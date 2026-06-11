import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { SchemaRegistry } from "../src/schema.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { termHash, termToJson } from "../src/term-io.js";
import { parseTerm } from "../src/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-holes.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
  schemas: Array<{ name: string; alg: number; body: unknown }>;
  cases: Array<{ name: string; term: unknown; termHash: string; expectedCanonicalHex: string }>;
};

const set = DeltaSet.from(doc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))));
const registry = SchemaRegistry.build(
  doc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);

describe("l1-eval hole vectors (parameterized terms, SPEC-2 §6 / E15)", () => {
  it("fixture ids are pinned", () => {
    for (const d of doc.fixture.deltas) {
      expect(makeDelta(parseClaims(d.claims)).id).toBe(d.id);
    }
  });

  for (const c of doc.cases) {
    it(c.name, () => {
      const term = parseTerm(c.term);
      expect(termHash(term)).toBe(c.termHash);
      const result = evalTerm(term, set, undefined, registry);
      expect(resultCanonicalHex(result)).toBe(c.expectedCanonicalHex);
    });
  }

  it("a body with holes keeps one hash; bindings differentiate invocations", () => {
    // The two asOf cases invoke the SAME schema body with different bindings.
    expect(doc.cases[0]!.termHash).not.toBe(doc.cases[1]!.termHash);
  });

  it("an unbound hole fails loudly at evaluation time (E15)", () => {
    const term = parseTerm({ op: "fix", schema: "ViewAsOf", entity: "movie:matrix" });
    expect(() => evalTerm(term, set, undefined, registry)).toThrow(/unbound hole/);
  });

  it("parse∘serialize is identity on holes and bindings (E12)", () => {
    for (const c of [...doc.cases, ...doc.schemas.map((s) => ({ term: s.body, termHash: "" }))]) {
      const term = parseTerm(c.term);
      expect(termHash(parseTerm(termToJson(term)))).toBe(termHash(term));
    }
  });
});
