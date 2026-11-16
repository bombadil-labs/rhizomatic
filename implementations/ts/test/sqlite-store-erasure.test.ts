// Proven erasure on the SQLite store (SPEC-18 slice 4 plan §7, step 4b). Every rail runs on real
// files in its own `mkdtempSync` directory and removes it. A target carries a distinct marker in
// every place the schema copies erasable material (test/support/sqlite-erasure.ts). After each
// case the rail scans every file of the directory (the database, `-wal`, `-shm`, anything else)
// for the markers of the purged targets, and a named set of bystanders reads back through the
// store with the same bytes. A report may say `absent` only when no marker is in any file.
//
// Each crash, and the window between two processes, is made from the test side: a child process
// wraps the statements of `better-sqlite3` in its own process (test/support/sqlite-erasure-child.ts).
// The store has no hook, switch or quirk for it.

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
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
import { marked, markersOf, scan, space, writerOf, type Marked } from "./support/sqlite-erasure.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const childScript = resolve(here, "support/sqlite-erasure-child.ts");

const PROVEN_HERE = ["linux", "darwin"].includes(process.platform);
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
const removedAll = (deltas: readonly Marked[]): Record<string, string> =>
  Object.fromEntries(deltas.map((d) => [d.delta.id, "removed"]));

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

/** The debt rows and the generation, read from the file by another connection. */
function ledger(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    const meta = (key: string) =>
      (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)
        ?.value;
    return {
      generation: Number(meta("generation")),
      residue: meta("residue"),
      debts: Object.fromEntries(
        (
          db.prepare("SELECT peer, delta, state, generation FROM surface_debt").all() as {
            peer: string;
            delta: string;
            state: string;
            generation: number;
          }[]
        ).map((r) => [`${r.peer} ${r.delta}`, `${r.state} ${r.generation}`]),
      ),
    };
  } finally {
    db.close();
  }
}

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

/** Runs the child with a mode; answers its report lines and how it ended. */
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
    report: (): PurgeReport =>
      JSON.parse(out.split("\n").find((line) => line.startsWith("{"))!) as PurgeReport,
    kill: () => proc.kill("SIGKILL"),
    errors: () => errors,
  };
}

