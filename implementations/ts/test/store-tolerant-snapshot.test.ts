// A snapshot after appends (SPEC-18 proposal §4.13 readings 130 and 131), on the memory store and
// the SQLite store through one suite. A snapshot keeps its last sequence. A later append gives
// every new holding a sequence past it, so each call keeps the holdings at or below it and answers
// as at the snapshot's revision. A purge that releases a holding moves every older snapshot. The
// scenarios are those of the step 4d build plan, section 2; the processes are in
// sqlite-store-processes.test.ts.

import { afterAll, describe, expect, it } from "vitest";
import { makeDelta, makeNegationClaims } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { parseTerm, resultCanonicalHex } from "../src/index.js";
import { captureScope, readAnchored } from "../src/reactor/store-read.js";
import { followFeed, positionOf } from "../src/storage/follow.js";
import { checkFresh } from "../src/storage/freshness.js";
import { createMemoryStore, type MemoryStoreOptions } from "../src/storage/memory-store.js";
import { StoreError, type PeerStore, type Snapshot, type Store } from "../src/storage/store.js";
import { withSnapshot } from "../src/storage/with-snapshot.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const fixture = sqliteFixture("rhizomatic-tolerant-snapshot");
afterAll(() => fixture.cleanup());

type Options = Pick<MemoryStoreOptions, "changeRetention">;
const STORES: readonly (readonly [string, (options?: Options) => Promise<Store>])[] = [
  ["the memory store", async (options = {}) => createMemoryStore(options)],
  ["the SQLite store", (options = {}) => fixture.audited(options)],
];

const AUTHOR = `ed25519:${"7e".repeat(32)}`;
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
const negation = (of: Delta): Delta => makeDelta(makeNegationClaims(AUTHOR, ++stamp, of.id));

/** A peer and a writer that numbers its own arrivals and heads. */
async function writer(open: (options?: Options) => Promise<Store>, options?: Options) {
  const store = await open(options);
  const peer = await store.createPeer("peer:p", { erasure: "unproven" });
  let head: string | null = null;
  let sequence = 0;
  let heads = 0;
  const append = async (deltas: readonly Delta[], nextHead = `head-${++heads}`) => {
    const added = deltas.map((delta) => ({
      delta,
      arrival: { id: delta.id, at: 1, sequence: ++sequence, transfer: 1, sender: "test" },
    }));
    const result = await peer.append({ expectedHead: head, nextHead, frame: null, added });
    expect(result.status).toBe("committed");
    head = nextHead;
  };
  return { store, peer, append };
}

const codeOf = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "answered",
    (error: unknown) => (error instanceof StoreError ? error.code : `not a StoreError: ${error}`),
  );
const idsOf = (deltas: readonly { id: string }[]): string[] => deltas.map((d) => d.id);
const scopeIds = async (s: Snapshot, entity: string): Promise<string[]> =>
  (await s.scope({ anchors: [{ kind: "entity", entity }] })).deltas.map((e) => e.delta.id);

/** Every call of a snapshot, the ones that would find no rows included, each with its code. */
const everyCall = async (s: Snapshot, id: string): Promise<string[]> => [
  await codeOf(s.get([id])),
  await codeOf(s.get([])),
  await codeOf(s.arrivals([id])),
  await codeOf(s.targets([X])),
  await codeOf(s.targets([])),
  await codeOf(s.negators([id])),
  await codeOf(s.scope({ anchors: [{ kind: "entity", entity: X }] })),
  await codeOf(s.scope({ anchors: [] })),
];
const MOVED = Array.from({ length: 8 }, () => "snapshot-moved");

