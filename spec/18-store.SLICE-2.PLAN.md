# SPEC-18 slice 2 plan: the reactor reads through a store

**Status:** build plan, 2026-11-10. It serves SPEC-18 §10 slice 2. It is deleted when slice 2 has
landed and its decisions are in `18-store.PROPOSAL.md`.

## 1. What exists today

- Each witness has a memory `Reactor`: a log, a delta set, three indexes, materializations and
  subscriptions. Nobody hands a reactor anything; it is built empty and fed by `ingest`.
- The journal peer does not own a reactor. No path opens a reactor from durable state.
- TS store calls are asynchronous. Rust store calls are synchronous. The evaluator is synchronous
  in both.
- `evalAnchored` already runs rounds: compute S(scope), evaluate, collect the visible anchors, add
  the missing ones, repeat. Each pass walks the whole scope again and evaluates every child again.
- Rust `Reactor::get` returns a borrow. The Rust store returns owned deltas.

## 2. Decisions

| # | Question | Decision |
|---|---|---|
| a | Re-base `Reactor` on a store? | No. `Reactor` stays synchronous and in memory. A store-backed read is added beside it. |
| b | What moves to the `Exporter`? | The store path has no whole-set method. The memory `Reactor` keeps `snapshot`, `arrivalLog`, `digest` and `eval`, each deprecated, until Loam moves (slice 5). |
| c | Caches | One fetch cache and one evaluation memo per read (§3 below). |
| d | Does the reactor write the store? | No. Slice 2 is read-only. Only test fixtures fill a store. Slice 4 settles who builds an admission. |
| e | Subscriptions and materializations | No change. They stay on the memory `Reactor`. |

Reasons for (a): an asynchronous `Reactor` breaks every vector harness and every synchronous
consumer call; a Rust re-base breaks the borrow in `get`; maintained views stay memory caches until
slice 6 by the interim rule; §3 rule 4 already describes fetch-then-evaluate.

## 3. The store-backed read

New in the `reactor` boundary (TS `reactor/store-read.ts`, Rust `store_read.rs`). The boundary
gains an edge to `storage`.

- `readAnchored(snapshot, request)`: an anchored read in rounds. It refuses an unanchored term with
  the existing reason. It never falls back to a scan.
- `readFullSurface(peerExporter, request)`: the explicit full-surface read of §6.6. It needs an
  exporter, so a serving path that was never given one cannot reach it.
- `fetchScope(snapshot, entities)`: one fetch that returns a synchronous source and the revision.
  Law readers in a consumer use this shape.
- `StoreReactor.open(peerStore)`: O(1), reads nothing. `read` takes a snapshot, runs `readAnchored`
  and releases the snapshot. `fetch` does the same for `fetchScope`.

**One round:**

1. Call `scope` once, for the anchors not yet fetched, with `exclude` set to every id held.
2. Add the answer to the fetch cache. The cache keeps members that fail the residual selection, so
   `exclude` names them and the store does not send them again.
3. Compute the exact members: S(fetched anchors) over the cache, under the residual selection. The
   residual is the caller's `admits` plus every pushdown field the store did not apply.
4. Evaluate synchronously over those members, with the memo.
5. The next anchors are the visible anchors not yet fetched. Stop when there are none.

Asking only for new anchors is sound: S(A ∪ B) = S(A) ∪ S(B), and `exclude` trims an answer without
cutting a chain. All rounds use one snapshot.

**The evaluation memo.** A child evaluation is stored under (schema reference, bindings, root). It
is stored only when the child is **final**: every anchor visible in the child's HView is fetched.
By the SPEC-17 closure lemma its result over the fetched set then equals its result over the
surface, and a later round cannot change it. A child that is not final is evaluated again in the
next round. The memo is off when an evaluation budget is present, because a hit would skip the
budget count.

**A moved snapshot.** `readAnchored` passes `snapshot-moved` up. `StoreReactor.read` retries the
whole read on a new snapshot up to three times. It never mixes snapshots.

## 4. One read type for consumers

- `DeltaSource` (`get`, `targets`, `negators`) moves to the `delta` boundary in TS. Rust already
  has it there.
