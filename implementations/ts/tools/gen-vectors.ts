// Generates vectors/l0-delta/deltas.json from the input claims below, using the (encoder-anchored)
// TS pipeline. Run with `npm run gen-vectors`. The Rust implementation must independently reproduce
// every canonicalCborHex and id in the output — that reproduction is the cross-impl parity check.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHex, computeId } from "../src/delta.js";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import { SchemaRegistry } from "../src/schema.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { authorForSeed, publicKeyFromSeed, signClaims } from "../src/sign.js";
import { parseTerm } from "../src/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../../vectors/l0-delta");
const keysDir = resolve(here, "../../../vectors/keys");
const evalDir = resolve(here, "../../../vectors/l1-eval");

interface Input {
  name: string;
  spec: string;
  claims: unknown;
}

const inputs: Input[] = [
  {
    name: "single-primitive-string",
    spec: "SPEC-1 §2",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "title", target: { value: "The Matrix" } }],
    },
  },
  {
    name: "primitive-number",
    spec: "SPEC-1 §2 / ERRATA D1",
    claims: {
      timestamp: 1717977600000,
      author: "did:key:zAuthorA",
      pointers: [{ role: "releaseYear", target: { value: 1999 } }],
    },
  },
  {
    name: "primitive-boolean",
    spec: "SPEC-1 §2",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "isCanonical", target: { value: true } }],
    },
  },
  {
    name: "entity-ref-no-context",
    spec: "SPEC-1 §2 / ERRATA D5",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "subject", target: { entityRef: { id: "entity:the_matrix" } } }],
    },
  },
  {
    name: "entity-ref-with-context",
    spec: "SPEC-1 §2 / ERRATA D5",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "cast", target: { entityRef: { id: "entity:keanu", context: "actor" } } }],
    },
  },
  {
    name: "negation-delta-ref",
    spec: "SPEC-1 §7 / ERRATA D5",
    claims: {
      timestamp: 1,
      author: "did:key:zAuthorB",
      pointers: [
        {
          role: "negates",
          target: {
            deltaRef: {
              delta: "1e2000000000000000000000000000000000000000000000000000000000000000",
            },
          },
        },
        { role: "reason", target: { value: "superseded" } },
      ],
    },
  },
  {
    name: "multi-pointer-purchase",
    spec: "SPEC-1 §3",
    claims: {
      timestamp: 1717977600000,
      author: "did:key:zAuthorA",
      pointers: [
        { role: "buyer", target: { entityRef: { id: "entity:alice", context: "purchases" } } },
        { role: "seller", target: { entityRef: { id: "entity:bob", context: "sales" } } },
        { role: "item", target: { entityRef: { id: "entity:widget", context: "soldVia" } } },
        { role: "price", target: { value: 19.99 } },
      ],
    },
  },
  {
    name: "unicode-nfc-author",
    spec: "SPEC-1 §4.1 / ERRATA D2",
    claims: {
      timestamp: 0,
      author: "did:key:café",
      pointers: [{ role: "note", target: { value: "ünïcödé" } }],
    },
  },
];

const out = inputs.map(({ name, spec, claims }) => {
  const parsed = parseClaims(claims);
  return { name, spec, claims, canonicalCborHex: canonicalHex(parsed), id: computeId(parsed) };
});

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "deltas.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${out.length} delta vectors to vectors/l0-delta/deltas.json`);

// --- test keys (deterministic seeds; Ed25519 per ERRATA D8) ---

const keySeeds: Array<[string, string]> = [
  ["test-key-1", "01".repeat(32)],
  ["test-key-2", "02".repeat(32)],
  ["test-key-3", "deadbeef".repeat(8)],
];

const keys = keySeeds.map(([keyId, seedHex]) => ({
  keyId,
  seedHex,
  publicKeyHex: publicKeyFromSeed(seedHex),
  author: authorForSeed(seedHex),
}));

mkdirSync(keysDir, { recursive: true });
writeFileSync(resolve(keysDir, "keys.json"), `${JSON.stringify(keys, null, 2)}\n`);
console.log(`wrote ${keys.length} test keys to vectors/keys/keys.json`);

// --- signed deltas (deterministic RFC 8032 signatures, reproducible cross-impl; ERRATA D9) ---

