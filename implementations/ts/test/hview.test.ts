import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { parseTerm } from "../src/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-hview.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
  cases: Array<{
    name: string;
    root: string;
    term: unknown;
    expected: { id: string; props: Record<string, Array<{ id: string; negated?: boolean }>> };
    expectedCanonicalHex: string;
  }>;
};

const fixtureSet = DeltaSet.from(doc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))));

describe("l1-eval hview vectors (group/prune)", () => {
  for (const c of doc.cases) {
    it(c.name, () => {
      const result = evalTerm(parseTerm(c.term), fixtureSet, 1_000_000_000_000_000, c.root);
      if (result.sort !== "hview") throw new Error("expected an HView result");
      expect(result.hview.id).toBe(c.expected.id);
      const props: Record<string, Array<{ id: string; negated?: boolean }>> = {};
      for (const [prop, entries] of [...result.hview.props.entries()].sort(([a], [b]) =>
        a < b ? -1 : 1,
      )) {
        props[prop] = entries.map((e) => ({
          id: e.delta.id,
          ...(e.negated ? { negated: true } : {}),
        }));
      }
      expect(props).toEqual(c.expected.props);
      expect(resultCanonicalHex(result)).toBe(c.expectedCanonicalHex);
    });
  }

  it("prune-all reproduces the unpruned canonical bytes (identity)", () => {
    const idiom = doc.cases.find((c) => c.name === "group-by-target-context-canonical-idiom")!;
    const pruned = doc.cases.find((c) => c.name === "prune-all-is-identity")!;
    expect(pruned.expectedCanonicalHex).toBe(idiom.expectedCanonicalHex);
  });
});

describe("sort errors (ERRATA-2 E9)", () => {
  it("prune over a DSet operand throws", () => {
    expect(() =>
      evalTerm(
        parseTerm({ op: "prune", keep: "all", in: "input" }),
        fixtureSet,
        1_000_000_000_000_000,
        "movie:matrix",
      ),
    ).toThrow(/HView operand/);
  });

  it("select over an HView operand throws", () => {
    const term = parseTerm({
      op: "select",
      pred: "true",
      in: { op: "group", key: "byRole", in: "input" },
    });
    expect(() => evalTerm(term, fixtureSet, 1_000_000_000_000_000, "movie:matrix")).toThrow(
      /DSet operand/,
    );
  });

  it("group without an ambient root throws", () => {
    expect(() =>
      evalTerm(
        parseTerm({ op: "group", key: "byRole", in: "input" }),
        fixtureSet,
        1_000_000_000_000_000,
      ),
    ).toThrow(/ambient root/);
  });
});

describe("group filing invariants (E6)", () => {
  it("every grouped entry's delta has a filing pointer targeting the root", () => {
    const result = evalTerm(
      parseTerm({ op: "group", key: "byRole", in: "input" }),
      fixtureSet,
      1_000_000_000_000_000,
      "movie:matrix",
    );
    if (result.sort !== "hview") throw new Error("expected hview");
    for (const entries of result.hview.props.values()) {
      for (const e of entries) {
        const files = e.delta.claims.pointers.some(
          (p) => p.target.kind === "entity" && p.target.entity.id === "movie:matrix",
        );
        expect(files).toBe(true);
      }
    }
  });

  it("entries within a property are unique by id and sorted", () => {
    const result = evalTerm(
      parseTerm({ op: "group", key: "byTargetContext", in: "input" }),
      fixtureSet,
      1_000_000_000_000_000,
      "movie:matrix",
    );
    if (result.sort !== "hview") throw new Error("expected hview");
    for (const entries of result.hview.props.values()) {
      const ids = entries.map((e) => e.delta.id);
      expect([...new Set(ids)].sort()).toEqual(ids);
    }
  });
});
