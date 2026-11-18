// Damaged rows and what each store answers for them (SPEC-18 proposal §4.13 readings 136 and 137).
// A read never answers from a damaged row: it throws StoreIntegrityError, whose fault names the
// kind, the peer and the id, and `fsck` reports the same fault. A second connection damages a real
// SQLite file. The memory store's structures cannot be reached by a call, so a test-only watch on
// `Map.prototype.get` records the store's own maps while one read runs, and the test changes them.

import { closeSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { makeDelta } from "../src/delta/set.js";
import type { Claims, Delta } from "../src/delta/types.js";
import type { ArrivalRecord } from "../src/storage/arrival-record.js";
import { admissionOf } from "../src/storage/admission.js";
import { followFeed } from "../src/storage/follow.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { openSqliteStore, type SqliteStore } from "../src/storage/sqlite-store.js";
import {
  StoreError,
  StoreIntegrityError,
  type FsckReport,
  type IntegrityFault,
  type PeerStore,
  type Store,
} from "../src/storage/store.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const fixture = sqliteFixture("rhizomatic-store-faults");
const opened: SqliteStore[] = [];
afterAll(async () => {
  for (const store of opened) await store.close();
  await fixture.cleanup();
});

const AUTHOR = `ed25519:${"5f".repeat(32)}`;
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
  const result = await peer.append(
    admissionOf(now, deltas, { at: 1, sender: "local", nextHead: `head-${++heads}` }),
  );
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
}

type Place = {
  kind: IntegrityFault["kind"];
  peer: string | undefined;
  id: string | undefined;
  key: string | undefined;
};
const place = ({ kind, peer, id, key }: IntegrityFault): Place => ({ kind, peer, id, key });
const places = (report: FsckReport): Place[] => report.faults.map(place);
/** The place of the fault a call throws, or what it did instead. */
const faultOf = (call: Promise<unknown>): Promise<Place | string> =>
  call.then(
    () => "answered",
    (error: unknown) =>
      error instanceof StoreIntegrityError
        ? place(error.fault)
        : `not a StoreIntegrityError: ${String(error)}`,
  );
const at = (entity: string) => ({ anchors: [{ kind: "entity" as const, entity }] });

/**
 * A SQLite store in a new file: peer A holds a fact `t` at entity `e:t`, its negation `n` and a
 * bystander `b` at `e:b`, over three appends (revisions 1 to 3); peer C holds `b` too. `damage`
 * runs one statement through a second connection with foreign keys off.
 */
async function sqliteFilled(options: { busyTimeoutMs?: number; changePageSize?: number } = {}) {
  const path = fixture.path();
  const store = await openSqliteStore(path, options);
  opened.push(store);
  const a = await store.createPeer("peer:a", { erasure: "unproven" });
  const c = await store.createPeer("peer:c", { erasure: "unproven" });
  const t = fact("e:t");
  const n = negation(t);
  const b = fact("e:b");
  await add(a, [t]);
  await add(a, [n]);
  await add(a, [b]);
  await add(c, [b]);
  const damage = (sql: string, ...args: unknown[]): void => {
    const db = new Database(path);
    try {
      db.pragma("foreign_keys = OFF");
      db.prepare(sql).run(...args);
    } finally {
      db.close();
    }
  };
  /** Writes the arrival record that `change` makes of `t`'s record at peer A. */
  const arrival = (change: (record: Record<string, unknown>) => unknown): void => {
    const db = new Database(path);
    try {
      const { arrival: text } = db
        .prepare("SELECT arrival FROM holding WHERE peer = 'peer:a' AND delta = ?")
        .get(t.id) as { arrival: string };
      db.prepare("UPDATE holding SET arrival = ? WHERE peer = 'peer:a' AND delta = ?").run(
        JSON.stringify(change(JSON.parse(text) as Record<string, unknown>)),
        t.id,
      );
    } finally {
      db.close();
    }
  };
  const fsck = () => store.openAdmin().fsck();
  expect(await fsck()).toEqual({ checked: { peers: 2, holdings: 4, deltas: 3 }, faults: [] });
  return { path, store, a, c, t, n, b, damage, arrival, fsck };
}

