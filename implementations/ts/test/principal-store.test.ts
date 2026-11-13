// The SPEC-14 principal reads over a fetched scope (SPEC-18 slice 2 plan §4, §5). Each shared
// principal case and history case loads into a memory store peer; the test fetches the scope of
// one entity, the principal root, and runs the read over that synchronous source. The answer
// must equal the vector's expectation and the Reactor's full result.
//
// Not covered here: the `actsFor` predicate cases. Their resolver takes a whole input set, and
// its store form belongs to a later slice. The Reactor run of every family stays in
// principal-vectors.test.ts.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeDelta, makeNegationClaims } from "../src/delta/set.js";
import type { DeltaSource } from "../src/delta/source.js";
import type { Delta } from "../src/delta/types.js";
import {
  associatedKeys,
  authorsForPrincipal,
  resolvePrincipal,
  type PrincipalReadOptions,
} from "../src/principal/read.js";
import { Reactor } from "../src/reactor/reactor.js";
import { parseClaims } from "../src/delta/json-profile.js";
import { fetchEntities, loadPeer, type StoreCalls } from "./support/store-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/principal/evidence.json"), "utf8"),
) as {
  keys: Record<string, string>;
  deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }>;
  cases: Array<{
    name: string;
    members: string[];
    at: number;
    now?: number;
    key: string;
    root?: string;
    scope: string;
    scopePolicy?: "exact" | "prefix";
    suppression?: "sameAuthor" | "rootOrSameAuthor";
    expected: { grade: string; authorized: boolean; delegable: boolean; authors: string[] };
  }>;
  history: Array<{
    name: string;
    members: string[];
    now: number;
    expected: Array<{ key: string; via: string[]; negated: boolean }>;
  }>;
  defaults: { root: string; now: number; scopePolicy: "exact"; suppression: "sameAuthor" };
};

const named = new Map<string, Delta>();
for (const entry of vector.deltas) {
  named.set(entry.name, {
    id: entry.id,
    claims: parseClaims(entry.claims),
    ...(entry.sig === undefined ? {} : { sig: entry.sig }),
  });
}
const membersOf = (names: readonly string[]): Delta[] => names.map((name) => named.get(name)!);
const reactorOf = (deltas: readonly Delta[]): Reactor => {
  const reactor = new Reactor();
  for (const delta of deltas) expect(reactor.ingest(delta)).toEqual({ status: "accepted" });
  return reactor;
};
const defaultRoot = vector.keys[vector.defaults.root]!;
const optionsOf = (c: (typeof vector.cases)[number]): PrincipalReadOptions => ({
  at: c.at,
  now: c.now ?? vector.defaults.now,
  scope: c.scope,
  scopePolicy: c.scopePolicy ?? vector.defaults.scopePolicy,
  suppression: c.suppression ?? vector.defaults.suppression,
});

/** Deltas that point at no principal root: facts on other entities and strikes on some. */
function unrelated(count: number): Delta[] {
  const facts = Array.from({ length: count }, (_, i) =>
    makeDelta({
      timestamp: i,
      validFrom: 0,
      author: "did:key:zBystander",
      pointers: [
        {
          role: "subject",
          target: { kind: "entity", entity: { id: `other:${i % 11}`, context: "v" } },
        },
        { role: "value", target: { kind: "primitive", value: i } },
      ],
    }),
  );
  const strikes = facts
    .slice(0, Math.floor(count / 10))
    .map((fact, i) => makeDelta(makeNegationClaims("did:key:zStriker", 5000 + i, fact.id)));
  return [...facts, ...strikes];
}

