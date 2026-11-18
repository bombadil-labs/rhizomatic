// A purge of a damaged id (SPEC-18 proposal §4.13 reading 136): the remedy for a row a read
// refuses is `purge([id])`, so that purge completes on both stores. Each rail is two-sided: the
// damaged target is gone, and a named live bystander still reads. The SQLite damage is made by a
// second connection on a file in a new temporary directory; the memory damage by a test-only watch
// on `Map.prototype.get`, which records the store's map of rows while one read runs.

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { makeDelta } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { admissionOf } from "../src/storage/admission.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { openSqliteStore, type SqliteStore } from "../src/storage/sqlite-store.js";
import {
  StoreError,
  StoreIntegrityError,
  type ErasurePosture,
  type PeerStore,
  type Snapshot,
  type Store,
} from "../src/storage/store.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const fixture = sqliteFixture("rhizomatic-purge-damaged");
const opened: SqliteStore[] = [];
afterAll(async () => {
  for (const store of opened) await store.close();
  await fixture.cleanup();
});

const AUTHOR = `ed25519:${"6e".repeat(32)}`;
let stamp = 0;
const fact = (entity: string): Delta =>
  makeDelta({
    timestamp: ++stamp,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "about", target: { kind: "entity", entity: { id: entity } } }],
  });

let heads = 0;
async function add(peer: PeerStore, deltas: readonly Delta[]): Promise<void> {
  const now = await peer.read();
  const result = await peer.append(
    admissionOf(now, deltas, { at: 1, sender: "local", nextHead: `head-${++heads}` }),
  );
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
}

/** The target is gone from every read, and the bystander reads as before. */
async function goneAndKept(peer: PeerStore, target: Delta, bystander: Delta) {
  const now = await peer.read();
  expect([
    await now.get([target.id]),
    await now.arrivals([target.id]),
    await now.targets(["e:target"]),
  ]).toEqual([[], [], []]);
  expect(await now.get([bystander.id])).toEqual([bystander]);
  expect((await now.arrivals([bystander.id])).map((r) => r.id)).toEqual([bystander.id]);
  expect(await now.targets(["e:bystander"])).toEqual([bystander.id]);
  expect(now.count).toBe(1);
}

describe("a purge of a damaged id on the SQLite store", () => {
  async function filled(posture: ErasurePosture) {
    const path = fixture.path();
    const store = await openSqliteStore(path);
    opened.push(store);
    const peer = await store.createPeer("peer:a", { erasure: posture });
    const target = fact("e:target");
    const bystander = fact("e:bystander");
    await add(peer, [target, bystander]);
    const damage = (sql: string, ...args: unknown[]): void => {
      const db = new Database(path);
      try {
        db.pragma("foreign_keys = OFF");
        db.prepare(sql).run(...args);
      } finally {
        db.close();
      }
    };
    return { store, peer, target, bystander, damage };
  }

  it.each([
    ["claims that do not hash to their id", "UPDATE delta SET claims = x'f6' WHERE id = ?"],
    ["a lost delta row", "DELETE FROM delta WHERE id = ?"],
    ["an arrival record that is not one", "UPDATE holding SET arrival = '{}' WHERE delta = ?"],
  ])(
    "%s: the purge answers removed, the target is gone, the bystander reads, and fsck finds nothing",
    async (_, sql) => {
      const { store, peer, target, bystander, damage } = await filled("unproven");
      damage(sql, target.id);
      const report = await peer.purge([target.id]);
      expect([report.claim, report.targets]).toEqual([
        "unproven",
        [{ id: target.id, outcome: "removed" }],
      ]);
      await goneAndKept(peer, target, bystander);
      expect((await store.openAdmin().fsck()).faults).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "a peer of posture proven: the purge of damaged claims answers proven, the target is gone, and the bystander reads",
    async () => {
      const { peer, target, bystander, damage } = await filled("proven");
      damage("UPDATE delta SET claims = x'f6' WHERE id = ?", target.id);
      const report = await peer.purge([target.id]);
      expect([report.claim, report.targets]).toEqual([
        "proven",
        [{ id: target.id, outcome: "removed" }],
      ]);
      await goneAndKept(peer, target, bystander);
    },
  );
});

/** Deletes the stored row of `id`: the watch records the store's map of rows while one read runs. */
async function loseRow(peer: PeerStore, id: string): Promise<void> {
  const snapshot = await peer.read();
  const real = Map.prototype.get;
  const rows: Map<unknown, unknown>[] = [];
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    const value: unknown = real.call(this, key);
    if (key === id && typeof value === "object" && value !== null && "holders" in value)
      rows.push(this);
    return value;
  };
  let pending: Promise<unknown>;
  try {
    pending = snapshot.get([id]);
  } finally {
    Map.prototype.get = real;
  }
  await pending;
  expect(rows.length).toBe(1);
  rows[0]!.delete(id);
}

