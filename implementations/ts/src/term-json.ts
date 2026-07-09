// Parse the JSON term profile (ERRATA-2 E1) into Term/Pred. Strings are NFC-normalized at parse
// time so term-side comparisons are NFC-vs-NFC (data strings are NFC by validation, D11).

import {
  termContainsInView,
  type GroupKey,
  type MaskPolicy,
  type SchemaRefT,
  type Term,
} from "./eval.js";
import type { MergeFn, Order, Policy, PropPolicy } from "./policy.js";
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
import type { Primitive } from "./types.js";

const CMPS: readonly Cmp[] = ["eq", "neq", "lt", "lte", "gt", "gte", "prefix", "inSet"];

function nfc(s: string): string {
  return s.normalize("NFC");
}

function asObject(x: unknown, what: string): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new Error(`expected object for ${what}`);
  }
  return x as Record<string, unknown>;
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

// A hole in Const position: {"hole": "name"} (E15).
function parseHole(v: unknown): Hole | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const h = (v as Record<string, unknown>)["hole"];
  return typeof h === "string" ? { kind: "hole", name: nfc(h) } : undefined;
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
  const o = asObject(raw, what);
  if (typeof o["exact"] === "string") return { kind: "exact", value: nfc(o["exact"]) };
  if (typeof o["prefix"] === "string") return { kind: "prefix", value: nfc(o["prefix"]) };
  if (Array.isArray(o["inSet"])) {
    return {
      kind: "inSet",
      values: o["inSet"].map((s) => {
        if (typeof s !== "string") throw new Error(`${what}: inSet members must be strings`);
        return nfc(s);
      }),
    };
  }
  if (o["aliased"] !== undefined) {
    const a = asObject(o["aliased"], `${what}.aliased`);
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
  throw new Error(`${what}: StrMatch must be exact | prefix | inSet | aliased`);
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
  const o = asObject(raw, what);
  if (o["vcmp"] !== undefined) {
    const v = asObject(o["vcmp"], `${what}.vcmp`);
    const cmp = parseCmp(v["cmp"], `${what}.vcmp`);
    if (cmp === "inSet")
      throw new Error(`${what}: vcmp cmp inSet is not allowed; use the inSet arm`);
    const value = parseParam(v["value"], `${what}.vcmp`);
    if (cmp === "prefix" && typeof value !== "string" && typeof value !== "object") {
      throw new Error(`${what}: prefix requires a string constant`);
    }
    return { kind: "vcmp", cmp, value };
  }
  if (Array.isArray(o["between"])) {
    if (o["between"].length !== 2) throw new Error(`${what}: between takes [lo, hi]`);
    return {
      kind: "between",
      lo: parsePrimitive(o["between"][0], `${what}.between`),
      hi: parsePrimitive(o["between"][1], `${what}.between`),
    };
  }
  if (Array.isArray(o["inSet"])) {
    return { kind: "inSet", values: o["inSet"].map((v) => parsePrimitive(v, `${what}.inSet`)) };
  }
  throw new Error(`${what}: ValMatch must be vcmp | between | inSet`);
}

