import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/json-profile.js";
import { DeltaSet } from "../src/set.js";
import {
  decodePeerState,
  encodePeerState,
  readPeerState,
  writePeerState,
  type PeerState,
} from "../src/federation/peer-state.js";
import type { ArrivalRecord } from "../src/federation/arrival.js";
import type { Delta } from "../src/types.js";

interface StateCase {
  name: string;
  peerId: string;
  admitted: string[];
  cursor: { lastSequence: number; lastTransfer: number };
  arrivals: Array<Omit<ArrivalRecord, "id"> & { id: string }>;
  refused: string[];
  expectedHex: string;
}
const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/principal/evidence.json"), "utf8"),
) as { deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }> };
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/state.json"), "utf8"),
) as {
  cases: StateCase[];
  invalidCases: Array<{ name: string; base: number; mutation: string; expected: string }>;
};
const invalidImages = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/state-invalid.json"), "utf8"),
) as { cases: Array<{ name: string; hex: string; expectedPeerId: string; error: string }> };
const named = new Map<string, Delta>(
  fixture.deltas.map((row) => [
    row.name,
    { id: row.id, claims: parseClaims(row.claims), ...(row.sig ? { sig: row.sig } : {}) },
  ]),
);
const fromCase = (c: StateCase): PeerState => ({
  peerId: c.peerId,
  admitted: DeltaSet.from(c.admitted.map((name) => named.get(name)!)),
  cursor: c.cursor,
  arrivals: c.arrivals.map((row) => ({ ...row, id: named.get(row.id)!.id })),
  refusedIds: new Set(c.refused.map((name) => named.get(name)!.id)),
});

