// `fsck` on the memory store, the shape of the integrity fault, and the store fault a read gives
// for a malformed member of a `scope` answer (SPEC-18 proposal §4.13 readings 21, 136 and 137).
// The SQLite store's faults are made on real files in sqlite-store-fsck.test.ts.

import { describe, expect, it } from "vitest";
import { makeDelta, parseTerm } from "../src/index.js";
import type { Delta } from "../src/delta/types.js";
import { StoreReactor, captureScope, fetchScope, readAnchored } from "../src/reactor/store-read.js";
import { StoreViews } from "../src/reactor/store-views.js";
import { admissionOf } from "../src/storage/admission.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import {
  StoreFaultError,
  StoreIntegrityError,
  type PeerStore,
  type Snapshot,
} from "../src/storage/store.js";

const AUTHOR = `ed25519:${"2e".repeat(32)}`;
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

describe("fsck on the memory store", () => {
  it("answers the report shape with no fault over shared ids, negations, purges and a trimmed feed, and counts what it read", async () => {
    const store = createMemoryStore({ changeRetention: { revisions: 2 } });
    const a = await store.createPeer("peer:a", { erasure: "unproven" });
    const b = await store.createPeer("peer:b", { erasure: "unproven" });
    const [x, y, z] = [fact("x"), fact("y"), fact("z")];
    const neg = negation(x);
    await add(a, [x, y]);
    await add(a, [neg]);
    await add(a, [z]);
    await add(b, [x, z, neg]);
    await a.purge([x.id, y.id]);
    await b.purge([z.id]);
    expect(await store.openAdmin().fsck()).toEqual({
      checked: { peers: 2, holdings: 4, deltas: 3 },
      faults: [],
    });
  });

  it("refuses store-closed after close", async () => {
    const store = createMemoryStore();
    const admin = store.openAdmin();
    await store.close();
    const code = await admin.fsck().then(
      () => "answered",
      (error: unknown) => (error as { code?: string }).code,
    );
    expect(code).toBe("store-closed");
  });
});

describe("StoreIntegrityError", () => {
  it("carries one frozen fault, its detail as the message, and is not a StoreError", () => {
    const error = new StoreIntegrityError({
      kind: "index-missing",
      peer: "p",
      id: "i",
      key: "e",
      detail: "a detail",
    });
    expect([error.name, error.message, Object.isFrozen(error.fault)]).toEqual([
      "StoreIntegrityError",
      "a detail",
      true,
    ]);
    expect(error.fault).toEqual({
      kind: "index-missing",
      peer: "p",
      id: "i",
      key: "e",
      detail: "a detail",
    });
    expect(error).not.toHaveProperty("code");
  });
});

