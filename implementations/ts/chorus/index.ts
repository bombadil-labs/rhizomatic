// Chorus — memory for agents, built on Rhizomatic. Many voices, one piece.
// An agent is a keypair, a reactor, and a policy; everything else is vocabulary and ergonomics.

export {
  ChorusAgent,
  type AgentOptions,
  type BeliefInput,
  type BeliefReceipt,
  type RecallOptions,
} from "./agent.js";
export { latest, trustFirst, everything, disagreements } from "./policies.js";
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