const signedInputs: Array<{
  name: string;
  spec: string;
  keyId: string;
  mk: (author: string) => unknown;
}> = [
  {
    name: "signed-single-claim",
    spec: "SPEC-1 §5 / ERRATA D8-D9",
    keyId: "test-key-1",
    mk: (author) => ({
      timestamp: 1717977600000,
      author,
      pointers: [{ role: "title", target: { value: "The Matrix" } }],
    }),
  },
  {
    name: "signed-entity-ref",
    spec: "SPEC-1 §5 / ERRATA D8-D9",
    keyId: "test-key-2",
    mk: (author) => ({
      timestamp: 42,
      author,
      pointers: [{ role: "cast", target: { entityRef: { id: "entity:keanu", context: "actor" } } }],
    }),
  },
  {
    name: "signed-negation",
    spec: "SPEC-1 §5 §7 / ERRATA D8-D9",
    keyId: "test-key-3",
    mk: (author) => ({
      timestamp: 43,
      author,
      pointers: [
        {
          role: "negates",
          target: {
            deltaRef: {
              delta: "1e2000000000000000000000000000000000000000000000000000000000000000",
            },
          },
        },
      ],
    }),
  },
];

const signed = signedInputs.map(({ name, spec, keyId, mk }) => {
  const key = keys.find((k) => k.keyId === keyId)!;
  const claims = mk(key.author);
  const parsed = parseClaims(claims);
  const delta = signClaims(parsed, key.seedHex);
  return {
    name,
    spec,
    keyId,
    claims,
    canonicalCborHex: canonicalHex(parsed),
    id: delta.id,
    sig: delta.sig,
  };
});

writeFileSync(resolve(outDir, "deltas-signed.json"), `${JSON.stringify(signed, null, 2)}\n`);
console.log(`wrote ${signed.length} signed delta vectors to vectors/l0-delta/deltas-signed.json`);

// --- set digest of the deltas.json set (ERRATA D10, provisional helper) ---

const dset = DeltaSet.from(inputs.map(({ claims }) => makeDelta(parseClaims(claims))));
const setDigest = {
  spec: "ERRATA D10 (provisional helper, not the SPEC-6 reconciliation digest)",
  ids: dset.ids(),
  digest: dset.digest(),
};
writeFileSync(resolve(outDir, "set-digest.json"), `${JSON.stringify(setDigest, null, 2)}\n`);
console.log(`wrote set digest (${dset.size} ids) to vectors/l0-delta/set-digest.json`);

// --- l1-eval: select/union/mask over a movie fixture (ERRATA-2 E1-E5) ---

// The fixture is built sequentially because negations pin earlier deltas by content address.
const claim = (timestamp: number, author: string, pointers: unknown[]) => ({
  timestamp,
  author,
  pointers,
});
const subj = (entity: string, context: string) => ({
  target: { entityRef: { id: entity, context } },
});

const A = "did:key:zAlice";
const B = "did:key:zBob";
const C = "did:key:zCarol";

const fx: Record<string, { claims: unknown; id: string }> = {};
const addFx = (name: string, claims: unknown) => {
  fx[name] = { claims, id: computeId(parseClaims(claims)) };
};

addFx(
  "d1-title-matrix",
  claim(100, A, [
    { role: "subject", ...subj("movie:matrix", "title") },
    { role: "value", target: { value: "The Matrix" } },
  ]),
);
addFx(
  "d2-title-reloaded",
  claim(200, B, [
    { role: "subject", ...subj("movie:matrix", "title") },
    { role: "value", target: { value: "Matrix Reloaded" } },
  ]),
);
addFx(
  "d3-year",
  claim(150, A, [
    { role: "subject", ...subj("movie:matrix", "releaseYear") },
    { role: "value", target: { value: 1999 } },
  ]),
);
addFx(
  "d4-negates-d2",
  claim(300, B, [
    { role: "negates", target: { deltaRef: { delta: fx["d2-title-reloaded"]!.id } } },
    { role: "reason", target: { value: "typo" } },
  ]),
);
addFx(
  "d5-negates-d4",
  claim(400, C, [{ role: "negates", target: { deltaRef: { delta: fx["d4-negates-d2"]!.id } } }]),
);
addFx(
  "d6-rating",
  claim(500, A, [
    { role: "subject", ...subj("movie:matrix", "rating") },
    { role: "value", target: { value: 8.7 } },
  ]),
);
addFx(
  "d7-tag",
  claim(120, C, [
    { role: "subject", ...subj("movie:matrix", "tag") },
    { role: "value", target: { value: "scifi" } },
  ]),
);
addFx(
  "d8-other-movie",
  claim(600, A, [
    { role: "subject", ...subj("movie:johnwick", "title") },
    { role: "value", target: { value: "John Wick" } },
  ]),
);

