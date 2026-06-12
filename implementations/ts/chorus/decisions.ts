// DECISION REPLAY, first-class. A decision is one signed delta pinning exactly what was known
// when an agent acted: the instant (asOf), the policy held (canonical CBOR, inline), and the
// content address of the resolved view (basis). Replay re-resolves at that instant — including
// claims that were retracted afterwards, because retraction appends — and verifies the basis.

import {
  DeltaSet,
  contentAddress,
  decode,
  encode,
  jsonToCbor,
  cborToJson,
  type Delta,
  type Pointer,
  type View,
} from "../src/index.js";
import type { BeliefReceipt, ChorusAgent } from "./agent.js";
import {
  ROLE_DECISION_ABOUT,
  ROLE_DECISION_ARRIVAL,
  ROLE_DECISION_ASOF,
  ROLE_DECISION_BASIS,
  ROLE_DECISION_INTENT,
  ROLE_DECISION_POLICY,
} from "./vocab.js";

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));

// The basis of a view: the content address of its canonical CBOR. Replay must reproduce it.
export function viewBasis(view: View): string {
  return contentAddress(encode(jsonToCbor(view)));
}

export interface DecisionInput {
  readonly about: string; // the entity the decision concerns
  readonly intent: string; // what the agent is about to do, in its own words
  readonly attribute?: string; // narrow the resolved view, if the decision hinges on one property
  readonly timestamp?: number;
}

export interface Decision {
  readonly delta: Delta; // the signed decision record
  readonly view: View; // what the agent saw when it acted
  readonly asOf: number;
  readonly basis: string;
}

// Act on the current view and RECORD the act: resolve under the agent's policy at now, pin
// (instant, policy, basis) into one signed delta filed at the subject under chorus.decisions.
export function decide(agent: ChorusAgent, input: DecisionInput): Decision {
  const asOf = input.timestamp ?? agent.now();
  const opts = input.attribute === undefined ? { asOf } : { asOf, attribute: input.attribute };
  const view = agent.recall(input.about, opts);
  const basis = viewBasis(view);
  const policyHex = toHex(encode(jsonToCbor(agent.policy)));
  const pointers: Pointer[] = [
    {
      // Contextless on purpose (SPEC-1 §2.3): the decision references its subject without
      // filing as a property of it — recall views stay beliefs-only; decisions are found by
      // selecting on this role.
      role: ROLE_DECISION_ABOUT,
      target: { kind: "entity", entity: { id: input.about } },
    },
    { role: ROLE_DECISION_INTENT, target: { kind: "primitive", value: input.intent } },
    { role: ROLE_DECISION_ASOF, target: { kind: "primitive", value: asOf } },
    { role: ROLE_DECISION_BASIS, target: { kind: "primitive", value: basis } },
    { role: ROLE_DECISION_POLICY, target: { kind: "primitive", value: policyHex } },
    // Derived claims carry timestamp 0 by design (SPEC-7 §5), so claimed time alone cannot
    // reconstruct what had ARRIVED when the agent acted; the arrival-prefix length can —
    // the same recipe replay verification uses (SPEC-7 §4).
    {
      role: ROLE_DECISION_ARRIVAL,
      target: { kind: "primitive", value: agent.peer.reactor.arrivalLog().length },
    },
  ];
  if (input.attribute !== undefined) {
    pointers.push({
      role: `${ROLE_DECISION_ABOUT}.attribute`,
      target: { kind: "primitive", value: input.attribute },
    });
  }
  const delta = agent.record({ timestamp: asOf, pointers });
  return { delta, view, asOf, basis };
}

export interface Replay {
  readonly view: View; // the world as it resolved at the pinned instant, under the pinned policy
  readonly verified: boolean; // recomputed basis matches the recorded one
  readonly asOf: number;
  readonly intent: string;
  readonly about: string;
  // Every candidate visible at the instant, with retractions that happened AFTERWARDS marked:
  // `negated` reflects NOW, `view` reflects THEN. Both facts stay queryable forever.
  readonly receipts: readonly BeliefReceipt[];
  readonly retractedSince: readonly string[]; // delta ids visible then, negated since
}

// Replay a recorded decision: reconstruct the exact belief set it resolved, under the exact
// policy it held — the incident review as a query, not an archaeology dig.
export function replayDecision(agent: ChorusAgent, decisionDeltaId: string): Replay {
  const d = agent.peer.reactor.get(decisionDeltaId);
  if (d === undefined) throw new Error(`unknown decision: ${decisionDeltaId}`);
  let about: string | undefined;
  let intent: string | undefined;
  let asOf: number | undefined;
  let basis: string | undefined;
  let policyHex: string | undefined;
  let attribute: string | undefined;
  let arrival: number | undefined;
  for (const ptr of d.claims.pointers) {
    if (ptr.role === ROLE_DECISION_ABOUT && ptr.target.kind === "entity") {
      about = ptr.target.entity.id;
    } else if (ptr.role === ROLE_DECISION_INTENT && ptr.target.kind === "primitive") {
      intent = String(ptr.target.value);
    } else if (ptr.role === ROLE_DECISION_ASOF && ptr.target.kind === "primitive") {
      if (typeof ptr.target.value === "number") asOf = ptr.target.value;
    } else if (ptr.role === ROLE_DECISION_BASIS && ptr.target.kind === "primitive") {
      basis = String(ptr.target.value);
    } else if (ptr.role === ROLE_DECISION_POLICY && ptr.target.kind === "primitive") {
      policyHex = String(ptr.target.value);
    } else if (ptr.role === ROLE_DECISION_ARRIVAL && ptr.target.kind === "primitive") {
      if (typeof ptr.target.value === "number") arrival = ptr.target.value;
    } else if (ptr.role === `${ROLE_DECISION_ABOUT}.attribute` && ptr.target.kind === "primitive") {
      attribute = String(ptr.target.value);
    }
  }
  if (
    about === undefined ||
    intent === undefined ||
    asOf === undefined ||
    basis === undefined ||
    policyHex === undefined
  ) {
    throw new Error(`delta ${decisionDeltaId} is not a well-formed chorus decision`);
  }
  const policy = cborToJson(decode(fromHex(policyHex)));
  // What had ARRIVED when the agent acted: the pinned prefix of the append-only log. Claims
  // (and negations, and timestamp-0 derived verdicts) that arrived later are absent THEN by
  // construction; evaluation over the prefix set itself stays order-blind.
  const prefix =
    arrival === undefined
      ? agent.snapshot()
      : DeltaSet.from(agent.peer.reactor.arrivalLog().slice(0, arrival));
  const view = agent.recall(about, {
    asOf,
    policy,
    over: prefix,
    ...(attribute === undefined ? {} : { attribute }),
  });
  const receiptsThen = agent.explain(about, attribute, { asOf, over: prefix });
  const receiptsNow = agent.explain(about, attribute);
  const negatedNow = new Set(receiptsNow.filter((r) => r.negated).map((r) => r.deltaId));
  const receipts = receiptsThen.map((r) =>
    negatedNow.has(r.deltaId) ? { ...r, negated: true } : r,
  );
  const retractedSince = receiptsThen
    .filter((r) => !r.negated && negatedNow.has(r.deltaId))
    .map((r) => r.deltaId);
  return {
    view,
    verified: viewBasis(view) === basis,
    asOf,
    intent,
    about,
    receipts,
    retractedSince,
  };
}
