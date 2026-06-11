import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalHex, computeId } from "../src/delta.js";
import { parseClaims } from "../src/json-profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const deltasPath = resolve(here, "../../../vectors/l0-delta/deltas.json");

interface DeltaVector {
  name: string;
  spec: string;
  claims: unknown;
  canonicalCborHex: string;
  id: string;
}

const deltas = JSON.parse(readFileSync(deltasPath, "utf8")) as DeltaVector[];

describe("l0-delta vectors (canonical bytes + content address)", () => {
  for (const v of deltas) {
    it(v.name, () => {
      const claims = parseClaims(v.claims);
      expect(canonicalHex(claims)).toBe(v.canonicalCborHex);
      expect(computeId(claims)).toBe(v.id);
    });
  }

  it("pointer order is significant for the id", () => {
    const a = parseClaims({
      timestamp: 0,
      author: "did:key:zA",
      pointers: [
        { role: "x", target: "1" },
        { role: "y", target: "2" },
      ],
    });
    const b = parseClaims({
      timestamp: 0,
      author: "did:key:zA",
      pointers: [
        { role: "y", target: "2" },
        { role: "x", target: "1" },
      ],
    });
    expect(computeId(a)).not.toBe(computeId(b));
  });
});
