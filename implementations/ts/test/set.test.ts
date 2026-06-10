import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/json-profile.js";
import { DeltaSet, federate, fork, makeDelta, makeNegationClaims, merge } from "../src/set.js";
import type { Claims, Delta, Pointer, Target } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  JSON.parse(readFileSync(resolve(here, "../../../vectors", rel), "utf8")) as never;

// --- generators -------------------------------------------------------------------------------

const targetArb: fc.Arbitrary<Target> = fc.oneof(
  fc
    .oneof(
      fc.string({ maxLength: 6 }),
      fc.integer({ min: -1000, max: 1000 }),
      fc.boolean() as fc.Arbitrary<string | number | boolean>,
    )
    .map((value): Target => ({ kind: "primitive", value })),
  fc
    .tuple(fc.constantFrom("e1", "e2", "e3"), fc.option(fc.constantFrom("c1", "c2")))
    .map(
      ([id, context]): Target =>
        context === null
          ? { kind: "entity", entity: { id } }
          : { kind: "entity", entity: { id, context } },
    ),
);

const pointerArb: fc.Arbitrary<Pointer> = fc.record({
  role: fc.constantFrom("r1", "r2", "r3"),
  target: targetArb,
});

const claimsArb: fc.Arbitrary<Claims> = fc.record({
  timestamp: fc.integer({ min: 0, max: 1_000_000 }),
  author: fc.constantFrom("did:key:zA", "did:key:zB", "did:key:zC"),
  pointers: fc.array(pointerArb, { minLength: 1, maxLength: 3 }),
});

const deltaArb: fc.Arbitrary<Delta> = claimsArb.map((c) => makeDelta(c));
const setArb: fc.Arbitrary<DeltaSet> = fc
  .array(deltaArb, { maxLength: 20 })
  .map((ds) => DeltaSet.from(ds));

const even = (d: Delta) => d.claims.timestamp % 2 === 0;

// --- CRDT laws (SPEC-1 §8) --------------------------------------------------------------------

describe("delta-set algebra: grow-only set CRDT laws", () => {
  it("merge is commutative", () => {
    fc.assert(fc.property(setArb, setArb, (a, b) => merge(a, b).digest() === merge(b, a).digest()));
  });

  it("merge is associative", () => {
    fc.assert(
      fc.property(
        setArb,
        setArb,
        setArb,
        (a, b, c) => merge(merge(a, b), c).digest() === merge(a, merge(b, c)).digest(),
      ),
    );
  });

  it("merge is idempotent", () => {
    fc.assert(fc.property(setArb, (a) => merge(a, a).digest() === a.digest()));
  });

  it("fork yields a subset whose members all satisfy the predicate", () => {
    fc.assert(
      fc.property(setArb, (a) => {
        const f = fork(a, even);
        return [...f].every((d) => a.has(d.id) && even(d));
      }),
    );
  });

  it("fork partitions: fork(p) ∪ fork(¬p) = identity", () => {
    fc.assert(
      fc.property(setArb, (a) => {
        const left = fork(a, even);
        const right = fork(a, (d) => !even(d));
        return merge(left, right).digest() === a.digest();
      }),
    );
  });

  it("federate(a, b, p) = merge(a, fork(b, p))", () => {
    fc.assert(
      fc.property(
        setArb,
        setArb,
        (a, b) => federate(a, b, even).digest() === merge(a, fork(b, even)).digest(),
      ),
    );
  });

  it("union deduplicates by id", () => {
    fc.assert(
      fc.property(deltaArb, (d) => {
        const s = DeltaSet.from([d, d, makeDelta(d.claims)]);
        return s.size === 1;
      }),
    );
  });
});

// --- guards & helpers ---------------------------------------------------------------------------

describe("delta-set guards", () => {
  it("rejects a delta whose id does not recompute (P6)", () => {
    const d = makeDelta(
      parseClaims({ timestamp: 0, author: "a", pointers: [{ role: "x", target: { value: 1 } }] }),
    );
    const forged: Delta = { ...d, id: `1e20${"00".repeat(32)}` };
    expect(() => new DeltaSet().add(forged)).toThrow(/content addressing/);
  });

  it("makeNegationClaims produces the SPEC-1 §7 shape", () => {
    const claims = makeNegationClaims("did:key:zA", 5, `1e20${"ab".repeat(32)}`, "superseded");
    const first = claims.pointers[0]!;
    expect(first.role).toBe("negates");
    expect(first.target.kind).toBe("delta");
    expect(claims.pointers[1]!.role).toBe("reason");
    // and it is a perfectly ordinary delta:
    expect(makeDelta(claims).id.startsWith("1e20")).toBe(true);
  });
});

// --- cross-impl digest vector -------------------------------------------------------------------

interface SetDigestVector {
  ids: string[];
  digest: string;
}

interface DeltaVector {
  claims: unknown;
}

describe("set-digest vector (ERRATA D10)", () => {
  it("reproduces the pinned digest of the deltas.json set", () => {
    const vec = read("l0-delta/set-digest.json") as SetDigestVector;
    const deltas = read("l0-delta/deltas.json") as DeltaVector[];
    const s = DeltaSet.from(deltas.map((v) => makeDelta(parseClaims(v.claims))));
    expect(s.ids()).toEqual(vec.ids);
    expect(s.digest()).toBe(vec.digest);
  });
});
