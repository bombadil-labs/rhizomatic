// Held views over a store (SPEC-18 proposal §4.6, "Held views"; vectors/store/README.md §11): the
// shared vectors `views.json` against the memory store and `StoreViews`, the wrong holders each
// witness keeps, the holder's own rules, a fuzz against brute force, and three timed cost rails.
//
// Not covered here: the feed (store-feed.test.ts), `touching` and `checkFresh`
// (store-freshness.test.ts), and the read itself (store-rounds.test.ts). A held view is only as
// right as the read it holds.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareUtf8 } from "../src/delta/cbor.js";
import { parseClaims } from "../src/delta/json-profile.js";
import { DeltaSet, makeDelta } from "../src/delta/set.js";
import type { Delta, Pointer } from "../src/delta/types.js";
import { UnanchoredTermError, readAnchored } from "../src/reactor/store-read.js";
import { StoreViews, type ViewQuirks } from "../src/reactor/store-views.js";
import {
  runViewsConformance,
  type StoreViewsDocument,
  type ViewWitness,
  type ViewsStoreRequest,
} from "../src/reactor/views-conformance.js";
import { anchorAnalysis, hviewAnchors } from "../src/resolve/anchored.js";
import { evalTerm, resultCanonicalHex } from "../src/resolve/eval.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import { advanceCapture, checkFresh } from "../src/storage/freshness.js";
import { createMemoryStore, type MemoryStoreOptions } from "../src/storage/memory-store.js";
import {
  StoreConformanceError,
  type StoreConformanceFailure,
} from "../src/storage/store-conformance.js";
import { PUSHDOWN_FIELDS, passesSelection, scopeOver } from "../src/storage/store-vector-format.js";
import {
  StoreError,
  StoreFaultError,
  type PeerStore,
  type Pushdown,
} from "../src/storage/store.js";
import type { Term } from "../src/syntax/model.js";
import { parseTerm } from "../src/syntax/term-json.js";
import { viewsVectors } from "../tools/store-views-vectors.js";
import type { ArrivalRecord } from "../src/storage/arrival-record.js";
import { broken, sparse, type Break } from "./support/broken-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const committed = readFileSync(resolve(here, "../../../vectors/store/views.json"), "utf8");
const document = JSON.parse(committed) as StoreViewsDocument;

const WITNESS: ViewWitness = { create: (peer, options) => new StoreViews(peer, options) };
const quirky = (quirks: ViewQuirks): ViewWitness => ({
  create: (peer, options) => new StoreViews(peer, options, quirks),
});

const factoryOf =
  (fault: Break = {}) =>
  async (request: ViewsStoreRequest) =>
    broken({ ...fault, options: { ...fault.options, ...request } })();

async function failures(
  witness: ViewWitness,
  fault: Break = {},
  vectors: StoreViewsDocument = document,
): Promise<readonly StoreConformanceFailure[]> {
  try {
    await runViewsConformance(factoryOf(fault), witness, vectors);
    return [];
  } catch (error) {
    if (error instanceof StoreConformanceError) return error.failures;
    throw error;
  }
}

/** The runs of README §11.5. */
const RUNS: Readonly<Record<string, Break>> = {
  "as built": {},
  "pages of one record": { options: { changePageSize: 1 } },
  "two records kept": { options: { changeRetention: { revisions: 2 } } },
  "two records kept, pages of one record": {
    options: { changeRetention: { revisions: 2 }, changePageSize: 1 },
  },
  "revisions times 3, pages of one record": { options: { changePageSize: 1 }, ...sparse(3) },
  "revisions times 2, two records kept": {
    options: { changeRetention: { revisions: 2 } },
    ...sparse(2),
  },
};

const copy = (): StoreViewsDocument => JSON.parse(committed) as StoreViewsDocument;
const caseOf = (doc: StoreViewsDocument, name: string) => doc.cases.find((c) => c.name === name)!;

// ---- the vectors ------------------------------------------------------------------------------

describe("views vectors", () => {
  it("the committed file is the model's output", () => {
    expect(`${JSON.stringify(viewsVectors(), null, 2)}\n`).toBe(committed);
  });

  for (const [run, fault] of Object.entries(RUNS))
    it(`every case passes: ${run}`, async () => {
      const report = await runViewsConformance(factoryOf(fault), WITNESS, document);
      expect(report.skipped).toEqual([]);
      expect(report.passed.length).toBe(document.cases.length);
    });

  it("a store with no feed skips every case and names the requirement", async () => {
    const report = await runViewsConformance(
      async () => broken({ profile: (p) => ({ ...p, changeRetention: "none" }) })(),
      WITNESS,
      document,
    );
    expect(report.passed).toEqual([]);
    expect(report.skipped.map((s) => s.missing)).toEqual(document.cases.map(() => "changes"));
  });

  it("a factory that cannot build a case's store skips that case", async () => {
    const report = await runViewsConformance(
      async (request) => (request.changeRetention === undefined ? createMemoryStore() : undefined),
      WITNESS,
      document,
    );
    expect(report.skipped.map((s) => s.name)).toEqual(["views/retention-too-short"]);
  });
});

