// The predicate grammar and its evaluator (SPEC-2 §3). Predicates are total, terminating,
// single-delta: they see one delta at a time, never the rest of the set.

import type { Delta, Pointer, Primitive } from "./types.js";

export type Cmp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "prefix" | "inSet";

export type StrMatch =
  | { readonly kind: "exact"; readonly value: string }
  | { readonly kind: "prefix"; readonly value: string }
  | { readonly kind: "inSet"; readonly values: readonly string[] };

export type ValMatch =
  | { readonly kind: "vcmp"; readonly cmp: Cmp; readonly value: Primitive }
  | { readonly kind: "between"; readonly lo: Primitive; readonly hi: Primitive }
  | { readonly kind: "inSet"; readonly values: readonly Primitive[] };

export interface PPred {
  readonly role?: StrMatch;
  readonly targetEntity?: string;
  readonly targetDelta?: string;
  readonly context?: StrMatch;
  readonly targetIsPrimitive?: boolean;
  readonly targetValue?: ValMatch;
}

export type Pred =
  | { readonly kind: "true" }
  | { readonly kind: "false" }
  | {
      readonly kind: "match";
      readonly field: "author" | "timestamp" | "id";
      readonly cmp: Cmp;
      readonly constant: Primitive | readonly Primitive[];
    }
  | { readonly kind: "hasPointer"; readonly ppred: PPred }
  | { readonly kind: "and"; readonly left: Pred; readonly right: Pred }
  | { readonly kind: "or"; readonly left: Pred; readonly right: Pred }
  | { readonly kind: "not"; readonly pred: Pred };

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

function strMatch(m: StrMatch, s: string): boolean {
  switch (m.kind) {
    case "exact":
      return s === m.value;
    case "prefix":
      return s.startsWith(m.value);
    case "inSet":
      return m.values.includes(s);
  }
}

function valMatch(m: ValMatch, v: Primitive): boolean {
  switch (m.kind) {
    case "vcmp":
      // cmp "inSet" is rejected at parse time (E1) — ValMatch has its own inSet arm.
      return compareWith(m.cmp, v, m.value);
    case "between":
      return comparePrimitives(v, m.lo) >= 0 && comparePrimitives(v, m.hi) <= 0;
    case "inSet":
      return m.values.some((x) => comparePrimitives(v, x) === 0);
  }
}

function pointerMatches(p: PPred, ptr: Pointer): boolean {
  if (p.role !== undefined && !strMatch(p.role, ptr.role)) return false;
  if (p.targetEntity !== undefined) {
    if (ptr.target.kind !== "entity" || ptr.target.entity.id !== p.targetEntity) return false;
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
    if (ptr.target.kind !== "primitive" || !valMatch(p.targetValue, ptr.target.value)) return false;
  }
  return true;
}

// Total and terminating: O(|delta|) per evaluation, no data dereference (SPEC-2 §3).
export function evalPred(pred: Pred, delta: Delta): boolean {
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
      return compareWith(pred.cmp, subject, pred.constant);
    }
    case "hasPointer":
      return delta.claims.pointers.some((ptr) => pointerMatches(pred.ppred, ptr));
    case "and":
      return evalPred(pred.left, delta) && evalPred(pred.right, delta);
    case "or":
      return evalPred(pred.left, delta) || evalPred(pred.right, delta);
    case "not":
      return !evalPred(pred.pred, delta);
  }
}
