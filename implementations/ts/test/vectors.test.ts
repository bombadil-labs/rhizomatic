import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalHex, computeId } from "../src/delta.js";
import { parseClaims } from "../src/json-profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const deltasPath = resolve(here, "../../../vectors/l0-delta/deltas.json");
const invalidPath = resolve(here, "../../../vectors/l0-delta/deltas-invalid.json");

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

interface InvalidVector {
  name: string;
  spec: string;
  reason: string;
  claims: unknown;
}

const invalid = JSON.parse(readFileSync(invalidPath, "utf8")) as InvalidVector[];

describe("l0-delta invalid vectors (boundary rejection, SPEC-4 §2)", () => {
  for (const v of invalid) {
    it(`${v.name} — ${v.reason}`, () => {
      // Rejection may come from the profile parser or from claims validation;
      // the contract is only that ingestion MUST fail before canonical bytes exist.
      expect(() => canonicalHex(parseClaims(v.claims))).toThrow();
    });
  }
});

describe("assertValidClaims guards the direct API against untyped callers (issue #4)", () => {
  // Plain-JS consumers bypass the static Primitive type entirely; the runtime guard
  // must reject cleanly instead of crashing inside the CBOR encoder.
  const claimsWith = (target: unknown) =>
    ({
      timestamp: 0,
      author: "did:key:zA",
      pointers: [{ role: "r", target: { kind: "primitive", value: target } }],
    }) as unknown as Parameters<typeof canonicalHex>[0];

  it("null primitive rejects with a boundary error, not a CBOR crash", () => {
    expect(() => canonicalHex(claimsWith(null))).toThrow(/primitive value must be/);
  });

  it("object primitive rejects with a boundary error", () => {
    expect(() => canonicalHex(claimsWith({ nested: true }))).toThrow(/primitive value must be/);
  });

  it("non-string author rejects with a boundary error, not a TypeError", () => {
    const claims = {
      timestamp: 0,
      author: 42,
      pointers: [{ role: "r", target: { kind: "primitive", value: "x" } }],
    } as unknown as Parameters<typeof canonicalHex>[0];
    expect(() => canonicalHex(claims)).toThrow(/author must be a string/);
  });
});
