# SPEC-18 slice 3 plan: revisions and the change feed

**Status:** build plan, 2026-11-12. It serves SPEC-18 §10 slice 3. Nothing in it is built. It is
deleted when slice 3 has landed and its decisions are in `18-store.PROPOSAL.md`.

## 1. What exists today

- Each memory store keeps only the current revision of a peer. It has no history.
- A revision advances on an append that adds a delta or moves the head, and on a purge that
  releases a held id. A head-only commit is a revision of its own.
- The profile says `changeRetention: "none"`. `PeerStore` has no `changes` method.
- The TS memory `Reactor` pushes each fresh delta to raw subscribers and refreshes its views. It has
  no cursor, so a subscriber cannot resume. The Rust `Reactor` has no subscriptions.
- `StoreReactor` offers `read` and `fetch` only.
- Loam notices change by rereading its whole store (`catchUp`), comparing SQLite's `data_version`,
  re-evaluating a membership term on every delta, and keeping its own size-driven revision.

## 2. Decisions

| # | Question | Decision |
|---|---|---|
| a | The `changes` API | `PeerStore.changes(from, to?)` returns pages of records. A record is `{revision, head, added, removed}`: ids only, plus the head after the commit. One record per revision advance. Records never change. |
| b | Retention | The memory store keeps every record by default (`unbounded`), with a bounded option. A `from` older than what is kept answers `resync-required`, a result and not an error. The caller drops what it derived and reads again. |
| c | Freshness | A pure function `touching(capture, records, addedDeltas)` and a helper `checkFresh(peer, capture)` in `storage`. A capture is stale when an added delta points at one of its anchors or negates a member, or when a member is removed. Exact without a selection; sound with one. |
| d | Raw subscriptions | A pull cursor over the feed (`FeedCursor`), no push. It resumes from a saved revision. It delivers the bytes only of ids still held when it pulls. |
| e | The memory `Reactor` | No change. Its dispatch and subscriptions stay until Loam moves (slice 5). A new `StoreViews` gives store-backed hosts memory views keyed by revision and refreshed through the feed. |
| f | Next validity boundary | Per read, never per peer. A read and a fetched scope carry `expiresAt`: the next `validFrom` or `validUntil` among its own members. |
| g | Whole-peer version address | Slice 4, with the holdings Merkle root. |

## 3. Cost

- `changes` costs O(records returned + ids returned). Never O(holdings), never O(earlier records).
- An append under bounded retention costs the same with 0 or N retained records.
- `checkFresh` makes one `read`, one `changes` call per page and one `get` of the added ids. Its
  calls do not depend on holdings or on records before the capture.

## 4. Vectors and rails

- `scripts.json`: a `changes` step, a `mark` step and `revisionAs` to name revisions; the
  requirement `changes`. The runner checks after every step that the feed holds exactly one record
  for each revision advance, with the right head, `added` and `removed`. Each witness also runs the
  scripts on a store that keeps only two records.
- A new `freshness.json`: cases of commits after a capture, each with the expected current or
  stale answer and what touched. The generator checks exactness for cases with no selection.
- `rounds.json`: each case gains its expected `expiresAt`.
- Broken stores (no record for a head-only commit, a settled debt in `removed`, a silent gap, a
  resync inside the window, an overstated page, records out of order, two peers mixed) and broken
  readers (ignores `removed`, ignores negators, treats every add as touching, reads after `to`,
  ignores a re-add) each fail.

## 5. What Loam gets

| Loam today | Slice 3 |
|---|---|
| `catchUp` rereads the whole store | `FeedCursor.pull()`; `removed` triggers what a reseat did |
| `refreshImpl` compares the journal head | `pull()`; an empty page means nothing to do |
| `durableCurrent` reads SQLite `data_version` | `checkFresh` over the read's capture, or compare revisions |
| the watch pulse re-evaluates on every delta | pull, then evaluate only if `touching` says so |
| the gateway's size-driven revision | the store revision; erasure pins stay a Loam-side epoch |
| the whole-ground validity timer | the least `expiresAt` over the captures Loam holds |
| `register`, `materializedView`, `subscribe` | `StoreViews` |

## 6. The PR stack

| # | Contents | Kind |
|---|---|---|
| 1 | TS: records, pages, `PeerStore.changes`, retention, refusals | low risk |
| 2 | Rust: the same | mirror of 1 |
| 3 | Vectors and the TS runner rules for the feed | fixture design |
| 4 | Rust runner rules, broken stores, cost rails | mechanical |
| 5 | TS: freshness, captures, `expiresAt`, `freshness.json` | highest risk |
| 6 | Rust: the same | highest risk |
| 7 | TS: `FeedCursor`, `StoreReactor.follow` | medium |
| 8 | Rust: the same | medium |
| 9 | TS: `StoreViews` | medium-high |
| 10 | Rust: the same | medium-high |
| 11 | Readings into the proposal; CHANGELOG; delete this plan | doc |

