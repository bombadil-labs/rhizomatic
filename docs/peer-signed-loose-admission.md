# Internal signed loose ordinary admission

The TypeScript and Rust witnesses share an internal path for signed loose **ordinary** deltas.
`vectors/peer/signed-loose-admission.json` pins its per-appearance outcomes and the canonical
resulting durable image bytes. The path verifies each signature and content id, checks the
permanent refusal set and current holdings, runs declared candidate guards against the same
pre-transfer admitted set, and passes remaining candidates to a deterministic ordinary quota.
Later stages use preflight's verified copy of each candidate, so a guard that mutates the caller's
offer cannot replace the candidate that lands.
An eligible co-offered negation must land with an ordinary target it negates. If quota skips that
negation, the target is pruned and neither id is charged. Repeated appearances land once and get
one arrival record. An empty or fully rejected transfer consumes no new transfer ordinal.

The receiver supplies a classifier for erasure candidates. A candidate classified as an order
cannot pass through this ordinary-only path and gets `unsupported-erasure`; it must use the later
erasure admission path. This slice has no subscribed lens, signed-bundle coverage, candidate-set
conflict rule, or erasure effect. Those stages remain necessary before a general admission API.
The classifier must be deterministic over a verified claim. The path evaluates it once per
distinct eligible id, so repeated appearances cannot split one id between ordinary and erasure
outcomes. Duplicate effective erasure orders also belong to the later erasure receipt path; this
ordinary path cannot report their current or earlier refusal event and must not be used for them.

The file operation plans against the caller's exact prior v2 image bytes, then asks the durable
writer to compare those bytes before replacement. A stale image rejects without changing the
file. This assumes one writer per peer and does not make the path a cross-process transaction.
This module is not exported from the TypeScript package barrel or the documented Rust surface.
It is not yet the reviewed handoff API needed by Loam.
