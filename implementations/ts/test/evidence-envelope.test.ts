import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  decodeHViewEnvelope,
  encodeHViewEnvelope,
  type HViewEnvelopeLimits,
} from "../src/algebra/hview-envelope.js";
import { EvidenceCodecError } from "../src/syntax/evidence-codec.js";
import {
  decodeReadingAppearance,
  encodeReadingAppearance,
} from "../src/syntax/reading-appearance.js";
import { bytesToHex, contentAddress } from "../src/delta/hash.js";
import { hviewCanonicalHex, type HView } from "../src/algebra/hview.js";
import { resolveView } from "../src/resolve-kernel/resolution.js";
import { parseSchema } from "../src/syntax/term-json.js";
import {
  schemaHash,
  schemaToJson,
  cborToJson,
  jsonToCbor,
  termToJson,
} from "../src/syntax/term-io.js";
import { fixtureView, inspectView } from "./support/evidence-fixture.js";
import { DeltaSet } from "../src/delta/set.js";
import { checkReadingSyntax } from "../src/syntax/reading-budget.js";
import { checkReadingWireSyntax } from "../src/syntax/reading-wire-budget.js";
import { verifyDelta } from "../src/delta/sign.js";
import { bindReadingVariables } from "../src/syntax/bind-reading.js";
import { evalTermRaw } from "../src/resolve/eval.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import type { Policy, Term } from "../src/syntax/model.js";
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../vectors/materialization/evidence-envelope.json", import.meta.url),
    "utf8",
  ),
) as {
  positives: {
    id: string;
    variant: string;
    native: unknown;
    envelopeHex: string;
    transportId: string;
    existingHViewHex: string;
    limits?: Partial<HViewEnvelopeLimits>;
    originalReading?: unknown;
  }[];
  negative: {
    id: string;
    variant: string;
    envelopeHex: string;
    error: string;
    native?: unknown;
    limits?: Partial<HViewEnvelopeLimits>;
  }[];
  nativeReject: { id: string; variant: string; native: unknown; error: string }[];
  syntaxBudgets: {
    variant: string;
    native: unknown;
    nodes: number;
    depth: number;
    valid: boolean;
  }[];
  readingFixtures: {
    variant: string;
    native: unknown;
    appearanceHex: string;
    semanticPin: string;
  }[];
};
const corpusId = createHash("sha256")
  .update(
    readFileSync(
      new URL("../../../vectors/materialization/evidence-envelope.json", import.meta.url),
    ),
  )
  .digest("hex");
