// Each place that reads a caller's object or a store's member reads own fields only. One rail for
// each such place: it sets one field on `Object.prototype`, makes its calls, removes the field in
// `finally`, and only then asserts. Every store file lives in this file's own `mkdtempSync`
// directory.

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeId, makeDelta, parseTerm } from "../src/index.js";
import type { Claims, Delta } from "../src/delta/types.js";
import {
  StoreReactor,
  UnanchoredTermError,
  captureScope,
  fetchScope,
  STANDARD_ROUNDS,
  readAnchored,
  readAnchoredWith,
  readFullSurface,
  type RoundPolicy,
} from "../src/reactor/store-read.js";
import { followFeed } from "../src/storage/follow.js";
import { validityWindow } from "../src/storage/freshness.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { scopeSource } from "../src/storage/scope-source.js";
import { openSqliteStore } from "../src/storage/sqlite-store.js";
import {
  StoreError,
  type PeerExporter,
  type PeerStore,
  type Snapshot,
  type Store,
} from "../src/storage/store.js";
import { space } from "./support/sqlite-erasure.js";

const { dir, remove } = space("rhizomatic-own-fields");
afterAll(remove);
let files = 0;
const newPath = (): string => join(dir, `store-${++files}.db`);

/** Runs `body` while `Object.prototype[key]` is `value`, and removes the field afterwards. */
async function polluted<T>(key: string, value: unknown, body: () => Promise<T>): Promise<T> {
  const proto = Object.prototype as Record<string, unknown>;
  proto[key] = value;
  try {
    return await body();
  } finally {
    delete proto[key];
  }
}

/** The answer of a call: its value, or the code of its `StoreError`, or the error's class name. */
const outcome = async <T>(call: () => Promise<T>): Promise<T | string> => {
  try {
    return await call();
  } catch (error) {
    if (error instanceof StoreError) return error.code;
    if (error instanceof Error) return error.constructor.name;
    throw error;
  }
};

const PEER = `ed25519:${"7e".repeat(32)}`;
const SIG = "ab".repeat(64);
const LEAF_JSON = {
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
};
const LEAF = parseTerm(LEAF_JSON);
const claims = (entity: string, t: number, value: string): Claims => ({
  timestamp: t,
  validFrom: t,
  author: "did:key:zA",
  pointers: [
    { role: "subject", target: { kind: "entity", entity: { id: entity, context: "subject" } } },
    { role: "value", target: { kind: "primitive", value } },
  ],
});
const fact = (entity: string, t: number, value: string): Delta =>
  makeDelta(claims(entity, t, value));
const arrival = (delta: Delta, sequence: number) => ({
  id: delta.id,
  at: 1,
  sequence,
  transfer: 1,
  sender: "local",
});
const batch = (deltas: readonly Delta[]) => ({
  expectedHead: null,
  nextHead: "h1",
  frame: null,
  added: deltas.map((delta, i) => ({ delta, arrival: arrival(delta, i + 1) })),
});

async function stores(): Promise<{ name: string; store: Store }[]> {
  return [
    { name: "memory", store: createMemoryStore() },
    { name: "sqlite", store: await openSqliteStore(newPath()) },
  ];
}

async function peerWith(deltas: readonly Delta[]): Promise<PeerStore> {
  const peer = await createMemoryStore().createPeer(PEER, { erasure: "unproven" });
  const result = await peer.append(batch(deltas));
  if (result.status !== "committed") throw new Error(`append answered ${result.status}`);
  return peer;
}

/** A snapshot that counts its `scope`, `targets` and `negators` calls. */
function counted(snapshot: Snapshot): { snapshot: Snapshot; calls: () => number } {
  let calls = 0;
  const wrapped = Object.create(snapshot) as Snapshot;
  for (const name of ["scope", "targets", "negators"] as const)
    Object.defineProperty(wrapped, name, {
      value: (...args: never[]) => {
        calls++;
        return (snapshot[name] as (...given: never[]) => unknown).apply(snapshot, args);
      },
    });
  return { snapshot: wrapped, calls: () => calls };
}

const listing = (deltas: readonly Delta[]): PeerExporter => ({
  async *ids() {
    for (const delta of deltas) yield delta.id;
  },
  async *deltas() {
    yield* deltas;
  },
});

