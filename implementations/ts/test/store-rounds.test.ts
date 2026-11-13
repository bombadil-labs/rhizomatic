// The round vectors (vectors/store/rounds.json, SPEC-18 proposal §4.4 and §8) against the
// store-backed read. Each case is read several ways over one loaded peer and every way must give
// the vector's bytes, scope and members. The expectations come from a list-scanning model
// (tools/store-round-vectors.ts), never from the code under test.
//
// Modes here: the whole surface through the exporter; rounds with no fetch cache; rounds with
// the fetch cache; each of the two with the evaluation memo.
//
// Not covered here: the scope bounds of a store (store-vectors.test.ts) and the existing read
// families run through the store (a later step of slice 2).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareUtf8 } from "../src/delta/cbor.js";
import { parseClaims } from "../src/delta/json-profile.js";
import { DeltaSet, makeDelta, makeNegationClaims } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import {
  CACHED_ROUNDS,
  STANDARD_ROUNDS,
  StoreReactor,
  UNCACHED_ROUNDS,
  UnanchoredTermError,
  fetchScope,
  finalChildMemo,
  readAnchored,
  readAnchoredWith,
  readFullSurface,
  unappliedFields,
  type ReadMemo,
  type RoundPolicy,
  type StoreAdmits,
  type StoreRead,
  type StoreReadRequest,
  type StoreRoundReport,
} from "../src/reactor/store-read.js";
import { anchorAnalysis, hviewAnchors } from "../src/resolve/anchored.js";
import type { HView } from "../src/algebra/hview.js";
import {
  evalTerm,
  evalTermWithHooks,
  resultCanonicalHex,
  type ChildMemo,
  type EvalResult,
} from "../src/resolve/eval.js";
import { EvaluationBudget } from "../src/resolve/evaluation-budget.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import { createFetchCache } from "../src/storage/fetch-cache.js";
import { nextBoundary } from "../src/storage/freshness.js";
import { createMemoryStore, type StoreMeter } from "../src/storage/memory-store.js";
import {
  PUSHDOWN_FIELDS,
  passesSelection,
  scopeOver,
  type PushdownField,
} from "../src/storage/store-vector-format.js";
import {
  StoreError,
  collectDeltaSet,
  type PeerExporter,
  type PeerStore,
  type Pushdown,
  type Snapshot,
  type Store,
  type VerifiedDelta,
} from "../src/storage/store.js";
import type { SchemaRefT, Term } from "../src/syntax/model.js";
import type { Bindings } from "../src/syntax/pred.js";
import { parseTerm } from "../src/syntax/term-json.js";
import {
  roundVectors,
  type RoundsAdmission,
  type RoundsAnswer,
  type RoundsRead,
  type StoreRoundsDocument,
} from "../tools/store-round-vectors.js";
import { countingPeer, countingSnapshot, type StoreCall } from "./support/store-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const document = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/store/rounds.json"), "utf8"),
) as StoreRoundsDocument;

const registry = SchemaRegistry.build(
  document.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);
const deltaOf = new Map<string, Delta>(
  document.deltas.map((d) => [d.name, { id: d.id, claims: parseClaims(d.claims) }]),
);
const nameOf = new Map(document.deltas.map((d) => [d.id, d.name]));
const idOf = (name: string): string => deltaOf.get(name)!.id;
const entriesOf = (admission: RoundsAdmission): VerifiedDelta[] =>
  admission.added.map(({ delta, arrival }) => ({
    delta: deltaOf.get(delta)!,
    arrival: { id: idOf(delta), ...arrival },
  }));
const admit = async (peer: PeerStore, admission: RoundsAdmission): Promise<void> => {
  const result = await peer.append({
    expectedHead: admission.expectedHead,
    nextHead: admission.nextHead,
    frame: null,
    added: entriesOf(admission),
  });
  expect(result.status).toBe("committed");
};

type Loaded = { store: Store; peer: PeerStore; meter: StoreMeter; held: VerifiedDelta[] };
type LoadOptions = { pushdown?: Partial<Record<PushdownField, boolean>>; extra?: Delta[] };

/** The fixture-load rule of vectors/store/README.md §5.2, on a new memory store. */
async function load(options: LoadOptions = {}): Promise<Loaded> {
  const meter: StoreMeter = { lookups: 0, visited: 0, scans: 0 };
  const store = createMemoryStore({
    meter,
    ...(options.pushdown === undefined ? {} : { pushdown: options.pushdown }),
  });
  const peer = await store.createPeer(document.load.peer, { erasure: document.load.erasure });
  const held: VerifiedDelta[] = [];
  let head: string | null = null;
  let sequence = 0;
  for (const admission of document.load.admissions) {
    await admit(peer, admission);
    held.push(...entriesOf(admission));
    head = admission.nextHead;
    sequence += admission.added.length;
  }
  // Deltas beside the fixture, for the cost rails. They arrive after it, under another head.
  if (options.extra !== undefined && options.extra.length > 0) {
    const added = options.extra.map((delta, i) => ({
      delta,
      arrival: { id: delta.id, at: 0, sequence: sequence + 1 + i, transfer: 9, sender: "crowd" },
    }));
    const result = await peer.append({
      expectedHead: head,
      nextHead: "crowd",
      frame: null,
      added,
    });
    expect(result.status).toBe("committed");
  }
  return { store, peer, meter, held };
}

const selectionOf = (read: RoundsRead): Pushdown => ({
  ...read.selection,
  ...(read.selection.excludeIds === undefined
    ? {}
    : { excludeIds: read.selection.excludeIds.map(idOf) }),
});
const requestOf = (read: RoundsRead, extra: Partial<StoreReadRequest> = {}): StoreReadRequest => {
  const pushdown = selectionOf(read);
  return {
    term: parseTerm(read.term),
    root: read.root,
    now: read.now,
    registry,
    ...(read.bindings === undefined ? {} : { bindings: new Map(Object.entries(read.bindings)) }),
    ...(Object.keys(pushdown).length === 0 ? {} : { pushdown }),
    ...extra,
  };
};

/** What a way of reading answered, in the vector's terms. `rounds` only where it ran rounds. */
type Answer = Omit<RoundsAnswer, "rounds"> & { rounds?: RoundsAnswer["rounds"] };
const answerOf = (read: StoreRead): Required<Answer> => ({
  canonicalHex: resultCanonicalHex(read.result),
  scope: [...read.scope],
  members: read.members.map((id) => nameOf.get(id) ?? id),
  expiresAt: read.expiresAt,
  rounds: read.rounds.map((round) => ({ anchors: [...round.anchors] })),
});
const unpinned = ({ canonicalHex, scope, members, expiresAt }: Answer): Answer => ({
  canonicalHex,
  scope,
  members,
  expiresAt,
});

async function onSnapshot<T>(peer: PeerStore, run: (snapshot: Snapshot) => Promise<T>): Promise<T> {
  const snapshot = await peer.read();
  try {
    return await run(snapshot);
  } finally {
    snapshot.release();
  }
}
const withPolicy = (peer: PeerStore, read: RoundsRead, policy: RoundPolicy): Promise<Answer> =>
  onSnapshot(peer, async (snapshot) =>
    answerOf(await readAnchoredWith(snapshot, requestOf(read), policy)),
  );

/** Every round asks for every anchor so far: the request of round i is the union of rounds 1..i. */
const cumulative = (rounds: RoundsAnswer["rounds"]): RoundsAnswer["rounds"] => {
  const seen: string[] = [];
  return rounds.map((round) => {
    seen.push(...round.anchors);
    return { anchors: [...seen].sort(compareUtf8) };
  });
};

type Mode = {
  readonly name: string;
  /** The round anchors this mode must show for a case, or undefined when it runs no rounds. */
  readonly rounds?: (expected: RoundsAnswer["rounds"]) => RoundsAnswer["rounds"];
  run(loaded: Loaded, read: RoundsRead): Promise<Answer>;
};

