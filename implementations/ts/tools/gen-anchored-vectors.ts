// Generates vectors/l1-eval/eval-anchored.json (SPEC-17 proposal): the scope S(E) of a read, the
// static anchor analysis, and anchored reads. Every read case is checked at generation time
// against a whole-set evaluation: an anchored read must answer the same canonical bytes.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimsToJson } from "../src/delta/json-profile.js";
import { makeDelta, makeNegationClaims } from "../src/delta/set.js";
import type { Claims, Delta, Pointer } from "../src/delta/types.js";
import { Reactor } from "../src/reactor/reactor.js";
import { anchorAnalysis, scopeIds } from "../src/resolve/anchored.js";
import { evalTerm, resultCanonicalHex } from "../src/resolve/eval.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import { parseTerm } from "../src/syntax/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../vectors/l1-eval/eval-anchored.json");

const ALICE = "did:key:zAlice",
  BOB = "did:key:zBob",
  CAROL = "did:key:zCarol";

const at = (id: string, context: string, role = "subject"): Pointer => ({
  role,
  target: { kind: "entity", entity: { id, context } },
});
const value = (v: string | number): Pointer => ({
  role: "value",
  target: { kind: "primitive", value: v },
});
const fact = (author: string, t: number, pointers: Pointer[], until?: number): Claims => ({
  timestamp: t,
  validFrom: t,
  ...(until === undefined ? {} : { validUntil: until }),
  author,
  pointers,
});

const named: { name: string; delta: Delta }[] = [];
const add = (name: string, claims: Claims): Delta => {
  const delta = makeDelta(claims);
  named.push({ name, delta });
  return delta;
};

// A bed with two plants; plant:a has a child cutting (depth 2). Bystanders elsewhere.
add("bed1-name", fact(ALICE, 10, [at("bed:1", "name"), value("North bed")]));
add("bed1-has-a", fact(ALICE, 11, [at("bed:1", "plants"), at("plant:a", "bed", "plant")]));
add("bed1-has-b", fact(ALICE, 12, [at("bed:1", "plants"), at("plant:b", "bed", "plant")]));
add("a-height-10", fact(ALICE, 20, [at("plant:a", "height"), value(10)]));
const a99 = add("a-height-99", fact(BOB, 21, [at("plant:a", "height"), value(99)]));
add("a-height-99-struck", makeNegationClaims(ALICE, 22, a99.id));
const a12 = add("a-height-12", fact(ALICE, 23, [at("plant:a", "height"), value(12)]));
const carolStrike = add("a-height-12-struck-by-carol", makeNegationClaims(CAROL, 24, a12.id));
add(
  "a-has-cutting",
  fact(ALICE, 25, [at("plant:a", "cuttings"), at("plant:c", "parent", "plant")]),
);
add("c-height-3", fact(ALICE, 26, [at("plant:c", "height"), value(3)]));
const bName = add("b-name-fern", fact(ALICE, 30, [at("plant:b", "name"), value("fern")]));
const bStrike = add("b-name-struck", makeNegationClaims(BOB, 31, bName.id));
add("b-name-strike-struck", makeNegationClaims(ALICE, 32, bStrike.id));
add("b-note-expired", fact(ALICE, 33, [at("plant:b", "note"), value("watered")], 40));
add("shared-bed1-bed2", fact(ALICE, 34, [at("bed:1", "neighbors"), at("bed:2", "neighbors")]));
add("bed2-name", fact(ALICE, 35, [at("bed:2", "name"), value("South bed")]));
const z = add("z-height", fact(ALICE, 36, [at("plant:z", "height"), value(50)]));
add("z-height-struck", makeNegationClaims(BOB, 37, z.id));
add(
  "grant-bob",
  fact(ALICE, 5, [
    at("grants", "grant"),
    { role: "grantee", target: { kind: "primitive", value: BOB } },
  ]),
);
const carolGrant = add(
  "grant-carol",
  fact(ALICE, 6, [
    at("grants", "grant"),
    { role: "grantee", target: { kind: "primitive", value: CAROL } },
  ]),
);
add("grant-carol-revoked", makeNegationClaims(ALICE, 7, carolGrant.id));
void carolStrike;

const nameOf = new Map(named.map((n) => [n.delta.id, n.name]));
const reactor = new Reactor();
for (const { delta } of named) {
  const r = reactor.ingest(delta);
  if (r.status !== "accepted") throw new Error(`fixture delta refused: ${JSON.stringify(r)}`);
}

const leaf = {
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
};
const lawful = {
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
            { match: { field: "author", cmp: "eq", const: ALICE } },
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
};
const schemas = [
  { name: "Plant", alg: 1, body: leaf },
  {
    name: "PlantWithCuttings",
    alg: 1,
    body: { op: "expand", role: { exact: "plant" }, schema: "Plant", in: leaf },
  },
  {
    name: "BedTree",
    alg: 1,
    body: { op: "expand", role: { exact: "plant" }, schema: "PlantWithCuttings", in: leaf },
  },
];
const registry = SchemaRegistry.build(
  schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);

const NOW = 38;
const ids = (list: readonly string[]) => list.map((id) => nameOf.get(id) ?? id);

