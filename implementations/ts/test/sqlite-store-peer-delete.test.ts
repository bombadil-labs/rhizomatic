// Peer delete on the SQLite store (SPEC-18 proposal §4.13 reading 143): the bytes, the mark, a
// delete that dies, other processes, and the statements. Every rail runs on real files in its own
// `mkdtempSync` directory and removes it. A rail that claims bytes are gone scans every file of
// the directory (the database, `-wal`, `-shm`, anything else) in another process, and a named
// bystander peer reads back through the store with the same bytes. The contract on both stores is
// in store-peer-delete.test.ts.
//
// Each crash, and each other process, is a real child process
// (test/support/sqlite-delete-child.ts). The store has no hook, switch or quirk for it.

import { spawn, type ChildProcess } from "node:child_process";
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

      const deleter = child({ op: "delete", path, peer: name, slowMs: 40 });
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
    fsckPeers: "fsck names a marked peer, and checks nothing else of it",
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

  it("the store reads a peer row through one method, and no call assumes the row is there", () => {
    expect([...source.matchAll(/\.peerRead\b/g)].length).toBe(1);
    expect(source).toMatch(
      /#peerRow\(id: PeerId\): PeerRow \| undefined \{\s+return this\.#s\.peerRead/,
    );
    // Two calls assume the row, each in the transaction that found it live: createPeer after its
    // insert, and a purge's last transaction after its #live check.
    const assumed = [...source.matchAll(/#peerRow\([^)]*\)!/g)].map((m) => methodAt(m.index));
    expect(assumed).toEqual(["createPeer", "#decide"]);
    expect(source).toMatch(/this\.#live\(peer\);\s+return this\.#decide\(/);
    // A marked row is read only where the delete is decided, and where createPeer refuses.
    const uses = [...source.matchAll(/\.peerState\.get\(/g)].map((m) => methodAt(m.index));
    expect(uses).toEqual(["createPeer", "deletePeer", "#deleted"]);
  });
});
