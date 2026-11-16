// The query-plan rail of the SQLite store (slice 4 plan §5 and §8 item 18), part 3: timing. Each
// read, one append and one purge run against a peer with 2,000 unrelated deltas and against a
// peer with 32,000, each in its own store. The time at the larger size may be at most four times
// the time at the smaller: an indexed statement grows by a logarithm, a scan of the peer by 16.
// A plan shows no foreign-key action, so the append and the purge are timed too: a cascade
// without its index reads the whole peer.
//
// Timed from outside with a monotonic clock, as the slice 3 rails are (§4.11 reading 36). Each
// size is measured as the fastest of three runs. The rail measures again when the ratio passes
// the bound, and fails only when three measurements in a row pass it: a scan passes it every
// time, and a stall on a busy host rarely does three times. The TypeScript witness has no
// shared timing lock across test files, so the repeat is what keeps a stall from failing it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDelta, makeNegationClaims } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import type { PeerStore, Store, VerifiedDelta } from "../src/storage/store.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const fixture = sqliteFixture("rhizomatic-sqlite-timing");
afterAll(() => fixture.cleanup());

const SMALL = 2_000;
const LARGE = 32_000;
const BOUND = 4;
const CALLS = 400;
const WRITES = 100;
const ATTEMPTS = 3;
const RUNS = 3;

const AUTHOR = `ed25519:${"0d".repeat(32)}`;
const fake = (n: number): string => `1e20${n.toString(16).padStart(64, "0")}`;

/**
 * A delta with four entity pointers and four `negates` pointers: four rows in `target` and four
 * in `reference`, so a statement that reads the peer's rows reads many.
 */
const linked = (entity: string, n: number): Delta =>
  makeDelta({
    timestamp: n,
    validFrom: 0,
    author: AUTHOR,
    pointers: [0, 1, 2, 3].flatMap((k) => [
      { role: "about", target: { kind: "entity", entity: { id: `${entity}/${k}` } } },
      { role: "negates", target: { kind: "delta", deltaRef: { delta: fake(4 * n + k) } } },
    ]),
  });

type Sized = {
  store: Store;
  peer: PeerStore;
  hot: Delta[];
  next: () => number;
  append: (deltas: readonly Delta[]) => Promise<void>;
  victims: Delta[];
};

async function sized(bulk: number): Promise<Sized> {
  const store = await fixture.open();
  const peer = await store.createPeer("peer:timed", { erasure: "unproven" });
  let sequence = 0;
  let head: string | null = null;
  const member = (delta: Delta): VerifiedDelta => ({
    delta,
    arrival: { id: delta.id, at: sequence + 1, sequence: ++sequence, transfer: 1, sender: "t" },
  });
  const append = async (deltas: readonly Delta[]): Promise<void> => {
    const next = `head-${sequence + deltas.length}`;
    const result = await peer.append({
      expectedHead: head,
      nextHead: next,
      frame: null,
      added: deltas.map(member),
    });
    if (result.status !== "committed") throw new Error(result.status);
    head = next;
  };
  const facts = Array.from({ length: 4 }, (_, i) => linked("hot", 10_000_000 + i));
  const negation = makeDelta(makeNegationClaims(AUTHOR, 10_000_100, facts[0]!.id));
  const again = makeDelta(makeNegationClaims(AUTHOR, 10_000_101, negation.id));
  const hot = [...facts, negation, again];
  await append(hot);
  for (let start = 0; start < bulk; start += 4_000)
    await append(
      Array.from({ length: Math.min(4_000, bulk - start) }, (_, i) =>
        linked(`bulk:${start + i}`, start + i),
      ),
    );
  // The deltas the purge runs remove: each with rows in every per-peer table.
  const victims = Array.from({ length: ATTEMPTS * RUNS * WRITES }, (_, i) =>
    linked(`victim:${i}`, 20_000_000 + i),
  );
  await append(victims);
  let fresh = 30_000_000;
  return { store, peer, hot, next: () => fresh++, append, victims };
}

/** The fastest of `RUNS` runs of `body`, in ms. */
async function fastest(body: () => Promise<void>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    await body();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("the query-plan rail, part 3: the time of each operation does not grow with the peer", () => {
  let small: Sized;
  let large: Sized;
  beforeAll(async () => {
    small = await sized(SMALL);
    large = await sized(LARGE);
  }, 600_000);

  const calls =
    (call: (s: Sized) => Promise<unknown>, times = CALLS) =>
    (s: Sized) =>
    async () => {
      for (let i = 0; i < times; i++) await call(s);
    };
  const at = async (s: Sized) => s.peer.read();
  const ops: Record<string, (s: Sized) => () => Promise<void>> = {
    read: calls(async (s) => (await at(s)).release()),
    get: calls(async (s) => (await at(s)).get(s.hot.map((d) => d.id))),
    arrivals: calls(async (s) => (await at(s)).arrivals(s.hot.map((d) => d.id))),
    targets: calls(async (s) => (await at(s)).targets(["hot/0"])),
    negators: calls(async (s) => (await at(s)).negators([s.hot[0]!.id])),
    scope: calls(async (s) =>
      (await at(s)).scope({ anchors: [{ kind: "entity", entity: "hot/0" }] }),
    ),
    "scope with every pushdown": calls(async (s) =>
      (await at(s)).scope({
        anchors: [{ kind: "entity", entity: "hot/0" }],
        pushdown: {
          arrivalAtMost: 3,
          timestampAtMost: 20_000_000,
          excludeIds: [s.hot[1]!.id],
        },
        exclude: [s.hot[2]!.id],
      }),
    ),
    changes: calls(async (s) => {
      const r = (await at(s)).revision;
      await s.peer.changes(r - 1, r);
    }),
    append: calls(async (s) => s.append([linked(`new:${s.next()}`, s.next())]), WRITES),
    purge: calls(async (s) => {
      await s.peer.purge([s.victims.pop()!.id]);
    }, WRITES),
  };

  for (const [name, op] of Object.entries(ops))
    it(`${name}: at ${LARGE} deltas at most ${BOUND} times the time at ${SMALL}`, async () => {
      const seen: string[] = [];
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const t = await fastest(op(small));
        const T = await fastest(op(large));
        seen.push(`${t.toFixed(2)} ms and ${T.toFixed(2)} ms, ratio ${(T / t).toFixed(2)}`);
        if (T / t <= BOUND) break;
      }
      console.log(`sqlite timing, ${name}: ${seen.join("; ")}`);
      const last = seen.at(-1)!;
      expect(Number(last.split("ratio ")[1]), last).toBeLessThanOrEqual(BOUND);
    }, 600_000);
});
