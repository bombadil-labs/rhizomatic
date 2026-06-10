import { type CborValue, array, bool, encode, float, map, tstr } from "./cbor.js";
import { bytesToHex, contentAddress } from "./hash.js";
import type { Claims, Pointer, Target } from "./types.js";

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
      if (t.entity.context !== undefined) entries.push(["context", tstr(t.entity.context)]);
      return map(entries);
    }
    case "delta": {
      const entries: Array<[string, CborValue]> = [["delta", tstr(t.deltaRef.delta)]];
      if (t.deltaRef.context !== undefined) entries.push(["context", tstr(t.deltaRef.context)]);
      return map(entries);
    }
  }
}

function pointerToCbor(p: Pointer): CborValue {
  return map([
    ["role", tstr(p.role)],
    ["target", targetToCbor(p.target)],
  ]);
}

export function claimsToCbor(claims: Claims): CborValue {
  return map([
    ["author", tstr(claims.author)],
    ["pointers", array(claims.pointers.map(pointerToCbor))],
    ["timestamp", float(claims.timestamp)],
  ]);
}

function assertNfc(s: string, what: string): void {
  if (s.normalize("NFC") !== s) {
    throw new Error(`${what} must be NFC-normalized (ERRATA D11): ${JSON.stringify(s)}`);
  }
}

// Reject malformed claims at the boundary; never repair (SPEC-4 §2).
export function assertValidClaims(claims: Claims): void {
  if (claims.author.length === 0) throw new Error("author must be non-empty");
  assertNfc(claims.author, "author");
  if (!Number.isFinite(claims.timestamp)) throw new Error("timestamp must be finite");
  if (claims.pointers.length < 1) throw new Error("a delta MUST contain at least one pointer");
  for (const p of claims.pointers) {
    if (p.role.length === 0) throw new Error("role must be non-empty");
    assertNfc(p.role, "role");
    if (p.target.kind === "primitive") {
      const v = p.target.value;
      if (typeof v === "number" && !Number.isFinite(v)) {
        throw new Error("numeric primitive must be finite");
      }
      if (typeof v === "string") assertNfc(v, "string primitive");
    }
    if (p.target.kind === "entity") assertNfc(p.target.entity.id, "entity id");
    if (p.target.kind === "delta") assertNfc(p.target.deltaRef.delta, "delta ref");
    const ctx =
      p.target.kind === "entity"
        ? p.target.entity.context
        : p.target.kind === "delta"
          ? p.target.deltaRef.context
          : undefined;
    if (ctx !== undefined) {
      if (ctx.length === 0) throw new Error("context, when present, must be non-empty");
      assertNfc(ctx, "context");
    }
  }
}

export function canonicalBytes(claims: Claims): Uint8Array {
  assertValidClaims(claims);
  return encode(claimsToCbor(claims));
}

export function canonicalHex(claims: Claims): string {
  return bytesToHex(canonicalBytes(claims));
}

export function computeId(claims: Claims): string {
  return contentAddress(canonicalBytes(claims));
}