describe("views vectors: wrong holders fail", () => {
  const ROWS: readonly { quirk: keyof ViewQuirks; fails: string; message: string }[] = [
    {
      quirk: "neverReread",
      fails: "an-append-at-an-anchor-of-one-view",
      message: "refresh re-read [], expected [leaf@garden:1]",
    },
    {
      quirk: "rereadAll",
      fails: "an-unrelated-append",
      message: "refresh re-read [leaf@garden:1 tree@garden:1], expected []",
    },
    {
      quirk: "ignoreRemoved",
      fails: "a-purge-of-a-member",
      message: "refresh re-read [], expected [leaf@plant:s]",
    },
    {
      quirk: "ignoreNegators",
      fails: "a-negator-of-a-member",
      message: "refresh re-read [], expected [leaf@plant:2]",
    },
    {
      quirk: "keepOldIndex",
      fails: "a-view-gains-a-dynamic-anchor",
      message: "refresh re-read [], expected [tree1@plant:2]",
    },
    {
      quirk: "keepIndexOnDrop",
      fails: "drop",
      message: "refresh re-read [leaf@garden:1], expected []",
    },
    {
      quirk: "ignoreSince",
      fails: "time-moves-past-the-window-and-back",
      message: "refresh re-read [], expected [leaf@plant:2 leaf@plant:s]",
    },
    {
      quirk: "ignoreExpiresAt",
      fails: "time-moves-past-the-window-and-back",
      message: "refresh re-read [], expected [leaf@plant:s]",
    },
    {
      quirk: "ignoreEpoch",
      fails: "set-epoch",
      message: "refresh re-read [], expected [leaf@bed:1 leaf@garden:1]",
    },
    {
      quirk: "newerSnapshot",
      fails: "an-append-at-an-anchor-of-one-view",
      message: "refresh made the call read where the contract asks for scope",
    },
    {
      quirk: "mergeOnResync",
      fails: "retention-too-short",
      message: "refresh re-read [], expected [leaf@garden:1 leaf@plant:2]",
    },
    {
      quirk: "feedPerView",
      fails: "an-unrelated-append",
      message: "refresh made the call changes(2, 3) where the contract asks for release",
    },
    {
      quirk: "staleBoundary",
      fails: "time-moves-past-the-window-and-back",
      message: "the next boundary is 60, expected null",
    },
  ];

  const NEW_ROWS: readonly { quirk: keyof ViewQuirks; fails: string; message: string }[] = [
    {
      quirk: "keepPurgedBaseline",
      fails: "a-purge-read-by-a-hold-releases-the-baseline",
      message: "refresh reports the change of leaf at plant:s with other bytes",
    },
    {
      quirk: "keepEvicted",
      fails: "an-evicted-view-is-read-again",
      message: "hold of leaf at garden:1 answered other bytes",
    },
    {
      quirk: "readWhenNew",
      fails: "an-evicted-view-held-again-answers-new",
      message: "hold of leaf at garden:1 answered from read, expected new",
    },
    {
      quirk: "omitEvicted",
      fails: "an-evicted-view-not-held-again",
      message: "refresh evicted [], expected [leaf@garden:1]",
    },
    {
      quirk: "evictedKeepsDropped",
      fails: "an-evicted-view-not-held-again",
      message: "refresh evicted [leaf@bed:1 leaf@garden:1], expected [leaf@garden:1]",
    },
    {
      quirk: "evictedKeepsReheld",
      fails: "an-evicted-view-held-again-answers-new",
      message: "refresh evicted [leaf@bed:1 leaf@garden:1], expected [leaf@bed:1]",
    },
    {
      quirk: "readEvicted",
      fails: "an-evicted-view-not-held-again",
      message: "hold read leaf@garden:1, the view it evicts",
    },
  ];
  for (const row of NEW_ROWS)
    it(`${row.quirk} fails ${row.fails}`, async () => {
      const found = await failures(quirky({ [row.quirk]: true }));
      expect(found.find((f) => f.name === `views/${row.fails}`)?.message).toContain(row.message);
    });

  const ONLY: readonly { quirk: keyof ViewQuirks; cases: readonly string[] }[] = [
    {
      quirk: "keepEvicted",
      cases: ["an-evicted-view-is-read-again", "an-evicted-view-held-again-answers-new"],
    },
    { quirk: "evictedKeepsDropped", cases: ["an-evicted-view-not-held-again"] },
    { quirk: "readEvicted", cases: ["an-evicted-view-not-held-again"] },
  ];
  for (const row of ONLY)
    it(`${row.quirk} fails only ${row.cases.join(" and ")}, and passes without them`, async () => {
      const found = await failures(quirky({ [row.quirk]: true }));
      expect(found.map((f) => f.name).sort()).toEqual(row.cases.map((c) => `views/${c}`).sort());
      const without = copy() as { cases: StoreViewsDocument["cases"] };
      without.cases = without.cases.filter((c) => !row.cases.includes(c.name));
      expect(
        await failures(quirky({ [row.quirk]: true }), {}, without as StoreViewsDocument),
      ).toEqual([]);
    });

  it("readWhenNew also fails the first hold of a program with a selection", async () => {
    const found = await failures(quirky({ readWhenNew: true }));
    expect(found.find((f) => f.name === "views/a-program-with-a-selection")?.message).toContain(
      "hold of before-60 at plant:s answered from read, expected new",
    );
  });

  it("the holder with no quirk passes every run", async () => {
    for (const fault of Object.values(RUNS)) expect(await failures(quirky({}), fault)).toEqual([]);
  });

  for (const row of ROWS)
    it(`${row.quirk} fails ${row.fails}`, async () => {
      const found = await failures(quirky({ [row.quirk]: true }));
      const failure = found.find((f) => f.name === `views/${row.fails}`);
      expect(failure?.message, JSON.stringify(found.map((f) => [f.name, f.message]))).toContain(
        row.message,
      );
    });

  it("a per-view scan passes every case: only the cost rail can catch it", async () => {
    expect(await failures(quirky({ scanEveryView: true }))).toEqual([]);
  });
});

// ---- wrong documents and the runner's checks ---------------------------------------------------

