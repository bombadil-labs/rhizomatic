// The admission surface (SPEC-18 proposal §4.13 readings 133 and 134), on the memory store and the
// SQLite store through one suite: `admissionOf` builds an append from a snapshot, and a peer keeps
// the application format string it was created with. The processes are in
// sqlite-store-processes.test.ts.

import Database from "better-sqlite3";
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
    const built = admissionOf(await peer.read(), [high, low, high], options());
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
        transfer: 1,
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
      lastTransfer: 0,
      get: () => (touched.push("get"), Promise.resolve([])),
      arrivals: () => (touched.push("arrivals"), Promise.resolve([])),
    } as unknown as Snapshot;
    const x = fact("x");
    const forged = { ...x, claims: { ...x.claims, timestamp: x.claims.timestamp + 1 } };
    const at = (over: Partial<Pick<Snapshot, "head" | "lastSequence" | "lastTransfer">>) => ({
      head: null,
      lastSequence: 0,
      lastTransfer: 0,
      ...over,
    });
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
      "sender a lone surrogate": () => admissionOf(snapshot, [x], options({ sender: "\udc00" })),
      "options a class instance": () =>
        admissionOf(snapshot, [x], Object.assign(new (class Options {})(), options()) as never),
      "a forged delta": () => admissionOf(snapshot, [forged], options()),
      "a forged repeat of a delta": () => admissionOf(snapshot, [x, forged], options()),
      "a malformed signature": () => admissionOf(snapshot, [{ ...x, sig: "AB" }], options()),
      "deltas not a list": () => admissionOf(snapshot, x as never, options()),
      "a delta without an id": () =>
        admissionOf(snapshot, [{ claims: x.claims } as never], options()),
      "a delta that is null": () => admissionOf(snapshot, [null as never], options()),
      "lastSequence negative": () => admissionOf(at({ lastSequence: -1 }), [x], options()),
      "lastSequence a fraction": () => admissionOf(at({ lastSequence: 1.5 }), [x], options()),
      "lastTransfer negative": () => admissionOf(at({ lastTransfer: -1 }), [x], options()),
      "lastTransfer a fraction": () => admissionOf(at({ lastTransfer: 1.5 }), [x], options()),
      "lastTransfer absent": () =>
        admissionOf({ head: null, lastSequence: 0 } as never, [x], options()),
      "a head that is empty": () => admissionOf(at({ head: "" }), [x], options()),
      "a head with a lone surrogate": () => admissionOf(at({ head: "h\ud800" }), [x], options()),
      "sequences past 2^53 - 1": () =>
        admissionOf(at({ lastSequence: Number.MAX_SAFE_INTEGER }), [x], options()),
      "a transfer past 2^53 - 1": () =>
        admissionOf(at({ lastTransfer: Number.MAX_SAFE_INTEGER }), [x], options()),
    };
    for (const [name, call] of Object.entries(cases))
      expect([name, codeOf(call)]).toEqual([name, "invalid-request"]);
    expect(touched).toEqual([]);
    expect(codeOf(() => admissionOf(snapshot, [x], options()))).toBe("built");
    expect(
      codeOf(() => admissionOf(at({ lastTransfer: Number.MAX_SAFE_INTEGER }), [], options())),
    ).toBe("built");
  });
});

