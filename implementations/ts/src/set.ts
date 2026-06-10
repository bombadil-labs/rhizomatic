// The delta set and its algebra (SPEC-1 §8): a mathematical set of deltas, deduplicated by id.
// merge is union (grow-only set CRDT), fork is filter, federate is merge of a filtered fork.
// There is no conflict at this layer — contradiction lives in superposition until evaluation.

import { array, encode, tstr } from "./cbor.js";
import { computeId } from "./delta.js";
import { contentAddress } from "./hash.js";
import type { Claims, Delta, Pointer } from "./types.js";

// Build a complete delta from claims (id computed, optional detached sig attached).
export function makeDelta(claims: Claims, sig?: string): Delta {
  const id = computeId(claims);
  return sig === undefined ? { id, claims } : { id, claims, sig };
}

// The negation vocabulary convention (SPEC-1 §7): an ordinary delta whose pointer targets the
// negated delta by content address under role "negates". Meaning is given at evaluation (mask).
export function makeNegationClaims(
  author: string,
  timestamp: number,
  targetDeltaId: string,
  reason?: string,
): Claims {
  const pointers: Pointer[] = [
    { role: "negates", target: { kind: "delta", deltaRef: { delta: targetDeltaId } } },
  ];
  if (reason !== undefined) {
    pointers.push({ role: "reason", target: { kind: "primitive", value: reason } });
  }
  return { timestamp, author, pointers };
}

export class DeltaSet implements Iterable<Delta> {
  private readonly byId = new Map<string, Delta>();

  static from(deltas: Iterable<Delta>): DeltaSet {
    const s = new DeltaSet();
    for (const d of deltas) s.add(d);
    return s;
  }

  // Idempotent insert; returns false when the id was already present. Verifies content
  // addressing on the way in (P6): a delta whose id does not recompute is rejected, never
  // repaired (SPEC-4 §2) — set semantics depend on true ids.
  add(delta: Delta): boolean {
    if (this.byId.has(delta.id)) return false;
    if (computeId(delta.claims) !== delta.id) {
      throw new Error(`delta id ${delta.id} does not match its claims (content addressing, P6)`);
    }
    this.byId.set(delta.id, delta);
    return true;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): Delta | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  [Symbol.iterator](): Iterator<Delta> {
    return this.byId.values();
  }

  // Sorted lexicographically — the canonical enumeration order.
  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  // Canonical membership fingerprint (ERRATA D10, provisional helper — not the SPEC-6 digest).
  digest(): string {
    return contentAddress(encode(array(this.ids().map(tstr))));
  }
}

// merge(A, B) = A ∪ B — commutative, associative, idempotent (SPEC-1 §8).
export function merge(a: DeltaSet, b: DeltaSet): DeltaSet {
  const s = DeltaSet.from(a);
  for (const d of b) s.add(d);
  return s;
}

// fork(A, p) = { d ∈ A : p(d) } — any filter yields a valid delta set (SPEC-1 §8).
export function fork(a: DeltaSet, p: (d: Delta) => boolean): DeltaSet {
  const s = new DeltaSet();
  for (const d of a) if (p(d)) s.add(d);
  return s;
}

// federate(A, B, p) = A ∪ fork(B, p) — merge of a filtered fork (SPEC-1 §8).
export function federate(a: DeltaSet, b: DeltaSet, p: (d: Delta) => boolean): DeltaSet {
  return merge(a, fork(b, p));
}
