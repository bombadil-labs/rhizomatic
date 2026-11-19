// A proof for the whole store (SPEC-18 proposal §4.13 reading 145): `Store.prove()` on the SQLite
// store and on the memory store. Every SQLite rail runs on real files in its own `mkdtempSync`
// directory and removes it. A rail that claims bytes are gone scans every file of the directory
// (the database, `-wal`, `-shm`, anything else) in another process, and a named bystander peer
// reads back through the store with the same bytes.
//
// Each window between two connections is made from the test side: the rail wraps the statements
// of `better-sqlite3` in this process, or runs a child process (test/support/sqlite-delete-child.ts).
// The store has no hook, switch or quirk for it.

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { SQLITE_STATEMENTS } from "../src/storage/sqlite-statements.js";
import { openSqliteStore, type SqliteStore } from "../src/storage/sqlite-store.js";
import {
  StoreError,
  type PeerStore,
  type ProofReport,
  type PurgeReport,
  type Store,
} from "../src/storage/store.js";
import { marked, markersOf, scan, space, writerOf, type Marked } from "./support/sqlite-erasure.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const childScript = resolve(here, "support/sqlite-delete-child.ts");

const PROVEN_HERE = process.platform === "linux";
const FILE_SURFACES = [
  "rows",
  "index-entries",
  "page-free-space",
  "freed-pages",
  "write-ahead-log",
  "temp-files",
];
const report = (claim: ProofReport["claim"], state: "absent" | "owed"): ProofReport => ({
  claim,
  boundary: "store-controlled-surfaces",
  surfaces: FILE_SURFACES.map((surface) => ({ surface, state })),
});
const PROVEN = report("proven", "absent");
const OWED = report("unproven", "owed");

const spaces: (() => void)[] = [];
const opened: Store[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const proc of children.splice(0))
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
});
afterAll(async () => {
  for (const store of opened) await store.close();
  for (const remove of spaces) remove();
});

function place(): { dir: string; path: string } {
  const { dir, remove } = space("rhizomatic-sqlite-prove");
  spaces.push(remove);
  return { dir, path: join(dir, "store.db") };
}

async function open(path: string, busyTimeoutMs = 100): Promise<SqliteStore> {
  const store = await openSqliteStore(path, { busyTimeoutMs });
  opened.push(store);
  return store;
}

const group = (tag: string, count: number): Marked[] =>
  Array.from({ length: count }, (_, i) => marked(tag, i));
const ids = (deltas: readonly Marked[]): string[] => deltas.map((d) => d.delta.id);
const put = async (peer: PeerStore, deltas: readonly Marked[]): Promise<void> =>
  (await writerOf(peer))(deltas);
const shape = (purge: PurgeReport) => [
  purge.claim,
  [...new Set(purge.surfaces.map((s) => s.state))],
  purge.targets.map((t) => t.outcome),
];

/** A reader in another connection that holds its snapshot: the log cannot be truncated. */
function reader(path: string): { release: () => void } {
  const db = new Database(path);
  db.exec("BEGIN");
  db.prepare("SELECT count(*) FROM meta").get();
  return {
    release: () => {
      db.exec("COMMIT");
      db.close();
    },
  };
}

