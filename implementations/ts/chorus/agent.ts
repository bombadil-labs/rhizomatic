// The Chorus agent handle: a keypair, a reactor, and a policy. Beliefs are claims it signed;
// its worldview is a lens it chose; its trust in others is data it can edit; its history is an
// append-only log it cannot quietly rewrite — and neither can anyone else (docs/agents.html).
//
// Everything here composes substrate primitives: Peer (keypair + reactor + offered lens +
// admission, SPEC-6), terms (SPEC-2), policies (SPEC-5), negation (SPEC-1 §7). Chorus adds
// vocabulary and ergonomics, never semantics.

import {
  DeltaSet,
  Peer,
  evalTerm,
  makeNegationClaims,
  parsePolicy,
  parseTerm,
  signClaims,
  syncBoth,
  type Delta,
  type Pointer,
  type Pred,
  type Primitive,
  type Term,
  type View,
} from "../src/index.js";
import { latest } from "./policies.js";
import {
  ROLE_ABOUT,
  ROLE_CONFIDENCE,
  ROLE_KIND,
  ROLE_SOURCE,
  ROLE_VALUE,
  type BeliefKind,
} from "./vocab.js";

export interface BeliefInput {
  readonly about: string; // subject entity id
  readonly attribute: string; // the property this belief files under at the subject
  readonly value: Primitive | { readonly entity: string; readonly context?: string };
  readonly kind?: BeliefKind; // default: "observation"
  readonly confidence?: number; // the author's own calibration, in [0, 1]
  readonly source?: string; // evidence note
  readonly timestamp?: number; // claimed time; defaults to the agent's clock
}

export interface RecallOptions {
  readonly attribute?: string; // narrow to one property
  readonly asOf?: number; // resolve over claims (and negations!) at or before this instant
  readonly policy?: unknown; // policy-term JSON (SPEC-5 §7); defaults to the agent's own
}

// One candidate belief with its full receipt — what `explain` returns.
export interface BeliefReceipt {
  readonly deltaId: string;
  readonly author: string;
  readonly timestamp: number;
  readonly signed: boolean;
  readonly negated: boolean; // true = retracted, kept visible (audit view)
  readonly value?: Primitive | string; // entity values render as their id
  readonly kind?: string;
  readonly confidence?: number;
  readonly source?: string;
}

export interface AgentOptions {
  readonly name: string;
  readonly seedHex: string; // ed25519 seed — the agent IS this keypair
  readonly policy?: unknown; // policy-term JSON; default latest()
  readonly lens?: Term; // what this agent offers peers (SPEC-6 §4); default everything
  readonly admission?: Pred; // what this agent accepts; default everything that verifies
  readonly clock?: () => number; // injectable for deterministic tests
}

export class ChorusAgent {
  readonly name: string;
  readonly peer: Peer;
  readonly author: string;
  policy: unknown;
  private readonly clock: () => number;

  constructor(opts: AgentOptions) {
    this.name = opts.name;
    this.peer = new Peer(opts.seedHex, opts.lens, opts.admission);
    this.author = this.peer.author;
    this.policy = opts.policy ?? latest();
    this.clock = opts.clock ?? (() => Date.now());
    // The seed stays inside Peer; Chorus keeps a signer for negations authored off-peer.
    this.seedHex = opts.seedHex;
  }
  private readonly seedHex: string;

  // --- writing -----------------------------------------------------------------------------------