const fixtureClaims = Object.values(fx).map((f) => f.claims);
const fixtureSet = DeltaSet.from(fixtureClaims.map((c) => makeDelta(parseClaims(c))));
const idOf = (name: string) => fx[name]!.id;

const sel = (pred: unknown, of: unknown = "input") => ({ op: "select", pred, in: of });

const evalCases: Array<{ name: string; spec: string; term: unknown; note?: string }> = [
  {
    name: "select-author-eq",
    spec: "SPEC-2 §3 §4.1",
    term: sel({ match: { field: "author", cmp: "eq", const: A } }),
  },
  {
    name: "select-timestamp-lte",
    spec: "SPEC-2 §3 (time-travel as a filter)",
    term: sel({ match: { field: "timestamp", cmp: "lte", const: 200 } }),
  },
  {
    name: "select-target-entity",
    spec: "SPEC-2 §3 hasPointer",
    term: sel({ hasPointer: { targetEntity: "movie:matrix" } }),
  },
  {
    name: "select-context-exact",
    spec: "SPEC-2 §3 hasPointer.context",
    term: sel({ hasPointer: { context: { exact: "title" } } }),
  },
  {
    name: "select-role-prefix",
    spec: "SPEC-2 §3 StrMatch.prefix",
    term: sel({ hasPointer: { role: { prefix: "neg" } } }),
  },
  {
    name: "select-value-between",
    spec: "SPEC-2 §3 ValMatch.between (value index contract)",
    term: sel({ hasPointer: { targetValue: { between: [5, 2000] } } }),
  },
  {
    name: "select-value-gt-mixed-types",
    spec: "SPEC-2 §3 / ERRATA-2 E3 (bool < number < string)",
    term: sel({ hasPointer: { targetValue: { vcmp: { cmp: "gt", value: 100 } } } }),
    note: "strings rank above all numbers in the canonical order, so every string value matches",
  },
  {
    name: "select-value-inset",
    spec: "SPEC-2 §3 ValMatch.inSet",
    term: sel({ hasPointer: { targetValue: { inSet: ["scifi", "typo"] } } }),
  },
  {
    name: "select-and-not",
    spec: "SPEC-2 §3 connectives",
    term: sel({
      and: [
        { match: { field: "author", cmp: "eq", const: A } },
        { not: { hasPointer: { context: { exact: "title" } } } },
      ],
    }),
  },
  {
    name: "select-false-is-empty",
    spec: "SPEC-2 §3",
    term: sel("false"),
  },
  {
    name: "union-two-selects",
    spec: "SPEC-2 §4.2",
    term: {
      op: "union",
      left: sel({ match: { field: "author", cmp: "eq", const: B } }),
      right: sel({ match: { field: "author", cmp: "eq", const: C } }),
    },
  },
  {
    name: "mask-drop-chain",
    spec: "SPEC-2 §4.3 (even-length chain reinstates)",
    term: { op: "mask", policy: "drop", in: "input" },
    note: "d4 negates d2, d5 negates d4 => d4 suppressed, d2 reinstated",
  },
  {
    name: "mask-annotate",
    spec: "SPEC-2 §4.3 / ERRATA-2 E2",
    term: { op: "mask", policy: "annotate", in: "input" },
  },
  {
    name: "mask-trust-restricts-candidates",
    spec: "SPEC-2 §4.3 / ERRATA-2 E4",
    term: {
      op: "mask",
      policy: { trust: { match: { field: "author", cmp: "eq", const: B } } },
      in: "input",
    },
    note: "only B's negations count: d4 counts (d5 by C does not), so d2 is suppressed",
  },
  {
    name: "select-then-mask-scopes-to-operand",
    spec: "SPEC-2 §4.3 (negated(d, D) ranges over the operand set)",
    term: { op: "mask", policy: "drop", in: sel({ hasPointer: { targetEntity: "movie:matrix" } }) },
    note: "the negation d4 is excluded by the select, so nothing in the subset is suppressed",
  },
];

