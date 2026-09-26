// Fixture gate for the frozen SPEC-14 corpus. Authority assertions join this file when the
// principal reader lands; these checks already pin the signed bytes and case references.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeId } from "../src/delta.js";
import { parseClaims } from "../src/json-profile.js";
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
    expected: { authors: string[] };
  }>;
  history: Array<{
    name: string;
    members: string[];
    expected: Array<{ key: string; via: string[] }>;
  }>;
  predicates: Array<{ name: string; members: string[]; expected: string[]; term: unknown }>;
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
});