describe("views vectors: every runner check has a row", () => {
  type Step = Record<string, unknown> & { op: string; expect?: Record<string, unknown> };
  const ROWS: readonly {
    name: string;
    case: string;
    edit: (steps: Step[]) => void;
    message: string;
  }[] = [
    {
      name: "other bytes",
      case: "no-change",
      edit: (s) => (s.find((x) => x.op === "hold")!.expect!.bytes = "00"),
      message: "hold of leaf at garden:1 answered other bytes",
    },
    {
      name: "another from",
      case: "no-change",
      edit: (s) => (s.filter((x) => x.op === "hold")[2]!.expect!.from = "read"),
      message: "hold of leaf at garden:1 answered from held, expected read",
    },
    {
      name: "another hold position",
      case: "no-change",
      edit: (s) => (s.find((x) => x.op === "hold")!.expect!.position = "A.1"),
      message: "hold stands at 2, expected 1",
    },
    {
      name: "another expiresAt",
      case: "no-change",
      edit: (s) => (s.find((x) => x.op === "hold")!.expect!.expiresAt = 7),
      message: "hold of leaf at garden:1 reports expiresAt null, expected 7",
    },
    {
      name: "another next boundary",
      case: "no-change",
      edit: (s) => (s.find((x) => x.op === "hold")!.expect!.nextBoundary = 7),
      message: "the next boundary is null, expected 7",
    },
    {
      name: "another refresh position",
      case: "no-change",
      edit: (s) => (s.find((x) => x.op === "refresh")!.expect!.position = "A.1"),
      message: "refresh stands at 2, expected 1",
    },
    {
      name: "another resynced",
      case: "no-change",
      edit: (s) => (s.find((x) => x.op === "refresh")!.expect!.resynced = true),
      message: "refresh resynced false, expected true",
    },
    {
      name: "another re-read set",
      case: "no-change",
      edit: (s) =>
        (s.find((x) => x.op === "refresh")!.expect!.reread = [
          { program: "leaf", root: "garden:1" },
        ]),
      message: "refresh re-read [], expected [leaf@garden:1]",
    },
    {
      name: "another changed set",
      case: "no-change",
      edit: (s) =>
        (s.find((x) => x.op === "refresh")!.expect!.changed = [
          { program: "leaf", root: "garden:1", before: "", after: "" },
        ]),
      message: "refresh changed [], expected [leaf@garden:1]",
    },
    {
      name: "another change",
      case: "an-append-at-an-anchor-of-one-view",
      edit: (s) => {
        const changed = s.find((x) => x.op === "refresh")!.expect!.changed as { after: string }[];
        changed[0]!.after = "00";
      },
      message: "refresh reports the change of leaf at garden:1 with other bytes",
    },
    {
      name: "a refusal that is not one",
      case: "an-unanchored-program-is-refused",
      edit: (s) => (s[0]!.expect = { reason: "reflection" }),
      message: "register refused aliased, expected reflection",
    },
    {
      name: "a refusal expected of an anchored program",
      case: "no-change",
      edit: (s) => (s[0]!.expect = { reason: "aliased" }),
      message: "register of leaf answered, expected the refusal aliased",
    },
    {
      name: "a refusal not expected",
      case: "an-unanchored-program-is-refused",
      edit: (s) => delete s[0]!.expect,
      message: "register of aliased was refused: aliased",
    },
    {
      name: "a hold before registering",
      case: "no-change",
      edit: (s) => s.splice(0, 3),
      message: "the vector holds leaf before registering it",
    },
    {
      name: "an unknown program",
      case: "no-change",
      edit: (s) => (s[0]!.program = "missing"),
      message: "the vector names an unknown program missing",
    },
    {
      name: "another evicted set",
      case: "no-change",
      edit: (s) =>
        (s.find((x) => x.op === "refresh")!.expect!.evicted = [
          { program: "leaf", root: "garden:1" },
        ]),
      message: "refresh evicted [], expected [leaf@garden:1]",
    },
    {
      name: "a new view expected held",
      case: "no-change",
      edit: (s) => (s.find((x) => x.op === "hold")!.expect!.from = "held"),
      message: "hold of leaf at garden:1 answered from new, expected held",
    },
    {
      name: "a hold read set that misses a read",
      case: "a-hold-passes-for-the-whole-set",
      edit: (s) => (s.filter((x) => x.op === "hold")[2]!.expect!.reread = []),
      message: "hold made the call scope where the contract asks for release",
    },
  ];

  for (const row of ROWS)
    it(row.name, async () => {
      const doc = copy();
      row.edit(caseOf(doc, row.case).steps as unknown as Step[]);
      const found = await failures(WITNESS, {}, doc);
      expect(found.find((f) => f.name === `views/${row.case}`)?.message).toContain(row.message);
    });

  it("a document of another format", async () => {
    const doc = { ...copy(), format: "rhizomatic-store-views/0" } as unknown as StoreViewsDocument;
    await expect(runViewsConformance(factoryOf(), WITNESS, doc)).rejects.toThrow(
      "unknown store views format",
    );
  });

  it("a holder that makes a store call where the contract has none", async () => {
    const reading: ViewWitness = {
      create: (peer, options) => {
        const views = new StoreViews(peer, options);
        return {
          register: (name, program) => views.register(name, program),
          setEpoch: async (name, epoch) => {
            (await peer.read()).release();
            return views.setEpoch(name, epoch);
          },
          hold: (name, root, now) => views.hold(name, root, now),
          refresh: (now) => views.refresh(now),
          drop: (name, root) => views.drop(name, root),
          get nextBoundary() {
            return views.nextBoundary;
          },
        };
      },
    };
    const found = await failures(reading);
    expect(found.find((f) => f.name === "views/set-epoch")?.message).toContain(
      "setEpoch made the call read; it makes no store call",
    );
  });

  it("a holder that answers new for a held view of a program with a selection", async () => {
    const renewed: ViewWitness = {
      create: (peer, options) => {
        const views = new StoreViews(peer, options);
        return {
          register: (name, program) => views.register(name, program),
          setEpoch: (name, epoch) => views.setEpoch(name, epoch),
          hold: async (name, root, now) => ({
            ...(await views.hold(name, root, now)),
            from: "new",
          }),
          refresh: (now) => views.refresh(now),
          drop: (name, root) => views.drop(name, root),
          get nextBoundary() {
            return views.nextBoundary;
          },
        };
      },
    };
    const found = await failures(renewed);
    expect(found.find((f) => f.name === "views/a-program-with-a-selection")?.message).toContain(
      "hold of before-60 at plant:s answered from new, expected held or read",
    );
  });

  it("a holder whose re-read list is not in order", async () => {
    const reversed: ViewWitness = {
      create: (peer, options) => {
        const views = new StoreViews(peer, options);
        return {
          register: (name, program) => views.register(name, program),
          setEpoch: (name, epoch) => views.setEpoch(name, epoch),
          hold: (name, root, now) => views.hold(name, root, now),
          refresh: async (now) => {
            const r = await views.refresh(now);
            return { ...r, reread: [...r.reread].reverse() };
          },
          drop: (name, root) => views.drop(name, root),
          get nextBoundary() {
            return views.nextBoundary;
          },
        };
      },
    };
    const found = await failures(reversed);
    expect(found.find((f) => f.name === "views/two-views-share-an-anchor")?.message).toContain(
      "refresh's re-read list is not ascending",
    );
  });

  it("a store that breaks its contract fails with the runner's fixed words", async () => {
    const noProgress: Break = {
      peer: (peer) => ({
        changes: async (from, to) => {
          const page = await peer.changes(from, to);
          return to !== undefined && page.status === "ok" && page.records.length > 0
            ? { ...page, through: from }
            : page;
        },
      }),
    };
    const found = await failures(WITNESS, noProgress);
    expect(found.find((f) => f.name === "views/an-unrelated-append")?.message).toContain(
      "the store broke no-progress: ",
    );
  });

  it("a holder that answers its own history", async () => {
    const elsewhere: ViewWitness = {
      create: (peer, options) => {
        const views = new StoreViews(peer, options);
        return {
          register: (name, program) => views.register(name, program),
          setEpoch: (name, epoch) => views.setEpoch(name, epoch),
          hold: async (name, root, now) => {
            const read = await views.hold(name, root, now);
            return { ...read, position: { ...read.position, history: "elsewhere" } };
          },
          refresh: (now) => views.refresh(now),
          drop: (name, root) => views.drop(name, root),
          get nextBoundary() {
            return views.nextBoundary;
          },
        };
      },
    };
    const found = await failures(elsewhere);
    expect(found.find((f) => f.name === "views/no-change")?.message).toContain(
      "hold answered another history",
    );
  });
});

// ---- the holder's own rules -------------------------------------------------------------------

const at = (entity: string, context = "subject"): Pointer => ({
  role: "subject",
  target: { kind: "entity", entity: { id: entity, context } },
});
const fact = (entity: string, t: number, valid?: { from?: number; until?: number }): Delta =>
  makeDelta({
    timestamp: t,
    validFrom: valid?.from ?? t,
    ...(valid?.until === undefined ? {} : { validUntil: valid.until }),
    author: "did:key:zA",
    pointers: [at(entity), { role: "value", target: { kind: "primitive", value: `v${t}` } }],
  });
const PEER = `ed25519:${"7e".repeat(32)}`;
const LEAF = parseTerm({
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
});
const hexOf = (id: string): string => Buffer.from(id, "utf8").toString("hex");
const MARKER = "erase-me-7f3a";
/**
 * A delta's own entry in canonical bytes: the key `id` and the id as a text string. A negator
 * that names a purged delta carries its id under `delta`, which is the negator's, not a copy.
 */
const entryHex = (id: string): string => `626964${"78"}${id.length.toString(16)}${hexOf(id)}`;
/** What a payload looks like inside a holder: the id, its hex, and the marker's hex. */
const needles = (id: string): string[] => [id, hexOf(id), hexOf(MARKER), MARKER];

/**
 * Whether any string reachable from the holder (its maps, sets, arrays and objects) contains a
 * needle. The peer handle is the store, not the holder's copy, and is not walked.
 */
function retained(
  holder: object,
  wanted: readonly string[],
  exactly: readonly string[] = [],
): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [holder];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (exactly.includes(value) || wanted.some((n) => value.includes(n))) return true;
      continue;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof Promise) continue;
    if (value instanceof Map) for (const [k, v] of value) stack.push(k, v);
    else if (value instanceof Set) for (const v of value) stack.push(v);
    else
      for (const [k, v] of Object.entries(value))
        if (!(value === holder && k === "peer")) stack.push(k, v);
  }
  return false;
}

/** One writer of one peer of a store. */
async function writer(options: MemoryStoreOptions = {}) {
  const store = createMemoryStore(options);
  const peer = await store.createPeer(PEER, { erasure: "unproven" });
  let head: string | null = null;
  let sequence = 0;
  return {
    store,
    peer,
    async append(deltas: readonly Delta[]) {
      const nextHead = `h${++sequence}`;
      const added = deltas.map((delta) => ({
        delta,
        arrival: { id: delta.id, at: 1, sequence: ++sequence, transfer: 1, sender: "local" },
      }));
      const result = await peer.append({ expectedHead: head, nextHead, frame: null, added });
      if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
      head = nextHead;
    },
  };
}

async function fresh(peer: PeerStore, root: string, now: number): Promise<string> {
  const snapshot = await peer.read();
  try {
    return resultCanonicalHex((await readAnchored(snapshot, { term: LEAF, root, now })).result);
  } finally {
    snapshot.release();
  }
}

