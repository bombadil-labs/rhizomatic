# Typed single-peer admission (step 6 trial)

The TypeScript barrel exports `openSinglePeer`, `admitSinglePeerTransfer`, the durable peer
state types and codecs, and the matching pure planners. Rust exposes the same behavior through
`single_peer` and its durable-state and admission modules. The shared
[`single-peer-api.json`](../vectors/peer/single-peer-api.json) vectors pin the empty and admitted
image bytes in both witnesses.

This first callable path is for one permanent-posture peer receiving **signed loose ordinary**
deltas. It checks signatures and permanent refusals, runs candidate-local guards against the
pre-transfer admitted set, applies the ordinary new-id count capacity, assigns receiver-local
arrival testimony, and commits one canonical durable v2 image. Bundles, effective erasure
orders, lens closure, re-entry, and handoff are not covered by this path. The classifier must
identify erasure candidates so they receive `unsupported-erasure`, never ordinary admission.
Consumers must not purge a delta's separate row through an older erasure path while its peer
image still admits that delta; reopening from the image would restore it.

`emptyDurablePeerState(peerId)` constructs a canonical empty image for a governing Ed25519 key.
`openSinglePeer(store, peerId)` reads an existing image or atomically installs that empty image.
The caller must authenticate the governing key outside this API. An `authenticated-peer` origin
requires a sender key verified by the caller; use `unattributed` when the sender is unknown.
`local` and `unattributed` are explicit arrival markers, not `PeerId`s.
The receiver's own key is not a valid `authenticated-peer` sender; use `local` for that path.

The `DurablePeerStore` contract is the storage boundary. `readImage` distinguishes an empty
store, an image with its exact current canonical bytes, and rows without an image. A reopen
uses the admitted DeltaSet inside the image; the adapter must verify that any separately stored
rows agree with that image before exposing them. Rows without an image fail closed. `compareAndSet`
compares those bytes and durably persists the next
image **and every newly admitted delta row in one transaction**. `conflict` means neither moved.
`committed-unconfirmed` means a write may have landed, so admission must stop until backend
recovery establishes its outcome. The Node-only `@bombadil/rhizomatic/node` subpath exports
`FileDurablePeerStore` for one writer and
keeps the whole delta set inside its image. A SQLite or memory adapter must implement its own
atomic comparison and row write; doing the two writes separately breaks the contract.

For a local append, `mode: "atomic"` refuses the whole offered unit if any candidate fails,
returning the first failure and its guard reason without writing. Application checks over the
whole batch run once under the same admission lock before this call. For a received transfer,
`mode: "individual"` commits the eligible subset and returns an outcome per offered delta.
An offer that changes no image bytes returns its outcomes without a store write.
The substrate capacity counts new ordinary IDs; an application's per-author byte or volume
budget belongs in its own check or guard. Pass `Number.MAX_SAFE_INTEGER` to leave the substrate
count effectively unbounded for the trial.

The facade caches a verified state for each store object and reuses it only while `readImage`
returns exactly the same bytes. It verifies a changed image before planning; callers must treat
admitted Delta values as immutable, as required by `DeltaSet`. Returned states are separate copies
from the cached state. Keep one store object per peer during a trial. A cold read after restart
verifies every held signature once. The current v2 image rewrites the
full admitted set and arrival history on every commit. It is
appropriate for an unmerged correctness trial on a fresh host store. A production merge on a
large store needs a measured storage strategy that preserves the same atomic logical image and
arrival counters without an O(history) write per append. Opening an existing populated host
store also needs an explicit bootstrap contract; creating an empty image over it would lose
refusals and invent no trustworthy prior arrivals.
