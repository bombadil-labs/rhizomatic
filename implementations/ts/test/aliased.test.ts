import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { relationSignature, relationSignatureCanonicalHex } from "../src/alias.js";
import { aliasClosure, evalTerm, resultCanonicalHex, type AliasedSpec } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { SchemaRegistry } from "../src/schema.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { termHash, termToJson } from "../src/term-io.js";
import { parsePred, parseTerm } from "../src/term-json.js";
import { strMatch } from "../src/pred.js";
import { VOCAB_PREFIX } from "../src/vocab.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-aliased.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
  schemas: Array<{ name: string; alg: number; body: unknown }>;
  cases: Array<{
    name: string;
    term: unknown;
    termHash: string;
    expectedClosure?: string[];
    expected: { ids?: string[]; id?: string; props?: Record<string, string[]> };
    expectedCanonicalHex: string;
  }>;
  signatures: Array<{ name: string; delta: string; signature: string[][]; canonicalHex: string }>;
};

const set = DeltaSet.from(doc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))));
const registry = SchemaRegistry.build(
  doc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);

// Pull the (single) aliased node out of a case's term JSON, wherever it sits.
function findAliased(v: unknown): AliasedSpec | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const found = findAliased(x);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const o = v as Record<string, unknown>;
  if (typeof o["aliased"] === "object" && o["aliased"] !== null) {
    const a = o["aliased"] as Record<string, unknown>;
    return {
      name: a["name"] as string,
      ...(a["via"] === undefined ? {} : { via: a["via"] as string }),
      ...(a["trust"] === undefined ? {} : { trust: parsePred(a["trust"]) }),
    };
  }
  for (const x of Object.values(o)) {
    const found = findAliased(x);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe("l1-eval aliased vectors (the alias closure, SPEC-9)", () => {
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
      if (c.expected.ids !== undefined && result.sort === "dset") {
        expect(result.set.ids()).toEqual(c.expected.ids);
      }
      if (c.expectedClosure !== undefined) {
        const spec = findAliased(c.term);
        expect(spec).toBeDefined();
        expect(aliasClosure(set, spec!)).toEqual(c.expectedClosure);
      }
    });
  }

  for (const s of doc.signatures) {
    it(`signature: ${s.name}`, () => {
      const fixture = doc.fixture.deltas.find((d) => d.name === s.delta)!;
      const d = makeDelta(parseClaims(fixture.claims));
      expect(relationSignature(d).map((p) => [...p])).toEqual(s.signature);
      expect(relationSignatureCanonicalHex(d)).toBe(s.canonicalHex);
    });
  }

  it("the closure never enters the term hash (one term, any data)", () => {
    const c = doc.cases[0]!;
    const term = parseTerm(c.term);
    // Same authored term hashes identically whether evaluated against the fixture or nothing.
    expect(termHash(term)).toBe(c.termHash);
    const empty = evalTerm(term, DeltaSet.from([]), undefined, registry);
    expect(empty.sort).toBe("dset");
  });

  it("parse∘serialize is identity on aliased (SPEC-2 §7)", () => {
    for (const c of [...doc.cases, ...doc.schemas.map((s) => ({ term: s.body }))]) {
      const term = parseTerm(c.term);
      expect(termHash(parseTerm(termToJson(term)))).toBe(termHash(term));
    }
  });

  it("rejects holes inside an aliased trust predicate at parse time", () => {
    expect(() =>
      parseTerm({
        op: "select",
        pred: {
          hasPointer: {
            context: {
              aliased: {
                name: "employer",
                trust: {
                  match: { field: "author", cmp: "eq", const: { hole: "who" } },
                },
              },
            },
          },
        },
        in: "input",
      }),
    ).toThrow(/holes are not allowed/);
  });

  it("rejects nested aliased inside an aliased trust predicate at parse time", () => {
    expect(() =>
      parseTerm({
        op: "select",
        pred: {
          hasPointer: {
            context: {
              aliased: {
                name: "employer",
                trust: { hasPointer: { context: { aliased: { name: "job" } } } },
              },
            },
          },
        },
        in: "input",
      }),
    ).toThrow(/nested aliased/);
  });

  it("an unexpanded aliased StrMatch fails loudly if it ever reaches matching", () => {
    expect(() => strMatch({ kind: "aliased", name: "employer" }, "employer")).toThrow(/expanded/);
  });

  it("aliased with an empty input degrades to exact(name)", () => {
    expect(aliasClosure(DeltaSet.from([]), { name: "anything" })).toEqual(["anything"]);
  });

  it("the vocabulary rides the configurable prefix", () => {
    // The fixture's mapping roles must be spelled with VOCAB_PREFIX, so a prefix change
    // stays a one-line edit plus a vector regen.
    const m1 = doc.fixture.deltas.find((d) => d.name === "m1-employer")!;
    expect(JSON.stringify(m1.claims)).toContain(`${VOCAB_PREFIX}.alias.fragment`);
  });
});
