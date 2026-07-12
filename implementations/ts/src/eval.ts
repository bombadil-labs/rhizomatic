// Term evaluation: select/union/mask over DSet (SPEC-2 §4.1-4.3), group into HView (§4.4),
// prune over HView (§4.6). eval is a pure function; order-blind; deterministic (SPEC-2 §5).
// Sorts are checked at evaluation time in v0 (ERRATA-2 E9).

import { array, encode, map, tstr } from "./cbor.js";
import { bytesToHex } from "./hash.js";
import { hviewCanonicalHex, type HVEntry, type HView } from "./hview.js";
import { resolveView, viewCanonicalHex, type Schema, type View } from "./resolution.js";
import {
  comparePrimitives,
  evalPred,
  predContainsInView,
  strMatch,
  substituteHoles,
  type Bindings,
  type InViewExtract,
  type Pred,
  type StrMatch,
} from "./pred.js";
import { VOCAB_PREFIX } from "./vocab.js";
import { SchemaRegistry } from "./schema.js";
import { DeltaSet, fork, merge } from "./set.js";
import type { Delta } from "./types.js";

export type MaskPolicy =
  | { readonly kind: "drop" }
  | { readonly kind: "annotate" }
  | { readonly kind: "trust"; readonly pred: Pred };

export type SchemaRefT =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "pinned"; readonly hash: string };

export type GroupKey =
  | { readonly kind: "byTargetContext" }
  | { readonly kind: "byRole" }
  | { readonly kind: "const"; readonly prop: string };

export type Term =
  | { readonly kind: "input" }
  | { readonly kind: "select"; readonly pred: Pred; readonly of: Term }
  | { readonly kind: "union"; readonly left: Term; readonly right: Term }
  | { readonly kind: "mask"; readonly policy: MaskPolicy; readonly of: Term }
  | { readonly kind: "group"; readonly key: GroupKey; readonly of: Term }
  | { readonly kind: "prune"; readonly keep: "all" | StrMatch; readonly of: Term }
  | {
      readonly kind: "expand";
      readonly role: StrMatch;
      readonly schema: SchemaRefT;
      readonly of: Term;
    }
  | {
      readonly kind: "fix";
      readonly schema: SchemaRefT;
      readonly entity: string;
      readonly bindings?: Bindings;
    }
  | { readonly kind: "resolve"; readonly schema: Schema; readonly of: Term };

interface DSetResult {
  readonly sort: "dset";
  readonly set: DeltaSet;
  // Negation tags from mask(annotate); consumed by group (E7) or surfaced at top level (E2).
  readonly negated: ReadonlySet<string>;
  readonly annotated: boolean;
}

interface HViewResult {
  readonly sort: "hview";
  readonly hview: HView;
}

// The terminal sort: no operator consumes a View (SPEC-2 §4.7, ERRATA-5 R7).
interface ViewResult {
  readonly sort: "view";
  readonly view: View;
}

export type EvalResult = DSetResult | HViewResult | ViewResult;

const dsetResult = (set: DeltaSet): DSetResult => ({
  sort: "dset",
  set,
  negated: new Set(),
  annotated: false,
});

function expectDSet(r: EvalResult, op: string): DSetResult {
  if (r.sort !== "dset") throw new Error(`${op} requires a DSet operand (E9)`);
  return r;
}

function expectHView(r: EvalResult, op: string): HViewResult {
  if (r.sort !== "hview") throw new Error(`${op} requires an HView operand (E9)`);
  return r;
}

// negated(d, D) per SPEC-2 §4.3, over candidate negations restricted by `trusted` (E4).
// Memoized with an in-progress default of "not negated" (E5 recursion guard).
function computeNegated(d: DeltaSet, trusted?: (n: Delta) => boolean): Set<string> {
  const negators = new Map<string, string[]>(); // target delta id -> negation delta ids
  for (const n of d) {
    if (trusted !== undefined && !trusted(n)) continue;
    for (const ptr of n.claims.pointers) {
      if (ptr.role === "negates" && ptr.target.kind === "delta") {
        const list = negators.get(ptr.target.deltaRef.delta);
        if (list === undefined) negators.set(ptr.target.deltaRef.delta, [n.id]);
        else list.push(n.id);
      }
    }
  }
  const memo = new Map<string, boolean>();
  const isNegated = (id: string): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    memo.set(id, false); // guard: cycles are impossible with verified ids, but degrade safely
    const result = (negators.get(id) ?? []).some((nid) => !isNegated(nid));
    memo.set(id, result);
    return result;
  };
  const out = new Set<string>();
  for (const delta of d) if (isNegated(delta.id)) out.add(delta.id);
  return out;
}

// --- the aliased closure (SPEC-9 §4.1) -----------------------------------------------------------