describe("StoreViews", () => {
  it("refuses an unanchored program as a read does, and a name given twice", () => {
    const views = new StoreViews(createMemoryStoreless());
    const aliased = parseTerm(
      document.programs.find((p) => p.name === "aliased")!.term as Record<string, unknown>,
    );
    let reason: string | undefined;
    try {
      views.register("aliased", { term: aliased });
    } catch (error) {
      if (error instanceof UnanchoredTermError) reason = error.reason;
    }
    expect(reason).toBe("aliased");
    views.register("leaf", { term: LEAF });
    expect(() => views.register("leaf", { term: LEAF })).toThrow(StoreError);
    for (const max of [0, 1.5, -1, Number.NaN])
      expect(() => new StoreViews(createMemoryStoreless(), { maxViews: max })).toThrow(
        "maxViews must be an integer of 1 or more",
      );
  });

  it("refuses an unknown program and a now that is not finite, before any store call", async () => {
    const calls: string[] = [];
    const views = new StoreViews(counting(calls));
    views.register("leaf", { term: LEAF });
    for (const call of [
      () => views.hold("missing", "x", 1),
      () => views.hold("leaf", "x", Number.NaN),
      () => views.refresh(Number.POSITIVE_INFINITY),
      () => views.setEpoch("missing", "e"),
    ])
      await expect(call()).rejects.toMatchObject({ code: "invalid-request" });
    expect(calls).toEqual([]);
  });

  it("forgets a dropped or evicted view entirely: the indexes return to their sizes", async () => {
    const w = await writer();
    await w.append([fact("a", 1), fact("b", 2), fact("c", 3, { until: 50 })]);
    const views = new StoreViews(w.peer, { maxViews: 2 });
    views.register("leaf", { term: LEAF });
    await views.hold("leaf", "a", 10);
    const one = views.indexSizes();
    await views.hold("leaf", "c", 10);
    // Read c again, so its first answer stays as a baseline beside its new bytes.
    await w.append([fact("c", 4, { until: 50 })]);
    await views.hold("leaf", "c", 10);
    expect(views.indexSizes().baselines).toBeGreaterThan(0);
    expect(views.nextBoundary).toBe(50);
    await views.drop("leaf", "c");
    expect(views.indexSizes()).toEqual(one);
    expect(views.nextBoundary).toBe(null);
    await views.hold("leaf", "b", 10);
    await views.hold("leaf", "c", 10); // evicts a
    await views.drop("leaf", "b");
    await views.drop("leaf", "c");
    expect(views.indexSizes()).toEqual({
      views: 0,
      anchors: 0,
      members: 0,
      baselines: 0,
      expiries: 0,
      starts: 0,
      programs: 0,
    });
  });

  it("runs its calls one at a time, in call order; a rejected call breaks nothing", async () => {
    const w = await writer();
    await w.append([fact("a", 1)]);
    const views = new StoreViews(w.peer);
    views.register("leaf", { term: LEAF });
    const order: string[] = [];
    const calls = [
      views.hold("leaf", "a", 10).then(() => order.push("hold")),
      views.hold("missing", "a", 10).catch(() => order.push("refused")),
      views.refresh(10).then((r) => order.push(`refresh ${r.reread.length}`)),
      views.drop("leaf", "a").then(() => order.push("drop")),
      views.refresh(10).then((r) => order.push(`refresh ${r.position.revision}`)),
    ];
    await Promise.all(calls);
    expect(order).toEqual(["hold", "refused", "refresh 0", "drop", "refresh 1"]);
  });

  it("refuses drop of a program not registered; a view not held is no error", async () => {
    const calls: string[] = [];
    const views = new StoreViews(counting(calls));
    views.register("leaf", { term: LEAF });
    await expect(views.drop("missing", "a")).rejects.toMatchObject({ code: "invalid-request" });
    await views.drop("leaf", "a");
    expect(calls).toEqual([]);
  });

  it("only hold counts as a use: a refresh that reads a view does not save it from eviction", async () => {
    const w = await writer();
    await w.append([fact("a", 1), fact("b", 1), fact("c", 1)]);
    const views = new StoreViews(w.peer, { maxViews: 2 });
    views.register("leaf", { term: LEAF });
    await views.hold("leaf", "a", 10);
    await views.hold("leaf", "b", 10);
    await w.append([fact("a", 2)]);
    expect((await views.refresh(10)).reread).toEqual([{ name: "leaf", root: "a" }]);
    await views.hold("leaf", "c", 10); // evicts a, the least recently held
    expect((await views.hold("leaf", "b", 10)).from).toBe("held");
    expect((await views.hold("leaf", "a", 10)).from).toBe("new");
  });

  it("a view a hold evicts is not read in that pass", async () => {
    const w = await writer();
    await w.append([fact("a", 1), fact("b", 1)]);
    const views = new StoreViews(w.peer, { maxViews: 1 });
    views.register("va", { term: LEAF });
    views.register("vb", { term: LEAF });
    await views.hold("va", "a", 10);
    await w.append([fact("a", 2)]);
    await views.hold("vb", "b", 10);
    expect([views.evalCountOf("va"), views.evalCountOf("vb")]).toEqual([1, 1]);
  });

  it("a refresh that fails changes nothing: the next refresh reads what the failed one owed", async () => {
    for (const quirk of [{}, { advanceOnFailure: true }]) {
      const w = await writer();
      await w.append([fact("a", 1)]);
      let fault = false;
      const peer: PeerStore = {
        ...w.peer,
        changes: async (from, to) =>
          fault ? { status: "ok", records: [], through: from } : w.peer.changes(from, to),
      };
      const views = new StoreViews(peer, {}, quirk);
      views.register("leaf", { term: LEAF });
      const before = (await views.hold("leaf", "a", 10)).bytes;
      await w.append([fact("a", 2)]);
      fault = true;
      await expect(views.refresh(10)).rejects.toBeInstanceOf(StoreFaultError);
      fault = false;
      const after = await views.refresh(10);
      const want = await fresh(w.peer, "a", 10);
      expect(want).not.toBe(before);
      if (quirk.advanceOnFailure === true) expect(after.changed).toEqual([]);
      else expect(after.changed.map((c) => c.after)).toEqual([want]);
    }
  });

  it("reports a store that breaks its contract as a fault value with its rule, and applies nothing", async () => {
    const cases: readonly {
      rule: string;
      changes?: (from: number, to: number) => { through: number };
      get?: true;
    }[] = [
      { rule: "past-the-bound", changes: (_from, to) => ({ through: to + 5 }) },
      { rule: "no-progress", changes: (from) => ({ through: from }) },
      { rule: "unasked-ids", get: true },
    ];
    for (const fault of cases) {
      const w = await writer();
      await w.append([fact("a", 1), fact("b", 1)]);
      const touching = fact("a", 2);
      let broken = false;
      const peer: PeerStore = {
        ...w.peer,
        changes: async (from, to) => {
          if (!broken || fault.changes === undefined) return w.peer.changes(from, to);
          return {
            status: "ok",
            records: [{ revision: from + 1, head: null, added: [touching.id], removed: [] }],
            ...fault.changes(from, to!),
          };
        },
        read: async () => {
          const snapshot = await w.peer.read();
          if (!broken || fault.get !== true) return snapshot;
          // The answer names an id the call did not ask for.
          return {
            ...snapshot,
            get: async (ids) => [...(await snapshot.get(ids)), fact("zz-unasked", 9)],
          };
        },
      };
      const views = new StoreViews(peer);
      views.register("leaf", { term: LEAF });
      const before = await views.hold("leaf", "a", 10);
      const sizes = views.indexSizes();
      await w.append([touching]);
      broken = true;
      const error = await views.refresh(10).catch((e: unknown) => e);
      expect(error, fault.rule).toBeInstanceOf(StoreFaultError);
      expect((error as StoreFaultError).rule).toBe(fault.rule);
      // Nothing applied: the view is where it was, and a sound store then moves it on.
      expect(views.indexSizes()).toEqual(sizes);
      broken = false;
      const after = await views.refresh(10);
      expect(after.changed.map((c) => [c.before, c.after])).toEqual([
        [before.bytes, await fresh(w.peer, "a", 10)],
      ]);
    }
  });

  it("starts a pass again when read() itself answers snapshot-moved", async () => {
    const w = await writer();
    await w.append([fact("a", 1)]);
    let moves = 3;
    const peer: PeerStore = {
      ...w.peer,
      read: async () => {
        if (moves > 0) {
          moves -= 1;
          throw new StoreError("snapshot-moved", "moved");
        }
        return w.peer.read();
      },
    };
    const views = new StoreViews(peer);
    views.register("leaf", { term: LEAF });
    expect((await views.hold("leaf", "a", 10)).from).toBe("new");
    moves = 4;
    await expect(views.refresh(10)).rejects.toMatchObject({ code: "snapshot-moved" });
  });

  it("starts a pass again when the peer moves under it, at most four snapshots", async () => {
    const w = await writer();
    await w.append([fact("a", 1)]);
    let moves = 0;
    let reads = 0;
    let releases = 0;
    const peer: PeerStore = {
      ...w.peer,
      read: async () => {
        reads += 1;
        const snapshot = await w.peer.read();
        return {
          ...snapshot,
          release: () => ((releases += 1), snapshot.release()),
          scope: async (request) => {
            if (moves > 0) {
              moves -= 1;
              throw new StoreError("snapshot-moved", "moved");
            }
            return snapshot.scope(request);
          },
        };
      },
    };
    const views = new StoreViews(peer);
    views.register("leaf", { term: LEAF });
    moves = 3;
    expect((await views.hold("leaf", "a", 10)).from).toBe("new");
    expect([reads, releases]).toEqual([4, 4]);
    await w.append([fact("a", 2)]);
    moves = 4;
    await expect(views.refresh(10)).rejects.toMatchObject({ code: "snapshot-moved" });
    expect([reads, releases]).toEqual([8, 8]);
  });

  it("resyncs with no feed call on another history or a lower revision", async () => {
    for (const twist of [
      (s: { history: string; revision: number }) => ({ history: `${s.history}-restored` }),
      (s: { history: string; revision: number }) => ({ revision: s.revision - 2 }),
    ]) {
      const w = await writer();
      await w.append([fact("a", 1), fact("b", 2)]);
      let twisted = false;
      const calls: string[] = [];
      const peer: PeerStore = {
        ...w.peer,
        read: async () => {
          const snapshot = await w.peer.read();
          return twisted ? { ...snapshot, ...twist(snapshot) } : snapshot;
        },
        changes: (from, to) => (calls.push("changes"), w.peer.changes(from, to)),
      };
      const views = new StoreViews(peer);
      views.register("leaf", { term: LEAF });
      await views.hold("leaf", "a", 10);
      await views.hold("leaf", "b", 10);
      await w.append([fact("c", 3)]);
      twisted = true;
      const refreshed = await views.refresh(10);
      expect([refreshed.resynced, refreshed.reread.length, calls]).toEqual([true, 2, []]);
    }
  });

  it("a pass that reads a purge leaves no payload in the holder; the bystander is untouched", async () => {
    const w = await writer();
    const secret = makeDelta({
      timestamp: 1,
      validFrom: 1,
      author: "did:key:zA",
      pointers: [at("t"), { role: "value", target: { kind: "primitive", value: MARKER } }],
    });
    await w.append([secret, fact("other", 2)]);
    const views = new StoreViews(w.peer);
    views.register("leaf", { term: LEAF });
    views.register("by", { term: LEAF });
    await views.hold("leaf", "t", 10);
    const bystander = await views.hold("by", "other", 10);
    await w.append([fact("t", 3)]);
    // Read again: the baseline (the first answer) still carries the payload.
    expect((await views.hold("leaf", "t", 10)).from).toBe("read");
    expect(retained(views, needles(secret.id))).toBe(true);
    await w.peer.purge([secret.id]);
    const reads = views.evalCountOf("by");
    // This pass reads the purge.
    const again = await views.hold("by", "other", 10);
    expect(retained(views, needles(secret.id))).toBe(false);
    expect([again.from, again.bytes, views.evalCountOf("by")]).toEqual([
      "held",
      bystander.bytes,
      reads,
    ]);
    const refreshed = await views.refresh(10);
    expect(refreshed.changed).toEqual([
      { name: "leaf", root: "t", before: null, after: await fresh(w.peer, "t", 10) },
    ]);
    expect(JSON.stringify(refreshed)).not.toContain(hexOf(secret.id));
  });

  it("a pass that reads a purge and then fails keeps the payload; the next pass that succeeds releases the baseline", async () => {
    const w = await writer();
    const secret = makeDelta({
      timestamp: 1,
      validFrom: 1,
      author: "did:key:zA",
      pointers: [at("t"), { role: "value", target: { kind: "primitive", value: MARKER } }],
    });
    await w.append([secret, fact("other", 2)]);
    let broken = false;
    let fed = 0;
    const peer: PeerStore = {
      ...w.peer,
      changes: (from, to) => ((fed += broken ? 1 : 0), w.peer.changes(from, to)),
      read: async () => {
        const snapshot = await w.peer.read();
        if (!broken) return snapshot;
        return {
          ...snapshot,
          scope: () => Promise.reject(new StoreError("store-closed", "the read fails")),
        };
      },
    };
    const views = new StoreViews(peer, {}, ERASURE_QUIRKS);
    views.register("leaf", { term: LEAF });
    views.register("by", { term: LEAF });
    await views.hold("leaf", "t", 10);
    const bystander = await views.hold("by", "other", 10);
    await w.append([fact("t", 3)]);
    expect((await views.hold("leaf", "t", 10)).from).toBe("read");
    await w.peer.purge([secret.id]);
    const sizes = views.indexSizes();
    broken = true;
    await expect(views.refresh(10)).rejects.toMatchObject({ code: "store-closed" });
    expect(fed).toBeGreaterThan(0);
    expect(retained(views, needles(secret.id))).toBe(true);
    expect(views.indexSizes()).toEqual(sizes);
    broken = false;
    const refreshed = await views.refresh(10);
    expect(retained(views, needles(secret.id))).toBe(false);
    expect(refreshed.changed).toEqual([
      { name: "leaf", root: "t", before: null, after: await fresh(w.peer, "t", 10) },
    ]);
    const again = await views.hold("by", "other", 10);
    expect([again.from, again.bytes]).toEqual(["held", bystander.bytes]);
  });

  it("a purge reaches a held view at the next refresh; a named bystander is not read again", async () => {
    const w = await writer();
    const secret = fact("target", 1);
    const kept = fact("target", 2);
    await w.append([secret, kept, fact("bystander", 3)]);
    const views = new StoreViews(w.peer);
    views.register("leaf", { term: LEAF });
    views.register("other", { term: LEAF });
    const target = await views.hold("leaf", "target", 10);
    const bystander = await views.hold("other", "bystander", 10);
    expect(target.bytes).toContain(hexOf(secret.id));
    const reads = views.evalCountOf("other");
    await w.peer.purge([secret.id]);
    // Until the next pass, the held copy keeps the payload: it lies outside the store.
    const refreshed = await views.refresh(10);
    expect(refreshed.reread).toEqual([{ name: "leaf", root: "target" }]);
    expect(refreshed.changed.map((c) => c.after)).toEqual([await fresh(w.peer, "target", 10)]);
    expect(refreshed.changed[0]!.after).not.toContain(hexOf(secret.id));
    expect(refreshed.changed[0]!.after).toContain(hexOf(kept.id));
    expect(views.evalCountOf("other")).toBe(reads);
    const again = await views.hold("other", "bystander", 10);
    expect([again.from, again.bytes]).toEqual(["held", bystander.bytes]);
  });

  it("answers the view's capture at its position, and checkFresh agrees", async () => {
    const w = await writer();
    await w.append([fact("a", 1)]);
    const views = new StoreViews(w.peer);
    views.register("leaf", { term: LEAF });
    await views.hold("leaf", "a", 10);
    await w.append([fact("elsewhere", 2)]);
    const read = await views.hold("leaf", "a", 10);
    expect(read.from).toBe("held");
    expect(read.capture.revision).toBe(read.position.revision);
    expect(await checkFresh(w.peer, read.capture, 10)).toEqual({ status: "current" });
  });

  it("advanceCapture moves a built capture forward within its history only", async () => {
    const w = await writer();
    await w.append([fact("a", 1)]);
    const views = new StoreViews(w.peer);
    views.register("leaf", { term: LEAF });
    const { capture } = await views.hold("leaf", "a", 10);
    expect(advanceCapture(capture, capture.history, capture.revision)).toBe(capture);
    const moved = advanceCapture(capture, capture.history, capture.revision + 3);
    expect([moved.revision, moved.members]).toEqual([capture.revision + 3, capture.members]);
    for (const [history, revision] of [
      ["another", capture.revision + 1],
      [capture.history, capture.revision - 1],
      [capture.history, 1.5],
    ] as const)
      expect(() => advanceCapture(capture, history, revision)).toThrow(StoreError);
    expect(() => advanceCapture({ ...capture }, capture.history, 9)).toThrow("not built");
  });
});

