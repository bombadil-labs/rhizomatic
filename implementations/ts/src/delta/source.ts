// The delta source (SPEC-17 §3): the three index reads every reader of a store is written
// against. It lives with the delta vocabulary so that a store, an evaluator and a law reader can
// all name it without depending on one another.

import type { DeltaSet } from "./set.js";
import type { Delta } from "./types.js";

/**
 * The read side of a store (SPEC-17 §3). `targets` and `negators` answer from indexes; neither
 * may scan the store. Each returns every matching id the source holds exactly once, ascending by
 * the UTF-8 bytes of the id (`compareUtf8`), as an array the caller must not change. A `Set`, or
 * a list in arrival order, does not conform. `subset`, when present, builds a set from members
 * the source has already verified, without hashing them again.
 *
 * A source holds content-addressed deltas: each id recomputes from its claims. Negation chains
 * over such deltas cannot form a cycle, and the readers rely on that; a reader that meets a
 * cycle throws. `targets` and `negators` list only ids the source holds, so `get` returns each
 * one. A reader skips a listed id that `get` cannot return, and does not count it.
 */
export interface DeltaSource {
  get(id: string): Delta | undefined;
  /** Ids of every delta with a pointer whose target is the entity `entity`, any role or context. */
  targets(entity: string): readonly string[];
  /** Ids of every delta with a pointer `{role: "negates", target: DeltaRef(id)}`. */
  negators(id: string): readonly string[];
  subset?(ids: Iterable<string>): DeltaSet;
}
