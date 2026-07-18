// Resolution (SPEC-5, ERRATA-5): a Schema — per-property Policies + a default — resolves a
// HyperView into a View. resolve : Schema -> HView -> View is the only exit from the algebra
// into application space; all pluralism is schema choice (P5).

import { type CborValue, array, bool, bstr, encode, float, map, tstr } from "./cbor.js";
import { bytesToHex } from "./hash.js";
import type { HVEntry, HView } from "./hview.js";
import { comparePrimitives, evalPred, type Pred } from "./pred.js";
import type { Primitive, Target } from "./types.js";

// A bytes View leaf, shaped identically to the target (SPEC-5 §5). Distinguished from a plain
// object View by its Uint8Array `value` — which is never itself a View, so the two never collide.
export interface BytesView {
  readonly mime: string;
  readonly value: Uint8Array;
}

export type View = Primitive | BytesView | readonly View[] | { readonly [key: string]: View };

function isBytesView(v: View): v is BytesView {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { value?: unknown }).value instanceof Uint8Array
  );
}

export type MergeFn = "max" | "min" | "sum" | "count" | "and" | "or" | "concatSorted";

export type Order =
  | { readonly kind: "byTimestamp"; readonly dir: "desc" | "asc" }
  | { readonly kind: "byAuthorRank"; readonly authors: readonly string[] }
  | { readonly kind: "byPred"; readonly pred: Pred; readonly then: Order }
  | { readonly kind: "chain"; readonly orders: readonly Order[] }
  | { readonly kind: "lexById" };

export type Policy =
  | { readonly kind: "pick"; readonly order: Order }
  | { readonly kind: "all"; readonly order: Order }
  | { readonly kind: "merge"; readonly fn: MergeFn }
  | { readonly kind: "conflicts"; readonly order: Order }
  | { readonly kind: "absentAs"; readonly constant: Primitive; readonly then: Policy };

export interface Schema {
  readonly props: ReadonlyMap<string, Policy>;
  readonly default: Policy;
  // Optional identity for a named/self-hosting Schema (SPEC-3 ERRATA S6); absent on inline
  // resolve-term schemas. A named Schema carries name + alg (the L5 algebra version).
  readonly name?: string;
  readonly alg?: number;
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

function renderTarget(t: Target, e: HVEntry, i: number): View {
  const expansion = e.expanded?.get(i);
  if (expansion !== undefined) {
    // An expansion resolves through ITS OWN reading — the child's resolution Schema named in the
    // expand term (issue #23). There is no parent-Schema fallback: a legacy body (no reading)
    // gathers fine but refuses to resolve, loudly.
    const reading = e.readings?.get(i);
    if (reading === undefined) {
      throw new Error(
        `expansion at pointer ${i} of delta ${e.delta.id} carries no reading — ` +
          `legacy expand bodies must name the child's resolution Schema (SPEC-5 §4, issue #23)`,
      );
    }
    return resolveView(reading, expansion);
  }
  switch (t.kind) {
    case "primitive":
      return t.value;
    case "entity":
      return t.entity.id;
    case "delta":
      return t.deltaRef.delta;
    case "bytes":
      return { mime: t.mime, value: t.value };
  }
}

function candidateValue(e: HVEntry, root: string): View {
  const nonFiling: Array<[string, View]> = [];
  e.delta.claims.pointers.forEach((p, i) => {
    const filing = p.target.kind === "entity" && p.target.entity.id === root;
    if (filing) return;
    nonFiling.push([p.role, renderTarget(p.target, e, i)]);
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
  // the bytes leaf's canonical CBOR IS the target's — defined once, reused (SPEC-5 §5)
  if (isBytesView(v)) {
    return map([
      ["mime", tstr(v.mime)],
      ["value", bstr(v.value)],
    ]);
  }
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

function applyMerge(fn: MergeFn, entries: readonly HVEntry[], root: string): Resolved {
  // Fold in ascending delta-id order — float addition is order-dependent (R2).
  const sorted = sortEntries({ kind: "lexById" }, entries);
  if (fn === "count") return sorted.length === 0 ? ABSENT : sorted.length;
  const prims = sorted
    .map((e) => candidateValue(e, root))
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

function applyPolicy(policy: Policy, entries: readonly HVEntry[], root: string): Resolved {
  switch (policy.kind) {
    case "pick": {
      if (entries.length === 0) return ABSENT;
      const sorted = sortEntries(policy.order, entries);
      return candidateValue(sorted[0]!, root);
    }
    case "all": {
      if (entries.length === 0) return ABSENT;
      return sortEntries(policy.order, entries).map((e) => candidateValue(e, root));
    }
    case "merge":
      return applyMerge(policy.fn, entries, root);
    case "conflicts": {
      const sorted = sortEntries(policy.order, entries);
      const seen = new Set<string>();
      const distinct: View[] = [];
      for (const e of sorted) {
        const v = candidateValue(e, root);
        const key = viewCanonicalHex(v);
        if (!seen.has(key)) {
          seen.add(key);
          distinct.push(v);
        }
      }
      return distinct.length >= 2 ? distinct : ABSENT;
    }
    case "absentAs": {
      const inner = applyPolicy(policy.then, entries, root);
      return inner === ABSENT ? policy.constant : inner;
    }
  }
}

// resolve(schema, HView) -> View. Deterministic; total; provenance-optional (SPEC-5 §2).
// The View covers every property named in the schema plus every HView property (R3).
export function resolveView(schema: Schema, hview: HView): View {
  const keys = new Set<string>([...schema.props.keys(), ...hview.props.keys()]);
  const obj: Record<string, View> = {};
  for (const key of keys) {
    const entries = hview.props.get(key) ?? [];
    const policy = schema.props.get(key) ?? schema.default;
    const v = applyPolicy(policy, entries, hview.id);
    if (v !== ABSENT) obj[key] = v;
  }
  return obj;
}
