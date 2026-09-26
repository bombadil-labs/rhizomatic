// Shared SPEC-14 evidence and authority decisions, in both ingest orders.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeId } from "../src/delta.js";
import { parseClaims } from "../src/json-profile.js";
import { associatedKeys, authorsForPrincipal, resolvePrincipal } from "../src/principal.js";
import {
  evalPrincipalTerm,
  principalResolver,
  principalResolverForReactor,
  registerPrincipalMaterialization,
} from "../src/principal.js";
import { Reactor } from "../src/reactor.js";
import { verifyDelta } from "../src/sign.js";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import type { Term } from "../src/eval.js";
import { parseTerm } from "../src/term-json.js";
import { termToJson } from "../src/term-io.js";
import { termHash } from "../src/term-io.js";
import { SchemaRegistry } from "../src/schema.js";
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
  predicates: Array<{
    name: string;
    members: string[];
    now: number;
    expected: string[];
    term: unknown;
    missingResolverMustThrow: boolean;
  }>;
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

  it("lowers serializable actsFor predicates through a supplied principal resolver", () => {
    for (const c of vector.predicates) {
      const term = parseTerm(c.term);
      expect(termToJson(term), c.name).toEqual(c.term);
      for (const members of [c.members, [...c.members].reverse()]) {
        const reactor = new Reactor();
        for (const name of members) {
          expect(reactor.ingest(named.get(name)!)).toEqual({ status: "accepted" });
        }
        const input = reactor.snapshot();
        if (c.missingResolverMustThrow) {
          expect(() => evalTerm(term, input, c.now), c.name).toThrow(/principal resolver/);
        }
        const result = evalPrincipalTerm(term, input, c.now, principalResolver("sameAuthor"));
        expect(result.sort, c.name).toBe("dset");
        if (result.sort !== "dset") throw new Error("principal predicate must select a delta set");
        expect(result.set.ids(), c.name).toEqual(
          c.expected.map((alias) => named.get(alias)!.id).sort(),
        );
      }
    }
  });

  it("refreshes principal membership when delegation arrives or reaches its start", () => {
    const select = parseTerm(vector.predicates[0]!.term);
    const term: Term = { kind: "group", key: { kind: "byRole" }, of: select };
    const resolver = principalResolver("sameAuthor");
    const root = vector.keys[vector.defaults.root]!;
    const expectedHex = (reactor: Reactor, now: number) =>
      resultCanonicalHex(evalPrincipalTerm(term, reactor.snapshot(), now, resolver, root));

    const timed = new Reactor();
    for (const name of ["userDelegation", "connectionDelegation", "dataConnection"]) {
      expect(timed.ingest(named.get(name)!)).toEqual({ status: "accepted" });
    }
    registerPrincipalMaterialization(timed, "member", term, [root], 4, resolver);
    const before = timed.materializedHex("member", root);
    expect(before).toBe(expectedHex(timed, 4));
    timed.advanceTime(5);
    expect(timed.materializedHex("member", root)).toBe(expectedHex(timed, 5));
    expect(timed.materializedHex("member", root)).not.toBe(before);

    const arriving = new Reactor();
    for (const name of ["userDelegation", "dataConnection"]) {
      expect(arriving.ingest(named.get(name)!)).toEqual({ status: "accepted" });
    }
    registerPrincipalMaterialization(arriving, "member", term, [root], 6, resolver);
    const beforeArrival = arriving.materializedHex("member", root);
    expect(beforeArrival).toBe(expectedHex(arriving, 6));
    expect(arriving.ingest(named.get("connectionDelegation")!)).toEqual({ status: "accepted" });
    expect(arriving.materializedHex("member", root)).toBe(expectedHex(arriving, 6));
    expect(arriving.materializedHex("member", root)).not.toBe(beforeArrival);
  });

  it("lowers actsFor in named and pinned HyperSchema bodies", () => {
    const reactor = new Reactor();
    for (const name of ["userDelegation", "connectionDelegation", "dataConnection"]) {
      expect(reactor.ingest(named.get(name)!)).toEqual({ status: "accepted" });
    }
    const root = vector.keys[vector.defaults.root]!;
    const body: Term = {
      kind: "group",
      key: { kind: "byRole" },
      of: parseTerm(vector.predicates[0]!.term),
    };
    const registry = SchemaRegistry.build([{ name: "principal-members", alg: 2, body }]);
    const resolver = principalResolver("sameAuthor");
    const input = reactor.snapshot();
    const expected = resultCanonicalHex(evalPrincipalTerm(body, input, 6, resolver, root));
    for (const schema of [
      { kind: "name" as const, name: "principal-members" },
      { kind: "pinned" as const, hash: termHash(body) },
    ]) {
      const fix: Term = { kind: "fix", schema, entity: root };
      expect(
        resultCanonicalHex(evalPrincipalTerm(fix, input, 6, resolver, undefined, registry)),
      ).toBe(expected);
    }

    const fix: Term = {
      kind: "fix",
      schema: { kind: "name", name: "principal-members" },
      entity: root,
    };
    registerPrincipalMaterialization(
      reactor,
      "principal-members",
      fix,
      [root],
      4,
      resolver,
      registry,
    );
    const before = reactor.materializedHex("principal-members", root);
    expect(before).toBe(
      resultCanonicalHex(evalPrincipalTerm(fix, input, 4, resolver, undefined, registry)),
    );
    reactor.advanceTime(5);
    expect(reactor.materializedHex("principal-members", root)).toBe(expected);
    expect(reactor.materializedHex("principal-members", root)).not.toBe(before);
  });

  it("drops cached signature authority when a held evidence object changes", () => {
    const root = vector.keys.userRoot!;
    const delegation = structuredClone(named.get("userDelegation")!);
    const reactor = new Reactor();
    expect(reactor.ingest(delegation)).toEqual({ status: "accepted" });
    expect(reactor.ingest(named.get("connectionDelegation")!)).toEqual({ status: "accepted" });
    const options = {
      at: 6,
      now: 6,
      scope: "ada:journal",
      scopePolicy: "prefix" as const,
      suppression: "rootOrSameAuthor" as const,
    };
    const expected = [root, vector.keys.userKey!, vector.keys.connection!].sort();
    expect(authorsForPrincipal(reactor, root, options)).toEqual(expected);
    expect(authorsForPrincipal(reactor, root, options)).toEqual(expected);

    const mutable = delegation as { id: string; sig?: string; claims: Delta["claims"] };
    const originalSig = mutable.sig!;
    mutable.sig = named.get("connectionDelegation")!.sig!;
    expect(authorsForPrincipal(reactor, root, options)).toEqual([root]);
    mutable.sig = originalSig;
    const originalClaims = mutable.claims;
    mutable.claims = { ...originalClaims, timestamp: originalClaims.timestamp + 1 };
    expect(authorsForPrincipal(reactor, root, options)).toEqual([root]);
    mutable.claims = originalClaims;
    expect(authorsForPrincipal(reactor, root, options)).toEqual(expected);
  });

  it("uses live principal indexes only for that reactor's exact current input", () => {
    const reactor = new Reactor();
    for (const name of ["userDelegation", "connectionDelegation", "dataConnection"]) {
      expect(reactor.ingest(named.get(name)!)).toEqual({ status: "accepted" });
    }
    const term = parseTerm(vector.predicates[0]!.term);
    const fast = principalResolverForReactor(reactor, "rootOrSameAuthor");
    const oldInput = reactor.snapshot();
    expect(resultCanonicalHex(evalPrincipalTerm(term, oldInput, 6, fast))).toBe(
      resultCanonicalHex(
        evalPrincipalTerm(term, oldInput, 6, principalResolver("rootOrSameAuthor")),
      ),
    );
    expect(reactor.ingest(named.get("dataUser")!)).toEqual({ status: "accepted" });
    expect(() => evalPrincipalTerm(term, oldInput, 6, fast)).toThrow(/input differs/);
    const current = reactor.snapshot();
    expect(resultCanonicalHex(evalPrincipalTerm(term, current, 6, fast))).toBe(
      resultCanonicalHex(
        evalPrincipalTerm(term, current, 6, principalResolver("rootOrSameAuthor")),
      ),
    );
  });
});
