import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evalTerm, resultCanonicalHex, type Term } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { evalPred, type Pred } from "../src/pred.js";
import { DeltaSet, fork, makeDelta, merge } from "../src/set.js";
import { parsePred, parseTerm } from "../src/term-json.js";
import type { Claims, Delta, Pointer } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const evalBasic = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-basic.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
  cases: Array<{
    name: string;
    term: unknown;
    expected: { ids: string[]; negated?: string[] };
    expectedCanonicalHex: string;
  }>;
};

const fixtureSet = DeltaSet.from(
  evalBasic.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))),
);

describe("l1-eval vectors (select/union/mask)", () => {
  it("fixture ids match the pinned ids", () => {
    for (const d of evalBasic.fixture.deltas) {
      expect(makeDelta(parseClaims(d.claims)).id).toBe(d.id);
    }
  });

  for (const c of evalBasic.cases) {
    it(c.name, () => {
      const result = evalTerm(parseTerm(c.term), fixtureSet);
      expect(result.set.ids()).toEqual(c.expected.ids);
      if (c.expected.negated !== undefined) {
        expect([...result.negated].sort()).toEqual(c.expected.negated);
      }
      expect(resultCanonicalHex(result)).toBe(c.expectedCanonicalHex);
    });
  }
});

// --- property tests -----------------------------------------------------------------------------

const pointerArb: fc.Arbitrary<Pointer> = fc.record({
  role: fc.constantFrom("r1", "r2", "negates"),
  target: fc.oneof(
    fc.constantFrom("x", "y").map((value) => ({ kind: "primitive" as const, value })),
    fc
      .constantFrom("e1", "e2")
      .map((id) => ({ kind: "entity" as const, entity: { id, context: "c1" } })),
  ),
});

const claimsArb: fc.Arbitrary<Claims> = fc.record({
  timestamp: fc.integer({ min: 0, max: 1000 }),
  author: fc.constantFrom("did:key:zA", "did:key:zB"),
  pointers: fc.array(pointerArb, { minLength: 1, maxLength: 2 }),
});

const setArb: fc.Arbitrary<DeltaSet> = fc
  .array(
    claimsArb.map((c) => makeDelta(c)),
    { maxLength: 15 },
  )
  .map((ds) => DeltaSet.from(ds));

const predPool: Pred[] = [
  parsePred({ match: { field: "author", cmp: "eq", const: "did:key:zA" } }),
  parsePred({ match: { field: "timestamp", cmp: "lte", const: 500 } }),
  parsePred({ hasPointer: { role: { exact: "r1" } } }),
  parsePred({ hasPointer: { targetEntity: "e1" } }),
  parsePred("true"),
  parsePred({ not: { match: { field: "author", cmp: "eq", const: "did:key:zA" } } }),
];
const predArb = fc.constantFrom(...predPool);

const selectTerm = (pred: Pred, of: Term = { kind: "input" }): Term => ({
  kind: "select",
  pred,
  of,
});

describe("evaluator laws (SPEC-2)", () => {
  it("select composes by conjunction: select(p, select(q, D)) = select(and(p,q), D)", () => {
    fc.assert(
      fc.property(setArb, predArb, predArb, (d, p, q) => {
        const nested = evalTerm(selectTerm(p, selectTerm(q)), d);
        const conj = evalTerm(selectTerm({ kind: "and", left: p, right: q }), d);
        return nested.set.digest() === conj.set.digest();
      }),
    );
  });

  it("select is monotone: select(p, A) ⊆ select(p, A ∪ B)", () => {
    fc.assert(
      fc.property(setArb, setArb, predArb, (a, b, p) => {
        const small = evalTerm(selectTerm(p), a);
        const big = evalTerm(selectTerm(p), merge(a, b));
        return [...small.set].every((d) => big.set.has(d.id));
      }),
    );
  });

  it("mask(drop) yields a subset of its operand", () => {
    fc.assert(
      fc.property(setArb, (d) => {
        const masked = evalTerm(
          { kind: "mask", policy: { kind: "drop" }, of: { kind: "input" } },
          d,
        );
        return [...masked.set].every((x) => d.has(x.id));
      }),
    );
  });

  it("union over selects equals select over disjunction", () => {
    fc.assert(
      fc.property(setArb, predArb, predArb, (d, p, q) => {
        const viaUnion = evalTerm({ kind: "union", left: selectTerm(p), right: selectTerm(q) }, d);
        const viaOr = evalTerm(selectTerm({ kind: "or", left: p, right: q }), d);
        return viaUnion.set.digest() === viaOr.set.digest();
      }),
    );
  });

  it("select agrees with direct fork over evalPred", () => {
    fc.assert(
      fc.property(setArb, predArb, (d, p) => {
        const viaTerm = evalTerm(selectTerm(p), d);
        const viaFork = fork(d, (x: Delta) => evalPred(p, x));
        return viaTerm.set.digest() === viaFork.digest();
      }),
    );
  });
});

// --- NFC boundary (ERRATA D11) --------------------------------------------------------------------

describe("NFC validation at the boundary (ERRATA D11)", () => {
  it("rejects a decomposed role", () => {
    const decomposed = "café"; // decomposed (NFD) form of cafe-with-acute
    expect(() =>
      makeDelta({
        timestamp: 0,
        author: "a",
        pointers: [{ role: decomposed, target: { kind: "primitive", value: 1 } }],
      }),
    ).toThrow(/NFC/);
  });

  it("accepts the composed form of the same string", () => {
    expect(
      makeDelta({
        timestamp: 0,
        author: "a",
        pointers: [{ role: "café", target: { kind: "primitive", value: 1 } }],
      }).id,
    ).toMatch(/^1e20/);
  });
});
