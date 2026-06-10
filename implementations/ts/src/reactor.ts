// The reactor core (SPEC-4 §2-3, ERRATA-4): ingest -> validate -> persist -> index. The log is
// the truth; the four core indexes are derived and reconstructible. Materializations arrive in
// M2.2; this layer guarantees idempotence and order-convergence.

import { evalTerm, type EvalResult, type Term } from "./eval.js";
import { comparePrimitives, type ValMatch } from "./pred.js";
import { viewCanonicalHex } from "./policy.js";
import type { SchemaRegistry } from "./schema.js";
import { DeltaSet } from "./set.js";
import { verifyDelta } from "./sign.js";
import type { Delta, Primitive } from "./types.js";

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
}

// Re-export for tests that need a ValMatch-shaped probe without re-deriving it.
export type { ValMatch };
