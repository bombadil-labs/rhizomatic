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
| `register(name, term, roots, now)` | `StoreViews.register(name, program)`, then `hold(name, root, now)` for each root |
| `materializedView(name, root)`, `materializedHex` | `hold(name, root, now)`: async, one pass; `bytes` is the hex |
| `subscribe(name, cb)` | the host's own list of callbacks, called from `refresh(now).changed` (no push) |
| `changesFromLastIngest()` | `refresh(now).changed`: the views whose bytes changed since the previous refresh |
| `advanceTime(now)` | `refresh(now)`: views whose window no longer holds `now` are read again |
| `nextValidityBoundary(now)` | `StoreViews.nextBoundary`: the least `expiresAt` over the held views |
| `refreshAll(now)` (a lowering dependency changed) | `setEpoch(name, epoch)` for each program that reads it, then `refresh(now)` |
| `evalCountOf(name)` | `StoreViews.evalCountOf(name)` |

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
| 9 | TS: `StoreViews` (done 2026-11-13) | medium-high |
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
- ✓ The review of step 7: single pulls in `follow.json` (`once`) and four cases with commits
  between them; a fault is found before a page is judged, with rails; a follower's copies lie
  outside erasure; a full mirror starts from a position and then an export (§4.6, readings 67 to
  72).
- ✓ The final check of PR #80: the order of a capture's defects (reading 54); the TypeScript
  entry of `capture-interchange.json` pinned byte for byte (README §9.8); a feed page past r′ is a
  store fault in `checkFresh` (reading 46).

### Step 8 (the feed cursor, Rust) and the integration of steps 7 and 8 — done 2026-11-13

- ✓ Step 8 is built from the documents alone: `Position`, `position_of`, `follow_feed`,
  `parse_position`, `FeedCursor::pull`, `StoreReactor::follow`, the runner of README §10 with
  its runs, the wrong-follower table (W6 included), the fuzz and the cost rails.
- ✓ Fuzz totals from the reviews: TypeScript 25,000 sequences and 741,018 pulls; Rust 100,000
  sequences and 1,636,514 pulls; no divergence in either.
- ✓ A store fault is an error value in both witnesses, never a panic or a plain `Error`, with
  four rules: `no-progress`, `past-the-bound`, `mismatched-answers`, `unasked-ids` (readings 46,
  63 and 73). TypeScript throws `StoreFaultError`; Rust returns `FeedError::Fault`. The boundary
  tool no longer allows `catch_unwind` in the runner.
- ✓ `get` and `arrivals` answer only what was asked (reading 74): an extra, repeated or unordered
  id is `unasked-ids`, and nothing of the answer is delivered or judged.
- ✓ One order of a capture's defects in both witnesses (reading 54), pinned by
  `vectors/store/capture-defects.json`.
- ✓ The runners agree (README §9 and §10): fixed words with an optional step locator;
  `follow refused with <code>`; `the store broke <rule>: …`; a case's `store` checked, a store the
  factory cannot build skipped (`store`), any other factory failure a failed case; a document
  defect before a capture gap; each call logged when it is made; `snapshot-moved` from `read()`
  retried; another format is a failure report; each witness asserts exactly the cases of the
  file.

### Step 9 (held views, TypeScript) — done 2026-11-13

- ✓ `StoreViews`: `register`, `setEpoch`, `hold`, `refresh`, `drop`, `nextBoundary`,
  `evalCountOf`; one pass for the whole set through an inverted index; the window by heaps; the
  epoch; `maxViews` and eviction; `advanceCapture`, internal (§4.6 "Held views"; §4.13 readings
  75 to 90).
- ✓ `vectors/store/views.json`, its runner and its rails (`vectors/store/README.md` §11). The
  generator proves rules 1 and 4 by brute force; a fuzz of 2,000 sequences in the suite (20,000
  run once); three cost rails.
- ✓ The independent review of step 9 (merge with follow-ups), applied: a pass reports a broken
  store as `StoreFaultError` with the four rules and checks its `get` answer (`unasked-ids`); a
  pass that reads a purge releases every baseline that could carry the purged delta, and the next
  refresh reports the view with `before: null` (reading 88); a resync releases every baseline;
  the cases `a-purge-read-by-a-hold-releases-the-baseline`, `an-evicted-view-is-read-again` and
  `a-new-view-that-changes-before-the-refresh`, with the wrong holders "keeps the baseline of a
  purged member" and "keeps an evicted view and serves its old bytes"; `drop` of a program not
  registered is refused; only `hold` is a use; a view a `hold` evicts is not read in that pass;
  the order of reads inside a pass is free, and `reread` and `changed` are sorted (readings 83,
  85, 89 and 90).
- Changed from the contract: `drop` and `setEpoch` answer promises (reading 81); `ViewRead` adds
  `capture` (reading 77); `bytes` is an HView or a View (reading 82); `changed` speaks for
  refreshes, against a baseline (reading 76); `ViewChange.before` may be null (reading 88); the
  vectors pin `reread` and `from` only for programs without a selection (reading 80).

### Step 10 (held views, Rust) owes

