// Chorus — memory for agents, built on Rhizomatic. Many voices, one piece.
// An agent is a keypair, a reactor, and a policy; everything else is vocabulary and ergonomics.

export {
  ChorusAgent,
  type AgentOptions,
  type BeliefInput,
  type BeliefReceipt,
  type RecallOptions,
} from "./agent.js";
export {
  ChorusAdjudicator,
  type AdjudicatorOptions,
  type Candidate,
  type Judge,
} from "./adjudicator.js";
export {
  decide,
  replayDecision,
  viewBasis,
  type Decision,
  type DecisionInput,
  type Replay,
} from "./decisions.js";
export { declareConcept, slotId } from "./concepts.js";
export {
  recallUnified,
  sameAsClass,
  sameAsPointers,
  search,
  topics,
  type SearchHit,
  type Topic,
} from "./discovery.js";
export {
  deriveSeed,
  identityIndex,
  identityPointers,
  sessionEntity,
  sessionSeed,
  userSeed,
  type AuthorIdentity,
  type SessionIdentity,
} from "./identity.js";
export {
  Librarian,
  MockEmbeddingModel,
  VOCABULARY_ROOT,
  cosine,
  type EmbeddingModel,
  type LibrarianOptions,
} from "./librarian.js";
export { latest, trustFirst, everything, disagreements } from "./policies.js";
export { SharedStore } from "./shared-store.js";
export { loadPack, restore, savePack } from "./store.js";
export {
  BELIEF_KINDS,
  CHORUS_PREFIX,
  ROLE_ABOUT,
  ROLE_CONFIDENCE,
  ROLE_KIND,
  ROLE_SOURCE,
  ROLE_VALUE,
  type BeliefKind,
} from "./vocab.js";
