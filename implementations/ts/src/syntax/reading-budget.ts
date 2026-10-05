// SPEC-16 MR-04: explicit semantic AST traversal, not JS/CBOR container counting.
import type { GroupKey, MaskPolicy, Order, Policy, Schema, SchemaRefT, Term } from "./model.js";
import type { EntityMatch, Hole, InViewExtract, PPred, Pred, StrMatch, ValMatch } from "./pred.js";
import {
  EvidenceCodecError,
  codecLimit,
  codecTextSize,
  type ReadingAppearanceLimits,
} from "./evidence-codec.js";

export function checkReadingSyntax(schema: Schema, limits: ReadingAppearanceLimits): void {
  let count = 0,
    bytes = 0;
  const add = (n: number): void => codecLimit((bytes += n), limits.artifactBytes);
  const text = (s: string): void => add(codecTextSize(s, limits.artifactBytes));
  const primitive = (v: unknown): void => {
    add(1);
    if (typeof v === "string") text(v);
  };
  const path = new Set<object>();
  function node(value: object, depth: number, children: () => void): void {
    if (path.has(value)) throw new EvidenceCodecError("invalid-evidence");
    add(1); // Lower bound: every semantic node has at least one wire item byte.
    codecLimit(++count, limits.syntaxNodes);
    codecLimit(depth, limits.syntaxDepth);
    path.add(value);
    children();
    path.delete(value);
  }
  function hole(value: Hole, depth: number): void {
    node(value, depth, () => {
      text(value.name);
    });
  }
  function str(value: StrMatch, depth: number): void {
    node(value, depth, () => {
      if (value.kind === "exact" || value.kind === "prefix") text(value.value);
      if (value.kind === "inSet") for (const s of value.values) primitive(s);
      if (value.kind === "aliased") {
        text(value.name);
        if (value.via !== undefined) text(value.via);
      }
      if (value.kind === "aliased" && value.trust !== undefined) pred(value.trust, depth + 1);
    });
  }
  function val(value: ValMatch, depth: number): void {
    node(value, depth, () => {
      if (value.kind === "vcmp") {
        if (typeof value.value === "object") hole(value.value, depth + 1);
        else primitive(value.value);
      }
      if (value.kind === "between") {
        primitive(value.lo);
        primitive(value.hi);
      }
      if (value.kind === "inSet") for (const v of value.values) primitive(v);
    });
  }
  function entity(value: EntityMatch, depth: number): void {
    node(value, depth, () => {
      if (value.kind === "const") text(value.id);
      if (value.kind === "hole") text(value.name);
    });
  }
  function pointer(value: PPred, depth: number): void {
    node(value, depth, () => {
      if (value.targetDelta !== undefined) text(value.targetDelta);
      if (value.role !== undefined) str(value.role, depth + 1);
      if (value.context !== undefined) str(value.context, depth + 1);
      if (value.targetEntity !== undefined) entity(value.targetEntity, depth + 1);
      if (value.targetValue !== undefined) val(value.targetValue, depth + 1);
    });
  }
  function extract(value: InViewExtract, depth: number): void {
    node(value, depth, () => {
      if (value.kind === "role") text(value.role);
    });
  }
  function pred(value: Pred, depth: number): void {
    node(value, depth, () => {
      switch (value.kind) {
        case "match":
          if (typeof value.constant === "object" && !Array.isArray(value.constant))
            hole(value.constant as Hole, depth + 1);
          else if (Array.isArray(value.constant)) for (const v of value.constant) primitive(v);
          else primitive(value.constant);
          break;
        case "hasPointer":
          pointer(value.ppred, depth + 1);
          break;
        case "and":
        case "or":
          pred(value.left, depth + 1);
          pred(value.right, depth + 1);
          break;
        case "not":
          pred(value.pred, depth + 1);
          break;
        case "actsFor":
          text(value.root);
          node(value.policy, depth + 1, () => {
            text(value.policy.scope);
          });
          break;
        case "inView":
          term(value.term, depth + 1);
          extract(value.extract, depth + 1);
          break;
        case "true":
        case "false":
          break;
      }
    });
  }
  function order(value: Order, depth: number): void {
    node(value, depth, () => {
      if (value.kind === "byAuthorRank") for (const s of value.authors) primitive(s);
      if (value.kind === "byPred") {
        pred(value.pred, depth + 1);
        order(value.then, depth + 1);
      }
      if (value.kind === "chain") for (const child of value.orders) order(child, depth + 1);
    });
  }
  function policy(value: Policy, depth: number): void {
    node(value, depth, () => {
      switch (value.kind) {
        case "pick":
        case "all":
        case "conflicts":
          order(value.order, depth + 1);
          break;
        case "absentAs":
          primitive(value.constant);
          policy(value.then, depth + 1);
          break;
        case "merge":
          break;
      }
    });
  }
  function reading(value: Schema, depth: number): void {
    node(value, depth, () => {
      if (value.name !== undefined) text(value.name);
      policy(value.default, depth + 1);
      for (const [key, child] of value.props) {
        text(key);
        policy(child, depth + 1);
      }
    });
  }
  function ref(value: SchemaRefT, depth: number): void {
    node(value, depth, () => {
      text(value.kind === "name" ? value.name : value.hash);
    });
  }
  function mask(value: MaskPolicy, depth: number): void {
    node(value, depth, () => {
      if (value.kind === "trust") pred(value.pred, depth + 1);
    });
  }
  function group(value: GroupKey, depth: number): void {
    node(value, depth, () => {
      if (value.kind === "const") text(value.prop);
    });
  }
  function term(value: Term, depth: number): void {
    node(value, depth, () => {
      switch (value.kind) {
        case "input":
          break;
        case "select":
          pred(value.pred, depth + 1);
          term(value.of, depth + 1);
          break;
        case "union":
        case "intersect":
          term(value.left, depth + 1);
          term(value.right, depth + 1);
          break;
        case "difference":
          term(value.of, depth + 1);
          term(value.without, depth + 1);
          break;
        case "mask":
          mask(value.policy, depth + 1);
          term(value.of, depth + 1);
          break;
        case "group":
          group(value.key, depth + 1);
          term(value.of, depth + 1);
          break;
        case "prune":
          if (value.keep !== "all") str(value.keep, depth + 1);
          term(value.of, depth + 1);
          break;
        case "expand":
          str(value.role, depth + 1);
          ref(value.schema, depth + 1);
          if (value.reading !== undefined) ref(value.reading, depth + 1);
          term(value.of, depth + 1);
          break;
        case "fix":
          text(value.entity);
          if (value.bindings !== undefined)
            for (const [k, v] of value.bindings) {
              text(k);
              primitive(v);
            }
          ref(value.schema, depth + 1);
          break;
        case "resolve":
          reading(value.schema, depth + 1);
          term(value.of, depth + 1);
          break;
      }
    });
  }
  reading(schema, 1);
}
