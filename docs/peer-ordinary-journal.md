# Signed-loose peer append journal (step 6 format slice)

The append journal persists one signed-loose transfer at a time while preserving receiver-local
arrival testimony. Both witnesses define canonical frame bytes, replay, and a typed admission
facade over an application supplied atomic store. The facade admits ordinary deltas, effective
erasure orders, and mixed signed-loose transfers. Bundles and re-entry acts remain open.
Existing-pool handoff is outside the greenfield step-6 scope: a backend with rows but no journal
is refused, while a fresh pool starts on an empty journal under its own key.

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

A v2 admission frame carries signed effective erasure orders, their target groups and an ordinary
quota charge. It can carry ordinary additions in the same transfer. Effective orders exclude
co-offered targets before ordinary quota, so an excluded target gets no arrival. V2 purge frames
record a failed byte removal or its verified settlement. The canonical bytes and replay state are
pinned in [`permanent-journal.json`](../vectors/peer/permanent-journal.json).
An order receipt of `effective-erasure` means the signed order itself was admitted and its
peer-local target refusal committed; callers should count it as an admitted addition.

TypeScript exports `OrdinaryJournalPeer.open` and `DurableOrdinaryJournalStore` from its barrel;
Rust exposes `open_ordinary_journal_peer` and the matching store trait. The store returns one
consistent head-and-frame snapshot on open, answers a cheap head read during append, and
atomically compares the prior head while writing the next head, frame and newly admitted rows.
For empty creation (`expectedHead` is `null`), that same transaction must also verify that no
rows already exist; a head-only check can create a false fresh peer over old rows.
Committed frames must remain immutable under that head; a cheap head read relies on this.
On reopen the store also returns rows for the reconstructed admitted ids. The facade checks
each row's id, content address and signature and fails closed on missing, duplicate or changed
rows. Empty-store initialization compares an absent head and refuses a store with rows but no journal.
After checking the rows, open rechecks the journal head. A changed head returns `conflict` so
the caller reopens against one stable snapshot.
A caller may opt into `OrdinaryJournalPeer.open(store, peerId, { allowDegraded: true })` or Rust
`open_ordinary_journal_peer_degraded`. The adapter then returns one row or row-specific fault for
each admitted id through `readAdmittedRowsDegraded`. The typed `degraded` result names the
unavailable ids and reasons. `peer.availableDeltas()` (Rust `available_deltas`) excludes those
ids from serving views while the journal image still governs admission and refusal. The peer
remains writable under the normal head CAS. Reopening after the original row is physically
repaired restores it to the available projection; discarding a genuinely admitted row requires
a signed erasure and purge. The application decides whether an unavailable constitutional record
requires a stricter boot response. The default open remains strict.
A conflict or uncertain commit closes that in-memory peer until it reopens from the journal.
Erasure appends use `compareAndAppendErasure`, which atomically checks any claim that target bytes
are absent. A `removed` purge report uses `compareAndSettlePurge`, which proves absence before it
appends the report. A refuted absence returns `absence-refuted` with the target id and leaves the
facade usable; it is distinct from a head conflict. A target still admitted by the image cannot
be asserted absent. The caller can conservatively report bytes present and settle the resulting
obligation after removal.
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
This checkpoint is ordinary-only. Once the peer has committed an erasure, `checkpoint()` rejects
the state. `peer.rebase()` is the erasure-aware compaction operation: whenever refusal history exists,
it asks `compareAndRebase` to atomically replace all old frames/checkpoint with a canonical
current-state anchor and a new head bound to that anchor's bytes. The current image omits refused
payloads; a shared vector checks that a marker in an old frame is absent from the replacement.
The adapter must remove the old frames from its logical store in the same transaction. Physical
remnants, including SQLite free pages and WAL debt, remain purge debt until the store proves their
absence. `compareAndSettlePurge` must check rows, frames, checkpoints and these remnants before
recording `removed`. Reopen validates the rebase image, anchor head and retained suffix frames.
The facade refuses `removed` for a previously arrived target unless the latest v2 rebase was
committed after that target became refused. A rebase while the target was still admitted retains
its payload, even if a later erasure removes its row. A v1 checkpoint does not qualify either.
Rebase remains available after purge settlement to bound later replay work.
Refusal and purge records may still name the erased target id; the proof checks for target
**payload bytes** on surfaces that can hold them, not for every occurrence of its id.
It still verifies every admitted signature and row on cold open, so a checkpoint reduces frame
replay work but does not make cold open constant time. A conflict or uncertain checkpoint result
closes the facade until reopen. A store without the optional checkpoint method continues to work.

Raw rows never become admission records by replay. Rows outside the admitted id list remain
visible to an application's quarantine/reporting path but grant no admission.
