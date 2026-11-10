// The store interface and the memory reference store (SPEC-18 proposal, slice 1): what the
// shared vectors cannot say. The profile, opening by URL, agreement with the SPEC-17 scope, the
// synchronous source over a fetched scope, and the cost rail.
//
// Not covered here: the change feed, the journal, value and derived-index anchors, and any
// store but memory. Erasure is asserted at the index level and by report; the memory store
// cannot prove absence, and no test here claims it does.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
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
