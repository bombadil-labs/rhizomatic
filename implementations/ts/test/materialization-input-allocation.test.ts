import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { expect, it, vi } from "vitest";
import * as base64 from "../src/delta/b64u.js";
import * as delta from "../src/delta/delta.js";
import {
  encode,
  float,
  tstr,
  cborHeadByteLength,
  cborFloatByteLength,
  cborTextByteLength,
} from "../src/delta/cbor.js";
import { captureDeltaDebugDelivery } from "../src/delta/json-profile.js";
import { MaterializationEndpoint } from "../src/command/materialization-endpoint.js";
import { signClaims } from "../src/delta/sign.js";
import { serializeCommandDelta, parseCommandDelta } from "../src/command-data/codec.js";
import {
  materializationInputCatalog,
  prepareMaterializationInput,
} from "../src/command/materialization-input.js";
import { preflightMaterializationInput } from "../src/command/materialization-preflight.js";
const fixture = JSON.parse(
  readFileSync(new URL("../../../vectors/materialization/commands.json", import.meta.url), "utf8"),
);
it("size primitives use the exact existing preferred widths and Unicode encoding", () => {
  for (const [n, size] of [
    [0, 3],
    [-0, 3],
    [1.5, 3],
    [100000, 5],
    [1.1, 9],
  ]) {
    expect(cborFloatByteLength(n!)).toBe(size);
    expect(cborFloatByteLength(n!)).toBe(encode(float(n!)).length);
  }
  for (const [n, size] of [
    [23, 1],
    [24, 2],
    [255, 2],
    [256, 3],
    [65535, 3],
    [65536, 5],
    [4294967296, 9],
  ])
    expect(cborHeadByteLength(n!)).toBe(size);
  for (const s of ["", "é", "\ud83d\udc1b", "a".repeat(24), "a".repeat(256)])
    expect(cborTextByteLength(s)).toBe(encode(tstr(s)).length);
  expect(cborTextByteLength("é")).toBe(3);
  expect(cborTextByteLength("\ud83d\udc1b")).toBe(5);
  expect(() => cborTextByteLength("\ud800")).toThrow();
  expect(() => cborFloatByteLength(Infinity)).toThrow();
});
it("base64 count validates tail bits and agrees without decoder use", () => {
  for (const s of ["", "AA", "AAA", "AAAA", "SGVsbG8", "__8"])
    expect(base64.b64uDecodedLength(s)).toBe(base64.b64uDecode(s).length);
  for (const s of ["A", "AB", "AAB", "AA=", "é"])
    expect(() => base64.b64uDecodedLength(s)).toThrow();
});
it("owned capture byte count exactly matches canonical C plus decoded signature length", () => {
  const raw = fixture.positives[0].delivery;
  const size = raw.reduce((n: number, r: unknown) => {
    const d = parseCommandDelta(r);
    return n + delta.canonicalBytes(d.claims).length + (d.sig?.length ?? 0) / 2;
  }, 0);
  expect(
    captureDeltaDebugDelivery(raw, {
      deliveryAppearances: raw.length,
      pointers: 4096,
      deliveryBytes: size,
    }),
  ).toEqual(raw);
  expect(() =>
    captureDeltaDebugDelivery(raw, {
      deliveryAppearances: raw.length,
      pointers: 4096,
      deliveryBytes: size - 1,
    }),
  ).toThrow("resource-limit");
});
it("every target arm has exact size, including contexts, Unicode and optional validity", () => {
  const raw = {
    id: "x",
    sig: "Aa00",
    claims: {
      timestamp: -0,
      validFrom: 1.5,
      validUntil: 100000,
      author: "é",
      pointers: [
        true,
        1.1,
        "🐛",
        { id: "", context: "ctx" },
        { delta: "ref", context: "🐛" },
        { mime: "text/é", value: "AAA" },
      ].map((target) => ({ role: "r", target })),
    },
  };
  const d = parseCommandDelta(raw),
    size = delta.canonicalBytes(d.claims).length + 2;
  expect(
    captureDeltaDebugDelivery([raw], { deliveryAppearances: 1, pointers: 6, deliveryBytes: size }),
  ).toEqual([raw]);
  expect(() =>
    captureDeltaDebugDelivery([raw], {
      deliveryAppearances: 1,
      pointers: 6,
      deliveryBytes: size - 1,
    }),
  ).toThrow("resource-limit");
});
for (const id of [
  "delivery_scan_oversized_carrier",
  "delivery_scan_oversized_malformed_sibling",
  "delivery_scan_oversized_malformed_sibling_reverse",
]) {
  it(`oversized input never enters payload decoder or canonical buffer/${id}`, async () => {
    const f = fixture.negatives.find((f: { id: string }) => f.id === id),
      b = f.boot ?? fixture.boot;
    const boot = {
      configuration: parseCommandDelta(b.configuration),
      declarations: b.declarations.map(parseCommandDelta),
      bindings: b.bindings.map(parseCommandDelta),
    };
    const c = materializationInputCatalog(boot);
    const endpoint = MaterializationEndpoint.boot({
      ...boot,
      sourceGrants: new Map(),
      diagnostic: () => {},
      signer: {
        author: fixture.keys.receiver,
        sign: (claims) => signClaims(claims, fixture.seeds.receiver),
      },
    });
    const allowed = [
      boot.configuration,
      ...boot.declarations,
      ...boot.bindings,
      parseCommandDelta(f.expected.outcome),
    ].map((d) => d.claims);
    const decode = vi.spyOn(base64, "b64uDecode"),
      canonical = vi.spyOn(delta, "canonicalBytes");
    try {
      expect(() => prepareMaterializationInput(c, f.request.id, f.delivery, 1000)).toThrow(
        f.expected.code,
      );
      expect(decode).not.toHaveBeenCalled();
      expect(canonical).not.toHaveBeenCalled();
      expect(preflightMaterializationInput(boot, f.request.id, f.delivery, 1000)).toEqual({
        status: f.expected.code === "resource-limit" ? "over-input-limit" : "invalid-input",
        code: f.expected.code,
      });
      expect(decode).not.toHaveBeenCalled();
      // Boot verification legitimately constructs its own small canonical bytes. None of
      // these calls contain an offered appearance, including the 16KiB carrier.
      expect(
        canonical.mock.calls.every(([claims]) => allowed.some((d) => isDeepStrictEqual(d, claims))),
      ).toBe(true);
      expect(serializeCommandDelta(await endpoint.invoke(f.request.id, f.delivery, 1000))).toEqual(
        f.expected.outcome,
      );
      expect(decode).not.toHaveBeenCalled();
      expect(
        canonical.mock.calls.every(([claims]) => allowed.some((d) => isDeepStrictEqual(d, claims))),
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
}