const ARRIVAL_DAMAGE: readonly (readonly [string, (r: Record<string, unknown>) => unknown])[] = [
  ["an empty object", () => ({})],
  ["a list", () => []],
  ["a record that names another id", (r) => ({ ...r, id: `1e20${"0".repeat(64)}` })],
  [
    "a record without its transfer",
    (r) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== "transfer")),
  ],
  ["a transfer of text", (r) => ({ ...r, transfer: "x" })],
  ["a transfer of 0", (r) => ({ ...r, transfer: 0 })],
  ["a transfer of 1.5", (r) => ({ ...r, transfer: 1.5 })],
  ["a sequence that is not the holding's", (r) => ({ ...r, sequence: 99 })],
  ["an at of text", (r) => ({ ...r, at: "x" })],
  ["an empty sender", (r) => ({ ...r, sender: "" })],
  ["a sender that is a number", (r) => ({ ...r, sender: 7 })],
  ["a field the store does not write", (r) => ({ ...r, extra: 1 })],
];

describe("a damaged arrival record on the SQLite store", () => {
  it.each(ARRIVAL_DAMAGE)(
    "%s: arrivals and scope throw column-mismatch (holding.arrival) with the peer and the id, fsck reports the same, and the bystander reads",
    async (_, change) => {
      const { a, t, b, arrival, fsck } = await sqliteFilled();
      arrival(change);
      const fault = { kind: "column-mismatch", peer: "peer:a", id: t.id, key: "holding.arrival" };
      const snapshot = await a.read();
      expect(await faultOf(snapshot.arrivals([t.id]))).toEqual(fault);
      expect(await faultOf(snapshot.scope(at("e:t")))).toEqual(fault);
      expect(places(await fsck())).toEqual([fault]);
      expect((await snapshot.arrivals([b.id])).map((r: ArrivalRecord) => r.id)).toEqual([b.id]);
    },
  );

  it("a transfer above the peer's last: arrivals and scope throw sequence-mismatch (transfer), and fsck reports the same", async () => {
    const { a, t, b, arrival, fsck } = await sqliteFilled();
    arrival((r) => ({ ...r, transfer: 999 }));
    const fault = { kind: "sequence-mismatch", peer: "peer:a", id: t.id, key: "transfer" };
    const snapshot = await a.read();
    expect(await faultOf(snapshot.arrivals([t.id]))).toEqual(fault);
    expect(await faultOf(snapshot.scope(at("e:t")))).toEqual(fault);
    expect(places(await fsck())).toEqual([fault]);
    expect(await snapshot.get([b.id])).toEqual([b]);
  });

  it("[gap: at and sender have no second copy] another at and another sender of the right form read as stored", async () => {
    const { a, t, arrival, fsck } = await sqliteFilled();
    arrival((r) => ({ ...r, at: 7, sender: "someone" }));
    expect((await (await a.read()).arrivals([t.id]))[0]).toMatchObject({
      at: 7,
      sender: "someone",
    });
    expect((await fsck()).faults).toEqual([]);
  });
});

describe("a damaged signature on the SQLite store", () => {
  it.each(["nothex", "AB".repeat(64), "ab".repeat(63)])(
    "a signature %s: get and scope throw column-mismatch (holding.sig), and fsck reports the same",
    async (sig) => {
      const { a, t, b, damage, fsck } = await sqliteFilled();
      damage("UPDATE holding SET sig = ? WHERE peer = 'peer:a' AND delta = ?", sig, t.id);
      const fault = { kind: "column-mismatch", peer: "peer:a", id: t.id, key: "holding.sig" };
      const snapshot = await a.read();
      expect(await faultOf(snapshot.get([t.id]))).toEqual(fault);
      expect(await faultOf(snapshot.scope(at("e:t")))).toEqual(fault);
      expect(places(await fsck())).toEqual([fault]);
      expect(await snapshot.get([b.id])).toEqual([b]);
    },
  );

  it("[gap: a signature is not verified] a signature of the right form reads as stored", async () => {
    const { a, t, damage, fsck } = await sqliteFilled();
    damage("UPDATE holding SET sig = ? WHERE peer = 'peer:a' AND delta = ?", "ab".repeat(64), t.id);
    expect(await (await a.read()).get([t.id])).toEqual([{ ...t, sig: "ab".repeat(64) }]);
    expect((await fsck()).faults).toEqual([]);
  });
});

