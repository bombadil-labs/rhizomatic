// The store interface and the memory reference store (SPEC-18 proposal, slice 1): what the
// shared vectors cannot say. The profile, opening by URL, ownership (vectors/store/README.md
// §6: what a caller holds reaches nothing in the store, and a value of the wrong type is refused,
// never converted), agreement with the SPEC-17 scope, the synchronous source over a fetched
// scope, and the cost rails.
//
// Ownership has one named gap: a caller that changes `Uint8Array.prototype` or the store's own
// class is not defended against, and no test here tries.
//
// Not covered here: the change feed, the journal, value and derived-index anchors, and any
// store but memory. Erasure is asserted at the index level and by report; the memory store
// cannot prove absence, and no test here claims it does.

import { runInNewContext } from "node:vm";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeId } from "../src/delta/delta.js";
import { makeDelta, makeNegationClaims } from "../src/delta/set.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import type { Delta, Pointer } from "../src/delta/types.js";
import { Reactor } from "../src/reactor/reactor.js";
import { scopeIds, type DeltaSource } from "../src/resolve/anchored.js";
import {
  createMemoryStore,
  MEMORY_STORE_FORMAT,
  type StoreMeter,
} from "../src/storage/memory-store.js";
import { openStore, registerStoreScheme } from "../src/storage/open-store.js";
import { scopeSource } from "../src/storage/scope-source.js";
import {
  missingRequirements,
  StoreError,
  type PeerStore,
  type Store,
  type VerifiedDelta,
} from "../src/storage/store.js";

const A = `ed25519:${"0a".repeat(32)}`;
const B = `ed25519:${"0b".repeat(32)}`;

const fact = (entity: string, value: number, timestamp = value): Delta =>
  makeDelta({
    timestamp,
    validFrom: timestamp,
    author: "did:key:zA",
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: entity, context: "v" } } },
      { role: "value", target: { kind: "primitive", value } },
    ],
  });
const strike = (target: Delta, timestamp: number): Delta =>
  makeDelta(makeNegationClaims("did:key:zB", timestamp, target.id));

/** Appends deltas with arrival sequences in the order given. */
async function fill(peer: PeerStore, deltas: readonly Delta[]): Promise<void> {
  const snapshot = await peer.read();
  const { head, count } = snapshot;
  snapshot.release();
  const result = await peer.append({
    expectedHead: head,
    nextHead: `head-${count + deltas.length}`,
    frame: null,
    added: deltas.map((delta, i) => ({
      delta,
      arrival: { id: delta.id, at: 1, sequence: count + i + 1, transfer: 1, sender: "local" },
    })),
  });
  expect(result.status).toBe("committed");
}

const code = async (action: () => Promise<unknown>): Promise<string> =>
  action().then(
    () => "no error",
    (error: unknown) => (error instanceof StoreError ? error.code : `not a StoreError: ${error}`),
  );

describe("the memory store's profile", () => {
  it("claims only what slice 1 implements", () => {
    expect(createMemoryStore().profile).toEqual({
      capabilities: {
        values: false,
        arrival: true,
        journal: false,
        views: false,
        derivedIndexes: false,
        digest: false,
        erasure: "unprovable",
      },
      indexedValueRoles: [],
      pushdown: { timestampAtMost: true, arrivalAtMost: true, excludeIds: true },
      writers: "one-process",
      atRest: "trusted",
      changeRetention: "none",
      formatVersion: MEMORY_STORE_FORMAT,
    });
  });

  it("serves no change feed, and says so instead of offering a method", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    expect("changes" in peer).toBe(false);
    expect(missingRequirements(store.profile, ["arrival", "changes", "purge"])).toEqual([
      "changes",
    ]);
  });

  it("names every requirement it lacks", () => {
    expect(
      missingRequirements(createMemoryStore().profile, [
        "values",
        "arrival",
        "journal",
        "views",
        "derivedIndexes",
        "digest",
        "changes",
        "purge",
        "erasure-proven",
      ]),
    ).toEqual([
      "values",
      "journal",
      "views",
      "derivedIndexes",
      "digest",
      "changes",
      "erasure-proven",
    ]);
  });
});

describe("requirements are an allow-list", () => {
  const profile = createMemoryStore().profile;
  it("refuses a name that is not a requirement, and names it", () => {
    // `erasure` holds a string and the others are inherited: none may read as satisfied.
    for (const name of ["erasure", "constructor", "toString", "__proto__", "hasOwnProperty", ""]) {
      const attempt = (): unknown => missingRequirements(profile, [name as "values"]);
      expect(attempt).toThrow(StoreError);
      expect(attempt).toThrow(`unknown store requirement: ${name}`);
    }
  });

  it("openStore refuses an unknown requirement instead of opening", async () => {
    expect(await code(() => openStore("memory:", { requires: ["erasure" as "purge"] }))).toBe(
      "invalid-request",
    );
  });

  it("openStore refuses options that are not of their type, with one fixed message", async () => {
    const message = "openStore: the options must be an object, and requires a list of names";
    const wrong: unknown[] = [
      null,
      "journal",
      5,
      [],
      ["journal"],
      () => ({}),
      new Map(),
      { requires: "journal" },
      { requires: 5 },
      { requires: null },
      { requires: { filter: () => [] } },
      { requires: new Set(["journal"]) },
      { requires: [5] },
      { requires: [new String("journal")] },
      {
        get requires(): never {
          throw new Error("a getter that throws");
        },
      },
    ];
    for (const options of wrong) {
      const opening = openStore("memory:", options as never);
      await expect(opening, String(options)).rejects.toThrow(StoreError);
      await expect(openStore("memory:", options as never)).rejects.toThrow(message);
      expect(await code(() => openStore("memory:", options as never))).toBe("invalid-request");
    }
    // Absent options, and absent `requires`, mean none.
    for (const options of [undefined, {}, { requires: undefined }, Object.create(null) as object])
      expect((await openStore("memory:", options as never)).profile.formatVersion).toBe(
        MEMORY_STORE_FORMAT,
      );
  });

  it("openStore reads its options once and hands the factory its own copy", async () => {
    let reads = 0;
    const options = {
      get requires(): string[] {
        return reads++ === 0 ? [] : ["journal"];
      },
    };
    expect(await code(() => openStore("memory:", options as never))).toBe("no error");
    expect(reads).toBe(1);

    const given: unknown[] = [];
    const remove = registerStoreScheme("read-once", async (_url, seen) => {
      given.push(seen);
      return createMemoryStore();
    });
    try {
      const requires: ("arrival" | "journal")[] = ["arrival"];
      await openStore("read-once:", { requires });
      expect(given).toHaveLength(1);
      expect(given[0]).toEqual({ requires: ["arrival"] });
      expect((given[0] as { requires: unknown }).requires).not.toBe(requires);
    } finally {
      remove();
    }
  });

  it("a capability counts only when it is exactly true", () => {
    const odd = {
      ...profile,
      capabilities: { ...profile.capabilities, journal: "yes" as unknown as boolean },
    };
    expect(missingRequirements(odd, ["journal"])).toEqual(["journal"]);
  });
});

