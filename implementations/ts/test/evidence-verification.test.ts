// F1 work regression, outside the existing semantic golden expectations.
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import * as sign from "../src/delta/sign.js";
import { encodeHViewEnvelope, decodeHViewEnvelope } from "../src/algebra/hview-envelope.js";
import { EvidenceCodecError } from "../src/syntax/evidence-codec.js";
import { parseClaims } from "../src/delta/json-profile.js";
import { fixtureView } from "./support/evidence-fixture.js";
import type { HVEntry, HView } from "../src/algebra/hview.js";
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../vectors/materialization/evidence-envelope.json", import.meta.url),
    "utf8",
  ),
);
const base = fixtureView(
  vectors.positives.find((v: { variant: string }) => v.variant === "original").native,
).props.get("child")![0]!.delta;
const make = (entries: HVEntry[]): HView => ({
  id: "item:fern",
  props: new Map([["value", entries]]),
});
for (const repeats of [1, 32, 1000])
  test(`F1 distinct appearance count at ${repeats} repeated entries`, () => {
    const spy = vi.spyOn(sign, "verifyCanonicalDelta");
    try {
      const second = fixtureView(
        vectors.positives.find((v: { variant: string }) => v.variant === "repeats").native,
      ).props.get("child")![0]!.delta;
      const entries = Array.from({ length: repeats }, () => ({
        delta: structuredClone(base),
        negated: false,
      }));
      entries.push(
        { delta: second, negated: false },
        { delta: { id: base.id, claims: base.claims }, negated: false },
      );
      const bytes = encodeHViewEnvelope(make(entries));
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockClear();
      decodeHViewEnvelope(bytes);
      expect(spy).toHaveBeenCalledTimes(2); // Includes final exact re-encode.
      spy.mockClear();
      encodeHViewEnvelope(make(entries));
      expect(spy).toHaveBeenCalledTimes(2); // No cross-invocation reuse.
    } finally {
      spy.mockRestore();
    }
  });
test("F1 same ID with a different signature must not reuse verification", () => {
  const spy = vi.spyOn(sign, "verifyCanonicalDelta");
  try {
    const valid = { delta: base, negated: false };
    const invalid = { delta: { ...base, sig: "00".repeat(64) }, negated: false };
    expect(() => encodeHViewEnvelope(make([valid, invalid]))).toThrow(
      new EvidenceCodecError("invalid-evidence"),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(() => encodeHViewEnvelope(make([invalid]))).toThrow(
      new EvidenceCodecError("invalid-evidence"),
    );
    expect(spy).toHaveBeenCalledTimes(3); // Failed checks are never reused across calls.
  } finally {
    spy.mockRestore();
  }
});
test("F1 mutable native identity and uppercase spelling cannot inherit a successful check", () => {
  const mutable = structuredClone(base);
  const entries: HVEntry[] = [
    { delta: mutable, negated: false },
    {
      get delta() {
        Object.assign(mutable, { sig: "00".repeat(64) });
        return mutable;
      },
      negated: false,
    },
  ];
  expect(() => encodeHViewEnvelope(make(entries))).toThrow(
    new EvidenceCodecError("invalid-evidence"),
  );
  expect(() =>
    encodeHViewEnvelope(
      make([
        { delta: base, negated: false },
        { delta: { ...base, sig: base.sig!.toUpperCase() }, negated: false },
      ]),
    ),
  ).toThrow(new EvidenceCodecError("invalid-evidence"));
});

test("F1 two valid signatures and unsigned form with the same ID remain distinct", () => {
  const v = JSON.parse(
    readFileSync(new URL("../../../vectors/command/execution.json", import.meta.url), "utf8"),
  ).fixtures.signatureVariants;
  const parse = (d: { id: string; claims: unknown; sig: string }) => ({
    ...d,
    claims: parseClaims(d.claims),
  });
  const first = parse(v.original),
    alternate = parse(v.alternate);
  const spy = vi.spyOn(sign, "verifyCanonicalDelta");
  try {
    const bytes = encodeHViewEnvelope(
      make([
        { delta: first, negated: false },
        { delta: alternate, negated: false },
        { delta: alternate, negated: false },
        { delta: { id: first.id, claims: first.claims }, negated: false },
      ]),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    const decoded = decodeHViewEnvelope(bytes);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(decoded.props.get("value")!.map((e) => e.delta.sig)).toEqual([
      first.sig,
      alternate.sig,
      alternate.sig,
      undefined,
    ]);
  } finally {
    spy.mockRestore();
  }
});
