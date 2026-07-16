// Ed25519 signing & verification (SPEC-1 §5, ERRATA D8-D9). Deterministic (RFC 8032), so
// signatures are reproducible across implementations and pinned in vectors.

import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
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

const Point = ed25519.ExtendedPoint;
const L = ed25519.CURVE.n;

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

// The SPEC-1 §5.1 strict criterion (ERRATA D13), implemented check by check — deliberately NOT a
// library default, because "strict" varies subtly between libraries and the spec text is the
// criterion. Pinned by vectors/l0-delta/deltas-sig-edge.json.
function verifySigStrict(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  if (sig.length !== 64 || pub.length !== 32) return false;
  const rBytes = sig.subarray(0, 32);
  // 1. canonical scalar: S < L
  const s = bytesToNumberLE(sig.subarray(32));
  if (s >= L) return false;
  // 2./3. canonical point encodings (fromHex without zip215 rejects y ≥ p and -0)
  let A: InstanceType<typeof Point>;
  let R: InstanceType<typeof Point>;
  try {
    A = Point.fromHex(pub, false);
    R = Point.fromHex(rBytes, false);
  } catch {
    return false;
  }
  // 4. no small-order components
  if (A.isSmallOrder() || R.isSmallOrder()) return false;
  // 5. cofactorless equation: [S]B = R + [k]A, k = SHA-512(R ‖ A ‖ M) mod L
  const k = bytesToNumberLE(sha512(concatBytes(rBytes, pub, msg))) % L;
  const lhs = Point.BASE.multiplyUnsafe(s);
  const rhs = R.add(A.multiplyUnsafe(k));
  return lhs.equals(rhs);
}

// Full verification per ERRATA D9: content addressing must hold, then the signature must verify
// over the raw id bytes against the key named in `author`, under the §5.1 strict criterion.
export function verifyDelta(delta: Delta): Verification {
  if (computeId(delta.claims) !== delta.id) return "invalid";
  if (delta.sig === undefined) return "unsigned";
  if (!delta.claims.author.startsWith(AUTHOR_PREFIX)) return "invalid";
  const pubHex = delta.claims.author.slice(AUTHOR_PREFIX.length);
  try {
    return verifySigStrict(hexToBytes(delta.sig), hexToBytes(delta.id), hexToBytes(pubHex))
      ? "verified"
      : "invalid";
  } catch {
    return "invalid";
  }
}
