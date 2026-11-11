// Test fixture loader: fills a memory store peer with a list of deltas in one admission, so a
// read rail can fetch a scope from it. Nothing outside tests writes a store this way.

import { compareUtf8 } from "../../src/delta/cbor.js";
import type { Delta } from "../../src/delta/types.js";
import { createMemoryStore, type StoreMeter } from "../../src/storage/memory-store.js";
import { scopeSource, type ScopeSource } from "../../src/storage/scope-source.js";
import type { PeerStore } from "../../src/storage/store.js";

export const FIXTURE_PEER = `ed25519:${"0a".repeat(32)}`;
export const FIXTURE_SENDER = "fixture";
export const FIXTURE_HEAD = "fixture-head";

export interface LoadedPeer {
  readonly peer: PeerStore;
  /** Counts the store's index work from the moment the peer is loaded. */
  readonly meter: StoreMeter;
}

/**
 * One admission on an empty peer: `expectedHead: null`, a fixed next head, no frame. Arrival
 * sequences run 1..n in ascending id order, so the load does not depend on the order given.
 */
export async function loadPeer(deltas: Iterable<Delta>): Promise<LoadedPeer> {
  const meter: StoreMeter = { lookups: 0, visited: 0, scans: 0 };
  const store = createMemoryStore({ meter });
  const peer = await store.createPeer(FIXTURE_PEER, { erasure: "unproven" });
  const sorted = [...deltas].sort((a, b) => compareUtf8(a.id, b.id));
  if (sorted.length > 0) {
    const result = await peer.append({
      expectedHead: null,
      nextHead: FIXTURE_HEAD,
      frame: null,
      added: sorted.map((delta, i) => ({
        delta,
        arrival: { id: delta.id, at: 0, sequence: i + 1, transfer: 1, sender: FIXTURE_SENDER },
      })),
    });
    if (result.status !== "committed") throw new Error(`fixture load: ${result.status}`);
  }
  meter.lookups = 0;
  meter.visited = 0;
  meter.scans = 0;
  return { peer, meter };
}

/** Which snapshot reads one fetch made, in order. */
export type StoreCalls = string[];

/**
 * One snapshot, one `scope` call for these entity anchors, then the synchronous source. `calls`
 * receives the name of every snapshot read the fetch makes.
 */
export async function fetchEntities(
  peer: PeerStore,
  entities: readonly string[],
  calls: StoreCalls = [],
): Promise<ScopeSource> {
  const snapshot = await peer.read();
  calls.push("read");
  try {
    const fetched = await snapshot.scope({
      anchors: entities.map((entity) => ({ kind: "entity" as const, entity })),
    });
    calls.push(`scope(${entities.join(",")})`);
    return scopeSource(fetched.deltas);
  } finally {
    snapshot.release();
  }
}
