// The reactor core (SPEC-4 §2-3, ERRATA-4): ingest -> validate -> persist -> index. The log is
// the truth; the four core indexes are derived and reconstructible. Materializations arrive in
// M2.2; this layer guarantees idempotence and order-convergence.

import { evalTerm, termContainsInView, type EvalResult, type Term } from "./eval.js";
import { array, encode } from "./cbor.js";
import { bytesToHex } from "./hash.js";
import { hvEntryToCbor, hviewCanonicalHex, type HView } from "./hview.js";
import { collectRefs } from "./schema.js";
import { comparePrimitives, type Pred, type ValMatch } from "./pred.js";
import { viewCanonicalHex } from "./resolution.js";
import type { SchemaRegistry } from "./schema.js";
import { DeltaSet } from "./set.js";
import { VOCAB_PREFIX } from "./schema-deltas.js";
import { verifyDelta } from "./sign.js";
import type { Delta, Primitive } from "./types.js";

// A change event carries: root, affected property paths, responsible delta ids, new content
// hash (SPEC-4 §5).
export interface MaterializationChange {
  readonly materialization: string;
  readonly root: string;
  readonly changedProps: readonly string[];
  readonly responsibleDeltaIds: readonly string[];
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
  readonly propHexes: Map<string, Map<string, string>>;
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
    for (const cb of this.rawSubscribers) cb(delta);
    this.lastChanges = this.dispatchAndUpdate([delta]);
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
        case "bytes":
          break; // bytes are invisible to value predicates (SPEC-2 §3) — not value-indexed
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
      propHexes: new Map(),
      supportEntities: new Map(),
      evalCount: 0,
    };
    for (const root of mat.roots) void this.refresh(mat, root);
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

  private refresh(mat: Materialization, root: string): string[] | undefined {
    const result = evalTerm(mat.term, this.set, root, mat.registry);
    if (result.sort !== "hview") throw new Error("materialized terms must be HView-sort");
    mat.evalCount += 1;
    const hex = hviewCanonicalHex(result.hview);
    const changed = mat.hexes.get(root) !== hex;
    const newPropHexes = propHexesOf(result.hview);
    const changedProps = changed
      ? diffProps(mat.propHexes.get(root) ?? new Map(), newPropHexes)
      : undefined;
    mat.views.set(root, result.hview);
    mat.hexes.set(root, hex);
    mat.propHexes.set(root, newPropHexes);
    const entities = new Set<string>([root]);
    collectNestedIds(result.hview, entities);
    mat.supportEntities.set(root, entities);
    return changedProps;
  }

  // Sound dispatch (V5): over-match allowed, under-match forbidden.
  private dispatchAndUpdate(deltas: readonly Delta[]): MaterializationChange[] {
    const responsible = deltas.map((d) => d.id);
    const changes: MaterializationChange[] = [];
    for (const mat of this.materializations.values()) {
      for (const root of mat.roots) {
        if (!deltas.some((d) => this.affects(d, mat, root))) continue;
        const changedProps = this.refresh(mat, root);
        if (changedProps !== undefined) {
          changes.push({
            materialization: mat.name,
            root,
            changedProps,
            responsibleDeltaIds: responsible,
            newHex: mat.hexes.get(root)!,
          });
        }
      }
    }
    for (const c of changes) {
      for (const cb of this.matSubscribers.get(c.materialization) ?? []) cb(c);
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

  // --- subscriptions (SPEC-4 §5) ---

  private readonly rawSubscribers: Array<(d: Delta) => void> = [];
  private readonly matSubscribers = new Map<string, Array<(c: MaterializationChange) => void>>();

  // The raw stream: every accepted delta (federation relays, audit, mirrors).
  subscribeRaw(cb: (delta: Delta) => void): void {
    this.rawSubscribers.push(cb);
  }

  // Change events on a registered materialization's HyperViews.
  subscribe(materialization: string, cb: (change: MaterializationChange) => void): void {
    const list = this.matSubscribers.get(materialization);
    if (list === undefined) this.matSubscribers.set(materialization, [cb]);
    else list.push(cb);
  }

  // --- atomic batch ingestion (SPEC-1 §9, SPEC-4 §6) ---

  // Manifest-keyed atomic ingestion: validate everything first; all members become visible to
  // dispatch in one step, or none do. The transaction vocabulary supplies the batch boundary;
  // the reactor supplies the courtesy.
  ingestBundle(manifest: Delta, members: readonly Delta[]): IngestResult {
    const fresh = [...members, manifest].filter((d) => !this.set.has(d.id));
    // Validate all before admitting any (atomic acceptance).
    for (const d of fresh) {
      if (d.sig !== undefined && verifyDelta(d) !== "verified") {
        return { status: "rejected", reason: `bundle member ${d.id}: signature does not verify` };
      }
      try {
        const probe = new DeltaSet();
        probe.add(d);
      } catch (e) {
        return {
          status: "rejected",
          reason: `bundle member ${d.id}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    // The manifest must commit to every supplied member by content address (SPEC-1 §9).
    const committed = new Set(manifestMemberIds(manifest));
    for (const m of members) {
      if (!committed.has(m.id)) {
        return { status: "rejected", reason: `member ${m.id} is not claimed by the manifest` };
      }
    }
    if (fresh.length === 0) return { status: "duplicate" };
    for (const d of fresh) {
      this.set.add(d);
      this.log.push(d);
      this.index(d);
      for (const cb of this.rawSubscribers) cb(d);
    }
    this.lastChanges = this.dispatchAndUpdate(fresh);
    return { status: "accepted" };
  }

  // Completeness is verifiable, not enforced (SPEC-1 §9): a hash check.
  holdsAllMembers(manifestId: string): boolean {
    const manifest = this.set.get(manifestId);
    if (manifest === undefined) return false;
    return manifestMemberIds(manifest).every((id) => this.set.has(id));
  }
}

// --- the rdb.txn vocabulary (SPEC-1 §9) ---

export function makeManifestClaims(
  author: string,
  timestamp: number,
  memberIds: readonly string[],
  options?: { readonly prior?: string; readonly intent?: string },
): import("./types.js").Claims {
  const pointers: import("./types.js").Pointer[] = memberIds.map((id) => ({
    role: `${VOCAB_PREFIX}.txn.member`,
    target: { kind: "delta", deltaRef: { delta: id } },
  }));
  if (options?.prior !== undefined) {
    pointers.push({
      role: `${VOCAB_PREFIX}.txn.prior`,
      target: { kind: "delta", deltaRef: { delta: options.prior } },
    });
  }
  if (options?.intent !== undefined) {
    pointers.push({
      role: `${VOCAB_PREFIX}.txn.intent`,
      target: { kind: "primitive", value: options.intent },
    });
  }
  return { timestamp, author, pointers };
}

export function manifestMemberIds(manifest: Delta): string[] {
  return manifest.claims.pointers
    .filter((p) => p.role === `${VOCAB_PREFIX}.txn.member` && p.target.kind === "delta")
    .map((p) => (p.target as { deltaRef: { delta: string } }).deltaRef.delta);
}

// Per-property canonical hexes, for change-path diffing (SPEC-4 §5).
function propHexesOf(h: HView): Map<string, string> {
  const out = new Map<string, string>();
  for (const [prop, entries] of h.props) {
    out.set(prop, bytesToHex(encode(array(entries.map(hvEntryToCbor)))));
  }
  return out;
}

function diffProps(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [prop, hex] of after) if (before.get(prop) !== hex) changed.add(prop);
  for (const prop of before.keys()) if (!after.has(prop)) changed.add(prop);
  return [...changed].sort();
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
// A reflective term (SPEC-2 §3.1) is never root-anchored: its reflected set may change with any
// ingest, so it takes the broad-dispatch path (SPEC-4 §4.1, correctness first).
export function isRootAnchored(term: Term, registry: SchemaRegistry | undefined): boolean {
  if (!termAnchored(term) || termContainsInView(term)) return false;
  const seen = new Set<string>();
  const queue = [...collectRefs(term)];
  while (queue.length > 0) {
    const ref = queue.pop()!;
    const key = ref.kind === "name" ? `n:${ref.name}` : `h:${ref.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const schema = registry?.resolve(ref);
    if (schema === undefined) return false; // unresolvable: be conservative, dispatch broadly
    if (!termAnchored(schema.body) || termContainsInView(schema.body)) return false;
    queue.push(...collectRefs(schema.body));
  }
  return true;
}

// Re-export for tests that need a ValMatch-shaped probe without re-deriving it.
export type { ValMatch };
