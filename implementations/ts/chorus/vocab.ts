// The Chorus belief vocabulary. Chorus is a product built ON Rhizomatic — its vocabulary lives
// in its own namespace (`chorus.*`), never in the reserved `rhizomatic.*` (SPEC-5 §6).
//
// A belief is one delta:
//   { role: chorus.belief.about, target: EntityRef(subject, context: <attribute>) }
//   { role: chorus.belief.value, target: <primitive> | EntityRef }
//   { role: chorus.belief.kind,  target: "observation" | "fact" | "preference" | "task" }
// plus optional confidence (number) and source (string) pointers. The `about` pointer's context
// is the attribute name — the property under which the belief files at the subject (SPEC-1 §2.3).

export const CHORUS_PREFIX = "chorus";

export const ROLE_ABOUT = `${CHORUS_PREFIX}.belief.about`;
export const ROLE_VALUE = `${CHORUS_PREFIX}.belief.value`;
export const ROLE_KIND = `${CHORUS_PREFIX}.belief.kind`;
export const ROLE_CONFIDENCE = `${CHORUS_PREFIX}.belief.confidence`;
export const ROLE_SOURCE = `${CHORUS_PREFIX}.belief.source`;

export const BELIEF_KINDS = ["observation", "fact", "preference", "task"] as const;
export type BeliefKind = (typeof BELIEF_KINDS)[number];

// A decision is one delta pinning exactly what was known when an agent acted: the instant it
// resolved (asOf), the policy it held (canonical CBOR hex), and the content address of the
// view it acted on (basis). Replay re-resolves and must reproduce the basis.
export const ROLE_DECISION_ABOUT = `${CHORUS_PREFIX}.decision.about`;
export const ROLE_DECISION_INTENT = `${CHORUS_PREFIX}.decision.intent`;
export const ROLE_DECISION_ASOF = `${CHORUS_PREFIX}.decision.asOf`;
export const ROLE_DECISION_BASIS = `${CHORUS_PREFIX}.decision.basis`;
// The arrival-prefix length at decide time: derived claims carry timestamp 0 by design
// (SPEC-7 §5), so claimed time alone cannot reconstruct "what had arrived"; the prefix can.
export const ROLE_DECISION_ARRIVAL = `${CHORUS_PREFIX}.decision.arrival`;
export const ROLE_DECISION_POLICY = `${CHORUS_PREFIX}.decision.policy`;

// Trust edits are claims too: demoting an author is auditable data, never a quiet config flip.
export const ROLE_TRUST_AUTHOR = `${CHORUS_PREFIX}.trust.author`;
export const ROLE_TRUST_VERDICT = `${CHORUS_PREFIX}.trust.verdict`;
export const ROLE_TRUST_REASON = `${CHORUS_PREFIX}.trust.reason`;