describe("openStore", () => {
  const SECRET = "hunter2-do-not-print";

  it("opens a new empty memory store for memory:", async () => {
    const one = await openStore("memory:");
    const two = await openStore("memory:");
    await one.createPeer(A, { erasure: "unproven" });
    expect(one.profile.formatVersion).toBe(MEMORY_STORE_FORMAT);
    expect(await code(() => two.peer(A))).toBe("peer-absent");
  });

  it("echoes nothing from a URL it cannot route", async () => {
    // The text before the first colon of a malformed connection string can be a credential.
    const urls = [
      `postgres://admin:${SECRET}@db.example/loam`,
      `${SECRET}:5432/loam`,
      `${SECRET}`,
      `://${SECRET}`,
      ` ${SECRET}:x`,
      "",
    ];
    const messages = new Set<string>();
    for (const url of urls) {
      const error = (await openStore(url).catch((e: unknown) => e)) as StoreError;
      expect(error).toBeInstanceOf(StoreError);
      expect(error.code).toBe("unknown-scheme");
      expect(error.message + String(error.stack)).not.toContain(SECRET);
      expect(error.message).not.toContain("postgres");
      messages.add(error.message);
    }
    expect(messages.size).toBe(1);
    expect(await code(() => openStore(undefined as unknown as string))).toBe("unknown-scheme");
  });

  it("a registered scheme may be named; its address is not echoed", async () => {
    const error = (await openStore(`memory:${SECRET}`).catch((e: unknown) => e)) as StoreError;
    expect(error.code).toBe("invalid-url");
    expect(error.message).toContain('"memory"');
    expect(error.message).not.toContain(SECRET);
  });

  it("invalid-url has two causes; a URL that cannot be routed is unknown-scheme", async () => {
    expect(await code(() => openStore("memory:somewhere"))).toBe("invalid-url");
    const register = (name: string): string => {
      try {
        registerStoreScheme(name, async () => createMemoryStore())();
        return "registered";
      } catch (error) {
        return (error as StoreError).code;
      }
    };
    expect(register("1abc")).toBe("invalid-url");
    expect(register("a b")).toBe("invalid-url");
    expect(register("fine+scheme")).toBe("registered");
    for (const url of ["", "no scheme here", "1abc:x", "a b:x", "nobody:x"])
      expect(await code(() => openStore(url))).toBe("unknown-scheme");
  });

  it("matches the scheme without regard to case", async () => {
    for (const url of ["MEMORY:", "Memory:", "mEmOrY:"])
      expect((await openStore(url)).profile.formatVersion).toBe(MEMORY_STORE_FORMAT);
    const seen: string[] = [];
    const remove = registerStoreScheme("Mixed+Case", async (url) => {
      seen.push(url);
      return createMemoryStore();
    });
    try {
      await openStore("mixed+case://x");
      await openStore("MIXED+CASE://y");
      expect(seen).toEqual(["mixed+case://x", "MIXED+CASE://y"]);
      expect(() => registerStoreScheme("mixed+case", async () => createMemoryStore())).toThrow(
        /already registered/,
      );
    } finally {
      remove();
    }
  });

  it("a close that fails does not replace the missing-capability refusal", async () => {
    const remove = registerStoreScheme("badclose", async (url) => ({
      ...createMemoryStore(),
      close: async () => {
        throw new Error(`cannot close ${url}`);
      },
    }));
    try {
      const error = (await openStore(`badclose://u:${SECRET}@h`, {
        requires: ["journal"],
      }).catch((e: unknown) => e)) as StoreError;
      expect(error).toBeInstanceOf(StoreError);
      expect(error.code).toBe("capability-absent");
      expect(error.message).not.toContain(SECRET);
    } finally {
      remove();
    }
  });

  it("passes a factory's own StoreError through", async () => {
    const remove = registerStoreScheme("own", async () => {
      throw new StoreError("invalid-url", "the factory's own words");
    });
    try {
      const error = (await openStore("own:x").catch((e: unknown) => e)) as StoreError;
      expect([error.code, error.message]).toEqual(["invalid-url", "the factory's own words"]);
    } finally {
      remove();
    }
  });

  it("hides a factory's own error text, which may quote the URL", async () => {
    const remove = registerStoreScheme("leaky", async (url) => {
      throw new Error(`cannot connect to ${url}`);
    });
    try {
      const error = (await openStore(`leaky://u:${SECRET}@h`).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("open-failed");
      expect(error.message).toContain('"leaky"');
      expect(error.message + String(error.stack) + String(error.cause)).not.toContain(SECRET);
    } finally {
      remove();
    }
  });

  it("opens a registered scheme, passes the URL to its factory, and forgets it on removal", async () => {
    const seen: string[] = [];
    const remove = registerStoreScheme("mine", async (url) => {
      seen.push(url);
      return createMemoryStore();
    });
    expect((await openStore("mine://somewhere")).profile.formatVersion).toBe(MEMORY_STORE_FORMAT);
    expect(seen).toEqual(["mine://somewhere"]);
    expect(() => registerStoreScheme("mine", async () => createMemoryStore())).toThrow(StoreError);
    remove();
    expect(await code(() => openStore("mine://somewhere"))).toBe("unknown-scheme");
  });

  it("does not let a consumer replace a built-in scheme or register a malformed one", () => {
    const factory = async (): Promise<Store> => createMemoryStore();
    expect(() => registerStoreScheme("memory", factory)).toThrow(/already registered/);
    expect(() => registerStoreScheme("MEMORY", factory)).toThrow(/already registered/);
    for (const scheme of ["", "a:b", "1abc", "a b", "é"]) {
      expect(() => registerStoreScheme(scheme, factory)).toThrow(StoreError);
      if (scheme !== "") expect(() => registerStoreScheme(scheme, factory)).not.toThrow(scheme);
    }
  });

  it("refuses to open when a required capability is absent, naming each", async () => {
    const error = (await openStore("memory:", {
      requires: ["arrival", "journal", "erasure-proven"],
    }).catch((e: unknown) => e)) as StoreError;
    expect(error.code).toBe("capability-absent");
    expect(error.message).toContain("journal, erasure-proven");
    expect(error.message).not.toContain("arrival");
    await expect(openStore("memory:", { requires: ["arrival", "purge"] })).resolves.toBeDefined();
  });
});

describe("the memory store", () => {
  it("refuses every operation after close", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const snapshot = await peer.read();
    await store.close();
    expect(await code(() => store.createPeer(B, { erasure: "unproven" }))).toBe("store-closed");
    expect(await code(() => store.peer(A))).toBe("store-closed");
    expect(await code(() => peer.read())).toBe("store-closed");
    expect(await code(() => peer.purge([]))).toBe("store-closed");
    expect(await code(() => snapshot.get([]))).toBe("store-closed");
    expect(() => store.openAdmin()).toThrow(StoreError);
  });

  it("requires a declared posture and a peer id", async () => {
    const store = createMemoryStore();
    const undeclared = {} as { erasure: "unproven" };
    expect(await code(() => store.createPeer(A, undeclared))).toBe("invalid-request");
    expect(await code(() => store.createPeer("", { erasure: "unproven" }))).toBe("invalid-request");
    expect(await code(() => store.createPeer(A, { erasure: "proven" }))).toBe("posture-refused");
    // The refused peer was not created on the way to the refusal.
    expect(await code(() => store.peer(A))).toBe("peer-absent");
  });

  it("refuses an empty next head and malformed arrival fields, and commits nothing", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const delta = fact("e", 1);
    const arrival = { id: delta.id, at: 1, sequence: 1, transfer: 1, sender: "local" };
    const attempt = (nextHead: string, patch: object): Promise<unknown> =>
      peer.append({
        expectedHead: null,
        nextHead,
        frame: null,
        added: [{ delta, arrival: { ...arrival, ...patch } }],
      });
    expect(await code(() => attempt("", {}))).toBe("invalid-admission");
    for (const patch of [
      { sequence: 0 },
      { sequence: 1.5 },
      { transfer: 0 },
      { at: Number.NaN },
      { sender: "" },
    ])
      expect(await code(() => attempt("h", patch))).toBe("invalid-admission");
    const snapshot = await peer.read();
    expect([snapshot.revision, snapshot.head, snapshot.count]).toEqual([0, null, 0]);
  });

  it("refuses an anchor kind it has no index for", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const snapshot = await peer.read();
    const value = { kind: "value", role: "height" } as unknown as {
      kind: "entity";
      entity: string;
    };
    expect(await code(() => snapshot.scope({ anchors: [value] }))).toBe("capability-absent");
  });
});

