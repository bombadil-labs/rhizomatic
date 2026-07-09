// The predicate grammar and its evaluator (SPEC-2 §3). Predicates are total, terminating,
// single-delta: they see one delta at a time, never the rest of the set — the one stratified
// exception, inView (SPEC-2 §3.1), is lowered to inSet before predicates meet data.

import type { Term } from "./eval.js";
import type { Delta, Pointer, Primitive } from "./types.js";

export type Cmp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "prefix" | "inSet";

// A parameter slot in Const position, bound through fix's bindings (SPEC-2 §6, ERRATA-2 E15).
export interface Hole {
  readonly kind: "hole";
  readonly name: string;
}

export type Bindings = ReadonlyMap<string, Primitive>;

// Resolve a possibly-parameterized primitive. Unbound holes fail loudly (E15).
export function resolveParam(p: Primitive | Hole, bindings: Bindings | undefined): Primitive {
  if (typeof p !== "object") return p;
  const bound = bindings?.get(p.name);
  if (bound === undefined) throw new Error(`unbound hole "${p.name}" (E15)`);
  return bound;
}

export type StrMatch =
  | { readonly kind: "exact"; readonly value: string }
  | { readonly kind: "prefix"; readonly value: string }
  | { readonly kind: "inSet"; readonly values: readonly string[] }
  // The aliased closure (SPEC-9 §4): expanded to inSet against the ambient input before matching.
  | {
      readonly kind: "aliased";
      readonly name: string;
      readonly via?: string;
      readonly trust?: Pred;
    };

export type ValMatch =
  | { readonly kind: "vcmp"; readonly cmp: Cmp; readonly value: Primitive | Hole }
  | { readonly kind: "between"; readonly lo: Primitive; readonly hi: Primitive }
  | { readonly kind: "inSet"; readonly values: readonly Primitive[] };

// An entity to match: a literal id, the ambient root variable (ERRATA-2 E10), or a hole (E15).
export type EntityMatch =
  | { readonly kind: "const"; readonly id: string }
  | { readonly kind: "root" }
  | Hole;

export interface PPred {
  readonly role?: StrMatch;
  readonly targetEntity?: EntityMatch;
  readonly targetDelta?: string;
  readonly context?: StrMatch;
  readonly targetIsPrimitive?: boolean;
  readonly targetValue?: ValMatch;
}

// The facet of a delta an inView extracts from its sub-view, forming the accepted set.
export type InViewExtract =
  | { readonly kind: "field"; readonly field: "author" | "id" }
  | { readonly kind: "role"; readonly role: string };

export type Pred =
  | { readonly kind: "true" }
  | { readonly kind: "false" }
  | {
      readonly kind: "match";
      readonly field: "author" | "timestamp" | "id";
      readonly cmp: Cmp;
      readonly constant: Primitive | Hole | readonly Primitive[];
    }
  | { readonly kind: "hasPointer"; readonly ppred: PPred }
  | { readonly kind: "and"; readonly left: Pred; readonly right: Pred }
  | { readonly kind: "or"; readonly left: Pred; readonly right: Pred }
  | { readonly kind: "not"; readonly pred: Pred }
  // Reflective (SPEC-2 §3.1): candidate's field ∈ extract(sub-view over the ambient input).
  // Stratified depth-1; DSet-sort sub-term only; both enforced at parse time.
  | {
      readonly kind: "inView";
      readonly term: Term;
      readonly field: "author" | "id";
      readonly extract: InViewExtract;
    };

// Does the predicate contain a reflective node anywhere? (SPEC-2 §3.1 stratification and the
// reactor's conservative-dispatch rule both hang off this walk.)
export function predContainsInView(pred: Pred): boolean {
  switch (pred.kind) {
    case "inView":
      return true;
    case "and":
    case "or":
      return predContainsInView(pred.left) || predContainsInView(pred.right);
    case "not":
      return predContainsInView(pred.pred);
    default:
      return false;
  }
}

// --- the canonical total order over primitives (ERRATA-2 E3) ------------------------------------