// The same read, each way. The memo modes join this list.
const MODES: readonly Mode[] = [
  {
    name: "whole surface through the exporter",
    run: async ({ store, held }, read) => {
      // The exporter lists deltas without arrivals; the arrival of each is the load's record.
      const arrivals = new Map(held.map((entry) => [entry.delta.id, entry.arrival]));
      const selection = selectionOf(read);
      const admitted: VerifiedDelta[] = [];
      for await (const delta of store.openAdmin().peer(document.load.peer).deltas()) {
        const entry = { delta, arrival: arrivals.get(delta.id)! };
        if (passesSelection(entry, selection, PUSHDOWN_FIELDS)) admitted.push(entry);
      }
      const request = requestOf(read);
      const whole = DeltaSet.from(admitted.map((entry) => entry.delta));
      const evaluate = (term: Term): EvalResult =>
        evalTerm(term, whole, request.now, request.root, registry, request.bindings);
      // The scope is the root, the static anchors and the anchors the whole-surface gather
      // shows; the members are the scope of those entities, found by scanning.
      const analysis = anchorAnalysis(request.term, registry, request.bindings);
      if (!analysis.anchored) throw new Error(`unanchored: ${analysis.reason}`);
      const gathered = evaluate(request.term.kind === "resolve" ? request.term.of : request.term);
      if (gathered.sort !== "hview") throw new Error("the gather is not an HView");
      const scope = [
        ...new Set([request.root, ...analysis.anchors, ...hviewAnchors(gathered.hview)]),
      ].sort(compareUtf8);
      const members = new Set(scopeOver(admitted, scope));
      return {
        canonicalHex: resultCanonicalHex(evaluate(request.term)),
        scope,
        members: scopeOver(admitted, scope).map((id) => nameOf.get(id)!),
        expiresAt: nextBoundary(
          admitted.filter((e) => members.has(e.delta.id)).map((e) => e.delta),
          request.now,
        ),
      };
    },
  },
  {
    name: "rounds with no fetch cache",
    rounds: cumulative,
    run: ({ peer }, read) => withPolicy(peer, read, UNCACHED_ROUNDS),
  },
  {
    name: "rounds with the fetch cache",
    rounds: (expected) => expected,
    run: ({ peer }, read) => withPolicy(peer, read, CACHED_ROUNDS),
  },
  {
    name: "rounds with the evaluation memo and no fetch cache",
    rounds: cumulative,
    run: ({ peer }, read) => withPolicy(peer, read, { ...UNCACHED_ROUNDS, memo: finalChildMemo }),
  },
  {
    name: "rounds with both caches",
    rounds: (expected) => expected,
    run: ({ peer }, read) => withPolicy(peer, read, STANDARD_ROUNDS),
  },
];

const FIELD_SUBSETS = PUSHDOWN_FIELDS.reduce<PushdownField[][]>(
  (all, field) => [...all, ...all.map((subset) => [...subset, field])],
  [[]],
);
const pushdownOf = (applied: readonly PushdownField[]): Record<PushdownField, boolean> => ({
  timestampAtMost: applied.includes("timestampAtMost"),
  arrivalAtMost: applied.includes("arrivalAtMost"),
  excludeIds: applied.includes("excludeIds"),
});
const pick = (name: string): StoreRoundsDocument["cases"][number] => {
  const found = document.cases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`the round vectors lost the case ${name}`);
  return found;
};

describe("round vectors: the document", () => {
  it("is what the model generates", () => {
    expect(JSON.parse(JSON.stringify(roundVectors()))).toEqual(document);
  });

  it("has the cases the rails below name", () => {
    expect(document.format).toBe("rhizomatic-store-rounds/1");
    expect(document.cases.length).toBeGreaterThanOrEqual(21);
    expect(document.interleaved.length).toBeGreaterThanOrEqual(4);
    expect(MODES).toHaveLength(5);
    expect(document.refusals.length).toBeGreaterThanOrEqual(5);
    expect(FIELD_SUBSETS).toHaveLength(8);
    expect(pick("the-whole-garden").expect.rounds).toHaveLength(4);
  });
});

describe("round vectors: one read, every way, every pushdown profile", () => {
  for (const applied of FIELD_SUBSETS) {
    it(`a store applying {${applied.join(", ")}}`, async () => {
      const loaded = await load({ pushdown: pushdownOf(applied) });
      for (const c of document.cases)
        for (const mode of MODES) {
          const label = `${c.name}: ${mode.name}`;
          const got = await mode.run(loaded, c);
          expect(unpinned(got), label).toEqual(unpinned(c.expect));
          if (mode.rounds !== undefined)
            expect(got.rounds, label).toEqual(mode.rounds(c.expect.rounds));
        }
    });
  }

  it("the selection as a host predicate the store never sees", async () => {
    // `admits` carries the whole selection and nothing is pushed down: the residual is all of it.
    const loaded = await load();
    for (const c of document.cases) {
      const selection = selectionOf(c);
      const admits: StoreAdmits = (delta, arrival) =>
        passesSelection({ delta, arrival }, selection, PUSHDOWN_FIELDS);
      const bare = requestOf({ ...c, selection: {} });
      const got = await onSnapshot(loaded.peer, async (snapshot) =>
        answerOf(await readAnchored(snapshot, { ...bare, admits })),
      );
      expect(got, c.name).toEqual(c.expect);
    }
  });

  it("StoreReactor.read answers each case on its own snapshot, at that revision", async () => {
    const loaded = await load();
    const trace: StoreCall[] = [];
    const reactor = StoreReactor.open(countingPeer(loaded.peer, trace));
    const revision = await onSnapshot(loaded.peer, async (snapshot) => snapshot.revision);
    for (const c of document.cases) {
      trace.length = 0;
      const hooked: StoreRoundReport[] = [];
      const read = await reactor.read(
        requestOf(c, { onRound: (round) => void hooked.push(round) }),
      );
      expect(answerOf(read), c.name).toEqual(c.expect);
      expect(read.revision, c.name).toBe(revision);
      expect(read.attempts, c.name).toBe(1);
      // The hook ran once per round, the last round included, with the read's own reports.
      expect(hooked, c.name).toEqual(read.rounds);
      expect(
        read.rounds.map((round) => [round.round, round.attempt, round.revision]),
        c.name,
      ).toEqual(c.expect.rounds.map((_, i) => [i + 1, 1, revision]));
      expect(
        trace.map((call) => call.op),
        c.name,
      ).toEqual(["read", ...c.expect.rounds.map(() => "scope"), "release"]);
    }
  });
});

