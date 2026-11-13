// The change feed of the memory reference store (SPEC-18 proposal §4.6, §4.13): what the shared
// vectors cannot say. Refusals a typed witness cannot receive, the retention and page options,
// ownership of the records, and the two timed cost rails. The vectors pin the records
// themselves (vectors/store/README.md §3.9).

import { describe, expect, it } from "vitest";
import { makeDelta } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { createMemoryStore, type MemoryStoreOptions } from "../src/storage/memory-store.js";
import {
  StoreError,
  type ChangePage,
  type ChangeRecord,
  type PeerStore,
  type Revision,
} from "../src/storage/store.js";

const A = `ed25519:${"0a".repeat(32)}`;
const B = `ed25519:${"0b".repeat(32)}`;

const fact = (entity: string, value: number): Delta =>
  makeDelta({
    timestamp: value,
    validFrom: value,
    author: "did:key:zA",
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: entity, context: "v" } } },
      { role: "value", target: { kind: "primitive", value } },
    ],
  });

/** One writer of one peer: it keeps the head and the next sequence. */
function writer(peer: PeerStore) {
  let head: string | null = null;
  let sequence = 0;
  let n = 0;
  return {
    async append(deltas: readonly Delta[], nextHead = `h${++n}`) {
      const result = await peer.append({
        expectedHead: head,
        nextHead,
        frame: null,
        added: deltas.map((delta) => ({
          delta,
          arrival: { id: delta.id, at: 1, sequence: ++sequence, transfer: 1, sender: "local" },
        })),
      });
      if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
      head = nextHead;
      return result;
    },
    get head() {
      return head;
    },
  };
}

async function peerOf(options: MemoryStoreOptions = {}, id = A) {
  const store = createMemoryStore(options);
  const peer = await store.createPeer(id, { erasure: "unproven" });
  return { store, peer, write: writer(peer) };
}

const code = async (action: () => Promise<unknown>): Promise<string> =>
  action().then(
    () => "no error",
    (error: unknown) => (error instanceof StoreError ? error.code : `not a StoreError: ${error}`),
  );

/** Every record from `from` on, following pages. */
async function all(peer: PeerStore, from: Revision, to?: Revision): Promise<ChangeRecord[]> {
  const records: ChangeRecord[] = [];
  for (let at = from; ; ) {
    const page: ChangePage = await peer.changes(at, to);
    if (page.status !== "ok") throw new Error("resync-required");
    records.push(...page.records);
    if (page.through === at && page.records.length === 0) return records;
    at = page.through;
    const end = Math.min(to ?? Number.POSITIVE_INFINITY, (await peer.read()).revision);
    if (at === end) return records;
  }
}

describe("the change feed: what a typed witness cannot receive", () => {
  it("refuses a from or a to that is not an integer of 0 or more", async () => {
    const { peer } = await peerOf();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "0", null]) {
      expect(await code(() => peer.changes(bad as never))).toBe("invalid-request");
      expect(await code(() => peer.changes(0, bad as never))).toBe("invalid-request");
    }
    expect(await code(() => peer.changes(0, undefined))).toBe("no error");
  });

  it("refuses on a closed store", async () => {
    const { store, peer } = await peerOf();
    await store.close();
    expect(await code(() => peer.changes(0))).toBe("store-closed");
  });

  it("refuses options it cannot keep", () => {
    for (const changeRetention of [{ revisions: 0 }, { revisions: 1.5 }, { revisions: -1 }, {}, []])
      expect(() => createMemoryStore({ changeRetention: changeRetention as never })).toThrow(
        StoreError,
      );
    for (const changePageSize of [0, 1.5, -1, Number.NaN])
      expect(() => createMemoryStore({ changePageSize })).toThrow(StoreError);
  });

  it("checks the shape before the state: to < from is refused also from the future", async () => {
    const { peer } = await peerOf();
    expect(await code(() => peer.changes(5, 4))).toBe("invalid-request");
    expect(await peer.changes(5)).toEqual({ status: "resync-required", current: 0 });
    expect(await peer.changes(5, 6)).toEqual({ status: "resync-required", current: 0 });
  });
});

describe("the change feed: the records", () => {
  it("a new peer has an empty feed whose floor is its first revision", async () => {
    const { peer } = await peerOf({ changeRetention: { revisions: 1 } });
    expect(await peer.changes(0)).toEqual({ status: "ok", records: [], through: 0 });
  });

  it("records cannot be changed through what changes returned", async () => {
    const { peer, write } = await peerOf();
    const d = fact("e", 1);
    await write.append([d]);
    const page = await peer.changes(0);
    if (page.status !== "ok") throw new Error("resync");
    const record = page.records[0]!;
    expect(() => ((record as { head: string }).head = "x")).toThrow(TypeError);
    expect(() => (record.added as string[]).push("x")).toThrow(TypeError);
    (page.records as ChangeRecord[]).length = 0;
    expect(await all(peer, 0)).toEqual([{ revision: 1, head: "h1", added: [d.id], removed: [] }]);
  });

  it("a refused append writes no record, and a conflict writes none", async () => {
    const { peer, write } = await peerOf();
    await write.append([fact("e", 1)]);
    const forged = { ...fact("e", 2), id: fact("e", 3).id };
    await expect(
      peer.append({
        expectedHead: "h1",
        nextHead: "h2",
        frame: null,
        added: [
          {
            delta: forged,
            arrival: { id: forged.id, at: 1, sequence: 9, transfer: 1, sender: "x" },
          },
        ],
      }),
    ).rejects.toThrow(StoreError);
    expect(
      await peer.append({ expectedHead: "nope", nextHead: "h2", frame: null, added: [] }),
    ).toEqual({ status: "conflict" });
    expect(await all(peer, 0)).toHaveLength(1);
  });

  it("each peer keeps its own feed", async () => {
    const store = createMemoryStore();
    const a = writer(await store.createPeer(A, { erasure: "unproven" }));
    const peerB = await store.createPeer(B, { erasure: "unproven" });
    const b = writer(peerB);
    const shared = fact("e", 1);
    await a.append([shared, fact("e", 2)]);
    await b.append([shared]);
    expect(await all(peerB, 0)).toEqual([
      { revision: 1, head: "h1", added: [shared.id], removed: [] },
    ]);
  });
});