describe("a holding whose delta row is gone, on the SQLite store", () => {
  it("get, arrivals, targets, scope and an export throw claims-unreadable with the peer and the id; fsck reports it beside the engine fault; the bystander reads", async () => {
    const { store, a, t, n, b, damage, fsck } = await sqliteFilled();
    damage("DELETE FROM delta WHERE id = ?", t.id);
    const fault = { kind: "claims-unreadable", peer: "peer:a", id: t.id, key: undefined };
    const snapshot = await a.read();
    expect(
      await Promise.all([
        faultOf(snapshot.get([t.id])),
        faultOf(snapshot.arrivals([t.id])),
        faultOf(snapshot.targets(["e:t"])),
        faultOf(snapshot.scope(at("e:t"))),
        faultOf(
          snapshot.scope({
            ...at("e:t"),
            pushdown: { timestampAtMost: 0 },
            exclude: [t.id],
          }),
        ),
        faultOf(
          (async () => {
            const read: Delta[] = [];
            for await (const delta of store.openAdmin().peer("peer:a").deltas()) read.push(delta);
            return read;
          })(),
        ),
      ]),
    ).toEqual([fault, fault, fault, fault, fault, fault]);
    expect(await snapshot.negators([t.id])).toEqual([n.id]);
    expect(places(await fsck())).toEqual([
      { kind: "engine", peer: undefined, id: undefined, key: "holding" },
      fault,
    ]);
    expect(await snapshot.get([b.id])).toEqual([b]);
    expect(await snapshot.targets(["e:b"])).toEqual([b.id]);
  });

  it("a lost negation: negators and scope throw claims-unreadable with its id", async () => {
    const { a, t, n, damage } = await sqliteFilled();
    damage("DELETE FROM delta WHERE id = ?", n.id);
    const fault = { kind: "claims-unreadable", peer: "peer:a", id: n.id, key: undefined };
    const snapshot = await a.read();
    expect(await faultOf(snapshot.negators([t.id]))).toEqual(fault);
    expect(await faultOf(snapshot.scope(at("e:t")))).toEqual(fault);
    expect(await snapshot.get([t.id])).toEqual([t]);
  });
});

