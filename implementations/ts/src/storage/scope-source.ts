// A synchronous delta source over what one read has fetched (SPEC-18 proposal §4.2, §4.4). The
// store boundary is asynchronous; evaluation is not. A host fetches a scope, builds this, and
// evaluates over it without another store call.

import { compareUtf8 } from "../delta/cbor.js";
import { computeId } from "../delta/delta.js";
import type { DeltaSource } from "../delta/source.js";
import type { Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import { copyArrival, copyDelta, copyMember } from "./copy.js";
import { StoreError, type Entity, type Id, type VerifiedDelta } from "./store.js";

/**
 * The SPEC-17 §3 delta source, answered from a fetched set, plus each member's arrival. It knows
 * only the members it was given: an answer is the store's answer restricted to the fetched set.
 */
export interface ScopeSource extends DeltaSource {
  get(id: Id): Delta | undefined;
  arrival(id: Id): ArrivalRecord | undefined;
  targets(entity: Entity): readonly Id[];
  negators(id: Id): readonly Id[];
  /** Every fetched id, ascending. */
  ids(): readonly Id[];
}

/**
 * Indexes fetched members once. A cost rail (`test/store.test.ts`) times the build at N and 8N
 * in four shapes and holds each to linear scaling: members at one entity, negations of one
 * delta, entity pointers of one member, and repeated appearances of a few ids. It checks no
 * other shape, and cannot see a quadratic term too small to show. Pass `ScopeResult.deltas`, or
 * the members of several rounds of one read. A repeated id keeps its first appearance, and the
 * repeat is not examined. The source copies each member in and copies out what it returns. A
 * refusal builds nothing. Refuses `invalid-request` for a member that is malformed or whose id
 * does not recompute from its claims: the source files members by id, and evaluation trusts
 * that id. It never repairs a member.
 */
export function scopeSource(members: Iterable<VerifiedDelta>): ScopeSource {
  const held = new Map<Id, VerifiedDelta>();
  // Buckets are sets while they are built. A list here would be searched once for each
  // insert, and many members at one entity would cost the square of their number.
  const building = { targets: new Map<Entity, Set<Id>>(), negators: new Map<Id, Set<Id>>() };
  const file = (index: Map<string, Set<Id>>, key: string, id: Id): void => {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, new Set([id]));
    else bucket.add(id);
  };
  for (const member of members) {
    // The source keeps its own copy. The claims that are hashed are the claims it files.
    let own: VerifiedDelta | undefined;
    try {
      // Each field is read once. A repeated id is skipped before anything else of the member
      // is read.
      const delta: unknown = (member as { delta: unknown }).delta;
      const id: unknown = (delta as { id: unknown }).id;
      if (typeof id === "string" && held.has(id)) continue;
      own = {
        delta: copyDelta(delta, id),
        arrival: copyArrival((member as { arrival: VerifiedDelta["arrival"] }).arrival),
      };
      if (computeId(own.delta.claims) !== own.delta.id) own = undefined;
    } catch {
      own = undefined;
    }
    if (own === undefined)
      throw new StoreError(
        "invalid-request",
        "scopeSource: a member is malformed, or its id does not match its claims",
      );
    const id = own.delta.id;
    held.set(id, own);
    for (const pointer of own.delta.claims.pointers) {
      if (pointer.target.kind === "entity") file(building.targets, pointer.target.entity.id, id);
      else if (pointer.target.kind === "delta" && pointer.role === "negates")
        file(building.negators, pointer.target.deltaRef.delta, id);
    }
  }
  const frozen = (index: Map<string, Set<Id>>): Map<string, readonly Id[]> =>
    new Map([...index].map(([key, bucket]) => [key, Object.freeze([...bucket].sort(compareUtf8))]));
  const targets = frozen(building.targets);
  const negators = frozen(building.negators);
  const ids = Object.freeze([...held.keys()].sort(compareUtf8));
  const none: readonly Id[] = Object.freeze([]);
  // Lists are frozen and members are copied out, so nothing a caller does to an answer
  // changes a later answer.
  return {
    get: (id) => {
      const member = held.get(id);
      return member === undefined ? undefined : copyMember(member).delta;
    },
    arrival: (id) => {
      const member = held.get(id);
      return member === undefined ? undefined : copyArrival(member.arrival);
    },
    targets: (entity) => targets.get(entity) ?? none,
    negators: (id) => negators.get(id) ?? none,
    ids: () => ids,
  };
}
