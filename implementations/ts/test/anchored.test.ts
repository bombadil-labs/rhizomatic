// Anchored reads (SPEC-17 proposal): over random stores, an anchored read answers exactly what a
// whole-set evaluation answers, and its scope holds only the deltas the read can depend on.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { anchorAnalysis, evalAnchored, scopeIds } from "../src/resolve/anchored.js";
import { evalTerm, resultCanonicalHex } from "../src/resolve/eval.js";
import { Reactor } from "../src/reactor/reactor.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import { makeDelta, makeNegationClaims } from "../src/delta/set.js";
import { parseTerm } from "../src/syntax/term-json.js";
import { parseClaims } from "../src/delta/json-profile.js";
import type { Delta, Pointer } from "../src/delta/types.js";

const here = dirname(fileURLToPath(import.meta.url));

const ENTITIES = ["e0", "e1", "e2", "e3", "e4", "e5", "e6", "grants"];
const AUTHORS = ["did:key:zA", "did:key:zB", "did:key:zC"];

const leaf = {
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
};
const registry = SchemaRegistry.build([
  { name: "Leaf", alg: 1, body: parseTerm(leaf) },
  {
    name: "Mid",
    alg: 1,
    body: parseTerm({ op: "expand", role: { exact: "child" }, schema: "Leaf", in: leaf }),
  },
  {
    name: "Tree",
    alg: 1,
    body: parseTerm({ op: "expand", role: { exact: "child" }, schema: "Mid", in: leaf }),
  },
]);

const TERMS: Record<string, unknown> = {
  leaf,
  tree: { op: "fix", schema: "Tree", entity: "e0" },
  rootTree: { op: "expand", role: { exact: "child" }, schema: "Mid", in: leaf },
  annotate: {
    op: "group",
    key: "byRole",
    in: {
      op: "select",
      pred: { hasPointer: { targetEntity: { var: "root" } } },
      in: { op: "mask", policy: "annotate", in: "input" },
    },
  },
  trust: {
    op: "group",
    key: "byTargetContext",
    in: {
      op: "select",
      pred: { hasPointer: { targetEntity: { var: "root" } } },
      in: {
        op: "mask",
        policy: {
          trust: {
            or: [
              { match: { field: "author", cmp: "eq", const: AUTHORS[0] } },
              {
                inView: {
                  term: {
                    op: "select",
                    pred: { hasPointer: { targetEntity: "grants" } },
                    in: { op: "mask", policy: "drop", in: "input" },
                  },
                  field: "author",
                  extract: { role: "grantee" },
                },
              },
            ],
          },
        },
        in: "input",
      },
    },
  },
  setAlgebra: {
    op: "group",
    key: "byRole",
    in: {
      op: "difference",
      of: {
        op: "select",
        pred: { hasPointer: { targetEntity: { var: "root" } } },
        in: { op: "mask", policy: "drop", in: "input" },
      },
      without: {
        op: "select",
        pred: { match: { field: "author", cmp: "eq", const: AUTHORS[1] } },
        in: "input",
      },
    },
  },
};

type Raw = {
  readonly author: number;
  readonly at: number;
  readonly until: number | undefined;
  readonly pointers: readonly { role: number; entity: number; context: number }[];
  readonly negates: number | undefined;
  readonly grantee: number | undefined;
};

const ROLES = ["subject", "child", "value", "other"];
const CONTEXTS = ["name", "height", "parts"];

// A value in `tenths` of ten draws, otherwise undefined. (fc.option defaults to a value 4 times in
// 5, which made most generated deltas negations and hid every expansion.)
const sometimes = <T>(arb: fc.Arbitrary<T>, tenths: number): fc.Arbitrary<T | undefined> =>
  fc.oneof(
    { arbitrary: fc.constant(undefined), weight: 10 - tenths },
    { arbitrary: arb, weight: tenths },
  );

