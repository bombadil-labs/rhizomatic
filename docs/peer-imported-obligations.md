# Internal active-obligation carry

`vectors/peer/imported-obligations.json` pins a v1 canonical CBOR image and content address in
both witnesses. It carries active `pending` and `failed` byte-removal obligations for a proposed
handoff. Each row keeps the obligation's source peer and sequence, target, declared surface and
storage generation, current source-qualified refusal event, and optional qualified prior
admission epoch. A failed row carries its retryable fault. The rows sort by source peer and
sequence, and the image binds them to the exact inherited-refusal snapshot digest.

Encoding rejects repeated obligation identities, unrefused targets, stale refusal references,
nonpositive generations, and invalid status and fault combinations. Decoding verifies the
snapshot digest and canonical bytes. A later handoff can preserve the stable identity rather
than assigning a new peer-local obligation sequence.

This image is a staged component. It does not prove that a surface holds the named bytes, that
all relevant obligations were copied, or that the old peer has transferred ownership. The old
peer remains responsible for reporting and resuming active work until a durable authoritative
commit and new-peer proof bind this carry with verified holdings, policy, storage fences, and
the inherited-refusal copy. Neither witness exposes this component as a serving peer API.
