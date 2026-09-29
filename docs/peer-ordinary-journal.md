# Ordinary peer append journal (step 6 format slice)

The current single-peer trial writes the full durable v2 image on every append. An ordinary
append journal persists one signed-loose transfer at a time while preserving the same
receiver-local arrival testimony. Both witnesses define canonical frame bytes, replay, and a
typed admission facade over an application supplied atomic store. It does not admit erasures,
bundles, re-entry acts, or handoffs.

A v1 frame contains exactly `version`, receiving `peer`, `prior` frame id, trusted receiver
`at`, `sender`, and a canonical SPEC-8 `pack` of newly admitted signed deltas. The first
`prior` is empty; later frames name the content address of the preceding frame's canonical
bytes. No-op transfers have no frame. Each frame creates one transfer ordinal, even when two
frames share a trusted time. Within a frame, arrival sequences follow ascending delta id.

The internal `encodeOrdinaryPeerFrame` and `decodeOrdinaryPeerFrame` functions in TypeScript and
their Rust equivalents
pin the bytes in [`ordinary-journal.json`](../vectors/peer/ordinary-journal.json).
`replayOrdinaryPeerFrames` checks the chain, unique admitted ids, signatures, canonical bytes,
and final head before producing a validated durable peer state.

TypeScript exports `OrdinaryJournalPeer.open` and `DurableOrdinaryJournalStore` from its barrel;
Rust exposes `open_ordinary_journal_peer` and the matching store trait. The store returns one
consistent head-and-frame snapshot on open, answers a cheap head read during append, and
atomically compares the prior head while writing the next head, frame and newly admitted rows.
Committed frames must remain immutable under that head; a cheap head read relies on this.
Empty-store initialization compares an absent head and refuses a store with rows but no journal.
A conflict or uncertain commit closes that in-memory peer until it reopens from the journal.
The admission receipt gives outcomes, new arrivals and the new head; `snapshot()` copies the
full admitted state only when a reader asks for it.

The adapter must fail closed if a frame or admitted row is missing; raw rows never become
admission records by replay. Checkpoints and non-ordinary frame kinds need separate contracts.
The adapter's row check is outside the portable journal codec: compare rows to admitted ids
before serving, as with the full-image trial.
