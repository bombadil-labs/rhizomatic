// Freshness over the change feed (SPEC-18 proposal §4.6; vectors/store/README.md §9): the
// shared vectors `freshness.json` against the memory store and the TypeScript freshness
// functions, the wrong readers each witness keeps, a fuzz against brute force, captures taken
// by real reads, and two timed cost rails.
//
// Not covered here: the feed itself (store-feed.test.ts and the scripts), and SPEC-16's scoped
// capture, whose amendment states a rule and changes no code path.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareUtf8 } from "../src/delta/cbor.js";
import { parseClaims } from "../src/delta/json-profile.js";
import { makeDelta, makeNegationClaims } from "../src/delta/set.js";
import type { Claims, Delta, Pointer } from "../src/delta/types.js";
import {
  StoreReactor,
  captureScope,
  fetchScope,
  readAnchored,
  type StoreRead,
  type StoreReadRequest,
} from "../src/reactor/store-read.js";
import { resultCanonicalHex } from "../src/resolve/eval.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import {
  StoreConformanceError,
  type StoreConformanceFailure,
} from "../src/storage/store-conformance.js";
import {
  runFreshnessConformance,
  type FreshnessStoreRequest,
  type FreshnessWitness,
} from "../src/storage/freshness-conformance.js";
import { freshnessVectors } from "../src/storage/freshness-vectors.js";
import {
  checkFresh,
  checkFreshWith,
  makeCapture,
  parseCapture,
  rawScope,
  touching,
  validityWindow,
  type Capture,
  type Freshness,
} from "../src/storage/freshness.js";
import { createMemoryStore, type MemoryStoreOptions } from "../src/storage/memory-store.js";
import {
  PUSHDOWN_FIELDS,
  passesSelection,
  scopeOver,
  type StoreFreshnessDocument,
} from "../src/storage/store-vector-format.js";
import {
  StoreError,
  type ChangeRecord,
  type PeerStore,
  type Pushdown,
  type Snapshot,
  type VerifiedDelta,
} from "../src/storage/store.js";
import { parseTerm } from "../src/syntax/term-json.js";
import { roundVectors } from "../tools/store-round-vectors.js";
import { broken, sparse, type Break } from "./support/broken-store.js";
import { countingSnapshot, type StoreCall } from "./support/store-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const committed = readFileSync(resolve(here, "../../../vectors/store/freshness.json"), "utf8");
const document = JSON.parse(committed) as StoreFreshnessDocument;

const WITNESS: FreshnessWitness = {
  capture: (snapshot, anchors, pushdown, now) =>
    captureScope(
      snapshot,
      anchors.map((anchor) => anchor.entity),
      now,
      { pushdown },
    ),
  touching,
  checkFresh,
};

/** A factory over a broken (or right) memory store; a case's own retention wins. */
const factoryOf =
  (fault: Break = {}) =>
  async ({ changeRetention }: FreshnessStoreRequest) =>
    broken({
      ...fault,
      options: { ...fault.options, ...(changeRetention === undefined ? {} : { changeRetention }) },
    })();

async function failures(
  witness: FreshnessWitness,
  fault: Break = {},
  vectors: StoreFreshnessDocument = document,
): Promise<readonly StoreConformanceFailure[]> {
  try {
    await runFreshnessConformance(factoryOf(fault), witness, vectors);
    return [];
  } catch (error) {
    if (error instanceof StoreConformanceError) return error.failures;
    throw error;
  }
}

// ---- the vectors ------------------------------------------------------------------------------

const TRIMS_AND_REPORTS_NOTHING = "the selection applied and nothing reported applied";

/** The runs of README §9.4, and two scaled stores. */
const RUNS: Readonly<Record<string, Break>> = {
  "as built": {},
  "pages of one record": { options: { changePageSize: 1 } },
  "two records kept": { options: { changeRetention: { revisions: 2 } } },
  "two records kept, pages of one record": {
    options: { changeRetention: { revisions: 2 }, changePageSize: 1 },
  },
  "no pushdown field applied": {
    options: { pushdown: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false } },
  },
  // Run 6: a store that trims by the whole selection and reports no field applied, which §4.3
  // allows. It returns less than the raw scope, and says nothing about why.
  [TRIMS_AND_REPORTS_NOTHING]: {
    snapshot: (s) => ({
      scope: async (request) => ({
        ...(await s.scope(request)),
        applied: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
      }),
    }),
  },
  "revisions times 3, pages of one record": { options: { changePageSize: 1 }, ...sparse(3) },
  "revisions times 2, two records kept": {
    options: { changeRetention: { revisions: 2 } },
    ...sparse(2),
  },
};

describe("freshness vectors", () => {
  it("the committed file is the model's output", () => {
    expect(committed).toBe(`${JSON.stringify(freshnessVectors(), null, 2)}\n`);
  });

  for (const [name, fault] of Object.entries(RUNS))
    it(`pass on the memory store: ${name}`, async () => {
      const report = await runFreshnessConformance(factoryOf(fault), WITNESS, document);
      expect(report.skipped).toEqual([]);
      expect(report.passed).toHaveLength(document.cases.length + document.touching.length);
    });

  it("a capture that takes the fetch as members when nothing is reported applied fails run 6 only", async () => {
    const reader = wrong({
      capture: async (snapshot, anchors, pushdown, now) => {
        const right = await WITNESS.capture(snapshot, anchors, pushdown, now);
        const answer = await snapshot.scope({ anchors: right.anchors, pushdown });
        const nothing = !Object.values(answer.applied).some(Boolean);
        const ids = answer.deltas.map((d) => d.delta.id).sort(compareUtf8);
        return nothing ? makeCapture(right, right.anchors, ids, right) : right;
      },
    });
    for (const [name, fault] of Object.entries(RUNS))
      if (name !== TRIMS_AND_REPORTS_NOTHING)
        expect(await failures(reader, fault), name).toEqual([]);
    const found = await failures(reader, RUNS[TRIMS_AND_REPORTS_NOTHING]!);
    expect(
      found.find((f) => f.name === "freshness/a-selection-rejects-the-toucher")?.message,
      JSON.stringify(found, null, 1),
    ).toContain("the capture's members are");
  });

  it("a store with no feed skips every case and names the requirement", async () => {
    const report = await runFreshnessConformance(
      factoryOf({ profile: (p) => ({ ...p, changeRetention: "none" }) }),
      WITNESS,
      document,
    );
    expect(report.skipped.map((s) => s.missing)).toEqual(document.cases.map(() => "changes"));
  });

  it("a factory that cannot build a case's store skips that case", async () => {
    const report = await runFreshnessConformance(
      async (request) => (request.changeRetention === undefined ? createMemoryStore() : undefined),
      WITNESS,
      document,
    );
    expect(report.skipped).toEqual([{ name: "freshness/retention-too-short", missing: "store" }]);
  });
});

// ---- wrong readers ------------------------------------------------------------------------------

/** `touching` that reports the added deltas as `transform` leaves them. */
const touchingOver =
  (transform: (delta: Delta) => Delta): typeof touching =>
  (capture, records, added) =>
    touching(capture, records, new Map([...added].map(([id, delta]) => [id, transform(delta)])));

