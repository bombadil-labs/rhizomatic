// The shared store vectors (SPEC-18 proposal §8) against the memory reference store, and the
// runner against stores that break one rule each. A vector that no broken store can fail pins
// nothing, so each rule the vectors claim has a store here that violates it.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { runStoreConformance, StoreConformanceError } from "../src/storage/store-conformance.js";
import type {
  StoreScopeDocument,
  StoreScriptsDocument,
  StoreVectors,
} from "../src/storage/store-vector-format.js";
import { storeVectors } from "../src/storage/store-vectors.js";
import type {
  PeerStore,
  PurgeReport,
  ScopeResult,
  Snapshot,
  Store,
  StoreProfile,
} from "../src/storage/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(here, "../../../vectors/store", name), "utf8")) as T;
const vectors: StoreVectors = {
  scripts: load<StoreScriptsDocument>("scripts.json"),
  scope: load<StoreScopeDocument>("scope.json"),
};
const memory = async (): Promise<Store> => createMemoryStore();

describe("store vectors: the memory reference store", () => {
  it("the committed documents are what the model generates", () => {
    expect(JSON.parse(JSON.stringify(storeVectors()))).toEqual(vectors);
  });

  for (const script of vectors.scripts.scripts) {
    it(`script ${script.name}`, async () => {
      const report = await runStoreConformance(memory, {
        scripts: { ...vectors.scripts, scripts: [script] },
        scope: { ...vectors.scope, cases: [] },
      });
      expect(report).toEqual({ passed: [`scripts/${script.name}`], skipped: [] });
    });
  }

  for (const scopeCase of vectors.scope.cases) {
    it(`scope ${scopeCase.name}`, async () => {
      const report = await runStoreConformance(memory, {
        scripts: { ...vectors.scripts, scripts: [] },
        scope: { ...vectors.scope, cases: [scopeCase] },
      });
      expect(report.passed).toEqual([`scope/${scopeCase.name}`]);
    });
  }

  it("the default vectors are the committed ones and all of them run", async () => {
    const report = await runStoreConformance(memory);
    expect(report.skipped).toEqual([]);
    expect(report.passed).toHaveLength(vectors.scripts.scripts.length + vectors.scope.cases.length);
  });
});

