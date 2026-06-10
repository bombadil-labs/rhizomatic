// Generates vectors/l0-delta/deltas.json from the input claims below, using the (encoder-anchored)
// TS pipeline. Run with `npm run gen-vectors`. The Rust implementation must independently reproduce
// every canonicalCborHex and id in the output — that reproduction is the cross-impl parity check.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHex, computeId } from "../src/delta.js";
import { parseClaims } from "../src/json-profile.js";
import { DeltaSet, makeDelta } from "../src/set.js";
import { authorForSeed, publicKeyFromSeed, signClaims } from "../src/sign.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../../vectors/l0-delta");
const keysDir = resolve(here, "../../../vectors/keys");

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