const wrong = (part: Partial<FreshnessWitness>): FreshnessWitness => ({ ...WITNESS, ...part });
const withTouching = (touch: typeof touching): FreshnessWitness =>
  wrong({ touching: touch, checkFresh: checkFreshWith(touch) });

const ignoresRemoved: typeof touching = (capture, records, added) =>
  touching(
    capture,
    records.map((r) => ({ ...r, removed: [] })),
    added,
  );
const ignoresNegators = touchingOver((delta) => ({
  ...delta,
  claims: { ...delta.claims, pointers: delta.claims.pointers.filter((p) => p.role !== "negates") },
}));
const everyAddTouches: typeof touching = (capture, records, added) => {
  for (const record of records) {
    const removed = touching(capture, [{ ...record, added: [] }], added);
    if (removed !== null) return removed;
    for (const id of record.added)
      if (added.has(id)) return { revision: record.revision, id, reason: "targets-anchor" };
  }
  return null;
};
const ignoresReAdd: typeof touching = (capture, records, added) =>
  touching(
    capture,
    records.map((r) => ({ ...r, removed: r.removed.filter((id) => !added.has(id)) })),
    added,
  );
const addedBeforeRemoved: typeof touching = (capture, records, added) =>
  touching(
    capture,
    records.map((r) => ({ ...r, removed: [] })),
    added,
  ) ?? touching(capture, records, new Map());

