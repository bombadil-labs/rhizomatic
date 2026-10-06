// Parse the JSON debug profile used by the vectors (SPEC-1 §4.1, ERRATA "JSON debug profile")
// into the logical delta model. The CBOR form is normative; this is for authoring/inspection.

import { b64uDecode, b64uEncode, b64uDecodedLength } from "./b64u.js";
import { asObject } from "./strict.js";
import { cborHeadByteLength, cborFloatByteLength, cborTextByteLength } from "./cbor.js";
import { assertValidClaims } from "./delta.js";
import type { Claims, Primitive, Target } from "./types.js";

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

interface TargetReader<T> {
  object(raw: unknown, what: string, keys: readonly string[]): Record<string, unknown>;
  primitive(value: Primitive): T;
  entity(id: string, context: string | undefined): T;
  delta(id: string, context: string | undefined): T;
  bytes(mime: string, encoded: string): T;
}
function readTarget<T>(raw: unknown, reader: TargetReader<T>): T {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return reader.primitive(parsePrimitive(raw));
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(TARGET_SHAPES);
  }
  const captured = reader.object(raw, "target", ["id", "delta", "context", "mime", "value"]);
  const present = TARGET_DISCRIMINATORS.filter((k) => k in captured);
  if (present.length === 0) throw new Error(TARGET_SHAPES);
  if (present.length > 1) {
    throw new Error(
      `target is ambiguous — ${present.map((p) => `"${p}"`).join(" and ")} are both present, ` +
        `but exactly one names the target kind`,
    );
  }
  if (present[0] === "id") {
    const o = reader.object(captured, "entity ref target", ["id", "context"]);
    const id = o["id"];
    if (typeof id !== "string") throw new Error("entity ref id must be a string");
    const context = parseContext(o);
    return reader.entity(id, context);
  }
  if (present[0] === "delta") {
    const o = reader.object(captured, "delta ref target", ["delta", "context"]);
    const delta = o["delta"];
    if (typeof delta !== "string") throw new Error("delta ref delta must be a string");
    const context = parseContext(o);
    return reader.delta(delta, context);
  }
  // A bytes literal has no context (D12). `value` is canonical base64url — malformed encodings
  // are rejected, never repaired.
  const o = reader.object(captured, "bytes target", ["mime", "value"]);
  const mime = o["mime"];
  if (typeof mime !== "string") throw new Error("bytes target mime must be a string");
  const value = o["value"];
  if (typeof value !== "string") throw new Error("bytes target value must be a base64url string");
  return reader.bytes(mime, value);
}

const parsingReader: TargetReader<Target> = {
  object: (raw, what, keys) =>
    what === "target" ? (raw as Record<string, unknown>) : asObject(raw, what, keys),
  primitive: (value) => ({ kind: "primitive", value }),
  entity: (id, context) => ({
    kind: "entity",
    entity: { id, ...(context === undefined ? {} : { context }) },
  }),
  delta: (delta, context) => ({
    kind: "delta",
    deltaRef: { delta, ...(context === undefined ? {} : { context }) },
  }),
  bytes: (mime, encoded) => ({ kind: "bytes", mime, value: b64uDecode(encoded) }),
};
function readPointer<T>(raw: unknown, reader: TargetReader<T>): { role: string; target: T } {
  const o = reader.object(raw, "pointer", ["role", "target"]);
  if (typeof o["role"] !== "string") throw new Error("pointer.role must be a string");
  return { role: o["role"], target: readTarget(o["target"], reader) };
}

