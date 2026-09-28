import { DeltaSet } from "../delta/set.js";
import { manifestMemberIds } from "../delta/manifest.js";
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

/** Verify one signed-bundle candidate before lens, guards, or quota. */
export function bundleEntryStatus(
  manifest: Delta,
  members: readonly Delta[],
  activeIds: ReadonlySet<string>,
  refusedIds: ReadonlySet<string>,
): LooseEntryStatus {
  if (verifyDelta(manifest) !== "verified") return "invalid";
  const committed = manifestMemberIds(manifest);
  if (
    committed.length === 0 ||
    members.length === 0 ||
    !members.every((member) => committed.includes(member.id))
  )
    return "invalid";
  const hasUnsigned = members.some((member) => member.sig === undefined);
  for (const member of members) {
    const verification = verifyDelta(member);
    if (verification === "invalid") return "invalid";
    if (hasUnsigned && member.claims.author !== manifest.claims.author) return "invalid";
  }
  try {
    const probe = new DeltaSet();
    for (const delta of [manifest, ...members]) probe.add(delta);
  } catch {
    return "invalid";
  }
  if ([manifest, ...members].some((delta) => refusedIds.has(delta.id))) return "refused";
  if ([manifest, ...members].every((delta) => activeIds.has(delta.id))) return "duplicate";
  return "eligible";
}
