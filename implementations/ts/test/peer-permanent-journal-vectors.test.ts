import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contentAddress } from "../src/delta/hash.js";
import { parseClaims } from "../src/delta/json-profile.js";
import type { Delta } from "../src/delta/types.js";
import { encodeDurablePeerState } from "../src/federation/durable-state.js";
import {
  applyPermanentPeerFrame,
  decodePermanentPeerFrame,
  encodePermanentPeerFrame,
  replayPermanentPeerFrames,
} from "../src/federation/permanent-journal.js";

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/peer/permanent-journal.json", import.meta.url)),
    "utf8",
  ),
) as {
  peerId: string;
  order: { id: string; sig: string; claims: unknown };
  frames: Array<{ kind: string; hex: string; head: string }>;
  pendingImageHex: string;
  removedImageHex: string;
  expected: {
    refusedTarget: string;
    orderId: string;
    priorEpoch: number;
    obligationSequence: number;
    generation: number;
  };
  brokenChainError: string;
  missingObligationError: string;
  signedTargetError: string;
  falseHeld: { hex: string; head: string; error: string };
  payloadProbe: {
    marker: string;
    targetId: string;
    ordinaryHex: string;
    erasureHex: string;
    rebaseHex: string;
    rebaseHead: string;
  };
};

const images = vector.frames.map((row) => Uint8Array.from(Buffer.from(row.hex, "hex")));
const order: Delta = {
  id: vector.order.id,
  sig: vector.order.sig,
  claims: parseClaims(vector.order.claims),
};

describe("shared SPEC-6 permanent journal", () => {
  it("omits an erased payload from the replacement anchor", () => {
    const probe = vector.payloadProbe;
    const marker = Buffer.from(probe.marker);
    expect(Buffer.from(probe.ordinaryHex, "hex").includes(marker)).toBe(true);
    expect(Buffer.from(probe.rebaseHex, "hex").includes(marker)).toBe(false);
    const rebased = replayPermanentPeerFrames(
      vector.peerId,
      [],
      probe.rebaseHead,
      Buffer.from(probe.rebaseHex, "hex"),
    );
    expect(rebased.base.refusedIds.has(probe.targetId)).toBe(true);
    expect(rebased.base.admitted.has(probe.targetId)).toBe(false);
  });
  it("rejects a replay frame claiming a held target has no bytes", () => {
    const forged = Uint8Array.from(Buffer.from(vector.falseHeld.hex, "hex"));
    expect(() =>
      replayPermanentPeerFrames(vector.peerId, [images[0]!, forged], vector.falseHeld.head),
    ).toThrow(vector.falseHeld.error);
  });
  it("replays a signed order, permanent refusal, pending debt, and physical-absence report", () => {
    for (let i = 0; i < images.length; i++)
      expect(contentAddress(images[i]!)).toBe(vector.frames[i]!.head);
    const admission = decodePermanentPeerFrame(images[1]!);
    const purge = decodePermanentPeerFrame(images[2]!);
    expect(Buffer.from(encodePermanentPeerFrame(admission)).toString("hex")).toBe(
      vector.frames[1]!.hex,
    );
    expect(Buffer.from(encodePermanentPeerFrame(purge)).toString("hex")).toBe(
      vector.frames[2]!.hex,
    );
    const pending = replayPermanentPeerFrames(
      vector.peerId,
      images.slice(0, 2),
      vector.frames[1]!.head,
    );
    expect(Buffer.from(encodeDurablePeerState(pending)).toString("hex")).toBe(
      vector.pendingImageHex,
    );
    expect(pending.base.refusedIds.has(vector.expected.refusedTarget)).toBe(true);
    expect(pending.base.admitted.has(vector.expected.refusedTarget)).toBe(false);
    expect(pending.base.admitted.has(vector.expected.orderId)).toBe(true);
    expect(pending.events[0]?.priorEpoch).toBe(vector.expected.priorEpoch);
    expect(pending.obligations[0]).toMatchObject({
      sequence: vector.expected.obligationSequence,
      generation: vector.expected.generation,
      status: "pending",
    });
    const removed = replayPermanentPeerFrames(vector.peerId, images, vector.frames[2]!.head);
    expect(Buffer.from(encodeDurablePeerState(removed)).toString("hex")).toBe(
      vector.removedImageHex,
    );
    expect(removed.obligations[0]?.status).toBe("removed");
    expect(() => applyPermanentPeerFrame(removed, purge)).toThrow(vector.missingObligationError);
  });

  it("rejects a broken chain and a signed order bound to another target", () => {
    expect(() =>
      replayPermanentPeerFrames(vector.peerId, images.slice(1), vector.frames[1]!.head),
    ).toThrow(vector.brokenChainError);
    const frame = decodePermanentPeerFrame(images[1]!);
    if (frame.kind !== "admission") throw new Error("expected admission");
    expect(() =>
      encodePermanentPeerFrame({
        ...frame,
        additions: [order],
        erasures: [{ ...frame.erasures[0]!, targetId: order.id }],
      }),
    ).toThrow(vector.signedTargetError);
  });
});
