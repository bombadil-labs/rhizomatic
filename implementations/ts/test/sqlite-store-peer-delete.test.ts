// Peer delete on the SQLite store (SPEC-18 proposal §4.13 reading 144): the bytes, the mark, a
// delete that dies, other processes, and the statements. Every rail runs on real files in its own
// `mkdtempSync` directory and removes it. A rail that claims bytes are gone scans every file of
// the directory (the database, `-wal`, `-shm`, anything else) in another process, and a named
// bystander peer reads back through the store with the same bytes. The contract on both stores is
// in store-peer-delete.test.ts.
//
// Each crash, and each other process, is a real child process
// (test/support/sqlite-delete-child.ts). The store has no hook, switch or quirk for it.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { digestOf } from "../src/storage/digest.js";
import { SQLITE_STATEMENTS } from "../src/storage/sqlite-statements.js";
import { openSqliteStore, type SqliteStore } from "../src/storage/sqlite-store.js";
import {
  StoreError,
  type DeleteReport,
  type PeerStore,
  type Snapshot,
  type VerifiedDelta,
} from "../src/storage/store.js";
import {
  appearance,
  marked,
  markersOf,
  scan,
  space,
  type Marked,
} from "./support/sqlite-erasure.js";

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
const RETAINS = ["change-feed", "purge-debt", "surface-debt"].map((surface) => ({
  surface,
  holds: "id",
}));
const proven = (released: number, keptByOtherPeers: number): DeleteReport => ({
  claim: "proven",
  boundary: "store-controlled-surfaces",
  surfaces: FILE_SURFACES.map((surface) => ({ surface, state: "absent" as const })),
  retains: RETAINS as DeleteReport["retains"],
  released,
  keptByOtherPeers,
});

const spaces: (() => void)[] = [];
const opened: SqliteStore[] = [];
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
  const { dir, remove } = space("rhizomatic-sqlite-peer-delete");
  spaces.push(remove);
  return { dir, path: join(dir, "store.db") };
}

async function open(path: string): Promise<SqliteStore> {
  const store = await openSqliteStore(path);
  opened.push(store);
  return store;
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
  // Only a line that its newline ended: a chunk can end inside a line.
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
  return { proc, ended, printed, kill: () => proc.kill("SIGKILL") };
}

const code = async (call: () => unknown): Promise<string> => {
  try {
    await call();
    return "answered";
  } catch (error) {
    if (error instanceof StoreError) return error.code;
    throw error;
  }
};
const ID = `1e20${"0".repeat(64)}`;
const handleCodes = async (p: PeerStore): Promise<string[]> => [
  await code(() => p.history),
  await code(() => p.appFormat),
  await code(() => p.read()),
  await code(() => p.append({ expectedHead: null, nextHead: "h", frame: null, added: [] })),
  await code(() => p.purge([ID])),
  await code(() => p.changes(0)),
];
const snapshotCodes = async (s: Snapshot): Promise<string[]> => [
  await code(() => s.get([ID])),
  await code(() => s.arrivals([ID])),
  await code(() => s.targets(["e"])),
  await code(() => s.negators([ID])),
  await code(() => s.scope({ anchors: [{ kind: "entity", entity: "e" }] })),
  await code(() => s.digest("")),
];
const ABSENT = Array<string>(6).fill("peer-absent");
const MOVED = Array<string>(6).fill("snapshot-moved");

async function listed<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

const group = (tag: string, count: number, from = 0): Marked[] =>
  Array.from({ length: count }, (_, i) => marked(tag, from + i));
const idsOf = (deltas: readonly Marked[]): string[] => deltas.map((d) => d.delta.id).sort();
/** The markers only this holding carries: its sender and its signature. */
const ownMarkers = (deltas: readonly Marked[]): string[] =>
  deltas.flatMap((d) => [d.markers.sender, d.markers.signature]);

