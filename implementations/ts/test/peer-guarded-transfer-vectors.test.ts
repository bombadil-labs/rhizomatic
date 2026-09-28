import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DeltaSet } from "../src/delta/set.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import type { Delta } from "../src/delta/types.js";
import {
  preflightTransfer,
  type CandidateGuard,
  type TransferUnit,
} from "../src/federation/preflight.js";
import { makeManifestClaims } from "../src/reactor/reactor.js";

interface Case {
  name: string;
  prior: string[];
  refused?: string[];
  sender?: string;
  units: Array<{ loose: string; mutation?: "forgeSignature" } | { bundle: string[] }>;
  guards: Array<"requiresGrant" | "denyValue" | "expectedPeer">;
  expected: string[];
  fresh: string[][];
  checked: string[];
  checkedOrder?: string[];
}
const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/peer/guarded-transfer.json"), "utf8"),
) as { cases: Case[] };
const seed = "01".repeat(32);
const author = authorForSeed(seed);
const labels = ["grant", "act", "revoke", "deny"];
const named = new Map<string, Delta>(
  labels.map((label) => [
    label,
    signClaims(
      {
        timestamp: 1,
        validFrom: 1,
        author,
        pointers: [{ role: "note", target: { kind: "primitive", value: label } }],
      },
      seed,
    ),
  ]),
);
const byId = new Map([...named].map(([label, delta]) => [delta.id, label]));

function labelOf(delta: Delta): string {
  return byId.get(delta.id) ?? "manifest";
}

describe("shared SPEC-6 guarded transfer vectors", () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const units: TransferUnit[] = c.units.map((description) => {
        if ("loose" in description) {
          const original = named.get(description.loose)!;
          return {
            kind: "loose",
            delta:
              description.mutation === "forgeSignature"
                ? { ...original, sig: "00".repeat(64) }
                : original,
          };
        }
        const members = description.bundle.map((label) => named.get(label)!);
        return {
          kind: "bundle",
          manifest: signClaims(
            makeManifestClaims(
              author,
              2,
              members.map((d) => d.id),
            ),
            seed,
          ),
          members,
        };
      });
      const prior = DeltaSet.from(c.prior.map((label) => named.get(label)!));
      const seen: string[] = [];
      const seenOrder: string[] = [];
      const guards: CandidateGuard<{ grantId: string }>[] = c.guards.map((rule) => (context) => {
        const label = labelOf(context.candidate);
        seen.push(label);
        seenOrder.push(`${rule}:${label}`);
        if (rule === "requiresGrant")
          return label !== "act" || context.admittedBefore.has(context.policyState.grantId);
        if (rule === "denyValue") return label !== "deny";
        return context.sendingPeerId === "sender-A" && context.receivingPeerId === "receiver-B";
      });
      const result = preflightTransfer(units, {
        admittedBefore: prior,
        refusedIds: new Set((c.refused ?? []).map((label) => named.get(label)!.id)),
        sendingPeerId: c.sender ?? "sender-A",
        receivingPeerId: "receiver-B",
        arrivedAt: 100,
        policyState: { grantId: named.get("grant")!.id },
        guards,
      });
      expect(result.map((unit) => unit.status)).toEqual(c.expected);
      expect(result.map((unit) => unit.freshIds.map((id) => byId.get(id) ?? "manifest"))).toEqual(
        c.fresh,
      );
      expect(seen).toEqual(c.checked);
      if (c.checkedOrder !== undefined) expect(seenOrder).toEqual(c.checkedOrder);
      for (const item of result) {
        if (item.status !== "eligible") expect(item.freshIds).toEqual([]);
        else expect(item.freshIds.every((id) => !prior.has(id))).toBe(true);
      }
      expect(prior.has(named.get("grant")!.id)).toBe(c.prior.includes("grant"));
    });
  }
});