describe("a store owns what it holds", () => {
  const signedClaims = (): Delta["claims"] => ({
    timestamp: 5,
    validFrom: 5,
    author: authorForSeed("01".repeat(32)),
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: "e", context: "v" } } },
      { role: "value", target: { kind: "primitive", value: "original" } },
      { role: "blob", target: { kind: "bytes", mime: "x/y", value: new Uint8Array([1, 2, 3]) } },
    ],
  });

  /** Two peers that both admitted one signed delta, from separate caller objects. */
  async function twoPeers(): Promise<{
    a: PeerStore;
    b: PeerStore;
    id: string;
    given: VerifiedDelta;
    pristine: string;
  }> {
    const store = createMemoryStore();
    const a = await store.createPeer(A, { erasure: "unproven" });
    const b = await store.createPeer(B, { erasure: "unproven" });
    const delta = signClaims(signedClaims(), "01".repeat(32));
    const given: VerifiedDelta = {
      delta,
      arrival: { id: delta.id, at: 10, sequence: 1, transfer: 1, sender: "local" },
    };
    const head = { expectedHead: null, nextHead: "h", frame: null };
    expect((await a.append({ ...head, added: [given] })).status).toBe("committed");
    const other = signClaims(signedClaims(), "01".repeat(32));
    expect(
      (
        await b.append({
          ...head,
          added: [{ delta: other, arrival: { ...given.arrival, sequence: 4, sender: A } }],
        })
      ).status,
    ).toBe("committed");
    return { a, b, id: delta.id, given, pristine: JSON.stringify(await view(a, delta.id)) };
  }

  /** Everything a reader can see of one id, bytes included. */
  async function view(peer: PeerStore, id: string): Promise<unknown> {
    const snapshot = await peer.read();
    const [delta] = await snapshot.get([id]);
    const [arrival] = await snapshot.arrivals([id]);
    const scope = await snapshot.scope({ anchors: [{ kind: "entity", entity: "e" }] });
    const plain = (d: Delta | undefined): unknown =>
      d && {
        id: d.id,
        sig: d.sig,
        claims: {
          ...d.claims,
          pointers: d.claims.pointers.map((p) =>
            p.target.kind === "bytes"
              ? { ...p, target: { ...p.target, value: [...p.target.value] } }
              : p,
          ),
        },
      };
    return {
      delta: plain(delta),
      arrival,
      scope: scope.deltas.map((m) => [plain(m.delta), m.arrival]),
      targets: await snapshot.targets(["e", "moved"]),
    };
  }

  type Loose = {
    -readonly [K in keyof VerifiedDelta]: {
      -readonly [F in keyof VerifiedDelta[K]]: unknown;
    };
  };
  /** Changes every part of an object a caller holds: claims, bytes, signature, arrival. */
  function vandalize(entry: VerifiedDelta): void {
    const loose = entry as unknown as Loose;
    const claims = entry.delta.claims as unknown as {
      timestamp: number;
      author: string;
      pointers: { role: string; target: Record<string, unknown> }[];
    };
    claims.timestamp = 999;
    claims.author = "did:key:zMallory";
    (claims.pointers[0]!.target["entity"] as { id: string }).id = "moved";
    claims.pointers[1]!.target["value"] = "changed";
    (claims.pointers[2]!.target["value"] as Uint8Array)[0] = 9;
    claims.pointers.push({ role: "extra", target: { kind: "primitive", value: 1 } });
    loose.delta.sig = "00".repeat(64);
    loose.delta.id = "1e20" + "00".repeat(32);
    const arrival = loose.arrival as Record<string, unknown>;
    arrival["sequence"] = 77;
    arrival["sender"] = "mallory";
    arrival["at"] = -1;
    arrival["id"] = "other";
  }

  it("changing an object after appending it changes nothing in the store", async () => {
    const { a, b, id, given, pristine } = await twoPeers();
    const before = JSON.stringify(await view(b, id));
    vandalize(given);
    expect(JSON.stringify(await view(a, id))).toBe(pristine);
    expect(JSON.stringify(await view(b, id))).toBe(before);
  });

  it("changing what a read returned changes nothing in the store, for either peer", async () => {
    const { a, b, id, pristine } = await twoPeers();
    const before = JSON.stringify(await view(b, id));
    const snapshot = await a.read();
    const [delta] = await snapshot.get([id]);
    const [arrival] = await snapshot.arrivals([id]);
    const scope = await snapshot.scope({ anchors: [{ kind: "entity", entity: "e" }] });
    vandalize({ delta: delta!, arrival: arrival! });
    vandalize(scope.deltas[0]!);
    expect(JSON.stringify(await view(a, id))).toBe(pristine);
    expect(JSON.stringify(await view(b, id))).toBe(before);
    // Each peer still reads its own arrival record, not the other's.
    expect(
      [(await view(a, id)) as { arrival: { sequence: number } }].map((v) => v.arrival.sequence),
    ).toEqual([1]);
    expect(
      [(await view(b, id)) as { arrival: { sequence: number } }].map((v) => v.arrival.sequence),
    ).toEqual([4]);
  });

  it("changing what the exporter returned changes nothing in the store", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const delta = makeDelta(signedClaims());
    await fill(peer, [delta]);
    const pristine = JSON.stringify(await view(peer, delta.id));
    for await (const exported of store.openAdmin().peer(A).deltas())
      vandalize({
        delta: exported,
        arrival: { id: "", at: 0, sequence: 0, transfer: 0, sender: "" },
      });
    expect(JSON.stringify(await view(peer, delta.id))).toBe(pristine);
  });

  it("a Buffer payload is copied, not viewed: two peers, after append and after read", async () => {
    // `Buffer.prototype.slice` returns a view of the same memory, unlike Uint8Array's.
    const store = createMemoryStore();
    const a = await store.createPeer(A, { erasure: "unproven" });
    const b = await store.createPeer(B, { erasure: "unproven" });
    const payload = Buffer.from([1, 2, 3, 4]);
    const delta = makeDelta({
      timestamp: 1,
      validFrom: 1,
      author: "did:key:zA",
      pointers: [
        { role: "subject", target: { kind: "entity", entity: { id: "e" } } },
        { role: "blob", target: { kind: "bytes", mime: "x/y", value: payload } },
      ],
    });
    await fill(a, [delta]);
    await fill(b, [delta]);
    const bytes = async (peer: PeerStore): Promise<Uint8Array> => {
      const [held] = await (await peer.read()).get([delta.id]);
      const target = held!.claims.pointers[1]!.target;
      if (target.kind !== "bytes") throw new Error("not a bytes target");
      return target.value;
    };
    payload[0] = 99;
    payload.fill(7, 1);
    expect([...(await bytes(a))]).toEqual([1, 2, 3, 4]);
    expect([...(await bytes(b))]).toEqual([1, 2, 3, 4]);

    const read = await bytes(a);
    read[0] = 55;
    Buffer.from(read.buffer).fill(66);
    expect([...(await bytes(a))]).toEqual([1, 2, 3, 4]);
    expect([...(await bytes(b))]).toEqual([1, 2, 3, 4]);
    const scope = await (await b.read()).scope({ anchors: [{ kind: "entity", entity: "e" }] });
    const scoped = scope.deltas[0]!.delta.claims.pointers[1]!.target;
    expect(scoped.kind === "bytes" && [...scoped.value]).toEqual([1, 2, 3, 4]);
  });

  it("the public profile is not what the store decides by", async () => {
    const store = createMemoryStore();
    type Loose = { capabilities: { erasure: string }; pushdown: Record<string, boolean> };
    const loose = store.profile as unknown as Loose;
    // A write to a frozen object throws in a module. Either way it must change nothing.
    expect(() => {
      loose.capabilities.erasure = "proven";
    }).toThrow(TypeError);
    expect(() => {
      loose.pushdown["timestampAtMost"] = false;
    }).toThrow(TypeError);
    expect(() => {
      (store.profile as unknown as { capabilities: object }).capabilities = { erasure: "proven" };
    }).toThrow(TypeError);
    expect(store.profile.capabilities.erasure).toBe("unprovable");
    expect(Object.isFrozen(store.profile.indexedValueRoles)).toBe(true);

    // Even a caller who replaces the public object outright does not move the gate.
    Object.defineProperty(store, "profile", {
      value: {
        ...store.profile,
        capabilities: { ...store.profile.capabilities, erasure: "proven" },
        pushdown: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
      },
    });
    expect(store.profile.capabilities.erasure).toBe("proven");
    expect(await code(() => store.createPeer(A, { erasure: "proven" }))).toBe("posture-refused");
    const peer = await store.createPeer(A, { erasure: "unproven" });
    expect(peer.erasure.storeClass).toBe("unprovable");
    await fill(peer, [fact("e", 5), fact("e", 50)]);
    const result = await (
      await peer.read()
    ).scope({
      anchors: [{ kind: "entity", entity: "e" }],
      pushdown: { timestampAtMost: 10 },
    });
    expect(result.applied.timestampAtMost).toBe(true);
    expect(result.deltas).toHaveLength(1);
  });

  it("nothing the store decides by is a property a cast can reach", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    await fill(peer, [fact("e", 5), fact("e", 50)]);
    // The public profile is the store's only own property.
    expect(Reflect.ownKeys(store)).toEqual(["profile"]);
    const loose = store as unknown as Record<string, unknown>;
    for (const name of ["own", "rows", "peers", "meter", "closed"])
      expect([name, loose[name]]).toEqual([name, undefined]);

    // A caller who plants the names a cast used to reach changes nothing.
    loose["own"] = {
      capabilities: { erasure: "proven" },
      pushdown: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
    };
    loose["peers"] = new Map();
    loose["rows"] = new Map();
    expect(await code(() => store.createPeer(B, { erasure: "proven" }))).toBe("posture-refused");
    expect((await store.createPeer(B, { erasure: "unproven" })).erasure.storeClass).toBe(
      "unprovable",
    );
    expect((await store.peer(A)).id).toBe(A);
    const result = await (
      await peer.read()
    ).scope({ anchors: [{ kind: "entity", entity: "e" }], pushdown: { timestampAtMost: 10 } });
    expect([result.applied.timestampAtMost, result.deltas.length]).toEqual([true, 1]);

    await store.close();
    loose["closed"] = false;
    expect(await code(() => peer.read())).toBe("store-closed");
  });

  it("handles, snapshots, reports and lists are the caller's to change", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const one = fact("e", 1);
    const two = fact("e", 2);
    const added = await peer.append({
      expectedHead: null,
      nextHead: "h",
      frame: null,
      added: [one, two].map((delta, i) => ({
        delta,
        arrival: { id: delta.id, at: 1, sequence: i + 1, transfer: 1, sender: "local" },
      })),
    });
    type Open = Record<string, unknown>;
    if (added.status !== "committed") throw new Error("not committed");
    (added.added as string[]).length = 0;
    (added as Open)["revision"] = 99;
    (peer.erasure as Open)["storeClass"] = "proven";
    (peer.erasure as Open)["posture"] = "proven";
    (peer as unknown as Open)["id"] = B;

    const snapshot = await peer.read();
    (snapshot as unknown as Open)["revision"] = 99;
    (snapshot as unknown as Open)["head"] = "other";
    (snapshot as unknown as Open)["count"] = 0;
    const ids = (await snapshot.targets(["e"])) as string[];
    ids.reverse();
    ids.push("x");
    const arrivals = await snapshot.arrivals([one.id]);
    (arrivals as unknown[]).length = 0;

    // The snapshot still answers at its own revision, and a new handle reports the truth.
    expect(await snapshot.targets(["e"])).toEqual([one.id, two.id].sort());
    expect(await snapshot.arrivals([one.id])).toHaveLength(1);
    const again = await store.peer(A);
    expect([again.id, again.erasure]).toEqual([
      A,
      { posture: "unproven", storeClass: "unprovable" },
    ]);
    const now = await again.read();
    expect([now.revision, now.head, now.count]).toEqual([1, "h", 2]);

    const report = await peer.purge([one.id]);
    (report.targets as unknown[]).length = 0;
    (report.surfaces as unknown[]).length = 0;
    (report as Open)["revision"] = 99;
    const after = await again.read();
    expect([after.revision, after.count]).toEqual([2, 1]);
    expect((await again.purge([one.id])).surfaces).toHaveLength(3);
  });

  it("fields outside the canonical claims are not stored and not served", async () => {
    const store = createMemoryStore();
    const a = await store.createPeer(A, { erasure: "unproven" });
    const b = await store.createPeer(B, { erasure: "unproven" });
    const clean = fact("e", 1);
    const padded = {
      ...clean,
      note: "on the delta",
      claims: {
        ...clean.claims,
        secret: "on the claims",
        pointers: clean.claims.pointers.map((p) => ({
          ...p,
          hidden: 1,
          target: { ...p.target, smuggled: true },
        })),
      },
    } as unknown as Delta;
    const arrival = { id: clean.id, at: 1, sequence: 1, transfer: 1, sender: "local", extra: "x" };
    const head = { expectedHead: null, nextHead: "h", frame: null };
    await a.append({ ...head, added: [{ delta: padded, arrival }] });
    await b.append({ ...head, added: [{ delta: clean, arrival }] });
    for (const peer of [a, b]) {
      const snapshot = await peer.read();
      const seen = JSON.stringify([
        await snapshot.get([clean.id]),
        await snapshot.arrivals([clean.id]),
        await snapshot.scope({ anchors: [{ kind: "entity", entity: "e" }] }),
      ]);
      for (const word of ["secret", "hidden", "smuggled", "note", "extra"])
        expect(seen).not.toContain(word);
      expect((await snapshot.get([clean.id]))[0]).toEqual(clean);
    }
  });
});

// ---- what a caller can pass, position by position -------------------------------------------

/** Claims with one bytes pointer, and the id those claims have with `bytes` as the payload. */
const blobClaims = (value: unknown): Delta["claims"] => ({
  timestamp: 1,
  validFrom: 1,
  author: "did:key:zA",
  pointers: [
    { role: "subject", target: { kind: "entity", entity: { id: "e" } } },
    { role: "blob", target: { kind: "bytes", mime: "x/y", value: value as Uint8Array } },
  ],
});
const blobId = (bytes: readonly number[]): string =>
  makeDelta(blobClaims(new Uint8Array(bytes))).id;
const blobOf = (delta: Delta | undefined): Uint8Array => {
  const target = delta?.claims.pointers[1]?.target;
  if (target?.kind !== "bytes") throw new Error("not a bytes target");
  return target.value;
};
const local = (id: string, sequence = 1): VerifiedDelta["arrival"] => ({
  id,
  at: 1,
  sequence,
  transfer: 1,
  sender: "local",
});
class Tagged extends Uint8Array {}

