import { DeltaSet } from "../delta/set.js";
import type { Delta } from "../delta/types.js";
import { bundleEntryStatus, looseEntryStatus, type LooseEntryStatus } from "./entry.js";

export type TransferUnit =
  | { readonly kind: "loose"; readonly delta: Delta }
  | { readonly kind: "bundle"; readonly manifest: Delta; readonly members: readonly Delta[] };

/** Membership and read access to the admitted set before this transfer. Returned deltas are copies. */
export interface ReadonlyAdmittedSet extends Iterable<Delta> {
  has(id: string): boolean;
  get(id: string): Delta | undefined;
  readonly size: number;
  ids(): string[];
  /** Create an independent mutable copy for APIs that require DeltaSet. Costs O(size). */
  toDeltaSet(): DeltaSet;
}

export interface GuardContext<State> {
  readonly candidate: Delta;
  readonly sendingPeerId: string;
  readonly receivingPeerId: string;
  readonly admittedBefore: ReadonlyAdmittedSet;
  readonly arrivedAt: number;
  readonly policyState: Readonly<State>;
}

export type GuardDecision =
  | boolean
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };
export type CandidateGuard<State> = (context: GuardContext<State>) => GuardDecision;
export type GuardedUnitStatus = LooseEntryStatus | "guard-rejected";

export interface PreflightContext<State> {
  readonly admittedBefore: DeltaSet;
  readonly refusedIds: ReadonlySet<string>;
  readonly sendingPeerId: string;
  readonly receivingPeerId: string;
  readonly arrivedAt: number;
  /** Application-owned state. Guards must treat it as read-only. */
  readonly policyState: Readonly<State>;
  readonly guards: readonly CandidateGuard<State>[];
}

export interface GuardedUnit {
  readonly unit: TransferUnit;
  readonly status: GuardedUnitStatus;
  readonly freshIds: readonly string[];
  /** The first rejecting guard's application-owned explanation, when supplied. */
  readonly reason?: string;
}

/**
 * Stage steps 1 and 3 for a transfer without a subscribed lens. All units verify before any guard
 * runs; guards see one read-only view of the same pre-transfer set. Conflict, erasure, quota, and durable
 * commit stages must still decide what lands. This result is not an admission receipt.
 */
export function preflightTransfer<State>(
  units: readonly TransferUnit[],
  context: PreflightContext<State>,
): GuardedUnit[] {
  const {
    admittedBefore,
    refusedIds,
    sendingPeerId,
    receivingPeerId,
    arrivedAt,
    policyState,
    guards,
  } = context;
  if (sendingPeerId.length === 0 || receivingPeerId.length === 0)
    throw new Error("peer ids must not be empty");
  if (!Number.isFinite(arrivedAt)) throw new Error("arrival time must be finite");
  // Application guards are called after verification. Keep candidates and the admitted snapshot
  // independent of caller-owned objects. Policy state is supplied by the application, whose
  // guards are required by the contract to treat it as read-only.
  const stableUnits = units.map((unit) => structuredClone(unit));
  const stableBefore = admittedBefore.copy();
  const admittedView: ReadonlyAdmittedSet = Object.freeze({
    has: (id: string) => stableBefore.has(id),
    get: (id: string) => {
      const delta = stableBefore.get(id);
      return delta === undefined ? undefined : structuredClone(delta);
    },
    get size() {
      return stableBefore.size;
    },
    ids: () => stableBefore.ids(),
    toDeltaSet: () =>
      DeltaSet.from(stableBefore.ids().map((id) => structuredClone(stableBefore.get(id)!))),
    *[Symbol.iterator]() {
      for (const id of stableBefore.ids()) yield structuredClone(stableBefore.get(id)!);
    },
  });
  const activeIds = new Set([...stableBefore].map((delta) => delta.id));
  const verified = stableUnits.map((unit) => {
    const status =
      unit.kind === "loose"
        ? looseEntryStatus(unit.delta, activeIds, refusedIds)
        : bundleEntryStatus(unit.manifest, unit.members, activeIds, refusedIds);
    const candidates = unit.kind === "loose" ? [unit.delta] : [unit.manifest, ...unit.members];
    const fresh = new Map<string, Delta>();
    if (status === "eligible") {
      for (const candidate of candidates) {
        if (!activeIds.has(candidate.id) && !fresh.has(candidate.id))
          fresh.set(candidate.id, candidate);
      }
    }
    return { unit, status, fresh };
  });
  return verified.map(({ unit, status, fresh }) => {
    if (status !== "eligible") return { unit, status, freshIds: [] };
    for (const candidate of fresh.values()) {
      for (const guard of guards) {
        const decision = guard({
          candidate: structuredClone(candidate),
          sendingPeerId,
          receivingPeerId,
          admittedBefore: admittedView,
          arrivedAt,
          policyState,
        });
        if (decision === false) return { unit, status: "guard-rejected", freshIds: [] };
        if (decision !== true && !decision.ok) {
          if (typeof decision.reason !== "string")
            throw new Error("candidate guard: refusal reason must be text");
          return {
            unit,
            status: "guard-rejected",
            freshIds: [],
            ...(decision.reason ? { reason: decision.reason } : {}),
          };
        }
      }
    }
    return { unit, status, freshIds: [...fresh.keys()] };
  });
}
