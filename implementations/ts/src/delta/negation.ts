// Negation readers over a delta source: which negations of a delta take effect at one time, under
// one suppression rule. They read `get` and `negators` and nothing else, so they answer the same
// over a reactor, a store snapshot or a fetched scope that holds the chain.

import type { DeltaSource } from "./source.js";
import type { Delta } from "./types.js";

/** Whether a valid negation has authority to suppress its held target at this read. */
export type Suppression = (negation: Delta, target: Delta) => boolean;

/**
 * Effective direct negations of each target at a caller-supplied time, ascending by negation id.
 * A negation is effective when the source holds it, it is valid at `now`, `suppression` grants it
 * authority over the target, and it has no effective negation of its own.
 *
 * A target the source does not hold answers an empty list. A source that holds only part of the
 * surface cannot tell "absent" from "not fetched": ask only about ids whose negation chains the
 * source holds, such as the members of a scope S(E) (SPEC-17 §4). The target's own validity is a
 * separate question: history readers can ask about an expired target.
 *
 * The reader memoizes chain walks for its whole life and never looks at the source again for an
 * id it has answered. Build a new reader when the source's membership or the suppression rule
 * changes. The suppression callback must not invoke this reader recursively; compute a trust set
 * in a prior pass.
 */
export function negationWitnesses(
  source: DeltaSource,
  now: number,
  suppression: Suppression,
): (id: string) => readonly Delta[] {
  if (!Number.isFinite(now)) throw new Error("now must be a finite number");
  const memo = new Map<string, readonly Delta[]>();
  const visiting = new Set<string>();
  const valid = (delta: Delta): boolean =>
    delta.claims.validFrom <= now &&
    (delta.claims.validUntil === undefined || now < delta.claims.validUntil);
  const witnesses = (id: string): readonly Delta[] => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const target = source.get(id);
    if (target === undefined) return [];
    if (visiting.has(id)) throw new Error("negation reader re-entered during suppression");
    visiting.add(id);
    const effective: Delta[] = [];
    try {
      for (const negationId of source.negators(id)) {
        const negation = source.get(negationId);
        if (negation === undefined || !valid(negation)) continue;
        if (!suppression(negation, target) || witnesses(negationId).length > 0) continue;
        effective.push(negation);
      }
    } finally {
      visiting.delete(id);
    }
    const result = Object.freeze(effective);
    memo.set(id, result);
    return result;
  };
  return witnesses;
}

/** The yes/no form of `negationWitnesses`: is this id effectively negated? Same memo rules. */
export function negationPredicate(
  source: DeltaSource,
  now: number,
  suppression: Suppression,
): (id: string) => boolean {
  const witnesses = negationWitnesses(source, now, suppression);
  return (id) => witnesses(id).length > 0;
}
