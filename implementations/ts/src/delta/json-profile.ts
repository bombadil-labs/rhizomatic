// Parse the JSON debug profile used by the vectors (SPEC-1 §4.1, ERRATA "JSON debug profile")
// into the logical delta model. The CBOR form is normative; this is for authoring/inspection.

import { b64uDecode, b64uEncode } from "./b64u.js";
import { asObject } from "./strict.js";
import type { Claims, Pointer, Primitive, Target } from "./types.js";

const TARGET_SHAPES =
  "target must be a primitive, {id, context?}, {delta, context?}, or {mime, value}";

function parsePrimitive(v: unknown): Primitive {
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("numeric primitive must be finite");
    return v;
  }
  throw new Error("primitive must be string | number | boolean");
}

// The profile mirrors the canonical CBOR exactly: a primitive target is the bare value; an
// entity ref is {id, context?}; a delta ref is {delta, context?}. Discrimination is structural
// (SPEC-1 §2.1) — primitives are never objects, and the id/delta key names the ref kind.
function parseContext(o: Record<string, unknown>): string | undefined {
  const context = o["context"];
  if (context === undefined) return undefined;
  // An explicit null (or any non-string) is present-but-malformed: reject, never coerce.
  if (typeof context !== "string") throw new Error("context, when present, must be a string");
  return context;
}

// The discriminator keys of the three object target shapes. Exactly one may be present: the
// former first-match-wins reading silently picked an arm and dropped the rest, which is repair
// (SPEC-4 §2) and is now rejected as ambiguous (issue #25).
const TARGET_DISCRIMINATORS = ["id", "delta", "mime"] as const;

function parseTarget(raw: unknown): Target {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return { kind: "primitive", value: parsePrimitive(raw) };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(TARGET_SHAPES);
  }
  const present = TARGET_DISCRIMINATORS.filter((k) => k in (raw as Record<string, unknown>));
  if (present.length === 0) throw new Error(TARGET_SHAPES);
  if (present.length > 1) {
    throw new Error(
      `target is ambiguous — ${present.map((p) => `"${p}"`).join(" and ")} are both present, ` +
        `but exactly one names the target kind`,
    );
  }
  if (present[0] === "id") {
    const o = asObject(raw, "entity ref target", ["id", "context"]);
    const id = o["id"];
    if (typeof id !== "string") throw new Error("entity ref id must be a string");
    const context = parseContext(o);
    return context === undefined
      ? { kind: "entity", entity: { id } }
      : { kind: "entity", entity: { id, context } };
  }
  if (present[0] === "delta") {
    const o = asObject(raw, "delta ref target", ["delta", "context"]);
    const delta = o["delta"];
    if (typeof delta !== "string") throw new Error("delta ref delta must be a string");
    const context = parseContext(o);
    return context === undefined
      ? { kind: "delta", deltaRef: { delta } }
      : { kind: "delta", deltaRef: { delta, context } };
  }
  // A bytes literal has no context (D12). `value` is canonical base64url — malformed encodings
  // are rejected, never repaired.
  const o = asObject(raw, "bytes target", ["mime", "value"]);
  const mime = o["mime"];
  if (typeof mime !== "string") throw new Error("bytes target mime must be a string");
  const value = o["value"];
  if (typeof value !== "string") throw new Error("bytes target value must be a base64url string");
  return { kind: "bytes", mime, value: b64uDecode(value) };
}

function parsePointer(raw: unknown): Pointer {
  const o = asObject(raw, "pointer", ["role", "target"]);
  if (typeof o["role"] !== "string") throw new Error("pointer.role must be a string");
  return { role: o["role"], target: parseTarget(o["target"]) };
}

// Serialize claims back to the JSON debug profile (the inverse of parseClaims).
export function claimsToJson(claims: Claims): unknown {
  return {
    timestamp: claims.timestamp,
    author: claims.author,
    pointers: claims.pointers.map((p) => {
      let target: unknown;
      switch (p.target.kind) {
        case "primitive":
          target = p.target.value;
          break;
        case "entity":
          target = {
            id: p.target.entity.id,
            ...(p.target.entity.context === undefined ? {} : { context: p.target.entity.context }),
          };
          break;
        case "delta":
          target = {
            delta: p.target.deltaRef.delta,
            ...(p.target.deltaRef.context === undefined
              ? {}
              : { context: p.target.deltaRef.context }),
          };
          break;
        case "bytes":
          target = { mime: p.target.mime, value: b64uEncode(p.target.value) };
          break;
      }
      return { role: p.role, target };
    }),
  };
}

export function parseClaims(raw: unknown): Claims {
  const o = asObject(raw, "claims", ["timestamp", "author", "pointers"]);
  if (typeof o["timestamp"] !== "number") throw new Error("claims.timestamp must be a number");
  if (typeof o["author"] !== "string") throw new Error("claims.author must be a string");
  if (!Array.isArray(o["pointers"])) throw new Error("claims.pointers must be an array");
  return {
    timestamp: o["timestamp"],
    author: o["author"],
    pointers: o["pointers"].map(parsePointer),
  };
}