describe("the change feed: retention and pages", () => {
  it("keeps the latest n records and answers resync-required exactly below the floor", async () => {
    const { peer, write } = await peerOf({ changeRetention: { revisions: 3 } });
    for (let i = 0; i < 10; i++) await write.append([], `h${i}`);
    // Revisions 1..10; records 8, 9, 10 kept; the floor is 7.
    expect(await peer.changes(6)).toEqual({ status: "resync-required", current: 10 });
    expect(await peer.changes(0, 0)).toEqual({ status: "resync-required", current: 10 });
    const page = await peer.changes(7);
    expect(page.status === "ok" && page.records.map((r) => r.revision)).toEqual([8, 9, 10]);
  });

  it("a bounded page makes progress and resumes from through", async () => {
    const { peer, write } = await peerOf({ changePageSize: 2 });
    for (let i = 0; i < 5; i++) await write.append([fact("e", i)]);
    const first = await peer.changes(0);
    expect(first.status === "ok" && [first.records.map((r) => r.revision), first.through]).toEqual([
      [1, 2],
      2,
    ]);
    const last = await peer.changes(4, 99);
    expect(last).toEqual({
      status: "ok",
      records: [expect.objectContaining({ revision: 5 })],
      through: 5,
    });
    expect((await all(peer, 0)).map((r) => r.revision)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---- the cost rails ---------------------------------------------------------------------------

describe("cost rail: the feed costs what it returns", () => {
  // Timed from outside with a monotonic clock, as SPEC-18 §4.11 reading 36: N against 8N, the
  // run at N the fastest of five, the run at 8N the fastest of three, stopped at the first under
  // the bound. Linear total work scales by about 8, quadratic by about 64; the rail fails at 24.
  // N is the smallest power of two from 256 whose run takes 50 ms or more.
  const BOUND = 24;
  const WINDOW = 64;

  async function fastest(run: () => Promise<number>, runs: number, enough = 0): Promise<number> {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs && best >= enough; i++) best = Math.min(best, await run());
    return best;
  }

  async function scaling(name: string, make: (n: number) => Promise<() => Promise<number>>) {
    let n = 256;
    let small = await fastest(await make(n), 5);
    while (small < 50 && n < 1 << 20) small = await fastest(await make((n *= 2)), 5);
    const large = await fastest(await make(8 * n), 3, BOUND * small);
    const ratio = large / small;
    console.log(
      `${name}: N = ${n}, ${small.toFixed(1)} ms and ${large.toFixed(1)} ms, ratio ${ratio.toFixed(2)}`,
    );
    expect(ratio, `N = ${n}: ${small.toFixed(1)} ms, then ${large.toFixed(1)} ms`).toBeLessThan(
      BOUND,
    );
  }

  /** A peer with `n` head-only commits: revisions 1 to n. */
  async function feedOf(n: number, options: MemoryStoreOptions = {}) {
    const { peer, write } = await peerOf(options);
    for (let i = 0; i < n; i++) await write.append([], `h${i}`);
    return peer;
  }

  it(`a window of ${WINDOW} after each of N records costs less than ${BOUND} times at 8N`, async () => {
    // N calls; call r reads (r, r + WINDOW] behind r earlier records. A store that walks from
    // the start of its feed to find `from` does quadratic work in total.
    await scaling("changes over a fixed window", async (n) => {
      const peer = await feedOf(n + WINDOW);
      return async () => {
        const start = performance.now();
        for (let r = 0; r < n; r++) {
          const page = await peer.changes(r, r + WINDOW);
          if (page.status !== "ok" || page.records.length !== WINDOW) throw new Error("window");
        }
        return performance.now() - start;
      };
    });
  }, 600_000);

  it(`N appends under bounded retention cost less than ${BOUND} times at 8N`, async () => {
    // The store keeps N / 4 records, so at 8N it holds 8 times as many while it drops. A store
    // whose drop copies or shifts what it keeps does quadratic work in total.
    await scaling("append under bounded retention", async (n) => {
      return async () => {
        const { peer, write } = await peerOf({ changeRetention: { revisions: n / 4 } });
        const start = performance.now();
        for (let i = 0; i < n; i++) await write.append([], `h${i}`);
        const took = performance.now() - start;
        const page = await peer.changes(n - n / 4);
        if (page.status !== "ok" || page.records.length !== n / 4) throw new Error("kept");
        return took;
      };
    });
  }, 600_000);
});