// Serialize claims back to the JSON debug profile (the inverse of parseClaims).
export function claimsToJson(claims: Claims): unknown {
  return {
    timestamp: claims.timestamp,
    validFrom: claims.validFrom,
    ...(claims.validUntil === undefined ? {} : { validUntil: claims.validUntil }),
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

function claimsFields(raw: unknown, object = asObject) {
  const o = object(raw, "claims", ["timestamp", "validFrom", "validUntil", "author", "pointers"]);
  if (typeof o["timestamp"] !== "number") throw new Error("claims.timestamp must be a number");
  if (typeof o["validFrom"] !== "number") throw new Error("claims.validFrom must be a number");
  if (o["validUntil"] !== undefined && typeof o["validUntil"] !== "number")
    throw new Error("claims.validUntil must be a number when present");
  if (typeof o["author"] !== "string") throw new Error("claims.author must be a string");
  if (!Array.isArray(o["pointers"])) throw new Error("claims.pointers must be an array");
  return {
    timestamp: o["timestamp"],
    validFrom: o["validFrom"],
    ...(o["validUntil"] === undefined ? {} : { validUntil: o["validUntil"] as number }),
    author: o["author"],
    pointers: o["pointers"],
  };
}

export function parseClaims(raw: unknown): Claims {
  const fields = claimsFields(raw);
  return { ...fields, pointers: fields.pointers.map((p) => readPointer(p, parsingReader)) };
}

/** Count/capture errors are independent of any command profile. */
export class DeltaDebugCaptureError extends Error {
  constructor(readonly code: "invalid-appearance" | "resource-limit") {
    super(code);
  }
}
// Capture only own enumerable fields, reading each value once. No typo diagnostic or copy of
// an unknown value is needed here; this path must reject even enormous malformed appearances.
function ownObject(raw: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  const { out, invalid } = headerObject(raw, keys);
  if (invalid) throw Error(what);
  return out;
}
// Delay header shape rejection until *all* captured pointer containers/counts are known.
function headerObject(raw: unknown, keys: readonly string[]) {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let invalid = typeof raw !== "object" || raw === null || Array.isArray(raw);
  if (!invalid) {
    for (const key in raw as object) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      if (!keys.includes(key)) {
        invalid = true;
        continue;
      }
      out[key] = (raw as Record<string, unknown>)[key];
    }
    if (
      Object.getOwnPropertySymbols(raw).some((k) =>
        Object.prototype.propertyIsEnumerable.call(raw, k),
      )
    )
      invalid = true;
  }
  return { out, invalid };
}
function arrayShape(raw: readonly unknown[], length: number): void {
  let n = 0;
  for (const key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= length || String(i) !== key)
      throw Error("invalid debug array");
    n++;
  }
  if (
    n !== length ||
    Object.getOwnPropertySymbols(raw).some((k) =>
      Object.prototype.propertyIsEnumerable.call(raw, k),
    )
  )
    throw Error("invalid debug array");
}
type CountedTarget = { debug: unknown; logical: Target; size: number };
const countingReader: TargetReader<CountedTarget> = {
  object: ownObject,
  primitive: (value) => ({
    debug: value,
    logical: { kind: "primitive", value },
    size:
      typeof value === "string"
        ? cborTextByteLength(value)
        : typeof value === "boolean"
          ? 1
          : cborFloatByteLength(value),
  }),
  entity: (id, context) => ({
    debug: { id, ...(context === undefined ? {} : { context }) },
    logical: { kind: "entity", entity: { id, ...(context === undefined ? {} : { context }) } },
    size:
      cborHeadByteLength(context === undefined ? 1 : 2) +
      cborTextByteLength("id") +
      cborTextByteLength(id) +
      (context === undefined ? 0 : cborTextByteLength("context") + cborTextByteLength(context)),
  }),
  delta: (delta, context) => ({
    debug: { delta, ...(context === undefined ? {} : { context }) },
    logical: { kind: "delta", deltaRef: { delta, ...(context === undefined ? {} : { context }) } },
    size:
      cborHeadByteLength(context === undefined ? 1 : 2) +
      cborTextByteLength("delta") +
      cborTextByteLength(delta) +
      (context === undefined ? 0 : cborTextByteLength("context") + cborTextByteLength(context)),
  }),
  bytes: (mime, value) => {
    const n = b64uDecodedLength(value);
    return {
      debug: { mime, value },
      logical: { kind: "bytes", mime, value: new Uint8Array(0) },
      size:
        cborHeadByteLength(2) +
        cborTextByteLength("mime") +
        cborTextByteLength(mime) +
        cborTextByteLength("value") +
        cborHeadByteLength(n) +
        n,
    };
  },
};
/** Synchronous owned debug capture; no payload decoding/canonical buffer construction.
 * Retained containers are bounded by counts and the canonical byte cap. After saturation
 * remaining shapes still validate; no failed capture escapes with source references.
 */
