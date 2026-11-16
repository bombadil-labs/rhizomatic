// Proven erasure on the SQLite store (SPEC-18 slice 4 plan §7, step 4b). Every rail runs on real
// files in its own `mkdtempSync` directory and removes it. A target carries a distinct marker in
// every place the schema copies erasable material (test/support/sqlite-erasure.ts). After each
// case the rail scans every file of the directory (the database, `-wal`, `-shm`, anything else)
// for the markers of the purged targets, and a named set of bystanders reads back through the
// store with the same bytes. A report may say `absent` only when no marker is in any file.
//
// The invariant under test: a trigger counts every delete of a `holding` or `delta` row in
// `residue.dirty`, a rebuild raises `residue.clean` to the count it read before it began, and a
// file surface is `absent` only when `clean = dirty` in the purge's last transaction.
//
// Each crash, and each window between two processes, is made from the test side: a child process
// wraps the statements of `better-sqlite3` in its own process (test/support/sqlite-erasure-child.ts).
// The store has no hook, switch or quirk for it.

import { spawn, type ChildProcess } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
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
  type PurgeReport,
  type Store,
  type StoreErrorCode,
} from "../src/storage/store.js";
import {
  appearance,
  deadMarkers,
  marked,
  markersOf,
  scan,
  space,
  writerOf,
  type Marked,
} from "./support/sqlite-erasure.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const childScript = resolve(here, "support/sqlite-erasure-child.ts");

const PROVEN_HERE = process.platform === "linux";
const FILE_SURFACES = [
  "rows",
  "index-entries",
  "page-free-space",
  "freed-pages",
  "write-ahead-log",
  "temp-files",
];
const every = (state: string): Record<string, string> =>
  Object.fromEntries(FILE_SURFACES.map((surface) => [surface, state]));
const states = (report: PurgeReport): Record<string, string> =>
  Object.fromEntries(report.surfaces.map((s) => [s.surface, s.state]));
const outcomes = (report: PurgeReport): Record<string, string> =>
  Object.fromEntries(report.targets.map((t) => [t.id, t.outcome]));
const ids = (deltas: readonly Marked[]): string[] => deltas.map((d) => d.delta.id);
const all = (deltas: readonly Marked[], outcome: string): Record<string, string> =>
  Object.fromEntries(deltas.map((d) => [d.delta.id, outcome]));
const removedAll = (deltas: readonly Marked[]): Record<string, string> => all(deltas, "removed");
const shape = (report: PurgeReport) => [report.claim, states(report), outcomes(report)];

const refusal = async (call: Promise<unknown>): Promise<StoreErrorCode | "answered"> =>
  call.then(
    () => "answered" as const,
    (error: unknown) => {
      if (error instanceof StoreError) return error.code;
      throw error;
    },
  );

const spaces: (() => void)[] = [];
const opened: Store[] = [];
const children: ChildProcess[] = [];
// A rail that fails while a child waits must not leave the child behind.
afterEach(() => {
  for (const proc of children.splice(0))
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
});
afterAll(async () => {
  for (const store of opened) await store.close();
  for (const remove of spaces) remove();
});

/** A directory for one rail, and the path of its store. */
function place(): { dir: string; path: string } {
  const { dir, remove } = space("rhizomatic-sqlite-erasure");
  spaces.push(remove);
  return { dir, path: join(dir, "store.db") };
}

async function open(path: string): Promise<SqliteStore> {
  const store = await openSqliteStore(path, { busyTimeoutMs: 100 });
  opened.push(store);
  return store;
}

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

/** The two counters and the records, read from the file by another connection. */
function ledger(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    const { dirty, clean } = db.prepare("SELECT dirty, clean FROM residue").get() as {
      dirty: number;
      clean: number;
    };
    const rows = (table: string) =>
      (db.prepare(`SELECT peer, delta FROM ${table}`).all() as { peer: string; delta: string }[])
        .map((r) => `${r.peer} ${r.delta}`)
        .sort();
    return { dirty, clean, records: rows("surface_debt"), debts: rows("debt") };
  } finally {
    db.close();
  }
}
const recordsOf = (peer: string, deltas: readonly Marked[]): string[] =>
  ids(deltas)
    .map((id) => `${peer} ${id}`)
    .sort();

/** The bystanders read back through the store with the same bytes, and every marker of theirs is in the file. */
async function bystandersHold(dir: string, peer: PeerStore, bystanders: readonly Marked[]) {
  const snapshot = await peer.read();
  const sortedIds = ids(bystanders).sort();
  const byId = new Map(bystanders.map((d) => [d.delta.id, d]));
  expect(await snapshot.get(ids(bystanders))).toEqual(sortedIds.map((id) => byId.get(id)!.delta));
  expect((await snapshot.arrivals(ids(bystanders))).map((a) => a.sender)).toEqual(
    sortedIds.map((id) => byId.get(id)!.sender),
  );
  snapshot.release();
  // The scan sees stored bytes: every marker of a bystander is found.
  expect(scan(dir, markersOf(bystanders)).length).toBeGreaterThanOrEqual(
    markersOf(bystanders).length,
  );
}

/** A store with one peer of each given posture, each holding its deltas. */
async function filled(
  path: string,
  holdings: Record<string, { posture: "proven" | "unproven"; deltas: readonly Marked[] }>,
): Promise<{ store: SqliteStore; peers: Record<string, PeerStore> }> {
  const store = await open(path);
  const peers: Record<string, PeerStore> = {};
  for (const [id, { posture, deltas }] of Object.entries(holdings)) {
    peers[id] = await store.createPeer(id, { erasure: posture });
    if (deltas.length > 0) await (await writerOf(peers[id])!)(deltas);
  }
  return { store, peers };
}