describe("store vectors: a store that ignores pushdown still conforms", () => {
  // The trim lemma (§4.3): whatever a store does not apply, the host applies, and the scope
  // is the same. These stores report `applied: false` and return the wider set.
  const fields = ["timestampAtMost", "arrivalAtMost", "excludeIds"] as const;
  const cases = [
    ...fields.map((field) => ({ [field]: false })),
    { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
  ];
  for (const pushdown of cases) {
    it(`without ${Object.keys(pushdown).join(", ")}`, async () => {
      const report = await runStoreConformance(
        async () => createMemoryStore({ pushdown }),
        vectors,
      );
      expect(report.skipped).toEqual([]);
    });
  }
});

// ---- broken stores ------------------------------------------------------------------------

type Break = {
  profile?: (profile: StoreProfile) => StoreProfile;
  store?: (store: Store, inner: Store) => Partial<Store>;
  peer?: (peer: PeerStore, store: Store) => Partial<PeerStore>;
  snapshot?: (snapshot: Snapshot, peer: PeerStore) => Partial<Snapshot>;
};

function broken(fault: Break): () => Promise<Store> {
  return async () => {
    const inner = createMemoryStore();
    const wrapPeer = (peer: PeerStore): PeerStore => {
      const withSnapshots: PeerStore = {
        ...peer,
        read: async () => {
          const snapshot = await peer.read();
          return { ...snapshot, ...fault.snapshot?.(snapshot, peer) };
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

const scopeFault =
  (change: (result: ScopeResult, snapshot: Snapshot) => ScopeResult | Promise<ScopeResult>) =>
  (snapshot: Snapshot): Partial<Snapshot> => ({
    scope: async (request) => change(await snapshot.scope(request), snapshot),
  });

const faults: Record<string, Break> = {
  "targets in descending order": {
    snapshot: (s) => ({ targets: async (e) => [...(await s.targets(e))].reverse() }),
  },
  "negators that follow the chain": {
    snapshot: (s) => ({
      negators: async (ids) => {
        const direct = await s.negators(ids);
        return [...new Set([...direct, ...(await s.negators(direct))])].sort();
      },
    }),
  },
  "get that drops the signature": {
    snapshot: (s) => ({
      get: async (ids) => (await s.get(ids)).map(({ id, claims }) => ({ id, claims })),
    }),
  },
  "arrivals with a shifted sequence": {
    snapshot: (s) => ({
      arrivals: async (ids) =>
        (await s.arrivals(ids)).map((a) => ({ ...a, sequence: a.sequence + 1 })),
    }),
  },
  "a count that is one too many": { snapshot: (s) => ({ count: s.count + 1 }) },
  "a scope without its negation chains": {
    snapshot: (s) => ({
      scope: async (request) => {
        const result = await s.scope(request);
        const direct = new Set(await s.targets(request.anchors.map((a) => a.entity)));
        return { ...result, deltas: result.deltas.filter((d) => direct.has(d.delta.id)) };
      },
    }),
  },
  "a scope that reports a pushdown it did not apply": {
    snapshot: (s) => ({
      scope: async ({ pushdown, ...request }) => ({
        ...(await s.scope(request)),
        applied: {
          timestampAtMost: pushdown?.timestampAtMost !== undefined,
          arrivalAtMost: pushdown?.arrivalAtMost !== undefined,
          excludeIds: pushdown?.excludeIds !== undefined,
        },
      }),
    }),
  },
  "a scope that treats exclude as a selection": {
    snapshot: (s) => ({
      scope: async ({ exclude, pushdown, ...request }) =>
        s
          .scope({
            ...request,
            ...(exclude === undefined ? {} : { exclude }),
            pushdown: {
              ...pushdown,
              excludeIds: [...(pushdown?.excludeIds ?? []), ...(exclude ?? [])],
            },
          })
          .then((result) => ({
            ...result,
            applied: { ...result.applied, excludeIds: pushdown?.excludeIds !== undefined },
          })),
    }),
  },
  "a scope that reports applied for a field nobody asked for": {
    snapshot: scopeFault((result) => ({
      ...result,
      applied: { ...result.applied, arrivalAtMost: true },
    })),
  },
  "a scope whose members carry no signature": {
    snapshot: scopeFault((result) => ({
      ...result,
      deltas: result.deltas.map(({ delta, arrival }) => ({
        delta: { id: delta.id, claims: delta.claims },
        arrival,
      })),
    })),
  },
  "a snapshot that follows the peer": {
    peer: (peer) => ({
      read: async () => {
        const first = await peer.read();
        const now = (): Promise<Snapshot> => peer.read();
        return {
          ...first,
          get: async (ids) => (await now()).get(ids),
          targets: async (entities) => (await now()).targets(entities),
          negators: async (ids) => (await now()).negators(ids),
          arrivals: async (ids) => (await now()).arrivals(ids),
          scope: async (request) => (await now()).scope(request),
        };
      },
    }),
  },
  "a released snapshot that still answers": {
    snapshot: () => ({ release: () => {} }),
  },
  "an append without the head compare-and-set": {
    peer: (peer) => ({
      append: async (batch) => peer.append({ ...batch, expectedHead: (await peer.read()).head }),
    }),
  },
  "an append that reports held ids as added": {
    peer: (peer) => ({
      append: async (batch) => {
        const result = await peer.append(batch);
        return result.status === "committed"
          ? { ...result, added: [...new Set(batch.added.map((a) => a.delta.id))].sort() }
          : result;
      },
    }),
  },
  "an append that accepts a frame without a journal": {
    peer: (peer) => ({ append: async (batch) => peer.append({ ...batch, frame: null }) }),
  },
  "a purge that says removed while another peer holds the bytes": {
    peer: (peer) => ({
      purge: async (ids) => {
        const report = await peer.purge(ids);
        return {
          ...report,
          targets: report.targets.map((t) =>
            t.outcome === "held-by-other-peer" ? { ...t, outcome: "removed" as const } : t,
          ),
        };
      },
    }),
  },
  "a purge that tells a stranger who holds an id": {
    peer: (peer, store) => ({
      purge: async (ids) => {
        const report = await peer.purge(ids);
        const stored = new Set<string>();
        for await (const id of store.openAdmin().storedIds()) stored.add(id);
        return {
          ...report,
          targets: report.targets.map((t) =>
            t.outcome === "not-held" && stored.has(t.id)
              ? { ...t, outcome: "held-by-other-peer" as const }
              : t,
          ),
        };
      },
    }),
  },
  "a purge that claims proven on an unprovable store": {
    peer: (peer) => ({
      purge: async (ids): Promise<PurgeReport> => ({ ...(await peer.purge(ids)), claim: "proven" }),
    }),
  },
  "a purge report without its boundary": {
    peer: (peer) => ({
      purge: async (ids) =>
        ({ ...(await peer.purge(ids)), boundary: "" }) as unknown as PurgeReport,
    }),
  },
  "a proven-posture peer on an unprovable store": {
    store: (store) => ({
      createPeer: async (id, options) => {
        const peer = await store.createPeer(id, { erasure: "unproven" });
        return { ...peer, erasure: { ...peer.erasure, posture: options.erasure } };
      },
    }),
  },
  "a peer created twice": {
    store: (store) => ({
      createPeer: async (id, options) =>
        store.createPeer(id, options).catch(async (error: unknown) => {
          if ((error as { code?: string }).code === "peer-exists") return store.peer(id);
          throw error;
        }),
    }),
  },
  "a peer opened into existence": {
    store: (store) => ({
      peer: async (id) => store.peer(id).catch(() => store.createPeer(id, { erasure: "unproven" })),
    }),
  },
  "an export that lists the whole store for one peer": {
    store: (store, inner) => ({
      openAdmin: () => {
        const admin = inner.openAdmin();
        return {
          ...admin,
          peer: (id) => ({ ...admin.peer(id), ids: () => admin.storedIds() }),
        };
      },
    }),
  },
  "a stored listing that repeats shared ids": {
    store: (store, inner) => ({
      openAdmin: () => {
        const admin = inner.openAdmin();
        return {
          ...admin,
          async *storedIds() {
            const ids: string[] = [];
            for await (const peer of admin.peers())
              for await (const id of admin.peer(peer).ids()) ids.push(id);
            yield* ids.sort();
          },
        };
      },
    }),
  },
  "peers listed in creation order": {
    store: (store, inner) => ({
      openAdmin: () => {
        const admin = inner.openAdmin();
        return {
          ...admin,
          async *peers() {
            const peers: string[] = [];
            for await (const peer of admin.peers()) peers.push(peer);
            yield* peers.reverse();
          },
        };
      },
    }),
  },
};

describe("store vectors: each broken store fails", () => {
  for (const [name, fault] of Object.entries(faults)) {
    it(name, async () => {
      await expect(runStoreConformance(broken(fault), vectors)).rejects.toBeInstanceOf(
        StoreConformanceError,
      );
    });
  }

  it("a store that is not the reference is held to the applied bound, not to exact ids", async () => {
    // The bound that makes the trim lemma hold: R must stay inside S over the selection the
    // store reports applied. Here the store reports a pushdown and returns the wider set.
    const fault = {
      ...faults["a scope that reports a pushdown it did not apply"],
      profile: (p: StoreProfile): StoreProfile => ({ ...p, formatVersion: "test.other/1" }),
    };
    const error = (await runStoreConformance(broken(fault), vectors).catch(
      (e: unknown) => e,
    )) as StoreConformanceError;
    expect(error).toBeInstanceOf(StoreConformanceError);
    const messages = error.failures.map((f) => `${f.name}: ${f.message}`);
    expect(messages.filter((m) => m.includes("leaves S over the applied selection"))).not.toEqual(
      [],
    );
    expect(messages.filter((m) => m.includes("the reference store"))).toEqual([]);
  });

  it("the trimmed scope is compared: a wrong expected scope fails a store that pushes nothing down", async () => {
    // With nothing applied, the bounds do not mention the scope under the whole selection.
    // Only the trim comparison reads it.
    const victim = vectors.scope.cases.find((c) => c.name === "every-field")!;
    const whole = victim.scopes.find((s) => s.fields.length === 3)!;
    const wrong: StoreVectors = {
      scripts: { ...vectors.scripts, scripts: [] },
      scope: {
        ...vectors.scope,
        cases: [
          {
            ...victim,
            scopes: victim.scopes.map((s) => (s === whole ? { ...s, ids: s.ids.slice(1) } : s)),
          },
        ],
      },
    };
    const lazy = async (): Promise<Store> =>
      createMemoryStore({
        pushdown: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
      });
    const error = (await runStoreConformance(lazy, wrong).catch(
      (e: unknown) => e,
    )) as StoreConformanceError;
    expect(error).toBeInstanceOf(StoreConformanceError);
    expect(error.failures.map((f) => f.message).join("\n")).toContain("the trimmed scope is");
  });

  it("the lower bound is checked where the residual selection would hide a missing member", async () => {
    // Asked for no pushdown, this store leaves out its latest member. The trimmed scope under
    // a signed-time cut is still right, so only the lower bound can see the omission.
    const fault: Break = {
      profile: (p) => ({ ...p, formatVersion: "test.other/1" }),
      snapshot: (s) => ({
        scope: async (request) => {
          const result = await s.scope(request);
          if (request.pushdown !== undefined) return result;
          const latest = Math.max(...result.deltas.map((d) => d.delta.claims.timestamp));
          return {
            ...result,
            deltas: result.deltas.filter((d) => d.delta.claims.timestamp !== latest),
          };
        },
      }),
    };
    const error = (await runStoreConformance(broken(fault), vectors).catch(
      (e: unknown) => e,
    )) as StoreConformanceError;
    expect(error.failures.map((f) => f.name)).toContain("scope/signed-time-cuts-a-chain");
  });

  it("the wrapper itself changes nothing", async () => {
    const report = await runStoreConformance(broken({}), vectors);
    expect(report.skipped).toEqual([]);
  });
});

describe("store vectors: what the profile changes", () => {
  it("a store of class proven creates the proven-posture peer and may claim proven", async () => {
    // A stand-in, not a store: it relabels the memory store's class and reports so the
    // runner's `proven` rules run before a real proven store exists.
    const proven = broken({
      profile: (p) => ({
        ...p,
        formatVersion: "test.proven/1",
        capabilities: { ...p.capabilities, erasure: "proven" },
      }),
      store: (store) => ({
        createPeer: async (id, options) => {
          const peer = await store.createPeer(id, { erasure: "unproven" });
          return { ...peer, erasure: { posture: options.erasure, storeClass: "proven" } };
        },
      }),
      peer: (peer) => ({
        erasure: { ...peer.erasure, storeClass: "proven" },
        purge: async (ids) => {
          const report = await peer.purge(ids);
          const surfaces = report.surfaces.filter((s) => s.surface !== "process-memory");
          return {
            ...report,
            surfaces,
            claim: surfaces.every((s) => s.state === "absent") ? "proven" : "unproven",
          };
        },
      }),
    });
    const report = await runStoreConformance(proven, vectors);
    expect(report.skipped).toEqual([]);
  });

  it("a store without purge skips the purge scripts and says so", async () => {
    const none = broken({
      profile: (p) => ({ ...p, capabilities: { ...p.capabilities, erasure: "none" } }),
      peer: (peer) => ({ erasure: { ...peer.erasure, storeClass: "none" } }),
    });
    const report = await runStoreConformance(none, vectors);
    expect(report.skipped).toEqual([
      { name: "scripts/purge", missing: "purge" },
      { name: "scripts/purge-clears-a-debt-on-append", missing: "purge" },
    ]);
  });

  it("a store with a journal skips the script that needs its absence", async () => {
    const journal = broken({
      profile: (p) => ({ ...p, capabilities: { ...p.capabilities, journal: true } }),
    });
    const report = await runStoreConformance(journal, vectors);
    expect(report.skipped).toEqual([
      { name: "scripts/a-frame-needs-the-journal", missing: "journal-absent" },
    ]);
  });
});
