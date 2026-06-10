// Generates vectors/l0-delta/deltas.json from the input claims below, using the (encoder-anchored)
// TS pipeline. Run with `npm run gen-vectors`. The Rust implementation must independently reproduce
// every canonicalCborHex and id in the output — that reproduction is the cross-impl parity check.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHex, computeId } from "../src/delta.js";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
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
// the fixture ids double as documentation: surface two for sanity
console.log(
  `  d2=${idOf("d2-title-reloaded").slice(0, 12)}… d4=${idOf("d4-negates-d2").slice(0, 12)}…`,
);