/** Runs the child with a mode; answers its report and how it ended. */
function child(path: string, peer: string, mode: string, purge: readonly string[]) {
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", childScript, path, peer, mode, JSON.stringify(purge)],
    { cwd: pkg, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(proc);
  let out = "";
  let errors = "";
  const waiters: { text: string; done: () => void }[] = [];
  proc.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    for (const w of waiters) if (out.includes(w.text)) w.done();
  });
  proc.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const ended = new Promise<string>((done) =>
    proc.on("exit", (code, signal) => done(String(signal ?? code))),
  );
  return {
    ended,
    /** Waits until the child prints `text`. */
    printed: (text: string) =>
      new Promise<void>((done, fail) => {
        if (out.includes(text)) return done();
        waiters.push({ text, done });
        void ended.then((how) =>
          fail(new Error(`the child ended (${how}) before it printed ${text}: ${errors}`)),
        );
      }),
    /** Waits until the child holds at `point`. */
    held: (point: string) =>
      new Promise<void>((done, fail) => {
        const text = `held ${point}\n`;
        if (out.includes(text)) return done();
        waiters.push({ text, done });
        void ended.then((how) =>
          fail(new Error(`the child ended (${how}) before it held at ${point}: ${errors}`)),
        );
      }),
    go: (point: string) => writeFileSync(`${path}.go-${point}`, ""),
    report: (): PurgeReport =>
      JSON.parse(
        out
          .split("\n")
          .find((line) => line.startsWith("report "))!
          .slice("report ".length),
      ) as PurgeReport,
    kill: () => proc.kill("SIGKILL"),
    errors: () => errors,
  };
}

const group = (tag: string, count: number, from = 0): Marked[] =>
  Array.from({ length: count }, (_, i) => marked(tag, from + i));

/** The markers only this holding carries: its sender and its signature. */
const ownMarkers = (deltas: readonly Marked[]): string[] =>
  deltas.flatMap((d) => [d.markers.sender, d.markers.signature]);

/** Wraps one method of every statement in this process; answers the undo. */
function wrap(
  method: "run" | "get",
  around: (
    this: Database.Statement,
    original: (...args: unknown[]) => unknown,
    args: unknown[],
  ) => unknown,
): () => void {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<
    "run" | "get",
    (this: Database.Statement, ...args: unknown[]) => unknown
  >;
  probe.close();
  const original = statement[method];
  statement[method] = function (...args) {
    return around.call(this, (...again) => original.apply(this, again), args);
  };
  return () => {
    statement[method] = original;
  };
}

/** Refuses the commit of the last transaction of each purge in this process. */
function refuseLastCommit(): () => void {
  let begun = 0;
  return wrap("run", function (original, args) {
    if (this.source === "BEGIN IMMEDIATE") begun++;
    if (this.source === "COMMIT" && begun === 2) {
      begun = 0;
      throw new Database.SqliteError("probe", "SQLITE_BUSY");
    }
    return original(...args);
  });
}

