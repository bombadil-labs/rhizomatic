// Term serialization back to the JSON profile, the generic JSON<->CBOR bridge, and term hashing
// (ERRATA-2 E12). parse(termToJson(t)) is identity on the AST, so semantically identical terms
// hash identically regardless of authored spelling.

import { b64uEncode } from "./b64u.js";
import { type CborValue, array, bool, encode, float, map, tstr } from "./cbor.js";
import type { Term } from "./eval.js";
import { bytesToHex, contentAddress } from "./hash.js";
import type { Order, Schema, Policy } from "./resolution.js";
import type { Hole, Pred, PPred, StrMatch, ValMatch } from "./pred.js";
import type { Primitive } from "./types.js";

// --- AST -> JSON profile ---------------------------------------------------------------------------

// Holes serialize to their profile spelling (E15); primitives pass through.
function paramToJson(v: Primitive | Hole): unknown {
  return typeof v === "object" ? { hole: v.name } : v;
}

function strMatchToJson(m: StrMatch): unknown {
  switch (m.kind) {
    case "exact":
      return { exact: m.value };
    case "prefix":
      return { prefix: m.value };
    case "inSet":
      return { inSet: [...m.values] };
    case "aliased": {
      // Optional fields omitted when absent (SPEC-2 §7); the closure never enters the hash.
      const a: Record<string, unknown> = { name: m.name };
      if (m.via !== undefined) a["via"] = m.via;
      if (m.trust !== undefined) a["trust"] = predToJson(m.trust);
      return { aliased: a };
    }
  }
}

function valMatchToJson(m: ValMatch): unknown {
  switch (m.kind) {
    case "vcmp":
      return { vcmp: { cmp: m.cmp, value: paramToJson(m.value) } };
    case "between":
      return { between: [m.lo, m.hi] };
    case "inSet":
      return { inSet: [...m.values] };
  }
}

function ppredToJson(p: PPred): unknown {
  const out: Record<string, unknown> = {};
  if (p.role !== undefined) out["role"] = strMatchToJson(p.role);
  if (p.targetEntity !== undefined) {
    out["targetEntity"] =
      p.targetEntity.kind === "const"
        ? p.targetEntity.id
        : p.targetEntity.kind === "hole"
          ? { hole: p.targetEntity.name }
          : { var: "root" };
  }
  if (p.targetDelta !== undefined) out["targetDelta"] = p.targetDelta;
  if (p.context !== undefined) out["context"] = strMatchToJson(p.context);
  if (p.targetIsPrimitive !== undefined) out["targetIsPrimitive"] = p.targetIsPrimitive;
  if (p.targetValue !== undefined) out["targetValue"] = valMatchToJson(p.targetValue);
  return out;
}

export function predToJson(pred: Pred): unknown {
  switch (pred.kind) {
    case "true":
      return "true";
    case "false":
      return "false";
    case "match":
      return {
        match: {
          field: pred.field,
          cmp: pred.cmp,
          const: Array.isArray(pred.constant)
            ? [...pred.constant]
            : paramToJson(pred.constant as Primitive | Hole),
        },
      };
    case "hasPointer":
      return { hasPointer: ppredToJson(pred.ppred) };
    case "and":
      return { and: [predToJson(pred.left), predToJson(pred.right)] };
    case "or":
      return { or: [predToJson(pred.left), predToJson(pred.right)] };
    case "not":
      return { not: predToJson(pred.pred) };
    case "inView":
      return {
        inView: {
          term: termToJson(pred.term),
          field: pred.field,
          extract:
            pred.extract.kind === "field"
              ? { field: pred.extract.field }
              : { role: pred.extract.role },
        },
      };
  }
}

function orderToJson(o: Order): unknown {
  switch (o.kind) {
    case "byTimestamp":
      return { byTimestamp: o.dir };
    case "byAuthorRank":
      return { byAuthorRank: [...o.authors] };
    case "byPred":
      return { byPred: { pred: predToJson(o.pred), then: orderToJson(o.then) } };
    case "chain":
      return { chain: o.orders.map(orderToJson) };
    case "lexById":
      return "lexById";
  }
}

