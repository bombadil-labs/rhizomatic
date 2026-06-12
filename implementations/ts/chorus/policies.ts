// Standard Chorus resolution policies, as policy-term JSON (SPEC-5 §7). A policy is the lens an
// agent reads through — data it holds and can edit, never a property of the substrate.

// Last claim wins, ties broken by the structural lexById tiebreak.
export function latest(): unknown {
  return { default: { pick: { order: { byTimestamp: "desc" } } } };
}

// Trust-ranked: the first listed author's claim wins; unlisted authors rank last (SPEC-5 §3).
export function trustFirst(authors: readonly string[]): unknown {
  return { default: { pick: { order: { byAuthorRank: [...authors] } } } };
}

// Every surviving value, oldest first — the superposition made visible.
export function everything(): unknown {
  return { default: { all: { order: { byTimestamp: "asc" } } } };
}

// Values only where ≥2 distinct claims survive — the disagreement dashboard.
export function disagreements(): unknown {
  return { default: { conflicts: { order: { byTimestamp: "desc" } } } };
}