// Each payload is not a Uint8Array. `bytes` is what a store that converted it would hold; the
// entry carries the id of that repaired form, so only a store that converts can admit it.
const NOT_BYTES: readonly { name: string; value: unknown; bytes: readonly number[] }[] = [
  { name: "an ArrayBuffer", value: new Uint8Array([1, 2, 3]).buffer, bytes: [1, 2, 3] },
  {
    name: "a SharedArrayBuffer",
    value: (() => {
      const shared = new SharedArrayBuffer(3);
      new Uint8Array(shared).set([1, 2, 3]);
      return shared;
    })(),
    bytes: [1, 2, 3],
  },
  { name: "a Uint16Array", value: new Uint16Array([257]), bytes: [1] },
  { name: "a Uint8ClampedArray", value: new Uint8ClampedArray([1, 2]), bytes: [1, 2] },
  { name: "a DataView", value: new DataView(new ArrayBuffer(2)), bytes: [] },
  { name: "a number", value: 3, bytes: [0, 0, 0] },
  { name: "a list of numbers", value: [1, 2, 3], bytes: [1, 2, 3] },
  { name: "a string", value: "abc", bytes: [] },
  { name: "null", value: null, bytes: [] },
  {
    // `computeId` refuses it (it is no instance of this realm's Uint8Array), so the store does.
    name: "a Uint8Array of another realm",
    value: runInNewContext("new Uint8Array([1, 2, 3])"),
    bytes: [1, 2, 3],
  },
  {
    // It passes `instanceof`, and its own iterator lets the constructor convert it.
    name: "an object that only inherits from Uint8Array.prototype",
    value: Object.create(Uint8Array.prototype, {
      length: { value: 2 },
      0: { value: 1 },
      1: { value: 2 },
      [Symbol.iterator]: { value: () => [1, 2].values() },
    }),
    bytes: [1, 2],
  },
];

// Each payload is a Uint8Array. `poke` changes the memory the caller still holds.
const BYTES: readonly { name: string; make: () => { value: Uint8Array; poke: () => void } }[] = [
  {
    name: "a Buffer",
    make: () => {
      const value = Buffer.from([1, 2, 3]);
      return { value, poke: () => value.fill(9) };
    },
  },
  {
    name: "a Uint8Array subclass",
    make: () => {
      const value = Tagged.from([1, 2, 3]);
      return { value, poke: () => value.fill(9) };
    },
  },
  {
    name: "a Uint8Array over a SharedArrayBuffer",
    make: () => {
      const shared = new SharedArrayBuffer(3);
      const value = new Uint8Array(shared);
      value.set([1, 2, 3]);
      return { value, poke: () => new Uint8Array(shared).fill(9) };
    },
  },
  {
    name: "a Uint8Array that views part of a larger buffer",
    make: () => {
      const whole = new Uint8Array([7, 1, 2, 3, 7]);
      return { value: whole.subarray(1, 4), poke: () => whole.fill(9) };
    },
  },
];

type Loose = Record<string, unknown>;
/** A well-formed entry, changed in one position by `change`. */
function entryWith(
  change: (parts: { entry: Loose; delta: Loose; claims: Loose; arrival: Loose }) => void,
): { entry: VerifiedDelta; id: string } {
  const delta = signClaims(
    {
      timestamp: 5,
      validFrom: 5,
      validUntil: 9,
      author: authorForSeed("01".repeat(32)),
      pointers: [
        { role: "subject", target: { kind: "entity", entity: { id: "e", context: "v" } } },
        { role: "value", target: { kind: "primitive", value: "v" } },
        { role: "about", target: { kind: "delta", deltaRef: { delta: "1e20aa", context: "c" } } },
        { role: "blob", target: { kind: "bytes", mime: "x/y", value: new Uint8Array([1]) } },
      ],
    },
    "01".repeat(32),
  );
  const claims = structuredClone(delta.claims) as unknown as Loose;
  const loose = { id: delta.id, claims, sig: delta.sig } as Loose;
  const arrival = { ...local(delta.id) } as Loose;
  const entry: Loose = { delta: loose, arrival };
  change({ entry, delta: loose, claims, arrival });
  return { entry: entry as unknown as VerifiedDelta, id: delta.id };
}
const pointer = (claims: Loose, index: number): { role: unknown; target: Loose } =>
  (claims["pointers"] as { role: unknown; target: Loose }[])[index]!;

// One value of the wrong type in each position of an entry. None is a value the store may
// convert: a store that did would hold something the caller never gave.
const WRONG: Readonly<Record<string, Parameters<typeof entryWith>[0]>> = {
  "the entry is null": () => {},
  "the delta is absent": (e) => {
    delete e.delta["claims"];
    delete e.delta["id"];
  },
  "the id is a String object": (e) => {
    e.delta["id"] = new String(e.delta["id"]);
  },
  "the claims are null": (e) => {
    e.delta["claims"] = null;
  },
  "the claims are a list": (e) => {
    e.delta["claims"] = [];
  },
  "the timestamp is a numeric string": (e) => {
    e.claims["timestamp"] = "5";
  },
  "the timestamp is a Number object": (e) => {
    e.claims["timestamp"] = new Number(5);
  },
  "the timestamp is a bigint": (e) => {
    e.claims["timestamp"] = 5n;
  },
  "validFrom is absent": (e) => {
    delete e.claims["validFrom"];
  },
  "validUntil is null": (e) => {
    e.claims["validUntil"] = null;
  },
  "validUntil is a string": (e) => {
    e.claims["validUntil"] = "9";
  },
  "the author is a String object": (e) => {
    e.claims["author"] = new String(e.claims["author"]);
  },
  "the author is a list of one string": (e) => {
    e.claims["author"] = [e.claims["author"]];
  },
  "the pointers are an object with indexes": (e) => {
    e.claims["pointers"] = { ...(e.claims["pointers"] as object), length: 4 };
  },
  "the pointers are a Set": (e) => {
    e.claims["pointers"] = new Set(e.claims["pointers"] as unknown[]);
  },
  "a pointer is null": (e) => {
    (e.claims["pointers"] as unknown[])[1] = null;
  },
  "a role is a number": (e) => {
    pointer(e.claims, 0).role = 7;
  },
  "a target is a string": (e) => {
    (pointer(e.claims, 0) as Loose)["target"] = "e";
  },
  "a target kind is unknown": (e) => {
    pointer(e.claims, 0).target["kind"] = "thing";
  },
  "an entity id is a number": (e) => {
    (pointer(e.claims, 0).target["entity"] as Loose)["id"] = 5;
  },
  "an entity context is a number": (e) => {
    (pointer(e.claims, 0).target["entity"] as Loose)["context"] = 5;
  },
  "an entity context is null": (e) => {
    (pointer(e.claims, 0).target["entity"] as Loose)["context"] = null;
  },
  "a primitive value is null": (e) => {
    pointer(e.claims, 1).target["value"] = null;
  },
  "a primitive value is an object": (e) => {
    pointer(e.claims, 1).target["value"] = { toString: () => "v" };
  },
  "a primitive value is a bigint": (e) => {
    pointer(e.claims, 1).target["value"] = 1n;
  },
  "a delta reference is a number": (e) => {
    (pointer(e.claims, 2).target["deltaRef"] as Loose)["delta"] = 5;
  },
  "a mime type is a number": (e) => {
    pointer(e.claims, 3).target["mime"] = 5;
  },
  "the signature is a number": (e) => {
    e.delta["sig"] = 7;
  },
  "the signature is null": (e) => {
    e.delta["sig"] = null;
  },
  "the signature is a String object": (e) => {
    e.delta["sig"] = new String(e.delta["sig"]);
  },
  "the signature is a list of its characters": (e) => {
    e.delta["sig"] = [...(e.delta["sig"] as string)];
  },
  "the delta is null": (e) => {
    e.entry["delta"] = null;
  },
  "the arrival record is null": (e) => {
    e.entry["arrival"] = null;
  },
  "the arrival record is absent": (e) => {
    delete e.entry["arrival"];
  },
  "the arrival record is empty": (e) => {
    for (const key of Object.keys(e.arrival)) delete e.arrival[key];
  },
  "the arrival id is a String object": (e) => {
    e.arrival["id"] = new String(e.arrival["id"]);
  },
  "the arrival time is a string": (e) => {
    e.arrival["at"] = "1";
  },
  "the arrival time is a Date": (e) => {
    e.arrival["at"] = new Date(1);
  },
  "the sequence is a numeric string": (e) => {
    e.arrival["sequence"] = "1";
  },
  "the sequence is a bigint": (e) => {
    e.arrival["sequence"] = 1n;
  },
  "the sequence is a Number object": (e) => {
    e.arrival["sequence"] = new Number(1);
  },
  "the transfer is a numeric string": (e) => {
    e.arrival["transfer"] = "1";
  },
  "the sender is a String object": (e) => {
    e.arrival["sender"] = new String("local");
  },
  "the sender is a list of one string": (e) => {
    e.arrival["sender"] = ["local"];
  },
  "the sender is an object": (e) => {
    e.arrival["sender"] = { toString: () => "local" };
  },
};