describe("round vectors: refusals", () => {
  it("refuses each unanchored term with its reason, before any store call", async () => {
    const loaded = await load();
    for (const refusal of document.refusals) {
      const request: StoreReadRequest = {
        term: parseTerm(refusal.term),
        root: refusal.root,
        now: refusal.now,
        registry,
      };
      const trace: StoreCall[] = [];
      const before = { ...loaded.meter };
      const failure = await onSnapshot(loaded.peer, (snapshot) =>
        readAnchored(countingSnapshot(snapshot, trace), request).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(failure, refusal.name).toBeInstanceOf(UnanchoredTermError);
      expect((failure as UnanchoredTermError).reason, refusal.name).toBe(refusal.expect.reason);
      expect((failure as Error).message, refusal.name).toBe(
        `term is not anchored: ${refusal.expect.reason}`,
      );
      expect(trace, refusal.name).toEqual([]);
      expect(loaded.meter, refusal.name).toEqual(before);

      // Through the reactor: the same refusal, and it opens no snapshot.
      trace.length = 0;
      const reactor = StoreReactor.open(countingPeer(loaded.peer, trace));
      await expect(reactor.read(request), refusal.name).rejects.toBeInstanceOf(UnanchoredTermError);
      expect(trace, refusal.name).toEqual([]);
    }
  });
});

// ---- interleaved appends ------------------------------------------------------------------

type Interleaved = StoreRoundsDocument["interleaved"][number];
type Outcome = { answer: Required<Answer>; revision: number } | { refused: string };

/** Applies the case's change to the peer: its append by the load rule, or its purge. */
async function change(peer: PeerStore, c: Interleaved): Promise<void> {
  if (c.append !== undefined) return admit(peer, c.append);
  const ids = c.purge!.map(idOf);
  const report = await peer.purge(ids);
  expect(report.targets).toEqual(ids.map((id) => ({ id, outcome: "removed" })));
}

/** Runs the read with the case's change made once, after round `afterRound` of the first pass. */
async function interleave(
  c: Interleaved,
  read: (peer: PeerStore, request: StoreReadRequest) => Promise<StoreRead>,
): Promise<{ outcome: Outcome; start: number; end: number; loaded: Loaded }> {
  const loaded = await load();
  const start = await onSnapshot(loaded.peer, async (snapshot) => snapshot.revision);
  let appended = false;
  const request = requestOf(c, {
    onRound: async (round) => {
      if (appended || round.round !== c.afterRound) return;
      appended = true;
      // The append lands a turn later: a read that does not wait for its hook misses it.
      await new Promise((done) => setImmediate(done));
      await change(loaded.peer, c);
    },
  });
  const outcome = await read(loaded.peer, request).then(
    (got): Outcome => ({ answer: answerOf(got), revision: got.revision }),
    (error: unknown): Outcome => {
      if (error instanceof StoreError) return { refused: error.code };
      throw error;
    },
  );
  expect(appended, c.name).toBe(true);
  const end = await onSnapshot(loaded.peer, async (snapshot) => snapshot.revision);
  expect(end, c.name).toBeGreaterThan(start);
  return { outcome, start, end, loaded };
}

/** A snapshot that, once the peer has moved, answers from a new snapshot and says nothing. */
function driftingSnapshot(peer: PeerStore, first: Snapshot): Snapshot {
  let current = first;
  return {
    ...first,
    scope: async (request) => {
      try {
        return await current.scope(request);
      } catch (error) {
        if (!(error instanceof StoreError && error.code === "snapshot-moved")) throw error;
        current = await peer.read();
        return current.scope(request);
      }
    },
  };
}

/**
 * A wrong reader: on `snapshot-moved` it starts again on a new snapshot, but keeps every member
 * the first attempt fetched, as a fetch cache kept across snapshots would. It excludes them in
 * its first new call and adds them to that call's answer.
 */
async function staleRestart(peer: PeerStore, request: StoreReadRequest): Promise<StoreRead> {
  const kept = new Map<string, VerifiedDelta>();
  const first = await peer.read();
  try {
    return await readAnchored(
      {
        ...first,
        scope: async (asked) => {
          const answer = await first.scope(asked);
          for (const entry of answer.deltas) kept.set(entry.delta.id, entry);
          return answer;
        },
      },
      request,
    );
  } catch (error) {
    if (!(error instanceof StoreError && error.code === "snapshot-moved")) throw error;
  } finally {
    first.release();
  }
  const second = await peer.read();
  try {
    return await readAnchored(
      {
        ...second,
        scope: async (asked) => {
          const carried = [...kept.values()];
          kept.clear();
          const answer = await second.scope({
            ...asked,
            exclude: [...new Set([...(asked.exclude ?? []), ...carried.map((e) => e.delta.id)])],
          });
          return {
            ...answer,
            deltas: [...answer.deltas, ...carried].sort((a, b) =>
              compareUtf8(a.delta.id, b.delta.id),
            ),
          };
        },
      },
      request,
    );
  } finally {
    second.release();
  }
}

describe("round vectors: a change between two rounds", () => {
  for (const c of document.interleaved) {
    const last = c.afterRound === c.expect.before.rounds.length;

    it(`${c.name}: readAnchored answers snapshot-moved or the old answer`, async () => {
      const { outcome, start } = await interleave(c, (peer, request) =>
        onSnapshot(peer, (snapshot) => readAnchored(snapshot, request)),
      );
      // The memory store has no read transactions: it refuses when another call follows.
      if (last) expect(outcome).toEqual({ answer: c.expect.before, revision: start });
      else expect(outcome).toEqual({ refused: "snapshot-moved" });
    });

    it(`${c.name}: StoreReactor.read answers one snapshot whole`, async () => {
      const { outcome, start, end } = await interleave(c, (peer, request) =>
        StoreReactor.open(peer).read(request),
      );
      if (last) expect(outcome).toEqual({ answer: c.expect.before, revision: start });
      else expect(outcome).toEqual({ answer: c.expect.after, revision: end });
    });

    // A reader that goes on mid-read on a new snapshot, with its cache and its anchors. An
    // append below the anchors already fetched is what shows it.
    if (c.append !== undefined)
      it(`${c.name}: a read that goes on with its cache on a new snapshot is caught`, async () => {
        const { outcome } = await interleave(c, (peer, request) =>
          onSnapshot(peer, (snapshot) => readAnchored(driftingSnapshot(peer, snapshot), request)),
        );
        if (!("answer" in outcome)) throw new Error("the drifting read refused");
        if (last) {
          // No store call follows the append, so there is nothing to mix.
          expect(outcome.answer).toEqual(c.expect.before);
          return;
        }
        expect(outcome.answer.canonicalHex).not.toBe(c.expect.before.canonicalHex);
        expect(outcome.answer.canonicalHex).not.toBe(c.expect.after.canonicalHex);
      });

    // A reader that starts again on a new snapshot but keeps the cache of the first. Appends
    // alone cannot show it: what it kept is still held. A purge can.
    it(`${c.name}: a read that starts again with its old cache`, async () => {
      const { outcome, start, end } = await interleave(c, staleRestart);
      if (last) expect(outcome).toEqual({ answer: c.expect.before, revision: start });
      else if (c.append !== undefined)
        expect(outcome).toEqual({ answer: c.expect.after, revision: end });
      else {
        // It shows the purged delta at the later revision: neither answer.
        expect(outcome).toEqual({ answer: c.expect.before, revision: end });
        expect(c.expect.before).not.toEqual(c.expect.after);
      }
    });
  }

  it("the vectors have a purge between two rounds", () => {
    expect(document.interleaved.filter((c) => c.purge !== undefined).length).toBeGreaterThan(0);
    for (const c of document.interleaved)
      expect(
        [c.append, c.purge].filter((x) => x !== undefined),
        c.name,
      ).toHaveLength(1);
  });

  it("retries three times, then passes snapshot-moved up; every snapshot is released", async () => {
    const c = document.interleaved[0]!;
    const loaded = await load();
    const trace: StoreCall[] = [];
    let moves = 0;
    // The peer moves after the first round of every attempt.
    const request = requestOf(c, {
      onRound: async (round) => {
        if (round.round !== 1) return;
        moves += 1;
        const result = await loaded.peer.append({
          expectedHead: moves === 1 ? "rounds-head-2" : `move-${moves - 1}`,
          nextHead: `move-${moves}`,
          frame: null,
          added: [],
        });
        expect(result.status).toBe("committed");
      },
    });
    const reactor = StoreReactor.open(countingPeer(loaded.peer, trace));
    const failure = await reactor.read(request).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StoreError);
    expect((failure as StoreError).code).toBe("snapshot-moved");
    expect(moves).toBe(4);
    expect(trace.map((call) => call.op)).toEqual(
      Array.from({ length: 4 }, () => ["read", "scope", "scope", "release"]).flat(),
    );
  });

  it("a second attempt that holds still answers, and says it took two", async () => {
    const c = document.interleaved[0]!;
    const reports: StoreRoundReport[] = [];
    let rounds: readonly StoreRoundReport[] = [];
    const { outcome, start, end } = await interleave(c, async (peer, request) => {
      const read = await StoreReactor.open(peer).read({
        ...request,
        onRound: async (round) => {
          reports.push(round);
          await request.onRound?.(round);
        },
      });
      expect(read.attempts).toBe(2);
      rounds = read.rounds;
      return read;
    });
    expect(outcome).toEqual({ answer: c.expect.after, revision: end });
    expect(rounds.every((round) => round.attempt === 2 && round.revision === end)).toBe(true);
    // The hook saw both attempts, and each report says which one it was.
    expect(reports.map((r) => [r.attempt, r.round, r.revision])).toEqual([
      [1, 1, start],
      ...c.expect.after.rounds.map((_, i) => [2, i + 1, end]),
    ]);
  });

  for (const code of ["snapshot-released", "capability-absent"] as const)
    it(`a ${code} refusal passes up after one attempt`, async () => {
      const loaded = await load();
      const refusing = (peer: PeerStore): PeerStore => {
        let refused = false;
        return {
          ...peer,
          read: async () => {
            const snapshot = await peer.read();
            return {
              ...snapshot,
              scope: async (asked) => {
                if (refused) return snapshot.scope(asked);
                refused = true;
                throw new StoreError(code, `once: ${code}`);
              },
            };
          },
        };
      };
      for (const run of [
        (reactor: StoreReactor) => reactor.read(requestOf(pick("a-subtree"))),
        (reactor: StoreReactor) => reactor.fetch(["cutting:2"]),
      ]) {
        const trace: StoreCall[] = [];
        const failure = await run(
          StoreReactor.open(countingPeer(refusing(loaded.peer), trace)),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(StoreError);
        expect((failure as StoreError).code).toBe(code);
        expect(trace.map((call) => call.op)).toEqual(["read", "scope", "release"]);
      }
    });
});

// ---- readers that are wrong on purpose ----------------------------------------------------

/**
 * A conforming store that returns more than the scope without closing it (SPEC-18 §4.3 allows
 * both). It leaves `timestampAtMost` to the host, and beside the exact scope it returns each
 * negation that passes the time cut while its target fails it, without that negation's own
 * negators. Such a delta is no member until a later anchor reaches it; then its negators are
 * owed, and the read holds it already.
 */
function looseSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    scope: async (request) => {
      const exact = await snapshot.scope(request);
      const cut = request.pushdown?.timestampAtMost;
      if (cut === undefined) return exact;
      const { arrivalAtMost, excludeIds } = request.pushdown ?? {};
      const wide = await snapshot.scope({
        ...request,
        pushdown: {
          ...(arrivalAtMost === undefined ? {} : { arrivalAtMost }),
          ...(excludeIds === undefined ? {} : { excludeIds }),
        },
      });
      const late = new Set(
        wide.deltas.filter((e) => e.delta.claims.timestamp > cut).map((e) => e.delta.id),
      );
      const returned = new Set(exact.deltas.map((e) => e.delta.id));
      const extras = wide.deltas.filter(
        (e) =>
          e.delta.claims.timestamp <= cut &&
          !returned.has(e.delta.id) &&
          e.delta.claims.pointers.some(
            (p) =>
              p.role === "negates" &&
              p.target.kind === "delta" &&
              late.has(p.target.deltaRef.delta),
          ),
      );
      return {
        deltas: [...exact.deltas, ...extras].sort((a, b) => compareUtf8(a.delta.id, b.delta.id)),
        applied: { ...exact.applied, timestampAtMost: false },
      };
    },
  };
}
const loosePeer = (peer: PeerStore): PeerStore => ({
  ...peer,
  read: async () => looseSnapshot(await peer.read()),
});

