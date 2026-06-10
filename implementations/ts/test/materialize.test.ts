import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evalTerm, resultCanonicalHex, type Term } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { Reactor } from "../src/reactor.js";
import { SchemaRegistry } from "../src/schema.js";
import { DeltaSet, makeDelta, makeNegationClaims } from "../src/set.js";
import { parseTerm } from "../src/term-json.js";
import type { Delta } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const expandDoc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-expand.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; claims: unknown }> };
  schemas: Array<{ name: string; alg: number; body: unknown }>;
};

const baseDeltas = expandDoc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims)));
const registry = SchemaRegistry.build(
  expandDoc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);
const movieDeepBody = registry.get("MovieDeep")!.body;

// Extend the world with a negation chain over the cast edge: n1 negates c1, n2 negates n1.
const byName = new Map(expandDoc.fixture.deltas.map((d, i) => [d.name, baseDeltas[i]!]));
const c1 = byName.get("c1-cast")!;
const n1 = makeDelta(makeNegationClaims("did:key:zNeg", 900, c1.id));
const n2 = makeDelta(makeNegationClaims("did:key:zNeg", 950, n1.id));
const allDeltas: Delta[] = [...baseDeltas, n1, n2];

// A non-anchored term: group(const) bags every delta — must dispatch broadly.
const bagTerm = parseTerm({ op: "group", key: { const: "all" }, in: "input" });

function batchHex(term: Term, set: DeltaSet, root: string): string {
  return resultCanonicalHex(evalTerm(term, set, root, registry));
}

describe("incremental equivalence (SPEC-4 §1 — the defining contract)", () => {
  it("materializations equal batch evaluation after EVERY ingest, any order", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(allDeltas, { minLength: allDeltas.length }), (perm) => {
        const r = new Reactor();
        r.register("deep", movieDeepBody, ["movie:matrix", "movie:brzrkr"], registry);
        r.register("bag", bagTerm, ["movie:matrix"], registry);
        const grow = new DeltaSet();
        for (const d of perm) {
          if (r.ingest(d).status !== "accepted") return false;
          grow.add(d);
          for (const root of ["movie:matrix", "movie:brzrkr"]) {
            if (r.materializedHex("deep", root) !== batchHex(movieDeepBody, grow, root)) {
              return false;
            }
          }
          if (
            r.materializedHex("bag", "movie:matrix") !== batchHex(bagTerm, grow, "movie:matrix")
          ) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 40 },
    );
  });

  it("the negation chain plays out incrementally: suppress, then reinstate", () => {
    const r = new Reactor();
    r.register("deep", movieDeepBody, ["movie:matrix"], registry);
    for (const d of baseDeltas) r.ingest(d);
    const withCast = r.materializedHex("deep", "movie:matrix")!;

    r.ingest(n1); // suppresses c1: the cast property (and the keanu subtree) disappears
    const suppressed = r.materializedHex("deep", "movie:matrix")!;
    expect(suppressed).not.toBe(withCast);

    r.ingest(n2); // reinstates c1 via negation-of-negation
    expect(r.materializedHex("deep", "movie:matrix")).toBe(withCast);
  });

  it("dispatch skips irrelevant deltas for anchored terms", () => {
    const r = new Reactor();
    r.register("deep", movieDeepBody, ["movie:matrix"], registry);
    for (const d of baseDeltas) r.ingest(d);
    const before = r.evalCountOf("deep");
    const stranger = makeDelta(
      parseClaims({
        timestamp: 9999,
        author: "did:key:zStranger",
        pointers: [
          { role: "subject", target: { entityRef: { id: "movie:unrelated", context: "title" } } },
          { role: "value", target: { value: "Speed" } },
        ],
      }),
    );
    r.ingest(stranger);
    expect(r.evalCountOf("deep")).toBe(before); // not even re-evaluated
    expect(r.changesFromLastIngest()).toEqual([]);
  });

  it("change events fire only on real content change", () => {
    const r = new Reactor();
    r.register("deep", movieDeepBody, ["movie:matrix"], registry);
    const m1 = byName.get("m1-matrix-title")!;
    r.ingest(m1);
    expect(r.changesFromLastIngest()).toEqual([
      {
        materialization: "deep",
        root: "movie:matrix",
        newHex: r.materializedHex("deep", "movie:matrix"),
      },
    ]);
  });

  it("expansion support: a delta about an expanded entity re-materializes the parent", () => {
    const r = new Reactor();
    r.register("deep", movieDeepBody, ["movie:matrix"], registry);
    for (const d of baseDeltas) r.ingest(d);
    const before = r.materializedHex("deep", "movie:matrix");
    // a new claim about keanu (an EXPANDED entity, not the root)
    const award = makeDelta(
      parseClaims({
        timestamp: 1500,
        author: "did:key:zCritic",
        pointers: [
          { role: "subject", target: { entityRef: { id: "actor:keanu", context: "award" } } },
          { role: "value", target: { value: "Best Stoic" } },
        ],
      }),
    );
    r.ingest(award);
    const after = r.materializedHex("deep", "movie:matrix");
    expect(after).not.toBe(before);
    const grow = DeltaSet.from([...baseDeltas, award]);
    expect(after).toBe(batchHex(movieDeepBody, grow, "movie:matrix"));
  });
});