describe("shared SPEC-6 peer state image vectors", () => {
  for (const c of invalidImages.cases) {
    it(`rejects image bytes: ${c.name}`, () => {
      expect(() => decodePeerState(Buffer.from(c.hex, "hex"), c.expectedPeerId)).toThrow(c.error);
    });
  }
  for (const c of vector.cases) {
    it(c.name, () => {
      const state = fromCase(c);
      const bytes = encodePeerState(state);
      expect(Buffer.from(bytes).toString("hex")).toBe(c.expectedHex);
      const restored = decodePeerState(bytes, c.peerId);
      expect(restored.admitted.ids()).toEqual(state.admitted.ids());
      expect(restored.arrivals).toEqual(state.arrivals);
      expect([...restored.refusedIds]).toEqual([...state.refusedIds]);
      expect(restored.cursor).toEqual(state.cursor);
      expect(() => decodePeerState(bytes, "another-peer")).toThrow("wrong peer id");
    });
  }

  for (const c of vector.invalidCases) {
    it(c.name, () => {
      const state = fromCase(vector.cases[c.base]!);
      switch (c.mutation) {
        case "cursorGap":
          expect(() =>
            encodePeerState({ ...state, cursor: { ...state.cursor, lastSequence: 1 } }),
          ).toThrow(c.expected);
          break;
        case "refuseActive":
          expect(() =>
            encodePeerState({ ...state, refusedIds: new Set(state.admitted.ids()) }),
          ).toThrow(c.expected);
          break;
        case "duplicateSequence":
          expect(() =>
            encodePeerState({
              ...state,
              arrivals: state.arrivals.map((row, i) => (i === 1 ? { ...row, sequence: 1 } : row)),
            }),
          ).toThrow(c.expected);
          break;
        case "forgedSignature": {
          const delta = [...state.admitted][0]!;
          expect(() =>
            encodePeerState({
              ...state,
              admitted: DeltaSet.from([{ ...delta, sig: "00".repeat(64) }]),
            }),
          ).toThrow(c.expected);
          break;
        }
        case "junkArrivalId":
          expect(() =>
            encodePeerState({ ...state, arrivals: [{ ...state.arrivals[0]!, id: "x" }] }),
          ).toThrow(c.expected);
          break;
        case "junkRefusedId":
          expect(() => encodePeerState({ ...state, refusedIds: new Set(["x"]) })).toThrow(
            c.expected,
          );
          break;
        case "repeatedEpoch":
          expect(() =>
            encodePeerState({
              ...state,
              arrivals: [state.arrivals[0]!, { ...state.arrivals[1]!, id: state.arrivals[0]!.id }],
            }),
          ).toThrow(c.expected);
          break;
        case "lostHoldingAndRefusal":
          expect(() => encodePeerState({ ...state, refusedIds: new Set() })).toThrow(c.expected);
          break;
        default:
          throw new Error(`unknown mutation ${c.mutation}`);
      }
    });
  }

  it("replaces one complete image and restores it after reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "rhizomatic-peer-state-"));
    const path = join(dir, "peer.bin");
    try {
      expect(readPeerState(path, "peer-A")).toBeUndefined();
      for (const c of vector.cases) {
        expect(writePeerState(path, fromCase(c))).toEqual({ status: "durable" });
        expect(Buffer.from(readFileSync(path)).toString("hex")).toBe(c.expectedHex);
        expect(readPeerState(path, "peer-A")!.cursor).toEqual(c.cursor);
        if (c.name === "first admission") {
          const beforeSignatureChange = readFileSync(path);
          const state = fromCase(c);
          const delta = [...state.admitted][0]!;
          expect(() =>
            writePeerState(path, {
              ...state,
              admitted: DeltaSet.from([{ id: delta.id, claims: delta.claims }]),
            }),
          ).toThrow("admitted signature changed");
          expect(readFileSync(path)).toEqual(beforeSignatureChange);
        }
      }
      const before = readFileSync(path);
      expect(() =>
        writePeerState(path, {
          ...fromCase(vector.cases[2]!),
          cursor: { lastSequence: 1, lastTransfer: 2 },
        }),
      ).toThrow("arrival history");
      expect(readFileSync(path)).toEqual(before);
      expect(() => writePeerState(path, fromCase(vector.cases[1]!))).toThrow(
        "arrival history cannot shrink",
      );
      expect(readFileSync(path)).toEqual(before);
      const removedRefusal = fromCase(vector.cases[2]!);
      expect(() =>
        writePeerState(path, {
          ...removedRefusal,
          admitted: DeltaSet.from([...removedRefusal.admitted, named.get("userRootDeclaration")!]),
          refusedIds: new Set(),
        }),
      ).toThrow("permanent refusal cannot be removed");
      expect(readFileSync(path)).toEqual(before);
      expect(() =>
        writePeerState(path, { ...fromCase(vector.cases[2]!), peerId: "other-peer" }),
      ).toThrow("wrong peer id");
      expect(readFileSync(path)).toEqual(before);
      writeFileSync(path, Uint8Array.of(0xff));
      expect(() => readPeerState(path, "peer-A")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects text that cannot survive UTF-8 encoding", () => {
    const state = fromCase(vector.cases[0]!);
    expect(() => encodePeerState({ ...state, peerId: "peer-\ud800" })).toThrow(
      "invalid peer id text",
    );
    const arrived = fromCase(vector.cases[1]!);
    expect(() =>
      encodePeerState({
        ...arrived,
        arrivals: [{ ...arrived.arrivals[0]!, sender: "peer-\ud800" }],
      }),
    ).toThrow("invalid arrival record");
  });

  it("rejects huge malformed container lengths before loading peer state", () => {
    const cases = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../../../vectors/l0-delta/cbor-invalid-length.json"),
        "utf8",
      ),
    ) as Array<{ hex: string; error: string }>;
    for (const c of cases)
      expect(() => decodePeerState(Buffer.from(c.hex, "hex"), "peer-A")).toThrow(c.error);
  });

  it("rejects excessive nesting before loading peer state", () => {
    const cases = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../../../vectors/l0-delta/cbor-nesting.json"),
        "utf8",
      ),
    ) as Array<{ prefixHex: string; repeat: number; suffixHex: string; expected: string }>;
    for (const c of cases.filter((c) => c.expected !== "valid")) {
      expect(() =>
        decodePeerState(Buffer.from(c.prefixHex.repeat(c.repeat) + c.suffixHex, "hex"), "peer-A"),
      ).toThrow(c.expected);
    }
  });
});
