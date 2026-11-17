// The SQLite store with many processes (slice 4 plan, step 4c): the gate of the plan (two writing
// processes and a follower in a third), the busy refusal, each value a process could keep in its
// memory, file identity and `restored` (decision S4-8), and bounded retention under two writers
// (decision S4-6). Every child is a real process (test/support/sqlite-process-child.ts). Each
// store lives in its own `mkdtempSync` directory, which the file removes at its end.

import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { makeDelta } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { captureScope } from "../src/reactor/store-read.js";
import { checkFresh } from "../src/storage/freshness.js";
import { followFeed, positionOf } from "../src/storage/follow.js";
import { openStore } from "../src/storage/open-store.js";
import { SQLITE_STATEMENTS } from "../src/storage/sqlite-statements.js";
import { openSqliteStore, type SqliteStoreOptions } from "../src/storage/sqlite-store.js";
import { StoreError, type PeerStore, type VerifiedDelta } from "../src/storage/store.js";
import { audit } from "./support/sqlite-fixture.js";
import { space } from "./support/sqlite-erasure.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const childScript = resolve(here, "support/sqlite-process-child.ts");

const removals: (() => void)[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const proc of children.splice(0)) if (proc.exitCode === null) proc.kill("SIGKILL");
  for (const remove of removals) remove();
});

/** A store file in a new `mkdtempSync` directory. */
function storePath(): string {
  const { dir, remove } = space("rhizomatic-sqlite-processes");
  removals.push(remove);
  return join(dir, "store.db");
}

/** Starts the children waiting on `go` at time `at`: the file is whole when it appears. */
function release(go: string, at: number): void {
  writeFileSync(`${go}.part`, String(at));
  renameSync(`${go}.part`, go);
}

/** A child running one job; its printed lines, and a wait for each. */
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
    proc.on("exit", (code, signal) => done(String(signal ?? code))),
  );
  const line = (word: string): string | undefined =>
    out
      .split("\n")
      .find((l) => l.startsWith(`${word} `))
      ?.slice(word.length + 1);
  const printed = (word: string): Promise<string> =>
    new Promise((done, fail) => {
      const look = (): void => {
        const found = line(word);
        if (found !== undefined) done(found);
        else waiters.push(look);
      };
      look();
      void ended.then((how) => {
        const found = line(word);
        if (found !== undefined) done(found);
        else fail(new Error(`the child ended (${how}) before it printed ${word}: ${out}${errors}`));
      });
    });
  return {
    ended,
    printed,
    /** Everything the child printed so far. */
    output: () => out,
    /** The JSON the child printed after `word`. */
    json: async <T>(word: string): Promise<T> => JSON.parse(await printed(word)) as T,
    held: (point: string) => printed("held").then((p) => expect(p).toBe(point)),
    go: (point: string) => writeFileSync(`${job["path"] as string}.go-${point}`, ""),
  };
}

const AUTHOR = `ed25519:${"0d".repeat(32)}`;
const fact = (entity: string): Delta =>
  makeDelta({
    timestamp: 1,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "about", target: { kind: "entity", entity: { id: entity } } }],
  });
const member = (delta: Delta, sequence: number): VerifiedDelta => ({
  delta,
  arrival: { id: delta.id, at: 1, sequence, transfer: 1, sender: "parent" },
});

const refusal = async (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "answered",
    (error: unknown) => {
      if (error instanceof StoreError) return error.code;
      throw error;
    },
  );

/** A store at a new path with one peer of posture unproven; it is closed again. */
async function made(options: SqliteStoreOptions = {}, peers = ["peer:a"]): Promise<string> {
  const path = storePath();
  const store = await openSqliteStore(path, options);
  for (const id of peers) await store.createPeer(id, { erasure: "unproven" });
  await store.close();
  return path;
}

/** The histories of every peer and every history ever issued, read by another connection. */
function histories(path: string): { peers: Record<string, string>; issued: string[] } {
  const db = new Database(path, { readonly: true });
  try {
    const peers = Object.fromEntries(
      (
        db.prepare("SELECT id, history FROM peer ORDER BY id").all() as {
          id: string;
          history: string;
        }[]
      ).map((r) => [r.id, r.history]),
    );
    const issued = (
      db.prepare("SELECT value FROM history ORDER BY value").all() as { value: string }[]
    ).map((r) => r.value);
    return { peers, issued };
  } finally {
    db.close();
  }
}

type Written = { committed: { revision: number; added: string[] }[]; conflicts: number };
type Followed = {
  revisions: number[];
  added: string[][];
  delivered: number;
  pulls: number;
  moved: number;
};

/** Every committed revision of the writers, with the ids each added, by revision. */
function byRevision(...written: Written[]): Map<number, string[]> {
  const all = new Map<number, string[]>();
  for (const w of written)
    for (const c of w.committed) {
      expect(all.has(c.revision), `revision ${c.revision} committed twice`).toBe(false);
      all.set(c.revision, c.added);
    }
  return all;
}

