// Copies that cut every reference between a caller and what a store or a scope source holds
// (SPEC-18 proposal §4.1: a store owns what it holds).
//
// A copy here never converts. Each field is read once, its type is checked, and only then is it
// taken; a value of another type throws. So the copy holds exactly the values the caller gave,
// and the id is computed over the copy: what was checked, what was hashed and what is stored
// are one object, which no caller can reach.

import type { Claims, Delta, Pointer, Target } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import type { VerifiedDelta } from "./store.js";

function malformed(what: string): never {
  throw new TypeError(`malformed claims: ${what}`);
}

function text(value: unknown, what: string): string {
  return typeof value === "string" ? value : malformed(`${what} is not a string`);
}
function number(value: unknown, what: string): number {
  return typeof value === "number" ? value : malformed(`${what} is not a number`);
}
function record(value: unknown, what: string): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : malformed(`${what} is not an object`);
}
/**
 * A plain object: not null, not a list, not a function, and made by an object literal or with a
 * null prototype. An optional object field of a request takes nothing else.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function context(value: unknown): { context?: string } {
  return value === undefined ? {} : { context: text(value, "a context") };
}

// The name of a typed array's kind, read from the object itself. It is "Uint8Array" for a
// Uint8Array, a Node Buffer and any subclass, and undefined for everything else, also for an
// object that only inherits from Uint8Array.prototype.
const typedArrayName = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  Symbol.toStringTag,
)!.get as (this: unknown) => string | undefined;

/**
 * A copy of a bytes payload that shares no memory with it. The constructor copies only when
 * its argument is a typed array: given an ArrayBuffer or a SharedArrayBuffer it builds a view,
 * and given a number or a list it converts. So the value must be a Uint8Array first. `slice`
 * is not used: on a Node Buffer it returns a view.
 */
function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || typedArrayName.call(value) !== "Uint8Array")
    return malformed("a bytes value is not a Uint8Array");
  return new Uint8Array(value);
}

function target(given: unknown): Target {
  const from = record(given, "a target");
  const kind = from["kind"];
  switch (kind) {
    case "primitive": {
      const value = from["value"];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
        return malformed("a primitive value is not a string, a number or a boolean");
      return { kind, value };
    }
    case "entity": {
      const entity = record(from["entity"], "an entity reference");
      return {
        kind,
        entity: { id: text(entity["id"], "an entity id"), ...context(entity["context"]) },
      };
    }
    case "delta": {
      const ref = record(from["deltaRef"], "a delta reference");
      return {
        kind,
        deltaRef: { delta: text(ref["delta"], "a delta id"), ...context(ref["context"]) },
      };
    }
    case "bytes":
      return { kind, mime: text(from["mime"], "a mime type"), value: bytes(from["value"]) };
    default:
      return malformed("a target has an unknown kind");
  }
}

/**
 * The canonical fields of a delta's claims and nothing else, in objects no caller holds.
 * Throws for claims that are not claims as given; it never repairs one. A bytes payload cannot
 * be frozen, which is why reads copy too.
 */
export function copyClaims(given: Claims): Claims {
  const from = record(given, "the claims");
  const validUntil = from["validUntil"];
  const list = from["pointers"];
  if (!Array.isArray(list)) return malformed("the pointers are not a list");
  const pointers: Pointer[] = [];
  for (let i = 0; i < list.length; i++) {
    const pointer = record(list[i], "a pointer");
    pointers.push({ role: text(pointer["role"], "a role"), target: target(pointer["target"]) });
  }
  return {
    timestamp: number(from["timestamp"], "the timestamp"),
    validFrom: number(from["validFrom"], "validFrom"),
    ...(validUntil === undefined ? {} : { validUntil: number(validUntil, "validUntil") }),
    author: text(from["author"], "the author"),
    pointers,
  };
}

/** The five fields of an arrival record, each of its own type. Ranges are the store's to check. */
export function copyArrival(given: ArrivalRecord): ArrivalRecord {
  const from = record(given, "an arrival record");
  return {
    id: text(from["id"], "an arrival id"),
    at: number(from["at"], "an arrival time"),
    sequence: number(from["sequence"], "an arrival sequence"),
    transfer: number(from["transfer"], "an arrival transfer"),
    sender: text(from["sender"], "an arrival sender"),
  };
}

/**
 * A member in objects no caller holds: the id, the canonical claims, the signature when there
 * is one, and the arrival record. Throws for a value of the wrong type. It does not check that
 * the id recomputes; the caller does that over this copy.
 */
export function copyMember(given: VerifiedDelta): VerifiedDelta {
  const from = record(given, "a member");
  const delta: unknown = from["delta"];
  const id: unknown = record(delta, "a delta")["id"];
  return { delta: copyDelta(delta, id), arrival: copyArrival(from["arrival"] as ArrivalRecord) };
}

/**
 * A delta in objects no caller holds, given its id already read from it. The id is not read
 * again, so a caller that decided by the id copies the delta under that same id.
 */
export function copyDelta(given: unknown, id: unknown): Delta {
  const delta = record(given, "a delta");
  const sig = delta["sig"];
  return {
    id: text(id, "a delta id"),
    claims: copyClaims(delta["claims"] as Claims),
    ...(sig === undefined ? {} : { sig: text(sig, "a signature") }),
  };
}
