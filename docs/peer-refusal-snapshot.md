# Internal inherited-refusal snapshot

`vectors/peer/refusal-snapshot.json` pins a v1 permanent-posture canonical CBOR image and BLAKE3 content address in
both witnesses. Each event keeps its source `PeerId`, source sequence, target id, order ids, and
optional prior admission epoch. The image carries earlier events as well as one explicit current
event reference for each refused target. Sequence numbers are compared only with their source
peer; an import must not relabel them as the new peer's events.

`localRefusalSnapshot` / `local_refusal_snapshot` captures every refusal event from a validated
local durable peer image, including a refusal for a target never held on that peer. Encoding
rejects duplicate source references, orders reused by one source or for another target, an order
that is itself an erasure target, inconsistent prior epochs within a source, missing current
targets, and malformed ids or epochs. An order may have independent effects on different source
peers for the same target. It sorts events by source and sequence, current references by target,
and order ids within each event. A current reference cannot roll back behind a later event from
the same source and target. Decoding rejects noncanonical bytes.
Lower-posture re-entry needs a later image version to retain a historical event whose target is
no longer refused.

`recoverRefusalSnapshot` / `recover_refusal_snapshot` reads the primary copy first, then the
independent recovery copy. It accepts a copy only if its entire byte string matches the committed
digest and parses as the canonical image. The caller may persist the returned verified bytes to
repair an unreadable primary. If neither copy verifies, admission and serving must remain closed.
Before a handoff commits, the caller must also verify the independent recovery copy itself,
even when the primary copy is valid.

This module supplies only the refusal snapshot and recovery check. The digest is not a handoff
commit proof. Before a new peer serves, the later import transaction must also durably bind the
snapshot, active obligations, verified holdings, staged policy, ownership fence, acknowledgement,
and old peer's authoritative commit record. The snapshot is private: a public refusal outcome
must not enumerate unseen ids or event provenance.
