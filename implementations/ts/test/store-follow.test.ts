// Following the change feed (SPEC-18 proposal §4.6, "Following the feed"; vectors/store/README.md
// §10): the shared vectors `follow.json` against the memory store and the TypeScript cursor, the
// wrong followers each witness keeps, the cursor's own rules, a fuzz against brute force, and two
// timed cost rails.
//
// Not covered here: the feed itself (store-feed.test.ts and the scripts). The follower's mirror is
// the runner's and the fuzz's: the cursor hands out records and bytes, and a host applies them.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareUtf8 } from "../src/delta/cbor.js";
import { makeDelta, makeNegationClaims } from "../src/delta/set.js";
import type { Delta, Pointer } from "../src/delta/types.js";
import { StoreReactor, fetchScope } from "../src/reactor/store-read.js";
import {
  runFollowConformance,
  type FeedFollower,
  type FollowStoreRequest,
} from "../src/storage/follow-conformance.js";
import { followVectors } from "../src/storage/follow-vectors.js";
import {
  followFeed,
  parsePosition,
  positionOf,
  type FeedCursor,
  type Position,
  type Pull,
} from "../src/storage/follow.js";
import { createMemoryStore, type MemoryStoreOptions } from "../src/storage/memory-store.js";
import {
  StoreConformanceError,
  type StoreConformanceFailure,
} from "../src/storage/store-conformance.js";
import type { StoreFollowDocument } from "../src/storage/store-vector-format.js";
import type { ArrivalRecord } from "../src/storage/arrival-record.js";
import {
  StoreError,
  type ChangeRetention,
  type Id,
  type PeerStore,
  type VerifiedDelta,
} from "../src/storage/store.js";
import { broken, sparse, type Break } from "./support/broken-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const committed = readFileSync(resolve(here, "../../../vectors/store/follow.json"), "utf8");
const document = JSON.parse(committed) as StoreFollowDocument;

const WITNESS: FeedFollower = { positionOf, follow: followFeed };

/** A factory over a broken (or right) memory store; a case's own store fields win. */
const factoryOf =
  (fault: Break = {}) =>
  async (request: FollowStoreRequest) =>
    broken({ ...fault, options: { ...fault.options, ...request } })();

async function failures(
  witness: FeedFollower,
  fault: Break = {},
  vectors: StoreFollowDocument = document,
): Promise<readonly StoreConformanceFailure[]> {
  try {
    await runFollowConformance(factoryOf(fault), witness, vectors);
    return [];
  } catch (error) {
    if (error instanceof StoreConformanceError) return error.failures;
    throw error;
  }
}

// ---- the vectors ------------------------------------------------------------------------------

/** The runs of README §10.4. */
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

describe("follow vectors", () => {
  it("the committed file is the model's output", () => {
    expect(committed).toBe(`${JSON.stringify(followVectors(), null, 2)}\n`);
  });

  for (const [name, fault] of Object.entries(RUNS))
    it(`pass on the memory store: ${name}`, async () => {
      const report = await runFollowConformance(factoryOf(fault), WITNESS, document);
      expect(report.skipped).toEqual([]);
      expect(report.passed).toHaveLength(document.cases.length);
    });

  it("a store with no feed skips every case and names the requirement", async () => {
    const report = await runFollowConformance(
      factoryOf({ profile: (p) => ({ ...p, changeRetention: "none" }) }),
      WITNESS,
      document,
    );
    expect(report.skipped.map((s) => s.missing)).toEqual(document.cases.map(() => "changes"));
  });

  it("a factory that cannot build a case's store skips that case", async () => {
    const report = await runFollowConformance(
      async (request) =>
        request.changeRetention === undefined && request.changePageSize === undefined
          ? createMemoryStore()
          : undefined,
      WITNESS,
      document,
    );
    expect(report.skipped).toEqual([
      { name: "follow/pages-of-one", missing: "store" },
      { name: "follow/retention-too-short", missing: "store" },
    ]);
  });
});

// ---- wrong followers --------------------------------------------------------------------------

/** One way a follower can be wrong. Each is the cursor of `quirky` with one rule broken. */
type Quirk =
  | "drops removed"
  | "arrival order"
  | "repeats"
  | "two pages"
  | "moves on resync"
  | "past through"
  | "past the snapshot"
  | "no history check"
  | "history after the feed"
  | "no to"
  | "get on an empty page"
  | "no release"
  | "not sticky"
  | "missing is an error"
  | "feed when ahead"
  | "feed at equal revisions"
  | "current is the position"
  | "keeps the first arrival"
  | "changes claims"
  | "another history"
  | "no progress"
  | "lags"
  | "no bytes"
  | "resync as ok";

/**
 * A second cursor, written for the rails: the contract of §4.6 with one rule broken at a time.
 * With no quirk it must pass every run, which the table below checks first.
 */
