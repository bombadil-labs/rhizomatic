// `withSnapshot` (SPEC-18 proposal §4.13, readings 127 to 129) over the memory store and the
// SQLite store, through one suite. Real movement is a purge of a sacrificial delta through the
// same peer between two calls of the body (`moveByPurge`). Refusals that a store cannot be made
// to give on demand come from a peer whose `read` the test wraps; the function has no hook.

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { makeDelta, parseTerm } from "../src/index.js";
import type { Delta } from "../src/delta/types.js";
import { fetchScope, readAnchored } from "../src/reactor/store-read.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { openSqliteStore } from "../src/storage/sqlite-store.js";
import {
  StoreError,
  StoreFaultError,
  type PeerStore,
  type Snapshot,
  type Store,
} from "../src/storage/store.js";
import { withSnapshot, type SnapshotRetry } from "../src/storage/with-snapshot.js";
import { SACRIFICIAL, moveByPurge, sacrificial } from "./support/move-snapshot.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const fixture = sqliteFixture("rhizomatic-with-snapshot");
afterAll(() => fixture.cleanup());

const STORES: readonly (readonly [string, () => Promise<Store>])[] = [
  ["the memory store", async () => createMemoryStore()],
  ["the SQLite store", () => fixture.open()],
];

const AUTHOR = `ed25519:${"0e".repeat(32)}`;
const X = "entity:x";
const Y = "entity:y";
const LEAF = parseTerm({
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
});

let stamp = 0;
const fact = (entity: string): Delta =>
  makeDelta({
    timestamp: ++stamp,
    validFrom: 0,
    author: AUTHOR,
    pointers: [{ role: "about", target: { kind: "entity", entity: { id: entity } } }],
  });

/** Sacrificial deltas each seeded peer holds: more than any test moves it. */
const SACRIFICES = 40;

/**
 * A peer with one delta at X and one at Y, then SACRIFICES sacrificial deltas; a write that
 * appends one more at each entity; and `move`, a purge of one sacrificial delta.
 */
async function seeded(open: () => Promise<Store>) {
  const store = await open();
  const peer = await store.createPeer("peer:p", { erasure: "unproven" });
  let head: string | null = null;
  let sequence = 0;
  const admit = async (deltas: readonly Delta[]): Promise<void> => {
    const next = `head-${sequence + 1}`;
    const added = deltas.map((delta) => {
      sequence += 1;
      return { delta, arrival: { id: delta.id, at: 1, sequence, transfer: 1, sender: "test" } };
    });
    const result = await peer.append({ expectedHead: head, nextHead: next, frame: null, added });
    expect(result.status).toBe("committed");
    head = next;
  };
  const write = async (...entities: string[]): Promise<void> =>
    admit(entities.map((entity) => fact(entity)));
  await write(X, Y);
  await admit(Array.from({ length: SACRIFICES }, (_, i) => sacrificial(i + 1)));
  return { store, peer, write, move: () => moveByPurge(peer) };
}

/** The peer with its `read` replaced; every other member passes through. */
function withRead(peer: PeerStore, read: () => Promise<Snapshot>): PeerStore {
  return {
    id: peer.id,
    get history() {
      return peer.history;
    },
    erasure: peer.erasure,
    read,
    append: (batch) => peer.append(batch),
    purge: (ids) => peer.purge(ids),
    changes: (from, to) => peer.changes(from, to),
  };
}

/** The peer, counting its `read` calls and keeping each snapshot it gave. */
function counted(peer: PeerStore) {
  const taken: Snapshot[] = [];
  return {
    taken,
    reads: () => taken.length,
    peer: withRead(peer, async () => {
      const snapshot = await peer.read();
      taken.push(snapshot);
      return snapshot;
    }),
  };
}

const outcome = <T>(call: Promise<T>): Promise<T | unknown> =>
  call.then(
    (value) => value,
    (error: unknown) => error,
  );
const codeOf = (error: unknown): string =>
  error instanceof StoreError ? error.code : `not a StoreError: ${String(error)}`;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