  // Assert a belief: one signed delta, ingested read-your-writes.
  assert(b: BeliefInput): Delta {
    const pointers: Pointer[] = [
      {
        role: ROLE_ABOUT,
        target: { kind: "entity", entity: { id: b.about, context: b.attribute } },
      },
      {
        role: ROLE_VALUE,
        target:
          typeof b.value === "object"
            ? {
                kind: "entity",
                entity:
                  b.value.context === undefined
                    ? { id: b.value.entity }
                    : { id: b.value.entity, context: b.value.context },
              }
            : { kind: "primitive", value: b.value },
      },
      { role: ROLE_KIND, target: { kind: "primitive", value: b.kind ?? "observation" } },
    ];
    if (b.confidence !== undefined) {
      pointers.push({ role: ROLE_CONFIDENCE, target: { kind: "primitive", value: b.confidence } });
    }
    if (b.source !== undefined) {
      pointers.push({ role: ROLE_SOURCE, target: { kind: "primitive", value: b.source } });
    }
    return this.peer.authorClaims({ timestamp: b.timestamp ?? this.clock(), pointers });
  }

  // Retract a belief: a signed negation APPENDS — history stays intact (SPEC-1 §7).
  retract(deltaId: string, reason?: string, timestamp?: number): Delta {
    const claims = makeNegationClaims(this.author, timestamp ?? this.clock(), deltaId, reason);
    const signed = signClaims(claims, this.seedHex);
    const result = this.peer.reactor.ingest(signed);
    if (result.status === "rejected") throw new Error(`own retraction rejected: ${result.reason}`);
    return signed;
  }

  // --- reading -----------------------------------------------------------------------------------

  // The resolved view of an entity under a policy: one truth, per THIS reader (SPEC-5).
  recall(entity: string, opts: RecallOptions = {}): View {
    const term = this.recallTerm(entity, opts, this.policy);
    const result = evalTerm(parseTerm(term), this.snapshot(), entity);
    if (result.sort !== "view") throw new Error("recall must resolve to a View");
    return unwrapBeliefs(result.view);
  }

  // The superposition itself — every surviving claim, no judgment applied.
  recallAll(entity: string, opts: Omit<RecallOptions, "policy"> = {}): View {
    return this.recall(entity, { ...opts, policy: ALL_POLICY });
  }

