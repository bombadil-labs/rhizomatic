// Exact acts selected by SPEC-15 R22; no ambient latest-definition selection.
import { decode } from "../delta/cbor.js";
import { bytesToHex } from "../delta/hash.js";
import { verifyCanonicalDelta } from "../delta/sign.js";
import type { Delta } from "../delta/types.js";
import { VOCAB_PREFIX } from "../delta/vocab.js";
import { cborToJson, schemaCanonicalHex, termCanonicalHex } from "../syntax/term-io.js";
import { parseSchema, parseTerm } from "../syntax/term-json.js";
import type { CommandProgramDefinition } from "../schema/command-program.js";

export function readCommandDefinition(delta: Delta, at: number): CommandProgramDefinition {
  if (
    verifyCanonicalDelta(delta) !== "verified" ||
    !Number.isFinite(at) ||
    delta.claims.validFrom > at ||
    (delta.claims.validUntil !== undefined && at >= delta.claims.validUntil)
  )
    throw new Error("invalid-definition");
  const pointers = delta.claims.pointers;
  const kind = pointers.some((p) => p.role === `${VOCAB_PREFIX}.hyperschema.defines`)
    ? "hyper"
    : "reading";
  const prefix = `${VOCAB_PREFIX}.${kind === "hyper" ? "hyperschema" : "schema"}.`;
  const fields = new Map(pointers.map((p) => [p.role, p.target]));
  if (
    pointers.length !== 4 ||
    fields.size !== 4 ||
    ["defines", "name", "alg", "term"].some((k) => !fields.has(prefix + k))
  )
    throw new Error("invalid-definition");
  const entity = fields.get(prefix + "defines")!,
    name = fields.get(prefix + "name")!,
    alg = fields.get(prefix + "alg")!,
    blob = fields.get(prefix + "term")!;
  if (
    entity.kind !== "entity" ||
    entity.entity.context !== "definition" ||
    name.kind !== "primitive" ||
    typeof name.value !== "string" ||
    alg.kind !== "primitive" ||
    alg.value !== 1 ||
    blob.kind !== "primitive" ||
    typeof blob.value !== "string" ||
    !/^(?:[0-9a-f]{2})+$/.test(blob.value)
  )
    throw new Error("invalid-definition");
  const bytes = Uint8Array.from(blob.value.match(/../g)!.map((h) => Number.parseInt(h, 16)));
  try {
    const json = cborToJson(decode(bytes));
    if (kind === "hyper") {
      const body = parseTerm(json);
      if (termCanonicalHex(body) !== bytesToHex(bytes)) throw new Error();
      return { id: delta.id, kind, hyper: { name: name.value, alg: 1, body } };
    }
    const body = parseSchema(json);
    if (schemaCanonicalHex(body) !== bytesToHex(bytes)) throw new Error();
    return { id: delta.id, kind, reading: { ...body, name: name.value, alg: 1 } };
  } catch {
    throw new Error("invalid-definition");
  }
}
