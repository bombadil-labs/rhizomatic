// HyperSchemas as deltas (SPEC-3 §5, ERRATA-3 S1-S3): the at-rest, federated form of a
// hyperschema, and the rhizomatic.HyperSchemaSchema bootstrap — the one hand-specified
// hyperschema, through which all others are read.

import { decode } from "./cbor.js";
import type { Term } from "./eval.js";
import { evalTerm } from "./eval.js";
import { hexToBytes } from "@noble/hashes/utils";
import type { Schema } from "./resolution.js";
import type { HyperSchema } from "./schema.js";
import { DeltaSet } from "./set.js";
import { cborToJson, schemaCanonicalHex, termCanonicalHex } from "./term-io.js";
import { parseSchema, parseTerm } from "./term-json.js";
import type { Claims } from "./types.js";
import { VOCAB_PREFIX } from "./vocab.js";

export { VOCAB_PREFIX } from "./vocab.js";

const ROLE_DEFINES = `${VOCAB_PREFIX}.hyperschema.defines`;
const ROLE_NAME = `${VOCAB_PREFIX}.hyperschema.name`;
const ROLE_ALG = `${VOCAB_PREFIX}.hyperschema.alg`;
const ROLE_TERM = `${VOCAB_PREFIX}.hyperschema.term`;

// The bootstrap (S2): the canonical idiom, hand-specified. Everything else is read using it.
export const HYPER_SCHEMA_SCHEMA: HyperSchema = {
  name: `${VOCAB_PREFIX}.HyperSchemaSchema`,
  alg: 1,
  body: parseTerm({
    op: "group",
    key: "byTargetContext",
    in: {
      op: "select",
      pred: { hasPointer: { targetEntity: { var: "root" } } },
      // mask BEFORE select (ERRATA-3 S5): negations target deltas, not the root, so a
      // select-first idiom would exclude them before mask could suppress anything.
      in: { op: "mask", policy: "drop", in: "input" },
    },
  }),
};

// Publish a schema definition as claims (S1). The caller signs/timestamps as any other authorship.
export function publishHyperSchemaClaims(
  schema: HyperSchema,
  schemaEntity: string,
  author: string,
  timestamp: number,
): Claims {
  return {
    timestamp,
    author,
    pointers: [
      {
        role: ROLE_DEFINES,
        target: { kind: "entity", entity: { id: schemaEntity, context: "definition" } },
      },
      { role: ROLE_NAME, target: { kind: "primitive", value: schema.name } },
      { role: ROLE_ALG, target: { kind: "primitive", value: schema.alg } },
      { role: ROLE_TERM, target: { kind: "primitive", value: termCanonicalHex(schema.body) } },
    ],
  };
}

function primitiveOf(claims: Claims, role: string): string | number | undefined {
  for (const p of claims.pointers) {
    if (p.role === role && p.target.kind === "primitive" && typeof p.target.value !== "boolean") {
      return p.target.value;
    }
  }
  return undefined;
}

// Load a schema definition from the rhizome (S3): evaluate the bootstrap at the schema entity,
// take the latest surviving definition (claimed timestamp, lexById tiebreak — a policy choice),
// decode the term, and verify canonicality by re-encoding.
export function loadHyperSchema(dset: DeltaSet, schemaEntity: string): HyperSchema {
  const result = evalTerm(HYPER_SCHEMA_SCHEMA.body, dset, schemaEntity);
  if (result.sort !== "hview") throw new Error("bootstrap body must yield an HView");
  const defs = result.hview.props.get("definition") ?? [];
  if (defs.length === 0) throw new Error(`no surviving schema definition for ${schemaEntity}`);
  const latest = [...defs].sort((a, b) => {
    const dt = b.delta.claims.timestamp - a.delta.claims.timestamp;
    if (dt !== 0) return dt;
    return a.delta.id < b.delta.id ? -1 : 1;
  })[0]!;
  const name = primitiveOf(latest.delta.claims, ROLE_NAME);
  const alg = primitiveOf(latest.delta.claims, ROLE_ALG);
  const termHex = primitiveOf(latest.delta.claims, ROLE_TERM);
  if (typeof name !== "string" || typeof alg !== "number" || typeof termHex !== "string") {
    throw new Error(`malformed schema definition delta ${latest.delta.id}`);
  }
  const bytes = hexToBytes(termHex);
  const term: Term = parseTerm(cborToJson(decode(bytes)));
  // Reject non-canonical blobs: the term must re-encode to exactly the published bytes (S3).
  if (termCanonicalHex(term) !== termHex) {
    throw new Error(`schema definition ${latest.delta.id} carries a non-canonical term blob`);
  }
  return { name, alg, body: term };
}