describe.skipIf(!PROVEN_HERE)("proven erasure on the SQLite store (plan §7)", () => {
  /**
   * 25 batches of 1,000 marked deltas on one peer. After each, 700 random deltas other than the
   * targets and the bystanders leave, so pages split on insert and merge on delete. Then the
   * targets (1 in 97) leave.
   */
  async function churn(posture: "proven" | "unproven") {
    const { dir, path } = place();
    const bystanders = group("By", 5);
    const { peers } = await filled(path, { "peer:a": { posture, deltas: bystanders } });
    const peer = peers["peer:a"]!;
    const write = await writerOf(peer);
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const live: Marked[] = [];
    const targets: Marked[] = [];
    for (let round = 0; round < 25; round++) {
      const batch = group("Sc", 1000, 1000 * round);
      await write(batch);
      for (const d of batch) (d.delta.claims.timestamp % 97 === 5 ? targets : live).push(d);
      const gone = Array.from(
        { length: 700 },
        () => live.splice(Math.floor(random() * live.length), 1)[0]!,
      );
      await peer.purge(ids(gone));
    }
    const report = await peer.purge(ids(targets));
    return { dir, peer, bystanders, targets, report };
  }

  it("rail 1, at scale: after churn that splits and merges pages, no marker of a purged target is in any file", async () => {
    const { dir, peer, bystanders, targets, report } = await churn("proven");
    expect(shape(report)).toEqual(["proven", every("absent"), removedAll(targets)]);
    expect(scan(dir, markersOf(targets))).toEqual([]);
    await bystandersHold(dir, peer, bystanders);
  }, 300_000);

  it("rail 1 sees residue: the same churn by a peer that asks for no proof leaves markers that secure_delete and a truncate do not reach", async () => {
    const { dir, peer, bystanders, targets, report } = await churn("unproven");
    expect([report.claim, states(report)]).toEqual(["unproven", every("owed")]);
    // The log is truncated, as a close does; the residue is in the database file itself.
    const db = new Database(join(dir, "store.db"));
    expect(db.pragma("wal_checkpoint(TRUNCATE)", { simple: true })).toBe(0);
    db.close();
    expect(scan(dir, markersOf(targets)).length).toBeGreaterThan(0);
    await bystandersHold(dir, peer, bystanders);
  }, 300_000);

  it("rail 2: a purge of every delta of a peer leaves no marker of them in any file; another peer's bystanders stay", async () => {
    const { dir, path } = place();
    const everything = group("Ev", 2000);
    const bystanders = group("Bs", 5);
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: everything },
      "peer:b": { posture: "proven", deltas: bystanders },
    });
    const a = peers["peer:a"]!;
    for (let i = 0; i < everything.length; i += 500) {
      const report = await a.purge(ids(everything.slice(i, i + 500)));
      expect([report.claim, states(report)]).toEqual(["proven", every("absent")]);
    }
    expect((await a.read()).count).toBe(0);
    expect(scan(dir, markersOf(everything))).toEqual([]);
    await bystandersHold(dir, peers["peer:b"]!, bystanders);
  }, 120_000);

  it("rail 3: a busy log gives owed on every file surface and never proven; the record survives a kill and a reopen; an unrelated purge under the same busy log is reported on its own", async () => {
    const { dir, path } = place();
    const [x, y, bystanders] = [group("X3", 4), group("Y3", 4), group("B3", 4)];
    const { store } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...y, ...bystanders] },
    });
    await store.close();
    const held = reader(path);
    // A child purges x while the reader holds the log, prints its report, and is killed.
    const run = child(path, "peer:a", "hold-report", ids(x));
    await run.held("report");
    run.kill();
    expect(await run.ended).toBe("SIGKILL");
    const first = run.report();
    expect(shape(first)).toEqual(["unproven", every("owed"), removedAll(x)]);
    // The report is true: the file still holds the bytes it names as owed.
    expect(scan(dir, markersOf(x)).length).toBeGreaterThan(0);
    const after = ledger(path);
    expect(after.clean).toBeLessThan(after.dirty);
    expect(after.records).toEqual(recordsOf("peer:a", x));
    // A reopened store keeps the record. An unrelated purge under the same busy log names only
    // its own targets, and owes too.
    const again = await open(path);
    const a = await again.peer("peer:a");
    const second = await a.purge(ids(y));
    expect(shape(second)).toEqual(["unproven", every("owed"), removedAll(y)]);
    const nothing = await a.purge([]);
    expect([nothing.claim, states(nothing)]).toEqual(["nothing-removed", every("owed")]);
    held.release();
    // The later proof (decision S4-13): the peer asks again once the reader lets go.
    const later = await a.purge(ids(x));
    expect(shape(later)).toEqual(["proven", every("absent"), removedAll(x)]);
    expect(scan(dir, markersOf([...x, ...y]))).toEqual([]);
    const end = ledger(path);
    expect([end.clean, end.records]).toEqual([end.dirty, recordsOf("peer:a", y)]);
    await bystandersHold(dir, a, bystanders);
  }, 120_000);

  it("rail 4: a purge that removes nothing rebuilds while the file is not clean; the next ask answers removed and proven, and ends the record", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("X4", 4), group("B4", 4)];
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...bystanders] },
    });
    const a = peers["peer:a"]!;
    const held = reader(path);
    expect(states(await a.purge(ids(x)))).toEqual(every("owed"));
    held.release();
    const before = ledger(path);
    expect(before.clean).toBeLessThan(before.dirty);
    const nothing = await a.purge(["never-held"]);
    expect(shape(nothing)).toEqual([
      "nothing-removed",
      every("absent"),
      { "never-held": "not-held" },
    ]);
    // The rebuild ran: the file is clean, the records stay, and no marker is left.
    expect(ledger(path)).toEqual({
      dirty: before.dirty,
      clean: before.dirty,
      records: recordsOf("peer:a", x),
      debts: [],
    });
    expect(scan(dir, markersOf(x))).toEqual([]);
    const proof = await a.purge(ids(x));
    expect([...shape(proof), proof.retains]).toEqual([
      "proven",
      every("absent"),
      removedAll(x),
      [{ surface: "change-feed", holds: "id" }],
    ]);
    expect(ledger(path).records).toEqual([]);
    expect(outcomes(await a.purge(ids(x)))).toEqual(all(x, "not-held"));
    await bystandersHold(dir, a, bystanders);
  }, 60_000);

  it("rail 5: bytes another peer holds stay, and the report says held-by-other-peer without a name", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("X5", 3), group("B5", 3)];
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...bystanders] },
      "peer:secret-holder": { posture: "proven", deltas: x },
    });
    const report = await peers["peer:a"]!.purge(ids(x));
    expect([report.claim, outcomes(report)]).toEqual([
      "nothing-removed",
      all(x, "held-by-other-peer"),
    ]);
    expect(report.retains.map((r) => r.surface)).toEqual(["change-feed", "purge-debt"]);
    expect(JSON.stringify(report)).not.toContain("secret-holder");
    await bystandersHold(dir, peers["peer:secret-holder"]!, x);
    await bystandersHold(dir, peers["peer:a"]!, bystanders);
  });

  it("rail 6: a peer of posture proven is accepted on a store of class proven", async () => {
    const { path } = place();
    const store = await open(path);
    expect(store.profile.capabilities.erasure).toBe("proven");
    const peer = await store.createPeer("peer:p", { erasure: "proven" });
    expect(peer.erasure).toEqual({ posture: "proven", storeClass: "proven" });
    expect((await store.peer("peer:p")).erasure).toEqual({
      posture: "proven",
      storeClass: "proven",
    });
  });

  it("rail 8: an id leaves the files at the first rebuild after retention drops the record that names it; retains names the feed until then", async () => {
    const { dir, path } = place();
    const store = await openSqliteStore(path, {
      busyTimeoutMs: 100,
      changeRetention: { revisions: 2 },
    });
    opened.push(store);
    const a = await store.createPeer("peer:a", { erasure: "proven" });
    const [x, w, later, bystanders] = [
      group("X8", 1),
      group("W8", 1),
      group("L8", 2),
      group("B8", 2),
    ];
    const write = await writerOf(a);
    await write([...x, ...w, ...bystanders]);
    const first = await a.purge(ids(x));
    expect([first.claim, first.retains.map((r) => r.surface)]).toEqual([
      "proven",
      ["change-feed", "surface-debt"],
    ]);
    // The feed and the record hold the id after the proof.
    expect(scan(dir, ids(x))).not.toEqual([]);
    // Two appends: retention drops the records that name x. An append runs no rebuild.
    await write(later.slice(0, 1));
    await write(later.slice(1));
    const ask = await a.purge(ids(x));
    expect([ask.claim, ask.retains]).toEqual(["proven", [{ surface: "change-feed", holds: "id" }]]);
    // The next rebuild, by the purge of w, writes the file without x's id; w's record is kept.
    expect((await a.purge(ids(w))).claim).toBe("proven");
    expect(scan(dir, ids(x))).toEqual([]);
    expect(scan(dir, ids(w))).not.toEqual([]);
    await bystandersHold(dir, a, bystanders);
  });

  it("rail 9, two peers in one file: A can reach proven after B's purge under a busy log", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("X9", 3), group("B9", 3)];
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...bystanders] },
      "peer:b": { posture: "proven", deltas: x },
    });
    const [a, b] = [peers["peer:a"]!, peers["peer:b"]!];
    expect(outcomes(await a.purge(ids(x)))).toEqual(all(x, "held-by-other-peer"));
    const held = reader(path);
    expect(shape(await b.purge(ids(x)))).toEqual(["unproven", every("owed"), removedAll(x)]);
    // A's purge debt answers removed, but the file is not clean: every surface is owed.
    expect(shape(await a.purge(ids(x)))).toEqual(["unproven", every("owed"), removedAll(x)]);
    expect(scan(dir, markersOf(x)).length).toBeGreaterThan(0);
    held.release();
    for (const peer of [a, b])
      expect([peer.id, ...shape(await peer.purge(ids(x)))]).toEqual([
        peer.id,
        "proven",
        every("absent"),
        removedAll(x),
      ]);
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystandersHold(dir, a, bystanders);
  });

  it("rail 10: a peer of posture unproven runs no rebuild and says owed and unproven, and keeps no record; a later rebuild by another peer cleans the file", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("X10", 3), group("B10", 3)];
    const { peers } = await filled(path, {
      "peer:u": { posture: "unproven", deltas: [...x, ...bystanders] },
      "peer:p": { posture: "proven", deltas: [] },
    });
    const before = ledger(path);
    expect(before.clean).toBe(before.dirty);
    expect(shape(await peers["peer:u"]!.purge(ids(x)))).toEqual([
      "unproven",
      every("owed"),
      removedAll(x),
    ]);
    // No rebuild ran: two rows left per id, `clean` stands, and the log still holds the bytes.
    expect(ledger(path)).toEqual({
      dirty: before.dirty + 2 * x.length,
      clean: before.clean,
      records: [],
      debts: [],
    });
    expect(scan(dir, markersOf(x)).length).toBeGreaterThan(0);
    const held = reader(path);
    expect(states(await peers["peer:p"]!.purge([]))).toEqual(every("owed"));
    expect(states(await peers["peer:u"]!.purge([]))).toEqual(every("owed"));
    held.release();
    expect(states(await peers["peer:u"]!.purge([]))).toEqual(every("owed"));
    const settle = await peers["peer:p"]!.purge([]);
    expect([settle.claim, states(settle)]).toEqual(["nothing-removed", every("absent")]);
    const end = ledger(path);
    expect(end.clean).toBe(end.dirty);
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystandersHold(dir, peers["peer:u"]!, bystanders);
  });

  it("the counter: every store path that deletes a holding or delta row raises dirty in its own transaction, by one per row; a rolled-back delete, a refused purge and VACUUM leave it; a cascaded pointer row needs no count of its own", async () => {
    const { dir, path } = place();
    const [x, y, s, bystanders] = [group("XD", 3), group("YD", 2), group("SD", 2), group("BD", 2)];
    const sa = s.map((d, i) => appearance("SA", i, d));
    const { peers } = await filled(path, {
      "peer:u": { posture: "unproven", deltas: [...x, ...y, ...s, ...bystanders] },
      "peer:a": { posture: "proven", deltas: sa },
    });
    const u = peers["peer:u"]!;
    const count = () => ledger(path).dirty;
    // No statement deletes a pointer row or rewrites a holding or a delta: the pointer rows leave
    // only by the cascade from their holding, inside the delete the trigger counts.
    expect(
      Object.entries(SQLITE_STATEMENTS)
        .filter(([, sql]) =>
          /DELETE FROM (target|reference)\b|UPDATE (holding|delta)\b|REPLACE/i.test(sql),
        )
        .map(([name]) => name),
    ).toEqual([]);
    const start = count();
    // A removal: one holding and one delta per id; each delta has three pointer rows.
    expect(outcomes(await u.purge(ids(x)))).toEqual(removedAll(x));
    expect(count()).toBe(start + 2 * x.length);
    // A release: the holding only; the other peer keeps the delta row.
    expect(outcomes(await u.purge(ids(s)))).toEqual(all(s, "held-by-other-peer"));
    expect(count()).toBe(start + 2 * x.length + s.length);
    const counted = count();
    // A purge whose first transaction fails leaves the count and the holdings as they were.
    const undo = wrap("run", function (original, args) {
      if (this.source === SQLITE_STATEMENTS.changeAdd)
        throw new Database.SqliteError("probe", "SQLITE_IOERR_WRITE");
      return original(...args);
    });
    try {
      expect(await refusal(u.purge(ids(y)))).toBe("store-unavailable");
    } finally {
      undo();
    }
    expect(count()).toBe(counted);
    expect((await u.read()).count).toBe(y.length + bystanders.length);
    // A rolled-back delete in another connection, and a VACUUM, leave the count.
    const db = new Database(path);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM holding WHERE delta = ?").run(y[0]!.delta.id);
    db.prepare("DELETE FROM delta WHERE id = ?").run(y[0]!.delta.id);
    expect((db.prepare("SELECT dirty FROM residue").get() as { dirty: number }).dirty).toBe(
      counted + 2,
    );
    db.exec("ROLLBACK");
    db.exec("VACUUM");
    expect(() => db.exec("DELETE FROM residue")).toThrow(/the residue row is kept/);
    expect(() => db.exec("UPDATE residue SET clean = dirty + 1")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO residue (one, dirty, clean) VALUES (2, 0, 0)")).toThrow(
      /CHECK/,
    );
    db.close();
    expect(count()).toBe(counted);
    expect(scan(dir, markersOf(y)).length).toBeGreaterThanOrEqual(markersOf(y).length);
    await bystandersHold(dir, u, [...y, ...bystanders]);
  });

  describe("two processes: the other process acts in each window of a held purge, and the report is true at its last commit", () => {
    const actions = ["i", "ii", "iii", "iv", "v"] as const;
    type Action = (typeof actions)[number];
    const ACTION: Record<Action, string> = {
      i: "appends X and purges X as a peer of posture unproven",
      ii: "appends X and purges X as a peer of posture proven under a busy log",
      iii: "purges an unrelated id",
      iv: "releases a shared id",
      v: "appends X only",
    };
    const cases: [posture: "proven" | "unproven", window: string, action: Action][] = [
      ...["read", "vacuum", "checkpoint", "last"].flatMap((window) =>
        actions.map((action) => ["proven", window, action] as ["proven", string, Action]),
      ),
      ...actions.map((action) => ["unproven", "last", action] as ["unproven", string, Action]),
    ];
    for (const [posture, window, action] of cases)
      it(`B of posture ${posture} held at ${window}; another process ${ACTION[action]}`, async () => {
        const { dir, path } = place();
        const [xb, y, sr, bystanders] = [
          group("XB", 2),
          group("YQ", 2),
          group("SR", 2),
          group("BY", 2),
        ];
        const [xa, xu, xp, sa] = [
          xb.map((d, i) => appearance("XA", i, d)),
          xb.map((d, i) => appearance("XU", i, d)),
          xb.map((d, i) => appearance("XP", i, d)),
          sr.map((d, i) => appearance("SA", i, d)),
        ];
        const { store } = await filled(path, {
          "peer:a": { posture: "proven", deltas: [...bystanders, ...sa] },
          "peer:b": { posture, deltas: xb },
          "peer:u": { posture: "unproven", deltas: [] },
          "peer:p": { posture: "proven", deltas: [] },
          "peer:q": { posture: "unproven", deltas: y },
          "peer:r": { posture: "unproven", deltas: sr },
        });
        await store.close();
        const run = child(path, "peer:b", `hold-${window},hold-after-last`, ids(xb));
        await run.held(window);
        const again = await open(path);
        const peer = (id: string) => again.peer(id);
        if (action === "i") {
          const u = await peer("peer:u");
          await (
            await writerOf(u)
          )(xu);
          expect(outcomes(await u.purge(ids(xb)))).toEqual(removedAll(xb));
        } else if (action === "ii") {
          const p = await peer("peer:p");
          await (
            await writerOf(p)
          )(xp);
          const busy = reader(path);
          expect(shape(await p.purge(ids(xb)))).toEqual([
            "unproven",
            every("owed"),
            removedAll(xb),
          ]);
          busy.release();
        } else if (action === "iii")
          expect(outcomes(await (await peer("peer:q")).purge(ids(y)))).toEqual(removedAll(y));
        else if (action === "iv")
          expect(outcomes(await (await peer("peer:r")).purge(ids(sr)))).toEqual(
            all(sr, "held-by-other-peer"),
          );
        else await (await writerOf(await peer("peer:a")))(xa);
        run.go(window);
        await run.held("after-last");
        // The scan at the instant of the last commit: every dead appearance of every peer.
        const dead = deadMarkers(path, [...xb, ...xa, ...xu, ...xp, ...y, ...sr, ...sa]);
        const found = scan(dir, dead);
        run.go("after-last");
        expect(await run.ended).toBe("0");
        const report = run.report();
        const cleaned = posture === "proven" && window === "read";
        expect(shape(report)).toEqual(
          action === "v"
            ? [
                "nothing-removed",
                every(posture === "proven" ? "absent" : "owed"),
                all(xb, "held-by-other-peer"),
              ]
            : [cleaned ? "proven" : "unproven", every(cleaned ? "absent" : "owed"), removedAll(xb)],
        );
        if (report.surfaces.some((surface) => surface.state === "absent")) {
          expect(dead.length).toBeGreaterThan(0);
          expect(found).toEqual([]);
        }
        const a = await peer("peer:a");
        if (action === "v") {
          // B has the purge debt it would have had had its first transaction seen A's holding.
          const b = await peer("peer:b");
          expect(ledger(path).debts).toEqual(recordsOf("peer:b", xb));
          expect(outcomes(await b.purge(ids(xb)))).toEqual(all(xb, "held-by-other-peer"));
          expect(shape(await a.purge(ids(xa)))).toEqual([
            "proven",
            every("absent"),
            removedAll(xa),
          ]);
          const asked = await b.purge(ids(xb));
          expect(shape(asked)).toEqual([posture, every("absent"), removedAll(xb)]);
          expect(scan(dir, markersOf([...xb, ...xa]))).toEqual([]);
          expect(outcomes(await b.purge(ids(xb)))).toEqual(all(xb, "not-held"));
        }
        await bystandersHold(dir, a, bystanders);
      }, 60_000);
  });

  it("an unproven peer's later ask of a removed id answers not-held: the counter is its record", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("XN", 2), group("BN", 2)];
    const { peers } = await filled(path, {
      "peer:u": { posture: "unproven", deltas: [...x, ...bystanders] },
    });
    const u = peers["peer:u"]!;
    expect(shape(await u.purge(ids(x)))).toEqual(["unproven", every("owed"), removedAll(x)]);
    expect(shape(await u.purge(ids(x)))).toEqual([
      "nothing-removed",
      every("owed"),
      all(x, "not-held"),
    ]);
    expect(ledger(path).records).toEqual([]);
    await bystandersHold(dir, u, bystanders);
  });

  for (const [mode, point] of [
    ["kill-delete-commit", "just after the delete commits"],
    ["kill-read-done", "just after the rebuild reads the count"],
    ["hold-in-vacuum,hold-checkpoint", "during VACUUM"],
    ["kill-checkpoint-done", "just after the checkpoint"],
    ["kill-in-last", "inside the last transaction"],
    ["kill-after-last", "just after the last transaction commits"],
  ] as const)
    it(`a crash ${point}: after a reopen clean <= dirty, nothing says absent unless the file is clean and a scan agrees, and the next ask proves`, async () => {
      const { dir, path } = place();
      const [x, filler, bystanders] = [group("XC", 3), group("FC", 1500), group("BC", 3)];
      const { store } = await filled(path, {
        "peer:a": { posture: "proven", deltas: [...x, ...filler, ...bystanders] },
      });
      await store.close();
      const run = child(path, "peer:a", mode, ids(x));
      if (mode.startsWith("hold-in-vacuum")) {
        await run.held("in-vacuum");
        run.kill();
      }
      expect(await run.ended).toBe("SIGKILL");
      const after = ledger(path);
      expect(after.clean).toBeLessThanOrEqual(after.dirty);
      expect(after.records).toEqual(recordsOf("peer:a", x));
      if (mode === "kill-after-last") {
        expect(after.clean).toBe(after.dirty);
        expect(scan(dir, markersOf(x))).toEqual([]);
      } else expect(after.clean).toBeLessThan(after.dirty);
      const again = await open(path);
      const a = await again.peer("peer:a");
      const held = reader(path);
      expect(states(await a.purge([]))).toEqual(
        every(mode === "kill-after-last" ? "absent" : "owed"),
      );
      held.release();
      expect(shape(await a.purge(ids(x)))).toEqual(["proven", every("absent"), removedAll(x)]);
      expect(scan(dir, markersOf(x))).toEqual([]);
      await bystandersHold(dir, a, bystanders);
    }, 60_000);

  describe("a rebuild or a truncate that fails gives owed on every file surface", () => {
    const faults: Record<string, { method: "run" | "get"; sql: string; answer: () => unknown }> = {
      "VACUUM busy": {
        method: "run",
        sql: SQLITE_STATEMENTS.vacuum,
        answer: () => fail("SQLITE_BUSY"),
      },
      "VACUUM locked": {
        method: "run",
        sql: SQLITE_STATEMENTS.vacuum,
        answer: () => fail("SQLITE_LOCKED"),
      },
      "VACUUM with a full disk": {
        method: "run",
        sql: SQLITE_STATEMENTS.vacuum,
        answer: () => fail("SQLITE_FULL"),
      },
      "VACUUM with an I/O error": {
        method: "run",
        sql: SQLITE_STATEMENTS.vacuum,
        answer: () => fail("SQLITE_IOERR_WRITE"),
      },
      "the read of the count busy": {
        method: "get",
        sql: SQLITE_STATEMENTS.residueDirty,
        answer: () => fail("SQLITE_BUSY"),
      },
      "the checkpoint throws": {
        method: "get",
        sql: SQLITE_STATEMENTS.checkpoint,
        answer: () => fail("SQLITE_IOERR_TRUNCATE"),
      },
      "the checkpoint answers busy": {
        method: "get",
        sql: SQLITE_STATEMENTS.checkpoint,
        answer: () => ({ busy: 1, log: 4, checkpointed: 2 }),
      },
      "the checkpoint leaves frames": {
        method: "get",
        sql: SQLITE_STATEMENTS.checkpoint,
        answer: () => ({ busy: 0, log: 4, checkpointed: 4 }),
      },
    };
    function fail(code: string): never {
      throw new Database.SqliteError("probe", code);
    }
    for (const [name, fault] of Object.entries(faults))
      it(name, async () => {
        const { dir, path } = place();
        const [x, bystanders] = [group("XF", 2), group("BF", 2)];
        const { peers } = await filled(path, {
          "peer:a": { posture: "proven", deltas: [...x, ...bystanders] },
        });
        const a = peers["peer:a"]!;
        const undo = wrap(fault.method, function (original, args) {
          if (this.source === fault.sql) return fault.answer();
          return original(...args);
        });
        let report: PurgeReport;
        try {
          report = await a.purge(ids(x));
        } finally {
          undo();
        }
        expect(shape(report)).toEqual(["unproven", every("owed"), removedAll(x)]);
        const after = ledger(path);
        expect([after.clean < after.dirty, after.records]).toEqual([true, recordsOf("peer:a", x)]);
        const proof = await a.purge(ids(x));
        expect([proof.claim, states(proof)]).toEqual(["proven", every("absent")]);
        expect(scan(dir, markersOf(x))).toEqual([]);
        await bystandersHold(dir, a, bystanders);
      });
  });

  it("a record proves a removal until the id is appended again: an append of the id ends every peer's record", async () => {
    const { dir, path } = place();
    const [x, w, v, bystanders] = [group("XS", 2), group("WS", 2), group("VS", 2), group("BS", 2)];
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: bystanders },
      "peer:b": { posture: "proven", deltas: [...x, ...w, ...v] },
    });
    const [a, b] = [peers["peer:a"]!, peers["peer:b"]!];
    // (d) A record, and nobody appended the id again: the later proof is proven.
    expect((await b.purge(ids(w))).claim).toBe("proven");
    expect(shape(await b.purge(ids(w)))).toEqual(["proven", every("absent"), removedAll(w)]);
    // (a) An append of the id by another peer ends B's record in the same transaction. B asks
    // while A holds the bytes: B owes nothing and learns nothing.
    expect((await b.purge(ids(x))).claim).toBe("proven");
    await (
      await writerOf(a)
    )(x);
    expect(ledger(path).records).toEqual([]);
    const asked = await b.purge(ids(x));
    expect([asked.claim, outcomes(asked)]).toEqual(["nothing-removed", all(x, "not-held")]);
    // (b) A removal under a busy log, then an append by another peer: the record ends too, and
    // B's next ask answers not-held, as the memory store does.
    const held = reader(path);
    expect(states(await b.purge(ids(v)))).toEqual(every("owed"));
    expect(ledger(path).records).toEqual(recordsOf("peer:b", v));
    await (
      await writerOf(a)
    )(v);
    held.release();
    expect(ledger(path).records).toEqual([]);
    expect(outcomes(await b.purge(ids(v)))).toEqual(all(v, "not-held"));
    expect(shape(await a.purge(ids(v)))).toEqual(["proven", every("absent"), removedAll(v)]);
    expect(outcomes(await b.purge(ids(v)))).toEqual(all(v, "not-held"));
    expect(scan(dir, markersOf([...v, ...w]))).toEqual([]);
    await bystandersHold(dir, a, [...x, ...bystanders]);
  });

  it("(c) a peer that appends an id again after its proof ends its own record, and its next purge proves anew", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("XO", 2), group("BO", 2)];
    const { peers } = await filled(path, {
      "peer:b": { posture: "proven", deltas: [...x, ...bystanders] },
    });
    const b = peers["peer:b"]!;
    expect((await b.purge(ids(x))).claim).toBe("proven");
    await (
      await writerOf(b)
    )(x);
    expect(ledger(path).records).toEqual([]);
    expect(shape(await b.purge(ids(x)))).toEqual(["proven", every("absent"), removedAll(x)]);
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystandersHold(dir, b, bystanders);
  });

  for (const posture of ["proven", "unproven"] as const)
    it(`a release by a peer of posture ${posture} leaves the bytes to another peer and owes the residue of its own rows until a rebuild`, async () => {
      const { dir, path } = place();
      const [xa, ya, bystanders] = [group("XH", 2), group("YH", 2), group("BH", 2)];
      const xb = xa.map((d, i) => appearance("ZH", i, d));
      const yb = ya.map((d, i) => appearance("ZH", 10 + i, d));
      const { peers } = await filled(path, {
        "peer:a": { posture, deltas: [...xa, ...ya] },
        "peer:b": { posture: "proven", deltas: [...xb, ...yb, ...bystanders] },
      });
      const [a, b] = [peers["peer:a"]!, peers["peer:b"]!];
      const released = all(xa, "held-by-other-peer");
      // Under a busy log: nothing removed, and every file surface owed.
      const held = reader(path);
      expect(shape(await a.purge(ids(xa)))).toEqual(["nothing-removed", every("owed"), released]);
      expect(scan(dir, ownMarkers(xa)).length).toBeGreaterThan(0);
      held.release();
      expect(states(await b.purge([]))).toEqual(every("absent"));
      expect(scan(dir, ownMarkers(xa))).toEqual([]);
      // Without a busy log a peer of posture proven rebuilds at once; one of posture unproven
      // owes until another peer rebuilds.
      const now = await a.purge(ids(ya));
      expect([now.claim, states(now)]).toEqual([
        "nothing-removed",
        every(posture === "proven" ? "absent" : "owed"),
      ]);
      if (posture === "unproven") {
        expect(scan(dir, ownMarkers(ya)).length).toBeGreaterThan(0);
        expect(states(await b.purge([]))).toEqual(every("absent"));
      }
      expect(scan(dir, ownMarkers(ya))).toEqual([]);
      // B's copies stay, with B's senders and signatures.
      await bystandersHold(dir, b, [...xb, ...yb, ...bystanders]);
    });

  it("the rebuild runs before the truncate: after a proven report the log is far smaller than the file", async () => {
    const { path } = place();
    const [x, rest] = [group("XL", 10), group("RL", 3000)];
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...rest] },
    });
    expect((await peers["peer:a"]!.purge(ids(x))).claim).toBe("proven");
    const [log, file] = [statSync(`${path}-wal`).size, statSync(path).size];
    expect(file).toBeGreaterThan(1_000_000);
    expect(log).toBeLessThan(file / 4);
  });

  it("a proven peer whose purge debt an unproven peer's removal answered can reach proven", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("XK", 2), group("BK", 2)];
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...bystanders] },
      "peer:u": { posture: "unproven", deltas: x },
    });
    const [a, u] = [peers["peer:a"]!, peers["peer:u"]!];
    expect(outcomes(await a.purge(ids(x)))).toEqual(all(x, "held-by-other-peer"));
    expect(outcomes(await u.purge(ids(x)))).toEqual(removedAll(x));
    const held = reader(path);
    expect(shape(await a.purge(ids(x)))).toEqual(["unproven", every("owed"), removedAll(x)]);
    held.release();
    expect(shape(await a.purge(ids(x)))).toEqual(["proven", every("absent"), removedAll(x)]);
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystandersHold(dir, a, bystanders);
  });

  it("a mixed call gives the same report whichever way its ids sort, under a clean rebuild and under a busy log, and so does the next ask", async () => {
    const roles = ["removed", "held", "never", "record", "debt", "reheld"] as const;
    type Role = (typeof roles)[number];
    const pool = group("OM", 6).sort((p, q) => (p.delta.id < q.delta.id ? -1 : 1));
    async function play(order: readonly Marked[], busy: boolean) {
      const { dir, path } = place();
      const role = Object.fromEntries(roles.map((r, i) => [r, order[i]!])) as Record<Role, Marked>;
      const bystanders = group(`BM${busy ? 1 : 0}${order === pool ? 1 : 0}`, 2);
      const other = (d: Marked, tag: string) => appearance(tag, pool.indexOf(d), d);
      const { peers } = await filled(path, {
        "peer:b": {
          posture: "proven",
          deltas: [role.removed, role.held, role.record, role.debt, role.reheld, ...bystanders],
        },
        "peer:a": { posture: "proven", deltas: [other(role.held, "OA")] },
        "peer:c": { posture: "proven", deltas: [other(role.debt, "OC")] },
      });
      const [b, c] = [peers["peer:b"]!, peers["peer:c"]!];
      expect((await b.purge(ids([role.record, role.reheld]))).claim).toBe("proven");
      await (
        await writerOf(b)
      )([role.reheld]);
      expect(outcomes(await b.purge(ids([role.debt])))).toEqual(
        all([role.debt], "held-by-other-peer"),
      );
      expect((await c.purge(ids([role.debt]))).claim).toBe("proven");
      const name = new Map(roles.map((r) => [role[r].delta.id, r]));
      const named = (report: PurgeReport) => ({
        ...report,
        targets: report.targets
          .map((t) => ({ id: name.get(t.id)!, outcome: t.outcome }))
          .sort((p, q) => (p.id < q.id ? -1 : 1)),
      });
      const held = busy ? reader(path) : undefined;
      const first = named(await b.purge(ids(order)));
      held?.release();
      const next = named(await b.purge(ids(order)));
      expect(scan(dir, markersOf([role.removed, role.record, role.debt, role.reheld]))).toEqual([]);
      await bystandersHold(dir, b, bystanders);
      return { first, next };
    }
    for (const busy of [false, true]) {
      const up = await play(pool, busy);
      const down = await play([...pool].reverse(), busy);
      expect(down).toEqual(up);
      const told = (report: { targets: { id: string; outcome: string }[] }) =>
        Object.fromEntries(report.targets.map((t) => [t.id, t.outcome]));
      expect([up.first.claim, told(up.first)]).toEqual([
        busy ? "unproven" : "proven",
        {
          removed: "removed",
          held: "held-by-other-peer",
          never: "not-held",
          record: "removed",
          debt: "removed",
          reheld: "removed",
        },
      ]);
      expect([up.next.claim, told(up.next)]).toEqual([
        "proven",
        {
          removed: "removed",
          held: "held-by-other-peer",
          never: "not-held",
          record: busy ? "removed" : "not-held",
          debt: busy ? "removed" : "not-held",
          reheld: "removed",
        },
      ]);
    }
  }, 60_000);

  for (const [name, holders] of [
    ["an unproven removal", { "peer:u": "unproven" }],
    ["a release", { "peer:u": "proven", "peer:a": "proven" }],
  ] as const)
    it(`a crash just after the delete commits of ${name} leaves the file not clean: a proven ask after a reopen is owed until it rebuilds`, async () => {
      const { dir, path } = place();
      const [x, bystanders] = [group("XK5", 2), group("BK5", 2)];
      const { store } = await filled(path, {
        "peer:p": { posture: "proven", deltas: bystanders },
        ...Object.fromEntries(
          Object.entries(holders).map(([peer, posture], k) => [
            peer,
            { posture, deltas: k === 0 ? x : x.map((d, i) => appearance("AK5", i, d)) },
          ]),
        ),
      });
      await store.close();
      const run = child(path, "peer:u", "kill-delete-commit", ids(x));
      expect(await run.ended).toBe("SIGKILL");
      const after = ledger(path);
      expect([after.clean < after.dirty, after.records]).toEqual([true, []]);
      const again = await open(path);
      const p = await again.peer("peer:p");
      const held = reader(path);
      expect(states(await p.purge([]))).toEqual(every("owed"));
      held.release();
      expect(states(await p.purge([]))).toEqual(every("absent"));
      expect(scan(dir, ownMarkers(x))).toEqual([]);
      await bystandersHold(dir, p, bystanders);
    }, 60_000);

  it("a purge whose last transaction cannot commit refuses store-unavailable; its delete stays, and the retry reports the present state: a proven peer keeps removed for a removal, a record and a purge debt", async () => {
    const { dir, path } = place();
    const [r, k, d, n, bystanders] = [
      group("RT6", 2),
      group("KT6", 2),
      group("DT6", 2),
      group("NT6", 2),
      group("BT6", 2),
    ];
    const { peers } = await filled(path, {
      "peer:b": { posture: "proven", deltas: [...r, ...k, ...d, ...bystanders] },
      "peer:c": { posture: "proven", deltas: d.map((x, i) => appearance("CT6", i, x)) },
      "peer:u": { posture: "unproven", deltas: n },
    });
    const [b, c, u] = [peers["peer:b"]!, peers["peer:c"]!, peers["peer:u"]!];
    expect((await b.purge(ids(k))).claim).toBe("proven");
    expect(outcomes(await b.purge(ids(d)))).toEqual(all(d, "held-by-other-peer"));
    expect((await c.purge(ids(d))).claim).toBe("proven");
    const asked = [...r, ...k, ...d];
    for (const [peer, targets] of [
      [b, asked],
      [u, n],
    ] as const) {
      const undo = refuseLastCommit();
      let error: unknown;
      try {
        error = await peer.purge(ids(targets)).catch((e: unknown) => e);
      } finally {
        undo();
      }
      expect([(error as StoreError).code, (error as StoreError).message]).toEqual([
        "store-unavailable",
        expect.stringContaining("ask again"),
      ]);
    }
    // The deletes committed in the first transaction of each call.
    expect([(await b.read()).count, (await u.read()).count]).toEqual([bystanders.length, 0]);
    expect(ledger(path).debts).toEqual(recordsOf("peer:b", d));
    expect(shape(await b.purge(ids(asked)))).toEqual([
      "proven",
      every("absent"),
      removedAll(asked),
    ]);
    // An unproven peer keeps no record: its retry answers not-held, which claims nothing.
    expect(shape(await u.purge(ids(n)))).toEqual([
      "nothing-removed",
      every("absent"),
      all(n, "not-held"),
    ]);
    expect(scan(dir, markersOf([...r, ...k, ...d, ...n]))).toEqual([]);
    await bystandersHold(dir, b, bystanders);
  });

  it("a re-held and re-purged id is owed again under a busy log, and proven after it", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("XR", 2), group("BR", 2)];
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...bystanders] },
    });
    const a = peers["peer:a"]!;
    const held = reader(path);
    expect(states(await a.purge(ids(x)))).toEqual(every("owed"));
    await (
      await writerOf(a)
    )(x);
    expect(ledger(path).records).toEqual([]);
    expect(shape(await a.purge(ids(x)))).toEqual(["unproven", every("owed"), removedAll(x)]);
    expect(ledger(path).records).toEqual(recordsOf("peer:a", x));
    held.release();
    expect((await a.purge(ids(x))).claim).toBe("proven");
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystandersHold(dir, a, bystanders);
  });
});

