// Parse the JSON term profile (ERRATA-2 E1) into Term/Pred. Strings are NFC-normalized at parse
// time so term-side comparisons are NFC-vs-NFC (data strings are NFC by validation, D11).

import {
  termContainsInView,
  type GroupKey,
  type MaskPolicy,
  type SchemaRefT,
  type Term,
} from "./eval.js";
import type { MergeFn, Order, Schema, Policy } from "./resolution.js";
import {
  predContainsInView,
  type Cmp,
  type EntityMatch,
  type Hole,
  type InViewExtract,
  type PPred,
  type Pred,
  type StrMatch,
  type ValMatch,
} from "./pred.js";
import { asDispatched, asObject, asOpenMap, oneTag } from "./strict.js";
import type { Primitive } from "./types.js";

const CMPS: readonly Cmp[] = ["eq", "neq", "lt", "lte", "gt", "gte", "prefix", "inSet"];

// The closed key sets of the §9 profile (issue #25). Every object node in the grammar names its
// keys here or at its call site; the only open nodes are `fix.bindings` and `schema.props`, whose
// keys are author-chosen data rather than grammar.
const TERM_KEYS: Readonly<Record<string, readonly string[]>> = {
  select: ["op", "pred", "in"],
  union: ["op", "left", "right"],
  intersect: ["op", "left", "right"],
  difference: ["op", "of", "without"],
  mask: ["op", "policy", "in"],
  group: ["op", "key", "in"],
  prune: ["op", "keep", "in"],
  expand: ["op", "role", "schema", "reading", "in"],
  fix: ["op", "schema", "entity", "bindings"],
  resolve: ["op", "schema", "in"],
};

const STR_MATCH_TAGS = ["exact", "prefix", "inSet", "aliased"] as const;
const VAL_MATCH_TAGS = ["vcmp", "between", "inSet"] as const;
const PRED_TAGS = ["match", "hasPointer", "and", "or", "not", "inView"] as const;
const ORDER_TAGS = ["byTimestamp", "byAuthorRank", "byPred", "chain"] as const;
const POLICY_TAGS = ["pick", "all", "merge", "conflicts", "absentAs"] as const;
const EXTRACT_TAGS = ["field", "role"] as const;

function nfc(s: string): string {
  return s.normalize("NFC");
}

