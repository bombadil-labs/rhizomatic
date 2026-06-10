// The delta data model (SPEC-1 §2). Bytes are never stored here — these are the logical
// structures; canonical encoding lives in cbor.ts / delta.ts.

export type Primitive = string | number | boolean;

export interface EntityRef {
  readonly id: string;
  readonly context?: string;
}

export interface DeltaRef {
  readonly delta: string; // content address (multihash hex) of another delta
  readonly context?: string;
}

// A pointer's target is exactly one of: a primitive value, an entity reference, or a delta
// reference. The three are kept structurally distinct (SPEC-1 §2.1, ERRATA D5).
export type Target =
  | { readonly kind: "primitive"; readonly value: Primitive }
  | { readonly kind: "entity"; readonly entity: EntityRef }
  | { readonly kind: "delta"; readonly deltaRef: DeltaRef };

export interface Pointer {
  readonly role: string;
  readonly target: Target;
}

export interface Claims {
  readonly timestamp: number; // ms since Unix epoch; a CLAIM, not an authority (SPEC-1 §6)
  readonly author: string; // public key or fingerprint (SPEC-1 §5)
  readonly pointers: readonly Pointer[]; // 1 or more (SPEC-1 §2.1)
}

export interface Delta {
  readonly id: string; // content-derived; "1e20" + hex(blake3-256(canonical_cbor(claims)))
  readonly claims: Claims;
  readonly sig?: string; // detached signature over id (SPEC-1 §5); absent in M0.1
}