function parsePPred(raw: unknown): PPred {
  const o = asObject(raw, "hasPointer");
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
        const v = asObject(te, "targetEntity");
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
  const o = asObject(raw, "pred");
  if (o["match"] !== undefined) {
    const m = asObject(o["match"], "match");
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
  if (o["hasPointer"] !== undefined)
    return { kind: "hasPointer", ppred: parsePPred(o["hasPointer"]) };
  if (o["and"] !== undefined || o["or"] !== undefined) {
    const key = o["and"] !== undefined ? "and" : "or";
    const arr = o[key];
    if (!Array.isArray(arr) || arr.length !== 2)
      throw new Error(`${key} takes exactly [Pred, Pred] (E1)`);
    const left = parsePred(arr[0]);
    const right = parsePred(arr[1]);
    return key === "and" ? { kind: "and", left, right } : { kind: "or", left, right };
  }
  if (o["not"] !== undefined) return { kind: "not", pred: parsePred(o["not"]) };
  if (o["inView"] !== undefined) {
    const v = asObject(o["inView"], "inView");
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
  throw new Error("pred must be true | false | match | hasPointer | and | or | not | inView");
}

function parseExtract(raw: unknown): InViewExtract {
  const o = asObject(raw, "inView.extract");
  if (o["field"] !== undefined) {
    if (o["field"] !== "author" && o["field"] !== "id") {
      throw new Error("inView.extract.field must be author | id");
    }
    return { kind: "field", field: o["field"] };
  }
  if (typeof o["role"] === "string") return { kind: "role", role: nfc(o["role"]) };
  throw new Error("inView.extract must be {field: author|id} | {role: string}");
}

function parseMaskPolicy(raw: unknown): MaskPolicy {
  if (raw === "drop") return { kind: "drop" };
  if (raw === "annotate") return { kind: "annotate" };
  const o = asObject(raw, "mask.policy");
  if (o["trust"] !== undefined) return { kind: "trust", pred: parsePred(o["trust"]) };
  throw new Error("mask policy must be drop | annotate | {trust: Pred}");
}

const MERGE_FNS: readonly MergeFn[] = ["max", "min", "sum", "count", "and", "or", "concatSorted"];

function parseOrder(raw: unknown): Order {
  if (raw === "lexById") return { kind: "lexById" };
  const o = asObject(raw, "order");
  if (o["byTimestamp"] !== undefined) {
    if (o["byTimestamp"] !== "desc" && o["byTimestamp"] !== "asc") {
      throw new Error("byTimestamp must be desc | asc");
    }
    return { kind: "byTimestamp", dir: o["byTimestamp"] };
  }
  if (Array.isArray(o["byAuthorRank"])) {
    return {
      kind: "byAuthorRank",
      authors: o["byAuthorRank"].map((a) => {
        if (typeof a !== "string") throw new Error("byAuthorRank entries must be strings");
        return nfc(a);
      }),
    };
  }
  if (o["byPred"] !== undefined) {
    const p = asObject(o["byPred"], "byPred");
    const pred = parsePred(p["pred"]);
    // Policy predicates are closed: they run inside resolve, after the mask already decided
    // standing — a reflective order would be a second, unlowered trust surface (SPEC-2 §3.1).
    if (predContainsInView(pred)) {
      throw new Error("inView is not allowed inside a policy byPred predicate (SPEC-2 §3.1)");
    }
    return { kind: "byPred", pred, then: parseOrder(p["then"]) };
  }
  if (Array.isArray(o["chain"])) {
    if (o["chain"].length === 0) throw new Error("chain must name at least one order");
    return { kind: "chain", orders: o["chain"].map(parseOrder) };
  }
  throw new Error("order must be lexById | byTimestamp | byAuthorRank | byPred | chain");
}

function parsePropPolicy(raw: unknown): PropPolicy {
  const o = asObject(raw, "propPolicy");
  if (o["pick"] !== undefined) {
    return { kind: "pick", order: parseOrder(asObject(o["pick"], "pick")["order"]) };
  }
  if (o["all"] !== undefined) {
    return { kind: "all", order: parseOrder(asObject(o["all"], "all")["order"]) };
  }
  if (o["merge"] !== undefined) {
    if (!MERGE_FNS.includes(o["merge"] as MergeFn)) {
      throw new Error("unknown merge fn " + String(o["merge"]));
    }
    return { kind: "merge", fn: o["merge"] as MergeFn };
  }
  if (o["conflicts"] !== undefined) {
    return { kind: "conflicts", order: parseOrder(asObject(o["conflicts"], "conflicts")["order"]) };
  }
  if (o["absentAs"] !== undefined) {
    const a = asObject(o["absentAs"], "absentAs");
    return {
      kind: "absentAs",
      constant: parsePrimitive(a["const"], "absentAs.const"),
      then: parsePropPolicy(a["then"]),
    };
  }
  throw new Error("propPolicy must be pick | all | merge | conflicts | absentAs");
}

export function parsePolicy(raw: unknown): Policy {
  const o = asObject(raw, "policy");
  const props = new Map<string, PropPolicy>();
  if (o["props"] !== undefined) {
    for (const [k, v] of Object.entries(asObject(o["props"], "policy.props"))) {
      props.set(nfc(k), parsePropPolicy(v));
    }
  }
  return { props, default: parsePropPolicy(o["default"]) };
}

function parseGroupKey(raw: unknown): GroupKey {
  if (raw === "byTargetContext") return { kind: "byTargetContext" };
  if (raw === "byRole") return { kind: "byRole" };
  const o = asObject(raw, "group.key");
  if (typeof o["const"] === "string") return { kind: "const", prop: nfc(o["const"]) };
  throw new Error("group key must be byTargetContext | byRole | {const: string}");
}

function parseSchemaRef(raw: unknown): SchemaRefT {
  if (typeof raw === "string") return { kind: "name", name: nfc(raw) };
  const o = asObject(raw, "schemaRef");
  if (typeof o["pinned"] === "string") return { kind: "pinned", hash: o["pinned"] };
  throw new Error("schema ref must be a name string or {pinned: hash} (E13)");
}

export function parseTerm(raw: unknown): Term {
  if (raw === "input") return { kind: "input" };
  const o = asObject(raw, "term");
  switch (o["op"]) {
    case "select":
      return { kind: "select", pred: parsePred(o["pred"]), of: parseTerm(o["in"]) };
    case "union":
      return { kind: "union", left: parseTerm(o["left"]), right: parseTerm(o["right"]) };
    case "mask":
      return { kind: "mask", policy: parseMaskPolicy(o["policy"]), of: parseTerm(o["in"]) };
    case "group":
      return { kind: "group", key: parseGroupKey(o["key"]), of: parseTerm(o["in"]) };
    case "expand": {
      return {
        kind: "expand",
        role: parseStrMatch(o["role"], "expand.role"),
        schema: parseSchemaRef(o["schema"]),
        of: parseTerm(o["in"]),
      };
    }
    case "fix": {
      if (typeof o["entity"] !== "string") throw new Error("fix.entity must be a string");
      const fix = {
        kind: "fix" as const,
        schema: parseSchemaRef(o["schema"]),
        entity: nfc(o["entity"]),
      };
      if (o["bindings"] === undefined) return fix;
      const bo = asObject(o["bindings"], "fix.bindings");
      const bindings = new Map<string, Primitive>();
      for (const key of Object.keys(bo).sort()) {
        bindings.set(nfc(key), parsePrimitive(bo[key], `fix.bindings.${key}`));
      }
      return { ...fix, bindings };
    }
    case "resolve":
      return { kind: "resolve", policy: parsePolicy(o["policy"]), of: parseTerm(o["in"]) };
    case "prune": {
      const keep = o["keep"] === "all" ? "all" : parseStrMatch(o["keep"], "prune.keep");
      return { kind: "prune", keep, of: parseTerm(o["in"]) };
    }
    default:
      throw new Error(`unknown term op ${String(o["op"])}`);
  }
}