const scopeCases = [
  { name: "one entity and its negation chains", entities: ["plant:a"] },
  { name: "a strike of a strike stays in the closure", entities: ["plant:b"] },
  { name: "a delta pointing at two entities joins either scope", entities: ["bed:2"] },
  { name: "several entities", entities: ["bed:1", "grants"] },
  { name: "an entity with no deltas", entities: ["plant:nowhere"] },
  {
    name: "the selection cuts a negation chain",
    entities: ["plant:b"],
    excluded: ["b-name-strike-struck"],
  },
].map((c) => {
  const excluded = new Set(
    (c.excluded ?? []).map((n) => named.find((x) => x.name === n)!.delta.id),
  );
  const members = scopeIds(reactor, c.entities, (d) => !excluded.has(d.id));
  return { ...c, expectedMembers: ids(members) };
});

const analysisCases: { name: string; term: unknown; expected: unknown }[] = [
  { name: "a plain gather at the root", term: leaf, expected: { anchored: true, anchors: [] } },
  {
    name: "a fixed tree names its entity",
    term: { op: "fix", schema: "BedTree", entity: "bed:1" },
    expected: { anchored: true, anchors: ["bed:1"] },
  },
  {
    name: "a lawful-striker mask names the grants entity",
    term: lawful,
    expected: { anchored: true, anchors: ["grants"] },
  },
  {
    name: "an aliased role",
    term: {
      op: "group",
      key: "byRole",
      in: {
        op: "select",
        pred: { hasPointer: { role: { aliased: { name: "height" } } } },
        in: "input",
      },
    },
    expected: { anchored: false, reason: "aliased" },
  },
  {
    name: "a reflection over every delta",
    term: {
      op: "group",
      key: "byRole",
      in: {
        op: "select",
        pred: {
          inView: {
            term: {
              op: "select",
              pred: { match: { field: "author", cmp: "eq", const: ALICE } },
              in: "input",
            },
            field: "author",
            extract: { field: "author" },
          },
        },
        in: "input",
      },
    },
    expected: { anchored: false, reason: "reflection" },
  },
  {
    name: "a const group over every delta",
    term: { op: "group", key: { const: "all" }, in: "input" },
    expected: { anchored: false, reason: "const-group" },
  },
  {
    name: "a const group pinned to an entity",
    term: {
      op: "group",
      key: { const: "all" },
      in: { op: "select", pred: { hasPointer: { targetEntity: "grants" } }, in: "input" },
    },
    expected: { anchored: true, anchors: ["grants"] },
  },
  {
    name: "a DSet result",
    term: { op: "select", pred: { hasPointer: { targetEntity: { var: "root" } } }, in: "input" },
    expected: { anchored: false, reason: "result-sort" },
  },
  {
    name: "an unknown schema",
    term: { op: "fix", schema: "Missing", entity: "bed:1" },
    expected: { anchored: false, reason: "unknown-schema" },
  },
];
for (const c of analysisCases) {
  const got = anchorAnalysis(parseTerm(c.term), registry);
  if (JSON.stringify(got) !== JSON.stringify(c.expected))
    throw new Error(`analysis ${c.name}: ${JSON.stringify(got)}`);
}

const readCases = [
  { name: "a plant at its root", term: leaf, root: "plant:a" },
  {
    name: "a bed tree discovers plants and a cutting",
    term: { op: "fix", schema: "BedTree", entity: "bed:1" },
    root: "bed:1",
  },
  {
    name: "an expand at the root",
    term: { op: "expand", role: { exact: "plant" }, schema: "PlantWithCuttings", in: leaf },
    root: "bed:1",
  },
  { name: "a reinstated name and an expired note", term: leaf, root: "plant:b" },
  { name: "lawful strikers: a revoked grantee's strike is inert", term: lawful, root: "plant:a" },
  { name: "a root with no deltas", term: leaf, root: "plant:nowhere" },
].map((c) => {
  const term = parseTerm(c.term);
  const read = reactor.evalAnchored(term, NOW, c.root, registry);
  const whole = evalTerm(term, reactor.snapshot(), NOW, c.root, registry);
  const hex = resultCanonicalHex(read.result);
  if (hex !== resultCanonicalHex(whole))
    throw new Error(`read ${c.name}: anchored differs from whole`);
  return {
    ...c,
    now: NOW,
    expectedScope: read.scope,
    expectedMembers: ids(read.members),
    expectedCanonicalHex: hex,
  };
});

const vectors = {
  note:
    "SPEC-17 proposal: scope S(E) closure, static anchor analysis, and anchored reads. Every read " +
    "case must also equal a whole-set evaluation of the same term. Member lists name fixture deltas.",
  fixture: {
    deltas: named.map(({ name, delta }) => ({
      name,
      id: delta.id,
      claims: claimsToJson(delta.claims),
    })),
  },
  schemas,
  scopeCases,
  analysisCases,
  readCases,
};
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(
  `wrote ${scopeCases.length} scope, ${analysisCases.length} analysis and ${readCases.length} read vectors to vectors/l1-eval/eval-anchored.json`,
);
