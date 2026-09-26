// Shared SPEC-14 evidence and authority decisions, in both ingest orders.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeId } from "../src/delta.js";
import { parseClaims } from "../src/json-profile.js";
import { associatedKeys, authorsForPrincipal, resolvePrincipal } from "../src/principal.js";
import { Reactor } from "../src/reactor.js";
import { verifyDelta } from "../src/sign.js";
import type { Delta } from "../src/types.js";

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
    expected: {
      grade: string;
      authorized: boolean;
      delegable: boolean;
      authors: string[];
    };
  }>;
  history: Array<{
    name: string;
    members: string[];
    now: number;
    expected: Array<{ key: string; via: string[]; negated: boolean }>;
  }>;
  predicates: Array<{ name: string; members: string[]; expected: string[]; term: unknown }>;
  defaults: { root: string; now: number; scopePolicy: "exact"; suppression: "sameAuthor" };
};

describe("frozen principal evidence fixtures (SPEC-14)", () => {
  const named = new Map<string, Delta>();
  for (const entry of vector.deltas) {
    const claims = parseClaims(entry.claims);
    const delta: Delta = {
      id: entry.id,
      claims,
      ...(entry.sig === undefined ? {} : { sig: entry.sig }),
    };
    named.set(entry.name, delta);
  }

  it("pins every content address and detached signature", () => {
    expect(named.size).toBe(vector.deltas.length);
    for (const delta of named.values()) {
      expect(computeId(delta.claims)).toBe(delta.id);
      expect(verifyDelta(delta)).toBe(delta.sig === undefined ? "unsigned" : "verified");
    }
  });

  it("pins every referenced subset and author alias in both ingest orders", () => {
    const cases = [...vector.cases, ...vector.history, ...vector.predicates];
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    for (const c of cases) {
      expect(new Set(c.members).size).toBe(c.members.length);
      for (const name of c.members) expect(named.has(name), `${c.name}: ${name}`).toBe(true);
      for (const order of [c.members, [...c.members].reverse()]) {
        const reactor = new Reactor();
        for (const name of order) {
          expect(reactor.ingest(named.get(name)!)).toEqual({ status: "accepted" });
        }
        expect(reactor.size).toBe(c.members.length);
      }
    }
    for (const c of vector.cases) {
      expect(Number.isFinite(c.at)).toBe(true);
      if (c.now !== undefined) expect(Number.isFinite(c.now)).toBe(true);
      expect(vector.keys[c.key]).toBeDefined();
      if (c.root !== undefined) expect(vector.keys[c.root]).toBeDefined();
      for (const alias of c.expected.authors) expect(vector.keys[alias]).toBeDefined();
    }
    for (const c of vector.history) {
      for (const row of c.expected) {
        expect(vector.keys[row.key]).toBeDefined();
        for (const name of row.via) expect(named.has(name)).toBe(true);
      }
    }
    for (const c of vector.predicates) {
      expect(c.term).toBeDefined();
      for (const name of c.expected) expect(named.has(name)).toBe(true);
    }
  });

  it("matches every curated association and authority decision in both ingest orders", () => {
    for (const c of vector.cases) {
      for (const members of [c.members, [...c.members].reverse()]) {
        const reactor = new Reactor();
        for (const name of members) {
          expect(reactor.ingest(named.get(name)!)).toEqual({ status: "accepted" });
        }
        const root = vector.keys[c.root ?? vector.defaults.root]!;
        const key = vector.keys[c.key]!;
        const options = {
          at: c.at,
          now: c.now ?? vector.defaults.now,
          scope: c.scope,
          scopePolicy: c.scopePolicy ?? vector.defaults.scopePolicy,
          suppression: c.suppression ?? vector.defaults.suppression,
        } as const;
        const result = resolvePrincipal(reactor, root, key, options);
        expect(result.grade, c.name).toBe(c.expected.grade);
        expect(result.authorized, c.name).toBe(c.expected.authorized);
        expect(result.delegable, c.name).toBe(c.expected.delegable);
        const expectedAuthors = c.expected.authors.map((alias) => vector.keys[alias]!).sort();
        expect(result.authors, c.name).toEqual(expectedAuthors);
        expect(authorsForPrincipal(reactor, root, options), c.name).toEqual(expectedAuthors);
      }
    }
  });

  it("keeps historical association paths after effective negation", () => {
    for (const c of vector.history) {
      for (const members of [c.members, [...c.members].reverse()]) {
        const reactor = new Reactor();
        for (const name of members) {
          expect(reactor.ingest(named.get(name)!)).toEqual({ status: "accepted" });
        }
        const rows = associatedKeys(
          reactor,
          vector.keys[vector.defaults.root]!,
          c.now,
          "sameAuthor",
        );
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
        for (const row of rows) {
          expect(row.intervals).toEqual(
            row.via.map((id) => {
              const claims = reactor.get(id)!.claims;
              return {
                validFrom: claims.validFrom,
                ...(claims.validUntil === undefined ? {} : { validUntil: claims.validUntil }),
              };
            }),
          );
        }
      }
    }
  });
});
