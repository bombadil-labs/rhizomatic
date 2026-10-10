// Shared pure command validation; no host lookup, clock or fallback.
import { type CborValue, encode } from "../delta/cbor.js";
import { bytesToHex } from "../delta/hash.js";
import { canonicalCommandCbor } from "../command-data/codec.js";
import { compareMaterializationText } from "../command-data/materialization-codec.js";
export class MaterializationInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function mFail(code = "invalid-evidence"): never {
  throw new MaterializationInputError(code);
}
export function mLimit(n: number, max: number): void {
  if (n > max) mFail("resource-limit");
}
export function mFields(
  v: CborValue,
  required: readonly string[],
  optional: readonly string[] = [],
): Map<string, CborValue> {
  if (v.t !== "map") return mFail();
  const fs = new Map<string, CborValue>();
  for (const [k, x] of v.v) {
    if (fs.has(k) || ![...required, ...optional].includes(k)) mFail();
    fs.set(k, x);
  }
  if (required.some((k) => !fs.has(k))) mFail();
  return fs;
}
export function mText(x: CborValue | undefined): string {
  return x?.t === "tstr" ? x.v : mFail();
}
export function mId(x: CborValue | undefined): string {
  const s = mText(x);
  return /^1e20[0-9a-f]{64}$/.test(s) ? s : mFail();
}
export function mPeer(x: CborValue | undefined): string {
  const s = mText(x);
  return /^ed25519:[0-9a-f]{64}$/.test(s) ? s : mFail();
}
export function mNumber(x: CborValue | undefined): number {
  return x?.t === "float" && Number.isFinite(x.v) ? x.v : mFail();
}
export function mBytes(x: CborValue | undefined): Uint8Array {
  return x?.t === "bstr" ? x.v : mFail();
}
export function mList(x: CborValue | undefined): readonly CborValue[] {
  return x?.t === "array" ? x.v : mFail();
}
export function mOrdered(xs: readonly string[]): void {
  if (xs.some((x, i) => i > 0 && compareMaterializationText(xs[i - 1]!, x) >= 0)) mFail();
}
export function mEqual(a: CborValue, b: CborValue): boolean {
  return bytesToHex(encode(a)) === bytesToHex(encode(b));
}
export function mCanonical(bytes: Uint8Array, max: number, code = "invalid-evidence"): CborValue {
  mLimit(bytes.length, max);
  try {
    return canonicalCommandCbor(bytes);
  } catch {
    return mFail(code);
  }
}
