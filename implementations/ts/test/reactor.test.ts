import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { Reactor } from "../src/reactor.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { authorForSeed, signClaims } from "../src/sign.js";
import { parseTerm } from "../src/term-json.js";
import type { Delta } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  JSON.parse(readFileSync(resolve(here, "../../../vectors", rel), "utf8")) as never;

const basic = read("l1-eval/eval-basic.json") as {
  fixture: { deltas: Array<{ name: string; id: string; claims: unknown }> };
};
const resolveDoc = read("l1-eval/eval-resolve.json") as {
  fixture: { deltas: Array<{ claims: unknown }> };
};
const keys = read("keys/keys.json") as Array<{ keyId: string; seedHex: string }>;

const basicDeltas = basic.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims)));
const resolveDeltas = resolveDoc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims)));

function ingestAll(deltas: readonly Delta[]): Reactor {
  const r = new Reactor();
  for (const d of deltas) {
    const result = r.ingest(d);
    if (result.status !== "accepted") throw new Error(`unexpected ${result.status}`);
  }
  return r;
}

describe("ingest pipeline (SPEC-4 §2, ERRATA-4 V3)", () => {
  it("accepts, deduplicates, and is idempotent downstream", () => {
    const r = new Reactor();
    expect(r.ingest(basicDeltas[0]!)).toEqual({ status: "accepted" });
    expect(r.ingest(basicDeltas[0]!)).toEqual({ status: "duplicate" });
    expect(r.size).toBe(1);
    expect(r.arrivalLog()).toHaveLength(1);
  });

  it("rejects a forged content address, leaving no trace", () => {
    const r = new Reactor();
    const forged: Delta = { ...basicDeltas[0]!, id: `1e20${"00".repeat(32)}` };
    const result = r.ingest(forged);
    expect(result.status).toBe("rejected");
    expect(r.size).toBe(0);
    expect(r.byTarget("movie:matrix")).toEqual([]);
  });

  it("accepts a correctly signed delta and rejects a tampered signature", () => {
    const key = keys[0]!;
    const claims = parseClaims({
      timestamp: 5,
      author: authorForSeed(key.seedHex),
      pointers: [{ role: "x", target: "y" }],
    });
    const signed = signClaims(claims, key.seedHex);
    const r = new Reactor();
    expect(r.ingest(signed).status).toBe("accepted");

    const flipped = { ...signed, sig: (signed.sig![0] === "0" ? "1" : "0") + signed.sig!.slice(1) };
    const r2 = new Reactor();
    expect(r2.ingest(flipped)).toEqual({ status: "rejected", reason: "signature does not verify" });
  });
});

describe("core indexes (SPEC-4 §3, ERRATA-4 V1)", () => {
  const r = ingestAll(basicDeltas);
  const brute = (pred: (d: Delta) => boolean) =>
    basicDeltas
      .filter(pred)
      .map((d) => d.id)
      .sort();

  it("target index agrees with a full scan", () => {
    for (const entity of ["movie:matrix", "movie:johnwick", "nope"]) {
      expect(r.byTarget(entity)).toEqual(
        brute((d) =>
          d.claims.pointers.some(
            (p) => p.target.kind === "entity" && p.target.entity.id === entity,
          ),
        ),
      );
    }
  });

  it("negation index agrees with a full scan", () => {
    for (const d of basicDeltas) {
      expect(r.negationsOf(d.id)).toEqual(
        brute((n) =>
          n.claims.pointers.some(
            (p) =>
              p.role === "negates" && p.target.kind === "delta" && p.target.deltaRef.delta === d.id,
          ),
        ),
      );
    }
  });

  it("value index range query agrees with evaluation", () => {
    const rr = ingestAll(resolveDeltas);
    const viaIndex = rr.byValueBetween("value", 5, 2000);
    const viaEval = rr.eval(
      parseTerm({
        op: "select",
        pred: { hasPointer: { role: { exact: "value" }, targetValue: { between: [5, 2000] } } },
        in: "input",
      }),
    );
    if (viaEval.sort !== "dset") throw new Error("expected dset");
    expect(viaIndex).toEqual(viaEval.set.ids());
  });
});

describe("order convergence (SPEC-4 §2, ERRATA-4 V4)", () => {
  it("any ingestion order converges to identical state", () => {
    const reference = ingestAll(basicDeltas);
    const refDigest = reference.digest();
    const refEval = resultCanonicalHex(
      reference.eval(parseTerm({ op: "mask", policy: "drop", in: "input" })),
    );
    fc.assert(
      fc.property(fc.shuffledSubarray(basicDeltas, { minLength: basicDeltas.length }), (perm) => {
        const r = ingestAll(perm);
        if (r.digest() !== refDigest) return false;
        for (const d of basicDeltas) {
          if (r.negationsOf(d.id).join() !== reference.negationsOf(d.id).join()) return false;
        }
        if (r.byTarget("movie:matrix").join() !== reference.byTarget("movie:matrix").join()) {
          return false;
        }
        const e = resultCanonicalHex(
          r.eval(parseTerm({ op: "mask", policy: "drop", in: "input" })),
        );
        return e === refEval;
      }),
      { numRuns: 50 },
    );
  });

  it("negations arriving before their targets still converge", () => {
    // d4 negates d2; ingest d4 first, then d2.
    const byName = new Map(basic.fixture.deltas.map((d, i) => [d.name, basicDeltas[i]!]));
    const d2 = byName.get("d2-title-reloaded")!;
    const d4 = byName.get("d4-negates-d2")!;
    const rest = basicDeltas.filter((d) => d.id !== d2.id && d.id !== d4.id);
    const r = ingestAll([d4, d2, ...rest]);
    expect(r.digest()).toBe(DeltaSet.from(basicDeltas).digest());
    expect(r.negationsOf(d2.id)).toEqual([d4.id]);
  });

  it("read-your-writes: an accepted delta is immediately visible (SPEC-4 §6)", () => {
    const r = new Reactor();
    const d = basicDeltas[0]!;
    r.ingest(d);
    expect(r.has(d.id)).toBe(true);
    expect(r.get(d.id)?.id).toBe(d.id);
  });
});
