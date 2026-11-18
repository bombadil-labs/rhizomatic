// The memory store decides a purge from the peers its row names as holders (SPEC-18 proposal §4.13
// reading 136). Each damage rail is two-sided: what the purge answers, and what the store reads
// after it, for the purging peer and for a bystander peer. The memory store's rows cannot be
// reached by a call, so a test-only watch on `Map.prototype.get` records the row of one id while
// one read runs, and the test changes it. The last rail runs random sequences on an undamaged
// memory store and on a SQLite store in a new temporary directory, and compares their answers.

import { afterAll, describe, expect, it } from "vitest";
import { makeDelta } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { admissionOf } from "../src/storage/admission.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import {
  StoreIntegrityError,
  type IntegrityFault,
  type PeerStore,
  type Store,
} from "../src/storage/store.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const fixture = sqliteFixture("rhizomatic-memory-holders");
afterAll(async () => {
  await fixture.cleanup();
});

const AUTHOR = `ed25519:${"4d".repeat(32)}`;
let stamp = 0;
const fact = (entity: string): Delta =>
  makeDelta({
    timestamp: ++stamp,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "about", target: { kind: "entity", entity: { id: entity } } }],
  });

let heads = 0;
async function add(peer: PeerStore, deltas: readonly Delta[], head?: string): Promise<void> {
  const now = await peer.read();
  const nextHead = head ?? `head-${++heads}`;
  const result = await peer.append(admissionOf(now, deltas, { at: 1, sender: "local", nextHead }));
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
}

/** The memory store's row of `id`: its holders by peer, recorded while one `get` runs. */
async function holdersOf(peer: PeerStore, id: string): Promise<Map<string, number>> {
  const snapshot = await peer.read();
  const real = Map.prototype.get;
  const rows: Map<string, number>[] = [];
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    const value: unknown = real.call(this, key);
    if (key === id && typeof value === "object" && value !== null && "holders" in value)
      rows.push((value as { holders: Map<string, number> }).holders);
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
  return rows[0]!;
}

const place = ({ kind, peer, id, key }: IntegrityFault) => ({ kind, peer, id, key });
const faultsOf = async (store: Store) => (await store.openAdmin().fsck()).faults;
async function storedIds(store: Store): Promise<string[]> {
  const ids: string[] = [];
  for await (const id of store.openAdmin().storedIds()) ids.push(id);
  return ids;
}

/** Peers A and B both hold `x`. A also holds `a`, and B also holds `b`. `fsck` finds nothing. */
async function shared() {
  const store = createMemoryStore();
  const a = await store.createPeer("peer:a", { erasure: "unproven" });
  const b = await store.createPeer("peer:b", { erasure: "unproven" });
  const x = fact("e:x");
  const onlyA = fact("e:a");
  const onlyB = fact("e:b");
  await add(a, [x, onlyA]);
  await add(b, [x, onlyB]);
  expect(await faultsOf(store)).toEqual([]);
  return { store, a, b, x, onlyA, onlyB };
}

