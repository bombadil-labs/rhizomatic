// Deterministic CBOR encoder — the Rhizomatic v0 canonicalization profile (RFC 8949 §4.2.1,
// as refined in spec/01-delta.ERRATA.md). Hand-rolled on purpose: this must reproduce the Rust
// encoder byte-for-byte, and the only way to guarantee that is to own every byte.
//
// Supported data items (exactly what the delta model needs): text string, float (numbers),
// bool, definite-length array, definite-length map (text-string keys, sorted).

export type CborValue =
  | { readonly t: "tstr"; readonly v: string }
  | { readonly t: "bstr"; readonly v: Uint8Array }
  | { readonly t: "float"; readonly v: number }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "array"; readonly v: readonly CborValue[] }
  | { readonly t: "map"; readonly v: ReadonlyArray<readonly [string, CborValue]> };

export const tstr = (v: string): CborValue => ({ t: "tstr", v });
// A definite-length byte string (major type 2) — a bytes target's raw payload (ERRATA D12).
export const bstr = (v: Uint8Array): CborValue => ({ t: "bstr", v });
export const float = (v: number): CborValue => ({ t: "float", v });
export const bool = (v: boolean): CborValue => ({ t: "bool", v });
export const array = (v: readonly CborValue[]): CborValue => ({ t: "array", v });
export const map = (v: ReadonlyArray<readonly [string, CborValue]>): CborValue => ({ t: "map", v });

class ByteSink {
  private readonly bytes: number[] = [];
  push(...b: number[]): void {
    for (const x of b) this.bytes.push(x & 0xff);
  }
  pushBytes(arr: Uint8Array): void {
    for (const x of arr) this.bytes.push(x);
  }
  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

// Write a CBOR head: major type (high 3 bits) plus an unsigned argument, shortest form.
function writeHead(sink: ByteSink, major: number, arg: number): void {
  const mt = major << 5;
  if (arg < 24) {
    sink.push(mt | arg);
  } else if (arg < 0x100) {
    sink.push(mt | 24, arg);
  } else if (arg < 0x10000) {
    sink.push(mt | 25, (arg >> 8) & 0xff, arg & 0xff);
  } else if (arg <= 0xffffffff) {
    sink.push(mt | 26, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff);
  } else {
    // Only reachable for absurd lengths; included for totality.
    const hi = Math.floor(arg / 0x100000000);
    const lo = arg >>> 0;
    sink.push(
      mt | 27,
      (hi >>> 24) & 0xff,
      (hi >>> 16) & 0xff,
      (hi >>> 8) & 0xff,
      hi & 0xff,
      (lo >>> 24) & 0xff,
      (lo >>> 16) & 0xff,
      (lo >>> 8) & 0xff,
      lo & 0xff,
    );
  }
}

const fbuf = new DataView(new ArrayBuffer(8));

// Returns the IEEE-754 binary16 bit pattern for n if (and only if) f16 represents n exactly,
// else null. n must be finite and exactly representable as f32 (caller guarantees both).
function tryF16Bits(n: number): number | null {
  fbuf.setFloat32(0, n);
  const bits = fbuf.getUint32(0);
  const sign = ((bits >>> 31) & 1) << 15;
  const exp = (bits >>> 23) & 0xff;
  const mant = bits & 0x7fffff;
  if (exp === 0 && mant === 0) return sign; // zero (-0 already normalized away by caller)
  const e = exp - 127; // unbiased exponent (f32 subnormals land at -127 and fall through)
  if (e >= -14 && e <= 15) {
    // f16 normal range: the 23-bit mantissa must fit in 10 bits.
    if ((mant & 0x1fff) !== 0) return null;
    return sign | ((e + 15) << 10) | (mant >>> 13);
  }
  if (e >= -24 && e <= -15) {
    // f16 subnormal range: value must be an exact multiple of 2^-24.
    const shift = -(e + 1); // 14..23
    const sig = 0x800000 | mant; // full 24-bit significand
    if ((sig & ((1 << shift) - 1)) !== 0) return null;
    return sign | (sig >>> shift);
  }
  return null;
}

// ERRATA D1: numbers encode as float only, in the shortest of f16/f32/f64 that represents the
// value exactly (RFC 8949 §4.2.1). -0.0 is normalized to +0.0.
function writeFloat(sink: ByteSink, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`non-finite number is not representable: ${value}`);
  }
  const n = value + 0; // normalize -0 to +0
  if (Math.fround(n) === n) {
    const h = tryF16Bits(n);
    if (h !== null) {
      sink.push(0xf9, (h >>> 8) & 0xff, h & 0xff);
      return;
    }
    fbuf.setFloat32(0, n);
    sink.push(0xfa, fbuf.getUint8(0), fbuf.getUint8(1), fbuf.getUint8(2), fbuf.getUint8(3));
  } else {
    fbuf.setFloat64(0, n);
    sink.push(
      0xfb,
      fbuf.getUint8(0),
      fbuf.getUint8(1),
      fbuf.getUint8(2),
      fbuf.getUint8(3),
      fbuf.getUint8(4),
      fbuf.getUint8(5),
      fbuf.getUint8(6),
      fbuf.getUint8(7),
    );
  }
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

