// Resolution policies and Views (SPEC-5, ERRATA-5). resolve : Policy -> HView -> View is the
// only exit from the algebra into application space; all pluralism is policy choice (P5).

import { type CborValue, array, bool, encode, float, map, tstr } from "./cbor.js";
import { bytesToHex } from "./hash.js";
import type { HVEntry, HView } from "./hview.js";
import { comparePrimitives, evalPred, type Pred } from "./pred.js";
import type { Primitive, Target } from "./types.js";

export type View = Primitive | readonly View[] | { readonly [key: string]: View };

export type MergeFn = "max" | "min" | "sum" | "count" | "and" | "or" | "concatSorted";

export type Order =
  | { readonly kind: "byTimestamp"; readonly dir: "desc" | "asc" }
  | { readonly kind: "byAuthorRank"; readonly authors: readonly string[] }
  | { readonly kind: "byPred"; readonly pred: Pred; readonly then: Order }
  | { readonly kind: "chain"; readonly orders: readonly Order[] }
  | { readonly kind: "lexById" };

export type PropPolicy =
  | { readonly kind: "pick"; readonly order: Order }
  | { readonly kind: "all"; readonly order: Order }
  | { readonly kind: "merge"; readonly fn: MergeFn }
  | { readonly kind: "conflicts"; readonly order: Order }
  | { readonly kind: "absentAs"; readonly constant: Primitive; readonly then: PropPolicy };

export interface Policy {
  readonly props: ReadonlyMap<string, PropPolicy>;
  readonly default: PropPolicy;
}

// --- ordering (R3: every chain ends in an implicit lexById tiebreak) ------------------------------

function cmpByOrder(order: Order, a: HVEntry, b: HVEntry): number {
  switch (order.kind) {
    case "byTimestamp": {
      const d = a.delta.claims.timestamp - b.delta.claims.timestamp;
      if (d !== 0) return order.dir === "desc" ? -d : d;
      return 0;
    }
    case "byAuthorRank": {
      const rank = (author: string) => {
        const i = order.authors.indexOf(author);
        return i === -1 ? order.authors.length : i;
      };
      return rank(a.delta.claims.author) - rank(b.delta.claims.author);
    }
    case "byPred": {
      const am = evalPred(order.pred, a.delta) ? 0 : 1;
      const bm = evalPred(order.pred, b.delta) ? 0 : 1;
      if (am !== bm) return am - bm; // matches first
      return cmpByOrder(order.then, a, b);
    }
    case "chain": {
      for (const o of order.orders) {
        const c = cmpByOrder(o, a, b);
        if (c !== 0) return c;
      }
      return 0;
    }
    case "lexById":
      return a.delta.id < b.delta.id ? -1 : a.delta.id > b.delta.id ? 1 : 0;
  }
}

function sortEntries(order: Order, entries: readonly HVEntry[]): HVEntry[] {
  return [...entries].sort((a, b) => {
    const primary = cmpByOrder(order, a, b);
    if (primary !== 0) return primary;
    return a.delta.id < b.delta.id ? -1 : a.delta.id > b.delta.id ? 1 : 0;
  });
}

// --- candidate value extraction (R1) ---------------------------------------------------------------

function renderTarget(t: Target, expansion: HView | undefined, policy: Policy): View {
  if (expansion !== undefined) return resolveView(policy, expansion);
  switch (t.kind) {
    case "primitive":
      return t.value;
    case "entity":
      return t.entity.id;
    case "delta":
      return t.deltaRef.delta;
  }
}

function candidateValue(e: HVEntry, root: string, policy: Policy): View {
  const nonFiling: Array<[string, View]> = [];
  e.delta.claims.pointers.forEach((p, i) => {
    const filing = p.target.kind === "entity" && p.target.entity.id === root;
    if (filing) return;
    nonFiling.push([p.role, renderTarget(p.target, e.expanded?.get(i), policy)]);
  });
  if (nonFiling.length === 0) return true; // the bare fact of the edge
  if (nonFiling.length === 1) return nonFiling[0]![1];
  const obj: Record<string, View> = {};
  for (const [role, v] of nonFiling) {
    const existing = obj[role];
    if (existing === undefined) obj[role] = v;
    else if (Array.isArray(existing)) obj[role] = [...existing, v];
    else obj[role] = [existing, v];
  }
  return obj;
}