/** The cases a reader gets wrong on a store with this pushdown profile, by what it got wrong. */
async function failures(
  policy: RoundPolicy,
  applied: readonly PushdownField[],
  wrap: (peer: PeerStore) => PeerStore = (peer) => peer,
): Promise<{ answers: string[]; rounds: string[] }> {
  const base = await load({ pushdown: pushdownOf(applied) });
  const loaded = { ...base, peer: wrap(base.peer) };
  const answers: string[] = [];
  const rounds: string[] = [];
  for (const c of document.cases) {
    const got = await withPolicy(loaded.peer, c, policy);
    if (JSON.stringify(unpinned(got)) !== JSON.stringify(unpinned(c.expect))) answers.push(c.name);
    if (JSON.stringify(got.rounds) !== JSON.stringify(c.expect.rounds)) rounds.push(c.name);
  }
  return { answers, rounds };
}

describe("round vectors: a wrong reader fails a case", () => {
  const ALL = PUSHDOWN_FIELDS;

  it("the standard reader fails none (the control for the rails below)", async () => {
    for (const applied of [[], ALL])
      expect(await failures(STANDARD_ROUNDS, applied)).toEqual({ answers: [], rounds: [] });
  });

  it("a reader that sends what it holds as a selection", async () => {
    // It names the held ids in `pushdown.excludeIds`, not in `exclude`. A store that leaves
    // that field to the host makes the reader drop everything it holds from its own scope.
    const wrong: RoundPolicy = {
      ...STANDARD_ROUNDS,
      request: ({ fresh, held, pushdown }) => ({
        anchors: fresh.map((entity) => ({ kind: "entity" as const, entity })),
        pushdown: { ...pushdown, excludeIds: [...(pushdown?.excludeIds ?? []), ...held] },
      }),
    };
    const { answers } = await failures(wrong, ["timestampAtMost", "arrivalAtMost"]);
    expect(answers).toContain("the-whole-garden");
    expect(answers).toContain("a-subtree");
    // One round holds nothing yet, so there is nothing to confuse.
    expect(answers).not.toContain("a-root-nothing-points-at");
    // The reference store hides the mistake when it applies the field: it returns closed
    // scopes, so what the read holds is closed under negation and dropping it loses nothing.
    expect((await failures(wrong, ALL)).answers).toEqual([]);
    // A store that returns an unclosed extra does not hide it. The read holds
    // b1-late-note-neg-at-c2 from round 2; round 3 owes the negation of it, and the chain
    // through a held id is cut.
    expect((await failures(STANDARD_ROUNDS, ALL, loosePeer)).answers).toEqual([]);
    const cut = await failures(wrong, ALL, loosePeer);
    expect(cut.answers).toContain("signed-time-cuts-a-link-and-a-strike");
  });

  it("a reader that skips the residual trim", async () => {
    const wrong: RoundPolicy = { ...STANDARD_ROUNDS, residual: () => [] };
    const none = await failures(wrong, []);
    for (const name of [
      "signed-time-cuts-a-link-and-a-strike",
      "arrival-cuts-a-strike-so-a-child-appears",
      "an-excluded-id-ends-a-chain-at-its-start",
      "an-excluded-id-in-the-middle-of-a-chain",
      "an-excluded-link-leaves-the-other-paths",
      "an-excluded-negation-held-before-its-target",
      "every-field",
      "the-selection-admits-nothing",
      "lawful-strikers-as-of-the-first-admission",
    ])
      expect(none.answers, name).toContain(name);
    // Each field alone is caught when it is the one the store leaves out.
    const withoutTime = await failures(wrong, ["arrivalAtMost", "excludeIds"]);
    expect(withoutTime.answers).toContain("signed-time-cuts-a-link-and-a-strike");
    expect(withoutTime.answers).not.toContain("arrival-cuts-a-strike-so-a-child-appears");
    const withoutArrival = await failures(wrong, ["timestampAtMost", "excludeIds"]);
    expect(withoutArrival.answers).toContain("arrival-cuts-a-strike-so-a-child-appears");
    const withoutExclude = await failures(wrong, ["timestampAtMost", "arrivalAtMost"]);
    expect(withoutExclude.answers).toContain("an-excluded-id-in-the-middle-of-a-chain");
    // A store that applies everything leaves no residual, so this reader is right there.
    expect((await failures(wrong, ALL)).answers).toEqual([]);
  });

  it("a reader that asks for every anchor in every round", async () => {
    const wrong: RoundPolicy = {
      ...STANDARD_ROUNDS,
      request: ({ anchors, held, pushdown }) => ({
        anchors: anchors.map((entity) => ({ kind: "entity" as const, entity })),
        ...(pushdown === undefined ? {} : { pushdown }),
        exclude: [...held],
      }),
    };
    const { answers, rounds } = await failures(wrong, ALL);
    // Its answers are right. Only the pinned round anchors catch it.
    expect(answers).toEqual([]);
    expect(rounds).toContain("the-whole-garden");
    expect(rounds).toContain("a-subtree");
    expect(rounds).not.toContain("a-root-nothing-points-at");
  });

  it("the reader with no fetch cache is right in its answers and differs in its rounds", async () => {
    const { answers, rounds } = await failures(UNCACHED_ROUNDS, []);
    expect(answers).toEqual([]);
    expect(rounds).toContain("the-whole-garden");
    // Each answer alone carries everything the read holds: nothing came from an earlier round.
    const loaded = await load();
    const read = await onSnapshot(loaded.peer, (snapshot) =>
      readAnchoredWith(snapshot, requestOf(pick("the-whole-garden")), UNCACHED_ROUNDS),
    );
    expect(read.rounds).toHaveLength(4);
    for (const round of read.rounds) expect(round.held).toBe(round.fetched);
  });

  it("a field one round leaves to the host stays with the host", async () => {
    // This store ignores `timestampAtMost` in its first answer and applies it afterwards. The
    // members round 1 fetched past the cut are still held in round 2, whose answer reports the
    // field applied.
    const firstRoundLoose = (peer: PeerStore): PeerStore => ({
      ...peer,
      read: async () => {
        const snapshot = await peer.read();
        let calls = 0;
        return {
          ...snapshot,
          scope: async (request) => {
            calls += 1;
            if (calls > 1 || request.pushdown?.timestampAtMost === undefined)
              return snapshot.scope(request);
            const { arrivalAtMost, excludeIds } = request.pushdown;
            const wide = await snapshot.scope({
              ...request,
              pushdown: {
                ...(arrivalAtMost === undefined ? {} : { arrivalAtMost }),
                ...(excludeIds === undefined ? {} : { excludeIds }),
              },
            });
            return { ...wide, applied: { ...wide.applied, timestampAtMost: false } };
          },
        };
      },
    });
    expect(await failures(STANDARD_ROUNDS, ALL, firstRoundLoose)).toEqual({
      answers: [],
      rounds: [],
    });
    // The control: this store does return members past the cut. A reader that never applies
    // the field itself shows the struck link alive.
    const forgetful: RoundPolicy = {
      ...STANDARD_ROUNDS,
      residual: (sent, applied) =>
        unappliedFields(sent, applied).filter((field) => field !== "timestampAtMost"),
    };
    expect((await failures(forgetful, ALL, firstRoundLoose)).answers).toContain(
      "signed-time-cuts-a-link-and-a-strike",
    );
  });
});

describe("round vectors: what the read trusts and what it keeps", () => {
  const ALL = PUSHDOWN_FIELDS;
  /** A store that ignores `timestampAtMost` in the rounds `loose` picks, and says so honestly. */
  const timeLooseOn =
    (loose: (call: number) => boolean) =>
    (peer: PeerStore): PeerStore => ({
      ...peer,
      read: async () => {
        const snapshot = await peer.read();
        let calls = 0;
        return {
          ...snapshot,
          scope: async (request) => {
            calls += 1;
            if (!loose(calls) || request.pushdown?.timestampAtMost === undefined)
              return snapshot.scope(request);
            const { arrivalAtMost, excludeIds } = request.pushdown;
            const wide = await snapshot.scope({
              ...request,
              pushdown: {
                ...(arrivalAtMost === undefined ? {} : { arrivalAtMost }),
                ...(excludeIds === undefined ? {} : { excludeIds }),
              },
            });
            return { ...wide, applied: { ...wide.applied, timestampAtMost: false } };
          },
        };
      },
    });

  it("a field stays residual for the rest of the read, whichever rounds leave it to the host", async () => {
    // Both parities: the odd rounds leave the field to the host, then the even rounds. A
    // reader that keeps only the last round's residual, or only the first's, fails one of them.
    for (const parity of [1, 0])
      expect(
        await failures(
          STANDARD_ROUNDS,
          ALL,
          timeLooseOn((call) => call % 2 === parity),
        ),
        `parity ${parity}`,
      ).toEqual({ answers: [], rounds: [] });
    // The control: these stores do return members past the cut in a read of several rounds.
    const forgetful: RoundPolicy = {
      ...STANDARD_ROUNDS,
      residual: (sent, applied) =>
        unappliedFields(sent, applied).filter((field) => field !== "timestampAtMost"),
    };
    for (const parity of [1, 0])
      expect(
        (
          await failures(
            forgetful,
            ALL,
            timeLooseOn((call) => call % 2 === parity),
          )
        ).answers,
        `parity ${parity}`,
      ).toContain("signed-time-cuts-a-link-and-a-strike");
  });

  it("the read trusts `applied`: a store that lies about it gets a wrong answer", async () => {
    // SPEC-18 §4.12 reading 18. The store drops `timestampAtMost` and reports it applied. The
    // read does not check the members again, so the cut does not happen. The store vectors,
    // not the read, catch such a store.
    const lying = (peer: PeerStore): PeerStore => ({
      ...peer,
      read: async () => {
        const snapshot = await peer.read();
        return {
          ...snapshot,
          scope: async (request) => {
            const { timestampAtMost, ...rest } = request.pushdown ?? {};
            const answer = await snapshot.scope({ ...request, pushdown: rest });
            return {
              ...answer,
              applied: { ...answer.applied, timestampAtMost: timestampAtMost !== undefined },
            };
          },
        };
      },
    });
    const { answers } = await failures(STANDARD_ROUNDS, ALL, lying);
    expect(answers).toContain("signed-time-cuts-a-link-and-a-strike");
    expect(answers).toContain("a-resolved-tree-cut-at-a-strike");
    // A case with no time cut is not touched by the lie.
    expect(answers).not.toContain("the-whole-garden");
  });
});

