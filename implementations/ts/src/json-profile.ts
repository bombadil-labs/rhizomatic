// Parse the JSON debug profile used by the vectors (SPEC-1 §4.1, ERRATA "JSON debug profile")
// into the logical delta model. The CBOR form is normative; this is for authoring/inspection.

import type { Claims, Pointer, Primitive, Target } from "./types.js";

function asObject(x: unknown, what: string): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new Error(`expected object for ${what}`);
  }
  return x as Record<string, unknown>;
}

function parsePrimitive(v: unknown): Primitive {
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("numeric primitive must be finite");
    return v;
  }
  throw new Error("primitive must be string | number | boolean");
}

function parseTarget(raw: unknown): Target {
  const o = asObject(raw, "target");
  if ("value" in o) return { kind: "primitive", value: parsePrimitive(o["value"]) };
  if ("entityRef" in o) {
    const e = asObject(o["entityRef"], "entityRef");
    const id = e["id"];
    if (typeof id !== "string") throw new Error("entityRef.id must be a string");
    const context = e["context"];
    return context === undefined
      ? { kind: "entity", entity: { id } }
      : { kind: "entity", entity: { id, context: String(context) } };
  }
  if ("deltaRef" in o) {
    const d = asObject(o["deltaRef"], "deltaRef");
    const delta = d["delta"];
    if (typeof delta !== "string") throw new Error("deltaRef.delta must be a string");
    const context = d["context"];
    return context === undefined
      ? { kind: "delta", deltaRef: { delta } }
      : { kind: "delta", deltaRef: { delta, context: String(context) } };
  }
  throw new Error("target must be one of value | entityRef | deltaRef");
}

function parsePointer(raw: unknown): Pointer {
  const o = asObject(raw, "pointer");
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
          target = { value: p.target.value };
          break;
        case "entity":
          target = {
            entityRef: {
              id: p.target.entity.id,
              ...(p.target.entity.context === undefined
                ? {}
                : { context: p.target.entity.context }),
            },
          };
          break;
        case "delta":
          target = {
            deltaRef: {
              delta: p.target.deltaRef.delta,
              ...(p.target.deltaRef.context === undefined
                ? {}
                : { context: p.target.deltaRef.context }),
            },
          };
          break;
      }
      return { role: p.role, target };
    }),
  };
}

export function parseClaims(raw: unknown): Claims {
  const o = asObject(raw, "claims");
  if (typeof o["timestamp"] !== "number") throw new Error("claims.timestamp must be a number");
  if (typeof o["author"] !== "string") throw new Error("claims.author must be a string");
  if (!Array.isArray(o["pointers"])) throw new Error("claims.pointers must be an array");
  return {
    timestamp: o["timestamp"],
    author: o["author"],
    pointers: o["pointers"].map(parsePointer),
  };
}