describe("a damaged change record on the SQLite store", () => {
  it.each([
    ["added", "garbage", 1],
    ["added", '{"x":1}', 1],
    ["removed", "[1]", 2],
  ] as const)(
    "change.%s of %s: changes throws column-mismatch with the peer and the column, fsck reports the same, and a page without it reads",
    async (column, text, revision) => {
      const { a, damage, fsck } = await sqliteFilled();
      damage(
        `UPDATE change SET ${column} = ? WHERE peer = 'peer:a' AND revision = ?`,
        text,
        revision,
      );
      const fault = {
        kind: "column-mismatch",
        peer: "peer:a",
        id: undefined,
        key: `change.${column}`,
      };
      expect(await faultOf(a.changes(0))).toEqual(fault);
      expect(places(await fsck())).toEqual([fault]);
      expect(await a.changes(2)).toMatchObject({ status: "ok", through: 3 });
    },
  );

  it.each([3, 2])(
    "a lost change record (revision %i): changes over it throws feed-gap with the peer, a follower throws it and keeps its position, and peer C reads",
    async (lost) => {
      const { a, c, damage, fsck } = await sqliteFilled();
      damage("DELETE FROM change WHERE peer = 'peer:a' AND revision = ?", lost);
      const fault = { kind: "feed-gap", peer: "peer:a", id: undefined, key: undefined };
      const detail = `sqlite store: the peer keeps 2 change records from 1 to ${lost === 3 ? 2 : 3}, at floor 0 and revision 3`;
      for (const from of [0, lost - 1]) {
        const thrown = await a.changes(from).then(
          () => "answered",
          (error: unknown) => error,
        );
        expect(thrown, `from ${from}`).toBeInstanceOf(StoreIntegrityError);
        const { kind, peer, id, key } = (thrown as StoreIntegrityError).fault;
        expect([{ kind, peer, id, key }, (thrown as StoreIntegrityError).fault.detail]).toEqual([
          fault,
          detail,
        ]);
      }
      expect(await a.changes(3)).toEqual({ status: "ok", records: [], through: 3 });
      const snapshot = await a.read();
      const start = { history: snapshot.history, revision: 0 };
      snapshot.release();
      const cursor = followFeed(a, start);
      expect(await faultOf(cursor.pull())).toEqual(fault);
      expect(cursor.position).toEqual(start);
      const now = await a.read();
      expect([now.revision, now.count]).toEqual([3, 3]);
      now.release();
      expect((await c.changes(0)).status).toBe("ok");
      expect(places(await fsck())).toEqual([fault]);
    },
  );

  it("a lost change record inside a full page (page size 2, revision 2 lost): changes from 0 throws feed-gap", async () => {
    const { a, damage } = await sqliteFilled({ changePageSize: 2 });
    damage("DELETE FROM change WHERE peer = 'peer:a' AND revision = 2");
    expect(await faultOf(a.changes(0))).toEqual({
      kind: "feed-gap",
      peer: "peer:a",
      id: undefined,
      key: undefined,
    });
    expect(await a.changes(2)).toMatchObject({ status: "ok", through: 3 });
  });
});

describe("fsck checks that each have one rail (SQLite)", () => {
  it("a holding with bad claims, a bad signature and a bad arrival record: fsck reports all three faults, the faults that get and arrivals throw among them", async () => {
    const { a, t, b, damage, arrival, fsck } = await sqliteFilled();
    damage(
      "UPDATE delta SET claims = (SELECT claims FROM delta WHERE id = ?) WHERE id = ?",
      b.id,
      t.id,
    );
    damage("UPDATE holding SET sig = 'zz' WHERE peer = 'peer:a' AND delta = ?", t.id);
    arrival(() => ({}));
    const claims = { kind: "claims-mismatch", peer: "peer:a", id: t.id, key: undefined };
    const record = { kind: "column-mismatch", peer: "peer:a", id: t.id, key: "holding.arrival" };
    expect(places(await fsck())).toEqual([
      claims,
      { kind: "column-mismatch", peer: "peer:a", id: t.id, key: "holding.sig" },
      record,
    ]);
    const snapshot = await a.read();
    expect(await faultOf(snapshot.get([t.id]))).toEqual(claims);
    expect(await faultOf(snapshot.arrivals([t.id]))).toEqual(record);
  });

  it("a stored author changed: one column-mismatch (delta.author) for each holder", async () => {
    const { b, damage, fsck } = await sqliteFilled();
    damage("UPDATE delta SET author = 'someone' WHERE id = ?", b.id);
    expect(places(await fsck())).toEqual([
      { kind: "column-mismatch", peer: "peer:a", id: b.id, key: "delta.author" },
      { kind: "column-mismatch", peer: "peer:c", id: b.id, key: "delta.author" },
    ]);
  });

  it("a stored timestamp changed: one column-mismatch (delta.timestamp)", async () => {
    const { t, damage, fsck } = await sqliteFilled();
    damage("UPDATE delta SET timestamp = timestamp + 0.5 WHERE id = ?", t.id);
    expect(places(await fsck())).toEqual([
      { kind: "column-mismatch", peer: "peer:a", id: t.id, key: "delta.timestamp" },
    ]);
  });

  it("a reference row the claims do not name: one index-stray with the referenced id", async () => {
    const { n, damage, fsck } = await sqliteFilled();
    damage(
      "INSERT INTO reference (peer, ref, role, delta) VALUES ('peer:a', 'nowhere', 'negates', ?)",
      n.id,
    );
    expect(places(await fsck())).toEqual([
      { kind: "index-stray", peer: "peer:a", id: n.id, key: "nowhere" },
    ]);
  });

  it.each([
    ["the lowest", "UPDATE change SET revision = 0 WHERE peer = 'peer:a' AND revision = 1"],
    ["the highest", "UPDATE change SET revision = 100 WHERE peer = 'peer:a' AND revision = 3"],
  ])("a feed whose count is right and whose %s revision is not: one feed-gap", async (_, sql) => {
    const { damage, fsck } = await sqliteFilled();
    damage(sql);
    expect(places(await fsck())).toEqual([
      { kind: "feed-gap", peer: "peer:a", id: undefined, key: undefined },
    ]);
  });

  it("an index entry whose key is not its row's: engine faults from integrity_check, with no peer and no id", async () => {
    const { path, store } = await sqliteFilled();
    await store.close();
    const db = new Database(path);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const size = db.pragma("page_size", { simple: true }) as number;
    const { rootpage } = db
      .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'holding_by_author'")
      .get() as { rootpage: number };
    db.close();
    // The index of 4 holdings is one page. Its last entry is peer C's; peer:d keeps the order.
    const bytes = readFileSync(path);
    const page = bytes.subarray((rootpage - 1) * size, rootpage * size);
    const found = page.indexOf("peer:c");
    expect(found).toBeGreaterThan(0);
    page.write("peer:d", found);
    writeFileSync(path, bytes);
    const again = await openSqliteStore(path);
    opened.push(again);
    const report = await again.openAdmin().fsck();
    expect(report.faults.length).toBeGreaterThan(0);
    expect(report.faults.map((f) => [f.kind, f.peer, f.id, f.key])).toEqual(
      report.faults.map(() => ["engine", undefined, undefined, undefined]),
    );
    expect(report.faults.map((f) => f.detail.split(": ").slice(0, 2).join(": "))).toEqual(
      report.faults.map(() => "sqlite store: integrity_check"),
    );
  });
});

