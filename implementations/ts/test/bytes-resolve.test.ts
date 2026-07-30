// Resolution over bytes candidates (SPEC-5 §2.1/§3/§5, D12) — the eval-bytes.json family the
// vectors README promised since 0.4, made shared truth by issue #34. Views compare in their
// SPEC-5 §5 JSON rendering; leafCanonicalHex pins that a picked bytes leaf's canonical CBOR is
// exactly the target's.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { viewCanonicalHex, viewToJson, type View } from "../src/resolution.js";
import { SchemaRegistry } from "../src/schema.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { parseTerm } from "../src/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-bytes.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
  schemas: Array<{ name: string; alg: number; body: unknown }>;
  cases: Array<{
    name: string;
    term: unknown;
    leafProp?: string;
    leafCanonicalHex?: string;
    expectedView: unknown;
    expectedCanonicalHex: string;
  }>;
};

const fixtureSet = DeltaSet.from(doc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))));
const registry = SchemaRegistry.build(
  doc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
  [],
);

describe("l1-eval bytes-resolve vectors (D12 at the resolve boundary)", () => {
  it("fixture ids match the pinned ids", () => {
    for (const d of doc.fixture.deltas) {
      expect(makeDelta(parseClaims(d.claims)).id).toBe(d.id);
    }
  });

  for (const c of doc.cases) {
    it(c.name, () => {
      const result = evalTerm(parseTerm(c.term), fixtureSet, undefined, registry);
      if (result.sort !== "view") throw new Error("expected a View result");
      expect(viewToJson(result.view)).toEqual(c.expectedView);
      expect(resultCanonicalHex(result)).toBe(c.expectedCanonicalHex);
      if (c.leafProp !== undefined && c.leafCanonicalHex !== undefined) {
        const leaf = (result.view as Record<string, View>)[c.leafProp];
        expect(leaf).toBeDefined();
        expect(viewCanonicalHex(leaf as View)).toBe(c.leafCanonicalHex);
      }
    });
  }
});