// ---- the gate --------------------------------------------------------------------------------

describe("the gate of step 4c: two writing processes and a follower in a third", () => {
  it("the follower sees every record of both writers once, in revision order, with no gap; first in fixed turns, then in free contention", async () => {
    const path = await made({ changeRetention: "unbounded" });
    const go = `${path}.go-start`;
    // Phase 1: the writers take turns at a fixed order, so both write at every second revision.
    const TURNS = 40;
    const FREE = 120;
    const a1 = child({
      op: "write",
      path,
      peer: "peer:a",
      tag: "A1",
      batches: TURNS,
      size: 2,
      turn: { of: 2, mine: 0 },
      go,
    });
    const b1 = child({
      op: "write",
      path,
      peer: "peer:a",
      tag: "B1",
      batches: TURNS,
      size: 2,
      turn: { of: 2, mine: 1 },
      go,
    });
    const follower = child({ op: "follow", path, peer: "peer:a", until: 2 * TURNS + 2 * FREE, go });
    release(go, Date.now());
    const [wa1, wb1] = await Promise.all([a1.json<Written>("done"), b1.json<Written>("done")]);
    // Phase 2: both writers append as fast as they can; a lost race answers conflict, and the
    // writer reads again.
    const a2 = child({ op: "write", path, peer: "peer:a", tag: "A2", batches: FREE, size: 2 });
    const b2 = child({ op: "write", path, peer: "peer:a", tag: "B2", batches: FREE, size: 2 });
    const [wa2, wb2] = await Promise.all([a2.json<Written>("done"), b2.json<Written>("done")]);
    const followed = await follower.json<Followed>("followed");
    expect([
      await a1.ended,
      await b1.ended,
      await a2.ended,
      await b2.ended,
      await follower.ended,
    ]).toEqual(["0", "0", "0", "0", "0"]);

    const total = 2 * TURNS + 2 * FREE;
    const committed = byRevision(wa1, wb1, wa2, wb2);
    expect([...committed.keys()].sort((x, y) => x - y)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
    // The turns: A wrote every odd revision and B every even one, up to 2 × TURNS.
    expect(wa1.committed.map((c) => c.revision)).toEqual(
      Array.from({ length: TURNS }, (_, i) => 2 * i + 1),
    );
    expect(wb1.committed.map((c) => c.revision)).toEqual(
      Array.from({ length: TURNS }, (_, i) => 2 * i + 2),
    );
    // The follower: revisions 1 to the last, each once, in order, each with the ids its writer
    // committed at that revision; and the delta of every added id.
    expect(followed.revisions).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(followed.added).toEqual(followed.revisions.map((r) => committed.get(r)));
    expect(followed.delivered).toBe(2 * total);
    console.log(
      `gate: ${total} revisions, ${followed.pulls} pulls, ${followed.moved} pulls moved, conflicts in free contention ${wa2.conflicts + wb2.conflicts}`,
    );
    audit(path);

    // The store agrees: one read in this process sees the last revision and every id.
    const store = await openSqliteStore(path);
    const snapshot = await (await store.peer("peer:a")).read();
    expect([snapshot.revision, snapshot.count]).toEqual([total, 2 * total]);
    await store.close();
  }, 120_000);
});

// ---- busy ------------------------------------------------------------------------------------

describe("busy: a write that cannot take the lock within busyTimeoutMs", () => {
  it("an append, a purge and createPeer refuse store-unavailable while another process holds the write lock; nothing changes, and each succeeds after", async () => {
    const path = await made();
    const store = await openSqliteStore(path, { busyTimeoutMs: 100 });
    const peer = await store.peer("peer:a");
    const holder = child({
      op: "append",
      path,
      peer: "peer:a",
      tag: "H",
      size: 1,
      after: 0,
      hold: "locked",
    });
    await holder.held("locked");
    const x = fact("x");
    const started = Date.now();
    const append = peer.append({
      expectedHead: null,
      nextHead: "mine",
      frame: null,
      added: [member(x, 50)],
    });
    expect(await refusal(append)).toBe("store-unavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await refusal(peer.purge([x.id]))).toBe("store-unavailable");
    expect(await refusal(store.createPeer("peer:b", { erasure: "unproven" }))).toBe(
      "store-unavailable",
    );
    // A read does not wait for the write lock, and sees nothing of the refused calls.
    const before = await peer.read();
    expect([before.revision, before.count, await before.get([x.id])]).toEqual([0, 0, []]);
    holder.go("locked");
    expect(await holder.printed("appended")).toBe("committed");
    expect(await holder.ended).toBe("0");
    // The refused append is asked again, from the head the other process wrote.
    const now = await peer.read();
    expect(now.revision).toBe(1);
    expect(
      await peer.append({
        expectedHead: now.head,
        nextHead: "mine",
        frame: null,
        added: [member(x, 50)],
      }),
    ).toEqual({ status: "committed", revision: 2, added: [x.id] });
    await store.close();
    audit(path);
  }, 60_000);

  it("a writing child refused store-unavailable while another process holds the write lock asks again, and commits after the lock is free", async () => {
    const path = await made();
    const holder = child({
      op: "append",
      path,
      peer: "peer:a",
      tag: "H",
      size: 1,
      after: 0,
      hold: "locked",
    });
    await holder.held("locked");
    const writer = child({
      op: "write",
      path,
      peer: "peer:a",
      tag: "W",
      batches: 1,
      size: 1,
      busyTimeoutMs: 50,
    });
    expect(await writer.printed("busy")).toBe("open");
    holder.go("locked");
    expect(await holder.printed("appended")).toBe("committed");
    const written = await writer.json<Written & { asked: number }>("done");
    expect(await writer.ended).toBe("0");
    expect(written.asked).toBeGreaterThan(0);
    expect(written.committed.map((c) => c.revision)).toEqual([2]);
    audit(path);
  }, 60_000);
});

// ---- the open of a new file ---------------------------------------------------------------------

const UNAVAILABLE =
  "store-unavailable: the SQLite store cannot serve this call now (SQLITE_BUSY); ask again";

/** The answer of an open of `path` (closed again when it opened) and its time in ms. */
async function timedOpen(path: string, busyTimeoutMs: number) {
  const started = performance.now();
  const answer = await openSqliteStore(path, { busyTimeoutMs }).then(
    async (store) => {
      await store.close();
      return "opened";
    },
    (error: unknown) =>
      error instanceof StoreError ? `${error.code}: ${error.message}` : String(error),
  );
  return { answer, ms: performance.now() - started };
}

/**
 * Runs `body` while each `pragma` or `prepare` call (`method`) of `better-sqlite3` in this process
 * first runs `before`. The hook lives in the test process only; the store has none.
 */
async function hooked<T>(
  method: "pragma" | "prepare",
  before: (source: string) => void,
  body: () => Promise<T>,
): Promise<T> {
  type Method = (this: Database.Database, source: string, ...rest: unknown[]) => unknown;
  const proto = Database.prototype as unknown as Record<string, Method>;
  const original = proto[method]!;
  proto[method] = function (this: Database.Database, source, ...rest) {
    before(source);
    return original.call(this, source, ...rest);
  };
  try {
    return await body();
  } finally {
    proto[method] = original;
  }
}

/** The configured wait of the bound rails, long enough that a slow disk adds little to it. */
const BOUND_MS = 1000;
/** How far past its wait an open took, as a part of the wait: a bound of twice gives 1 or more. */
const past = (ms: number): number => (ms - BOUND_MS) / BOUND_MS;

describe("the open of a new file that other connections open at the same time", () => {
  it("while another connection holds the write lock of the new file, open waits busyTimeoutMs and refuses store-unavailable, not open-failed at once; a later open makes the store", async () => {
    const path = storePath();
    const holder = new Database(path);
    holder.prepare("BEGIN IMMEDIATE").run();
    const started = Date.now();
    const refused = await openSqliteStore(path, { busyTimeoutMs: 200 }).then(
      () => "opened",
      (error: unknown) =>
        error instanceof StoreError ? `${error.code}: ${error.message}` : String(error),
    );
    expect(refused).toBe(
      "store-unavailable: the SQLite store cannot serve this call now (SQLITE_BUSY); ask again",
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    holder.prepare("ROLLBACK").run();
    holder.close();
    const store = await openSqliteStore(path);
    await store.createPeer("peer:a", { erasure: "unproven" });
    await store.close();
    audit(path);
  }, 60_000);

  it("while another connection holds an exclusive lock on the new file, the open's first read waits and refuses store-unavailable after busyTimeoutMs and within one and a half times it, not open-failed", async () => {
    const path = storePath();
    const holder = new Database(path);
    holder.prepare("BEGIN EXCLUSIVE").run();
    const { answer, ms } = await timedOpen(path, BOUND_MS);
    holder.prepare("ROLLBACK").run();
    holder.close();
    expect(answer).toBe(UNAVAILABLE);
    expect(ms).toBeGreaterThanOrEqual(BOUND_MS);
    expect(past(ms)).toBeLessThan(0.5);
  }, 60_000);

  it("when another connection takes an exclusive lock after the open's first read, so each journal mode switch is busy, the open refuses store-unavailable within one and a half times busyTimeoutMs", async () => {
    const path = storePath();
    let holder: Database.Database | undefined;
    let switches = 0;
    const { answer, ms } = await hooked(
      "pragma",
      (source) => {
        if (!source.startsWith("journal_mode")) return;
        switches++;
        if (holder !== undefined) return;
        holder = new Database(path);
        holder.prepare("BEGIN EXCLUSIVE").run();
      },
      () => timedOpen(path, BOUND_MS),
    );
    holder?.prepare("ROLLBACK").run();
    holder?.close();
    expect(answer).toBe(UNAVAILABLE);
    expect(switches).toBeGreaterThanOrEqual(1);
    expect(ms).toBeGreaterThanOrEqual(BOUND_MS);
    expect(past(ms)).toBeLessThan(0.5);
  }, 60_000);

  it("an error of a connection rule that is not busy passes up as open-failed with its code, after one try", async () => {
    const path = storePath();
    let switches = 0;
    const { answer } = await hooked(
      "pragma",
      (source) => {
        if (!source.startsWith("journal_mode")) return;
        switches++;
        throw new Database.SqliteError("disk I/O error", "SQLITE_IOERR");
      },
      () => timedOpen(path, 200),
    );
    expect([answer, switches]).toEqual([
      "open-failed: sqlite store: the file did not open (SQLITE_IOERR)",
      1,
    ]);
  }, 60_000);

  it("four processes that open one new path together all open it, no open is refused before the default busyTimeoutMs of 5000 ms, and the file is one sound store", async () => {
    for (let round = 0; round < 10; round++) {
      const path = storePath();
      const go = `${path}.go-start`;
      const openers = Array.from({ length: 4 }, () => child({ op: "open", path, go }));
      for (const opener of openers) await opener.printed("waiting");
      release(go, Date.now() + 100);
      for (const opener of openers) {
        expect(await opener.json("histories")).toEqual({});
        expect(await opener.ended).toBe("0");
        for (const ms of await opener.json<number[]>("refused-after"))
          expect(ms).toBeGreaterThanOrEqual(5000);
      }
      const db = new Database(path, { readonly: true });
      try {
        expect([
          db.pragma("integrity_check", { simple: true }),
          db.pragma("journal_mode", { simple: true }),
          db.prepare("SELECT key FROM meta ORDER BY key").all(),
        ]).toEqual(["ok", "wal", [{ key: "format" }, { key: "identity" }, { key: "retention" }]]);
      } finally {
        db.close();
      }
    }
  }, 120_000);
});

/** A store with one peer, set to the rollback journal, as another tool can leave a file. */
async function rollbackStore(): Promise<string> {
  const path = await made();
  const db = new Database(path);
  try {
    expect(db.pragma("journal_mode = DELETE", { simple: true })).toBe("delete");
  } finally {
    db.close();
  }
  return path;
}

/**
 * Runs `body` while a connection in a worker thread takes an exclusive lock on `path` before
 * each statement that the store in this process runs and `at` accepts, and holds it `holdMs`. A
 * statement that finds the lock held, or only sets the wait, does not ask for it again. The
 * worker takes no lock that this process holds: it does not wait. The hook lives in the test
 * process only.
 */
async function retaking<T>(
  path: string,
  holdMs: number,
  at: (source: string) => boolean,
  body: () => Promise<T>,
): Promise<T> {
  const cell = new Int32Array(new SharedArrayBuffer(12));
  const worker = new Worker(
    `const { workerData } = require("node:worker_threads");
const Database = require(workerData.driver);
const cell = new Int32Array(workerData.cell.buffer);
const db = new Database(workerData.path, { timeout: 0 });
for (let seen = 0; ; ) {
  Atomics.wait(cell, 0, seen);
  seen = Atomics.load(cell, 0);
  if (seen < 0) break;
  let taken = 1;
  try { db.exec("BEGIN EXCLUSIVE"); } catch { taken = 2; }
  if (taken === 1) Atomics.store(cell, 2, 1);
  Atomics.store(cell, 1, taken);
  Atomics.notify(cell, 1);
  if (taken !== 1) continue;
  Atomics.wait(cell, 0, seen, workerData.holdMs);
  Atomics.store(cell, 2, 0);
  db.exec("ROLLBACK");
}
db.close();`,
    {
      eval: true,
      workerData: {
        driver: createRequire(import.meta.url).resolve("better-sqlite3"),
        cell,
        path,
        holdMs,
      },
    },
  );
  const probe = new Database(":memory:");
  const proto = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<
    "run" | "get" | "all",
    (this: Database.Statement, ...args: unknown[]) => unknown
  >;
  probe.close();
  const originals = { run: proto.run, get: proto.get, all: proto.all };
  let asked = 0;
  const take = (source: string): void => {
    if (/^PRAGMA (busy_timeout|database_list)|^(COMMIT|ROLLBACK)$/.test(source)) return;
    if (!at(source) || Atomics.load(cell, 2) === 1) return;
    Atomics.store(cell, 1, 0);
    Atomics.store(cell, 0, ++asked);
    Atomics.notify(cell, 0);
    Atomics.wait(cell, 1, 0, 10_000);
  };
  for (const name of ["run", "get", "all"] as const)
    proto[name] = function (this: Database.Statement, ...args: unknown[]) {
      take(this.source);
      return originals[name].apply(this, args);
    };
  try {
    return await body();
  } finally {
    Object.assign(proto, originals);
    Atomics.store(cell, 0, -1);
    Atomics.notify(cell, 0);
    await new Promise((done) => worker.on("exit", done));
  }
}

describe("the open of a store whose lock another connection takes between the open's statements", () => {
  it("an exclusive lock taken after the names read of a rollback-journal store makes the format read busy: the open refuses store-unavailable within the bound, not open-failed, changes no byte, and the next open opens the store", async () => {
    const path = await rollbackStore();
    const before = readFileSync(path);
    let holder: Database.Database | undefined;
    const { answer, ms } = await hooked(
      "prepare",
      (source) => {
        if (source !== SQLITE_STATEMENTS.metaGet || holder !== undefined) return;
        holder = new Database(path);
        holder.exec("BEGIN EXCLUSIVE");
      },
      () => timedOpen(path, BOUND_MS),
    );
    holder?.exec("ROLLBACK");
    holder?.close();
    expect(answer).toBe(UNAVAILABLE);
    expect(ms).toBeGreaterThanOrEqual(BOUND_MS);
    expect(past(ms)).toBeLessThan(0.5);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(false);
    const store = await openSqliteStore(path);
    const peers: string[] = [];
    for await (const id of store.openAdmin().peers()) peers.push(id);
    expect(peers).toEqual(["peer:a"]);
    await store.close();
    audit(path);
  }, 60_000);

  it("an engine error at the format read that is not busy passes up as open-failed with its code, after one try, not as a file that is not a store", async () => {
    const path = await made();
    let reads = 0;
    const { answer } = await hooked(
      "prepare",
      (source) => {
        if (source !== SQLITE_STATEMENTS.metaGet) return;
        reads++;
        throw new Database.SqliteError("database disk image is malformed", "SQLITE_CORRUPT");
      },
      () => timedOpen(path, BOUND_MS),
    );
    expect([answer, reads]).toEqual([
      "open-failed: sqlite store: the file did not open (SQLITE_CORRUPT)",
      1,
    ]);
  }, 60_000);

  for (const [code, expected] of [
    ["SQLITE_CORRUPT", "open-failed: sqlite store: the file did not open (SQLITE_CORRUPT)"],
    ["SQLITE_BUSY", UNAVAILABLE],
  ] as const)
    it(`an engine error ${code} at the format read of the second pass, in the open's write transaction, answers ${expected.split(":")[0]} after one try`, async () => {
      const path = await made();
      let reads = 0;
      const { answer } = await hooked(
        "prepare",
        (source) => {
          if (source !== SQLITE_STATEMENTS.metaGet) return;
          // The first pass reads format and retention; the third read is the second pass.
          if (++reads === 3) throw new Database.SqliteError("the engine failed", code);
        },
        () => timedOpen(path, BOUND_MS),
      );
      expect([answer, reads]).toEqual([expected, 3]);
      const store = await openSqliteStore(path);
      const peers: string[] = [];
      for await (const id of store.openAdmin().peers()) peers.push(id);
      expect(peers).toEqual(["peer:a"]);
      await store.close();
    }, 60_000);

  for (const file of ["a new file", "a rollback-journal store"] as const)
    it(`a holder that takes an exclusive lock again before each statement of the open of ${file}, and holds it for most of busyTimeoutMs, cannot make the open take more than one and a half times busyTimeoutMs`, async () => {
      const path = file === "a new file" ? storePath() : await rollbackStore();
      const { answer, ms } = await retaking(
        path,
        0.85 * BOUND_MS,
        () => true,
        () => timedOpen(path, BOUND_MS),
      );
      expect(["opened", UNAVAILABLE]).toContain(answer);
      expect(past(ms)).toBeLessThan(0.5);
      const store = await openSqliteStore(path);
      await store.close();
      audit(path);
    }, 60_000);
  it("a holder that makes the first read of a rollback-journal store wait most of busyTimeoutMs, then takes the write lock at the open's write transaction, cannot make the open take more than one and a half times busyTimeoutMs", async () => {
    const path = await rollbackStore();
    let begins = 0;
    const { answer, ms } = await retaking(
      path,
      0.85 * BOUND_MS,
      (source) =>
        source === SQLITE_STATEMENTS.schemaNames ||
        (source === "BEGIN IMMEDIATE" && ++begins === 1),
      () => timedOpen(path, BOUND_MS),
    );
    expect([answer, begins]).toEqual([UNAVAILABLE, 1]);
    expect(ms).toBeGreaterThanOrEqual(BOUND_MS);
    expect(past(ms)).toBeLessThan(0.5);
    audit(path);
  }, 60_000);

  it("a holder that makes the open's first write transaction wait more than half of busyTimeoutMs, then takes the write lock again at the second, makes the open refuse store-unavailable within the bound: the second waits only the time left", async () => {
    const path = await made();
    let begins = 0;
    const { answer, ms } = await retaking(
      path,
      0.6 * BOUND_MS,
      (source) => source === "BEGIN IMMEDIATE" && ++begins <= 2,
      () => timedOpen(path, BOUND_MS),
    );
    expect([answer, begins]).toEqual([UNAVAILABLE, 2]);
    expect(ms).toBeGreaterThanOrEqual(BOUND_MS);
    expect(past(ms)).toBeLessThan(0.5);
    audit(path);
  }, 60_000);
});

// ---- values a process could keep ---------------------------------------------------------------

describe("each value a process could keep in memory is read from the file in the transaction that uses it", () => {
  it("revision, head and last arrival: an append after another process wrote builds on what that process wrote", async () => {
    const path = await made();
    const store = await openSqliteStore(path);
    const peer = await store.peer("peer:a");
    // This process writes first, so that a value it kept from its own write would be stale.
    const w = fact("w");
    expect(
      await peer.append({
        expectedHead: null,
        nextHead: "own",
        frame: null,
        added: [member(w, 1)],
      }),
    ).toEqual({ status: "committed", revision: 1, added: [w.id] });
    const stale = await peer.read();
    const other = child({ op: "append", path, peer: "peer:a", tag: "O", size: 3, after: 1 });
    expect(await other.printed("appended")).toBe("committed");
    const x = fact("x");
    // From the old head: conflict, not a write over the other process's.
    expect(
      await peer.append({
        expectedHead: stale.head,
        nextHead: "mine",
        frame: null,
        added: [member(x, 9)],
      }),
    ).toEqual({ status: "conflict" });
    const now = await peer.read();
    expect([now.revision, now.count, now.head]).toEqual([2, 4, "O-head"]);
    // An arrival at or below the other process's last one is refused: the last arrival is read
    // from the file.
    expect(
      await refusal(
        peer.append({
          expectedHead: now.head,
          nextHead: "mine",
          frame: null,
          added: [member(x, 4)],
        }),
      ),
    ).toBe("invalid-admission");
    expect(
      await peer.append({
        expectedHead: now.head,
        nextHead: "mine",
        frame: null,
        added: [member(x, 5)],
      }),
    ).toEqual({ status: "committed", revision: 3, added: [x.id] });
    await store.close();
    audit(path);
  }, 60_000);

  it("a snapshot refuses snapshot-moved after another process writes, also where it would find no rows", async () => {
    const path = await made();
    const store = await openSqliteStore(path);
    const peer = await store.peer("peer:a");
    const snapshot = await peer.read();
    const other = child({ op: "append", path, peer: "peer:a", tag: "O", size: 1, after: 0 });
    expect(await other.printed("appended")).toBe("committed");
    for (const call of [
      snapshot.get([fact("O-0").id]),
      snapshot.get([]),
      snapshot.targets(["O-0"]),
    ])
      expect(await refusal(call)).toBe("snapshot-moved");
    await store.close();
  }, 60_000);

  it("a snapshot's call answers the state of its revision when another process commits between the revision check and the data statement", async () => {
    const path = await made();
    const reader = child({
      op: "read",
      path,
      peer: "peer:a",
      ids: [fact("O-0").id],
      hold: "checked",
    });
    await reader.held("checked");
    // The reader's revision check passed at revision 0; this process now commits revision 1.
    const store = await openSqliteStore(path);
    const peer = await store.peer("peer:a");
    const o = fact("O-0");
    expect(
      await peer.append({ expectedHead: null, nextHead: "h", frame: null, added: [member(o, 1)] }),
    ).toEqual({
      status: "committed",
      revision: 1,
      added: [o.id],
    });
    reader.go("checked");
    expect(await reader.json("got")).toEqual({ revision: 0, ids: [] });
    await store.close();
  }, 60_000);

  it("the floor: a feed read after another process trimmed it refuses resync-required below the floor, and the next append trims from the file's floor", async () => {
    const path = await made({ changeRetention: { revisions: 3 } });
    const store = await openSqliteStore(path);
    const peer = await store.peer("peer:a");
    expect(await peer.changes(0)).toEqual({ status: "ok", records: [], through: 0 });
    for (let n = 0; n < 5; n++) {
      const other = child({ op: "append", path, peer: "peer:a", tag: `O${n}`, size: 1, after: n });
      expect(await other.printed("appended")).toBe("committed");
    }
    expect(await peer.changes(0)).toEqual({ status: "resync-required", current: 5 });
    expect(await peer.changes(1)).toEqual({ status: "resync-required", current: 5 });
    const page = await peer.changes(2);
    expect(page.status === "ok" && page.records.map((r) => r.revision)).toEqual([3, 4, 5]);
    const now = await peer.read();
    const x = fact("x");
    await peer.append({
      expectedHead: now.head,
      nextHead: "mine",
      frame: null,
      added: [member(x, 10)],
    });
    expect(await peer.changes(2)).toEqual({ status: "resync-required", current: 6 });
    audit(path);
    await store.close();
  }, 60_000);

  it("peers and issued histories: another process's peer is seen, its id is taken, and its history is never issued again", async () => {
    const path = await made();
    const store = await openSqliteStore(path, { mintHistory: () => "host:one" });
    const other = child({ op: "create", path, peer: "peer:b", mint: "host:one" });
    expect(await other.printed("created")).toBe("host:one");
    expect((await store.peer("peer:b")).history).toBe("host:one");
    expect(await refusal(store.createPeer("peer:b", { erasure: "unproven" }))).toBe("peer-exists");
    expect(await refusal(store.createPeer("peer:c", { erasure: "unproven" }))).toBe(
      "invalid-request",
    );
    await store.close();
    expect(Object.keys(histories(path).peers)).toEqual(["peer:a", "peer:b"]);
  }, 60_000);
});

// ---- file identity and restored (decision S4-8) -------------------------------------------------

/** The histories each peer has in the store at `path`, through the contract. */
async function opened(
  path: string,
  options: SqliteStoreOptions = {},
): Promise<Record<string, string>> {
  const store = await openSqliteStore(path, options);
  try {
    const found: Record<string, string> = {};
    for await (const id of store.openAdmin().peers()) found[id] = (await store.peer(id)).history;
    return found;
  } finally {
    await store.close();
  }
}

describe("file identity: a copy, or a restore, opens under new histories", () => {
  it("a copied file opens under new histories, once; the original keeps its own; every history stays issued", async () => {
    const path = await made({}, ["peer:a", "peer:b"]);
    const original = await opened(path);
    const copy = join(dirname(path), "copy.db");
    copyFileSync(path, copy);
    const first = await opened(copy);
    expect(Object.keys(first)).toEqual(["peer:a", "peer:b"]);
    for (const id of ["peer:a", "peer:b"]) expect(first[id]).not.toBe(original[id]);
    expect(await opened(copy)).toEqual(first);
    expect(await opened(path)).toEqual(original);
    expect(histories(copy).issued).toEqual(
      [...Object.values(original), ...Object.values(first)].sort(),
    );
  }, 60_000);

  it("two processes that open a copy together mint once: the second waits for the first's write lock and finds the identity it recorded", async () => {
    const path = await made({}, ["peer:a", "peer:b"]);
    const original = await opened(path);
    const copy = join(dirname(path), "copy.db");
    copyFileSync(path, copy);
    // The second process opens the file and stops before the write lock of its identity check.
    const two = child({ op: "open", path: copy, hold: "lock" });
    await two.held("lock");
    // The first takes that lock and stops after it reads the identity, before it mints.
    const one = child({ op: "open", path: copy, hold: "identity" });
    await one.held("identity");
    // The second asks for the lock that the first holds: its next statement is BEGIN IMMEDIATE.
    two.go("lock");
    expect(await two.printed("locking")).toBe("lock");
    one.go("identity");
    const [h1, h2] = await Promise.all([
      one.json<Record<string, string>>("histories"),
      two.json<Record<string, string>>("histories"),
    ]);
    expect(h2).toEqual(h1);
    for (const id of ["peer:a", "peer:b"]) expect(h1[id]).not.toBe(original[id]);
    expect(histories(copy).issued).toHaveLength(4);
  }, 60_000);

  it("a copy with more peers than one page of 256 gives every peer a new history, the last page too", async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `peer:${String(i).padStart(3, "0")}`);
    const path = await made({}, ids);
    const original = await opened(path);
    const copy = join(dirname(path), "copy.db");
    copyFileSync(path, copy);
    const first = await opened(copy);
    expect(Object.keys(first)).toHaveLength(600);
    const kept = ids.filter((id) => first[id] === original[id]);
    expect(kept).toEqual([]);
    expect(await opened(copy)).toEqual(first);
    expect(histories(copy).issued).toHaveLength(1200);
  }, 120_000);

  it("a file whose identity row is missing gives every peer a new history at its open, and records the identity", async () => {
    const path = await made({}, ["peer:a", "peer:b"]);
    const original = await opened(path);
    const db = new Database(path);
    db.prepare("DELETE FROM meta WHERE key = 'identity'").run();
    db.close();
    const first = await opened(path);
    for (const id of ["peer:a", "peer:b"]) expect(first[id]).not.toBe(original[id]);
    expect(await opened(path)).toEqual(first);
    const check = new Database(path, { readonly: true });
    const row = check.prepare("SELECT value FROM meta WHERE key = 'identity'").get();
    check.close();
    expect(row).toBeDefined();
    expect(histories(path).issued).toHaveLength(4);
  }, 60_000);

  it("a move to another directory keeps the file's identity: no new history", async () => {
    const path = await made();
    const original = await opened(path);
    const elsewhere = join(dirname(storePath()), "moved.db");
    renameSync(path, elsewhere);
    expect(await opened(elsewhere)).toEqual(original);
  }, 60_000);

  it("a restore that removes the file and copies a backup to its path mints, also when the file system gives the new file the old file index", async () => {
    const path = await made();
    const original = await opened(path);
    const backup = join(dirname(path), "backup.db");
    copyFileSync(path, backup);
    const before = statSync(path, { bigint: true });
    rmSync(path);
    copyFileSync(backup, path);
    const after = statSync(path, { bigint: true });
    // ext4 gives the copy the index of the file just removed; the birth time differs.
    console.log(
      `restore: the file index was ${after.ino === before.ino ? "reused" : "not reused"}`,
    );
    const restored = await opened(path);
    expect(restored["peer:a"]).not.toBe(original["peer:a"]);
  }, 60_000);

  it("restored: true mints at that open and a normal reopen does not, through openSqliteStore and through openStore", async () => {
    const path = await made();
    const original = await opened(path);
    const once = await opened(path, { restored: true });
    expect(once["peer:a"]).not.toBe(original["peer:a"]);
    expect(await opened(path)).toEqual(once);
    const url = pathToFileURL(path).href.replace(/^file:/, "sqlite:");
    const store = await openStore(url, { restored: true });
    const twice = (await store.peer("peer:a")).history;
    await store.close();
    expect([twice === once["peer:a"], twice === original["peer:a"]]).toEqual([false, false]);
    const plain = await openStore(url);
    expect((await plain.peer("peer:a")).history).toBe(twice);
    await plain.close();
    expect(histories(path).issued).toHaveLength(3);
  }, 60_000);

  it("a new file records its identity and mints nothing; a host mint that repeats an issued history refuses the open and changes nothing", async () => {
    const path = storePath();
    const store = await openSqliteStore(path, { mintHistory: (peer) => `host:${peer}` });
    await store.createPeer("peer:a", { erasure: "unproven" });
    await store.close();
    expect(histories(path)).toEqual({
      peers: { "peer:a": "host:peer:a" },
      issued: ["host:peer:a"],
    });
    expect(
      await refusal(openSqliteStore(path, { restored: true, mintHistory: () => "host:peer:a" })),
    ).toBe("invalid-request");
    expect(histories(path)).toEqual({
      peers: { "peer:a": "host:peer:a" },
      issued: ["host:peer:a"],
    });
  }, 60_000);

  it("a new history in another process makes this process's handle, snapshot, cursor and capture of the old history refuse", async () => {
    const path = await made();
    const store = await openSqliteStore(path);
    const peer: PeerStore = await store.peer("peer:a");
    const o = fact("O-0");
    await peer.append({ expectedHead: null, nextHead: "h", frame: null, added: [member(o, 1)] });
    const old = peer.history;
    const snapshot = await peer.read();
    const capture = await captureScope(snapshot, ["O-0"], 0);
    const cursor = followFeed(peer, positionOf(snapshot));
    expect(await checkFresh(peer, capture, 0)).toEqual({ status: "current" });

    const other = child({ op: "open", path, restored: true });
    const renewed = await other.json<Record<string, string>>("histories");
    expect(renewed["peer:a"]).not.toBe(old);
    // The handle reads the history from the file.
    expect(peer.history).toBe(renewed["peer:a"]);
    expect(await refusal(snapshot.get([o.id]))).toBe("snapshot-moved");
    expect(await cursor.pull()).toEqual({
      status: "resync-required",
      current: { history: renewed["peer:a"], revision: 1 },
    });
    expect(await checkFresh(peer, capture, 0)).toEqual({ status: "resync-required", current: 1 });
    await store.close();
  }, 60_000);
});

// ---- retention at the default (decision S4-6) ---------------------------------------------------

describe("bounded retention at the default under two writers", () => {
  it("two processes write past 1024 revisions; the floor follows them, a follower behind it gets resync-required, and one at it gets every kept record", async () => {
    const path = await made();
    const store = await openSqliteStore(path);
    expect(store.profile.changeRetention).toEqual({ revisions: 1024 });
    const peer = await store.peer("peer:a");
    const behind = await peer.read();
    const cursor = followFeed(peer, positionOf(behind));
    behind.release();
    const BATCHES = 520;
    const a = child({ op: "write", path, peer: "peer:a", tag: "A", batches: BATCHES, size: 1 });
    const b = child({ op: "write", path, peer: "peer:a", tag: "B", batches: BATCHES, size: 1 });
    const [wa, wb] = await Promise.all([a.json<Written>("done"), b.json<Written>("done")]);
    const committed = byRevision(wa, wb);
    const total = 2 * BATCHES;
    expect(committed.size).toBe(total);
    audit(path);
    const floor = total - 1024;
    expect(await peer.changes(floor - 1)).toEqual({ status: "resync-required", current: total });
    const pull = await cursor.pull();
    expect(pull.status).toBe("resync-required");
    const revisions: number[] = [];
    for (let from = floor; from < total; ) {
      const page = await peer.changes(from);
      if (page.status !== "ok") throw new Error("a page at the floor answered resync-required");
      for (const record of page.records) {
        revisions.push(record.revision);
        expect(record.added).toEqual(committed.get(record.revision));
      }
      from = page.through;
    }
    expect(revisions).toEqual(Array.from({ length: 1024 }, (_, i) => floor + i + 1));
    await store.close();
  }, 180_000);
});
