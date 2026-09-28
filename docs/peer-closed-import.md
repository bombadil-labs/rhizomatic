# Closed combined import stage

`vectors/peer/closed-import.json` pins a v4 canonical image and two content addresses in both
witnesses. The carried-state digest covers the closed v3 inherited-refusal image, verified
holding inventory, and active obligation carry. The policy digest separately covers a policy
format identifier and opaque policy bytes. The image also names the old and new peer ids,
attempt id, old state version, and deadline. The new peer's embedded local image must be empty:
host arrival rows are never copied in as new-peer testimony.

All three carried components are encoded and decoded against the same inherited-refusal
snapshot. The image retains the covering signed manifests needed to verify unsigned holdings,
including when the manifest is evidence outside the admitted set. Active purge identities,
surfaces, generations, retry faults, and source-qualified event references are retained.

`stageClosedImportState` / `stage_closed_import_state` creates one primary file only after a
separate inherited-refusal recovery copy matches the snapshot digest and both the copy and its
directory are synced. It syncs the primary file before creating the primary path without
replacement, then syncs the primary directory. A fault after primary creation is reported as
`committed-unconfirmed`; callers reload before retrying. The adapter verifies separate paths
and canonical bytes but cannot prove an independent physical failure domain for the recovery
copy.

This is still a closed stage. The policy bytes are bound but not interpreted, the claimed
holding inventory is not compared to the old peer's authoritative state, and neither witness
authenticates an old-peer commit record or assigns new-peer arrivals here. No API in this
module admits, serves, acknowledges, or transfers obligation ownership. A later transaction
must compare the attempt and both digests against old-peer-authoritative proof before opening
any entry path.