describe("principal reads over a fetched scope (SPEC-14 over SPEC-18)", () => {
  it("has cases to run", () => {
    expect(vector.cases.length).toBeGreaterThanOrEqual(43);
    expect(vector.history.length).toBeGreaterThanOrEqual(2);
  });

  it("resolves every association and authority case from the scope of the root alone", async () => {
    for (const c of vector.cases) {
      const members = membersOf(c.members);
      const root = vector.keys[c.root ?? vector.defaults.root]!;
      const key = vector.keys[c.key]!;
      const options = optionsOf(c);
      const { peer } = await loadPeer(members);
      const calls: StoreCalls = [];
      const source = await fetchEntities(peer, [root], calls);
      expect(calls, c.name).toEqual(["read", `scope(${root})`]);

      const result = resolvePrincipal(source, root, key, options);
      const expectedAuthors = c.expected.authors.map((alias) => vector.keys[alias]!).sort();
      expect(result.grade, c.name).toBe(c.expected.grade);
      expect(result.authorized, c.name).toBe(c.expected.authorized);
      expect(result.delegable, c.name).toBe(c.expected.delegable);
      expect(result.authors, c.name).toEqual(expectedAuthors);
      expect(authorsForPrincipal(source, root, options), c.name).toEqual(expectedAuthors);
      // The paths are not in the vector; the Reactor run over the whole set pins them.
      expect(result, c.name).toEqual(resolvePrincipal(reactorOf(members), root, key, options));
    }
  });

  it("keeps historical association paths from the scope of the root alone", async () => {
    for (const c of vector.history) {
      const members = membersOf(c.members);
      const { peer } = await loadPeer(members);
      const source = await fetchEntities(peer, [defaultRoot]);
      const rows = associatedKeys(source, defaultRoot, c.now, "sameAuthor");
      expect(
        rows.map((row) => ({ key: row.key, via: row.via, negated: row.negated })),
        c.name,
      ).toEqual(
        c.expected.map((row) => ({
          key: vector.keys[row.key],
          via: row.via.map((name) => named.get(name)!.id),
          negated: row.negated,
        })),
      );
      expect(rows, c.name).toEqual(
        associatedKeys(reactorOf(members), defaultRoot, c.now, "sameAuthor"),
      );
    }
  });

  it("answers the same with every delta of the vector loaded beside each case", async () => {
    // One peer holds the whole fixture set, so every case reads its own root among the evidence
    // of the other root. The Reactor over the same whole set is the oracle.
    const all = [...named.values()];
    const { peer } = await loadPeer(all);
    const whole = reactorOf(all);
    for (const c of vector.cases) {
      const root = vector.keys[c.root ?? vector.defaults.root]!;
      const key = vector.keys[c.key]!;
      const source = await fetchEntities(peer, [root]);
      expect(resolvePrincipal(source, root, key, optionsOf(c)), c.name).toEqual(
        resolvePrincipal(whole, root, key, optionsOf(c)),
      );
    }
    const source = await fetchEntities(peer, [defaultRoot]);
    for (const c of vector.history)
      expect(associatedKeys(source, defaultRoot, c.now, "sameAuthor"), c.name).toEqual(
        associatedKeys(whole, defaultRoot, c.now, "sameAuthor"),
      );
  });

  // The cost and control rails use one case with delegation, binding and negation evidence.
  const pick = (name: string): (typeof vector.cases)[number] => {
    const found = vector.cases.find((c) => c.name === name);
    if (found === undefined) throw new Error(`principal vector lost the case ${name}`);
    return found;
  };

  it("makes the same store calls with 0 and with 1100 unrelated deltas", async () => {
    const c = pick("expired-self-revocation-revives");
    const key = vector.keys[c.key]!;
    const measure = async (extra: readonly Delta[]) => {
      const { peer, meter } = await loadPeer([...membersOf(c.members), ...extra]);
      const calls: StoreCalls = [];
      const source = await fetchEntities(peer, [defaultRoot], calls);
      const afterFetch = { ...meter };
      const result = resolvePrincipal(source, defaultRoot, key, optionsOf(c));
      const rows = associatedKeys(source, defaultRoot, c.at, "sameAuthor");
      // The reads themselves touch the store zero times: the source is synchronous.
      expect(meter).toEqual(afterFetch);
      return { calls, meter: afterFetch, result, rows, held: source.ids().length };
    };
    const alone = await measure([]);
    const crowd = unrelated(1000);
    expect(crowd.length).toBe(1100);
    const crowded = await measure(crowd);
    expect(crowded).toEqual(alone);
    expect(alone.calls).toEqual(["read", `scope(${defaultRoot})`]);
    expect(alone.meter.scans).toBe(0);
    // The rail measures something: the fetch did index work and brought the evidence back.
    expect(alone.meter.lookups).toBeGreaterThan(0);
    expect(alone.held).toBe(c.members.length);
    expect(alone.result.authorized).toBe(true);
  });

  it("finds no evidence over a scope fetched at the wrong entity", async () => {
    const c = pick("expired-self-revocation-revives");
    const key = vector.keys[c.key]!;
    const members = membersOf(c.members);
    const { peer } = await loadPeer([...members, ...unrelated(20)]);
    const bare: DeltaSource = { get: () => undefined, targets: () => [], negators: () => [] };
    const nothing = resolvePrincipal(bare, defaultRoot, key, optionsOf(c));
    expect(nothing.authors).toEqual([defaultRoot]);
    expect(nothing.authorized).toBe(false);

    // The peer holds the evidence, and the right fetch finds it.
    const right = await fetchEntities(peer, [defaultRoot]);
    expect(resolvePrincipal(right, defaultRoot, key, optionsOf(c)).authorized).toBe(true);
    // A key that the evidence names, an entity that holds bystander deltas, and no entity.
    for (const entities of [[key], ["other:3"], []]) {
      const wrong = await fetchEntities(peer, entities);
      expect(resolvePrincipal(wrong, defaultRoot, key, optionsOf(c)), `${entities}`).toEqual(
        nothing,
      );
      expect(authorsForPrincipal(wrong, defaultRoot, optionsOf(c))).toEqual([defaultRoot]);
      expect(associatedKeys(wrong, defaultRoot, c.at, "sameAuthor")).toEqual([
        { key: defaultRoot, via: [], intervals: [], negated: false },
      ]);
    }
    expect((await fetchEntities(peer, ["other:3"])).ids().length).toBeGreaterThan(0);
  });
});
