// Moves a peer's snapshots with a purge of a sacrificial delta. A test that needs a snapshot to
// move uses this, never an append: a purge that releases a holding moves every older snapshot on
// every store (SPEC-18 proposal §4.13 reading 130), and an append need not. The helper purges
// only a delta whose one pointer targets SACRIFICIAL, so it never removes the delta under test.

import { makeDelta } from "../../src/delta/set.js";
import type { Delta } from "../../src/delta/types.js";
import type { PeerStore } from "../../src/storage/store.js";

/** The entity of every sacrificial delta. No test reads it. */
export const SACRIFICIAL = "entity:sacrificial";

const AUTHOR = `ed25519:${"5a".repeat(32)}`;

/** The nth sacrificial delta: one pointer, at SACRIFICIAL. Seed the peer with as many as moves. */
export const sacrificial = (n: number): Delta =>
  makeDelta({
    timestamp: n,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "sacrificial", target: { kind: "entity", entity: { id: SACRIFICIAL } } }],
  });

const isSacrificial = (delta: Delta): boolean =>
  delta.claims.author === AUTHOR &&
  delta.claims.pointers.length === 1 &&
  delta.claims.pointers[0]!.target.kind === "entity" &&
  delta.claims.pointers[0]!.target.entity.id === SACRIFICIAL;

/**
 * Purges one sacrificial delta that `peer` holds, and checks that the purge removed it, so the
 * peer's revision moved. A delta at SACRIFICIAL that is not one is never purged. Throws when the
 * peer holds no sacrificial delta.
 */
export async function moveByPurge(peer: PeerStore): Promise<void> {
  const snapshot = await peer.read();
  let victim: Delta | undefined;
  try {
    victim = (await snapshot.get(await snapshot.targets([SACRIFICIAL]))).find(isSacrificial);
  } finally {
    snapshot.release();
  }
  if (victim === undefined)
    throw new Error("moveByPurge: the peer holds no sacrificial delta; seed more");
  const report = await peer.purge([victim.id]);
  const [target] = report.targets;
  if (report.targets.length !== 1 || target!.id !== victim.id || target!.outcome !== "removed")
    throw new Error(`moveByPurge: the purge did not remove ${victim.id}`);
}
