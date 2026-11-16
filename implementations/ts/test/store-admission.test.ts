// Two admission rules that every store keeps alike (SPEC-18 §4.11 readings 21 and 34; §4.13
// reading 106), run on the memory store and the SQLite store: an entry that cannot be read is
// malformed, whatever it throws; and -0 answers as +0, the value the canonical encoding writes.

import { afterAll, describe, expect, it } from "vitest";
import { makeDelta } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { StoreError, type Store, type StoreErrorCode } from "../src/storage/store.js";
import { sqliteFixture } from "./support/sqlite-fixture.js";

const fixture = sqliteFixture("rhizomatic-admission");
afterAll(() => fixture.cleanup());

const AUTHOR = `ed25519:${"0f".repeat(32)}`;
const stores: Record<string, () => Promise<Store>> = {
  memory: async () => createMemoryStore(),
  sqlite: () => fixture.open(),
};

const refusal = async (call: Promise<unknown>): Promise<StoreErrorCode | "answered"> =>
  call.then(
    () => "answered" as const,
    (error: unknown) => {
      if (error instanceof StoreError) return error.code;
      throw error;
    },
  );

for (const [name, open] of Object.entries(stores))
  describe(`admission: the ${name} store`, () => {
    it("an entry whose getter throws is malformed, also when it throws a StoreError", async () => {
      const peer = await (await open()).createPeer("peer:a", { erasure: "unproven" });
      for (const thrown of [new StoreError("store-closed", "a caller's refusal"), new Error("x")]) {
        const entry = {
          get delta(): Delta {
            throw thrown;
          },
          arrival: { id: "x", at: 1, sequence: 1, transfer: 1, sender: "s" },
        };
        expect(
          await refusal(
            peer.append({ expectedHead: null, nextHead: "h", frame: null, added: [entry] }),
          ),
        ).toBe("invalid-admission");
      }
    });

    it("-0 in the claims and in an arrival time answers +0", async () => {
      const peer = await (await open()).createPeer("peer:a", { erasure: "unproven" });
      const claims = {
        timestamp: -0,
        validFrom: -0,
        validUntil: 1,
        author: AUTHOR,
        pointers: [
          { role: "about", target: { kind: "entity" as const, entity: { id: "z" } } },
          { role: "n", target: { kind: "primitive" as const, value: -0 } },
        ],
      };
      const delta = makeDelta(claims);
      expect(delta.id).toBe(makeDelta({ ...claims, timestamp: 0, validFrom: 0 }).id);
      await peer.append({
        expectedHead: null,
        nextHead: "h",
        frame: null,
        added: [
          { delta, arrival: { id: delta.id, at: -0, sequence: 1, transfer: 1, sender: "s" } },
        ],
      });
      const snapshot = await peer.read();
      const [read] = await snapshot.get([delta.id]);
      const [arrival] = await snapshot.arrivals([delta.id]);
      const target = read!.claims.pointers[1]!.target;
      const zeros = [
        read!.claims.timestamp,
        read!.claims.validFrom,
        target.kind === "primitive" ? target.value : null,
        arrival!.at,
      ];
      expect(zeros.map((value) => Object.is(value, 0))).toEqual([true, true, true, true]);
      const [scoped] = (await snapshot.scope({ anchors: [{ kind: "entity", entity: "z" }] }))
        .deltas;
      expect([
        Object.is(scoped!.delta.claims.timestamp, 0),
        Object.is(scoped!.arrival.at, 0),
      ]).toEqual([true, true]);
    });
  });
