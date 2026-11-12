// The fetch cache of one read (SPEC-18 proposal §4.4): everything the rounds of one read have
// fetched from one snapshot, indexed as it arrives. `scopeSource` indexes a finished set once;
// this one grows, and it hands out exact sub-sources without hashing a member twice.
//
// It owns what it holds, as a store and `scopeSource` do (§4.1): `copyMember` checks and copies
// each member, the id is computed over that copy, and nothing the cache hands out reaches what
// it keeps.

import { compareUtf8 } from "../delta/cbor.js";
import { DeltaSet } from "../delta/set.js";
import type { Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import { copyArrival, copyMember } from "./copy.js";
import type { ScopeSource } from "./scope-source.js";
import { StoreError, type Entity, type Id, type VerifiedDelta } from "./store.js";

/**
 * What one read holds. Every member came from the same snapshot: a cache kept across snapshots
 * can name negations the peer no longer holds and miss ones that arrived since (§4.3).
 *
 * `targets` and `negators` answer over every member held, in no fixed order; they feed scope
 * computation, which sorts its own answer. `source` is the sorted `DeltaSource` for readers.
 * Every answer is a copy or cannot be changed: nothing a caller does to one changes the cache.
 */
export interface FetchCache {
  /**
   * Files members and returns how many were new. A repeated id keeps its first appearance, and
   * the repeat is not examined. Refuses `invalid-request` for a member that is malformed, whose
   * id does not recompute from its claims, or whose arrival record is missing or names another
   * id. A refused call files nothing.
   */
  add(members: Iterable<VerifiedDelta>): number;
  /** How many members are held. */
  readonly size: number;
  get(id: Id): Delta | undefined;
  arrival(id: Id): ArrivalRecord | undefined;
  targets(entity: Entity): Iterable<Id>;
  negators(id: Id): Iterable<Id>;
  /** Every held id, in the order fetched. */
  ids(): Iterable<Id>;
  /** A source that knows exactly the held members among `ids`, and nothing else in the cache. */
  source(ids: Iterable<Id>): ScopeSource;
}

/**
 * The read's own access to what the cache keeps, with no copy. Only the read that made the
 * cache holds it. What it returns reaches a caller only inside the read's result, and by then
 * no later answer depends on the cache.
 */
export interface HeldMembers {
  get(id: Id): Delta | undefined;
  arrival(id: Id): ArrivalRecord | undefined;
  targets(entity: Entity): Iterable<Id>;
  negators(id: Id): Iterable<Id>;
  /** The held members among `ids` as a set, carried without hashing them again. */
  subset(ids: Iterable<Id>): DeltaSet;
}

const NONE: readonly Id[] = Object.freeze([]);
const EMPTY: ReadonlySet<Id> = new Set();

/** A fetch cache, and the read's own access to it. Not part of the package surface. */
export function createReadCache(): { readonly cache: FetchCache; readonly held: HeldMembers } {
  // Every member of the set is the cache's own copy, checked once on the way in; `subset` and
  // `union` carry members without a second hash.
  let verified = new DeltaSet();
  const arrivals = new Map<Id, ArrivalRecord>();
  const targets = new Map<Entity, Set<Id>>();
  const negators = new Map<Id, Set<Id>>();
  const file = (index: Map<string, Set<Id>>, key: string, id: Id): void => {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, new Set([id]));
    else bucket.add(id);
  };
  const refuse = (): never => {
    throw new StoreError(
      "invalid-request",
      "fetch cache: a member is malformed, its id does not match its claims, or its arrival record is missing or names another id",
    );
  };

  const add = (members: Iterable<VerifiedDelta>): number => {
    // Every new member is checked before any is filed, so a refused call files nothing.
    const fresh = new DeltaSet();
    const freshArrivals = new Map<Id, ArrivalRecord>();
    for (const member of members) {
      let own: VerifiedDelta;
      try {
        // A repeated id is skipped before anything else of the member is read.
        const given = member.delta.id;
        if (verified.has(given) || fresh.has(given)) continue;
        own = copyMember(member);
      } catch {
        return refuse();
      }
      const id = own.delta.id;
      if (verified.has(id) || fresh.has(id)) continue;
      if (own.arrival.id !== id) return refuse();
      try {
        // The id is computed over the cache's own copy.
        fresh.add(own.delta);
      } catch {
        return refuse();
      }
      freshArrivals.set(id, own.arrival);
    }
    verified = verified.union(fresh);
    for (const delta of fresh) {
      arrivals.set(delta.id, freshArrivals.get(delta.id)!);
      for (const pointer of delta.claims.pointers) {
        if (pointer.target.kind === "entity") file(targets, pointer.target.entity.id, delta.id);
        else if (pointer.target.kind === "delta" && pointer.role === "negates")
          file(negators, pointer.target.deltaRef.delta, delta.id);
      }
    }
    return fresh.size;
  };

  // A copy that shares nothing with the cache. The member was checked when it entered.
  const handOut = (delta: Delta): Delta =>
    copyMember({ delta, arrival: arrivals.get(delta.id)! }).delta;

  const source = (ids: Iterable<Id>): ScopeSource => {
    const members = new Map<Id, Delta>();
    for (const id of ids) {
      const delta = verified.get(id);
      if (delta !== undefined) members.set(id, delta);
    }
    const sorted = Object.freeze([...members.keys()].sort(compareUtf8));
    // Filed in ascending id order, so every bucket is ascending and holds each id once.
    const targetsWithin = new Map<Entity, Id[]>();
    const negatorsWithin = new Map<Id, Id[]>();
    const fileSorted = (index: Map<string, Id[]>, key: string, id: Id): void => {
      const bucket = index.get(key);
      if (bucket === undefined) index.set(key, [id]);
      else if (bucket[bucket.length - 1] !== id) bucket.push(id);
    };
    for (const id of sorted)
      for (const pointer of members.get(id)!.claims.pointers) {
        if (pointer.target.kind === "entity")
          fileSorted(targetsWithin, pointer.target.entity.id, id);
        else if (pointer.target.kind === "delta" && pointer.role === "negates")
          fileSorted(negatorsWithin, pointer.target.deltaRef.delta, id);
      }
    for (const bucket of [...targetsWithin.values(), ...negatorsWithin.values()])
      Object.freeze(bucket);
    return {
      get: (id) => {
        const delta = members.get(id);
        return delta === undefined ? undefined : handOut(delta);
      },
      arrival: (id) => (members.has(id) ? copyArrival(arrivals.get(id)!) : undefined),
      targets: (entity) => targetsWithin.get(entity) ?? NONE,
      negators: (id) => negatorsWithin.get(id) ?? NONE,
      ids: () => sorted,
    };
  };

  // A bucket's own iterator: a caller can read it and cannot change the bucket.
  const listed = (index: Map<string, Set<Id>>, key: string): Iterable<Id> =>
    (index.get(key) ?? EMPTY).values();

  const cache: FetchCache = {
    add,
    get size() {
      return verified.size;
    },
    get: (id) => {
      const delta = verified.get(id);
      return delta === undefined ? undefined : handOut(delta);
    },
    arrival: (id) => {
      const arrival = arrivals.get(id);
      return arrival === undefined ? undefined : copyArrival(arrival);
    },
    targets: (entity) => listed(targets, entity),
    negators: (id) => listed(negators, id),
    ids: () => arrivals.keys(),
    source,
  };
  const held: HeldMembers = {
    get: (id) => verified.get(id),
    arrival: (id) => arrivals.get(id),
    targets: (entity) => listed(targets, entity),
    negators: (id) => listed(negators, id),
    subset: (ids) => verified.subset(ids),
  };
  return { cache, held };
}

export function createFetchCache(): FetchCache {
  return createReadCache().cache;
}