describe("a read of a store that answers a malformed scope member", () => {
  const X = "entity:x";
  const LEAF = parseTerm({
    op: "group",
    key: "byTargetContext",
    in: {
      op: "select",
      pred: { hasPointer: { targetEntity: { var: "root" } } },
      in: { op: "mask", policy: "drop", in: "input" },
    },
  });

  /** A snapshot whose `scope` answers each member under the id of another delta. */
  async function forging(): Promise<Snapshot> {
    const store = createMemoryStore();
    const peer = await store.createPeer("peer:p", { erasure: "unproven" });
    await add(peer, [fact(X)]);
    const real = await peer.read();
    const other = fact("entity:other").id;
    return {
      ...real,
      lastSequence: real.lastSequence,
      lastTransfer: real.lastTransfer,
      scope: async (request) => {
        const answer = await real.scope(request);
        return {
          ...answer,
          deltas: answer.deltas.map((m) => ({
            delta: { ...m.delta, id: other },
            arrival: { ...m.arrival, id: other },
          })),
        };
      },
    };
  }

  const faultOf = (call: Promise<unknown>): Promise<unknown> =>
    call.then(
      () => "answered",
      (error: unknown) =>
        error instanceof StoreFaultError ? `fault ${error.rule}` : `other ${String(error)}`,
    );

  it("readAnchored throws the store fault malformed-member", async () => {
    expect(await faultOf(readAnchored(await forging(), { term: LEAF, root: X, now: 10 }))).toBe(
      "fault malformed-member",
    );
  });

  it("fetchScope throws the store fault malformed-member", async () => {
    expect(await faultOf(fetchScope(await forging(), [X]))).toBe("fault malformed-member");
  });

  /**
   * A memory store whose peer holds one fact at X; a handle of that peer whose `scope` answers
   * each member under another id while `forge` is on; and counts of the handle's reads, `scope`
   * calls and releases.
   */
  async function counting() {
    const store = createMemoryStore();
    const writer = await store.createPeer("peer:p", { erasure: "unproven" });
    await add(writer, [fact(X)]);
    const other = fact("entity:other").id;
    const control = { forge: true, reads: 0, scopes: 0, releases: 0 };
    const reset = (forge: boolean): void => {
      Object.assign(control, { forge, reads: 0, scopes: 0, releases: 0 });
    };
    const counts = (): number[] => [control.reads, control.scopes, control.releases];
    const peer: PeerStore = {
      id: writer.id,
      get history() {
        return writer.history;
      },
      get appFormat() {
        return writer.appFormat;
      },
      erasure: writer.erasure,
      read: async () => {
        control.reads++;
        const real = await writer.read();
        return {
          ...real,
          lastSequence: real.lastSequence,
          lastTransfer: real.lastTransfer,
          scope: async (request) => {
            control.scopes++;
            const answer = await real.scope(request);
            if (!control.forge) return answer;
            return {
              ...answer,
              deltas: answer.deltas.map((m) => ({
                delta: { ...m.delta, id: other },
                arrival: { ...m.arrival, id: other },
              })),
            };
          },
          release: () => {
            control.releases++;
            real.release();
          },
        };
      },
      append: (batch) => writer.append(batch),
      purge: (ids) => writer.purge(ids),
      changes: (from, to) => writer.changes(from, to),
    };
    return { writer, peer, reset, counts };
  }

  it("StoreReactor.read throws the store fault after one read and one scope call, and releases the snapshot", async () => {
    const { peer, reset, counts } = await counting();
    const reactor = StoreReactor.open(peer);
    reset(true);
    expect(await faultOf(reactor.read({ term: LEAF, root: X, now: 10 }))).toBe(
      "fault malformed-member",
    );
    expect(counts()).toEqual([1, 1, 1]);
  });

  it("StoreReactor.fetch throws the store fault after one read and one scope call, and releases the snapshot", async () => {
    const { peer, reset, counts } = await counting();
    const reactor = StoreReactor.open(peer);
    reset(true);
    expect(await faultOf(reactor.fetch([X]))).toBe("fault malformed-member");
    expect(counts()).toEqual([1, 1, 1]);
  });

  it("captureScope throws the store fault after one scope call", async () => {
    const { peer, reset, counts } = await counting();
    const snapshot = await peer.read();
    reset(true);
    expect(await faultOf(captureScope(snapshot, [X], 10))).toBe("fault malformed-member");
    expect(counts()).toEqual([0, 1, 0]);
  });

  it("a hold throws the store fault after one read and one scope call, releases the snapshot and keeps no view", async () => {
    const { peer, reset, counts } = await counting();
    const views = new StoreViews(peer);
    views.register("leaf", { term: LEAF });
    const empty = views.indexSizes();
    reset(true);
    expect(await faultOf(views.hold("leaf", X, 10))).toBe("fault malformed-member");
    expect(counts()).toEqual([1, 1, 1]);
    expect(views.indexSizes()).toEqual(empty);
  });

  it("a refresh throws the store fault after one read and one scope call, releases the snapshot and keeps its view; the next refresh reads again at the same revision", async () => {
    const { writer, peer, reset, counts } = await counting();
    const views = new StoreViews(peer);
    views.register("leaf", { term: LEAF });
    reset(false);
    const held = await views.hold("leaf", X, 10);
    await add(writer, [fact(X)]);
    const sizes = views.indexSizes();
    reset(true);
    expect(await faultOf(views.refresh(10))).toBe("fault malformed-member");
    expect(counts()).toEqual([1, 1, 1]);
    expect(views.indexSizes()).toEqual(sizes);
    reset(false);
    const refresh = await views.refresh(10);
    expect([refresh.position.revision, refresh.reread.length]).toEqual([
      held.position.revision + 1,
      1,
    ]);
  });
});