describe("a store refuses what is not of its type, and converts nothing", () => {
  const head = { expectedHead: null, nextHead: "h", frame: null };
  /** Nothing of a refused append is left: no holding, no bytes, no head, no revision. */
  async function untouched(store: Store, peer: PeerStore): Promise<void> {
    const snapshot = await peer.read();
    expect([snapshot.revision, snapshot.head, snapshot.count]).toEqual([0, null, 0]);
    const stored: string[] = [];
    for await (const id of store.openAdmin().storedIds()) stored.push(id);
    expect(stored).toEqual([]);
  }

  it("the well-formed entry these cases start from is admitted", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const { entry, id } = entryWith(() => {});
    expect(await peer.append({ ...head, added: [entry] })).toMatchObject({ added: [id] });
  });

  for (const { name, value, bytes } of NOT_BYTES) {
    it(`a bytes payload that is ${name} is refused, in append and in scopeSource`, async () => {
      const store = createMemoryStore();
      const peer = await store.createPeer(A, { erasure: "unproven" });
      const id = blobId(bytes);
      const entry: VerifiedDelta = { delta: { id, claims: blobClaims(value) }, arrival: local(id) };
      expect(await code(() => peer.append({ ...head, added: [entry] }))).toBe("invalid-admission");
      await untouched(store, peer);
      expect(() => scopeSource([entry])).toThrow(StoreError);
    });
  }

  for (const { name, make } of BYTES) {
    it(`a bytes payload that is ${name} is admitted and shares no memory`, async () => {
      const store = createMemoryStore();
      const peer = await store.createPeer(A, { erasure: "unproven" });
      const { value, poke } = make();
      const id = blobId([1, 2, 3]);
      const entry: VerifiedDelta = { delta: { id, claims: blobClaims(value) }, arrival: local(id) };
      expect(await peer.append({ ...head, added: [entry] })).toMatchObject({ added: [id] });
      const source = scopeSource([entry]);
      poke();
      expect([...value]).toEqual([9, 9, 9]);

      const snapshot = await peer.read();
      const read = async (): Promise<Uint8Array> => blobOf((await snapshot.get([id]))[0]);
      for (const held of [await read(), blobOf(source.get(id))]) {
        expect([...held]).toEqual([1, 2, 3]);
        // What is handed out is a plain Uint8Array over memory of its own, and no more of it.
        expect(Object.getPrototypeOf(held)).toBe(Uint8Array.prototype);
        expect(held.buffer).toBeInstanceOf(ArrayBuffer);
        expect([held.byteOffset, held.buffer.byteLength]).toEqual([0, 3]);
        expect(held.buffer).not.toBe(value.buffer);
        new Uint8Array(held.buffer).fill(4);
      }
      // Two reads share nothing with each other either.
      expect((await read()).buffer).not.toBe((await read()).buffer);
      expect([...(await read())]).toEqual([1, 2, 3]);
      expect([...blobOf(source.get(id))]).toEqual([1, 2, 3]);
      expect(computeId((await snapshot.get([id]))[0]!.claims)).toBe(id);
    });
  }

  for (const [name, change] of Object.entries(WRONG)) {
    it(`an entry where ${name} is refused, in append and in scopeSource`, async () => {
      const store = createMemoryStore();
      const peer = await store.createPeer(A, { erasure: "unproven" });
      const entry =
        name === "the entry is null" ? (null as unknown as VerifiedDelta) : entryWith(change).entry;
      expect(await code(() => peer.append({ ...head, added: [entry] }))).toBe("invalid-admission");
      await untouched(store, peer);
      const refusal = (() => {
        try {
          return scopeSource([entry]) && "no error";
        } catch (error) {
          return error instanceof StoreError ? error.code : `not a StoreError: ${error}`;
        }
      })();
      // The source checks types, not an arrival record's ranges or a signature's form.
      expect(refusal).toBe("invalid-request");
    });
  }

  // The honest value on one read and another value on every other read. Whichever read the
  // store takes, it may admit or refuse; it may not hold the id over claims that do not
  // recompute to it.
  for (const honestRead of [0, 1, 2, 3]) {
    it(`a field that is honest only on read ${honestRead} never files other claims under the id`, async () => {
      const store = createMemoryStore();
      const peer = await store.createPeer(A, { erasure: "unproven" });
      const honest = fact("e", 1);
      let reads = 0;
      const shifty = {
        ...honest.claims,
        get timestamp(): number {
          return reads++ === honestRead ? honest.claims.timestamp : 999;
        },
      };
      const entry: VerifiedDelta = {
        delta: { id: honest.id, claims: shifty },
        arrival: local(honest.id),
      };
      const outcome = await code(() => peer.append({ ...head, added: [entry] }));
      expect(["no error", "invalid-admission"]).toContain(outcome);
      const held = await (await peer.read()).get([honest.id]);
      expect(held).toHaveLength(outcome === "no error" ? 1 : 0);
      for (const delta of held) expect(computeId(delta.claims)).toBe(honest.id);
      // The store reads the field once, so the first read decides.
      expect(outcome).toBe(honestRead === 0 ? "no error" : "invalid-admission");

      reads = 0;
      const source = ((): ReturnType<typeof scopeSource> | undefined => {
        try {
          return scopeSource([entry]);
        } catch {
          return undefined;
        }
      })();
      const got = source?.get(honest.id);
      if (got !== undefined) expect(computeId(got.claims)).toBe(honest.id);
      expect(source !== undefined).toBe(honestRead === 0);
    });
  }

  // README §6 test 5 beyond the claims: the signature, the id and every arrival field. Each is
  // honest on its first read and wrong on every later one. The store reads each once, so it
  // admits the entry and keeps the honest value; it never keeps a value it did not check.
  const later: Readonly<
    Record<string, [part: "delta" | "arrival", field: string, wrong: unknown]>
  > = {
    "the signature": ["delta", "sig", "not hex"],
    "the id": ["delta", "id", "1e20" + "00".repeat(32)],
    "the arrival id": ["arrival", "id", "1e20" + "00".repeat(32)],
    "the arrival time": ["arrival", "at", Number.NaN],
    "the arrival sequence": ["arrival", "sequence", 0],
    "the arrival transfer": ["arrival", "transfer", 0],
    "the arrival sender": ["arrival", "sender", ""],
  };
  for (const [name, [part, field, wrong]] of Object.entries(later)) {
    it(`${name} is read once: the checked value is the kept one`, async () => {
      let reads = 0;
      const { entry, id } = entryWith((e) => {
        const honest = e[part][field];
        Object.defineProperty(e[part], field, {
          enumerable: true,
          get: () => (reads++ === 0 ? honest : wrong),
        });
      });
      const store = createMemoryStore();
      const peer = await store.createPeer(A, { erasure: "unproven" });
      expect(await code(() => peer.append({ ...head, added: [entry] }))).toBe("no error");
      expect(reads).toBe(1);
      const snapshot = await peer.read();
      const [delta] = await snapshot.get([id]);
      const [arrival] = await snapshot.arrivals([id]);
      expect(delta?.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(arrival).toEqual(local(id));

      reads = 0;
      const source = scopeSource([entry]);
      expect(reads).toBe(1);
      expect(source.get(id)?.sig).toBe(delta?.sig);
      expect(source.arrival(id)).toEqual(local(id));
    });
  }

  // README §6 test 5 inside the claims: every claims field, the list of pointers, each pointer,
  // and each part of each kind of target. Honest on the first read, of the right type and
  // another value on every later one; the kept claims recompute to the id.
  type Place = (claims: Loose) => Loose;
  const claimsAt: Place = (c) => c;
  const at =
    (index: number, ...path: string[]): Place =>
    (c) =>
      path.reduce<Loose>((o, key) => o[key] as Loose, pointer(c, index) as unknown as Loose);
  const inner: Readonly<Record<string, [place: Place, field: string, wrong: unknown]>> = {
    validFrom: [claimsAt, "validFrom", 6],
    validUntil: [claimsAt, "validUntil", 10],
    "the author": [claimsAt, "author", "did:key:zOther"],
    "the list of pointers": [claimsAt, "pointers", []],
    "a pointer": [
      (c) => c["pointers"] as Loose,
      "0",
      { role: "x", target: { kind: "primitive", value: 1 } },
    ],
    "a pointer's role": [at(0), "role", "object"],
    "a pointer's target": [at(0), "target", { kind: "primitive", value: 1 }],
    "a target's kind": [at(0, "target"), "kind", "primitive"],
    "an entity id": [at(0, "target", "entity"), "id", "f"],
    "an entity context": [at(0, "target", "entity"), "context", "w"],
    "a primitive value": [at(1, "target"), "value", "w"],
    "a delta reference": [at(2, "target"), "deltaRef", { delta: "1e20bb" }],
    "a delta reference's id": [at(2, "target", "deltaRef"), "delta", "1e20bb"],
    "a delta reference's context": [at(2, "target", "deltaRef"), "context", "d"],
    "a mime type": [at(3, "target"), "mime", "x/z"],
    "a bytes payload": [at(3, "target"), "value", new Uint8Array([2])],
  };
  for (const [name, [place, field, wrong]] of Object.entries(inner)) {
    it(`${name} is read once: the kept claims recompute to the id`, async () => {
      let reads = 0;
      const { entry, id } = entryWith(({ claims }) => {
        const owner = place(claims);
        const honest = owner[field];
        Object.defineProperty(owner, field, {
          enumerable: true,
          get: () => (reads++ === 0 ? honest : wrong),
        });
      });
      const store = createMemoryStore();
      const peer = await store.createPeer(A, { erasure: "unproven" });
      expect(await code(() => peer.append({ ...head, added: [entry] }))).toBe("no error");
      expect(reads).toBe(1);
      const [delta] = await (await peer.read()).get([id]);
      expect(computeId(delta!.claims)).toBe(id);

      reads = 0;
      const source = scopeSource([entry]);
      expect(reads).toBe(1);
      expect(computeId(source.get(id)!.claims)).toBe(id);
    });
  }

  it("the fields of a request are read once: ids, entities, anchors and exclude", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const delta = fact("e", 1);
    await fill(peer, [delta]);
    const snapshot = await peer.read();
    let reads = 0;
    /** A list whose one item is honest on its first read and a number on every later one. */
    const shifty = (honest: unknown): unknown[] => {
      const list: unknown[] = [honest];
      Object.defineProperty(list, 0, { get: () => (reads++ === 0 ? honest : 5) });
      return list;
    };
    const once = async (ask: () => Promise<unknown>): Promise<unknown> => {
      reads = 0;
      const answer = await ask();
      expect(reads).toBe(1);
      return answer;
    };
    expect(await once(() => snapshot.get(shifty(delta.id) as string[]))).toHaveLength(1);
    expect(await once(() => snapshot.arrivals(shifty(delta.id) as string[]))).toHaveLength(1);
    expect(await once(() => snapshot.targets(shifty("e") as string[]))).toEqual([delta.id]);
    expect(await once(() => snapshot.negators(shifty(delta.id) as string[]))).toEqual([]);
    const anchor = {
      kind: "entity" as const,
      get entity(): string {
        return reads++ === 0 ? "e" : (5 as unknown as string);
      },
    };
    expect(
      ((await once(() => snapshot.scope({ anchors: [anchor] }))) as { deltas: unknown[] }).deltas,
    ).toHaveLength(1);
    expect(
      (
        (await once(() =>
          snapshot.scope({
            anchors: [{ kind: "entity", entity: "e" }],
            exclude: shifty(delta.id) as string[],
          }),
        )) as { deltas: unknown[] }
      ).deltas,
    ).toEqual([]);
    expect(
      (
        (await once(() =>
          snapshot.scope({
            anchors: [{ kind: "entity", entity: "e" }],
            pushdown: { excludeIds: shifty(delta.id) as string[] },
          }),
        )) as { deltas: unknown[] }
      ).deltas,
    ).toEqual([]);
    expect(await once(() => peer.purge(shifty(delta.id) as string[]))).toMatchObject({
      targets: [{ id: delta.id, outcome: "removed" }],
    });
  });

  it("a call that is not of its shape is refused: the batch, its head, its list", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const delta = fact("e", 1);
    const entry: VerifiedDelta = { delta, arrival: local(delta.id) };
    type Batch = Parameters<PeerStore["append"]>[0];
    const calls: unknown[] = [
      null,
      undefined,
      { ...head, nextHead: 7, added: [entry] },
      { ...head, nextHead: new String("h"), added: [entry] },
      { ...head, added: undefined },
      { ...head, added: new Set([entry]) },
      { ...head, added: { 0: entry, length: 1 } },
      { ...head, added: [[entry]] },
    ];
    for (const call of calls)
      expect(await code(() => peer.append(call as Batch))).toBe("invalid-admission");
    expect(await code(() => peer.append({ ...head, frame: undefined, added: [] } as never))).toBe(
      "capability-absent",
    );
    // A head that is not the peer's is a conflict, whatever its type.
    for (const expectedHead of [undefined, 0, "", new String("h")])
      expect(await peer.append({ ...head, expectedHead, added: [entry] } as never)).toEqual({
        status: "conflict",
      });
    await untouched(store, peer);

    // A next head that reads as a string once and as something else later is read once.
    let reads = 0;
    const shifty = {
      ...head,
      added: [entry],
      get nextHead(): string {
        return reads++ === 0 ? "h" : (7 as unknown as string);
      },
    };
    await peer.append(shifty).catch(() => undefined);
    const now = (await peer.read()).head;
    expect(now === null || now === "h").toBe(true);
  });

  it("a request that is not of its shape is refused invalid-request", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    await fill(peer, [fact("e", 1)]);
    const snapshot = await peer.read();
    const lists: unknown[] = [undefined, null, "abc", 5, new Set(["a"]), [5], [null], [["a"]]];
    for (const list of lists) {
      const ids = list as string[];
      expect(await code(() => snapshot.get(ids))).toBe("invalid-request");
      expect(await code(() => snapshot.arrivals(ids))).toBe("invalid-request");
      expect(await code(() => snapshot.targets(ids))).toBe("invalid-request");
      expect(await code(() => snapshot.negators(ids))).toBe("invalid-request");
      expect(await code(() => peer.purge(ids))).toBe("invalid-request");
      expect(await code(() => snapshot.scope({ anchors: ids as never }))).toBe("invalid-request");
      if (list !== undefined) {
        expect(await code(() => snapshot.scope({ anchors: [], exclude: ids }))).toBe(
          "invalid-request",
        );
        expect(
          await code(() => snapshot.scope({ anchors: [], pushdown: { excludeIds: ids } })),
        ).toBe("invalid-request");
      }
    }
    expect(await code(() => snapshot.scope(null as never))).toBe("invalid-request");
    expect(
      await code(() => snapshot.scope({ anchors: [{ kind: "entity", entity: 5 as never }] })),
    ).toBe("invalid-request");
    // An absent pushdown is none. A pushdown that is not a plain object is refused, never
    // read as an empty one: that would answer unfiltered.
    const anchors = [{ kind: "entity" as const, entity: "e" }];
    for (const pushdown of [5, "abc", true, [], () => ({}), null, new Map(), new Date(0)])
      expect(
        await code(() => snapshot.scope({ anchors, pushdown: pushdown as never })),
        String(pushdown),
      ).toBe("invalid-request");
    for (const pushdown of [undefined, {}, Object.create(null) as object]) {
      const result = await snapshot.scope({ anchors, pushdown: pushdown as never });
      expect(result.deltas).toHaveLength(1);
      expect(result.applied).toEqual({
        timestampAtMost: false,
        arrivalAtMost: false,
        excludeIds: false,
      });
    }
    for (const timestampAtMost of ["5", null, 5n, new Number(5)])
      expect(
        await code(() => snapshot.scope({ anchors: [], pushdown: { timestampAtMost } as never })),
      ).toBe("invalid-request");
    for (const arrivalAtMost of ["5", null, 5n, new Number(5)])
      expect(
        await code(() => snapshot.scope({ anchors: [], pushdown: { arrivalAtMost } as never })),
      ).toBe("invalid-request");
    const listWithPosture = Object.assign([], { erasure: "unproven" });
    class Options {
      erasure = "unproven";
    }
    const throwing = {
      get erasure(): never {
        throw new Error("a getter that throws");
      },
    };
    for (const options of [
      null,
      undefined,
      "unproven",
      { erasure: new String("unproven") },
      listWithPosture,
      new Options(),
      Object.create({ erasure: "unproven" }) as object,
      throwing,
    ]) {
      const refusal = await store.createPeer(B, options as never).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal, String(options)).toBeInstanceOf(StoreError);
      expect((refusal as StoreError).code).toBe("invalid-request");
    }
    await expect(store.peer(B)).rejects.toThrow(StoreError);
    for (const id of [5, null, undefined, new String(B)])
      expect(await code(() => store.createPeer(id as never, { erasure: "unproven" }))).toBe(
        "invalid-request",
      );
    for (const id of [5, null, undefined, new String(A)])
      expect(await code(() => store.peer(id as never))).toBe("peer-absent");
    // The refusals changed nothing.
    expect((await peer.read()).count).toBe(1);
    expect(await snapshot.targets(["e"])).toHaveLength(1);
  });

  it("a plain object from another realm is plain; a list or an instance from it is not", async () => {
    // Plainness is the shape of the prototype chain, as `Array.isArray` is for a list.
    const foreign = <T>(source: string): T => runInNewContext(source) as T;
    const store = createMemoryStore();
    const peer = await store.createPeer(A, foreign("({ erasure: 'unproven' })"));
    expect(peer.erasure.posture).toBe("unproven");
    await store.createPeer(
      B,
      foreign("Object.assign(Object.create(null), { erasure: 'unproven' })"),
    );
    await fill(peer, [fact("e", 1)]);
    const snapshot = await peer.read();
    const anchors = [{ kind: "entity", entity: "e" }] as const;
    const result = await snapshot.scope({
      anchors,
      pushdown: foreign("({ timestampAtMost: 0 })"),
    });
    expect(result.applied.timestampAtMost).toBe(true);
    expect(result.deltas).toHaveLength(0);
    expect(
      (await openStore("memory:", foreign("({ requires: ['arrival'] })"))).profile.formatVersion,
    ).toBe(MEMORY_STORE_FORMAT);
    await expect(openStore("memory:", foreign("({ requires: ['journal'] })"))).rejects.toThrow(
      "journal",
    );
    for (const source of [
      "[]",
      "Object.assign([], { erasure: 'unproven' })",
      "new (class Options { erasure = 'unproven' })()",
      "Object.create({ erasure: 'unproven' })",
      "new Map()",
    ]) {
      expect(await code(() => store.createPeer("C", foreign(source))), source).toBe(
        "invalid-request",
      );
      expect(await code(() => snapshot.scope({ anchors, pushdown: foreign(source) })), source).toBe(
        "invalid-request",
      );
      expect(await code(() => openStore("memory:", foreign(source))), source).toBe(
        "invalid-request",
      );
    }
    // An object that only borrows a realm's `constructor` is not that realm's Object.prototype.
    const impostor = Object.create(Object.assign(Object.create(null), { constructor: Object }));
    // A prototype with a null prototype that belongs to a constructor of another name.
    const Other = function Other(): void {};
    Other.prototype = Object.assign(Object.create(null), { constructor: Other });
    const instance = Object.create(Other.prototype as object);
    for (const pushdown of [impostor, instance])
      expect(await code(() => snapshot.scope({ anchors, pushdown: pushdown as never }))).toBe(
        "invalid-request",
      );
  });

  it("a request that reads differently each time is read once", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    await fill(peer, [fact("e", 1), fact("e", 2), fact("e", 3)]);
    const snapshot = await peer.read();
    let reads = 0;
    const request = {
      anchors: [{ kind: "entity" as const, entity: "e" }],
      get pushdown(): { arrivalAtMost: number } {
        return { arrivalAtMost: reads++ === 0 ? 1 : Number.NaN };
      },
    };
    const result = await snapshot.scope(request);
    expect([result.applied.arrivalAtMost, result.deltas.length]).toEqual([true, 1]);
  });
});

