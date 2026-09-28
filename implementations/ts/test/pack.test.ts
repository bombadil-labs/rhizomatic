import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "@noble/hashes/utils";
import { array, decode, encode, float, map, type CborValue } from "../src/cbor.js";
import { bytesToHex } from "../src/hash.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/json-profile.js";
import { packId, packSet, unpackSet } from "../src/pack.js";
import { makeManifestClaims } from "../src/reactor.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { signClaims, authorForSeed } from "../src/sign.js";
import type { Delta } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  JSON.parse(readFileSync(resolve(here, "../../../vectors", rel), "utf8")) as never;

const basic = read("l1-eval/eval-basic.json") as {
  fixture: { deltas: Array<{ claims: unknown }> };
};
const keys = read("keys/keys.json") as Array<{ seedHex: string }>;
const baseDeltas = basic.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims)));

// A worked bundle: manifest by zBundler at ts 5000; members include a DIVERGENT author
// (the fixture deltas have their own authors/timestamps) and a signed member.
function bundleWorld(): DeltaSet {
  const signedMember = signClaims(
    parseClaims({
      timestamp: 4900,
      validFrom: 4900,
      author: authorForSeed(keys[0]!.seedHex),
      pointers: [{ role: "note", target: "covered" }],
    }),
    keys[0]!.seedHex,
  );
  const members = [...baseDeltas.slice(0, 4), signedMember];
  const manifest = makeDelta(
    makeManifestClaims(
      "did:key:zBundler",
      5000,
      members.map((m) => m.id),
      { intent: "pack fixture" },
    ),
  );
  // a second manifest claiming an overlapping member (multiply-claimed)
  const manifest2 = makeDelta(
    makeManifestClaims("did:key:zBundler", 5001, [members[0]!.id], { prior: manifest.id }),
  );
  return DeltaSet.from([...members, manifest, manifest2, ...baseDeltas.slice(4)]);
}

describe("packs (SPEC-8, ERRATA-8)", () => {
  it("round-trips byte-exactly: pack -> unpack -> identical set", () => {
    const set = bundleWorld();
    const bytes = packSet(set);
    const back = unpackSet(bytes);
    expect(back.digest()).toBe(set.digest());
    // and every delta is byte-identical (ids recomputed through makeDelta on the way out)
    for (const d of set) expect(back.get(d.id)?.sig).toEqual(d.sig);
  });

  it("packing is deterministic: same set => same bytes => same packId", () => {
    const set = bundleWorld();
    const a = packSet(set);
    const b = packSet(DeltaSet.from([...set])); // rebuilt in different insertion order
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(packId(a)).toBe(packId(b));
  });

  it("repacking an unpacked set reproduces the identical pack (logical form is sacred)", () => {
    const set = bundleWorld();
    const bytes = packSet(set);
    expect(bytesToHex(packSet(unpackSet(bytes)))).toBe(bytesToHex(bytes));
  });

  it("a corrupted member fails the content-address check on unpack", () => {
    const set = bundleWorld();
    const hex = bytesToHex(packSet(set));
    // flip a byte inside the strings section (find a fixture author string and mutate it)
    const target = Buffer.from("did:key:zAlice").toString("hex");
    const corrupted = hex.replace(target, Buffer.from("did:key:zEvils").toString("hex"));
    expect(corrupted).not.toBe(hex);
    expect(() => unpackSet(hexToBytes(corrupted))).toThrow();
  });

  it("rejects out-of-range pack indices from shared vectors", () => {
    const vector = read("l0-pack/invalid-index.json") as {
      cases: Array<{
        source: string;
        section: string;
        field: string;
        index: number;
        error: string;
      }>;
    };
    const principal = read("principal/evidence.json") as {
      deltas: Array<{ name: string; id: string; sig: string; claims: unknown }>;
    };
    for (const c of vector.cases) {
      const bytes =
        c.source === "pack.json"
          ? hexToBytes((read("l0-pack/pack.json") as { packHex: string }).packHex)
          : packSet(
              DeltaSet.from(
                principal.deltas
                  .filter((d) => d.name === "userRootDeclaration")
                  .map((d) => ({ id: d.id, sig: d.sig, claims: parseClaims(d.claims) })),
              ),
            );
      const top = decode(bytes);
      if (top.t !== "map") throw new Error("expected pack map");
      let changed = false;
      const fields: Array<[string, CborValue]> = top.v.map(([key, value]) => {
        if (key !== c.section || value.t !== "array") return [key, value];
        const records = value.v.map((record) => {
          if (changed || record.t !== "map" || !record.v.some(([field]) => field === c.field))
            return record;
          changed = true;
          return map(
            record.v.map(([field, item]) => [field, field === c.field ? float(c.index) : item]),
          );
        });
        return [key, array(records)];
      });
      expect(changed).toBe(true);
      expect(() => unpackSet(encode(map(fields)))).toThrow(c.error);
    }
  });

  it("rejects huge malformed container lengths before unpacking", () => {
    const cases = read("l0-delta/cbor-invalid-length.json") as Array<{
      hex: string;
      error: string;
    }>;
    for (const c of cases) expect(() => unpackSet(hexToBytes(c.hex))).toThrow(c.error);
  });

  it("property: pack/unpack round-trips arbitrary sets", () => {
    const claimsArb = fc.record({
      timestamp: fc.integer({ min: 0, max: 100000 }),
      validFrom: fc.integer({ min: 0, max: 100000 }),
      author: fc.constantFrom("did:key:zA", "did:key:zB"),
      pointers: fc.array(
        fc.record({
          role: fc.constantFrom("r1", "r2"),
          target: fc.oneof(
            fc.constantFrom("x", "y", 7, true).map((value) => ({
              kind: "primitive" as const,
              value,
            })),
            fc.constantFrom("e1", "e2").map((id) => ({
              kind: "entity" as const,
              entity: { id, context: "c" },
            })),
          ),
        }),
        { minLength: 1, maxLength: 3 },
      ),
    });
    fc.assert(
      fc.property(fc.array(claimsArb, { maxLength: 12 }), (cs) => {
        const set = DeltaSet.from(cs.map((c) => makeDelta(c as never)));
        return unpackSet(packSet(set)).digest() === set.digest();
      }),
      { numRuns: 60 },
    );
  });

  for (const file of ["l0-pack/pack.json", "l0-pack/pack-bytes.json"]) {
    it(`matches the cross-impl pack vector (${file})`, () => {
      const vec = read(file) as {
        deltas: Array<{ claims: unknown; sig?: string }>;
        packHex: string;
        packId: string;
      };
      const set = DeltaSet.from(vec.deltas.map((d) => makeDelta(parseClaims(d.claims), d.sig)));
      const bytes = packSet(set);
      expect(bytesToHex(bytes)).toBe(vec.packHex);
      expect(packId(bytes)).toBe(vec.packId);
      expect(unpackSet(hexToBytes(vec.packHex)).digest()).toBe(set.digest());
    });
  }
});

// keep the type import used
const _t: Delta | undefined = undefined;
void _t;
