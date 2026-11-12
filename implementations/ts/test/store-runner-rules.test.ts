// The conformance runner's own rules (vectors/store/README.md §3, §4). The runner is the
// instrument every store is judged by, so each rule it checks has a store here that breaks that
// rule and nothing before it. The run must fail, in the named document, with the message of
// that rule: a runner that stops checking the rule passes the store, or fails it with another
// rule's message, and the case goes red either way.
//
// A script stops at its first failing step. A wrong store is therefore built so that some
// script reaches the step that shows the rule.
//
// Rules no wrapped store can reach, and why:
// - The checks of the documents themselves (an unknown format, a corpus id that does not
//   recompute, a step that names an unknown delta, peer or snapshot, a scope case without the
//   scope of a subset). No store answer leads there. "a wrong document" below covers them with
//   wrong documents.
// - "a store with erasure class none answered a purge" is reached with a document of this
//   file. The shared scripts that purge are skipped for such a store (README §6).
// - In a scope case, "the case lacks a scope for the applied fields" cannot fail for a correct
//   document: applied ⊆ requested is checked first, and the document holds every subset.
// - The trim comparison (§4 step 7) follows from the two bounds and the member checks, so a
//   store that passes those passes it. It is reached here through a `get` that returns held
//   deltas with other claims, which this runner reads the held deltas from; and in
//   store-vectors.test.ts through a document whose exact scope is wrong.
//
// Not covered here: what a store must do (store-vectors.test.ts, "each broken store fails"),
// and ownership, which no conformance run checks (store.test.ts).

import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { runStoreConformance, StoreConformanceError } from "../src/storage/store-conformance.js";
import type { StoreVectors } from "../src/storage/store-vector-format.js";
import { storeVectors } from "../src/storage/store-vectors.js";
import type {
  AppendResult,
  Exporter,
  PeerExporter,
  PeerStore,
  PurgeReport,
  ScopeResult,
  Snapshot,
  Store,
  StoreErrorCode,
  StoreProfile,
  VerifiedDelta,
} from "../src/storage/store.js";
import { StoreError } from "../src/storage/store.js";
import type { Delta } from "../src/delta/types.js";
import { broken, type Break } from "./support/broken-store.js";

const vectors = storeVectors();

// ---- parts of a wrong store -----------------------------------------------------------------

/** Not the reference store: the runner holds it to the general rules only. */
const other: Break = { profile: (p) => ({ ...p, formatVersion: "test.other/1" }) };
const join = (...faults: Break[]): Break => Object.assign({}, ...faults) as Break;

const codeOf = (error: unknown): string | undefined =>
  error instanceof StoreError ? error.code : undefined;
/** Runs `action`; a refusal with code `from` becomes one with code `to`. */
async function recoded<T>(
  from: StoreErrorCode,
  to: StoreErrorCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (codeOf(error) === from) throw new StoreError(to, "another code");
    throw error;
  }
}

type Query = "get" | "arrivals" | "targets" | "negators" | "scope";
const QUERIES: readonly Query[] = ["get", "arrivals", "targets", "negators", "scope"];
/** Replaces every query of a snapshot by `wrap` around it. */
const queries =
  (wrap: (run: () => Promise<unknown>) => Promise<unknown>) =>
  (s: Snapshot): Partial<Snapshot> =>
    Object.fromEntries(
      QUERIES.map((name) => [
        name,
        (argument: never) => wrap(() => (s[name] as (a: never) => Promise<unknown>)(argument)),
      ]),
    ) as Partial<Snapshot>;

const scope =
  (
    change: (
      result: ScopeResult,
      s: Snapshot,
      peer: PeerStore,
      inner: Store,
    ) => Promise<ScopeResult>,
    ask: (request: ScopeRequest) => ScopeRequest = (r) => r,
  ) =>
  (s: Snapshot, peer: PeerStore, inner: Store): Partial<Snapshot> => ({
    scope: async (request) => change(await s.scope(ask(request)), s, peer, inner),
  });
type ScopeRequest = Parameters<Snapshot["scope"]>[0];
/** The request without the ids the read holds: a store that ignores `exclude` sees this. */
const withoutExclude = (request: ScopeRequest): ScopeRequest => ({
  anchors: request.anchors,
  ...(request.pushdown === undefined ? {} : { pushdown: request.pushdown }),
});
const members =
  (change: (deltas: readonly VerifiedDelta[]) => readonly VerifiedDelta[]) =>
  async (result: ScopeResult): Promise<ScopeResult> => ({
    ...result,
    deltas: change(result.deltas),
  });

const get = (change: (deltas: readonly Delta[]) => readonly Delta[]): Break => ({
  snapshot: (s) => ({ get: async (ids) => change(await s.get(ids)) }),
});
const purge = (change: (report: PurgeReport, ids: readonly string[]) => PurgeReport): Break => ({
  peer: (peer) => ({ purge: async (ids) => change(await peer.purge(ids), ids) }),
});
const append = (change: (result: AppendResult) => AppendResult | Promise<AppendResult>): Break => ({
  peer: (peer) => ({ append: async (batch) => change(await peer.append(batch)) }),
});
const exporter = (change: (listing: PeerExporter, admin: Exporter) => Partial<PeerExporter>) => ({
  store: (_store: Store, inner: Store): Partial<Store> => ({
    openAdmin: () => {
      const admin = inner.openAdmin();
      return {
        ...admin,
        peer: (id) => {
          const listing = admin.peer(id);
          return { ...listing, ...change(listing, admin) };
        },
      };
    },
  }),
});
async function* listed<T>(items: AsyncIterable<T>, change: (all: T[]) => T[]): AsyncIterable<T> {
  const all: T[] = [];
  for await (const item of items) all.push(item);
  yield* change(all);
}
const reversed = <T>(all: readonly T[]): T[] => [...all].reverse();
const otherClaims = (delta: Delta): Delta => ({
  ...delta,
  claims: { ...delta.claims, timestamp: delta.claims.timestamp + 1 },
});
const unsigned = ({ id, claims }: Delta): Delta => ({ id, claims });

