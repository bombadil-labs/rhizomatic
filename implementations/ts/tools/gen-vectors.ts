// Generates vectors/l0-delta/deltas.json from the input claims below, using the (encoder-anchored)
// TS pipeline. Run with `npm run gen-vectors`. The Rust implementation must independently reproduce
// every canonicalCborHex and id in the output — that reproduction is the cross-impl parity check.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHex, computeId } from "../src/delta.js";
import { parseClaims } from "../src/json-profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../../vectors/l0-delta");

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
