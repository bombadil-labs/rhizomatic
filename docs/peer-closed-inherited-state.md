# Closed inherited-refusal state

The internal v3 image in `vectors/peer/inherited-state.json` embeds a validated local v2 peer
image and the complete canonical inherited-refusal snapshot. It also pins the inherited
snapshot's BLAKE3 digest. Both witnesses produce identical image bytes. A read checks the local
peer id, embedded digest, both canonical images, and that a currently inherited-refused id is
not locally admitted. Imported events keep their source peer ids and sequences. A new local
event for the same target becomes current while the inherited event remains in history.

`completeRefusalSnapshot` / `complete_refusal_snapshot` combines the inherited history with the
local ledger for a later handoff. The shared vector carries this result through a second closed
peer and pins the resulting digest. No imported event is relabeled as an event of the new peer.

`stageClosedPeerState` / `stage_closed_peer_state` is a one-shot single-writer file operation. It
checks an already stored, separate recovery file against the inherited snapshot digest, syncs
that file and its directory, writes and syncs a temporary primary image, creates the primary
without replacing an existing stage, then syncs its directory. A post-create sync fault is
`committed-unconfirmed`; the caller must reload before retrying. The adapter verifies separate
paths and bytes but cannot attest that the recovery location has an independent physical failure
domain or remains available after the old peer disappears. The host must provide that property.

This image is **closed**. Its local v2 image may contain candidate holdings and peer-local
arrival rows, but staging does not authenticate their import provenance or unsigned bundle
coverage. The later import transaction must verify those, bind active obligations, destination
policy, storage ownership and fencing, and the old peer's authoritative commit proof before any
admission or serving is possible. This module exposes no operation that opens the stage.