function assertionEvidence(group: string, v: { variant: string; id?: string }): void {
  console.log(
    "materialization-assertion:" +
      JSON.stringify({
        group,
        id: v.id ?? null,
        variant: v.variant,
        corpusId,
        assertions: expect.getState().assertionCalls,
      }),
  );
}
const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const reading = parseSchema({ props: {}, default: { pick: { order: "lexById" } } });
describe("SPEC-16 shared envelope vectors", () => {
  for (const v of vectors.positives)
    test(`${v.id}/${v.variant}`, () => {
      expect.assertions(6 + (["legacy", "annotations", "bound"].includes(v.variant) ? 1 : 0));
      const native = fixtureView(v.native),
        encoded = encodeHViewEnvelope(native, v.limits),
        decoded = decodeHViewEnvelope(hex(v.envelopeHex), v.limits);
      expect(bytesToHex(encoded)).toBe(v.envelopeHex);
      expect(contentAddress(encoded)).toBe(v.transportId);
      expect(bytesToHex(encodeHViewEnvelope(decoded, v.limits))).toBe(v.envelopeHex);
      expect(inspectView(decoded)).toEqual(inspectView(native));
      expect(hviewCanonicalHex(native)).toBe(v.existingHViewHex);
      expect(hviewCanonicalHex(decoded)).toBe(v.existingHViewHex);
      if (v.variant === "legacy") expect(() => resolveView(reading, decoded)).toThrow(/reading/i);
      if (v.variant === "annotations")
        expect(resolveView(reading, decoded)).toEqual(resolveView(reading, native));
      if (v.variant === "bound")
        expect(schemaHash([...decoded.props.values()][0]![0]!.readings!.get(1)!)).not.toBe(
          schemaHash(parseSchema(v.originalReading)),
        );
      assertionEvidence("positives", v);
    });
  for (const v of vectors.negative)
    test(`${v.id}/${v.variant}`, () => {
      expect.assertions(1 + (v.native !== undefined ? 1 : 0));
      if (v.native !== undefined)
        expect(() => encodeHViewEnvelope(fixtureView(v.native), v.limits)).toThrow(
          new EvidenceCodecError(v.error as "invalid-evidence" | "resource-limit"),
        );
      expect(() => decodeHViewEnvelope(hex(v.envelopeHex), v.limits)).toThrow(
        new EvidenceCodecError(v.error as "invalid-evidence" | "resource-limit"),
      );
      assertionEvidence("negative", v);
    });
  for (const v of vectors.nativeReject)
    test(`${v.id}/${v.variant}`, () => {
      expect.assertions(2);
      const native = fixtureView(v.native),
        d = [...native.props.values()][0]![0]!.delta;
      expect(verifyDelta(d)).toBe("verified");
      expect(() => encodeHViewEnvelope(native)).toThrow(new EvidenceCodecError("invalid-evidence"));
      assertionEvidence("nativeReject", v);
    });
  for (const v of vectors.readingFixtures)
    test(`reading/${v.variant}`, () => {
      expect.assertions(3);
      const native = parseSchema(v.native),
        decoded = decodeReadingAppearance(hex(v.appearanceHex));
      expect(bytesToHex(encodeReadingAppearance(native))).toBe(v.appearanceHex);
      expect(schemaToJson(decoded)).toEqual(schemaToJson(native));
      expect(schemaHash(decoded)).toBe(v.semanticPin);
      assertionEvidence("readingFixtures", v);
    });
  test("env_reading_metadata/metadata-excluded-from-old-hash", () => {
    const input = fixtureView(vectors.positives.find((v) => v.variant === "metadata")!.native),
      es = input.props.get("child")!,
      e = es[0]!;
    const changed: HView = {
      ...input,
      props: new Map([
        [
          "child",
          [
            {
              ...e,
              readings: new Map(
                [...e.readings!].map(([i, s]) => [i, { ...s, name: "Another", alg: 9 }]),
              ),
            },
          ],
        ],
      ]),
    };
    expect(hviewCanonicalHex(input)).toBe(hviewCanonicalHex(changed));
    expect(bytesToHex(encodeHViewEnvelope(input))).not.toBe(
      bytesToHex(encodeHViewEnvelope(changed)),
    );
  });
  test("env_finite_bounds/native-cycle", () => {
    const native = fixtureView(vectors.positives[0]!.native),
      e = native.props.get("child")![0]!;
    (e.expanded as Map<number, HView>).set(1, native);
    expect(() => encodeHViewEnvelope(native)).toThrow(new EvidenceCodecError("invalid-evidence"));
  });
  test("env_finite_bounds/native-reading-sharing-and-cycle", () => {
    const shared = { ...reading, props: new Map([["repeated", reading.default]]) };
    expect(() => encodeReadingAppearance(shared, { syntaxNodes: 5, syntaxDepth: 3 })).not.toThrow();
    expect(() => encodeReadingAppearance(shared, { syntaxNodes: 4 })).toThrow(
      new EvidenceCodecError("resource-limit"),
    );
    const cyclic: Extract<Policy, { kind: "absentAs" }> = {
      kind: "absentAs",
      constant: 0,
      then: reading.default,
    };
    Object.assign(cyclic, { then: cyclic });
    expect(() => encodeReadingAppearance({ ...reading, default: cyclic })).toThrow(
      new EvidenceCodecError("invalid-evidence"),
    );
  });
  test("env_original_appearance/actual-fix-root", () => {
    const registry = SchemaRegistry.build([
      {
        name: "Fixed",
        alg: 1,
        body: { kind: "group", key: { kind: "const", prop: "value" }, of: { kind: "input" } },
      },
    ]);
    const fixed = evalTermRaw(
      { kind: "fix", schema: { kind: "name", name: "Fixed" }, entity: "fix:selected" },
      new DeltaSet(),
      undefined,
      registry,
    );
    expect(fixed.sort).toBe("hview");
    if (fixed.sort !== "hview") throw Error("fix sort");
    const original = fixtureView(vectors.positives[0]!.native),
      e = original.props.get("child")![0]!;
    const actual: HView = {
      ...original,
      props: new Map([["child", [{ ...e, expanded: new Map([[1, fixed.hview]]) }]]]),
    };
    const restored = decodeHViewEnvelope(encodeHViewEnvelope(actual));
    expect(restored.props.get("child")![0]!.expanded!.get(1)!.id).toBe("fix:selected");
    expect(e.delta.claims.pointers[1]!.target).toEqual({
      kind: "entity",
      entity: { id: "authored:second" },
    });
  });
  test("env_reading_metadata/reserved-keys-nested-bridges", () => {
    const r = parseSchema(vectors.readingFixtures.at(-1)!.native),
      json = schemaToJson(r) as { props: object };
    expect(Object.hasOwn(json.props, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(json.props)).toBe(Object.prototype);
    const bridged = cborToJson(jsonToCbor(json)) as { props: object };
    expect(Object.hasOwn(bridged.props, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(bridged.props)).toBe(Object.prototype);
    const fix: Term = {
      kind: "fix",
      schema: { kind: "name", name: "X" },
      entity: "E",
      bindings: new Map([["__proto__", "value"]]),
    };
    const out = termToJson({ kind: "resolve", schema: r, of: fix }) as {
      schema: { props: object };
      in: { bindings: object };
    };
    expect(Object.hasOwn(out.schema.props, "__proto__")).toBe(true);
    expect(Object.hasOwn(out.in.bindings, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out.in.bindings)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "value")).toBe(false);
  });
});

test("env_finite_bounds/semantic-grammar-boundaries", () => {
  expect.assertions(vectors.syntaxBudgets.reduce((n, v) => n + 3 + (v.valid ? 4 : 0), 0));
  for (const v of vectors.syntaxBudgets) {
    const before = expect.getState().assertionCalls;
    const raw = jsonToCbor(v.native),
      limits = { artifactBytes: 16777216, syntaxNodes: v.nodes, syntaxDepth: v.depth };
    expect(() => checkReadingWireSyntax(raw, limits), v.variant).not.toThrow();
    expect(
      () => checkReadingWireSyntax(raw, { ...limits, syntaxNodes: v.nodes - 1 }),
      v.variant,
    ).toThrow(new EvidenceCodecError("resource-limit"));
    expect(
      () => checkReadingWireSyntax(raw, { ...limits, syntaxDepth: v.depth - 1 }),
      v.variant,
    ).toThrow(new EvidenceCodecError("resource-limit"));
    if (v.valid) {
      const native = parseSchema(v.native);
      expect(() => checkReadingSyntax(native, limits)).not.toThrow();
      const bytes = encodeReadingAppearance(native, limits);
      expect(schemaToJson(decodeReadingAppearance(bytes, limits))).toEqual(schemaToJson(native));
      expect(() =>
        encodeReadingAppearance(native, { ...limits, syntaxNodes: v.nodes - 1 }),
      ).toThrow(new EvidenceCodecError("resource-limit"));
      expect(() => decodeReadingAppearance(bytes, { ...limits, syntaxDepth: v.depth - 1 })).toThrow(
        new EvidenceCodecError("resource-limit"),
      );
    }
    console.log(
      "materialization-assertion:" +
        JSON.stringify({
          group: "syntaxBudgets",
          id: null,
          variant: v.variant,
          corpusId,
          assertions: expect.getState().assertionCalls - before,
        }),
    );
  }
});
test("env_fixed_mixed_routes/independent-empty-oracles-local", () => {
  const vs = JSON.parse(
    readFileSync(
      new URL("../../../vectors/materialization/independent-empty-oracles.json", import.meta.url),
      "utf8",
    ),
  ) as {
    cases: {
      input: { root: { id: string; props: Record<string, []> } };
      expectedEnvelopeHex: string;
      expectedExistingHViewHex: string;
    }[];
  };
  for (const v of vs.cases) {
    const native = { id: v.input.root.id, props: new Map(Object.entries(v.input.root.props)) };
    expect(bytesToHex(encodeHViewEnvelope(native))).toBe(v.expectedEnvelopeHex);
    expect(hviewCanonicalHex(native)).toBe(v.expectedExistingHViewHex);
  }
});

test("env_bound_reading/actual-fix-local-binding", () => {
  const v = vectors.positives.find((v) => v.variant === "bound")!,
    native = fixtureView(v.native),
    bound = native.props.get("child")![0]!.readings!.get(1)!;
  const author = native.props.get("child")![0]!.delta.claims.author;
  const actual = bindReadingVariables(parseSchema(v.originalReading), new Map([["owner", author]]));
  expect(schemaToJson(actual)).toEqual(schemaToJson(bound));
  expect(bytesToHex(encodeReadingAppearance(actual))).toBe(
    bytesToHex(encodeReadingAppearance(bound)),
  );
});

test("env_all_pointer_sorts/native-negative-zero", () => {
  const v = vectors.positives.find((v) => v.variant === "all-targets")!,
    native = fixtureView(v.native),
    e = native.props.get("child")![0]!;
  const pointers = e.delta.claims.pointers.map((p, i) =>
    i === 3 ? { ...p, target: { kind: "primitive" as const, value: -0 } } : p,
  );
  const changed: HView = {
    ...native,
    props: new Map([
      ["child", [{ ...e, delta: { ...e.delta, claims: { ...e.delta.claims, pointers } } }]],
    ]),
  };
  expect(bytesToHex(encodeHViewEnvelope(changed))).toBe(v.envelopeHex);
});
