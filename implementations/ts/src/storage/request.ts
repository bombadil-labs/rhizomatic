// The checks every store makes of a caller's request before it reads or writes (SPEC-18 proposal
// §4.11 readings 21 and 34; §4.13 reading 104). Each store calls these, so two stores refuse one
// request with one code.

import { computeId } from "../delta/delta.js";
import type { Claims } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import { copyMember, isPlainObject } from "./copy.js";
import {
  StoreError,
  type Id,
  type Pushdown,
  type ScopeRequest,
  type VerifiedDelta,
} from "./store.js";

// A lone surrogate: a UTF-16 code unit that is not half of a pair. Such a string has no UTF-8
// form, so two of them can be stored as one (§4.13 reading 104).
const LONE_SURROGATE = /\p{Cs}/u;

/** True when the string is well-formed UTF-16: it holds no lone surrogate. */
export const wellFormed = (text: string): boolean => !LONE_SURROGATE.test(text);

function claimsWellFormed(claims: Claims): boolean {
  const texts: string[] = [claims.author];
  for (const { role, target } of claims.pointers) {
    texts.push(role);
    if (target.kind === "primitive" && typeof target.value === "string") texts.push(target.value);
    else if (target.kind === "entity") texts.push(target.entity.id, target.entity.context ?? "");
    else if (target.kind === "delta")
      texts.push(target.deltaRef.delta, target.deltaRef.context ?? "");
    else if (target.kind === "bytes") texts.push(target.mime);
  }
  return texts.every(wellFormed);
}

/**
 * A caller's list of ids or entities, read once into a list the store owns. Refuses
 * `invalid-request` for anything that is not a list of well-formed strings.
 */
export function strings(given: unknown, what: string): string[] {
  if (!Array.isArray(given)) throw new StoreError("invalid-request", `${what} must be a list`);
  const own: string[] = [];
  for (let i = 0; i < given.length; i++) {
    const item: unknown = given[i];
    if (typeof item !== "string")
      throw new StoreError("invalid-request", `${what} must hold strings only`);
    if (!wellFormed(item))
      throw new StoreError("invalid-request", `${what} must hold well-formed strings only`);
    own.push(item);
  }
  return own;
}

/** One admitted entry, copied and checked: its id, claims, signature and arrival record. */
export type Admitted = {
  readonly id: Id;
  readonly claims: Claims;
  readonly sig: string | undefined;
  readonly arrival: ArrivalRecord;
};

const SIG = /^[0-9a-f]{128}$/;

/**
 * A checked copy of one admitted entry. Refuses `invalid-admission`. The entry is copied
 * first, by a copy that converts nothing and throws for a value of the wrong type; every check
 * after that reads the copy. Checking the caller's object and then copying it would leave a
 * moment in which the object can change.
 */
export function admit(entry: unknown): Admitted {
  const refuse = (what: string): never => {
    throw new StoreError("invalid-admission", `append: ${what}`);
  };
  let own: VerifiedDelta;
  let id: string;
  try {
    own = copyMember(entry as VerifiedDelta);
    if (!claimsWellFormed(own.delta.claims) || !wellFormed(own.arrival.sender))
      return refuse("a string is not well-formed");
    id = computeId(own.delta.claims);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    return refuse("an entry is malformed");
  }
  // Claims are shared across peers by id. An id that does not recompute would let one peer's
  // append change what another peer reads.
  if (id !== own.delta.id) refuse("a delta id does not match its claims");
  const sig = own.delta.sig;
  if (sig !== undefined && !SIG.test(sig))
    refuse("a signature is not 128 lowercase hex characters");
  const { at, sequence, transfer, sender } = own.arrival;
  const count = (n: number): boolean => Number.isSafeInteger(n) && n >= 1;
  if (
    own.arrival.id !== id ||
    !count(sequence) ||
    !count(transfer) ||
    !Number.isFinite(at) ||
    sender.length === 0
  )
    refuse("an arrival record is malformed");
  return { id, claims: own.delta.claims, sig, arrival: own.arrival };
}