for (const [name, open] of STORES)
  describe(`withSnapshot on ${name}`, () => {
    it("runs targets, get, fetchScope and readAnchored on one snapshot: one read, one revision, one release", async () => {
      const { peer, write } = await seeded(open);
      await write(X);
      const { peer: watched, reads, taken } = counted(peer);
      const { value, attempts } = await withSnapshot(watched, async (snapshot) => {
        const ids = await snapshot.targets([X]);
        const got = await snapshot.get(ids);
        const fetched = await fetchScope(snapshot, [X]);
        const read = await readAnchored(snapshot, { term: LEAF, root: X, now: 10 });
        return { at: snapshot.revision, ids, got, fetched, read };
      });
      expect([attempts, reads()]).toEqual([1, 1]);
      expect([value.fetched.revision, value.read.revision]).toEqual([value.at, value.at]);
      expect(value.ids).toHaveLength(2);
      expect(value.got.map((d) => d.id)).toEqual(value.ids);
      expect([...value.fetched.source.ids()].sort()).toEqual(value.ids);
      expect(codeOf(await outcome(taken[0]!.targets([X])))).toBe("snapshot-released");
    });

    it("a purge between two calls of the body starts it again: attempts 2, and every part of the answer is at the new revision", async () => {
      const { peer, move } = await seeded(open);
      const before = (await withSnapshot(peer, (s) => s.revision)).value;
      const { value, attempts } = await withSnapshot(peer, async (snapshot, attempt) => {
        const first = await snapshot.targets([X]);
        if (attempt === 1) await move();
        const fetched = await fetchScope(snapshot, [X]);
        return { at: snapshot.revision, first, fetched: [...fetched.source.ids()].sort() };
      });
      expect(attempts).toBe(2);
      expect(value.at).toBe(before + 1);
      expect(value.first).toHaveLength(1);
      expect(value.fetched).toEqual(value.first);
    });

    it("a body that the peer always moves takes exactly the bound: 4 snapshots by default, 1 and 16 when asked, then the last snapshot-moved passes up as the same object", async () => {
      const { peer, move } = await seeded(open);
      for (const [retry, expected] of [
        [undefined, 4],
        [{ snapshots: 1 }, 1],
        [{ snapshots: 16 }, 16],
      ] as const) {
        const { peer: watched, reads } = counted(peer);
        let runs = 0;
        const met: unknown[] = [];
        const failure = await outcome(
          withSnapshot(
            watched,
            async (snapshot) => {
              runs += 1;
              await snapshot.targets([X]);
              await move();
              return snapshot.targets([Y]).catch((error: unknown) => {
                met.push(error);
                throw error;
              });
            },
            retry,
          ),
        );
        expect([codeOf(failure), reads(), runs]).toEqual(["snapshot-moved", expected, expected]);
        expect(met).toHaveLength(expected);
        expect(failure).toBe(met.at(-1));
      }
    });

    it("a read() that refuses snapshot-moved counts as an attempt, and the body's attempt counts it too: three such and the body runs once with attempt 4; four, and the fourth refusal passes up as the same object", async () => {
      const { peer } = await seeded(open);
      for (const [refusals, answers] of [
        [3, true],
        [4, false],
      ] as const) {
        let left = refusals;
        let reads = 0;
        const given: number[] = [];
        const refused: StoreError[] = [];
        const moving = withRead(peer, async () => {
          reads += 1;
          if (left-- > 0) {
            refused.push(new StoreError("snapshot-moved", "moved before the snapshot"));
            throw refused.at(-1)!;
          }
          return peer.read();
        });
        const answer = await outcome(
          withSnapshot(moving, (snapshot, attempt) => {
            given.push(attempt);
            return snapshot.revision;
          }),
        );
        expect(reads).toBe(4);
        if (answers) {
          expect([(answer as { attempts: number }).attempts, given]).toEqual([4, [4]]);
        } else {
          expect(given).toEqual([]);
          expect(answer).toBe(refused[3]);
        }
      }
      let first = true;
      const once = withRead(peer, async () => {
        if (!first) return peer.read();
        first = false;
        throw new StoreError("snapshot-moved", "moved before the snapshot");
      });
      const given: number[] = [];
      await withSnapshot(once, (_snapshot, attempt) => given.push(attempt));
      expect(given).toEqual([2]);
    });

    it("any other error, of read() or of the body, passes up at once as the same object, after one read; an object that only carries the code snapshot-moved is such an error", async () => {
      const { peer } = await seeded(open);
      const errors: unknown[] = [
        new StoreError("store-unavailable", "the engine is busy; ask again"),
        new StoreError("snapshot-released", "released"),
        new StoreError("capability-absent", "absent"),
        new StoreError("store-closed", "closed"),
        new StoreError("invalid-request", "bad"),
        new StoreFaultError("no-progress", { from: 1 }, "a fault"),
        new Error("plain"),
        Object.assign(new Error("a look-alike"), { code: "snapshot-moved" }),
        { code: "snapshot-moved" },
        "not an error",
      ];
      for (const error of errors) {
        const { peer: watched, reads, taken } = counted(peer);
        expect(
          await outcome(
            withSnapshot(watched, () => {
              throw error;
            }),
          ),
        ).toBe(error);
        expect(reads()).toBe(1);
        expect(codeOf(await outcome(taken[0]!.targets([X])))).toBe("snapshot-released");
        let refusedReads = 0;
        const refusing = withRead(peer, () => {
          refusedReads += 1;
          return Promise.reject(error);
        });
        let runs = 0;
        expect(await outcome(withSnapshot(refusing, () => (runs += 1)))).toBe(error);
        expect([refusedReads, runs]).toEqual([1, 0]);
      }
    });

    it("releases the snapshot of every attempt: on an answer, on a throw, and on a move", async () => {
      const { peer, move } = await seeded(open);
      const { peer: watched, taken } = counted(peer);
      await withSnapshot(watched, (s) => s.targets([X]));
      await outcome(
        withSnapshot(watched, () => {
          throw new Error("the body failed");
        }),
      );
      await withSnapshot(watched, async (snapshot, attempt) => {
        await snapshot.targets([X]);
        if (attempt === 1) await move();
        return snapshot.targets([X]);
      });
      expect(taken).toHaveLength(4);
      for (const snapshot of taken)
        expect(codeOf(await outcome(snapshot.targets([X])))).toBe("snapshot-released");
    });

    it("withinMs bounds the snapshots after the first by the host's clock: 0 still runs the first; a body that passes the bound gets no second; a bound not passed reaches the count", async () => {
      const { peer, move } = await seeded(open);
      let now = 1_000;
      let readings = 0;
      const clock = (): number => {
        readings += 1;
        return now;
      };
      const still = await withSnapshot(peer, (s) => s.targets([X]), { withinMs: 0, clock });
      expect([still.attempts, readings]).toEqual([1, 1]);
      const moves = (step: number) => async (snapshot: Snapshot) => {
        await snapshot.targets([X]);
        now += step;
        await move();
        return snapshot.targets([Y]);
      };
      for (const [withinMs, step, snapshots, expected] of [
        [0, 0, undefined, 1],
        [10, 30, undefined, 1],
        [10, 9, undefined, 2],
        [10, 3, undefined, 4],
        [100, 0, 2, 2],
      ] as const) {
        const { peer: watched, reads } = counted(peer);
        const retry =
          snapshots === undefined ? { withinMs, clock } : { withinMs, clock, snapshots };
        const failure = await outcome(withSnapshot(watched, moves(step), retry));
        expect([codeOf(failure), reads()], `${withinMs} ${step}`).toEqual([
          "snapshot-moved",
          expected,
        ]);
      }
      const { peer: watched, reads } = counted(peer);
      const unbounded = await outcome(withSnapshot(watched, moves(1_000_000), { clock }));
      expect([codeOf(unbounded), reads()]).toEqual(["snapshot-moved", 4]);
    });

    it("a clock reading below the first, or not a finite number, refuses invalid-request after the move, and a clock that throws passes its error up; one snapshot was taken and released in each case", async () => {
      const { peer, move } = await seeded(open);
      const thrown = new Error("the clock failed");
      for (const [later, expected] of [
        [999, "invalid-request"],
        [Number.NaN, "invalid-request"],
        [Number.POSITIVE_INFINITY, "invalid-request"],
        [-1, "invalid-request"],
        ["throws", thrown],
      ] as const) {
        let readings = 0;
        const clock = (): number => {
          readings += 1;
          if (readings === 1) return 1_000;
          if (later === "throws") throw thrown;
          return later;
        };
        const { peer: watched, reads, taken } = counted(peer);
        const failure = await outcome(
          withSnapshot(
            watched,
            async (snapshot) => {
              await snapshot.targets([X]);
              await move();
              return snapshot.targets([Y]);
            },
            { withinMs: 1_000_000, clock },
          ),
        );
        if (expected === thrown) expect(failure).toBe(thrown);
        else expect(codeOf(failure), String(later)).toBe(expected);
        expect([reads(), readings]).toEqual([1, 2]);
        expect(codeOf(await outcome(taken[0]!.targets([X])))).toBe("snapshot-released");
      }
      const equal = await outcome(
        withSnapshot(peer, (s) => s.revision, { withinMs: 0, clock: () => 7 }),
      );
      expect((equal as { attempts: number }).attempts).toBe(1);
    });

    it("the clock is not read once the count ends the call: snapshots 1 reads it once, at the start", async () => {
      const { peer, move } = await seeded(open);
      let readings = 0;
      const clock = (): number => {
        readings += 1;
        return 0;
      };
      const failure = await outcome(
        withSnapshot(
          peer,
          async (snapshot) => {
            await snapshot.targets([X]);
            await move();
            return snapshot.targets([Y]);
          },
          { snapshots: 1, withinMs: 100, clock },
        ),
      );
      expect([codeOf(failure), readings]).toEqual(["snapshot-moved", 1]);
    });

    it("a body that answers a thenable is awaited: the value is what the thenable gives", async () => {
      const { peer } = await seeded(open);
      const thenable = {
        then: (done: (value: number) => void) => done(5),
      } as unknown as Promise<number>;
      expect(await withSnapshot(peer, () => thenable)).toEqual({ value: 5, attempts: 1 });
    });

    it("refuses a bad policy invalid-request before any store call, an unknown own field too, and reads policy fields as own fields", async () => {
      const { peer, move } = await seeded(open);
      class Policy {
        readonly snapshots = 2;
      }
      const bad: unknown[] = [
        null,
        [],
        "4",
        4,
        new Policy(),
        Object.create({ snapshots: 2 }),
        { snapshots: 0 },
        { snapshots: 17 },
        { snapshots: 1.5 },
        { snapshots: Number.NaN },
        { snapshots: "4" },
        { snapshots: null },
        { withinMs: -1, clock: () => 0 },
        { withinMs: 1.5, clock: () => 0 },
        { withinMs: Number.POSITIVE_INFINITY, clock: () => 0 },
        { withinMs: 2 ** 53, clock: () => 0 },
        { withinMs: "10", clock: () => 0 },
        { withinMs: null, clock: () => 0 },
        { withinMs: 10 },
        { withinMs: 10, clock: 5 },
        { clock: "now" },
        { withinMs: 10, clock: () => Number.NaN },
        { withinMs: 10, clock: () => "1" },
        { snapshot: 1 },
        { within: 5 },
        { snapshots: 2, retries: 1 },
        { snapshots: 2, clock: () => 0, extra: undefined },
      ];
      for (const retry of bad) {
        const { peer: watched, reads } = counted(peer);
        const failure = await outcome(
          withSnapshot(watched, (s) => s.revision, retry as SnapshotRetry),
        );
        expect([codeOf(failure), reads()], JSON.stringify(retry)).toEqual(["invalid-request", 0]);
      }
      const { peer: watched, reads } = counted(peer);
      const body = 42 as unknown as () => number;
      expect([codeOf(await outcome(withSnapshot(watched, body))), reads()]).toEqual([
        "invalid-request",
        0,
      ]);
      const always = async (snapshot: Snapshot) => {
        await snapshot.targets([X]);
        await move();
        return snapshot.targets([Y]);
      };
      const bare = Object.assign(Object.create(null) as SnapshotRetry, { snapshots: 2 });
      const proto = Object.prototype as { snapshots?: number; withinMs?: number };
      for (const [retry, expected] of [
        [{}, 4],
        [bare, 2],
      ] as const) {
        const { peer: polluted, reads: pollutedReads } = counted(peer);
        proto.snapshots = 1;
        proto.withinMs = 0;
        let failure: unknown;
        try {
          failure = await outcome(withSnapshot(polluted, always, retry));
        } finally {
          delete proto.snapshots;
          delete proto.withinMs;
        }
        expect([codeOf(failure), pollutedReads()]).toEqual(["snapshot-moved", expected]);
      }
    });

    it("a snapshot at revision 2^53 is the fault revision-out-of-range before the body runs, and is released; 2^53 - 1 runs", async () => {
      const { peer } = await seeded(open);
      for (const [revision, refused] of [
        [2 ** 53, true],
        [2 ** 53 - 1, false],
      ] as const) {
        let released = 0;
        const wrapped = withRead(peer, async () => {
          const snapshot = await peer.read();
          return {
            ...snapshot,
            revision,
            release: () => {
              released += 1;
              snapshot.release();
            },
          };
        });
        let runs = 0;
        const answer = await outcome(withSnapshot(wrapped, (s) => ((runs += 1), s.revision)));
        if (refused) {
          expect(answer).toBeInstanceOf(StoreFaultError);
          expect((answer as StoreFaultError).rule).toBe("revision-out-of-range");
          expect(runs).toBe(0);
        } else expect((answer as { value: number }).value).toBe(revision);
        expect(released).toBe(1);
      }
    });

    it("after close the read refuses store-closed and the body never runs; a close inside the body gives store-closed after one attempt", async () => {
      const inside = await seeded(open);
      const { peer: watched, reads, taken } = counted(inside.peer);
      const failure = await outcome(
        withSnapshot(watched, async (snapshot) => {
          await snapshot.targets([X]);
          await inside.store.close();
          return snapshot.targets([X]);
        }),
      );
      expect([codeOf(failure), reads()]).toEqual(["store-closed", 1]);
      expect(codeOf(await outcome(taken[0]!.targets([X])))).toBe("store-closed");
      const after = await seeded(open);
      await after.store.close();
      let runs = 0;
      const closed = await outcome(withSnapshot(after.peer, () => (runs += 1)));
      expect([codeOf(closed), runs]).toEqual(["store-closed", 0]);
    });

    it("a synchronous body's value is the answer", async () => {
      const { peer } = await seeded(open);
      const answer = withSnapshot(peer, (snapshot, attempt) => ({
        count: snapshot.count,
        attempt,
      }));
      expect(answer).toBeInstanceOf(Promise);
      expect(await answer).toEqual({ value: { count: 2 + SACRIFICES, attempt: 1 }, attempts: 1 });
    });
  });