function createMemoryStoreless(): PeerStore {
  return counting([]);
}

/** A peer handle that only counts calls; every call answers nothing useful. */
function counting(calls: string[]): PeerStore {
  const no = (op: string) => () => {
    calls.push(op);
    throw new Error(`no ${op}`);
  };
  return {
    id: PEER,
    history: "h",
    erasure: { posture: "unproven", storeClass: "unprovable" },
    read: no("read"),
    append: no("append"),
    purge: no("purge"),
    changes: no("changes"),
  } as unknown as PeerStore;
}

// ---- the fuzz ---------------------------------------------------------------------------------

const FUZZ = Number(process.env["VIEWS_FUZZ"] ?? 2000);

/** A small deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Entry = { readonly delta: Delta; readonly arrival: ArrivalRecord };
type Seen = {
  readonly scope: readonly string[];
  readonly raw: ReadonlyMap<string, string>;
  readonly since: number | null;
  readonly expiresAt: number | null;
  readonly bytes: string;
};

/** The brute force: a read over the holdings by scanning, as rounds.json mode 1. */
class Brute {
  readonly registry = SchemaRegistry.build(
    document.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
  );
  readonly corpus = new Map(
    document.deltas.map((d) => [d.name, { id: d.id, claims: parseClaims(d.claims) } as Delta]),
  );
  readonly programs = new Map<string, { term: Term; selection: Pushdown | undefined }>(
    document.programs.map((p) => [
      p.name,
      {
        term: parseTerm(p.term),
        selection:
          p.selection === undefined
            ? undefined
            : {
                ...p.selection,
                ...(p.selection.excludeIds === undefined
                  ? {}
                  : {
                      excludeIds: p.selection.excludeIds.map((n) => this.corpus.get(n)!.id),
                    }),
              },
      },
    ]),
  );