const ALIAS_FRAGMENT = `${VOCAB_PREFIX}.alias.fragment`;
const ALIAS_SLOT = `${VOCAB_PREFIX}.alias.slot`;
const ALIAS_CONCEPT = `${VOCAB_PREFIX}.alias.concept`;

export interface AliasedSpec {
  readonly name: string;
  readonly via?: string;
  readonly trust?: Pred;
}

// closure(A, D): name → slots → fragments, one hop, computed against the AMBIENT evaluation
// input. The trust predicate restricts every participant — mappings, slot declarations, and the
// negations of both — and negation chains are walked within the trusted set only (mask(trust)
// semantics). Returns the closure sorted by the canonical string order; the name is always a
// member, so an aliased with no surviving mappings degrades to exact(name).
export function aliasClosure(input: DeltaSet, spec: AliasedSpec, root?: string): string[] {
  const trustPred = spec.trust;
  const trusted = trustPred === undefined ? undefined : (n: Delta) => evalPred(trustPred, n, root);
  const negated = computeNegated(input, trusted);
  const mappings: { fragment: string; slot: string }[] = [];
  const slotConcepts = new Map<string, Set<string>>();
  for (const d of input) {
    if (trusted !== undefined && !trusted(d)) continue;
    if (negated.has(d.id)) continue;
    const fragments: string[] = [];
    const slots: string[] = [];
    const concepts: string[] = [];
    for (const ptr of d.claims.pointers) {
      if (ptr.role === ALIAS_FRAGMENT && ptr.target.kind === "primitive") {
        if (typeof ptr.target.value === "string") fragments.push(ptr.target.value);
      } else if (ptr.role === ALIAS_SLOT && ptr.target.kind === "entity") {
        slots.push(ptr.target.entity.id);
      } else if (ptr.role === ALIAS_CONCEPT && ptr.target.kind === "entity") {
        concepts.push(ptr.target.entity.id);
      }
    }
    // Mapping claim: ≥1 fragment × ≥1 slot, cross product (SPEC-9 §3). Anything else with the
    // alias roles is not a mapping and is ignored here (graceful degradation).
    for (const fragment of fragments) for (const slot of slots) mappings.push({ fragment, slot });
    // Slot declaration: ≥1 slot × ≥1 concept (SPEC-9 §2).
    for (const slot of slots) {
      for (const concept of concepts) {
        let set = slotConcepts.get(slot);
        if (set === undefined) {
          set = new Set();
          slotConcepts.set(slot, set);
        }
        set.add(concept);
      }
    }
  }
  const eligible =
    spec.via === undefined
      ? mappings
      : mappings.filter((m) => slotConcepts.get(m.slot)?.has(spec.via!) ?? false);
  const slotsOfName = new Set(eligible.filter((m) => m.fragment === spec.name).map((m) => m.slot));
  const closure = new Set<string>([spec.name]);
  for (const m of eligible) if (slotsOfName.has(m.slot)) closure.add(m.fragment);
  return [...closure].sort(comparePrimitives);
}

// Expand an aliased StrMatch to its inSet form against the ambient input; other forms pass.
function expandStrMatch(m: StrMatch, input: DeltaSet, root: string | undefined): StrMatch {
  if (m.kind !== "aliased") return m;
  return { kind: "inSet", values: aliasClosure(input, m, root) };
}

// Expand every aliased StrMatch in a predicate (ppred role/context) against the ambient input.
// Applied where predicates meet data (select / mask-trust), after hole substitution (SPEC-9 §4.1).
export function expandAliased(pred: Pred, input: DeltaSet, root: string | undefined): Pred {
  switch (pred.kind) {
    case "true":
    case "false":
    case "match":
      return pred;
    case "hasPointer": {
      const p = pred.ppred;
      const role = p.role === undefined ? undefined : expandStrMatch(p.role, input, root);
      const context = p.context === undefined ? undefined : expandStrMatch(p.context, input, root);
      if (role === p.role && context === p.context) return pred;
      return {
        kind: "hasPointer",
        ppred: {
          ...p,
          ...(role === undefined ? {} : { role }),
          ...(context === undefined ? {} : { context }),
        },
      };
    }
    case "and":
      return {
        kind: "and",
        left: expandAliased(pred.left, input, root),
        right: expandAliased(pred.right, input, root),
      };
    case "or":
      return {
        kind: "or",
        left: expandAliased(pred.left, input, root),
        right: expandAliased(pred.right, input, root),
      };
    case "not":
      return { kind: "not", pred: expandAliased(pred.pred, input, root) };
    case "inView":
      // Aliased matches inside the sub-term expand during its own evaluation.
      return pred;
  }
}

// --- reflective predicates (SPEC-2 §3.1) ----------------------------------------------------------

