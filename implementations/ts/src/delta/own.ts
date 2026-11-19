// The one normalizing step between a caller's delta object and everything that reads it: the hash,
// the checks, the sets, the reactor and the stores (issue #133). What the hash covers is exactly
// what the delta holds, in both directions.
//
// - Each holder must be a plain object (`isPlainObject`): its prototype is null or a realm's
//   `Object.prototype`. A class instance or an object made with `Object.create(proto)` is refused.
// - Each holder's own enumerable fields are read once. A field that only `Object.prototype` holds
//   reads as absent. An own accessor is called once. An own field whose value is `undefined` reads
//   as absent, at any key, as JSON drops it.
// - An own schema key that is not enumerable is refused. An own enumerable key with a value that
//   the holder's schema does not name is refused, text or Symbol.
// - A value of the wrong type is refused. Nothing is converted.
// - `pointers` must pass `Array.isArray`. Each index is read once; a hole or an extra key refuses.
// - A number is written as `+0` where it was `-0`. The bytes of a bytes target are copied.
// - The copy is made of ordinary plain objects that hold exactly the schema's fields. The core
//   reads an optional field of a copy only through `ownField`, so a field set on `Object.prototype`
//   reaches no hash and no decision of the core.
//
// The step checks shape and type only. `assertValidClaims` checks the values of the copy.

import type { Claims, Delta, Pointer, Primitive, Target } from "./types.js";

/**
 * True while `at` is before the end of the claims' validity: they hold no own `validUntil`, or `at`
 * is earlier than it.
 */
export function validBefore(claims: Claims, at: number): boolean {
  const validUntil = ownField(claims, "validUntil");
  return validUntil === undefined || at < validUntil;
}

/** `{ sig }` when the delta holds its own signature, and `{}` when it holds none. */
export function sigOf(delta: Delta): { sig?: string } {
  const sig = ownField(delta, "sig");
  return sig === undefined ? {} : { sig };
}

/** `{ validUntil }` when the claims hold their own end of validity, and `{}` when they hold none. */
export function validUntilOf(claims: Claims): { validUntil?: number } {
  const validUntil = ownField(claims, "validUntil");
  return validUntil === undefined ? {} : { validUntil };
}

function refuse(message: string): never {
  throw new Error(message);
}

/**
 * The value of an optional field that `holder` holds as its own, or undefined. A field that only a
 * prototype holds, such as one set on `Object.prototype`, reads as absent.
 */
export function ownField<T extends object, K extends keyof T>(holder: T, key: K): T[K] | undefined {
  return Object.hasOwn(holder, key) ? holder[key] : undefined;
}

// The own enumerable fields of an object, each read once through its property descriptor: a data
// field's value, or the answer of its getter. A Proxy's `get` trap is never called; its
// `getOwnPropertyDescriptor` trap is called once per key. A field whose value is `undefined` is
// absent, as in JSON. Nothing reads through the prototype. A Symbol key with a value is refused.
function fields(
  given: object,
  what: string,
  hidden: (key: string | symbol, field: PropertyDescriptor) => void = () => {},
): [string, unknown][] {
  const found: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(given)) {
    const field = Object.getOwnPropertyDescriptor(given, key);
    if (field === undefined) continue;
    if (field.enumerable !== true) {
      hidden(key, field);
      continue;
    }
    const value: unknown = Object.hasOwn(field, "value") ? field.value : field.get?.call(given);
    if (value === undefined) continue;
    if (typeof key === "symbol") return refuse(`${what} must not have a Symbol key`);
    found.push([key, value]);
  }
  return found;
}

