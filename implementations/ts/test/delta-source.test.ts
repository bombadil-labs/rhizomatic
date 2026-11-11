// The delta source contract (SPEC-17 §3) and the readers written against it: the order rule on
// `targets` and `negators`, the free negation readers over a fetched scope, and the reactor's
// membership revision.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareUtf8 } from "../src/delta/cbor.js";
import { negationPredicate, negationWitnesses, type Suppression } from "../src/delta/negation.js";
import { makeDelta } from "../src/delta/set.js";
import type { DeltaSource } from "../src/delta/source.js";
import type { Delta, Pointer } from "../src/delta/types.js";
import { Reactor, makeManifestClaims } from "../src/reactor/reactor.js";
import { scopeIds } from "../src/resolve/anchored.js";
import { scopeSource } from "../src/storage/scope-source.js";

const ENTITIES = ["e0", "e1", "e2", "e3", "e4"];
const AUTHORS = ["did:key:zA", "did:key:zB", "did:key:zC"];
const ROOT = AUTHORS[0]!;

const entityPointer = (entity: string, role = "about"): Pointer => ({
  role,
  target: { kind: "entity", entity: { id: entity, context: "c" } },
});
const negates = (id: string): Pointer => ({
  role: "negates",
  target: { kind: "delta", deltaRef: { delta: id } },
});
const GHOST = `1e20${"ab".repeat(32)}`;

// A validity window around the read times the property uses (0..9).
const window = fc.record({
  validFrom: fc.integer({ min: 0, max: 6 }),
  length: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
});

type Spec =
  | {
      kind: "base";
      entities: string[];
      author: string;
      w: { validFrom: number; length: number | undefined };
    }
  | {
      kind: "negation";
      // Each pick names an earlier delta (base or negation), so chains of any depth occur.
      picks: number[];
      ghost: boolean;
      entity: string | undefined;
      author: string;
      w: { validFrom: number; length: number | undefined };
    };

const spec: fc.Arbitrary<Spec> = fc.oneof(
  fc.record({
    kind: fc.constant("base" as const),
    entities: fc.subarray(ENTITIES, { minLength: 1, maxLength: 2 }),
    author: fc.constantFrom(...AUTHORS),
    w: window,
  }),
  fc.record({
    kind: fc.constant("negation" as const),
    picks: fc.array(fc.nat(), { minLength: 1, maxLength: 2 }),
    ghost: fc.boolean(),
    entity: fc.option(fc.constantFrom(...ENTITIES), { nil: undefined }),
    author: fc.constantFrom(...AUTHORS),
    w: window,
  }),
  // Negations weighted up: the subject is chains.
  fc.record({
    kind: fc.constant("negation" as const),
    picks: fc.array(fc.nat(), { minLength: 1, maxLength: 1 }),
    ghost: fc.constant(false),
    entity: fc.constant(undefined),
    author: fc.constantFrom(...AUTHORS),
    w: window,
  }),
);

function build(specs: readonly Spec[]): Delta[] {
  const out: Delta[] = [];
  const seen = new Set<string>();
  specs.forEach((s, i) => {
    const pointers: Pointer[] = [];
    if (s.kind === "base") for (const e of s.entities) pointers.push(entityPointer(e));
    else {
      if (out.length === 0) return;
      for (const id of new Set(s.picks.map((p) => out[p % out.length]!.id)))
        pointers.push(negates(id));
      if (s.ghost) pointers.push(negates(GHOST));
      if (s.entity !== undefined) pointers.push(entityPointer(s.entity));
    }
    const delta = makeDelta({
      timestamp: i,
      validFrom: s.w.validFrom,
      ...(s.w.length === undefined ? {} : { validUntil: s.w.validFrom + s.w.length }),
      author: s.author,
      pointers,
    });
    if (seen.has(delta.id)) return;
    seen.add(delta.id);
    out.push(delta);
  });
  return out;
}

// The suppression shapes the code uses: no authority test, the two principal profiles (author
// equality, with and without a root override), and no authority at all.
const SUPPRESSIONS: Record<string, Suppression> = {
  always: () => true,
  sameAuthor: (n, t) => n.claims.author === t.claims.author,
  rootOrSameAuthor: (n, t) => n.claims.author === t.claims.author || n.claims.author === ROOT,
  never: () => false,
};

