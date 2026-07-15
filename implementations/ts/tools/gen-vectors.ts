// Generates vectors/l0-delta/deltas.json from the input claims below, using the (encoder-anchored)
// TS pipeline. Run with `npm run gen-vectors`. The Rust implementation must independently reproduce
// every canonicalCborHex and id in the output — that reproduction is the cross-impl parity check.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHex, computeId } from "../src/delta.js";
import { bytesToHex } from "../src/hash.js";
import { packId, packSet } from "../src/pack.js";
import { makeManifestClaims } from "../src/reactor.js";
import { aliasClosure, evalTerm, resultCanonicalHex, type AliasedSpec } from "../src/eval.js";
import { relationSignature, relationSignatureCanonicalHex } from "../src/alias.js";
import { VOCAB_PREFIX } from "../src/vocab.js";
import { b64uEncode } from "../src/b64u.js";
import { claimsToJson, parseClaims } from "../src/json-profile.js";
import {
  HYPER_SCHEMA_SCHEMA,
  SCHEMA_SCHEMA,
  loadSchema,
  publishHyperSchemaClaims,
  publishSchemaClaims,
} from "../src/schema-deltas.js";
import { SchemaRegistry } from "../src/schema.js";
import { schemaCanonicalHex, termCanonicalHex, termHash, termToJson } from "../src/term-io.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { authorForSeed, publicKeyFromSeed, signClaims } from "../src/sign.js";
import { parsePred, parseSchema, parseTerm } from "../src/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../../vectors/l0-delta");
const keysDir = resolve(here, "../../../vectors/keys");
const evalDir = resolve(here, "../../../vectors/l1-eval");

interface Input {
  name: string;
  spec: string;
  claims: unknown;
}

// bytes-target fixtures (issue #7, 0.4, ERRATA D12). Raw payloads → the JSON profile carries them
// as canonical base64url; Rust must reproduce every canonicalCborHex and id byte-for-byte.
const PNG4 = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // 4 bytes: the PNG magic prefix
const BLOB30 = new Uint8Array(Array.from({ length: 30 }, (_, i) => i)); // 0x58 one-byte length head
const bytesTarget = (mime: string, bytes: Uint8Array) => ({ mime, value: b64uEncode(bytes) });

const inputs: Input[] = [
  {
    name: "single-primitive-string",
    spec: "SPEC-1 §2",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "title", target: "The Matrix" }],
    },
  },
  {
    name: "primitive-number",
    spec: "SPEC-1 §2 / ERRATA D1",
    claims: {
      timestamp: 1717977600000,
      author: "did:key:zAuthorA",
      pointers: [{ role: "releaseYear", target: 1999 }],
    },
  },
  {
    name: "primitive-boolean",
    spec: "SPEC-1 §2",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "isCanonical", target: true }],
    },
  },
  {
    name: "entity-ref-no-context",
    spec: "SPEC-1 §2 / ERRATA D5",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "subject", target: { id: "entity:the_matrix" } }],
    },
  },
  {
    name: "entity-ref-with-context",
    spec: "SPEC-1 §2 / ERRATA D5",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "cast", target: { id: "entity:keanu", context: "actor" } }],
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
            delta: "1e2000000000000000000000000000000000000000000000000000000000000000",
          },
        },
        { role: "reason", target: "superseded" },
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
        { role: "buyer", target: { id: "entity:alice", context: "purchases" } },
        { role: "seller", target: { id: "entity:bob", context: "sales" } },
        { role: "item", target: { id: "entity:widget", context: "soldVia" } },
        { role: "price", target: 19.99 },
      ],
    },
  },
  {
    name: "unicode-nfc-author",
    spec: "SPEC-1 §4.1 / ERRATA D2",
    claims: {
      timestamp: 0,
      author: "did:key:café",
      pointers: [{ role: "note", target: "ünïcödé" }],
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
      pointers: [{ role: "title", target: "The Matrix" }],
    }),
  },
  {
    name: "signed-entity-ref",
    spec: "SPEC-1 §5 / ERRATA D8-D9",
    keyId: "test-key-2",
    mk: (author) => ({
      timestamp: 42,
      author,
      pointers: [{ role: "cast", target: { id: "entity:keanu", context: "actor" } }],
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
            delta: "1e2000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      ],
    }),
  },
  {
    name: "signed-bytes-icon",
    spec: "SPEC-1 §5 / ERRATA D12 (signing is indifferent to the bytes kind)",
    keyId: "test-key-1",
    mk: (author) => ({
      timestamp: 4242,
      author,
      pointers: [{ role: "icon", target: bytesTarget("image/png", PNG4) }],
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

// --- bytes target kind (issue #7, 0.4, ERRATA D12) — all additive ---

const bytesInputs: Input[] = [
  {
    name: "bytes-empty-octet-stream",
    spec: "SPEC-1 §2.1 §4.1 / D12 (zero-length payload is legal; encodes 0x40)",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [
        { role: "blob", target: bytesTarget("application/octet-stream", new Uint8Array()) },
      ],
    },
  },
  {
    name: "bytes-png-4byte",
    spec: "SPEC-1 §4.1 / D12",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "icon", target: bytesTarget("image/png", PNG4) }],
    },
  },
  {
    name: "bytes-mime-case-sensitive",
    spec: "D12 (image/PNG ≠ image/png — same bytes, different id)",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "icon", target: bytesTarget("image/PNG", PNG4) }],
    },
  },
  {
    name: "bytes-different-mime-different-claim",
    spec: "D12 (same bytes under application/wasm — a different claim, different id)",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "icon", target: bytesTarget("application/wasm", PNG4) }],
    },
  },
  {
    name: "bytes-mixed-pointer-delta",
    spec: "D12 (bytes payload co-traveling with a filing EntityRef and a string primitive)",
    claims: {
      timestamp: 7,
      author: "did:key:zAuthorA",
      pointers: [
        { role: "subject", target: { id: "entity:logo", context: "asset" } },
        { role: "data", target: bytesTarget("image/png", PNG4) },
        { role: "alt", target: "the logo" },
      ],
    },
  },
  {
    name: "bytes-30byte-head",
    spec: "SPEC-1 §4.1 (0x58 one-byte length head path)",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [{ role: "blob", target: bytesTarget("application/octet-stream", BLOB30) }],
    },
  },
  {
    name: "bytes-1byte-tail",
    spec: 'D12 (base64url 2-char tail: 0x66 → "Zg")',
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [
        { role: "blob", target: bytesTarget("application/octet-stream", new Uint8Array([0x66])) },
      ],
    },
  },
  {
    name: "bytes-2byte-tail",
    spec: "D12 (base64url 3-char tail)",
    claims: {
      timestamp: 0,
      author: "did:key:zAuthorA",
      pointers: [
        {
          role: "blob",
          target: bytesTarget("application/octet-stream", new Uint8Array([0x66, 0x6f])),
        },
      ],
    },
  },
];