describe("numbers a store refuses", () => {
  it("a scope bound that is not a finite number, or not a whole arrival sequence", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const snapshot = await peer.read();
    const scope = (pushdown: object): Promise<unknown> => snapshot.scope({ anchors: [], pushdown });
    for (const timestampAtMost of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(await code(() => scope({ timestampAtMost }))).toBe("invalid-request");
    for (const arrivalAtMost of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 2 ** 53])
      expect(await code(() => scope({ arrivalAtMost }))).toBe("invalid-request");
    for (const pushdown of [
      { timestampAtMost: -3.5 },
      { arrivalAtMost: 0 },
      { arrivalAtMost: 2 ** 53 - 1 },
    ])
      expect(await code(() => scope(pushdown))).toBe("no error");
  });

  it("a malformed bound is invalid-request on a moved and on a released snapshot too", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const moved = await peer.read();
    await fill(peer, [fact("e", 1)]);
    const released = await peer.read();
    released.release();
    for (const snapshot of [moved, released])
      for (const pushdown of [{ timestampAtMost: Number.NaN }, { arrivalAtMost: 1.5 }])
        expect(await code(() => snapshot.scope({ anchors: [], pushdown }))).toBe("invalid-request");
    expect(await code(() => moved.scope({ anchors: [] }))).toBe("snapshot-moved");
    expect(await code(() => released.scope({ anchors: [] }))).toBe("snapshot-released");
  });

  it("an arrival time that is not finite, which JSON vectors cannot carry", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const delta = fact("e", 1);
    for (const at of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "1" as unknown as number,
    ])
      expect(
        await code(() =>
          peer.append({
            expectedHead: null,
            nextHead: "h",
            frame: null,
            added: [
              { delta, arrival: { id: delta.id, at, sequence: 1, transfer: 1, sender: "x" } },
            ],
          }),
        ),
      ).toBe("invalid-admission");
    expect((await peer.read()).count).toBe(0);
  });

  it("a signature that is not a string", async () => {
    const store = createMemoryStore();
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const delta = { ...fact("e", 1), sig: 7 as unknown as string };
    const arrival = { id: delta.id, at: 1, sequence: 1, transfer: 1, sender: "x" };
    expect(
      await code(() =>
        peer.append({
          expectedHead: null,
          nextHead: "h",
          frame: null,
          added: [{ delta, arrival }],
        }),
      ),
    ).toBe("invalid-admission");
  });
});

