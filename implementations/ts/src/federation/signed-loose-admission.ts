// Internal ordinary-only admission path. A classifier keeps erasure candidates out of this path.
import type { Delta } from "../delta/types.js";
import {
  decodeDurablePeerState,
  planPermanentCommit,
  writeDurablePeerState,
  type DurablePeerState,
} from "./durable-state.js";
import { planOrdinaryQuota, type OrdinaryQuotaUnit } from "./ordinary-quota.js";
import { preflightTransfer, type CandidateGuard } from "./preflight.js";

export type SignedLooseOutcomeStatus =
  | "invalid"
  | "refused"
  | "duplicate"
  | "guard-rejected"
  | "unsupported-erasure"
  | "admitted"
  | "quota-skipped"
  | "dependency-pruned";

export interface SignedLooseOutcome {
  readonly id: string;
  readonly status: SignedLooseOutcomeStatus;
  readonly reason?: string;
}

export interface SignedLooseTransferInput<State> {
  readonly offered: readonly Delta[];
  readonly sendingPeerId: string;
  readonly arrivedAt: number;
  readonly capacity: number;
  readonly policyState: Readonly<State>;
  readonly guards: readonly CandidateGuard<State>[];
  /** Receiver policy classification, evaluated only for verified, guard-passing candidates. */
  readonly isErasureCandidate: (delta: Delta) => boolean;
}

export interface SignedLooseTransferPlan {
  readonly state: DurablePeerState;
  readonly outcomes: readonly SignedLooseOutcome[];
  readonly admittedIds: readonly string[];
}

function negates(delta: Delta, id: string): boolean {
  return delta.claims.pointers.some(
    (pointer) =>
      pointer.role === "negates" &&
      pointer.target.kind === "delta" &&
      pointer.target.deltaRef.delta === id,
  );
}

/** Steps 1, 3, 5, and 6 for signed loose ordinary candidates, with no lens or conflict rule. */
export function planSignedLooseOrdinaryTransfer<State>(
  before: DurablePeerState,
  input: SignedLooseTransferInput<State>,
): SignedLooseTransferPlan {
  const active = new Set(before.base.admitted.ids());
  const guarded = preflightTransfer(
    input.offered.map((delta) => ({ kind: "loose" as const, delta })),
    {
      admittedBefore: before.base.admitted,
      refusedIds: before.base.refusedIds,
      sendingPeerId: input.sendingPeerId,
      receivingPeerId: before.base.peerId,
      arrivedAt: input.arrivedAt,
      policyState: input.policyState,
      guards: input.guards,
    },
  );
  const stableOffered = guarded.map((unit) => {
    if (unit.unit.kind !== "loose") throw new Error("signed loose admission: unexpected bundle");
    return unit.unit.delta;
  });
  const candidates = new Map<string, Delta>();
  const classified = new Map<string, boolean>();
  const statuses: SignedLooseOutcomeStatus[] = guarded.map((unit, i) => {
    if (unit.status !== "eligible") return unit.status;
    const delta = stableOffered[i]!;
    if (!classified.has(delta.id))
      classified.set(delta.id, input.isErasureCandidate(structuredClone(delta)));
    if (classified.get(delta.id)) return "unsupported-erasure";
    candidates.set(delta.id, delta);
    return "admitted";
  });
  const ordinary: OrdinaryQuotaUnit[] = [...candidates.values()].map((delta) => ({
    key: delta.id,
    rank: delta.id,
    freshIds: [delta.id],
    requires: [...candidates.values()]
      .filter((other) => negates(other, delta.id))
      .map((other) => other.id),
  }));
  const quota = planOrdinaryQuota(ordinary, active, new Set(), new Set(), input.capacity);
  const admitted = new Set(quota.admittedIds);
  const skipped = new Set(quota.skippedKeys);
  const pruned = new Set(quota.prunedKeys);
  const quotaStatus = (id: string): SignedLooseOutcomeStatus => {
    if (admitted.has(id)) return "admitted";
    if (skipped.has(id)) return "quota-skipped";
    if (pruned.has(id)) return "dependency-pruned";
    throw new Error("signed loose admission: eligible id has no quota outcome");
  };
  const outcomes: SignedLooseOutcome[] = stableOffered.map((delta, i) => ({
    id: delta.id,
    status: statuses[i] === "admitted" ? quotaStatus(delta.id) : statuses[i]!,
    ...(guarded[i]!.reason === undefined ? {} : { reason: guarded[i]!.reason }),
  }));
  const state = planPermanentCommit(before, {
    additions: quota.admittedIds.map((id) => candidates.get(id)!),
    erasures: [],
    quotaCharge: quota.charged,
    at: input.arrivedAt,
    sender: input.sendingPeerId,
  });
  return { state, outcomes, admittedIds: quota.admittedIds };
}

/** Single-writer file operation. The expected bytes are also the planning snapshot. */
export function admitSignedLooseOrdinaryTransfer<State>(
  path: string,
  expectedPrior: Uint8Array,
  peerId: string,
  input: SignedLooseTransferInput<State>,
) {
  const before = decodeDurablePeerState(expectedPrior, peerId);
  const plan = planSignedLooseOrdinaryTransfer(before, input);
  const write = writeDurablePeerState(path, plan.state, expectedPrior);
  return { ...plan, write };
}