  read(held: ReadonlyMap<string, Entry>, program: string, root: string, now: number): Seen {
    const { term, selection } = this.programs.get(program)!;
    const all = [...held.values()];
    const admitted =
      selection === undefined
        ? all
        : all.filter((e) => passesSelection(e, selection, PUSHDOWN_FIELDS));
    const result = evalTerm(
      term,
      DeltaSet.from(admitted.map((e) => e.delta)),
      now,
      root,
      this.registry,
    );
    const analysis = anchorAnalysis(term, this.registry);
    if (!analysis.anchored) throw new Error("unanchored");
    const gather = term.kind === "resolve" ? term.of : term;
    const scope = new Set<string>();
    let next = [...new Set([root, ...analysis.anchors])];
    let members: string[] = [];
    while (next.length > 0) {
      for (const e of next) scope.add(e);
      members = scopeOver(admitted, [...scope]);
      const inScope = new Set(members);
      const gathered = evalTerm(
        gather,
        DeltaSet.from(admitted.filter((e) => inScope.has(e.delta.id)).map((e) => e.delta)),
        now,
        root,
        this.registry,
      );
      if (gathered.sort !== "hview") throw new Error("not an hview");
      next = hviewAnchors(gathered.hview).filter((e) => !scope.has(e));
    }
    const inScope = new Set(members);
    let since: number | null = null;
    let expiresAt: number | null = null;
    for (const { delta } of admitted)
      if (inScope.has(delta.id))
        for (const b of [delta.claims.validFrom, delta.claims.validUntil]) {
          if (b === undefined) continue;
          if (b > now && (expiresAt === null || b < expiresAt)) expiresAt = b;
          if (b <= now && (since === null || b > since)) since = b;
        }
    const sorted = [...scope].sort(compareUtf8);
    return {
      scope: sorted,
      raw: new Map(scopeOver(all, sorted).map((id) => [id, JSON.stringify(held.get(id)!.arrival)])),
      since,
      expiresAt,
      bytes: resultCanonicalHex(result),
    };
  }
}

const brute = new Brute();
const FUZZ_PROGRAMS = ["leaf", "tree1", "tree", "lawful", "resolved", "before-60"];
const FUZZ_ROOTS = [
  "garden:1",
  "bed:1",
  "bed:2",
  "plant:1",
  "plant:2",
  "plant:s",
  "cutting:1",
  "cutting:2",
  "cutting:9",
  "seed:1",
  "grants",
];
const FUZZ_TIMES = [30, 33, 34, 35, 36, 44, 55, 59, 60, 61, 85, 90, 95, 100];
const PEER_B = `ed25519:${"b7".repeat(32)}`;

type FuzzStats = Record<
  | "holds"
  | "refreshes"
  | "touched"
  | "windows"
  | "epochs"
  | "resyncs"
  | "evictions"
  | "purges"
  | "reheld"
  | "unheld"
  | "droppedEvicted",
  number
>;