// ---- the evaluation memo ------------------------------------------------------------------

/** How a memo under test forms its key and what it keeps (SPEC-18 §4.12 reading 21). */
type MemoRule = {
  /** Keep a child only when every anchor its HView shows is fetched. */
  readonly finalOnly: boolean;
  readonly keyBindings: boolean;
  readonly keyRoot: boolean;
  /** A store kept outside the attempt: across reads, or across the snapshots of one read. */
  readonly kept?: Map<string, HView>;
};
const RIGHT: MemoRule = { finalOnly: true, keyBindings: true, keyRoot: true };

/** A memo written beside the witness's, so each rule can be broken alone. */
const ruledMemo =
  (rule: MemoRule) =>
  (fetched: ReadonlySet<string>): ReadMemo => {
    const kept = rule.kept ?? new Map<string, HView>();
    const ids = new Map<Bindings, number>();
    const idOfBindings = (bindings: Bindings | undefined): number => {
      if (bindings === undefined || !rule.keyBindings) return 0;
      if (!ids.has(bindings)) ids.set(bindings, ids.size + 1);
      return ids.get(bindings)!;
    };
    const key = (schema: SchemaRefT, bindings: Bindings | undefined, root: string): string =>
      JSON.stringify([
        schema.kind === "name" ? schema.name : schema.hash,
        idOfBindings(bindings),
        rule.keyRoot ? root : "",
      ]);
    return {
      get: (schema, bindings, root) => kept.get(key(schema, bindings, root)),
      put: (schema, bindings, root, hview) => {
        if (!rule.finalOnly || hviewAnchors(hview).every((entity) => fetched.has(entity)))
          kept.set(key(schema, bindings, root), hview);
      },
      get stored() {
        return kept.size;
      },
    };
  };
const withMemo = (rule: MemoRule): RoundPolicy => ({ ...CACHED_ROUNDS, memo: ruledMemo(rule) });

/** What a memo saw: one `put` per child evaluation, and whether the memo kept it. */
type MemoCount = {
  gets: number;
  hits: number;
  evaluations: number;
  final: number;
  notFinal: number;
  keys: Set<string>;
  finalKeys: string[];
};
const newCount = (): MemoCount => ({
  gets: 0,
  hits: 0,
  evaluations: 0,
  final: 0,
  notFinal: 0,
  keys: new Set(),
  finalKeys: [],
});
/** Counts through the hook. With no inner memo it keeps nothing: the read without a memo. */
const counted =
  (count: MemoCount, inner?: (fetched: ReadonlySet<string>) => ReadMemo) =>
  (fetched: ReadonlySet<string>): ReadMemo => {
    const memo = inner?.(fetched);
    const keyOf = (schema: SchemaRefT, bindings: Bindings | undefined, root: string): string =>
      JSON.stringify([schema, [...(bindings ?? [])], root]);
    return {
      get: (schema, bindings, root) => {
        count.gets += 1;
        const hit = memo?.get(schema, bindings, root);
        if (hit !== undefined) count.hits += 1;
        return hit;
      },
      put: (schema, bindings, root, hview) => {
        count.evaluations += 1;
        const key = keyOf(schema, bindings, root);
        count.keys.add(key);
        memo?.put(schema, bindings, root, hview);
        if (memo?.get(schema, bindings, root) === hview) {
          count.final += 1;
          count.finalKeys.push(key);
        } else count.notFinal += 1;
      },
      get stored() {
        return memo?.stored ?? 0;
      },
    };
  };

