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
import { StoreError } from "../src/storage/store.js";
import { broken, type Break } from "./support/broken-store.js";

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
  // The reference store may be configured with any subset of the three fields; all 8 run.
  const fields = ["timestampAtMost", "arrivalAtMost", "excludeIds"] as const;
  const subsets = fields.reduce<(typeof fields)[number][][]>(
    (all, field) => [...all, ...all.map((subset) => [...subset, field])],
    [[]],
  );
  expect(subsets).toHaveLength(8);
  for (const applied of subsets) {
    it(`applying {${applied.join(", ")}}`, async () => {
      const pushdown = Object.fromEntries(fields.map((f) => [f, applied.includes(f)]));
      const report = await runStoreConformance(
        async () => createMemoryStore({ pushdown }),
        vectors,
      );
      expect(report.skipped).toEqual([]);
      expect(report.passed).toHaveLength(
        vectors.scripts.scripts.length + vectors.scope.cases.length,
      );
    });
  }
});

// ---- broken stores ------------------------------------------------------------------------

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
  "a scope that walks the chain first and filters on signed time afterwards": {
    snapshot: (s) => ({
      scope: async ({ pushdown, ...request }) => {
        const { timestampAtMost, ...rest } = pushdown ?? {};
        const result = await s.scope({ ...request, pushdown: rest });
        return {
          deltas: result.deltas.filter(
            (d) => timestampAtMost === undefined || d.delta.claims.timestamp <= timestampAtMost,
          ),
          applied: { ...result.applied, timestampAtMost: timestampAtMost !== undefined },
        };
      },
    }),
  },
  "a scope that accepts a fractional arrival bound": {
    snapshot: (s) => ({
      scope: async ({ pushdown, ...request }) =>
        s.scope({
          ...request,
          ...(pushdown === undefined
            ? {}
            : {
                pushdown: {
                  ...pushdown,
                  ...(pushdown.arrivalAtMost === undefined
                    ? {}
                    : { arrivalAtMost: Math.max(0, Math.floor(pushdown.arrivalAtMost)) }),
                },
              }),
        }),
    }),
  },
  "an append that answers uncertain": {
    peer: (peer) => ({
      append: async (batch) => {
        const result = await peer.append(batch);
        return result.status === "committed" ? { status: "uncertain", fault: "test" } : result;
      },
    }),
  },
  "a purge that says unproven when it removed nothing": {
    peer: (peer) => ({
      purge: async (ids): Promise<PurgeReport> => ({
        ...(await peer.purge(ids)),
        claim: "unproven",
      }),
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
  "a snapshot whose head and count follow the peer": {
    peer: (peer) => {
      // What the peer looks like now, refreshed after each write through this handle.
      let now: { head: string | null; count: number } | undefined;
      const after = async <T>(result: T): Promise<T> => {
        now = await peer.read();
        return result;
      };
      return {
        append: async (batch) => after(await peer.append(batch)),
        purge: async (ids) => after(await peer.purge(ids)),
        read: async () => {
          const first = await peer.read();
          now = first;
          return Object.defineProperties(
            { ...first },
            {
              head: { get: () => now!.head, enumerable: true },
              count: { get: () => now!.count, enumerable: true },
            },
          );
        },
      };
    },
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
  "a refusal with a code the vector does not list": {
    store: (store) => ({
      createPeer: async (id, options) =>
        store.createPeer(id, options).catch((error: unknown) => {
          if ((error as { code?: string }).code === "peer-exists")
            throw new StoreError("invalid-request", "wrong code");
          throw error;
        }),
    }),
  },
  "an arrival sequence that is reusable after a purge": {
    peer: (peer) => {
      let purged = false;
      return {
        purge: async (ids) => {
          purged = true;
          return peer.purge(ids);
        },
        append: async (batch) => {
          const result = await peer.append(batch).catch((error: unknown) => {
            if (!purged) throw error;
            return { status: "committed" as const, revision: 0, added: [] };
          });
          return result;
        },
      };
    },
  },
  "an older handle that stops working when the peer is opened again": {
    store: (store) => {
      const live = new Map<string, object>();
      const guard = (id: string, peer: PeerStore): PeerStore => {
        const token = {};
        live.set(id, token);
        const check = (): void => {
          if (live.get(id) !== token) throw new StoreError("store-closed", "stale handle");
        };
        return {
          ...peer,
          read: async () => (check(), peer.read()),
          append: async (batch) => (check(), peer.append(batch)),
          purge: async (ids) => (check(), peer.purge(ids)),
        };
      };
      return {
        createPeer: async (id, options) => guard(id, await store.createPeer(id, options)),
        peer: async (id) => guard(id, await store.peer(id)),
      };
    },
  },
  "heads compared after trimming": {
    peer: (peer) => ({
      append: async (batch) =>
        peer.append({
          ...batch,
          expectedHead: batch.expectedHead === null ? null : batch.expectedHead.trim(),
        }),
    }),
  },
  "the empty string taken for no head": {
    peer: (peer) => ({
      append: async (batch) =>
        peer.append({
          ...batch,
          expectedHead: batch.expectedHead === "" ? null : batch.expectedHead,
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

  /** The failures of one script, as `step N (op): message` lines. */
  const failuresIn = async (script: string, fault: Break): Promise<string[]> => {
    const error = (await runStoreConformance(broken(fault), vectors).catch(
      (e: unknown) => e,
    )) as StoreConformanceError;
    expect(error).toBeInstanceOf(StoreConformanceError);
    return error.failures.filter((f) => f.name === `scripts/${script}`).map((f) => f.message);
  };

  it("a repeat inside a batch does not raise the largest committed sequence", async () => {
    // This store counts the sequence of every entry it did not hold before the batch, a
    // repeat inside the batch included. After [x at 11, x at 60] it refuses y at 12.
    const fault: Break = {
      peer: (peer) => {
        let largest = 0;
        return {
          append: async (batch) => {
            const snapshot = await peer.read();
            const held = new Set(
              (await snapshot.get(batch.added.map((a) => a.delta.id))).map((d) => d.id),
            );
            const stale = snapshot.head !== batch.expectedHead;
            const seen = new Set<string>();
            for (const { delta, arrival } of batch.added) {
              if (held.has(delta.id) || seen.has(delta.id)) continue;
              seen.add(delta.id);
              if (!stale && arrival.sequence <= largest)
                throw new StoreError("invalid-admission", "below the raised mark");
            }
            const result = await peer.append(batch);
            if (result.status === "committed")
              for (const { delta, arrival } of batch.added)
                if (!held.has(delta.id)) largest = Math.max(largest, arrival.sequence);
            return result;
          },
        };
      },
    };
    const lines = await failuresIn("a-skipped-entry-spends-no-sequence", fault);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("(append): the append refused");
    // It is the step after the batch with the repeat, and no other script notices.
    const script = vectors.scripts.scripts.find(
      (s) => s.name === "a-skipped-entry-spends-no-sequence",
    )!;
    const step = Number(/^step (\d+) /.exec(lines[0]!)![1]);
    expect(script.steps[step - 1]).toMatchObject({
      op: "append",
      added: [{ arrival: { sequence: 11 } }, { arrival: { sequence: 60 } }],
    });
    expect(script.steps[step]).toMatchObject({ added: [{ arrival: { sequence: 12 } }] });
  });

  it("a bound a 64-bit field can hold is refused before a moved snapshot's state", async () => {
    // 2^53 reaches the store in every witness; 1.5 and -1 stop at a typed runner's own
    // boundary. This store refuses a moved snapshot before it looks at such a bound.
    const fault: Break = {
      snapshot: (s) => ({
        scope: async (request) => {
          const bound = request.pushdown?.arrivalAtMost;
          if (bound !== undefined && Number.isInteger(bound) && bound > Number.MAX_SAFE_INTEGER)
            await s.targets([]).catch((error: unknown) => {
              if ((error as { code?: string }).code === "snapshot-moved") throw error;
            });
          return s.scope(request);
        },
      }),
    };
    const lines = await failuresIn("snapshots", fault);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("(scope): refused with snapshot-moved, expected invalid-request");
    const script = vectors.scripts.scripts.find((s) => s.name === "snapshots")!;
    const step = Number(/^step (\d+) /.exec(lines[0]!)![1]);
    expect(script.steps[step]).toMatchObject({
      snapshot: "s1",
      pushdown: { arrivalAtMost: 2 ** 53 },
    });
  });

  it("the wrapper itself changes nothing", async () => {
    const report = await runStoreConformance(broken({}), vectors);
    expect(report.skipped).toEqual([]);
  });
});

describe("store vectors: what the profile changes", () => {
  // A stand-in, not a store: it relabels the memory store's class and reports so the runner's
  // `proven` rules run before a real proven store exists.
  const proven = (
    report: (report: PurgeReport, surfaces: PurgeReport["surfaces"]) => PurgeReport,
  ): (() => Promise<Store>) =>
    broken({
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
          const inner = await peer.purge(ids);
          return report(
            inner,
            inner.surfaces.filter((s) => s.surface !== "process-memory"),
          );
        },
      }),
    });
  const removedAny = (r: PurgeReport): boolean => r.targets.some((t) => t.outcome === "removed");

  it("a store of class proven creates the proven-posture peer and may claim proven", async () => {
    const store = proven((r, surfaces) => ({
      ...r,
      surfaces,
      claim: removedAny(r) ? "proven" : "nothing-removed",
    }));
    expect((await runStoreConformance(store, vectors)).skipped).toEqual([]);
  });

  it("a store of class proven may claim less: unproven where the vector allows proven", async () => {
    const store = proven((r, surfaces) => ({
      ...r,
      surfaces,
      claim: removedAny(r) ? "unproven" : "nothing-removed",
    }));
    expect((await runStoreConformance(store, vectors)).skipped).toEqual([]);
  });

  const failures = async (store: () => Promise<Store>): Promise<string> => {
    const error = (await runStoreConformance(store, vectors).catch(
      (e: unknown) => e,
    )) as StoreConformanceError;
    expect(error).toBeInstanceOf(StoreConformanceError);
    return error.failures.map((f) => `${f.name}: ${f.message}`).join("\n");
  };

  it("proven is refused where nothing was removed", async () => {
    const store = proven((r, surfaces) => ({ ...r, surfaces, claim: "proven" }));
    expect(await failures(store)).toContain("the report claims proven, expected nothing-removed");
  });

  it("proven is refused with an empty surface list", async () => {
    const store = proven((r) => ({
      ...r,
      surfaces: [],
      claim: removedAny(r) ? "proven" : "nothing-removed",
    }));
    expect(await failures(store)).toContain("claims proven without surfaces that are all absent");
  });

  it("proven is refused while a surface is owed", async () => {
    const store = proven((r, surfaces) => ({
      ...r,
      surfaces: surfaces.map((s) => ({ ...s, state: "owed" })),
      claim: removedAny(r) ? "proven" : "nothing-removed",
    }));
    expect(await failures(store)).toContain("claims proven without surfaces that are all absent");
  });

  it("a store without purge skips the purge scripts and says so", async () => {
    const none = broken({
      profile: (p) => ({ ...p, capabilities: { ...p.capabilities, erasure: "none" } }),
      peer: (peer) => ({ erasure: { ...peer.erasure, storeClass: "none" } }),
    });
    const report = await runStoreConformance(none, vectors);
    expect(report.skipped).toEqual(
      vectors.scripts.scripts
        .filter((script) => script.requires.includes("purge"))
        .map((script) => ({ name: `scripts/${script.name}`, missing: "purge" })),
    );
    expect(report.skipped).toHaveLength(5);
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
