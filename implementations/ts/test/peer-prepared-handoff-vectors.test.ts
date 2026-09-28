import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { authorForSeed } from "../src/delta/sign.js";
import {
  decodeClosedImportState,
  type ClosedImportState,
} from "../src/federation/closed-import.js";
import {
  decodePreparedHandoff,
  encodePreparedHandoffClaim,
  preparedDescriptorFromStage,
  signPreparedHandoff,
  verifyPreparedMatchesStage,
  type PreparedHandoffDescriptor,
} from "../src/federation/prepared-handoff.js";

const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/prepared-handoff.json"), "utf8"),
) as {
  oldSeedHex: string;
  newSeedHex: string;
  cases: Array<{
    name: string;
    baseCase: number;
    surfaceId: string;
    descriptor: PreparedHandoffDescriptor;
    expectedClaimHex: string;
    expectedSignedHex: string;
  }>;
  invalidCases: Array<{ name: string; mutation: string }>;
  invalidImages: Array<{ name: string; expectedHex: string; expected: string }>;
};
const closed = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/closed-import.json"), "utf8"),
) as { cases: Array<{ expectedHex: string }> };

function stage(baseCase: number): ClosedImportState {
  const base = decodeClosedImportState(
    Buffer.from(closed.cases[baseCase]!.expectedHex, "hex"),
    "peer-new",
  );
  return {
    ...base,
    oldPeerId: authorForSeed(vector.oldSeedHex),
    closed: {
      ...base.closed,
      local: {
        ...base.closed.local,
        base: { ...base.closed.local.base, peerId: authorForSeed(vector.newSeedHex) },
      },
    },
  };
}

function changed(
  descriptor: PreparedHandoffDescriptor,
  mutation: string,
): PreparedHandoffDescriptor {
  switch (mutation) {
    case "attempt":
      return { ...descriptor, attemptId: "different-attempt" };
    case "surface":
      return { ...descriptor, surfaceId: "other-pool" };
    case "old-version":
      return { ...descriptor, oldStateVersion: descriptor.oldStateVersion + 1 };
    case "deadline":
      return { ...descriptor, deadline: descriptor.deadline + 1 };
    case "new-peer":
      return { ...descriptor, newPeerId: authorForSeed("03".repeat(32)) };
    case "refusal-digest":
      return { ...descriptor, refusalDigest: descriptor.policyDigest };
    case "carried-digest":
      return { ...descriptor, carriedDigest: descriptor.refusalDigest };
    case "policy-digest":
      return { ...descriptor, policyDigest: descriptor.carriedDigest };
    case "old-peer":
      return { ...descriptor, oldPeerId: authorForSeed("03".repeat(32)) };
    default:
      throw new Error(`unknown mutation ${mutation}`);
  }
}

describe("shared SPEC-6 signed prepared handoff descriptor", () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const state = stage(c.baseCase);
      const descriptor = preparedDescriptorFromStage(state, c.surfaceId);
      expect(descriptor).toEqual(c.descriptor);
      expect(Buffer.from(encodePreparedHandoffClaim(descriptor)).toString("hex")).toBe(
        c.expectedClaimHex,
      );
      const signed = signPreparedHandoff(descriptor, vector.oldSeedHex);
      expect(Buffer.from(signed).toString("hex")).toBe(c.expectedSignedHex);
      expect(decodePreparedHandoff(signed)).toEqual(descriptor);
      expect(verifyPreparedMatchesStage(signed, state, c.surfaceId)).toEqual(descriptor);
    });
  }

  for (const c of vector.invalidCases) {
    it(c.name, () => {
      const base = vector.cases[1]!;
      const state = stage(base.baseCase);
      const descriptor = preparedDescriptorFromStage(state, base.surfaceId);
      if (c.mutation === "wrong-seed") {
        expect(() => signPreparedHandoff(descriptor, vector.newSeedHex)).toThrow(
          "wrong old peer signing key",
        );
        return;
      }
      if (c.mutation === "signature") {
        const image = Uint8Array.from(signPreparedHandoff(descriptor, vector.oldSeedHex));
        image[image.length - 1]! ^= 1;
        expect(() => decodePreparedHandoff(image)).toThrow("invalid old peer signature");
        return;
      }
      if (c.mutation === "stage-policy") {
        const signed = signPreparedHandoff(descriptor, vector.oldSeedHex);
        expect(() =>
          verifyPreparedMatchesStage(
            signed,
            { ...state, policyBytes: new TextEncoder().encode("changed-policy") },
            base.surfaceId,
          ),
        ).toThrow("descriptor does not match closed stage");
        return;
      }
      const altered = changed(descriptor, c.mutation);
      const signingSeed = c.mutation === "old-peer" ? "03".repeat(32) : vector.oldSeedHex;
      const signed = signPreparedHandoff(altered, signingSeed);
      expect(decodePreparedHandoff(signed)).toEqual(altered);
      expect(() => verifyPreparedMatchesStage(signed, state, base.surfaceId)).toThrow(
        "descriptor does not match closed stage",
      );
    });
  }

  for (const c of vector.invalidImages) {
    it(c.name, () => {
      expect(() => decodePreparedHandoff(Buffer.from(c.expectedHex, "hex"))).toThrow(c.expected);
    });
  }
});