describe("fsck on a file the engine cannot read whole (SQLite)", () => {
  it("overwritten pages: fsck answers a report with one engine fault that names the engine's code; a read refuses store-unavailable; a new open refuses open-failed", async () => {
    const { path, store, a, t } = await sqliteFilled();
    const db = new Database(path);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const size = db.pragma("page_size", { simple: true }) as number;
    const count = db.pragma("page_count", { simple: true }) as number;
    db.close();
    const file = openSync(path, "r+");
    for (let page = 1; page < count; page++)
      writeSync(file, Buffer.alloc(size, 0xff), 0, size, page * size);
    closeSync(file);
    const report = await store.openAdmin().fsck();
    expect(places(report)).toEqual([
      { kind: "engine", peer: undefined, id: undefined, key: undefined },
    ]);
    expect(report.faults[0]!.detail).toMatch(/SQLITE_CORRUPT/);
    const read = await a
      .read()
      .then((snapshot) => snapshot.get([t.id]))
      .then(
        () => "answered",
        (error: unknown) => (error instanceof StoreError ? error.code : String(error)),
      );
    expect(read).toBe("store-unavailable");
    const reopened = await openSqliteStore(path).then(
      () => "opened",
      (error: unknown) => (error instanceof StoreError ? error.code : String(error)),
    );
    expect(reopened).toBe("open-failed");
  });

  it("an overwritten header: fsck answers a report with one engine fault that names SQLITE_NOTADB", async () => {
    const { path, store } = await sqliteFilled();
    const db = new Database(path);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    const file = openSync(path, "r+");
    writeSync(file, Buffer.from("this is not a database file"), 0, 27, 0);
    closeSync(file);
    const report = await store.openAdmin().fsck();
    expect(places(report)).toEqual([
      { kind: "engine", peer: undefined, id: undefined, key: undefined },
    ]);
    expect(report.faults[0]!.detail).toMatch(/SQLITE_NOTADB/);
  });

  it("an engine error that is not a damaged page (a table dropped by another connection) still rejects store-unavailable, not a report", async () => {
    const { store, damage } = await sqliteFilled();
    damage("DROP TABLE reference");
    const answer = await store
      .openAdmin()
      .fsck()
      .then(
        () => "answered",
        (error: unknown) => (error instanceof StoreError ? error.code : String(error)),
      );
    expect(answer).toBe("store-unavailable");
  });
});

