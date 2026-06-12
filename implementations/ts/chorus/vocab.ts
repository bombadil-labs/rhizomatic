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