- Its contract tightens: each id once, ascending by UTF-8 bytes. Rust and SPEC-18 §4.2 already say
  this. TS `Reactor.targets` and `negators` return insertion order today.
- `negationWitnesses` and `negationPredicate` become free functions over a `DeltaSource`. The
  `Reactor` methods delegate to them. Rust `NegationReader` becomes generic over the source.
- For an id outside a fetched scope a reader answers "not held". A fetched scope cannot tell
  "absent" from "not fetched". The caller fetches the anchors of everything it asks about.
- `resolvePrincipal`, `authorsForPrincipal` and `associatedKeys` take a `DeltaSource`. They read
  one entity's scope and nothing else.
- `Reactor.revision` is public: the membership counter, comparable only within one reactor object.
  It is not a store revision. Rust gains the counter.

## 5. Vectors and rails

- **Existing read families run a second time through the store:** the anchored read cases, the
  other evaluation cases (anchored through `readAnchored`, unanchored through `readFullSurface`),
  the negation-witness cases over a fetched scope, and the principal cases over a fetched scope.
- **Not run on the store in slice 2:** transaction, atomic-transfer, materialization and peer
  families. Their subject is ingest, dispatch or the journal.
- **Round vectors** (`vectors/store/rounds.json`): a term, a root, a selection, the expected bytes,
  the expected scope and members, and the anchors of each round. A list-scanning model generates
  the expectations. Each witness evaluates each case five ways and all five must match: whole
  surface; rounds with no cache; fetch cache only; memo only; both. Each case also runs with every
  subset of pushdown fields off.
- **The fixture holds:** expansion of depth three; a delta that points at an early anchor and a
  deeper one; a child reached twice; a negation of a negation that arrives in a later round; an
  excluded id in the middle of a chain.
- **Interleaved cases:** an append between two rounds. The read answers `snapshot-moved` or the
  old answer, never a mix.
- **Broken-reader rails:** memoize every child; treat `exclude` as a selection; skip the residual
  trim; reuse a fetch cache across two snapshots. Each must fail a round case.
- **Cost rails:** the same read with 0 and with N unrelated deltas makes the same store calls;
  exactly one `scope` call per round and no other read call; `open` makes no snapshot call; the memo
  lowers the count of child evaluations on the depth-three fixture.

## 6. The PR stack

| # | Contents | Kind |
|---|---|---|
| 1 | TS: `DeltaSource` in `delta`, sorted contract; free negation readers; `Reactor.revision` | mechanical |
| 2 | Rust: the same; generic `NegationReader` | mechanical |
| 3 | Both: the principal functions take a `DeltaSource`; principal vectors run over a fetched scope | mechanical |
| 4 | Vectors: `rounds.json`, its generator and model | fixture design |
| 5 | TS: fetch cache, rounds, `readAnchored`, `fetchScope`, `StoreReactor`; the boundary edge | design risk |
| 6 | Rust: the same | design risk |
| 7 | TS: the evaluation memo | highest risk |
| 8 | Rust: the evaluation memo | highest risk |
| 9 | Both: existing read families through the store; `readFullSurface`; deprecations; changelog | mostly mechanical |

Pairs 1 and 2, 5 and 6, 7 and 8 merge together. The witnesses are never more than one PR apart.

## 7. Open for the owner

- **O1.** `snapshot()` stays on the memory `Reactor`, deprecated, until slice 5. SPEC-18 §10 says
  it "moves to the Exporter".
- **O2.** "Every existing vector passes on the memory store" means every vector whose subject is a
  read.
- **O3.** The anchors of each round are normative. SPEC-17 §6 allows lazy growth.
- **O4.** No host path writes a store before slice 4.
- **O5.** The `DeltaSource` order rule is a contract change on an exported interface.

## 8. Known and left for a later slice

- A registered term's lowering hook still receives the whole set (slice 6).
- The next validity boundary, value ranges and the digest have no store form yet.
- A read that spans peers needs a union snapshot. `readAnchored` takes a `Snapshot`, so a union
  can implement it later.
- `principalResolverForReactor` compares the whole input with the reactor on every call. It should
  compare revisions (slice 3).