function parsePrimitive(v: unknown, what: string): Primitive {
  if (typeof v === "string") return nfc(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${what}: numeric constant must be finite`);
    return v;
  }
  throw new Error(`${what}: constant must be string | number | boolean`);
}

// A hole in Const position: {"hole": "name"} (E15). Speculative — a non-hole returns undefined so
// the caller can try a primitive — but once the `hole` key is present the node IS a hole, and its
// keys are checked like any other closed node (issue #25).
function parseHole(v: unknown): Hole | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  if (!("hole" in (v as Record<string, unknown>))) return undefined;
  const o = asObject(v, "hole", ["hole"]);
  if (typeof o["hole"] !== "string") throw new Error("hole name must be a string");
  return { kind: "hole", name: nfc(o["hole"]) };
}

function parseParam(v: unknown, what: string): Primitive | Hole {
  return parseHole(v) ?? parsePrimitive(v, what);
}

function parseCmp(v: unknown, what: string): Cmp {
  if (typeof v !== "string" || !CMPS.includes(v as Cmp)) {
    throw new Error(`${what}: unknown cmp ${String(v)}`);
  }
  return v as Cmp;
}

function parseStrMatch(raw: unknown, what: string): StrMatch {
  const { o, tag } = oneTag(raw, STR_MATCH_TAGS, what);
  if (tag === "exact") {
    if (typeof o["exact"] !== "string") throw new Error(`${what}: exact must be a string`);
    return { kind: "exact", value: nfc(o["exact"]) };
  }
  if (tag === "prefix") {
    if (typeof o["prefix"] !== "string") throw new Error(`${what}: prefix must be a string`);
    return { kind: "prefix", value: nfc(o["prefix"]) };
  }
  if (tag === "inSet") {
    if (!Array.isArray(o["inSet"])) throw new Error(`${what}: inSet must be an array`);
    return {
      kind: "inSet",
      values: o["inSet"].map((s) => {
        if (typeof s !== "string") throw new Error(`${what}: inSet members must be strings`);
        return nfc(s);
      }),
    };
  }
  {
    const a = asObject(o["aliased"], `${what}.aliased`, ["name", "via", "trust"]);
    if (typeof a["name"] !== "string") throw new Error(`${what}: aliased.name must be a string`);
    const out: { name: string; via?: string; trust?: Pred } = { name: nfc(a["name"]) };
    if (a["via"] !== undefined) {
      if (typeof a["via"] !== "string")
        throw new Error(`${what}: aliased.via must be an entity id`);
      out.via = nfc(a["via"]);
    }
    if (a["trust"] !== undefined) {
      const trust = parsePred(a["trust"]);
      assertClosedTrustPred(trust, `${what}.aliased.trust`);
      out.trust = trust;
    }
    return { kind: "aliased", ...out };
  }
}

// An aliased trust predicate admits no holes and no nested aliased (SPEC-9 §4.1): it is
// evaluated against alias-vocabulary deltas during closure computation, outside the hole
// environment and outside any further expansion.
function assertClosedTrustPred(p: Pred, what: string): void {
  switch (p.kind) {
    case "true":
    case "false":
      return;
    case "match":
      if (typeof p.constant === "object" && !Array.isArray(p.constant)) {
        throw new Error(`${what}: holes are not allowed inside an aliased trust predicate`);
      }
      return;
    case "hasPointer": {
      const pp = p.ppred;
      if (
        pp.targetEntity?.kind === "hole" ||
        (pp.targetValue?.kind === "vcmp" && typeof pp.targetValue.value === "object")
      ) {
        throw new Error(`${what}: holes are not allowed inside an aliased trust predicate`);
      }
      if (pp.role?.kind === "aliased" || pp.context?.kind === "aliased") {
        throw new Error(`${what}: nested aliased is not allowed inside an aliased trust predicate`);
      }
      return;
    }
    case "and":
    case "or":
      assertClosedTrustPred(p.left, what);
      assertClosedTrustPred(p.right, what);
      return;
    case "not":
      assertClosedTrustPred(p.pred, what);
      return;
    case "inView":
      throw new Error(`${what}: inView is not allowed inside an aliased trust predicate`);
  }
}

function parseValMatch(raw: unknown, what: string): ValMatch {
  const { o, tag } = oneTag(raw, VAL_MATCH_TAGS, what);
  if (tag === "vcmp") {
    const v = asObject(o["vcmp"], `${what}.vcmp`, ["cmp", "value"]);
    const cmp = parseCmp(v["cmp"], `${what}.vcmp`);
    if (cmp === "inSet")
      throw new Error(`${what}: vcmp cmp inSet is not allowed; use the inSet arm`);
    const value = parseParam(v["value"], `${what}.vcmp`);
    if (cmp === "prefix" && typeof value !== "string" && typeof value !== "object") {
      throw new Error(`${what}: prefix requires a string constant`);
    }
    return { kind: "vcmp", cmp, value };
  }
  if (tag === "between") {
    if (!Array.isArray(o["between"]) || o["between"].length !== 2) {
      throw new Error(`${what}: between takes [lo, hi]`);
    }
    return {
      kind: "between",
      lo: parsePrimitive(o["between"][0], `${what}.between`),
      hi: parsePrimitive(o["between"][1], `${what}.between`),
    };
  }
  if (!Array.isArray(o["inSet"])) throw new Error(`${what}: inSet must be an array`);
  return { kind: "inSet", values: o["inSet"].map((v) => parsePrimitive(v, `${what}.inSet`)) };
}

function parsePPred(raw: unknown): PPred {
  const o = asObject(raw, "hasPointer", [
    "role",
    "targetEntity",
    "targetDelta",
    "context",
    "targetIsPrimitive",
    "targetValue",
  ]);
  const out: {
    role?: StrMatch;
    targetEntity?: EntityMatch;
    targetDelta?: string;
    context?: StrMatch;
    targetIsPrimitive?: boolean;
    targetValue?: ValMatch;
  } = {};
  if (o["role"] !== undefined) out.role = parseStrMatch(o["role"], "hasPointer.role");
  if (o["targetEntity"] !== undefined) {
    const te = o["targetEntity"];
    if (typeof te === "string") {
      out.targetEntity = { kind: "const", id: nfc(te) };
    } else {
      const hole = parseHole(te);
      if (hole !== undefined) {
        out.targetEntity = hole;
      } else {
        const v = asObject(te, "targetEntity", ["var"]);
        if (v["var"] !== "root") {
          throw new Error('targetEntity must be a string, {var: "root"}, or {hole: "name"}');
        }
        out.targetEntity = { kind: "root" };
      }
    }
  }
  if (o["targetDelta"] !== undefined) {
    if (typeof o["targetDelta"] !== "string") throw new Error("targetDelta must be a string");
    out.targetDelta = o["targetDelta"];
  }
  if (o["context"] !== undefined) out.context = parseStrMatch(o["context"], "hasPointer.context");
  if (o["targetIsPrimitive"] !== undefined) {
    if (typeof o["targetIsPrimitive"] !== "boolean") {
      throw new Error("targetIsPrimitive must be a boolean");
    }
    out.targetIsPrimitive = o["targetIsPrimitive"];
  }
  if (o["targetValue"] !== undefined) {
    out.targetValue = parseValMatch(o["targetValue"], "hasPointer.targetValue");
  }
  if (Object.keys(out).length === 0) throw new Error("hasPointer requires at least one field (E1)");
  return out;
}

export function parsePred(raw: unknown): Pred {
  if (raw === "true") return { kind: "true" };
  if (raw === "false") return { kind: "false" };
  const { o, tag } = oneTag(raw, PRED_TAGS, "pred");
  if (tag === "match") {
    const m = asObject(o["match"], "match", ["field", "cmp", "const"]);
    const field = m["field"];
    if (field !== "author" && field !== "timestamp" && field !== "id") {
      throw new Error(`match: unknown field ${String(field)}`);
    }
    const cmp = parseCmp(m["cmp"], "match");
    const rawConst = m["const"];
    const constant =
      cmp === "inSet"
        ? (() => {
            if (!Array.isArray(rawConst)) throw new Error("match: inSet requires an array const");
            return rawConst.map((v) => parsePrimitive(v, "match.const"));
          })()
        : parseParam(rawConst, "match.const");
    if (cmp === "prefix" && typeof constant !== "string" && typeof constant !== "object") {
      throw new Error("match: prefix requires a string const");
    }
    return { kind: "match", field, cmp, constant };
  }
  if (tag === "hasPointer") return { kind: "hasPointer", ppred: parsePPred(o["hasPointer"]) };
  if (tag === "and" || tag === "or") {
    const arr = o[tag];
    if (!Array.isArray(arr) || arr.length !== 2)
      throw new Error(`${tag} takes exactly [Pred, Pred] (E1)`);
    const left = parsePred(arr[0]);
    const right = parsePred(arr[1]);
    return tag === "and" ? { kind: "and", left, right } : { kind: "or", left, right };
  }
  if (tag === "not") return { kind: "not", pred: parsePred(o["not"]) };
  {
    const v = asObject(o["inView"], "inView", ["term", "field", "extract"]);
    const term = parseTerm(v["term"]);
    if (
      term.kind !== "input" &&
      term.kind !== "select" &&
      term.kind !== "union" &&
      term.kind !== "mask"
    ) {
      throw new Error("inView.term must be a DSet-sort term (input | select | union | mask)");
    }
    if (termContainsInView(term)) {
      throw new Error("inView is stratified: no inView inside inView.term (SPEC-2 §3.1)");
    }
    const field = v["field"];
    if (field !== "author" && field !== "id") throw new Error("inView.field must be author | id");
    return { kind: "inView", term, field, extract: parseExtract(v["extract"]) };
  }
}

function parseExtract(raw: unknown): InViewExtract {
  const { o, tag } = oneTag(raw, EXTRACT_TAGS, "inView.extract");
  if (tag === "field") {
    if (o["field"] !== "author" && o["field"] !== "id") {
      throw new Error("inView.extract.field must be author | id");
    }
    return { kind: "field", field: o["field"] };
  }
  if (typeof o["role"] !== "string") throw new Error("inView.extract.role must be a string");
  return { kind: "role", role: nfc(o["role"]) };
}

function parseMaskPolicy(raw: unknown): MaskPolicy {
  if (raw === "drop") return { kind: "drop" };
  if (raw === "annotate") return { kind: "annotate" };
  const { o } = oneTag(raw, ["trust"], "mask.policy");
  return { kind: "trust", pred: parsePred(o["trust"]) };
}

const MERGE_FNS: readonly MergeFn[] = ["max", "min", "sum", "count", "and", "or", "concatSorted"];

function parseOrder(raw: unknown): Order {
  if (raw === "lexById") return { kind: "lexById" };
  const { o, tag } = oneTag(raw, ORDER_TAGS, "order");
  if (tag === "byTimestamp") {
    if (o["byTimestamp"] !== "desc" && o["byTimestamp"] !== "asc") {
      throw new Error("byTimestamp must be desc | asc");
    }
    return { kind: "byTimestamp", dir: o["byTimestamp"] };
  }
  if (tag === "byAuthorRank") {
    if (!Array.isArray(o["byAuthorRank"])) throw new Error("byAuthorRank must be an array");
    return {
      kind: "byAuthorRank",
      authors: o["byAuthorRank"].map((a) => {
        if (typeof a !== "string") throw new Error("byAuthorRank entries must be strings");
        return nfc(a);
      }),
    };
  }
  if (tag === "byPred") {
    const p = asObject(o["byPred"], "byPred", ["pred", "then"]);
    const pred = parsePred(p["pred"]);
    // Schema predicates are closed: they run inside resolve, after the mask already decided
    // standing — a reflective order would be a second, unlowered trust surface (SPEC-2 §3.1).
    if (predContainsInView(pred)) {
      throw new Error("inView is not allowed inside a policy byPred predicate (SPEC-2 §3.1)");
    }
    return { kind: "byPred", pred, then: parseOrder(p["then"]) };
  }
  if (!Array.isArray(o["chain"])) throw new Error("chain must be an array");
  if (o["chain"].length === 0) throw new Error("chain must name at least one order");
  return { kind: "chain", orders: o["chain"].map(parseOrder) };
}

function parsePolicy(raw: unknown): Policy {
  const { o, tag } = oneTag(raw, POLICY_TAGS, "propPolicy");
  if (tag === "pick") {
    return { kind: "pick", order: parseOrder(asObject(o["pick"], "pick", ["order"])["order"]) };
  }
  if (tag === "all") {
    return { kind: "all", order: parseOrder(asObject(o["all"], "all", ["order"])["order"]) };
  }
  if (tag === "merge") {
    if (!MERGE_FNS.includes(o["merge"] as MergeFn)) {
      throw new Error("unknown merge fn " + String(o["merge"]));
    }
    return { kind: "merge", fn: o["merge"] as MergeFn };
  }
  if (tag === "conflicts") {
    return {
      kind: "conflicts",
      order: parseOrder(asObject(o["conflicts"], "conflicts", ["order"])["order"]),
    };
  }
  {
    const a = asObject(o["absentAs"], "absentAs", ["const", "then"]);
    return {
      kind: "absentAs",
      constant: parsePrimitive(a["const"], "absentAs.const"),
      then: parsePolicy(a["then"]),
    };
  }
}

export function parseSchema(raw: unknown): Schema {
  const o = asObject(raw, "schema", ["props", "default", "name", "alg"]);
  const props = new Map<string, Policy>();
  if (o["props"] !== undefined) {
    // OPEN by design: the keys are the author's property names, not grammar (issue #25).
    for (const [k, v] of Object.entries(asOpenMap(o["props"], "schema.props"))) {
      props.set(nfc(k), parsePolicy(v));
    }
  }
  // name/alg optional (SPEC-3 ERRATA S6): present on a named/self-hosting Schema, absent inline.
  const name = typeof o["name"] === "string" ? nfc(o["name"]) : undefined;
  const alg = typeof o["alg"] === "number" ? o["alg"] : undefined;
  return {
    props,
    default: parsePolicy(o["default"]),
    ...(name !== undefined ? { name } : {}),
    ...(alg !== undefined ? { alg } : {}),
  };
}

function parseGroupKey(raw: unknown): GroupKey {
  if (raw === "byTargetContext") return { kind: "byTargetContext" };
  if (raw === "byRole") return { kind: "byRole" };
  const { o } = oneTag(raw, ["const"], "group.key");
  if (typeof o["const"] !== "string") throw new Error("group.key const must be a string");
  return { kind: "const", prop: nfc(o["const"]) };
}

function parseSchemaRef(raw: unknown): SchemaRefT {
  if (typeof raw === "string") return { kind: "name", name: nfc(raw) };
  const { o } = oneTag(raw, ["pinned"], "schemaRef");
  if (typeof o["pinned"] !== "string") {
    throw new Error("schema ref must be a name string or {pinned: hash} (E13)");
  }
  return { kind: "pinned", hash: o["pinned"] };
}

export function parseTerm(raw: unknown): Term {
  if (raw === "input") return { kind: "input" };
  // Dispatched node: the `op` is checked first (the §8 tag rule), then the keys are checked
  // against exactly that operator's row of the closed grammar (issue #25).
  const { o, tag } = asDispatched(raw, "term", "op", TERM_KEYS);
  switch (tag) {
    case "select":
      return { kind: "select", pred: parsePred(o["pred"]), of: parseTerm(o["in"]) };
    case "union":
      return { kind: "union", left: parseTerm(o["left"]), right: parseTerm(o["right"]) };
    case "intersect":
      return { kind: "intersect", left: parseTerm(o["left"]), right: parseTerm(o["right"]) };
    case "difference":
      return { kind: "difference", of: parseTerm(o["of"]), without: parseTerm(o["without"]) };
    case "mask":
      return { kind: "mask", policy: parseMaskPolicy(o["policy"]), of: parseTerm(o["in"]) };
    case "group":
      return { kind: "group", key: parseGroupKey(o["key"]), of: parseTerm(o["in"]) };
    case "expand": {
      // `reading` is required in the current vocabulary (issue #23); legacy bodies without it
      // still parse and gather, but their expansions refuse to resolve (SPEC-5 §4).
      const expand = {
        kind: "expand" as const,
        role: parseStrMatch(o["role"], "expand.role"),
        schema: parseSchemaRef(o["schema"]),
        of: parseTerm(o["in"]),
      };
      if (o["reading"] === undefined) return expand;
      return { ...expand, reading: parseSchemaRef(o["reading"]) };
    }
    case "fix": {
      if (typeof o["entity"] !== "string") throw new Error("fix.entity must be a string");
      const fix = {
        kind: "fix" as const,
        schema: parseSchemaRef(o["schema"]),
        entity: nfc(o["entity"]),
      };
      if (o["bindings"] === undefined) return fix;
      // OPEN by design: the keys are the author's hole names, not grammar (issue #25).
      const bo = asOpenMap(o["bindings"], "fix.bindings");
      const bindings = new Map<string, Primitive>();
      for (const key of Object.keys(bo).sort()) {
        bindings.set(nfc(key), parsePrimitive(bo[key], `fix.bindings.${key}`));
      }
      return { ...fix, bindings };
    }
    case "resolve":
      return { kind: "resolve", schema: parseSchema(o["schema"]), of: parseTerm(o["in"]) };
    case "prune": {
      const keep = o["keep"] === "all" ? "all" : parseStrMatch(o["keep"], "prune.keep");
      return { kind: "prune", keep, of: parseTerm(o["in"]) };
    }
    /* c8 ignore next 2 -- asDispatched already rejected every tag outside TERM_KEYS */
    default:
      throw new Error(`unknown term op ${String(tag)}`);
  }
}
