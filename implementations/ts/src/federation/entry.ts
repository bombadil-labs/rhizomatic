import { memberIdsOf } from "../delta/manifest.js";
import { ownDelta, ownField } from "../delta/own.js";
import { verifyDelta } from "../delta/sign.js";
import type { Delta } from "../delta/types.js";

export type LooseEntryStatus = "invalid" | "refused" | "duplicate" | "eligible";

/** A gate's answer, and the own copies (`ownDelta`) it decided on: the manifest first. */
export interface EntryCheck {
  readonly status: LooseEntryStatus;
  readonly deltas: readonly Delta[];
}

function verificationOf(delta: Delta): ReturnType<typeof verifyDelta> {
  try {
    return verifyDelta(delta);
  } catch {
    return "invalid";
  }
}

// The own copies of the given deltas, each read once, or undefined for a delta of the wrong shape.
function owned(given: readonly unknown[]): Delta[] | undefined {
  try {
    return given.map((delta) => ownDelta(delta));
  } catch {
    return undefined;
  }
}

function listed(
  deltas: readonly Delta[],
  activeIds: ReadonlySet<string>,
  refusedIds: ReadonlySet<string>,
): LooseEntryStatus {
  if (deltas.some((delta) => refusedIds.has(delta.id))) return "refused";
  if (deltas.every((delta) => activeIds.has(delta.id))) return "duplicate";
  return "eligible";
}

/** `looseEntryStatus`, with the own copy it decided on. */
export function looseEntry(
  given: Delta,
  activeIds: ReadonlySet<string>,
  refusedIds: ReadonlySet<string>,
): EntryCheck {
  const deltas = owned([given]);
  if (deltas === undefined || verificationOf(deltas[0]!) !== "verified")
    return { status: "invalid", deltas: [] };
  return { status: listed(deltas, activeIds, refusedIds), deltas };
}

/** `bundleEntryStatus`, with the own copies it decided on: the manifest first. */
export function bundleEntry(
  givenManifest: Delta,
  givenMembers: readonly Delta[],
  activeIds: ReadonlySet<string>,
  refusedIds: ReadonlySet<string>,
): EntryCheck {
  const invalid = { status: "invalid", deltas: [] } as const;
  const deltas = owned([givenManifest, ...Array.from(givenMembers)]);
  if (deltas === undefined) return invalid;
  const [manifest, ...members] = deltas as [Delta, ...Delta[]];
  if (verificationOf(manifest) !== "verified") return invalid;
  const committed = memberIdsOf(manifest);
  if (
    committed.length === 0 ||
    members.length === 0 ||
    !members.every((member) => committed.includes(member.id))
  )
    return invalid;
  const hasUnsigned = members.some((member) => ownField(member, "sig") === undefined);
  for (const member of members) {
    if (verificationOf(member) === "invalid") return invalid;
    if (hasUnsigned && member.claims.author !== manifest.claims.author) return invalid;
  }
  return { status: listed(deltas, activeIds, refusedIds), deltas };
}

/**
 * SPEC-6 vNext §2 step 1 for a self-signed loose candidate. This is only the first gate: an
 * eligible delta still needs the lens, guards, conflict rules and quota before admission.
 * Unsigned members require separately verified signed-bundle coverage and never use this gate.
 * It reads the own copy of the delta (`ownDelta`), once.
 */
export function looseEntryStatus(
  delta: Delta,
  activeIds: ReadonlySet<string>,
  refusedIds: ReadonlySet<string>,
): LooseEntryStatus {
  return looseEntry(delta, activeIds, refusedIds).status;
}

/**
 * Verify one signed-bundle candidate before lens, guards, or quota. It reads the own copy of the
 * manifest and of each member (`ownDelta`), once.
 */
export function bundleEntryStatus(
  manifest: Delta,
  members: readonly Delta[],
  activeIds: ReadonlySet<string>,
  refusedIds: ReadonlySet<string>,
): LooseEntryStatus {
  return bundleEntry(manifest, members, activeIds, refusedIds).status;
}
