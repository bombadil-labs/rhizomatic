// Full reading evidence, separate from the unchanged props/default semantic pin (SPEC-16).
import { type CborValue, bstr, decode, encode, float, map, tstr } from "../delta/cbor.js";
import { bytesToHex } from "../delta/hash.js";
import type { Schema } from "./model.js";
import { checkReadingWireSyntax } from "./reading-wire-budget.js";
import { checkReadingSyntax } from "./reading-budget.js";
import { parseSchema } from "./term-json.js";
import { cborToJson, schemaCanonicalHex } from "./term-io.js";

import {
  EvidenceCodecError,
  DEFAULT_READING_APPEARANCE_LIMITS,
  codecBoundary,
  codecBytes,
  codecLimit,
  codecLimits,
  codecMap,
  codecText,
  canonicalEvidence,
  type ReadingAppearanceLimits,
} from "./evidence-codec.js";
export {
  EvidenceCodecError,
  DEFAULT_READING_APPEARANCE_LIMITS,
  type ReadingAppearanceLimits,
} from "./evidence-codec.js";

function hexBytes(hex: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})*$/.test(hex)) throw new EvidenceCodecError("invalid-evidence");
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

export function encodeReadingAppearance(
  schema: Schema,
  requested: Partial<ReadingAppearanceLimits> = {},
): Uint8Array {
  return codecBoundary(() => {
    const limits = codecLimits(DEFAULT_READING_APPEARANCE_LIMITS, requested);
    checkReadingSyntax(schema, limits);
    if (schema.name !== undefined && typeof schema.name !== "string")
      throw new EvidenceCodecError("invalid-evidence");
    if (schema.alg !== undefined && !Number.isFinite(schema.alg))
      throw new EvidenceCodecError("invalid-evidence");
    const body = hexBytes(schemaCanonicalHex(schema));
    parseSchema(cborToJson(decode(body))); // Existing closed policy grammar.
    const fields: [string, CborValue][] = [["body", bstr(body)]];
    if (schema.name !== undefined) fields.push(["name", tstr(schema.name)]);
    if (schema.alg !== undefined) fields.push(["alg", float(schema.alg)]);
    const bytes = encode(map(fields));
    codecLimit(bytes.length, limits.artifactBytes);
    return bytes;
  });
}

export function decodeReadingAppearance(
  bytes: Uint8Array,
  requested: Partial<ReadingAppearanceLimits> = {},
): Schema {
  return codecBoundary(() => {
    const limits = codecLimits(DEFAULT_READING_APPEARANCE_LIMITS, requested);
    const fields = codecMap(canonicalEvidence(bytes, limits.artifactBytes), [
      "body",
      "name",
      "alg",
    ]);
    const body = codecBytes(fields.get("body"));
    const raw = canonicalEvidence(body, limits.artifactBytes);
    codecMap(raw, ["props", "default"]);
    checkReadingWireSyntax(raw, limits);
    const schema = parseSchema(cborToJson(raw));
    const name = fields.has("name") ? codecText(fields.get("name")) : undefined;
    const alg = fields.get("alg");
    if (alg !== undefined && alg.t !== "float") throw new EvidenceCodecError("invalid-evidence");
    const result = {
      ...schema,
      ...(name === undefined ? {} : { name }),
      ...(alg === undefined ? {} : { alg: alg.v as number }),
    };
    if (bytesToHex(encodeReadingAppearance(result, limits)) !== bytesToHex(bytes))
      throw new EvidenceCodecError("invalid-evidence");
    return result;
  });
}