const utf8 = new TextEncoder();

function encodeInto(sink: ByteSink, val: CborValue): void {
  switch (val.t) {
    case "tstr": {
      const bytes = utf8.encode(val.v.normalize("NFC"));
      writeHead(sink, 3, bytes.length);
      sink.pushBytes(bytes);
      return;
    }
    case "bstr":
      writeHead(sink, 2, val.v.length);
      sink.pushBytes(val.v);
      return;
    case "bool":
      sink.push(val.v ? 0xf5 : 0xf4);
      return;
    case "float":
      writeFloat(sink, val.v);
      return;
    case "array":
      writeHead(sink, 4, val.v.length);
      for (const item of val.v) encodeInto(sink, item);
      return;
    case "map": {
      // ERRATA D4: sort entries by bytewise lex order of the encoded key.
      const entries = val.v.map(([k, v]) => {
        const ks = new ByteSink();
        encodeInto(ks, tstr(k));
        return { key: ks.toUint8Array(), value: v };
      });
      entries.sort((a, b) => cmpBytes(a.key, b.key));
      for (let i = 1; i < entries.length; i++) {
        if (cmpBytes(entries[i - 1]!.key, entries[i]!.key) === 0) {
          throw new Error("duplicate map key in canonical CBOR");
        }
      }
      writeHead(sink, 5, entries.length);
      for (const e of entries) {
        sink.pushBytes(e.key);
        encodeInto(sink, e.value);
      }
      return;
    }
  }
}

export function encode(val: CborValue): Uint8Array {
  const sink = new ByteSink();
  encodeInto(sink, val);
  return sink.toUint8Array();
}

// --- strict decoder for the Rhizomatic profile ----------------------------------------------------
// Accepts exactly the items the profile emits: definite text strings, definite byte strings
// (bytes targets, ERRATA D12), f16/f32/f64 floats, bools, definite arrays, definite maps with text
// keys. Everything else (ints, tags, indefinite lengths, null/undefined) is rejected. Canonicality
// is checked by re-encoding where a caller needs it; this decoder checks structure only.

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

class ByteReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error("cbor: unexpected end of input");
    return this.bytes[this.pos++]!;
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Error("cbor: unexpected end of input");
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  done(): boolean {
    return this.pos === this.bytes.length;
  }
}

function readLength(r: ByteReader, info: number): number {
  if (info < 24) return info;
  if (info === 24) return r.u8();
  if (info === 25) return (r.u8() << 8) | r.u8();
  if (info === 26) return ((r.u8() << 24) | (r.u8() << 16) | (r.u8() << 8) | r.u8()) >>> 0;
  throw new Error(`cbor: unsupported length encoding (info ${info})`);
}

function f16BitsToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const mant = bits & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) throw new Error("cbor: non-finite f16 is not representable");
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

function decodeItem(r: ByteReader): CborValue {
  const head = r.u8();
  const major = head >> 5;
  const info = head & 0x1f;
  switch (major) {
    case 2: {
      const len = readLength(r, info);
      return bstr(r.take(len).slice()); // copy out of the reader's backing buffer
    }
    case 3: {
      const len = readLength(r, info);
      return tstr(utf8Decoder.decode(r.take(len)));
    }
    case 4: {
      const len = readLength(r, info);
      const items: CborValue[] = [];
      for (let i = 0; i < len; i++) items.push(decodeItem(r));
      return array(items);
    }
    case 5: {
      const len = readLength(r, info);
      const entries: Array<[string, CborValue]> = [];
      for (let i = 0; i < len; i++) {
        const key = decodeItem(r);
        if (key.t !== "tstr") throw new Error("cbor: map keys must be text strings");
        entries.push([key.v, decodeItem(r)]);
      }
      return map(entries);
    }
    case 7: {
      if (info === 20) return bool(false);
      if (info === 21) return bool(true);
      if (info === 25) {
        const b = r.take(2);
        return float(f16BitsToNumber((b[0]! << 8) | b[1]!));
      }
      if (info === 26) {
        const b = r.take(4);
        const dv = new DataView(b.buffer, b.byteOffset, 4);
        const n = dv.getFloat32(0);
        if (!Number.isFinite(n)) throw new Error("cbor: non-finite float is not representable");
        return float(n);
      }
      if (info === 27) {
        const b = r.take(8);
        const dv = new DataView(b.buffer, b.byteOffset, 8);
        const n = dv.getFloat64(0);
        if (!Number.isFinite(n)) throw new Error("cbor: non-finite float is not representable");
        return float(n);
      }
      throw new Error(`cbor: unsupported simple/float (info ${info})`);
    }
    default:
      throw new Error(`cbor: major type ${major} is outside the Rhizomatic profile`);
  }
}

export function decode(bytes: Uint8Array): CborValue {
  const r = new ByteReader(bytes);
  const v = decodeItem(r);
  if (!r.done()) throw new Error("cbor: trailing bytes after item");
  return v;
}
