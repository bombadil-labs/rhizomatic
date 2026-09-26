import { describe, expect, it } from "vitest";
import { governedDeltas } from "../src/eval.js";
import { Reactor } from "../src/reactor.js";
import { applyPolicy } from "../src/resolution.js";
import { DeltaSet, makeDelta, makeNegationClaims } from "../src/set.js";
import type { Delta } from "../src/types.js";

const claim = (author: string, validFrom: number, validUntil?: number): Delta =>
  makeDelta({
    timestamp: 1,
    validFrom,
    ...(validUntil === undefined ? {} : { validUntil }),
    author,
    pointers: [{ role: "value", target: { kind: "primitive", value: author } }],
  });

const negate = (target: Delta, author: string, validFrom: number, validUntil?: number): Delta =>
  makeDelta({
    ...makeNegationClaims(author, validFrom, target.id),
    ...(validUntil === undefined ? {} : { validUntil }),
  });

function reactorOf(deltas: readonly Delta[]): Reactor {
  const reactor = new Reactor();
  for (const delta of deltas) expect(reactor.ingest(delta)).toEqual({ status: "accepted" });
  return reactor;
}

describe("governed read queries", () => {
  it("exposes an explicit absent result for a property policy", () => {
    const policy = { kind: "pick", order: { kind: "lexById" } } as const;
    expect(applyPolicy(policy, [], "entity:one")).toEqual({ kind: "absent" });
    expect(
      applyPolicy({ kind: "absentAs", constant: false, then: policy }, [], "entity:one"),
    ).toEqual({
      kind: "present",
      value: false,
    });
  });

  it("filters authors and [validFrom, validUntil) without choosing a winner", () => {
    const first = claim("A", 5, 20);
    const second = claim("A", 10);
    const foreign = claim("B", 5);
    const input = DeltaSet.from([first, foreign, second]);
    expect(governedDeltas(input, 10, new Set(["A"])).ids()).toEqual([first.id, second.id].sort());
    expect([...governedDeltas(input, 20, (author) => author === "A")].map((d) => d.id)).toEqual([
      second.id,
    ]);
    expect(() => governedDeltas(input, Number.NaN, new Set(["A"]))).toThrow(/finite/);
  });

  it("reports timed negations and counter-negations at their exact boundaries", () => {
    const target = claim("A", 0, 100);
    const negation = negate(target, "B", 10, 20);
    const counter = negate(negation, "C", 15, 18);
    const reactor = reactorOf([counter, negation, target]);
    const permits = () => true;
    for (const [now, expected] of [
      [9, false],
      [10, true],
      [14, true],
      [15, false],
      [17, false],
      [18, true],
      [19, true],
      [20, false],
      [100, false],
    ] as const) {
      const isNegated = reactor.negationPredicate(now, permits);
      expect(isNegated(target.id), `target at ${now}`).toBe(expected);
      const witnesses = reactor.negationWitnesses(now, permits)(target.id);
      expect(
        witnesses.map((d) => d.id),
        `witnesses at ${now}`,
      ).toEqual(expected ? [negation.id] : []);
      if (expected) expect(witnesses[0]?.claims.validUntil).toBe(20);
    }
  });

  it("applies suppression to every edge and refreshes a memo after ingest", () => {
    const target = claim("A", 0);
    const negation = negate(target, "B", 10);
    const counter = negate(negation, "C", 11);
    const reactor = reactorOf([target, negation]);
    let calls = 0;
    const sameAuthor = (n: Delta, d: Delta) => {
      calls += 1;
      return n.claims.author === d.claims.author;
    };
    const sameAuthorVerdict = reactor.negationPredicate(12, sameAuthor);
    expect(sameAuthorVerdict(target.id)).toBe(false);
    expect(sameAuthorVerdict(target.id)).toBe(false);
    expect(calls).toBe(1);

    const everyAuthor = reactor.negationPredicate(12, () => true);
    expect(everyAuthor(target.id)).toBe(true);
    expect(reactor.ingest(counter)).toEqual({ status: "accepted" });
    expect(everyAuthor(target.id)).toBe(false); // the existing reader resets at a membership revision
    expect(reactor.negationPredicate(12, (n) => n.claims.author === "B")(target.id)).toBe(true);
  });

  it("ignores a negation when its target bytes are absent", () => {
    const target = claim("A", 0);
    const negation = negate(target, "B", 10);
    const reactor = reactorOf([negation]);
    const isNegated = reactor.negationPredicate(10, () => true);
    expect(isNegated(target.id)).toBe(false);
    expect(reactor.negationWitnesses(10, () => true)(target.id)).toEqual([]);
    expect(reactor.ingest(target)).toEqual({ status: "accepted" });
    expect(isNegated(target.id)).toBe(true);
  });

  it("fails a suppression callback that re-enters its unfinished reader", () => {
    const target = claim("A", 0);
    const negation = negate(target, "B", 10);
    const reactor = reactorOf([target, negation]);
    const reader = reactor.negationWitnesses(10, () => {
      reader(target.id);
      return true;
    });
    expect(() => reader(target.id)).toThrow(/re-entered/);
  });

  it("can report a negation of a held but expired historical target", () => {
    const target = claim("A", 0, 12);
    const negation = negate(target, "B", 10, 20);
    const reactor = reactorOf([target, negation]);
    expect(governedDeltas(reactor.snapshot(), 13, new Set(["A"])).has(target.id)).toBe(false);
    expect(reactor.negationPredicate(13, () => true)(target.id)).toBe(true);
    expect(
      reactor
        .negationWitnesses(
          13,
          () => true,
        )(target.id)
        .map((d) => d.id),
    ).toEqual([negation.id]);
    expect(reactor.negationPredicate(20, () => true)(target.id)).toBe(false);
  });
});
