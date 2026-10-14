// Anchored reads (SPEC-17 proposal): evaluate a gather over the scope S(E) of its anchors instead
// of over the whole delta set, so a read costs its footprint and not the store. The evaluator is
// unchanged; this module chooses its input. The scope lemma (SPEC-17 §4) is what makes the
// answer identical: S(E) is closed under every negation chain that decides a member.

import type { HView } from "../algebra/hview.js";
import { compareUtf8 } from "../delta/cbor.js";
import { DeltaSet } from "../delta/set.js";
import type { Delta } from "../delta/types.js";
import type { SchemaRegistry } from "../schema/schema.js";
import type { SchemaRefT, Term } from "../syntax/model.js";
import type { Bindings, EntityMatch, Pred, StrMatch } from "../syntax/pred.js";
import { evalTerm, type EvalResult } from "./eval.js";

/**
 * The read side of a store (SPEC-17 §3). `targets` and `negators` answer from indexes; neither
 * may scan the store. `subset`, when present, builds a set from members the source has already
 * verified, without hashing them again.
 */
export interface DeltaSource {
  get(id: string): Delta | undefined;
  /** Ids of every delta with a pointer whose target is the entity `entity`, any role or context. */
  targets(entity: string): Iterable<string>;
  /** Ids of every delta with a pointer `{role: "negates", target: DeltaRef(id)}`. */
  negators(id: string): Iterable<string>;
  subset?(ids: Iterable<string>): DeltaSet;
}

/** A host selection: decided per delta, never by inspecting other deltas (SPEC-17 §3). */
export type Admits = (delta: Delta) => boolean;

/**
 * S(E): every admitted delta pointing at an entity in `entities`, closed under admitted negators,
 * transitively. Sorted ids. Cost is O(|S(E)|) index lookups.
 */
export function scopeIds(
  source: DeltaSource,
  entities: Iterable<string>,
  admits?: Admits,
): string[] {
  const members = new Set<string>();
  const pending: string[] = [];
  const consider = (id: string) => {
    if (members.has(id)) return;
    const delta = source.get(id);
    if (delta === undefined || (admits !== undefined && !admits(delta))) return;
    members.add(id);
    pending.push(id);
  };
  for (const entity of entities) for (const id of source.targets(entity)) consider(id);
  while (pending.length > 0) {
    const id = pending.pop()!;
    for (const negator of source.negators(id)) consider(negator);
  }
  return [...members].sort();
}

/** Why a term cannot be anchored (SPEC-17 §5). The strings are shared vocabulary. */
export type UnanchoredReason =
  | "aliased"
  | "reflection"
  | "const-group"
  | "acts-for"
  | "unknown-schema"
  | "result-sort";

export type AnchorAnalysis =
  | { readonly anchored: true; readonly anchors: readonly string[] }
  | { readonly anchored: false; readonly reason: UnanchoredReason };

class Unanchored extends Error {
  constructor(readonly reason: UnanchoredReason) {
    super(`term is not anchored: ${reason}`);
  }
}

const conjuncts = (pred: Pred): Pred[] =>
  pred.kind === "and" ? [...conjuncts(pred.left), ...conjuncts(pred.right)] : [pred];

// The ambient root, kept apart from every entity id: an entity may be named "root".
const AMBIENT = Symbol("ambient root");
type Pin = string | typeof AMBIENT;

// The entity a conjunct pins, when it pins one: AMBIENT for the ambient root.
function pinnedEntity(pred: Pred, bindings: Bindings | undefined): Pin | undefined {
  for (const c of conjuncts(pred)) {
    if (c.kind !== "hasPointer" || c.ppred.targetEntity === undefined) continue;
    const entity = entityOf(c.ppred.targetEntity, bindings);
    if (entity !== undefined) return entity;
  }
  return undefined;
}

function entityOf(m: EntityMatch, bindings: Bindings | undefined): Pin | undefined {
  if (m.kind === "const") return m.id;
  if (m.kind === "root") return AMBIENT;
  const bound = bindings?.get(m.name);
  return typeof bound === "string" ? bound : undefined;
}

const checkStr = (m: StrMatch | undefined): void => {
  if (m?.kind === "aliased") throw new Unanchored("aliased");
};

/**
 * Static check (SPEC-17 §5): is every place this term reads deltas tied to an entity it can name?
 * Returns its static anchors (constant `inView`, `group const` and `fix` entities), sorted.
 * Referenced schema bodies are walked through the registry.
 */
