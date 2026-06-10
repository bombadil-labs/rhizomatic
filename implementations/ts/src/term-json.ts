// Parse the JSON term profile (ERRATA-2 E1) into Term/Pred. Strings are NFC-normalized at parse
// time so term-side comparisons are NFC-vs-NFC (data strings are NFC by validation, D11).

import type { Term, MaskPolicy } from "./eval.js";
import type { Cmp, PPred, Pred, StrMatch, ValMatch } from "./pred.js";
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
  throw new Error(`${what}: StrMatch must be exact | prefix | inSet`);
}

function parseValMatch(raw: unknown, what: string): ValMatch {
  const o = asObject(raw, what);
  if (o["vcmp"] !== undefined) {
    const v = asObject(o["vcmp"], `${what}.vcmp`);
    const cmp = parseCmp(v["cmp"], `${what}.vcmp`);
    if (cmp === "inSet")
      throw new Error(`${what}: vcmp cmp inSet is not allowed; use the inSet arm`);
    const value = parsePrimitive(v["value"], `${what}.vcmp`);
    if (cmp === "prefix" && typeof value !== "string") {
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
    targetEntity?: string;
    targetDelta?: string;
    context?: StrMatch;
    targetIsPrimitive?: boolean;
    targetValue?: ValMatch;
  } = {};
  if (o["role"] !== undefined) out.role = parseStrMatch(o["role"], "hasPointer.role");
  if (o["targetEntity"] !== undefined) {
    if (typeof o["targetEntity"] !== "string") throw new Error("targetEntity must be a string");
    out.targetEntity = nfc(o["targetEntity"]);
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
        : parsePrimitive(rawConst, "match.const");
    if (cmp === "prefix" && typeof constant !== "string") {
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
  throw new Error("pred must be true | false | match | hasPointer | and | or | not");
}

function parseMaskPolicy(raw: unknown): MaskPolicy {
  if (raw === "drop") return { kind: "drop" };
  if (raw === "annotate") return { kind: "annotate" };
  const o = asObject(raw, "mask.policy");
  if (o["trust"] !== undefined) return { kind: "trust", pred: parsePred(o["trust"]) };
  throw new Error("mask policy must be drop | annotate | {trust: Pred}");
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
    default:
      throw new Error(`unknown term op ${String(o["op"])}`);
  }
}