function quirky(quirk?: Quirk): FeedFollower {
  return {
    positionOf,
    follow(peer: PeerStore, from: Position): FeedCursor {
      let at: Position = from;
      let stopped: Pull | undefined;
      const first = new Map<Id, ArrivalRecord>();
      const is = (q: Quirk): boolean => quirk === q;
      return {
        get position() {
          return at;
        },
        async pull(): Promise<Pull> {
          if (stopped !== undefined && !is("not sticky")) return stopped;
          const s = await peer.read();
          try {
            const current = { history: s.history, revision: s.revision };
            const resync = (): Pull => {
              if (is("resync as ok"))
                return { status: "ok", position: at, records: [], deltas: [] };
              const answer: Pull = {
                status: "resync-required",
                current: is("current is the position") ? at : current,
              };
              stopped = answer;
              if (is("moves on resync")) at = current;
              return answer;
            };
            const sameHistory = is("no history check") || s.history === at.history;
            if (!sameHistory && !is("history after the feed")) return resync();
            if (s.revision < at.revision && !is("feed when ahead")) return resync();
            if (s.revision === at.revision && !is("feed at equal revisions"))
              return { status: "ok", position: at, records: [], deltas: [] };
            let page = await peer.changes(at.revision, is("no to") ? undefined : s.revision);
            if (is("two pages") && page.status === "ok" && page.through < s.revision) {
              const more = await peer.changes(page.through, s.revision);
              if (more.status === "ok")
                page = {
                  status: "ok",
                  records: [...page.records, ...more.records],
                  through: more.through,
                };
            }
            if (!sameHistory) return resync();
            if (page.status !== "ok") return resync();
            const ids = [...new Set(page.records.flatMap((r) => r.added))].sort(compareUtf8);
            let deltas: VerifiedDelta[] = [];
            if (ids.length > 0 || is("get on an empty page")) {
              const got = await s.get(ids);
              const arrivals = await s.arrivals(ids);
              if (is("missing is an error") && got.length < ids.length)
                throw new Error("a delta of the page is missing");
              deltas = got.map((delta, i) => ({ delta, arrival: arrivals[i]! }));
            }
            if (is("arrival order")) deltas.sort((a, b) => a.arrival.sequence - b.arrival.sequence);
            if (is("repeats"))
              deltas = page.records.flatMap((r) =>
                deltas.filter((d) => r.added.includes(d.delta.id)),
              );
            if (is("keeps the first arrival"))
              deltas = deltas.map((d) => {
                const kept = first.get(d.delta.id) ?? d.arrival;
                first.set(d.delta.id, kept);
                return { ...d, arrival: kept };
              });
            if (is("changes claims"))
              deltas = deltas.map((d) => ({
                ...d,
                delta: { ...d.delta, claims: { ...d.delta.claims, timestamp: -1 } },
              }));
            if (is("no bytes")) deltas = [];
            const records = is("drops removed")
              ? page.records.map((r) => ({ ...r, removed: [] }))
              : page.records;
            const through = is("past through")
              ? page.through + 1
              : is("past the snapshot")
                ? s.revision + 1
                : is("no progress")
                  ? at.revision
                  : page.through;
            const position = {
              history: is("another history") ? "elsewhere" : at.history,
              revision: through,
            };
            if (!is("lags")) at = position;
            return {
              status: "ok",
              position,
              records: is("no progress") ? [] : records,
              deltas: is("no progress") ? [] : deltas,
            };
          } finally {
            if (!is("no release")) s.release();
          }
        },
      };
    },
  };
}

