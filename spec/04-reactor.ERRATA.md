# ERRATA & Decisions — SPEC-4 (The Reactor)

## V1 — The value index is keyed by (role, primitive), not (context, primitive)

SPEC-4 §3 specifies the value index as `(context, primitive) → DeltaId[]`, and SPEC-2 §3 describes
`ValMatch` as indexable over "(context, value) pairs". But in the pinned wire format (ERRATA-1 D5)
**primitive targets carry no context** — context lives on EntityRef/DeltaRef only. A
`hasPointer{context, targetValue}` predicate is in fact unsatisfiable (both conditions can never
hold on one pointer). The thing that names a primitive payload is its pointer's **role** (`value`,
`price`, …). v0 therefore keys the value index by `(role, primitive)`. Flagged for SPEC-4/SPEC-2:
the "(context, value)" phrasing reflects the legacy model where primitives sat inside contexted
references.

## V2 — v0 persistence is in-memory; ordering is the arrival log

The v0 reactor keeps the append-only log in memory (the log is still the truth; everything else is
derived). Durable storage, checkpoints (SPEC-4 §4.4), and replay-from-checkpoint arrive with the
pack format (M3) — packs are the checkpoint freight (SPEC-8 §6). Within a role bucket the value
index is scanned with the canonical comparator rather than kept in a range tree; per-role bucketing
already removes the O(|log|) term and sublinearity-within-bucket is an optimization the contract
(SPEC-4 §1) does not require.

## V3 — Ingest outcomes

`ingest(delta)` returns exactly one of: **accepted** (validated, persisted, indexed),
**duplicate** (id already in the log — a no-op everywhere downstream, SPEC-4 §2), or
**rejected(reason)** (content address does not recompute; claims fail L1 validation; a present
signature fails verification — ERRATA-1 D9; unsigned deltas remain legal). Rejected deltas leave
no trace in the log or indexes ("rejected, never repaired").

## V5 — v0 incremental maintenance: root-localized recomputation with sound dispatch

SPEC-4 §4.3 allows non-monotone repair by localized recomputation; v0 adopts it wholesale: a
materialization is `(term, roots, registry)` plus per-root HViews, and maintenance re-evaluates an
affected root with the batch evaluator. Incremental equivalence then holds by construction *for
re-evaluated roots*; the correctness burden is entirely in **dispatch** (never under-match,
SPEC-4 §4.1). v0 dispatch:

- **Support entities** per root = the root plus every expanded (nested) HView id in the current
  materialized view, recursively. A delta carrying an EntityRef pointer to a support entity
  affects that root.
- **Negation chains**: for an incoming delta with `negates` pointers, walk each chain downward
  (negation → its target, possibly itself a negation) via the id index; if any delta on the chain
  carries an EntityRef pointer to a support entity, the root is affected. This covers
  reinstatement (negation-of-negation) even when the suppressed delta is currently absent from
  the view — membership is checked against *relevance* (targets a support entity), not *presence*.
- **Root anchoring**: a term is root-anchored when every `group` in it — and in every transitively
  referenced schema body — sits above a pipeline that conjunctively requires a pointer at `$root`
  (analyzer: `hasPointer{targetEntity:$root}` is required; `and` requires either side; `or`
  requires both; everything else requires nothing). Non-anchored terms (e.g. `group(const(...))`,
  author-keyed selects) dispatch **broadly**: every ingested delta affects every root. Over-match
  is allowed; silence is not.

## V4 — Convergence is the tested contract

SPEC-4 §2's order-independence ("any ingestion order of the same deltas MUST converge to the same
materializations") is property-tested in both implementations: random permutations of fixture sets
— including negations arriving before their targets — must yield identical set digests, identical
index contents, and identical batch-evaluation results. Incremental materializations (M2.2) extend
the same property against the M1 evaluator as oracle.
