// Peer delete (SPEC-18 proposal §4.13 reading 144): the contract, on the memory store and on the
// SQLite store. Every rail is two-sided: what the delete removes is gone, and a named bystander
// peer reads as before, byte for byte. The SQLite stores live in one `mkdtempSync` directory,
// which the file removes at its end. The byte scans and the many-process rails of the SQLite store
// are in sqlite-store-peer-delete.test.ts.

import { afterAll, describe, expect, it } from "vitest";
import { makeDelta } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { admissionOf } from "../src/storage/admission.js";
import { EMPTY_DIGEST, digestOf } from "../src/storage/digest.js";
import { createMemoryStore, type MemoryStoreOptions } from "../src/storage/memory-store.js";
import type { SqliteStoreOptions } from "../src/storage/sqlite-store.js";
import {
  StoreError,
  StoreIntegrityError,
  type DeleteReport,
  type ErasurePosture,
  type PeerStore,
  type Snapshot,
  type Store,
} from "../src/storage/store.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const fixture = sqliteFixture("rhizomatic-peer-delete");
afterAll(() => fixture.cleanup());

const PROVEN_HERE = process.platform === "linux";

type Options = { mintHistory?: (peer: string) => string };
const STORES: [
  name: string,
  open: (options?: Options) => Promise<Store>,
  posture: ErasurePosture,
  claim: DeleteReport["claim"],
][] = [
  [
    "memory",
    async (options) => createMemoryStore(options as MemoryStoreOptions),
    "unproven",
    "unproven",
  ],
  [
    "sqlite",
    (options) => fixture.audited(options as SqliteStoreOptions),
    PROVEN_HERE ? "proven" : "unproven",
    PROVEN_HERE ? "proven" : "unproven",
  ],
];

const AUTHOR = `ed25519:${"5d".repeat(32)}`;
let stamp = 0;
const fact = (entity: string): Delta =>
  makeDelta({
    timestamp: ++stamp,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "about", target: { kind: "entity", entity: { id: entity } } }],
  });
const facts = (tag: string, n: number): Delta[] =>
  Array.from({ length: n }, (_, i) => fact(`${tag}${i}`));
const ids = (deltas: readonly Delta[]): string[] => deltas.map((d) => d.id).sort();

