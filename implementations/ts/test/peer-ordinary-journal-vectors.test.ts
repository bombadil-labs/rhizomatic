import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/delta/json-profile.js";
import type { Delta } from "../src/delta/types.js";
import { encodeDurablePeerState } from "../src/federation/durable-state.js";
import {
  decodeOrdinaryJournalCheckpoint,
  encodeOrdinaryJournalCheckpoint,
  decodeOrdinaryPeerFrame,
  encodeOrdinaryPeerFrame,
  ordinaryPeerFrameId,
  replayOrdinaryPeerFrames,
} from "../src/federation/ordinary-journal.js";

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/peer/ordinary-journal.json", import.meta.url)),
    "utf8",
  ),
) as {
  peerId: string;
  firstName: string;
  secondName: string;
  frames: Array<{ at: number; sender: string; prior: string; hex: string; head: string }>;
  expectedImageHex: string;
  checkpoint: {
    head: string;
    hex: string;
    retainedFrameHex: string;
    expectedImageHex: string;
    brokenBoundaryError: string;
  };
  expectedArrivals: unknown[];
  brokenChainError: string;
  headMismatchError: string;
  repeatedIdError: string;
  emptyFrameError: string;
};
const evidence = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/principal/evidence.json", import.meta.url)),
    "utf8",
  ),
) as { deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }> };
const named = new Map<string, Delta>(
  evidence.deltas.map((row) => [
    row.name,
    { id: row.id, claims: parseClaims(row.claims), ...(row.sig ? { sig: row.sig } : {}) },
  ]),
);
const additions = [named.get(vector.firstName)!, named.get(vector.secondName)!];
const bytes = vector.frames.map((row) => Uint8Array.from(Buffer.from(row.hex, "hex")));

describe("shared SPEC-6 ordinary journal vectors", () => {
  it("pins canonical bytes and the digest chain in both witnesses", () => {
    vector.frames.forEach((row, i) => {
      const encoded = encodeOrdinaryPeerFrame({
        peerId: vector.peerId,
        prior: row.prior,
        at: row.at,
        sender: row.sender,
        additions: [additions[i]!],
      });
      expect(Buffer.from(encoded).toString("hex")).toBe(row.hex);
      expect(ordinaryPeerFrameId(encoded)).toBe(row.head);
      expect(decodeOrdinaryPeerFrame(encoded).prior).toBe(row.prior);
    });
    const state = replayOrdinaryPeerFrames(vector.peerId, bytes, vector.frames.at(-1)!.head);
    expect(Buffer.from(encodeDurablePeerState(state)).toString("hex")).toBe(
      vector.expectedImageHex,
    );
    expect(state.base.arrivals).toEqual(vector.expectedArrivals);
  });

  it("fails closed on broken, repeated, empty, or mismatched history", () => {
    expect(() =>
      replayOrdinaryPeerFrames(vector.peerId, bytes.slice(1), vector.frames[1]!.head),
    ).toThrow(vector.brokenChainError);
    expect(() => replayOrdinaryPeerFrames(vector.peerId, bytes, vector.frames[0]!.head)).toThrow(
      vector.headMismatchError,
    );
    const repeated = encodeOrdinaryPeerFrame({
      peerId: vector.peerId,
      prior: vector.frames[0]!.head,
      at: 100,
      sender: "local",
      additions: [additions[0]!],
    });
    expect(() =>
      replayOrdinaryPeerFrames(vector.peerId, [bytes[0]!, repeated], ordinaryPeerFrameId(repeated)),
    ).toThrow(vector.repeatedIdError);
    expect(() =>
      encodeOrdinaryPeerFrame({
        peerId: vector.peerId,
        prior: "",
        at: 100,
        sender: "local",
        additions: [],
      }),
    ).toThrow(vector.emptyFrameError);
    const corrupt = Uint8Array.from(bytes[0]!);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect(() => decodeOrdinaryPeerFrame(corrupt)).toThrow();
  });

  it("pins a canonical checkpoint boundary and replays only its retained suffix", () => {
    const firstState = replayOrdinaryPeerFrames(
      vector.peerId,
      bytes.slice(0, 1),
      vector.checkpoint.head,
    );
    const checkpoint = encodeOrdinaryJournalCheckpoint({
      peerId: vector.peerId,
      head: vector.checkpoint.head,
      state: firstState,
    });
    expect(Buffer.from(checkpoint).toString("hex")).toBe(vector.checkpoint.hex);
    expect(decodeOrdinaryJournalCheckpoint(checkpoint).head).toBe(vector.checkpoint.head);
    expect(Buffer.from(bytes[1]!).toString("hex")).toBe(vector.checkpoint.retainedFrameHex);
    const state = replayOrdinaryPeerFrames(
      vector.peerId,
      bytes.slice(1),
      vector.frames[1]!.head,
      checkpoint,
    );
    expect(Buffer.from(encodeDurablePeerState(state)).toString("hex")).toBe(
      vector.checkpoint.expectedImageHex,
    );
    expect(() =>
      replayOrdinaryPeerFrames(vector.peerId, bytes, vector.frames[1]!.head, checkpoint),
    ).toThrow(vector.checkpoint.brokenBoundaryError);
    expect(() =>
      replayOrdinaryPeerFrames(vector.peerId, [], vector.frames[1]!.head, checkpoint),
    ).toThrow(vector.headMismatchError);
  });
});