// One count of arrivals for the whole file, so that every append passes a peer's last one.
let sequence = 0;
/** Appends the deltas to the peer, from the head it has now, under `head`. */
async function put(peer: PeerStore, deltas: readonly Marked[], head: string): Promise<void> {
  const now = await peer.read();
  const expectedHead = now.head;
  now.release();
  const added = deltas.map(
    ({ delta, sender }): VerifiedDelta => ({
      delta,
      arrival: { id: delta.id, at: 1, sequence: ++sequence, transfer: sequence, sender },
    }),
  );
  const result = await peer.append({ expectedHead, nextHead: head, frame: null, added });
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
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
const digestHashes = (path: string, peer: string): string[] =>
  read(path, (db) => [
    ...(db.prepare("SELECT hash FROM digest WHERE peer = ?").pluck().all(peer) as string[]),
    ...(db.prepare("SELECT root FROM peer WHERE id = ?").pluck().all(peer) as string[]),
  ]);

/** The bystander reads its deltas and their senders byte for byte, its root names its set, and fsck is clean. */
async function bystanderHolds(store: SqliteStore, peer: PeerStore, deltas: readonly Marked[]) {
  const now = await peer.read();
  const byId = new Map(deltas.map((d) => [d.delta.id, d]));
  const ids = idsOf(deltas);
  expect(await now.get(ids)).toEqual(ids.map((id) => byId.get(id)!.delta));
  expect((await now.arrivals(ids)).map((a) => a.sender)).toEqual(
    ids.map((id) => byId.get(id)!.sender),
  );
  expect([now.count, now.root]).toEqual([deltas.length, digestOf(ids).hash]);
  now.release();
  expect((await store.openAdmin().fsck()).faults).toEqual([]);
}

/**
 * Peer A of posture proven holds `size` marked deltas, appended 1,000 at a time under heads that
 * carry its name. Its first 50 deltas are shared: B holds another appearance of each (its own
 * sender and signature), and 20 deltas of its own. A purged the first shared delta, so it owes it.
 */
async function filled(path: string, name: string, size: number) {
  const store = await open(path);
  const a = await store.createPeer(name, { erasure: "proven" });
  const b = await store.createPeer("peer:b", { erasure: "proven" });
  const deltas = group(`D${size}`, size);
  const shared = deltas.slice(0, 50);
  const bystander = [...shared.map((d, i) => appearance("Sh", i, d)), ...group("Bo", 20)];
  const heads: string[] = [];
  for (let i = 0; i < size; i += 1000) {
    heads.push(`Hd${name.slice(5)}${i}Z`);
    await put(a, deltas.slice(i, i + 1000), heads.at(-1)!);
  }
  await put(b, bystander, "HdBystanderZ");
  const owed = await a.purge([shared[0]!.delta.id]);
  expect(owed.targets[0]!.outcome).toBe("held-by-other-peer");
  const only = deltas.slice(50);
  // The markers a scan looks for: every place of a sample of A's own deltas and their ids, A's
  // own sender and signature of every shared delta, A's name, its heads and its digest hashes.
  const sample = only.filter((_, i) => i % Math.ceil(only.length / 100) === 0);
  const markers = [
    ...markersOf(sample),
    ...idsOf(sample),
    ...ownMarkers(shared),
    name,
    ...heads,
    ...digestHashes(path, name),
  ];
  return { store, a, b, shared, bystander, sample, heads, markers };
}

/** A's markers in every file of the directory, leaving out the hashes B's digest holds now. */
function markersLeft(dir: string, path: string, markers: readonly string[]): string[] {
  const kept = new Set(digestHashes(path, "peer:b"));
  return scan(
    dir,
    markers.filter((m) => !kept.has(m)),
  );
}

describe.skipIf(!PROVEN_HERE)("peer delete removes the bytes (Linux)", () => {
  it("rail 1, at 20,000 deltas: the delete answers proven; no file holds A's payloads, ids, own senders and signatures, name, heads or digest hashes; B's deltas, shared ones included, read back byte for byte", async () => {
    const { dir, path } = place();
    const name = "peer:Qdel7Twenty";
    const { store, b, bystander, sample, heads, markers } = await filled(path, name, 20_000);
    // The positive control: the scan finds each kind of marker before the delete.
    const before = [
      ...markersOf(sample.slice(0, 1)),
      sample[0]!.delta.id,
      name,
      heads[0]!,
      digestHashes(path, name)[0]!,
    ];
    expect(scan(dir, before).length).toBeGreaterThanOrEqual(before.length);

    const report = await store.deletePeer(name);
    expect(report).toEqual(proven(19_999, 49));
    expect(markersLeft(dir, path, markers)).toEqual([]);
    await bystanderHolds(store, b, bystander);
  }, 300_000);

  it("rail 6: a shared id that the deleted peer kept for another peer leaves at that peer's purge, and a purge debt left before the delete answers removed after it; no file holds the id's bytes", async () => {
    for (const order of ["delete first", "purge first"]) {
      const { dir, path } = place();
      const store = await open(path);
      const a = await store.createPeer("peer:a", { erasure: "proven" });
      const b = await store.createPeer("peer:b", { erasure: "proven" });
      const x = marked(`X${order[0]}`, 1);
      const xOfB = appearance(`XB${order[0]}`, 1, x);
      const y = marked(`Y${order[0]}`, 1);
      await put(a, [x], `HdA${order[0]}Z`);
      await put(b, [xOfB, y], `HdB${order[0]}Z`);
      if (order === "purge first") {
        const owed = await b.purge([x.delta.id]);
        expect(owed.targets[0]!.outcome).toBe("held-by-other-peer");
        expect(await store.deletePeer("peer:a")).toEqual(proven(1, 0));
      } else expect(await store.deletePeer("peer:a")).toEqual(proven(1, 1));
      const last = await b.purge([x.delta.id]);
      expect([last.claim, last.targets]).toEqual([
        "proven",
        [{ id: x.delta.id, outcome: "removed" }],
      ]);
      // B's change records keep the id (decision O4); the claim covers the bytes.
      expect(scan(dir, [...markersOf([x]), ...ownMarkers([xOfB])])).toEqual([]);
      await bystanderHolds(store, b, [y]);
    }
  }, 120_000);

  it("rail 10: a peer of posture proven that holds nothing, only heads, on a clean file: the delete answers proven, and no file holds its name or any head it had", async () => {
    const { dir, path } = place();
    const store = await open(path);
    const name = "peer:Qdel7Empty";
    const a = await store.createPeer(name, { erasure: "proven" });
    const b = await store.createPeer("peer:b", { erasure: "proven" });
    const gone = marked("EmG", 1);
    await put(b, [gone], "HdB0Z");
    // B's proven purge rebuilds the file, so it is clean. An append deletes and updates no
    // erasable row, so the file stays clean while A writes its heads and the records that
    // retention trims, and B's appends between them split the pages that hold A's rows.
    expect((await b.purge([gone.delta.id])).claim).toBe("proven");
    const heads: string[] = [];
    const bystander: Marked[] = [];
    let head: string | null = null;
    for (let i = 0; i < 1500; i++) {
      heads.push(`HdEmpty${i}Z${"~".repeat(60)}`);
      const result = await a.append({
        expectedHead: head,
        nextHead: heads.at(-1)!,
        frame: null,
        added: [],
      });
      expect(result.status).toBe("committed");
      head = heads.at(-1)!;
      if (i % 3 === 0) {
        bystander.push(marked("EmY", i));
        await put(b, bystander.slice(-1), `HdB${i + 1}Z`);
      }
    }
    const clean = read(path, (db) =>
      db.prepare("SELECT dirty = clean AS c FROM residue").pluck().get(),
    );
    expect(clean).toBe(1);
    const control = [name, heads.at(-1)!.slice(0, 16)];
    expect(new Set(scan(dir, control).map((found) => found.split(": ")[1]))).toEqual(
      new Set(control),
    );

    expect(await store.deletePeer(name)).toEqual(proven(0, 0));
    expect(scan(dir, [name, ...heads.map((h) => h.slice(0, 16))])).toEqual([]);
    await bystanderHolds(store, b, bystander);
  }, 120_000);
});

describe("a delete that dies, and other processes", () => {
  it.skipIf(!PROVEN_HERE)(
    "rail 4 and rail 5: a child killed between the delete's pages leaves the mark; from then on another process's handle refuses peer-absent and its snapshot snapshot-moved, createPeer refuses peer-exists, and fsck names the delete; the next delete finishes, answers proven, and no file holds A's bytes",
    async () => {
      const { dir, path } = place();
      const name = "peer:Qdel7Killed";
      const size = 4_000;
      const { store, a, b, bystander, markers } = await filled(path, name, size);
      const snapshot = await a.read();
      expect(await snapshotCodes(snapshot)).toEqual(Array(6).fill("answered"));
      const watcher = child({ op: "watch", path, peer: name });
      await watcher.printed("ready");

      const deleter = child({ op: "delete", path, peer: name, slowMs: 40, busyTimeoutMs: 5000 });
      const poll = new Database(path, { readonly: true });
      const state = poll.prepare("SELECT state FROM peer WHERE id = ?").pluck();
      const held = poll.prepare("SELECT count(*) FROM holding WHERE peer = ?").pluck();
      const deadline = Date.now() + 60_000;
      // Killed after the mark and at least one page of releases, before the last page.
      for (;;) {
        const n = held.get(name) as number;
        if (state.get(name) === "deleting" && n < size - 1 - 256 && n > 0) {
          deleter.kill();
          break;
        }
        if (n === 0 || Date.now() > deadline) throw new Error(`no window: ${n} holdings left`);
        await new Promise((done) => setTimeout(done, 2));
      }
      expect(await deleter.ended).toBe("SIGKILL");
      const left = held.get(name) as number;
      const kept = poll
        .prepare(
          `SELECT count(*) FROM holding WHERE peer = ? AND EXISTS
            (SELECT 1 FROM holding AS other WHERE other.delta = holding.delta AND other.peer = 'peer:b')`,
        )
        .pluck()
        .get(name) as number;
      poll.close();
      expect(left).toBeGreaterThan(0);

      expect(await handleCodes(a)).toEqual(ABSENT);
      expect(await snapshotCodes(snapshot)).toEqual(MOVED);
      writeFileSync(`${path}.go-watch`, "");
      expect(await watcher.printed("codes")).toEqual({ handle: ABSENT, snapshot: MOVED });
      expect(await watcher.ended).toBe("0");
      expect(await code(() => store.peer(name))).toBe("peer-absent");
      const refused = await store.createPeer(name, { erasure: "proven" }).catch((e: unknown) => e);
      expect([(refused as StoreError).code, (refused as StoreError).message]).toEqual([
        "peer-exists",
        "createPeer: a delete of the peer did not end; deletePeer of the id finishes it",
      ]);
      const admin = store.openAdmin();
      expect(await listed(admin.peers())).toEqual(["peer:b"]);
      expect(await code(() => listed(admin.peer(name).ids()))).toBe("peer-absent");
      const { faults } = await admin.fsck();
      expect(faults.map(({ kind, peer }) => ({ kind, peer }))).toEqual([
        { kind: "peer-deleting", peer: name },
      ]);

      expect(await store.deletePeer(name)).toEqual(proven(left, kept));
      expect(markersLeft(dir, path, markers)).toEqual([]);
      await bystanderHolds(store, b, bystander);
      expect(await code(() => store.deletePeer(name))).toBe("peer-absent");
      const again = await store.createPeer(name, { erasure: "proven" });
      expect((await again.read()).count).toBe(0);
    },
    180_000,
  );

  it("rail 10: another process that appends to the peer while it is deleted either commits before the mark, and its holdings are released, or is refused peer-absent; no holding of the peer is left", async () => {
    const { path } = place();
    const store = await open(path);
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const own = group("Race", 3000);
    const y = marked("RaceY", 1);
    await put(a, own, "HdRaceZ");
    await put(b, [y], "HdRaceBZ");
    const appender = child({ op: "append", path, peer: "peer:a", after: 1_000_000 });
    await appender.printed("appended");
    const report = await store.deletePeer("peer:a");
    const done = await appender.printed<{ committed: number; ids: string[]; refused: string }>(
      "done",
    );
    expect(await appender.ended).toBe("0");
    expect(done.refused).toBe("peer-absent");
    expect([report.claim, report.released, report.keptByOtherPeers]).toEqual([
      "unproven",
      3000 + done.committed,
      0,
    ]);
    expect(
      read(path, (db) => [
        db.prepare("SELECT count(*) FROM holding WHERE peer = 'peer:a'").pluck().get(),
        db.prepare("SELECT count(*) FROM peer WHERE id = 'peer:a'").pluck().get(),
      ]),
    ).toEqual([0, 0]);
    expect(await listed(store.openAdmin().storedIds())).toEqual([y.delta.id]);
    await bystanderHolds(store, b, [y]);
  }, 120_000);
});

describe("a purge that a delete overtakes", () => {
  it("a delete that marks the peer between a purge's first and last transactions makes the purge refuse peer-absent; the next delete finishes and counts only what it released", async () => {
    const { path } = place();
    const store = await open(path);
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const own = group("Over", 5);
    const y = marked("OverY", 1);
    await put(a, own, "HdOverZ");
    await put(b, [y], "HdOverBZ");
    // Another connection marks the peer as soon as the purge's first transaction commits, as a
    // delete in another process would. The watch is on this process's statements only.
    const other = new Database(path);
    const probe = new Database(":memory:");
    const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as {
      run: (this: Database.Statement, ...args: unknown[]) => unknown;
    };
    probe.close();
    const run = statement.run;
    let mark = false;
    statement.run = function (...args) {
      const result = run.apply(this, args);
      if (this.source === "COMMIT" && !mark) {
        mark = true;
        other.prepare("UPDATE peer SET state = 'deleting' WHERE id = 'peer:a'").run();
      }
      return result;
    };
    let refused: string;
    try {
      refused = await code(() => a.purge([own[0]!.delta.id]));
    } finally {
      statement.run = run;
      other.close();
    }
    expect([mark, refused]).toEqual([true, "peer-absent"]);
    const report = await store.deletePeer("peer:a");
    expect([report.claim, report.released, report.keptByOtherPeers]).toEqual(["unproven", 4, 0]);
    expect(await listed(store.openAdmin().storedIds())).toEqual([y.delta.id]);
    await bystanderHolds(store, b, [y]);
  });
});

describe("a delete whose last transaction cannot take the write lock", () => {
  it("after the peer row is gone, a busy last transaction answers every file surface owed with the delete's counts and throws nothing; a repeat answers peer-absent; the bystander reads back", async () => {
    const { path } = place();
    const store = await openSqliteStore(path, { busyTimeoutMs: 100 });
    opened.push(store);
    const a = await store.createPeer("peer:a", { erasure: PROVEN_HERE ? "proven" : "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const y = marked("BusyLastY", 1);
    await put(a, group("BusyLast", 5), "HdBusyLastZ");
    await put(b, [y], "HdBusyLastBZ");
    // Another connection takes the write lock just before the delete's last transaction begins,
    // after the transaction that removed the peer row. The watch is on this process's statements.
    const other = new Database(path);
    const probe = new Database(":memory:");
    const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as {
      run: (this: Database.Statement, ...args: unknown[]) => unknown;
    };
    probe.close();
    const run = statement.run;
    let dropped = false;
    let taken = false;
    statement.run = function (...args) {
      if (this.source === SQLITE_STATEMENTS.peerDrop) dropped = true;
      else if (this.source === "BEGIN IMMEDIATE" && dropped && !taken) {
        taken = true;
        other.exec("BEGIN IMMEDIATE");
      }
      return run.apply(this, args);
    };
    let answer: DeleteReport | string;
    try {
      answer = await store.deletePeer("peer:a").catch((error: unknown) => {
        if (error instanceof StoreError) return error.code;
        throw error;
      });
    } finally {
      statement.run = run;
      if (other.inTransaction) other.exec("COMMIT");
      other.close();
    }
    expect([taken, answer]).toEqual([true, owed(5, 0)]);
    expect(rowsOf(path, "peer:a")).toEqual({
      peer: 0,
      holding: 0,
      change: 0,
      digest: 0,
      debt: 0,
      surface_debt: 0,
    });
    expect(await code(() => store.deletePeer("peer:a"))).toBe("peer-absent");
    await bystanderHolds(store, b, [y]);
  });
});

// ---- incarnations: a delete and a createPeer of the same id between two calls ----------------

const POSTURE = PROVEN_HERE ? "proven" : "unproven";
/** The answer of a delete whose last transaction found a peer row of the id. */
const owed = (released: number, keptByOtherPeers: number): DeleteReport => ({
  claim: "unproven",
  boundary: "store-controlled-surfaces",
  surfaces: FILE_SURFACES.map((surface) => ({
    surface,
    state: surface === "temp-files" && !PROVEN_HERE ? "unprovable" : "owed",
  })),
  retains: RETAINS as DeleteReport["retains"],
  released,
  keptByOtherPeers,
});
/** What a refused delete of peer:d says it left (§4.13 reading 144). */
const UNFINISHED =
  "This call of deletePeer for peer:d did not finish. A peer that it marked stays marked for delete until a delete ends it. A repeat of deletePeer deletes the peer that has this id at that time.";
/**
 * A child deleter that stops after its first commit; `go` lets it on. It waits up to 5 s for a
 * lock and makes one call: a refusal fails the rail with its text, because a repeat is a new call
 * that deletes the peer that has the id then.
 */
async function heldDeleter(path: string, peer: string) {
  const deleter = child({ op: "delete", path, peer, hold: true, busyTimeoutMs: 5000 });
  const pid = await deleter.printed<number>("held");
  return { ...deleter, go: () => writeFileSync(`${path}.go-${pid}`, "") };
}
/** The peer's rows in every per-peer table, by another connection. */
const rowsOf = (path: string, peer: string): Record<string, number> =>
  read(path, (db) =>
    Object.fromEntries(
      [
        ["peer", "id"],
        ["holding", "peer"],
        ["change", "peer"],
        ["digest", "peer"],
        ["debt", "peer"],
        ["surface_debt", "peer"],
      ].map(([table, column]) => [
        table,
        db.prepare(`SELECT count(*) FROM ${table} WHERE ${column} = ?`).pluck().get(peer) as number,
      ]),
    ),
  );

describe("a late deleter and a peer created again under the id", () => {
  for (const variant of ["three deltas", "empty", "an append racing the late deleter"])
    it(`R1 (${variant}): deleter A ends, the id is created again, and deleter B, which began before A ended, then goes on: it touches nothing of the new peer and answers its own counts with every file surface owed; the new peer reads back byte for byte`, async () => {
      const { path } = place();
      const store = await open(path);
      const d = await store.createPeer("peer:d", { erasure: POSTURE });
      const b = await store.createPeer("peer:b", { erasure: POSTURE });
      const old = group(`R1Old${variant[0]}`, 5);
      const y = marked(`R1Y${variant[0]}`, 1);
      await put(d, old, "HdR1OldZ");
      await put(b, [y], "HdR1BZ");

      const a = await heldDeleter(path, "peer:d");
      const late = await heldDeleter(path, "peer:d");
      a.go();
      expect(await a.printed<DeleteReport>("report")).toEqual(
        PROVEN_HERE ? proven(5, 0) : owed(5, 0),
      );
      expect(await a.ended).toBe("0");

      const fresh = await store.createPeer("peer:d", { erasure: POSTURE });
      const news = variant === "empty" ? [] : group(`R1New${variant[0]}`, 3);
      if (news.length > 0) await put(fresh, news, "HdR1NewZ");
      late.go();
      const racing: Marked[] = [];
      if (variant.startsWith("an append"))
        for (let i = 0; i < 20; i++) {
          racing.push(marked("R1Race", i));
          await put(fresh, racing.slice(-1), `HdR1Race${i}Z`);
        }
      expect(await late.printed<DeleteReport>("report")).toEqual(owed(0, 0));
      expect(await late.ended).toBe("0");

      const all = [...news, ...racing];
      expect(rowsOf(path, "peer:d")).toMatchObject({ peer: 1, holding: all.length });
      await bystanderHolds(store, fresh, all);
      const again = await store.peer("peer:d");
      expect(again.history).toBe(fresh.history);
      await put(again, [marked("R1After", 1)], "HdR1AfterZ");
      expect((await again.read()).count).toBe(all.length + 1);
      await bystanderHolds(store, b, [y]);
    }, 120_000);

  it.skipIf(!PROVEN_HERE)(
    "R2: two deletes of one peer at once both end; their counts add up to the peer's holdings; each claims proven or unproven, and at least one claims proven; no file holds the peer's bytes; the bystander reads back byte for byte",
    async () => {
      const { dir, path } = place();
      const name = "peer:Qdel7Twice";
      const { store, b, bystander, markers } = await filled(path, name, 900);
      // A repeat would answer peer-absent, or count only its own releases.
      const first = await heldDeleter(path, name);
      const second = await heldDeleter(path, name);
      first.go();
      second.go();
      const reports = [
        await first.printed<DeleteReport>("report"),
        await second.printed<DeleteReport>("report"),
      ];
      expect([await first.ended, await second.ended]).toEqual(["0", "0"]);
      expect([
        reports[0]!.released + reports[1]!.released,
        reports[0]!.keptByOtherPeers + reports[1]!.keptByOtherPeers,
      ]).toEqual([899, 49]);
      expect(rowsOf(path, name)).toEqual({
        peer: 0,
        holding: 0,
        change: 0,
        digest: 0,
        debt: 0,
        surface_debt: 0,
      });
      // SQLite answers busy at once to a checkpoint while another connection checkpoints, without
      // the busy handler, and the truncate tries again for one busyTimeoutMs (reading 143). A
      // deleter whose truncate stays busy past that, or whose lock wait passes busyTimeoutMs, has
      // no proof; it answers unproven unless the log is empty and the file clean at its last
      // transaction. When no wait passes busyTimeoutMs, the checkpoint that runs ends and its
      // deleter answers proven. So at least one of the two answers proven here.
      const claims = reports.map((r) => r.claim);
      expect(claims.filter((claim) => claim !== "proven" && claim !== "unproven")).toEqual([]);
      expect(claims).toContain("proven");
      expect(markersLeft(dir, path, markers)).toEqual([]);
      await bystanderHolds(store, b, bystander);
    },
    180_000,
  );

  it("R6: deleter L marks the peer; another delete ends; the id is created again with three deltas, and deleter C marks the new peer; L goes on: it releases nothing and answers every file surface owed, the new peer's three holdings stay until C goes on, C releases 3, and the bystander reads back byte for byte", async () => {
    const { path } = place();
    const store = await open(path);
    const d = await store.createPeer("peer:d", { erasure: POSTURE });
    const b = await store.createPeer("peer:b", { erasure: POSTURE });
    const y = marked("R6Y", 1);
    await put(d, group("R6Old", 5), "HdR6OldZ");
    await put(b, [y], "HdR6BZ");

    const late = await heldDeleter(path, "peer:d");
    expect((await store.deletePeer("peer:d")).released).toBe(5);
    const fresh = await store.createPeer("peer:d", { erasure: POSTURE });
    const news = group("R6New", 3);
    await put(fresh, news, "HdR6NewZ");
    const c = await heldDeleter(path, "peer:d");

    late.go();
    expect(await late.printed<DeleteReport>("report")).toEqual(owed(0, 0));
    expect(await late.ended).toBe("0");
    expect(rowsOf(path, "peer:d")).toMatchObject({ peer: 1, holding: 3 });
    const held = read(path, (db) =>
      db.prepare("SELECT delta FROM holding WHERE peer = ? ORDER BY delta").pluck().all("peer:d"),
    );
    expect(held).toEqual(idsOf(news));

    c.go();
    expect(await c.printed<DeleteReport>("report")).toEqual(
      PROVEN_HERE ? proven(3, 0) : owed(3, 0),
    );
    expect(await c.ended).toBe("0");
    expect(rowsOf(path, "peer:d")).toEqual({
      peer: 0,
      holding: 0,
      change: 0,
      digest: 0,
      debt: 0,
      surface_debt: 0,
    });
    await bystanderHolds(store, b, [y]);
  }, 120_000);

  it("a delete refused store-unavailable in a page transaction says it did not finish and that a repeat deletes the peer that has the id then; after another delete ends it and the id is created again, a repeat of deletePeer deletes the new peer [stated limit: reading 144]; the bystander's named delta survives", async () => {
    const { path } = place();
    const store = await openSqliteStore(path, { busyTimeoutMs: 100 });
    opened.push(store);
    const d = await store.createPeer("peer:d", { erasure: POSTURE });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const y = marked("RepeatY", 1);
    await put(d, group("RepeatOld", 5), "HdRepeatOldZ");
    await put(b, [y], "HdRepeatBZ");
    // Another connection takes the write lock just before the delete's first page transaction
    // begins, after the transaction that marked the peer. The watch is on this process's statements.
    const other = new Database(path);
    const probe = new Database(":memory:");
    const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as {
      run: (this: Database.Statement, ...args: unknown[]) => unknown;
    };
    probe.close();
    const run = statement.run;
    let marking = false;
    let taken = false;
    statement.run = function (...args) {
      if (this.source === SQLITE_STATEMENTS.peerMark) marking = true;
      else if (this.source === "BEGIN IMMEDIATE" && marking && !taken) {
        taken = true;
        other.exec("BEGIN IMMEDIATE");
      }
      return run.apply(this, args);
    };
    let refused: unknown;
    try {
      refused = await store.deletePeer("peer:d").catch((error: unknown) => error);
    } finally {
      statement.run = run;
      if (other.inTransaction) other.exec("COMMIT");
      other.close();
    }
    expect([taken, (refused as StoreError).code, (refused as StoreError).message]).toEqual([
      true,
      "store-unavailable",
      `the SQLite store cannot serve this call now (SQLITE_BUSY). ${UNFINISHED}`,
    ]);
    expect(
      read(path, (db) => db.prepare("SELECT state FROM peer WHERE id = 'peer:d'").get()),
    ).toEqual({ state: "deleting" });
    expect(rowsOf(path, "peer:d")).toMatchObject({ peer: 1, holding: 5 });

    expect(await store.deletePeer("peer:d")).toEqual(PROVEN_HERE ? proven(5, 0) : owed(5, 0));
    const fresh = await store.createPeer("peer:d", { erasure: POSTURE });
    const news = group("RepeatNew", 3);
    await put(fresh, news, "HdRepeatNewZ");
    expect(rowsOf(path, "peer:d")).toMatchObject({ peer: 1, holding: 3 });

    expect(await store.deletePeer("peer:d")).toEqual(PROVEN_HERE ? proven(3, 0) : owed(3, 0));
    expect(rowsOf(path, "peer:d")).toEqual({
      peer: 0,
      holding: 0,
      change: 0,
      digest: 0,
      debt: 0,
      surface_debt: 0,
    });
    expect(await code(() => fresh.read())).toBe("peer-absent");
    expect(await listed(store.openAdmin().storedIds())).toEqual([y.delta.id]);
    await bystanderHolds(store, b, [y]);
  }, 60_000);
});

describe.skipIf(!PROVEN_HERE)("a purge across a delete and a re-create (Linux)", () => {
  for (const [before, after] of [
    ["unproven", "proven"],
    ["proven", "unproven"],
  ] as const)
    it(`R3 (old ${before}, new ${after}): another process deletes and creates the peer again between the purge's transactions; the purge refuses peer-absent and writes nothing on the new peer; the new peer's purge answers not-held; the bystander's purge answers removed and no file holds the bytes`, async () => {
      const { dir, path } = place();
      const store = await open(path);
      const d = await store.createPeer("peer:d", { erasure: before });
      const b = await store.createPeer("peer:b", { erasure: "proven" });
      const x = marked(`R3X${before[0]}`, 1);
      const xOfB = appearance(`R3XB${before[0]}`, 1, x);
      const own = marked(`R3Own${before[0]}`, 1);
      const y = marked(`R3Y${before[0]}`, 1);
      await put(d, [x, own], "HdR3DZ");
      await put(b, [xOfB, y], "HdR3BZ");
      // Another process deletes and creates the peer again as soon as the purge's first
      // transaction commits. The watch is on this process's statements only.
      const probe = new Database(":memory:");
      const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as {
        run: (this: Database.Statement, ...args: unknown[]) => unknown;
      };
      probe.close();
      const run = statement.run;
      let other: { status: number | null; stdout: string; stderr: string } | undefined;
      statement.run = function (...args) {
        const result = run.apply(this, args);
        if (this.source === "COMMIT" && other === undefined)
          other = spawnSync(
            process.execPath,
            [
              "--import",
              "tsx",
              childScript,
              JSON.stringify({ op: "recreate", path, peer: "peer:d", posture: after }),
            ],
            { cwd: pkg, encoding: "utf8" },
          );
        return result;
      };
      let refused: string;
      try {
        refused = await code(() => d.purge([x.delta.id]));
      } finally {
        statement.run = run;
      }
      expect([other?.status, other?.stderr]).toEqual([0, ""]);
      expect(other!.stdout).toMatch(/^open \d+\nreport .*\ncreated \S+\n$/);
      expect(refused).toBe("peer-absent");
      expect(rowsOf(path, "peer:d")).toEqual({
        peer: 1,
        holding: 0,
        change: 0,
        digest: 0,
        debt: 0,
        surface_debt: 0,
      });

      const fresh = await store.peer("peer:d");
      expect(fresh.erasure.posture).toBe(after);
      const theirs = await fresh.purge([x.delta.id]);
      expect([theirs.claim, theirs.targets, theirs.revision]).toEqual([
        "nothing-removed",
        [{ id: x.delta.id, outcome: "not-held" }],
        0,
      ]);
      const last = await b.purge([x.delta.id]);
      expect([last.claim, last.targets]).toEqual([
        "proven",
        [{ id: x.delta.id, outcome: "removed" }],
      ]);
      expect(scan(dir, [...markersOf([x, own]), ...ownMarkers([x, xOfB])])).toEqual([]);
      const again = await fresh.purge([x.delta.id]);
      expect(again.targets).toEqual([{ id: x.delta.id, outcome: "not-held" }]);
      expect(rowsOf(path, "peer:d")).toMatchObject({ debt: 0, surface_debt: 0 });
      await bystanderHolds(store, b, [y]);
    }, 120_000);
});

describe("a handle and a listing name one peer, not its id", () => {
  it("R4 (export): a listing of a peer's ids that began before the delete refuses peer-absent at its next page after the id is created again", async () => {
    const { path } = place();
    const store = await open(path);
    const d = await store.createPeer("peer:d", { erasure: "unproven" });
    await put(d, group("R4Ex", 300), "HdR4ExZ");
    for (const listing of ["ids", "deltas"] as const) {
      const pages = store.openAdmin().peer("peer:d")[listing]()[Symbol.asyncIterator]();
      expect((await pages.next()).done).toBe(false);
      await store.deletePeer("peer:d");
      const fresh = await store.createPeer("peer:d", { erasure: "unproven" });
      await put(fresh, group(`R4Ex${listing}`, 300), `HdR4Ex${listing}Z`);
      let refused = "";
      for (let i = 0; i < 300 && refused === ""; i++)
        refused = await code(() => pages.next()).then((answer) =>
          answer === "answered" ? "" : answer,
        );
      expect(refused).toBe("peer-absent");
      const now = await listed(store.openAdmin().peer("peer:d").ids());
      expect(now.length).toBe(300);
    }
  }, 60_000);
});

describe("a damaged row of the peer that a page key cannot reach", () => {
  const damage: [string, string][] = [
    [
      "a change record of revision -5",
      "INSERT INTO change VALUES ('peer:d', -5, NULL, '[]', '[]')",
    ],
    ["a purge debt of the empty id", "INSERT INTO debt VALUES ('peer:d', '')"],
    ["a record of a removal of the empty id", "INSERT INTO surface_debt VALUES ('peer:d', '')"],
  ];
  for (const [what, sql] of damage)
    it(`R5 (${what}): the delete ends and removes it, and fsck is clean`, async () => {
      const { path } = place();
      const store = await open(path);
      const d = await store.createPeer("peer:d", { erasure: "unproven" });
      const b = await store.createPeer("peer:b", { erasure: "unproven" });
      const y = marked("R5Y", 1);
      await put(d, group("R5", 3), "HdR5Z");
      await put(b, [y], "HdR5BZ");
      const raw = new Database(path);
      raw.prepare(sql).run();
      raw.close();
      const report = await store.deletePeer("peer:d");
      expect([report.released, report.keptByOtherPeers]).toEqual([3, 0]);
      expect(rowsOf(path, "peer:d")).toEqual({
        peer: 0,
        holding: 0,
        change: 0,
        digest: 0,
        debt: 0,
        surface_debt: 0,
      });
      await bystanderHolds(store, b, [y]);
    }, 60_000);
});

type StatementCall = (this: Database.Statement, ...args: unknown[]) => unknown;
/** Wraps one method of every statement of this process. Answers the call that restores it. */
function watch(
  method: "run" | "get" | "all",
  wrap: (statement: Database.Statement, call: () => unknown, args: unknown[]) => unknown,
): () => void {
  const probe = new Database(":memory:");
  const prototype = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<
    string,
    StatementCall
  >;
  probe.close();
  const original = prototype[method]!;
  prototype[method] = function (...args) {
    return wrap(this, () => original.apply(this, args), args);
  };
  return () => {
    prototype[method] = original;
  };
}

describe("what a refused delete says, at each transaction before the peer row is gone", () => {
  /**
   * Runs one delete of peer:d (5 holdings) beside peer:b (1 delta). At the first `BEGIN
   * IMMEDIATE` after `after` ran (or the first one of the call), `fail` takes the write lock in
   * another connection or throws an engine error that is not transient. Answers the refusal.
   */
  async function refusedDelete(after: string | undefined, fail: "lock" | "full") {
    const { path } = place();
    const store = await openSqliteStore(path, { busyTimeoutMs: 100 });
    opened.push(store);
    const d = await store.createPeer("peer:d", { erasure: POSTURE });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const tag = `Refused${after === undefined ? "Mark" : after.length}${fail}`;
    const y = marked(`${tag}Y`, 1);
    const own = group(tag, 5);
    await put(d, own, `Hd${tag}Z`);
    await put(b, [y], `Hd${tag}BZ`);
    const other = new Database(path);
    let armed = after === undefined;
    let fired = false;
    const restore = watch("run", (statement, call) => {
      if (statement.source === after) armed = true;
      else if (statement.source === "BEGIN IMMEDIATE" && armed && !fired) {
        fired = true;
        if (fail === "full")
          throw new Database.SqliteError("database or disk is full", "SQLITE_FULL");
        other.exec("BEGIN IMMEDIATE");
      }
      return call();
    });
    let refused: unknown;
    try {
      refused = await store.deletePeer("peer:d").catch((error: unknown) => error);
    } finally {
      restore();
      if (other.inTransaction) other.exec("COMMIT");
      other.close();
    }
    expect(fired).toBe(true);
    const { code: why, message } = refused as StoreError;
    return { store, d, b, y, own, path, why, message };
  }
  const stateOf = (path: string): unknown =>
    read(path, (db) => db.prepare("SELECT state FROM peer WHERE id = 'peer:d'").get());

  it("the mark transaction: a busy engine refuses store-unavailable with the delete's text; no mark is on disk, the peer is live and reads back, and the bystander's named delta survives", async () => {
    const { store, d, b, y, own, path, why, message } = await refusedDelete(undefined, "lock");
    expect([why, message]).toEqual([
      "store-unavailable",
      `the SQLite store cannot serve this call now (SQLITE_BUSY). ${UNFINISHED}`,
    ]);
    expect(stateOf(path)).toEqual({ state: "live" });
    await bystanderHolds(store, d, own);
    await bystanderHolds(store, b, [y]);
  });

  it("the transaction that removes the peer row: a busy engine refuses store-unavailable with the delete's text; the row stays marked with no other row of the peer, fsck gives one peer-deleting fault, a repeat ends the delete with 0 released, and the bystander's named delta survives", async () => {
    const { store, b, y, path, why, message } = await refusedDelete(
      SQLITE_STATEMENTS.deleteSurfaceDebts,
      "lock",
    );
    expect([why, message]).toEqual([
      "store-unavailable",
      `the SQLite store cannot serve this call now (SQLITE_BUSY). ${UNFINISHED}`,
    ]);
    expect(stateOf(path)).toEqual({ state: "deleting" });
    expect(rowsOf(path, "peer:d")).toEqual({
      peer: 1,
      holding: 0,
      change: 0,
      digest: 0,
      debt: 0,
      surface_debt: 0,
    });
    expect((await store.openAdmin().fsck()).faults).toEqual([
      {
        kind: "peer-deleting",
        peer: "peer:d",
        detail: "sqlite store: a delete of the peer did not end; deletePeer of the id finishes it",
      },
    ]);
    expect(await store.deletePeer("peer:d")).toEqual(PROVEN_HERE ? proven(0, 0) : owed(0, 0));
    expect(rowsOf(path, "peer:d")).toMatchObject({ peer: 0 });
    await bystanderHolds(store, b, [y]);
  });

  it("a page transaction: an engine error that is not transient refuses store-unavailable with the error's text, then the delete's text; the mark stays, a repeat ends the delete, and the bystander's named delta survives", async () => {
    const { store, b, y, path, why, message } = await refusedDelete(
      SQLITE_STATEMENTS.peerMark,
      "full",
    );
    expect([why, message]).toEqual([
      "store-unavailable",
      `the SQLite store failed: database or disk is full (SQLITE_FULL); this is not a lock, and the same call fails again until the cause is fixed. ${UNFINISHED}`,
    ]);
    expect(stateOf(path)).toEqual({ state: "deleting" });
    expect(rowsOf(path, "peer:d")).toMatchObject({ peer: 1, holding: 5 });
    expect(await store.deletePeer("peer:d")).toEqual(PROVEN_HERE ? proven(5, 0) : owed(5, 0));
    expect(rowsOf(path, "peer:d")).toMatchObject({ peer: 0, holding: 0 });
    await bystanderHolds(store, b, [y]);
  });
});

describe("fsck beside a running delete", () => {
  it("a delete that starts 0 to 24 event-loop turns after fsck's peer step read the peer live: fsck reports no fault at all, and stops checking the peer once its row is marked; a second fsck after the delete is clean; the bystander's named delta reads back", async () => {
    let paged = 0;
    for (let turns = 0; turns <= 24; turns++) {
      const { path } = place();
      const store = await open(path);
      const z = await store.createPeer("peer:z", { erasure: "unproven" });
      const b = await store.createPeer("peer:b", { erasure: "unproven" });
      const y = marked(`FsckRaceY${turns}`, 1);
      await put(z, group(`FsckRace${turns}`, 600), `HdFsckRace${turns}Z`);
      await put(b, [y], `HdFsckRaceB${turns}Z`);
      let deletion: Promise<DeleteReport> | undefined;
      let released = false;
      let fired = false;
      const later = (n: number): void => {
        if (n === 0) deletion = store.deletePeer("peer:z");
        else setImmediate(() => later(n - 1));
      };
      const restoreGet = watch("get", (statement, call, args) => {
        if (statement.source === SQLITE_STATEMENTS.fsckCount && args[0] === "peer:z" && !fired) {
          fired = true;
          setImmediate(() => later(turns));
        }
        return call();
      });
      const restoreAll = watch("all", (statement, call) => {
        if (statement.source === SQLITE_STATEMENTS.deleteHoldings) released = true;
        return call();
      });
      let report: Awaited<ReturnType<ReturnType<SqliteStore["openAdmin"]>["fsck"]>>;
      let releasedBeforeEnd: boolean;
      try {
        report = await store.openAdmin().fsck();
        releasedBeforeEnd = released;
      } finally {
        restoreGet();
        restoreAll();
        while (fired && deletion === undefined)
          await new Promise<void>((done) => setImmediate(done));
        await deletion?.catch(() => undefined);
      }
      expect((await deletion!).released).toBe(600);
      if (releasedBeforeEnd) paged++;
      expect([turns, report.faults]).toEqual([turns, []]);
      await bystanderHolds(store, b, [y]);
      await store.close();
    }
    expect(paged).toBeGreaterThan(0);
  }, 120_000);

  it("a peer that a delete marks just after fsck's peer step gets no fault from that scan, also for a damaged change record that the scan finds without the delete; the bystander's named delta reads back", async () => {
    for (const deleting of [false, true]) {
      const { path } = place();
      const store = await open(path);
      const z = await store.createPeer("peer:z", { erasure: "unproven" });
      const b = await store.createPeer("peer:b", { erasure: "unproven" });
      const y = marked(`FsckMarkY${deleting}`, 1);
      await put(z, group(`FsckMark${deleting}`, 3), `HdFsckMark${deleting}Z`);
      await put(b, [y], `HdFsckMarkB${deleting}Z`);
      const raw = new Database(path);
      raw.prepare("UPDATE change SET added = 'not a list' WHERE peer = 'peer:z'").run();
      raw.close();
      let deletion: Promise<DeleteReport> | undefined;
      const restore = watch("get", (statement, call, args) => {
        if (
          deleting &&
          statement.source === SQLITE_STATEMENTS.fsckCount &&
          args[0] === "peer:z" &&
          deletion === undefined
        )
          setImmediate(() => (deletion = store.deletePeer("peer:z")));
        return call();
      });
      let faults: unknown[];
      try {
        faults = (await store.openAdmin().fsck()).faults.map((f) => [f.kind, f.peer, f.key]);
      } finally {
        restore();
        await deletion?.catch(() => undefined);
      }
      expect([deleting, faults]).toEqual([
        deleting,
        deleting ? [] : [["column-mismatch", "peer:z", "change.added"]],
      ]);
      if (deleting) {
        expect((await deletion!).released).toBe(3);
        await bystanderHolds(store, b, [y]);
      }
      await store.close();
    }
  });
});

describe("the statements that read a peer", () => {
  const statements = SQLITE_STATEMENTS as Record<string, string>;
  // Each statement that names the peer table and does not keep live peers only, with why it may.
  const NOT_FILTERED: Readonly<Record<string, string>> = {
    peerAdd: "writes a new row as live",
    peerState: "createPeer and deletePeer read a marked row: one refuses, the other resumes",
    peerMark: "the delete's first transaction marks the row",
    peerDrop: "the delete's last transaction removes the row",
    peerHistory: "a minting open writes the row of a peer that exportPeers listed as live",
    peerAdvance: "an append or a purge writes the row that #live read in its transaction",
    peerDeleting:
      "prove reads whether a delete of any peer has not ended: a marked row makes every file surface owed",
    fsckPeers:
      "fsck names a peer marked at this read as one fault; each later step of a peer reads its live row and stops without it",
  };
  const source = readFileSync(resolve(here, "../src/storage/sqlite-store.ts"), "utf8");
  /** The method of the store class that holds the text at `at`. */
  const methodAt = (at: number): string =>
    [...source.slice(0, at).matchAll(/^ {2}(?:async )?(#?\w+)\(/gm)].at(-1)![1]!;

  it("every statement that reads the peer table keeps live peers only, or is listed with its reason", () => {
    const naming = Object.entries(statements)
      .filter(([, sql]) => /\b(FROM|UPDATE|INTO)\s+peer\b/.test(sql))
      .map(([name]) => name);
    const unfiltered = naming.filter((name) => !statements[name]!.includes("state = 'live'"));
    expect(unfiltered.sort()).toEqual(Object.keys(NOT_FILTERED).sort());
    expect(naming).toContain("peerRead");
    expect(naming).toContain("exportPeers");
  });

  it("only peerAdd writes the origin column: no other statement that inserts into or updates the peer table names origin before its WHERE", () => {
    const writers = Object.entries(statements)
      .filter(([, sql]) => /\b(UPDATE|INTO)\s+peer\b/.test(sql))
      .filter(([, sql]) => /\borigin\b/.test(sql.split(/\bWHERE\b/)[0]!))
      .map(([name]) => name);
    expect(writers).toEqual(["peerAdd"]);
  });

  it("the store reads a peer row through one method, and no call assumes the row is there", () => {
    expect([...source.matchAll(/\.peerRead\b/g)].length).toBe(1);
    expect(source).toMatch(
      /#peerRow\(id: PeerId\): PeerRow \| undefined \{\s+return this\.#s\.peerRead/,
    );
    // Two calls assume the row, each in the transaction that found it live: createPeer after its
    // insert, and a purge's last transaction after its #live check.
    const assumed = [...source.matchAll(/#peerRow\([^)]*\)!/g)].map((m) => methodAt(m.index));
    expect(assumed).toEqual(["createPeer", "#decide"]);
    expect(source).toMatch(/this\.#live\(peer, origin\);\s+return this\.#decide\(/);
    // A marked row is read only where the delete is decided, and where createPeer refuses.
    // `prove` reads only whether a marked row exists (peerDeleting).
    const uses = [...source.matchAll(/\.peerState\.get\(/g)].map((m) => methodAt(m.index));
    expect(uses).toEqual(["createPeer", "deletePeer", "deletePeer", "deletePeer"]);
  });

  it("every call of a handle reads its peer through #live with the origin the handle was made with; no other path reads a peer row by its id alone", () => {
    // A new call of a handle that reads the row itself shows here as a new reader.
    const readers = [...source.matchAll(/this\.#peerRow\(/g)].map((m) => methodAt(m.index));
    expect(readers).toEqual([
      "#live",
      "createPeer",
      "peer",
      "#snapshot",
      "#decide",
      "openAdmin",
      "openAdmin",
      "#fsckPeer",
      "#fsckSame",
    ]);
    expect(source).toMatch(
      /#live\(id: PeerId, origin: History\): PeerRow \{\s+const row = this\.#peerRow\(id\);\s+if \(row\?\.origin !== origin\)/,
    );
    const lives = [...source.matchAll(/this\.#live\(([^)]*)\)/g)];
    expect(lives.map((m) => [methodAt(m.index), m[1]!.split(", ")[1]])).toEqual([
      ["#handle", "origin"],
      ["#handle", "origin"],
      ["#handle", "origin"],
      ["#changes", "origin"],
      ["#append", "origin"],
      ["#purge", "origin"],
      ["#purge", "origin"],
    ]);
    // Each call of the handle that does not read #live itself passes the origin to the method that does.
    for (const call of ["#append", "#purge", "#changes"]) {
      expect(source).toMatch(new RegExp(`this\\.${call}\\(id, origin, `));
      expect(source).toMatch(new RegExp(`^  ${call}\\(peer: PeerId, origin: History, `, "m"));
    }
  });
});
