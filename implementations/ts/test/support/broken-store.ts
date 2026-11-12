// A store that breaks one rule: a thin wrapper over the memory reference store. The store tests
// use it to show that the vectors and the conformance runner can fail. Each hook returns the
// members it replaces; everything else passes through to the memory store.

import { createMemoryStore } from "../../src/storage/memory-store.js";
import type {
  PeerStore,
  PurgeOutcome,
  Snapshot,
  Store,
  StoreProfile,
  VerifiedDelta,
} from "../../src/storage/store.js";

export type Break = {
  profile?: (profile: StoreProfile) => StoreProfile;
  store?: (store: Store, inner: Store) => Partial<Store>;
  peer?: (peer: PeerStore, inner: Store) => Partial<PeerStore>;
  snapshot?: (snapshot: Snapshot, peer: PeerStore, inner: Store) => Partial<Snapshot>;
};

export function broken(fault: Break): () => Promise<Store> {
  return async () => {
    const inner = createMemoryStore();
    const wrapPeer = (peer: PeerStore): PeerStore => {
      const withSnapshots: PeerStore = {
        ...peer,
        read: async () => {
          const snapshot = await peer.read();
          return { ...snapshot, ...fault.snapshot?.(snapshot, peer, inner) };
        },
      };
      return { ...withSnapshots, ...fault.peer?.(withSnapshots, inner) };
    };
    const store: Store = {
      profile: fault.profile?.(inner.profile) ?? inner.profile,
      createPeer: async (id, options) => wrapPeer(await inner.createPeer(id, options)),
      peer: async (id) => wrapPeer(await inner.peer(id)),
      openAdmin: () => inner.openAdmin(),
      close: () => inner.close(),
    };
    return { ...store, ...fault.store?.(store, inner) };
  };
}

/**
 * A store that serves a peer's first arrival record for an id again after the id is appended
 * anew. It forgets the record on a purge only when `forgets` says so for that target's outcome.
 */
export function stale(forgets: (outcome: PurgeOutcome) => boolean): Break {
  const first = new WeakMap<Store, Map<string, VerifiedDelta["arrival"]>>();
  return {
    peer: (peer, inner) => {
      if (!first.has(inner)) first.set(inner, new Map());
      const kept = first.get(inner)!;
      const key = (id: string): string => `${peer.id} ${id}`;
      return {
        append: async (batch) => {
          const result = await peer.append(batch);
          if (result.status === "committed")
            for (const { arrival } of batch.added)
              if (result.added.includes(arrival.id) && !kept.has(key(arrival.id)))
                kept.set(key(arrival.id), arrival);
          return result;
        },
        purge: async (ids) => {
          const report = await peer.purge(ids);
          for (const target of report.targets)
            if (forgets(target.outcome)) kept.delete(key(target.id));
          return report;
        },
        read: async () => {
          const snapshot = await peer.read();
          return {
            ...snapshot,
            arrivals: async (ids) =>
              (await snapshot.arrivals(ids)).map((a) => kept.get(key(a.id)) ?? a),
            scope: async (request) => {
              const result = await snapshot.scope(request);
              return {
                ...result,
                deltas: result.deltas.map((m) => ({
                  ...m,
                  arrival: kept.get(key(m.delta.id)) ?? m.arrival,
                })),
              };
            },
          };
        },
      };
    },
  };
}
