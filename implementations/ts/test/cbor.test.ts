import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import { array, bool, type CborValue, encode, float, map, tstr } from "../src/cbor.js";

const here = dirname(fileURLToPath(import.meta.url));
const primsPath = resolve(here, "../../../vectors/l0-delta/cbor-primitives.json");

interface Prim {
  name: string;
  kind: "tstr" | "float" | "bool";
  value: string | number | boolean;
  hex: string;
}

function build(p: Prim): CborValue {
  switch (p.kind) {
    case "tstr":
      return tstr(p.value as string);
    case "float":
      return float(p.value as number);
    case "bool":
      return bool(p.value as boolean);
  }
}

const prims = JSON.parse(readFileSync(primsPath, "utf8")) as Prim[];

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

  it("NFC-normalizes text before encoding (composed == decomposed)", () => {
    const composed = bytesToHex(encode(tstr("é"))); // é
    const decomposed = bytesToHex(encode(tstr("é"))); // e + combining acute
    expect(composed).toBe("62c3a9");
    expect(decomposed).toBe(composed);
  });

  it("rejects non-finite numbers", () => {
    expect(() => encode(float(Number.NaN))).toThrow();
    expect(() => encode(float(Number.POSITIVE_INFINITY))).toThrow();
  });

  it("normalizes -0 to +0", () => {
    expect(bytesToHex(encode(float(-0)))).toBe("fa00000000");
  });
});
