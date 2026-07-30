// all(order, distinct: true) — opt-in value-dedup at the resolve boundary (SPEC-5 §3/§7,
// ERRATA-5 R9, issue #33). Views are compared in their SPEC-5 §5 JSON rendering (bytes leaves as
// base64url); the canonical hex stays the byte-normative check.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { viewToJson } from "../src/resolution.js";
import { SchemaRegistry } from "../src/schema.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { schemaToJson } from "../src/term-io.js";
import { parseSchema, parseTerm } from "../src/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-distinct.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
  schemas: Array<{ name: string; alg: number; body: unknown }>;
  cases: Array<{
    name: string;
    term: unknown;
    expectedView: unknown;
    expectedCanonicalHex: string;
  }>;
  rejects: Array<{ name: string; reason: string; term: unknown }>;
};

const fixtureSet = DeltaSet.from(doc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))));
const registry = SchemaRegistry.build(
  doc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
  [],
);

describe("l1-eval distinct vectors (R9)", () => {
  for (const c of doc.cases) {
    it(c.name, () => {
      const result = evalTerm(parseTerm(c.term), fixtureSet, undefined, registry);
      if (result.sort !== "view") throw new Error("expected a View result");
      expect(viewToJson(result.view)).toEqual(c.expectedView);
      expect(resultCanonicalHex(result)).toBe(c.expectedCanonicalHex);
    });
  }

  for (const r of doc.rejects) {
    it(`${r.name} — ${r.reason}`, () => {
      expect(() => evalTerm(parseTerm(r.term), fixtureSet, undefined, registry)).toThrow();
    });
  }

  it("distinct round-trips through the schema serializer with one spelling", () => {
    const schema = parseSchema({
      props: { tag: { all: { order: { byTimestamp: "asc" }, distinct: true } } },
      default: { all: { order: { byTimestamp: "asc" } } },
    });
    const json = schemaToJson(schema) as {
      props: { tag: { all: { distinct?: unknown } } };
      default: { all: { distinct?: unknown } };
    };
    // distinct: true survives serialization; an absent distinct stays absent (never `false`).
    expect(json.props.tag.all.distinct).toBe(true);
    expect("distinct" in json.default.all).toBe(false);
  });
});