async function fuzzOne(seed: number, stats: FuzzStats): Promise<void> {
  const rnd = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const retention = rnd() < 0.4 ? { revisions: 1 + Math.floor(rnd() * 4) } : undefined;
  const pageSize = rnd() < 0.5 ? 1 + Math.floor(rnd() * 3) : undefined;
  const maxViews = rnd() < 0.5 ? 2 + Math.floor(rnd() * 4) : undefined;
  const store = createMemoryStore({
    ...(retention === undefined ? {} : { changeRetention: retention }),
    ...(pageSize === undefined ? {} : { changePageSize: pageSize }),
  });
  const a = await store.createPeer(document.peers["A"]!, { erasure: "unproven" });
  const b = await store.createPeer(PEER_B, { erasure: "unproven" });
  const heads = new Map<PeerStore, string | null>([
    [a, null],
    [b, null],
  ]);
  const held = new Map<string, Entry>();
  /** Ids purged from A in this sequence: once a pass has read their purge, the holder keeps none. */
  const purged = new Set<string>();
  /** A's records: revision, removed ids, added ids. */
  const records: { revision: number; added: string[]; removed: string[] }[] = [];
  let sequence = 0;
  let commits = 0;
  const append = async (peer: PeerStore, deltas: readonly Delta[]) => {
    const nextHead = `h${++commits}`;
    const added = deltas.map((delta) => ({
      delta,
      arrival: {
        id: delta.id,
        at: 1000 + sequence,
        sequence: ++sequence,
        transfer: 1,
        sender: "f",
      },
    }));
    const result = await peer.append({
      expectedHead: heads.get(peer)!,
      nextHead,
      frame: null,
      added,
    });
    if (result.status !== "committed") throw new Error(result.status);
    heads.set(peer, nextHead);
    if (peer === a) {
      records.push({ revision: result.revision, added: [...result.added], removed: [] });
      for (const x of added) if (result.added.includes(x.delta.id)) held.set(x.delta.id, x);
    }
  };
  // The setup of views.json: A holds the two admissions.
  for (const step of document.setup)
    if (step.op === "append")
      await append(
        a,
        step.added.map((x) => brute.corpus.get(x.delta)!),
      );
  const corpus = [...brute.corpus.values()];

  const views = new StoreViews(a, maxViews === undefined ? {} : { maxViews });
  const epochs = new Map<string, string>();
  for (const name of FUZZ_PROGRAMS) {
    views.register(name, {
      term: brute.programs.get(name)!.term,
      registry: brute.registry,
      ...(brute.programs.get(name)!.selection === undefined
        ? {}
        : { selection: { pushdown: brute.programs.get(name)!.selection! } }),
    });
    epochs.set(name, "");
  }
  type Model = Seen & { program: string; root: string; epoch: string };
  const model = new Map<string, Model>();
  /** Views an eviction forgot since the previous refresh, not held again or dropped since. */
  const evictions = new Set<string>();
  /**
   * The host's copy of each view it believes held, kept by the host rule alone: copy a `hold`
   * answer whose `from` is "new", then only `changed[].after`; stop at a view in `evicted`.
   */
  const host = new Map<string, string>();
  const evictedOnce = new Set<string>();
  let processed: number | undefined;
  const floor = (): number => {
    if (retention === undefined || records.length <= retention.revisions) return 0;
    return records[records.length - retention.revisions - 1]!.revision;
  };
  const fail = (why: string): never => {
    throw new Error(`seed ${seed}: ${why}`);
  };

  /** The contract's pass over the model: which views must be read again, and whether it resyncs. */
  const pass = (now: number): { reads: Set<string>; resynced: boolean } => {
    const reads = new Set<string>();
    let resynced = false;
    if (model.size > 0 && processed !== undefined) {
      if (processed < floor()) resynced = true;
      else {
        const since = records.filter((r) => r.revision > processed!);
        const removed = new Set(since.flatMap((r) => r.removed));
        for (const [key, v] of model) {
          const now = scopeOver([...held.values()], v.scope);
          const changed =
            now.length !== v.raw.size ||
            now.some((id) => v.raw.get(id) !== JSON.stringify(held.get(id)!.arrival)) ||
            [...removed].some((id) => v.raw.has(id));
          if (changed) {
            reads.add(key);
            stats.touched += 1;
          }
        }
      }
    }
    for (const [key, v] of model) {
      if (resynced) reads.add(key);
      else if (
        (v.since !== null && now < v.since) ||
        (v.expiresAt !== null && now >= v.expiresAt)
      ) {
        reads.add(key);
        stats.windows += 1;
      } else if (v.epoch !== epochs.get(v.program)) {
        reads.add(key);
        stats.epochs += 1;
      }
    }
    if (resynced) stats.resyncs += 1;
    return { reads, resynced };
  };
  const reread = (keys: Iterable<string>, now: number) => {
    for (const key of keys) {
      const v = model.get(key)!;
      model.set(key, {
        ...brute.read(held, v.program, v.root, now),
        program: v.program,
        root: v.root,
        epoch: epochs.get(v.program)!,
      });
    }
  };
  const plain = (key: string) =>
    brute.programs.get(model.get(key)!.program)!.selection === undefined;

  for (let op = 0; op < 14; op++) {
    const r = rnd();
    const now = pick(FUZZ_TIMES);
    if (r < 0.3) {
      stats.holds += 1;
      const program = pick(FUZZ_PROGRAMS);
      const root = pick(FUZZ_ROOTS);
      const key = JSON.stringify([program, root]);
      const was = model.has(key);
      const { reads } = pass(now);
      reread(reads, now);
      if (!was && maxViews !== undefined && model.size >= maxViews) {
        const gone = model.keys().next().value!;
        model.delete(gone);
        evictions.add(gone);
        evictedOnce.add(gone);
        stats.evictions += 1;
      }
      const answer = await views.hold(program, root, now);
      const want = brute.read(held, program, root, now);
      if (answer.bytes !== want.bytes) fail(`hold of ${key} at ${now} answered other bytes`);
      const v = was ? model.get(key)! : { ...want, program, root, epoch: epochs.get(program)! };
      model.delete(key);
      model.set(key, v);
      evictions.delete(key);
      const from = !was ? "new" : reads.has(key) ? "read" : "held";
      if (brute.programs.get(program)!.selection === undefined || from === "new") {
        if (answer.from !== from) fail(`hold of ${key} answered ${answer.from}, expected ${from}`);
      } else if (answer.from === "new") fail(`hold of ${key} answered new, and it was held`);
      // The host rule: a "new" answer is the view's baseline, and the host copies it.
      if (answer.from === "new") {
        host.set(key, answer.bytes);
        if (evictedOnce.has(key)) stats.reheld += 1;
      }
      if (answer.expiresAt !== model.get(key)!.expiresAt) fail(`hold of ${key}: expiresAt`);
      processed = answer.position.revision;
      // Erasure: this pass read every purge so far; the holder keeps no purged id or payload.
      for (const id of purged)
        if (!held.has(id) && retained(views, [entryHex(id)], [id]))
          fail(`after a pass, the holder still keeps ${id.slice(0, 12)}`);
    } else if (r < 0.55) {
      stats.refreshes += 1;
      const { reads, resynced } = pass(now);
      reread(reads, now);
      const answer = await views.refresh(now);
      if (answer.resynced !== resynced) fail(`refresh resynced ${answer.resynced}`);
      const got = answer.reread
        .map((k) => JSON.stringify([k.name, k.root]))
        .filter((k) => plain(k))
        .sort();
      const want = [...reads].filter((k) => plain(k)).sort();
      if (got.join() !== want.join()) fail(`refresh re-read ${got}, expected ${want}`);
      const evicted = answer.evicted.map((k) => JSON.stringify([k.name, k.root]));
      const wantEvicted = [...evictions].sort((x, y) => {
        const [xp, xr] = JSON.parse(x) as [string, string];
        const [yp, yr] = JSON.parse(y) as [string, string];
        return compareUtf8(xp, yp) || compareUtf8(xr, yr);
      });
      if (evicted.join() !== wantEvicted.join())
        fail(`refresh evicted ${evicted}, expected ${wantEvicted}`);
      if (evicted.length > 0) stats.unheld += 1;
      evictions.clear();
      // The host rule: copy from `changed`, stop at `evicted`.
      for (const c of answer.changed) {
        const key = JSON.stringify([c.name, c.root]);
        if (!host.has(key)) fail(`changed names ${key}, which the host does not hold`);
        host.set(key, c.after);
      }
      for (const key of evicted)
        if (!host.delete(key)) fail(`evicted names ${key}, which the host does not hold`);
      // Rule 1: every view the host believes held is held, and is a fresh read now.
      if ([...host.keys()].sort().join() !== [...model.keys()].sort().join())
        fail(`after a refresh at ${now}, the host's views are not the held views`);
      for (const [key, v] of model) {
        if (host.get(key) !== brute.read(held, v.program, v.root, now).bytes)
          fail(`after a refresh at ${now}, the host's ${key} is not a fresh read`);
        if (host.get(key) !== v.bytes) fail(`the model of ${key} disagrees with itself`);
      }
      processed = answer.position.revision;
      // Erasure: this pass read every purge so far; the holder keeps no purged id or payload.
      for (const id of purged)
        if (!held.has(id) && retained(views, [entryHex(id)], [id]))
          fail(`after a pass, the holder still keeps ${id.slice(0, 12)}`);
    } else if (r < 0.8) {
      // A commit: an append (perhaps of nothing), a purge, or another peer's append.
      const c = rnd();
      if (c < 0.12) await append(a, []);
      else if (c < 0.22) await append(b, [pick(corpus)]);
      else if (c < 0.55 && held.size > 0) {
        const id = pick([...held.keys()]);
        const report = await a.purge([id]);
        held.delete(id);
        records.push({ revision: report.revision, added: [], removed: [id] });
        stats.purges += 1;
        purged.add(id);
      } else {
        const absent = corpus.filter((d) => !held.has(d.id));
        if (absent.length > 0) await append(a, [pick(absent)]);
      }
    } else if (r < 0.9) {
      // The host drops a view it believes held: perhaps one an eviction already forgot.
      if (host.size > 0) {
        const key = pick([...host.keys()]);
        const [program, root] = JSON.parse(key) as [string, string];
        if (!model.has(key)) stats.droppedEvicted += 1;
        await views.drop(program, root);
        model.delete(key);
        evictions.delete(key);
        host.delete(key);
      }
    } else {
      const program = pick(FUZZ_PROGRAMS);
      const epoch = pick(["", "e1", "e2"]);
      await views.setEpoch(program, epoch);
      epochs.set(program, epoch);
    }
    let least: number | null = null;
    for (const v of model.values())
      if (v.expiresAt !== null && (least === null || v.expiresAt < least)) least = v.expiresAt;
    if (views.nextBoundary !== least)
      fail(`the next boundary is ${views.nextBoundary}, expected ${least}`);
  }
  await store.close();
}

