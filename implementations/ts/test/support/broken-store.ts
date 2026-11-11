// A store that breaks one rule: a thin wrapper over the memory reference store. The store tests
// use it to show that the vectors and the conformance runner can fail. Each hook returns the
// members it replaces; everything else passes through to the memory store.

import { createMemoryStore } from "../../src/storage/memory-store.js";
import type { PeerStore, Snapshot, Store, StoreProfile } from "../../src/storage/store.js";

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
