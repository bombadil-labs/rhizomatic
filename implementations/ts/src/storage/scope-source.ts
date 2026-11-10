// A synchronous delta source over what one read has fetched (SPEC-18 proposal §4.2, §4.4). The
// store boundary is asynchronous; evaluation is not. A host fetches a scope, builds this, and
// evaluates over it without another store call.

import { compareUtf8 } from "../delta/cbor.js";
import { computeId } from "../delta/delta.js";
import type { Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import { copyArrival, copyMember } from "./copy.js";
import { StoreError, type Entity, type Id, type VerifiedDelta } from "./store.js";

/**
 * The SPEC-17 §3 delta source, answered from a fetched set, plus each member's arrival. It is
 * assignable to the evaluator's `DeltaSource`. It knows only the members it was given: an
 * answer is the store's answer restricted to the fetched set.
 */
export interface ScopeSource {
  get(id: Id): Delta | undefined;
  arrival(id: Id): ArrivalRecord | undefined;
  targets(entity: Entity): readonly Id[];
  negators(id: Id): readonly Id[];
  /** Every fetched id, ascending. */
  ids(): readonly Id[];
}

/**
 * Indexes fetched members once, at a cost of their total size. Pass `ScopeResult.deltas`, or
 * the members of several rounds of one read. A repeated id keeps its first appearance, and the
 * repeat is not examined. The source copies each member in and copies out what it returns. A
 * refusal builds nothing. Refuses
 * `invalid-request` for a member whose id does not recompute from its claims: the source files
 * members by id, and evaluation trusts that id.
 */
export function scopeSource(members: Iterable<VerifiedDelta>): ScopeSource {
  const held = new Map<Id, VerifiedDelta>();
  const targets = new Map<Entity, Id[]>();
  const negators = new Map<Id, Id[]>();
  const file = (index: Map<string, Id[]>, key: string, id: Id): void => {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [id]);
    else if (!bucket.includes(id)) bucket.push(id);
  };
  for (const member of members) {
    const id = member.delta.id;
    if (held.has(id)) continue;
    // The source keeps its own copy. The claims that are hashed are the claims it files.
    let own: VerifiedDelta | undefined;
    try {
      own = copyMember(member);
      if (computeId(own.delta.claims) !== id) own = undefined;
    } catch {
      own = undefined;
    }
    if (own === undefined)
      throw new StoreError(
        "invalid-request",
        "scopeSource: a member's id does not match its claims",
      );
    held.set(id, own);
    for (const pointer of own.delta.claims.pointers) {
      if (pointer.target.kind === "entity") file(targets, pointer.target.entity.id, id);
      else if (pointer.target.kind === "delta" && pointer.role === "negates")
        file(negators, pointer.target.deltaRef.delta, id);
    }
  }
  for (const bucket of [...targets.values(), ...negators.values()])
    Object.freeze(bucket.sort(compareUtf8));
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
