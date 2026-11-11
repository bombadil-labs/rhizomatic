// The fetch cache of one read (SPEC-18 proposal §4.4): everything the rounds of one read have
// fetched from one snapshot, indexed as it arrives. `scopeSource` indexes a finished set once;
// this one grows, and it hands out exact sub-sources without hashing a member twice.

import { compareUtf8 } from "../delta/cbor.js";
import { DeltaSet } from "../delta/set.js";
import type { Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import type { ScopeSource } from "./scope-source.js";
import { StoreError, type Entity, type Id, type VerifiedDelta } from "./store.js";

/**
 * What one read holds. Every member came from the same snapshot: a cache kept across snapshots
 * can name negations the peer no longer holds and miss ones that arrived since (§4.3).
 *
 * `targets` and `negators` answer over every member held, in no fixed order; they feed scope
 * computation, which sorts its own answer. `source` is the sorted `DeltaSource` for readers.
 */
export interface FetchCache {
  /**
   * Files members and returns how many were new. A repeated id keeps its first appearance.
   * Refuses `invalid-request` for a member whose id does not recompute from its claims.
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
  /** The held members among `ids` as a set, carried without hashing them again. */
  subset(ids: Iterable<Id>): DeltaSet;
  /** A source that knows exactly the held members among `ids`, and nothing else in the cache. */
  source(ids: Iterable<Id>): ScopeSource;
}

const NONE: readonly Id[] = [];

export function createFetchCache(): FetchCache {
  // The set checks each id against its claims on the way in; `subset` then carries members out
  // without a second hash.
  const verified = new DeltaSet();
  const arrivals = new Map<Id, ArrivalRecord>();
  const targets = new Map<Entity, Set<Id>>();
  const negators = new Map<Id, Set<Id>>();
  const file = (index: Map<string, Set<Id>>, key: string, id: Id): void => {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, new Set([id]));
    else bucket.add(id);
  };

  const add = (members: Iterable<VerifiedDelta>): number => {
    let added = 0;
    for (const { delta, arrival } of members) {
      let fresh: boolean;
      try {
        fresh = verified.add(delta);
      } catch {
        throw new StoreError(
          "invalid-request",
          "fetch cache: a member's id does not match its claims",
        );
      }
      if (!fresh) continue;
      added += 1;
      arrivals.set(delta.id, arrival);
      for (const pointer of delta.claims.pointers) {
        if (pointer.target.kind === "entity") file(targets, pointer.target.entity.id, delta.id);
        else if (pointer.target.kind === "delta" && pointer.role === "negates")
          file(negators, pointer.target.deltaRef.delta, delta.id);
      }
    }
    return added;
  };

  const source = (ids: Iterable<Id>): ScopeSource => {
    const members = new Map<Id, Delta>();
    for (const id of ids) {
      const delta = verified.get(id);
      if (delta !== undefined) members.set(id, delta);
    }
    const sorted = [...members.keys()].sort(compareUtf8);
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
    return {
      get: (id) => members.get(id),
      arrival: (id) => (members.has(id) ? arrivals.get(id) : undefined),
      targets: (entity) => targetsWithin.get(entity) ?? NONE,
      negators: (id) => negatorsWithin.get(id) ?? NONE,
      ids: () => sorted,
    };
  };

  return {
    add,
    get size() {
      return verified.size;
    },
    get: (id) => verified.get(id),
    arrival: (id) => arrivals.get(id),
    targets: (entity) => targets.get(entity) ?? NONE,
    negators: (id) => negators.get(id) ?? NONE,
    ids: () => arrivals.keys(),
    subset: (ids) => verified.subset(ids),
    source,
  };
}