type Row = { claims: Claims; holders: number };
type Holding = { arrival: { sequence: number; transfer: number; id: string } };

/**
 * The memory store's own map of rows, the row of `id` and the peer's holding of it, recorded by
 * a watch on `Map.prototype.get` while one `get` runs. The watch ends before the call returns.
 */
async function internals(peer: PeerStore, id: string) {
  const snapshot = await peer.read();
  const real = Map.prototype.get;
  const seen: { map: Map<unknown, unknown>; value: object }[] = [];
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    const value: unknown = real.call(this, key);
    if (key === id && typeof value === "object" && value !== null) seen.push({ map: this, value });
    return value;
  };
  let pending: Promise<unknown>;
  try {
    pending = snapshot.get([id]);
  } finally {
    Map.prototype.get = real;
  }
  await pending;
  const row = seen.find((s) => "holders" in s.value)!;
  const holding = seen.find((s) => "arrival" in s.value)!;
  return { rows: row.map, row: row.value as Row, holding: holding.value as Holding };
}

async function memoryFilled() {
  const store: Store = createMemoryStore();
  const a = await store.createPeer("peer:a", { erasure: "unproven" });
  const t = fact("e:t");
  const n = negation(t);
  const b = fact("e:b");
  await add(a, [t]);
  await add(a, [n]);
  await add(a, [b]);
  const fsck = () => store.openAdmin().fsck();
  expect((await fsck()).faults).toEqual([]);
  return { store, a, t, n, b, fsck };
}