let heads = 0;
async function add(peer: PeerStore, deltas: readonly Delta[]): Promise<void> {
  const now = await peer.read();
  const result = await peer.append(
    admissionOf(now, deltas, { at: 1, sender: "local", nextHead: `head-${++heads}` }),
  );
  now.release();
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
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

/** Every call of a snapshot, each with its code. */
const snapshotCodes = async (s: Snapshot, id: string): Promise<string[]> => [
  await code(() => s.get([id])),
  await code(() => s.arrivals([id])),
  await code(() => s.targets(["e"])),
  await code(() => s.negators([id])),
  await code(() => s.scope({ anchors: [{ kind: "entity", entity: "e" }] })),
  await code(() => s.digest("")),
];
/** Every call of a handle, each with its code. */
const handleCodes = async (p: PeerStore, id: string): Promise<string[]> => [
  await code(() => p.history),
  await code(() => p.appFormat),
  await code(() => p.read()),
  await code(() => p.append({ expectedHead: null, nextHead: "h", frame: null, added: [] })),
  await code(() => p.purge([id])),
  await code(() => p.changes(0)),
];

/** Every call of a handle, by name. The R4 rail checks that it names them all. */
const HANDLE_CALLS: Record<string, (p: PeerStore, id: string) => unknown> = {
  history: (p) => p.history,
  appFormat: (p) => p.appFormat,
  read: (p) => p.read(),
  append: (p) => p.append({ expectedHead: null, nextHead: "h", frame: null, added: [] }),
  purge: (p, id) => p.purge([id]),
  changes: (p) => p.changes(0),
};

async function listed<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

/** The bystander reads its deltas byte for byte, and its root names exactly its set. */
async function holds(peer: PeerStore, deltas: readonly Delta[]): Promise<void> {
  const now = await peer.read();
  const byId = new Map(deltas.map((d) => [d.id, d]));
  expect(await now.get(ids(deltas))).toEqual(ids(deltas).map((id) => byId.get(id)));
  expect([now.count, now.root]).toEqual([deltas.length, digestOf(ids(deltas)).hash]);
  now.release();
}

describe.each(STORES)("peer delete on the %s store", (name, open, posture, claim) => {
  it("rail 2: released counts every holding and keptByOtherPeers the ids another peer holds; the shared bytes stay with the bystander and the others leave the store", async () => {
    const store = await open();
    const a = await store.createPeer("peer:a", { erasure: posture });
    const b = await store.createPeer("peer:b", { erasure: posture });
    const own = facts("own", 4);
    const shared = facts("shared", 3);
    const bystander = facts("bystander", 2);
    await add(a, [...own, ...shared]);
    await add(b, [...shared, ...bystander]);
    const report = await store.deletePeer("peer:a");
    expect([report.released, report.keptByOtherPeers, report.claim]).toEqual([7, 3, claim]);
    expect(report.boundary).toBe("store-controlled-surfaces");
    // The delete names every surface a purge names, in the purge's order.
    const purge = await b.purge([]);
    expect(report.surfaces.map((s) => s.surface)).toEqual(purge.surfaces.map((s) => s.surface));
    expect(report.retains.map((r) => r.surface)).toEqual(
      name === "memory" ? ["change-feed"] : ["change-feed", "purge-debt", "surface-debt"],
    );
    const admin = store.openAdmin();
    expect(await listed(admin.storedIds())).toEqual(ids([...shared, ...bystander]));
    expect(await listed(admin.peers())).toEqual(["peer:b"]);
    await holds(b, [...shared, ...bystander]);
    expect((await admin.fsck()).faults).toEqual([]);
  });

  it("rail 3: from the delete on, every call of a handle refuses peer-absent and every call of a snapshot refuses snapshot-moved; a peer created again has a new history, no holdings and the empty root, and the old snapshot still refuses", async () => {
    let n = 0;
    const store = await open({ mintHistory: (peer) => `h:${peer}:${++n}` });
    const a = await store.createPeer("peer:a", { erasure: posture });
    const b = await store.createPeer("peer:b", { erasure: posture });
    const deltas = facts("a", 3);
    const bystander = facts("b", 2);
    await add(a, deltas);
    await add(b, bystander);
    const old = await a.read();
    const history = a.history;
    expect(await snapshotCodes(old, deltas[0]!.id)).toEqual(Array(6).fill("answered"));
    await store.deletePeer("peer:a");
    expect(await snapshotCodes(old, deltas[0]!.id)).toEqual(Array(6).fill("snapshot-moved"));
    expect(await handleCodes(a, deltas[0]!.id)).toEqual(Array(6).fill("peer-absent"));
    expect(await code(() => store.peer("peer:a"))).toBe("peer-absent");
    expect(await code(() => listed(store.openAdmin().peer("peer:a").ids()))).toBe("peer-absent");

    const again = await store.createPeer("peer:a", { erasure: posture });
    expect(again.history).not.toBe(history);
    const now = await again.read();
    expect([now.count, now.revision, now.head, now.root, now.lastSequence]).toEqual([
      0,
      0,
      null,
      EMPTY_DIGEST.hash,
      0,
    ]);
    expect(await now.get(ids(deltas))).toEqual([]);
    expect(await listed(store.openAdmin().peer("peer:a").ids())).toEqual([]);
    expect(await snapshotCodes(old, deltas[0]!.id)).toEqual(Array(6).fill("snapshot-moved"));
    // A handle names the peer it was made for: the old handle never reaches the new peer.
    expect(await handleCodes(a, deltas[0]!.id)).toEqual(Array(6).fill("peer-absent"));
    await holds(b, bystander);
    expect((await store.openAdmin().fsck()).faults).toEqual([]);
  });

  it("a peer whose root was a node (40 ids) is deleted and created again: the new peer's root and digest(\"\") are the empty digest, then the digest of only what it appends; fsck is clean, and the bystander's root names its set", async () => {
    const store = await open();
    const a = await store.createPeer("peer:a", { erasure: posture });
    const b = await store.createPeer("peer:b", { erasure: posture });
    const deltas = facts("dg", 40);
    const bystander = facts("dgb", 3);
    await add(a, deltas);
    await add(b, bystander);
    const before = await a.read();
    expect([before.root, await before.digest("")]).toEqual([
      digestOf(ids(deltas)).hash,
      digestOf(ids(deltas)),
    ]);
    before.release();
    await store.deletePeer("peer:a");
    const again = await store.createPeer("peer:a", { erasure: posture });
    const now = await again.read();
    expect([now.root, await now.digest("")]).toEqual([EMPTY_DIGEST.hash, EMPTY_DIGEST]);
    now.release();
    const two = deltas.slice(0, 2);
    await add(again, two);
    const refilled = await again.read();
    expect([refilled.root, await refilled.digest("")]).toEqual([
      digestOf(ids(two)).hash,
      digestOf(ids(two)),
    ]);
    refilled.release();
    await holds(b, bystander);
    expect((await store.openAdmin().fsck()).faults).toEqual([]);
  });

  it("R4: after a delete and a createPeer of the id, every call of an old handle with a well-formed request refuses peer-absent and changes nothing; a new handle answers every call", async () => {
    const store = await open();
    const a = await store.createPeer("peer:a", { erasure: posture });
    const b = await store.createPeer("peer:b", { erasure: posture });
    const bystander = facts("r4b", 2);
    await add(a, facts("r4a", 3));
    await add(b, bystander);
    // The table names every call of a handle: a new call fails this check until it is listed.
    expect(
      Object.keys(a)
        .filter((key) => key !== "id" && key !== "erasure")
        .sort(),
    ).toEqual(Object.keys(HANDLE_CALLS).sort());
    const id = facts("r4x", 1)[0]!.id;
    await store.deletePeer("peer:a");
    const fresh = await store.createPeer("peer:a", { erasure: posture });
    const kept = facts("r4n", 2);
    await add(fresh, kept);
    const before = await fresh.read();
    for (const [call, run] of Object.entries(HANDLE_CALLS))
      expect([call, await code(() => run(a, id))]).toEqual([call, "peer-absent"]);
    const after = await fresh.read();
    expect([after.revision, after.head, after.count]).toEqual([
      before.revision,
      before.head,
      before.count,
    ]);
    await holds(fresh, kept);
    const handle = await store.peer("peer:a");
    for (const [call, run] of Object.entries(HANDLE_CALLS))
      expect([call, await code(() => run(handle, id))]).toEqual([call, "answered"]);
    await holds(b, bystander);
    expect((await store.openAdmin().fsck()).faults).toEqual([]);
  });

  it("rail 3: the store keeps the deleted peer's history, so a mint that gives it again is refused", async () => {
    const store = await open({ mintHistory: () => "h:fixed" });
    await store.createPeer("peer:a", { erasure: posture });
    await store.deletePeer("peer:a");
    const refused = await store.createPeer("peer:a", { erasure: posture }).catch((e: unknown) => e);
    expect([(refused as StoreError).code, (refused as StoreError).message]).toEqual([
      "invalid-request",
      `${name} store: the mint answered h:fixed, a history this store already issued; a history is never reused`,
    ]);
  });

  it("rail 7: a peer of posture unproven is deleted with the claim unproven; the other peer's revision, root, feed and holdings do not change", async () => {
    const store = await open();
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: posture });
    const shared = facts("s", 2);
    const bystander = [...shared, ...facts("b", 3)];
    await add(a, [...shared, ...facts("a", 3)]);
    await add(b, bystander);
    const before = await b.read();
    const feed = await b.changes(0);
    const report = await store.deletePeer("peer:a");
    expect([report.claim, report.released, report.keptByOtherPeers]).toEqual(["unproven", 5, 2]);
    const after = await b.read();
    expect([after.revision, after.root, after.history]).toEqual([
      before.revision,
      before.root,
      before.history,
    ]);
    expect(await b.changes(0)).toEqual(feed);
    await holds(b, bystander);
    expect((await store.openAdmin().fsck()).faults).toEqual([]);
  });

  it("rail 6: another peer's purge of a shared id after the delete answers removed; with the order reversed, the purge debt it left answers removed after the delete", async () => {
    const store = await open();
    const a = await store.createPeer("peer:a", { erasure: posture });
    const b = await store.createPeer("peer:b", { erasure: posture });
    const [x, y, z] = facts("x", 3) as [Delta, Delta, Delta];
    await add(a, [x, z]);
    await add(b, [x, y]);
    // B purges x while A holds it, so B owes x.
    const first = await b.purge([x.id]);
    expect(first.targets).toEqual([{ id: x.id, outcome: "held-by-other-peer" }]);
    const report = await store.deletePeer("peer:a");
    expect([report.released, report.keptByOtherPeers]).toEqual([2, 0]);
    expect(await listed(store.openAdmin().storedIds())).toEqual([y.id]);
    const owed = await b.purge([x.id]);
    expect([owed.claim, owed.targets]).toEqual([claim, [{ id: x.id, outcome: "removed" }]]);
    await holds(b, [y]);

    const c = await store.createPeer("peer:c", { erasure: posture });
    await add(c, [x]);
    await add(b, [x]);
    const kept = await store.deletePeer("peer:c");
    expect([kept.released, kept.keptByOtherPeers]).toEqual([1, 1]);
    const last = await b.purge([x.id]);
    expect([last.claim, last.targets]).toEqual([claim, [{ id: x.id, outcome: "removed" }]]);
    expect(await listed(store.openAdmin().storedIds())).toEqual([y.id]);
    await holds(b, [y]);
    expect((await store.openAdmin().fsck()).faults).toEqual([]);
  });

  it("retains names purge-debt when a debt of another peer names an id the deleted peer released in an earlier purge, and the memory store omits it when the delete settles the last debt; the bystander reads back", async () => {
    const store = await open();
    const a = await store.createPeer("peer:a", { erasure: posture });
    const b = await store.createPeer("peer:b", { erasure: posture });
    const c = await store.createPeer("peer:c", { erasure: posture });
    const [x, y] = facts("debt", 2) as [Delta, Delta];
    await add(a, [x]);
    await add(b, [x]);
    await add(c, [x, y]);
    // A and B purge x while C holds it, so each owes x.
    expect((await a.purge([x.id])).targets).toEqual([{ id: x.id, outcome: "held-by-other-peer" }]);
    expect((await b.purge([x.id])).targets).toEqual([{ id: x.id, outcome: "held-by-other-peer" }]);
    const report = await store.deletePeer("peer:a");
    expect([report.released, report.keptByOtherPeers]).toEqual([0, 0]);
    expect(report.retains.map((r) => r.surface)).toContain("purge-debt");
    // B's debt of x is still in the store: its purge reports it.
    const owed = await b.purge([x.id]);
    expect(owed.targets).toEqual([{ id: x.id, outcome: "held-by-other-peer" }]);
    expect(owed.retains.map((r) => r.surface)).toContain("purge-debt");

    // C's purge removes x. Then B's debt is the last one, and its delete settles it.
    expect((await c.purge([x.id])).targets).toEqual([{ id: x.id, outcome: "removed" }]);
    const settled = await store.deletePeer("peer:b");
    expect(settled.retains.map((r) => r.surface)).toEqual(
      name === "memory" ? ["change-feed"] : ["change-feed", "purge-debt", "surface-debt"],
    );
    expect(await listed(store.openAdmin().storedIds())).toEqual([y.id]);
    await holds(c, [y]);
    expect((await store.openAdmin().fsck()).faults).toEqual([]);
  });

  it("rail 10: a peer with no holdings, the last peer, and a second delete; the request is checked first", async () => {
    const store = await open();
    const empty = await store.createPeer("peer:empty", { erasure: posture });
    await empty.append({ expectedHead: null, nextHead: "only-a-head", frame: null, added: [] });
    const b = await store.createPeer("peer:b", { erasure: posture });
    const bystander = facts("b", 2);
    await add(b, bystander);
    const report = await store.deletePeer("peer:empty");
    expect([report.claim, report.released, report.keptByOtherPeers]).toEqual([claim, 0, 0]);
    expect(await code(() => store.deletePeer("peer:empty"))).toBe("peer-absent");
    await holds(b, bystander);
    expect((await store.openAdmin().fsck()).faults).toEqual([]);

    const last = await store.deletePeer("peer:b");
    expect([last.claim, last.released, last.keptByOtherPeers]).toEqual([claim, 2, 0]);
    const admin = store.openAdmin();
    expect([await listed(admin.peers()), await listed(admin.storedIds())]).toEqual([[], []]);
    expect((await admin.fsck()).faults).toEqual([]);

    for (const bad of ["", 7, null, "a\uD800"] as unknown[])
      expect(await code(() => store.deletePeer(bad as string))).toBe("invalid-request");
    await store.close();
    expect(await code(() => store.deletePeer(""))).toBe("store-closed");
  });

  it("a handle checks store-closed, then the form of its request, then the peer: a deleted peer's handle and a live peer's handle answer the same code for each malformed request, and a deleted peer's handle answers peer-absent for a well-formed one; after close, every call answers store-closed; the bystander reads back", async () => {
    const store = await open();
    const a = await store.createPeer("peer:a", { erasure: posture });
    const b = await store.createPeer("peer:b", { erasure: posture });
    const bystander = facts("order-b", 2);
    await add(a, facts("order-a", 2));
    await add(b, bystander);
    const malformed = async (p: PeerStore): Promise<string[]> => [
      await code(() => p.append(7 as never)),
      await code(() => p.purge(7 as never)),
      await code(() => p.changes(-1)),
      await code(() => p.changes(3, 1)),
    ];
    const wanted = ["invalid-admission", "invalid-request", "invalid-request", "invalid-request"];
    expect(await malformed(b)).toEqual(wanted);
    await store.deletePeer("peer:a");
    expect(await malformed(a)).toEqual(wanted);
    expect([
      await code(() => a.append({ expectedHead: null, nextHead: "h", frame: null, added: [] })),
      await code(() => a.purge([])),
      await code(() => a.changes(0)),
      await code(() => a.changes(0, 1)),
    ]).toEqual(Array(4).fill("peer-absent"));
    await holds(b, bystander);
    await store.close();
    expect(await malformed(a)).toEqual(Array(4).fill("store-closed"));
    expect(await malformed(b)).toEqual(Array(4).fill("store-closed"));
  });
});