describe("a memory purge reads who holds the id from the row", () => {
  it("peers A and B hold x and the row does not name A: A's purge of x throws count-mismatch (holders), removes nothing, and both peers read as before", async () => {
    const { store, a, b, x, onlyA, onlyB } = await shared();
    (await holdersOf(a, x.id)).delete("peer:a");
    const before = {
      a: await a.read(),
      b: await b.read(),
      feedA: await a.changes(0),
      feedB: await b.changes(0),
      faults: await faultsOf(store),
    };
    expect(before.faults.map(place)).toEqual([
      { kind: "count-mismatch", peer: undefined, id: x.id, key: "holders" },
    ]);
    expect(before.faults[0]!.detail).toBe(
      "memory store: the row names the holders [peer:b] and the peers [peer:a, peer:b] hold it",
    );

    const answer = await a.purge([x.id]).then(
      (report) => report,
      (error: unknown) => error,
    );

    expect(answer).toBeInstanceOf(StoreIntegrityError);
    const fault = (answer as StoreIntegrityError).fault;
    expect({ ...place(fault), detail: fault.detail }).toEqual({
      kind: "count-mismatch",
      peer: "peer:a",
      id: x.id,
      key: "holders",
      detail: "memory store: the row counts this peer 0 times as a holder and this peer holds it",
    });
    const nowA = await a.read();
    const nowB = await b.read();
    expect([nowA.revision, nowA.count]).toEqual([before.a.revision, 2]);
    expect([nowB.revision, nowB.count]).toEqual([before.b.revision, 2]);
    expect(await a.changes(0)).toEqual(before.feedA);
    expect(await b.changes(0)).toEqual(before.feedB);
    expect(await nowB.get([x.id, onlyB.id])).toEqual(
      [x, onlyB].sort((p, q) => (p.id < q.id ? -1 : 1)),
    );
    expect(await nowA.get([x.id, onlyA.id])).toEqual(
      [x, onlyA].sort((p, q) => (p.id < q.id ? -1 : 1)),
    );
    expect(await nowB.targets(["e:x"])).toEqual([x.id]);
    expect(await faultsOf(store)).toEqual(before.faults);
  });

  it("peer A alone holds x and the row counts A twice: A's purge of x throws count-mismatch (holders) and removes nothing", async () => {
    const store = createMemoryStore();
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const x = fact("e:x");
    const onlyB = fact("e:b");
    await add(a, [x]);
    await add(b, [onlyB]);
    (await holdersOf(a, x.id)).set("peer:a", 2);
    const faults = await faultsOf(store);
    expect(faults.map((f) => [f.kind, f.id, f.detail])).toEqual([
      [
        "count-mismatch",
        x.id,
        "memory store: the row names the holders [peer:a (2)] and the peers [peer:a] hold it",
      ],
    ]);
    const before = await a.read();

    const answer = await a.purge([x.id]).then(
      (report) => report,
      (error: unknown) => error,
    );

    expect(answer).toBeInstanceOf(StoreIntegrityError);
    const fault = (answer as StoreIntegrityError).fault;
    expect({ ...place(fault), detail: fault.detail }).toEqual({
      kind: "count-mismatch",
      peer: "peer:a",
      id: x.id,
      key: "holders",
      detail: "memory store: the row counts this peer 2 times as a holder and this peer holds it",
    });
    const now = await a.read();
    expect([now.revision, now.count]).toEqual([before.revision, 1]);
    expect(await now.get([x.id])).toEqual([x]);
    expect(await (await b.read()).get([onlyB.id])).toEqual([onlyB]);
    expect(await faultsOf(store)).toEqual(faults);
  });

  it("[gap: a row that does not name another holder is removed by the last named holder's purge; no O(1) check sees it, and fsck names it before] peers A and B hold x and the row does not name B: A's purge removes x, B's get then throws claims-unreadable, and the other ids read", async () => {
    const { store, a, b, x, onlyA, onlyB } = await shared();
    (await holdersOf(a, x.id)).delete("peer:b");
    const faults = await faultsOf(store);
    expect(faults.map(place)).toEqual([
      { kind: "count-mismatch", peer: undefined, id: x.id, key: "holders" },
    ]);
    expect(faults[0]!.detail).toBe(
      "memory store: the row names the holders [peer:a] and the peers [peer:a, peer:b] hold it",
    );
    const revisionB = (await b.read()).revision;

    const report = await a.purge([x.id]);

    expect([report.claim, report.targets, report.retains]).toEqual([
      "unproven",
      [{ id: x.id, outcome: "removed" }],
      [{ surface: "change-feed", holds: "id" }],
    ]);
    const nowB = await b.read();
    expect(nowB.revision).toBe(revisionB);
    const thrown = await nowB.get([x.id]).then(
      () => undefined,
      (error: unknown) => (error instanceof StoreIntegrityError ? place(error.fault) : error),
    );
    expect(thrown).toEqual({ kind: "claims-unreadable", peer: "peer:b", id: x.id, key: undefined });
    expect(await nowB.get([onlyB.id])).toEqual([onlyB]);
    expect(await (await a.read()).get([x.id, onlyA.id])).toEqual([onlyA]);
    expect((await faultsOf(store)).map(place)).toEqual([
      { kind: "claims-unreadable", peer: "peer:b", id: x.id, key: undefined },
      { kind: "index-stray", peer: "peer:b", id: x.id, key: "e:x" },
    ]);
  });

  it("[gap: a row that names a peer that does not hold the id makes the purge report held-by-other-peer; the row stays] peer A alone holds x and the row also names B: A's purge keeps the row and owes it, and fsck names the row", async () => {
    const store = createMemoryStore();
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const x = fact("e:x");
    const onlyB = fact("e:b");
    await add(a, [x]);
    await add(b, [onlyB]);
    (await holdersOf(a, x.id)).set("peer:b", 1);
    const faults = await faultsOf(store);
    expect(faults.map(place)).toEqual([
      { kind: "count-mismatch", peer: undefined, id: x.id, key: "holders" },
    ]);
    expect(faults[0]!.detail).toBe(
      "memory store: the row names the holders [peer:a, peer:b] and the peers [peer:a] hold it",
    );

    const report = await a.purge([x.id]);

    expect([report.claim, report.targets, report.retains]).toEqual([
      "nothing-removed",
      [{ id: x.id, outcome: "held-by-other-peer" }],
      [
        { surface: "change-feed", holds: "id" },
        { surface: "purge-debt", holds: "id" },
      ],
    ]);
    expect(await storedIds(store)).toContain(x.id);
    const now = await a.read();
    expect([now.count, await now.get([x.id])]).toEqual([0, []]);
    expect(await (await b.read()).get([x.id, onlyB.id])).toEqual([onlyB]);
    expect((await faultsOf(store)).map((f) => [f.kind, f.id, f.detail])).toEqual([
      ["orphan-bytes", x.id, "memory store: no peer holds these bytes"],
    ]);
  });

  it("peer B holds x and the row names only A once: after A appends x, A's purge of x throws count-mismatch (holders) with A counted 2 times, removes nothing, and B still reads x", async () => {
    const store = createMemoryStore();
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const x = fact("e:x");
    const onlyA = fact("e:a");
    const onlyB = fact("e:b");
    await add(a, [onlyA]);
    await add(b, [x, onlyB]);
    const row = await holdersOf(b, x.id);
    row.clear();
    row.set("peer:a", 1);
    await add(a, [x]);
    const before = {
      a: await a.read(),
      b: await b.read(),
      feedA: await a.changes(0),
      feedB: await b.changes(0),
    };

    const answer = await a.purge([x.id]).then(
      (report) => report,
      (error: unknown) => error,
    );

    const nowB = await b.read();
    const readX = await nowB.get([x.id]).then(
      (deltas) => deltas,
      (error: unknown) => (error instanceof StoreIntegrityError ? place(error.fault) : error),
    );
    expect(
      readX,
      `B reads x after A's purge; the purge answered ${JSON.stringify(answer)}`,
    ).toEqual([x]);
    expect(answer).toBeInstanceOf(StoreIntegrityError);
    const fault = (answer as StoreIntegrityError).fault;
    expect({ ...place(fault), detail: fault.detail }).toEqual({
      kind: "count-mismatch",
      peer: "peer:a",
      id: x.id,
      key: "holders",
      detail: "memory store: the row counts this peer 2 times as a holder and this peer holds it",
    });
    expect(await storedIds(store)).toContain(x.id);
    const nowA = await a.read();
    expect([nowA.revision, nowA.count]).toEqual([before.a.revision, 2]);
    expect([nowB.revision, nowB.count]).toEqual([before.b.revision, 2]);
    expect(await a.changes(0)).toEqual(before.feedA);
    expect(await b.changes(0)).toEqual(before.feedB);
    expect(await nowA.get([onlyA.id])).toEqual([onlyA]);
    expect(await nowB.get([onlyB.id])).toEqual([onlyB]);
    const faults = await faultsOf(store);
    expect(faults.map((f) => [f.kind, f.id, f.key, f.detail])).toEqual([
      [
        "count-mismatch",
        x.id,
        "holders",
        "memory store: the row names the holders [peer:a (2)] and the peers [peer:a, peer:b] hold it",
      ],
    ]);
  });

  it("[gap: a row that names a holder with a zero count] peer A alone holds x and the row also names B with a count of 0: fsck names the row, and A's purge keeps the row and owes it", async () => {
    const store = createMemoryStore();
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const x = fact("e:x");
    const onlyB = fact("e:b");
    await add(a, [x]);
    await add(b, [onlyB]);
    (await holdersOf(a, x.id)).set("peer:b", 0);
    const faults = await faultsOf(store);
    expect(faults.map((f) => [f.kind, f.id, f.key, f.detail])).toEqual([
      [
        "count-mismatch",
        x.id,
        "holders",
        "memory store: the row names the holders [peer:a, peer:b (0)] and the peers [peer:a] hold it",
      ],
    ]);

    const report = await a.purge([x.id]);

    expect([report.claim, report.targets, report.retains]).toEqual([
      "nothing-removed",
      [{ id: x.id, outcome: "held-by-other-peer" }],
      [
        { surface: "change-feed", holds: "id" },
        { surface: "purge-debt", holds: "id" },
      ],
    ]);
    expect(await storedIds(store)).toContain(x.id);
    const now = await a.read();
    expect([now.count, await now.get([x.id])]).toEqual([0, []]);
    expect(await (await b.read()).get([x.id, onlyB.id])).toEqual([onlyB]);
    expect((await faultsOf(store)).map((f) => [f.kind, f.id, f.detail])).toEqual([
      ["orphan-bytes", x.id, "memory store: no peer holds these bytes"],
    ]);
  });
});

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs one seeded sequence of 24 steps on a memory store, and on a SQLite store too when `parity`
 * is set. After every step `fsck` of the memory store is clean, and each answer and each peer's
 * revision, count and held deltas equal the SQLite store's. Answers what the purges reported.
 */