export function definitionRoles(): { defines: string; name: string; alg: string; term: string } {
  return { defines: ROLE_DEFINES, name: ROLE_NAME, alg: ROLE_ALG, term: ROLE_TERM };
}

// --- resolution Schema self-hosting (SPEC-3 ERRATA S6, issue #11) ----------------------------------

const SCHEMA_DEFINES = `${VOCAB_PREFIX}.schema.defines`;
const SCHEMA_NAME = `${VOCAB_PREFIX}.schema.name`;
const SCHEMA_ALG = `${VOCAB_PREFIX}.schema.alg`;
const SCHEMA_TERM = `${VOCAB_PREFIX}.schema.term`;

// SCHEMA_SCHEMA (rhizomatic.SchemaSchema): the bootstrap through which resolution Schemas are read.
// Mechanical parity — it reuses HYPER_SCHEMA_SCHEMA's generic gather idiom; only the extracted roles
// (schema.* vs hyperschema.*) and the decoded blob (a Schema, not a Term) differ.
export const SCHEMA_SCHEMA: HyperSchema = {
  name: `${VOCAB_PREFIX}.SchemaSchema`,
  alg: 1,
  body: HYPER_SCHEMA_SCHEMA.body,
};

// Publish a resolution Schema as claims (parallel to publishHyperSchemaClaims). A published Schema
// MUST be named (name + alg); the term blob is its content hash over props+default.
export function publishSchemaClaims(
  schema: Schema,
  schemaEntity: string,
  author: string,
  timestamp: number,
): Claims {
  if (schema.name === undefined || schema.alg === undefined) {
    throw new Error("a published Schema must carry a name and alg (SPEC-3 ERRATA S6)");
  }
  return {
    timestamp,
    author,
    pointers: [
      {
        role: SCHEMA_DEFINES,
        target: { kind: "entity", entity: { id: schemaEntity, context: "definition" } },
      },
      { role: SCHEMA_NAME, target: { kind: "primitive", value: schema.name } },
      { role: SCHEMA_ALG, target: { kind: "primitive", value: schema.alg } },
      { role: SCHEMA_TERM, target: { kind: "primitive", value: schemaCanonicalHex(schema) } },
    ],
  };
}

// Load a resolution Schema from the rhizome (parallel to loadHyperSchema): gather via SCHEMA_SCHEMA,
// take the latest surviving definition, decode props+default, reject non-canonical blobs, and
// reattach name/alg from the roles.
export function loadSchema(dset: DeltaSet, schemaEntity: string): Schema {
  const result = evalTerm(SCHEMA_SCHEMA.body, dset, schemaEntity);
  if (result.sort !== "hview") throw new Error("bootstrap body must yield an HView");
  const defs = result.hview.props.get("definition") ?? [];
  if (defs.length === 0) throw new Error(`no surviving schema definition for ${schemaEntity}`);
  const latest = [...defs].sort((a, b) => {
    const dt = b.delta.claims.timestamp - a.delta.claims.timestamp;
    if (dt !== 0) return dt;
    return a.delta.id < b.delta.id ? -1 : 1;
  })[0]!;
  const name = primitiveOf(latest.delta.claims, SCHEMA_NAME);
  const alg = primitiveOf(latest.delta.claims, SCHEMA_ALG);
  const termHex = primitiveOf(latest.delta.claims, SCHEMA_TERM);
  if (typeof name !== "string" || typeof alg !== "number" || typeof termHex !== "string") {
    throw new Error(`malformed schema definition delta ${latest.delta.id}`);
  }
  const body = parseSchema(cborToJson(decode(hexToBytes(termHex))));
  // Reject non-canonical blobs: props+default must re-encode to exactly the published bytes (S3).
  if (schemaCanonicalHex(body) !== termHex) {
    throw new Error(`schema definition ${latest.delta.id} carries a non-canonical schema blob`);
  }
  return { ...body, name, alg };
}
