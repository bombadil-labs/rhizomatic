// Budget the SPEC-2 JSON-profile grammar before allocating the native syntax tree.
// Containers/primitive members have no semantic cost; family positions define nodes.
import type { CborValue } from "../delta/cbor.js";
import { codecLimit, type ReadingAppearanceLimits } from "./evidence-codec.js";

type Family =
  | "schema"
  | "policy"
  | "order"
  | "pred"
  | "ppred"
  | "str"
  | "val"
  | "entity"
  | "hole"
  | "mask"
  | "group"
  | "ref"
  | "extract"
  | "principal"
  | "term";

export function checkReadingWireSyntax(root: CborValue, limits: ReadingAppearanceLimits): void {
  checkProgramWireSyntax([{ body: root, kind: "reading" }], limits);
}

/** Each distinct selected body starts at depth 1; the node budget is shared by the closure. */
export function checkProgramWireSyntax(
  definitions: readonly { readonly body: CborValue; readonly kind: "hyper" | "reading" }[],
  limits: ReadingAppearanceLimits,
): void {
  let count = 0;
  function visit(value: CborValue | undefined, family: Family, depth: number): void {
    if (value === undefined) return; // Native parser rejects missing required fields.
    codecLimit(++count, limits.syntaxNodes);
    codecLimit(depth, limits.syntaxDepth);
    const fields = new Map(value.t === "map" ? value.v : []);
    const child = (key: string, next: Family): void => visit(fields.get(key), next, depth + 1);
    const wrapped = (key: string): Map<string, CborValue> => {
      const v = fields.get(key);
      return new Map(v?.t === "map" ? v.v : []);
    };
    const inner = (key: string, field: string, next: Family): void =>
      visit(wrapped(key).get(field), next, depth + 1);
    const many = (v: CborValue | undefined, next: Family): void => {
      if (v?.t === "array") for (const c of v.v) visit(c, next, depth + 1);
    };
    const hole = (v: CborValue | undefined): void => {
      if (v?.t === "map" && v.v.some(([k]) => k === "hole")) visit(v, "hole", depth + 1);
    };
    switch (family) {
      case "schema": {
        child("default", "policy");
        const props = fields.get("props");
        if (props?.t === "map") for (const [, c] of props.v) visit(c, "policy", depth + 1);
        break;
      }
      case "policy":
        for (const key of ["pick", "all", "conflicts"]) inner(key, "order", "order");
        inner("absentAs", "then", "policy");
        break;
      case "order":
        inner("byPred", "pred", "pred");
        inner("byPred", "then", "order");
        many(fields.get("chain"), "order");
        break;
      case "pred":
        hole(wrapped("match").get("const"));
        child("hasPointer", "ppred");
        many(fields.get("and"), "pred");
        many(fields.get("or"), "pred");
        child("not", "pred");
        inner("actsFor", "policy", "principal");
        inner("inView", "term", "term");
        inner("inView", "extract", "extract");
        break;
      case "ppred":
        child("role", "str");
        child("context", "str");
        child("targetEntity", "entity");
        child("targetValue", "val");
        break;
      case "str":
        inner("aliased", "trust", "pred");
        break;
      case "val":
        hole(wrapped("vcmp").get("value"));
        break;
      case "mask":
        child("trust", "pred");
        break;
      case "term": {
        const op = fields.get("op");
        switch (op?.t === "tstr" ? op.v : "") {
          case "select":
            child("pred", "pred");
            child("in", "term");
            break;
          case "union":
          case "intersect":
            child("left", "term");
            child("right", "term");
            break;
          case "difference":
            child("of", "term");
            child("without", "term");
            break;
          case "mask":
            child("policy", "mask");
            child("in", "term");
            break;
          case "group":
            child("key", "group");
            child("in", "term");
            break;
          case "prune": {
            const keep = fields.get("keep");
            if (!(keep?.t === "tstr" && keep.v === "all")) child("keep", "str");
            child("in", "term");
            break;
          }
          case "expand":
            child("role", "str");
            child("schema", "ref");
            child("reading", "ref");
            child("in", "term");
            break;
          case "fix":
            child("schema", "ref");
            break;
          case "resolve":
            child("schema", "schema");
            child("in", "term");
            break;
        }
        break;
      }
      case "entity":
      case "hole":
      case "group":
      case "ref":
      case "extract":
      case "principal":
        break;
    }
  }
  for (const definition of definitions)
    visit(definition.body, definition.kind === "reading" ? "schema" : "term", 1);
}
