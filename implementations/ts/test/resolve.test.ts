import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { SchemaRegistry } from "../src/schema.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { parseTerm } from "../src/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-resolve.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
  schemas: Array<{ name: string; alg: number; body: unknown }>;
  cases: Array<{
    name: string;
    term: unknown;
    expectedView: unknown;
    expectedCanonicalHex: string;
  }>;
};

const fixtureSet = DeltaSet.from(doc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))));
const registry = SchemaRegistry.build(
  doc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);

describe("l1-eval resolve vectors (SPEC-5)", () => {
  for (const c of doc.cases) {
    it(c.name, () => {
      const result = evalTerm(parseTerm(c.term), fixtureSet, undefined, registry);
      if (result.sort !== "view") throw new Error("expected a View result");
      expect(result.view).toEqual(c.expectedView);
      expect(resultCanonicalHex(result)).toBe(c.expectedCanonicalHex);
    });
  }

  it("two policies over the same HyperView legitimately disagree (P5 pluralism)", () => {
    const latest = evalTerm(
      parseTerm({
        op: "resolve",
        schema: { default: { pick: { order: { byTimestamp: "desc" } } } },
        in: { op: "fix", schema: "MovieRaw", entity: "movie:matrix" },
      }),
      fixtureSet,
      undefined,
      registry,
    );
    const trustAlice = evalTerm(
      parseTerm({
        op: "resolve",
        schema: { default: { pick: { order: { byAuthorRank: ["did:key:zAlice"] } } } },
        in: { op: "fix", schema: "MovieRaw", entity: "movie:matrix" },
      }),
      fixtureSet,
      undefined,
      registry,
    );
    if (latest.sort !== "view" || trustAlice.sort !== "view") throw new Error("expected views");
    const l = latest.view as Record<string, unknown>;
    const t = trustAlice.view as Record<string, unknown>;
    expect(l["title"]).toBe("Matrix Reloaded");
    expect(t["title"]).toBe("The Matrix");
  });

  it("resolve demands an HView operand (R7)", () => {
    expect(() =>
      evalTerm(
        parseTerm({
          op: "resolve",
          schema: { default: { pick: { order: "lexById" } } },
          in: "input",
        }),
        fixtureSet,
      ),
    ).toThrow(/HView operand/);
  });

  it("an empty chain is a rejected term, not an identity (SPEC-5 §3)", () => {
    expect(() =>
      parseTerm({
        op: "resolve",
        schema: { default: { pick: { order: { chain: [] } } } },
        in: { op: "fix", schema: "MovieRaw", entity: "movie:matrix" },
      }),
    ).toThrow(/chain must name at least one order/);
  });

  it("determinism: same policy + hview => byte-identical view", () => {
    const term = parseTerm({
      op: "resolve",
      schema: { default: { all: { order: "lexById" } } },
      in: { op: "fix", schema: "MovieRaw", entity: "movie:matrix" },
    });
    const a = resultCanonicalHex(evalTerm(term, fixtureSet, undefined, registry));
    const b = resultCanonicalHex(evalTerm(term, fixtureSet, undefined, registry));
    expect(a).toBe(b);
  });
});