for (const [name, open] of STORES)
  describe(`a snapshot after appends on ${name}`, () => {
    it("scenario 1: a delta admitted after the snapshot at an anchored entity is in neither targets nor scope", async () => {
      const { peer, append } = await writer(open);
      const held = fact(X);
      await append([held]);
      const s = await peer.read();
      await append([fact(X), fact(X)]);
      expect(await s.targets([X])).toEqual([held.id]);
      expect(await scopeIds(s, X)).toEqual([held.id]);
      const now = await peer.read();
      expect(await now.targets([X])).toHaveLength(3);
    });

    it("scenario 2: a negation admitted after the snapshot is in neither negators nor scope, and the evaluation still shows the claim", async () => {
      const { peer, append } = await writer(open);
      const claim = fact(X);
      await append([claim]);
      const s = await peer.read();
      const before = await readAnchored(s, { term: LEAF, root: X, now: 10 });
      const strike = negation(claim);
      const unstrike = negation(strike);
      await append([strike, unstrike, negation(unstrike)]);
      expect(await s.negators([claim.id])).toEqual([]);
      expect(await scopeIds(s, X)).toEqual([claim.id]);
      const after = await readAnchored(s, { term: LEAF, root: X, now: 10 });
      expect(resultCanonicalHex(after.result)).toBe(resultCanonicalHex(before.result));
      expect(after.members).toEqual([claim.id]);
      const now = await peer.read();
      expect(await now.negators([claim.id])).toEqual([strike.id]);
      expect(await scopeIds(now, X)).toHaveLength(4);
    });

    it("scenario 3: an id asked by name that arrived after the snapshot: get and arrivals answer nothing for it", async () => {
      const { peer, append } = await writer(open);
      const held = fact(X);
      await append([held]);
      const s = await peer.read();
      const late = fact(X);
      await append([late]);
      expect(idsOf(await s.get([held.id, late.id]))).toEqual([held.id]);
      expect((await s.arrivals([held.id, late.id])).map((a) => a.id)).toEqual([held.id]);
      expect(await s.get([late.id])).toEqual([]);
      expect(await s.arrivals([late.id])).toEqual([]);
    });

    it("scenario 4: revision, history, head, count and lastSequence stay fixed after appends, and count is the number of ids get answers", async () => {
      const { peer, append } = await writer(open);
      const ids: string[] = [];
      const add = async (n: number) => {
        const deltas = Array.from({ length: n }, () => fact(X));
        ids.push(...idsOf(deltas));
        await append(deltas);
      };
      await add(3);
      const s = await peer.read();
      const fixed = [s.revision, s.history, s.head, s.count, s.lastSequence];
      expect(fixed.slice(2)).toEqual(["head-1", 3, 3]);
      for (let k = 0; k < 4; k++) await add(2);
      expect([s.revision, s.history, s.head, s.count, s.lastSequence]).toEqual(fixed);
      expect(await s.get(ids)).toHaveLength(s.count);
      const now = await peer.read();
      expect([now.revision, now.count, now.lastSequence]).toEqual([5, 11, 11]);
    });

    it("scenario 5: a head-only append refuses nothing; the answers and the head are the snapshot's", async () => {
      const { peer, append } = await writer(open);
      const held = fact(X);
      await append([held]);
      const s = await peer.read();
      await append([], "head-only");
      expect((await peer.read()).revision).toBe(s.revision + 1);
      expect(s.head).toBe("head-1");
      expect(await everyCall(s, held.id)).toEqual([
        "answered",
        "answered",
        "answered",
        "answered",
        "answered",
        "answered",
        "answered",
        "answered",
      ]);
      expect(await s.targets([X])).toEqual([held.id]);
    });

    it("scenario 6: after a purge, the same id appended again with a new sequence: the old snapshot refuses every call, the empty ones too", async () => {
      const { peer, append } = await writer(open);
      const again = fact(X);
      await append([again, fact(X)]);
      const s = await peer.read();
      expect((await peer.purge([again.id])).targets).toEqual([
        { id: again.id, outcome: "removed" },
      ]);
      await append([again]);
      await append([fact(X)]);
      expect(await everyCall(s, again.id)).toEqual(MOVED);
      const now = await peer.read();
      expect(await now.targets([X])).toHaveLength(3);
    });

    it("a purge that releases nothing, and a purge of another peer, move no older snapshot of this peer", async () => {
      const { store, peer, append } = await writer(open);
      const held = fact(X);
      await append([held]);
      const s = await peer.read();
      await append([fact(Y)]);
      const other = await store.createPeer("peer:q", { erasure: "unproven" });
      const shared = fact(X);
      await other.append({
        expectedHead: null,
        nextHead: "q",
        frame: null,
        added: [
          {
            delta: shared,
            arrival: { id: shared.id, at: 1, sequence: 1, transfer: 1, sender: "q" },
          },
        ],
      });
      expect((await peer.purge([fact(X).id])).claim).toBe("nothing-removed");
      expect((await other.purge([shared.id])).claim).not.toBe("nothing-removed");
      expect(await s.targets([X])).toEqual([held.id]);
    });

    it("two peers share ids across a snapshot: a holding of the other peer neither adds to nor removes from this peer's targets, negators or scope", async () => {
      const { store, peer, append } = await writer(open);
      const held = fact(X);
      await append([held, fact(Y)]);
      const s = await peer.read();
      const late = fact(X);
      const strike = negation(held);
      const other = await store.createPeer("peer:q", { erasure: "unproven" });
      const added = [late, strike, held].map((delta, i) => ({
        delta,
        arrival: { id: delta.id, at: 1, sequence: [1, 2, 100][i]!, transfer: 1, sender: "q" },
      }));
      const result = await other.append({ expectedHead: null, nextHead: "q", frame: null, added });
      expect(result.status).toBe("committed");
      await append([late, strike]);
      expect(await s.targets([X])).toEqual([held.id]);
      expect(await s.negators([held.id])).toEqual([]);
      expect(await scopeIds(s, X)).toEqual([held.id]);
      const now = await peer.read();
      expect(await now.targets([X])).toEqual([held.id, late.id].sort());
      expect(await now.negators([held.id])).toEqual([strike.id]);
    });

    it("scenario 9: arrivalAtMost above the snapshot's last sequence keeps the snapshot's set, and is reported applied", async () => {
      const { peer, append } = await writer(open);
      const held = fact(X);
      await append([held]);
      const s = await peer.read();
      await append([fact(X), fact(X)]);
      const result = await s.scope({
        anchors: [{ kind: "entity", entity: X }],
        pushdown: { arrivalAtMost: 2 ** 53 - 1 },
      });
      expect(result.deltas.map((e) => e.delta.id)).toEqual([held.id]);
      expect(result.applied.arrivalAtMost).toBe(true);
      const lower = await s.scope({
        anchors: [{ kind: "entity", entity: X }],
        pushdown: { arrivalAtMost: 0 },
      });
      expect(lower.deltas).toEqual([]);
    });

    it("scenario 11: with two records kept, five appends trim the records a snapshot's position needs: checkFresh and a pull answer resync-required, and get still answers the snapshot's state", async () => {
      const { peer, append } = await writer(open, { changeRetention: { revisions: 2 } });
      const held = fact(X);
      await append([held]);
      const s = await peer.read();
      const capture = await captureScope(s, [X], 0);
      const position = positionOf(s);
      for (let k = 0; k < 5; k++) await append([fact(X)]);
      expect(await checkFresh(peer, capture, 0)).toEqual({ status: "resync-required", current: 6 });
      expect(await followFeed(peer, position).pull()).toEqual({
        status: "resync-required",
        current: { history: s.history, revision: 6 },
      });
      expect(idsOf(await s.get([held.id]))).toEqual([held.id]);
      expect(await s.targets([X])).toEqual([held.id]);
    });

    it("scenario 14: a body that appends and then reads does not see its own write, and runs once", async () => {
      const { peer, append } = await writer(open);
      const held = fact(X);
      await append([held]);
      const { value, attempts } = await withSnapshot(peer, async (s) => {
        await append([fact(X)]);
        return s.targets([X]);
      });
      expect([value, attempts]).toEqual([[held.id], 1]);
    });

    it("scenario 16: a pull during appends answers from one snapshot: its position is that snapshot's, and one read", async () => {
      const { peer, append } = await writer(open);
      const start = await peer.read();
      start.release();
      const first = fact(X);
      await append([first]);
      let reads = 0;
      let appends = 3;
      const moving: PeerStore = {
        id: peer.id,
        get history() {
          return peer.history;
        },
        erasure: peer.erasure,
        get appFormat() {
          return peer.appFormat;
        },
        read: () => ((reads += 1), peer.read()),
        append: (batch) => peer.append(batch),
        purge: (ids) => peer.purge(ids),
        changes: async (from, to) => {
          const page = await peer.changes(from, to);
          if (appends-- > 0) await append([fact(X)]);
          return page;
        },
      };
      const pull = await followFeed(moving, positionOf(start)).pull();
      expect(reads).toBe(1);
      expect(pull).toMatchObject({
        status: "ok",
        position: { history: start.history, revision: 1 },
      });
      expect(pull.status === "ok" && pull.deltas.map((d) => d.delta.id)).toEqual([first.id]);
    });
  });
