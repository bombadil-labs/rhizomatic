# Ordinary peer append journal (step 6 format slice)

An ordinary append journal persists one signed-loose transfer at a time while preserving the same
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
On reopen the store also returns rows for the reconstructed admitted ids. The facade checks
each row's id, content address and signature and fails closed on missing, duplicate or changed
rows. Empty-store initialization compares an absent head and refuses a store with rows but no journal.
A conflict or uncertain commit closes that in-memory peer until it reopens from the journal.
The admission receipt gives outcomes, new arrivals and the new head; `snapshot()` copies the
full admitted state only when a reader asks for it.

`peer.checkpoint()` asks the store to atomically replace the verified frame prefix with a
canonical checkpoint containing the durable v2 image and the exact boundary head. The optional
store method `compareAndCheckpoint` compares that head and installs the checkpoint while pruning
the prefix in one transaction; it does not change the head or admitted rows. Reopen validates the
image, checks its ordinary-only counters, and replays any retained frames from the boundary.
It first reconstructs every pruned frame from the image's admissions and arrival records and
requires the recomputed prefix head to equal the checkpoint boundary. A canonical but altered
image under a genuine head therefore fails closed.
It still verifies every admitted signature and row on cold open, so a checkpoint reduces frame
replay work but does not make cold open constant time. A conflict or uncertain checkpoint result
closes the facade until reopen. A store without the optional checkpoint method continues to work.

Raw rows never become admission records by replay. Rows outside the admitted id list remain
visible to an application's quarantine/reporting path but grant no admission. Non-ordinary
frame kinds need separate contracts.
