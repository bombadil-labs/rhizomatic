// The derivation layer (SPEC-7, ERRATA-7): everything that computes is an author. Derived
// authors read materializations and write signed claims back through the ordinary ingest path.

import { computeId } from "./delta.js";
import type { HView } from "./hview.js";
import { Reactor, type IngestResult, type MaterializationChange } from "./reactor.js";
import { VOCAB_PREFIX } from "./schema-deltas.js";
import { makeNegationClaims } from "./set.js";
import { authorForSeed, signClaims, verifyDelta } from "./sign.js";
import type { Claims, Delta, Pointer } from "./types.js";

// A v0 derived function: substantive pointer lists, one per claim to emit (G1).
export type DerivedFn = (view: HView, root: string) => Pointer[][];

export interface BindingSpec {
  readonly name: string; // binding entity id
  readonly fnId: string; // fn entity id (declared identity; WASM hash later, G1)
  readonly materialization: string;
  readonly pure: boolean;
  readonly budget: number; // lifetime emission-trigger cap (G2)
  readonly emit: "append" | "supersede";
}

interface Installed {
  readonly spec: BindingSpec;
  readonly fn: DerivedFn;
  readonly seedHex: string;
  readonly author: string;
  liveEmissions: string[];
  triggerCount: number;
  suspended: boolean;
}

function provenancePointers(spec: BindingSpec, inputHex: string): Pointer[] {
  return [
    {
      role: `${VOCAB_PREFIX}.derived.by`,
      target: { kind: "entity", entity: { id: spec.fnId } },
    },
    { role: `${VOCAB_PREFIX}.derived.from`, target: { kind: "primitive", value: inputHex } },
    {
      role: `${VOCAB_PREFIX}.derived.under`,
      target: { kind: "entity", entity: { id: spec.name } },
    },
  ];
}

// Build the full claims for one emission — the exact recipe replay verification re-runs (G5).
export function derivedClaims(
  spec: BindingSpec,
  author: string,
  substantive: readonly Pointer[],
  inputHex: string,
): Claims {
  // timestamp 0: pure output must be a function of (fn, input hash) only (G3).
  return {
    timestamp: 0,
    author,
    pointers: [...substantive, ...provenancePointers(spec, inputHex)],
  };
}

export class DerivationHost {
  private readonly bindings = new Map<string, Installed>();

  constructor(readonly reactor: Reactor) {}

  // Installation is an assertion: a signed rdb.derived.binds delta (SPEC-7 §3).
  install(spec: BindingSpec, fn: DerivedFn, seedHex: string): string {
    if (this.bindings.has(spec.name)) throw new Error(`duplicate binding: ${spec.name}`);
    const author = authorForSeed(seedHex);
    const binds = signClaims(
      {
        timestamp: 0,
        author,
        pointers: [
          {
            role: `${VOCAB_PREFIX}.derived.binds`,
            target: { kind: "entity", entity: { id: spec.fnId, context: "bindings" } },
          },
          { role: `${VOCAB_PREFIX}.derived.author`, target: { kind: "primitive", value: author } },
        ],
      },
      seedHex,
    );
    this.reactor.ingest(binds);
    this.bindings.set(spec.name, {
      spec,
      fn,
      seedHex,
      author,
      liveEmissions: [],
      triggerCount: 0,
      suspended: false,
    });
    return author;
  }

  isSuspended(name: string): boolean {
    return this.bindings.get(name)?.suspended ?? false;
  }

  authorOf(name: string): string | undefined {
    return this.bindings.get(name)?.author;
  }

  // The write-back loop (G2): ingest, then drain triggers until quiescent.
  ingest(delta: Delta): IngestResult {
    const result = this.reactor.ingest(delta);
    if (result.status !== "accepted") return result;
    this.drain([...this.reactor.changesFromLastIngest()]);
    return result;
  }

  private drain(pending: MaterializationChange[]): void {
    let depth = 0;
    while (pending.length > 0 && depth < 32) {
      depth += 1;
      const next: MaterializationChange[] = [];
      for (const change of pending) {
        for (const b of this.bindings.values()) {
          if (b.spec.materialization !== change.materialization) continue;
          next.push(...this.trigger(b, change));
        }
      }
      pending = next;
    }
  }

  private emitSigned(b: Installed, claims: Claims): MaterializationChange[] {
    const signed = signClaims(claims, b.seedHex);
    const result = this.reactor.ingest(signed);
    if (result.status === "rejected") throw new Error("derived emission rejected");
    return result.status === "accepted" ? [...this.reactor.changesFromLastIngest()] : [];
  }

  private trigger(b: Installed, change: MaterializationChange): MaterializationChange[] {
    if (b.suspended) return [];
    // The default non-reentrancy guard (SPEC-7 §6): skip when the trigger is entirely our own.
    const own = change.responsibleDeltaIds.every(
      (id) => this.reactor.get(id)?.claims.author === b.author,
    );
    if (own) return [];
    if (b.triggerCount >= b.spec.budget) {
      b.suspended = true;
      // Divergence becomes an observable event, not a melted reactor (G2).
      return this.emitSigned(b, {
        timestamp: 0,
        author: b.author,
        pointers: [
          {
            role: `${VOCAB_PREFIX}.derived.suspended`,
            target: { kind: "entity", entity: { id: b.spec.name, context: "suspensions" } },
          },
        ],
      });
    }
    b.triggerCount += 1;
    const view = this.reactor.materializedView(change.materialization, change.root);
    if (view === undefined) return [];
    const out: MaterializationChange[] = [];
    if (b.spec.emit === "supersede") {
      for (const prior of b.liveEmissions) {
        out.push(...this.emitSigned(b, makeNegationClaims(b.author, 0, prior)));
      }
      b.liveEmissions = [];
    }
    for (const substantive of b.fn(view, change.root)) {
      const claims = derivedClaims(b.spec, b.author, substantive, change.newHex);
      const signed = signClaims(claims, b.seedHex);
      const result = this.reactor.ingest(signed);
      if (result.status === "accepted") {
        b.liveEmissions.push(signed.id);
        out.push(...this.reactor.changesFromLastIngest());
      }
    }
    return out;
  }
}

// Pure-replay verification (SPEC-7 §4, G5): recompute the emission from (fn, input view) and
// compare content addresses; the signature must also verify.
export function verifyPureDerivation(
  emitted: Delta,
  spec: BindingSpec,
  fn: DerivedFn,
  view: HView,
  root: string,
  viewHex: string,
): boolean {
  if (verifyDelta(emitted) !== "verified") return false;
  const fromPtr = emitted.claims.pointers.find(
    (p) => p.role === `${VOCAB_PREFIX}.derived.from` && p.target.kind === "primitive",
  );
  if (fromPtr?.target.kind !== "primitive" || fromPtr.target.value !== viewHex) return false;
  // Re-derive ids: the replayed claims must content-address to the emitted delta's id.
  const ids = fn(view, root).map((substantive) =>
    computeId(derivedClaims(spec, emitted.claims.author, substantive, viewHex)),
  );
  return ids.includes(emitted.id);
}
