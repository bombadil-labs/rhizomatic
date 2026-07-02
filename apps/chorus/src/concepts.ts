// Concept declaration helpers (SPEC-9 §2): concepts with oriented slots, declared as ordinary
// signed claims. A slot's identity is its entity id; `<concept>#<name>` is convention only.

import { VOCAB_PREFIX, type Delta, type Pointer } from "@rhizomes/core";
import type { ChorusAgent } from "./agent.js";

const ROLE_SLOT = `${VOCAB_PREFIX}.alias.slot`;
const ROLE_CONCEPT = `${VOCAB_PREFIX}.alias.concept`;
const CTX_CONCEPT = `${VOCAB_PREFIX}.alias.concept`;
const CTX_SLOTS = `${VOCAB_PREFIX}.alias.slots`;

export function slotId(concept: string, slotName: string): string {
  return `${concept}#${slotName}`;
}

// Declare a concept's slots: one declaration delta per slot, signed by the declaring agent.
export function declareConcept(
  agent: ChorusAgent,
  concept: string,
  slotNames: readonly string[],
  timestamp?: number,
): Delta[] {
  return slotNames.map((name) => {
    const pointers: Pointer[] = [
      {
        role: ROLE_SLOT,
        target: { kind: "entity", entity: { id: slotId(concept, name), context: CTX_CONCEPT } },
      },
      {
        role: ROLE_CONCEPT,
        target: { kind: "entity", entity: { id: concept, context: CTX_SLOTS } },
      },
    ];
    return agent.record({ timestamp: timestamp ?? agent.now(), pointers });
  });
}