Pairs merge together. After step 4, pairs 5–6 and 7–8 can run in parallel. The stack adds no
package edge.

## 7. Decided 2026-11-12 (delegated to Claude)

The owner delegated these twelve calls. Each is decided as the plan recommended. Items marked ⚑
change what the system promises.

- **O1.** A record carries the head. A head-only commit is a revision and writes a record.
- **O2.** `resync-required` is a result, not an error, like `conflict`.
- **⚑ O3.** A `from` later than the current revision answers `resync-required`. A store restored
  from backup rolls revisions back, so slice 4 adds a history epoch.
- **⚑ O4.** Retained records keep the ids of purged deltas, never their bytes. §4.7.2 states that
  ids in the feed lie outside "absent", and that retention bounds them.
- **O5.** The feed is pull only. There is no push.
- **⚑ O6.** The raw stream delivers bytes only for ids still held at pull time. This narrows
  SPEC-4 §5 ("every accepted delta"); it never hands out purged bytes.
- **O7.** Freshness is exact without a selection and sound with one.
- **⚑ O8.** The next validity boundary is per read only. This changes the meaning of Loam's
  validity timer.
- **O9.** The version address waits for slice 4.
- **O10.** `StoreViews` lands in slice 3. Without it slice 5 has no store-backed home for Loam's
  views.
- **O11.** The memory store keeps every record by default, with a bounded option.
- **O12.** SPEC-16 MR-10b is amended now, in one sentence, to allow the feed check.

## 8. Follow-ups