const evalVectors = evalCases.map(({ name, spec, term, note }) => {
  const parsed = parseTerm(term);
  const result = evalTerm(parsed, fixtureSet);
  if (result.sort !== "dset") throw new Error(`${name}: expected a DSet result`);
  const expected: { ids: string[]; negated?: string[] } = { ids: result.set.ids() };
  if (result.annotated) expected.negated = [...result.negated].sort();
  return {
    name,
    spec,
    ...(note === undefined ? {} : { note }),
    term,
    expected,
    expectedCanonicalHex: resultCanonicalHex(result),
  };
});

mkdirSync(evalDir, { recursive: true });
const evalOut = {
  fixture: {
    note: "deltas are listed with their fixture names; negations pin earlier deltas by id",
    deltas: Object.entries(fx).map(([name, f]) => ({ name, id: f.id, claims: f.claims })),
  },
  cases: evalVectors,
};
writeFileSync(resolve(evalDir, "eval-basic.json"), `${JSON.stringify(evalOut, null, 2)}\n`);
console.log(
  `wrote ${evalVectors.length} eval vectors over ${fixtureSet.size} fixture deltas to vectors/l1-eval/eval-basic.json`,
);
// --- l1-eval: group/prune into HyperViews (ERRATA-2 E6-E9) ---

// Extend the movie fixture with multi-context and contextless filing probes.
addFx(
  "d9-variant",
  claim(700, C, [
    { role: "subject", ...subj("movie:matrix", "title") },
    { role: "variantOf", ...subj("movie:matrix", "related") },
    { role: "value", target: { value: "The Matrix (1999)" } },
  ]),
);
addFx(
  "d10-contextless-mention",
  claim(800, B, [{ role: "mentions", target: { entityRef: { id: "movie:matrix" } } }]),
);

const hviewFixtureSet = DeltaSet.from(
  Object.values(fx).map((f) => makeDelta(parseClaims(f.claims))),
);

const MATRIX = "movie:matrix";
const canonicalIdiom = {
  op: "group",
  key: "byTargetContext",
  in: { op: "mask", policy: "drop", in: sel({ hasPointer: { targetEntity: MATRIX } }) },
};

const hviewCases: Array<{
  name: string;
  spec: string;
  root: string;
  term: unknown;
  note?: string;
}> = [
  {
    name: "group-by-target-context-canonical-idiom",
    spec: "SPEC-2 §4.4 / SPEC-3 §2 / E6",
    root: MATRIX,
    term: canonicalIdiom,
    note: "select relevant, drop negated, file by target-context — the canonical schema body",
  },
  {
    name: "group-by-role",
    spec: "SPEC-2 §4.4 / E6",
    root: MATRIX,
    term: { op: "group", key: "byRole", in: sel({ hasPointer: { targetEntity: MATRIX } }) },
  },
  {
    name: "group-const-bags-everything",
    spec: "SPEC-2 §4.4 / E6 (const files without a filing pointer)",
    root: MATRIX,
    term: {
      op: "group",
      key: { const: "claims" },
      in: sel({ match: { field: "author", cmp: "eq", const: A } }),
    },
  },
  {
    name: "group-threads-annotate-tags",
    spec: "SPEC-5 §4 audit views / E7",
    root: MATRIX,
    term: {
      op: "group",
      key: "byTargetContext",
      in: { op: "mask", policy: "annotate", in: "input" },
    },
    note: "d2 is negated in the full input, so its entry carries negated: true",
  },
  {
    name: "group-by-target-context-skips-contextless",
    spec: "E6 (a filing pointer without context files nothing)",
    root: MATRIX,
    term: {
      op: "group",
      key: "byTargetContext",
      in: sel({ match: { field: "author", cmp: "eq", const: B } }),
    },
  },
  {
    name: "group-by-role-files-contextless",
    spec: "E6 (byRole files under the pointer role)",
    root: MATRIX,
    term: {
      op: "group",
      key: "byRole",
      in: sel({ match: { field: "author", cmp: "eq", const: B } }),
    },
  },
  {
    name: "group-empty-root",
    spec: "SPEC-3 §7 (empty props, never null)",
    root: "movie:nonexistent",
    term: { op: "group", key: "byTargetContext", in: "input" },
  },
  {
    name: "prune-keep-exact",
    spec: "SPEC-2 §4.6 / E8",
    root: MATRIX,
    term: { op: "prune", keep: { exact: "title" }, in: canonicalIdiom },
  },
  {
    name: "prune-keep-inset",
    spec: "SPEC-2 §4.6 / E8",
    root: MATRIX,
    term: { op: "prune", keep: { inSet: ["title", "rating"] }, in: canonicalIdiom },
  },
  {
    name: "prune-keep-prefix",
    spec: "SPEC-2 §4.6 / E8",
    root: MATRIX,
    term: { op: "prune", keep: { prefix: "re" }, in: canonicalIdiom },
  },
  {
    name: "prune-all-is-identity",
    spec: "SPEC-2 §4.6 / E8",
    root: MATRIX,
    term: { op: "prune", keep: "all", in: canonicalIdiom },
  },
];