describe("held views against brute force", () => {
  it(`${FUZZ} random sequences: every answer is a fresh read, and the re-read set is exact`, async () => {
    const stats: FuzzStats = {
      holds: 0,
      refreshes: 0,
      touched: 0,
      windows: 0,
      epochs: 0,
      resyncs: 0,
      evictions: 0,
      purges: 0,
      reheld: 0,
      unheld: 0,
      droppedEvicted: 0,
    };
    for (let seed = 1; seed <= FUZZ; seed++) await fuzzOne(seed, stats);
    console.log(`views fuzz: ${FUZZ} sequences, ${JSON.stringify(stats)}`);
    for (const value of Object.values(stats)) expect(value).toBeGreaterThan(0);
  }, 1_200_000);
});

// ---- the cost rails ---------------------------------------------------------------------------

describe("cost rail: a refresh costs its records and its reads", () => {
  // Timed from outside with a monotonic clock, as vectors/store/README.md §3.9.9: N refreshes at N
  // and at 8N, the run at N the fastest of five, at 8N the fastest of three, stopped at the first
  // under the bound. Each refresh follows one commit that touches one small view: an append of a
  // fact at its anchor, then a purge of it, in turn. The total scales by about 8. A refresh that
  // walks the held views, the holdings or the earlier records costs N per call: about 64.
  const BOUND = 24;

  async function fastest(run: () => Promise<number>, runs: number, enough = 0): Promise<number> {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs && best >= enough; i++) best = Math.min(best, await run());
    return best;
  }

  async function scaling(name: string, make: (n: number) => Promise<() => Promise<number>>) {
    let n = 256;
    let small = await fastest(await make(n), 5);
    while (small < 50 && n < 1 << 16) small = await fastest(await make((n *= 2)), 5);
    const large = await fastest(await make(8 * n), 3, BOUND * small);
    const ratio = large / small;
    console.log(
      `${name}: N = ${n}, ${small.toFixed(1)} ms and ${large.toFixed(1)} ms, ratio ${ratio.toFixed(2)}`,
    );
    expect(ratio, `N = ${n}: ${small.toFixed(1)} ms, then ${large.toFixed(1)} ms`).toBeLessThan(
      BOUND,
    );
  }

  /** N rounds of: one commit at `hot`, then one refresh that reads the view at `hot` again. */
  const timed =
    (w: Awaited<ReturnType<typeof writer>>, views: StoreViews, n: number) => async () => {
      const toggle = fact("hot", 9_999_999);
      let held = false;
      const start = performance.now();
      for (let i = 0; i < n; i++) {
        if (held) await w.peer.purge([toggle.id]);
        else await w.append([toggle]);
        held = !held;
        const refreshed = await views.refresh(10);
        if (refreshed.reread.length !== 1) throw new Error(`re-read ${refreshed.reread.length}`);
      }
      return performance.now() - start;
    };

  async function holder(w: Awaited<ReturnType<typeof writer>>, roots: readonly string[]) {
    const views = new StoreViews(w.peer, { maxViews: roots.length + 1 }, RAIL_QUIRKS);
    views.register("leaf", { term: LEAF });
    await views.hold("leaf", "hot", 10);
    for (const root of roots) await views.hold("leaf", root, 10);
    return views;
  }

  it(`N held views: N refreshes cost less than ${BOUND} times at 8N`, async () => {
    await scaling("refresh beside N held views", async (n) => {
      const w = await writer();
      const roots = Array.from({ length: n }, (_, i) => `view:${i}`);
      await w.append([fact("hot", 1), ...roots.map((root, i) => fact(root, i + 2))]);
      return timed(w, await holder(w, roots), n);
    });
  }, 600_000);

  it(`N holdings: N refreshes cost less than ${BOUND} times at 8N`, async () => {
    await scaling("refresh beside N holdings", async (n) => {
      const w = await writer();
      await w.append([
        fact("hot", 1),
        ...Array.from({ length: n }, (_, i) => fact(`bulk:${i}`, i)),
      ]);
      return timed(w, await holder(w, ["bulk:0", "bulk:1", "bulk:2", "bulk:3"]), n);
    });
  }, 600_000);

  it(`N records before the processed position: N refreshes cost less than ${BOUND} times at 8N`, async () => {
    await scaling("refresh after N earlier records", async (n) => {
      const w = await writer();
      await w.append([fact("hot", 1)]);
      for (let i = 0; i < n; i++) await w.append([]);
      return timed(w, await holder(w, ["a", "b"]), n);
    });
  }, 600_000);
});

// The rail's holder. A quirk set here (for example `scanEveryView`) shows the rail going red.
const RAIL_QUIRKS: ViewQuirks = {};

// The erasure rail's holder. `advanceOnFailure` here shows the rail of a failed pass going red.
const ERASURE_QUIRKS: ViewQuirks = {};
