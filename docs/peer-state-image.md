# Internal peer-state image v1

The internal permanent-posture v2 image and commit transitions are described in
[peer-durable-state.md](peer-durable-state.md).

The TypeScript and Rust witnesses share a private, canonical CBOR image for one peer's current
holdings, full first-epoch arrival history, counters, and permanent refusal ids. The shared bytes
are pinned in `vectors/peer/state.json`. The image embeds a SPEC-8 pack of admitted deltas and
uses map fields `version`, `peer`, `pack`, `sequence`, `transfer`, `arrivals`, and `refused`.

This is a storage component, not the typed SPEC-6 journal API. It does not hold
logical exclusion epochs, quota counters, refusal events, purge obligations, re-entry acts,
incomplete-history markers. It rejects repeated admission epochs and requires
full arrival history. It cannot commit an erasure that needs any of those fields.

The file adapter assumes one writer per peer. It verifies an existing image before replacing it,
keeps prior arrival testimony and permanent refusals, writes a temporary file in the same
directory, syncs it, renames it over the old image, and syncs the directory. Failures before the
rename leave the old image in place. If directory sync fails after the rename, the result is
`committed-unconfirmed`: the caller must reload and reconcile before acknowledging admission.
The adapter does not coordinate writers across processes or storage backends. The public journal
storage seam requires an atomic compare-and-set for each peer.

If the existing image is corrupt, reads and writes fail closed. The adapter has no automatic
recovery copy. Keep that peer offline until an externally authenticated, complete image can be
restored; deleting the file and starting the same `PeerId` again would discard its counters and
refusals.
An interrupted write may leave an uncommitted temporary image beside the primary file. After
stopping the writer, operators may remove stale temporary files; they are never a recovery source.