describe("a damaged memory store", () => {
  it("a held id whose row is gone: get, arrivals, targets and scope throw claims-unreadable with the peer and the id, as on SQLite; fsck reports it; the bystander reads", async () => {
    const { a, t, n, b, fsck } = await memoryFilled();
    (await internals(a, t.id)).rows.delete(t.id);
    const fault = { kind: "claims-unreadable", peer: "peer:a", id: t.id, key: undefined };
    const snapshot = await a.read();
    expect(
      await Promise.all([
        faultOf(snapshot.get([t.id])),
        faultOf(snapshot.arrivals([t.id])),
        faultOf(snapshot.targets(["e:t"])),
        faultOf(snapshot.scope(at("e:t"))),
      ]),
    ).toEqual([fault, fault, fault, fault]);
    expect(await snapshot.negators([t.id])).toEqual([n.id]);
    expect(places(await fsck())).toContainEqual(fault);
    expect(await snapshot.get([b.id])).toEqual([b]);
  });

  it("a lost negation: negators throws claims-unreadable with its id", async () => {
    const { a, t, n } = await memoryFilled();
    (await internals(a, n.id)).rows.delete(n.id);
    expect(await faultOf((await a.read()).negators([t.id]))).toEqual({
      kind: "claims-unreadable",
      peer: "peer:a",
      id: n.id,
      key: undefined,
    });
  });

  it.each([
    ["sequence", "seq", "sequence-mismatch"],
    ["transfer", "transfer", "sequence-mismatch"],
  ] as const)(
    "a held arrival's %s above the peer's last: fsck reports %s",
    async (field, key, kind) => {
      const { a, t, fsck } = await memoryFilled();
      (await internals(a, t.id)).holding.arrival[field] = 999;
      expect(places(await fsck())).toEqual([{ kind, peer: "peer:a", id: t.id, key }]);
    },
  );

  it("a held arrival that names another id: fsck reports column-mismatch (holding.arrival), the key SQLite gives", async () => {
    const { a, t, b, fsck } = await memoryFilled();
    (await internals(a, t.id)).holding.arrival.id = b.id;
    expect(places(await fsck())).toEqual([
      { kind: "column-mismatch", peer: "peer:a", id: t.id, key: "holding.arrival" },
    ]);
  });

  it("two held ids of one peer whose rows are gone: fsck reports the full list, claims-unreadable for each and index-stray for each target entry", async () => {
    const { a, t, b, fsck } = await memoryFilled();
    const { rows } = await internals(a, t.id);
    rows.delete(t.id);
    rows.delete(b.id);
    const lost = [t.id, b.id].sort();
    expect(places(await fsck())).toEqual([
      ...lost.map((id) => ({ kind: "claims-unreadable", peer: "peer:a", id, key: undefined })),
      { kind: "index-stray", peer: "peer:a", id: b.id, key: "e:b" },
      { kind: "index-stray", peer: "peer:a", id: t.id, key: "e:t" },
    ]);
  });

  it("a row that counts fewer holders than hold it: fsck reports count-mismatch (holders) with no peer", async () => {
    const { a, t, fsck } = await memoryFilled();
    (await internals(a, t.id)).row.holders = 0;
    const report = await fsck();
    expect(places(report)).toEqual([
      { kind: "count-mismatch", peer: undefined, id: t.id, key: "holders" },
    ]);
    expect(report.faults[0]!.detail).toBe(
      "memory store: the row counts 0 holders and 1 peers hold it",
    );
  });

  it.each([
    ["the newest change record lost", 2],
    ["a middle change record lost", 1],
    ["a middle change record renumbered", -1],
  ])(
    "%s: changes over it throws feed-gap with the peer, a follower throws it and keeps its position, and fsck reports it",
    async (_, lost) => {
      const { store, a, fsck } = await memoryFilled();
      const real = Map.prototype.get;
      const states: { feed: { records: unknown[] } }[] = [];
      Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
        const value: unknown = real.call(this, key);
        if (key === "peer:a" && typeof value === "object" && value !== null && "feed" in value)
          states.push(value as { feed: { records: unknown[] } });
        return value;
      };
      let pending: Promise<unknown>;
      try {
        pending = store.peer("peer:a");
      } finally {
        Map.prototype.get = real;
      }
      await pending;
      expect(states.length).toBe(1);
      const records = states[0]!.feed.records;
      if (lost < 0) records[1] = { ...(records[1] as object), revision: 7 };
      else records.splice(lost, 1);
      const detail = `memory store: the peer keeps ${records.length} change records at floor 0 and revision 3`;
      const fault = { kind: "feed-gap", peer: "peer:a", id: undefined, key: undefined };
      const thrown = (call: Promise<unknown>) =>
        call.then(
          () => "answered",
          (error: unknown) =>
            error instanceof StoreIntegrityError
              ? { ...place(error.fault), detail: error.fault.detail }
              : `not a StoreIntegrityError: ${String(error)}`,
        );
      for (const from of lost < 0 ? [0, 1] : [0, 1, 2])
        expect(await thrown(a.changes(from)), `from ${from}`).toEqual({ ...fault, detail });
      expect(await a.changes(3)).toEqual({ status: "ok", records: [], through: 3 });
      const snapshot = await a.read();
      const start = { history: snapshot.history, revision: 0 };
      snapshot.release();
      const cursor = followFeed(a, start);
      expect(await thrown(cursor.pull())).toEqual({ ...fault, detail });
      expect(cursor.position).toEqual(start);
      const now = await a.read();
      expect([now.revision, now.count]).toEqual([3, 3]);
      now.release();
      expect((await fsck()).faults).toEqual([{ ...fault, detail }]);
    },
  );

  it("stored claims that do not hash to their id: fsck reports claims-mismatch", async () => {
    const { a, t, b, fsck } = await memoryFilled();
    (await internals(a, t.id)).row.claims = b.claims;
    expect(places(await fsck())).toContainEqual({
      kind: "claims-mismatch",
      peer: "peer:a",
      id: t.id,
      key: undefined,
    });
  });
});
