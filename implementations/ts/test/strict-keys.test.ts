// Fail-closed KEY parsing (SPEC-2 §8, ERRATA-2 E19, issue #25). The shared vectors pin the
// contract every witness owes — rejection — while the suggestion quality below is TS-local
// ergonomics: error TEXT is deliberately not normative, so witnesses may word it differently.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/json-profile.js";
import { parseTerm } from "../src/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-strict-keys.json"), "utf8"),
) as { rejects: Array<{ name: string; reason: string; term: unknown }> };

describe("l1-eval strict-key rejects (SPEC-2 §8 / E19)", () => {
  for (const r of doc.rejects) {
    it(`${r.name} — ${r.reason}`, () => {
      expect(() => parseTerm(r.term)).toThrow();
    });
  }
});

describe("rejection messages name the offending key (SHOULD, SPEC-2 §8)", () => {
  it("suggests the nearest key for a typo", () => {
    expect(() =>
      parseTerm({
        op: "expand",
        role: { exact: "a" },
        schema: "S",
        readng: "R",
        in: { op: "group", key: "byRole", in: "input" },
      }),
    ).toThrow(/unknown key "readng".*did you mean "reading"/);
  });

  it("points at version skew when nothing is near", () => {
    expect(() => parseTerm({ op: "select", pred: "true", in: "input", quantumFlux: 1 })).toThrow(
      /unknown key "quantumFlux".*newer rhizomatic/s,
    );
  });

  it("names both arms when a one-of node is ambiguous", () => {
    expect(() =>
      parseTerm({
        op: "select",
        pred: { hasPointer: { role: { exact: "a", prefix: "b" } } },
        in: "input",
      }),
    ).toThrow(/ambiguous.*"exact" and "prefix"/);
  });

  it("names the ambiguous target discriminators at L0", () => {
    expect(() =>
      parseClaims({
        timestamp: 0,
        author: "did:key:zA",
        pointers: [{ role: "r", target: { id: "e", delta: "1e2000" } }],
      }),
    ).toThrow(/ambiguous.*"id" and "delta"/);
  });
});

describe("genuinely open nodes stay open (issue #25)", () => {
  // These two are author-keyed data, not grammar: strictness here would be a bug.
  it("fix.bindings accepts arbitrary hole names", () => {
    expect(() =>
      parseTerm({
        op: "fix",
        schema: "S",
        entity: "e",
        bindings: { anyHoleName: 1, another: "x" },
      }),
    ).not.toThrow();
  });

  it("schema.props accepts arbitrary property names", () => {
    expect(() =>
      parseTerm({
        op: "resolve",
        schema: {
          props: { anyPropertyName: { pick: { order: "lexById" } } },
          default: { pick: { order: "lexById" } },
        },
        in: "input",
      }),
    ).not.toThrow();
  });
});
