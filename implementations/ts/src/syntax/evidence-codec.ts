// Shared evidence-boundary errors/limits; syntax/algebra compose existing Delta CBOR.
import { type CborValue, decodeWithGuard, encode } from "../delta/cbor.js";
import { bytesToHex } from "../delta/hash.js";

export class EvidenceCodecError extends Error {
  constructor(readonly code: "invalid-evidence" | "resource-limit") {
    super(code);
    this.name = "EvidenceCodecError";
  }
}

export interface ReadingAppearanceLimits {
  readonly artifactBytes: number;
  readonly syntaxDepth: number;
  readonly syntaxNodes: number;
}

export const DEFAULT_READING_APPEARANCE_LIMITS: ReadingAppearanceLimits = Object.freeze({
  artifactBytes: 16_777_216,
  syntaxDepth: 64,
  syntaxNodes: 16_384,
});

export function codecLimit(value: number, maximum: number): void {
  if (value > maximum) throw new EvidenceCodecError("resource-limit");
}

export function codecBoundary<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof EvidenceCodecError) throw error;
    throw new EvidenceCodecError("invalid-evidence");
  }
}

export function codecMap(value: CborValue, keys?: readonly string[]): Map<string, CborValue> {
  if (value.t !== "map") throw new EvidenceCodecError("invalid-evidence");
  const result = new Map<string, CborValue>();
  for (const [key, field] of value.v) {
    if (result.has(key) || (keys !== undefined && !keys.includes(key)))
      throw new EvidenceCodecError("invalid-evidence");
    result.set(key, field);
  }
  return result;
}

export function codecText(value: CborValue | undefined): string {
  if (value?.t !== "tstr") throw new EvidenceCodecError("invalid-evidence");
  return value.v;
}

export function codecBytes(value: CborValue | undefined): Uint8Array {
  if (value?.t !== "bstr") throw new EvidenceCodecError("invalid-evidence");
  return value.v;
}

export function codecLimits<T extends ReadingAppearanceLimits>(
  maximum: T,
  requested: Partial<T>,
): T {
  const result = { ...maximum, ...requested };
  for (const key of Object.keys(requested)) {
    if (!Object.hasOwn(maximum, key)) throw new EvidenceCodecError("invalid-evidence");
  }
  for (const key of Object.keys(maximum) as (keyof T)[]) {
    const value = result[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
      throw new EvidenceCodecError("invalid-evidence");
    codecLimit(value, maximum[key] as number);
  }
  return result;
}

export function canonicalEvidence(
  bytes: Uint8Array,
  maximum: number,
  guard: Parameters<typeof decodeWithGuard>[1] = () => {},
): CborValue {
  codecLimit(bytes.length, maximum);
  const value = decodeWithGuard(bytes, guard);
  if (bytesToHex(encode(value)) !== bytesToHex(bytes))
    throw new EvidenceCodecError("invalid-evidence");
  return value;
}

/** UTF-8 payload size without allocating an encoded copy; text remains byte-honest. */
export function codecTextSize(value: string, maximum: number): number {
  if (typeof value !== "string") throw new EvidenceCodecError("invalid-evidence");
  codecLimit(value.length, maximum);
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x7f) bytes++;
    else if (c <= 0x7ff) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new EvidenceCodecError("invalid-evidence");
      bytes += 4;
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new EvidenceCodecError("invalid-evidence");
    else bytes += 3;
    codecLimit(bytes, maximum);
  }
  return bytes;
}