async function sequence(seed: number, parity: boolean): Promise<string[]> {
  const pool = Array.from({ length: 6 }, (_, i) => fact(`e:${i % 3}`));
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const stores: Store[] = [createMemoryStore(), ...(parity ? [await fixture.open()] : [])];
  const peers: PeerStore[][] = [];
  for (const id of ["peer:a", "peer:b", "peer:c"]) {
    const twins: PeerStore[] = [];
    for (const store of stores) twins.push(await store.createPeer(id, { erasure: "unproven" }));
    peers.push(twins);
  }
  const seen: string[] = [];
  for (let step = 0; step < 24; step++) {
    const where = `seed ${seed} step ${step}`;
    const twins = pick(peers);
    const roll = next();
    const answers: unknown[] = [];
    if (roll < 0.55) {
      const deltas = roll < 0.45 ? pool.filter(() => next() < 0.4) : [];
      for (const peer of twins) {
        const now = await peer.read();
        const nextHead = deltas.length > 0 ? `head-${step}` : (now.head ?? "head-0");
        answers.push(
          await peer.append(admissionOf(now, deltas, { at: 1, sender: "local", nextHead })),
        );
      }
    } else {
      const ids = pool.filter(() => next() < 0.4).map((d) => d.id);
      for (const peer of twins) {
        const { targets, retains, revision } = await peer.purge(ids);
        answers.push({ targets, retains, revision });
        if (peer === twins[0]) {
          seen.push(...targets.map((t) => t.outcome));
          seen.push(...retains.map((r) => r.surface));
        }
      }
    }
    expect(await faultsOf(stores[0]!), where).toEqual([]);
    if (!parity) continue;
    expect(answers[0], where).toEqual(answers[1]);
    for (const [m, s] of peers) {
      const [mr, sr] = [await m!.read(), await s!.read()];
      const all = pool.map((d) => d.id);
      expect([mr.revision, mr.count, await mr.get(all)], where).toEqual([
        sr.revision,
        sr.count,
        await sr.get(all),
      ]);
    }
  }
  for (const store of stores) await store.close();
  return seen;
}

describe("an undamaged memory store", () => {
  it("over 300 seeded random sequences of append, head-only append and purge by 3 peers with shared ids: fsck is clean after every step, no purge throws, and the purges report each outcome and purge-debt", async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 300; seed++)
      for (const s of await sequence(seed, false)) seen.add(s);
    expect([...seen].sort()).toEqual(
      ["change-feed", "held-by-other-peer", "not-held", "purge-debt", "removed"].sort(),
    );
  });

  it("over 40 seeded random sequences, every answer, revision, count and held delta equals the SQLite store's", async () => {
    for (let seed = 1; seed <= 40; seed++) await sequence(seed, true);
  }, 60_000);
});