describe("what admissionOf builds, before any store", () => {
  const snapshot = { head: "h", lastSequence: 4, lastTransfer: 9 };

  it("numbers the transfer lastTransfer + 1 for every entry, and passes sender and at through", () => {
    const [a, b] = [fact("a"), fact("b")];
    const built = admissionOf(snapshot, [a, b], options({ sender: "peer:sender", at: 33.5 }));
    expect(built.added.map((m) => [m.arrival.transfer, m.arrival.sender, m.arrival.at])).toEqual([
      [10, "peer:sender", 33.5],
      [10, "peer:sender", 33.5],
    ]);
  });

  it("an at of -0 is +0 in every arrival record", () => {
    const built = admissionOf(snapshot, [fact("a")], options({ at: -0 }));
    expect(Object.is(built.added[0]!.arrival.at, 0)).toBe(true);
  });

  it("of a repeated id it keeps the first entry, also when the repeat carries another signature", () => {
    const x = fact("x");
    const first = { ...x, sig: "a".repeat(128) };
    const second = { ...x, sig: "b".repeat(128) };
    const built = admissionOf(snapshot, [first, second], options());
    expect(built.added.map((m) => m.delta)).toEqual([first]);
  });

  it("keeps its own copy: a later change to a delta or to the options changes nothing built", () => {
    const x = fact("x");
    const given = { ...x, claims: { ...x.claims, pointers: [...x.claims.pointers] } };
    const asked = options();
    const built = admissionOf(snapshot, [given], asked);
    (given.claims.pointers as unknown[]).length = 0;
    (given as { id: string }).id = "changed";
    (asked as { nextHead: string }).nextHead = "changed";
    expect(built.added[0]!.delta).toEqual(x);
    expect(built.nextHead).not.toBe("changed");
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

const entry = (delta: Delta, sequence: number, transfer: number) => ({
  delta,
  arrival: { id: delta.id, at: 1, sequence, transfer, sender: "local" },
});

// The snapshot rail opens the SQLite store with no audit wrapper: the wrapper copies
// `lastTransfer` when it wraps a snapshot, so a live value would pass through it unseen.
const UNWRAPPED: typeof STORES = [
  ["the memory store", async () => createMemoryStore()],
  ["the SQLite store", () => fixture.open()],
];

describe.each(UNWRAPPED)(
  "the transfer ordinal of a snapshot on %s (§4.13 reading 135)",
  (_, open) => {
    it("lastTransfer is 0 on a new peer, is the committed transfer after each append, is fixed on a snapshot, and stays after a head-only append and a purge", async () => {
      const store = await open();
      const peer = await store.createPeer("peer:p", { erasure: "unproven" });
      const first = await peer.read();
      expect(first.lastTransfer).toBe(0);
      await peer.append(admissionOf(first, [fact("x"), sacrificial(1)], options()));
      const second = await peer.read();
      expect(second.lastTransfer).toBe(1);
      await peer.append(admissionOf(second, [fact("y")], options()));
      expect([first.lastTransfer, second.lastTransfer]).toEqual([0, 1]);
      const third = await peer.read();
      expect(third.lastTransfer).toBe(2);
      await peer.append(admissionOf(third, [], options()));
      await moveByPurge(peer);
      const last = await peer.read();
      expect([last.lastTransfer, last.head === third.head]).toEqual([2, false]);
      expect(
        (await last.arrivals(await last.targets(["x", "y"]))).map((a) => a.transfer).sort(),
      ).toEqual([1, 2]);
    });
  },
);

describe.each(STORES)("the transfer ordinal on %s (§4.13 reading 135)", (_, open) => {
  it("a held entry with a higher transfer is skipped and does not raise the last transfer", async () => {
    const store = await open();
    const peer = await store.createPeer("peer:p", { erasure: "unproven" });
    const [x, y] = [fact("x"), fact("y")];
    await peer.append({ expectedHead: null, nextHead: "h1", frame: null, added: [entry(x, 1, 1)] });
    expect(
      await peer.append({
        expectedHead: "h1",
        nextHead: "h2",
        frame: null,
        added: [entry(x, 2, 50), entry(y, 3, 2)],
      }),
    ).toMatchObject({ status: "committed", added: [y.id] });
    const now = await peer.read();
    expect([now.lastTransfer, (await now.arrivals([x.id]))[0]!.transfer]).toEqual([2, 1]);
  });

  it("refuses invalid-admission a new entry whose transfer does not pass the peer's last one, and changes nothing; a held entry's transfer is not compared; the last is the largest of an append", async () => {
    const store = await open();
    const peer = await store.createPeer("peer:p", { erasure: "unproven" });
    const [x, y, z] = [fact("x"), fact("y"), fact("z")];
    expect(
      await peer.append({
        expectedHead: null,
        nextHead: "h1",
        frame: null,
        added: [entry(x, 1, 7), entry(y, 2, 3)],
      }),
    ).toMatchObject({ status: "committed" });
    const before = await peer.read();
    expect(before.lastTransfer).toBe(7);
    for (const transfer of [3, 7]) {
      const asked = {
        expectedHead: "h1",
        nextHead: "h2",
        frame: null,
        added: [entry(z, 3, transfer)],
      };
      expect([transfer, await refusal(peer.append(asked))]).toEqual([
        transfer,
        "invalid-admission",
      ]);
    }
    const now = await peer.read();
    expect([now.revision, now.head, now.lastTransfer, now.lastSequence]).toEqual([
      before.revision,
      "h1",
      7,
      2,
    ]);
    expect(await now.get([z.id])).toEqual([]);
    expect(
      await peer.append({
        expectedHead: "h1",
        nextHead: "h2",
        frame: null,
        added: [entry(x, 3, 1), entry(z, 4, 8)],
      }),
    ).toMatchObject({ status: "committed", added: [z.id] });
    expect((await peer.read()).lastTransfer).toBe(8);
  });
});

describe("a closed store's handle", () => {
  it.each(STORES.map(([name]) => name))(
    "on %s, history and appFormat refuse store-closed",
    async (name) => {
      const store = name === "the memory store" ? createMemoryStore() : await fixture.open();
      const peer = await store.createPeer("peer:p", { erasure: "unproven", appFormat: "host/1" });
      expect([peer.history.length > 0, peer.appFormat]).toEqual([true, "host/1"]);
      await store.close();
      const code = (read: () => unknown): string => {
        try {
          read();
          return "answered";
        } catch (error) {
          return error instanceof StoreError ? error.code : String(error);
        }
      };
      expect([code(() => peer.history), code(() => peer.appFormat)]).toEqual([
        "store-closed",
        "store-closed",
      ]);
    },
  );
});

describe("the order of createPeer's refusals", () => {
  it("a bad appFormat with a proven posture is refused invalid-request on the memory store, whose class refuses proven", async () => {
    const store = createMemoryStore();
    expect(await refusal(store.createPeer("peer:p", { erasure: "proven" }))).toBe(
      "posture-refused",
    );
    expect(await refusal(store.createPeer("peer:p", { erasure: "proven", appFormat: "" }))).toBe(
      "invalid-request",
    );
  });
});

describe("the application format string in the file", () => {
  it("a handle reads the peer row at each ask: a change to the row is seen by an open handle", async () => {
    const path = fixture.path();
    const store = await openSqliteStore(path);
    const peer = await store.createPeer("peer:p", { erasure: "unproven", appFormat: "host/1" });
    expect(peer.appFormat).toBe("host/1");
    const db = new Database(path);
    db.prepare("UPDATE peer SET app_format = 'host/2' WHERE id = 'peer:p'").run();
    db.close();
    expect(peer.appFormat).toBe("host/2");
    await store.close();
  });

  it("the file refuses a value outside 1 to 256 UTF-8 bytes by its own check, and keeps one inside", async () => {
    const path = fixture.path();
    const store = await openSqliteStore(path);
    await store.createPeer("peer:p", { erasure: "unproven", appFormat: "host/1" });
    await store.close();
    const db = new Database(path);
    const put = db.prepare("UPDATE peer SET app_format = ? WHERE id = 'peer:p'");
    const answer = (value: string | null): string => {
      try {
        put.run(value);
        return "kept";
      } catch (error) {
        return (error as { code?: string }).code ?? String(error);
      }
    };
    expect(
      ["", "x".repeat(257), "é".repeat(129), "é".repeat(128), null].map((v) => answer(v)),
    ).toEqual([
      "SQLITE_CONSTRAINT_CHECK",
      "SQLITE_CONSTRAINT_CHECK",
      "SQLITE_CONSTRAINT_CHECK",
      "kept",
      "kept",
    ]);
    db.close();
  });
});
