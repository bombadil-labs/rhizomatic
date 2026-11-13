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
  type StoreReadRequest,
} from "../src/reactor/store-read.js";
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
  nextBoundary,
  touching,
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
): Promise<readonly StoreConformanceFailure[]> {
  try {
    await runFreshnessConformance(factoryOf(fault), witness, document);
    return [];
  } catch (error) {
    if (error instanceof StoreConformanceError) return error.failures;
    throw error;
  }
}

// ---- the vectors ------------------------------------------------------------------------------

describe("freshness vectors", () => {
  it("the committed file is the model's output", () => {
    expect(committed).toBe(`${JSON.stringify(freshnessVectors(), null, 2)}\n`);
  });

  const runs: Readonly<Record<string, Break>> = {
    "as built": {},
    "pages of one record": { options: { changePageSize: 1 } },
    "two records kept": { options: { changeRetention: { revisions: 2 } } },
    "no pushdown field applied": {
      options: { pushdown: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false } },
    },
    "two records kept, pages of one record": {
      options: { changeRetention: { revisions: 2 }, changePageSize: 1 },
    },
    "revisions times 3, pages of one record": { options: { changePageSize: 1 }, ...sparse(3) },
    "revisions times 2, two records kept": {
      options: { changeRetention: { revisions: 2 } },
      ...sparse(2),
    },
  };
  for (const [name, fault] of Object.entries(runs))
    it(`pass on the memory store: ${name}`, async () => {
      const report = await runFreshnessConformance(factoryOf(fault), WITNESS, document);
      expect(report.skipped).toEqual([]);
      expect(report.passed).toHaveLength(document.cases.length + document.touching.length);
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
        return makeCapture(
          snapshot.revision,
          anchors,
          fetched.source.ids(),
          fetched.expiresAfter(now),
        );
      },
    }),
    fails: "freshness/a-selection-rejects-the-toucher",
    message: "the capture's members are",
  },
  {
    name: "ignores expiresAt",
    witness: wrong({ checkFresh: (peer, capture) => checkFresh(peer, capture) }),
    fails: "freshness/expiry",
    message: "checkFresh answered current, expected expired",
  },
  {
    name: "expiry over the raw scope",
    witness: wrong({
      capture: async (snapshot, anchors, pushdown, now) => {
        const right = await WITNESS.capture(snapshot, anchors, pushdown, now);
        const raw = await snapshot.get(right.members);
        return makeCapture(right.revision, right.anchors, right.members, nextBoundary(raw, now));
      },
    }),
    fails: "freshness/a-selection-rejects-the-toucher",
    message: "the capture expires at 105, expected 120",
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
    message: "the capture's anchors are [entity:plant:b entity:plant:a entity:plant:b]",
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
        return verdict.status === "expired" ? { ...verdict, expiresAt: now! } : verdict;
      },
    }),
    fails: "freshness/expiry",
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
    const capture = makeCapture(1, [{ kind: "entity", entity: "plant:a" }], [a.id], null);
    const records: ChangeRecord[] = [{ revision: 2, head: null, added: [a.id], removed: [] }];
    const before = JSON.stringify([capture, records]);
    touching(capture, records, new Map([[a.id, a]]));
    expect(JSON.stringify([capture, records])).toBe(before);
  });

  it("refuses a capture with an anchor kind it cannot read", () => {
    expect(() =>
      makeCapture(1, [{ kind: "value", entity: "x" } as unknown as never], [], null),
    ).toThrow(StoreError);
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
    const capture = { ...(await w.capture(["plant:a"])), revision: 9 };
    const calls: string[] = [];
    const verdict = await checkFresh(
      { ...w.peer, changes: (from, to) => (calls.push("changes"), w.peer.changes(from, to)) },
      capture,
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
    const verdict = await checkFresh(peer, capture);
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
    await expect(checkFresh(peer, capture)).rejects.toMatchObject({ code: "snapshot-moved" });
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
        const expected = nextBoundary(
          admitted.filter((e) => members.has(e.delta.id)).map((e) => e.delta),
          now,
        );
        expect(read.expiresAt, c.name).toBe(expected);
        if (expected !== null) nonNull += 1;
        // The capture: the raw scope of the read's anchors, whatever the selection.
        expect(read.capture, c.name).toEqual({
          revision: read.revision,
          anchors: read.scope.map((entity) => ({ kind: "entity", entity })),
          members: scopeOver(held, read.scope),
          expiresAt: expected,
        });
        // The same capture taken beside a fetched scope.
        const snapshot = await peer.read();
        const beside = await captureScope(snapshot, read.scope, now, { pushdown: selection });
        snapshot.release();
        expect(beside, c.name).toEqual(read.capture);
      }
      if (now === 55) expect(nonNull).toBeGreaterThan(0);
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
    expect(await checkFresh(peer, read.capture!)).toMatchObject({
      status: "stale",
      touch: { id: late.id, reason: "targets-anchor" },
    });
  });

  it("a fetched scope answers its next boundary for any now", async () => {
    const w = await writer();
    const a = fact("plant:a", 10, { until: 50 });
    const b = fact("plant:a", 20, { from: 30 });
    const outside = fact("plant:b", 5, { until: 25 });
    await w.append([a, b, outside]);
    const fetched = await StoreReactor.open(w.peer).fetch(["plant:a"]);
    expect([0, 10, 25, 30, 49, 50].map((now) => fetched.expiresAfter(now))).toEqual([
      10,
      30,
      30,
      50,
      50,
      null,
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
    if (corpus.length > 0 && next() < 0.4) corpus.push(strike(pick(corpus), i));
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
  const selected = (held: Map<string, VerifiedDelta>) =>
    scopeOver(
      [...held.values()].filter((e) => passesSelection(e, selection, PUSHDOWN_FIELDS)),
      anchors,
    );
  const operand = new Set(selected(before));
  expect(capture.expiresAt, `seed ${seed}`).toBe(
    nextBoundary(
      [...before.values()].filter((e) => operand.has(e.delta.id)).map((e) => e.delta),
      now,
    ),
  );

  const removedMembers = new Set<string>();
  for (let i = 1 + Math.floor(next() * 5); i > 0; i--) {
    const held = new Set(w.held.keys());
    await commit();
    for (const id of held) if (!w.held.has(id) && raw.includes(id)) removedMembers.add(id);
  }
  const verdict = await checkFresh(w.peer, capture);
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
      const verdict = await checkFresh(peer, capture);
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