// ---- agreement with SPEC-17 ---------------------------------------------------------------

const ENTITIES = ["e0", "e1", "e2", "e3"];

/** A random delta set: facts at a few entities, and negations of earlier members. */
const arbDeltas = fc
  .array(
    fc.record({
      negate: fc.boolean(),
      entity: fc.constantFrom(...ENTITIES),
      second: fc.option(fc.constantFrom(...ENTITIES), { nil: undefined }),
      cite: fc.boolean(),
      pick: fc.nat(),
      timestamp: fc.integer({ min: 0, max: 20 }),
    }),
    { maxLength: 24 },
  )
  .map((specs) => {
    const deltas: Delta[] = [];
    specs.forEach((spec, i) => {
      if (spec.negate && deltas.length > 0) {
        deltas.push(strike(deltas[spec.pick % deltas.length]!, spec.timestamp));
        return;
      }
      const pointers: Pointer[] = [
        { role: "subject", target: { kind: "entity", entity: { id: spec.entity } } },
        { role: "n", target: { kind: "primitive", value: i } },
      ];
      if (spec.second !== undefined)
        pointers.push({ role: "other", target: { kind: "entity", entity: { id: spec.second } } });
      // A delta reference under another role: it must not count as a negation.
      if (spec.cite && deltas.length > 0)
        pointers.push({
          role: "cites",
          target: { kind: "delta", deltaRef: { delta: deltas[spec.pick % deltas.length]!.id } },
        });
      deltas.push(
        makeDelta({ timestamp: spec.timestamp, validFrom: 0, author: "did:key:zA", pointers }),
      );
    });
    return [...new Map(deltas.map((d) => [d.id, d])).values()];
  });