From the documents alone: `spec/18-store.PROPOSAL.md` §4.6 ("Held views", with "A held view lies
outside erasure") and §4.13 readings 73, 74 and 75 to 90; §4.7.2 (its paragraph on held views);
§6 items 3 to 5; and `vectors/store/README.md` §11.

1. `advance_capture(capture, history, revision)` beside `make_capture` and `parse_capture`, not
   public outside the crate's store modules: it answers the same capture at a later revision of
   the same history, and refuses another history, a lower revision and a revision outside 0 to
   2^53 − 1 with `invalid-request`. It states its assumption (§4.6, "Captures move without a
   write").
2. `StoreViews::new(peer, options)` with `max_views` (an integer of 1 or more, default 1024,
   anything else refused `invalid-request`) and a round policy. `register(name, program)` with
   term, registry, selection and epoch (default `""`): an unanchored term is refused with the
   read's SPEC-17 §5 reason; a name given twice is refused `invalid-request`; no store call.
   `hold`, `set_epoch` and `drop` of a name not registered are refused `invalid-request`; `drop`
   of a view not held is no error.
3. The pass of §4.6, in its order: one snapshot; the feed only when views are held and the
   snapshot has the position's history and a higher revision, page by page with an explicit
   `to`, one `get` per page that adds ids (distinct, ascending) and none for a page that adds
   nothing; touches through an inverted index (anchor entity → views, member id → views), never
   a walk over the views; baselines released through the same lookups plus a baseline index
   (member id → views whose baseline capture holds it and is not their current capture); resync
   on another history, a lower revision or the store's `resync-required` (every held view read
   again, every baseline released, `resynced`); time through structures ordered by `expires_at`
   and by `since`; epochs compared by value; a `hold` of a new view into a full set does not
   read the view it will evict; every read on the pass's snapshot, in any order; then release,
   then apply. A pass with no view held reads no feed.
4. Faults as values (readings 73, 74 and 89): a page with no progress (`no-progress`), a page
   past r′ (`past-the-bound`) and a `get` answer with an unasked, repeated or unordered id
   (`unasked-ids`) are `FeedError::Fault` with that rule, found before the page is judged; never
   a panic. `snapshot-moved`, from `read()` itself or a later call, starts the pass again, at
   most four snapshots, each released. A failed pass applies nothing (reading 84). Calls take the
   holder mutably, so they cannot overlap (reading 81, as reading 64).
5. The answers: `ViewRead` (bytes as lowercase hex of the canonical result, HView or View;
   position; `expires_at`; `from`; the capture at the position, from `advance_capture`);
   `Refresh` (position; `changed` against each view's baseline, with `before: Option<String>`,
   `None` for a released baseline and reported whatever the bytes; `reread`; `resynced`), both
   lists ascending by program name, then root, by UTF-8 bytes (reading 85). A view is not in
   `changed` merely because it is new; its baseline is its first answer. `drop` forgets a view
   and every index entry it had; eviction forgets the least recently held view (only `hold` is a
   use) and is not a change; `next_boundary` is the least `expires_at`; `eval_count_of(name)`
   counts reads.
6. Erasure (reading 88): after the first pass that reads a purge, the holder keeps none of the
   purged delta's payload anywhere (bytes, baselines, captures, indexes, ordering); a baseline the
   purge did not touch is unchanged.
7. The runner of README §11 with its fixed messages: the `ViewHolder` trait, the setup, the
   holder made after it over a logged handle, the expected resync below the floor (every held
   view re-read but the evicted one, every view in `changed` with `before: null`), the hold and
   refresh checks (the `reread` order check included), `the store broke <rule>: ` for a fault,
   the call walk of §11.4, and the runs of §11.5. Replace the skip in `tests/store_views.rs` with
   the run. The bytes of every answer equal the document's: that is the byte parity of the two
   witnesses.
8. The rails of README §11.6: the wrong-holder table (the holder with one rule broken at a time,
   which passes every run with none broken), including "keeps the baseline of a purged member"
   and "keeps an evicted view and serves its old bytes" (which fails only
   `an-evicted-view-is-read-again` and passes without it); the two holders that only a rail
   catches; a row for every runner check (the unordered `reread` and the fault words included);
   the holder's own rules (refusals, use and eviction, forgetting with index sizes, the three
   fault rules with nothing applied, moved snapshots from `read()` and later, two-sided erasure
   with the review's scenario and a walk of the holder for the payload, the capture and
   `check_fresh`); the fuzz (at least 2,000 sequences, rule 1 after every hold and refresh, rule
   4 without a selection, no purged entry in the holder after every pass); and the three cost
   rails, with the per-view scan shown red once.

### Slice 5 owes (Loam)

- Loam's followers of the feed drop their mirror on `resync-required` and start again from a
  position and a read; they never merge (§4.6, "A follower's copies lie outside erasure").
- Loam's erasure accounts for its followers: a purge does not reach a follower's mirror until it
  pulls the removal, and a follower that stops pulling keeps the bytes. Loam erases those copies
  itself or keeps its followers pulling.
- Loam's scoped reads keep fresh with `checkFresh`, not by applying pages; only a full mirror
  applies them (§4.6, "A scope is not a mirror").
- Loam's maintained views move onto `StoreViews` by the table of §5. Loam's erasure runs a pass
  (`refresh`, or `drop` of the views) on every `StoreViews` it holds before it reports: a held
  view keeps a purged delta's bytes, and its baseline, until a pass reads the purge (§4.6, "A
  held view lies outside erasure"; §4.7.2; §4.13 reading 88). Loam treats every `before`, `after`
  and `hold` answer it copied before that pass as its own copy, and erases it itself.
- Loam names the state its selections and authority read outside the store (grants, trust, a
  lowering's dependencies) with an epoch per program, and calls `setEpoch` when it changes.
- Loam's view subscribers copy from `refresh(now).changed`, not from the answers of `hold`
  (§4.13 reading 76).

### Slice 4 owes

- **Remote stores rely on the fault values.** A store across a process or a network can break
  its contract; `checkFresh` and the cursor report that as a store fault with its rule, not by
  aborting the host (§4.13 reading 73). Slice 4 decides how a remote store's client reports a
  transport failure, and keeps the fault values for a store that breaks its contract.
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