describe("the evaluation memo", () => {
  const ALL = PUSHDOWN_FIELDS;

  it("changes no round report: modes 5 and 4 report what modes 3 and 2 report", async () => {
    const loaded = await load();
    for (const c of document.cases)
      for (const [plain, memo] of [
        [CACHED_ROUNDS, STANDARD_ROUNDS],
        [UNCACHED_ROUNDS, { ...UNCACHED_ROUNDS, memo: finalChildMemo }],
      ] as const) {
        const reports: (readonly StoreRoundReport[])[] = [];
        for (const policy of [plain, memo])
          reports.push(
            await onSnapshot(loaded.peer, async (snapshot) => {
              const hooked: StoreRoundReport[] = [];
              const read = await readAnchoredWith(
                snapshot,
                requestOf(c, { onRound: (round) => void hooked.push(round) }),
                policy,
              );
              expect(hooked, c.name).toEqual(read.rounds);
              return read.rounds;
            }),
          );
        expect(reports[1], c.name).toEqual(reports[0]);
      }
  });

  it("a memo written by the rule of reading 21 fails no case (the control for the rails below)", async () => {
    for (const applied of [[], ALL])
      expect(await failures(withMemo(RIGHT), applied)).toEqual({ answers: [], rounds: [] });
  });

  it("a memo that keeps every child, final or not", async () => {
    const { answers } = await failures(withMemo({ ...RIGHT, finalOnly: false }), ALL);
    // Round 1 evaluates the beds over the garden's scope alone, and the memo keeps the empty
    // answer for the rest of the read.
    expect(answers).toContain("the-whole-garden");
    expect(answers).toContain("a-subtree");
    // One round evaluates no child that a later round could need.
    expect(answers).not.toContain("a-root-nothing-points-at");
  });

  it("a memo whose key leaves out the bindings", async () => {
    const { answers } = await failures(withMemo({ ...RIGHT, keyBindings: false }), ALL);
    expect(answers).toEqual(["one-child-under-two-bindings"]);
  });

  it("a memo whose key leaves out the root", async () => {
    const { answers } = await failures(withMemo({ ...RIGHT, keyRoot: false }), ALL);
    expect(answers).toContain("the-whole-garden");
    expect(answers).toContain("lawful-strikers");
  });

  it("a memo kept across two reads", async () => {
    // One store for every case of the run: each read starts with what the reads before it kept.
    const kept = new Map<string, HView>();
    const { answers } = await failures(withMemo({ ...RIGHT, kept }), ALL);
    expect(kept.size).toBeGreaterThan(0);
    expect(answers).toContain("signed-time-cuts-a-link-and-a-strike");
    expect(answers).toContain("every-field");
    // The first case reads with an empty memo, so it is right.
    expect(answers).not.toContain(document.cases[0]!.name);
  });

  it("a memo kept across the snapshots of one read (a retry)", async () => {
    // A wrapper that starts again on `snapshot-moved`, as StoreReactor.read does. With `share`
    // set, each new attempt gets the memo of the attempt before it.
    const restart =
      (share: boolean) =>
      async (peer: PeerStore, request: StoreReadRequest): Promise<StoreRead> => {
        const kept = new Map<string, HView>();
        for (let attempt = 1; ; attempt += 1) {
          const policy = share ? withMemo({ ...RIGHT, kept }) : STANDARD_ROUNDS;
          const snapshot = await peer.read();
          try {
            return await readAnchoredWith(snapshot, request, policy, attempt);
          } catch (error) {
            const moved = error instanceof StoreError && error.code === "snapshot-moved";
            if (!moved || attempt > 3) throw error;
          } finally {
            snapshot.release();
          }
        }
      };
    for (const c of document.interleaved) {
      if (c.afterRound === c.expect.before.rounds.length) continue;
      const right = await interleave(c, restart(false));
      expect(right.outcome, c.name).toEqual({ answer: c.expect.after, revision: right.end });
      const { outcome } = await interleave(c, restart(true));
      if (!("answer" in outcome)) throw new Error(`${c.name}: the read refused`);
      expect(outcome.answer.members, c.name).toEqual(c.expect.after.members);
      if (c.afterRound === 1) {
        // Round 1 finishes no child, so the memo it hands on is empty and the answer is right.
        expect(outcome.answer, c.name).toEqual(c.expect.after);
        continue;
      }
      // Round 3 finished Leaf at cutting:1, and the append is under it: the old cutting:1
      // beside the new members, which is neither answer.
      expect(c.afterRound, c.name).toBe(3);
      expect(outcome.answer.canonicalHex, c.name).not.toBe(c.expect.after.canonicalHex);
      expect(outcome.answer.canonicalHex, c.name).not.toBe(c.expect.before.canonicalHex);
    }
  });

  it("evaluates fewer children: each key once as final, plus each time it was not final", async () => {
    const loaded = await load();
    const report: Record<string, Record<string, number>> = {};
    for (const name of ["the-whole-garden", "lawful-strikers", "one-child-under-two-bindings"]) {
      const c = pick(name);
      const none = newCount();
      const memo = newCount();
      for (const [count, policy] of [
        [none, { ...CACHED_ROUNDS, memo: counted(none) }],
        [memo, { ...CACHED_ROUNDS, memo: counted(memo, finalChildMemo) }],
      ] as const) {
        const read = await onSnapshot(loaded.peer, (snapshot) =>
          readAnchoredWith(snapshot, requestOf(c), policy),
        );
        expect(answerOf(read), name).toEqual(c.expect);
        // Every lookup that misses is followed by one evaluation and one `put`.
        expect(count.gets, name).toBe(count.evaluations + count.hits);
      }
      expect(c.expect.rounds.length, name).toBeGreaterThanOrEqual(3);
      // Without the memo nothing is kept and every child reached is evaluated in every round.
      expect(none.hits + none.final, name).toBe(0);
      // With it: strictly fewer evaluations, each key final at most once, and nothing more.
      expect(memo.evaluations, name).toBeLessThan(none.evaluations);
      expect(new Set(memo.finalKeys).size, name).toBe(memo.finalKeys.length);
      expect(memo.evaluations, name).toBe(memo.final + memo.notFinal);
      expect(memo.evaluations, name).toBeLessThanOrEqual(memo.keys.size + memo.notFinal);
      expect(memo.hits, name).toBeGreaterThan(0);
      report[name] = {
        rounds: c.expect.rounds.length,
        withoutMemo: none.evaluations,
        withMemo: memo.evaluations,
        keys: memo.keys.size,
        final: memo.final,
        notFinal: memo.notFinal,
        hits: memo.hits,
      };
    }
    // The numbers, so a change in what the memo saves is seen. A witness that counts child
    // evaluations the same way (one per `put`) gets the same ones.
    expect(report).toEqual({
      "the-whole-garden": {
        rounds: 4,
        withoutMemo: 159,
        withMemo: 62,
        keys: 18,
        final: 18,
        notFinal: 44,
        hits: 42,
      },
      "lawful-strikers": {
        rounds: 4,
        withoutMemo: 159,
        withMemo: 62,
        keys: 18,
        final: 18,
        notFinal: 44,
        hits: 42,
      },
      "one-child-under-two-bindings": {
        rounds: 3,
        withoutMemo: 38,
        withMemo: 24,
        keys: 11,
        final: 11,
        notFinal: 13,
        hits: 12,
      },
    });
  });

  it("reports how many children it stored: more than none with the memo, none without", async () => {
    // The memo changes no answer, so no case can see a read that ignores the switch. The count
    // can (SPEC-18 §4.12 reading 27).
    const loaded = await load();
    const c = pick("the-whole-garden");
    expect(c.expect.rounds, "a case of depth three").toHaveLength(4);
    const on = await onSnapshot(loaded.peer, (snapshot) => readAnchored(snapshot, requestOf(c)));
    const off = await onSnapshot(loaded.peer, (snapshot) =>
      readAnchoredWith(snapshot, requestOf(c), CACHED_ROUNDS),
    );
    expect(answerOf(on)).toEqual(answerOf(off));
    // The keys of the case, each stored once (the reference numbers above).
    expect(on.memoStored).toBe(18);
    expect(off.memoStored).toBe(0);
    expect((await StoreReactor.open(loaded.peer).read(requestOf(c))).memoStored).toBe(18);
    const uncached = await onSnapshot(loaded.peer, (snapshot) =>
      readAnchoredWith(snapshot, requestOf(c), UNCACHED_ROUNDS),
    );
    expect(uncached.memoStored).toBe(0);
  });

  it("is not consulted when an evaluation budget is present", () => {
    const c = pick("the-whole-garden");
    const request = requestOf(c);
    const whole = DeltaSet.from([...deltaOf.values()]);
    const spy = (count: { get: number; put: number }): ChildMemo => ({
      get: () => {
        count.get += 1;
        return undefined;
      },
      put: () => void (count.put += 1),
    });
    const limits = { nodes: 4096, entries: 16384, buckets: 256, depth: 32 };
    const plain = resultCanonicalHex(
      evalTerm(request.term, whole, request.now, request.root, registry),
    );
    const budgeted = { get: 0, put: 0 };
    const result = evalTermWithHooks(
      request.term,
      whole,
      request.now,
      { budget: new EvaluationBudget(limits), memo: spy(budgeted) },
      request.root,
      registry,
    );
    expect(resultCanonicalHex(result)).toBe(plain);
    expect(budgeted).toEqual({ get: 0, put: 0 });
    // The control: without the budget the same memo is asked about every child.
    const free = { get: 0, put: 0 };
    evalTermWithHooks(
      request.term,
      whole,
      request.now,
      { memo: spy(free) },
      request.root,
      registry,
    );
    expect(free.get).toBeGreaterThan(0);
    expect(free.put).toBe(free.get);
  });
});

// ---- cost ---------------------------------------------------------------------------------

/** Deltas that point at no fixture entity: facts elsewhere, and strikes on some of them. */
function unrelated(count: number): Delta[] {
  const facts = Array.from({ length: count }, (_, i) =>
    makeDelta({
      timestamp: i,
      validFrom: 0,
      author: "did:key:zBystander",
      pointers: [
        {
          role: "subject",
          target: { kind: "entity", entity: { id: `elsewhere:${i % 97}`, context: "v" } },
        },
        { role: "value", target: { kind: "primitive", value: i } },
      ],
    }),
  );
  const strikes = facts
    .slice(0, Math.floor(count / 10))
    .map((fact, i) => makeDelta(makeNegationClaims("did:key:zStriker", 9000 + i, fact.id)));
  return [...facts, ...strikes];
}

