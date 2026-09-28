# Internal closed holding inventory

`vectors/peer/imported-holdings.json` pins the v1 canonical image and content address in
TypeScript and Rust. The image binds two canonical packs to an inherited-refusal snapshot:
the admitted holding inventory and any separately carried signed manifests that cover its
unsigned members. A manifest can be evidence without itself being admitted. Holdings hidden
by validity or local view policy remain in the inventory.

Each holding's content id must match its claims. A signed holding must verify its own signature;
an unsigned holding must have a verified signed manifest naming its id and author. The inventory
rejects duplicate ids, invalid cover signatures, and any currently refused id. The cover list
is validated and retained in the image, so decoding can recheck the same evidence after restart.
The image sorts pack members by id and rejects noncanonical or snapshot-mismatched bytes.

This verifier checks the claimed inventory, not its completeness relative to the old surface's
authoritative state or the physical backend. That comparison and the old peer's authenticated
state version belong to the later handoff transaction. Raw backend rows outside the inventory
remain unadmitted. This component assigns no new-peer arrival testimony, imports no obligations,
and grants no serving right.