describe("a signature and a validity end set only on Object.prototype read as absent", () => {
  it("sig: an append of an unsigned delta stores no sig on either store", async () => {
    const delta = fact("target", 1, "one");
    const seen: unknown[] = [];
    for (const { name, store } of await stores()) {
      const peer = await store.createPeer(PEER, { erasure: "unproven" });
      const status = await polluted(
        "sig",
        SIG,
        async () => (await peer.append(batch([delta]))).status,
      );
      const [held] = await (await peer.read()).get([delta.id]);
      seen.push([name, status, Object.hasOwn(held!, "sig")]);
      await store.close();
    }
    expect(seen).toEqual([
      ["memory", "committed", false],
      ["sqlite", "committed", false],
    ]);
  });

  it("validUntil: a delta made without one and appended under a polluted Object.prototype is stored without validUntil, and its id recomputes", async () => {
    const plain = fact("target", 1, "one");
    const seen: unknown[] = [];
    for (const { name, store } of await stores()) {
      const peer = await store.createPeer(PEER, { erasure: "unproven" });
      const status = await polluted(
        "validUntil",
        50,
        async () => (await peer.append(batch([plain]))).status,
      );
      const [held] = await (await peer.read()).get([plain.id]);
      seen.push([name, status, Object.hasOwn(held!.claims, "validUntil"), computeId(held!.claims)]);
      await store.close();
    }
    expect(seen).toEqual([
      ["memory", "committed", false, plain.id],
      ["sqlite", "committed", false, plain.id],
    ]);
  });

  it("validUntil: a delta whose id hashes a validUntil that only a prototype holds (a class getter, Object.create) is refused invalid-admission on either store, and the store keeps nothing", async () => {
    class Getter {
      get validUntil(): number {
        return 5;
      }
    }
    const shapes = {
      getter: () => Object.assign(new Getter(), claims("target", 1, "one")) as Claims,
      created: () =>
        Object.assign(Object.create({ validUntil: 5 }) as Claims, claims("target", 1, "one")),
    };
    const seen: unknown[] = [];
    for (const { name, store } of await stores()) {
      const peer = await store.createPeer(PEER, { erasure: "unproven" });
      for (const [shape, make] of Object.entries(shapes)) {
        const inherited = make();
        const delta = { id: computeId(inherited), claims: inherited };
        const answer = await outcome(async () => (await peer.append(batch([delta]))).status);
        const held = await (await peer.read()).get([delta.id]);
        const stored: string[] = [];
        for await (const id of store.openAdmin().storedIds()) stored.push(id);
        seen.push([name, shape, delta.id === fact("target", 1, "one").id, answer, held, stored]);
      }
      await store.close();
    }
    expect(seen).toEqual(
      ["memory", "sqlite"].flatMap((name) =>
        ["getter", "created"].map((shape) => [name, shape, false, "invalid-admission", [], []]),
      ),
    );
  });

  it("validUntil: under a polluted Object.prototype, readAnchored and fetchScope refuse invalid-request, and neither answers a window from the inherited field", async () => {
    const peer = await peerWith([fact("target", 1, "one")]);
    const snapshot = await peer.read();
    const answers = await polluted("validUntil", 50, async () => [
      await outcome(() => readAnchored(snapshot, { term: LEAF, root: "target", now: 10 })),
      await outcome(() => fetchScope(snapshot, ["target"])),
    ]);
    expect(answers).toEqual(["invalid-request", "invalid-request"]);
  });

  it("validUntil: validityWindow reads a validUntil that only a prototype holds as absent", () => {
    const inherited = Object.assign(
      Object.create({ validUntil: 50 }) as Claims,
      claims("target", 1, "one"),
    );
    const delta = { id: fact("target", 1, "one").id, claims: inherited };
    expect(validityWindow([delta], 10)).toEqual({ since: 1, expiresAt: null });
  });
});