describe("withSnapshot on the SQLite store holds no transaction between the body's calls", () => {
  it("while the body is suspended at an await, an append through the same Store commits, and a second connection's checkpoint (TRUNCATE) is not busy and leaves no log; the body does not see the append and runs once", async () => {
    const path = fixture.path();
    const store = await openSqliteStore(path);
    try {
      const peer = await store.createPeer("peer:p", { erasure: "unproven" });
      const delta = fact(X);
      const arrival = { id: delta.id, at: 1, sequence: 1, transfer: 1, sender: "test" };
      const seen: unknown[] = [];
      const { value, attempts } = await withSnapshot(peer, async (snapshot, attempt) => {
        const first = await snapshot.targets([X]);
        if (attempt === 1) {
          await sleep(1);
          const result = await peer.append({
            expectedHead: null,
            nextHead: "head-1",
            frame: null,
            added: [{ delta, arrival }],
          });
          seen.push(result.status);
          const other = new Database(path);
          try {
            seen.push(other.pragma("wal_checkpoint(TRUNCATE)"));
          } finally {
            other.close();
          }
        }
        return { first, second: await snapshot.targets([X]) };
      });
      expect(seen).toEqual(["committed", [{ busy: 0, log: 0, checkpointed: 0 }]]);
      expect(attempts).toBe(1);
      expect(value).toEqual({ first: [], second: [] });
    } finally {
      await store.close();
    }
  });
});