export function captureDeltaDebugDelivery(
  raw: readonly unknown[],
  limits: { deliveryAppearances: number; pointers: number; deliveryBytes: number },
): readonly unknown[] {
  let issued: DeltaDebugCaptureError | undefined;
  const fail: (code: "invalid-appearance" | "resource-limit") => never = (code) => {
    issued = new DeltaDebugCaptureError(code);
    throw issued;
  };
  try {
    if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 0))
      fail("invalid-appearance");
    const count = raw.length;
    if (!Number.isSafeInteger(count) || count < 0) fail("invalid-appearance");
    if (count > limits.deliveryAppearances) fail("resource-limit");
    arrayShape(raw, count);
    const headers = [];
    for (let i = 0; i < count; i++) {
      const top = headerObject(raw[i], ["id", "claims", "sig"]);
      const claims = headerObject(top.out.claims, [
        "timestamp",
        "validFrom",
        "validUntil",
        "author",
        "pointers",
      ]);
      const pointers = claims.out.pointers;
      if (!Array.isArray(pointers)) throw new DeltaDebugCaptureError("invalid-appearance");
      const length = pointers.length;
      if (!Number.isSafeInteger(length) || length < 0) fail("invalid-appearance");
      headers.push({ top, claims, pointers, length });
    }
    for (const h of headers) if (h.length > limits.pointers) fail("resource-limit");
    let size = 0;
    const owned: unknown[] = [];
    // Saturate safely even when total input lengths exceed exact integer arithmetic.
    const add = (n: number) => {
      size = n > limits.deliveryBytes - size ? limits.deliveryBytes + 1 : size + n;
    };
    for (const h of headers) {
      if (h.top.invalid || h.claims.invalid) fail("invalid-appearance");
      const fields = claimsFields(h.claims.out);
      const id = h.top.out.id,
        sig = h.top.out.sig;
      if (
        typeof id !== "string" ||
        (sig !== undefined &&
          (typeof sig !== "string" || sig.length % 2 !== 0 || !/^[a-fA-F0-9]*$/.test(sig)))
      )
        fail("invalid-appearance");
      const base = {
        ...fields,
        pointers: [{ role: "_", target: { kind: "primitive" as const, value: true } }],
      };
      assertValidClaims(base);
      if (h.length === 0) fail("invalid-appearance");
      arrayShape(h.pointers, h.length);
      add(
        cborHeadByteLength(fields.validUntil === undefined ? 4 : 5) +
          cborTextByteLength("author") +
          cborTextByteLength(fields.author) +
          cborTextByteLength("timestamp") +
          cborFloatByteLength(fields.timestamp) +
          cborTextByteLength("validFrom") +
          cborFloatByteLength(fields.validFrom) +
          cborTextByteLength("pointers") +
          cborHeadByteLength(h.length) +
          (fields.validUntil === undefined
            ? 0
            : cborTextByteLength("validUntil") + cborFloatByteLength(fields.validUntil)) +
          (sig === undefined ? 0 : (sig as string).length / 2),
      );
      const pointers: unknown[] = [];
      for (let i = 0; i < h.length; i++) {
        const p = readPointer(h.pointers[i], countingReader);
        assertValidClaims({ ...base, pointers: [{ role: p.role, target: p.target.logical }] });
        add(
          cborHeadByteLength(2) +
            cborTextByteLength("role") +
            cborTextByteLength(p.role) +
            cborTextByteLength("target") +
            p.target.size,
        );
        if (size <= limits.deliveryBytes) pointers.push({ role: p.role, target: p.target.debug });
        else {
          pointers.length = 0;
          owned.length = 0;
        }
      }
      if (size <= limits.deliveryBytes)
        owned.push({ id, claims: { ...fields, pointers }, ...(sig === undefined ? {} : { sig }) });
    }
    if (size > limits.deliveryBytes) fail("resource-limit");
    return owned;
  } catch (error) {
    if (issued !== undefined && error === issued) throw issued;
    return fail("invalid-appearance");
  }
}
