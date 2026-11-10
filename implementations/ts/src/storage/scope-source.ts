// A synchronous delta source over what one read has fetched (SPEC-18 proposal §4.2, §4.4). The
// store boundary is asynchronous; evaluation is not. A host fetches a scope, builds this, and
// evaluates over it without another store call.

import { compareUtf8 } from "../delta/cbor.js";
import { computeId } from "../delta/delta.js";
import type { DeltaSource } from "../delta/source.js";
import type { Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
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
 * Indexes fetched members once, at a cost of their total size. Pass `ScopeResult.deltas`, or
 * the members of several rounds of one read; a repeated id keeps its first appearance. Refuses
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
    let recomputed: string | undefined;
    try {
      recomputed = computeId(member.delta.claims);
    } catch {
      recomputed = undefined;
    }
    if (recomputed !== id)
      throw new StoreError(
        "invalid-request",
        "scopeSource: a member's id does not match its claims",
      );
    held.set(id, member);
    for (const pointer of member.delta.claims.pointers) {
      if (pointer.target.kind === "entity") file(targets, pointer.target.entity.id, id);
      else if (pointer.target.kind === "delta" && pointer.role === "negates")
        file(negators, pointer.target.deltaRef.delta, id);
    }
  }
  for (const bucket of [...targets.values(), ...negators.values()]) bucket.sort(compareUtf8);
  const ids = [...held.keys()].sort(compareUtf8);
  return {
    get: (id) => held.get(id)?.delta,
    arrival: (id) => held.get(id)?.arrival,
    targets: (entity) => targets.get(entity) ?? [],
    negators: (id) => negators.get(id) ?? [],
    ids: () => ids,
  };
}
