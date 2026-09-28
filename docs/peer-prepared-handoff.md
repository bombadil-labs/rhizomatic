# Signed prepared handoff descriptor

`vectors/peer/prepared-handoff.json` pins canonical claim bytes and Ed25519 signatures in both
witnesses. The old peer signs the `rhizomatic.peer.handoff.prepare.v1` claim directly. It names the
old and new governing keys, old surface, attempt, old state version, trusted deadline, refusal
snapshot digest, carried-state digest, and destination-policy digest. Both keys use
`ed25519:<lowercase-public-key-hex>` in this v1 claim. A strict signature check and canonical
CBOR check precede any descriptor comparison.

`verifyPreparedMatchesStage` / `verify_prepared_matches_stage` compares every signed field to
the closed v4 import and the caller's declared surface. Validly signed substitutions still fail
this comparison. The signature authenticates the old peer's proposed preparation only. It does
not prove a durable barrier, storage fence, new-peer import acknowledgement, old-peer CAS commit,
or deadline outcome. No prepared claim opens the stage or transfers purge responsibility.
