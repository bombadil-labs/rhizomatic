import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/delta/json-profile.js";
import { canonicalBytes, computeId } from "../src/delta/delta.js";
import { bytesToHex } from "../src/delta/hash.js";
import type { Claims } from "../src/delta/types.js";
import {
  materializationDescriptionClaims,
  materializationFields,
  readMaterializationDescription,
  type MaterializationDescriptionKind,
  type MaterializationVerb,
} from "../src/command-data/materialization-codec.js";
interface Fixture {
  id: string;
  kind: MaterializationDescriptionKind;
  verb?: MaterializationVerb;
  claims: unknown;
  expectedClaimsHex: string;
  expectedRoles: string[];
}
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../vectors/materialization/command-descriptions.json", import.meta.url),
    "utf8",
  ),
) as { positives: Fixture[]; negatives: { id: string; base: string; mutation: string }[] };
function delta(claims: Claims) {
  return { id: computeId(claims), claims };
}
const assertionCorpusId = createHash("sha256")
  .update(
    readFileSync(
      new URL("../../../vectors/materialization/command-descriptions.json", import.meta.url),
    ),
  )
  .digest("hex");
function recordAssertions(group: string, f: { id: string }, before: number): void {
  console.log(
    "materialization-m2-assertion:" +
      JSON.stringify({
        corpus: "command-descriptions",
        corpusId: assertionCorpusId,
        group,
        id: f.id,
        assertions: expect.getState().assertionCalls - before,
      }),
  );
}
describe("materialization descriptions shared independent claims oracle", () => {
  for (const f of vectors.positives)
    it(f.id, () => {
      const before = expect.getState().assertionCalls;
      const claims = parseClaims(f.claims),
        d = delta(claims);
      expect(bytesToHex(canonicalBytes(claims))).toBe(f.expectedClaimsHex);
      const fields = readMaterializationDescription(d, f.verb);
      const written = materializationDescriptionClaims(claims.author, 1000, f.kind, fields);
      expect(bytesToHex(canonicalBytes(written))).toBe(f.expectedClaimsHex);
      expect(written.pointers.map((p) => p.role)).toEqual(f.expectedRoles);
      expect(
        materializationFields(delta({ ...claims, pointers: [...claims.pointers].reverse() })),
      ).toEqual(fields);
      expect(
        readMaterializationDescription(
          delta({ ...claims, pointers: [...claims.pointers].reverse() }),
          f.verb,
        ),
      ).toEqual(fields);
      recordAssertions("positives", f, before);
    });
  for (const n of vectors.negatives)
    it(n.id, () => {
      const before = expect.getState().assertionCalls;
      const f = vectors.positives.find((f) => f.id === n.base)!;
      const claims = parseClaims(f.claims),
        ps = [...claims.pointers];
      if (n.mutation === "extra-role")
        ps.push({
          role: "rhizomatic.materialization.extra",
          target: { kind: "primitive", value: true },
        });
      if (n.mutation === "duplicate-receiver")
        ps.push(ps.find((p) => p.role.endsWith("receiver"))!);
      if (n.mutation === "reference-context") {
        const i = ps.findIndex((p) => p.role.endsWith("evidence"));
        ps[i] = {
          ...ps[i]!,
          target: {
            kind: "delta",
            deltaRef: { delta: "1e20" + "03".repeat(32), context: "secret" },
          },
        };
      }
      if (n.mutation === "unknown-name") {
        const i = ps.findIndex((p) => p.role.endsWith("name"));
        ps[i] = {
          ...ps[i]!,
          target: { kind: "entity", entity: { id: "rhizomatic.materialization.install" } },
        };
      }
      if (n.mutation === "wrong-mime") {
        const i = ps.findIndex((p) => p.role.endsWith("spec"));
        ps[i] = {
          ...ps[i]!,
          target: { kind: "bytes", mime: "text/plain", value: new Uint8Array([0xa0]) },
        };
      }
      expect(() =>
        readMaterializationDescription(delta({ ...claims, pointers: ps }), f.verb),
      ).toThrow();
      recordAssertions("negatives", n, before);
    });
});