const hviewVectors = hviewCases.map(({ name, spec, root, term, note }) => {
  const result = evalTerm(parseTerm(term), hviewFixtureSet, root);
  if (result.sort !== "hview") throw new Error(`${name}: expected an HView result`);
  const props: Record<string, Array<{ id: string; negated?: boolean }>> = {};
  for (const [prop, entries] of [...result.hview.props.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    props[prop] = entries.map((e) => ({
      id: e.delta.id,
      ...(e.negated ? { negated: true } : {}),
    }));
  }
  return {
    name,
    spec,
    ...(note === undefined ? {} : { note }),
    root,
    term,
    expected: { id: result.hview.id, props },
    expectedCanonicalHex: resultCanonicalHex(result),
  };
});

const hviewOut = {
  fixture: {
    note: "the eval-basic fixture plus d9 (multi-context filing) and d10 (contextless pointer)",
    deltas: Object.entries(fx).map(([name, f]) => ({ name, id: f.id, claims: f.claims })),
  },
  cases: hviewVectors,
};
writeFileSync(resolve(evalDir, "eval-hview.json"), `${JSON.stringify(hviewOut, null, 2)}\n`);
console.log(
  `wrote ${hviewVectors.length} hview vectors over ${hviewFixtureSet.size} fixture deltas to vectors/l1-eval/eval-hview.json`,
);

// --- l1-eval: expand/fix + schema registry (ERRATA-2 E10-E11) ---

// A fresh fixture with a DATA cycle: keanu created brzrkr; brzrkr was created by keanu.
// Expansion terminates because the SCHEMA chain terminates (SPEC-3 §3).
const xfx: Record<string, { claims: unknown; id: string }> = {};
const addXfx = (name: string, claims: unknown) => {
  xfx[name] = { claims, id: computeId(parseClaims(claims)) };
};

addXfx(
  "a1-keanu-name",
  claim(100, A, [
    { role: "subject", ...subj("actor:keanu", "name") },
    { role: "value", target: { value: "Keanu Reeves" } },
  ]),
);
addXfx(
  "m1-matrix-title",
  claim(110, A, [
    { role: "subject", ...subj("movie:matrix", "title") },
    { role: "value", target: { value: "The Matrix" } },
  ]),
);
addXfx(
  "m2-brzrkr-title",
  claim(120, B, [
    { role: "subject", ...subj("movie:brzrkr", "title") },
    { role: "value", target: { value: "BRZRKR" } },
  ]),
);
addXfx(
  "c1-cast",
  claim(130, A, [
    { role: "movie", ...subj("movie:matrix", "cast") },
    { role: "actor", ...subj("actor:keanu", "filmography") },
    { role: "character", target: { value: "Neo" } },
  ]),
);
addXfx(
  "c2-created",
  claim(140, C, [
    { role: "creator", ...subj("actor:keanu", "createdWorks") },
    { role: "work", ...subj("movie:brzrkr", "createdBy") },
  ]),
);

const expandFixtureSet = DeltaSet.from(
  Object.values(xfx).map((f) => makeDelta(parseClaims(f.claims))),
);

// The canonical schema body idiom (SPEC-3 §2): select everything pointing at the root, drop
// negated, file by target-context.
const canonicalBody = {
  op: "group",
  key: "byTargetContext",
  in: { op: "mask", policy: "drop", in: sel({ hasPointer: { targetEntity: { var: "root" } } }) },
};

const schemas = [
  { name: "MovieBasic", alg: 1, body: canonicalBody },
  { name: "ActorName", alg: 1, body: canonicalBody },
  {
    name: "MovieWithCast",
    alg: 1,
    body: { op: "expand", role: { exact: "actor" }, schema: "ActorName", in: canonicalBody },
  },
  {
    name: "ActorWithWorks",
    alg: 1,
    body: { op: "expand", role: { exact: "work" }, schema: "MovieBasic", in: canonicalBody },
  },
  {
    name: "MovieDeep",
    alg: 1,
    body: { op: "expand", role: { exact: "actor" }, schema: "ActorWithWorks", in: canonicalBody },
  },
];

const expandRegistry = SchemaRegistry.build(
  schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);

const expandCases: Array<{ name: string; spec: string; term: unknown; note?: string }> = [
  {
    name: "fix-terminal-schema",
    spec: "SPEC-2 §4.8 / E10",
    term: { op: "fix", schema: "MovieBasic", entity: "movie:matrix" },
    note: "no expands: entity refs stay bare (terminal schema, SPEC-3 §3)",
  },
  {
    name: "fix-expand-one-level",
    spec: "SPEC-2 §4.5 §4.8 / E11",
    term: { op: "fix", schema: "MovieWithCast", entity: "movie:matrix" },
    note: "c1's actor pointer is replaced by the ActorName HView at actor:keanu",
  },
  {
    name: "fix-data-cycle-terminates",
    spec: "SPEC-3 §3 (DAG on programs, not data)",
    term: { op: "fix", schema: "MovieDeep", entity: "movie:matrix" },
    note: "keanu -> brzrkr -> keanu is a data cycle; the schema chain MovieDeep -> ActorWithWorks -> MovieBasic is finite, so expansion terminates with brzrkr's createdBy as a bare ref",
  },
  {
    name: "fix-actor-perspective",
    spec: "SPEC-2 §4.8",
    term: { op: "fix", schema: "ActorWithWorks", entity: "actor:keanu" },
  },
  {
    name: "expand-no-matching-role-is-identity",
    spec: "SPEC-3 §7 (graceful degradation)",
    term: {
      op: "expand",
      role: { exact: "nonexistent" },
      schema: "ActorName",
      in: { op: "fix", schema: "MovieBasic", entity: "movie:matrix" },
    },
  },
  {
    name: "expand-skips-primitive-targets",
    spec: "E11 (only EntityRef targets expand)",
    term: {
      op: "expand",
      role: { exact: "character" },
      schema: "ActorName",
      in: { op: "fix", schema: "MovieBasic", entity: "movie:matrix" },
    },
    note: 'c1.character targets the primitive "Neo"; role matches but the target kind does not',
  },
  {
    name: "fix-unknown-entity-is-empty",
    spec: "SPEC-3 §7",
    term: { op: "fix", schema: "MovieDeep", entity: "movie:unknown" },
  },
];

const expandVectors = expandCases.map(({ name, spec, term, note }) => {
  const result = evalTerm(parseTerm(term), expandFixtureSet, undefined, expandRegistry);
  if (result.sort !== "hview") throw new Error(`${name}: expected an HView result`);
  return {
    name,
    spec,
    ...(note === undefined ? {} : { note }),
    term,
    expectedCanonicalHex: resultCanonicalHex(result),
  };
});

const expandOut = {
  fixture: {
    note: "actors/movies with a keanu<->brzrkr data cycle; schema DAG depth 3",
    deltas: Object.entries(xfx).map(([name, f]) => ({ name, id: f.id, claims: f.claims })),
  },
  schemas,
  cases: expandVectors,
};
writeFileSync(resolve(evalDir, "eval-expand.json"), `${JSON.stringify(expandOut, null, 2)}\n`);
console.log(
  `wrote ${expandVectors.length} expand vectors over ${expandFixtureSet.size} fixture deltas to vectors/l1-eval/eval-expand.json`,
);

// the fixture ids double as documentation: surface two for sanity
console.log(
  `  d2=${idOf("d2-title-reloaded").slice(0, 12)}… d4=${idOf("d4-negates-d2").slice(0, 12)}…`,
);
