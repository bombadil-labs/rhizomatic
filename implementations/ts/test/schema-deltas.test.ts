import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/cbor.js";
import { evalTerm, resultCanonicalHex } from "../src/eval.js";
import { parseClaims } from "../src/json-profile.js";
import {
  HYPER_SCHEMA_SCHEMA,
  SCHEMA_SCHEMA,
  loadHyperSchema,
  loadSchema,
  publishHyperSchemaClaims,
  publishSchemaClaims,
} from "../src/schema-deltas.js";
import { SchemaRegistry } from "../src/schema.js";
import { DeltaSet, makeDelta, merge } from "../src/set.js";
import { schemaCanonicalHex, termCanonicalHex, termHash, termToJson } from "../src/term-io.js";
import { parseSchema, parseTerm } from "../src/term-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  JSON.parse(readFileSync(resolve(here, "../../../vectors/l1-eval", rel), "utf8")) as never;

const doc = read("schema-deltas.json") as {
  bootstrap: { name: string; termJson: unknown; canonicalCborHex: string; termHash: string };
  termHashes: Array<{
    name: string;
    termJson: unknown;
    canonicalCborHex: string;
    termHash: string;
  }>;
  published: { schemaEntity: string; claims: unknown; deltaId: string; expectedTermHash: string };
  schemaSchema: { name: string; alg: number; termHash: string };
  publishedSchema: {
    schemaEntity: string;
    schemaJson: unknown;
    claims: unknown;
    deltaId: string;
    expectedSchemaHex: string;
  };
  pinnedRef: { term: unknown; expectedCanonicalHex: string };
};

const expandDoc = read("eval-expand.json") as {
  fixture: { deltas: Array<{ claims: unknown }> };
  schemas: Array<{ name: string; alg: number; body: unknown }>;
};
const expandSet = DeltaSet.from(
  expandDoc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))),
);
const expandRegistry = SchemaRegistry.build(
  expandDoc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
);

describe("term canonical CBOR + hashes (E12)", () => {
  it("the bootstrap constant reproduces", () => {
    expect(HYPER_SCHEMA_SCHEMA.name).toBe(doc.bootstrap.name);
    expect(termToJson(HYPER_SCHEMA_SCHEMA.body)).toEqual(doc.bootstrap.termJson);
    expect(termCanonicalHex(HYPER_SCHEMA_SCHEMA.body)).toBe(doc.bootstrap.canonicalCborHex);
    expect(termHash(HYPER_SCHEMA_SCHEMA.body)).toBe(doc.bootstrap.termHash);
  });

  for (const h of doc.termHashes) {
    it(`${h.name}: parse∘serialize is identity and the hash pins`, () => {
      const term = parseTerm(h.termJson);
      expect(termToJson(term)).toEqual(h.termJson);
      expect(termCanonicalHex(term)).toBe(h.canonicalCborHex);
      expect(termHash(term)).toBe(h.termHash);
    });
  }

  it("decode is the inverse of encode on term bytes", () => {
    const bytes = hexToBytes(doc.bootstrap.canonicalCborHex);
    expect(encode(decode(bytes))).toEqual(bytes);
  });

  it("the decoder rejects items outside the profile", () => {
    expect(() => decode(Uint8Array.from([0x01]))).toThrow(/major type/); // integer
    expect(() => decode(Uint8Array.from([0x9f, 0xff]))).toThrow(/length/); // indefinite array
    expect(() => decode(Uint8Array.from([0xf4, 0xf4]))).toThrow(/trailing/);
    expect(() => decode(Uint8Array.from([0xf6]))).toThrow(/simple/); // null
  });
});

