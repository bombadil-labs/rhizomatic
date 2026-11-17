// Strings must be well-formed (SPEC-18 §4.13 reading 104; slice 4 plan S4-15), in every store. A
// lone surrogate has no UTF-8 form. SQLite binds it as U+FFFD directly and as its raw code unit
// through `json_each`, so a key with one could find another key's rows. The canonical encoding
// already refuses one in the claims. An append refuses one anywhere else in a batch, and a read
// refuses such a key, in the memory store and in the SQLite store alike.

import { afterAll, describe, expect, it } from "vitest";
import { computeId } from "../src/delta/delta.js";
import { makeDelta } from "../src/delta/set.js";
import type { Claims, Delta, Target } from "../src/delta/types.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import {
  StoreError,
  type Admission,
  type Store,
  type StoreErrorCode,
  type VerifiedDelta,
} from "../src/storage/store.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const fixture = sqliteFixture("rhizomatic-well-formed");
afterAll(() => fixture.cleanup());

const LONE = "\uD800";
const AUTHOR = `ed25519:${"0c".repeat(32)}`;

const claims = (target: Target, author = AUTHOR, role = "about"): Claims => ({
  timestamp: 1,
  validFrom: 0,
  author,
  pointers: [{ role, target }],
});
const entity = (id: string, context?: string): Target => ({
  kind: "entity",
  entity: context === undefined ? { id } : { id, context },
});

const refusal = async (call: Promise<unknown>): Promise<StoreErrorCode | "answered"> =>
  call.then(
    () => "answered" as const,
    (error: unknown) => {
      if (error instanceof StoreError) return error.code;
      throw error;
    },
  );

const stores: Record<string, () => Promise<Store>> = {
  memory: async () => createMemoryStore(),
  sqlite: () => fixture.open(),
};

it("the canonical encoding refuses a lone surrogate, so no claims carry one", () => {
  expect(() => computeId(claims(entity(`a${LONE}`)))).toThrow("not well-formed");
});

/** A delta whose claims cannot be encoded: its id is made up, and no store may admit it. */
const unencodable = (c: Claims): Delta => ({ id: "unencodable", claims: c });

for (const [name, open] of Object.entries(stores))
  describe(`well-formed strings: the ${name} store`, () => {
    async function peer() {
      const store = await open();
      const handle = await store.createPeer("peer:a", { erasure: "unproven" });
      let sequence = 0;
      const member = (delta: Delta, sender = "fixture"): VerifiedDelta => ({
        delta,
        arrival: { id: delta.id, at: 1, sequence: ++sequence, transfer: sequence, sender },
      });
      const batch = (added: VerifiedDelta[], nextHead = "head"): Admission => ({
        expectedHead: null,
        nextHead,
        frame: null,
        added,
      });
      return { store, handle, member, batch };
    }

    it("append refuses a string with a lone surrogate anywhere in the batch, and changes nothing", async () => {
      const { handle, member, batch } = await peer();
      const bad: Record<string, Admission> = {
        author: batch([member(unencodable(claims(entity("x"), `${AUTHOR}${LONE}`)))]),
        role: batch([member(unencodable(claims(entity("x"), AUTHOR, `r${LONE}`)))]),
        "entity id": batch([member(unencodable(claims(entity(`x${LONE}`))))]),
        context: batch([member(unencodable(claims(entity("x", `c${LONE}`))))]),
        "string value": batch([
          member(unencodable(claims({ kind: "primitive", value: `v${LONE}` }))),
        ]),
        "delta reference": batch([
          member(unencodable(claims({ kind: "delta", deltaRef: { delta: `d${LONE}` } }))),
        ]),
        mime: batch([
          member(
            unencodable(claims({ kind: "bytes", mime: `m${LONE}`, value: new Uint8Array([1]) })),
          ),
        ]),
        "arrival sender": batch([member(makeDelta(claims(entity("x"))), `s${LONE}`)]),
        "next head": batch([member(makeDelta(claims(entity("x"))))], `h${LONE}`),
      };
      for (const [where, admission] of Object.entries(bad))
        expect([where, await refusal(handle.append(admission))]).toEqual([
          where,
          "invalid-admission",
        ]);
      const snapshot = await handle.read();
      expect([snapshot.revision, snapshot.count, snapshot.head]).toEqual([0, 0, null]);
    });

    it("a read refuses a key with a lone surrogate, on a current and on a moved snapshot", async () => {
      const { handle, member, batch } = await peer();
      const moved = await handle.read();
      // Stored as U+FFFD by a direct bind, the key's other byte form: a read must not find it.
      const replaced = makeDelta(claims(entity("x\uFFFD")));
      const pair = makeDelta(claims(entity("x\u{1F331}")));
      await handle.append(batch([member(replaced), member(pair)]));
      const current = await handle.read();
      const key = `x${LONE}`;
      for (const [at, snapshot] of Object.entries({ current, moved })) {
        const calls: Record<string, () => Promise<unknown>> = {
          get: () => snapshot.get([key]),
          arrivals: () => snapshot.arrivals([key]),
          targets: () => snapshot.targets([key]),
          negators: () => snapshot.negators([key]),
          "scope anchor": () => snapshot.scope({ anchors: [{ kind: "entity", entity: key }] }),
          "scope excludeIds": () =>
            snapshot.scope({ anchors: [], pushdown: { excludeIds: [key] } }),
          "scope exclude": () => snapshot.scope({ anchors: [], exclude: [key] }),
        };
        for (const [what, call] of Object.entries(calls))
          expect([at, what, await refusal(call())]).toEqual([at, what, "invalid-request"]);
      }
      expect(await refusal(handle.purge([key]))).toBe("invalid-request");
      // U+FFFD and a surrogate pair are well-formed: each is stored and found with its bytes.
      expect(await current.targets(["x\uFFFD", "x\u{1F331}"])).toEqual(
        [replaced.id, pair.id].sort(),
      );
      expect(await current.get([pair.id])).toEqual([pair]);
    });

    it("a peer id or a minted history with a lone surrogate is refused", async () => {
      const store = await open();
      expect(await refusal(store.createPeer(`p${LONE}`, { erasure: "unproven" }))).toBe(
        "invalid-request",
      );
      expect(await refusal(store.peer(`p${LONE}`))).toBe("peer-absent");
      const minted =
        name === "memory"
          ? createMemoryStore({ mintHistory: () => `h${LONE}` })
          : await fixture.open({ mintHistory: () => `h${LONE}` });
      expect(await refusal(minted.createPeer("p", { erasure: "unproven" }))).toBe(
        "invalid-request",
      );
    });
  });