describe("peer delete on the memory store, with a damaged holding", () => {
  it("rail 8: a held id whose row is gone throws claims-unreadable before the delete removes anything; the peer, its holdings and the bystander stay [gap: no call completes such a delete until PR #99's remedy]", async () => {
    const store = createMemoryStore();
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const target = fact("e:target");
    let companion = fact("e:companion");
    // The companion sorts first, so a delete that released in order would release it first.
    while (companion.id > target.id) companion = fact("e:companion");
    const bystander = facts("b", 2);
    await add(a, [target, companion]);
    await add(b, bystander);
    // The store's map of rows, recorded while one read runs, then the target's row is lost.
    const snapshot = await a.read();
    const real = Map.prototype.get;
    const rows: Map<unknown, unknown>[] = [];
    Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
      const value: unknown = real.call(this, key);
      if (key === target.id && typeof value === "object" && value !== null && "holders" in value)
        rows.push(this);
      return value;
    };
    let pending: Promise<unknown>;
    try {
      pending = snapshot.get([target.id]);
    } finally {
      Map.prototype.get = real;
    }
    await pending;
    expect(rows.length).toBe(1);
    rows[0]!.delete(target.id);
    const feed = await a.changes(0);

    const thrown = await store.deletePeer("peer:a").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StoreIntegrityError);
    expect((thrown as StoreIntegrityError).fault).toMatchObject({
      kind: "claims-unreadable",
      peer: "peer:a",
      id: target.id,
    });

    const now = await a.read();
    expect([now.revision, now.count]).toEqual([snapshot.revision, 2]);
    expect(await a.changes(0)).toEqual(feed);
    expect(await now.get([companion.id])).toEqual([companion]);
    expect(await listed(store.openAdmin().peers())).toEqual(["peer:a", "peer:b"]);
    await holds(b, bystander);
  });

  it("a held id whose row counts 0 holders throws count-mismatch (holders) before the delete removes anything; the peer, its holdings, feed and fsck faults and the bystander stay", async () => {
    const store = createMemoryStore();
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const target = fact("e:target");
    let companion = fact("e:companion");
    // The companion sorts first, so a delete that released in order would release it first.
    while (companion.id > target.id) companion = fact("e:companion");
    const bystander = facts("b", 2);
    await add(a, [target, companion]);
    await add(b, bystander);
    // The target's row, recorded while one read runs, then its count of holders is set to 0.
    const snapshot = await a.read();
    const real = Map.prototype.get;
    const rows: { holders: number }[] = [];
    Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
      const value: unknown = real.call(this, key);
      if (key === target.id && typeof value === "object" && value !== null && "holders" in value)
        rows.push(value as { holders: number });
      return value;
    };
    let pending: Promise<unknown>;
    try {
      pending = snapshot.get([target.id]);
    } finally {
      Map.prototype.get = real;
    }
    await pending;
    expect(rows.length).toBe(1);
    rows[0]!.holders = 0;
    const feed = await a.changes(0);
    const otherFeed = await b.changes(0);
    const faults = (await store.openAdmin().fsck()).faults;
    expect(faults.map(({ kind, key, id }) => ({ kind, key, id }))).toEqual([
      { kind: "count-mismatch", key: "holders", id: target.id },
    ]);

    const thrown = await store.deletePeer("peer:a").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StoreIntegrityError);
    const { kind, peer, id, key, detail } = (thrown as StoreIntegrityError).fault;
    expect({ kind, peer, id, key, detail }).toEqual({
      kind: "count-mismatch",
      peer: "peer:a",
      id: target.id,
      key: "holders",
      detail: "memory store: the row counts 0 holders and this peer holds it",
    });

    const now = await a.read();
    expect([now.revision, now.count, now.root]).toEqual([
      snapshot.revision,
      2,
      digestOf(ids([target, companion])).hash,
    ]);
    expect(await now.get(ids([target, companion]))).toEqual(
      [target, companion].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    expect(await now.targets(["e:target", "e:companion"])).toEqual(ids([target, companion]));
    expect(await a.changes(0)).toEqual(feed);
    expect(await b.changes(0)).toEqual(otherFeed);
    expect(await listed(store.openAdmin().peers())).toEqual(["peer:a", "peer:b"]);
    await holds(b, bystander);
    expect((await store.openAdmin().fsck()).faults).toEqual(faults);
  });

  it("[gap: a row that counts fewer holders than hold it] fsck reports count-mismatch (holders) before the call; a delete of one holder answers, counts the id as not kept, removes the row, and the other holder's get throws claims-unreadable", async () => {
    const store = createMemoryStore();
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const shared = fact("e:shared");
    const bystander = facts("gap", 2);
    await add(a, [shared]);
    await add(b, [shared, ...bystander]);
    // The shared row, recorded while one read runs, then its count of holders is set from 2 to 1.
    const snapshot = await a.read();
    const real = Map.prototype.get;
    const rows: { holders: number }[] = [];
    Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
      const value: unknown = real.call(this, key);
      if (key === shared.id && typeof value === "object" && value !== null && "holders" in value)
        rows.push(value as { holders: number });
      return value;
    };
    let pending: Promise<unknown>;
    try {
      pending = snapshot.get([shared.id]);
    } finally {
      Map.prototype.get = real;
    }
    await pending;
    snapshot.release();
    expect(rows.map((row) => row.holders)).toEqual([2]);
    rows[0]!.holders = 1;
    const faults = (await store.openAdmin().fsck()).faults;
    expect(faults.map(({ kind, key, id }) => ({ kind, key, id }))).toEqual([
      { kind: "count-mismatch", key: "holders", id: shared.id },
    ]);

    const report = await store.deletePeer("peer:a");
    expect([report.released, report.keptByOtherPeers]).toEqual([1, 0]);
    expect(report.surfaces.find(({ surface }) => surface === "rows")?.state).toBe("absent");

    expect(await listed(store.openAdmin().storedIds())).toEqual(ids(bystander));
    const now = await b.read();
    expect(now.count).toBe(3);
    const thrown = await now.get([shared.id]).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StoreIntegrityError);
    const { kind, peer, id } = (thrown as StoreIntegrityError).fault;
    expect({ kind, peer, id }).toEqual({
      kind: "claims-unreadable",
      peer: "peer:b",
      id: shared.id,
    });
    expect(await now.get(ids(bystander))).toEqual(
      [...bystander].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    now.release();
  });
});
