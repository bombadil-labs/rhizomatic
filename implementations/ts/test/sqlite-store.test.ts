// The SQLite store (SPEC-18 slice 4 plan, step 4a): the four shared conformance suites, run as the
// memory store's tests run them, the count and floor of every peer after every call, the profile,
// the scheme, snapshots, `store-unavailable`, the purge report and what a reopen keeps.
//
// Not covered here: the plans of the statements (sqlite-store-plans.test.ts), their cost
// (sqlite-store-timing.test.ts) and a crash during an append (sqlite-store-crash.test.ts).

import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { makeDelta, makeNegationClaims } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { captureScope } from "../src/reactor/store-read.js";
import { StoreViews } from "../src/reactor/store-views.js";
import { runViewsConformance, type StoreViewsDocument } from "../src/reactor/views-conformance.js";
import { runFollowConformance } from "../src/storage/follow-conformance.js";
import { followFeed, positionOf } from "../src/storage/follow.js";
import {
  runFreshnessConformance,
  type FreshnessWitness,
} from "../src/storage/freshness-conformance.js";
import { checkFresh, touching } from "../src/storage/freshness.js";
import { openStore } from "../src/storage/open-store.js";
import { SQLITE_STORE_FORMAT, openSqliteStore } from "../src/storage/sqlite-store.js";
import { runStoreConformance } from "../src/storage/store-conformance.js";
import type {
  StoreFollowDocument,
  StoreFreshnessDocument,
  StoreScopeDocument,
  StoreScriptsDocument,
} from "../src/storage/store-vector-format.js";
import {
  StoreError,
  type PeerStore,
  type Store,
  type StoreErrorCode,
  type VerifiedDelta,
} from "../src/storage/store.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(here, "../../../vectors/store", name), "utf8")) as T;
const vectors = {
  scripts: load<StoreScriptsDocument>("scripts.json"),
  scope: load<StoreScopeDocument>("scope.json"),
};
const freshness = load<StoreFreshnessDocument>("freshness.json");
const follow = load<StoreFollowDocument>("follow.json");
const views = load<StoreViewsDocument>("views.json");

const fixture = sqliteFixture("rhizomatic-sqlite-store");
afterAll(() => fixture.cleanup());

/** The store options of each run; a case's own request wins over the run's. */
const RUNS = {
  "as built": {},
  "pages of one record": { changePageSize: 1 },
  "two records kept": { changeRetention: { revisions: 2 } },
  "two records kept, pages of one record": { changeRetention: { revisions: 2 }, changePageSize: 1 },
} as const;

const refusal = async (call: Promise<unknown>): Promise<StoreErrorCode | "answered"> =>
  call.then(
    () => "answered" as const,
    (error: unknown) => {
      if (error instanceof StoreError) return error.code;
      throw error;
    },
  );

// ---- the four suites ----------------------------------------------------------------------------

describe("the shared store vectors on the SQLite store, with count and floor checked after every call", () => {
  const all = vectors.scripts.scripts.length + vectors.scope.cases.length;
  const runs = {
    ...RUNS,
    "one record kept": { changeRetention: { revisions: 1 } },
    "every record kept": { changeRetention: "unbounded" },
  } as const;
  for (const [name, options] of Object.entries(runs))
    it(`every script and scope case passes: ${name}`, async () => {
      const report = await runStoreConformance(() => fixture.audited(options), vectors);
      expect(report.skipped).toEqual([]);
      expect(report.passed).toHaveLength(all);
    });
});

