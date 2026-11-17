// `fsck` and the integrity fault on real SQLite files (SPEC-18 proposal §4.13 readings 136 to 138).
// Each fault kind is made by a second connection that damages the file, and each test first
// checks that the same store reports nothing before the damage. The concurrency rail runs a child
// process that appends and purges while `fsck` scans. The erasure guard checks that `fsck`
// changes no byte and leaves no transaction behind: a purge after it, or while it waits between
// pages, reports what the same purge reports on a store that never ran it.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalBytes } from "../src/delta/delta.js";
import { contentAddress } from "../src/delta/hash.js";
import { makeDelta } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { admissionOf } from "../src/storage/admission.js";
import { EMPTY_DIGEST, digestRows } from "../src/storage/digest.js";
import { openSqliteStore } from "../src/storage/sqlite-store.js";
import {
  StoreIntegrityError,
  type FsckReport,
  type IntegrityFault,
  type PeerStore,
  type Store,
} from "../src/storage/store.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const fixture = sqliteFixture("rhizomatic-sqlite-fsck");
const children: ChildProcess[] = [];
afterAll(async () => {
  for (const proc of children) if (proc.exitCode === null) proc.kill();
  await fixture.cleanup();
});

const AUTHOR = `ed25519:${"1f".repeat(32)}`;
let stamp = 0;
const fact = (entity: string): Delta =>
  makeDelta({
    timestamp: ++stamp,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "about", target: { kind: "entity", entity: { id: entity } } }],
  });
const negation = (of: Delta): Delta =>
  makeDelta({
    timestamp: ++stamp,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "negates", target: { kind: "delta", deltaRef: { delta: of.id } } }],
  });

let heads = 0;
async function add(peer: PeerStore, deltas: readonly Delta[]): Promise<void> {
  const now = await peer.read();
  now.release();
  const result = await peer.append(
    admissionOf(now, deltas, { at: 1, sender: "local", nextHead: `head-${++heads}` }),
  );
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
}

/** The place of each fault, without its text. */
const places = (report: FsckReport) =>
  report.faults.map(({ kind, peer, id, key }: IntegrityFault) => ({ kind, peer, id, key }));

/**
 * A store in a new file: peer A holds a fact at E, a fact at F, a negation of the fact at E and a
 * bystander at B, over three appends; peer C holds the fact at F too.
 */
async function filled() {
  const path = fixture.path();
  const store = await openSqliteStore(path);
  const a = await store.createPeer("peer:a", { erasure: "unproven" });
  const c = await store.createPeer("peer:c", { erasure: "unproven" });
  const atE = fact("entity:e");
  const atF = fact("entity:f");
  const neg = negation(atE);
  const bystander = fact("entity:b");
  await add(a, [atE, atF]);
  await add(a, [neg]);
  await add(a, [bystander]);
  await add(c, [atF]);
  const damage = (sql: string, ...args: unknown[]): void => {
    const db = new Database(path);
    try {
      db.prepare(sql).run(...args);
    } finally {
      db.close();
    }
  };
  /** Writes the digest rows and root that the peer's holdings give, as the store writes them. */
  const redigest = (peer: string): void => {
    const db = new Database(path);
    try {
      const ids = db
        .prepare("SELECT delta FROM holding WHERE peer = ?")
        .pluck()
        .all(peer) as string[];
      const rows = digestRows(ids);
      db.prepare("DELETE FROM digest WHERE peer = ?").run(peer);
      for (const [prefix, { count, hash }] of rows)
        db.prepare("INSERT INTO digest (peer, prefix, count, hash) VALUES (?, ?, ?, ?)").run(
          peer,
          prefix,
          count,
          hash,
        );
      db.prepare("UPDATE peer SET root = ? WHERE id = ?").run(
        rows.get("")?.hash ?? EMPTY_DIGEST.hash,
        peer,
      );
    } finally {
      db.close();
    }
  };
  const fsck = () => store.openAdmin().fsck();
  expect(await fsck()).toEqual({ checked: { peers: 2, holdings: 5, deltas: 4 }, faults: [] });
  return { path, store, a, atE, atF, neg, bystander, damage, redigest, fsck };
}

