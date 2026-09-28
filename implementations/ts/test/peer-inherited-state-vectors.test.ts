import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contentAddress } from "../src/delta/hash.js";
import { decodeDurablePeerState } from "../src/federation/durable-state.js";
import {
  completeRefusalSnapshot,
  decodeClosedPeerState,
  encodeClosedPeerState,
  readClosedPeerState,
  stageClosedPeerState,
  type ClosedPeerState,
} from "../src/federation/inherited-state.js";
import {
  decodeRefusalSnapshot,
  encodeRefusalSnapshot,
  localRefusalSnapshot,
} from "../src/federation/refusal-snapshot.js";

interface Case {
  name: string;
  localCase: number;
  inheritedCase?: number;
  inheritedDurableCase?: number;
  newPeerId: string;
  expectedHex: string;
  fullDigest: string;
  secondHopDigest?: string;
}
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/inherited-state.json"), "utf8"),
) as {
  cases: Case[];
  invalidCases: Array<Case & { expected: string }>;
  stageCases: Array<{
    name: string;
    case: number;
    backup: "missing" | "corrupt" | "valid";
    samePath?: boolean;
    expected: string;
  }>;
};
const durable = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/durable-state.json"), "utf8"),
) as { cases: Array<{ expectedHex: string }> };
const refusal = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/refusal-snapshot.json"), "utf8"),
) as { cases: Array<{ expectedHex: string }> };

function local(index: number, peerId: string) {
  const original = decodeDurablePeerState(
    Buffer.from(durable.cases[index]!.expectedHex, "hex"),
    "peer-A",
  );
  return {
    ...original,
    base: {
      ...original.base,
      peerId,
      arrivals: original.base.arrivals.map((row) => ({
        ...row,
        at: 999 + row.transfer,
        sender: row.transfer === 1 ? "peer-A" : peerId,
      })),
    },
  };
}

function fromCase(c: Case): ClosedPeerState {
  const inherited =
    c.inheritedCase === undefined
      ? localRefusalSnapshot(
          decodeDurablePeerState(
            Buffer.from(durable.cases[c.inheritedDurableCase!]!.expectedHex, "hex"),
            "peer-A",
          ),
        )
      : decodeRefusalSnapshot(Buffer.from(refusal.cases[c.inheritedCase]!.expectedHex, "hex"));
  return { local: local(c.localCase, c.newPeerId), inherited };
}

describe("shared SPEC-6 closed inherited state", () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const state = fromCase(c);
      const image = encodeClosedPeerState(state);
      expect(Buffer.from(image).toString("hex")).toBe(c.expectedHex);
      expect(contentAddress(encodeRefusalSnapshot(completeRefusalSnapshot(state)))).toBe(
        c.fullDigest,
      );
      const restored = decodeClosedPeerState(image, c.newPeerId);
      expect(Buffer.from(encodeClosedPeerState(restored))).toEqual(Buffer.from(image));
      expect(restored.inherited).toEqual(state.inherited);
      expect(() => decodeClosedPeerState(image, "wrong-peer")).toThrow("wrong peer id");
      if (c.secondHopDigest !== undefined) {
        const second: ClosedPeerState = {
          local: local(0, "peer-final"),
          inherited: completeRefusalSnapshot(restored),
        };
        const reopened = decodeClosedPeerState(encodeClosedPeerState(second), "peer-final");
        expect(contentAddress(encodeRefusalSnapshot(completeRefusalSnapshot(reopened)))).toBe(
          c.secondHopDigest,
        );
        expect(reopened.inherited.events).toHaveLength(
          state.inherited.events.length + state.local.events.length,
        );
      }
    });
  }

  for (const c of vector.invalidCases) {
    it(c.name, () => {
      expect(() => encodeClosedPeerState(fromCase(c))).toThrow(c.expected);
    });
  }

  for (const stage of vector.stageCases) {
    it(stage.name, () => {
      const c = vector.cases[stage.case]!;
      const state = fromCase(c);
      const dir = mkdtempSync(join(tmpdir(), "rhizomatic-closed-"));
      const primary = join(dir, "primary");
      const backup = join(dir, "backup");
      try {
        if (stage.backup !== "missing")
          writeFileSync(
            backup,
            stage.backup === "valid" ? encodeRefusalSnapshot(state.inherited) : new Uint8Array([0]),
          );
        const write = () => stageClosedPeerState(primary, stage.samePath ? primary : backup, state);
        if (stage.expected === "durable") {
          expect(write().status).toBe("durable");
          expect(Buffer.from(readFileSync(primary)).toString("hex")).toBe(c.expectedHex);
          expect(readClosedPeerState(primary, c.newPeerId)?.inherited).toEqual(state.inherited);
          expect(() => write()).toThrow("stage already exists");
        } else {
          if (stage.expected === "error") expect(write).toThrow();
          else expect(write).toThrow(stage.expected);
          expect(readClosedPeerState(primary, c.newPeerId)).toBeUndefined();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
