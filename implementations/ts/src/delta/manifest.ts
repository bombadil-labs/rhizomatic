import { ownDelta } from "./own.js";
import type { Delta } from "./types.js";
import { VOCAB_PREFIX } from "./vocab.js";

/** The member ids of a manifest that is already an own copy (`ownDelta`), such as a set member. */
export function memberIdsOf(manifest: Delta): string[] {
  return manifest.claims.pointers
    .filter((p) => p.role === `${VOCAB_PREFIX}.txn.member` && p.target.kind === "delta")
    .map((p) => (p.target as { deltaRef: { delta: string } }).deltaRef.delta);
}

/** The member ids of a manifest. It reads the own copy of the manifest (`ownDelta`), once. */
export function manifestMemberIds(manifest: Delta): string[] {
  return memberIdsOf(ownDelta(manifest));
}
