// Copies that cut every reference between a caller and what a store or a scope source holds
// (SPEC-18 proposal §4.1: a store owns what it holds).
//
// A copy here never converts. Each field is read once, its type is checked, and only then is it
// taken; a value of another type throws. So the copy holds exactly the values the caller gave,
// and the id is computed over the copy: what was checked, what was hashed and what is stored
// are one object, which no caller can reach. A delta is copied by the core's own step
// (`ownDelta`), so a store and the core read one delta object by one rule (issue #133).

import { ownDelta } from "../delta/own.js";
import type { ArrivalRecord } from "./arrival-record.js";
import type { VerifiedDelta } from "./store.js";

function malformed(what: string): never {
  throw new TypeError(`malformed member: ${what}`);
}

function text(value: unknown, what: string): string {
  return typeof value === "string" ? value : malformed(`${what} is not a string`);
}
function number(value: unknown, what: string): number {
  return typeof value === "number" ? value : malformed(`${what} is not a number`);
}
function record(value: unknown, what: string): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? ownFields(value as Record<string, unknown>)
    : malformed(`${what} is not an object`);
}

/**
 * The own enumerable fields of a caller's object, read once into an object with no prototype.
 * A field that only a prototype holds, also one set on `Object.prototype`, reads as absent.
 * Every option, request and member a store or a read takes from a caller is read through this.
 */
export function ownFields<T extends object>(given: T | undefined): T {
  return Object.assign(Object.create(null) as T, given);
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
 * A member in objects no caller holds: the own copy of its delta (`ownDelta`) and the arrival
 * record. Throws for a value of the wrong type and for a key a delta does not have. It does not
 * check that the id recomputes; the caller does that over this copy.
 */
export function copyMember(given: VerifiedDelta): VerifiedDelta {
  const from = record(given, "a member");
  return {
    delta: ownDelta(from["delta"]),
    arrival: copyArrival(from["arrival"] as ArrivalRecord),
  };
}
