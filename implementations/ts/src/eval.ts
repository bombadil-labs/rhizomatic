// Term evaluation for the DSet fragment of the algebra: select, union, mask (SPEC-2 §4.1-4.3).
// eval is a pure function; order-blind; deterministic (SPEC-2 §5).

import { array, encode, map, tstr } from "./cbor.js";
import { bytesToHex } from "./hash.js";
import { evalPred, type Pred } from "./pred.js";
import { DeltaSet, fork, merge } from "./set.js";
import type { Delta } from "./types.js";

export type MaskPolicy =
  | { readonly kind: "drop" }
  | { readonly kind: "annotate" }
  | { readonly kind: "trust"; readonly pred: Pred };

export type Term =
  | { readonly kind: "input" }
  | { readonly kind: "select"; readonly pred: Pred; readonly of: Term }
  | { readonly kind: "union"; readonly left: Term; readonly right: Term }
  | { readonly kind: "mask"; readonly policy: MaskPolicy; readonly of: Term };

export interface EvalResult {
  readonly set: DeltaSet;
  // Negation tags; populated only by a top-level mask(annotate) (ERRATA-2 E2).
  readonly negated: ReadonlySet<string>;
  readonly annotated: boolean;
}

// negated(d, D) per SPEC-2 §4.3, over candidate negations restricted by `trusted` (E4).
// Memoized with an in-progress default of "not negated" (E5 recursion guard).
function computeNegated(d: DeltaSet, trusted?: (n: Delta) => boolean): Set<string> {
  const negators = new Map<string, string[]>(); // target delta id -> negation delta ids
  for (const n of d) {
    if (trusted !== undefined && !trusted(n)) continue;
    for (const ptr of n.claims.pointers) {
      if (ptr.role === "negates" && ptr.target.kind === "delta") {
        const list = negators.get(ptr.target.deltaRef.delta);
        if (list === undefined) negators.set(ptr.target.deltaRef.delta, [n.id]);
        else list.push(n.id);
      }
    }
  }
  const memo = new Map<string, boolean>();
  const isNegated = (id: string): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    memo.set(id, false); // guard: cycles are impossible with verified ids, but degrade safely
    const result = (negators.get(id) ?? []).some((nid) => !isNegated(nid));
    memo.set(id, result);
    return result;
  };
  const out = new Set<string>();
  for (const delta of d) if (isNegated(delta.id)) out.add(delta.id);
  return out;
}

export function evalTerm(term: Term, input: DeltaSet): EvalResult {
  switch (term.kind) {
    case "input":
      return { set: input, negated: new Set(), annotated: false };
    case "select": {
      const of = evalTerm(term.of, input);
      return {
        set: fork(of.set, (d) => evalPred(term.pred, d)),
        negated: new Set(),
        annotated: false,
      };
    }
    case "union": {
      const left = evalTerm(term.left, input);
      const right = evalTerm(term.right, input);
      return { set: merge(left.set, right.set), negated: new Set(), annotated: false };
    }
    case "mask": {
      const of = evalTerm(term.of, input);
      switch (term.policy.kind) {
        case "drop": {
          const negated = computeNegated(of.set);
          return {
            set: fork(of.set, (d) => !negated.has(d.id)),
            negated: new Set(),
            annotated: false,
          };
        }
        case "annotate": {
          const negated = computeNegated(of.set);
          return { set: of.set, negated, annotated: true };
        }
        case "trust": {
          const pred = term.policy.pred;
          const negated = computeNegated(of.set, (n) => evalPred(pred, n));
          return {
            set: fork(of.set, (d) => !negated.has(d.id)),
            negated: new Set(),
            annotated: false,
          };
        }
      }
    }
  }
}

// Canonical serialization of a DSet-sort result (ERRATA-2 E2): sorted id array, or for a
// top-level annotate, the map {"ids": [...], "negated": [...]}.
export function resultCanonicalHex(result: EvalResult): string {
  const ids = result.set.ids().map(tstr);
  if (!result.annotated) return bytesToHex(encode(array(ids)));
  const negated = [...result.negated].sort().map(tstr);
  return bytesToHex(
    encode(
      map([
        ["ids", array(ids)],
        ["negated", array(negated)],
      ]),
    ),
  );
}
