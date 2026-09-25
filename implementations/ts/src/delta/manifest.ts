import type { Delta } from "./types.js";
import { VOCAB_PREFIX } from "./vocab.js";

export function manifestMemberIds(manifest: Delta): string[] {
  return manifest.claims.pointers
    .filter((p) => p.role === `${VOCAB_PREFIX}.txn.member` && p.target.kind === "delta")
    .map((p) => (p.target as { deltaRef: { delta: string } }).deltaRef.delta);
}
