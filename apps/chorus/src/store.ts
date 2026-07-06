// Pack-to-disk persistence (v0-sufficient): an agent's whole world serializes to one
// deterministic, self-verifying pack (SPEC-8). Same set ⇒ same bytes ⇒ same packId. The core
// stays pure; file I/O lives here, at the Chorus edge.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { packId, packSet, unpackSet, type DeltaSet } from "@bombadil/rhizomatic";
import type { ChorusAgent } from "./agent.js";

// Write the agent's world to disk. Returns the pack's content address.
export function savePack(agent: ChorusAgent, filePath: string): string {
  const bytes = packSet(agent.snapshot());
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  return packId(bytes);
}

// Read a pack from disk. Rehydration is self-verifying: a corrupted pack FAILS (SPEC-8 §4).
export function loadPack(filePath: string): DeltaSet {
  return unpackSet(new Uint8Array(readFileSync(filePath)));
}

// Restore an agent's world from disk: load, verify, ingest.
export function restore(
  agent: ChorusAgent,
  filePath: string,
): { accepted: number; duplicate: number; rejected: number } {
  return agent.importSet(loadPack(filePath));
}