/**
 * The fields of an append, each read once, with the checks that come before the head
 * compare-and-set. Refuses `invalid-admission` for a malformed call or next head, and
 * `capability-absent` for a frame: no store here keeps a journal.
 */
export function takeAppend(batch: unknown): {
  expectedHead: unknown;
  nextHead: string;
  added: unknown;
} {
  let call: { expectedHead: unknown; nextHead: unknown; frame: unknown; added: unknown };
  try {
    const { expectedHead, nextHead, frame, added } = batch as Record<string, unknown>;
    call = { expectedHead, nextHead, frame, added };
  } catch {
    throw new StoreError("invalid-admission", "append: the call is malformed");
  }
  const { expectedHead, nextHead, frame, added } = call;
  if (typeof nextHead !== "string" || nextHead.length === 0)
    throw new StoreError("invalid-admission", "append: the next head must not be empty");
  if (!wellFormed(nextHead))
    throw new StoreError("invalid-admission", "append: the next head is not well-formed");
  if (frame !== null)
    throw new StoreError(
      "capability-absent",
      "append: this store has no journal capability and cannot keep a frame",
    );
  return { expectedHead, nextHead, added };
}

/** A scope request in values the store owns, each read from the caller once. */
export type OwnScope = {
  /** An anchor of kind `entity` holds a string. Another kind is refused when the scope runs. */
  readonly anchors: readonly { readonly kind: unknown; readonly entity: unknown }[];
  readonly asked: {
    readonly timestampAtMost?: number;
    readonly arrivalAtMost?: number;
    readonly excludeIds?: readonly Id[];
  };
  readonly exclude: readonly Id[];
};

/** Refuses `invalid-request` for a request that is malformed or has a bound outside its values. */
export function takeScope(request: ScopeRequest): OwnScope {
  const refuse = (what: string): never => {
    throw new StoreError("invalid-request", `scope: ${what}`);
  };
  let exclude: unknown;
  let bounds: { timestampAtMost: unknown; arrivalAtMost: unknown; excludeIds: unknown };
  const anchors: { kind: unknown; entity: unknown }[] = [];
  try {
    const { anchors: list, pushdown, exclude: omit } = request;
    exclude = omit;
    // Absent means no pushdown. Anything else that is not a plain object is refused, never
    // read as an empty one.
    if (pushdown !== undefined && !isPlainObject(pushdown)) throw new TypeError("pushdown");
    const { timestampAtMost, arrivalAtMost, excludeIds } = (pushdown ?? {}) as Pushdown;
    bounds = { timestampAtMost, arrivalAtMost, excludeIds };
    if (!Array.isArray(list)) throw new TypeError("anchors");
    for (let i = 0; i < list.length; i++) {
      const { kind, entity } = list[i] as { kind: unknown; entity: unknown };
      if (typeof kind !== "string") throw new TypeError("kind");
      if (kind === "entity" && typeof entity !== "string") throw new TypeError("entity");
      anchors.push({ kind, entity });
    }
  } catch {
    return refuse("the request is malformed");
  }
  if (anchors.some(({ kind, entity }) => kind === "entity" && !wellFormed(entity as string)))
    refuse("an anchor entity is not well-formed");
  const { timestampAtMost, arrivalAtMost, excludeIds } = bounds;
  if (timestampAtMost !== undefined && !Number.isFinite(timestampAtMost))
    refuse("timestampAtMost must be a finite number");
  if (
    arrivalAtMost !== undefined &&
    !(Number.isSafeInteger(arrivalAtMost) && (arrivalAtMost as number) >= 0)
  )
    refuse("arrivalAtMost must be an integer, 0 or more");
  return {
    anchors,
    asked: {
      ...(timestampAtMost === undefined ? {} : { timestampAtMost: timestampAtMost as number }),
      ...(arrivalAtMost === undefined ? {} : { arrivalAtMost: arrivalAtMost as number }),
      ...(excludeIds === undefined ? {} : { excludeIds: strings(excludeIds, "scope: excludeIds") }),
    },
    exclude: exclude === undefined ? [] : strings(exclude, "scope: exclude"),
  };
}