const utf8 = new TextEncoder();

function utf8Compare(a: string, b: string): number {
  const ab = utf8.encode(a);
  const bb = utf8.encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = ab[i]! - bb[i]!;
    if (d !== 0) return d;
  }
  return ab.length - bb.length;
}

function typeRank(v: Primitive): number {
  if (typeof v === "boolean") return 0;
  if (typeof v === "number") return 1;
  return 2;
}

// Type rank first (bool < number < string), then value; strings by NFC UTF-8 bytes.
export function comparePrimitives(a: Primitive, b: Primitive): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "boolean") return (a ? 1 : 0) - ((b as boolean) ? 1 : 0);
  if (typeof a === "number") {
    const bn = b as number;
    return a < bn ? -1 : a > bn ? 1 : 0;
  }
  return utf8Compare(a, b as string);
}

function compareWith(
  cmp: Cmp,
  subject: Primitive,
  constant: Primitive | readonly Primitive[],
): boolean {
  if (cmp === "inSet") {
    const values = constant as readonly Primitive[];
    return values.some((v) => comparePrimitives(subject, v) === 0);
  }
  if (cmp === "prefix") {
    return (
      typeof subject === "string" && typeof constant === "string" && subject.startsWith(constant)
    );
  }
  const c = comparePrimitives(subject, constant as Primitive);
  switch (cmp) {
    case "eq":
      return c === 0;
    case "neq":
      return c !== 0;
    case "lt":
      return c < 0;
    case "lte":
      return c <= 0;
    case "gt":
      return c > 0;
    case "gte":
      return c >= 0;
  }
}

// --- evaluation ----------------------------------------------------------------------------------

export function strMatch(m: StrMatch, s: string): boolean {
  switch (m.kind) {
    case "exact":
      return s === m.value;
    case "prefix":
      return s.startsWith(m.value);
    case "inSet":
      return m.values.includes(s);
    case "aliased":
      // Every consumer expands aliased against the ambient input first (SPEC-9 §4.1).
      throw new Error(`aliased("${m.name}") must be expanded before matching (SPEC-9)`);
  }
}

function valMatch(m: ValMatch, v: Primitive, bindings: Bindings | undefined): boolean {
  switch (m.kind) {
    case "vcmp":
      // cmp "inSet" is rejected at parse time (E1) — ValMatch has its own inSet arm.
      return compareWith(m.cmp, v, resolveParam(m.value, bindings));
    case "between":
      return comparePrimitives(v, m.lo) >= 0 && comparePrimitives(v, m.hi) <= 0;
    case "inSet":
      return m.values.some((x) => comparePrimitives(v, x) === 0);
  }
}

function entityWant(
  m: EntityMatch,
  root: string | undefined,
  bindings: Bindings | undefined,
): string | undefined {
  if (m.kind === "const") return m.id;
  // The root variable matches nothing without an ambient root (E10).
  if (m.kind === "root") return root;
  const bound = resolveParam(m, bindings);
  if (typeof bound !== "string") {
    throw new Error(`hole "${m.name}" bound to a non-string where an entity id is required (E15)`);
  }
  return bound;
}

function pointerMatches(
  p: PPred,
  ptr: Pointer,
  root: string | undefined,
  bindings: Bindings | undefined,
): boolean {
  if (p.role !== undefined && !strMatch(p.role, ptr.role)) return false;
  if (p.targetEntity !== undefined) {
    if (ptr.target.kind !== "entity") return false;
    const want = entityWant(p.targetEntity, root, bindings);
    if (want === undefined || ptr.target.entity.id !== want) return false;
  }
  if (p.targetDelta !== undefined) {
    if (ptr.target.kind !== "delta" || ptr.target.deltaRef.delta !== p.targetDelta) return false;
  }
  if (p.context !== undefined) {
    const ctx =
      ptr.target.kind === "entity"
        ? ptr.target.entity.context
        : ptr.target.kind === "delta"
          ? ptr.target.deltaRef.context
          : undefined;
    if (ctx === undefined || !strMatch(p.context, ctx)) return false;
  }
  if (p.targetIsPrimitive !== undefined) {
    if ((ptr.target.kind === "primitive") !== p.targetIsPrimitive) return false;
  }
  if (p.targetValue !== undefined) {
    if (ptr.target.kind !== "primitive" || !valMatch(p.targetValue, ptr.target.value, bindings)) {
      return false;
    }
  }
  return true;
}

