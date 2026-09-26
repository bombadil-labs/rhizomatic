import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeId } from "../src/delta.js";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { Reactor } from "../src/reactor.js";
import { loadHyperSchema, loadSchema } from "../src/schema-deltas.js";
import { viewToJson } from "../src/resolution.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { parseTerm } from "../src/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-time.json"), "utf8"),
) as {
  fixture: Record<string, { id: string; claims: unknown }>;
  cases: Array<{
    name: string;
    now: number;
    input: string[];
    term: unknown;
    expectedCanonicalHex: string;
    expectedIds?: string[];
    expectedView?: unknown;
  }>;
  expiringDefinitions: Array<{
    kind: "hyperschema" | "schema";
    entity: string;
    expectedName: string;
    validAt: number;
    expiredAt: number;
    id: string;
    claims: unknown;
  }>;
};
const fixture = Object.fromEntries(
  Object.entries(doc.fixture).map(([name, item]) => [name, makeDelta(parseClaims(item.claims))]),
);

describe("vNext validity and Schema order vectors", () => {
  it("pins the content addresses used by the time cases", () => {
    for (const [name, item] of Object.entries(doc.fixture)) {
      expect(computeId(parseClaims(item.claims)), name).toBe(item.id);
    }
  });
  for (const c of doc.cases) {
    it(c.name, () => {
      const term = parseTerm(c.term);
      for (const names of [c.input, [...c.input].reverse()]) {
        const input = DeltaSet.from(names.map((name) => fixture[name]!));
        const result = evalTerm(term, input, c.now, "entity:time");
        expect(resultCanonicalHex(result)).toBe(c.expectedCanonicalHex);
        if (c.expectedIds !== undefined) {
          expect(result.sort).toBe("dset");
          if (result.sort === "dset") expect(result.set.ids()).toEqual(c.expectedIds);
        }
        if (c.expectedView !== undefined) {
          expect(result.sort).toBe("view");
          if (result.sort === "view") expect(viewToJson(result.view)).toEqual(c.expectedView);
        }
      }
    });
  }

  for (const c of doc.expiringDefinitions) {
    it(`${c.kind} definition expires at its signed end`, () => {
      const delta = makeDelta(parseClaims(c.claims));
      expect(delta.id).toBe(c.id);
      const set = DeltaSet.from([delta]);
      const load = c.kind === "hyperschema" ? loadHyperSchema : loadSchema;
      expect(load(set, c.entity, c.validAt).name).toBe(c.expectedName);
      expect(() => load(set, c.entity, c.expiredAt)).toThrow(/no surviving schema definition/);
    });
  }

  it("refreshes a maintained view at a validity boundary without a new delta", () => {
    const reactor = new Reactor();
    expect(reactor.ingest(fixture["fact-later"]!).status).toBe("accepted");
    expect(reactor.ingest(fixture["bounded-negation"]!).status).toBe("accepted");
    const body = parseTerm({
      op: "group",
      key: "byTargetContext",
      in: { op: "mask", policy: "drop", in: "input" },
    });
    reactor.register("time", body, ["entity:time"], 279);
    expect(reactor.materializedView("time", "entity:time")?.props.get("value")).toBeUndefined();
    expect(reactor.nextValidityBoundary(279)).toBe(280);
    const changes = reactor.advanceTime(280);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.responsibleDeltaIds).toEqual([]);
    expect(reactor.materializedView("time", "entity:time")?.props.get("value")?.[0]?.delta.id).toBe(
      fixture["fact-later"]!.id,
    );
    const reversed = reactor.advanceTime(279);
    expect(reversed).toHaveLength(1);
    expect(reactor.materializedView("time", "entity:time")?.props.get("value")).toBeUndefined();
  });

  it("finds the next boundary through the maintained index in either ingest order", () => {
    const starts = [90, 10, 50, 30, 70, 20, 60, 80, 40, 100, 50];
    for (const order of [starts, [...starts].reverse()]) {
      const reactor = new Reactor();
      for (const start of order) {
        const delta = makeDelta({
          timestamp: 0,
          validFrom: start,
          validUntil: start + 5,
          author: "author:index",
          pointers: [{ role: "value", target: { kind: "primitive", value: start } }],
        });
        reactor.ingest(delta);
      }
      const boundaries = [...new Set(starts.flatMap((start) => [start, start + 5]))].sort(
        (a, b) => a - b,
      );
      for (const now of [0, 10, 15, 49, 50, 94, 100, 105]) {
        expect(reactor.nextValidityBoundary(now)).toBe(boundaries.find((at) => at > now));
      }
    }
  });
});