// The reflected string set: extract a facet from every delta of the sub-view.
function extractReflected(extract: InViewExtract, set: DeltaSet): string[] {
  const out = new Set<string>();
  for (const d of set) {
    if (extract.kind === "field") {
      out.add(extract.field === "author" ? d.claims.author : d.id);
      continue;
    }
    for (const ptr of d.claims.pointers) {
      if (ptr.role !== extract.role) continue;
      const t = ptr.target;
      if (t.kind === "entity") out.add(t.entity.id);
      else if (t.kind === "delta") out.add(t.deltaRef.delta);
      else if (typeof t.value === "string") out.add(t.value);
    }
  }
  return [...out].sort(comparePrimitives);
}

// Lower every inView to its inSet form: evaluate the sub-term against the AMBIENT input (not the
// enclosing operator's operand — a grant landing anywhere may flip a negation's standing), once
// per operator application. Applied where predicates meet data (select / mask-trust), beside hole
// substitution and alias expansion. The lowered predicate is inside the SPEC-2 §3 fragment.
function resolveReflective(
  pred: Pred,
  input: DeltaSet,
  root: string | undefined,
  registry: SchemaRegistry | undefined,
  bindings: Bindings | undefined,
): Pred {
  switch (pred.kind) {
    case "inView": {
      const sub = evalTerm(pred.term, input, root, registry, bindings);
      if (sub.sort !== "dset") throw new Error("inView.term must evaluate to a DSet (E9)");
      return {
        kind: "match",
        field: pred.field,
        cmp: "inSet",
        constant: extractReflected(pred.extract, sub.set),
      };
    }
    case "and":
      return {
        kind: "and",
        left: resolveReflective(pred.left, input, root, registry, bindings),
        right: resolveReflective(pred.right, input, root, registry, bindings),
      };
    case "or":
      return {
        kind: "or",
        left: resolveReflective(pred.left, input, root, registry, bindings),
        right: resolveReflective(pred.right, input, root, registry, bindings),
      };
    case "not":
      return { kind: "not", pred: resolveReflective(pred.pred, input, root, registry, bindings) };
    default:
      return pred;
  }
}

// Any inView anywhere in the term? Parse-time stratification and the reactor's conservative
// dispatch (SPEC-4 §4.1) both hang off this walk. Schema bodies referenced by expand/fix are the
// caller's concern (the reactor walks its registry; the parser rejects per-body).
export function termContainsInView(t: Term): boolean {
  switch (t.kind) {
    case "input":
    case "fix":
      return false;
    case "select":
      return predContainsInView(t.pred) || termContainsInView(t.of);
    case "union":
      return termContainsInView(t.left) || termContainsInView(t.right);
    case "mask":
      return (
        (t.policy.kind === "trust" && predContainsInView(t.policy.pred)) || termContainsInView(t.of)
      );
    case "group":
    case "prune":
    case "expand":
    case "resolve":
      return termContainsInView(t.of);
  }
}

// group(key, D) @ root — filing rules per ERRATA-2 E6; annotate tags thread into entries (E7).
function evalGroup(key: GroupKey, operand: DSetResult, root: string): HView {
  const buckets = new Map<string, Map<string, HVEntry>>(); // prop -> deltaId -> entry
  const file = (prop: string, d: Delta) => {
    let bucket = buckets.get(prop);
    if (bucket === undefined) {
      bucket = new Map();
      buckets.set(prop, bucket);
    }
    if (!bucket.has(d.id)) bucket.set(d.id, { delta: d, negated: operand.negated.has(d.id) });
  };
  for (const d of operand.set) {
    if (key.kind === "const") {
      file(key.prop, d);
      continue;
    }
    for (const ptr of d.claims.pointers) {
      if (ptr.target.kind !== "entity" || ptr.target.entity.id !== root) continue;
      if (key.kind === "byTargetContext") {
        const ctx = ptr.target.entity.context;
        if (ctx !== undefined) file(ctx, d);
      } else {
        file(ptr.role, d);
      }
    }
  }
  const props = new Map<string, HVEntry[]>();
  for (const [prop, bucket] of buckets) {
    props.set(
      prop,
      [...bucket.values()].sort((a, b) => (a.delta.id < b.delta.id ? -1 : 1)),
    );
  }
  return { id: root, props };
}

