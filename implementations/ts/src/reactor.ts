// The reactor core (SPEC-4 §2-3, ERRATA-4): ingest -> validate -> persist -> index. The log is
// the truth; the four core indexes are derived and reconstructible. Materializations arrive in
// M2.2; this layer guarantees idempotence and order-convergence.

import { evalTerm, type EvalResult, type Term } from "./eval.js";
import { hviewCanonicalHex, type HView } from "./hview.js";
import { collectRefs } from "./schema.js";
import { comparePrimitives, type Pred, type ValMatch } from "./pred.js";
import { viewCanonicalHex } from "./policy.js";
import type { SchemaRegistry } from "./schema.js";
import { DeltaSet } from "./set.js";
import { verifyDelta } from "./sign.js";
import type { Delta, Primitive } from "./types.js";

export interface MaterializationChange {
  readonly materialization: string;
  readonly root: string;
  readonly newHex: string;
}

interface Materialization {
  readonly name: string;
  readonly term: Term;
  readonly roots: readonly string[];
  readonly registry: SchemaRegistry | undefined;
  readonly rootAnchored: boolean;
  readonly views: Map<string, HView>;
  readonly hexes: Map<string, string>;
  readonly supportEntities: Map<string, Set<string>>;
  evalCount: number;
}

export type IngestResult =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate" }
  | { readonly status: "rejected"; readonly reason: string };

export class Reactor {
  // The append-only log in arrival order (v0: in-memory; the log is still the truth — V2).
  private readonly log: Delta[] = [];
  private readonly set = new DeltaSet();
  // target index: EntityId -> delta ids whose pointers target that entity (SPEC-4 §3)
  private readonly targetIndex = new Map<string, Set<string>>();
  // negation index: delta id -> ids of negations targeting it (SPEC-4 §3)
  private readonly negationIndex = new Map<string, Set<string>>();
  private readonly materializations = new Map<string, Materialization>();
  // value index: role -> canonical primitive key -> { value, ids } (V1: keyed by role)
  private readonly valueIndex = new Map<
    string,
    Map<string, { value: Primitive; ids: Set<string> }>
  >();

  // Validate -> persist -> index. Idempotent by id; rejected deltas leave no trace (V3).
  ingest(delta: Delta): IngestResult {
    if (this.set.has(delta.id)) return { status: "duplicate" };
    // A present signature must verify; unsigned deltas remain legal at L1 (D9).
    if (delta.sig !== undefined && verifyDelta(delta) !== "verified") {
      return { status: "rejected", reason: "signature does not verify" };
    }
    try {
      this.set.add(delta); // recomputes the content address and runs L1 validation
    } catch (e) {
      return { status: "rejected", reason: e instanceof Error ? e.message : String(e) };
    }
    this.log.push(delta);
    this.index(delta);
    this.lastChanges = this.dispatchAndUpdate(delta);
    return { status: "accepted" };
  }

  private index(delta: Delta): void {
    for (const ptr of delta.claims.pointers) {
      switch (ptr.target.kind) {
        case "entity": {
          const id = ptr.target.entity.id;
          let bucket = this.targetIndex.get(id);
          if (bucket === undefined) {
            bucket = new Set();
            this.targetIndex.set(id, bucket);
          }
          bucket.add(delta.id);
          break;
        }
        case "delta": {
          if (ptr.role === "negates") {
            const target = ptr.target.deltaRef.delta;
            let bucket = this.negationIndex.get(target);
            if (bucket === undefined) {
              bucket = new Set();
              this.negationIndex.set(target, bucket);
            }
            bucket.add(delta.id);
          }
          break;
        }
        case "primitive": {
          let roleBucket = this.valueIndex.get(ptr.role);
          if (roleBucket === undefined) {
            roleBucket = new Map();
            this.valueIndex.set(ptr.role, roleBucket);
          }
          const key = viewCanonicalHex(ptr.target.value);
          let entry = roleBucket.get(key);
          if (entry === undefined) {
            entry = { value: ptr.target.value, ids: new Set() };
            roleBucket.set(key, entry);
          }
          entry.ids.add(delta.id);
          break;
        }
      }
    }
  }