These come from the independent review of steps 1 and 3 (2026-11-13) and from the review of the
proposal (PR #76). Each is owed by the step or slice named.

### Step 5 (freshness) owes — done 2026-11-13

- ✓ Freshness covers time as well as the feed: a capture is valid over its window
  `[since, expiresAt)`, and `checkFresh` answers `not-yet` or `expired` after the feed (§4.6
  "The window"; §4.13 readings 24, 25 and 34; SPEC-16 MR-10b).
- ✓ Freshness covers the inputs of the selection and of authority, not the scope alone. The host
  keeps its own epoch for them (§4.6 "What the check does not cover"; SPEC-16 MR-10b, ERRATA E14).
- ✓ A removed raw id that is not an operand can still change a capture. A capture's members are
  the raw scope, so its removal touches (§4.6; `freshness.json` case
  `a-selection-and-a-purged-raw-id`; SPEC-16 ERRATA E14).
- ✓ An added negator of an excluded raw id can still change a capture. It negates a member of the
  raw scope, so it touches (`freshness.json` case `a-selection-and-a-negator-of-a-raw-id`).
- ✓ How a capture gets its raw ids: a read that pushed nothing down holds them in its fetch cache;
  otherwise it reads them with id-only calls on the same snapshot, never from a pushed-down fetch
  (§4.6; §4.13 readings 28 and 29; SPEC-16 MR-10b).
- ✓ A capture is compared only within one history of its peer: `PeerStore.history`,
  `Snapshot.history` and `Capture.history` (§4.6 "History"; §4.13 readings 37 to 39). Decision
  O3's history epoch is this field.

### Steps 5 and 6 (freshness, TypeScript and Rust) — done 2026-11-13

- ✓ Step 5 (TypeScript) and step 6 (Rust) are built. The Rust witness was built from the
  documents alone, and both were reviewed independently.
- ✓ The integration aligned the two witnesses where the reviews found them apart (§4.13 readings
  46 to 53): the maker takes a live snapshot; a repeated mint is refused; a page with no progress
  is a store fault; `now` is finite; anchor kinds; a revision written `1.0`; the runner's message
  for a refusal; one capture JSON, pinned by `vectors/store/capture-interchange.json`.

### Step 7 (the feed cursor, TypeScript) — done 2026-11-13

- ✓ `positionOf`, `followFeed`, `parsePosition`, `FeedCursor.pull` and `StoreReactor.follow`;
  `StoreRead.position` and `FetchedScope.position` (§4.6 "Following the feed"; §4.13 readings
  55 to 66). SPEC-4 ERRATA V6 states decision O6.
- ✓ `vectors/store/follow.json`, its runner and its rails (`vectors/store/README.md` §10). The
  generator and a fuzz prove the follower's guarantee by brute force.
- ✓ The final check of PR #80: the order of a capture's defects (reading 54); the TypeScript
  entry of `capture-interchange.json` pinned byte for byte (README §9.8); a feed page past r′ is a
  store fault in `checkFresh` (reading 46).

### Step 8 (the feed cursor, Rust) owes

From the documents alone: `spec/18-store.PROPOSAL.md` §4.6 and §4.13 readings 46 and 54 to 66,
`vectors/store/README.md` §9.7, §9.8 and §10, and SPEC-4 ERRATA V6.

1. `Position` (history and revision), `position_of(&Snapshot)`, and a cursor made by
   `follow_feed(peer, from)` that makes no store call and refuses a malformed position
   `invalid-request` (empty history; a revision outside 0 to 2^53 − 1).
2. `pull`: one snapshot; another history or a position past the snapshot answers
   `resync-required` with the snapshot's position and no feed call; equal revisions answer ok with
   no records and no feed call; otherwise one `changes(position, r′)` with that explicit `to`, one
   page; a store `resync-required` passed on with the snapshot's position; on an ok page that adds
   ids, `get` then `arrivals` of those ids, distinct and ascending, and none for a page that adds
   nothing; then the release.
3. Ok answers: the page's records; the delivered deltas ascending by id, each once, each with the
   arrival record at the snapshot, only for ids held there; the cursor moves to `through`.
4. `resync-required` is final: every later pull answers the same, with no store call, and the
   cursor does not move.
5. Faults and moves: on `snapshot-moved`, start again, at most four snapshots, each released; a
   page with no progress, a page past the snapshot, and `get` and `arrivals` that disagree are
   store faults (a panic, as reading 46); a failed pull does not move the cursor. Pulls take the
   cursor mutably, so they cannot overlap (reading 64).
6. `parse_position`: exactly the keys `history` and `revision`; a non-empty history that is not
   local to a process; `3.0` read as 3; `1.5` refused.
7. The reactor: `StoreReactor::follow(from)`, and the position on a read and on a fetched scope.
8. The runner of README §10 with its fixed messages and the call walk, and the runs of §10.4.
   Replace the skip in `tests/store_follow.rs` with the run.
9. The rails of README §10.6: the wrong-follower table (a second cursor with one rule broken at a
   time, which passes every run with none broken, and the "only these cases" evidence); the rows
   for the follow step and for documents; each runner check removed goes red; the cursor's own
   rules; the fuzz (at least 2,000 sequences); the two cost rails.
10. From the final check of PR #80: move the empty-history check of the capture parser before the
    anchors, so the order of reading 54 holds (an empty history beside a `value` anchor is
    `invalid-request`); pin the Rust entry of `capture-interchange.json` byte for byte from the
    scenario of README §9.8; make `check_fresh` fail on a page whose `through` is past r′, as on a
    page with no progress (reading 46), with the rail of README §9.7 ("Store faults and time").

### Slice 4 owes

- **A durable store persists each peer's history** (§4.6 "History") and gives the peer a new
  history when the store is restored from a backup or a peer is deleted and created again. A
  capture or a cursor from before then answers `resync-required`. It also keeps every history
  it issued across a reopen, so a host mint that repeats is refused there too (§4.13 reading 49).
- **Records appear in revision order** (§4.6, §4.13 reading 5). A record at revision r is visible
  only when every record at or below r is. A store open to several writing processes enforces
  this at commit. Slice 4 adds the rail; a sequential runner cannot test it.
- **The feed is a purge surface** (§4.7.2). The purge report names the change feed as a surface
  that still holds the id of a purged delta.
- **A durable store's default retention is bounded.** Under `unbounded` retention a purged id
  stays in the feed for as long as the store lives.
- A purge does not report a surface `absent` while an open snapshot can still read the bytes.
- The claim that "nothing is served silently" (§4.7.3) covers lost rows. Slice 4 narrows it, or
  backs it, for lost index entries: a lost index entry hides a delta without a read failing.

### Slice 6 owes

- Stored views (§4.7.4) join the list of purge surfaces.
- Value and derived-index anchors join a capture, `rawScope` and `touching`. Their fields in the
  capture JSON are defined then; until then `parseCapture` reads only their kind (§4.13
  reading 30).

### Done in steps 1 and 3

- §5.3 and §5.4 state their exceptions to the cost rule: the compacting copy of a `proven` LMDB
  purge costs O(store), and a segment lookup costs O(log² N) above the bound of §4.2.
