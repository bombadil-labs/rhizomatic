# ERRATA & Decisions — SPEC-6 (Federation)

## F1 — v0 federation is in-process; transport is out of scope by design

A v0 **Peer** is a Reactor plus a signing keypair, an **offered lens**, and an **admission
predicate**. Sync exchanges the spec's abstract messages as plain data between in-process peers —
which is a legitimate transport (§2 blesses sneakernet; a function call clears that bar). HTTP/WS
bindings are future work (§9).

## F2 — v0 reconciliation: full sorted-id exchange

WANT carries the requester's full sorted id list; the responder offers `eval(lens, log)` minus
those ids. Correct and convergent, not yet sublinear — the Merkle/IBLT set-digest construction is
SPEC-6 §9's open question and is deferred. The D10 set digest serves SUMMARY for change detection.

## F3 — The signature boundary, operationalized (SPEC-1 §5 / SPEC-6 §3)

An offered delta crosses only if it carries a verifying `sig`, **or** it is covered by a signed
manifest in the same BUNDLE. The sender partitions its offer: signed manifests with present
members travel as bundles (members may be sig-less — Merkle coverage); remaining signed deltas
travel loose; **unsigned uncovered deltas are withheld** (they "stay local or are re-issued
signed"). The receiver verifies bundle manifests' signatures before atomic ingestion and verifies
loose deltas individually; then applies its admission predicate (an L2 Pred — §5); then ingests.
Rejection is local and silent (each sovereign judges alone).

## F4 — Lenses are DSet-sort terms

A lens is any DSet-sort term evaluated over the responder's log; lens fidelity
(`offered ≡ eval(lens, log)`) is a tested invariant. Schema-relevance-closure lenses (§6) are
expressible today as entity-targeting selects; automatic dependency closure is deferred with
evolvable refs.