export function anchorAnalysis(
  term: Term,
  registry?: SchemaRegistry,
  bindings?: Bindings,
): AnchorAnalysis {
  const anchors = new Set<string>();
  const seen = new Set<string>();
  const pred = (p: Pred, b: Bindings | undefined): void => {
    switch (p.kind) {
      case "and":
      case "or":
        pred(p.left, b);
        pred(p.right, b);
        return;
      case "not":
        pred(p.pred, b);
        return;
      case "hasPointer":
        checkStr(p.ppred.role);
        checkStr(p.ppred.context);
        return;
      case "actsFor":
        throw new Unanchored("acts-for");
      case "inView": {
        const sub = p.term;
        const entity = sub.kind === "select" ? pinnedEntity(sub.pred, b) : undefined;
        if (entity === undefined) throw new Unanchored("reflection");
        if (entity !== AMBIENT) anchors.add(entity);
        walk(sub, b);
        return;
      }
      default:
        return;
    }
  };
  const schema = (ref: SchemaRefT, b: Bindings | undefined) => {
    const body = registry?.resolve(ref)?.body;
    if (body === undefined) throw new Unanchored("unknown-schema");
    const key = `${ref.kind === "name" ? ref.name : ref.hash}|${JSON.stringify([...(b ?? [])])}`;
    if (seen.has(key)) return;
    seen.add(key);
    walk(body, b);
  };
  const walk = (t: Term, b: Bindings | undefined): void => {
    switch (t.kind) {
      case "input":
        return;
      case "select":
        pred(t.pred, b);
        walk(t.of, b);
        return;
      case "union":
      case "intersect":
        walk(t.left, b);
        walk(t.right, b);
        return;
      case "difference":
        walk(t.of, b);
        walk(t.without, b);
        return;
      case "mask":
        if (t.policy.kind === "trust") pred(t.policy.pred, b);
        walk(t.of, b);
        return;
      case "group": {
        if (t.key.kind === "const") {
          const entity = t.of.kind === "select" ? pinnedEntity(t.of.pred, b) : undefined;
          if (entity === undefined) throw new Unanchored("const-group");
          if (entity !== AMBIENT) anchors.add(entity);
        }
        walk(t.of, b);
        return;
      }
      case "prune":
        if (t.keep !== "all") checkStr(t.keep);
        walk(t.of, b);
        return;
      case "expand":
        checkStr(t.role);
        walk(t.of, b);
        schema(t.schema, b);
        return;
      case "fix":
        anchors.add(t.entity);
        schema(t.schema, t.bindings ?? b);
        return;
      case "resolve":
        walk(t.of, b);
        return;
    }
  };
  // Discovery reads the gathered HView; a DSet or bare View result shows no anchors.
  const top = term.kind === "resolve" ? term.of : term;
  if (top.kind !== "group" && top.kind !== "prune" && top.kind !== "expand" && top.kind !== "fix")
    return { anchored: false, reason: "result-sort" };
  try {
    walk(term, bindings);
  } catch (e) {
    if (e instanceof Unanchored) return { anchored: false, reason: e.reason };
    throw e;
  }
  return { anchored: true, anchors: [...anchors].sort(compareUtf8) };
}

/** The anchors an HView shows: its root and every expanded child, at any depth. */
function visibleAnchors(hview: HView, out: Set<string>): void {
  out.add(hview.id);
  for (const entries of hview.props.values())
    for (const entry of entries)
      for (const child of entry.expanded?.values() ?? []) visibleAnchors(child, out);
}

/** The anchors an HView shows, sorted: its root and every expanded child (SPEC-17 §6). */
export function hviewAnchors(hview: HView): string[] {
  const out = new Set<string>();
  visibleAnchors(hview, out);
  return [...out].sort(compareUtf8);
}

export interface AnchoredRead {
  readonly result: EvalResult;
  /** The scope E*: the root, the static anchors and every dynamic anchor, sorted. */
  readonly scope: readonly string[];
  /** The ids of S(E*), sorted: the deltas the read can depend on. */
  readonly members: readonly string[];
}

/**
 * Evaluate an anchored term at `root` over the scope it needs (SPEC-17 §6). The answer equals
 * `evalTerm` over the whole admitted source. Throws on an unanchored term: the caller classifies
 * with `anchorAnalysis` first and decides what an unanchored read does.
 */
export function evalAnchored(
  term: Term,
  source: DeltaSource,
  now: number,
  root: string,
  registry?: SchemaRegistry,
  bindings?: Bindings,
  admits?: Admits,
): AnchoredRead {
  const analysis = anchorAnalysis(term, registry, bindings);
  if (!analysis.anchored) throw new Error(`term is not anchored: ${analysis.reason}`);
  const gather = term.kind === "resolve" ? term.of : term;
  const scope = new Set([root, ...analysis.anchors]);
  for (;;) {
    const members = scopeIds(source, scope, admits);
    const set =
      source.subset?.(members) ??
      DeltaSet.from(members.map((id) => source.get(id)).filter((d) => d !== undefined));
    const gathered = evalTerm(gather, set, now, root, registry, bindings);
    if (gathered.sort !== "hview") throw new Error("term is not anchored: result-sort");
    const seen = new Set<string>();
    visibleAnchors(gathered.hview, seen);
    const missing = [...seen].filter((e) => !scope.has(e));
    if (missing.length === 0) {
      const result =
        gather === term ? gathered : evalTerm(term, set, now, root, registry, bindings);
      return { result, scope: [...scope].sort(compareUtf8), members };
    }
    for (const e of missing) scope.add(e);
  }
}