describe("schemas as deltas + the bootstrap (S1-S3)", () => {
  it("publish -> load round-trips and the term hash matches the direct hash", () => {
    const claims = parseClaims(doc.published.claims);
    const delta = makeDelta(claims);
    expect(delta.id).toBe(doc.published.deltaId);
    const dset = merge(expandSet, DeltaSet.from([delta]));
    const loaded = loadHyperSchema(dset, doc.published.schemaEntity);
    expect(loaded.name).toBe("MovieWithCast");
    expect(termHash(loaded.body)).toBe(doc.published.expectedTermHash);
    // and the loaded schema evaluates identically to the registry's original
    const viaLoaded = evalTerm(loaded.body, expandSet, "movie:matrix", expandRegistry);
    const viaOriginal = evalTerm(
      expandRegistry.get("MovieWithCast")!.body,
      expandSet,
      "movie:matrix",
      expandRegistry,
    );
    expect(resultCanonicalHex(viaLoaded)).toBe(resultCanonicalHex(viaOriginal));
  });

  it("evolution is append: a newer definition supersedes", () => {
    const v1 = publishHyperSchemaClaims(
      expandRegistry.get("MovieBasic")!,
      "schema:Evolving",
      "did:key:zAlice",
      1000,
    );
    const v2 = publishHyperSchemaClaims(
      { name: "MovieBasicV2", alg: 1, body: expandRegistry.get("MovieWithCast")!.body },
      "schema:Evolving",
      "did:key:zAlice",
      2000,
    );
    const dset = DeltaSet.from([makeDelta(v1), makeDelta(v2)]);
    const loaded = loadHyperSchema(dset, "schema:Evolving");
    expect(loaded.name).toBe("MovieBasicV2");
    expect(termHash(loaded.body)).toBe(termHash(expandRegistry.get("MovieWithCast")!.body));
  });

  it("deprecation is negation: a negated definition does not load", () => {
    const v1 = makeDelta(
      publishHyperSchemaClaims(
        expandRegistry.get("MovieBasic")!,
        "schema:Dead",
        "did:key:zAlice",
        1000,
      ),
    );
    const negation = makeDelta({
      timestamp: 1100,
      author: "did:key:zAlice",
      pointers: [{ role: "negates", target: { kind: "delta", deltaRef: { delta: v1.id } } }],
    });
    const dset = DeltaSet.from([v1, negation]);
    expect(() => loadHyperSchema(dset, "schema:Dead")).toThrow(/no surviving schema definition/);
  });
});

describe("resolution Schema self-hosting via SCHEMA_SCHEMA (S6, issue #11)", () => {
  it("SCHEMA_SCHEMA is rhizomatic.SchemaSchema and pins the bootstrap hash", () => {
    expect(SCHEMA_SCHEMA.name).toBe(doc.schemaSchema.name);
    expect(SCHEMA_SCHEMA.name).toBe("rhizomatic.SchemaSchema");
    expect(termHash(SCHEMA_SCHEMA.body)).toBe(doc.schemaSchema.termHash);
  });

  it("publish -> load round-trips a named Schema to one content hash", () => {
    const claims = parseClaims(doc.publishedSchema.claims);
    const delta = makeDelta(claims);
    expect(delta.id).toBe(doc.publishedSchema.deltaId);
    const loaded = loadSchema(DeltaSet.from([delta]), doc.publishedSchema.schemaEntity);
    expect(loaded.name).toBe("MovieView");
    expect(loaded.alg).toBe(1);
    expect(schemaCanonicalHex(loaded)).toBe(doc.publishedSchema.expectedSchemaHex);
    // the loaded Schema equals the directly-parsed input (props/default recovered exactly)
    expect(schemaCanonicalHex(loaded)).toBe(
      schemaCanonicalHex(parseSchema(doc.publishedSchema.schemaJson)),
    );
  });

  it("a published Schema must be named", () => {
    const anon = parseSchema({ props: {}, default: { pick: { order: "lexById" } } });
    expect(() => publishSchemaClaims(anon, "schema:x", "did:key:zA", 1)).toThrow(
      /must carry a name/,
    );
  });

  it("a non-canonical schema blob is rejected on load", () => {
    // hand-forge a definition delta whose schema.term hex is a valid but non-canonical CBOR blob
    const bad = makeDelta({
      timestamp: 1,
      author: "did:key:zA",
      pointers: [
        {
          role: "rhizomatic.schema.defines",
          target: { kind: "entity", entity: { id: "schema:bad", context: "definition" } },
        },
        { role: "rhizomatic.schema.name", target: { kind: "primitive", value: "Bad" } },
        { role: "rhizomatic.schema.alg", target: { kind: "primitive", value: 1 } },
        // 0x00 is an integer — outside the profile; decode throws before the canonicality check
        { role: "rhizomatic.schema.term", target: { kind: "primitive", value: "00" } },
      ],
    });
    expect(() => loadSchema(DeltaSet.from([bad]), "schema:bad")).toThrow();
  });
});

describe("pinned schema refs (E13)", () => {
  it("fix through {pinned: hash} equals fix through the name", () => {
    const result = evalTerm(parseTerm(doc.pinnedRef.term), expandSet, undefined, expandRegistry);
    expect(resultCanonicalHex(result)).toBe(doc.pinnedRef.expectedCanonicalHex);
  });

  it("an unknown pinned hash is rejected", () => {
    const term = parseTerm({
      op: "fix",
      schema: { pinned: `1e20${"00".repeat(32)}` },
      entity: "movie:matrix",
    });
    expect(() => evalTerm(term, expandSet, undefined, expandRegistry)).toThrow(/unknown schema/);
  });
});