/**
 * A store whose revisions are the memory store's plus an offset this wrapper moves. `moved`
 * says how far to move it after an append or a purge; `reported` skews the revision a result
 * or a report states.
 */
function revisions(rule: {
  append?: (outcome: "refused" | "conflict" | "committed", advanced: boolean) => number;
  purge?: (advanced: boolean) => number;
  reported?: { append?: number; purge?: number };
}): Break {
  const offsets = new WeakMap<Store, Map<string, number>>();
  return {
    peer: (peer, inner) => {
      if (!offsets.has(inner)) offsets.set(inner, new Map());
      const of = offsets.get(inner)!;
      const offset = (): number => of.get(peer.id) ?? 0;
      const move = (by: number): void => void of.set(peer.id, offset() + by);
      const real = async (): Promise<number> => (await peer.read()).revision;
      return {
        read: async () => {
          const snapshot = await peer.read();
          return { ...snapshot, revision: snapshot.revision + offset() };
        },
        append: async (batch) => {
          const before = await real();
          let result: AppendResult;
          try {
            result = await peer.append(batch);
          } catch (error) {
            move(rule.append?.("refused", false) ?? 0);
            throw error;
          }
          if (result.status !== "committed") {
            move(rule.append?.("conflict", false) ?? 0);
            return result;
          }
          move(rule.append?.("committed", result.revision > before) ?? 0);
          return {
            ...result,
            revision: result.revision + offset() + (rule.reported?.append ?? 0),
          };
        },
        purge: async (ids) => {
          const before = await real();
          const report = await peer.purge(ids);
          move(rule.purge?.(report.revision > before) ?? 0);
          return {
            ...report,
            revision: report.revision + offset() + (rule.reported?.purge ?? 0),
          };
        },
      };
    },
  };
}

/** A stand-in of class `proven`: the memory store with its class and its reports relabelled. */
const provenClass: Break = {
  profile: (p) => ({
    ...p,
    formatVersion: "test.proven/1",
    capabilities: { ...p.capabilities, erasure: "proven" },
  }),
  peer: (peer) => ({ erasure: { ...peer.erasure, storeClass: "proven" } }),
};

// ---- the table ------------------------------------------------------------------------------

type Rule = {
  /** The document the failure must be in. */
  readonly doc: "scripts" | "scope";
  /** Text of the rule's own message. A step's failure starts with `step N (op): `. */
  readonly says: string | RegExp;
  readonly store: Break;
  readonly vectors?: StoreVectors;
};

