// The admission surface (SPEC-18 proposal §4.13 readings 133 and 134), on the memory store and the
// SQLite store through one suite: `admissionOf` builds an append from a snapshot, and a peer keeps
// the application format string it was created with. The processes are in
// sqlite-store-processes.test.ts.

import { afterAll, describe, expect, it } from "vitest";
import { makeDelta } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { admissionOf, type AdmissionOptions } from "../src/storage/admission.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { openSqliteStore } from "../src/storage/sqlite-store.js";
import { StoreError, type Snapshot, type Store } from "../src/storage/store.js";
import { moveByPurge, sacrificial } from "./support/move-snapshot.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const fixture = sqliteFixture("rhizomatic-admission-of");
afterAll(() => fixture.cleanup());

const STORES: readonly (readonly [string, () => Promise<Store>])[] = [
  ["the memory store", async () => createMemoryStore()],
  ["the SQLite store", () => fixture.audited()],
];

const AUTHOR = `ed25519:${"ad".repeat(32)}`;
let stamp = 0;
const fact = (entity: string): Delta =>
  makeDelta({
    timestamp: ++stamp,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "about", target: { kind: "entity", entity: { id: entity } } }],
  });

let heads = 0;
const options = (over: Partial<AdmissionOptions> = {}): AdmissionOptions => ({
  at: 10,
  sender: "local",
  transfer: 1,
  nextHead: `head-${++heads}`,
  ...over,
});

const codeOf = (call: () => unknown): string => {
  try {
    call();
    return "built";
  } catch (error) {
    return error instanceof StoreError ? error.code : `not a StoreError: ${String(error)}`;
  }
};
const refusal = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "answered",
    (error: unknown) =>
      error instanceof StoreError ? error.code : `not a StoreError: ${String(error)}`,
  );

describe.each(STORES)("admissionOf on %s", (_, open) => {
  it("after a purge, an admission built by the helper commits at lastSequence + 1, and the count + 1 guess is refused invalid-admission", async () => {
    const store = await open();
    const peer = await store.createPeer("peer:p", { erasure: "unproven" });
    const kept = fact("x");
    const first = admissionOf(await peer.read(), [kept, sacrificial(1)], options());
    expect(await peer.append(first)).toMatchObject({ status: "committed" });
    await moveByPurge(peer);
    const after = await peer.read();
    expect([after.count, after.lastSequence]).toEqual([1, 2]);
    const next = fact("x");
    const built = admissionOf(after, [next], options());
    const guess = {
      ...built,
      added: built.added.map((m) => ({
        ...m,
        arrival: { ...m.arrival, sequence: after.count + 1 },
      })),
    };
    expect(await refusal(peer.append(guess))).toBe("invalid-admission");
    expect(await peer.append(built)).toEqual({
      status: "committed",
      revision: after.revision + 1,
      added: [next.id],
    });
    const now = await peer.read();
    expect(await now.get([next.id])).toEqual([next]);
    expect((await now.arrivals([next.id])).map((a) => a.sequence)).toEqual([3]);
    expect([now.count, now.lastSequence, now.head]).toEqual([2, 3, built.nextHead]);
  });

  it("gives two ids their sequences in ascending id order, whatever the order given, with one record per id", async () => {
    const store = await open();
    const peer = await store.createPeer("peer:p", { erasure: "unproven" });
    const [low, high] = [fact("a"), fact("b")].sort((p, q) => (p.id < q.id ? -1 : 1)) as [
      Delta,
      Delta,
    ];
    const built = admissionOf(await peer.read(), [high, low, high], options({ transfer: 7 }));
    expect([built.expectedHead, built.frame]).toEqual([null, null]);
    expect(built.added.map((m) => [m.delta.id, m.arrival.sequence])).toEqual([
      [low.id, 1],
      [high.id, 2],
    ]);
    expect(await peer.append(built)).toMatchObject({ status: "committed" });
    expect(await (await peer.read()).arrivals([low.id, high.id])).toEqual(
      [low, high].map((d, i) => ({
        id: d.id,
        at: 10,
        sequence: i + 1,
        transfer: 7,
        sender: "local",
      })),
    );
  });

  it("an admission built on a snapshot whose head another append replaced answers conflict, and changes nothing", async () => {
    const store = await open();
    const peer = await store.createPeer("peer:p", { erasure: "unproven" });
    await peer.append(admissionOf(await peer.read(), [fact("x")], options()));
    const stale = await peer.read();
    await peer.append(admissionOf(stale, [fact("x")], options()));
    const before = await peer.read();
    const late = fact("y");
    expect(await peer.append(admissionOf(stale, [late], options()))).toEqual({
      status: "conflict",
    });
    const now = await peer.read();
    expect([now.revision, now.count, now.lastSequence, now.head]).toEqual([
      before.revision,
      before.count,
      before.lastSequence,
      before.head,
    ]);
    expect(await now.get([late.id])).toEqual([]);
  });

  it("an empty list builds a head-only append; an id the peer holds is skipped at append and its sequence is not used", async () => {
    const store = await open();
    const peer = await store.createPeer("peer:p", { erasure: "unproven" });
    const held = fact("x");
    await peer.append(admissionOf(await peer.read(), [held], options()));
    const empty = admissionOf(await peer.read(), [], options());
    expect(empty.added).toEqual([]);
    expect(await peer.append(empty)).toMatchObject({ status: "committed", added: [] });
    expect((await peer.read()).head).toBe(empty.nextHead);
    const fresh = fact("y");
    const both = admissionOf(await peer.read(), [held, fresh], options());
    expect(await peer.append(both)).toMatchObject({ status: "committed", added: [fresh.id] });
    const now = await peer.read();
    expect((await now.arrivals([held.id]))[0]!.sequence).toBe(1);
    expect(now.lastSequence).toBe(
      both.added.find((m) => m.delta.id === fresh.id)!.arrival.sequence,
    );
  });
});

