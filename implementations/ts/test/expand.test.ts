import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { SchemaRegistry, collectRefs, type HyperSchema } from "../src/schema.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { parseSchema, parseTerm } from "../src/term-json.js";
import { schemaHash } from "../src/term-io.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-expand.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
  schemas: Array<{ name: string; alg: number; body: unknown }>;
  cases: Array<{ name: string; term: unknown; expectedCanonicalHex: string }>;
};

const fixtureSet = DeltaSet.from(doc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))));
const registry = SchemaRegistry.build(
  doc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);

describe("l1-eval expand/fix vectors", () => {
  for (const c of doc.cases) {
    it(c.name, () => {
      const result = evalTerm(parseTerm(c.term), fixtureSet, undefined, registry);
      expect(resultCanonicalHex(result)).toBe(c.expectedCanonicalHex);
    });
  }

  it("the data cycle case nests exactly three levels then bottoms out", () => {
    const result = evalTerm(
      parseTerm({ op: "fix", schema: "MovieDeep", entity: "movie:matrix" }),
      fixtureSet,
      undefined,
      registry,
    );
    if (result.sort !== "hview") throw new Error("expected hview");
    // matrix.cast -> c1 with actor expanded
    const cast = result.hview.props.get("cast")!;
    expect(cast).toHaveLength(1);
    const c1 = cast[0]!;
    const actorIdx = c1.delta.claims.pointers.findIndex((p) => p.role === "actor");
    const keanu = c1.expanded!.get(actorIdx)!;
    expect(keanu.id).toBe("actor:keanu");
    // keanu.createdWorks -> c2 with work expanded
    const created = keanu.props.get("createdWorks")!;
    const c2 = created[0]!;
    const workIdx = c2.delta.claims.pointers.findIndex((p) => p.role === "work");
    const brzrkr = c2.expanded!.get(workIdx)!;
    expect(brzrkr.id).toBe("movie:brzrkr");
    // brzrkr.createdBy -> c2 again, UNexpanded (MovieBasic is terminal): the cycle bottoms out
    const createdBy = brzrkr.props.get("createdBy")!;
    expect(createdBy[0]!.delta.id).toBe(c2.delta.id);
    expect(createdBy[0]!.expanded).toBeUndefined();
  });
});

describe("schema registry (SPEC-3 §3 / E10)", () => {
  const body = (t: unknown) => parseTerm(t);
  const groupInput = { op: "group", key: "byRole", in: "input" };

  it("collects refs from expand and fix nodes", () => {
    const term = parseTerm({
      op: "expand",
      role: { exact: "x" },
      schema: "Child",
      in: groupInput,
    });
    expect(collectRefs(term)).toEqual([{ kind: "name", name: "Child" }]);
  });

  it("rejects reference cycles", () => {
    const a: HyperSchema = {
      name: "A",
      alg: 1,
      body: body({ op: "expand", role: { exact: "x" }, schema: "B", in: groupInput }),
    };
    const b: HyperSchema = {
      name: "B",
      alg: 1,
      body: body({ op: "expand", role: { exact: "y" }, schema: "A", in: groupInput }),
    };
    expect(() => SchemaRegistry.build([a, b])).toThrow(/cycle/);
  });

  it("rejects unresolved references", () => {
    const a: HyperSchema = {
      name: "A",
      alg: 1,
      body: body({ op: "expand", role: { exact: "x" }, schema: "Ghost", in: groupInput }),
    };
    expect(() => SchemaRegistry.build([a])).toThrow(/unknown schema/);
  });

  it("rejects duplicate names", () => {
    const a: HyperSchema = { name: "A", alg: 1, body: body(groupInput) };
    expect(() => SchemaRegistry.build([a, a])).toThrow(/duplicate/);
  });

  // issue #23: reading references validate at build, exactly as gather references do.
  it("rejects an unknown reading reference at build", () => {
    const base: HyperSchema = { name: "Base", alg: 1, body: body(groupInput) };
    const a: HyperSchema = {
      name: "A",
      alg: 1,
      body: body({
        op: "expand",
        role: { exact: "x" },
        schema: "Base",
        reading: "GhostReading",
        in: groupInput,
      }),
    };
    expect(() => SchemaRegistry.build([base, a])).toThrow(/unknown reading/);
  });

  it("resolves a registered reading by name and by pinned hash", () => {
    const reading = parseSchema({
      name: "R",
      alg: 1,
      props: { name: { pick: { order: { byTimestamp: "asc" } } } },
      default: { pick: { order: "lexById" } },
    });
    const base: HyperSchema = { name: "Base", alg: 1, body: body(groupInput) };
    const registry = SchemaRegistry.build([base], [reading]);
    expect(registry.resolveReading({ kind: "name", name: "R" })).toBe(reading);
    expect(registry.resolveReading({ kind: "pinned", hash: schemaHash(reading) })).toBe(reading);
  });

  it("evaluating a schema reference without a registry throws", () => {
    expect(() => evalTerm(parseTerm({ op: "fix", schema: "A", entity: "e" }), fixtureSet)).toThrow(
      /no registry/,
    );
  });
});
