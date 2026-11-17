// `fsck` on the memory store, the shape of the integrity fault, and the store fault a read gives
// for a malformed member of a `scope` answer (SPEC-18 proposal §4.13 readings 21, 136 and 137).
// The SQLite store's faults are made on real files in sqlite-store-fsck.test.ts.

import { describe, expect, it } from "vitest";
import { makeDelta, parseTerm } from "../src/index.js";
import type { Delta } from "../src/delta/types.js";
import { fetchScope, readAnchored } from "../src/reactor/store-read.js";
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
});
