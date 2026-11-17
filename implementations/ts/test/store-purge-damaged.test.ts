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
import type { ErasurePosture, PeerStore } from "../src/storage/store.js";
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

describe("a purge of a damaged id on the memory store", () => {
  it("a held id whose row is gone: the purge answers removed with its index entries owed, the target is gone, and the bystander reads", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer("peer:a", { erasure: "unproven" });
    const target = fact("e:target");
    const bystander = fact("e:bystander");
    await add(peer, [target, bystander]);
    const snapshot = await peer.read();
    const real = Map.prototype.get;
    let rows: Map<unknown, unknown> | undefined;
    Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
      const value: unknown = real.call(this, key);
      if (key === target.id && typeof value === "object" && value !== null && "holders" in value)
        rows = this;
      return value;
    };
    let pending: Promise<unknown>;
    try {
      pending = snapshot.get([target.id]);
    } finally {
      Map.prototype.get = real;
    }
    await pending;
    rows!.delete(target.id);
    const report = await peer.purge([target.id]);
    expect([report.claim, report.targets, report.surfaces]).toEqual([
      "unproven",
      [{ id: target.id, outcome: "removed" }],
      [
        { surface: "rows", state: "absent" },
        { surface: "index-entries", state: "owed" },
        { surface: "process-memory", state: "unprovable" },
      ],
    ]);
    await goneAndKept(peer, target, bystander);
    expect(
      (await store.openAdmin().fsck()).faults.map(({ kind, id, key }) => ({ kind, id, key })),
    ).toEqual([{ kind: "index-stray", id: target.id, key: "e:target" }]);
  });
});