const bytesOut = bytesInputs.map(({ name, spec, claims }) => {
  const parsed = parseClaims(claims);
  return { name, spec, claims, canonicalCborHex: canonicalHex(parsed), id: computeId(parsed) };
});
writeFileSync(resolve(outDir, "deltas-bytes.json"), `${JSON.stringify(bytesOut, null, 2)}\n`);
console.log(`wrote ${bytesOut.length} bytes-target vectors to vectors/l0-delta/deltas-bytes.json`);

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
  target: { id: entity, context },
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
    { role: "value", target: "The Matrix" },
  ]),
);
addFx(
  "d2-title-reloaded",
  claim(200, B, [
    { role: "subject", ...subj("movie:matrix", "title") },
    { role: "value", target: "Matrix Reloaded" },
  ]),
);
addFx(
  "d3-year",
  claim(150, A, [
    { role: "subject", ...subj("movie:matrix", "releaseYear") },
    { role: "value", target: 1999 },
  ]),
);
addFx(
  "d4-negates-d2",
  claim(300, B, [
    { role: "negates", target: { delta: fx["d2-title-reloaded"]!.id } },
    { role: "reason", target: "typo" },
  ]),
);
addFx(
  "d5-negates-d4",
  claim(400, C, [{ role: "negates", target: { delta: fx["d4-negates-d2"]!.id } }]),
);
addFx(
  "d6-rating",
  claim(500, A, [
    { role: "subject", ...subj("movie:matrix", "rating") },
    { role: "value", target: 8.7 },
  ]),
);
addFx(
  "d7-tag",
  claim(120, C, [
    { role: "subject", ...subj("movie:matrix", "tag") },
    { role: "value", target: "scifi" },
  ]),
);
addFx(
  "d8-other-movie",
  claim(600, A, [
    { role: "subject", ...subj("movie:johnwick", "title") },
    { role: "value", target: "John Wick" },
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

// --- l1-eval: set algebra over delta-sets — difference/intersect (SPEC-2 §4.9, ERRATA-2 E17) ---
// Reuses the eval-basic fixture (fx / fixtureSet) so ids are the same already-verified hashes.
const matrixSel = sel({ hasPointer: { targetEntity: "movie:matrix" } });
const authorSel = (a: string) => sel({ match: { field: "author", cmp: "eq", const: a } });
const maskAnnotate = { op: "mask", policy: "annotate", in: "input" };

const setAlgCases: Array<{ name: string; spec: string; term: unknown; note?: string }> = [
  {
    name: "difference-basic",
    spec: "SPEC-2 §4.9 (difference: of ∖ without, keyed by id)",
    note: "matrix-touching {d1,d2,d3,d6,d7} minus Bob {d2,d4} = {d1,d3,d6,d7}",
    term: { op: "difference", of: matrixSel, without: authorSel(B) },
  },
  {
    name: "intersect-basic",
    spec: "SPEC-2 §4.9 (intersect: left ∩ right, keyed by id)",
    note: "matrix-touching {d1,d2,d3,d6,d7} ∩ Alice {d1,d3,d6,d8} = {d1,d3,d6}",
    term: { op: "intersect", left: matrixSel, right: authorSel(A) },
  },
  {
    name: "difference-self-is-empty",
    spec: "SPEC-2 §4.9 (X ∖ X = ∅)",
    term: { op: "difference", of: authorSel(A), without: authorSel(A) },
  },
  {
    name: "intersect-disjoint-is-empty",
    spec: "SPEC-2 §4.9 (disjoint operands ∩ = ∅)",
    note: "Bob {d2,d4} ∩ Carol {d5,d7} = ∅",
    term: { op: "intersect", left: authorSel(B), right: authorSel(C) },
  },
  {
    name: "nested-difference-of-difference",
    spec: "SPEC-2 §4.9 + E17 (difference against a term that is itself a difference — impossible under inView depth-1 stratification, the blocker this op removes)",
    note: "inner = matrix ∖ Bob = {d1,d3,d6,d7}; outer = matrix ∖ inner = {d2}",
    term: {
      op: "difference",
      of: matrixSel,
      without: { op: "difference", of: matrixSel, without: authorSel(B) },
    },
  },
  {
    name: "difference-then-union",
    spec: "SPEC-2 §4.9 (composes with union — set algebra closes)",
    note: "(matrix ∖ Alice = {d2,d7}) ∪ Carol {d5,d7} = {d2,d5,d7}",
    term: {
      op: "union",
      left: { op: "difference", of: matrixSel, without: authorSel(A) },
      right: authorSel(C),
    },
  },
  {
    name: "intersect-over-union-operand",
    spec: "SPEC-2 §4.9 (whole-delta dedup by id through a union operand)",
    note: "(Alice ∪ Bob = {d1,d2,d3,d4,d6,d8}) ∩ matrix {d1,d2,d3,d6,d7} = {d1,d2,d3,d6}",
    term: {
      op: "intersect",
      left: { op: "union", left: authorSel(A), right: authorSel(B) },
      right: matrixSel,
    },
  },
  {
    name: "difference-drops-annotate-channel",
    spec: "SPEC-2 §4.9 + §4.3/E14/E17 Q4 (the mask(annotate) tag channel does not survive a DSet op — result is a plain id array, no `negated` key)",
    note: "of = mask(annotate, input) tags d4 negated but the channel is dropped; {d1..d8} ∖ Bob {d2,d4} = {d1,d3,d5,d6,d7,d8}",
    term: { op: "difference", of: maskAnnotate, without: authorSel(B) },
  },
];

const setAlgVectors = setAlgCases.map(({ name, spec, term, note }) => {
  const result = evalTerm(parseTerm(term), fixtureSet);
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

// The §8 fail-closed guards — each MUST be rejected (parse-time: unknown op / wrong operand keys;
// eval-time: HView operand, E9), never partially evaluated. Verified at generation time so a
// regenerated vector can never silently ship a "reject" term that actually evaluates.
const setAlgRejects: Array<{ name: string; spec: string; reason: string; term: unknown }> = [
  {
    name: "unknown-op-rejected",
    spec: "SPEC-2 §8 (fail-closed: parsers MUST reject an unrecognized `op`, loudly, before evaluation — the parity guard that lets additive operators enter without an `alg` bump)",
    reason:
      "unknown operator `symmetricDifference` is not in the closed §9 Term profile; a conformant parser rejects rather than partially evaluating",
    term: { op: "symmetricDifference", left: "input", right: "input" },
  },
  {
    name: "difference-wrong-operand-keys-rejected",
    spec: "SPEC-2 §9 (difference uses `of`/`without`; `left`/`right` is union's shape)",
    reason:
      "difference requires `of` and `without` operands; supplying union's `left`/`right` is a malformed term",
    term: { op: "difference", left: "input", right: "input" },
  },
  {
    name: "difference-hview-operand-rejected",
    spec: "SPEC-2 §4.9 + E9 (operands are DSet-sort; a group result is HView-sort)",
    reason:
      "difference operands must be DSet-sort; `group` yields an HView (evaluation-time sort error, per E9 dynamic sorting)",
    term: {
      op: "difference",
      of: "input",
      without: { op: "group", key: "byTargetContext", in: "input" },
    },
  },
];
for (const r of setAlgRejects) {
  let rejected = false;
  try {
    evalTerm(parseTerm(r.term), fixtureSet);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`set-algebra reject "${r.name}" was accepted; §8 fail-closed is violated`);
  }
}

const setAlgOut = {
  note: "Set algebra over delta-sets: first-class `difference` and `intersect` term ops (SPEC-2 §4.9, ERRATA-2 E17), symmetric with `union` (§4.2). Fixture is the eval-basic fixture (same 8 content-addressed deltas). `cases` are positive oracles; `rejects` are the §8 fail-closed parity guards (unknown-op / unknown-tag / wrong-sort MUST be rejected, verified at generation time).",
  fixture: {
    note: "identical to eval-basic.json — the same 8 content-addressed deltas",
    deltas: Object.entries(fx).map(([name, f]) => ({ name, id: f.id, claims: f.claims })),
  },
  cases: setAlgVectors,
  rejects: setAlgRejects,
};
writeFileSync(resolve(evalDir, "eval-setalgebra.json"), `${JSON.stringify(setAlgOut, null, 2)}\n`);
console.log(
  `wrote ${setAlgVectors.length} set-algebra vectors + ${setAlgRejects.length} rejects to vectors/l1-eval/eval-setalgebra.json`,
);

// --- l1-eval: group/prune into HyperViews (ERRATA-2 E6-E9) ---

// Extend the movie fixture with multi-context and contextless filing probes.
addFx(
  "d9-variant",
  claim(700, C, [
    { role: "subject", ...subj("movie:matrix", "title") },
    { role: "variantOf", ...subj("movie:matrix", "related") },
    { role: "value", target: "The Matrix (1999)" },
  ]),
);
addFx(
  "d10-contextless-mention",
  claim(800, B, [{ role: "mentions", target: { id: "movie:matrix" } }]),
);

const hviewFixtureSet = DeltaSet.from(
  Object.values(fx).map((f) => makeDelta(parseClaims(f.claims))),
);

const MATRIX = "movie:matrix";
const canonicalIdiom = {
  op: "group",
  key: "byTargetContext",
  // mask BEFORE select (ERRATA-3 S5)
  in: sel({ hasPointer: { targetEntity: MATRIX } }, { op: "mask", policy: "drop", in: "input" }),
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
    { role: "value", target: "Keanu Reeves" },
  ]),
);
addXfx(
  "m1-matrix-title",
  claim(110, A, [
    { role: "subject", ...subj("movie:matrix", "title") },
    { role: "value", target: "The Matrix" },
  ]),
);
addXfx(
  "m2-brzrkr-title",
  claim(120, B, [
    { role: "subject", ...subj("movie:brzrkr", "title") },
    { role: "value", target: "BRZRKR" },
  ]),
);
addXfx(
  "c1-cast",
  claim(130, A, [
    { role: "movie", ...subj("movie:matrix", "cast") },
    { role: "actor", ...subj("actor:keanu", "filmography") },
    { role: "character", target: "Neo" },
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
  // mask BEFORE select (ERRATA-3 S5)
  in: sel(
    { hasPointer: { targetEntity: { var: "root" } } },
    {
      op: "mask",
      policy: "drop",
      in: "input",
    },
  ),
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

// --- l1-eval: resolve + schema terms (SPEC-5, ERRATA-5 R1-R7) ---

const rfx: Record<string, { claims: unknown; id: string }> = {};
const addRfx = (name: string, claims: unknown) => {
  rfx[name] = { claims, id: computeId(parseClaims(claims)) };
};

addRfx(
  "t1-title-a",
  claim(100, A, [
    { role: "subject", ...subj("movie:matrix", "title") },
    { role: "value", target: "The Matrix" },
  ]),
);
addRfx(
  "t2-title-b",
  claim(200, B, [
    { role: "subject", ...subj("movie:matrix", "title") },
    { role: "value", target: "Matrix Reloaded" },
  ]),
);
addRfx(
  "y1-year",
  claim(150, A, [
    { role: "subject", ...subj("movie:matrix", "releaseYear") },
    { role: "value", target: 1999 },
  ]),
);
addRfx(
  "r1-rating-a",
  claim(500, A, [
    { role: "subject", ...subj("movie:matrix", "rating") },
    { role: "value", target: 8.7 },
  ]),
);
addRfx(
  "r2-rating-b",
  claim(600, B, [
    { role: "subject", ...subj("movie:matrix", "rating") },
    { role: "value", target: 9.1 },
  ]),
);
addRfx(
  "g1-tag-scifi",
  claim(120, C, [
    { role: "subject", ...subj("movie:matrix", "tag") },
    { role: "value", target: "scifi" },
  ]),
);
addRfx(
  "g2-tag-action",
  claim(610, B, [
    { role: "subject", ...subj("movie:matrix", "tag") },
    { role: "value", target: "action" },
  ]),
);
addRfx(
  "s1-size-str",
  claim(700, C, [
    { role: "subject", ...subj("movie:matrix", "size") },
    { role: "value", target: "large" },
  ]),
);
addRfx(
  "s2-size-num",
  claim(710, A, [
    { role: "subject", ...subj("movie:matrix", "size") },
    { role: "value", target: 3 },
  ]),
);
addRfx(
  "n1-negates-t2",
  claim(300, B, [{ role: "negates", target: { delta: rfx["t2-title-b"]!.id } }]),
);
addRfx(
  "a1-keanu-name",
  claim(110, A, [
    { role: "subject", ...subj("actor:keanu", "name") },
    { role: "value", target: "Keanu Reeves" },
  ]),
);
addRfx(
  "c1-cast",
  claim(130, A, [
    { role: "movie", ...subj("movie:matrix", "cast") },
    { role: "actor", ...subj("actor:keanu", "filmography") },
    { role: "character", target: "Neo" },
  ]),
);

// A second root for the chain-composition cases (SPEC-5 §3 chain), so the movie pins above stay
// byte-stable: Alice holds two bio claims at different times; unranked Carol's is newest of all.
addRfx(
  "w1-bio-old",
  claim(100, A, [
    { role: "subject", ...subj("person:wren", "bio") },
    { role: "value", target: "Founder of the village archive" },
  ]),
);
addRfx(
  "w2-bio-new",
  claim(500, A, [
    { role: "subject", ...subj("person:wren", "bio") },
    { role: "value", target: "Archivist and cartographer" },
  ]),
);
addRfx(
  "f1-bio-unranked",
  claim(900, C, [
    { role: "subject", ...subj("person:wren", "bio") },
    { role: "value", target: "Retired from public life" },
  ]),
);
addRfx(
  "m1-motto-a",
  claim(400, A, [
    { role: "subject", ...subj("person:wren", "motto") },
    { role: "value", target: "measure twice" },
  ]),
);
addRfx(
  "m2-motto-b",
  claim(400, B, [
    { role: "subject", ...subj("person:wren", "motto") },
    { role: "value", target: "cut once" },
  ]),
);

const resolveFixtureSet = DeltaSet.from(
  Object.values(rfx).map((f) => makeDelta(parseClaims(f.claims))),
);

const rawBody = {
  op: "group",
  key: "byTargetContext",
  in: sel({ hasPointer: { targetEntity: { var: "root" } } }),
};
const resolveSchemas = [
  { name: "MovieRaw", alg: 1, body: rawBody },
  { name: "PersonRaw", alg: 1, body: rawBody },
  { name: "MovieView", alg: 1, body: canonicalBody },
  { name: "ActorNameV", alg: 1, body: canonicalBody },
  {
    name: "MovieCast",
    alg: 1,
    body: { op: "expand", role: { exact: "actor" }, schema: "ActorNameV", in: canonicalBody },
  },
];
const resolveRegistry = SchemaRegistry.build(
  resolveSchemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);

const latest = { pick: { order: { byTimestamp: "desc" } } };
const fixMovie = (schema: string) => ({ op: "fix", schema, entity: "movie:matrix" });
const fixWren = { op: "fix", schema: "PersonRaw", entity: "person:wren" };
const res = (schema: unknown, of: unknown) => ({ op: "resolve", schema, in: of });

const resolveCases: Array<{ name: string; spec: string; term: unknown; note?: string }> = [
  {
    name: "pick-latest-superposed",
    spec: "SPEC-5 §3 pick/byTimestamp",
    term: res({ default: latest }, fixMovie("MovieRaw")),
    note: "no mask: both titles superposed; last-claim-wins picks Matrix Reloaded; size picks 3 (ts 710)",
  },
  {
    name: "pick-latest-after-mask-drop",
    spec: "SPEC-5 §4 (negation already happened upstream)",
    term: res({ default: latest }, fixMovie("MovieView")),
    note: "t2 negated by n1: title resolves to The Matrix",
  },
  {
    name: "pick-by-author-rank",
    spec: "SPEC-5 §3 byAuthorRank (the trust primitive)",
    term: res({ default: { pick: { order: { byAuthorRank: [A, B, C] } } } }, fixMovie("MovieRaw")),
  },
  {
    name: "pick-by-pred-prefers-carol",
    spec: "SPEC-5 §3 byPred",
    term: res(
      {
        default: {
          pick: {
            order: {
              byPred: {
                pred: { match: { field: "author", cmp: "eq", const: C } },
                then: { byTimestamp: "desc" },
              },
            },
          },
        },
      },
      fixMovie("MovieRaw"),
    ),
    note: "tag prefers scifi (Carol's), size prefers large (Carol's)",
  },
  {
    name: "all-ascending",
    spec: "SPEC-5 §3 all",
    term: res(
      { props: { tag: { all: { order: { byTimestamp: "asc" } } } }, default: latest },
      fixMovie("MovieRaw"),
    ),
  },
  {
    name: "merge-max-min-sum-count",
    spec: "SPEC-5 §3 MergeFn / ERRATA-5 R2",
    term: res(
      {
        props: {
          rating: { merge: "sum" },
          tag: { merge: "count" },
          size: { merge: "max" },
          releaseYear: { merge: "min" },
        },
        default: latest,
      },
      fixMovie("MovieRaw"),
    ),
    note: "sum folds in id order (8.7+9.1); size max is the STRING large by canonical type order",
  },
  {
    name: "merge-concat-sorted",
    spec: "SPEC-5 §3 MergeFn",
    term: res({ props: { tag: { merge: "concatSorted" } }, default: latest }, fixMovie("MovieRaw")),
  },
  {
    name: "conflicts-surfaces-disagreement",
    spec: "SPEC-5 §3 conflicts",
    term: res(
      {
        props: {
          title: { conflicts: { order: { byTimestamp: "desc" } } },
          releaseYear: { conflicts: { order: { byTimestamp: "desc" } } },
        },
        default: latest,
      },
      fixMovie("MovieRaw"),
    ),
    note: "title has 2 distinct claims -> surfaced; releaseYear has 1 -> absent",
  },
  {
    name: "absent-as-default",
    spec: "SPEC-5 §3 absentAs / §4 empty property",
    term: res(
      {
        props: { director: { absentAs: { const: "unknown", then: latest } } },
        default: latest,
      },
      fixMovie("MovieRaw"),
    ),
    note: "no director deltas exist; the schema names the property so absentAs fires",
  },
  {
    name: "resolve-nested-expansion",
    spec: "ERRATA-5 R1/R6 (multi-pointer candidate; nested View with same schema)",
    term: res({ default: latest }, fixMovie("MovieCast")),
    note: "cast candidate is {actor: {name: Keanu Reeves}, character: Neo}",
  },
  {
    name: "author-rank-terminal-ties-lexById",
    spec: "SPEC-5 §3 byAuthorRank (tie-permissive: ties fall to the structural lexById)",
    term: res(
      { props: { bio: { pick: { order: { byAuthorRank: [A] } } } }, default: latest },
      fixWren,
    ),
    note: "rank alone cannot see recency: Alice's two bios tie, whichever id sorts first wins",
  },
  {
    name: "chain-trusted-then-latest",
    spec: "SPEC-5 §3 chain (trusted, then latest)",
    term: res(
      {
        props: {
          bio: {
            pick: { order: { chain: [{ byAuthorRank: [A] }, { byTimestamp: "desc" }] } },
          },
        },
        default: latest,
      },
      fixWren,
    ),
    note: "unranked Carol's newest bio loses to Alice; among Alice's own, recency decides: Archivist and cartographer",
  },
  {
    name: "chain-latest-then-rank",
    spec: "SPEC-5 §3 chain (latest, rank as tiebreak)",
    term: res(
      {
        props: {
          motto: {
            all: { order: { chain: [{ byTimestamp: "desc" }, { byAuthorRank: [A, B, C] }] } },
          },
        },
        default: latest,
      },
      fixWren,
    ),
    note: "mottoes tie at ts 400; rank breaks the tie: Alice's first",
  },
  {
    name: "chain-indecisive-falls-to-lexById",
    spec: "SPEC-5 §3 chain / R3 (a fully tied chain ends at the implicit lexById)",
    term: res(
      { props: { bio: { pick: { order: { chain: [{ byAuthorRank: [A] }] } } } }, default: latest },
      fixWren,
    ),
    note: "a one-link chain is its link: same View as author-rank-terminal-ties-lexById",
  },
  {
    name: "chain-under-byPred",
    spec: "SPEC-5 §3 byPred + chain compose",
    term: res(
      {
        props: {
          bio: {
            pick: {
              order: {
                byPred: {
                  pred: { match: { field: "author", cmp: "eq", const: A } },
                  then: { chain: [{ byTimestamp: "asc" }] },
                },
              },
            },
          },
        },
        default: latest,
      },
      fixWren,
    ),
    note: "Alice's claims first, then her oldest: Founder of the village archive",
  },
];

const resolveVectors = resolveCases.map(({ name, spec, term, note }) => {
  const result = evalTerm(parseTerm(term), resolveFixtureSet, undefined, resolveRegistry);
  if (result.sort !== "view") throw new Error(`${name}: expected a View result`);
  return {
    name,
    spec,
    ...(note === undefined ? {} : { note }),
    term,
    expectedView: result.view,
    expectedCanonicalHex: resultCanonicalHex(result),
  };
});

const resolveOut = {
  fixture: {
    note: "superposed titles, competing ratings, mixed-type sizes, a negation, and a cast edge for nested resolution",
    deltas: Object.entries(rfx).map(([name, f]) => ({ name, id: f.id, claims: f.claims })),
  },
  schemas: resolveSchemas,
  cases: resolveVectors,
};
writeFileSync(resolve(evalDir, "eval-resolve.json"), `${JSON.stringify(resolveOut, null, 2)}\n`);
console.log(
  `wrote ${resolveVectors.length} resolve vectors over ${resolveFixtureSet.size} fixture deltas to vectors/l1-eval/eval-resolve.json`,
);

// --- l1-eval: schemas-as-deltas + the bootstrap (ERRATA-2 E12-E13, ERRATA-3 S1-S3) ---

const schemaHashes = schemas.map((s) => ({
  name: s.name,
  termJson: termToJson(parseTerm(s.body)),
  canonicalCborHex: termCanonicalHex(parseTerm(s.body)),
  termHash: termHash(parseTerm(s.body)),
}));

const movieWithCast = expandRegistry.get("MovieWithCast")!;
const publishedClaims = publishHyperSchemaClaims(movieWithCast, "schema:MovieWithCast", A, 1000);
const publishedDelta = makeDelta(publishedClaims);

// pinned-ref case: fix through the hash of MovieBasic must equal fix through its name
const movieBasicHash = termHash(expandRegistry.get("MovieBasic")!.body);
const pinnedTerm = { op: "fix", schema: { pinned: movieBasicHash }, entity: "movie:matrix" };
const pinnedResult = evalTerm(parseTerm(pinnedTerm), expandFixtureSet, undefined, expandRegistry);

// S6 (issue #11): a resolution Schema published + loaded back through SCHEMA_SCHEMA.
const publishedSchemaInput = {
  name: "MovieView",
  alg: 1,
  props: {
    title: { pick: { order: { byTimestamp: "desc" } } },
    rating: { merge: "max" },
  },
  default: { pick: { order: "lexById" } },
};
const publishedSchemaObj = parseSchema(publishedSchemaInput);
const schemaClaims = publishSchemaClaims(publishedSchemaObj, "schema:MovieView", A, 2000);
const schemaDelta = makeDelta(schemaClaims);
const loadedSchema = loadSchema(DeltaSet.from([schemaDelta]), "schema:MovieView");
if (schemaCanonicalHex(loadedSchema) !== schemaCanonicalHex(publishedSchemaObj)) {
  throw new Error("SCHEMA_SCHEMA round-trip failed in gen-vectors");
}

const schemaDeltasOut = {
  bootstrap: {
    name: HYPER_SCHEMA_SCHEMA.name,
    alg: HYPER_SCHEMA_SCHEMA.alg,
    termJson: termToJson(HYPER_SCHEMA_SCHEMA.body),
    canonicalCborHex: termCanonicalHex(HYPER_SCHEMA_SCHEMA.body),
    termHash: termHash(HYPER_SCHEMA_SCHEMA.body),
  },
  schemaSchema: {
    note: "SCHEMA_SCHEMA (rhizomatic.SchemaSchema): reuses the generic gather idiom (S6)",
    name: SCHEMA_SCHEMA.name,
    alg: SCHEMA_SCHEMA.alg,
    termHash: termHash(SCHEMA_SCHEMA.body),
  },
  publishedSchema: {
    note: "a resolution Schema published as a definition delta; loadSchema must round-trip it (S6)",
    schemaEntity: "schema:MovieView",
    schemaJson: publishedSchemaInput,
    claims: claimsToJson(schemaClaims),
    deltaId: schemaDelta.id,
    expectedSchemaHex: schemaCanonicalHex(publishedSchemaObj),
  },
  termHashes: schemaHashes,
  published: {
    note: "MovieWithCast published as a definition delta; loadHyperSchema must round-trip it",
    schemaEntity: "schema:MovieWithCast",
    claims: claimsToJson(publishedClaims),
    deltaId: publishedDelta.id,
    expectedTermHash: termHash(movieWithCast.body),
  },
  pinnedRef: {
    note: "fix through {pinned: hash} equals fix through the name",
    term: pinnedTerm,
    expectedCanonicalHex: resultCanonicalHex(pinnedResult),
  },
};
writeFileSync(
  resolve(evalDir, "schema-deltas.json"),
  `${JSON.stringify(schemaDeltasOut, null, 2)}\n`,
);
console.log(
  "wrote schema-deltas vectors (bootstrap " +
    schemaDeltasOut.bootstrap.termHash.slice(0, 14) +
    "...)",
);

// --- l0-pack: the pack round-trip vector (SPEC-8, ERRATA-8) ---

const packMembers = [
  ...Object.values(fx)
    .slice(0, 4)
    .map((f) => makeDelta(parseClaims(f.claims))),
  signClaims(
    parseClaims({
      timestamp: 4900,
      author: keys[0]!.author,
      pointers: [{ role: "note", target: "covered" }],
    }),
    keys[0]!.seedHex,
  ),
];
const packManifest = makeDelta(
  makeManifestClaims(
    "did:key:zBundler",
    5000,
    packMembers.map((m) => m.id),
    { intent: "pack fixture" },
  ),
);
const packManifest2 = makeDelta(
  makeManifestClaims("did:key:zBundler", 5001, [packMembers[0]!.id], { prior: packManifest.id }),
);
const packLoose = Object.values(fx)
  .slice(4, 8)
  .map((f) => makeDelta(parseClaims(f.claims)));
const packDeltas = [...packMembers, packManifest, packManifest2, ...packLoose];
const packFixtureSet = DeltaSet.from(packDeltas);
const packBytes = packSet(packFixtureSet);

mkdirSync(resolve(evalDir, "../l0-pack"), { recursive: true });
writeFileSync(
  resolve(evalDir, "../l0-pack/pack.json"),
  `${JSON.stringify(
    {
      note: "members incl. a divergent-author member, a signed member, a multiply-claimed member; manifests + loose deltas. Rust must reproduce packHex byte-for-byte.",
      deltas: packDeltas.map((d) => ({
        claims: claimsToJson(d.claims),
        ...(d.sig === undefined ? {} : { sig: d.sig }),
      })),
      packHex: bytesToHex(packBytes),
      packId: packId(packBytes),
    },
    null,
    2,
  )}\n`,
);
console.log(
  `wrote pack vector (${packDeltas.length} deltas, packId ${packId(packBytes).slice(0, 14)}...)`,
);

// the fixture ids double as documentation: surface two for sanity
console.log(
  `  d2=${idOf("d2-title-reloaded").slice(0, 12)}… d4=${idOf("d4-negates-d2").slice(0, 12)}…`,
);

// --- l1-eval: parameterized terms — hole(name) bound at fix (SPEC-2 §6, ERRATA-2 E15) ---

const hfx: Record<string, { claims: unknown; id: string }> = {};
const addHfx = (name: string, claims: unknown) => {
  hfx[name] = { claims, id: computeId(parseClaims(claims)) };
};

addHfx(
  "h1-title",
  claim(100, A, [
    { role: "movie", ...subj("movie:matrix", "title") },
    { role: "title", target: "The Matrix" },
  ]),
);
addHfx(
  "h2-rating-low",
  claim(150, A, [
    { role: "movie", ...subj("movie:matrix", "rating") },
    { role: "rating", target: 7.5 },
  ]),
);
addHfx(
  "h3-rating-high",
  claim(200, B, [
    { role: "movie", ...subj("movie:matrix", "rating") },
    { role: "rating", target: 9.2 },
  ]),
);
addHfx(
  "h4-cast-keanu",
  claim(250, A, [
    { role: "movie", ...subj("movie:matrix", "cast") },
    { role: "actor", target: { id: "entity:keanu", context: "filmography" } },
  ]),
);
addHfx(
  "h5-cast-carrie",
  claim(300, A, [
    { role: "movie", ...subj("movie:matrix", "cast") },
    { role: "actor", target: { id: "entity:carrie", context: "filmography" } },
  ]),
);

const holesFixtureSet = DeltaSet.from(
  Object.values(hfx).map((f) => makeDelta(parseClaims(f.claims))),
);

// Each schema body parameterizes a different Const position (E15).
const holeSchemas = [
  {
    name: "ViewAsOf",
    alg: 1,
    body: {
      op: "group",
      key: "byTargetContext",
      in: {
        op: "mask",
        policy: "drop",
        in: {
          op: "select",
          pred: { match: { field: "timestamp", cmp: "lte", const: { hole: "asOf" } } },
          in: "input",
        },
      },
    },
  },
  {
    name: "RatedAtLeast",
    alg: 1,
    body: {
      op: "group",
      key: "byTargetContext",
      in: {
        op: "mask",
        policy: "drop",
        in: {
          op: "select",
          pred: {
            or: [
              { not: { hasPointer: { context: { exact: "rating" } } } },
              { hasPointer: { targetValue: { vcmp: { cmp: "gte", value: { hole: "min" } } } } },
            ],
          },
          in: "input",
        },
      },
    },
  },
  {
    name: "LinkedTo",
    alg: 1,
    body: {
      op: "group",
      key: "byTargetContext",
      in: {
        op: "mask",
        policy: "drop",
        in: {
          op: "select",
          pred: { hasPointer: { targetEntity: { hole: "who" } } },
          in: "input",
        },
      },
    },
  },
];

const holesRegistry = SchemaRegistry.build(
  holeSchemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);

const holeCases: Array<{ name: string; spec: string; term: unknown; note?: string }> = [
  {
    name: "asof-150-sees-two",
    spec: "E15 (hole in match const)",
    term: { op: "fix", schema: "ViewAsOf", entity: "movie:matrix", bindings: { asOf: 150 } },
    note: "title + the t=150 rating; later deltas are outside the bound horizon",
  },
  {
    name: "asof-999-sees-all",
    spec: "E15 (same body, different binding, different view)",
    term: { op: "fix", schema: "ViewAsOf", entity: "movie:matrix", bindings: { asOf: 999 } },
  },
  {
    name: "rated-at-least-9",
    spec: "E15 (hole in vcmp value)",
    term: { op: "fix", schema: "RatedAtLeast", entity: "movie:matrix", bindings: { min: 9 } },
    note: "the 7.5 rating drops; non-rating properties pass through",
  },
  {
    name: "rated-at-least-5",
    spec: "E15 (hole in vcmp value)",
    term: { op: "fix", schema: "RatedAtLeast", entity: "movie:matrix", bindings: { min: 5 } },
  },
  {
    name: "cast-member-keanu",
    spec: "E15 (hole in targetEntity)",
    term: {
      op: "fix",
      schema: "LinkedTo",
      entity: "movie:matrix",
      bindings: { who: "entity:keanu" },
    },
    note: "only the edge that also points at the bound entity files",
  },
  {
    name: "cast-member-carrie",
    spec: "E15 (hole in targetEntity)",
    term: {
      op: "fix",
      schema: "LinkedTo",
      entity: "movie:matrix",
      bindings: { who: "entity:carrie" },
    },
  },
];

const holeVectors = holeCases.map(({ name, spec, term, note }) => {
  const parsed = parseTerm(term);
  const result = evalTerm(parsed, holesFixtureSet, undefined, holesRegistry);
  if (result.sort !== "hview") throw new Error(`${name}: expected an HView result`);
  return {
    name,
    spec,
    ...(note === undefined ? {} : { note }),
    term,
    // The invocation term's content address: same body, different bindings => different hashes
    // (the bodies themselves keep a single hash however they are bound — asserted in unit tests).
    termHash: termHash(parsed),
    expectedCanonicalHex: resultCanonicalHex(result),
  };
});

const holesOut = {
  fixture: {
    note: "one movie with a title, two ratings, two cast edges; holes bind asOf/min/who",
    deltas: Object.entries(hfx).map(([name, f]) => ({ name, id: f.id, claims: f.claims })),
  },
  schemas: holeSchemas,
  cases: holeVectors,
};
writeFileSync(resolve(evalDir, "eval-holes.json"), `${JSON.stringify(holesOut, null, 2)}\n`);
console.log(
  `wrote ${holeVectors.length} hole vectors over ${holesFixtureSet.size} fixture deltas to vectors/l1-eval/eval-holes.json`,
);

// --- l1-eval: the aliased closure + relation signatures (SPEC-9) ---

const AF = `${VOCAB_PREFIX}.alias.fragment`;
const AS = `${VOCAB_PREFIX}.alias.slot`;
const AC = `${VOCAB_PREFIX}.alias.concept`;
const ACONF = `${VOCAB_PREFIX}.alias.confidence`;

const LIB = "did:key:zLibrarian";
const HUM = "did:key:zHuman";
const SLOPPY = "did:key:zSloppy";
const APP_A = "did:key:zAppA";
const APP_B = "did:key:zAppB";

const EMPLOYMENT = "concept:employment";
const WORKER = "concept:employment#worker";
const ORG = "concept:employment#organization";
const RESIDENCE = "concept:residence";
const LOCATION = "concept:residence#location";

const afx: Record<string, { claims: unknown; id: string }> = {};
const addAfx = (name: string, claims: unknown) => {
  afx[name] = { claims, id: computeId(parseClaims(claims)) };
};

// Two employment dialects (SPEC-9 §1's motivating drift), a decoy concept, and a stray edge.
addAfx(
  "a1-employment-ada",
  claim(100, APP_A, [
    { role: "worker", target: { id: "person:ada", context: "employer" } },
    { role: "organization", target: { id: "company:acme", context: "employees" } },
  ]),
);
addAfx(
  "b1-employment-bob",
  claim(200, APP_B, [
    { role: "worker", target: { id: "person:bob", context: "job" } },
    { role: "org", target: { id: "company:initech", context: "staff" } },
  ]),
);
addAfx(
  "b2-address-bob",
  claim(210, APP_B, [
    { role: "resident", target: { id: "person:bob", context: "address" } },
    { role: "place", target: "42 Elm St" },
  ]),
);
addAfx(
  "w1-manager-eve",
  claim(220, APP_A, [
    { role: "worker", target: { id: "person:eve", context: "manager" } },
    { role: "org", target: { id: "company:acme" } },
  ]),
);
addAfx("p1-note", claim(230, APP_B, [{ role: "note", target: "reorg pending" }]));

// Slot declarations (SPEC-9 §2): slots belong to concepts by claim, not by id convention.
const slotDecl = (slot: string, concept: string) => [
  { role: AS, target: { id: slot, context: AC } },
  { role: AC, target: { id: concept, context: `${VOCAB_PREFIX}.alias.slots` } },
];
addAfx("s1-slot-worker", claim(300, HUM, slotDecl(WORKER, EMPLOYMENT)));
addAfx("s2-slot-organization", claim(310, HUM, slotDecl(ORG, EMPLOYMENT)));
addAfx("s3-slot-location", claim(320, HUM, slotDecl(LOCATION, RESIDENCE)));

// Mapping claims (SPEC-9 §3): fragment -> slot, with confidence and provenance.
const mapping = (fragment: string, slot: string, confidence: number) => [
  { role: AF, target: fragment },
  { role: AS, target: { id: slot, context: `${VOCAB_PREFIX}.alias.mappings` } },
  { role: ACONF, target: confidence },
];
addAfx("m1-employer", claim(400, LIB, mapping("employer", ORG, 0.97)));
addAfx("m2-job", claim(410, LIB, mapping("job", ORG, 0.91)));
addAfx("m3-organization", claim(420, LIB, mapping("organization", ORG, 0.93)));
addAfx("m4-org", claim(430, LIB, mapping("org", ORG, 0.9)));
addAfx("m5-employees", claim(440, LIB, mapping("employees", WORKER, 0.95)));
addAfx("m6-staff", claim(450, LIB, mapping("staff", WORKER, 0.88)));
addAfx("m7-manager", claim(460, LIB, mapping("manager", WORKER, 0.55)));
addAfx("m8-address", claim(470, LIB, mapping("address", LOCATION, 0.92)));
// The cross-concept stray: a sloppy author gluing "employer" onto a residence slot.
addAfx("m9-employer-location", claim(480, SLOPPY, mapping("employer", LOCATION, 0.3)));
// One delta, two fragments: the cross-product rule (SPEC-9 §3).
addAfx(
  "m10-personnel-workforce",
  claim(490, LIB, [
    { role: AF, target: "personnel" },
    { role: AF, target: "workforce" },
    { role: AS, target: { id: WORKER, context: `${VOCAB_PREFIX}.alias.mappings` } },
    { role: ACONF, target: 0.85 },
  ]),
);
// A wrong mapping dies by one signed negation (SPEC-9 §3).
addAfx(
  "n1-negates-m7",
  claim(500, HUM, [
    { role: "negates", target: { delta: afx["m7-manager"]!.id } },
    { role: "reason", target: "manager names a different relation" },
  ]),
);

const aliasFixtureSet = DeltaSet.from(
  Object.values(afx).map((f) => makeDelta(parseClaims(f.claims))),
);

const confTrust = {
  hasPointer: { role: { exact: ACONF }, targetValue: { vcmp: { cmp: "gte", value: 0.8 } } },
};
const librarianTrust = { match: { field: "author", cmp: "eq", const: LIB } };

const aliasSchemas = [
  {
    name: "RecallWork",
    alg: 1,
    body: {
      op: "group",
      key: "byTargetContext",
      in: {
        op: "mask",
        policy: "drop",
        in: sel({
          and: [
            { hasPointer: { targetEntity: { var: "root" } } },
            { hasPointer: { context: { aliased: { name: "employer", via: EMPLOYMENT } } } },
          ],
        }),
      },
    },
  },
];
const aliasRegistry = SchemaRegistry.build(
  aliasSchemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);

interface AliasCase {
  name: string;
  spec: string;
  term: unknown;
  aliased?: { json: unknown; spec: AliasedSpec };
  note?: string;
}

const mkAliased = (name: string, via?: string, trustJson?: unknown) => {
  const json: Record<string, unknown> = { name };
  if (via !== undefined) json["via"] = via;
  if (trustJson !== undefined) json["trust"] = trustJson;
  const spec: AliasedSpec = {
    name,
    ...(via === undefined ? {} : { via }),
    ...(trustJson === undefined ? {} : { trust: parsePred(trustJson) }),
  };
  return { json: { aliased: json }, spec };
};

const alEmployerVia = mkAliased("employer", EMPLOYMENT);
const alEmployerBare = mkAliased("employer");
const alEmployerConf = mkAliased("employer", undefined, confTrust);
const alEmployeesVia = mkAliased("employees", EMPLOYMENT);
const alEmployeesLib = mkAliased("employees", undefined, librarianTrust);
const alIdentity = mkAliased("quarterly-review");
const alOrgRole = mkAliased("organization", EMPLOYMENT);

const aliasCases: AliasCase[] = [
  {
    name: "closure-via-restricted",
    spec: "SPEC-9 §4.1 (via restricts slots to the named concept)",
    term: sel({ hasPointer: { context: alEmployerVia.json } }),
    aliased: alEmployerVia,
    note: "employer/job converge through employment#organization; the residence stray is excluded by via",
  },
  {
    name: "closure-unrestricted-crosses-concepts",
    spec: "SPEC-9 §4.1 (no via: every slot the name maps to participates)",
    term: sel({ hasPointer: { context: alEmployerBare.json } }),
    aliased: alEmployerBare,
    note: "the sloppy employer->location mapping pulls in address — why via exists",
  },
  {
    name: "closure-trust-confidence-gate",
    spec: "SPEC-9 §4.1 (trust restricts every participant)",
    term: sel({ hasPointer: { context: alEmployerConf.json } }),
    aliased: alEmployerConf,
    note: "confidence >= 0.8 excludes the 0.3 stray without via; same closure as via-restricted, different mechanism",
  },
  {
    name: "closure-negated-mapping-dead",
    spec: "SPEC-9 §3 §4.1 (a wrong mapping dies by one signed negation)",
    term: sel({ hasPointer: { context: alEmployeesVia.json } }),
    aliased: alEmployeesVia,
    note: "manager->worker is negated by human review, so the misfiled manager edge stays out; the cross-product fragments enter",
  },
  {
    name: "closure-trust-excludes-the-negation",
    spec: "SPEC-9 §4.1 (negation chains are walked within the trusted set only — mask(trust) parity)",
    term: sel({ hasPointer: { context: alEmployeesLib.json } }),
    aliased: alEmployeesLib,
    note: "trusting only the librarian excludes the human's negation, so manager revives and the misfiled edge matches",
  },
  {
    name: "closure-identity",
    spec: "SPEC-9 §4.1 (the name is always in its own closure)",
    term: sel({ hasPointer: { context: alIdentity.json } }),
    aliased: alIdentity,
    note: "no mappings: degrades to exact(name); nothing in the fixture uses it",
  },
  {
    name: "closure-role-position",
    spec: "SPEC-9 §3 §4 (fragments are position-blind; the StrMatch position decides what is matched)",
    term: sel({ hasPointer: { role: alOrgRole.json } }),
    aliased: alOrgRole,
    note: "organization/org are role fragments of the same slot; matched in role position here",
  },
];

const aliasVectors = aliasCases.map(({ name, spec, term, aliased, note }) => {
  const parsed = parseTerm(term);
  const result = evalTerm(parsed, aliasFixtureSet);
  if (result.sort !== "dset") throw new Error(`${name}: expected a DSet result`);
  return {
    name,
    spec,
    ...(note === undefined ? {} : { note }),
    term,
    termHash: termHash(parsed),
    ...(aliased === undefined
      ? {}
      : { expectedClosure: aliasClosure(aliasFixtureSet, aliased.spec) }),
    expected: { ids: result.set.ids() },
    expectedCanonicalHex: resultCanonicalHex(result),
  };
});

// Root-anchored recall: the closure matches across dialects; output keeps the target's own
// vocabulary (matching, never renaming — SPEC-9 §4.1).
const recallCases = [
  {
    name: "recall-bob-keeps-bobs-vocabulary",
    root: "person:bob",
    note: "bob's employment files under HIS dialect's name: job",
  },
  {
    name: "recall-ada-keeps-adas-vocabulary",
    root: "person:ada",
    note: "ada's employment files under employer",
  },
].map(({ name, root, note }) => {
  const term = { op: "fix", schema: "RecallWork", entity: root };
  const parsed = parseTerm(term);
  const result = evalTerm(parsed, aliasFixtureSet, undefined, aliasRegistry);
  if (result.sort !== "hview") throw new Error(`${name}: expected an HView result`);
  const props: Record<string, string[]> = {};
  for (const [prop, entries] of [...result.hview.props.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    props[prop] = entries.map((e) => e.delta.id);
  }
  return {
    name,
    spec: "SPEC-9 §4.1 (matching, never renaming) + §7",
    note,
    term,
    termHash: termHash(parsed),
    expected: { id: result.hview.id, props },
    expectedCanonicalHex: resultCanonicalHex(result),
  };
});

// Relation signatures (SPEC-9 §5).
const signatureCases = [
  { name: "sig-two-contexted-pairs", delta: "a1-employment-ada" },
  { name: "sig-contextless-pointer", delta: "w1-manager-eve" },
  { name: "sig-mapping-delta", delta: "m1-employer" },
  { name: "sig-no-entity-pointers", delta: "p1-note" },
].map(({ name, delta }) => {
  const d = makeDelta(parseClaims(afx[delta]!.claims));
  return {
    name,
    delta,
    signature: relationSignature(d),
    canonicalHex: relationSignatureCanonicalHex(d),
  };
});

const aliasOut = {
  fixture: {
    note: "two employment dialects, a decoy residence concept, mappings (one negated, one sloppy cross-concept stray, one two-fragment cross product), slot declarations",
    deltas: Object.entries(afx).map(([name, f]) => ({ name, id: f.id, claims: f.claims })),
  },
  schemas: aliasSchemas,
  cases: [...aliasVectors, ...recallCases],
  signatures: signatureCases,
};
writeFileSync(resolve(evalDir, "eval-aliased.json"), `${JSON.stringify(aliasOut, null, 2)}\n`);
console.log(
  `wrote ${aliasOut.cases.length} aliased vectors + ${signatureCases.length} signatures over ${aliasFixtureSet.size} fixture deltas to vectors/l1-eval/eval-aliased.json`,
);

// --- l1-eval: reflective predicates (SPEC-2 §3.1, ERRATA-2 E16) ---

// The village ACL: Alice operates; grants make Bob and Carol negation-worthy; Carol's grant is
// revoked; Dave was never granted. The trusted set is a VIEW over these deltas, always current.
const D = "did:key:zDave";
const vfx: Record<string, { claims: unknown; id: string }> = {};
const addVfx = (name: string, claims: unknown) => {
  vfx[name] = { claims, id: computeId(parseClaims(claims)) };
};

addVfx(
  "g1-grant-bob",
  claim(100, A, [
    { role: "grant", ...subj("acl:village", "grants") },
    { role: "grantee", target: B },
  ]),
);
addVfx(
  "g2-grant-carol",
  claim(110, A, [
    { role: "grant", ...subj("acl:village", "grants") },
    { role: "grantee", target: C },
  ]),
);
addVfx(
  "rv1-revoke-carol",
  claim(200, A, [{ role: "negates", target: { delta: vfx["g2-grant-carol"]!.id } }]),
);
addVfx(
  "c1-color-blue",
  claim(300, A, [
    { role: "subject", ...subj("topic:sky", "color") },
    { role: "value", target: "blue" },
  ]),
);
addVfx(
  "c2-color-green",
  claim(310, D, [
    { role: "subject", ...subj("topic:sky", "color") },
    { role: "value", target: "green" },
  ]),
);
addVfx(
  "n1-bob-negates-c1",
  claim(400, B, [{ role: "negates", target: { delta: vfx["c1-color-blue"]!.id } }]),
);
addVfx(
  "n2-carol-negates-c2",
  claim(410, C, [{ role: "negates", target: { delta: vfx["c2-color-green"]!.id } }]),
);
addVfx(
  "n3-dave-negates-c2",
  claim(420, D, [{ role: "negates", target: { delta: vfx["c2-color-green"]!.id } }]),
);
addVfx("e1-endorse-bob", claim(500, B, [{ role: "member", ...subj("club:endorsed", "members") }]));
addVfx("e2-endorse-dave", claim(510, D, [{ role: "member", ...subj("club:endorsed", "members") }]));

const reflectiveFixtureSet = DeltaSet.from(
  Object.values(vfx).map((f) => makeDelta(parseClaims(f.claims))),
);

// Surviving, operator-rooted grants: Alice's deltas, negation chains walked among them (rv1
// revokes g2), then the grant edges — the sub-view every trust surface below shares.
const grantView = {
  op: "select",
  pred: { hasPointer: { role: { exact: "grant" }, targetEntity: "acl:village" } },
  in: { op: "mask", policy: "drop", in: sel({ match: { field: "author", cmp: "eq", const: A } }) },
};
const trustedGrantees = {
  inView: { term: grantView, field: "author", extract: { role: "grantee" } },
};

const reflectiveCases: Array<{ name: string; spec: string; term: unknown; note?: string }> = [
  {
    name: "reflective-roster-select",
    spec: "SPEC-2 §3.1 (aggregator admission as a view)",
    term: sel(trustedGrantees),
    note: "admits deltas authored by CURRENT grantees: Bob's only — Carol is revoked, Dave was never granted",
  },
  {
    name: "reflective-trust-mask",
    spec: "SPEC-2 §3.1 + §4.3 (the heckler's veto, closed)",
    term: { op: "mask", policy: { trust: trustedGrantees }, in: "input" },
    note: "Bob's negation suppresses c1; Carol's (revoked) and Dave's (never granted) do not — c2 survives; rv1 is Alice's own and Alice is no grantee, so g2 survives the OUTER mask while the sub-view already dropped it",
  },
  {
    name: "reflective-as-of-before-revocation",
    spec: "SPEC-2 §3.1 (the roster time-travels with the store)",
    term: {
      op: "mask",
      policy: {
        trust: {
          inView: {
            term: {
              op: "select",
              pred: { hasPointer: { role: { exact: "grant" }, targetEntity: "acl:village" } },
              in: {
                op: "mask",
                policy: "drop",
                in: sel({ match: { field: "timestamp", cmp: "lte", const: 150 } }),
              },
            },
            field: "author",
            extract: { role: "grantee" },
          },
        },
      },
      in: "input",
    },
    note: "the sub-view is time-filtered to before the revocation, so Carol still holds standing: her negation counts and c2 is suppressed too",
  },
  {
    name: "reflective-extract-author",
    spec: "SPEC-2 §3.1 (extract by delta facet)",
    term: sel({
      inView: {
        term: sel({ hasPointer: { targetEntity: "club:endorsed" } }),
        field: "author",
        extract: { field: "author" },
      },
    }),
    note: "anyone who endorsed may speak: Bob's and Dave's deltas are admitted",
  },
  {
    name: "reflective-id-membership-equals-mask",
    spec: "SPEC-2 §3.1 (id-extract membership reproduces the sub-view exactly)",
    term: sel({
      inView: {
        term: { op: "mask", policy: "drop", in: "input" },
        field: "id",
        extract: { field: "id" },
      },
    }),
    note: "select-by-membership-in-a-view is the view: identical ids to mask(drop, input)",
  },
];

const reflectiveVectors = reflectiveCases.map(({ name, spec, term, note }) => {
  const parsed = parseTerm(term);
  const result = evalTerm(parsed, reflectiveFixtureSet);
  if (result.sort !== "dset") throw new Error(`${name}: expected a DSet result`);
  return {
    name,
    spec,
    ...(note === undefined ? {} : { note }),
    term,
    expected: { ids: result.set.ids() },
    expectedCanonicalHex: resultCanonicalHex(result),
  };
});

const reflectiveOut = {
  fixture: {
    note: "operator-rooted grants (one revoked), color claims, negations by granted/revoked/never-granted authors, endorsement edges",
    deltas: Object.entries(vfx).map(([name, f]) => ({ name, id: f.id, claims: f.claims })),
  },
  cases: reflectiveVectors,
};
writeFileSync(
  resolve(evalDir, "eval-reflective.json"),
  `${JSON.stringify(reflectiveOut, null, 2)}\n`,
);
console.log(
  `wrote ${reflectiveVectors.length} reflective vectors over ${reflectiveFixtureSet.size} fixture deltas to vectors/l1-eval/eval-reflective.json`,
);
