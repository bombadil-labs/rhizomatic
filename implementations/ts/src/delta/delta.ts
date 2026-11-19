import { type CborValue, array, bool, bstr, encode, float, map, tstr } from "./cbor.js";
import { bytesToHex, contentAddress } from "./hash.js";
import { ownClaims, ownDelta, ownField } from "./own.js";
import type { Claims, Delta, Pointer, Target } from "./types.js";

function targetToCbor(t: Target): CborValue {
  switch (t.kind) {
    case "primitive": {
      const v = t.value;
      if (typeof v === "string") return tstr(v);
      if (typeof v === "boolean") return bool(v);
      return float(v);
    }
    case "entity": {
      const entries: Array<[string, CborValue]> = [["id", tstr(t.entity.id)]];
      const context = ownField(t.entity, "context");
      if (context !== undefined) entries.push(["context", tstr(context)]);
      return map(entries);
    }
    case "delta": {
      const entries: Array<[string, CborValue]> = [["delta", tstr(t.deltaRef.delta)]];
      const context = ownField(t.deltaRef, "context");
      if (context !== undefined) entries.push(["context", tstr(context)]);
      return map(entries);
    }
    // Bytes: map { "mime": tstr, "value": bstr } — the raw payload is the bstr and identity is its
    // hash (SPEC-1 §4.1, ERRATA D12); keys are sorted at encode time (D4).
    case "bytes":
      return map([
        ["mime", tstr(t.mime)],
        ["value", bstr(t.value)],
      ]);
  }
}

function pointerToCbor(p: Pointer): CborValue {
  return map([
    ["role", tstr(p.role)],
    ["target", targetToCbor(p.target)],
  ]);
}

function ownToCbor(claims: Claims): CborValue {
  const entries: Array<[string, CborValue]> = [
    ["author", tstr(claims.author)],
    ["pointers", array(claims.pointers.map(pointerToCbor))],
    ["timestamp", float(claims.timestamp)],
    ["validFrom", float(claims.validFrom)],
  ];
  const validUntil = ownField(claims, "validUntil");
  if (validUntil !== undefined) entries.push(["validUntil", float(validUntil)]);
  return map(entries);
}

// Reject malformed claims at the boundary; never repair (SPEC-4 §2). The claims are the own
// copy of `ownClaims`, so each check reads a value that the hash covers.
function check(claims: Claims): void {
  if (claims.author.length === 0) throw new Error("author must be non-empty");
  if (!Number.isFinite(claims.timestamp)) throw new Error("timestamp must be finite");
  if (!Number.isFinite(claims.validFrom)) throw new Error("validFrom must be finite");
  const validUntil = ownField(claims, "validUntil");
  if (validUntil !== undefined) {
    if (!Number.isFinite(validUntil)) throw new Error("validUntil must be finite");
    if (validUntil <= claims.validFrom)
      throw new Error("validUntil must be greater than validFrom");
  }
  if (claims.pointers.length < 1) throw new Error("a delta MUST contain at least one pointer");
  for (const p of claims.pointers) {
    if (p.role.length === 0) throw new Error("role must be non-empty");
    const t = p.target;
    if (t.kind === "primitive" && typeof t.value === "number" && !Number.isFinite(t.value))
      throw new Error("numeric primitive must be finite");
    // mime REQUIRED, non-empty, case-sensitive-opaque (SPEC-1 §2.1, D12); value is raw bytes, and
    // zero-length is legal.
    if (t.kind === "bytes" && t.mime.length === 0)
      throw new Error("bytes target mime must be non-empty (SPEC-1 §2.1)");
    const ctx =
      t.kind === "entity"
        ? ownField(t.entity, "context")
        : t.kind === "delta"
          ? ownField(t.deltaRef, "context")
          : undefined;
    if (ctx !== undefined && ctx.length === 0)
      throw new Error("context, when present, must be non-empty");
  }
}

/** The own copy of the claims (`ownClaims`), checked. Throws for claims that are not valid. */
export function validClaims(claims: Claims): Claims {
  const own = ownClaims(claims);
  check(own);
  return own;
}

// Untyped callers (plain JS, `as` casts) bypass the static types, so the step and these runtime
// guards are the real boundary.
export function assertValidClaims(claims: Claims): void {
  validClaims(claims);
}

/** The canonical CBOR of the own copy of the claims (`ownClaims`). It checks no value. */
export function claimsToCbor(claims: Claims): CborValue {
  return ownToCbor(ownClaims(claims));
}

function encodeOwn(own: Claims): Uint8Array {
  return encode(ownToCbor(own));
}

export function canonicalBytes(claims: Claims): Uint8Array {
  return encodeOwn(validClaims(claims));
}

export function canonicalHex(claims: Claims): string {
  return bytesToHex(canonicalBytes(claims));
}

export function computeId(claims: Claims): string {
  return contentAddress(canonicalBytes(claims));
}

/** The own copy of valid claims (`validClaims`) and the id they hash to. */
export function claimsWithId(claims: Claims): { own: Claims; id: string } {
  const own = ownClaims(claims);
  return { own, id: idOfOwn(own) };
}

/**
 * The own copy of a delta (`ownDelta`) whose claims are valid, and the id its claims hash to.
 * Throws for a delta of the wrong shape or with claims that are not valid; a wrong id is the
 * caller's to judge.
 */
export function ownCheckedDelta(delta: Delta): { own: Delta; id: string } {
  const own = ownDelta(delta);
  return { own, id: idOfOwn(own.claims) };
}

/** The id of claims that are already an own copy (`ownClaims`). Throws for claims not valid. */
export function idOfOwn(own: Claims): string {
  check(own);
  return contentAddress(encodeOwn(own));
}