/** Reads from the file by another connection. */
function read<T>(path: string, body: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/** The two counters and the records of removals, read by another connection. */
const ledger = (path: string) =>
  read(path, (db) => ({
    ...(db.prepare("SELECT dirty, clean FROM residue").get() as { dirty: number; clean: number }),
    records: (db.prepare("SELECT peer, delta FROM surface_debt").all() as Record<string, string>[])
      .map((r) => `${r.peer} ${r.delta}`)
      .sort(),
  }));
const recordsOf = (peer: string, deltas: readonly Marked[]): string[] =>
  ids(deltas)
    .map((id) => `${peer} ${id}`)
    .sort();

/** Every row of every table but `residue`, read by another connection. */
const rowsBut = (path: string) =>
  read(path, (db) =>
    (
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    )
      .filter(({ name }) => name !== "residue")
      .map(({ name }) => [
        name,
        db
          .prepare(`SELECT * FROM "${name}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
  );

/** The bystander reads its deltas and their senders byte for byte, and fsck is clean. */
async function bystanderHolds(store: Store, peer: PeerStore, deltas: readonly Marked[]) {
  const now = await peer.read();
  const byId = new Map(deltas.map((d) => [d.delta.id, d]));
  const sorted = ids(deltas).sort();
  expect(await now.get(sorted)).toEqual(sorted.map((id) => byId.get(id)!.delta));
  expect((await now.arrivals(sorted)).map((a) => a.sender)).toEqual(
    sorted.map((id) => byId.get(id)!.sender),
  );
  now.release();
  expect((await store.openAdmin().fsck()).faults).toEqual([]);
}

type StatementCall = (this: Database.Statement, ...args: unknown[]) => unknown;
/** Wraps one method of every statement in this process; answers the undo. */
function watch(
  method: "run" | "get",
  wrap: (statement: Database.Statement, call: () => unknown) => unknown,
): () => void {
  const probe = new Database(":memory:");
  const prototype = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<
    string,
    StatementCall
  >;
  probe.close();
  const original = prototype[method]!;
  prototype[method] = function (...args) {
    return wrap(this, () => original.apply(this, args));
  };
  return () => {
    prototype[method] = original;
  };
}

/** A child running one job; a wait for each whole line it prints, and its end. */
function child(job: Record<string, unknown>) {
  const proc = spawn(process.execPath, ["--import", "tsx", childScript, JSON.stringify(job)], {
    cwd: pkg,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(proc);
  let out = "";
  let errors = "";
  const waiters: (() => void)[] = [];
  proc.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    for (const wake of waiters.splice(0)) wake();
  });
  proc.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const ended = new Promise<string>((done) =>
    proc.on("close", (code, signal) => done(String(signal ?? code))),
  );
  // Only a line that its newline ended, and that names this child: `<word> <json>`.
  const line = (word: string): string | undefined =>
    out
      .slice(0, out.lastIndexOf("\n") + 1)
      .split("\n")
      .find((l) => l.startsWith(`${word} `))
      ?.slice(word.length + 1);
  const printed = <T>(word: string): Promise<T> =>
    new Promise((done, fail) => {
      const look = (): void => {
        const found = line(word);
        if (found !== undefined) done(JSON.parse(found) as T);
        else waiters.push(look);
      };
      look();
      void ended.then((how) => {
        const found = line(word);
        if (found !== undefined) done(JSON.parse(found) as T);
        else fail(new Error(`the child ended (${how}) before it printed ${word}: ${out}${errors}`));
      });
    });
  return { pid: proc.pid!, ended, printed, errors: () => errors };
}

describe.skipIf(!PROVEN_HERE)("prove on the SQLite store (Linux)", () => {
  it("a proven peer deleted while a reader holds the log answers unproven and leaves its markers in the file; prove() then answers proven, and no file holds them; the bystander reads back", async () => {
    const { dir, path } = place();
    const store = await open(path);
    const name = "peer:PvGoneA";
    const a = await store.createPeer(name, { erasure: "proven" });
    const b = await store.createPeer("peer:b", { erasure: "proven" });
    const [gone, kept] = [group("PvDel", 40), group("PvKeep", 3)];
    await put(a, gone);
    await put(b, kept);
    const markers = [...markersOf(gone), ...ids(gone), name];
    const held = reader(path);
    const deleted = await store.deletePeer(name);
    held.release();
    expect(deleted).toMatchObject({ claim: "unproven", released: 40, surfaces: OWED.surfaces });
    expect(scan(dir, markers).length).toBeGreaterThan(0);

    expect(await store.prove()).toEqual(PROVEN);
    expect(scan(dir, markers)).toEqual([]);
    await bystanderHolds(store, b, kept);
  });

  it("a purge that answered unproven, then prove(): proven; prove() ends no record, and the peer's next ask answers removed and proven and ends its records; no file holds the markers", async () => {
    const { dir, path } = place();
    const store = await open(path);
    const a = await store.createPeer("peer:a", { erasure: "proven" });
    const [x, kept] = [group("PvPurge", 2), group("PvPurgeKeep", 2)];
    await put(a, [...x, ...kept]);
    const held = reader(path);
    const first = await a.purge(ids(x));
    held.release();
    expect(shape(first)).toEqual(["unproven", ["owed"], ["removed", "removed"]]);
    expect(ledger(path).records).toEqual(recordsOf("peer:a", x));

    expect(await store.prove()).toEqual(PROVEN);
    expect(ledger(path).records).toEqual(recordsOf("peer:a", x));
    expect(scan(dir, markersOf(x))).toEqual([]);
    const next = await a.purge(ids(x));
    expect(shape(next)).toEqual(["proven", ["absent"], ["removed", "removed"]]);
    expect(ledger(path).records).toEqual([]);
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystanderHolds(store, a, kept);
  });

  it("a peer left marked by a delete refused before its last removal: prove() rebuilds and the file is clean, yet every file surface is owed; after the delete ends, proven, and no file holds the peer's markers", async () => {
    const { dir, path } = place();
    const store = await open(path);
    const name = "peer:PvMarked";
    const d = await store.createPeer(name, { erasure: "proven" });
    const b = await store.createPeer("peer:b", { erasure: "proven" });
    const [own, kept] = [group("PvMark", 5), group("PvMarkKeep", 1)];
    await put(d, own);
    await put(b, kept);
    const other = new Database(path);
    let armed = false;
    let fired = false;
    const restore = watch("run", (statement, call) => {
      if (statement.source === SQLITE_STATEMENTS.deleteSurfaceDebts) armed = true;
      else if (statement.source === "BEGIN IMMEDIATE" && armed && !fired) {
        fired = true;
        other.exec("BEGIN IMMEDIATE");
      }
      return call();
    });
    let refused: unknown;
    try {
      refused = await store.deletePeer(name).catch((error: unknown) => error);
    } finally {
      restore();
      if (other.inTransaction) other.exec("COMMIT");
      other.close();
    }
    expect([fired, (refused as StoreError).code]).toEqual([true, "store-unavailable"]);
    expect(read(path, (db) => db.prepare("SELECT state FROM peer WHERE id = ?").get(name))).toEqual(
      { state: "deleting" },
    );

    expect(await store.prove()).toEqual(OWED);
    const after = ledger(path);
    expect(after.clean).toBe(after.dirty);
    expect((await store.deletePeer(name)).claim).toBe("proven");
    expect(await store.prove()).toEqual(PROVEN);
    expect(scan(dir, [...markersOf(own), name])).toEqual([]);
    await bystanderHolds(store, b, kept);
  });

  it("prove() while a reader holds the log answers every file surface owed and raises no clean; after the reader lets go, proven, and no file holds the purged markers", async () => {
    const { dir, path } = place();
    const store = await open(path);
    const u = await store.createPeer("peer:u", { erasure: "unproven" });
    const [x, kept] = [group("PvRead", 3), group("PvReadKeep", 2)];
    await put(u, [...x, ...kept]);
    expect((await u.purge(ids(x))).claim).toBe("unproven");
    const before = ledger(path);
    expect(before.clean).toBeLessThan(before.dirty);
    const held = reader(path);
    let answer: ProofReport;
    try {
      answer = await store.prove();
    } finally {
      held.release();
    }
    expect(answer).toEqual(OWED);
    expect(ledger(path)).toEqual(before);
    expect(await store.prove()).toEqual(PROVEN);
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystanderHolds(store, u, kept);
  });

  it("a write of another connection that does not commit leaves its frames in the log after prove()'s truncate: the last transaction finds them, empties the log, tries again and answers proven; no file holds the write's marker", async () => {
    const { dir, path } = place();
    const store = await open(path);
    const u = await store.createPeer("peer:u", { erasure: "unproven" });
    const [x, kept] = [group("PvDead", 3), group("PvDeadKeep", 2)];
    await put(u, [...x, ...kept]);
    await u.purge(ids(x));
    const marker = "PvRolledBackZ";
    const other = new Database(path);
    other.pragma("cache_size = 2");
    let checkpoints = 0;
    let tries = 0;
    let inLog: string[] = [];
    const undoGet = watch("get", (statement, call) => {
      const answer = call();
      if (statement.source === SQLITE_STATEMENTS.checkpoint && ++checkpoints === 1) {
        other.exec("BEGIN IMMEDIATE");
        const insert = other.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
        for (let i = 0; i < 200; i++) insert.run(`${marker}${i}`, `${marker}${"~".repeat(4000)}`);
        other.exec("ROLLBACK");
        inLog = scan(dir, [marker]);
      }
      return answer;
    });
    const undoRun = watch("run", (statement, call) => {
      if (statement.source === "BEGIN IMMEDIATE") tries++;
      return call();
    });
    let answer: ProofReport;
    try {
      answer = await store.prove();
    } finally {
      undoGet();
      undoRun();
      other.close();
    }
    expect(inLog).toEqual([`store.db-wal: ${marker}`]);
    expect([answer, tries]).toEqual([PROVEN, 2]);
    expect(scan(dir, [marker, ...markersOf(x)])).toEqual([]);
    await bystanderHolds(store, u, kept);
  });

  it("another connection commits a write before each try of the last transaction: after three tries prove() answers every file surface owed and raises no clean; the next prove() answers proven", async () => {
    const { dir, path } = place();
    const store = await open(path);
    const u = await store.createPeer("peer:u", { erasure: "unproven" });
    const [x, kept] = [group("PvBusy", 3), group("PvBusyKeep", 2)];
    await put(u, [...x, ...kept]);
    await u.purge(ids(x));
    const before = ledger(path);
    const other = new Database(path);
    let tries = 0;
    const undo = watch("run", (statement, call) => {
      if (statement.source === "BEGIN IMMEDIATE")
        other.prepare("INSERT INTO meta (key, value) VALUES (?, 'x')").run(`PvBusy${++tries}`);
      return call();
    });
    let answer: ProofReport;
    try {
      answer = await store.prove();
    } finally {
      undo();
      other.prepare("DELETE FROM meta WHERE key LIKE 'PvBusy%'").run();
      other.close();
    }
    expect([answer, tries]).toEqual([OWED, 3]);
    expect(ledger(path).clean).toBe(before.clean);
    expect(await store.prove()).toEqual(PROVEN);
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystanderHolds(store, u, kept);
  });

  it("prove() changes no row but residue: on a store where nothing was ever deleted, and on one with a record of a removal and a purge debt; it answers proven on both", async () => {
    for (const deleted of [false, true]) {
      const { path } = place();
      const store = await open(path);
      const a = await store.createPeer("peer:a", { erasure: "proven" });
      const b = await store.createPeer("peer:b", { erasure: "unproven" });
      const [x, shared, kept] = [
        group(`PvRows${deleted}`, 2),
        group(`PvShare${deleted}`, 1),
        group(`PvRowsKeep${deleted}`, 2),
      ];
      await put(a, [...x, ...shared, ...kept]);
      await put(b, shared);
      if (deleted) {
        const held = reader(path);
        const purged = await a.purge(ids([...x, ...shared]));
        held.release();
        expect(shape(purged)).toEqual([
          "unproven",
          ["owed"],
          ids([...x, ...shared])
            .sort()
            .map((id) => (id === shared[0]!.delta.id ? "held-by-other-peer" : "removed")),
        ]);
      }
      const rows = rowsBut(path);
      expect(rows.find(([name]) => name === "surface_debt")![1]).toHaveLength(deleted ? 2 : 0);
      expect(rows.find(([name]) => name === "debt")![1]).toHaveLength(deleted ? 1 : 0);
      expect(await store.prove()).toEqual(PROVEN);
      expect(rowsBut(path)).toEqual(rows);
      const after = ledger(path);
      expect(after.clean).toBe(after.dirty);
      if (!deleted) expect(after.dirty).toBe(0);
      await bystanderHolds(store, a, kept);
    }
  });

  for (const job of ["append", "delete"] as const)
    it(`two processes, 20 rounds: prove() again and again beside another process that runs ${job === "append" ? "appends" : "a delete of a proven peer"}; each report is proven with no marker of an earlier removal in any file${job === "delete" ? ", the deleted peer's included," : ""} or owed on every file surface; after the child ends, proven; the bystander reads back`, async () => {
      const seen = { proven: 0, owed: 0 };
      for (let round = 0; round < 20; round++) {
        const { dir, path } = place();
        const store = await open(path, 5000);
        const u = await store.createPeer("peer:u", { erasure: "unproven" });
        const b = await store.createPeer("peer:b", { erasure: "proven" });
        const tag = `Pv2${job}${round}`;
        const [x, kept, own] = [group(tag, 10), group(`${tag}Keep`, 2), group(`${tag}D`, 600)];
        await put(u, x);
        await put(b, kept);
        if (job === "append") await store.createPeer("peer:w", { erasure: "unproven" });
        else await put(await store.createPeer("peer:d", { erasure: "proven" }), own);
        expect((await u.purge(ids(x))).claim).toBe("unproven");
        // The markers of removals that committed before each prove() below began.
        const removed = [
          ...markersOf(x),
          ...(job === "delete" ? markersOf(own.filter((_, i) => i % 20 === 0)) : []),
        ];
        const run = child(
          job === "append"
            ? { op: "append", path, peer: "peer:w", count: 30, after: 1e6, busyTimeoutMs: 5000 }
            : { op: "delete", path, peer: "peer:d", busyTimeoutMs: 5000 },
        );
        let ended = false;
        void run.ended.then(() => (ended = true));
        expect(await run.printed<number>("open")).toBe(run.pid);
        if (job === "append") await run.printed("appended");
        else {
          // Each prove() then begins after the mark: a proven one ends after the delete.
          const state = new Database(path, { readonly: true });
          const marked = state.prepare("SELECT state FROM peer WHERE id = 'peer:d'").pluck();
          while (marked.get() === "live") await new Promise((done) => setTimeout(done, 1));
          state.close();
        }
        const check = (answer: ProofReport): void => {
          if (answer.claim === "proven") {
            expect(answer).toEqual(PROVEN);
            expect([round, scan(dir, removed)]).toEqual([round, []]);
            seen.proven++;
          } else {
            expect(answer).toEqual(OWED);
            seen.owed++;
          }
        };
        for (let calls = 0; !ended && calls < 40; calls++) {
          check(await store.prove());
          await new Promise((done) => setImmediate(done));
        }
        expect([round, await run.ended, run.errors()]).toEqual([round, "0", ""]);
        expect(await run.printed(job === "append" ? "done" : "report")).toBeDefined();
        expect(await store.prove()).toEqual(PROVEN);
        expect([round, scan(dir, removed)]).toEqual([round, []]);
        await bystanderHolds(store, b, kept);
        await store.close();
      }
      expect(seen.proven + seen.owed).toBeGreaterThanOrEqual(20);
    }, 600_000);
});

describe("prove on a store that cannot prove", () => {
  type Module = typeof import("../src/storage/sqlite-store.js");
  const SUBPATH = "../src/storage/sqlite-store.js";
  /** The store module evaluated anew while the platform reads `name`. */
  async function on(name: string): Promise<Module> {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: name });
    try {
      return (await import(/* @vite-ignore */ `${SUBPATH}?platform=${name}`)) as Module;
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  }

  it("a SQLite store of class unprovable runs no rebuild, raises no clean and answers unproven with temp-files unprovable; the bystander reads back", async () => {
    const unprovable = await on("win32");
    const { path } = place();
    const store = await unprovable.openSqliteStore(path, { busyTimeoutMs: 100 });
    opened.push(store);
    expect(store.profile.capabilities.erasure).toBe("unprovable");
    const u = await store.createPeer("peer:u", { erasure: "unproven" });
    const [x, kept] = [group("PvWin", 2), group("PvWinKeep", 2)];
    await put(u, [...x, ...kept]);
    await u.purge(ids(x));
    const before = ledger(path);
    let vacuums = 0;
    const undo = watch("run", (statement, call) => {
      if (statement.source === "VACUUM") vacuums++;
      return call();
    });
    let answer: ProofReport;
    try {
      answer = await store.prove();
    } finally {
      undo();
    }
    expect(answer).toEqual({
      claim: "unproven",
      boundary: "store-controlled-surfaces",
      surfaces: FILE_SURFACES.map((surface) => ({
        surface,
        state: surface === "temp-files" ? "unprovable" : "owed",
      })),
    });
    expect([vacuums, ledger(path)]).toEqual([0, before]);
    await bystanderHolds(store, u, kept);
  });

  it("the memory store answers unproven, with rows and index entries absent and process memory unprovable; after close, prove() refuses store-closed on both stores", async () => {
    const memory = createMemoryStore();
    const u = await memory.createPeer("peer:u", { erasure: "unproven" });
    const [x, kept] = [group("PvMem", 2), group("PvMemKeep", 2)];
    await put(u, [...x, ...kept]);
    await u.purge(ids(x));
    expect(await memory.prove()).toEqual({
      claim: "unproven",
      boundary: "store-controlled-surfaces",
      surfaces: [
        { surface: "rows", state: "absent" },
        { surface: "index-entries", state: "absent" },
        { surface: "process-memory", state: "unprovable" },
      ],
    });
    await bystanderHolds(memory, u, kept);
    const sqlite = await open(place().path);
    for (const store of [memory, sqlite]) {
      await store.close();
      const refused = await store.prove().catch((error: unknown) => error);
      expect([refused instanceof StoreError, (refused as StoreError).code]).toEqual([
        true,
        "store-closed",
      ]);
    }
  });
});