const READERS: readonly {
  readonly name: string;
  readonly witness: FreshnessWitness;
  readonly fails: string;
  readonly message: string;
  /** The cases added for this reader: without them it passes the vectors. */
  readonly newCases?: readonly string[];
}[] = [
  {
    name: "ignores removed",
    witness: withTouching(ignoresRemoved),
    fails: "freshness/a-purge-of-a-member",
    message: "checkFresh answered current, expected stale",
  },
  {
    name: "ignores negators",
    witness: withTouching(ignoresNegators),
    fails: "freshness/an-added-negator-of-a-member",
    message: "checkFresh answered current, expected stale",
  },
  {
    name: "treats every add as touching",
    witness: withTouching(everyAddTouches),
    fails: "freshness/unrelated-appends",
    message: "checkFresh answered stale, expected current",
  },
  {
    name: "reads records after r′",
    witness: wrong({
      checkFresh: (peer, capture, now) =>
        checkFresh({ ...peer, changes: (from) => peer.changes(from) }, capture, now),
    }),
    fails: "freshness/a-head-only-commit",
    message: "checkFresh made the call changes(1, none) where the contract asks for changes(1, 2)",
  },
  {
    name: "ignores a re-add",
    witness: withTouching(ignoresReAdd),
    // The re-added member points at the anchor itself, so it still touches, one record later.
    fails: "freshness/a-member-purged-and-added-again",
    message: "checkFresh reports the touch 3 ",
  },
  {
    name: "examines added before removed",
    witness: withTouching(addedBeforeRemoved),
    fails: "freshness/the-first-of-several-touches",
    message: "checkFresh reports the touch 4 ",
  },
  {
    name: "uses the fetched (pushed-down) set as members",
    witness: wrong({
      capture: async (snapshot, anchors, pushdown, now) => {
        const fetched = await fetchScope(
          snapshot,
          anchors.map((a) => a.entity),
          { pushdown },
        );
        return makeCapture(snapshot, anchors, fetched.source.ids(), fetched.validityAt(now));
      },
    }),
    fails: "freshness/a-selection-rejects-the-toucher",
    message: "the capture's members are",
  },
  {
    name: "ignores the window",
    witness: wrong({
      checkFresh: (peer, capture) => checkFresh(peer, capture, capture.since ?? 0),
    }),
    fails: "freshness/the-window",
    message: "checkFresh answered current, expected not-yet",
  },
  {
    name: "ignores since",
    witness: wrong({
      checkFresh: async (peer, capture, now) => {
        const verdict = await checkFresh(peer, capture, now);
        return verdict.status === "not-yet" ? { status: "current" } : verdict;
      },
    }),
    fails: "freshness/a-fact-that-starts-at-now",
    message: "checkFresh answered current, expected not-yet",
    newCases: ["the-window", "a-fact-that-starts-at-now", "a-negator-sets-the-window"],
  },
  {
    name: "not-yet at since itself",
    witness: wrong({
      checkFresh: async (peer, capture, now) => {
        const verdict = await checkFresh(peer, capture, now);
        return verdict.status === "current" && capture.since === now
          ? { status: "not-yet", since: now }
          : verdict;
      },
    }),
    fails: "freshness/the-window",
    message: "checkFresh answered not-yet, expected current",
  },
  {
    name: "not-yet with the check's now",
    witness: wrong({
      checkFresh: async (peer, capture, now) => {
        const verdict = await checkFresh(peer, capture, now);
        return verdict.status === "not-yet" ? { ...verdict, since: now } : verdict;
      },
    }),
    fails: "freshness/the-window",
    message: "checkFresh reports not-yet since 99, expected 100",
  },
  {
    name: "a capture with no since",
    witness: wrong({
      capture: async (...args) => {
        const right = await WITNESS.capture(...args);
        return makeCapture(right, right.anchors, right.members, {
          since: null,
          expiresAt: right.expiresAt,
        });
      },
    }),
    fails: "freshness/the-window",
    message: "the capture's since is null, expected 100",
  },
  {
    name: "ignores the history",
    witness: wrong({
      checkFresh: (peer, capture, now) =>
        checkFresh(
          peer,
          makeCapture(
            { history: peer.history, revision: capture.revision },
            capture.anchors,
            capture.members,
            capture,
          ),
          now,
        ),
    }),
    fails: "freshness/a-capture-checked-on-another-peer",
    message: "checkFresh answered current, expected resync-required",
    newCases: ["a-capture-checked-on-another-peer"],
  },
  {
    name: "a capture of another history",
    witness: wrong({
      capture: async (...args) =>
        parseCapture({ ...(await WITNESS.capture(...args)), history: "elsewhere" }),
    }),
    fails: "freshness/no-change",
    message: "the capture's history is not its snapshot's",
  },
  {
    name: "drops the members excludeIds rejects",
    witness: wrong({
      capture: async (snapshot, anchors, pushdown, now) => {
        const right = await WITNESS.capture(snapshot, anchors, pushdown, now);
        const out = new Set(pushdown.excludeIds ?? []);
        return makeCapture(
          right,
          right.anchors,
          right.members.filter((id) => !out.has(id)),
          right,
        );
      },
    }),
    fails: "freshness/a-selection-excludes-members",
    message: "the capture's members are",
    newCases: ["a-selection-excludes-members"],
  },
  {
    name: "drops the members arrivalAtMost rejects",
    witness: wrong({
      capture: async (snapshot, anchors, pushdown, now) => {
        const right = await WITNESS.capture(snapshot, anchors, pushdown, now);
        const cut = pushdown.arrivalAtMost;
        const late = new Set(
          (await snapshot.arrivals(right.members))
            .filter((a) => cut !== undefined && a.sequence > cut)
            .map((a) => a.id),
        );
        return makeCapture(
          right,
          right.anchors,
          right.members.filter((id) => !late.has(id)),
          right,
        );
      },
    }),
    fails: "freshness/a-selection-by-arrival",
    message: "the capture's members are",
    newCases: ["a-selection-by-arrival"],
  },
  {
    name: "a window that ignores excludeIds",
    witness: wrong({
      capture: async (snapshot, anchors, { excludeIds: _, ...pushdown }, now) => {
        const right = await WITNESS.capture(snapshot, anchors, pushdown, now);
        const full = await WITNESS.capture(
          snapshot,
          anchors,
          { ...pushdown, ...(_ === undefined ? {} : { excludeIds: _ }) },
          now,
        );
        return makeCapture(full, full.anchors, full.members, right);
      },
    }),
    fails: "freshness/a-selection-excludes-members",
    message: "the capture's since is 22, expected 20",
    newCases: ["a-selection-excludes-members"],
  },
  {
    name: "a window that ignores arrivalAtMost",
    witness: wrong({
      capture: async (snapshot, anchors, { arrivalAtMost: _, ...pushdown }, now) => {
        const right = await WITNESS.capture(snapshot, anchors, pushdown, now);
        const full = await WITNESS.capture(
          snapshot,
          anchors,
          { ...pushdown, ...(_ === undefined ? {} : { arrivalAtMost: _ }) },
          now,
        );
        return makeCapture(full, full.anchors, full.members, right);
      },
    }),
    fails: "freshness/a-selection-by-arrival",
    message: "the capture's since is 23, expected 20",
    newCases: ["a-selection-by-arrival"],
  },
  {
    name: "an expiresAt that leaves out negators",
    witness: wrong({
      capture: async (snapshot, anchors, pushdown, now) => {
        const right = await WITNESS.capture(snapshot, anchors, pushdown, now);
        const facts = (await snapshot.get(right.members)).filter(
          (d) => !d.claims.pointers.some((p) => p.role === "negates"),
        );
        const window = validityWindow(facts, now);
        // Only the deltas the operand admits; with no selection that is every member.
        return makeCapture(right, right.anchors, right.members, {
          since: right.since,
          expiresAt: Object.keys(pushdown).length === 0 ? window.expiresAt : right.expiresAt,
        });
      },
    }),
    fails: "freshness/a-negator-sets-the-window",
    message: "the capture expires at null, expected 130",
    newCases: ["a-negator-sets-the-window"],
  },
  {
    name: "a raw scope that stops after one negation layer",
    witness: wrong({
      capture: async (snapshot, anchors, pushdown, now) => {
        const right = await WITNESS.capture(snapshot, anchors, pushdown, now);
        const direct = await snapshot.targets(right.anchors.map((a) => a.entity));
        const once = await snapshot.negators(direct);
        return makeCapture(
          right,
          right.anchors,
          [...new Set([...direct, ...once])].sort(compareUtf8),
          right,
        );
      },
    }),
    fails: "freshness/a-chain-of-four",
    message: "the capture's members are",
    newCases: ["a-chain-of-four"],
  },
  {
    name: "expiry over the raw scope",
    witness: wrong({
      capture: async (snapshot, anchors, pushdown, now) => {
        const right = await WITNESS.capture(snapshot, anchors, pushdown, now);
        const raw = await snapshot.get(right.members);
        return makeCapture(right, right.anchors, right.members, validityWindow(raw, now));
      },
    }),
    fails: "freshness/a-selection-rejects-the-toucher",
    message: "the capture's since is 70, expected 20",
  },
  {
    name: "reads the feed at equal revisions",
    witness: wrong({
      checkFresh: async (peer, capture, now) => {
        const snapshot = await peer.read();
        await peer.changes(capture.revision, snapshot.revision);
        snapshot.release();
        return checkFresh(peer, capture, now);
      },
    }),
    fails: "freshness/no-change",
    message: "checkFresh made the call changes(1, 1) where the contract asks for release",
  },
  {
    name: "goes on after the touch",
    witness: wrong({
      checkFresh: async (peer, capture, now) => {
        const verdict = await checkFresh(peer, capture, now);
        if (verdict.status === "stale") {
          const snapshot = await peer.read();
          snapshot.release();
        }
        return verdict;
      },
    }),
    fails: "freshness/an-added-delta-targets-an-anchor",
    message: "checkFresh made the call read after its last call",
  },
  {
    name: "a capture of another revision",
    witness: wrong({
      capture: async (...args) => {
        const right = await WITNESS.capture(...args);
        return { ...right, revision: right.revision + 1 };
      },
    }),
    fails: "freshness/no-change",
    message: "the capture is of revision 2, expected 1",
  },
  {
    name: "a capture that keeps the anchors in the order given",
    witness: wrong({
      capture: async (snapshot, anchors, pushdown, now) => ({
        ...(await WITNESS.capture(snapshot, anchors, pushdown, now)),
        anchors,
      }),
    }),
    fails: "freshness/two-anchors",
    message: "the capture is malformed: capture: anchors is not strictly ascending by UTF-8 bytes",
  },
  {
    name: "turns resync-required into current",
    witness: wrong({
      checkFresh: async (peer, capture, now) => {
        const verdict = await checkFresh(peer, capture, now);
        return verdict.status === "resync-required" ? { status: "current" } : verdict;
      },
    }),
    fails: "freshness/retention-too-short",
    message: "checkFresh answered current for a capture below the retention floor 2",
  },
  {
    name: "resync-required with the capture's revision",
    witness: wrong({
      checkFresh: async (peer, capture, now) => {
        const verdict = await checkFresh(peer, capture, now);
        return verdict.status === "resync-required"
          ? { ...verdict, current: capture.revision }
          : verdict;
      },
    }),
    fails: "freshness/retention-too-short",
    message: "checkFresh reports resync-required with current 1, not the peer's revision 3",
  },
  {
    name: "expired at the check's now",
    witness: wrong({
      checkFresh: async (peer, capture, now) => {
        const verdict = await checkFresh(peer, capture, now);
        return verdict.status === "expired" ? { ...verdict, expiresAt: now } : verdict;
      },
    }),
    fails: "freshness/the-window",
    message: "checkFresh reports expiry at 200, expected 120",
  },
  {
    name: "gets the added ids out of order",
    witness: wrong({
      checkFresh: (peer, capture, now) =>
        checkFresh(
          {
            ...peer,
            read: async () => {
              const snapshot = await peer.read();
              return { ...snapshot, get: (ids) => snapshot.get([...ids].reverse()) };
            },
          },
          capture,
          now,
        ),
    }),
    fails: "freshness/two-touchers-in-one-record",
    message: "checkFresh made the call get [",
  },
  {
    name: "makes no get",
    witness: wrong({
      checkFresh: (peer, capture, now) =>
        checkFresh(
          {
            ...peer,
            read: async () => ({ ...(await peer.read()), get: async () => [] }),
          },
          capture,
          now,
        ),
    }),
    fails: "freshness/unrelated-appends",
    message: "checkFresh made the call release where the contract asks for get [",
  },
  {
    name: "does not release its snapshot",
    witness: wrong({
      checkFresh: (peer, capture, now) =>
        checkFresh(
          {
            ...peer,
            read: async () => ({ ...(await peer.read()), release: () => undefined }),
          },
          capture,
          now,
        ),
    }),
    fails: "freshness/no-change",
    message: "checkFresh made no call where the contract asks for release",
  },
  {
    name: "touching drops the last record",
    witness: wrong({
      touching: (capture, records, added) => touching(capture, records.slice(0, -1), added),
    }),
    fails: "freshness/an-added-delta-targets-an-anchor",
    message: "touching answered none, expected 2 ",
  },
];