/**
 * A plain object: not null, not a list, not a function, and made by an object literal or with a
 * null prototype. An optional object field of a request takes nothing else.
 *
 * Plainness is the shape of the prototype chain, not identity with this realm's
 * `Object.prototype`, so an object literal from another realm (`vm`, an iframe) is plain, as a
 * list from another realm is a list. The prototype is null, or it is some realm's
 * `Object.prototype`: its own prototype is null, and its own `constructor` is a data property
 * holding a function named `Object` whose `prototype` it is. A class instance and an object
 * made from another object are not plain. No getter is called.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return true;
  if (typeof prototype !== "object" || Object.getPrototypeOf(prototype) !== null) return false;
  const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  if (typeof constructor !== "function") return false;
  return (
    Object.getOwnPropertyDescriptor(constructor, "prototype")?.value === prototype &&
    Object.getOwnPropertyDescriptor(constructor, "name")?.value === "Object"
  );
}

/**
 * Refuses a holder that is not a plain object (`isPlainObject`). A class instance and an object
 * made with `Object.create(proto)` are a host's mistake.
 */
export function plainHolder(given: object, what: string): void {
  if (!isPlainObject(given))
    refuse(
      `${what} must be a plain object, not a class instance or an object made with Object.create`,
    );
}

/** Refuses an own key of the holder's schema that is not enumerable. */
export function hiddenKey(what: string, keys: readonly string[], key: string | symbol): void {
  if (typeof key === "string" && keys.includes(key))
    refuse(`${what} has the key "${key}", which is not enumerable`);
}

function holder(given: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof given !== "object" || given === null || Array.isArray(given))
    return refuse(`${what} must be an object`);
  plainHolder(given, what);
  const own = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of fields(given, what, (key) => hiddenKey(what, keys, key))) {
    if (!keys.includes(key))
      return refuse(`${what} has the key "${key}", which is not one of: ${keys.join(", ")}`);
    own[key] = value;
  }
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
  let length: unknown;
  const items = fields(given, what, (key, field) => {
    if (key === "length") length = field.value;
  });
  if (
    typeof length !== "number" ||
    items.length !== length ||
    items.some(([key], i) => key !== String(i))
  )
    return refuse(`${what} must have exactly one item at each index, and no other key`);
  return items.map(([, value]) => value);
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
      return { kind, value: primitive(own["value"], `${what}.value`) };
    case "entity": {
      const entity = holder(own["entity"], `${what}.entity`, ["id", "context"]);
      return {
        kind,
        entity: {
          id: text(entity["id"], `${what}.entity.id`),
          ...context(entity["context"], `${what}.entity`),
        },
      };
    }
    case "delta": {
      const ref = holder(own["deltaRef"], `${what}.deltaRef`, ["delta", "context"]);
      return {
        kind,
        deltaRef: {
          delta: text(ref["delta"], `${what}.deltaRef.delta`),
          ...context(ref["context"], `${what}.deltaRef`),
        },
      };
    }
    default:
      return {
        kind: "bytes",
        mime: text(own["mime"], `${what}.mime`),
        value: bytes(own["value"], `${what}.value`),
      };
  }
}

function pointer(given: unknown, what: string): Pointer {
  const own = holder(given, what, ["role", "target"]);
  return {
    role: text(own["role"], `${what}.role`),
    target: target(own["target"], `${what}.target`),
  };
}

/**
 * The canonical fields of the claims and nothing else, in plain objects that no caller holds. Throws an `Error` for claims of the wrong shape or type; it never repairs them.
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
  return {
    timestamp: number(own["timestamp"], "claims.timestamp"),
    validFrom: number(own["validFrom"], "claims.validFrom"),
    ...(validUntil === undefined ? {} : { validUntil: number(validUntil, "claims.validUntil") }),
    author: text(own["author"], "claims.author"),
    pointers: ownList(own["pointers"], "claims.pointers").map((item, i) =>
      pointer(item, `claims.pointers[${i}]`),
    ),
  };
}

/**
 * The id, the canonical claims and the signature when there is one, in plain objects that no
 * caller holds. Throws an `Error` for a delta of the wrong shape or type. It does not check
 * that the id recomputes.
 */
export function ownDelta(given: unknown): Delta {
  const own = holder(given, "the delta", ["id", "claims", "sig"]);
  const sig = own["sig"];
  return {
    id: text(own["id"], "the delta id"),
    claims: ownClaims(own["claims"]),
    ...(sig === undefined ? {} : { sig: text(sig, "the delta sig") }),
  };
}