export function evalTerm(
  term: Term,
  input: DeltaSet,
  root?: string,
  registry?: SchemaRegistry,
  bindings?: Bindings,
): EvalResult {
  switch (term.kind) {
    case "input":
      return dsetResult(input);
    case "select": {
      const of = expectDSet(evalTerm(term.of, input, root, registry, bindings), "select");
      const pred = resolveReflective(
        expandAliased(substituteHoles(term.pred, bindings), input, root),
        input,
        root,
        registry,
        bindings,
      );
      return dsetResult(fork(of.set, (d) => evalPred(pred, d, root)));
    }
    case "union": {
      const left = expectDSet(evalTerm(term.left, input, root, registry, bindings), "union");
      const right = expectDSet(evalTerm(term.right, input, root, registry, bindings), "union");
      return dsetResult(merge(left.set, right.set));
    }
    case "mask": {
      const of = expectDSet(evalTerm(term.of, input, root, registry, bindings), "mask");
      switch (term.policy.kind) {
        case "drop": {
          const negated = computeNegated(of.set);
          return dsetResult(fork(of.set, (d) => !negated.has(d.id)));
        }
        case "annotate": {
          const negated = computeNegated(of.set);
          return { sort: "dset", set: of.set, negated, annotated: true };
        }
        case "trust": {
          const pred = resolveReflective(
            expandAliased(substituteHoles(term.policy.pred, bindings), input, root),
            input,
            root,
            registry,
            bindings,
          );
          const negated = computeNegated(of.set, (n) => evalPred(pred, n, root));
          return dsetResult(fork(of.set, (d) => !negated.has(d.id)));
        }
      }
      break;
    }
    case "group": {
      if (root === undefined) throw new Error("group requires an ambient root entity (E9)");
      const of = expectDSet(evalTerm(term.of, input, root, registry, bindings), "group");
      return { sort: "hview", hview: evalGroup(term.key, of, root) };
    }
    case "prune": {
      const of = expectHView(evalTerm(term.of, input, root, registry, bindings), "prune");
      if (term.keep === "all") return of;
      const keep = expandStrMatch(term.keep, input, root);
      const props = new Map<string, readonly HVEntry[]>();
      for (const [prop, entries] of of.hview.props) {
        if (strMatch(keep, prop)) props.set(prop, entries);
      }
      return { sort: "hview", hview: { id: of.hview.id, props } };
    }
    case "expand": {
      const of = expectHView(evalTerm(term.of, input, root, registry, bindings), "expand");
      const role = expandStrMatch(term.role, input, root);
      const props = new Map<string, readonly HVEntry[]>();
      for (const [prop, entries] of of.hview.props) {
        props.set(
          prop,
          entries.map((e) => {
            let expanded: Map<number, HView> | undefined;
            e.delta.claims.pointers.forEach((ptr, i) => {
              // Only role-matching EntityRef pointers expand; everything else passes through
              // as written (E11, SPEC-3 §7 graceful degradation).
              if (ptr.target.kind !== "entity" || !strMatch(role, ptr.role)) return;
              const nested = evalSchema(
                term.schema,
                input,
                ptr.target.entity.id,
                registry,
                bindings,
              );
              expanded = expanded ?? new Map(e.expanded ?? []);
              expanded.set(i, nested);
            });
            return expanded === undefined ? e : { ...e, expanded };
          }),
        );
      }
      return { sort: "hview", hview: { id: of.hview.id, props } };
    }
    case "fix":
      // The invocation instruction: ambient root is set explicitly (E10); bindings, when
      // present, become the ambient hole environment for the invoked body (E15).
      return {
        sort: "hview",
        hview: evalSchema(term.schema, input, term.entity, registry, term.bindings ?? bindings),
      };
    case "resolve": {
      const of = expectHView(evalTerm(term.of, input, root, registry, bindings), "resolve");
      return { sort: "view", view: resolveView(term.schema, of.hview) };
    }
  }
}

// Evaluate a named schema at a root over the SAME delta set the enclosing evaluation received
// (SPEC-2 §4.5). Termination is the schema DAG's, enforced at registry build (SPEC-3 §3).
function evalSchema(
  ref: SchemaRefT,
  input: DeltaSet,
  root: string,
  registry: SchemaRegistry | undefined,
  bindings?: Bindings,
): HView {
  const label = ref.kind === "name" ? ref.name : `pinned:${ref.hash.slice(0, 12)}…`;
  if (registry === undefined)
    throw new Error(`schema ${label} referenced but no registry supplied (E10)`);
  const schema = registry.resolve(ref);
  if (schema === undefined) throw new Error(`unknown schema: ${label} (E10/E13)`);
  const result = evalTerm(schema.body, input, root, registry, bindings);
  if (result.sort !== "hview") {
    throw new Error(`schema ${label} body must be an HView-sort term (E10)`);
  }
  return result.hview;
}

// Canonical serialization of an evaluation result (ERRATA-2 E2, E7).
export function resultCanonicalHex(result: EvalResult): string {
  if (result.sort === "view") return viewCanonicalHex(result.view);
  if (result.sort === "hview") return hviewCanonicalHex(result.hview);
  const ids = result.set.ids().map(tstr);
  if (!result.annotated) return bytesToHex(encode(array(ids)));
  const negated = [...result.negated].sort().map(tstr);
  return bytesToHex(
    encode(
      map([
        ["ids", array(ids)],
        ["negated", array(negated)],
      ]),
    ),
  );
}