describe("the store's scope is the SPEC-17 scope", () => {
  it("scope(anchors, pushdown) equals scopeIds over the reactor with the same selection", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbDeltas,
        fc.subarray(ENTITIES),
        fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 24 }), { nil: undefined }),
        fc.array(fc.nat(), { maxLength: 3 }),
        async (deltas, entities, timestampAtMost, arrivalAtMost, drops) => {
          const store = createMemoryStore();
          const peer = await store.createPeer(A, { erasure: "unproven" });
          await fill(peer, deltas);
          const reactor = new Reactor();
          for (const delta of deltas) reactor.ingest(delta);
          const sequence = new Map(deltas.map((d, i) => [d.id, i + 1]));
          const excludeIds = deltas.length ? drops.map((n) => deltas[n % deltas.length]!.id) : [];

          const snapshot = await peer.read();
          const result = await snapshot.scope({
            anchors: entities.map((entity) => ({ kind: "entity" as const, entity })),
            pushdown: {
              ...(timestampAtMost === undefined ? {} : { timestampAtMost }),
              ...(arrivalAtMost === undefined ? {} : { arrivalAtMost }),
              excludeIds,
            },
          });
          const expected = scopeIds(
            reactor,
            entities,
            (d) =>
              (timestampAtMost === undefined || d.claims.timestamp <= timestampAtMost) &&
              (arrivalAtMost === undefined || sequence.get(d.id)! <= arrivalAtMost) &&
              !excludeIds.includes(d.id),
          );
          expect(result.deltas.map((d) => d.delta.id)).toEqual(expected);
          expect(await snapshot.targets(entities)).toEqual(
            [...new Set(entities.flatMap((e) => reactor.byTarget(e)))].sort(),
          );
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("scopeSource: a synchronous delta source over a fetched scope", () => {
  it("agrees with the snapshot on the fetched set", async () => {
    await fc.assert(
      fc.asyncProperty(arbDeltas, fc.subarray(ENTITIES), async (deltas, entities) => {
        const store = createMemoryStore();
        const peer = await store.createPeer(A, { erasure: "unproven" });
        await fill(peer, deltas);
        const snapshot = await peer.read();
        const fetched = await snapshot.scope({
          anchors: entities.map((entity) => ({ kind: "entity" as const, entity })),
        });
        const source = scopeSource(fetched.deltas);
        const ids = fetched.deltas.map((d) => d.delta.id);
        const inFetched = (list: readonly string[]): string[] =>
          list.filter((id) => ids.includes(id));

        expect(source.ids()).toEqual(ids);
        expect(ids.map((id) => source.get(id))).toEqual(await snapshot.get(ids));
        expect(ids.map((id) => source.arrival(id))).toEqual(await snapshot.arrivals(ids));
        for (const entity of ENTITIES)
          expect(source.targets(entity)).toEqual(inFetched(await snapshot.targets([entity])));
        for (const delta of deltas)
          expect(source.negators(delta.id)).toEqual(inFetched(await snapshot.negators([delta.id])));
        for (const delta of deltas)
          if (!ids.includes(delta.id)) expect(source.get(delta.id)).toBeUndefined();

        // It is the evaluator's DeltaSource: the scope computed through it is the fetched set.
        const asSource: DeltaSource = source;
        expect(scopeIds(asSource, entities)).toEqual(ids);
      }),
      { numRuns: 100 },
    );
  });

  it("refuses a member whose id does not match its claims", () => {
    const real = fact("e", 1);
    const forged: VerifiedDelta = {
      delta: { id: real.id, claims: fact("e", 2).claims },
      arrival: { id: real.id, at: 1, sequence: 1, transfer: 1, sender: "local" },
    };
    expect(() => scopeSource([forged])).toThrow(StoreError);
    expect(() => scopeSource([forged])).toThrow(/does not match its claims/);
    const broken = { ...forged, delta: { id: real.id, claims: {} as Delta["claims"] } };
    expect(() => scopeSource([broken])).toThrow(StoreError);
  });

  it("owns its members and its lists: nothing a caller holds reaches inside", () => {
    const payload = Buffer.from([1, 2, 3]);
    const delta = makeDelta({
      timestamp: 1,
      validFrom: 1,
      author: "did:key:zA",
      pointers: [
        { role: "subject", target: { kind: "entity", entity: { id: "e" } } },
        { role: "blob", target: { kind: "bytes", mime: "x/y", value: payload } },
      ],
    });
    const negation = strike(delta, 2);
    const member = (d: Delta, sequence: number): VerifiedDelta => ({
      delta: d,
      arrival: { id: d.id, at: 1, sequence, transfer: 1, sender: "local" },
    });
    const given = [member(delta, 1), member(negation, 2)];
    const source = scopeSource(given);
    const state = (): string =>
      JSON.stringify([
        source.ids(),
        source.targets("e"),
        source.targets("moved"),
        source.negators(delta.id),
        source.ids().map((id) => [source.get(id), source.arrival(id)]),
      ]);
    const pristine = state();

    // What the caller gave.
    payload.fill(9);
    (given[0]!.arrival as { sequence: number }).sequence = 99;
    (given[0]!.delta.claims.pointers[0]!.target as { entity: { id: string } }).entity.id = "moved";
    expect(state()).toBe(pristine);

    // What the source returned.
    for (const list of [source.ids(), source.targets("e"), source.negators(delta.id)]) {
      expect(() => (list as string[]).push("x")).toThrow(TypeError);
      expect(() => {
        (list as string[]).length = 0;
      }).toThrow(TypeError);
    }
    expect(() => (source.targets("nowhere") as string[]).push("x")).toThrow(TypeError);
    expect(source.targets("nowhere")).toEqual([]);
    const got = source.get(delta.id)!;
    (got.claims as { timestamp: number }).timestamp = 5;
    const target = got.claims.pointers[1]!.target;
    if (target.kind === "bytes") target.value.fill(4);
    (source.arrival(delta.id) as { sender: string }).sender = "mallory";
    expect(state()).toBe(pristine);
  });

  it("a repeated id is not examined, and a refusal builds nothing", () => {
    const real = fact("e", 1);
    const arrival = { id: real.id, at: 1, sequence: 1, transfer: 1, sender: "local" };
    const forgedRepeat: VerifiedDelta = {
      delta: { id: real.id, claims: fact("e", 2).claims },
      arrival,
    };
    // After a good first appearance, the forged repeat is skipped unread.
    const source = scopeSource([{ delta: real, arrival }, forgedRepeat]);
    expect(source.get(real.id)).toEqual(real);
    // First, it is refused; the call returns no source at all.
    expect(() => scopeSource([forgedRepeat, { delta: real, arrival }])).toThrow(StoreError);
    // A repeat is skipped by its id alone: nothing else of it is read, malformed or not.
    const unread = { delta: { id: real.id, claims: null }, arrival: null };
    const again = scopeSource([{ delta: real, arrival }, unread as unknown as VerifiedDelta]);
    expect(again.ids()).toEqual([real.id]);
    expect(() => scopeSource([unread as unknown as VerifiedDelta])).toThrow(StoreError);
  });

  it("keeps the first appearance of an id fetched in two rounds", () => {
    const delta = fact("e", 1);
    const first: VerifiedDelta = {
      delta,
      arrival: { id: delta.id, at: 1, sequence: 1, transfer: 1, sender: "local" },
    };
    const second: VerifiedDelta = { delta, arrival: { ...first.arrival, sequence: 9 } };
    const source = scopeSource([first, second]);
    expect(source.ids()).toEqual([delta.id]);
    expect(source.arrival(delta.id)?.sequence).toBe(1);
    expect(source.targets("e")).toEqual([delta.id]);
  });
});

describe("cost rail: scopeSource builds in the size of its members", () => {
  // A coarse scaling check, timed from outside: the code under test keeps no meter of its own,
  // so a build that copies or searches a list per insert cannot hide its work. Four shapes, at
  // N and at 8N: members at one entity, negations of one delta, entity pointers of one member,
  // and appearances of four ids (every one after the fourth a repeat). Linear work scales by
  // about 8, quadratic by about 64; the rail fails at 24.
  //
  // N is the smallest power of two whose build takes 50 ms or more, so a quadratic build finds
  // a small N and fails rather than hangs. The build at N is the fastest of five; the build at
  // 8N passes when any of three is under the bound, which is the fastest of three, stopped
  // early. The rail is coarse in one direction. A stall during the 8N builds raises the ratio
  // only if it slows all three, so correct code under load stays green. A stall during every
  // build at N lowers the ratio, so a loaded machine can let a quadratic build pass. And a cost
  // that is quadratic only with a tiny constant at these sizes passes.
  const BOUND = 24;
  const member = (delta: Delta, sequence: number): VerifiedDelta => ({
    delta,
    arrival: { id: delta.id, at: 1, sequence, transfer: 1, sender: "local" },
  });
  const struck = fact("struck", 0);
  /** The first `n` of a list built on demand, `make(i)` at index i. */
  const prefix = <T>(make: (i: number) => T): ((n: number) => T[]) => {
    const made: T[] = [];
    return (n) => {
      while (made.length < n) made.push(make(made.length));
      return made.slice(0, n);
    };
  };
  const wide = (n: number): Delta =>
    makeDelta({
      timestamp: 1,
      validFrom: 1,
      author: "did:key:zA",
      pointers: Array.from({ length: n }, (_, i) => ({
        role: "subject",
        target: { kind: "entity", entity: { id: `wide:${i}`, context: "v" } },
      })),
    });
  const four = [1, 2, 3, 4].map((i) => member(fact("four", i), i));
  type Shape = {
    members: (n: number) => Iterable<VerifiedDelta>;
    /** What a build over `n` holds: the shape reaches the index it names. */
    holds: (n: number) => void;
  };
  const shapes: Record<string, Shape> = {
    "members at one entity": {
      members: prefix((i) => member(fact("crowded", i + 1), i + 1)),
      holds: (n) =>
        expect(
          scopeSource(shapes["members at one entity"]!.members(n)).targets("crowded"),
        ).toHaveLength(n),
    },
    "negations of one delta": {
      members: prefix((i) => member(strike(struck, i + 1), i + 1)),
      holds: (n) =>
        expect(
          scopeSource(shapes["negations of one delta"]!.members(n)).negators(struck.id),
        ).toHaveLength(n),
    },
    "entity pointers of one member": {
      members: (n) => [member(wide(n), 1)],
      holds: (n) => {
        const source = scopeSource(shapes["entity pointers of one member"]!.members(n));
        expect(source.ids()).toHaveLength(1);
        for (const i of [0, n - 1]) expect(source.targets(`wide:${i}`)).toHaveLength(1);
      },
    },
    // A list that yields its members again on each walk, without holding 8N of them.
    "appearances of four ids": {
      members: (n) => ({
        *[Symbol.iterator]() {
          for (let i = 0; i < n; i++) yield four[i % 4]!;
        },
      }),
      holds: (n) =>
        expect(scopeSource(shapes["appearances of four ids"]!.members(n)).ids()).toHaveLength(
          Math.min(n, 4),
        ),
    },
  };
  /** The fastest of `runs` builds; it stops at the first build faster than `enough`. */
  const fastest = (members: Iterable<VerifiedDelta>, runs: number, enough = 0): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < runs && best >= enough; run++) {
      const start = performance.now();
      scopeSource(members);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  for (const [shape, { members, holds }] of Object.entries(shapes)) {
    it(`8 times the ${shape} cost less than ${BOUND} times the time`, () => {
      holds(300);
      let n = 256;
      let small = fastest(members(n), 5);
      while (small < 50 && n < 1 << 24) small = fastest(members((n *= 2)), 5);
      const large = fastest(members(8 * n), 3, BOUND * small);
      const ratio = large / small;
      console.log(
        `scope source, ${shape}: N = ${n}, ${small.toFixed(1)} ms and ${large.toFixed(1)} ms, ratio ${ratio.toFixed(2)}`,
      );
      expect(ratio, `N = ${n}: ${small.toFixed(1)} ms, then ${large.toFixed(1)} ms`).toBeLessThan(
        BOUND,
      );
    }, 600_000);
  }
});

// ---- the cost rail ------------------------------------------------------------------------

describe("cost rail: an operation costs its footprint, not the store", () => {
  // Counts index work; times nothing. Every map in the memory store sits behind one counting
  // door, and `scans` counts the only way to walk a whole map.
  const N = 500;
  const base = fact("plant", 1);
  const baseStrike = strike(base, 2);
  const footprint = [base, baseStrike, strike(baseStrike, 3), fact("plant", 4), fact("bed", 5)];
  const fresh = [fact("plant", 6), strike(base, 7)];
  const unrelated = Array.from({ length: N }, (_, i) => fact(`other:${i % 7}`, 100 + i));
  const unrelatedStrikes = unrelated.slice(0, 50).map((d, i) => strike(d, 1000 + i));

  /** The work each core operation does over the same footprint, with `extra` deltas around it. */
  async function measure(extra: readonly Delta[]): Promise<Record<string, StoreMeter>> {
    const meter: StoreMeter = { lookups: 0, visited: 0, scans: 0 };
    const store = createMemoryStore({ meter });
    const peer = await store.createPeer(A, { erasure: "unproven" });
    const other = await store.createPeer(B, { erasure: "unproven" });
    await fill(peer, footprint);
    // Unrelated deltas in this peer, and the same again in another peer.
    await fill(peer, extra);
    await fill(other, extra);

    const costs: Record<string, StoreMeter> = {};
    const cost = async (name: string, action: () => Promise<unknown>): Promise<void> => {
      const before = { ...meter };
      await action();
      costs[name] = {
        lookups: meter.lookups - before.lookups,
        visited: meter.visited - before.visited,
        scans: meter.scans - before.scans,
      };
    };
    const ids = footprint.map((d) => d.id);
    const anchors = [
      { kind: "entity" as const, entity: "plant" },
      { kind: "entity" as const, entity: "bed" },
    ];
    let snapshot = await peer.read();
    await cost("open", () => store.peer(A));
    await cost("read", () => peer.read());
    await cost("get", () => snapshot.get(ids));
    await cost("arrivals", () => snapshot.arrivals(ids));
    await cost("targets", () => snapshot.targets(["plant", "bed"]));
    await cost("negators", () => snapshot.negators(ids));
    await cost("scope", () => snapshot.scope({ anchors }));
    await cost("scope with pushdown", () =>
      snapshot.scope({
        anchors,
        pushdown: { timestampAtMost: 3, arrivalAtMost: 4, excludeIds: [ids[3]!] },
        exclude: [ids[0]!],
      }),
    );
    const { head, count } = snapshot;
    await cost("append", () =>
      peer.append({
        expectedHead: head,
        nextHead: "next",
        frame: null,
        added: fresh.map((delta, i) => ({
          delta,
          arrival: { id: delta.id, at: 1, sequence: count + i + 1, transfer: 9, sender: "local" },
        })),
      }),
    );
    snapshot = await peer.read();
    expect(snapshot.count).toBe(count + fresh.length);
    await cost("purge", () => peer.purge([ids[1]!, fresh[0]!.id, "1e20" + "00".repeat(32)]));
    await cost("createPeer", () => store.createPeer("ed25519:new", { erasure: "unproven" }));
    return costs;
  }

  it("the same operations make the same index calls with 0 and with N unrelated deltas", async () => {
    const alone = await measure([]);
    const crowded = await measure([...unrelated, ...unrelatedStrikes]);
    expect(crowded).toEqual(alone);
    // The rail measures something: a scope read does index work, and more than a point read.
    expect(alone["scope"]!.lookups).toBeGreaterThan(alone["targets"]!.lookups);
    expect(alone["scope"]!.visited).toBeGreaterThan(0);
  });

  it("no core operation walks a whole map", async () => {
    const costs = await measure([...unrelated, ...unrelatedStrikes]);
    for (const [name, cost] of Object.entries(costs)) expect([name, cost.scans]).toEqual([name, 0]);
  });

  it("the meter sees a walk: the exporter is O(surface) and is counted as one", async () => {
    const meter: StoreMeter = { lookups: 0, visited: 0, scans: 0 };
    const store = createMemoryStore({ meter });
    const peer = await store.createPeer(A, { erasure: "unproven" });
    await fill(peer, unrelated);
    const admin = store.openAdmin();
    expect(meter.scans).toBe(0);
    const ids: string[] = [];
    for await (const id of admin.peer(A).ids()) ids.push(id);
    expect(ids).toHaveLength(N);
    expect(meter.scans).toBe(1);
    for await (const id of admin.storedIds()) ids.push(id);
    for await (const id of admin.peers()) ids.push(id);
    expect(meter.scans).toBe(3);
  });
});
