import { DeltaSet } from "../delta/set.js";
import { verifyDelta } from "../delta/sign.js";
import type { Delta } from "../delta/types.js";

export type LooseEntryStatus = "invalid" | "refused" | "duplicate" | "eligible";

/**
 * SPEC-6 vNext §2 step 1 for a self-signed loose candidate. This is only the first gate: an
 * eligible delta still needs the lens, guards, conflict rules and quota before admission.
 * Unsigned members require separately verified signed-bundle coverage and never use this gate.
 */
export function looseEntryStatus(
  delta: Delta,
  activeIds: ReadonlySet<string>,
  refusedIds: ReadonlySet<string>,
): LooseEntryStatus {
  if (verifyDelta(delta) !== "verified") return "invalid";
  try {
    new DeltaSet().add(delta);
  } catch {
    return "invalid";
  }
  if (refusedIds.has(delta.id)) return "refused";
  if (activeIds.has(delta.id)) return "duplicate";
  return "eligible";
}
