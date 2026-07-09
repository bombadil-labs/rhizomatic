// Reflective predicates (SPEC-2 §3.1, ERRATA-2 E16): conformance vectors, parse-time
// stratification, and the reactor's conservative dispatch for reflective terms.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evalTerm, resultCanonicalHex, type EvalResult } from "../src/eval.js";
import { hviewCanonicalHex } from "../src/hview.js";
import { parseClaims } from "../src/json-profile.js";
import { evalPred } from "../src/pred.js";
import { Reactor } from "../src/reactor.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { parsePred, parseTerm } from "../src/term-json.js";
import { termToJson } from "../src/term-io.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-reflective.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
  cases: Array<{
    name: string;
    term: unknown;
    expected: { ids: string[] };
    expectedCanonicalHex: string;
  }>;
};

function asDSet(r: EvalResult) {
  if (r.sort !== "dset") throw new Error("expected a DSet result");
  return r;
}

const fixtureDeltas = doc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims)));
const fixtureSet = DeltaSet.from(fixtureDeltas);

describe("l1-eval reflective vectors (SPEC-2 §3.1)", () => {
  it("fixture ids match the pinned ids", () => {
    for (const d of doc.fixture.deltas) {
      expect(makeDelta(parseClaims(d.claims)).id).toBe(d.id);
    }
  });

  for (const c of doc.cases) {
    it(c.name, () => {
      const result = asDSet(evalTerm(parseTerm(c.term), fixtureSet));
      expect(result.set.ids()).toEqual(c.expected.ids);
      expect(resultCanonicalHex(result)).toBe(c.expectedCanonicalHex);
    });
  }

  it("parse(termToJson) is identity through an inView (E12 hashing round-trip)", () => {
    for (const c of doc.cases) {
      const parsed = parseTerm(c.term);
      expect(parseTerm(termToJson(parsed))).toEqual(parsed);
    }
  });
});

describe("stratification and closure (parse-time rejection)", () => {
  const innerInView = {
    inView: { term: "input", field: "author", extract: { field: "author" } },
  };

  it("rejects inView inside inView.term (depth-1 stratification)", () => {
    expect(() =>
      parsePred({
        inView: {
          term: { op: "select", pred: innerInView, in: "input" },
          field: "author",
          extract: { field: "author" },
        },
      }),
    ).toThrow(/stratified/);
  });

  it("rejects a non-DSet-sort sub-term", () => {
    expect(() =>
      parsePred({
        inView: {
          term: { op: "group", key: "byRole", in: "input" },
          field: "author",
          extract: { field: "author" },
        },
      }),
    ).toThrow(/DSet-sort/);
  });

  it("rejects inView inside a policy byPred predicate", () => {
    expect(() =>
      parseTerm({
        op: "resolve",
        policy: {
          default: { pick: { order: { byPred: { pred: innerInView, then: "lexById" } } } },
        },
        in: "input",
      }),
    ).toThrow(/not allowed inside a policy byPred/);
  });

  it("rejects inView inside an aliased trust predicate", () => {
    expect(() =>
      parsePred({
        hasPointer: { role: { aliased: { name: "parent", trust: innerInView } } },
      }),
    ).toThrow(/not allowed inside an aliased trust predicate/);
  });

  it("an unresolved inView never reaches per-delta evaluation", () => {
    const pred = parsePred({
      inView: { term: "input", field: "author", extract: { field: "author" } },
    });
    expect(() => evalPred(pred, fixtureDeltas[0]!)).toThrow(/resolved before matching/);
  });
});

describe("reactor: reflective terms dispatch conservatively (SPEC-4 §4.1)", () => {
  // The vectors' trust surface, materialized: color claims about topic:sky, masked by
  // negations from authors holding a surviving, operator-rooted grant.
  const A = "did:key:zAlice";
  // mask BEFORE select (ERRATA-3 S5): the negations live outside the root's edge set, so the
  // trust mask must run over the full input before the root selection narrows it.
  const reflectiveTerm = parseTerm({
    op: "group",
    key: "byTargetContext",
    in: {
      op: "select",
      pred: { hasPointer: { targetEntity: { var: "root" } } },
      in: {
        op: "mask",
        policy: {
          trust: {
            inView: {
              term: {
                op: "select",
                pred: { hasPointer: { role: { exact: "grant" }, targetEntity: "acl:village" } },
                in: {
                  op: "mask",
                  policy: "drop",
                  in: {
                    op: "select",
                    pred: { match: { field: "author", cmp: "eq", const: A } },
                    in: "input",
                  },
                },
              },
              field: "author",
              extract: { role: "grantee" },
            },
          },
        },
        in: "input",
      },
    },
  });

  it("incremental equals batch after EVERY ingest, in any order (the reflective oracle)", () => {
    fc.assert(
      fc.property(
        fc.constant(fixtureDeltas).chain((ds) => fc.shuffledSubarray(ds, { minLength: ds.length })),
        (order) => {
          const reactor = new Reactor();
          reactor.register("sky", reflectiveTerm, ["topic:sky"]);
          for (const delta of order) {
            expect(reactor.ingest(delta).status).toBe("accepted");
            const batch = evalTerm(reflectiveTerm, reactor.snapshot(), "topic:sky");
            if (batch.sort !== "hview") throw new Error("expected hview");
            expect(reactor.materializedHex("sky", "topic:sky")).toBe(
              hviewCanonicalHex(batch.hview),
            );
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it("a grant landing away from the root's support still refreshes the materialization", () => {
    const byName = new Map(doc.fixture.deltas.map((d, i) => [d.name, fixtureDeltas[i]!]));
    const reactor = new Reactor();
    reactor.register("sky", reflectiveTerm, ["topic:sky"]);
    // Claims and negations first: Bob has no grant yet, so his negation has no standing.
    for (const name of ["c1-color-blue", "n1-bob-negates-c1"]) {
      expect(reactor.ingest(byName.get(name)!).status).toBe("accepted");
    }
    const before = reactor.materializedHex("sky", "topic:sky");
    // The grant targets acl:village — nowhere near topic:sky's support — yet it flips
    // Bob's standing and must suppress c1.
    expect(reactor.ingest(byName.get("g1-grant-bob")!).status).toBe("accepted");
    const after = reactor.materializedHex("sky", "topic:sky");
    expect(after).not.toBe(before);
    const batch = evalTerm(reflectiveTerm, reactor.snapshot(), "topic:sky");
    if (batch.sort !== "hview") throw new Error("expected hview");
    expect(after).toBe(hviewCanonicalHex(batch.hview));
  });
});