const FOLLOWERS: readonly {
  readonly quirk: Quirk;
  readonly fails: string;
  readonly message: string;
  /** The run, when only a store that keeps fewer records reaches the rule. */
  readonly run?: string;
  /** Exactly the cases that catch it: without them the follower passes the document. */
  readonly only?: readonly string[];
}[] = [
  {
    quirk: "drops removed",
    fails: "follow/a-purge-of-a-held-id",
    message: "the pull's record at revision 2 differs from its commit",
  },
  {
    quirk: "arrival order",
    fails: "follow/several-records-in-one-page",
    message: "the pull's deltas are not ascending by id and distinct",
    only: ["several-records-in-one-page", "pages-of-one", "a-follower-started-mid-history"],
  },
  {
    quirk: "repeats",
    fails: "follow/add-purge-add-in-one-page",
    message: "the pull's deltas are not ascending by id and distinct",
    // Mid-history, one page names three ids over two records: a list per record is out of order.
    only: ["add-purge-add-in-one-page", "a-follower-started-mid-history"],
  },
  {
    quirk: "two pages",
    fails: "follow/pages-of-one",
    message: "pull made the call changes(2, 4) where the contract asks for get [",
    only: ["pages-of-one"],
  },
  {
    quirk: "moves on resync",
    fails: "follow/retention-too-short",
    message: "the cursor moved after resync-required",
    only: [
      "retention-too-short",
      "a-position-from-the-future",
      "another-peers-history",
      "pull-after-resync",
    ],
  },
  {
    quirk: "past through",
    fails: "follow/pages-of-one",
    message: "the pull's records are at [2], expected [2 3]",
  },
  {
    quirk: "past the snapshot",
    fails: "follow/one-append",
    message: "the pull's position 3 lies outside [1, 2]",
  },
  {
    quirk: "no history check",
    fails: "follow/another-peers-history",
    message: "pull answered ok, expected resync-required",
    only: ["another-peers-history"],
  },
  {
    quirk: "history after the feed",
    fails: "follow/another-peers-history",
    message: "pull made the call changes(1, 2) where the contract asks for release",
    only: ["another-peers-history"],
  },
  {
    quirk: "no to",
    fails: "follow/one-append",
    message: "pull made the call changes(1, none) where the contract asks for changes(1, 2)",
  },
  {
    quirk: "get on an empty page",
    fails: "follow/a-head-only-commit",
    message: "pull made the call get [] where the contract asks for release",
  },
  {
    quirk: "no release",
    fails: "follow/nothing-new",
    message: "pull made no call where the contract asks for release",
  },
  {
    quirk: "not sticky",
    fails: "follow/pull-after-resync",
    message: "pull answered ok, expected resync-required",
    // There a second pull asks the store again and gets the same answer: a call after the last.
    only: ["pull-after-resync", "retention-too-short"],
  },
  {
    quirk: "missing is an error",
    fails: "follow/add-then-purge-in-one-page",
    message: "a delta of the page is missing",
  },
  {
    quirk: "feed when ahead",
    fails: "follow/a-position-from-the-future",
    message: "pull refused with invalid-request",
  },
  {
    quirk: "feed at equal revisions",
    fails: "follow/nothing-new",
    message: "pull made the call changes(1, 1) where the contract asks for release",
  },
  {
    quirk: "current is the position",
    fails: "follow/a-position-from-the-future",
    message: "pull reports resync-required with current 3, expected 1",
  },
  {
    quirk: "keeps the first arrival",
    fails: "follow/add-purge-add-across-pulls",
    message: "the pull delivered ",
    only: ["add-purge-add-across-pulls"],
  },
  {
    quirk: "changes claims",
    fails: "follow/one-append",
    message: "as another appearance",
  },
  {
    quirk: "another history",
    fails: "follow/one-append",
    message: "the pull moved the cursor to another history",
  },
  {
    quirk: "no progress",
    fails: "follow/one-append",
    message: "the pull from 1 made no progress toward 2",
  },
  {
    quirk: "lags",
    fails: "follow/one-append",
    message: "the cursor stands at 1, not at the pull's position 2",
  },
  {
    quirk: "no bytes",
    fails: "follow/one-append",
    message: "the pull delivered [], expected [",
  },
  {
    quirk: "resync as ok",
    fails: "follow/retention-too-short",
    message: "pull answered ok, expected resync-required",
  },
  {
    quirk: "resync as ok",
    fails: "follow/several-records-in-one-page",
    run: "two records kept",
    message: "pull answered ok for a position below the retention floor 2",
  },
];

describe("follow vectors: wrong followers fail", () => {
  it("the rails' own cursor passes every run with no quirk", async () => {
    for (const [name, fault] of Object.entries(RUNS))
      expect(await failures(quirky(), fault), name).toEqual([]);
  });

  for (const row of FOLLOWERS)
    it(`${row.quirk}${row.run === undefined ? "" : ` (${row.run})`}`, async () => {
      const found = await failures(quirky(row.quirk), RUNS[row.run ?? "as built"]);
      const own = found.find((f) => f.name === row.fails);
      expect(own?.message, JSON.stringify(found, null, 1)).toContain(row.message);
      if (row.only === undefined) return;
      expect(found.map((f) => f.name).sort()).toEqual(row.only.map((n) => `follow/${n}`).sort());
      // Without the cases that catch it, the follower passes the document.
      const without = {
        ...document,
        cases: document.cases.filter((c) => !row.only!.includes(c.name)),
      };
      expect(await failures(quirky(row.quirk), {}, without)).toEqual([]);
    });
});

// ---- the cursor's own rules -------------------------------------------------------------------

const PEER = `ed25519:${"0f".repeat(32)}`;
const OTHER = `ed25519:${"0e".repeat(32)}`;
const at = (id: string): Pointer => ({
  role: "subject",
  target: { kind: "entity", entity: { id, context: "c" } },
});
const fact = (entity: string, t: number): Delta =>
  makeDelta({
    timestamp: t,
    validFrom: t,
    author: "did:key:zA",
    pointers: [at(entity), { role: "value", target: { kind: "primitive", value: t } }],
  });

/** One writer of one peer of a store; `other` is a second peer of the same store. */
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
    async position(): Promise<Position> {
      const snapshot = await peer.read();
      snapshot.release();
      return positionOf(snapshot);
    },
  };
}

/** A peer handle that writes each call's name, and `release`, to `trace`. */
function traced(peer: PeerStore, trace: string[]): PeerStore {
  return {
    ...peer,
    history: peer.history,
    read: async () => {
      trace.push("read");
      const s = await peer.read();
      return {
        ...s,
        history: s.history,
        revision: s.revision,
        get: (ids) => (trace.push("get"), s.get(ids)),
        arrivals: (ids) => (trace.push("arrivals"), s.arrivals(ids)),
        release: () => (trace.push("release"), s.release()),
      };
    },
    changes: (from, to) => (
      trace.push(`changes(${from}, ${to ?? "none"})`),
      peer.changes(from, to)
    ),
  };
}

