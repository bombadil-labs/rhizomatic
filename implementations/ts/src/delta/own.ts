// The one normalizing step between a caller's delta object and everything that reads it: the hash,
// the checks, the sets, the reactor and the stores (issue #133). What the hash covers is exactly
// what the delta holds, in both directions.
//
// - Each holder's own enumerable fields are read once. A field that only a prototype holds, also
//   one set on `Object.prototype`, reads as absent. An own accessor is called once.
// - An own enumerable key that the holder's schema does not name is refused, text or Symbol.
// - A value of the wrong type is refused. Nothing is converted.
// - `pointers` must pass `Array.isArray`. Each index is read once; a hole or an extra key refuses.
// - A number is written as `+0` where it was `-0`. The bytes of a bytes target are copied.
// - The prototype of every object of the copy is one frozen, empty object with no prototype, so no
//   later read can reach `Object.prototype`.
//
// The step checks shape and type only. `assertValidClaims` checks the values of the copy.

import type { Claims, Delta, Pointer, Primitive, Target } from "./types.js";

function refuse(message: string): never {
  throw new Error(message);
}

// The prototype of every object the step writes. It is empty and frozen, and it has no prototype
// of its own. An object made from it reads as fast as a plain one, which an object with a null
// prototype does not.
const BARE: object = Object.freeze(Object.create(null) as object);

function bare<T extends object>(fields: T): T {
  return Object.assign(Object.create(BARE) as T, fields);
}

const isEnumerable = Object.prototype.propertyIsEnumerable;

// The value of an own field, read once: a data field's value, or the answer of its getter. A key
// that is no longer own reads as absent; nothing reads through the prototype.
function read(given: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(given, key);
  if (field === undefined) return undefined;
  if (Object.hasOwn(field, "value")) return field.value;
  return Object.hasOwn(field, "get") ? field.get?.call(given) : undefined;
}

function noSymbol(given: object, what: string): void {
  for (const key of Object.getOwnPropertySymbols(given))
    if (isEnumerable.call(given, key)) refuse(`${what} must not have a Symbol key`);
}

function holder(given: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof given !== "object" || given === null || Array.isArray(given))
    return refuse(`${what} must be an object`);
  const own = Object.create(BARE) as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!keys.includes(key))
      return refuse(`${what} has the key "${key}", which is not one of: ${keys.join(", ")}`);
    own[key] = read(given, key);
  }
  noSymbol(given, what);
  return own;
}

function text(value: unknown, what: string): string {
  return typeof value === "string" ? value : refuse(`${what} must be a string`);
}

function number(value: unknown, what: string): number {
  return typeof value === "number" ? value + 0 : refuse(`${what} must be a number`);
}

function context(value: unknown, what: string): { context?: string } {
  return value === undefined ? {} : { context: text(value, `${what}.context`) };
}

/**
 * The items of a list, each index read once. The value must pass `Array.isArray`, and its own
 * enumerable keys must be exactly the indexes below its length: no hole, no other key, no Symbol.
 */
export function ownList(given: unknown, what: string): unknown[] {
  if (!Array.isArray(given)) return refuse(`${what} must be an array`);
  const length = read(given, "length");
  const keys = Object.keys(given);
  if (typeof length !== "number" || keys.length !== length)
    return refuse(`${what} must have exactly one item at each index, and no other key`);
  for (let i = 0; i < length; i++)
    if (keys[i] !== String(i))
      return refuse(`${what} must have exactly one item at each index, and no other key`);
  noSymbol(given, what);
  return keys.map((key) => read(given, key));
}

// The name of a typed array's kind, read from the object's internal slot. It is "Uint8Array" for
// a Uint8Array, a Node Buffer and any subclass, and undefined for everything else, also for an
// object or a Proxy that only inherits from Uint8Array.prototype.
const typedArrayName = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  Symbol.toStringTag,
)!.get as (this: unknown) => string | undefined;

