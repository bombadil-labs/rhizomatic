import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import {
  array,
  bool,
  bstr,
  type CborValue,
  decode,
  encode,
  float,
  map,
  tstr,
} from "../src/cbor.js";

const here = dirname(fileURLToPath(import.meta.url));
const primsPath = resolve(here, "../../../vectors/l0-delta/cbor-primitives.json");

interface Prim {
  name: string;
  kind: "tstr" | "bstr" | "float" | "bool";
  value: string | number | boolean;
  hex: string;
}

function build(p: Prim): CborValue {
  switch (p.kind) {
    case "tstr":
      return tstr(p.value as string);
    case "bstr":
      // bstr ground-truth value is the raw payload as a hex string (vectors/README convention)
      return bstr(hexToBytes(p.value as string));
    case "float":
      return float(p.value as number);
    case "bool":
      return bool(p.value as boolean);
  }
}

const prims = JSON.parse(readFileSync(primsPath, "utf8")) as Prim[];
const invalidLengths = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l0-delta/cbor-invalid-length.json"), "utf8"),
) as Array<{ name: string; hex: string; error: string }>;
const nesting = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l0-delta/cbor-nesting.json"), "utf8"),
) as Array<{
  name: string;
  prefixHex: string;
  repeat: number;
  suffixHex: string;
  expected: string;
}>;

describe("shared CBOR malformed-length vectors", () => {
  for (const c of invalidLengths) {
    it(c.name, () => expect(() => decode(hexToBytes(c.hex))).toThrow(c.error));
  }
});

describe("shared CBOR nesting boundary vectors", () => {
  for (const c of nesting) {
    it(c.name, () => {
      const bytes = hexToBytes(c.prefixHex.repeat(c.repeat) + c.suffixHex);
      if (c.expected === "valid") expect(() => decode(bytes)).not.toThrow();
      else expect(() => decode(bytes)).toThrow(c.expected);
    });
  }
});

describe("cbor primitive ground truth (RFC 8949 §4.2.1 / ERRATA D1–D3)", () => {
  for (const p of prims) {
    it(p.name, () => {
      expect(bytesToHex(encode(build(p)))).toBe(p.hex);
    });
  }
});

describe("cbor composites", () => {
  it("sorts map keys by encoded-key bytes (b before a -> a before b)", () => {
    expect(
      bytesToHex(
        encode(
          map([
            ["b", bool(true)],
            ["a", bool(false)],
          ]),
        ),
      ),
    ).toBe("a26161f46162f5");
  });

  it("preserves array order", () => {
    expect(bytesToHex(encode(array([tstr("a"), tstr("b")])))).toBe("8261616162");
  });

  it("is byte-honest: composed and decomposed spellings encode differently (D16)", () => {
    const composed = bytesToHex(encode(tstr("\u00e9")));
    const decomposed = bytesToHex(encode(tstr("e\u0301"))); // e + combining acute
    expect(composed).toBe("62c3a9");
    expect(decomposed).toBe("6365cc81"); // 3-byte tstr body: e + U+0301 as UTF-8
  });

  it("rejects non-finite numbers", () => {
    expect(() => encode(float(Number.NaN))).toThrow();
    expect(() => encode(float(Number.POSITIVE_INFINITY))).toThrow();
  });

  it("rejects lone UTF-16 surrogates before they can change signed bytes", () => {
    expect(() => encode(tstr("x\ud800"))).toThrow("not well-formed Unicode");
    expect(() => encode(tstr("x\udc00"))).toThrow("not well-formed Unicode");
    expect(() => encode(tstr("x😀"))).not.toThrow();
  });

  it("normalizes -0 to +0", () => {
    expect(bytesToHex(encode(float(-0)))).toBe("f90000");
  });
});
