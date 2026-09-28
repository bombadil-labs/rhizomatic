import { DeltaSet } from "../delta/set.js";
import type { Delta } from "../delta/types.js";
import { bundleEntryStatus, looseEntryStatus, type LooseEntryStatus } from "./entry.js";

export type TransferUnit =
  | { readonly kind: "loose"; readonly delta: Delta }
  | { readonly kind: "bundle"; readonly manifest: Delta; readonly members: readonly Delta[] };

export interface GuardContext<State> {
  readonly candidate: Delta;
  readonly sendingPeerId: string;
  readonly receivingPeerId: string;
  readonly admittedBefore: DeltaSet;
  readonly arrivedAt: number;
  readonly policyState: Readonly<State>;
}

export type CandidateGuard<State> = (context: GuardContext<State>) => boolean;
export type GuardedUnitStatus = LooseEntryStatus | "guard-rejected";

export interface PreflightContext<State> {
  readonly admittedBefore: DeltaSet;
  readonly refusedIds: ReadonlySet<string>;
  readonly sendingPeerId: string;
  readonly receivingPeerId: string;
  readonly arrivedAt: number;
  /** A structured-cloneable snapshot; guards cannot mutate the caller's state. */
  readonly policyState: Readonly<State>;
  readonly guards: readonly CandidateGuard<State>[];
}

export interface GuardedUnit {
  readonly unit: TransferUnit;
  readonly status: GuardedUnitStatus;
  readonly freshIds: readonly string[];
}

/**
 * Stage steps 1 and 3 for a transfer without a subscribed lens. All units verify before any guard
 * runs; guards see only a copy of the same pre-transfer set. Conflict, erasure, quota, and durable
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
  // Application guards are called after verification. Keep the candidates, admitted snapshot,
  // and policy state independent of caller-owned objects and of one another's mutations.
  const stableUnits = units.map((unit) => structuredClone(unit));
  const stableBefore = DeltaSet.from([...admittedBefore].map((delta) => structuredClone(delta)));
  const stablePolicyState = structuredClone(policyState);
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
        if (
          !guard({
            candidate: structuredClone(candidate),
            sendingPeerId,
            receivingPeerId,
            admittedBefore: DeltaSet.from([...stableBefore].map((delta) => structuredClone(delta))),
            arrivedAt,
            policyState: structuredClone(stablePolicyState),
          })
        ) {
          return { unit, status: "guard-rejected", freshIds: [] };
        }
      }
    }
    return { unit, status, freshIds: [...fresh.keys()] };
  });
}