/** What a call answers: `answered`, a store error's code, or an integrity fault's kind and peer. */
const outcomeOf = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "answered",
    (error: unknown) =>
      error instanceof StoreIntegrityError
        ? `${error.fault.kind} ${error.fault.peer} ${error.fault.id}`
        : error instanceof StoreError
          ? error.code
          : `not a store error: ${String(error)}`,
  );
/** Every read call of a snapshot, for the id and the entity it names. */
const everyRead = async (s: Snapshot, id: string, entity: string): Promise<string[]> => [
  await outcomeOf(s.get([id])),
  await outcomeOf(s.arrivals([id])),
  await outcomeOf(s.targets([entity])),
  await outcomeOf(s.negators([id])),
  await outcomeOf(s.scope({ anchors: [{ kind: "entity", entity }] })),
];
const MOVED = Array.from({ length: 5 }, () => "snapshot-moved");
const faults = async (store: Store) =>
  (await store.openAdmin().fsck()).faults.map(({ kind, peer, id, key }) => ({
    kind,
    peer,
    id,
    key,
  }));

describe("a purge of a damaged id on the memory store", () => {
  async function damaged() {
    const store = createMemoryStore();
    const peer = await store.createPeer("peer:a", { erasure: "unproven" });
    const target = fact("e:target");
    const bystander = fact("e:bystander");
    await add(peer, [target, bystander]);
    await loseRow(peer, target.id);
    const before = await peer.read();
    return { store, peer, target, bystander, before };
  }

  it("a held id whose row is gone: the purge answers removed with its index entries owed and retained, writes one change record that names the id, moves every snapshot, the target is gone, and the bystander reads", async () => {
    const { store, peer, target, bystander, before } = await damaged();
    const report = await peer.purge([target.id]);
    expect([report.claim, report.revision, report.targets, report.surfaces]).toEqual([
      "unproven",
      before.revision + 1,
      [{ id: target.id, outcome: "removed" }],
      [
        { surface: "rows", state: "absent" },
        { surface: "index-entries", state: "owed" },
        { surface: "process-memory", state: "unprovable" },
      ],
    ]);
    expect(report.retains).toEqual([
      { surface: "change-feed", holds: "id" },
      { surface: "index-entries", holds: "id" },
    ]);
    expect((await peer.read()).revision).toBe(before.revision + 1);
    expect(await peer.changes(before.revision)).toEqual({
      status: "ok",
      records: [
        { revision: before.revision + 1, head: before.head, added: [], removed: [target.id] },
      ],
      through: before.revision + 1,
    });
    expect(await everyRead(before, target.id, "e:target")).toEqual(MOVED);
    await goneAndKept(peer, target, bystander);
    expect(await faults(store)).toEqual([
      { kind: "index-stray", peer: "peer:a", id: target.id, key: "e:target" },
    ]);
  });

  it("no debt is recorded: a second purge of the id answers not-held and index-entries absent, and the stray entry stays", async () => {
    const { store, peer, target } = await damaged();
    await peer.purge([target.id]);
    const again = await peer.purge([target.id]);
    expect([again.claim, again.targets, again.surfaces[1]]).toEqual([
      "nothing-removed",
      [{ id: target.id, outcome: "not-held" }],
      { surface: "index-entries", state: "absent" },
    ]);
    expect(await faults(store)).toEqual([
      { kind: "index-stray", peer: "peer:a", id: target.id, key: "e:target" },
    ]);
  });

  it("the remedy: the same delta appended again and purged clears the stray entries, fsck finds nothing, and the bystander reads", async () => {
    const { store, peer, target, bystander } = await damaged();
    await peer.purge([target.id]);
    await add(peer, [target]);
    const report = await peer.purge([target.id]);
    expect([report.targets, report.surfaces[1]]).toEqual([
      [{ id: target.id, outcome: "removed" }],
      { surface: "index-entries", state: "absent" },
    ]);
    await goneAndKept(peer, target, bystander);
    expect(await faults(store)).toEqual([]);
  });

  it.each([0, 1, 2])(
    "the damaged id at sorted place %i of three named ids: exactly the three leave in one revision with one change record, every snapshot moves, and the two bystanders read",
    async (place) => {
      const store = createMemoryStore();
      const peer = await store.createPeer("peer:a", { erasure: "unproven" });
      const named = [fact("e:n0"), fact("e:n1"), fact("e:n2")]
        .map((delta, n) => ({ delta, entity: `e:n${n}` }))
        .sort((x, y) => (x.delta.id < y.delta.id ? -1 : 1));
      const bystanders = [fact("e:b0"), fact("e:b1")];
      await add(peer, [...named.map((n) => n.delta), ...bystanders]);
      const lost = named[place]!;
      await loseRow(peer, lost.delta.id);
      const before = await peer.read();
      const ids = named.map((n) => n.delta.id);
      const report = await peer.purge([...ids].reverse());
      expect([report.revision, report.targets, report.surfaces[1]]).toEqual([
        before.revision + 1,
        ids.map((id) => ({ id, outcome: "removed" })),
        { surface: "index-entries", state: "owed" },
      ]);
      expect(await peer.changes(before.revision)).toEqual({
        status: "ok",
        records: [{ revision: before.revision + 1, head: before.head, added: [], removed: ids }],
        through: before.revision + 1,
      });
      expect(await everyRead(before, lost.delta.id, lost.entity)).toEqual(MOVED);
      const now = await peer.read();
      expect(now.count).toBe(2);
      expect(await now.get(ids)).toEqual([]);
      for (const n of named) expect(await now.targets([n.entity])).toEqual([]);
      for (const [b, bystander] of bystanders.entries()) {
        expect(await now.get([bystander.id])).toEqual([bystander]);
        expect((await now.arrivals([bystander.id])).map((r) => r.id)).toEqual([bystander.id]);
        expect(await now.targets([`e:b${b}`])).toEqual([bystander.id]);
      }
      expect(await faults(store)).toEqual([
        { kind: "index-stray", peer: "peer:a", id: lost.delta.id, key: lost.entity },
      ]);
    },
  );

  it("two peers hold the damaged id: peer A's purge removes A's holding only; peer B still holds it, B's reads of it throw claims-unreadable naming B, B's bystander reads, and fsck names the stray entry of each peer", async () => {
    const store = createMemoryStore();
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const target = fact("e:target");
    const bystander = fact("e:bystander");
    await add(a, [target, bystander]);
    await add(b, [target, bystander]);
    await loseRow(a, target.id);
    const beforeB = await b.read();
    const report = await a.purge([target.id]);
    expect([report.targets, report.surfaces[1]]).toEqual([
      [{ id: target.id, outcome: "removed" }],
      { surface: "index-entries", state: "owed" },
    ]);
    await goneAndKept(a, target, bystander);
    const nowB = await b.read();
    expect([nowB.revision, nowB.count]).toEqual([beforeB.revision, 2]);
    const unreadable = `claims-unreadable peer:b ${target.id}`;
    expect([
      await outcomeOf(nowB.get([target.id])),
      await outcomeOf(nowB.arrivals([target.id])),
      await outcomeOf(nowB.targets(["e:target"])),
      await outcomeOf(nowB.scope({ anchors: [{ kind: "entity", entity: "e:target" }] })),
    ]).toEqual([unreadable, unreadable, unreadable, unreadable]);
    expect(await nowB.get([bystander.id])).toEqual([bystander]);
    expect(await nowB.targets(["e:bystander"])).toEqual([bystander.id]);
    expect(await faults(store)).toEqual([
      { kind: "index-stray", peer: "peer:a", id: target.id, key: "e:target" },
      { kind: "claims-unreadable", peer: "peer:b", id: target.id, key: undefined },
      { kind: "index-stray", peer: "peer:b", id: target.id, key: "e:target" },
    ]);
  });
});
