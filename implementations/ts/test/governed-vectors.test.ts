import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { governedDeltas, latestByKey } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { Reactor } from "../src/reactor.js";
import { DeltaSet, makeDelta } from "../src/set.js";

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l2-reactor/governed.json"), "utf8"),
) as {
  deltas: Array<{ name: string; id: string; claims: unknown }>;
  governed: Array<{ now: number; authors: string[]; expectedIds: string[] }>;
  latestByKey: Array<{ now: number; authors: string[]; expected: string | null }>;
  witnesses: Array<{
    now: number;
    target: string;
    permittedAuthors: string[];
    expectedIds: string[];
  }>;
};

describe("shared governed-read vectors (SPEC-2/4)", () => {
  const named = new Map(
    vector.deltas.map((entry) => [entry.name, makeDelta(parseClaims(entry.claims))]),
  );
  const deltas = vector.deltas.map((entry) => {
    const delta = named.get(entry.name)!;
    expect(delta.id).toBe(entry.id);
    return delta;
  });

  for (const order of [deltas, [...deltas].reverse()]) {
    it(`matches governed slices and negation witnesses in ${order === deltas ? "forward" : "reverse"} ingest order`, () => {
      const set = DeltaSet.from(order);
      const reactor = new Reactor();
      for (const delta of order) expect(reactor.ingest(delta)).toEqual({ status: "accepted" });
      for (const c of vector.governed) {
        expect(governedDeltas(set, c.now, new Set(c.authors)).ids()).toEqual(c.expectedIds);
      }
      for (const c of vector.latestByKey) {
        const winners = latestByKey(set, c.now, new Set(c.authors), (delta) => {
          const subject = delta.claims.pointers.find((p) => p.role === "subject");
          return subject?.target.kind === "entity" ? subject.target.entity.id : undefined;
        });
        expect(winners.get("person:myk")?.id).toBe(
          c.expected === null ? undefined : named.get(c.expected)!.id,
        );
      }
      for (const c of vector.witnesses) {
        const permitted = new Set(c.permittedAuthors);
        const target = named.get(c.target)?.id ?? `1e20${"00".repeat(32)}`;
        const suppression = (negation: { claims: { author: string } }) =>
          permitted.has(negation.claims.author);
        expect(
          reactor
            .negationWitnesses(
              c.now,
              suppression,
            )(target)
            .map((d) => d.id),
        ).toEqual(c.expectedIds);
        expect(reactor.negationPredicate(c.now, suppression)(target)).toBe(
          c.expectedIds.length > 0,
        );
      }
    });
  }
});
