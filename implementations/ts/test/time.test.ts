import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeId } from "../src/delta.js";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { Reactor } from "../src/reactor.js";
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
  });
});