  // Why does the view say what it says? Every candidate (retracted ones tagged, never hidden),
  // with author, id, timestamp, signature — the receipts (SPEC-4 §7's explain, Chorus-shaped).
  explain(entity: string, attribute?: string, opts: { asOf?: number } = {}): BeliefReceipt[] {
    // Audit idiom: group(mask(annotate, …)) directly — group's filing scopes to the root (E6),
    // and no DSet operator may sit between mask(annotate) and group (E14).
    const base = asOfBase(opts.asOf);
    const grouped = {
      op: "group",
      key: "byTargetContext",
      in: { op: "mask", policy: "annotate", in: base },
    };
    const term =
      attribute === undefined ? grouped : { op: "prune", keep: { exact: attribute }, in: grouped };
    const result = evalTerm(parseTerm(term), this.snapshot(), entity);
    if (result.sort !== "hview") throw new Error("explain must produce an HView");
    const receipts: BeliefReceipt[] = [];
    for (const [, entries] of [...result.hview.props.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      for (const e of entries) {
        receipts.push(receiptOf(e.delta, e.negated === true));
      }
    }
    return receipts;
  }

  // --- trust -------------------------------------------------------------------------------------

  // Trust is a lens: editing it re-resolves the world without touching history (SPEC-5 §3).
  setPolicy(policy: unknown): void {
    parsePolicy(policy); // validate now, fail loud
    this.policy = policy;
  }

  // --- federation & persistence ------------------------------------------------------------------

  sync(other: ChorusAgent): void {
    syncBoth(this.peer, other.peer);
  }

  snapshot(): DeltaSet {
    return this.peer.reactor.snapshot();
  }

  digest(): string {
    return this.peer.reactor.digest();
  }

  // Ingest an external set (e.g. unpacked from disk). Returns how many were accepted.
  importSet(set: DeltaSet): { accepted: number; duplicate: number; rejected: number } {
    let accepted = 0;
    let duplicate = 0;
    let rejected = 0;
    for (const d of set) {
      const r = this.peer.reactor.ingest(d);
      if (r.status === "accepted") accepted += 1;
      else if (r.status === "duplicate") duplicate += 1;
      else rejected += 1;
    }
    return { accepted, duplicate, rejected };
  }

  // --- term construction ---------------------------------------------------------------------------

  private recallTerm(entity: string, opts: RecallOptions, fallbackPolicy: unknown): unknown {
    const base = asOfBase(opts.asOf);
    // mask BEFORE select (ERRATA-3 S5): negations target deltas, not the entity, so a
    // relevance-select-first idiom would exclude them before mask could suppress anything.
    const masked = { op: "mask", policy: "drop", in: base };
    const selected = {
      op: "select",
      pred: { hasPointer: { targetEntity: entity } },
      in: masked,
    };
    const grouped = { op: "group", key: "byTargetContext", in: selected };
    const shaped =
      opts.attribute === undefined
        ? grouped
        : { op: "prune", keep: { exact: opts.attribute }, in: grouped };
    return { op: "resolve", policy: opts.policy ?? fallbackPolicy, in: shaped };
  }
}

const ALL_POLICY = { default: { all: { order: { byTimestamp: "asc" } } } };

// The Chorus presentation profile. A belief delta carries value + kind (+ confidence, source)
// pointers, so SPEC-5 §2.1 renders its candidate as a { role: rendered } object. Presentation
// may reshape, never re-adjudicate (SPEC-5 §5): once the policy has picked a candidate, unwrap
// it to the belief's payload — the value pointer; from the value-entity's own perspective, the
// subject (`about`). Receipts (`explain`) keep the full candidate.
function unwrapBeliefs(view: View): View {
  if (Array.isArray(view)) return view.map(unwrapBeliefs);
  if (typeof view !== "object") return view;
  const o = view as Record<string, View>;
  for (const key of Object.keys(o)) o[key] = unwrapCandidate(o[key]!);
  return o;
}

function unwrapCandidate(v: View): View {
  if (Array.isArray(v)) return v.map(unwrapCandidate);
  if (typeof v !== "object") return v;
  const o = v as Record<string, View>;
  if (ROLE_VALUE in o) return o[ROLE_VALUE]!;
  if (ROLE_ABOUT in o) return o[ROLE_ABOUT]!;
  return v;
}

// Time scoping: filtering the OPERAND scopes mask too — a negation claimed after T does not
// suppress at T. Retraction appends; the past stays resolvable as it was (claimed time, SPEC-1 §6).
function asOfBase(asOf: number | undefined): unknown {
  return asOf === undefined
    ? "input"
    : {
        op: "select",
        pred: { match: { field: "timestamp", cmp: "lte", const: asOf } },
        in: "input",
      };
}

function receiptOf(delta: Delta, negated: boolean): BeliefReceipt {
  let value: Primitive | string | undefined;
  let kind: string | undefined;
  let confidence: number | undefined;
  let source: string | undefined;
  for (const ptr of delta.claims.pointers) {
    if (ptr.role === ROLE_VALUE) {
      value =
        ptr.target.kind === "primitive"
          ? ptr.target.value
          : ptr.target.kind === "entity"
            ? ptr.target.entity.id
            : ptr.target.deltaRef.delta;
    } else if (ptr.role === ROLE_KIND && ptr.target.kind === "primitive") {
      kind = String(ptr.target.value);
    } else if (ptr.role === ROLE_CONFIDENCE && ptr.target.kind === "primitive") {
      if (typeof ptr.target.value === "number") confidence = ptr.target.value;
    } else if (ptr.role === ROLE_SOURCE && ptr.target.kind === "primitive") {
      source = String(ptr.target.value);
    }
  }
  return {
    deltaId: delta.id,
    author: delta.claims.author,
    timestamp: delta.claims.timestamp,
    signed: delta.sig !== undefined,
    negated,
    ...(value === undefined ? {} : { value }),
    ...(kind === undefined ? {} : { kind }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(source === undefined ? {} : { source }),
  };
}