describe("moveByPurge, the helper that moves a snapshot in these tests", () => {
  it("purges one sacrificial delta and nothing else, and never a delta at the sacrificial entity that is not one", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer("peer:p", { erasure: "unproven" });
    const other = makeDelta({
      timestamp: 1,
      validFrom: 0,
      author: AUTHOR,
      pointers: [{ role: "sacrificial", target: { kind: "entity", entity: { id: SACRIFICIAL } } }],
    });
    const kept = fact(X);
    const added = [kept, other, sacrificial(1)].map((delta, i) => ({
      delta,
      arrival: { id: delta.id, at: 1, sequence: i + 1, transfer: 1, sender: "test" },
    }));
    await peer.append({ expectedHead: null, nextHead: "h", frame: null, added });
    const held = async (): Promise<string[]> => {
      const snapshot = await peer.read();
      try {
        return (await snapshot.get(added.map((a) => a.delta.id))).map((d) => d.id).sort();
      } finally {
        snapshot.release();
      }
    };
    const victim = sacrificial(1).id;
    const before = await held();
    const old = await peer.read();
    await moveByPurge(peer);
    expect(await held()).toEqual(before.filter((id) => id !== victim));
    expect(codeOf(await outcome(old.get([])))).toBe("snapshot-moved");
    const refused = await outcome(moveByPurge(peer));
    expect(String(refused)).toContain("holds no sacrificial delta");
    expect(await held()).toEqual([kept.id, other.id].sort());
  });
});