const fetched = (reactor: Reactor, ids: readonly string[]) =>
  scopeSource(
    ids.map((id, i) => ({
      delta: reactor.get(id)!,
      arrival: { id, at: 0, sequence: i, transfer: 0, sender: "test" },
    })),
  );

const idsOf = (deltas: readonly Delta[]) => deltas.map((d) => d.id);

// The model: effective negations by scanning the whole list, with no index and no memo. It
// shares no code with the readers under test.
function modelWitnesses(all: readonly Delta[], now: number, suppression: Suppression) {
  const negatesId = (n: Delta, id: string) =>
    n.claims.pointers.some(
      (p) => p.role === "negates" && p.target.kind === "delta" && p.target.deltaRef.delta === id,
    );
  const witnesses = (target: Delta): string[] =>
    all
      .filter(
        (n) =>
          negatesId(n, target.id) &&
          n.claims.validFrom <= now &&
          (n.claims.validUntil === undefined || now < n.claims.validUntil) &&
          suppression(n, target) &&
          witnesses(n).length === 0,
      )
      .map((n) => n.id)
      .sort(compareUtf8);
  return witnesses;
}

describe("free negation readers over a fetched scope", () => {
  it("agree with the reactor's readers for every member of S(E)", () => {
    let witnessed = 0;
    let chained = 0;
    fc.assert(
      fc.property(
        fc.array(spec, { minLength: 1, maxLength: 40 }),
        fc.nat(),
        fc.subarray(ENTITIES, { minLength: 1 }),
        fc.integer({ min: 0, max: 9 }),
        (specs, seed, entities, now) => {
          const deltas = build(specs);
          // Arrival order is free: a negation may arrive before its target.
          const order = fc.sample(fc.shuffledSubarray(deltas, { minLength: deltas.length }), {
            seed,
            numRuns: 1,
          })[0]!;
          const reactor = new Reactor();
          for (const d of order) expect(reactor.ingest(d).status).toBe("accepted");

          const members = scopeIds(reactor, entities);
          const source = fetched(reactor, members);
          for (const suppression of Object.values(SUPPRESSIONS)) {
            const whole = reactor.negationWitnesses(now, suppression);
            const model = modelWitnesses(deltas, now, suppression);
            const wholeYes = reactor.negationPredicate(now, suppression);
            const scoped = negationWitnesses(source, now, suppression);
            const scopedYes = negationPredicate(source, now, suppression);
            for (const id of members) {
              const expected = whole(id);
              expect(idsOf(scoped(id))).toEqual(idsOf(expected));
              expect(scopedYes(id)).toBe(wholeYes(id));
              expect(scopedYes(id)).toBe(expected.length > 0);
              if (expected.length > 0) witnessed += 1;
              if (reactor.negators(id).some((n) => reactor.negators(n).length > 0)) chained += 1;
            }
            // The free reader over the reactor itself is the reactor's reader, for every id.
            const direct = negationWitnesses(reactor, now, suppression);
            for (const d of deltas) {
              expect(idsOf(whole(d.id))).toEqual(model(d));
              expect(idsOf(direct(d.id))).toEqual(model(d));
            }
          }
        },
      ),
      { numRuns: 300 },
    );
    // The generator reaches the cases the property is about.
    expect(witnessed).toBeGreaterThan(100);
    expect(chained).toBeGreaterThan(100);
  });

  // One chain with known answers, so the property above cannot pass by both sides being empty.
  const A = AUTHORS[0]!;
  const B = AUTHORS[1]!;
  const claim = makeDelta({
    timestamp: 1,
    validFrom: 0,
    author: A,
    pointers: [entityPointer("e0")],
  });
  const strike = makeDelta({
    timestamp: 2,
    validFrom: 0,
    author: B,
    pointers: [negates(claim.id)],
  });
  const unstrike = makeDelta({
    timestamp: 3,
    validFrom: 2,
    validUntil: 5,
    author: A,
    pointers: [negates(strike.id)],
  });
  const late = makeDelta({ timestamp: 4, validFrom: 7, author: A, pointers: [negates(claim.id)] });
  const chain = [claim, strike, unstrike, late];

  it("reads a chain of negations, validity windows and authority from the fetched members", () => {
    const reactor = new Reactor();
    // The negations arrive before their targets.
    for (const d of [...chain].reverse()) reactor.ingest(d);
    const members = scopeIds(reactor, ["e0"]);
    expect(members).toEqual(idsOf(chain).sort(compareUtf8));
    const source: DeltaSource = fetched(reactor, members);
    const at = (now: number, s: Suppression) => idsOf(negationWitnesses(source, now, s)(claim.id));

    expect(at(1, SUPPRESSIONS.always!)).toEqual([strike.id]);
    // The strike is itself negated from 2 until 5.
    expect(at(2, SUPPRESSIONS.always!)).toEqual([]);
    expect(at(4, SUPPRESSIONS.always!)).toEqual([]);
    expect(at(5, SUPPRESSIONS.always!)).toEqual([strike.id]);
    // Two effective negations answer in ascending id order.
    expect(at(8, SUPPRESSIONS.always!)).toEqual([strike.id, late.id].sort(compareUtf8));
    // Author B has no authority over A's claim under the same-author rule.
    expect(at(1, SUPPRESSIONS.sameAuthor!)).toEqual([]);
    expect(at(8, SUPPRESSIONS.sameAuthor!)).toEqual([late.id]);
    expect(negationPredicate(source, 8, SUPPRESSIONS.sameAuthor!)(claim.id)).toBe(true);
    expect(negationPredicate(source, 2, SUPPRESSIONS.always!)(claim.id)).toBe(false);
    // An id the source does not hold answers "not held": an empty list.
    expect(at(1, SUPPRESSIONS.always!)).not.toEqual([]);
    expect(negationWitnesses(source, 1, SUPPRESSIONS.always!)(GHOST)).toEqual([]);
    expect(() => negationWitnesses(source, Number.NaN, SUPPRESSIONS.always!)).toThrow(
      "now must be a finite number",
    );
  });

  it("a free reader keeps its memo; the reactor's reader follows the reactor's revision", () => {
    const reactor = new Reactor();
    reactor.ingest(claim);
    const free = negationPredicate(reactor, 1, SUPPRESSIONS.always!);
    const own = reactor.negationPredicate(1, SUPPRESSIONS.always!);
    expect([free(claim.id), own(claim.id)]).toEqual([false, false]);
    reactor.ingest(strike);
    expect(own(claim.id)).toBe(true);
    // The free reader answered this id already and does not look again.
    expect(free(claim.id)).toBe(false);
    expect(negationPredicate(reactor, 1, SUPPRESSIONS.always!)(claim.id)).toBe(true);
  });
});