describe("the erasure class on Windows and macOS is unprovable, and its reports never say proven", () => {
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

  for (const name of ["win32", "darwin"])
    it(`rail 6, ${name}: proven is refused at create and at open, also after a caller replaces the profile; an unproven peer's purge says unproven with temp files unprovable`, async () => {
      const windows = await on(name);
      expect(process.platform).not.toBe(name);
      const { dir, path } = place();
      if (PROVEN_HERE) {
        const here = await open(path);
        await here.createPeer("peer:p", { erasure: "proven" });
        await here.close();
      }
      const store = await windows.openSqliteStore(path, { busyTimeoutMs: 100 });
      opened.push(store);
      expect(store.profile.capabilities.erasure).toBe("unprovable");
      expect(await refusal(store.createPeer("peer:q", { erasure: "proven" }))).toBe(
        "posture-refused",
      );
      if (PROVEN_HERE) expect(await refusal(store.peer("peer:p"))).toBe("posture-refused");
      Object.assign(store, {
        profile: {
          ...store.profile,
          capabilities: { ...store.profile.capabilities, erasure: "proven" },
        },
      });
      expect(await refusal(store.createPeer("peer:q", { erasure: "proven" }))).toBe(
        "posture-refused",
      );
      const [x, bystanders] = [group("XW", 2), group("BW", 2)];
      const u = await store.createPeer("peer:u", { erasure: "unproven" });
      expect(u.erasure).toEqual({ posture: "unproven", storeClass: "unprovable" });
      await (
        await writerOf(u)
      )([...x, ...bystanders]);
      const before = ledger(path).clean;
      const seen = [await u.purge(ids(x)), await u.purge(ids(x)), await u.purge([])];
      for (const report of seen) {
        expect(report.claim).not.toBe("proven");
        expect(states(report)).toEqual({ ...every("owed"), "temp-files": "unprovable" });
      }
      expect(seen.map((r) => r.claim)).toEqual(["unproven", "nothing-removed", "nothing-removed"]);
      expect(ledger(path).clean).toBe(before);
      await bystandersHold(dir, u, bystanders);
    });
});