describe("freshness vectors: wrong readers fail", () => {
  for (const reader of READERS)
    it(reader.name, async () => {
      const found = await failures(reader.witness);
      const own = found.find((f) => f.name === reader.fails);
      expect(own?.message, JSON.stringify(found, null, 1)).toContain(reader.message);
      if (reader.newCases === undefined) return;
      // Without the cases added for it, the reader passes: those cases are what catches it.
      const without = {
        ...document,
        cases: document.cases.filter((c) => !reader.newCases!.includes(c.name)),
      };
      expect(await failures(reader.witness, {}, without)).toEqual([]);
    });
});

// ---- touching and checkFresh, as functions ------------------------------------------------------

const PEER = `ed25519:${"0f".repeat(32)}`;
const at = (id: string, role = "subject"): Pointer => ({
  role,
  target: { kind: "entity", entity: { id, context: "c" } },
});
const fact = (entity: string, t: number, valid: { from?: number; until?: number } = {}): Delta =>
  makeDelta({
    timestamp: t,
    validFrom: valid.from ?? t,
    ...(valid.until === undefined ? {} : { validUntil: valid.until }),
    author: "did:key:zA",
    pointers: [at(entity), { role: "value", target: { kind: "primitive", value: t } }],
  });
const strike = (target: Delta, t: number): Delta =>
  makeDelta(makeNegationClaims("did:key:zB", t, target.id));

/** One writer of one peer of a new memory store. */
async function writer(options: MemoryStoreOptions = {}) {
  const store = createMemoryStore(options);
  const peer = await store.createPeer(PEER, { erasure: "unproven" });
  let head: string | null = null;
  let sequence = 0;
  let n = 0;
  const held = new Map<string, VerifiedDelta>();
  return {
    store,
    peer,
    held,
    async append(deltas: readonly Delta[]) {
      const nextHead = `h${++n}`;
      const added = deltas.map((delta) => ({
        delta,
        arrival: { id: delta.id, at: 1, sequence: ++sequence, transfer: 1, sender: "local" },
      }));
      const result = await peer.append({ expectedHead: head, nextHead, frame: null, added });
      if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
      head = nextHead;
      for (const entry of added) if (!held.has(entry.delta.id)) held.set(entry.delta.id, entry);
    },
    async purge(ids: readonly string[]) {
      await peer.purge(ids);
      for (const id of ids) held.delete(id);
    },
    async capture(entities: readonly string[], now = 0, selection: Pushdown = {}) {
      const snapshot = await peer.read();
      try {
        return await captureScope(snapshot, entities, now, { pushdown: selection });
      } finally {
        snapshot.release();
      }
    },
  };
}

describe("touching", () => {
  it("changes nothing it is given", () => {
    const a = fact("plant:a", 1);
    const capture = makeCapture(
      { history: "h", revision: 1 },
      [{ kind: "entity", entity: "plant:a" }],
      [a.id],
      { since: null, expiresAt: null },
    );
    const records: ChangeRecord[] = [{ revision: 2, head: null, added: [a.id], removed: [] }];
    const before = JSON.stringify([capture, records]);
    touching(capture, records, new Map([[a.id, a]]));
    expect(JSON.stringify([capture, records])).toBe(before);
  });

  it("refuses a capture with an anchor kind it cannot read", () => {
    expect(() =>
      makeCapture(
        { history: "h", revision: 1 },
        [{ kind: "value", entity: "x" } as unknown as never],
        [],
        { since: null, expiresAt: null },
      ),
    ).toThrow(StoreError);
  });
});

describe("parseCapture", () => {
  // U+FF61 and U+1F600: UTF-16 puts the surrogate pair of U+1F600 first; UTF-8 puts U+FF61 first.
  const low = "\u{FF61}";
  const high = "\u{1F600}";
  const stored = (members: readonly string[], anchors: readonly string[] = ["plant:a"]) => ({
    history: "h",
    revision: 3,
    anchors: anchors.map((entity) => ({ kind: "entity", entity })),
    members,
    since: null,
    expiresAt: null,
  });

  it("accepts lists in UTF-8 order, which is not UTF-16 order", () => {
    expect([low, high].sort()).toEqual([high, low]);
    const capture = parseCapture(stored([low, high], [low, high]));
    expect(capture.members).toEqual([low, high]);
    const records: ChangeRecord[] = [{ revision: 4, head: null, added: [], removed: [high] }];
    expect(touching(capture, records, new Map())).toEqual({
      revision: 4,
      id: high,
      reason: "removed-member",
    });
  });

  it("refuses lists in UTF-16 order, shuffled, or repeated, and never answers for them", () => {
    for (const members of [
      [high, low],
      ["b", "a", "c"],
      ["a", "a"],
    ])
      expect(() => parseCapture(stored(members))).toThrow(/strictly ascending by UTF-8/);
    expect(() => parseCapture(stored(["a"], ["plant:b", "plant:a"]))).toThrow(/anchors/);
  });

  it("refuses a malformed window, a missing history and another shape", () => {
    expect(() => parseCapture({ ...stored([]), since: 5, expiresAt: 5 })).toThrow(/before/);
    expect(() => parseCapture({ ...stored([]), history: "" })).toThrow(/history/);
    expect(() => parseCapture({ ...stored([]), extra: 1 })).toThrow(/keys/);
    expect(() => parseCapture({ ...stored([]), revision: -1 })).toThrow(/revision/);
  });

  it("round-trips a capture through JSON when its history is not local to the process", async () => {
    const w = await writer({ mintHistory: () => "host:7f3a" });
    await w.append([fact("plant:a", 1), fact("plant:a", 2, { until: 9 })]);
    const capture = await w.capture(["plant:a"], 3);
    expect(parseCapture(JSON.parse(JSON.stringify(capture)))).toEqual(capture);
  });
});