describe("fsck finds each kind of fault that a second connection makes", () => {
  it("the gate: a deleted target row gives exactly one index-missing, with the peer, the id and the entity", async () => {
    const { atE, damage, fsck } = await filled();
    damage("DELETE FROM target WHERE peer = 'peer:a' AND delta = ?", atE.id);
    expect(places(await fsck())).toEqual([
      { kind: "index-missing", peer: "peer:a", id: atE.id, key: "entity:e" },
    ]);
  });

  it("a deleted reference row gives one index-missing with the referenced id", async () => {
    const { atE, neg, damage, fsck } = await filled();
    damage("DELETE FROM reference WHERE peer = 'peer:a' AND delta = ?", neg.id);
    expect(places(await fsck())).toEqual([
      { kind: "index-missing", peer: "peer:a", id: neg.id, key: atE.id },
    ]);
  });

  it("a target row the claims do not name gives one index-stray", async () => {
    const { atE, damage, fsck } = await filled();
    damage("INSERT INTO target (peer, entity, delta) VALUES ('peer:a', 'entity:stray', ?)", atE.id);
    expect(places(await fsck())).toEqual([
      { kind: "index-stray", peer: "peer:a", id: atE.id, key: "entity:stray" },
    ]);
  });

  it("claims changed to another delta's give one claims-mismatch per holder; a read of the id throws StoreIntegrityError with the id, and a bystander still reads", async () => {
    const { a, atE, bystander, damage, fsck } = await filled();
    damage(
      "UPDATE delta SET claims = (SELECT claims FROM delta WHERE id = ?) WHERE id = ?",
      bystander.id,
      atE.id,
    );
    expect(places(await fsck())).toEqual([
      { kind: "claims-mismatch", peer: "peer:a", id: atE.id, key: undefined },
    ]);
    const snapshot = await a.read();
    const thrown = await snapshot.get([atE.id]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(StoreIntegrityError);
    expect((thrown as StoreIntegrityError).fault).toMatchObject({
      kind: "claims-mismatch",
      peer: "peer:a",
      id: atE.id,
    });
    const scoped = await snapshot.scope({ anchors: [{ kind: "entity", entity: "entity:e" }] }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((scoped as StoreIntegrityError).fault?.id).toBe(atE.id);
    expect(await snapshot.get([bystander.id])).toEqual([bystander]);
    expect(
      (await snapshot.scope({ anchors: [{ kind: "entity", entity: "entity:b" }] })).deltas.map(
        (m) => m.delta,
      ),
    ).toEqual([bystander]);
  });

  it("bytes that hash to their id and are not claims give one claims-unreadable, and a read of the id throws it", async () => {
    const { a, damage, redigest, fsck } = await filled();
    const bytes = new Uint8Array([0xf6]);
    const id = contentAddress(bytes);
    damage("INSERT INTO delta (id, claims, author, timestamp) VALUES (?, ?, 'x', 0)", id, bytes);
    damage(
      `INSERT INTO holding (peer, delta, seq, arrival, sig, author)
       SELECT 'peer:a', ?, max_seq + 1, json_object('id', ?, 'at', 1, 'sequence', max_seq + 1,
         'transfer', max_transfer, 'sender', 'x'), NULL, 'x' FROM peer WHERE id = 'peer:a'`,
      id,
      id,
    );
    damage("UPDATE peer SET count = count + 1, max_seq = max_seq + 1 WHERE id = 'peer:a'");
    redigest("peer:a");
    expect(places(await fsck())).toEqual([
      { kind: "claims-unreadable", peer: "peer:a", id, key: undefined },
    ]);
    const thrown = await (await a.read()).get([id]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((thrown as StoreIntegrityError).fault).toMatchObject({ kind: "claims-unreadable", id });
  });

  it("a holding's author changed gives one column-mismatch naming the column", async () => {
    const { atF, damage, fsck } = await filled();
    damage("UPDATE holding SET author = 'someone' WHERE peer = 'peer:c' AND delta = ?", atF.id);
    expect(places(await fsck())).toEqual([
      { kind: "column-mismatch", peer: "peer:c", id: atF.id, key: "holding.author" },
    ]);
  });

  it("a peer count changed gives one count-mismatch", async () => {
    const { damage, fsck } = await filled();
    damage("UPDATE peer SET count = count + 1 WHERE id = 'peer:a'");
    expect(places(await fsck())).toEqual([
      { kind: "count-mismatch", peer: "peer:a", id: undefined, key: undefined },
    ]);
  });

  it("a last sequence below a holding's gives one sequence-mismatch for that holding", async () => {
    const { bystander, damage, fsck } = await filled();
    damage("UPDATE peer SET max_seq = max_seq - 1 WHERE id = 'peer:a'");
    expect(places(await fsck())).toEqual([
      { kind: "sequence-mismatch", peer: "peer:a", id: bystander.id, key: "seq" },
    ]);
  });

  it("a deleted change record gives one feed-gap", async () => {
    const { damage, fsck } = await filled();
    damage("DELETE FROM change WHERE peer = 'peer:a' AND revision = 2");
    expect(places(await fsck())).toEqual([
      { kind: "feed-gap", peer: "peer:a", id: undefined, key: undefined },
    ]);
  });

  it("a damaged change record past the first page of 256 (revision 300) gives one column-mismatch", async () => {
    const { a, damage, fsck } = await filled();
    for (let i = 0; i < 297; i++) await add(a, []);
    damage("UPDATE change SET added = 'garbage' WHERE peer = 'peer:a' AND revision = 300");
    expect(places(await fsck())).toEqual([
      { kind: "column-mismatch", peer: "peer:a", id: undefined, key: "change.added" },
    ]);
  }, 60_000);

  it("bytes no peer holds give one orphan-bytes", async () => {
    const { damage, fsck } = await filled();
    const loose = fact("entity:loose");
    damage(
      "INSERT INTO delta (id, claims, author, timestamp) VALUES (?, ?, ?, ?)",
      loose.id,
      canonicalBytes(loose.claims),
      loose.claims.author,
      loose.claims.timestamp,
    );
    expect(places(await fsck())).toEqual([
      { kind: "orphan-bytes", peer: undefined, id: loose.id, key: undefined },
    ]);
  });

  it("a holding of a peer that does not exist gives one engine fault from foreign_key_check", async () => {
    const { path, atE, fsck } = await filled();
    const db = new Database(path);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO holding (peer, delta, seq, arrival, sig, author)
       VALUES ('peer:ghost', ?, 1, '{}', NULL, 'x')`,
    ).run(atE.id);
    db.close();
    expect(places(await fsck())).toEqual([
      { kind: "engine", peer: undefined, id: undefined, key: "holding" },
    ]);
  });
});

describe("fsck at scale", () => {
  it.each([2_000, 32_000])(
    "a clean store of %i deltas gives no fault, and fsck reads every holding",
    async (size) => {
      const store = await fixture.open();
      const peer = await store.createPeer("peer:big", { erasure: "unproven" });
      for (let start = 0; start < size; start += 4_000) {
        const batch: Delta[] = [];
        for (let i = start; i < Math.min(size, start + 4_000); i++)
          batch.push(i % 4 === 3 ? negation(batch[batch.length - 1]!) : fact(`bulk:${i}`));
        await add(peer, batch);
      }
      const started = performance.now();
      const report = await store.openAdmin().fsck();
      const ms = performance.now() - started;
      console.log(`fsck of ${size} deltas: ${ms.toFixed(0)} ms`);
      expect(report).toEqual({ checked: { peers: 1, holdings: size, deltas: size }, faults: [] });
    },
    300_000,
  );
});

/** A child that appends to and purges from `peer` until `<path>.stop` exists. */
function churn(path: string, peer: string) {
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", resolve(here, "support/sqlite-fsck-child.ts"), path, peer],
    { cwd: pkg, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(proc);
  let out = "";
  let errors = "";
  proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  proc.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const ended = new Promise<void>((done) => proc.on("exit", () => done()));
  const word = async (name: string): Promise<string> => {
    for (const start = Date.now(); Date.now() - start < 60_000; ) {
      const line = out.split("\n").find((l) => l.startsWith(`${name} `));
      if (line !== undefined) return line.slice(name.length + 1);
      if (proc.exitCode !== null) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`the child did not print ${name}: ${out}${errors}`);
  };
  return { ended, word };
}

describe("fsck while another process writes", () => {
  it("gives no false fault while a child appends and purges between its pages, and sees the child's writes", async () => {
    const path = fixture.path();
    const store = await openSqliteStore(path);
    const peer = await store.createPeer("peer:w", { erasure: "unproven" });
    const seed: Delta[] = [];
    for (let i = 0; i < 700; i++)
      seed.push(i % 3 === 2 ? negation(seed[i - 1]!) : fact(`seed:${i}`));
    await add(peer, seed);
    const child = churn(path, "peer:w");
    await child.word("started");
    const admin = store.openAdmin();
    // The scans go on until ten of them saw the child commit during the scan, and at least 25
    // ran: a slow machine gives the child fewer commits per scan, never a false fault.
    let moved = 0;
    let runs = 0;
    for (let run = 0; (run < 25 || moved < 10) && run < 2_000; run++, runs++) {
      const before = (await peer.read()).revision;
      const report = await admin.fsck();
      expect([run, report.faults]).toEqual([run, []]);
      if ((await peer.read()).revision !== before) moved++;
    }
    writeFileSync(`${path}.stop`, "");
    const done = JSON.parse(await child.word("done")) as { appends: number; purges: number };
    await child.ended;
    expect([moved >= 10, runs >= 25]).toEqual([true, true]);
    expect(done.purges).toBeGreaterThan(3);
    expect((await admin.fsck()).faults).toEqual([]);
    await store.close();
  }, 120_000);
});

const digest = (file: string): string =>
  existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "absent";

describe.skipIf(process.platform !== "linux")("fsck and erasure", () => {
  /** A store in a new file with a peer of posture proven that holds 600 deltas: three pages. */
  async function proven(): Promise<{ path: string; store: Store; peer: PeerStore; ids: string[] }> {
    const path = fixture.path();
    const store = await openSqliteStore(path);
    const peer = await store.createPeer("peer:p", { erasure: "proven" });
    const deltas: Delta[] = [];
    for (let i = 0; i < 600; i++)
      deltas.push(
        makeDelta({
          timestamp: i,
          validFrom: 0,
          author: AUTHOR,
          pointers: [{ role: "about", target: { kind: "entity", entity: { id: `p:${i}` } } }],
        }),
      );
    const now = await peer.read();
    await peer.append(admissionOf(now, deltas, { at: 1, sender: "local", nextHead: "proven-1" }));
    return { path, store, peer, ids: deltas.map((d) => d.id) };
  }

  it("fsck changes no byte of the file or its log", async () => {
    const { path, store } = await proven();
    const before = [digest(path), digest(`${path}-wal`)];
    expect((await store.openAdmin().fsck()).faults).toEqual([]);
    expect([digest(path), digest(`${path}-wal`)]).toEqual(before);
  }, 60_000);

  it("a purge right after fsck, and a purge while fsck waits between pages, report what the same purge reports with no fsck", async () => {
    const twin = await proven();
    const without = await twin.peer.purge([twin.ids[7]!]);
    expect(without.claim).toBe("proven");
    const after = await proven();
    expect((await after.store.openAdmin().fsck()).faults).toEqual([]);
    expect(await after.peer.purge([after.ids[7]!])).toEqual(without);
    const during = await proven();
    let settled = false;
    const pending = during.store
      .openAdmin()
      .fsck()
      .finally(() => (settled = true));
    for (let turn = 0; turn < 4; turn++) await new Promise((done) => setImmediate(done));
    expect(settled).toBe(false);
    const report = await during.peer.purge([during.ids[7]!]);
    expect(settled).toBe(false);
    expect(report).toEqual(without);
    expect((await pending).faults).toEqual([]);
  }, 60_000);
});