describe("retains: the surfaces that may still hold a target's id (decision S4-5), in both stores", () => {
  const stores: Record<string, () => Promise<Store>> = {
    memory: async () => createMemoryStore(),
    sqlite: async () => open(place().path),
  };
  for (const [name, make] of Object.entries(stores))
    it(`${name}: the feed always; a purge debt while one names the target; never a target the peer did not hold`, async () => {
      const store = await make();
      const posture = store.profile.capabilities.erasure === "proven" ? "proven" : "unproven";
      const a = await store.createPeer("peer:a", { erasure: posture });
      const b = await store.createPeer("peer:b", { erasure: posture });
      const [x, other] = [group("XT", 1), group("OT", 1)];
      await (
        await writerOf(a)
      )(x);
      await (
        await writerOf(b)
      )([...x, ...other]);
      const surfaces = (report: PurgeReport) => report.retains.map((r) => r.surface);
      const debtRow = name === "sqlite" && posture === "proven" ? ["surface-debt"] : [];
      expect(surfaces(await a.purge(ids(x)))).toEqual(["change-feed", "purge-debt"]);
      expect(surfaces(await b.purge(ids(x)))).toEqual(["change-feed", "purge-debt", ...debtRow]);
      expect(surfaces(await a.purge(ids(x)))).toEqual(["change-feed", ...debtRow]);
      // A peer that never held an id learns nothing of the debts that name it.
      const c = await store.createPeer("peer:c", { erasure: posture });
      expect(surfaces(await c.purge(ids(x)))).toEqual(["change-feed"]);
      expect(surfaces(await b.purge(ids(other)))).toEqual(["change-feed", ...debtRow]);
      expect((await a.read()).count).toBe(0);
    });
});
