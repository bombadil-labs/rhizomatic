// Canonical unpadded base64url (RFC 4648 §5) — the JSON-profile transport for a bytes target's
// payload (SPEC-1 §4.2, ERRATA D12). Mirrors ../rust/src/b64u.rs. Identity is computed from the raw
// bytes, never this encoding; encoding is canonical by construction and decoding *validates*
// canonicality (reject, never repair — SPEC-4 §2): no padding, alphabet only, length never ≡ 1
// (mod 4), and a final character's unused low bits MUST be zero.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64uEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]!;
  }
  return out;
}

function sextet(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65; // A-Z
  if (code >= 97 && code <= 122) return code - 97 + 26; // a-z
  if (code >= 48 && code <= 57) return code - 48 + 52; // 0-9
  if (c === "-") return 62;
  if (c === "_") return 63;
  // '=' padding lands here too — deliberately rejected (canonical form is unpadded).
  throw new Error(`base64url: invalid character ${JSON.stringify(c)}`);
}

export function b64uDecode(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error("base64url: invalid length (≡ 1 mod 4)");
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const end = Math.min(i + 4, s.length);
    const len = end - i;
    let acc = 0;
    for (let j = i; j < end; j++) acc = (acc << 6) | sextet(s[j]!);
    if (len === 4) {
      out.push((acc >> 16) & 0xff, (acc >> 8) & 0xff, acc & 0xff);
    } else if (len === 3) {
      // 18 bits carried; the last 2 are spill and MUST be zero.
      if ((acc & 0x3) !== 0) throw new Error("base64url: non-canonical trailing bits");
      const a = acc >> 2;
      out.push((a >> 8) & 0xff, a & 0xff);
    } else {
      // len === 2: 12 bits carried; the last 4 are spill and MUST be zero.
      if ((acc & 0xf) !== 0) throw new Error("base64url: non-canonical trailing bits");
      out.push((acc >> 4) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