describe("positions", () => {
  it("positionOf is the snapshot's history and revision, frozen", async () => {
    const w = await writer();
    await w.append([fact("plant:a", 1)]);
    const snapshot = await w.peer.read();
    const position = positionOf(snapshot);
    snapshot.release();
    expect(position).toEqual({ history: w.peer.history, revision: 1 });
    expect(Object.isFrozen(position)).toBe(true);
  });

  it("followFeed refuses a malformed position and makes no store call", async () => {
    const w = await writer();
    const trace: string[] = [];
    const peer = traced(w.peer, trace);
    for (const bad of [
      { history: "", revision: 0 },
      { history: "h", revision: -1 },
      { history: "h", revision: 1.5 },
      { history: "h", revision: Number.NaN },
      { history: "h", revision: 2 ** 53 },
      { history: 7, revision: 0 },
      null,
    ])
      expect(() => followFeed(peer, bad as unknown as Position), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: "invalid-request" }),
      );
    const cursor = followFeed(peer, await w.position());
    expect(cursor.position).toEqual({ history: w.peer.history, revision: 0 });
    expect(trace).toEqual([]);
  });

  it("parsePosition checks a stored position and refuses one local to its process", () => {
    expect(parsePosition(JSON.parse('{"history":"host:1","revision":3.0}'))).toEqual({
      history: "host:1",
      revision: 3,
    });
    expect(() => parsePosition({ history: "memory:local:4", revision: 3 })).toThrow(
      /local to the process.*mintHistory/,
    );
    for (const bad of [
      { history: "host:1", revision: 3, extra: 1 },
      { history: "host:1" },
      { history: "host:1", revision: 1.5 },
      { history: "", revision: 1 },
      [],
    ])
      expect(() => parsePosition(bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: "invalid-request" }),
      );
  });

  it("a read and a fetched scope carry the position of their snapshot; the reactor follows from it", async () => {
    const w = await writer();
    await w.append([fact("plant:a", 1)]);
    const reactor = StoreReactor.open(w.peer);
    const fetched = await reactor.fetch(["plant:a"]);
    expect(fetched.position).toEqual({ history: w.peer.history, revision: 1 });
    const snapshot = await w.peer.read();
    expect((await fetchScope(snapshot, ["plant:a"])).position).toEqual(positionOf(snapshot));
    snapshot.release();
    const cursor = reactor.follow(fetched.position);
    const late = fact("plant:a", 2);
    await w.append([late]);
    const pull = await cursor.pull();
    expect(pull).toMatchObject({ status: "ok", position: { revision: 2 } });
    expect(pull.status === "ok" && pull.deltas.map((d) => d.delta.id)).toEqual([late.id]);
  });
});

