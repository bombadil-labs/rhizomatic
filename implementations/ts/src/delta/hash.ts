import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";

// BLAKE3 multicodec code (https://github.com/multiformats/multicodec). Both it and the 32-byte
// length fit in a single-byte varint, so the multihash prefix is simply [0x1e, 0x20].
const BLAKE3_MULTICODEC = 0x1e;
const DIGEST_LEN = 32;

// The BLAKE3 options have no prototype. The library reads `key` and `context` from them, so a field
// of that name set on `Object.prototype` would turn the hash into a keyed or derived one.
const OPTIONS: { dkLen: number } = Object.freeze(
  Object.assign(Object.create(null) as { dkLen: number }, { dkLen: DIGEST_LEN }),
);

// id = multihash(BLAKE3-256(data)) as lowercase hex (SPEC-1 §4, ERRATA D7).
export function contentAddress(data: Uint8Array): string {
  const digest = blake3(data, OPTIONS);
  const mh = new Uint8Array(2 + digest.length);
  mh[0] = BLAKE3_MULTICODEC;
  mh[1] = digest.length;
  mh.set(digest, 2);
  return bytesToHex(mh);
}

export { bytesToHex };
