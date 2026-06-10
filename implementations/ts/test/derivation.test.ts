import { describe, expect, it } from "vitest";
import {
  DerivationHost,
  verifyPureDerivation,
  type BindingSpec,
  type DerivedFn,
} from "../src/derivation.js";
import { Reactor } from "../src/reactor.js";
import { makeDelta } from "../src/set.js";
import { parseTerm } from "../src/term-json.js";
import { VOCAB_PREFIX } from "../src/schema-deltas.js";
import type { Claims, HView, Pointer } from "../src/index.js";

const DERIVED_SEED = "0d".repeat(32);
const MOVIE = "movie:matrix";

// The watched materialization: everything pointing at the root, by target-context.
const movieBody = parseTerm({
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
});

// The fixture derived function: average the numeric "value" payloads of the rating property,
// emit one claim filing under derived:avgRating at the root.
const avgRating: DerivedFn = (view: HView, root: string): Pointer[][] => {
  const ratings = (view.props.get("rating") ?? [])
    .flatMap((e) => e.delta.claims.pointers)
    .filter((p) => p.role === "value" && p.target.kind === "primitive")
    .map((p) => (p.target as { value: unknown }).value)
    .filter((v): v is number => typeof v === "number");
  if (ratings.length === 0) return [];
  const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  return [
    [
      {
        role: "subject",
        target: { kind: "entity", entity: { id: root, context: "derived:avgRating" } },
      },
      { role: "value", target: { kind: "primitive", value: avg } },
    ],
  ];
};

const spec: BindingSpec = {
  name: "binding:avgRating",
  fnId: "fn:avgRating",
  materialization: "movie",
  pure: true,
  budget: 10,
  emit: "supersede",
};

const ratingClaim = (ts: number, author: string, value: number): Claims => ({
  timestamp: ts,
  author,
  pointers: [
    { role: "subject", target: { kind: "entity", entity: { id: MOVIE, context: "rating" } } },
    { role: "value", target: { kind: "primitive", value } },
  ],
});

function world(): { host: DerivationHost; author: string } {
  const reactor = new Reactor();
  reactor.register("movie", movieBody, [MOVIE]);
  const host = new DerivationHost(reactor);
  const author = host.install(spec, avgRating, DERIVED_SEED);
  return { host, author };
}

describe("derivation (SPEC-7, ERRATA-7)", () => {
  it("a pure derived author computes, signs, and writes back with full provenance", () => {
    const { host, author } = world();
    host.ingest(makeDelta(ratingClaim(1, "did:key:zA", 8)));
    host.ingest(makeDelta(ratingClaim(2, "did:key:zB", 9)));
    const view = host.reactor.materializedView("movie", MOVIE)!;
    const derivedEntries = view.props.get("derived:avgRating") ?? [];
    expect(derivedEntries).toHaveLength(1);
    const emitted = derivedEntries[0]!.delta;
    expect(emitted.claims.author).toBe(author);
    const value = emitted.claims.pointers.find((p) => p.role === "value");
    expect(value?.target.kind === "primitive" && value.target.value).toBe(8.5);
    // provenance: by / from / under (SPEC-7 §5)
    for (const suffix of ["by", "from", "under"]) {
      expect(
        emitted.claims.pointers.some((p) => p.role === `${VOCAB_PREFIX}.derived.${suffix}`),
      ).toBe(true);
    }
  });

  it("supersede: a new input negates the prior verdict; exactly one live claim", () => {
    const { host } = world();
    host.ingest(makeDelta(ratingClaim(1, "did:key:zA", 8)));
    const first = host.reactor.materializedView("movie", MOVIE)!.props.get("derived:avgRating")![0]!
      .delta;
    host.ingest(makeDelta(ratingClaim(2, "did:key:zB", 9)));
    const entries = host.reactor.materializedView("movie", MOVIE)!.props.get("derived:avgRating")!;
    // mask(drop) in the schema: the superseded claim is suppressed, only the new average lives
    expect(entries).toHaveLength(1);
    expect(entries[0]!.delta.id).not.toBe(first.id);
    expect(host.reactor.negationsOf(first.id)).toHaveLength(1);
  });

  it("pure replay verification reproduces the emitted id (G5)", () => {
    const { host } = world();
    host.ingest(makeDelta(ratingClaim(1, "did:key:zA", 8)));
    const emitted = host.reactor
      .materializedView("movie", MOVIE)!
      .props.get("derived:avgRating")![0]!.delta;
    // Reconstruct the input the function saw: the view WITHOUT the derived claim, i.e. the
    // rdb.derived.from hex pins it; rebuild by re-evaluating at the pre-emission state is complex,
    // so verify against the recorded from-hex by replaying over a reconstructed view.
    const fromHex = (
      emitted.claims.pointers.find((p) => p.role === `${VOCAB_PREFIX}.derived.from`)!.target as {
        value: string;
      }
    ).value;
    // Rebuild the pre-emission view: a fresh reactor with only the base claim.
    const probe = new Reactor();
    probe.register("movie", movieBody, [MOVIE]);
    probe.ingest(makeDelta(ratingClaim(1, "did:key:zA", 8)));
    expect(probe.materializedHex("movie", MOVIE)).toBe(fromHex);
    const view = probe.materializedView("movie", MOVIE)!;
    expect(verifyPureDerivation(emitted, spec, avgRating, view, MOVIE, fromHex)).toBe(true);
    // a tampered function (off-by-one average) fails replay
    const wrongFn: DerivedFn = (v, r) =>
      avgRating(v, r).map((ptrs) =>
        ptrs.map((p) =>
          p.role === "value" && p.target.kind === "primitive" && typeof p.target.value === "number"
            ? { ...p, target: { kind: "primitive" as const, value: p.target.value + 1 } }
            : p,
        ),
      );
    expect(verifyPureDerivation(emitted, spec, wrongFn, view, MOVIE, fromHex)).toBe(false);
  });

  it("the loop guard prevents self-triggering; the budget suspends runaways observably", () => {
    const reactor = new Reactor();
    reactor.register("movie", movieBody, [MOVIE]);
    const host = new DerivationHost(reactor);
    // budget 2: the third trigger suspends
    const tight: BindingSpec = { ...spec, name: "binding:tight", budget: 2 };
    host.install(tight, avgRating, DERIVED_SEED);
    host.ingest(makeDelta(ratingClaim(1, "did:key:zA", 8))); // trigger 1
    host.ingest(makeDelta(ratingClaim(2, "did:key:zB", 9))); // trigger 2
    expect(host.isSuspended("binding:tight")).toBe(false);
    host.ingest(makeDelta(ratingClaim(3, "did:key:zC", 7))); // budget exceeded
    expect(host.isSuspended("binding:tight")).toBe(true);
    // the suspension is an observable, signed annotation in the rhizome
    const suspRole = `${VOCAB_PREFIX}.derived.suspended`;
    const suspended = [...host.reactor.snapshot()].some((d) =>
      d.claims.pointers.some((p) => p.role === suspRole),
    );
    expect(suspended).toBe(true);
    // and after suspension, no further emissions occur
    const before = host.reactor.size;
    host.ingest(makeDelta(ratingClaim(4, "did:key:zD", 6)));
    expect(host.reactor.size).toBe(before + 1); // only the base claim, no emission
  });
});
