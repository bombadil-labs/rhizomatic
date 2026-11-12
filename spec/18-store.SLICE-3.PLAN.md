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

## 7. Open for the owner

Items marked ⚑ change what the system promises.

- **O1.** A record carries the head. Recommendation: yes; a head-only commit is a revision.
- **O2.** `resync-required` is a result, not an error. Recommendation: yes, like `conflict`.
- **⚑ O3.** A `from` later than the current revision answers `resync-required`. Recommendation: yes.
  A store restored from backup rolls revisions back, so slice 4 should add a history epoch.
- **⚑ O4.** Retained records keep the ids of purged deltas, never their bytes. Recommendation: yes;
  state in §4.7.2 that ids in the feed lie outside "absent", and that retention bounds them.
- **O5.** Pull only, no push. Recommendation: yes.
- **⚑ O6.** The raw stream delivers bytes only for ids still held at pull time. SPEC-4 §5 says
  "every accepted delta". Recommendation: accept the narrower promise; it never hands out purged
  bytes.
- **O7.** Freshness is exact without a selection and sound with one. Recommendation: yes.
- **⚑ O8.** The next validity boundary is per read only. Recommendation: yes. It changes the meaning
  of Loam's validity timer.
- **O9.** The version address waits for slice 4.
- **O10.** `StoreViews` lands in slice 3. Recommendation: yes; without it slice 5 has no store-backed
  home for Loam's views.
- **O11.** The memory store keeps every record by default. Recommendation: yes, with a bounded option.
- **O12.** Amend SPEC-16 MR-10b now to allow the feed check. Recommendation: yes, one sentence.