describe("admissionOf refuses a malformed call invalid-request, before any store call", () => {
  it("refuses each bad option, a bad snapshot, a bad list and a bad delta, and reads no store", () => {
    const touched: string[] = [];
    const snapshot = {
      head: "h",
      lastSequence: 4,
      get: () => (touched.push("get"), Promise.resolve([])),
      arrivals: () => (touched.push("arrivals"), Promise.resolve([])),
    } as unknown as Snapshot;
    const x = fact("x");
    const headless: Record<string, unknown> = { ...options() };
    delete headless["nextHead"];
    const cases: Record<string, () => unknown> = {
      "options absent": () => admissionOf(snapshot, [x], undefined as never),
      "options a list": () => admissionOf(snapshot, [x], [] as never),
      "nextHead omitted": () => admissionOf(snapshot, [x], headless as never),
      "nextHead empty": () => admissionOf(snapshot, [x], options({ nextHead: "" })),
      "nextHead a lone surrogate": () =>
        admissionOf(snapshot, [x], options({ nextHead: "\ud800" })),
      "at not finite": () => admissionOf(snapshot, [x], options({ at: Number.NaN })),
      "at a string": () => admissionOf(snapshot, [x], options({ at: "1" as never })),
      "sender empty": () => admissionOf(snapshot, [x], options({ sender: "" })),
      "transfer 0": () => admissionOf(snapshot, [x], options({ transfer: 0 })),
      "transfer 1.5": () => admissionOf(snapshot, [x], options({ transfer: 1.5 })),
      "deltas not a list": () => admissionOf(snapshot, x as never, options()),
      "a delta without an id": () =>
        admissionOf(snapshot, [{ claims: x.claims } as never], options()),
      "a delta that is null": () => admissionOf(snapshot, [null as never], options()),
      "lastSequence negative": () => admissionOf({ head: null, lastSequence: -1 }, [x], options()),
      "a head that is empty": () => admissionOf({ head: "", lastSequence: 0 }, [x], options()),
      "sequences past 2^53 - 1": () =>
        admissionOf({ head: null, lastSequence: Number.MAX_SAFE_INTEGER }, [x], options()),
    };
    for (const [name, call] of Object.entries(cases))
      expect([name, codeOf(call)]).toEqual([name, "invalid-request"]);
    expect(touched).toEqual([]);
    expect(codeOf(() => admissionOf(snapshot, [x], options()))).toBe("built");
  });
});

describe.each(STORES)("the application format string on %s", (_, open) => {
  it("is read back from every handle, is null when absent, and cannot change after create", async () => {
    const store = await open();
    const peer = await store.createPeer("peer:p", { erasure: "unproven", appFormat: "loam/7" });
    const none = await store.createPeer("peer:q", { erasure: "unproven" });
    expect([peer.appFormat, none.appFormat]).toEqual(["loam/7", null]);
    for (const id of ["peer:p", "peer:q"])
      expect(
        await refusal(store.createPeer(id, { erasure: "unproven", appFormat: "loam/8" })),
      ).toBe("peer-exists");
    expect((await store.peer("peer:p")).appFormat).toBe("loam/7");
    expect((await store.peer("peer:q")).appFormat).toBeNull();
  });

  it("refuses a bad appFormat invalid-request before peer-exists, and creates nothing; 256 UTF-8 bytes is the bound", async () => {
    const store = await open();
    await store.createPeer("peer:p", { erasure: "unproven" });
    const bad: unknown[] = [null, "", 7, "\ud800", "x".repeat(257), "é".repeat(129)];
    for (const appFormat of bad)
      for (const id of ["peer:p", "peer:new"]) {
        const asked = store.createPeer(id, { erasure: "unproven", appFormat } as never);
        expect([appFormat, id, await refusal(asked)]).toEqual([appFormat, id, "invalid-request"]);
      }
    expect(await refusal(store.peer("peer:new"))).toBe("peer-absent");
    const longest = await store.createPeer("peer:long", {
      erasure: "unproven",
      appFormat: "é".repeat(128),
    });
    expect(longest.appFormat).toBe("é".repeat(128));
  });

  it("a write to a handle's appFormat throws, and no handle reads another value", async () => {
    const store = await open();
    const peer = await store.createPeer("peer:p", { erasure: "unproven", appFormat: "host/1" });
    expect(() => {
      (peer as { appFormat: string | null }).appFormat = "host/2";
    }).toThrow(TypeError);
    expect([peer.appFormat, (await store.peer("peer:p")).appFormat]).toEqual(["host/1", "host/1"]);
  });
});

describe("the application format string in a SQLite file", () => {
  it("survives a reopen", async () => {
    const path = fixture.path();
    const store = await openSqliteStore(path);
    await store.createPeer("peer:p", { erasure: "unproven", appFormat: "host/1" });
    await store.createPeer("peer:q", { erasure: "unproven" });
    await store.close();
    const again = await openSqliteStore(path);
    expect([
      (await again.peer("peer:p")).appFormat,
      (await again.peer("peer:q")).appFormat,
    ]).toEqual(["host/1", null]);
    await again.close();
  });
});
