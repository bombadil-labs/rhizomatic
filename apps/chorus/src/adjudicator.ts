// The adjudicator: judgment as an AUTHOR (SPEC-7), not a config option. It watches a belief
// materialization on an agent's reactor and emits one signed verdict per subject via KEYED
// EMISSION (SPEC-7 §5) — new testimony supersedes only that subject's prior verdict, by a
// self-authored negation. Its verdicts are ordinary claims: rankable by policy, negatable by
// humans, replay-verifiable against the exact input view it saw.

import {
  VOCAB_PREFIX,
  parseTerm,
  verifyPureDerivation,
  type BindingSpec,
  type DerivedFn,
  type Delta,
  type HView,
  type Pointer,
  type Primitive,
} from "@rhizomes/core";
import type { ChorusAgent } from "./agent.js";
import { CHORUS_PREFIX, ROLE_ABOUT, ROLE_KIND, ROLE_VALUE } from "./vocab.js";

// What the judge sees: the surviving candidates for one attribute of one subject.
export interface Candidate {
  readonly author: string;
  readonly value: Primitive;
  readonly timestamp: number;
}

// The judge: pure, total over its candidates. Returns the verdict value, or undefined for
// "no verdict on this subject" (nothing is emitted, priors stay live).
export type Judge = (candidates: readonly Candidate[], subject: string) => Primitive | undefined;

export interface AdjudicatorOptions {
  readonly name: string; // binding entity id — also names the materialization
  readonly seedHex: string; // the adjudicator's OWN keypair: its own track record
  readonly subjects: readonly string[]; // the roots it watches (v0: explicit)
  readonly attribute: string; // the belief property it adjudicates
  readonly verdictAttribute: string; // where its verdict files at the subject
  readonly judge: Judge;
  readonly budget?: number; // lifetime trigger cap (SPEC-7 §6); default 256
}

// The canonical belief view the adjudicator watches: everything pointing at the root,
// negations dropped, filed by target context (mask BEFORE select, ERRATA-3 S5).
const beliefBody = parseTerm({
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
});

export class ChorusAdjudicator {
  readonly author: string;
  readonly spec: BindingSpec;
  private readonly fn: DerivedFn;
  private readonly agent: ChorusAgent;

  constructor(agent: ChorusAgent, opts: AdjudicatorOptions) {
    this.agent = agent;
    const materialization = `${CHORUS_PREFIX}.adjudicator.${opts.name}`;
    agent.peer.reactor.register(materialization, beliefBody, opts.subjects);
    this.fn = makeVerdictFn(opts.attribute, opts.verdictAttribute, opts.judge);
    this.spec = {
      name: opts.name,
      fnId: `fn:${opts.name}`,
      materialization,
      pure: true,
      budget: opts.budget ?? 256,
      emit: { keyed: [opts.verdictAttribute] },
    };
    this.author = agent.ensureHost().install(this.spec, this.fn, opts.seedHex);
  }

  suspended(): boolean {
    return this.agent.ensureHost().isSuspended(this.spec.name);
  }

  // Pure-replay verification (SPEC-7 §4): re-run the judge on the pinned input view, recompute
  // the content address, compare. Returns false for tampered emissions — or for a stale input
  // (the materialization moved on), which honest callers re-pin first.
  verifyVerdict(verdict: Delta, subject: string): boolean {
    const view = this.agent.peer.reactor.materializedView(this.spec.materialization, subject);
    if (view === undefined) return false;
    const fromPtr = verdict.claims.pointers.find(
      (p) => p.role === `${VOCAB_PREFIX}.derived.from` && p.target.kind === "primitive",
    );
    if (fromPtr?.target.kind !== "primitive") return false;
    return verifyPureDerivation(
      verdict,
      this.spec,
      this.fn,
      view,
      subject,
      String(fromPtr.target.value),
    );
  }
}

// Lift a Judge into the DerivedFn shape: read the watched attribute's surviving candidates
// out of the HView, judge them, and emit one verdict belief filed at the subject.
function makeVerdictFn(attribute: string, verdictAttribute: string, judge: Judge): DerivedFn {
  return (view: HView, root: string): Pointer[][] => {
    const entries = view.props.get(attribute) ?? [];
    const candidates: Candidate[] = [];
    for (const e of entries) {
      for (const ptr of e.delta.claims.pointers) {
        if (ptr.role === ROLE_VALUE && ptr.target.kind === "primitive") {
          candidates.push({
            author: e.delta.claims.author,
            value: ptr.target.value,
            timestamp: e.delta.claims.timestamp,
          });
        }
      }
    }
    const verdict = judge(candidates, root);
    if (verdict === undefined) return [];
    return [
      [
        {
          role: ROLE_ABOUT,
          target: { kind: "entity", entity: { id: root, context: verdictAttribute } },
        },
        { role: ROLE_VALUE, target: { kind: "primitive", value: verdict } },
        { role: ROLE_KIND, target: { kind: "primitive", value: "fact" } },
      ],
    ];
  };
}
