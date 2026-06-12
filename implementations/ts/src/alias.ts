// Relation signatures (SPEC-9 §5): the deterministic answer to "what relation shape does this
// delta instantiate?" — the librarian's input, never part of evaluation semantics.

import { array, encode, tstr } from "./cbor.js";
import { bytesToHex } from "./hash.js";
import type { Delta } from "./types.js";

function byteCompare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

// The [role, context] pairs ([role] when the pointer has no context) of the delta's EntityRef
// pointers, sorted bytewise by their canonical CBOR encoding. Primitive and DeltaRef pointers
// contribute nothing: primitives are not vertices (SPEC-1 §2.3); delta references are plumbing.
export function relationSignature(delta: Delta): readonly (readonly string[])[] {
  const pairs: { pair: string[]; bytes: Uint8Array }[] = [];
  for (const ptr of delta.claims.pointers) {
    if (ptr.target.kind !== "entity") continue;
    const context = ptr.target.entity.context;
    const pair = context === undefined ? [ptr.role] : [ptr.role, context];
    pairs.push({ pair, bytes: encode(array(pair.map(tstr))) });
  }
  pairs.sort((a, b) => byteCompare(a.bytes, b.bytes));
  return pairs.map((p) => p.pair);
}

// The signature's canonical form: the canonical CBOR of the sorted array of pairs.
export function relationSignatureCanonicalHex(delta: Delta): string {
  const pairs = relationSignature(delta).map((pair) => array(pair.map(tstr)));
  return bytesToHex(encode(array(pairs)));
}
