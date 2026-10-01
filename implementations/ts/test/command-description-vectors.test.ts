import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { canonicalHex } from "../src/delta/delta.js";
import { claimsToJson } from "../src/delta/json-profile.js";
import { decodeView, viewCanonicalHex, viewToJson } from "../src/resolve-kernel/resolution.js";
import {
  commandFields,
  commandText,
  decodeBindings,
  encodeBindings,
  parseCommandDelta,
  readConfiguration,
  readOperation,
  readOutcome,
  readRequestArguments,
  verifyCommandAppearance,
  writeCommandDescription,
} from "../src/command-data/codec.js";
interface Case {
  id: string;
  scenario: string;
  kind: string;
  input: unknown;
  operationKind?: "retain" | "evaluate";
  expected: { valid: boolean; canonicalHex?: string; view?: unknown; bindings?: unknown };
}
const fixture = JSON.parse(
  readFileSync(new URL("../../../vectors/command/descriptions.json", import.meta.url), "utf8"),
) as { seed: string; cases: Case[] };
describe("command shared M1 descriptions", () => {
  for (const c of fixture.cases)
    it(`${c.scenario}:${c.id}`, () => {
      const run = () => {
        if (c.kind === "view") {
          const v = decodeView(hexToBytes(c.input as string));
          expect(viewCanonicalHex(v)).toBe(c.expected.canonicalHex);
          expect(viewToJson(v)).toEqual(c.expected.view);
        } else if (c.kind === "bindings") {
          const v = decodeBindings(hexToBytes(c.input as string));
          expect(v).toEqual(c.expected.bindings);
          expect(Buffer.from(encodeBindings(v)).toString("hex")).toBe(c.expected.canonicalHex);
        } else {
          const d = parseCommandDelta(c.input);
          verifyCommandAppearance(d);
          if (c.kind === "configuration") readConfiguration(d);
          else if (c.kind === "operation") readOperation(d);
          else if (c.kind === "request") readRequestArguments(d, c.operationKind!);
          else readOutcome(d);
          expect(canonicalHex(d.claims)).toBe(c.expected.canonicalHex);
          const f = { ...commandFields(d) };
          const kind = commandText(f, "kind") as
            | "endpoint/1"
            | "operation/1"
            | "request/1"
            | "outcome/1";
          delete f.kind;
          const written = writeCommandDescription(fixture.seed, 10, kind, f);
          expect(claimsToJson(written.claims)).toEqual(claimsToJson(d.claims));
          expect(written.id).toBe(d.id);
          expect(written.sig).toBe(d.sig);
        }
      };
      if (c.expected.valid) run();
      else expect(run).toThrow();
    });
});