function policyToJson(pp: Policy): unknown {
  switch (pp.kind) {
    case "pick":
      return { pick: { order: orderToJson(pp.order) } };
    case "all":
      return { all: { order: orderToJson(pp.order) } };
    case "merge":
      return { merge: pp.fn };
    case "conflicts":
      return { conflicts: { order: orderToJson(pp.order) } };
    case "absentAs":
      return { absentAs: { const: pp.constant, then: policyToJson(pp.then) } };
  }
}

export function schemaToJson(p: Schema): unknown {
  const props: Record<string, unknown> = {};
  for (const [k, v] of p.props) props[k] = policyToJson(v);
  const out: Record<string, unknown> = { props, default: policyToJson(p.default) };
  // name/alg emitted only when present (SPEC-3 ERRATA S6); canonical CBOR sorts keys (D4).
  if (p.name !== undefined) out.name = p.name;
  if (p.alg !== undefined) out.alg = p.alg;
  return out;
}

export function termToJson(term: Term): unknown {
  switch (term.kind) {
    case "input":
      return "input";
    case "select":
      return { op: "select", pred: predToJson(term.pred), in: termToJson(term.of) };
    case "union":
      return { op: "union", left: termToJson(term.left), right: termToJson(term.right) };
    case "mask": {
      const policy =
        term.policy.kind === "trust" ? { trust: predToJson(term.policy.pred) } : term.policy.kind;
      return { op: "mask", policy, in: termToJson(term.of) };
    }
    case "group": {
      const key = term.key.kind === "const" ? { const: term.key.prop } : term.key.kind;
      return { op: "group", key, in: termToJson(term.of) };
    }
    case "prune":
      return {
        op: "prune",
        keep: term.keep === "all" ? "all" : strMatchToJson(term.keep),
        in: termToJson(term.of),
      };
    case "expand":
      return {
        op: "expand",
        role: strMatchToJson(term.role),
        schema: schemaRefToJson(term.schema),
        in: termToJson(term.of),
      };
    case "fix": {
      const out: Record<string, unknown> = {
        op: "fix",
        schema: schemaRefToJson(term.schema),
        entity: term.entity,
      };
      if (term.bindings !== undefined && term.bindings.size > 0) {
        const bindings: Record<string, Primitive> = {};
        for (const key of [...term.bindings.keys()].sort()) {
          bindings[key] = term.bindings.get(key)!;
        }
        out["bindings"] = bindings;
      }
      return out;
    }
    case "resolve":
      return { op: "resolve", schema: schemaToJson(term.schema), in: termToJson(term.of) };
  }
}

function schemaRefToJson(ref: import("./eval.js").SchemaRefT): unknown {
  return ref.kind === "name" ? ref.name : { pinned: ref.hash };
}

// --- generic JSON <-> CBOR bridge ------------------------------------------------------------------

export function jsonToCbor(v: unknown): CborValue {
  if (typeof v === "string") return tstr(v);
  if (typeof v === "number") return float(v);
  if (typeof v === "boolean") return bool(v);
  if (Array.isArray(v)) return array(v.map(jsonToCbor));
  if (typeof v === "object" && v !== null) {
    return map(
      Object.entries(v as Record<string, unknown>).map(([k, x]): readonly [string, CborValue] => [
        k,
        jsonToCbor(x),
      ]),
    );
  }
  throw new Error("json value outside the CBOR profile (null/undefined are not representable)");
}

export function cborToJson(v: CborValue): unknown {
  switch (v.t) {
    case "tstr":
    case "float":
    case "bool":
      return v.v;
    // a bstr renders as its canonical base64url string (the bytes JSON profile, SPEC-1 §4.2);
    // terms never carry bstr, but a bytes View leaf serialized through here does.
    case "bstr":
      return b64uEncode(v.v);
    case "array":
      return v.v.map(cborToJson);
    case "map": {
      const out: Record<string, unknown> = {};
      for (const [k, x] of v.v) out[k] = cborToJson(x);
      return out;
    }
  }
}

// --- term hashing (E12) ----------------------------------------------------------------------------

export function termCanonicalBytes(term: Term): Uint8Array {
  return encode(jsonToCbor(termToJson(term)));
}

export function termCanonicalHex(term: Term): string {
  return bytesToHex(termCanonicalBytes(term));
}

// A term's content address: same multihash as deltas (E12).
export function termHash(term: Term): string {
  return contentAddress(termCanonicalBytes(term));
}
