// A store that breaks one rule: a thin wrapper over the memory reference store. The store tests
// use it to show that the vectors and the conformance runner can fail. Each hook returns the
// members it replaces; everything else passes through to the memory store.

import { createMemoryStore, type MemoryStoreOptions } from "../../src/storage/memory-store.js";
import {
  StoreError,
  type PeerStore,
  type PurgeOutcome,
  type Snapshot,
  type Store,
  type StoreProfile,
  type VerifiedDelta,
} from "../../src/storage/store.js";

export type Break = {
  /** The options of the memory store under the wrapper. */
  options?: MemoryStoreOptions;
  profile?: (profile: StoreProfile) => StoreProfile;
  store?: (store: Store, inner: Store) => Partial<Store>;
  peer?: (peer: PeerStore, inner: Store) => Partial<PeerStore>;
  snapshot?: (snapshot: Snapshot, peer: PeerStore, inner: Store) => Partial<Snapshot>;
};

export function broken(fault: Break): () => Promise<Store> {
  return async () => {
    const inner = createMemoryStore(fault.options);
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
        read: async () => serving(await peer.read(), (id) => kept.get(key(id))),
      };
    },
  };
}

/** A snapshot whose `arrivals` and scope members carry `record(id)` where it has one. */
function serving(
  snapshot: Snapshot,
  record: (id: string) => VerifiedDelta["arrival"] | undefined,
): Snapshot {
  return {
    ...snapshot,
    arrivals: async (ids) => (await snapshot.arrivals(ids)).map((a) => record(a.id) ?? a),
    scope: async (request) => {
      const result = await snapshot.scope(request);
      return {
        ...result,
        deltas: result.deltas.map((m) => ({ ...m, arrival: record(m.delta.id) ?? m.arrival })),
      };
    },
  };
}

/**
 * A store that keeps a peer's arrival record for as long as the peer owes a purge debt for the
 * id. An append of the id clears the debt and replaces the record. A purge that settles the debt
 * (`removed`, for an id the peer no longer held) forgets the debt but keeps the record, so the
 * next append of the id is served the record of the first holding.
 */
export function staleAfterSettledDebt(): Break {
  const books = new WeakMap<
    Store,
    { kept: Map<string, VerifiedDelta["arrival"]>; owed: Set<string> }
  >();
  return {
    peer: (peer, inner) => {
      if (!books.has(inner)) books.set(inner, { kept: new Map(), owed: new Set() });
      const { kept, owed } = books.get(inner)!;
      const key = (id: string): string => `${peer.id} ${id}`;
      return {
        append: async (batch) => {
          const result = await peer.append(batch);
          if (result.status === "committed")
            for (const { arrival } of batch.added) {
              const k = key(arrival.id);
              if (!result.added.includes(arrival.id)) continue;
              if (owed.delete(k)) kept.delete(k);
              if (!kept.has(k)) kept.set(k, arrival);
            }
          return result;
        },
        purge: async (ids) => {
          const report = await peer.purge(ids);
          for (const { id, outcome } of report.targets) {
            const k = key(id);
            if (outcome === "held-by-other-peer") owed.add(k);
            else if (outcome === "removed" && !owed.delete(k)) kept.delete(k);
          }
          return report;
        },
        read: async () => serving(await peer.read(), (id) => kept.get(key(id))),
      };
    },
  };
}

/**
 * A store whose revisions are the memory store's times `k`: they skip values, as a store with
 * one counter for many peers would. It answers by the rules of §4.6, scaled. With
 * `partialThroughPlusOne` a partial page says `through = last + 1`, past its last record and
 * short of `to`. With `oldestKeptFloor` a `from` strictly between the newest dropped revision
 * and the oldest kept one answers `resync-required`: the floor read as the revision just before
 * the oldest kept record.
 */
export function sparse(
  k: number,
  quirk: { partialThroughPlusOne?: boolean; oldestKeptFloor?: boolean } = {},
): Break {
  const now = async (peer: PeerStore): Promise<number> => {
    const snapshot = await peer.read();
    snapshot.release();
    return snapshot.revision;
  };
  return {
    peer: (peer) => ({
      read: async () => {
        const snapshot = await peer.read();
        return { ...snapshot, revision: snapshot.revision * k };
      },
      append: async (batch) => {
        const result = await peer.append(batch);
        return result.status === "committed"
          ? { ...result, revision: result.revision * k }
          : result;
      },
      purge: async (ids) => {
        const report = await peer.purge(ids);
        return { ...report, revision: report.revision * k };
      },
      changes: async (from, to) => {
        const current = await now(peer);
        if (to !== undefined && to < from)
          throw new StoreError("invalid-request", "to must not be less than from");
        if (from > k * current) return { status: "resync-required", current: k * current };
        const inner = Math.floor(from / k);
        const innerTo = to === undefined ? undefined : Math.floor(to / k);
        const page = await peer.changes(inner, innerTo);
        if (page.status === "resync-required") return { ...page, current: page.current * k };
        if (
          quirk.oldestKeptFloor === true &&
          from % k !== 0 &&
          inner > 0 &&
          (await peer.changes(inner - 1)).status === "resync-required"
        )
          return { status: "resync-required", current: k * current };
        const innerEnd = Math.min(innerTo ?? current, current);
        const end = Math.min(to ?? k * current, k * current);
        const records = page.records.map((r) => ({ ...r, revision: r.revision * k }));
        const through =
          page.through === innerEnd
            ? end
            : quirk.partialThroughPlusOne === true
              ? records[records.length - 1]!.revision + 1
              : page.through * k;
        return { status: "ok", records, through };
      },
    }),
  };
}