  // --- queries over the core indexes (sorted ids — canonical enumeration order) ---

  byTarget(entityId: string): string[] {
    return [...(this.targetIndex.get(entityId) ?? [])].sort();
  }

  negationsOf(deltaId: string): string[] {
    return [...(this.negationIndex.get(deltaId) ?? [])].sort();
  }

  // Range/equality queries over primitive payloads filed under a role (V1; ValMatch per SPEC-2 §3).
  byValue(role: string, match: (v: Primitive) => boolean): string[] {
    const bucket = this.valueIndex.get(role);
    if (bucket === undefined) return [];
    const out: string[] = [];
    for (const { value, ids } of bucket.values()) {
      if (match(value)) out.push(...ids);
    }
    return out.sort();
  }

  byValueBetween(role: string, lo: Primitive, hi: Primitive): string[] {
    return this.byValue(
      role,
      (v) => comparePrimitives(v, lo) >= 0 && comparePrimitives(v, hi) <= 0,
    );
  }

  // --- the log and the set ---

  get size(): number {
    return this.set.size;
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  get(id: string): Delta | undefined {
    return this.set.get(id);
  }

  // Arrival order — a transport artifact, never consulted by evaluation (SPEC-4 §2).
  arrivalLog(): readonly Delta[] {
    return this.log;
  }

  digest(): string {
    return this.set.digest();
  }

  snapshot(): DeltaSet {
    return DeltaSet.from(this.set);
  }

  // Batch evaluation over the current set — the oracle hookup (SPEC-4 §1). Read-your-writes
  // holds trivially: ingest is synchronous, so an accepted delta is visible immediately (§6).
  eval(term: Term, root?: string, registry?: SchemaRegistry): EvalResult {
    return evalTerm(term, this.set, root, registry);
  }

  // --- materializations (SPEC-4 §4, ERRATA-4 V5) ---

  private lastChanges: MaterializationChange[] = [];

  // Register a live materialization: an HView-sort term (a function of $root) kept
  // incrementally equal to batch evaluation at each root (SPEC-4 §1).
  register(name: string, term: Term, roots: readonly string[], registry?: SchemaRegistry): void {
    if (this.materializations.has(name)) throw new Error(`duplicate materialization: ${name}`);
    const mat: Materialization = {
      name,
      term,
      roots: [...roots],
      registry,
      rootAnchored: isRootAnchored(term, registry),
      views: new Map(),
      hexes: new Map(),
      supportEntities: new Map(),
      evalCount: 0,
    };
    for (const root of mat.roots) this.refresh(mat, root);
    this.materializations.set(name, mat);
  }

  materializedHex(name: string, root: string): string | undefined {
    return this.materializations.get(name)?.hexes.get(root);
  }

  materializedView(name: string, root: string): HView | undefined {
    return this.materializations.get(name)?.views.get(root);
  }

  evalCountOf(name: string): number {
    return this.materializations.get(name)?.evalCount ?? 0;
  }

  changesFromLastIngest(): readonly MaterializationChange[] {
    return this.lastChanges;
  }

  private refresh(mat: Materialization, root: string): boolean {
    const result = evalTerm(mat.term, this.set, root, mat.registry);
    if (result.sort !== "hview") throw new Error("materialized terms must be HView-sort");
    mat.evalCount += 1;
    const hex = hviewCanonicalHex(result.hview);
    const changed = mat.hexes.get(root) !== hex;
    mat.views.set(root, result.hview);
    mat.hexes.set(root, hex);
    const entities = new Set<string>([root]);
    collectNestedIds(result.hview, entities);
    mat.supportEntities.set(root, entities);
    return changed;
  }

  // Sound dispatch (V5): over-match allowed, under-match forbidden.
  private dispatchAndUpdate(delta: Delta): MaterializationChange[] {
    const changes: MaterializationChange[] = [];
    for (const mat of this.materializations.values()) {
      for (const root of mat.roots) {
        if (!this.affects(delta, mat, root)) continue;
        if (this.refresh(mat, root)) {
          changes.push({ materialization: mat.name, root, newHex: mat.hexes.get(root)! });
        }
      }
    }
    return changes;
  }

  private affects(delta: Delta, mat: Materialization, root: string): boolean {
    if (!mat.rootAnchored) return true; // broad dispatch for non-anchored terms (V5)
    const support = mat.supportEntities.get(root) ?? new Set([root]);
    if (this.targetsSupport(delta, support)) return true;
    // negation chains: walk each negates target downward toward base data (V5)
    for (const ptr of delta.claims.pointers) {
      if (ptr.role !== "negates" || ptr.target.kind !== "delta") continue;
      if (this.chainTouchesSupport(ptr.target.deltaRef.delta, support, 0)) return true;
    }
    return false;
  }

  private targetsSupport(delta: Delta, support: ReadonlySet<string>): boolean {
    return delta.claims.pointers.some(
      (p) => p.target.kind === "entity" && support.has(p.target.entity.id),
    );
  }

  private chainTouchesSupport(id: string, support: ReadonlySet<string>, depth: number): boolean {
    if (depth > 64) return true; // adversarial-depth guard: over-match rather than recurse forever
    const target = this.set.get(id);
    if (target === undefined) return false; // unknown target: nothing materialized depends on it
    if (this.targetsSupport(target, support)) return true;
    for (const ptr of target.claims.pointers) {
      if (ptr.role !== "negates" || ptr.target.kind !== "delta") continue;
      if (this.chainTouchesSupport(ptr.target.deltaRef.delta, support, depth + 1)) return true;
    }
    return false;
  }
}

// Collect every nested (expanded) HView id, recursively — the support-entity set (V5).
function collectNestedIds(h: HView, out: Set<string>): void {
  for (const entries of h.props.values()) {
    for (const e of entries) {
      if (e.expanded === undefined) continue;
      for (const nested of e.expanded.values()) {
        out.add(nested.id);
        collectNestedIds(nested, out);
      }
    }
  }
}

// Does this predicate conjunctively REQUIRE a pointer at $root? (V5 anchoring analyzer)
function predRequiresRoot(pred: Pred): boolean {
  switch (pred.kind) {
    case "hasPointer":
      return pred.ppred.targetEntity?.kind === "root";
    case "and":
      return predRequiresRoot(pred.left) || predRequiresRoot(pred.right);
    case "or":
      return predRequiresRoot(pred.left) && predRequiresRoot(pred.right);
    default:
      return false;
  }
}

// Does every group in this pipeline sit above a root-requiring select?
function pipelineAnchored(t: Term): boolean {
  switch (t.kind) {
    case "input":
      return false;
    case "select":
      return predRequiresRoot(t.pred) || pipelineAnchored(t.of);
    case "mask":
      return pipelineAnchored(t.of);
    case "union":
      return pipelineAnchored(t.left) && pipelineAnchored(t.right);
    default:
      return false;
  }
}

function termAnchored(t: Term): boolean {
  switch (t.kind) {
    case "group":
      return pipelineAnchored(t.of);
    case "prune":
    case "expand":
    case "resolve":
      return termAnchored(t.of);
    case "fix":
      return true; // anchoring of the referenced schema is checked via the registry walk below
    default:
      return false;
  }
}

// Root anchoring across the term and every transitively referenced schema body (V5).
export function isRootAnchored(term: Term, registry: SchemaRegistry | undefined): boolean {
  if (!termAnchored(term)) return false;
  const seen = new Set<string>();
  const queue = [...collectRefs(term)];
  while (queue.length > 0) {
    const ref = queue.pop()!;
    const key = ref.kind === "name" ? `n:${ref.name}` : `h:${ref.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const schema = registry?.resolve(ref);
    if (schema === undefined) return false; // unresolvable: be conservative, dispatch broadly
    if (!termAnchored(schema.body)) return false;
    queue.push(...collectRefs(schema.body));
  }
  return true;
}

// Re-export for tests that need a ValMatch-shaped probe without re-deriving it.
export type { ValMatch };
