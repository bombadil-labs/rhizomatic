// Store-level reads that an index can accelerate. Today the reverse-adjacency question — "who
// points AT this entity?" — is answered by scanning the whole surviving set (gql's inbound-index
// build, the recall relevance-select). At fleet scale that scan is the cost the SQLite tier
// exists to remove, and it is the SAME read a closure-scoped federation pull will issue
// (spec/11-federation-as-query.NOTE.md §4): the by-target index does double duty.
//
// `backlinks` is written once over the `Store` seam: if the backend offers `deltasByTarget` it
// asks the index; otherwise it scans the full stored set. Both branches run the identical
// per-delta extractor, so the index only ever NARROWS the candidate set — the results are
// byte-for-byte the same, which is exactly what the conformance/perf test pins.

import type { Delta } from "@rhizomatic/core";
import type { Store } from "./store-tier.js";
import { ROLE_ABOUT, ROLE_VALUE } from "./vocab.js";

// One reverse edge: a belief whose VALUE references `target`, surfaced from the target's side.
export interface Backlink {
  readonly source: string; // the entity the belief is ABOUT (the edge's origin)
  readonly attribute: string; // the attribute it was filed under at the source
  readonly role: string; // the pointer role that crossed to the target
  readonly target: string; // the entity referenced (what we asked about)
  readonly deltaId: string;
  readonly author: string;
  readonly timestamp: number;
}

// Every belief whose value points at `target`, newest first. Uses the by-target index when the
// backend has one; falls back to a full-store scan otherwise (the JSONL tier's behavior today).
export function backlinks(store: Store, target: string): Backlink[] {
  const candidates =
    store.deltasByTarget !== undefined
      ? store.deltasByTarget(target)
      : store.deltasSince(new Set());
  const out: Backlink[] = [];
  for (const d of candidates) {
    const edge = valueEdgeTo(d, target);
    if (edge !== undefined) out.push(edge);
  }
  return out.sort((a, b) => b.timestamp - a.timestamp || (a.deltaId < b.deltaId ? -1 : 1));
}

// The per-delta extractor, shared by both branches: a belief is a backlink to `target` iff its
// VALUE pointer references `target` and it carries an `about` subject + attribute.
function valueEdgeTo(d: Delta, target: string): Backlink | undefined {
  let about: { id: string; attribute: string } | undefined;
  let pointsAtTarget = false;
  for (const p of d.claims.pointers) {
    if (
      p.role === ROLE_ABOUT &&
      p.target.kind === "entity" &&
      p.target.entity.context !== undefined
    ) {
      about = { id: p.target.entity.id, attribute: p.target.entity.context };
    } else if (
      p.role === ROLE_VALUE &&
      p.target.kind === "entity" &&
      p.target.entity.id === target
    ) {
      pointsAtTarget = true;
    }
  }
  if (!pointsAtTarget || about === undefined) return undefined;
  return {
    source: about.id,
    attribute: about.attribute,
    role: ROLE_VALUE,
    target,
    deltaId: d.id,
    author: d.claims.author,
    timestamp: d.claims.timestamp,
  };
}
