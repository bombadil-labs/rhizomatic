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
 *
 * A source whose membership can change passes `epoch`, a counter that moves on each change. The
 * reader looks at it at every step of a walk and drops its memo when the value moved, also when
 * a suppression callback changed the source in the middle of a walk.
 *
 * The source must hold content-addressed deltas (`DeltaSource`). A negator the source lists but
 * cannot `get` is not counted. A negation cycle, which only a source with forged ids can hold,
 * throws.
 */
export function negationWitnesses(
  source: DeltaSource,
  now: number,
  suppression: Suppression,
  epoch?: () => number,
): (id: string) => readonly Delta[] {
  if (!Number.isFinite(now)) throw new Error("now must be a finite number");
  const memo = new Map<string, readonly Delta[]>();
  const visiting = new Set<string>();
  let seen = epoch?.();
  // True while a suppression callback runs: a walk that starts then is a re-entry.
  let inSuppression = false;
  const valid = (delta: Delta): boolean =>
    delta.claims.validFrom <= now &&
    (delta.claims.validUntil === undefined || now < delta.claims.validUntil);
  const witnesses = (id: string): readonly Delta[] => {
    if (epoch !== undefined) {
      const current = epoch();
      if (current !== seen) {
        memo.clear();
        visiting.clear();
        seen = current;
      }
    }
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const target = source.get(id);
    if (target === undefined) return [];
    if (visiting.has(id)) {
      if (inSuppression) throw new Error("negation reader re-entered during suppression");
      throw new Error(
        "negation cycle: the delta source holds deltas that are not content-addressed",
      );
    }
    visiting.add(id);
    const effective: Delta[] = [];
    try {
      for (const negationId of source.negators(id)) {
        const negation = source.get(negationId);
        if (negation === undefined || !valid(negation)) continue;
        const outer = inSuppression;
        inSuppression = true;
        let grants: boolean;
        try {
          grants = suppression(negation, target);
        } finally {
          inSuppression = outer;
        }
        if (!grants || witnesses(negationId).length > 0) continue;
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
  epoch?: () => number,
): (id: string) => boolean {
  const witnesses = negationWitnesses(source, now, suppression, epoch);
  return (id) => witnesses(id).length > 0;
}
