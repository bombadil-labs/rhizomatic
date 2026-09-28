# Internal peer-state image v2

The TypeScript and Rust witnesses now share a private, canonical CBOR image for a permanent-posture
peer. `vectors/peer/durable-state.json` pins its bytes; `vectors/peer/permanent-commit.json` pins
the transitions. Version 2 embeds the complete v1 image as `base` bytes and binds it to a quota
counter, refusal events, logical exclusions, and stable purge obligations. A later effective order
for the same target advances the refusal event and the obligation's event pointer while keeping
the obligation sequence and worker generation. An advance refusal without locally held bytes has
no purge obligation.

`planPermanentCommit` / `plan_permanent_commit` accepts *already verified final* additions and
effective erasure groups. Its caller must run candidate verification, guards, authority filtering,
ordinary selection, and surface ownership checks before supplying those decisions. The planner
rejects duplicate or permanently refused additions, unsigned effective orders, repeated target
groups, an ordinary quota charge that differs from the new non-order ids, and counter overflow.
It assigns new arrival testimony and forms one image containing
all changes. The file writer then replaces that complete image with a sync, rename, and directory
sync. A post-rename directory sync failure means `committed-unconfirmed`; the caller must reload
and reconcile before acknowledging anything. A failed plan or pre-rename write leaves the prior
image intact. An existing corrupt image blocks reads and writes.

This is an internal, single-writer permanent-posture format. It currently represents signed loose
effective orders that remain admitted and first admission epochs; it is not the typed peer
admission or handoff API. Erasing a held effective order requires retaining its historical order
evidence in a later image version.
It does not store imported qualified references, bundle coverage for unsigned deltas, refusal
reason reports, lower-posture re-entry acts, incomplete-history markers, or durable handoff proof.
The `surfaceHoldsBytes` input is a fact supplied by the host storage layer. Marking a purge
obligation `removed` requires external proof of physical absence; the image alone cannot verify
that proof. No consumer should report byte removal from a planned event or a pending obligation.
The file adapter does not coordinate multiple writers or provide the independent recovery copy
required before an irreversible handoff commit.
