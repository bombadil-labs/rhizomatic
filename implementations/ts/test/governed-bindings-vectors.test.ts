import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/json-profile.js";
import { loadLensBinding, publishLensBindingClaims } from "../src/lens-binding.js";
import { loadGovernedHyperSchema, loadGovernedSchema } from "../src/schema-deltas.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { schemaHash, termHash } from "../src/term-io.js";
import type { Order } from "../src/resolution.js";

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l3-schema/governed-bindings.json"), "utf8"),
) as {
  pins: Record<string, string>;
  deltas: Array<{ name: string; id: string; claims: unknown }>;
  hyperLoads: Array<{ now: number; authors: string[]; order: string; expected: string | null }>;
  schemaLoads: Array<{ now: number; authors: string[]; order: string; expected: string | null }>;
  lensLoads: Array<{ now: number; authors: string[]; order: string; expected: string | null }>;
};

const order = (name: string): Order => ({
  kind: name === "byValidFrom" ? "byValidFrom" : "byTimestamp",
  dir: "desc",
});

describe("shared governed definition and lens binding vectors (SPEC-3)", () => {
  const named = new Map(
    vector.deltas.map((entry) => {
      const delta = makeDelta(parseClaims(entry.claims));
      expect(delta.id).toBe(entry.id);
      return [entry.name, delta] as const;
    }),
  );
  const deltas = [...named.values()];

  for (const [label, ordered] of [
    ["forward", deltas],
    ["reverse", [...deltas].reverse()],
  ] as const) {
    it(`matches the governed loaders and binding in ${label} ingest order`, () => {
      const set = DeltaSet.from(ordered);
      for (const c of vector.hyperLoads) {
        const read = () =>
          loadGovernedHyperSchema(
            set,
            "schema:governed",
            c.now,
            new Set(c.authors),
            order(c.order),
          );
        if (c.expected === null) expect(read).toThrow(/no surviving schema definition/);
        else {
          const loaded = read();
          expect(loaded.name).toBe(c.expected);
          expect(termHash(loaded.body)).toBe(
            vector.pins[c.expected === "DefinitionA" ? "hyperA" : "hyperB"],
          );
        }
      }
      for (const c of vector.schemaLoads) {
        const read = () =>
          loadGovernedSchema(set, "schema:reading", c.now, new Set(c.authors), order(c.order));
        if (c.expected === null) expect(read).toThrow(/no surviving schema definition/);
        else {
          const loaded = read();
          expect(loaded.name).toBe(c.expected);
          expect(schemaHash(loaded)).toBe(
            vector.pins[c.expected === "ReadingA" ? "schemaA" : "schemaB"],
          );
        }
      }
      for (const c of vector.lensLoads) {
        const read = () =>
          loadLensBinding(set, "lens:shared", c.now, new Set(c.authors), order(c.order));
        if (c.expected === null) expect(read).toThrow(/no surviving lens binding/);
        else {
          const binding = read();
          expect(binding).toEqual({
            name: "lens:shared",
            hyperSchemaPin: vector.pins[c.expected === "lensA" ? "hyperA" : "hyperB"],
            schemaPin: vector.pins[c.expected === "lensA" ? "schemaA" : "schemaB"],
            deltaId: named.get(c.expected)!.id,
          });
        }
      }
    });
  }

  it("publishes the pinned pair as the vector claims", () => {
    const set = DeltaSet.from(deltas);
    const hyper = loadGovernedHyperSchema(
      set,
      "schema:governed",
      60,
      new Set(["A"]),
      order("byTimestamp"),
    );
    const schema = loadGovernedSchema(
      set,
      "schema:reading",
      60,
      new Set(["A"]),
      order("byTimestamp"),
    );
    const claims = {
      ...publishLensBindingClaims("lens:shared", hyper, schema, "A", 100),
      validFrom: 50,
    };
    expect(makeDelta(claims).id).toBe(named.get("lensA")!.id);
  });
});
