# RhizomeDB Specification — SPEC-4: The Reactor (L4)

**Status:** Draft
**Layer:** L4 — execution engine
**Depends on:** SPEC-0 … SPEC-3

---

## 1. Purpose

L4 specifies the **reactor**: the machine that L1–L3 deliberately are not. A reactor ingests deltas over time, evaluates L2 terms, and keeps **materializations** (live HyperViews, i.e., indexes) incrementally consistent with the growing delta set.

The defining contract of this layer is **incremental equivalence**:

> For any materialized term `t`, after ingesting any sequence of deltas resulting in set `D`, the materialization MUST be byte-identical (canonical form) to a from-scratch `eval(t, D)`.

Everything else in this document is technique in service of that one sentence. The conformance suite tests it directly: vectors supply delta sequences (including pathological orderings) and assert equality between incremental and batch evaluation at checkpoints.

## 2. The Reactor Model

```
            ┌──────────────────────────── Reactor ───────────────────────────┐
 deltas ──▶ │ ingest ─▶ validate ─▶ persist ─▶ dispatch ─▶ update ─▶ notify  │ ──▶ subscribers
            │                        (log)      (match)    (materializations)│
            └────────────────────────────────────────────────────────────────┘
```

Stages:

1. **Ingest** — receive a delta from any source (local mutation, federation peer, replay).
2. **Validate** — L1 checks: canonical form, content address verifies, signature verifies if present, primitives legal. Invalid deltas MUST be rejected, never repaired.
3. **Persist** — append to the durable log. Idempotent by `id` (re-ingesting a known delta is a no-op everywhere downstream).
4. **Dispatch** — determine which registered materializations the delta can affect (§4).
5. **Update** — apply incremental maintenance to affected materializations (§4.3).
6. **Notify** — emit change events to subscribers (§5).