describe("pull", () => {
  it("after resync-required every pull answers the same, with no store call", async () => {
    const w = await writer({ changeRetention: { revisions: 1 } });
    const from = await w.position();
    await w.append([fact("plant:a", 1)]);
    await w.append([fact("plant:a", 2)]);
    const trace: string[] = [];
    const cursor = followFeed(traced(w.peer, trace), from);
    const first = await cursor.pull();
    expect(first).toEqual({
      status: "resync-required",
      current: { history: w.peer.history, revision: 2 },
    });
    expect(trace).toEqual(["read", "changes(0, 2)", "release"]);
    await w.append([fact("plant:a", 3)]);
    trace.length = 0;
    expect(await cursor.pull()).toEqual(first);
    expect(trace).toEqual([]);
    expect(cursor.position).toEqual(from);
  });

  it("resync-required carries the snapshot's position, not the store's later current", async () => {
    const w = await writer();
    await w.append([fact("plant:a", 1)]);
    const from = await w.position();
    await w.append([fact("plant:a", 2)]);
    const cursor = followFeed(
      { ...w.peer, changes: async () => ({ status: "resync-required", current: 99 }) },
      from,
    );
    expect(await cursor.pull()).toEqual({
      status: "resync-required",
      current: { history: w.peer.history, revision: 2 },
    });
  });

  it("starts again on a new snapshot when the peer moves, at most four, each released", async () => {
    const w = await writer();
    const from = await w.position();
    await w.append([fact("plant:a", 1)]);
    let moves = 1;
    let t = 10;
    const trace: string[] = [];
    const moving = traced(
      {
        ...w.peer,
        changes: async (f, to) => {
          const page = await w.peer.changes(f, to);
          if (moves-- > 0) await w.append([fact("plant:b", t++)]);
          return page;
        },
      },
      trace,
    );
    const pull = await followFeed(moving, from).pull();
    // The first snapshot refuses its get; the second reads both records.
    expect(pull).toMatchObject({ status: "ok", position: { revision: 2 } });
    expect(trace).toEqual([
      "read",
      "changes(0, 1)",
      "get",
      "release",
      "read",
      "changes(0, 2)",
      "get",
      "arrivals",
      "release",
    ]);
    moves = 4;
    trace.length = 0;
    const cursor = followFeed(moving, pull.status === "ok" ? pull.position : from);
    await w.append([fact("plant:c", 1)]);
    await expect(cursor.pull()).rejects.toMatchObject({ code: "snapshot-moved" });
    expect(trace.filter((c) => c === "read")).toHaveLength(4);
    expect(trace.filter((c) => c === "release")).toHaveLength(4);
    expect(cursor.position).toEqual({ history: w.peer.history, revision: 2 });
  });

  it("releases its snapshot on a throw and stays where it was", async () => {
    const w = await writer();
    const from = await w.position();
    await w.append([fact("plant:a", 1)]);
    const trace: string[] = [];
    const failing = traced(w.peer, trace);
    const cursor = followFeed(
      {
        ...failing,
        read: async () => ({
          ...(await failing.read()),
          get: () => Promise.reject(new StoreError("store-closed", "closed")),
        }),
      },
      from,
    );
    await expect(cursor.pull()).rejects.toMatchObject({ code: "store-closed" });
    expect(trace).toEqual(["read", "changes(0, 1)", "release"]);
    expect(cursor.position).toEqual(from);
  });

  it("fails with an error, not an answer, on a page that breaks the feed's contract", async () => {
    const w = await writer();
    const from = await w.position();
    await w.append([fact("plant:a", 1)]);
    // No progress, and records claimed past the snapshot's revision (`to + 5`).
    for (const past of [false, true]) {
      const cursor = followFeed(
        {
          ...w.peer,
          changes: async (f, to) => ({
            status: "ok",
            records: [],
            through: past ? (to ?? 0) + 5 : f,
          }),
        },
        from,
      );
      const failed = await cursor.pull().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(Error);
      expect(failed).not.toBeInstanceOf(StoreError);
      expect((failed as Error).message).toMatch(/breaks the change feed contract/);
      expect(cursor.position).toEqual(from);
    }
  });

  it("fails with an error when get and arrivals disagree on one snapshot", async () => {
    const w = await writer();
    const from = await w.position();
    await w.append([fact("plant:a", 1)]);
    const cursor = followFeed(
      {
        ...w.peer,
        read: async () => ({ ...(await w.peer.read()), arrivals: async () => [] }),
      },
      from,
    );
    await expect(cursor.pull()).rejects.toThrow(/get and arrivals/);
  });

  it("pulls on one cursor run one at a time, in call order", async () => {
    const w = await writer();
    const from = await w.position();
    await w.append([fact("plant:a", 1)]);
    const trace: string[] = [];
    const cursor = followFeed(traced(w.peer, trace), from);
    const [a, b] = await Promise.all([cursor.pull(), cursor.pull()]);
    expect(a).toMatchObject({ status: "ok", position: { revision: 1 } });
    expect(b).toMatchObject({ status: "ok", position: { revision: 1 }, records: [] });
    expect(trace).toEqual([
      "read",
      "changes(0, 1)",
      "get",
      "arrivals",
      "release",
      "read",
      "release",
    ]);
  });

  it("never hands out the bytes of a purged delta, also while another peer holds them", async () => {
    const w = await writer();
    const other = await w.store.createPeer(OTHER, { erasure: "unproven" });
    const shared = fact("plant:a", 1);
    const arrival = { id: shared.id, at: 1, sequence: 1, transfer: 1, sender: "x" };
    await other.append({
      expectedHead: null,
      nextHead: "o1",
      frame: null,
      added: [{ delta: shared, arrival }],
    });
    const from = await w.position();
    await w.append([shared]);
    expect((await w.peer.purge([shared.id])).targets[0]!.outcome).toBe("held-by-other-peer");
    const pull = await followFeed(w.peer, from).pull();
    expect(pull).toMatchObject({ status: "ok", position: { revision: 2 }, deltas: [] });
    expect(pull.status === "ok" && pull.records.map((r) => [r.added, r.removed])).toEqual([
      [[shared.id], []],
      [[], [shared.id]],
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

type Held = Map<Id, VerifiedDelta>;
type ModelRecord = { revision: number; added: Id[]; removed: Id[] };
/** Three ways to apply an ok pull to a mirror. Only `rule` is the contract's (SPEC-18 §4.6). */
type Apply = "rule" | "batch" | "ignores removed";

function applyPull(mirror: Held, pull: Extract<Pull, { status: "ok" }>, how: Apply): void {
  const delivered = new Map(pull.deltas.map((d) => [d.delta.id, d]));
  if (how === "batch") {
    // Every removal of the page first, then every delivered delta.
    for (const record of pull.records) for (const id of record.removed) mirror.delete(id);
    for (const [id, delta] of delivered) mirror.set(id, delta);
    return;
  }
  for (const record of pull.records) {
    if (how === "rule") for (const id of record.removed) mirror.delete(id);
    for (const id of record.added) {
      const delta = delivered.get(id);
      if (delta !== undefined) mirror.set(id, delta);
    }
  }
}

const heldText = (held: ReadonlyMap<Id, VerifiedDelta>, only?: (id: Id) => boolean): string =>
  JSON.stringify(
    [...held.keys()]
      .filter((id) => only === undefined || only(id))
      .sort(compareUtf8)
      .map((id) => [id, held.get(id)!.arrival]),
  );

type FuzzTally = {
  ok: number;
  resync: number;
  quiet: number;
  /** Quiet points where a wrong way to apply the pulls missed the holdings. */
  wrong: Record<Exclude<Apply, "rule">, number>;
};

/** One random sequence of commits on two peers and pulls on a follower of the first. */
async function fuzzOne(seed: number, tally: FuzzTally): Promise<void> {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const fail = (why: string): never => {
    throw new Error(`seed ${seed}: ${why}`);
  };
  const corpus: Delta[] = [];
  for (let i = 0; i < 7; i++)
    corpus.push(
      i > 0 && next() < 0.25
        ? makeDelta(makeNegationClaims("did:key:zB", i, pick(corpus).id))
        : fact(pick(["e0", "e1", "e2"]), i),
    );
  const keep = next() < 0.4 ? 1 + Math.floor(next() * 4) : Number.POSITIVE_INFINITY;
  const pageSize = next() < 0.5 ? undefined : 1 + Math.floor(next() * 3);
  const retention: ChangeRetention = keep === Infinity ? "unbounded" : { revisions: keep };
  const store = createMemoryStore({
    changeRetention: retention,
    ...(pageSize === undefined ? {} : { changePageSize: pageSize }),
  });

  // The model of each peer: holdings with arrival records, every record, the holdings after each.
  type ModelPeer = {
    handle: PeerStore;
    held: Held;
    records: ModelRecord[];
    at: Map<number, Held>;
    revision: number;
    head: string | null;
    sequence: number;
  };
  const peers: ModelPeer[] = [];
  for (const id of [PEER, OTHER])
    peers.push({
      handle: await store.createPeer(id, { erasure: "unproven" }),
      held: new Map(),
      records: [],
      at: new Map([[0, new Map()]]),
      revision: 0,
      head: null,
      sequence: 0,
    });
  const [A, B] = peers as [ModelPeer, ModelPeer];
  const advance = (p: ModelPeer, added: Id[], removed: Id[]): void => {
    p.revision += 1;
    p.records.push({ revision: p.revision, added, removed });
    p.at.set(p.revision, new Map(p.held));
  };
  const append = async (p: ModelPeer): Promise<void> => {
    const deltas = next() < 0.2 ? [] : corpus.filter(() => next() < 0.3);
    const nextHead = `h${p.revision + 1}`;
    const added = deltas.map((delta) => ({
      delta,
      arrival: { id: delta.id, at: 1, sequence: ++p.sequence, transfer: 1, sender: "fuzz" },
    }));
    const result = await p.handle.append({
      expectedHead: p.head,
      nextHead,
      frame: null,
      added,
    });
    if (result.status !== "committed") fail(`append answered ${result.status}`);
    p.head = nextHead;
    const fresh = added.filter((e) => !p.held.has(e.delta.id));
    for (const entry of fresh) p.held.set(entry.delta.id, entry);
    advance(p, fresh.map((e) => e.delta.id).sort(compareUtf8), []);
  };
  const purge = async (p: ModelPeer): Promise<void> => {
    const ids = corpus.map((d) => d.id).filter(() => next() < 0.35);
    await p.handle.purge(ids);
    const released = [...new Set(ids)].filter((id) => p.held.has(id)).sort(compareUtf8);
    for (const id of released) p.held.delete(id);
    if (released.length > 0) advance(p, [], released);
  };
  const floor = (p: ModelPeer): number =>
    p.records.length > keep ? p.records[p.records.length - keep - 1]!.revision : 0;

  // A follower starts from a full read of A on one snapshot.
  type Follower = { cursor: FeedCursor; mirrors: Record<Apply, Held>; stopped?: Position };
  const start = async (): Promise<Follower> => {
    const snapshot = await A.handle.read();
    const ids = corpus.map((d) => d.id).sort(compareUtf8);
    const deltas = await snapshot.get(ids);
    const arrivals = await snapshot.arrivals(ids);
    const position = positionOf(snapshot);
    snapshot.release();
    const mirror: Held = new Map(
      deltas.map((delta, i) => [delta.id, { delta, arrival: arrivals[i]! }]),
    );
    if (position.revision !== A.revision || heldText(mirror) !== heldText(A.held))
      fail("the full read is not the model's holdings");
    return {
      cursor: followFeed(A.handle, position),
      mirrors: { rule: mirror, batch: new Map(mirror), "ignores removed": new Map(mirror) },
    };
  };
  let f = await start();

  for (let step = 0; step < 24; step++) {
    const r = next();
    if (r < 0.25) await append(A);
    else if (r < 0.4) await purge(A);
    else if (r < 0.5) await append(B);
    else if (r < 0.58) await purge(B);
    else {
      const from = f.cursor.position.revision;
      const pull = await f.cursor.pull();
      // The model's answer: resync-required exactly below the floor, and after it.
      if (f.stopped !== undefined || from < floor(A)) {
        const current = f.stopped ?? { history: A.handle.history, revision: A.revision };
        if (
          pull.status !== "resync-required" ||
          JSON.stringify(pull.current) !== JSON.stringify(current)
        )
          fail(
            `pull answered ${JSON.stringify(pull)}, the model says resync-required at ${current.revision}`,
          );
        if (f.stopped !== undefined) {
          tally.resync += 1;
          f = await start();
        } else f.stopped = current;
        continue;
      }
      if (pull.status !== "ok") return fail(`pull answered ${pull.status}, the model says ok`);
      tally.ok += 1;
      const end = A.revision;
      const pending = A.records.filter((rec) => rec.revision > from);
      const page = pageSize === undefined ? pending : pending.slice(0, pageSize);
      const through = page.length === pending.length ? end : page[page.length - 1]!.revision;
      const expected = {
        position: through,
        records: JSON.stringify(page),
        delivered: heldText(A.held, (id) => page.some((rec) => rec.added.includes(id))),
      };
      const got = {
        position: pull.position.revision,
        records: JSON.stringify(
          pull.records.map((rec) => ({
            revision: rec.revision,
            added: rec.added,
            removed: rec.removed,
          })),
        ),
        delivered: heldText(new Map(pull.deltas.map((d) => [d.delta.id, d]))),
      };
      if (JSON.stringify(got) !== JSON.stringify(expected))
        fail(`pull answered ${JSON.stringify(got)}, the model says ${JSON.stringify(expected)}`);
      for (const how of ["rule", "batch", "ignores removed"] as const)
        applyPull(f.mirrors[how], pull, how);
      // Between quiet points: the mirror is the holdings at the position, except for the ids a
      // record after the position names; a later pull fixes those.
      const later = new Set(
        A.records
          .filter((rec) => rec.revision > through)
          .flatMap((rec) => [...rec.added, ...rec.removed]),
      );
      const settled = (id: Id): boolean => !later.has(id);
      if (heldText(f.mirrors.rule, settled) !== heldText(A.at.get(through)!, settled))
        fail(`after the pull to ${through} the mirror is not the holdings there`);
      if (through === end) {
        tally.quiet += 1;
        if (heldText(f.mirrors.rule) !== heldText(A.held))
          fail(`at the quiet point ${end} the mirror is not the holdings`);
        for (const how of ["batch", "ignores removed"] as const)
          if (heldText(f.mirrors[how]) !== heldText(A.held)) {
            tally.wrong[how] += 1;
            f.mirrors[how] = new Map(A.held);
          }
      }
    }
  }
  await store.close();
}

const FUZZ = Number(process.env["FOLLOW_FUZZ"] ?? 2000);

describe("following against brute force", () => {
  it(`${FUZZ} random sequences: the mirror is the holdings at every quiet point`, async () => {
    const tally: FuzzTally = {
      ok: 0,
      resync: 0,
      quiet: 0,
      wrong: { batch: 0, "ignores removed": 0 },
    };
    for (let seed = 1; seed <= FUZZ; seed++) await fuzzOne(seed, tally);
    console.log(
      `follow fuzz: ${FUZZ} sequences, ${tally.ok} ok pulls, ${tally.quiet} quiet points, ${tally.resync} resyncs; wrong appliers missed: ${JSON.stringify(tally.wrong)}`,
    );
    expect(tally.quiet).toBeGreaterThan(FUZZ);
    expect(tally.resync).toBeGreaterThan(FUZZ / 20);
    // A mirror that ignores `removed` is wrong; one that applies a page's removals before its
    // additions is right at every quiet point (SPEC-18 §4.13, reading 58).
    expect(tally.wrong["ignores removed"]).toBeGreaterThan(0);
    expect(tally.wrong.batch).toBe(0);
  }, 600_000);
});

// ---- the cost rails ---------------------------------------------------------------------------

describe("cost rail: a pull costs its page", () => {
  // Timed from outside with a monotonic clock, as vectors/store/README.md §3.9.9: N pulls at N and
  // at 8N, the run at N the fastest of five, at 8N the fastest of three, stopped at the first
  // under the bound. Each pull reads one fixed page of PAGE records, whatever the peer holds or
  // wrote before the position: the total scales by about 8. A pull that walks the holdings or the
  // earlier records costs N per call: the total scales by about 64.
  const BOUND = 24;
  const PAGE = 16;

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

  /** N pulls, each by a new cursor at `from`, each reading the same page of PAGE records. */
  const timed = (peer: PeerStore, from: Position, n: number) => async () => {
    const start = performance.now();
    for (let i = 0; i < n; i++) {
      const pull = await followFeed(peer, from).pull();
      if (pull.status !== "ok" || pull.records.length !== PAGE) throw new Error(pull.status);
    }
    return performance.now() - start;
  };
  const page = async (w: Awaited<ReturnType<typeof writer>>) => {
    for (let i = 0; i < PAGE; i++) await w.append(i % 4 === 0 ? [fact("new", 2_000_000 + i)] : []);
  };

  it(`N holdings: N pulls cost less than ${BOUND} times at 8N`, async () => {
    await scaling("pull beside N holdings", async (n) => {
      const w = await writer();
      await w.append(Array.from({ length: n }, (_, i) => fact(`bulk:${i}`, i)));
      const from = await w.position();
      await page(w);
      return timed(w.peer, from, n);
    });
  }, 600_000);

  it(`N records before the position: N pulls cost less than ${BOUND} times at 8N`, async () => {
    await scaling("pull after N earlier records", async (n) => {
      const w = await writer();
      for (let i = 0; i < n; i++) await w.append([]);
      const from = await w.position();
      await page(w);
      return timed(w.peer, from, n);
    });
  }, 600_000);
});

// ---- the follow step and the document ----------------------------------------------------------

describe("follow vectors: wrong positions and wrong documents fail", () => {
  const FOLLOW_ROWS: readonly { name: string; witness: FeedFollower; message: string }[] = [
    {
      name: "a position of another history",
      witness: { ...WITNESS, positionOf: (s) => ({ history: "elsewhere", revision: s.revision }) },
      message: "the position's history is not its snapshot's",
    },
    {
      name: "a position of another revision",
      witness: {
        ...WITNESS,
        positionOf: (s) => ({ history: s.history, revision: s.revision + 1 }),
      },
      message: "the position is of revision 2, expected 1",
    },
    {
      name: "a cursor that starts at the snapshot's revision whatever it is given",
      witness: {
        ...WITNESS,
        follow: (peer, from) => followFeed(peer, { ...from, revision: 1 }),
      },
      message: "a new cursor stands at 1, not at the position it was given",
    },
    {
      name: "following that reads the store",
      witness: {
        ...WITNESS,
        follow: (peer, from) => (void peer.read().then((s) => s.release()), followFeed(peer, from)),
      },
      message: "following made the call read; it makes no store call",
    },
  ];
  for (const row of FOLLOW_ROWS)
    it(row.name, async () => {
      const found = await failures(row.witness);
      expect(found.length, JSON.stringify(found, null, 1)).toBeGreaterThan(0);
      expect(found.map((f) => f.message).join("\n")).toContain(row.message);
    });

  /** The document with one step of one case changed. */
  const edited = (
    name: string,
    op: string,
    nth: number,
    change: (step: Record<string, unknown>) => void,
  ): StoreFollowDocument => {
    const copy = JSON.parse(committed) as StoreFollowDocument;
    const steps = copy.cases.find((c) => c.name === name)!.steps as unknown as Record<
      string,
      unknown
    >[];
    change(steps.filter((s) => s["op"] === op)[nth]!);
    return copy;
  };
  const expectOf = (step: Record<string, unknown>) => step["expect"] as Record<string, unknown>;
  const DOCUMENT_ROWS: readonly { name: string; doc: StoreFollowDocument; message: string }[] = [
    {
      name: "records the pulls do not read",
      doc: edited("one-append", "pull", 0, (s) => (expectOf(s)["records"] = [])),
      message: "the pulls read the records at [2], expected []",
    },
    {
      name: "deltas the pulls do not deliver",
      doc: edited("one-append", "pull", 0, (s) => (expectOf(s)["delivered"] = [])),
      message: "the pulls delivered [",
    },
    {
      name: "another count of pulls",
      doc: edited("pages-of-one", "pull", 0, (s) => (expectOf(s)["pulls"] = 2)),
      message: "the follower took 3 pulls, expected 2",
    },
    {
      name: "a position the peer is not at",
      doc: edited("one-append", "pull", 0, (s) => (expectOf(s)["position"] = "A.1")),
      message: "the vector pulls to A.1, and the peer is at 2",
    },
    {
      name: "a resync current the peer is not at",
      doc: edited("another-peers-history", "pull", 0, (s) => (expectOf(s)["current"] = "A.1")),
      message: "the vector expects current A.1, and the peer is at 2",
    },
    {
      name: "a follower named twice",
      doc: edited("two-peers", "follow", 1, (s) => (s["as"] = "fa")),
      message: "the vector names follower fa twice",
    },
    {
      name: "a follower used before it follows",
      doc: edited("one-append", "pull", 0, (s) => (s["follower"] = "g")),
      message: "the vector uses follower g before following",
    },
    {
      name: "an ahead that is not a whole number",
      doc: edited("a-position-from-the-future", "follow", 0, (s) => (s["ahead"] = -1)),
      message: "the vector's ahead is not a whole number",
    },
  ];
  for (const row of DOCUMENT_ROWS)
    it(`a document with ${row.name}`, async () => {
      const found = await failures(WITNESS, {}, row.doc);
      expect(found.map((f) => f.message).join("\n")).toContain(row.message);
    });

  it("a document of another format", async () => {
    await expect(
      runFollowConformance(factoryOf(), WITNESS, { ...document, format: "x" as never }),
    ).rejects.toThrow("unknown store follow format");
  });
});