describe("a capture is built, checked and frozen", () => {
  const snap = { history: "host:1", revision: 2 };
  const anchors = [{ kind: "entity" as const, entity: "plant:a" }];
  const open = { since: null, expiresAt: null };

  it("makeCapture refuses what parseCapture refuses", () => {
    const refusals: [Parameters<typeof makeCapture>, RegExp][] = [
      [[snap, anchors, ["b", "a"], open], /members is not strictly ascending/],
      [[snap, anchors, ["a", "a"], open], /members is not strictly ascending/],
      [[snap, [...anchors, { kind: "entity", entity: "plant:0" }], [], open], /anchors/],
      [[{ history: "", revision: 2 }, anchors, [], open], /history/],
      [[{ history: "h", revision: -1 }, anchors, [], open], /revision/],
      [[{ history: "h", revision: 0.5 }, anchors, [], open], /revision/],
      [[snap, anchors, [], { since: Number.NaN, expiresAt: null }], /since/],
      [[snap, anchors, [], { since: 5, expiresAt: 5 }], /before/],
    ];
    for (const [args, why] of refusals)
      expect(() => makeCapture(...args), String(why)).toThrow(why);
  });

  it("touching and checkFresh refuse a capture neither constructor built", async () => {
    const w = await writer();
    await w.append([fact("plant:a", 1)]);
    const capture = await w.capture(["plant:a"]);
    const copies: unknown[] = [
      { ...capture },
      { ...capture, members: [...capture.members].reverse() },
      JSON.parse(JSON.stringify(capture)),
      {
        history: capture.history,
        revision: capture.revision,
        anchors: capture.anchors,
        members: capture.members,
        since: capture.since,
        expiresAt: capture.expiresAt,
      },
    ];
    for (const copy of copies) {
      expect(() => touching(copy as Capture, [], new Map())).toThrow(/not built by makeCapture/);
      await expect(checkFresh(w.peer, copy as Capture, 0)).rejects.toMatchObject({
        code: "invalid-request",
      });
    }
    expect(await checkFresh(w.peer, capture, 0)).toEqual({ status: "current" });
  });

  it("a capture and its lists cannot be changed after it is built", async () => {
    const w = await writer();
    await w.append([fact("plant:a", 1)]);
    const capture = await w.capture(["plant:a"]);
    const writable = capture as unknown as { revision: number; members: string[] };
    expect(() => (writable.revision = 9)).toThrow(TypeError);
    expect(() => writable.members.push("x")).toThrow(TypeError);
    expect(Object.isFrozen(capture.anchors[0])).toBe(true);
  });

  it("a capture with a history local to its process does not cross a process", async () => {
    // Process A: a default memory store, and a capture serialized as JSON.
    const a = await writer();
    await a.append([fact("plant:a", 1)]);
    const stored = JSON.stringify(await a.capture(["plant:a"]));
    expect(JSON.parse(stored).history).toMatch(/^memory:local:/);
    // Process B would hold another store whose peer may have the same local history. The
    // capture is refused before it can be judged against it.
    expect(() => parseCapture(JSON.parse(stored))).toThrow(/local to the process.*mintHistory/);
  });

  it("a minted history must not take the local prefix", async () => {
    await expect(
      createMemoryStore({ mintHistory: () => "memory:local:1" }).createPeer(PEER, {
        erasure: "unproven",
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
  });
});

describe("history", () => {
  it("every handle and snapshot of a peer report its history; other peers differ", async () => {
    const store = createMemoryStore();
    const a = await store.createPeer(PEER, { erasure: "unproven" });
    const again = await store.peer(PEER);
    const snapshot = await again.read();
    expect(again.history).toBe(a.history);
    expect(snapshot.history).toBe(a.history);
    snapshot.release();
    const b = await store.createPeer(`ed25519:${"0e".repeat(32)}`, { erasure: "unproven" });
    expect(b.history).not.toBe(a.history);
  });

  it("one name created anew, in another store, has another history", async () => {
    const first = await createMemoryStore().createPeer(PEER, { erasure: "unproven" });
    const second = await createMemoryStore().createPeer(PEER, { erasure: "unproven" });
    expect(second.history).not.toBe(first.history);
  });

  it("a host mints histories its own way; a mint that answers no string is refused", async () => {
    const minted = await createMemoryStore({ mintHistory: (peer) => `host:${peer}` }).createPeer(
      PEER,
      { erasure: "unproven" },
    );
    expect(minted.history).toBe(`host:${PEER}`);
    await expect(
      createMemoryStore({ mintHistory: () => "" }).createPeer(PEER, { erasure: "unproven" }),
    ).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("a capture checked against another history answers resync-required, with no feed call", async () => {
    const w = await writer();
    await w.append([fact("plant:a", 1)]);
    const capture = await w.capture(["plant:a"]);
    // A store restored from elsewhere: same name, same revision, another history.
    const other = await writer();
    await other.append([fact("plant:a", 1)]);
    const calls: string[] = [];
    const verdict = await checkFresh(
      { ...other.peer, changes: (f, t) => (calls.push("changes"), other.peer.changes(f, t)) },
      capture,
      0,
    );
    expect(verdict).toEqual({ status: "resync-required", current: 1 });
    expect(calls).toEqual([]);
  });
});

describe("checkFresh", () => {
  it("refuses a now that is not finite, before any store call", async () => {
    const w = await writer();
    const capture = await w.capture(["plant:a"]);
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY])
      await expect(checkFresh(w.peer, capture, now)).rejects.toMatchObject({
        code: "invalid-request",
      });
  });

  it("answers resync-required for a capture from a later revision, with no feed call", async () => {
    const w = await writer();
    await w.append([fact("plant:a", 1)]);
    const right = await w.capture(["plant:a"]);
    const capture = makeCapture(
      { history: right.history, revision: 9 },
      right.anchors,
      right.members,
      right,
    );
    const calls: string[] = [];
    const verdict = await checkFresh(
      { ...w.peer, changes: (from, to) => (calls.push("changes"), w.peer.changes(from, to)) },
      capture,
      0,
    );
    expect(verdict).toEqual({ status: "resync-required", current: 1 });
    expect(calls).toEqual([]);
  });

  it("starts again on a new snapshot when the peer moves during the check", async () => {
    const w = await writer();
    const a = fact("plant:a", 1);
    await w.append([a]);
    const capture = await w.capture(["plant:a"]);
    await w.append([fact("plant:b", 2)]);
    let moved = false;
    const trace: StoreCall[] = [];
    const peer: PeerStore = {
      ...w.peer,
      read: async () => {
        trace.push({ op: "read", keyCount: 0, excludeCount: 0 });
        return countingSnapshot(await w.peer.read(), trace);
      },
      changes: async (from, to) => {
        const page = await w.peer.changes(from, to);
        if (!moved) {
          moved = true;
          await w.append([fact("plant:a", 3)]);
        }
        return page;
      },
    };
    const verdict = await checkFresh(peer, capture, 0);
    // The first snapshot refuses its `get`; the second sees the toucher at revision 3.
    expect(verdict).toMatchObject({ status: "stale", touch: { revision: 3 } });
    expect(trace.map((c) => c.op)).toEqual(["read", "get", "release", "read", "get", "release"]);
  });

  it("passes snapshot-moved up after four snapshots", async () => {
    const w = await writer();
    await w.append([fact("plant:a", 1)]);
    const capture = await w.capture(["plant:a"]);
    let t = 10;
    const peer: PeerStore = {
      ...w.peer,
      changes: async (from, to) => {
        const page = await w.peer.changes(from, to);
        await w.append([fact("plant:z", t++)]);
        return page;
      },
    };
    await w.append([fact("plant:b", 2)]);
    await expect(checkFresh(peer, capture, 0)).rejects.toMatchObject({ code: "snapshot-moved" });
    expect(t).toBe(14);
  });

  it("stops at the first page that touches", async () => {
    const w = await writer({ changePageSize: 1 });
    await w.append([fact("plant:a", 1)]);
    const capture = await w.capture(["plant:a"]);
    await w.append([fact("plant:a", 2)]);
    for (let i = 0; i < 5; i++) await w.append([fact("plant:b", 10 + i)]);
    const asked: number[] = [];
    const verdict = await checkFresh(
      { ...w.peer, changes: (from, to) => (asked.push(from), w.peer.changes(from, to)) },
      capture,
      0,
    );
    expect(verdict).toMatchObject({ status: "stale", touch: { revision: 2 } });
    expect(asked).toEqual([1]);
  });
});

// ---- captures from reads ----------------------------------------------------------------------

describe("a read's capture and expiry", () => {
  const rounds = roundVectors();
  const registry = SchemaRegistry.build(
    rounds.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
  );
  const deltaOf = new Map(
    rounds.deltas.map((d) => [d.name, { id: d.id, claims: parseClaims(d.claims) } as Delta]),
  );
  const loadRounds = async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(rounds.load.peer, { erasure: rounds.load.erasure });
    const held: VerifiedDelta[] = [];
    for (const admission of rounds.load.admissions) {
      const added = admission.added.map(({ delta, arrival }) => ({
        delta: deltaOf.get(delta)!,
        arrival: { id: deltaOf.get(delta)!.id, ...arrival },
      }));
      await peer.append({
        expectedHead: admission.expectedHead,
        nextHead: admission.nextHead,
        frame: null,
        added,
      });
      held.push(...added);
    }
    return { peer, held };
  };
  const requestOf = (c: (typeof rounds.cases)[number], now: number): StoreReadRequest => {
    const pushdown: Pushdown = {
      ...c.selection,
      ...(c.selection.excludeIds === undefined
        ? {}
        : { excludeIds: c.selection.excludeIds.map((n) => deltaOf.get(n)!.id) }),
    };
    return {
      term: parseTerm(c.term),
      root: c.root,
      now,
      registry,
      ...(c.bindings === undefined ? {} : { bindings: new Map(Object.entries(c.bindings)) }),
      ...(Object.keys(pushdown).length === 0 ? {} : { pushdown }),
      capture: true,
    };
  };

  // At now = 55 several members of the fixture start or end later: the expiry is not null.
  for (const now of [55, 100])
    it(`every round case at now ${now}: expiry over the members, capture over the raw scope`, async () => {
      const { peer, held } = await loadRounds();
      const reactor = StoreReactor.open(peer);
      let nonNull = 0;
      for (const c of rounds.cases) {
        const request = requestOf(c, now);
        const read = await reactor.read(request);
        const selection = request.pushdown ?? {};
        const admitted = held.filter((e) => passesSelection(e, selection, PUSHDOWN_FIELDS));
        const members = new Set(scopeOver(admitted, read.scope));
        expect([...read.members].sort(compareUtf8), c.name).toEqual([...members].sort(compareUtf8));
        const operand = admitted.filter((e) => members.has(e.delta.id)).map((e) => e.delta);
        const expected = validityWindow(operand, now);
        expect({ since: read.since, expiresAt: read.expiresAt }, c.name).toEqual(expected);
        if (expected.expiresAt !== null && expected.since !== null) nonNull += 1;
        // The capture: the raw scope of the read's anchors, whatever the selection.
        expect(read.capture, c.name).toEqual({
          history: peer.history,
          revision: read.revision,
          anchors: read.scope.map((entity) => ({ kind: "entity", entity })),
          members: scopeOver(held, read.scope),
          ...expected,
        });
        // The claim of the window: at every time inside it the read answers the same bytes; at
        // each bound outside it some delta of the operand changes validity.
        const valid = (t: number) =>
          operand
            .filter(
              (d) =>
                d.claims.validFrom <= t &&
                (d.claims.validUntil === undefined || t < d.claims.validUntil),
            )
            .map((d) => d.id);
        const lo = expected.since ?? now - 50;
        const hi = expected.expiresAt ?? now + 50;
        for (const t of [lo, (lo + hi) / 2, hi - 1e-6]) {
          const again = await reactor.read({ ...request, now: t, capture: false });
          expect(resultCanonicalHex(again.result), `${c.name} at ${t}`).toBe(
            resultCanonicalHex(read.result),
          );
        }
        if (expected.since !== null)
          expect(valid(expected.since - 1e-6), c.name).not.toEqual(valid(now));
        if (expected.expiresAt !== null)
          expect(valid(expected.expiresAt), c.name).not.toEqual(valid(now));
        // The same capture taken beside a fetched scope.
        const snapshot = await peer.read();
        const beside = await captureScope(snapshot, read.scope, now, { pushdown: selection });
        snapshot.release();
        expect(beside, c.name).toEqual(read.capture);
      }
      if (now === 55) expect(nonNull).toBeGreaterThan(0);
    });

  // Wrong readers against the shared round vectors alone: each fails the fields `since`,
  // `expiresAt` and `rawMembers` of rounds.json (vectors/store/README.md §5.4).
  const committedRounds = JSON.parse(
    readFileSync(resolve(here, "../../../vectors/store/rounds.json"), "utf8"),
  ) as typeof rounds;
  const nameOfId = new Map(rounds.deltas.map((d) => [d.id, d.name]));
  async function roundFailures(
    wrongRead: (read: StoreRead, snapshot: Snapshot) => Promise<StoreRead>,
  ): Promise<string[]> {
    const { peer } = await loadRounds();
    const failed: string[] = [];
    for (const c of committedRounds.cases) {
      const snapshot = await peer.read();
      const read = await wrongRead(await readAnchored(snapshot, requestOf(c, c.now)), snapshot);
      snapshot.release();
      const got = {
        since: read.since,
        expiresAt: read.expiresAt,
        rawMembers: (read.capture?.members ?? []).map((id) => nameOfId.get(id)),
      };
      const { since, expiresAt, rawMembers } = c.expect;
      if (JSON.stringify(got) !== JSON.stringify({ since, expiresAt, rawMembers }))
        failed.push(c.name);
    }
    return failed;
  }
  it("the standard read passes the window and the raw members of every round case", async () => {
    expect(await roundFailures(async (read) => read)).toEqual([]);
  });
  const ROUND_READERS: readonly {
    name: string;
    wrongRead: (read: StoreRead, snapshot: Snapshot) => Promise<StoreRead>;
    fails: string;
  }[] = [
    {
      name: "a window that is always open",
      wrongRead: async (read) => ({ ...read, since: null, expiresAt: null }),
      fails: "the-whole-garden-at-55",
    },
    {
      name: "a capture whose members are the read's members",
      wrongRead: async (read) => ({
        ...read,
        capture: makeCapture(read.capture!, read.capture!.anchors, read.members, read.capture!),
      }),
      fails: "signed-time-cuts-a-link-and-a-strike",
    },
    {
      name: "a capture over the first round's anchors only",
      wrongRead: async (read, snapshot) => {
        const anchors = read.rounds[0]!.anchors.map((entity) => ({
          kind: "entity" as const,
          entity,
        }));
        return {
          ...read,
          capture: makeCapture(
            read.capture!,
            read.capture!.anchors,
            await rawScope(snapshot, anchors),
            read.capture!,
          ),
        };
      },
      fails: "the-whole-garden",
    },
  ];
  for (const reader of ROUND_READERS)
    it(`round vectors catch a wrong reader: ${reader.name}`, async () => {
      expect(await roundFailures(reader.wrongRead)).toContain(reader.fails);
    });

  it("a read with nothing pushed down captures with no further store call", async () => {
    const { peer } = await loadRounds();
    const c = rounds.cases.find((x) => x.name === "the-whole-garden")!;
    for (const [request, extra] of [
      [requestOf(c, 100), []],
      [{ ...requestOf(c, 100), pushdown: { timestampAtMost: 60 } }, ["targets", "negators"]],
    ] as const) {
      const trace: StoreCall[] = [];
      const snapshot = countingSnapshot(await peer.read(), trace);
      const read = await readAnchored(snapshot, request);
      snapshot.release();
      const ops = trace.map((t) => t.op);
      expect(ops.slice(0, read.rounds.length)).toEqual(read.rounds.map(() => "scope"));
      expect(
        ops.slice(read.rounds.length, -1).filter((op, i, all) => all.indexOf(op) === i),
      ).toEqual(extra);
    }
  });

  it("a read without the flag carries no capture and makes no extra call", async () => {
    const { peer } = await loadRounds();
    const c = rounds.cases.find((x) => x.name === "every-field")!;
    const request = { ...requestOf(c, 100), capture: false };
    const trace: StoreCall[] = [];
    const snapshot = countingSnapshot(await peer.read(), trace);
    const read = await readAnchored(snapshot, request);
    snapshot.release();
    expect(read.capture).toBeUndefined();
    expect(trace.map((t) => t.op)).toEqual([...read.rounds.map(() => "scope"), "release"]);
  });

  it("a touch through an expanded child: the capture of a read holds its dynamic anchors", async () => {
    const { peer } = await loadRounds();
    const c = rounds.cases.find((x) => x.name === "the-whole-garden")!;
    const reactor = StoreReactor.open(peer);
    const read = await reactor.read(requestOf(c, 100));
    expect(read.capture!.anchors.map((a) => a.entity)).toContain("seed:1");
    // A new fact about seed:1, which only the fourth round reached.
    const late = makeDelta({
      timestamp: 99,
      validFrom: 99,
      author: "did:key:zAlice",
      pointers: [at("seed:1", "subject")],
    });
    const snapshot = await peer.read();
    const head = snapshot.head;
    snapshot.release();
    await peer.append({
      expectedHead: head,
      nextHead: "late",
      frame: null,
      added: [
        { delta: late, arrival: { id: late.id, at: 1, sequence: 999, transfer: 9, sender: "x" } },
      ],
    });
    expect(await checkFresh(peer, read.capture!, 100)).toMatchObject({
      status: "stale",
      touch: { id: late.id, reason: "targets-anchor" },
    });
  });

  it("a fetched scope answers its window for any now", async () => {
    const w = await writer();
    const a = fact("plant:a", 10, { until: 50 });
    const b = fact("plant:a", 20, { from: 30 });
    const outside = fact("plant:b", 5, { until: 25 });
    await w.append([a, b, outside]);
    const fetched = await StoreReactor.open(w.peer).fetch(["plant:a"]);
    expect([0, 10, 25, 30, 49, 50].map((now) => fetched.validityAt(now))).toEqual([
      { since: null, expiresAt: 10 },
      { since: 10, expiresAt: 30 },
      { since: 10, expiresAt: 30 },
      { since: 30, expiresAt: 50 },
      { since: 30, expiresAt: 50 },
      { since: 50, expiresAt: null },
    ]);
  });
});

// ---- fuzz against brute force -----------------------------------------------------------------

/** mulberry32: a small deterministic generator. */
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

/** One random sequence; answers what it checked. */
async function fuzzOne(seed: number): Promise<{ verdict: Freshness["status"]; exact: boolean }> {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const entities = ["e0", "e1", "e2", "e3", "e4"];
  // A corpus: facts at random entities, and negations at random depth.
  const corpus: Delta[] = [];
  for (let i = 0; i < 14; i++) {
    if (corpus.length > 0 && next() < 0.35) {
      // A chain of three or four negations: a raw scope that stops after one layer misses it.
      let link = pick(corpus);
      for (let depth = 3 + Math.floor(next() * 2); depth > 0; depth--) {
        link = makeDelta({
          ...makeNegationClaims("did:key:zB", i, link.id),
          ...(next() < 0.3 ? { validFrom: i, validUntil: 50 + Math.floor(next() * 30) } : {}),
        });
        corpus.push(link);
      }
    } else if (corpus.length > 0 && next() < 0.3) corpus.push(strike(pick(corpus), i));
    else {
      const claims: Claims = {
        timestamp: i,
        validFrom: next() < 0.2 ? 40 + Math.floor(next() * 20) : i,
        ...(next() < 0.2 ? { validUntil: 60 + Math.floor(next() * 20) } : {}),
        author: "did:key:zA",
        pointers: [
          at(pick(entities)),
          ...(next() < 0.3 ? [at(pick(entities), "also")] : []),
          { role: "value", target: { kind: "primitive", value: i } },
        ],
      };
      corpus.push(makeDelta(claims));
    }
  }
  const w = await writer(next() < 0.5 ? {} : { changePageSize: 1 + Math.floor(next() * 3) });
  const commit = async (): Promise<void> => {
    const r = next();
    if (r < 0.15) await w.append([]);
    else if (r < 0.7) await w.append(corpus.filter(() => next() < 0.25));
    else await w.purge([...w.held.keys()].filter(() => next() < 0.3));
  };
  for (let i = Math.floor(next() * 4); i > 0; i--) await commit();
  const anchors = entities.filter(() => next() < 0.35);
  if (anchors.length === 0) anchors.push(pick(entities));
  // Half the time, a whole chain of three or four negations of a fact at an anchor is held when
  // the capture is taken: the deep members a one-layer raw scope would miss.
  if (next() < 0.5) {
    let link = fact(pick(anchors), 200 + Math.floor(next() * 50));
    const chain = [link];
    for (let depth = 3 + Math.floor(next() * 2); depth > 0; depth--) {
      link = strike(link, 300 + depth);
      chain.push(link);
    }
    await w.append(chain);
    corpus.push(...chain);
  }
  const selection: Pushdown = {
    ...(next() < 0.2 ? { timestampAtMost: Math.floor(next() * 14) } : {}),
    ...(next() < 0.1 ? { arrivalAtMost: Math.floor(next() * 20) } : {}),
    ...(next() < 0.1 ? { excludeIds: [...w.held.keys()].filter(() => next() < 0.3) } : {}),
  };
  const now = Math.floor(next() * 50);
  const before = new Map(w.held);
  const capture = await w.capture(anchors, now, selection);

  // The capture: raw members by scanning, expiry over the selected scope.
  const raw = scopeOver([...before.values()], anchors);
  expect(capture.members, `seed ${seed}`).toEqual(raw);
  // The id-only raw scope too, every time: a capture with no selection does not need it.
  const snapshot = await w.peer.read();
  expect(
    await rawScope(
      snapshot,
      anchors.map((entity) => ({ kind: "entity" as const, entity })),
    ),
    `seed ${seed}: rawScope`,
  ).toEqual(raw);
  snapshot.release();
  const selected = (held: Map<string, VerifiedDelta>) =>
    scopeOver(
      [...held.values()].filter((e) => passesSelection(e, selection, PUSHDOWN_FIELDS)),
      anchors,
    );
  const operand = new Set(selected(before));
  const operandDeltas = [...before.values()]
    .filter((e) => operand.has(e.delta.id))
    .map((e) => e.delta);
  // The window, by scanning: the last boundary at or before now, the first after it.
  const boundaries = operandDeltas.flatMap((d) =>
    d.claims.validUntil === undefined
      ? [d.claims.validFrom]
      : [d.claims.validFrom, d.claims.validUntil],
  );
  const since = boundaries
    .filter((b) => b <= now)
    .reduce<number | null>((m, b) => (m === null || b > m ? b : m), null);
  const expiresAt = boundaries
    .filter((b) => b > now)
    .reduce<number | null>((m, b) => (m === null || b < m ? b : m), null);
  expect({ since: capture.since, expiresAt: capture.expiresAt }, `seed ${seed}`).toEqual({
    since,
    expiresAt,
  });
  // Inside the window no operand delta changes validity; just outside, one does.
  const validAt = (t: number) =>
    operandDeltas
      .filter(
        (d) =>
          d.claims.validFrom <= t && (d.claims.validUntil === undefined || t < d.claims.validUntil),
      )
      .map((d) => d.id)
      .join();
  const lo = since ?? now - 100;
  const hi = expiresAt ?? now + 100;
  const inside = lo + next() * (hi - lo);
  expect(validAt(inside), `seed ${seed}: inside the window`).toBe(validAt(now));
  if (since !== null)
    expect(validAt(since - 0.5), `seed ${seed}: below since`).not.toBe(validAt(now));
  if (expiresAt !== null)
    expect(validAt(expiresAt), `seed ${seed}: at expiresAt`).not.toBe(validAt(now));

  const removedMembers = new Set<string>();
  for (let i = 1 + Math.floor(next() * 5); i > 0; i--) {
    const held = new Set(w.held.keys());
    await commit();
    for (const id of held) if (!w.held.has(id) && raw.includes(id)) removedMembers.add(id);
  }
  // Checked at a time inside the window: the answer is about the feed alone.
  const verdict = await checkFresh(w.peer, capture, inside);
  const after = scopeOver([...w.held.values()], anchors);
  const unchanged =
    after.length === raw.length &&
    after.every(
      (id, i) =>
        id === raw[i] && w.held.get(id)!.arrival.sequence === before.get(id)!.arrival.sequence,
    ) &&
    removedMembers.size === 0;
  const exact = Object.keys(selection).length === 0;
  if (verdict.status === "current") {
    // Never a false current, with or without a selection.
    expect(unchanged, `seed ${seed}: current, and the raw scope changed`).toBe(true);
    expect(selected(w.held), `seed ${seed}`).toEqual([...operand].sort(compareUtf8));
  } else {
    if (verdict.status !== "stale") throw new Error(`seed ${seed}: ${verdict.status}`);
    // Stale only when the raw scope changed, with or without a selection.
    expect(unchanged, `seed ${seed}: stale, and the raw scope did not change`).toBe(false);
    // The touch is the first one, by a plain scan of every record since the capture.
    const records: ChangeRecord[] = [];
    for (let from = capture.revision; ; ) {
      const page = await w.peer.changes(from);
      if (page.status !== "ok") throw new Error("the fuzz store keeps every record");
      records.push(...page.records);
      if (page.through === from || page.records.length === 0) break;
      from = page.through;
    }
    let first: { revision: number; id: string; reason: string } | undefined;
    for (const record of records) {
      for (const id of record.removed)
        if (first === undefined && raw.includes(id))
          first = { revision: record.revision, id, reason: "removed-member" };
      for (const id of record.added) {
        const delta = w.held.get(id)?.delta;
        if (first !== undefined || delta === undefined) continue;
        const points = delta.claims.pointers;
        if (points.some((p) => p.target.kind === "entity" && anchors.includes(p.target.entity.id)))
          first = { revision: record.revision, id, reason: "targets-anchor" };
        else if (
          points.some(
            (p) =>
              p.role === "negates" &&
              p.target.kind === "delta" &&
              raw.includes(p.target.deltaRef.delta),
          )
        )
          first = { revision: record.revision, id, reason: "negates-member" };
      }
    }
    expect(verdict.touch, `seed ${seed}`).toEqual(first);
  }
  await w.store.close();
  return { verdict: verdict.status, exact };
}

const FUZZ = Number(process.env["FRESHNESS_FUZZ"] ?? 2000);

describe("checkFresh against brute force", () => {
  it(`${FUZZ} random sequences: exact without a selection, sound with one`, async () => {
    const seen = { current: 0, stale: 0 };
    for (let seed = 1; seed <= FUZZ; seed++) {
      const { verdict } = await fuzzOne(seed);
      if (verdict === "current" || verdict === "stale") seen[verdict] += 1;
    }
    console.log(`freshness fuzz: ${FUZZ} sequences, ${seen.current} current, ${seen.stale} stale`);
    // Both answers occur often enough to mean something.
    expect(seen.current).toBeGreaterThan(FUZZ / 10);
    expect(seen.stale).toBeGreaterThan(FUZZ / 10);
  }, 600_000);
});

// ---- the cost rails ---------------------------------------------------------------------------

describe("cost rail: a check costs the changes since its capture", () => {
  // Timed from outside with a monotonic clock, as vectors/store/README.md §3.9.9: N calls at N
  // and at 8N, the run at N the fastest of five, at 8N the fastest of three, stopped at the
  // first under the bound. Each call costs the same at N and 8N when the check reads only the
  // records since its capture: the total scales by about 8. A check that walks the holdings or
  // the earlier records costs N per call: the total scales by about 64.
  const BOUND = 24;
  const SINCE = 16;

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

  /** N calls of `checkFresh` on a capture with SINCE unrelated records after it. */
  const timed = (peer: PeerStore, capture: Capture, n: number) => async () => {
    const start = performance.now();
    for (let i = 0; i < n; i++) {
      const verdict = await checkFresh(peer, capture, 0);
      if (verdict.status !== "current") throw new Error(verdict.status);
    }
    return performance.now() - start;
  };
  const since = async (w: Awaited<ReturnType<typeof writer>>) => {
    for (let i = 0; i < SINCE; i++) await w.append([fact("other", 1_000_000 + i)]);
  };

  it(`N holdings: N checks cost less than ${BOUND} times at 8N`, async () => {
    await scaling("checkFresh beside N holdings", async (n) => {
      const w = await writer();
      await w.append(Array.from({ length: n }, (_, i) => fact(`bulk:${i}`, i)));
      await w.append([fact("plant:a", -1)]);
      const capture = await w.capture(["plant:a"]);
      await since(w);
      return timed(w.peer, capture, n);
    });
  }, 600_000);

  it(`N records before the capture: N checks cost less than ${BOUND} times at 8N`, async () => {
    await scaling("checkFresh after N earlier records", async (n) => {
      const w = await writer();
      await w.append([fact("plant:a", -1)]);
      for (let i = 0; i < n; i++) await w.append([]);
      const capture = await w.capture(["plant:a"]);
      await since(w);
      return timed(w.peer, capture, n);
    });
  }, 600_000);
});