describe("each own-fields site reads a field set only on Object.prototype as absent", () => {
  it("readAnchored, round: a round request with no own pushdown sends none and applies none", async () => {
    const peer = await peerWith([fact("target", 1, "one")]);
    const snapshot = await peer.read();
    const policy: RoundPolicy = {
      ...STANDARD_ROUNDS,
      request: (round) => {
        const { anchors, exclude } = STANDARD_ROUNDS.request(round);
        return { anchors, ...(exclude === undefined ? {} : { exclude }) };
      },
    };
    const read = () => readAnchoredWith(snapshot, { term: LEAF, root: "target", now: 10 }, policy);
    const plain = await read();
    const under = await polluted("pushdown", { timestampAtMost: 0 }, read);
    expect(under.members).toEqual(plain.members);
    expect(plain.members).toHaveLength(1);
  });

  it("follow: followFeed refuses a position with no own revision", async () => {
    const peer = await peerWith([fact("target", 1, "one")]);
    const { history } = await peer.read();
    const refused = await polluted("revision", 0, () =>
      outcome(async () => followFeed(peer, { history } as never) && "followed"),
    );
    expect(refused).toBe("invalid-request");
  });

  it("scopeSource, member: a member with no own arrival is refused", async () => {
    const delta = fact("target", 1, "one");
    const refused = await polluted("arrival", arrival(delta, 1), () =>
      outcome(async () => scopeSource([{ delta } as never]) && "built"),
    );
    expect(refused).toBe("invalid-request");
  });

  it("scopeSource, delta: a delta with no own id is refused", async () => {
    const delta = fact("target", 1, "one");
    const refused = await polluted("id", delta.id, () =>
      outcome(
        async () =>
          scopeSource([{ delta: { claims: delta.claims }, arrival: arrival(delta, 1) } as never]) &&
          "built",
      ),
    );
    expect(refused).toBe("invalid-request");
  });

  it("append: a batch with no own nextHead refuses invalid-admission", async () => {
    const delta = fact("target", 1, "one");
    const peer = await createMemoryStore().createPeer(PEER, { erasure: "unproven" });
    const { expectedHead, frame, added } = batch([delta]);
    const headless = { expectedHead, frame, added };
    const refused = await polluted("nextHead", "h1", () =>
      outcome(async () => (await peer.append(headless as never)).status),
    );
    expect(refused).toBe("invalid-admission");
  });

  it("scope: an entity anchor with no own entity refuses invalid-request", async () => {
    const peer = await peerWith([fact("target", 1, "one")]);
    const snapshot = await peer.read();
    const refused = await polluted("entity", "target", () =>
      outcome(
        async () => (await snapshot.scope({ anchors: [{ kind: "entity" } as never] })).deltas,
      ),
    );
    expect(refused).toBe("invalid-request");
  });

  it("fetchScope: a selection with no own pushdown trims nothing", async () => {
    const peer = await peerWith([fact("target", 1, "one"), fact("target", 2, "two")]);
    const snapshot = await peer.read();
    const fetched = await polluted("pushdown", { timestampAtMost: 0 }, () =>
      fetchScope(snapshot, ["target"], {}),
    );
    expect([...fetched.source.ids()]).toHaveLength(2);
  });

  it("captureScope: a selection with no own pushdown makes one store call", async () => {
    const peer = await peerWith([fact("target", 1, "one"), fact("target", 2, "two")]);
    const { snapshot, calls } = counted(await peer.read());
    await polluted("pushdown", { timestampAtMost: 0 }, () =>
      captureScope(snapshot, ["target"], 10, {}),
    );
    expect(calls()).toBe(1);
  });

  it("readFullSurface, request: a request with no own admits is not refused", async () => {
    const deltas = [fact("target", 1, "one")];
    const read = await polluted(
      "admits",
      () => true,
      () =>
        outcome(
          async () =>
            (await readFullSurface(listing(deltas), { term: LEAF, root: "target", now: 10 })).route
              .admitted,
        ),
    );
    expect(read).toBe(1);
  });

  it("readFullSurface, pushdown: a pushdown that is not a plain object is read by its own fields", async () => {
    const deltas = [fact("target", 1, "one"), fact("target", 2, "two")];
    const pushdown = new (class Pushdown {})();
    const read = await polluted("timestampAtMost", 0, () =>
      readFullSurface(listing(deltas), { term: LEAF, root: "target", now: 10, pushdown }),
    );
    expect(read.route.admitted).toBe(2);
  });

  it("StoreReactor.read: a request with no own registry consults none", async () => {
    const peer = await peerWith([fact("target", 1, "one")]);
    const term = parseTerm({
      op: "expand",
      role: { exact: "value" },
      schema: "Missing",
      in: LEAF_JSON,
    } as never);
    const registry = {
      resolve() {
        throw new Error("the polluted registry was read");
      },
    };
    const refused = await polluted("registry", registry, () =>
      outcome(() => StoreReactor.open(peer).read({ term, root: "target", now: 10 })),
    );
    expect(refused).toBe(UnanchoredTermError.name);
  });

  it("memory store: a changeRetention with no own revisions refuses invalid-request", async () => {
    const refused = await polluted("revisions", 3, () =>
      outcome(async () => createMemoryStore({ changeRetention: {} as never }).profile),
    );
    expect(refused).toBe("invalid-request");
  });

  it("memory store: no pushdown option keeps every pushdown field applied", async () => {
    const profile = await polluted(
      "timestampAtMost",
      false,
      async () => createMemoryStore().profile,
    );
    expect(profile.pushdown).toEqual({
      timestampAtMost: true,
      arrivalAtMost: true,
      excludeIds: true,
    });
  });

  it("sqlite store: a changeRetention with no own revisions refuses invalid-request", async () => {
    const path = newPath();
    const refused = await polluted("revisions", 3, () =>
      outcome(async () => {
        const store = await openSqliteStore(path, { changeRetention: {} as never });
        await store.close();
        return "opened";
      }),
    );
    expect(refused).toBe("invalid-request");
  });
});
