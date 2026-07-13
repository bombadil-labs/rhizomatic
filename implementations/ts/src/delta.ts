import { type CborValue, array, bool, bstr, encode, float, map, tstr } from "./cbor.js";
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

// Reject malformed claims at the boundary; never repair (SPEC-4 §2). Untyped callers
// (plain JS, `as` casts) bypass the static types, so runtime guards here are the real boundary.
export function assertValidClaims(claims: Claims): void {
  if (typeof claims.author !== "string") throw new Error("author must be a string");
  if (claims.author.length === 0) throw new Error("author must be non-empty");
  assertNfc(claims.author, "author");
  if (!Number.isFinite(claims.timestamp)) throw new Error("timestamp must be finite");
  if (claims.pointers.length < 1) throw new Error("a delta MUST contain at least one pointer");
  for (const p of claims.pointers) {
    if (typeof p.role !== "string") throw new Error("role must be a string");
    if (p.role.length === 0) throw new Error("role must be non-empty");
    assertNfc(p.role, "role");
    if (p.target.kind === "primitive") {
      const v = p.target.value;
      const t = typeof v;
      if (t !== "string" && t !== "number" && t !== "boolean") {
        // Without this, targetToCbor's float() fallback crashes opaquely on null/objects.
        throw new Error(
          `primitive value must be string, number, or boolean; got ${v === null ? "null" : t}`,
        );
      }
      if (typeof v === "number" && !Number.isFinite(v)) {
        throw new Error("numeric primitive must be finite");
      }
      if (typeof v === "string") assertNfc(v, "string primitive");
    }
    if (p.target.kind === "entity") assertNfc(p.target.entity.id, "entity id");
    if (p.target.kind === "delta") assertNfc(p.target.deltaRef.delta, "delta ref");
    if (p.target.kind === "bytes") {
      // mime REQUIRED, non-empty, NFC, case-sensitive-opaque (SPEC-1 §2.1, D12); value is raw
      // bytes — zero-length is legal, no NFC. Runtime guards catch untyped/`as`-cast callers.
      if (typeof p.target.mime !== "string") throw new Error("bytes target mime must be a string");
      if (p.target.mime.length === 0) {
        throw new Error("bytes target mime must be non-empty (SPEC-1 §2.1)");
      }
      assertNfc(p.target.mime, "bytes mime");
      if (!(p.target.value instanceof Uint8Array)) {
        throw new Error("bytes target value must be a Uint8Array");
      }
    }
    const ctx =
      p.target.kind === "entity"
        ? p.target.entity.context
        : p.target.kind === "delta"
          ? p.target.deltaRef.context
          : undefined;
    if (ctx !== undefined) {
      if (typeof ctx !== "string") throw new Error("context, when present, must be a string");
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
