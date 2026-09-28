import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isCanonicalPeerId, samePeerId } from "../src/federation/peer-identity.js";

const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/peer-identity.json"), "utf8"),
) as {
  canonicalCases: Array<{ id: string; valid: boolean }>;
  sameCases: Array<{ a: string; b: string; same: boolean }>;
};

describe("shared SPEC-6 peer key identity", () => {
  it("accepts only the canonical v1 spelling", () => {
    for (const c of vector.canonicalCases) expect(isCanonicalPeerId(c.id)).toBe(c.valid);
  });
  it("recognizes key aliases before identity checks", () => {
    for (const c of vector.sameCases) {
      expect(samePeerId(c.a, c.b)).toBe(c.same);
      expect(samePeerId(c.b, c.a)).toBe(c.same);
    }
  });
});
