import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalHex, computeId } from "../src/delta.js";
import { parseClaims } from "../src/json-profile.js";
import { publicKeyFromSeed, signClaims, verifyDelta } from "../src/sign.js";
import type { Delta } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  JSON.parse(readFileSync(resolve(here, "../../../vectors", rel), "utf8")) as never;

interface KeyVector {
  keyId: string;
  seedHex: string;
  publicKeyHex: string;
  author: string;
}

interface SignedVector {
  name: string;
  keyId: string;
  claims: unknown;
  canonicalCborHex: string;
  id: string;
  sig: string;
}

const keys = read("keys/keys.json") as KeyVector[];
const signed = read("l0-delta/deltas-signed.json") as SignedVector[];

describe("test keys (vectors/keys/keys.json)", () => {
  for (const k of keys) {
    it(`${k.keyId} public key derives from seed`, () => {
      expect(publicKeyFromSeed(k.seedHex)).toBe(k.publicKeyHex);
      expect(k.author).toBe(`ed25519:${k.publicKeyHex}`);
    });
  }
});

describe("signed delta vectors (ERRATA D8-D9)", () => {
  for (const v of signed) {
    it(`${v.name}: canonical bytes, id, deterministic signature, verification`, () => {
      const key = keys.find((k) => k.keyId === v.keyId)!;
      const claims = parseClaims(v.claims);
      expect(canonicalHex(claims)).toBe(v.canonicalCborHex);
      expect(computeId(claims)).toBe(v.id);
      // RFC 8032 determinism: re-signing reproduces the pinned signature bytes.
      const resigned = signClaims(claims, key.seedHex);
      expect(resigned.sig).toBe(v.sig);
      expect(verifyDelta({ id: v.id, claims, sig: v.sig })).toBe("verified");
    });
  }

  it("rejects a signature over tampered claims", () => {
    const v = signed[0]!;
    const claims = parseClaims(v.claims);
    const tampered = { ...claims, timestamp: claims.timestamp + 1 };
    // id recomputation fails first (content addressing), so this is invalid.
    expect(verifyDelta({ id: v.id, claims: tampered, sig: v.sig })).toBe("invalid");
  });

  it("rejects a flipped signature byte", () => {
    const v = signed[0]!;
    const claims = parseClaims(v.claims);
    const flipped = (v.sig[0] === "0" ? "1" : "0") + v.sig.slice(1);
    expect(verifyDelta({ id: v.id, claims, sig: flipped })).toBe("invalid");
  });

  it("reports unsigned deltas as unsigned, not invalid", () => {
    const v = signed[0]!;
    const claims = parseClaims(v.claims);
    const unsigned: Delta = { id: v.id, claims };
    expect(verifyDelta(unsigned)).toBe("unsigned");
  });

  it("refuses to sign claims whose author mismatches the key (ERRATA D8)", () => {
    const key = keys[0]!;
    const claims = parseClaims({
      timestamp: 0,
      author: "ed25519:0000000000000000000000000000000000000000000000000000000000000000",
      pointers: [{ role: "x", target: "y" }],
    });
    expect(() => signClaims(claims, key.seedHex)).toThrow(/author must be/);
  });
});