describe("the freshness vectors on the SQLite store", () => {
  const witness: FreshnessWitness = {
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
  for (const [name, options] of Object.entries(RUNS))
    it(`every case passes: ${name}`, async () => {
      const report = await runFreshnessConformance(
        (request) => fixture.audited({ ...options, ...request }),
        witness,
        freshness,
      );
      expect(report.skipped).toEqual([]);
      expect(report.passed).toEqual([
        ...freshness.cases.map((c) => `freshness/${c.name}`),
        ...freshness.touching.map((c) => `touching/${c.name}`),
      ]);
    });
});

describe("the follow vectors on the SQLite store", () => {
  for (const [name, options] of Object.entries(RUNS))
    it(`every case passes: ${name}`, async () => {
      const report = await runFollowConformance(
        (request) => fixture.audited({ ...options, ...request }),
        { positionOf, follow: followFeed },
        follow,
      );
      expect(report.skipped).toEqual([]);
      expect(report.passed).toEqual(follow.cases.map((c) => `follow/${c.name}`));
    });
});

describe("the views vectors on the SQLite store", () => {
  for (const [name, options] of Object.entries(RUNS))
    it(`every case passes: ${name}`, async () => {
      const report = await runViewsConformance(
        (request) => fixture.audited({ ...options, ...request }),
        { create: (peer, options) => new StoreViews(peer, options) },
        views,
      );
      expect(report.skipped).toEqual([]);
      expect(report.passed).toHaveLength(views.cases.length);
    });
});

// ---- a small peer ----------------------------------------------------------------------------

const AUTHOR = `ed25519:${"0b".repeat(32)}`;
const fact = (entity: string, n: number): Delta =>
  makeDelta({
    timestamp: n,
    validFrom: 0,
    author: AUTHOR,
    pointers: [
      { role: "about", target: { kind: "entity", entity: { id: entity } } },
      { role: "n", target: { kind: "primitive", value: n } },
    ],
  });

/** A peer with a writer that numbers arrivals and heads itself. */
async function writer(store: Store, id = "peer:a") {
  const peer = await store.createPeer(id, { erasure: "unproven" });
  let sequence = 0;
  let head: string | null = null;
  const member = (delta: Delta): VerifiedDelta => ({
    delta,
    arrival: { id: delta.id, at: 1, sequence: ++sequence, transfer: 1, sender: "fixture" },
  });
  return {
    peer,
    append: async (deltas: readonly Delta[]) => {
      const next = `head-${sequence + 1}`;
      const result = await peer.append({
        expectedHead: head,
        nextHead: next,
        frame: null,
        added: deltas.map(member),
      });
      if (result.status !== "committed") throw new Error(result.status);
      head = next;
      return result;
    },
  };
}

// ---- the store's own rules -------------------------------------------------------------------

describe("the SQLite store's profile and scheme", () => {
  it("declares what step 4c holds, and nothing more; the class is proven on Linux only", async () => {
    const store = await fixture.open();
    expect(store.profile).toEqual({
      capabilities: {
        values: false,
        arrival: true,
        journal: false,
        views: false,
        derivedIndexes: false,
        digest: false,
        erasure: process.platform === "linux" ? "proven" : "unprovable",
      },
      indexedValueRoles: [],
      pushdown: { timestampAtMost: true, arrivalAtMost: true, excludeIds: true },
      writers: "many-processes",
      atRest: "trusted",
      changeRetention: { revisions: 1024 },
      formatVersion: "rhizomatic-store-sqlite/3",
    });
    expect(Object.isFrozen(store.profile)).toBe(true);
    // The posture gate on a store of class unprovable: sqlite-store-erasure.test.ts, rail 6.
  });

  it("openStore opens sqlite:///path, and refuses another form without echoing it", async () => {
    const path = fixture.path();
    const store = await openStore(pathToFileURL(path).href.replace(/^file:/, "sqlite:"), {
      requires: ["arrival", "changes", "purge"],
    });
    await (await writer(store)).append([fact("x", 1)]);
    await store.close();
    const again = await openSqliteStore(path);
    expect((await (await again.peer("peer:a")).read()).count).toBe(1);
    await again.close();
    for (const url of ["sqlite:secret.db", "sqlite://host/x.db", "sqlite:///x.db?mode=ro"]) {
      const error = (await openStore(url).catch((e: unknown) => e)) as StoreError;
      expect([error.code, error.message.includes("secret")]).toEqual(["invalid-url", false]);
    }
    expect(await refusal(openStore(`sqlite://${path}`, { requires: ["journal"] }))).toBe(
      "capability-absent",
    );
  });

  it("refuses a file of another format, naming both, and a file that is not a store", async () => {
    const path = fixture.path();
    await (await openSqliteStore(path)).close();
    const db = new Database(path);
    db.prepare("UPDATE meta SET value = 'rhizomatic-store-sqlite/0' WHERE key = 'format'").run();
    db.close();
    const error = (await openSqliteStore(path).catch((e: unknown) => e)) as StoreError;
    expect(error.code).toBe("open-failed");
    expect(error.message).toContain("rhizomatic-store-sqlite/0");
    expect(error.message).toContain(SQLITE_STORE_FORMAT);
    const other = fixture.path();
    const foreign = new Database(other);
    foreign.exec("CREATE TABLE t (x)");
    foreign.close();
    expect(await refusal(openSqliteStore(other))).toBe("open-failed");
  });

  it("refuses a file of format /1 or /2, which steps 4a and 4b wrote, naming both formats; no migration ships", async () => {
    for (const old of ["rhizomatic-store-sqlite/1", "rhizomatic-store-sqlite/2"]) {
      const path = fixture.path();
      await (await openSqliteStore(path)).close();
      const db = new Database(path);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'format'").run(old);
      db.close();
      const error = (await openSqliteStore(path).catch((e: unknown) => e)) as StoreError;
      expect([error.code, error.message]).toEqual([
        "open-failed",
        `sqlite store: the file holds format ${old}, and this store reads rhizomatic-store-sqlite/3`,
      ]);
    }
  });

  it("keeps the retention it was created with, and refuses another at a later open", async () => {
    const path = fixture.path();
    await (await openSqliteStore(path, { changeRetention: { revisions: 3 } })).close();
    const again = await openSqliteStore(path);
    expect(again.profile.changeRetention).toEqual({ revisions: 3 });
    await again.close();
    expect(await refusal(openSqliteStore(path, { changeRetention: "unbounded" }))).toBe(
      "invalid-request",
    );
    await (await openSqliteStore(path, { changeRetention: { revisions: 3 } })).close();
  });

  it("refuses options of the wrong type", async () => {
    for (const options of [
      { busyTimeoutMs: -1 },
      { busyTimeoutMs: 1.5 },
      { busyTimeoutMs: 2 ** 31 },
      { busyTimeoutMs: Number.MAX_SAFE_INTEGER },
      { changePageSize: 0 },
      { changeRetention: { revisions: 0 } },
      { changeRetention: "none" },
      { mintHistory: "x" },
      { restored: "yes" },
    ])
      expect(await refusal(openSqliteStore(fixture.path(), options as never))).toBe(
        "invalid-request",
      );
  });

  it("waits at most 2^31 - 1 ms, which the engine reads back", async () => {
    const store = await fixture.open({ busyTimeoutMs: 2 ** 31 - 1 });
    expect(store.openAdmin().connection().busy_timeout).toBe(2 ** 31 - 1);
  });

  it("reads every connection rule back from the engine, and refuses a connection that breaks one", async () => {
    const store = await fixture.open({ busyTimeoutMs: 1234 });
    expect(store.openAdmin().connection()).toEqual({
      foreign_keys: 1,
      secure_delete: 1,
      journal_mode: "wal",
      synchronous: 2,
      temp_store: 1,
      busy_timeout: 1234,
    });
    // An in-memory database keeps no log file, so the engine answers another journal mode.
    const error = (await openSqliteStore(":memory:").catch((e: unknown) => e)) as StoreError;
    expect([error.code, error.message]).toEqual([
      "open-failed",
      "sqlite store: the connection refused journal_mode = WAL",
    ]);
    await store.close();
    expect(() => store.openAdmin()).toThrow(StoreError);
  });

  it("refuses a path with U+0000, which the engine would end there, and makes no file", async () => {
    const before = readdirSync(fixture.dir);
    const url = `${pathToFileURL(fixture.dir).href.replace(/^file:/, "sqlite:")}/one%00.secret.db`;
    const error = (await openStore(url).catch((e: unknown) => e)) as StoreError;
    expect([error.code, error.message.includes("secret")]).toEqual(["invalid-url", false]);
    expect(await refusal(openSqliteStore(join(fixture.dir, "one\u0000.other.db")))).toBe(
      "invalid-request",
    );
    expect(readdirSync(fixture.dir)).toEqual(before);
  });

  it("keeps peers, holdings, arrivals, the feed and histories across a reopen", async () => {
    const path = fixture.path();
    const store = await openSqliteStore(path, { mintHistory: (peer) => `host:${peer}` });
    const w = await writer(store);
    const [a, b] = [fact("x", 1), fact("x", 2)];
    await w.append([a, b]);
    await w.peer.purge([a.id]);
    await store.close();
    const again = await openSqliteStore(path, { mintHistory: (peer) => `host:${peer}` });
    const peer = await again.peer("peer:a");
    expect(peer.history).toBe("host:peer:a");
    const snapshot = await peer.read();
    expect([snapshot.revision, snapshot.count, snapshot.head]).toEqual([2, 1, "head-1"]);
    expect(await snapshot.get([a.id, b.id])).toEqual([b]);
    expect((await snapshot.arrivals([b.id]))[0]!.sequence).toBe(2);
    expect(await peer.changes(0)).toEqual({
      status: "ok",
      records: [
        { revision: 1, head: "head-1", added: [a.id, b.id].sort(), removed: [] },
        { revision: 2, head: "head-1", added: [], removed: [a.id] },
      ],
      through: 2,
    });
    // A history is never issued twice, also across a reopen.
    await again.close();
    const third = await openSqliteStore(path, { mintHistory: () => "host:peer:a" });
    expect(await refusal(third.createPeer("peer:b", { erasure: "unproven" }))).toBe(
      "invalid-request",
    );
    await third.close();
  });

  it("refuses every operation after close, the history getter too, and close truncates the log", async () => {
    const path = fixture.path();
    const store = await openSqliteStore(path);
    const w = await writer(store);
    await w.append([fact("x", 1)]);
    const snapshot = await w.peer.read();
    // Another connection keeps the log file, so the store's close must empty it.
    const other = new Database(path);
    other.prepare("SELECT count(*) FROM meta").get();
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    await store.close();
    await store.close();
    expect(statSync(`${path}-wal`).size).toBe(0);
    other.close();
    for (const call of [
      store.peer("peer:a"),
      store.createPeer("peer:b", { erasure: "unproven" }),
      w.peer.read(),
      w.peer.purge([]),
      w.peer.changes(0),
      snapshot.get([]),
      snapshot.scope({ anchors: [] }),
    ])
      expect(await refusal(call)).toBe("store-closed");
    expect(() => store.openAdmin()).toThrow(StoreError);
    let history: unknown;
    try {
      history = w.peer.history;
    } catch (error) {
      history = error instanceof StoreError ? error.code : error;
    }
    expect(history).toBe("store-closed");
  });
});

describe("snapshots on the SQLite store (decision S4-2)", () => {
  it("a snapshot at revision r refuses every read with snapshot-moved after a purge, also where it would find no rows", async () => {
    const store = await fixture.open();
    const w = await writer(store);
    const x = fact("x", 1);
    const negation = makeDelta(makeNegationClaims(AUTHOR, 2, x.id));
    const bystander = fact("y", 3);
    await w.append([x, negation, bystander]);
    const old = await w.peer.read();
    await w.peer.purge([x.id]);
    const calls: Record<string, () => Promise<unknown>> = {
      get: () => old.get([x.id]),
      targets: () => old.targets(["x"]),
      negators: () => old.negators([x.id]),
      arrivals: () => old.arrivals([x.id]),
      scope: () => old.scope({ anchors: [{ kind: "entity", entity: "x" }] }),
      "get of an id never held": () => old.get(["nothing"]),
      "an empty scope": () => old.scope({ anchors: [] }),
    };
    for (const [name, call] of Object.entries(calls))
      expect([name, await refusal(call())]).toEqual([name, "snapshot-moved"]);
    const now = await w.peer.read();
    expect(await now.get([x.id, bystander.id])).toEqual([bystander]);
    expect(await now.negators([x.id])).toEqual([negation.id]);
    old.release();
    expect(await refusal(old.get([]))).toBe("snapshot-released");
  });

  it("a refused call ends its transaction: the next write does not wait", async () => {
    const store = await fixture.open({ busyTimeoutMs: 0 });
    const w = await writer(store);
    await w.append([fact("x", 1)]);
    const old = await w.peer.read();
    await w.append([fact("x", 2)]);
    expect(await refusal(old.get([]))).toBe("snapshot-moved");
    expect(await refusal(old.scope({ anchors: [{ kind: "value" } as never] }))).toBe(
      "snapshot-moved",
    );
    await w.append([fact("x", 3)]);
    const now = await w.peer.read();
    expect(await refusal(now.scope({ anchors: [{ kind: "value" } as never] }))).toBe(
      "capability-absent",
    );
    await w.append([fact("x", 4)]);
  });
});

describe("store-unavailable: the SQLite store cannot serve the call", () => {
  it("an append and a purge refuse while another connection holds the write lock past the wait; nothing changes", async () => {
    const path = fixture.path();
    const store = await openSqliteStore(path, { busyTimeoutMs: 50 });
    const w = await writer(store);
    const x = fact("x", 1);
    await w.append([x]);
    const other = new Database(path);
    other.exec("BEGIN IMMEDIATE");
    const before = await w.peer.read();
    expect(await refusal(w.append([fact("x", 2)]))).toBe("store-unavailable");
    expect(await refusal(w.peer.purge([x.id]))).toBe("store-unavailable");
    expect(await refusal(store.createPeer("peer:b", { erasure: "unproven" }))).toBe(
      "store-unavailable",
    );
    expect(
      ((await w.append([fact("x", 3)]).catch((e: unknown) => e)) as StoreError).message,
    ).toContain("ask again");
    // Reads do not wait for the write lock in WAL mode.
    expect(await before.get([x.id])).toEqual([x]);
    other.exec("ROLLBACK");
    other.close();
    const after = await w.peer.read();
    expect([after.revision, after.count]).toEqual([before.revision, before.count]);
    expect((await w.peer.purge([x.id])).targets).toEqual([{ id: x.id, outcome: "removed" }]);
    await store.close();
  });

  it("open waits no longer than busyTimeoutMs while another connection holds the file", async () => {
    const path = fixture.path();
    await (await openSqliteStore(path)).close();
    const other = new Database(path);
    other.pragma("locking_mode = EXCLUSIVE");
    other.exec("BEGIN EXCLUSIVE");
    const start = performance.now();
    const answer = await refusal(openSqliteStore(path, { busyTimeoutMs: 0 }));
    const waited = performance.now() - start;
    other.exec("ROLLBACK");
    other.close();
    expect([answer, waited < 1000]).toEqual(["open-failed", true]);
    await (await openSqliteStore(path, { busyTimeoutMs: 0 })).close();
  });

  it("a transient engine error says ask again; an error that repeats does not", async () => {
    const store = await fixture.open();
    const w = await writer(store);
    await w.append([fact("x", 1)]);
    // The engine's codes, raised from the test side by the statement that begins a write.
    const probe = new Database(":memory:");
    const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as {
      run: (this: Database.Statement, ...args: unknown[]) => unknown;
    };
    probe.close();
    const run = statement.run;
    const told: Record<string, boolean> = {};
    try {
      for (const code of [
        "SQLITE_BUSY",
        "SQLITE_LOCKED_SHAREDCACHE",
        "SQLITE_PROTOCOL",
        "SQLITE_IOERR_LOCK",
        "SQLITE_INTERRUPT",
        "SQLITE_NOMEM",
        "SQLITE_FULL",
        "SQLITE_CORRUPT",
        "SQLITE_IOERR_WRITE",
        "SQLITE_READONLY",
      ]) {
        statement.run = function (this: Database.Statement, ...args: unknown[]) {
          if (this.source === "BEGIN IMMEDIATE") throw new Database.SqliteError("probe", code);
          return run.apply(this, args);
        };
        const error = (await w.append([fact("x", 2)]).catch((e: unknown) => e)) as StoreError;
        statement.run = run;
        expect(error.code).toBe("store-unavailable");
        told[code] = error.message.includes("ask again");
      }
    } finally {
      statement.run = run;
    }
    expect(told).toEqual({
      SQLITE_BUSY: true,
      SQLITE_LOCKED_SHAREDCACHE: true,
      SQLITE_PROTOCOL: true,
      SQLITE_IOERR_LOCK: true,
      SQLITE_INTERRUPT: true,
      SQLITE_NOMEM: true,
      SQLITE_FULL: false,
      SQLITE_CORRUPT: false,
      SQLITE_IOERR_WRITE: false,
      SQLITE_READONLY: false,
    });
    expect((await w.peer.read()).count).toBe(1);
  });

  it("a read refuses, and never answers empty, when the engine cannot read the file", async () => {
    const path = fixture.path();
    const store = await openSqliteStore(path);
    const w = await writer(store);
    const x = fact("x", 1);
    await w.append([x]);
    const snapshot = await w.peer.read();
    expect(await snapshot.get([x.id])).toEqual([x]);
    // Damage the file and the log index from outside: the engine finds no database.
    const checkpoint = new Database(path);
    checkpoint.pragma("wal_checkpoint(TRUNCATE)");
    checkpoint.close();
    const size = statSync(path).size;
    const file = openSync(path, "r+");
    writeSync(file, Buffer.alloc(size, 0x41));
    closeSync(file);
    const index = openSync(`${path}-shm`, "r+");
    writeSync(index, Buffer.alloc(136));
    closeSync(index);
    for (const call of [
      () => snapshot.get([x.id]),
      () => snapshot.targets(["x"]),
      () => snapshot.scope({ anchors: [{ kind: "entity", entity: "x" }] }),
      () => w.peer.read(),
      () => w.peer.changes(0),
    ])
      expect(await refusal(call())).toBe("store-unavailable");
    await store.close();
  });
});

describe("an engine error that is not a lock does not invite a retry", () => {
  it("a broken constraint refuses store-unavailable, names the constraint, and changes nothing", async () => {
    const path = fixture.path();
    const store = await openSqliteStore(path);
    const w = await writer(store);
    await w.append([fact("x", 1)]);
    // Damage the file from outside: the peer's last sequence goes back to 0.
    const raw = new Database(path);
    raw.prepare("UPDATE peer SET max_seq = 0").run();
    raw.close();
    const y = fact("x", 2);
    const error = (await w.peer
      .append({
        expectedHead: "head-1",
        nextHead: "head-2",
        frame: null,
        added: [{ delta: y, arrival: { id: y.id, at: 1, sequence: 1, transfer: 1, sender: "f" } }],
      })
      .catch((e: unknown) => e)) as StoreError;
    expect(error.code).toBe("store-unavailable");
    expect(error.message).toContain("UNIQUE constraint failed: holding.peer, holding.seq");
    expect(error.message).not.toContain("ask again");
    expect((await w.peer.read()).count).toBe(1);
    await store.close();
  });
});

describe("the purge report of a peer of posture unproven", () => {
  it("removes, keeps bytes another peer holds, settles the debt, says unproven, and owes every file surface", async () => {
    const store = await fixture.audited();
    const a = await writer(store, "peer:a");
    const b = await writer(store, "peer:b");
    const [x, shared, bystander] = [fact("x", 1), fact("s", 2), fact("y", 3)];
    const negation = makeDelta(makeNegationClaims(AUTHOR, 4, x.id));
    await a.append([x, shared, bystander, negation]);
    await b.append([shared]);
    const report = await a.peer.purge([x.id, shared.id, "never-held"]);
    expect(report).toEqual({
      claim: "unproven",
      boundary: "store-controlled-surfaces",
      revision: 2,
      targets: [
        { id: "never-held", outcome: "not-held" },
        { id: shared.id, outcome: "held-by-other-peer" },
        { id: x.id, outcome: "removed" },
      ].sort((p, q) => (p.id < q.id ? -1 : 1)),
      // The peer asks for no proof: no rebuild runs, and the residue is owed (decision S4-16).
      surfaces: [
        "rows",
        "index-entries",
        "page-free-space",
        "freed-pages",
        "write-ahead-log",
        "temp-files",
      ].map((surface) => ({ surface, state: "owed" })),
      retains: [
        { surface: "change-feed", holds: "id" },
        { surface: "purge-debt", holds: "id" },
      ],
    });
    // The rows: the target is gone at the bytes and the indexes; the bystander and the shared
    // delta stay.
    const stored: string[] = [];
    for await (const id of store.openAdmin().storedIds()) stored.push(id);
    expect(stored).toEqual([shared.id, bystander.id, negation.id].sort());
    const now = await a.peer.read();
    expect(await now.targets(["x", "y"])).toEqual([bystander.id]);
    expect(await now.get([bystander.id])).toEqual([bystander]);
    // The negation's own reference row stays: it is the negation's, not x's.
    expect(await now.negators([x.id])).toEqual([negation.id]);
    expect((await a.peer.purge([shared.id])).targets[0]!.outcome).toBe("held-by-other-peer");
    await b.peer.purge([shared.id]);
    const later = await a.peer.purge([shared.id]);
    expect([later.claim, later.targets[0]!.outcome, later.revision]).toEqual([
      "unproven",
      "removed",
      2,
    ]);
    expect((await a.peer.purge([shared.id])).targets[0]!.outcome).toBe("not-held");
  });
});

describe("the Exporter on the SQLite store", () => {
  it("lists in pages, in byte order, and refuses an absent or ill-formed peer", async () => {
    const store = await fixture.open();
    const w = await writer(store);
    const deltas = Array.from({ length: 600 }, (_, i) => fact(`e:${i}`, i));
    await w.append(deltas);
    await store.createPeer("peer:b", { erasure: "unproven" });
    const admin = store.openAdmin();
    const ids: string[] = [];
    for await (const id of admin.peer("peer:a").ids()) ids.push(id);
    const listed: Delta[] = [];
    for await (const delta of admin.peer("peer:a").deltas()) listed.push(delta);
    const expected = deltas.map((d) => d.id).sort();
    expect(ids).toEqual(expected);
    expect(listed.map((d) => d.id)).toEqual(expected);
    expect(listed[0]).toEqual(deltas.find((d) => d.id === expected[0]));
    const peers: string[] = [];
    for await (const peer of admin.peers()) peers.push(peer);
    expect(peers).toEqual(["peer:a", "peer:b"]);
    for (const absent of ["peer:c", "peer:\uD800"]) {
      const listing = admin.peer(absent).ids()[Symbol.asyncIterator]();
      expect(await refusal(listing.next())).toBe("peer-absent");
    }
  });
});

describe("a peer id with a lone surrogate never reaches another peer", () => {
  it("peer() answers peer-absent, though the engine would store the id as another", async () => {
    const store = await fixture.open();
    await store.createPeer("a�", { erasure: "unproven" });
    expect(await refusal(store.peer("a\uD800"))).toBe("peer-absent");
    expect(await refusal(store.createPeer("a\uD800", { erasure: "unproven" }))).toBe(
      "invalid-request",
    );
    const peer: PeerStore = await store.peer("a�");
    expect(peer.id).toBe("a�");
  });
});