/** A copy of a bytes payload that shares no memory with it. */
function bytes(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array) || typedArrayName.call(value) !== "Uint8Array")
    return refuse(`${what} must be a Uint8Array`);
  return new Uint8Array(value);
}

function primitive(value: unknown, what: string): Primitive {
  if (typeof value === "number") return value + 0;
  if (typeof value === "string" || typeof value === "boolean") return value;
  return refuse(
    `${what}: primitive value must be string, number, or boolean; got ${value === null ? "null" : typeof value}`,
  );
}

const TARGET_KEYS: Readonly<Record<string, readonly string[]>> = {
  primitive: ["kind", "value"],
  entity: ["kind", "entity"],
  delta: ["kind", "deltaRef"],
  bytes: ["kind", "mime", "value"],
};

function target(given: unknown, what: string): Target {
  const own = holder(given, what, ["kind", "value", "entity", "deltaRef", "mime"]);
  const kind = own["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(TARGET_KEYS, kind))
    return refuse(`${what}.kind must be "primitive", "entity", "delta" or "bytes"`);
  for (const key of Object.keys(own))
    if (!TARGET_KEYS[kind]!.includes(key))
      return refuse(`${what} of kind ${kind} has the key "${key}"`);
  switch (kind) {
    case "primitive":
      return bare({ kind, value: primitive(own["value"], `${what}.value`) });
    case "entity": {
      const entity = holder(own["entity"], `${what}.entity`, ["id", "context"]);
      return bare({
        kind,
        entity: bare({
          id: text(entity["id"], `${what}.entity.id`),
          ...context(entity["context"], `${what}.entity`),
        }),
      });
    }
    case "delta": {
      const ref = holder(own["deltaRef"], `${what}.deltaRef`, ["delta", "context"]);
      return bare({
        kind,
        deltaRef: bare({
          delta: text(ref["delta"], `${what}.deltaRef.delta`),
          ...context(ref["context"], `${what}.deltaRef`),
        }),
      });
    }
    default:
      return bare({
        kind: "bytes",
        mime: text(own["mime"], `${what}.mime`),
        value: bytes(own["value"], `${what}.value`),
      });
  }
}

function pointer(given: unknown, what: string): Pointer {
  const own = holder(given, what, ["role", "target"]);
  return bare({
    role: text(own["role"], `${what}.role`),
    target: target(own["target"], `${what}.target`),
  });
}

/**
 * The canonical fields of the claims and nothing else, in objects with no prototype that no caller
 * holds. Throws an `Error` for claims of the wrong shape or type; it never repairs them.
 */
export function ownClaims(given: unknown): Claims {
  const own = holder(given, "claims", [
    "timestamp",
    "validFrom",
    "validUntil",
    "author",
    "pointers",
  ]);
  const validUntil = own["validUntil"];
  return bare({
    timestamp: number(own["timestamp"], "claims.timestamp"),
    validFrom: number(own["validFrom"], "claims.validFrom"),
    ...(validUntil === undefined ? {} : { validUntil: number(validUntil, "claims.validUntil") }),
    author: text(own["author"], "claims.author"),
    pointers: ownList(own["pointers"], "claims.pointers").map((item, i) =>
      pointer(item, `claims.pointers[${i}]`),
    ),
  });
}

/**
 * The id, the canonical claims and the signature when there is one, in objects with no prototype
 * that no caller holds. Throws an `Error` for a delta of the wrong shape or type. It does not check
 * that the id recomputes.
 */
export function ownDelta(given: unknown): Delta {
  const own = holder(given, "the delta", ["id", "claims", "sig"]);
  const sig = own["sig"];
  return bare({
    id: text(own["id"], "the delta id"),
    claims: ownClaims(own["claims"]),
    ...(sig === undefined ? {} : { sig: text(sig, "the delta sig") }),
  });
}

/** A delta of these own claims and signature, in an object with no prototype. */
export function bareDelta(id: string, claims: Claims, sig: string | undefined): Delta {
  return bare(sig === undefined ? { id, claims } : { id, claims, sig });
}
