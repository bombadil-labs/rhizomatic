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
  priorOrder?: "reverseId";
  refused?: string[];
  sender?: string;
  units: Array<{ loose: string; mutation?: "forgeSignature" } | { bundle: string[] }>;
  guards: Array<"requiresGrant" | "denyValue" | "expectedPeer" | "sortedPrior">;
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
      const priorDeltas = c.prior.map((label) => named.get(label)!);
      if (c.priorOrder === "reverseId")
        priorDeltas.sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
      const prior = DeltaSet.from(priorDeltas);
      const seen: string[] = [];
      const seenOrder: string[] = [];
      const guards: CandidateGuard<{ grantId: string }>[] = c.guards.map((rule) => (context) => {
        const label = labelOf(context.candidate);
        seen.push(label);
        seenOrder.push(`${rule}:${label}`);
        if (rule === "requiresGrant")
          return label !== "act" || context.admittedBefore.has(context.policyState.grantId);
        if (rule === "denyValue") return label !== "deny";
        if (rule === "sortedPrior") {
          const iterated = [...context.admittedBefore].map((delta) => delta.id);
          const copied = [...context.admittedBefore.toDeltaSet()].map((delta) => delta.id);
          const ascending = iterated.every((id, i) => i === 0 || iterated[i - 1]! <= id);
          return (
            ascending &&
            iterated.join() === context.admittedBefore.ids().join() &&
            copied.join() === iterated.join()
          );
        }
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

it("isolates guard mutation from later guards, caller deltas, and returned candidates", () => {
  const grant = named.get("grant")!;
  const act = named.get("act")!;
  const prior = DeltaSet.from([grant]);
  const policyState = { allow: true };
  const result = preflightTransfer([{ kind: "loose", delta: act }], {
    admittedBefore: prior,
    refusedIds: new Set(),
    sendingPeerId: "sender-A",
    receivingPeerId: "receiver-B",
    arrivedAt: 100,
    policyState,
    guards: [
      ({ candidate, admittedBefore }) => {
        (candidate.claims as { author: string }).author = "tampered";
        ([...admittedBefore][0]!.claims as { author: string }).author = "tampered";
        const standalone = admittedBefore.toDeltaSet();
        ([...standalone][0]!.claims as { author: string }).author = "tampered";
        return true;
      },
      ({ candidate, admittedBefore, policyState: state }) =>
        candidate.claims.author === author &&
        [...admittedBefore][0]!.claims.author === author &&
        state.allow,
    ],
  });
  expect(result[0]?.status).toBe("eligible");
  expect(result[0]?.unit.kind === "loose" && result[0].unit.delta.claims.author).toBe(author);
  expect(act.claims.author).toBe(author);
  expect(grant.claims.author).toBe(author);
  expect(policyState.allow).toBe(true);
});

it("keeps application policy classes and their methods available to guards", () => {
  class PolicyState {
    constructor(readonly roster: DeltaSet) {}
    allows(id: string): boolean {
      return this.roster.has(id);
    }
  }
  const policyState = new PolicyState(DeltaSet.from([named.get("grant")!]));
  const result = preflightTransfer([{ kind: "loose", delta: named.get("act")! }], {
    admittedBefore: new DeltaSet(),
    refusedIds: new Set(),
    sendingPeerId: "sender-A",
    receivingPeerId: "receiver-B",
    arrivedAt: 100,
    policyState,
    guards: [({ policyState: state }) => state.allows(named.get("grant")!.id)],
  });
  expect(result[0]?.status).toBe("eligible");
});