const raw: fc.Arbitrary<Raw> = fc.record({
  author: fc.nat(AUTHORS.length - 1),
  at: fc.integer({ min: 1, max: 40 }),
  until: sometimes(fc.integer({ min: 41, max: 80 }), 3),
  pointers: fc.array(
    fc.record({
      role: fc.nat(ROLES.length - 1),
      entity: fc.nat(ENTITIES.length - 1),
      context: fc.nat(CONTEXTS.length - 1),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  negates: sometimes(fc.nat(200), 2),
  grantee: sometimes(fc.nat(AUTHORS.length - 1), 2),
});

// Build deltas in order; a negation targets an earlier delta, so chains form naturally.
function build(raws: readonly Raw[]): Delta[] {
  const out: Delta[] = [];
  for (const r of raws) {
    const author = AUTHORS[r.author]!;
    if (r.negates !== undefined && out.length > 0) {
      const target = out[r.negates % out.length]!;
      out.push(makeDelta(makeNegationClaims(author, r.at, target.id)));
      continue;
    }
    const pointers: Pointer[] = r.pointers.map((p) => ({
      role: ROLES[p.role]!,
      target: {
        kind: "entity",
        entity: { id: ENTITIES[p.entity]!, context: CONTEXTS[p.context]! },
      },
    }));
    if (r.grantee !== undefined)
      pointers.push({ role: "grantee", target: { kind: "primitive", value: AUTHORS[r.grantee]! } });
    out.push(
      makeDelta({
        timestamp: r.at,
        validFrom: r.at,
        ...(r.until === undefined ? {} : { validUntil: r.until }),
        author,
        pointers,
      }),
    );
  }
  return out;
}

describe("anchored reads (SPEC-17 §6)", () => {
  for (const [name, json] of Object.entries(TERMS)) {
    it(`${name}: an anchored read equals the whole-set read, on random stores`, () => {
      const term = parseTerm(json);
      const analysis = anchorAnalysis(term, registry);
      if (!analysis.anchored) throw new Error(analysis.reason);
      // Coverage: runs where discovery widened the scope, and where a member was struck.
      let discovered = 0,
        struck = 0;
      fc.assert(
        fc.property(
          fc.array(raw, { minLength: 1, maxLength: 60 }),
          fc.nat(ENTITIES.length - 2),
          fc.integer({ min: 0, max: 90 }),
          (raws, rootIndex, now) => {
            const reactor = new Reactor();
            const deltas = build(raws);
            for (const d of deltas) reactor.ingest(d);
            const root = ENTITIES[rootIndex]!;
            const anchored = reactor.evalAnchored(term, now, root, registry);
            const whole = evalTerm(term, reactor.snapshot(), now, root, registry);
            expect(resultCanonicalHex(anchored.result)).toBe(resultCanonicalHex(whole));
            if (anchored.scope.length > new Set([root, ...analysis.anchors]).size) discovered++;
            // Every member points into the scope, or negates a member.
            const members = new Set(anchored.members);
            for (const id of anchored.members) {
              const d = reactor.get(id)!;
              const inScope = d.claims.pointers.some(
                (p) => p.target.kind === "entity" && anchored.scope.includes(p.target.entity.id),
              );
              const negatesMember = d.claims.pointers.some(
                (p) =>
                  p.role === "negates" &&
                  p.target.kind === "delta" &&
                  members.has(p.target.deltaRef.delta),
              );
              expect(inScope || negatesMember).toBe(true);
              if (negatesMember) struck++;
            }
          },
        ),
        // A pinned seed keeps the coverage counts below stable from run to run.
        { numRuns: 300, seed: 17 },
      );
      expect(struck).toBeGreaterThan(20);
      if (name === "tree" || name === "rootTree") expect(discovered).toBeGreaterThan(20);
    });
  }

  it("a selection is applied to every member and every negator", () => {
    const keep = makeDelta({
      timestamp: 1,
      validFrom: 1,
      author: AUTHORS[0]!,
      pointers: [
        { role: "subject", target: { kind: "entity", entity: { id: "e0", context: "name" } } },
      ],
    });
    const strike = makeDelta(makeNegationClaims(AUTHORS[1]!, 2, keep.id));
    const reactor = new Reactor();
    reactor.ingest(keep);
    reactor.ingest(strike);
    expect(scopeIds(reactor, ["e0"])).toEqual([keep.id, strike.id].sort());
    expect(scopeIds(reactor, ["e0"], (d) => d.claims.author === AUTHORS[0])).toEqual([keep.id]);
    expect(scopeIds(reactor, ["e1"])).toEqual([]);
  });
});

describe("anchor analysis (SPEC-17 §5)", () => {
  const unanchored: [string, unknown, string][] = [
    [
      "an aliased role",
      {
        op: "group",
        key: "byRole",
        in: {
          op: "select",
          pred: { hasPointer: { role: { aliased: { name: "n" } } } },
          in: "input",
        },
      },
      "aliased",
    ],
    [
      "a reflection not pinned to an entity",
      {
        op: "group",
        key: "byRole",
        in: {
          op: "select",
          pred: {
            inView: {
              term: {
                op: "select",
                pred: { match: { field: "timestamp", cmp: "gte", const: 0 } },
                in: "input",
              },
              field: "author",
              extract: { field: "author" },
            },
          },
          in: "input",
        },
      },
      "reflection",
    ],
    [
      "a const group over every delta",
      { op: "group", key: { const: "all" }, in: "input" },
      "const-group",
    ],
    [
      "a DSet result",
      { op: "select", pred: { match: { field: "timestamp", cmp: "gte", const: 0 } }, in: "input" },
      "result-sort",
    ],
  ];
  for (const [name, json, reason] of unanchored) {
    it(`${name} is unanchored: ${reason}`, () => {
      expect(anchorAnalysis(parseTerm(json), registry)).toEqual({ anchored: false, reason });
    });
  }

  it("names constant anchors: reflection entities and fix entities", () => {
    expect(anchorAnalysis(parseTerm(TERMS["trust"]), registry)).toEqual({
      anchored: true,
      anchors: ["grants"],
    });
    expect(anchorAnalysis(parseTerm(TERMS["tree"]), registry)).toEqual({
      anchored: true,
      anchors: ["e0"],
    });
  });
});

// The shared vectors: both witnesses must produce these exact scopes, analyses and bytes.
const vectors = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-anchored.json"), "utf8"),
) as {
  fixture: { deltas: { name: string; id: string; claims: unknown }[] };
  schemas: { name: string; alg: number; body: unknown }[];
  scopeCases: {
    name: string;
    entities: string[];
    excluded?: string[];
    expectedMembers: string[];
  }[];
  analysisCases: { name: string; term: unknown; expected: unknown }[];
  readCases: {
    name: string;
    term: unknown;
    root: string;
    now: number;
    expectedScope: string[];
    expectedMembers: string[];
    expectedCanonicalHex: string;
  }[];
};

describe("l1-eval anchored vectors (SPEC-17)", () => {
  const fixture = new Reactor();
  const nameOf = new Map<string, string>();
  const idOf = new Map<string, string>();
  for (const d of vectors.fixture.deltas) {
    const delta = makeDelta(parseClaims(d.claims));
    expect(delta.id).toBe(d.id);
    expect(fixture.ingest(delta).status).toBe("accepted");
    nameOf.set(d.id, d.name);
    idOf.set(d.name, d.id);
  }
  const names = (ids: readonly string[]) => ids.map((id) => nameOf.get(id) ?? id);
  const vectorRegistry = SchemaRegistry.build(
    vectors.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
  );

  for (const c of vectors.scopeCases) {
    it(`scope: ${c.name}`, () => {
      const excluded = new Set((c.excluded ?? []).map((n) => idOf.get(n)!));
      expect(names(scopeIds(fixture, c.entities, (d) => !excluded.has(d.id)))).toEqual(
        c.expectedMembers,
      );
    });
  }
  for (const c of vectors.analysisCases) {
    it(`analysis: ${c.name}`, () => {
      expect(anchorAnalysis(parseTerm(c.term), vectorRegistry)).toEqual(c.expected);
    });
  }
  for (const c of vectors.readCases) {
    it(`read: ${c.name}`, () => {
      const term = parseTerm(c.term);
      const read = fixture.evalAnchored(term, c.now, c.root, vectorRegistry);
      expect(read.scope).toEqual(c.expectedScope);
      expect(names(read.members)).toEqual(c.expectedMembers);
      expect(resultCanonicalHex(read.result)).toBe(c.expectedCanonicalHex);
      const whole = evalTerm(term, fixture.snapshot(), c.now, c.root, vectorRegistry);
      expect(resultCanonicalHex(whole)).toBe(c.expectedCanonicalHex);
    });
  }
});

// P7 as a rail: the work an anchored read does is a count of store lookups, and that count does
// not move when unrelated deltas are added. Timing would be noisy; the lookup count is exact.
describe("an anchored read's cost does not grow with the store (SPEC-17 P7)", () => {
  const term = parseTerm(TERMS["rootTree"]);
  const fixtureDeltas = build(
    [0, 1, 2, 3, 4, 5].map((i) => ({
      author: 0,
      at: 1 + i,
      until: undefined,
      pointers: [
        { role: 0, entity: i % 2, context: 0 },
        { role: 1, entity: (i % 3) + 2, context: 1 },
      ],
      negates: undefined,
      grantee: undefined,
    })),
  );
  const lookups = (bystanders: number) => {
    const reactor = new Reactor();
    for (const d of fixtureDeltas) reactor.ingest(d);
    for (let i = 0; i < bystanders; i++)
      reactor.ingest(
        makeDelta({
          timestamp: 1,
          validFrom: 1,
          author: AUTHORS[1]!,
          pointers: [
            {
              role: "subject",
              target: { kind: "entity", entity: { id: `elsewhere:${i}`, context: "name" } },
            },
          ],
        }),
      );
    let count = 0;
    const counting = {
      get: (id: string) => (count++, reactor.get(id)),
      targets: (e: string) => (count++, reactor.targets(e)),
      negators: (id: string) => (count++, reactor.negators(id)),
      subset: (ids: Iterable<string>) => reactor.subset(ids),
    };
    const read = evalAnchored(term, counting, 50, "e0", registry);
    return { count, members: read.members.length };
  };

  it("the same lookups with 0 and with 5000 unrelated deltas", () => {
    const small = lookups(0);
    expect(small.members).toBeGreaterThan(0);
    expect(lookups(5000)).toEqual(small);
  });
});

// Incremental equivalence under scope dispatch (SPEC-4 §1, SPEC-17 §6): a warm view refreshes only
// when an ingested delta touches its scope, and after every single ingest it still equals a batch
// evaluation. Narrower dispatch is only sound if this holds.
describe("warm views refresh by scope and stay equal to batch evaluation", () => {
  const roots = ["e0", "e1", "e2"];
  for (const name of ["leaf", "rootTree", "annotate", "trust", "setAlgebra"]) {
    it(`${name}: equal to batch after every ingest`, () => {
      const term = parseTerm(TERMS[name]);
      let skipped = 0;
      fc.assert(
        fc.property(fc.array(raw, { minLength: 1, maxLength: 40 }), (raws) => {
          const reactor = new Reactor();
          reactor.register(name, term, roots, 50, registry);
          for (const d of build(raws)) {
            const before = reactor.evalCountOf(name);
            reactor.ingest(d);
            if (reactor.evalCountOf(name) === before) skipped++;
            for (const root of roots) {
              const batch = evalTerm(term, reactor.snapshot(), 50, root, registry);
              expect(reactor.materializedHex(name, root)).toBe(resultCanonicalHex(batch));
            }
          }
        }),
        { numRuns: 120, seed: 23 },
      );
      // The dispatch is narrow: some ingests touch no root's scope and refresh nothing.
      expect(skipped).toBeGreaterThan(50);
    });
  }
});

describe("a static anchor dispatches: a grant landing after a strike refreshes the view", () => {
  it("granting the striker makes the strike bind, and the warm view follows", () => {
    const term = parseTerm(TERMS["trust"]);
    const reactor = new Reactor();
    reactor.register("trust", term, ["e0"], 50, registry);
    const fact = makeDelta({
      timestamp: 1,
      validFrom: 1,
      author: AUTHORS[0]!,
      pointers: [
        { role: "subject", target: { kind: "entity", entity: { id: "e0", context: "name" } } },
      ],
    });
    reactor.ingest(fact);
    reactor.ingest(makeDelta(makeNegationClaims(AUTHORS[1]!, 2, fact.id)));
    const ungranted = reactor.materializedHex("trust", "e0");
    reactor.ingest(
      makeDelta({
        timestamp: 3,
        validFrom: 3,
        author: AUTHORS[0]!,
        pointers: [
          {
            role: "subject",
            target: { kind: "entity", entity: { id: "grants", context: "grant" } },
          },
          { role: "grantee", target: { kind: "primitive", value: AUTHORS[1]! } },
        ],
      }),
    );
    const granted = reactor.materializedHex("trust", "e0");
    expect(granted).not.toBe(ungranted);
    expect(granted).toBe(
      resultCanonicalHex(evalTerm(term, reactor.snapshot(), 50, "e0", registry)),
    );
  });
});

describe("a lowered program dispatches by scope only when its hook names its dependencies", () => {
  const term = parseTerm(TERMS["leaf"]);
  const unrelated = makeDelta({
    timestamp: 1,
    validFrom: 1,
    author: AUTHORS[0]!,
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: "e5", context: "name" } } },
    ],
  });
  const dependency = makeDelta({
    timestamp: 1,
    validFrom: 1,
    author: AUTHORS[0]!,
    pointers: [
      { role: "subject", target: { kind: "entity", entity: { id: "grants", context: "grant" } } },
    ],
  });
  const refreshes = (deps: readonly string[] | undefined, delta: Delta) => {
    const reactor = new Reactor();
    reactor.register("lowered", term, ["e0"], 50, registry, (t, _input, _now, r) => ({
      term: t,
      ...(r === undefined ? {} : { registry: r }),
      ...(deps === undefined ? {} : { deps }),
    }));
    const before = reactor.evalCountOf("lowered");
    reactor.ingest(delta);
    return reactor.evalCountOf("lowered") - before;
  };

  it("without deps, every ingest refreshes (the reactor cannot see what the lowering read)", () => {
    expect(refreshes(undefined, unrelated)).toBe(1);
  });
  it("with deps, an unrelated ingest refreshes nothing", () => {
    expect(refreshes(["grants"], unrelated)).toBe(0);
  });
  it("with deps, an ingest at a dependency refreshes", () => {
    expect(refreshes(["grants"], dependency)).toBe(1);
  });
});