// --- View canonical form (R4) ----------------------------------------------------------------------

export function viewToCbor(v: View): CborValue {
  if (typeof v === "string") return tstr(v);
  if (typeof v === "number") return float(v);
  if (typeof v === "boolean") return bool(v);
  if (Array.isArray(v)) return array(v.map(viewToCbor));
  const entries = Object.entries(v as { [key: string]: View }).map(
    ([k, x]): readonly [string, CborValue] => [k, viewToCbor(x)],
  );
  return map(entries);
}

export function viewCanonicalHex(v: View): string {
  return bytesToHex(encode(viewToCbor(v)));
}

// --- resolution ------------------------------------------------------------------------------------

const ABSENT = Symbol("absent");
type Resolved = View | typeof ABSENT;

function isPrimitive(v: View): v is Primitive {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function applyMerge(
  fn: MergeFn,
  entries: readonly HVEntry[],
  root: string,
  policy: Policy,
): Resolved {
  // Fold in ascending delta-id order — float addition is order-dependent (R2).
  const sorted = sortEntries({ kind: "lexById" }, entries);
  if (fn === "count") return sorted.length === 0 ? ABSENT : sorted.length;
  const prims = sorted
    .map((e) => candidateValue(e, root, policy))
    .filter((v): v is Primitive => isPrimitive(v));
  switch (fn) {
    case "max":
    case "min": {
      if (prims.length === 0) return ABSENT;
      return prims.reduce((acc, v) => {
        const c = comparePrimitives(v, acc);
        return (fn === "max" ? c > 0 : c < 0) ? v : acc;
      });
    }
    case "sum": {
      const nums = prims.filter((v): v is number => typeof v === "number");
      if (nums.length === 0) return ABSENT;
      return nums.reduce((a, b) => a + b, 0);
    }
    case "and":
    case "or": {
      const bools = prims.filter((v): v is boolean => typeof v === "boolean");
      if (bools.length === 0) return ABSENT;
      return fn === "and" ? bools.every(Boolean) : bools.some(Boolean);
    }
    case "concatSorted": {
      if (prims.length === 0) return ABSENT;
      return [...prims].sort(comparePrimitives);
    }
  }
}

function applyPropPolicy(
  pp: PropPolicy,
  entries: readonly HVEntry[],
  root: string,
  policy: Policy,
): Resolved {
  switch (pp.kind) {
    case "pick": {
      if (entries.length === 0) return ABSENT;
      const sorted = sortEntries(pp.order, entries);
      return candidateValue(sorted[0]!, root, policy);
    }
    case "all": {
      if (entries.length === 0) return ABSENT;
      return sortEntries(pp.order, entries).map((e) => candidateValue(e, root, policy));
    }
    case "merge":
      return applyMerge(pp.fn, entries, root, policy);
    case "conflicts": {
      const sorted = sortEntries(pp.order, entries);
      const seen = new Set<string>();
      const distinct: View[] = [];
      for (const e of sorted) {
        const v = candidateValue(e, root, policy);
        const key = viewCanonicalHex(v);
        if (!seen.has(key)) {
          seen.add(key);
          distinct.push(v);
        }
      }
      return distinct.length >= 2 ? distinct : ABSENT;
    }
    case "absentAs": {
      const inner = applyPropPolicy(pp.then, entries, root, policy);
      return inner === ABSENT ? pp.constant : inner;
    }
  }
}

// resolve(policy, HView) -> View. Deterministic; total; provenance-optional (SPEC-5 §2).
// The View covers every property named in the policy plus every HView property (R3).
export function resolveView(policy: Policy, hview: HView): View {
  const keys = new Set<string>([...policy.props.keys(), ...hview.props.keys()]);
  const obj: Record<string, View> = {};
  for (const key of keys) {
    const entries = hview.props.get(key) ?? [];
    const pp = policy.props.get(key) ?? policy.default;
    const v = applyPropPolicy(pp, entries, hview.id, policy);
    if (v !== ABSENT) obj[key] = v;
  }
  return obj;
}
