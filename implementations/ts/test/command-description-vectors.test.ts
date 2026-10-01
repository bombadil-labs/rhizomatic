import { signClaims } from "../src/delta/sign.js";
import { decode, encode, bstr } from "../src/delta/cbor.js";
import { readCommandResult } from "../src/command/read-result.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { canonicalHex } from "../src/delta/delta.js";
import { claimsToJson } from "../src/delta/json-profile.js";
import { decodeView, viewCanonicalHex, viewToJson } from "../src/resolve-kernel/resolution.js";
import {
  commandFields,
  commandText,
  commandRef,
  commandEntity,
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
  expected: {
    valid: boolean;
    canonicalHex?: string;
    writerCanonicalHex?: string;
    view?: unknown;
    bindings?: unknown;
  };
}
const fixture = JSON.parse(
  readFileSync(
    process.env.COMMAND_VECTOR_PATH ??
      new URL("../../../vectors/command/descriptions.json", import.meta.url),
    "utf8",
  ),
) as { seed: string; cases: Case[] };
describe("command shared M1 descriptions", () => {
  for (const c of fixture.cases)
    it(`${c.scenario}:${c.id}`, () => {
      const run = () => {
        if (c.kind === "view") {
          const v = decodeView(hexToBytes(c.input as string));
          if (!c.expected.valid) return;
          expect(viewCanonicalHex(v)).toBe(c.expected.canonicalHex);
          expect(viewToJson(v)).toEqual(c.expected.view);
        } else if (c.kind === "bindings") {
          const v = decodeBindings(hexToBytes(c.input as string));
          if (!c.expected.valid) return;
          expect(v).toEqual(c.expected.bindings);
          expect(Buffer.from(encodeBindings(v)).toString("hex")).toBe(c.expected.canonicalHex);
        } else {
          const d = parseCommandDelta(c.input);
          verifyCommandAppearance(d);
          if (c.kind === "configuration") readConfiguration(d);
          else if (c.kind === "operation") readOperation(d);
          else if (c.kind === "request") readRequestArguments(d, c.operationKind!);
          else readOutcome(d);
          if (!c.expected.valid) return;
          expect(canonicalHex(d.claims)).toBe(c.expected.canonicalHex);
          const f = { ...commandFields(d) };
          const kind = commandText(f, "kind") as
            | "endpoint/1"
            | "operation/1"
            | "request/1"
            | "outcome/1";
          delete f.kind;
          const written = writeCommandDescription(fixture.seed, 10, kind, f);
          expect(canonicalHex(written.claims)).toBe(
            c.expected.writerCanonicalHex ?? c.expected.canonicalHex,
          );
          if (c.expected.writerCanonicalHex === undefined) {
            expect(claimsToJson(written.claims)).toEqual(claimsToJson(d.claims));
            expect(written.id).toBe(d.id);
            expect(written.sig).toBe(d.sig);
          }
        }
      };
      if (c.expected.valid) run();
      else expect(run).toThrow();
    });
});

describe("M1 complete reader and native inputs", () => {
  it("strict_argument_shapes:native-target-property-order", () => {
    const c = fixture.cases.find(
      (c) => c.kind === "request" && c.operationKind === "retain" && c.expected.valid,
    )!;
    const delta = parseCommandDelta(c.input);
    const pointer = delta.claims.pointers.find((p) => p.role.endsWith(".payload"))!;
    if (pointer.target.kind !== "delta") throw new Error("expected delta ref");
    const duplicate = {
      role: pointer.role,
      target: { deltaRef: { delta: pointer.target.deltaRef.delta }, kind: "delta" as const },
    };
    const signed = signClaims(
      { ...delta.claims, pointers: [...delta.claims.pointers, duplicate] },
      fixture.seed,
    );
    verifyCommandAppearance(signed);
    expect(() => readRequestArguments(signed, "retain")).toThrow();
  });
  it("outcome_body_strict:full-reader-valid-and-invalid-View", () => {
    const c = fixture.cases.find((c) => {
      if (c.kind !== "outcome" || !c.expected.valid) return false;
      return readOutcome(parseCommandDelta(c.input)).value !== undefined;
    })!;
    const delta = parseCommandDelta(c.input),
      outcome = readOutcome(delta);
    const context = {
      receiver: commandEntity(outcome.fields, "receiver"),
      configuration: commandRef(outcome.fields, "configuration"),
      request: commandRef(outcome.fields, "request"),
    };
    expect(readCommandResult(delta, context).view).toEqual({ hello: "world" });
    expect(() =>
      readCommandResult(delta, { ...context, request: "1e20" + "99".repeat(32) }),
    ).toThrow();
    const resultPointer = delta.claims.pointers.find((p) => p.role.endsWith(".result"))!;
    if (resultPointer.target.kind !== "bytes") throw new Error("expected bytes");
    const body = decode(resultPointer.target.value);
    if (body.t !== "map") throw new Error("expected map");
    const corrupt = encode({
      ...body,
      v: body.v.map(([k, v]) => [k, k === "value" ? bstr(new Uint8Array([0xf6])) : v] as const),
    });
    const bad = signClaims(
      {
        ...delta.claims,
        pointers: delta.claims.pointers.map((p) =>
          p === resultPointer
            ? { ...p, target: { kind: "bytes", mime: "application/cbor", value: corrupt } }
            : p,
        ),
      },
      fixture.seed,
    );
    expect(readOutcome(bad).value).toEqual(new Uint8Array([0xf6]));
    expect(() => readCommandResult(bad, context)).toThrow();
  });
});
