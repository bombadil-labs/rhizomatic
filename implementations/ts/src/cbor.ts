// Deterministic CBOR encoder — the Rhizomatic v0 canonicalization profile (RFC 8949 §4.2.1,
// as refined in spec/01-delta.ERRATA.md). Hand-rolled on purpose: this must reproduce the Rust
// encoder byte-for-byte, and the only way to guarantee that is to own every byte.
//
// Supported data items (exactly what the delta model needs): text string, float (numbers),
// bool, definite-length array, definite-length map (text-string keys, sorted).

export type CborValue =
  | { readonly t: "tstr"; readonly v: string }
  | { readonly t: "float"; readonly v: number }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "array"; readonly v: readonly CborValue[] }
  | { readonly t: "map"; readonly v: ReadonlyArray<readonly [string, CborValue]> };

export const tstr = (v: string): CborValue => ({ t: "tstr", v });
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

// ERRATA D1: numbers encode as float only; f32 when it round-trips exactly, else f64.
// (-0.0 normalized to +0.0; float16 reduction deferred to M0.x.)
function writeFloat(sink: ByteSink, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`non-finite number is not representable: ${value}`);
  }
  const n = value + 0; // normalize -0 to +0
  if (Math.fround(n) === n) {
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