describe("Reactor.targets and Reactor.negators follow the order contract", () => {
  const sortedOnce = (ids: readonly string[]) => {
    expect(Array.isArray(ids)).toBe(true);
    expect([...ids]).toEqual([...new Set(ids)].sort(compareUtf8));
  };

  it("each id once, ascending, whatever the arrival order", () => {
    const base = Array.from({ length: 12 }, (_, i) =>
      makeDelta({
        timestamp: i,
        validFrom: 0,
        author: AUTHORS[0]!,
        // Two pointers at one entity: the delta is still listed once.
        pointers: [entityPointer("e0", "about"), entityPointer("e0", "also"), entityPointer("e1")],
      }),
    );
    const strikes = Array.from({ length: 12 }, (_, i) =>
      makeDelta({
        timestamp: 100 + i,
        validFrom: 0,
        author: AUTHORS[1]!,
        pointers: [negates(base[0]!.id), negates(base[0]!.id)],
      }),
    );
    const descending = [...base, ...strikes].sort((a, b) => compareUtf8(b.id, a.id));
    const reactor = new Reactor();
    for (const d of descending) expect(reactor.ingest(d).status).toBe("accepted");

    expect(reactor.targets("e0")).toEqual(idsOf(base).sort(compareUtf8));
    expect(reactor.negators(base[0]!.id)).toEqual(idsOf(strikes).sort(compareUtf8));
    sortedOnce(reactor.targets("e0"));
    sortedOnce(reactor.negators(base[0]!.id));
    expect(reactor.targets("e0")).toEqual(reactor.byTarget("e0"));
    expect(reactor.negators(base[0]!.id)).toEqual(reactor.negationsOf(base[0]!.id));
    expect(reactor.targets("nowhere")).toEqual([]);
    expect(reactor.negators(GHOST)).toEqual([]);
    // The answer is the caller's own array: changing it does not change the reactor.
    (reactor.targets("e0") as string[]).length = 0;
    expect(reactor.targets("e0")).toHaveLength(base.length);
  });

  it("holds over random sets, and equals byTarget and negationsOf", () => {
    fc.assert(
      fc.property(fc.array(spec, { minLength: 1, maxLength: 40 }), fc.nat(), (specs, seed) => {
        const deltas = build(specs);
        const order = fc.sample(fc.shuffledSubarray(deltas, { minLength: deltas.length }), {
          seed,
          numRuns: 1,
        })[0]!;
        const reactor = new Reactor();
        for (const d of order) reactor.ingest(d);
        for (const e of ENTITIES) {
          sortedOnce(reactor.targets(e));
          expect(reactor.targets(e)).toEqual(reactor.byTarget(e));
        }
        for (const id of [...idsOf(deltas), GHOST]) {
          sortedOnce(reactor.negators(id));
          expect(reactor.negators(id)).toEqual(reactor.negationsOf(id));
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Reactor.revision", () => {
  const d = (n: number, entity = "e0") =>
    makeDelta({
      timestamp: n,
      validFrom: 0,
      author: AUTHORS[0]!,
      pointers: [entityPointer(entity)],
    });
  const forged = (delta: Delta): Delta => ({ ...delta, id: `1e20${"00".repeat(32)}` });
  const manifestFor = (members: readonly Delta[]) =>
    makeDelta(makeManifestClaims(AUTHORS[0]!, 1000, idsOf(members)));

  it("starts at 0 and rises once per accepted ingest", () => {
    const r = new Reactor();
    expect(r.revision).toBe(0);
    expect(r.ingest(d(1)).status).toBe("accepted");
    expect(r.revision).toBe(1);
    expect(r.ingest(d(1)).status).toBe("duplicate");
    expect(r.revision).toBe(1);
    expect(r.ingest(forged(d(2))).status).toBe("rejected");
    expect(r.revision).toBe(1);
    expect(r.ingest(d(2)).status).toBe("accepted");
    expect(r.revision).toBe(2);
  });

  it("rises once per accepted batch, whatever its size", () => {
    const r = new Reactor();
    expect(r.ingestBatch([d(1), d(2), d(3)]).status).toBe("accepted");
    expect(r.revision).toBe(1);
    expect(r.ingestBatch([d(1), d(2), d(3)]).status).toBe("duplicate");
    expect(r.ingestBatch([]).status).toBe("duplicate");
    expect(r.revision).toBe(1);
    // One bad member refuses the whole batch: no member, no change.
    expect(r.ingestBatch([d(4), forged(d(5))]).status).toBe("rejected");
    expect(r.has(d(4).id)).toBe(false);
    expect(r.revision).toBe(1);
    // Held members beside one new member: one new revision.
    expect(r.ingestBatch([d(1), d(4), d(4)]).status).toBe("accepted");
    expect(r.revision).toBe(2);
  });

  it("rises once per accepted bundle", () => {
    const r = new Reactor();
    const members = [d(1), d(2)];
    const manifest = manifestFor(members);
    expect(r.ingestBundle(manifestFor([d(1)]), members).status).toBe("rejected");
    expect(r.ingestBundle(manifestFor([d(1), d(2)]), [d(1), forged(d(2))]).status).toBe("rejected");
    expect(r.revision).toBe(0);
    expect(r.ingestBundle(manifest, members).status).toBe("accepted");
    expect(r.size).toBe(3);
    expect(r.revision).toBe(1);
    expect(r.ingestBundle(manifest, members).status).toBe("duplicate");
    expect(r.revision).toBe(1);
  });

  it("does not move for time, a refresh, a registration or a read", () => {
    const r = new Reactor();
    r.ingest(d(1));
    r.register("m", { kind: "group", key: { kind: "byRole" }, of: { kind: "input" } }, ["e0"], 1);
    r.advanceTime(50);
    r.refreshAll(60);
    r.subscribeRaw(() => {});
    r.targets("e0");
    r.negationPredicate(1, () => true)(d(1).id);
    r.snapshot();
    expect(r.revision).toBe(1);
  });

  it("has risen, with every new member indexed, when a subscriber runs", () => {
    const r = new Reactor();
    const seen: Array<[number, number]> = [];
    r.subscribeRaw(() => seen.push([r.revision, r.targets("e0").length]));
    r.ingest(d(1));
    r.ingestBatch([d(2), d(3)]);
    const members = [d(4), d(5)];
    r.ingestBundle(manifestFor(members), members);
    expect(seen).toEqual([
      [1, 1],
      [2, 3],
      [2, 3],
      [3, 5],
      [3, 5],
      [3, 5],
    ]);
  });

  it("is comparable only within one reactor", () => {
    const one = new Reactor();
    const other = new Reactor();
    one.ingest(d(1));
    one.ingest(d(2));
    other.ingestBatch([d(1), d(2)]);
    expect(one.digest()).toBe(other.digest());
    expect([one.revision, other.revision]).toEqual([2, 1]);
  });
});

describe("Reactor.revision and a subscriber that throws", () => {
  it("has risen, and the member is held, when ingest throws from a raw subscriber", () => {
    const fact = makeDelta({
      timestamp: 1,
      validFrom: 0,
      author: AUTHORS[0]!,
      pointers: [entityPointer("e0")],
    });
    const r = new Reactor();
    r.subscribeRaw(() => {
      throw new Error("subscriber failed");
    });
    // The call does not answer `accepted`; it throws.
    expect(() => r.ingest(fact)).toThrow("subscriber failed");
    expect(r.revision).toBe(1);
    expect(r.has(fact.id)).toBe(true);
    expect(r.targets("e0")).toEqual([fact.id]);
    // The same delta again adds no member: the counter stays.
    expect(r.ingest(fact)).toEqual({ status: "duplicate" });
    expect(r.revision).toBe(1);
  });
});

describe("the Reactor's negation reader and an ingest in the middle of a walk", () => {
  const fact = (n: number): Delta =>
    makeDelta({
      timestamp: n,
      validFrom: 0,
      author: AUTHORS[0]!,
      pointers: [entityPointer("e0")],
    });
  const strikeOf = (target: Delta, n: number): Delta =>
    makeDelta({ timestamp: n, validFrom: 0, author: AUTHORS[1]!, pointers: [negates(target.id)] });

  for (const form of ["witnesses", "predicate"] as const) {
    it(`${form}: a suppression callback that ingests gets a fresh answer in the same call`, () => {
      const x = fact(1);
      const n1 = strikeOf(x, 2);
      const n0 = strikeOf(n1, 3);
      const reactor = new Reactor();
      reactor.ingest(x);
      reactor.ingest(n1);
      // When the walk asks about (n1, x), a negation of n1 arrives.
      const suppression: Suppression = (negation, target) => {
        if (negation.id === n1.id && target.id === x.id) reactor.ingest(n0);
        return true;
      };
      const count =
        form === "witnesses"
          ? (
              (read) => (id: string) =>
                read(id).length
            )(reactor.negationWitnesses(1, suppression))
          : ((read) => (id: string) => (read(id) ? 1 : 0))(
              reactor.negationPredicate(1, suppression),
            );
      // The reader has answered n1 before the walk: not negated.
      expect(count(n1.id)).toBe(0);
      expect(reactor.has(n0.id)).toBe(false);
      // n0 arrives inside this call, and the answer already counts it: n1 is negated, x is not.
      expect(count(x.id)).toBe(0);
      expect(reactor.has(n0.id)).toBe(true);
      expect(count(x.id)).toBe(0);
      expect(count(n1.id)).toBe(1);
    });
  }

  it("a free reader with no epoch keeps its memo through the same ingest", () => {
    const x = fact(1);
    const n1 = strikeOf(x, 2);
    const n0 = strikeOf(n1, 3);
    const reactor = new Reactor();
    reactor.ingest(x);
    reactor.ingest(n1);
    const suppression: Suppression = (negation, target) => {
      if (negation.id === n1.id && target.id === x.id) reactor.ingest(n0);
      return true;
    };
    const free = negationWitnesses(reactor, 1, suppression);
    expect(free(n1.id)).toEqual([]);
    expect(idsOf(free(x.id))).toEqual([n1.id]);
    // With an epoch the same free reader follows the change.
    const other = new Reactor();
    other.ingest(x);
    other.ingest(n1);
    const followed = negationWitnesses(
      other,
      1,
      (negation, target) => {
        if (negation.id === n1.id && target.id === x.id) other.ingest(n0);
        return true;
      },
      () => other.revision,
    );
    expect(followed(n1.id)).toEqual([]);
    expect(followed(x.id)).toEqual([]);
  });
});

describe("negation readers over a source that breaks the contract", () => {
  // A hand-written source. Its deltas carry ids that do not recompute from their claims, which
  // no reactor, store or scope source admits.
  const forged = (id: string, pointers: Pointer[]): Delta => ({
    id,
    claims: { timestamp: 1, validFrom: 0, author: AUTHORS[0]!, pointers },
  });
  const stub = (held: readonly Delta[], negators: Record<string, string[]>): DeltaSource => ({
    get: (id) => held.find((d) => d.id === id),
    targets: () => [],
    negators: (id) => negators[id] ?? [],
  });

  it("throws on a negation cycle, and names the cause", () => {
    const a = forged("a", [negates("b")]);
    const b = forged("b", [negates("a")]);
    const self = forged("s", [negates("s")]);
    const source = stub([a, b, self], { a: ["b"], b: ["a"], s: ["s"] });
    for (const id of ["a", "b", "s"]) {
      expect(() => negationWitnesses(source, 1, SUPPRESSIONS.always!)(id)).toThrow(
        "negation cycle: the delta source holds deltas that are not content-addressed",
      );
      expect(() => negationPredicate(source, 1, SUPPRESSIONS.always!)(id)).toThrow(
        /negation cycle/,
      );
    }
  });

  it("keeps the re-entry error for a suppression callback that calls the reader", () => {
    const reactor = new Reactor();
    const x = makeDelta({
      timestamp: 1,
      validFrom: 0,
      author: AUTHORS[0]!,
      pointers: [entityPointer("e0")],
    });
    const n = makeDelta({
      timestamp: 2,
      validFrom: 0,
      author: AUTHORS[0]!,
      pointers: [negates(x.id)],
    });
    reactor.ingest(x);
    reactor.ingest(n);
    const reader: (id: string) => readonly Delta[] = negationWitnesses(reactor, 1, () => {
      reader(x.id);
      return true;
    });
    expect(() => reader(x.id)).toThrow("negation reader re-entered during suppression");
  });

  it("does not count a negator the source lists but cannot get", () => {
    const x = forged("x", [entityPointer("e0")]);
    const held = forged("held", [negates("x")]);
    const calls: string[] = [];
    const suppression: Suppression = (negation) => {
      calls.push(negation.id);
      return true;
    };
    // `negators` lists an id that `get` does not return.
    const onlyGhost = stub([x], { x: ["ghost"] });
    expect(negationWitnesses(onlyGhost, 1, suppression)("x")).toEqual([]);
    expect(negationPredicate(onlyGhost, 1, suppression)("x")).toBe(false);
    const both = stub([x, held], { x: ["ghost", "held"] });
    expect(idsOf(negationWitnesses(both, 1, suppression)("x"))).toEqual(["held"]);
    // The reader never asked the suppression rule about the id it could not get.
    expect(calls).toEqual(["held"]);
  });
});
