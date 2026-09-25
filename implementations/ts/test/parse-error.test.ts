import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ParseError, parsePred, parseTerm } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-parse-errors.json"), "utf8"),
) as {
  cases: Array<{
    name: string;
    parse: "term" | "pred";
    input: unknown;
    error: { kind: string; path: string };
  }>;
};

describe("SPEC-2 §8 structured parse diagnostics", () => {
  for (const c of doc.cases) {
    it(c.name, () => {
      const parse = c.parse === "term" ? parseTerm : parsePred;
      let caught: unknown;
      try {
        parse(c.input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ParseError);
      const error = caught as ParseError;
      expect({ kind: error.kind, path: error.path }).toEqual(c.error);
      expect(error.message.length).toBeGreaterThan(0);
    });
  }
});
