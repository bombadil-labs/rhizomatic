# Ordinary peer append journal (step 6 format slice)

The current single-peer trial writes the full durable v2 image on every append. An ordinary
append journal can persist one signed-loose transfer at a time while preserving the same
receiver-local arrival testimony. This first slice defines canonical frame bytes and replay in
both witnesses; the atomic append store and typed admission facade are the next slice. It does
not admit erasures, bundles, re-entry acts, or handoffs.

A v1 frame contains exactly `version`, receiving `peer`, `prior` frame id, trusted receiver
`at`, `sender`, and a canonical SPEC-8 `pack` of newly admitted signed deltas. The first
`prior` is empty; later frames name the content address of the preceding frame's canonical
bytes. No-op transfers have no frame. Each frame creates one transfer ordinal, even when two
frames share a trusted time. Within a frame, arrival sequences follow ascending delta id.

The internal `encodeOrdinaryPeerFrame` and `decodeOrdinaryPeerFrame` functions in TypeScript and
their Rust equivalents
pin the bytes in [`ordinary-journal.json`](../vectors/peer/ordinary-journal.json).
`replayOrdinaryPeerFrames` checks the chain, unique admitted ids, signatures, canonical bytes,
and final head before producing a validated durable peer state. A backend using this format must
atomically compare the previous head and persist the next head, frame, and newly admitted rows.
It must fail closed if a frame or admitted row is missing; raw rows never become admission
records by replay. Checkpoints and non-ordinary frame kinds need separate contracts.