// Eagerly resolve every hole in a predicate against the ambient bindings (E15). Applied where
// a predicate meets data (select / mask-trust), so an unbound hole errors deterministically —
// regardless of how many deltas the operand happens to hold.
export function substituteHoles(pred: Pred, bindings: Bindings | undefined): Pred {
  switch (pred.kind) {
    case "true":
    case "false":
      return pred;
    case "match": {
      const c = pred.constant;
      if (typeof c === "object" && !Array.isArray(c)) {
        return { ...pred, constant: resolveParam(c as Hole, bindings) };
      }
      return pred;
    }
    case "hasPointer": {
      const p = pred.ppred;
      let te = p.targetEntity;
      if (te !== undefined && te.kind === "hole") {
        const bound = resolveParam(te, bindings);
        if (typeof bound !== "string") {
          throw new Error(
            `hole "${te.name}" bound to a non-string where an entity id is required (E15)`,
          );
        }
        te = { kind: "const", id: bound };
      }
      let tv = p.targetValue;
      if (tv !== undefined && tv.kind === "vcmp" && typeof tv.value === "object") {
        tv = { ...tv, value: resolveParam(tv.value, bindings) };
      }
      if (te === p.targetEntity && tv === p.targetValue) return pred;
      return {
        kind: "hasPointer",
        ppred: {
          ...p,
          ...(te === undefined ? {} : { targetEntity: te }),
          ...(tv === undefined ? {} : { targetValue: tv }),
        },
      };
    }
    case "and":
      return {
        kind: "and",
        left: substituteHoles(pred.left, bindings),
        right: substituteHoles(pred.right, bindings),
      };
    case "or":
      return {
        kind: "or",
        left: substituteHoles(pred.left, bindings),
        right: substituteHoles(pred.right, bindings),
      };
    case "not":
      return { kind: "not", pred: substituteHoles(pred.pred, bindings) };
    case "inView":
      // Holes inside the sub-term resolve from the same ambient bindings when it is evaluated.
      return pred;
  }
}

// Total and terminating: O(|delta|) per evaluation, no data dereference (SPEC-2 §3).
// `root` is the ambient root entity, consulted only by the root variable (E10). Holes are
// substituted away before predicates meet data; a stray hole here means "unbound" (E15).
export function evalPred(pred: Pred, delta: Delta, root?: string, bindings?: Bindings): boolean {
  switch (pred.kind) {
    case "true":
      return true;
    case "false":
      return false;
    case "match": {
      const subject: Primitive =
        pred.field === "author"
          ? delta.claims.author
          : pred.field === "timestamp"
            ? delta.claims.timestamp
            : delta.id;
      const c = pred.constant;
      const constant: Primitive | readonly Primitive[] =
        typeof c === "object" && !Array.isArray(c)
          ? resolveParam(c as Hole, bindings)
          : (c as Primitive | readonly Primitive[]);
      return compareWith(pred.cmp, subject, constant);
    }
    case "hasPointer":
      return delta.claims.pointers.some((ptr) => pointerMatches(pred.ppred, ptr, root, bindings));
    case "and":
      return (
        evalPred(pred.left, delta, root, bindings) && evalPred(pred.right, delta, root, bindings)
      );
    case "or":
      return (
        evalPred(pred.left, delta, root, bindings) || evalPred(pred.right, delta, root, bindings)
      );
    case "not":
      return !evalPred(pred.pred, delta, root, bindings);
    case "inView":
      // Every consumer lowers inView against the ambient input first (SPEC-2 §3.1).
      throw new Error("inView must be resolved before matching (SPEC-2 §3.1)");
  }
}
