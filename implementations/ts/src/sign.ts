// Ed25519 signing & verification (SPEC-1 §5, ERRATA D8-D9). Deterministic (RFC 8032), so
// signatures are reproducible across implementations and pinned in vectors.

import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { computeId } from "./delta.js";
import type { Claims, Delta } from "./types.js";

export const AUTHOR_PREFIX = "ed25519:";

export function publicKeyFromSeed(seedHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)));
}

// The author string a signed delta MUST carry for this seed (ERRATA D8).
export function authorForSeed(seedHex: string): string {
  return AUTHOR_PREFIX + publicKeyFromSeed(seedHex);
}

// Sign claims, producing a complete delta. Refuses to sign claims whose author does not match
// the signing key — a signature contradicting its own author field is born broken (ERRATA D8).
export function signClaims(claims: Claims, seedHex: string): Delta {
  const expected = authorForSeed(seedHex);
  if (claims.author !== expected) {
    throw new Error(`author must be ${expected} for this signing key, got ${claims.author}`);
  }
  const id = computeId(claims);
  const sig = bytesToHex(ed25519.sign(hexToBytes(id), hexToBytes(seedHex)));
  return { id, claims, sig };
}

export type Verification = "verified" | "unsigned" | "invalid";

// Full verification per ERRATA D9: content addressing must hold, then the signature must verify
// over the raw id bytes against the key named in `author`.
export function verifyDelta(delta: Delta): Verification {
  if (computeId(delta.claims) !== delta.id) return "invalid";
  if (delta.sig === undefined) return "unsigned";
  if (!delta.claims.author.startsWith(AUTHOR_PREFIX)) return "invalid";
  const pubHex = delta.claims.author.slice(AUTHOR_PREFIX.length);
  try {
    return ed25519.verify(hexToBytes(delta.sig), hexToBytes(delta.id), hexToBytes(pubHex))
      ? "verified"
      : "invalid";
  } catch {
    return "invalid";
  }
}