const RULES: Readonly<Record<string, Rule>> = {
  // -- refusals (README §3, "Refusals") --
  "createPeer refuses with a code the step does not list": {
    doc: "scripts",
    says: "(createPeer): refused with invalid-request, expected peer-exists",
    store: {
      store: (store) => ({
        createPeer: (id, options) =>
          recoded("peer-exists", "invalid-request", () => store.createPeer(id, options)),
      }),
    },
  },
  "createPeer refuses a two-cause step with a code outside its list": {
    doc: "scripts",
    says: "(createPeer): refused with invalid-request, expected posture-refused or peer-exists",
    store: {
      store: (store) => ({
        createPeer: async (id, options) => {
          if (options.erasure === "proven")
            await recoded("posture-refused", "invalid-request", () =>
              store.createPeer(id, options),
            );
          return store.createPeer(id, options);
        },
      }),
    },
    vectors: {
      ...vectors,
      scripts: {
        ...vectors.scripts,
        scripts: vectors.scripts.scripts.filter((s) => s.name === "requests-a-store-refuses"),
      },
    },
  },
  "openPeer refuses with a code the step does not list": {
    doc: "scripts",
    says: "(openPeer): refused with invalid-request, expected peer-absent",
    store: {
      store: (store) => ({
        peer: (id) => recoded("peer-absent", "invalid-request", () => store.peer(id)),
      }),
    },
  },
  "append refuses with a code the step does not list": {
    doc: "scripts",
    says: "(append): refused with invalid-request, expected invalid-admission",
    store: {
      peer: (peer) => ({
        append: (batch) =>
          recoded("invalid-admission", "invalid-request", () => peer.append(batch)),
      }),
    },
  },
  "a query refuses with a code the step does not list": {
    doc: "scripts",
    says: /\((targets|get|arrivals|negators|scope)\): refused with store-closed, expected snapshot-released/,
    store: {
      snapshot: queries((run) => recoded("snapshot-released", "store-closed", run)),
    },
  },
  "export refuses with a code the step does not list": {
    doc: "scripts",
    says: "(export): refused with invalid-request, expected peer-absent",
    store: exporter((listing) => ({
      ids: () =>
        (async function* () {
          yield* await recoded("peer-absent", "invalid-request", async () => {
            const ids: string[] = [];
            for await (const id of listing.ids()) ids.push(id);
            return ids;
          });
        })(),
    })),
  },
  "a moved snapshot refuses with a code that is not snapshot-moved": {
    doc: "scripts",
    says: /the query refused with snapshot-released, and only snapshot-moved or an answer conforms/,
    store: {
      snapshot: queries((run) => recoded("snapshot-moved", "snapshot-released", run)),
    },
  },
  "a current snapshot refuses a query": {
    doc: "scripts",
    says: "(targets): the query refused with snapshot-moved, and it must answer",
    store: {
      snapshot: () => ({
        targets: async () => {
          throw new StoreError("snapshot-moved", "never moved");
        },
      }),
    },
  },
  "a released snapshot answers": {
    doc: "scripts",
    says: "expected a refusal: snapshot-released",
    store: { snapshot: () => ({ release: () => {} }) },
  },

  // -- createPeer and openPeer (§3.1, §3.2) --
  "createPeer refuses a peer it must create": {
    doc: "scripts",
    says: "(createPeer): expected the peer to be created",
    store: {
      store: (store) => {
        let created = 0;
        return {
          createPeer: async (id, options) => {
            if (created++ > 0) throw new StoreError("peer-exists", "one peer only");
            return store.createPeer(id, options);
          },
        };
      },
    },
  },
  "a store of class proven refuses the proven-posture peer": {
    doc: "scripts",
    says: "(createPeer): expected the peer to be created",
    store: provenClass,
    vectors: {
      ...vectors,
      scripts: {
        ...vectors.scripts,
        scripts: vectors.scripts.scripts.filter((s) => s.name === "peers-and-postures"),
      },
    },
  },
  "a store of class unprovable creates the proven-posture peer": {
    doc: "scripts",
    says: "(createPeer): expected a refusal: posture-refused",
    store: {
      store: (store) => ({
        createPeer: async (id, options) => {
          const peer = await store.createPeer(id, { erasure: "unproven" });
          return { ...peer, erasure: { ...peer.erasure, posture: options.erasure } };
        },
      }),
    },
  },
  "createPeer creates a peer it must refuse": {
    doc: "scripts",
    says: "(createPeer): expected a refusal: peer-exists",
    store: {
      store: (store) => ({
        createPeer: (id, options) =>
          store.createPeer(id, options).catch((error: unknown) => {
            if (codeOf(error) === "peer-exists") return store.peer(id);
            throw error;
          }),
      }),
    },
  },
  "a created handle reports another posture": {
    doc: "scripts",
    says: "(createPeer): the peer's posture differs",
    store: {
      store: (store) => ({
        createPeer: async (id, options) => {
          const peer = await store.createPeer(id, options);
          return { ...peer, erasure: { ...peer.erasure, posture: "proven" } };
        },
      }),
    },
  },
  "a created handle reports another erasure class than the profile": {
    doc: "scripts",
    says: "(createPeer): the peer did not record its store's erasure class",
    store: {
      store: (store) => ({
        createPeer: async (id, options) => {
          const peer = await store.createPeer(id, options);
          return { ...peer, erasure: { ...peer.erasure, storeClass: "proven" } };
        },
      }),
    },
  },
  "openPeer refuses a peer that exists": {
    doc: "scripts",
    says: "(openPeer): expected the peer to open",
    store: {
      store: () => ({
        peer: async () => {
          throw new StoreError("peer-absent", "never opens");
        },
      }),
    },
  },
  "openPeer creates the peer it must refuse": {
    doc: "scripts",
    says: "(openPeer): expected a refusal: peer-absent",
    store: {
      store: (store) => ({
        peer: (id) => store.peer(id).catch(() => store.createPeer(id, { erasure: "unproven" })),
      }),
    },
  },
  "an opened handle reports another posture": {
    doc: "scripts",
    says: "(openPeer): the posture differs",
    store: {
      store: (store) => ({
        peer: async (id) => {
          const peer = await store.peer(id);
          return { ...peer, erasure: { ...peer.erasure, posture: "proven" } };
        },
      }),
    },
  },

  // -- append (§3.3) --
  "append commits what it must refuse": {
    doc: "scripts",
    says: "(append): expected a refusal: capability-absent",
    store: { peer: (peer) => ({ append: (batch) => peer.append({ ...batch, frame: null }) }) },
  },
  "append refuses what it must commit": {
    doc: "scripts",
    says: "(append): the append refused",
    store: {
      peer: (peer) => ({
        append: async (batch) => {
          if (batch.added.length > 1) throw new StoreError("invalid-admission", "too many");
          return peer.append(batch);
        },
      }),
    },
  },
  "append commits against a stale head": {
    doc: "scripts",
    says: "(append): the append answered committed",
    store: {
      peer: (peer) => ({
        append: async (batch) => peer.append({ ...batch, expectedHead: (await peer.read()).head }),
      }),
    },
  },
  "append answers conflict where it must commit": {
    doc: "scripts",
    says: "(append): the append answered conflict",
    store: {
      peer: (peer) => ({
        append: async (batch) =>
          batch.expectedHead === null ? peer.append(batch) : { status: "conflict" },
      }),
    },
  },
  "append answers uncertain": {
    doc: "scripts",
    says: "(append): the append answered uncertain",
    store: append((result) =>
      result.status === "committed" ? { status: "uncertain", fault: "test" } : result,
    ),
  },
  "append reports ids it did not add": {
    doc: "scripts",
    says: "(append): added [",
    store: {
      peer: (peer) => ({
        append: async (batch) => {
          const result = await peer.append(batch);
          return result.status === "committed"
            ? { ...result, added: [...new Set(batch.added.map((a) => a.delta.id))].sort() }
            : result;
        },
      }),
    },
  },
  "append lists the added ids in descending order": {
    doc: "scripts",
    says: "(append): added [",
    store: append((result) =>
      result.status === "committed" ? { ...result, added: reversed(result.added) } : result,
    ),
  },
  "a refused append moves the revision": {
    doc: "scripts",
    says: "(append): a refused append moved the revision",
    store: revisions({ append: (outcome) => (outcome === "refused" ? 1 : 0) }),
  },
  "a conflict moves the revision": {
    doc: "scripts",
    says: "(append): an append that did not commit moved the revision",
    store: revisions({ append: (outcome) => (outcome === "conflict" ? 1 : 0) }),
  },
  "an append result states a revision that is not the peer's": {
    doc: "scripts",
    says: "(append): the append result's revision is not the peer's",
    store: revisions({ reported: { append: 1 } }),
  },
  "an append that changes nothing advances the revision": {
    doc: "scripts",
    says: "(append): the revision advanced",
    store: revisions({
      append: (outcome, advanced) => (outcome === "committed" && !advanced ? 1 : 0),
    }),
  },
  "an append that adds an id does not advance the revision": {
    doc: "scripts",
    says: "(append): the revision did not advance",
    store: revisions({
      append: (outcome, advanced) => (outcome === "committed" && advanced ? -1 : 0),
    }),
  },
  "the last entry of a batch with one id is the one held, not the first": {
    doc: "scripts",
    says: /\((get|arrivals|scope|export)\): .*(the signature differs|carries another arrival record)/,
    store: {
      peer: (peer) => ({
        append: (batch) => peer.append({ ...batch, added: reversed(batch.added) }),
      }),
    },
  },

  // -- purge (§3.4) --
  "purge refuses on a store that offers it": {
    doc: "scripts",
    says: "(purge): the purge refused with capability-absent",
    store: {
      peer: () => ({
        purge: async () => {
          throw new StoreError("capability-absent", "no purge after all");
        },
      }),
    },
  },
  "purge reports an outcome the step does not expect": {
    doc: "scripts",
    says: "(purge): purge targets",
    store: purge((report) => ({
      ...report,
      targets: report.targets.map((t) =>
        t.outcome === "held-by-other-peer" ? { ...t, outcome: "removed" } : t,
      ),
    })),
  },
  "purge lists its targets in descending order": {
    doc: "scripts",
    says: "(purge): purge targets",
    store: purge((report) => ({ ...report, targets: reversed(report.targets) })),
  },
  "purge lists a repeated id twice": {
    doc: "scripts",
    says: "(purge): purge targets",
    store: purge((report, ids) => ({
      ...report,
      targets: [...ids].sort().map((id) => report.targets.find((t) => t.id === id)!),
    })),
  },
  "a purge report states a revision that is not the peer's": {
    doc: "scripts",
    says: "(purge): the purge report's revision is not the peer's",
    store: revisions({ reported: { purge: 1 } }),
  },
  "a purge that removes nothing advances the revision": {
    doc: "scripts",
    says: "(purge): the revision advanced",
    store: revisions({ purge: (advanced) => (advanced ? 0 : 1) }),
  },
  "a purge that removes an id does not advance the revision": {
    doc: "scripts",
    says: "(purge): the revision did not advance",
    store: revisions({ purge: (advanced) => (advanced ? -1 : 0) }),
  },
  "a purge report without its boundary": {
    doc: "scripts",
    says: "(purge): the report does not state its boundary",
    store: purge((report) => ({ ...report, boundary: "" }) as unknown as PurgeReport),
  },
  "a purge report with another boundary text": {
    doc: "scripts",
    says: "(purge): the report does not state its boundary",
    store: purge(
      (report) => ({ ...report, boundary: "Store-Controlled-Surfaces" }) as unknown as PurgeReport,
    ),
  },
  "a purge that claims unproven when it removed nothing": {
    doc: "scripts",
    says: "(purge): the report claims unproven, expected nothing-removed",
    store: purge((report) => ({ ...report, claim: "unproven" })),
  },
  "a purge that claims nothing-removed when it removed a target": {
    doc: "scripts",
    says: "(purge): the report claims nothing-removed, expected unproven",
    store: purge((report) => ({ ...report, claim: "nothing-removed" })),
  },
  "a purge that claims proven on a store of class unprovable": {
    doc: "scripts",
    says: "(purge): the report claims proven, expected unproven on a store of class unprovable",
    store: purge((report) => ({
      ...report,
      claim: report.claim === "unproven" ? "proven" : report.claim,
    })),
  },
  "a store of class proven claims proven where nothing was removed": {
    doc: "scripts",
    says: "(purge): the report claims proven, expected nothing-removed on a store of class proven",
    store: join(provenClass, {
      peer: (peer) => ({
        erasure: { ...peer.erasure, storeClass: "proven" },
        purge: async (ids) => {
          const report = await peer.purge(ids);
          return {
            ...report,
            surfaces: report.surfaces.filter((s) => s.state === "absent"),
            claim: "proven",
          };
        },
      }),
    }),
  },
  "a store of class proven claims proven with a surface that is not absent": {
    doc: "scripts",
    says: "(purge): the report claims proven without surfaces that are all absent",
    store: join(provenClass, {
      peer: (peer) => ({
        erasure: { ...peer.erasure, storeClass: "proven" },
        purge: async (ids) => {
          const report = await peer.purge(ids);
          return { ...report, claim: report.claim === "unproven" ? "proven" : report.claim };
        },
      }),
    }),
  },
  "a store of class proven claims proven with no surface": {
    doc: "scripts",
    says: "(purge): the report claims proven without surfaces that are all absent",
    store: join(provenClass, {
      peer: (peer) => ({
        erasure: { ...peer.erasure, storeClass: "proven" },
        purge: async (ids) => {
          const report = await peer.purge(ids);
          return {
            ...report,
            surfaces: [],
            claim: report.claim === "unproven" ? "proven" : report.claim,
          };
        },
      }),
    }),
  },
  "a surface in a state that is not one of the three": {
    doc: "scripts",
    says: "(purge): a surface reports an unknown state",
    store: join(
      other,
      purge(
        (report) =>
          ({
            ...report,
            surfaces: report.surfaces.map((s) => ({ ...s, state: "gone" })),
          }) as unknown as PurgeReport,
      ),
    ),
  },
  "the reference store lists other surfaces": {
    doc: "scripts",
    says: "(purge): the reference store's surfaces differ",
    store: purge((report) => ({ ...report, surfaces: reversed(report.surfaces) })),
  },
  "the reference store reports another surface state": {
    doc: "scripts",
    says: "(purge): the reference store's surfaces differ",
    store: purge((report) => ({
      ...report,
      surfaces: report.surfaces.map((s) => ({ ...s, state: "unprovable" })),
    })),
  },
  "a store of class none answers a purge": {
    doc: "scripts",
    says: "(purge): a store with erasure class none answered a purge",
    store: {
      profile: (p) => ({ ...p, capabilities: { ...p.capabilities, erasure: "none" } }),
      peer: (peer) => ({ erasure: { ...peer.erasure, storeClass: "none" } }),
    },
    vectors: {
      ...vectors,
      scripts: {
        ...vectors.scripts,
        scripts: [
          {
            name: "a-purge-nobody-skips",
            spec: "README §1.3",
            requires: [],
            steps: [
              { op: "createPeer", peer: "A", erasure: "unproven", expect: { status: "created" } },
              {
                op: "purge",
                peer: "A",
                ids: [],
                expect: {
                  targets: [],
                  revisionAdvanced: false,
                  claim: { unprovable: "nothing-removed", proven: "nothing-removed" },
                  referenceSurfaces: [],
                },
              },
            ],
          },
        ],
      },
    },
  },
  "an arrival record that outlives a purge: the runner's books forget a purged id": {
    doc: "scripts",
    says: /\((arrivals|scope)\): .*carries another arrival record/,
    store: (() => {
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
    })(),
  },

  // -- snapshot fields (§3.6) --
  "a snapshot with another head": {
    doc: "scripts",
    says: "(head): the head is",
    store: { snapshot: (s) => ({ head: s.head === null ? "none" : null }) },
  },
  "a new peer's head is the empty string, not null": {
    doc: "scripts",
    says: "(head): the head is ",
    store: { snapshot: (s) => ({ head: s.head ?? "" }) },
  },
  "a snapshot that counts one too many": {
    doc: "scripts",
    says: "(count): the snapshot counts",
    store: { snapshot: (s) => ({ count: s.count + 1 }) },
  },

  // -- point queries (§3.7) --
  "get in descending order": {
    doc: "scripts",
    says: "(get): get answered [",
    store: get(reversed),
  },
  "get drops the signature": {
    doc: "scripts",
    says: /\(get\): delta \S+: the signature differs/,
    store: get((deltas) => deltas.map(unsigned)),
  },
  "get returns other claims under the id": {
    doc: "scripts",
    says: /\(get\): delta \S+: the claims differ/,
    store: get((deltas) => deltas.map(otherClaims)),
  },
  "arrivals in descending order": {
    doc: "scripts",
    says: "(arrivals): arrivals answered [",
    store: { snapshot: (s) => ({ arrivals: async (ids) => reversed(await s.arrivals(ids)) }) },
  },
  "arrivals with a shifted sequence": {
    doc: "scripts",
    says: /\(arrivals\): \S+ carries another arrival record/,
    store: {
      snapshot: (s) => ({
        arrivals: async (ids) =>
          (await s.arrivals(ids)).map((a) => ({ ...a, sequence: a.sequence + 1 })),
      }),
    },
  },
  "arrivals with another sender": {
    doc: "scripts",
    says: /\(arrivals\): \S+ carries another arrival record/,
    store: {
      snapshot: (s) => ({
        arrivals: async (ids) => (await s.arrivals(ids)).map((a) => ({ ...a, sender: "x" })),
      }),
    },
  },
  "arrivals with another time": {
    doc: "scripts",
    says: /\(arrivals\): \S+ carries another arrival record/,
    store: {
      snapshot: (s) => ({
        arrivals: async (ids) => (await s.arrivals(ids)).map((a) => ({ ...a, at: a.at + 0.5 })),
      }),
    },
  },
  "arrivals with another transfer": {
    doc: "scripts",
    says: /\(arrivals\): \S+ carries another arrival record/,
    store: {
      snapshot: (s) => ({
        arrivals: async (ids) =>
          (await s.arrivals(ids)).map((a) => ({ ...a, transfer: a.transfer + 1 })),
      }),
    },
  },
  "targets in descending order": {
    doc: "scripts",
    says: "(targets): targets answered [",
    store: { snapshot: (s) => ({ targets: async (e) => reversed(await s.targets(e)) }) },
  },
  "negators in descending order": {
    doc: "scripts",
    says: "(negators): negators answered [",
    store: { snapshot: (s) => ({ negators: async (ids) => reversed(await s.negators(ids)) }) },
  },

  // -- scope members and bounds in a script (§3.7) --
  "scope members in descending order": {
    doc: "scripts",
    says: "(scope): scope members are not ascending and distinct",
    store: join(other, { snapshot: scope(members(reversed)) }),
  },
  "a scope member listed twice": {
    doc: "scripts",
    says: "(scope): scope members are not ascending and distinct",
    store: join(other, { snapshot: scope(members((d) => [...d.slice(0, 1), ...d])) }),
  },
  "a scope member with other claims under its id": {
    doc: "scripts",
    says: "(scope): a scope member's claims differ",
    store: {
      snapshot: scope(members((d) => d.map((m) => ({ ...m, delta: otherClaims(m.delta) })))),
    },
  },
  "a scope member with the arrival record of another id": {
    doc: "scripts",
    says: "(scope): a scope member carries another id's arrival",
    store: {
      snapshot: scope(
        members((d) =>
          d.map((m, i) => ({
            ...m,
            arrival: { ...m.arrival, id: d[(i + 1) % d.length]!.delta.id },
          })),
        ),
      ),
    },
    // One member cannot carry another member's id. This script has scopes of several.
    vectors: {
      ...vectors,
      scripts: {
        ...vectors.scripts,
        scripts: vectors.scripts.scripts.filter((s) => s.name === "negation-chains"),
      },
    },
  },
  "a scope member with a shifted arrival sequence": {
    doc: "scripts",
    says: /\(scope\): \S+ carries another arrival record/,
    store: {
      snapshot: scope(
        members((d) =>
          d.map((m) => ({ ...m, arrival: { ...m.arrival, sequence: m.arrival.sequence + 1 } })),
        ),
      ),
    },
  },
  "a scope member without the signature it was admitted with": {
    doc: "scripts",
    says: "(scope): a scope member carries another appearance's signature",
    store: { snapshot: scope(members((d) => d.map((m) => ({ ...m, delta: unsigned(m.delta) })))) },
  },
  "a scope member the peer does not hold": {
    doc: "scripts",
    says: /\(scope\): the store answered for \S+, not held/,
    store: join(other, {
      snapshot: scope(async (result, s, peer, inner) => {
        // Every delta another peer holds and this one does not, under a made-up arrival.
        const strangers: VerifiedDelta[] = [];
        const admin = inner.openAdmin();
        for await (const id of admin.peers())
          if (id !== peer.id)
            for await (const delta of admin.peer(id).deltas())
              if ((await s.get([delta.id])).length === 0)
                strangers.push({
                  delta,
                  arrival: { id: delta.id, at: 1, sequence: 1, transfer: 1, sender: "x" },
                });
        const all = new Map([...result.deltas, ...strangers].map((m) => [m.delta.id, m]));
        return { ...result, deltas: [...all.keys()].sort().map((id) => all.get(id)!) };
      }),
    }),
  },
  "applied reports a field nobody asked for": {
    doc: "scripts",
    says: "(scope): applied reports arrivalAtMost, which was not requested",
    store: join(other, {
      snapshot: scope(async (result) => ({
        ...result,
        applied: { ...result.applied, arrivalAtMost: true },
      })),
    }),
  },
  "the reference store reports a field not applied that its profile offers": {
    doc: "scripts",
    says: "(scope): the reference store must apply",
    store: {
      snapshot: scope(async (result) => ({
        ...result,
        applied: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
      })),
    },
  },
  "the reference store applies a field its profile does not offer": {
    doc: "scripts",
    says: "(scope): the reference store must apply",
    store: {
      profile: (p) => ({ ...p, pushdown: { ...p.pushdown, timestampAtMost: false } }),
    },
  },
  "a scope in a script that lacks a member of the lower bound": {
    doc: "scripts",
    says: /\(scope\): scope \[.*\] lacks a member of/,
    store: join(other, { snapshot: scope(members((d) => d.slice(1))) }),
  },
  "a scope in a script that leaves the upper bound": {
    doc: "scripts",
    says: /\(scope\): scope \[.*\] leaves the upper bound/,
    store: join(other, {
      snapshot: scope(async (result, s, peer, inner) => {
        // Everything the peer holds, in scope or not.
        const held: Delta[] = [];
        for await (const delta of inner.openAdmin().peer(peer.id).deltas()) held.push(delta);
        const arrivals = await s.arrivals(held.map((d) => d.id));
        return { ...result, deltas: held.map((delta, i) => ({ delta, arrival: arrivals[i]! })) };
      }),
    }),
  },
  "a scope in a script that answers with every holding when nothing is in scope": {
    doc: "scripts",
    says: /\(scope\): scope \[.+\] leaves the upper bound/,
    store: join(other, {
      snapshot: scope(async (result, s, peer, inner) => {
        if (result.deltas.length > 0) return result;
        const held: Delta[] = [];
        for await (const delta of inner.openAdmin().peer(peer.id).deltas()) held.push(delta);
        const arrivals = await s.arrivals(held.map((d) => d.id));
        return { ...result, deltas: held.map((delta, i) => ({ delta, arrival: arrivals[i]! })) };
      }),
    }),
  },
  "the reference store returns ids the read excluded, in a script": {
    doc: "scripts",
    says: "(scope): the reference store answered",
    store: {
      snapshot: scope(async (result) => result, withoutExclude),
    },
  },

  // -- export (§3.8) --
  "export of an absent peer lists nothing instead of refusing": {
    doc: "scripts",
    says: "(export): expected a refusal: peer-absent",
    store: exporter((listing) => ({
      ids: () =>
        (async function* () {
          try {
            yield* listing.ids();
          } catch {
            // An absent peer reads as an empty one.
          }
        })(),
      deltas: () =>
        (async function* () {
          try {
            yield* listing.deltas();
          } catch {
            // The same.
          }
        })(),
    })),
  },
  "export refuses for a peer that exists": {
    doc: "scripts",
    says: "(export): the export refused",
    store: exporter(() => ({
      ids: () =>
        // eslint-disable-next-line require-yield
        (async function* (): AsyncGenerator<string> {
          throw new StoreError("peer-absent", "never lists");
        })(),
    })),
  },
  "export lists the whole store for one peer": {
    doc: "scripts",
    says: "(export): export ids [",
    store: exporter((_listing, admin) => ({ ids: () => admin.storedIds() })),
  },
  "export lists ids in descending order": {
    doc: "scripts",
    says: "(export): export ids [",
    store: exporter((listing) => ({ ids: () => listed(listing.ids(), reversed) })),
  },
  "export yields fewer deltas than ids": {
    doc: "scripts",
    says: "(export): export deltas and ids disagree",
    store: exporter((listing) => ({ deltas: () => listed(listing.deltas(), (d) => d.slice(1)) })),
  },
  "export yields deltas in another order than ids": {
    doc: "scripts",
    says: /\(export\): expected delta \S+, got id/,
    store: exporter((listing) => ({ deltas: () => listed(listing.deltas(), reversed) })),
  },
  "export drops the signature": {
    doc: "scripts",
    says: /\(export\): delta \S+: the signature differs/,
    store: exporter((listing) => ({
      deltas: () => listed(listing.deltas(), (d) => d.map(unsigned)),
    })),
  },
  "export yields other claims under an id": {
    doc: "scripts",
    says: /\(export\): delta \S+: the claims differ/,
    store: exporter((listing) => ({
      deltas: () => listed(listing.deltas(), (d) => d.map(otherClaims)),
    })),
  },
  "the stored listing repeats an id two peers hold": {
    doc: "scripts",
    says: "(exportStored): the store keeps [",
    store: {
      store: (_store, inner) => ({
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
  },
  "the stored listing is in descending order": {
    doc: "scripts",
    says: "(exportStored): the store keeps [",
    store: {
      store: (_store, inner) => ({
        openAdmin: () => {
          const admin = inner.openAdmin();
          return { ...admin, storedIds: () => listed(admin.storedIds(), reversed) };
        },
      }),
    },
  },
  "peers are listed in descending order": {
    doc: "scripts",
    says: "(exportPeers): the store lists peers",
    store: {
      store: (_store, inner) => ({
        openAdmin: () => {
          const admin = inner.openAdmin();
          return { ...admin, peers: () => listed(admin.peers(), reversed) };
        },
      }),
    },
  },

  // -- a scope case (§4) --
  "a scope case: members in descending order": {
    doc: "scope",
    says: "scope members are not ascending and distinct",
    store: join(other, { snapshot: scope(members(reversed)) }),
  },
  "a scope case: a member with a shifted arrival sequence": {
    doc: "scope",
    says: "carries another arrival record",
    store: {
      snapshot: scope(
        members((d) =>
          d.map((m) => ({ ...m, arrival: { ...m.arrival, sequence: m.arrival.sequence + 1 } })),
        ),
      ),
    },
  },
  "a scope case: applied reports a field outside the pushed-down subset": {
    doc: "scope",
    says: /applied reports \w+, which was not requested/,
    store: join(other, {
      snapshot: scope(async (result) => ({
        ...result,
        applied: { timestampAtMost: true, arrivalAtMost: true, excludeIds: true },
      })),
    }),
  },
  "a scope case: the reference store reports a field not applied": {
    doc: "scope",
    says: "the reference store must apply",
    store: {
      snapshot: scope(async (result) => ({
        ...result,
        applied: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
      })),
    },
  },
  "a scope case: the lower bound, where the residual selection would hide the omission": {
    doc: "scope",
    says: /pushdown \{\}: scope \[.*\] lacks a member of/,
    // Asked for no pushdown, this store leaves out its latest member. The trimmed scope under
    // a signed-time cut is still right, so only the lower bound can see it.
    store: join(other, {
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
    }),
  },
  "a scope case: a store reports a pushdown applied and returns the wider set": {
    doc: "scope",
    says: "leaves S over the applied selection",
    store: join(other, {
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
    }),
  },
  "a scope case: the reference store returns ids the read holds": {
    doc: "scope",
    says: "the reference store answered [",
    store: {
      snapshot: scope(async (result) => result, withoutExclude),
    },
  },
  "a scope case: the peer does not hold what the case says the read holds": {
    doc: "scope",
    says: "the peer does not hold a delta the case holds",
    store: get(() => []),
  },
  "a scope case: the trimmed scope, when the held deltas come back with other claims": {
    doc: "scope",
    says: "the trimmed scope is [",
    store: get((deltas) =>
      deltas.map((d) => ({
        ...d,
        claims: {
          ...d.claims,
          pointers: [{ role: "x", target: { kind: "primitive", value: 1 } }],
        },
      })),
    ),
  },
};

const failuresOf = async (rule: Rule): Promise<string[]> => {
  const error = await runStoreConformance(broken(rule.store), rule.vectors ?? vectors).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "the run must fail").toBeInstanceOf(StoreConformanceError);
  return (error as StoreConformanceError).failures.map((f) => `${f.name}: ${f.message}`);
};
const says = (line: string, rule: Rule): boolean =>
  line.startsWith(`${rule.doc}/`) &&
  (typeof rule.says === "string" ? line.includes(rule.says) : rule.says.test(line));

describe("runner rules: each wrong store fails with the message of its rule", () => {
  for (const [name, rule] of Object.entries(RULES)) {
    it(name, async () => {
      const lines = await failuresOf(rule);
      expect(
        lines.filter((line) => says(line, rule)),
        `no failure in ${rule.doc}/ says ${String(rule.says)}:\n${lines.join("\n")}`,
      ).not.toEqual([]);
    });
  }

  it("the wrapper itself changes nothing, with and without the reference label", async () => {
    for (const fault of [{}, other]) {
      const report = await runStoreConformance(broken(fault), vectors);
      expect(report.skipped).toEqual([]);
      expect(report.passed).toHaveLength(
        vectors.scripts.scripts.length + vectors.scope.cases.length,
      );
    }
  });
});

describe("runner rules: what binds the reference store only", () => {
  // The same wrong answers under another format version are right answers: a store may ignore
  // `exclude`, may report a field not applied, and declares its own surfaces.
  const allowed: Readonly<Record<string, Break>> = {
    "returning ids the read excluded": {
      snapshot: scope(async (result) => result, withoutExclude),
    },
    "reporting no field applied": {
      snapshot: scope(async (result) => ({
        ...result,
        applied: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
      })),
    },
    "listing other surfaces": purge((report) => ({
      ...report,
      surfaces: [{ surface: "pages", state: "unprovable" }],
    })),
  };
  for (const [name, fault] of Object.entries(allowed)) {
    it(`${name} conforms for a store that is not the reference`, async () => {
      const report = await runStoreConformance(broken(join(other, fault)), vectors);
      expect(report.passed).toHaveLength(
        vectors.scripts.scripts.length + vectors.scope.cases.length,
      );
      await expect(runStoreConformance(broken(fault), vectors)).rejects.toBeInstanceOf(
        StoreConformanceError,
      );
    });
  }
});

describe("runner rules: what the profile makes the runner do", () => {
  const profiled = (change: (p: StoreProfile) => StoreProfile): Break => ({ profile: change });

  it("a store without purge skips exactly the scripts that require it, and runs the rest", async () => {
    const report = await runStoreConformance(
      broken({
        ...profiled((p) => ({ ...p, capabilities: { ...p.capabilities, erasure: "none" } })),
        peer: (peer) => ({ erasure: { ...peer.erasure, storeClass: "none" } }),
      }),
      vectors,
    );
    const needPurge = vectors.scripts.scripts.filter((s) => s.requires.includes("purge"));
    expect(needPurge.length).toBeGreaterThan(0);
    expect(report.skipped).toEqual(
      needPurge.map((s) => ({ name: `scripts/${s.name}`, missing: "purge" })),
    );
    expect(report.passed).toHaveLength(
      vectors.scripts.scripts.length - needPurge.length + vectors.scope.cases.length,
    );
  });

  it("a store with a journal skips exactly the script that needs its absence", async () => {
    const report = await runStoreConformance(
      broken(profiled((p) => ({ ...p, capabilities: { ...p.capabilities, journal: true } }))),
      vectors,
    );
    expect(report.skipped).toEqual([
      { name: "scripts/a-frame-needs-the-journal", missing: "journal-absent" },
    ]);
  });

  it("a store that offers purge and no journal skips nothing", async () => {
    const report = await runStoreConformance(async () => createMemoryStore(), vectors);
    expect(report.skipped).toEqual([]);
    expect(report.passed).toEqual([
      ...vectors.scripts.scripts.map((s) => `scripts/${s.name}`),
      ...vectors.scope.cases.map((c) => `scope/${c.name}`),
    ]);
  });

  it("each script and the scope document get a new store, and each store is closed", async () => {
    let opened = 0;
    let closed = 0;
    const report = await runStoreConformance(async () => {
      opened++;
      const store = createMemoryStore();
      return {
        profile: store.profile,
        createPeer: (id, options) => store.createPeer(id, options),
        peer: (id) => store.peer(id),
        openAdmin: () => store.openAdmin(),
        close: async () => {
          closed++;
          await store.close();
        },
      };
    }, vectors);
    expect(report.skipped).toEqual([]);
    expect(opened).toBe(vectors.scripts.scripts.length + 1);
    expect(closed).toBe(opened);
  });
});

describe("runner rules: a wrong document", () => {
  const memory = async (): Promise<Store> => createMemoryStore();
  const script = vectors.scripts.scripts.find((s) => s.name === "append-and-point-reads")!;
  const only = (steps: StoreVectors["scripts"]["scripts"][number]["steps"]): StoreVectors => ({
    scripts: { ...vectors.scripts, scripts: [{ ...script, steps }] },
    scope: { ...vectors.scope, cases: [] },
  });
  const scopeOnly = (
    change: (c: StoreVectors["scope"]["cases"][number]) => object,
  ): StoreVectors => ({
    scripts: { ...vectors.scripts, scripts: [] },
    scope: {
      ...vectors.scope,
      cases: [
        change(
          vectors.scope.cases.find((c) => c.name === "every-field")!,
        ) as StoreVectors["scope"]["cases"][number],
      ],
    },
  });
  const corpus = (
    change: (d: StoreVectors["scripts"]["deltas"][number]) => object,
  ): StoreVectors => ({
    scripts: {
      ...vectors.scripts,
      deltas: vectors.scripts.deltas.map((d) =>
        d.name === "a-name" ? (change(d) as typeof d) : d,
      ),
      scripts: [script],
    },
    scope: { ...vectors.scope, cases: [] },
  });

  type Wrong = { vectors: StoreVectors; says: string; store?: () => Promise<Store> };
  const wrong: Readonly<Record<string, Wrong>> = {
    "an unknown scripts format": {
      vectors: { ...vectors, scripts: { ...vectors.scripts, format: "x/1" as never } },
      says: "unknown store scripts format",
    },
    "an unknown scope format": {
      vectors: { ...vectors, scope: { ...vectors.scope, format: "x/1" as never } },
      says: "unknown store scope format",
    },
    "a corpus id that does not recompute and is not marked forged": {
      vectors: corpus((d) => ({ ...d, id: vectors.scripts.deltas[0]!.id })),
      says: "vector delta a-name: id does not recompute",
    },
    "a step that names an unknown delta": {
      vectors: only([
        script.steps[0]!,
        script.steps[1]!,
        script.steps[2]!,
        { op: "get", snapshot: "s", ids: ["nobody"], expect: { deltas: [] } },
      ]),
      says: "the vector names an unknown delta nobody",
    },
    "a step that names an unknown peer": {
      vectors: only([{ op: "exportPeers", expect: { peers: ["Z"] } }]),
      says: "the vector names an unknown peer Z",
    },
    "a step that uses a peer before creating it": {
      vectors: only([{ op: "read", peer: "A", snapshot: "s" }]),
      says: "the vector uses peer A before creating it",
    },
    "a step that uses a snapshot before reading it": {
      vectors: only([{ op: "count", snapshot: "s", expect: { count: 0 } }]),
      says: "the vector uses snapshot s before reading it",
    },
    "a scope case without the scope under its whole selection": {
      vectors: scopeOnly((c) => ({ ...c, scopes: c.scopes.filter((s) => s.fields.length < 3) })),
      says: "the case lacks the scope under its whole selection",
    },
    "a scope case without the scope of an applied subset": {
      vectors: scopeOnly((c) => ({
        ...c,
        scopes: c.scopes.filter((s) => s.fields.length !== 1),
      })),
      says: "the case lacks a scope for the applied fields",
      // Asked for two fields, this store applies one; the document has no scope for it.
      store: async () =>
        createMemoryStore({ pushdown: { arrivalAtMost: false, excludeIds: false } }),
    },
  };
  for (const [name, { vectors: document, says: message, store }] of Object.entries(wrong)) {
    it(name, async () => {
      await expect(runStoreConformance(store ?? memory, document)).rejects.toThrow(message);
    });
  }

  it("a forged corpus entry is not checked: the documents carry one on purpose", async () => {
    expect(vectors.scripts.deltas.filter((d) => d.forged === true)).toHaveLength(1);
    await expect(runStoreConformance(memory, vectors)).resolves.toBeDefined();
  });
});
