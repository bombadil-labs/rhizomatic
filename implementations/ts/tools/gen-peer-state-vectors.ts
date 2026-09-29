// Regenerate the byte-exact private peer-state images in the shared SPEC-6 vector.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseClaims } from "../src/json-profile.js";
import { DeltaSet } from "../src/set.js";
import { encodePeerState } from "../src/federation/peer-state.js";
import type { Delta } from "../src/types.js";

const root = resolve(import.meta.dirname, "../../..");
const fixture = JSON.parse(
  readFileSync(resolve(root, "vectors/principal/evidence.json"), "utf8"),
) as {
  deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }>;
};
const path = resolve(root, "vectors/peer/state.json");
const vector = JSON.parse(readFileSync(path, "utf8")) as {
  cases: Array<{
    peerId: string;
    admitted: string[];
    cursor: { lastSequence: number; lastTransfer: number };
    arrivals: Array<{ id: string; at: number; sequence: number; transfer: number; sender: string }>;
    refused: string[];
    expectedHex: string;
  }>;
};
const named = new Map<string, Delta>(
  fixture.deltas.map((row) => [
    row.name,
    { id: row.id, claims: parseClaims(row.claims), ...(row.sig ? { sig: row.sig } : {}) },
  ]),
);
for (const c of vector.cases) {
  c.expectedHex = Buffer.from(
    encodePeerState({
      peerId: c.peerId,
      admitted: DeltaSet.from(c.admitted.map((name) => named.get(name)!)),
      cursor: c.cursor,
      arrivals: c.arrivals.map((row) => ({ ...row, id: named.get(row.id)!.id })),
      refusedIds: new Set(c.refused.map((name) => named.get(name)!.id)),
    }),
  ).toString("hex");
}
writeFileSync(path, `${JSON.stringify(vector, null, 2)}\n`);