Stream order is a transport artifact. Because L1 semantics are set-based and evaluation is order-blind, **any ingestion order of the same deltas MUST converge to the same materializations** (this is the CRDT guarantee surfaced at L4, and it is what makes federation catch-up trivial: replaying a peer's log in any order, with any interleaving, converges).

## 3. Storage Profile (Normative Minimum)

A Level-2-conformant reactor MUST maintain:

- **The log:** append-only, idempotent-by-id storage of all accepted deltas. The log *is* the database; everything else is derived and reconstructible.
- **The id index:** `Hash → Delta` (required for `DeltaRef` chasing, dedup, and Merkle verification).
- **The target index:** `EntityId → DeltaId[]` over pointer targets (required for `select(hasPointer(targetEntity: …))` to beat O(|D|)).
- **The negation index:** `Hash → DeltaId[]` mapping each delta to negations targeting it (required for `mask` and for §4.3's non-monotone repair).
- **The value index:** `(context, primitive) → DeltaId[]` over primitive pointer targets, ordered within each context (required whenever registered terms use `ValMatch` predicates — SPEC-2 §3 — so that range queries are sublinear; MAY be lazy/partial for contexts no registered term touches).

All further indexes are materializations registered as schema terms — there is no second index machinery (§4).

## 4. Materializations (Indexes)

**An index is a registered, persisted evaluation:** `(term t, roots R, pin-set P)` plus its current HyperViews. Registration compiles the term once into a maintenance plan. There is no separate index definition language — P4 means the schema *is* the index definition, and the relevance closure (SPEC-3 §2.1) *is* the maintenance contract.

### 4.1 Dispatch

On ingesting delta `d`, the reactor must decide which materializations to touch. Because terms are inspectable (P4):

- Each registered term contributes its `select` predicates and the predicates implied by its `expand` chain to a global **dispatch structure** (predicate → materialization set).
- Conservative approximation is permitted: dispatch MAY over-match (touching a materialization that turns out unaffected) but MUST NOT under-match. Predicate subsumption (SPEC-2 §3) is the optimization lever — e.g., merging dispatch entries when one predicate subsumes another.
- The required asymptotic: dispatch cost per delta MUST be independent of |D| (log size) — a function of registered-term count and structure only.

### 4.2 Membership tracking

For each materialization, the reactor MUST track which entity-roots each contributing delta reaches and through which expansion path (the *support* of the materialization). This is what turns "a delta arrived about Keanu" into "update the `the_matrix` HyperView, under `cast[*].actor`" — the inverted relevance closure.

### 4.3 Monotone vs. non-monotone maintenance

SPEC-2 §5 splits the algebra; L4 inherits the split as two maintenance modes:

- **Monotone operators** (`select`, `union`, `group`, `expand`): a new delta can only *add* entries. Maintenance is insertion along the support paths. Cheap.
- **Non-monotone operators** (`mask`, and `resolve` outputs if materialized): a new delta can *remove or change* prior results. The negation index (§3) localizes this: ingesting a negation of `x` triggers re-evaluation of exactly the materializations whose support contains `x` (and, for negation-of-negation, the chain walk is bounded by the Merkle-DAG argument of SPEC-2 §4.3).

A reactor MAY implement non-monotone repair by localized recomputation (re-evaluate the affected property of the affected root) — full differential dataflow is an optimization, not a requirement. Incremental equivalence (§1) is the only contract.

### 4.4 Checkpoints

Reactors SHOULD persist materialization checkpoints `(term hash, pin-set, log position, canonical HView hashes)` so restart cost is replay-from-checkpoint, not replay-from-genesis. Because HyperViews are content-addressable (SPEC-3 §4), checkpoint verification is hash comparison.

## 5. Subscriptions

Subscribers attach to:

- **the raw stream** — every accepted delta (federation relays, audit, mirrors); or
- **a materialization** — change events on a registered term's HyperViews.

The canonical write-back subscriber is the **derived author** (SPEC-7): a content-addressed function bound to a materialization, whose computed outputs re-enter the reactor through the ordinary ingest path as signed deltas. The reactor needs no special machinery for this beyond loop accounting (SPEC-7 §6).

Change events MUST carry: the root entity, the affected property paths, the responsible delta ids, and the materialization's new content hash. (Subscribers can then fetch, diff, or re-`resolve` as they please; the reactor never pushes resolved Views unless a `resolve` term is itself registered.)

Delivery guarantees are transport-specific and out of scope, with one normative rule: a subscriber that reconnects and replays from a checkpoint hash MUST be able to reach current state (events are re-derivable from the log; the log is the truth).

## 6. Mutation

A mutation is delta creation. The reactor's write path is `ingest` (§2); everything else is convention:

- **Mutation helpers** (informative): applications SHOULD route writes through functions that enforce vocabulary and delta-granularity discipline (SPEC-1 §3) — this is where the L5 ABI is enforced in practice, since L1 will accept any well-formed delta.
- **Read-your-writes:** a reactor MUST expose, for local mutations, a confirmation that the delta has passed persist+update, so callers can query their own writes coherently.
- **Atomic batch ingestion is manifest-keyed.** When a bundle (manifest + members, SPEC-1 §9) arrives flagged atomic, the reactor MUST make all members visible to dispatch in one step or none (rejecting the bundle if any member fails validation). This is the resolution of the former batch-ingestion open question: the transaction vocabulary supplies the batch boundary; the reactor supplies the courtesy. Reactors SHOULD assert completeness facts ("I hold all members of M") as annotation deltas under their own key, making transactional integrity *selectable* by policies (SPEC-5 §7) despite `Pred` being single-delta.
- There is no further transaction concept at L4. A multi-delta intent that must be all-or-nothing *in meaning* (not merely in arrival) should still usually be one delta (SPEC-1 §3).

## 7. Determinism & Observability

- **Determinism:** all reactor-visible nondeterminism (arrival order, timing) MUST be quarantined from materialization content (§2 convergence rule). Wall-clock receipt, if recorded, is recorded as annotation deltas authored by the reactor's own key (SPEC-1 §6) — making operational metadata first-class, queryable data instead of side-channel logs.
- **Debugging a query-time-assembled system:** the prescribed method is provenance-native. Any value in any View traces to: resolving policy decision → HVEntry deltas → delta ids → authors/signatures. Reactors SHOULD expose this trace as a structured API (`explain(view, path)`), since it falls directly out of HyperView structure.
- **Metrics that matter (informative):** log size, dispatch fan-out per delta, non-monotone repair frequency, materialization staleness (events pending), checkpoint lag.

## 8. Open Questions (L4)

- **Batch ingestion semantics:** ~~resolved~~ — manifest-keyed atomic ingestion (§6). Remaining detail: visibility semantics under partitioned logs.
- **Compaction:** the log is append-only forever (P2). Archival format for cold segments, and whether checkpoints can *replace* (rather than accelerate) genesis replay for instances that opt out of full history.
- **Backpressure & ordering at scale:** partitioned logs (by entity? by hash range?) and whether the convergence guarantee composes across partitions trivially (it should — union — but vectors must prove it under partial replay).
- **Resource bounds for hostile terms:** registration-time cost analysis of terms (expansion depth × predicate fan-out) so a federated peer cannot register a materialization bomb. Relates to SPEC-6 trust.
- **Cold queries:** the planner story for unregistered ad-hoc terms over the raw log (sort/merge strategies, borrowing from existing materializations whose terms subsume the query's).
