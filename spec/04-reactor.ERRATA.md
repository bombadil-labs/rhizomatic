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

## V4 — Convergence is the tested contract

SPEC-4 §2's order-independence ("any ingestion order of the same deltas MUST converge to the same
materializations") is property-tested in both implementations: random permutations of fixture sets
— including negations arriving before their targets — must yield identical set digests, identical
index contents, and identical batch-evaluation results. Incremental materializations (M2.2) extend
the same property against the M1 evaluator as oracle.