const group = (tag: string, count: number, from = 0): Marked[] =>
  Array.from({ length: count }, (_, i) => marked(tag, from + i));

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
    expect([report.claim, states(report), outcomes(report)]).toEqual([
      "proven",
      every("absent"),
      removedAll(targets),
    ]);
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
    const all = group("Ev", 2000);
    const bystanders = group("Bs", 5);
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: all },
      "peer:b": { posture: "proven", deltas: bystanders },
    });
    const a = peers["peer:a"]!;
    for (let i = 0; i < all.length; i += 500) {
      const report = await a.purge(ids(all.slice(i, i + 500)));
      expect([report.claim, states(report)]).toEqual(["proven", every("absent")]);
    }
    expect((await a.read()).count).toBe(0);
    expect(scan(dir, markersOf(all))).toEqual([]);
    await bystandersHold(dir, peers["peer:b"]!, bystanders);
  }, 120_000);

  it("rail 3: a busy log gives owed on every file surface and never proven; the debt survives a kill and a reopen; an unrelated purge under the same busy log is reported on its own", async () => {
    const { dir, path } = place();
    const [x, y, bystanders] = [group("X3", 4), group("Y3", 4), group("B3", 4)];
    const { store } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...y, ...bystanders] },
    });
    await store.close();
    const held = reader(path);
    // A child purges x while the reader holds the log, prints its report, and is killed.
    const run = child(path, "peer:a", "hold-after-report", ids(x));
    await run.printed("}\n");
    run.kill();
    expect(await run.ended).toBe("SIGKILL");
    const first = run.report();
    expect([first.claim, states(first), outcomes(first)]).toEqual([
      "unproven",
      every("owed"),
      removedAll(x),
    ]);
    // The report is true: the log still holds the bytes it names as owed.
    expect(scan(dir, markersOf(x)).length).toBeGreaterThan(0);
    const generation = ledger(path).generation;
    expect(ledger(path).debts).toEqual(
      Object.fromEntries(ids(x).map((id) => [`peer:a ${id}`, `owed ${generation - 1}`])),
    );
    // A reopened store keeps the debt. An unrelated purge under the same busy log names only its
    // own targets, and owes too.
    const again = await open(path);
    const a = await again.peer("peer:a");
    const second = await a.purge(ids(y));
    expect([second.claim, states(second), outcomes(second)]).toEqual([
      "unproven",
      every("owed"),
      removedAll(y),
    ]);
    const nothing = await a.purge([]);
    expect([nothing.claim, states(nothing)]).toEqual(["nothing-removed", every("owed")]);
    expect(Object.values(ledger(path).debts).every((d) => d.startsWith("owed"))).toBe(true);
    held.release();
    // The later proof (decision S4-13): the peer asks again once the reader lets go.
    const later = await a.purge(ids(x));
    expect([later.claim, states(later), outcomes(later)]).toEqual([
      "proven",
      every("absent"),
      removedAll(x),
    ]);
    expect(scan(dir, markersOf([...x, ...y]))).toEqual([]);
    expect(Object.values(ledger(path).debts).every((d) => d.startsWith("settled"))).toBe(true);
    await bystandersHold(dir, a, bystanders);
  }, 120_000);

  it("rail 4: a purge that removes nothing rebuilds while a debt is owed; the next ask answers removed and proven, and ends the row", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("X4", 4), group("B4", 4)];
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...bystanders] },
    });
    const a = peers["peer:a"]!;
    const stamp = ledger(path).generation;
    const held = reader(path);
    expect(states(await a.purge(ids(x)))).toEqual(every("owed"));
    held.release();
    const before = ledger(path).generation;
    const nothing = await a.purge(["never-held"]);
    expect([nothing.claim, states(nothing), outcomes(nothing)]).toEqual([
      "nothing-removed",
      every("absent"),
      { "never-held": "not-held" },
    ]);
    // The rebuild ran: the generation rose, the debts settled, and no marker is left.
    expect(ledger(path).generation).toBe(before + 1);
    expect(Object.values(ledger(path).debts)).toEqual(x.map(() => `settled ${stamp}`));
    expect(scan(dir, markersOf(x))).toEqual([]);
    const proof = await a.purge(ids(x));
    expect([proof.claim, states(proof), outcomes(proof), proof.retains]).toEqual([
      "proven",
      every("absent"),
      removedAll(x),
      [{ surface: "change-feed", holds: "id" }],
    ]);
    expect(ledger(path).debts).toEqual({});
    expect(outcomes(await a.purge(ids(x)))).toEqual(
      Object.fromEntries(ids(x).map((id) => [id, "not-held"])),
    );
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
      Object.fromEntries(ids(x).map((id) => [id, "held-by-other-peer"])),
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
    // The feed and the debt row hold the id after the proof.
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
    expect(Object.values(outcomes(await a.purge(ids(x))))).toEqual(
      x.map(() => "held-by-other-peer"),
    );
    const held = reader(path);
    const byB = await b.purge(ids(x));
    expect([byB.claim, states(byB), outcomes(byB)]).toEqual([
      "unproven",
      every("owed"),
      removedAll(x),
    ]);
    // A's purge debt answers removed, but the file owes the rebuild: every surface is owed.
    const askA = await a.purge(ids(x));
    expect([askA.claim, states(askA), outcomes(askA)]).toEqual([
      "unproven",
      every("owed"),
      removedAll(x),
    ]);
    expect(scan(dir, markersOf(x)).length).toBeGreaterThan(0);
    held.release();
    for (const peer of [a, b]) {
      const proof = await peer.purge(ids(x));
      expect([peer.id, proof.claim, states(proof), outcomes(proof)]).toEqual([
        peer.id,
        "proven",
        every("absent"),
        removedAll(x),
      ]);
    }
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystandersHold(dir, a, bystanders);
  });

  it("rail 10: a peer of posture unproven runs no rebuild and says owed and unproven; a later rebuild by another peer settles its mark", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("X10", 3), group("B10", 3)];
    const { peers } = await filled(path, {
      "peer:u": { posture: "unproven", deltas: [...x, ...bystanders] },
      "peer:p": { posture: "proven", deltas: [] },
    });
    const before = ledger(path).generation;
    const report = await peers["peer:u"]!.purge(ids(x));
    expect([report.claim, states(report), outcomes(report)]).toEqual([
      "unproven",
      every("owed"),
      removedAll(x),
    ]);
    // No rebuild ran: the generation stands, and the log still holds the bytes.
    expect(ledger(path)).toEqual({ generation: before, residue: String(before), debts: {} });
    expect(scan(dir, markersOf(x)).length).toBeGreaterThan(0);
    const held = reader(path);
    expect(states(await peers["peer:p"]!.purge([]))).toEqual(every("owed"));
    expect(states(await peers["peer:u"]!.purge([]))).toEqual(every("owed"));
    held.release();
    const settle = await peers["peer:p"]!.purge([]);
    expect([settle.claim, states(settle)]).toEqual(["nothing-removed", every("absent")]);
    expect(ledger(path)).toEqual({ generation: before + 2, residue: undefined, debts: {} });
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystandersHold(dir, peers["peer:u"]!, bystanders);
  });

  it("the generation rule, two processes: a purge committed between another process's rebuild and its marking keeps its debt", async () => {
    const { dir, path } = place();
    const [x, y, bystanders] = [group("XG", 3), group("YG", 3), group("BG", 3)];
    const { store } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...bystanders] },
      "peer:b": { posture: "proven", deltas: y },
    });
    await store.close();
    const start = ledger(path).generation;
    // Process 1 purges x, rebuilds, truncates, and waits before it marks the debts settled.
    const first = child(path, "peer:a", "hold-after-checkpoint", ids(x));
    await first.printed("checkpointed");
    // Process 2 purges y in that window. It dies after its delete commits, before its rebuild.
    const second = child(path, "peer:b", "kill-at-raise", ids(y));
    expect(await second.ended).toBe("SIGKILL");
    writeFileSync(`${path}.go`, "");
    expect(await first.ended).toBe("0");
    const one = first.report();
    expect([one.claim, states(one), outcomes(one)]).toEqual([
      "proven",
      every("absent"),
      removedAll(x),
    ]);
    // Process 1 settled x only: y was deleted after its rebuild began.
    expect(ledger(path).debts).toEqual({
      ...Object.fromEntries(ids(x).map((id) => [`peer:a ${id}`, `settled ${start}`])),
      ...Object.fromEntries(ids(y).map((id) => [`peer:b ${id}`, `owed ${start + 1}`])),
    });
    const again = await open(path);
    const held = reader(path);
    const a = await again.peer("peer:a");
    expect(states(await a.purge([]))).toEqual(every("owed"));
    held.release();
    const proof = await (await again.peer("peer:b")).purge(ids(y));
    expect([proof.claim, states(proof), outcomes(proof)]).toEqual([
      "proven",
      every("absent"),
      removedAll(y),
    ]);
    expect(scan(dir, markersOf([...x, ...y]))).toEqual([]);
    await bystandersHold(dir, a, bystanders);
  }, 60_000);

  for (const [mode, point] of [
    ["kill-at-raise", "between the delete and the rebuild"],
    ["kill-at-vacuum", "between raising the generation and the rebuild"],
    ["kill-at-settle", "between the rebuild and the marking"],
  ] as const)
    it(`a crash ${point}: the debt survives a reopen, nothing says absent until a rebuild, and the next ask proves`, async () => {
      const { dir, path } = place();
      const [x, bystanders] = [group("XC", 3), group("BC", 3)];
      const { store } = await filled(path, {
        "peer:a": { posture: "proven", deltas: [...x, ...bystanders] },
      });
      await store.close();
      const start = ledger(path).generation;
      const run = child(path, "peer:a", mode, ids(x));
      expect(await run.ended).toBe("SIGKILL");
      expect(ledger(path)).toEqual({
        generation: mode === "kill-at-raise" ? start : start + 1,
        residue: undefined,
        debts: Object.fromEntries(ids(x).map((id) => [`peer:a ${id}`, `owed ${start}`])),
      });
      const again = await open(path);
      const a = await again.peer("peer:a");
      const held = reader(path);
      expect(states(await a.purge([]))).toEqual(every("owed"));
      held.release();
      const proof = await a.purge(ids(x));
      expect([proof.claim, states(proof), outcomes(proof)]).toEqual([
        "proven",
        every("absent"),
        removedAll(x),
      ]);
      expect(scan(dir, markersOf(x))).toEqual([]);
      await bystandersHold(dir, a, bystanders);
    }, 60_000);

  describe("a rebuild or a truncate that fails gives owed on every file surface", () => {
    // The engine's failures, raised from the test side by the statement of the rebuild.
    const probe = new Database(":memory:");
    const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<
      "run" | "get",
      (this: Database.Statement, ...args: unknown[]) => unknown
    >;
    probe.close();
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
      "the raise of the generation busy": {
        method: "run",
        sql: SQLITE_STATEMENTS.generationRaise,
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
        const original = statement[fault.method];
        statement[fault.method] = function (...args) {
          if (this.source === fault.sql) return fault.answer();
          return original.apply(this, args);
        };
        let report: PurgeReport;
        try {
          report = await a.purge(ids(x));
        } finally {
          statement[fault.method] = original;
        }
        expect([report.claim, states(report), outcomes(report)]).toEqual([
          "unproven",
          every("owed"),
          removedAll(x),
        ]);
        expect(Object.values(ledger(path).debts).every((d) => d.startsWith("owed"))).toBe(true);
        const proof = await a.purge(ids(x));
        expect([proof.claim, states(proof)]).toEqual(["proven", every("absent")]);
        expect(scan(dir, markersOf(x))).toEqual([]);
        await bystandersHold(dir, a, bystanders);
      });
  });

  it("a re-held and re-purged id is owed again under the present generation", async () => {
    const { dir, path } = place();
    const [x, bystanders] = [group("XR", 2), group("BR", 2)];
    const { peers } = await filled(path, {
      "peer:a": { posture: "proven", deltas: [...x, ...bystanders] },
    });
    const a = peers["peer:a"]!;
    expect((await a.purge(ids(x))).claim).toBe("proven");
    const settled = ledger(path).generation;
    await (
      await writerOf(a)
    )(x);
    const held = reader(path);
    expect(states(await a.purge(ids(x)))).toEqual(every("owed"));
    expect(Object.values(ledger(path).debts)).toEqual(x.map(() => `owed ${settled}`));
    held.release();
    expect((await a.purge(ids(x))).claim).toBe("proven");
    expect(scan(dir, markersOf(x))).toEqual([]);
    await bystandersHold(dir, a, bystanders);
  });
});

describe("the erasure class on Windows is unprovable, and its reports never say proven", () => {
  type Module = typeof import("../src/storage/sqlite-store.js");
  const SUBPATH = "../src/storage/sqlite-store.js";
  /** The store module evaluated anew while the platform reads `win32`. */
  async function onWindows(): Promise<Module> {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      return (await import(/* @vite-ignore */ `${SUBPATH}?platform=win32`)) as Module;
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  }

  it("rail 6: proven is refused at create and at open, also after a caller replaces the profile; an unproven peer's purge says unproven with temp files unprovable", async () => {
    const windows = await onWindows();
    expect(process.platform).not.toBe("win32");
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
    const before = ledger(path).generation;
    const seen = [await u.purge(ids(x)), await u.purge(ids(x)), await u.purge([])];
    for (const report of seen) {
      expect(report.claim).not.toBe("proven");
      expect(states(report)).toEqual({ ...every("owed"), "temp-files": "unprovable" });
    }
    expect(seen.map((r) => r.claim)).toEqual(["unproven", "nothing-removed", "nothing-removed"]);
    expect(ledger(path).generation).toBe(before);
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