describe("readFullSurface: the explicit full-surface read (SPEC-18 §6.6)", () => {
  const exporterOf = (loaded: Loaded): PeerExporter =>
    loaded.store.openAdmin().peer(document.load.peer);

  it("answers each case whose selection needs no arrival record, and says it is unoptimized", async () => {
    const loaded = await load();
    const ran: string[] = [];
    for (const c of document.cases) {
      const { term, root, now, bindings, pushdown } = requestOf(c);
      if (pushdown?.arrivalAtMost !== undefined) continue;
      const got = await readFullSurface(exporterOf(loaded), {
        term,
        root,
        now,
        registry,
        ...(bindings === undefined ? {} : { bindings }),
        ...(pushdown === undefined ? {} : { pushdown }),
      });
      expect(resultCanonicalHex(got.result), c.name).toBe(c.expect.canonicalHex);
      expect(got.route.optimized, c.name).toBe(false);
      expect(got.route.listed, c.name).toBe(loaded.held.length);
      const admitted = loaded.held.filter((entry) =>
        passesSelection(entry, pushdown ?? {}, PUSHDOWN_FIELDS),
      ).length;
      expect(got.route.admitted, c.name).toBe(admitted);
      ran.push(c.name);
    }
    // Both host-applied fields, and a selection that admits nothing, are among them.
    expect(ran).toContain("signed-time-cuts-a-link-and-a-strike");
    expect(ran).toContain("an-excluded-id-in-the-middle-of-a-chain");
    expect(ran).toContain("the-selection-admits-nothing");
    expect(ran).toHaveLength(18);
  });

  it("refuses a selection by arrival before it lists anything", async () => {
    let listed = 0;
    const exporter: PeerExporter = {
      ids: () => {
        throw new Error("the read listed ids");
      },
      deltas: () => {
        listed += 1;
        return (async function* () {})();
      },
    };
    const c = pick("arrival-cuts-a-strike-so-a-child-appears");
    const { term, root, now, pushdown } = requestOf(c);
    for (const request of [
      { term, root, now, registry, pushdown: pushdown as never },
      { term, root, now, registry, admits: (() => true) as never },
    ]) {
      const refused = await readFullSurface(exporter, request).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(StoreError);
      expect((refused as StoreError).code).toBe("invalid-request");
    }
    expect(listed).toBe(0);
    // The control: the same exporter is listed once for a selection it can apply.
    await readFullSurface(exporter, { term, root, now, registry });
    expect(listed).toBe(1);
  });

  it("passes up the exporter's refusal of a peer it does not hold", async () => {
    const loaded = await load();
    const refused = await readFullSurface(loaded.store.openAdmin().peer("ed25519:absent"), {
      term: requestOf(pick("the-whole-garden")).term,
      root: "garden:1",
      now: 100,
      registry,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((refused as StoreError).code).toBe("peer-absent");
  });

  it("collectDeltaSet holds every listed delta, and refuses one whose id does not recompute", async () => {
    const loaded = await load();
    const set = await collectDeltaSet(exporterOf(loaded));
    expect(set.ids()).toEqual(loaded.held.map((entry) => entry.delta.id).sort(compareUtf8));
    const [first, second] = loaded.held;
    const forged: PeerExporter = {
      ids: async function* () {},
      deltas: async function* () {
        yield { ...first!.delta, id: second!.delta.id };
      },
    };
    await expect(collectDeltaSet(forged)).rejects.toThrow(/does not match its claims/);
  });

  it("is not reachable from a StoreReactor, which holds no exporter", () => {
    const methods = Object.getOwnPropertyNames(StoreReactor.prototype).sort();
    expect(methods).toEqual(["constructor", "fetch", "onSnapshot", "read"]);
  });
});

describe("the store-backed read: cost", () => {
  const measure = async (read: RoundsRead, extra: Delta[]) => {
    const loaded = await load({ extra });
    const trace: StoreCall[] = [];
    const before = { ...loaded.meter };
    const raw = await onSnapshot(loaded.peer, (snapshot) =>
      readAnchored(countingSnapshot(snapshot, trace), requestOf(read)),
    );
    const got = answerOf(raw);
    // Each round excludes exactly what the read held when it asked.
    expect(trace.map((call) => call.excludeCount)).toEqual([
      0,
      ...raw.rounds.slice(0, -1).map((round) => round.held),
    ]);
    const meter = {
      lookups: loaded.meter.lookups - before.lookups,
      visited: loaded.meter.visited - before.visited,
      scans: loaded.meter.scans - before.scans,
    };
    return { got, trace, meter };
  };

  for (const name of ["the-whole-garden", "every-field", "lawful-strikers"]) {
    it(`${name}: the same calls and the same index work beside 0 and 4400 unrelated deltas`, async () => {
      const c = pick(name);
      const alone = await measure(c, []);
      const crowd = unrelated(4000);
      expect(crowd).toHaveLength(4400);
      const crowded = await measure(c, crowd);
      expect(crowded).toEqual(alone);
      expect(alone.got).toEqual(c.expect);
      expect(alone.meter.scans).toBe(0);
      // The rail measures something: the read did index work.
      expect(alone.meter.lookups).toBeGreaterThan(0);

      // One `scope` call per round, for that round's anchors, and no other read call. The
      // reference store returns exactly the scope, so each round excludes the members so far.
      expect(alone.trace.map((call) => call.op)).toEqual(c.expect.rounds.map(() => "scope"));
      expect(alone.trace.map((call) => call.keyCount)).toEqual(
        c.expect.rounds.map((round) => round.anchors.length),
      );
      const excluded = alone.trace.map((call) => call.excludeCount);
      expect(excluded[excluded.length - 1]).toBeGreaterThan(0);
      expect(excluded[excluded.length - 1]).toBeLessThanOrEqual(c.expect.members.length);
    });
  }

  it("the fetch cache keeps a member that fails the residual, so the store is not sent it twice", async () => {
    // With no field applied the store returns members the host trims. They stay excluded.
    const c = pick("every-field");
    const loaded = await load({ pushdown: pushdownOf([]) });
    const rounds: StoreRead["rounds"][number][] = [];
    const read = await onSnapshot(loaded.peer, (snapshot) =>
      readAnchored(snapshot, requestOf(c, { onRound: (round) => void rounds.push(round) })),
    );
    expect(answerOf(read)).toEqual(c.expect);
    expect(read.rounds).toEqual(rounds);
    const last = read.rounds[read.rounds.length - 1]!;
    expect(last.held).toBeGreaterThan(last.members);
    // No delta came back twice: what the rounds fetched adds up to what the read holds.
    expect(read.rounds.reduce((sum, round) => sum + round.fetched, 0)).toBe(last.held);
    expect(read.rounds.every((round) => !round.applied.timestampAtMost)).toBe(true);
  });

  it("StoreReactor.open makes no store call and does no index work, whatever the peer holds", async () => {
    const loaded = await load({ extra: unrelated(4000) });
    const trace: StoreCall[] = [];
    const before = { ...loaded.meter };
    const reactor = StoreReactor.open(countingPeer(loaded.peer, trace));
    expect(trace).toEqual([]);
    expect(loaded.meter).toEqual(before);
    // The handle is live: the first read is the first store call.
    const read = await reactor.read(requestOf(pick("a-subtree")));
    expect(answerOf(read)).toEqual(pick("a-subtree").expect);
    expect(trace[0]!.op).toBe("read");
  });

  it("offers no whole-set method", () => {
    const names = Object.getOwnPropertyNames(StoreReactor.prototype).sort();
    expect(names).toEqual(["constructor", "fetch", "onSnapshot", "read"]);
  });
});

// ---- fetchScope ---------------------------------------------------------------------------

describe("fetchScope: one fetch, then a synchronous source", () => {
  const selections: { name: string; entities: string[]; selection: Pushdown }[] = [
    { name: "no selection", entities: ["cutting:2", "bed:1"], selection: {} },
    { name: "signed time", entities: ["garden:1", "plant:1"], selection: { timestampAtMost: 60 } },
    { name: "arrival", entities: ["bed:2", "cutting:2"], selection: { arrivalAtMost: 38 } },
    {
      name: "an excluded id in a chain",
      entities: ["cutting:2"],
      selection: { excludeIds: [idOf("c2-size-n2")] },
    },
    { name: "nothing points there", entities: ["nowhere"], selection: {} },
  ];

  for (const applied of FIELD_SUBSETS) {
    it(`knows exactly the scope, on a store applying {${applied.join(", ")}}`, async () => {
      const loaded = await load({ pushdown: pushdownOf(applied) });
      for (const { name, entities, selection } of selections) {
        const admitted = loaded.held.filter((e) => passesSelection(e, selection, PUSHDOWN_FIELDS));
        const expected = scopeOver(admitted, entities);
        const trace: StoreCall[] = [];
        const { source, revision } = await onSnapshot(loaded.peer, (snapshot) =>
          fetchScope(countingSnapshot(snapshot, trace), [...entities, entities[0]!], {
            pushdown: selection,
          }),
        );
        expect(source.ids(), name).toEqual(expected);
        expect(trace, name).toEqual([{ op: "scope", keyCount: entities.length, excludeCount: 0 }]);
        expect(revision, name).toBe(2);
        // The source answers as a list scan over the exact scope answers.
        const inScope = admitted.filter((e) => expected.includes(e.delta.id));
        for (const entity of [...entities, "plant:s", "garden:1"])
          expect(source.targets(entity), `${name} ${entity}`).toEqual(
            inScope
              .filter((e) =>
                e.delta.claims.pointers.some(
                  (p) => p.target.kind === "entity" && p.target.entity.id === entity,
                ),
              )
              .map((e) => e.delta.id)
              .sort(compareUtf8),
          );
        for (const entry of loaded.held) {
          const id = entry.delta.id;
          const member = expected.includes(id);
          expect(source.get(id)?.id, name).toBe(member ? id : undefined);
          expect(source.arrival(id), name).toEqual(member ? entry.arrival : undefined);
          expect(source.negators(id), name).toEqual(
            inScope
              .filter((e) =>
                e.delta.claims.pointers.some(
                  (p) =>
                    p.role === "negates" &&
                    p.target.kind === "delta" &&
                    p.target.deltaRef.delta === id,
                ),
              )
              .map((e) => e.delta.id)
              .sort(compareUtf8),
          );
        }
      }
    });
  }

  it("applies a host predicate with the arrival record", async () => {
    const loaded = await load();
    const admits: StoreAdmits = (_delta, arrival) => arrival.sequence <= 38;
    const admitted = loaded.held.filter((e) => e.arrival.sequence <= 38);
    const { source } = await onSnapshot(loaded.peer, (snapshot) =>
      fetchScope(snapshot, ["bed:2", "cutting:2"], { admits }),
    );
    expect(source.ids()).toEqual(scopeOver(admitted, ["bed:2", "cutting:2"]));
    expect(source.get(idOf("b2-has-p2-neg"))).toBeUndefined();
    expect(source.get(idOf("c2-tag-neg-neg"))).toBeUndefined();
    expect(source.get(idOf("c2-tag-neg-at-b1"))?.id).toBe(idOf("c2-tag-neg-at-b1"));
  });

  it("StoreReactor.fetch takes one snapshot, makes one scope call and releases", async () => {
    const loaded = await load();
    const trace: StoreCall[] = [];
    const reactor = StoreReactor.open(countingPeer(loaded.peer, trace));
    const { source, revision } = await reactor.fetch(["cutting:2"]);
    expect(source.ids()).toEqual(scopeOver(loaded.held, ["cutting:2"]));
    expect(revision).toBe(2);
    expect(trace).toEqual([
      { op: "read", keyCount: 0, excludeCount: 0 },
      { op: "scope", keyCount: 1, excludeCount: 0 },
      { op: "release", keyCount: 0, excludeCount: 0 },
    ]);
  });
});

describe("the fetch cache", () => {
  const entry = (name: string): VerifiedDelta => ({
    delta: deltaOf.get(name)!,
    arrival: { id: idOf(name), at: 1, sequence: 1, transfer: 1, sender: "s" },
  });

  it("refuses a member whose id does not recompute, and files nothing of it", () => {
    const cache = createFetchCache();
    const forged = { ...entry("g-name"), delta: { ...entry("g-name").delta, id: idOf("b1-name") } };
    let code: string | undefined;
    try {
      cache.add([forged]);
    } catch (error) {
      code = error instanceof StoreError ? error.code : String(error);
    }
    expect(code).toBe("invalid-request");
    expect(cache.size).toBe(0);
    expect([...cache.targets("garden:1")]).toEqual([]);
  });

  it("counts what is new and keeps the first appearance of a repeated id", () => {
    const cache = createFetchCache();
    expect(cache.add([entry("c2-size"), entry("c2-size-n1")])).toBe(2);
    const again = { ...entry("c2-size"), arrival: { ...entry("c2-size").arrival, sequence: 77 } };
    expect(cache.add([again, entry("c2-size-n2")])).toBe(1);
    expect(cache.size).toBe(3);
    expect(cache.arrival(idOf("c2-size"))?.sequence).toBe(1);
    expect([...cache.ids()]).toEqual(["c2-size", "c2-size-n1", "c2-size-n2"].map(idOf));
    expect([...cache.negators(idOf("c2-size"))]).toEqual([idOf("c2-size-n1")]);
    // A sub-source knows its own members only.
    const source = cache.source([idOf("c2-size"), idOf("c2-size-n2"), "not-held"]);
    expect(source.ids()).toEqual([idOf("c2-size"), idOf("c2-size-n2")].sort(compareUtf8));
    expect(source.negators(idOf("c2-size"))).toEqual([]);
    expect(source.negators(idOf("c2-size-n1"))).toEqual([idOf("c2-size-n2")]);
    expect(source.get(idOf("c2-size-n1"))).toBeUndefined();
    expect(source.arrival(idOf("c2-size-n1"))).toBeUndefined();
  });

  const refusal = (run: () => unknown): string | undefined => {
    try {
      run();
    } catch (error) {
      return error instanceof StoreError ? error.code : String(error);
    }
    return undefined;
  };
  const bytesMember = (payload: unknown): VerifiedDelta => {
    const delta = makeDelta({
      timestamp: 1,
      validFrom: 1,
      author: "did:key:zAlice",
      pointers: [
        { role: "subject", target: { kind: "entity", entity: { id: "box:1", context: "blob" } } },
        {
          role: "value",
          target: {
            kind: "bytes",
            mime: "application/octet-stream",
            value: new Uint8Array([1, 2, 3]),
          },
        },
      ],
    });
    const claims = {
      ...delta.claims,
      pointers: [
        delta.claims.pointers[0]!,
        {
          role: "value",
          target: { kind: "bytes", mime: "application/octet-stream", value: payload },
        },
      ],
    };
    return {
      delta: { id: delta.id, claims: claims as Delta["claims"] },
      arrival: { id: delta.id, at: 1, sequence: 1, transfer: 1, sender: "s" },
    };
  };
  const payloadOf = (delta: Delta | undefined): Uint8Array => {
    const target = delta!.claims.pointers[1]!.target;
    if (target.kind !== "bytes") throw new Error("not a bytes target");
    return target.value;
  };

  it("refuses a member with no arrival record, or one that names another id", () => {
    const cache = createFetchCache();
    const bare = { delta: entry("g-name").delta } as unknown as VerifiedDelta;
    expect(refusal(() => cache.add([bare]))).toBe("invalid-request");
    const other = {
      ...entry("g-name"),
      arrival: { ...entry("g-name").arrival, id: idOf("b1-name") },
    };
    expect(refusal(() => cache.add([other]))).toBe("invalid-request");
    expect(cache.size).toBe(0);
    expect(cache.add([entry("g-name")])).toBe(1);
  });

  it("refuses bytes that are not a Uint8Array, and never converts them", () => {
    const cache = createFetchCache();
    expect(refusal(() => cache.add([bytesMember([1, 2, 3])]))).toBe("invalid-request");
    expect(refusal(() => cache.add([bytesMember(new Uint8Array([1, 2, 3]).buffer)]))).toBe(
      "invalid-request",
    );
    expect(cache.size).toBe(0);
  });

  it("a refused call files nothing, also the good members before the bad one", () => {
    const cache = createFetchCache();
    const forged = { ...entry("g-name"), delta: { ...entry("g-name").delta, id: idOf("b1-name") } };
    expect(refusal(() => cache.add([entry("c2-size"), entry("c2-size-n1"), forged]))).toBe(
      "invalid-request",
    );
    expect(cache.size).toBe(0);
    expect([...cache.ids()]).toEqual([]);
    expect([...cache.negators(idOf("c2-size"))]).toEqual([]);
  });

  it("owns what it holds: bytes the driver reuses after `scope` change nothing", async () => {
    const member = bytesMember(new Uint8Array([1, 2, 3]));
    const cache = createFetchCache();
    cache.add([member]);
    payloadOf(member.delta).fill(9);
    expect(payloadOf(cache.get(member.delta.id))).toEqual(new Uint8Array([1, 2, 3]));
    // Through fetchScope: the driver writes into its buffer once the answer is handed over.
    const fresh = bytesMember(new Uint8Array([1, 2, 3]));
    const snapshot = {
      revision: 1,
      scope: async () => ({
        deltas: [fresh],
        applied: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
      }),
    } as unknown as Snapshot;
    const { source } = await fetchScope(snapshot, ["box:1"]);
    payloadOf(fresh.delta).fill(7);
    expect(payloadOf(source.get(fresh.delta.id))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("owns what it holds: a caller that changes an answer changes no later answer", () => {
    const cache = createFetchCache();
    cache.add([entry("c2-size"), entry("c2-size-n1"), bytesMember(new Uint8Array([1, 2, 3]))]);
    const box = bytesMember(new Uint8Array()).delta.id;
    const source = cache.source([idOf("c2-size"), idOf("c2-size-n1"), box]);
    // An index answer cannot be pushed into.
    for (const list of [
      source.targets("cutting:2"),
      source.negators(idOf("c2-size")),
      source.ids(),
    ])
      expect(() => (list as string[]).push("forged")).toThrow(TypeError);
    expect(cache.targets("cutting:2")).not.toBeInstanceOf(Set);
    expect([...cache.targets("cutting:2")]).toEqual([idOf("c2-size")]);
    // A delta, its claims, its payload and its arrival record are copies.
    for (const get of [(id: string) => cache.get(id), (id: string) => source.get(id)]) {
      const got = get(idOf("c2-size"))!;
      (got.claims as { timestamp: number }).timestamp = 0;
      (got.claims.pointers as unknown[]).length = 0;
      payloadOf(get(box)).fill(5);
    }
    for (const arrival of [cache.arrival(idOf("c2-size"))!, source.arrival(idOf("c2-size"))!])
      (arrival as { sequence: number }).sequence = 99;
    for (const get of [(id: string) => cache.get(id), (id: string) => source.get(id)]) {
      expect(get(idOf("c2-size"))).toEqual(entry("c2-size").delta);
      expect(payloadOf(get(box))).toEqual(new Uint8Array([1, 2, 3]));
    }
    expect(cache.arrival(idOf("c2-size"))?.sequence).toBe(1);
    expect(source.arrival(idOf("c2-size"))?.sequence).toBe(1);
    expect(source.targets("cutting:2")).toEqual([idOf("c2-size")]);
    // Two reads of one id share nothing.
    expect(cache.get(box)).not.toBe(cache.get(box));
    expect(payloadOf(source.get(box))).not.toBe(payloadOf(source.get(box)));
  });

  it("indexes a delta with two pointers at one entity once, and no other pointer at a delta as a negation", () => {
    const cache = createFetchCache();
    cache.add([entry("b2-name-twice"), entry("c2-size"), entry("c2-size-remark")]);
    expect([...cache.targets("bed:2")]).toEqual([idOf("b2-name-twice")]);
    expect([...cache.negators(idOf("c2-size"))]).toEqual([]);
    const source = cache.source([...cache.ids()]);
    expect(source.targets("bed:2")).toEqual([idOf("b2-name-twice")]);
    expect(source.negators(idOf("c2-size"))).toEqual([]);
    expect(source.targets("cutting:2")).toEqual(
      [idOf("c2-size"), idOf("c2-size-remark")].sort(compareUtf8),
    );
  });

  it("unappliedFields is the requested fields the store did not report applied", () => {
    const none = { timestampAtMost: false, arrivalAtMost: false, excludeIds: false };
    expect(unappliedFields(undefined, none)).toEqual([]);
    expect(unappliedFields({ timestampAtMost: 1, excludeIds: [] }, none)).toEqual([
      "timestampAtMost",
      "excludeIds",
    ]);
    expect(
      unappliedFields({ timestampAtMost: 1, arrivalAtMost: 2 }, { ...none, timestampAtMost: true }),
    ).toEqual(["arrivalAtMost"]);
  });
});
