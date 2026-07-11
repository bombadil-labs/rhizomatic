"use strict";
(() => {
  // src/cbor.ts
  var tstr = (v) => ({ t: "tstr", v });
  var float = (v) => ({ t: "float", v });
  var bool = (v) => ({ t: "bool", v });
  var array = (v) => ({ t: "array", v });
  var map = (v) => ({ t: "map", v });
  var ByteSink = class {
    bytes = [];
    push(...b) {
      for (const x of b) this.bytes.push(x & 255);
    }
    pushBytes(arr) {
      for (const x of arr) this.bytes.push(x);
    }
    toUint8Array() {
      return Uint8Array.from(this.bytes);
    }
  };
  function writeHead(sink, major, arg) {
    const mt = major << 5;
    if (arg < 24) {
      sink.push(mt | arg);
    } else if (arg < 256) {
      sink.push(mt | 24, arg);
    } else if (arg < 65536) {
      sink.push(mt | 25, arg >> 8 & 255, arg & 255);
    } else if (arg <= 4294967295) {
      sink.push(mt | 26, arg >>> 24 & 255, arg >>> 16 & 255, arg >>> 8 & 255, arg & 255);
    } else {
      const hi = Math.floor(arg / 4294967296);
      const lo = arg >>> 0;
      sink.push(
        mt | 27,
        hi >>> 24 & 255,
        hi >>> 16 & 255,
        hi >>> 8 & 255,
        hi & 255,
        lo >>> 24 & 255,
        lo >>> 16 & 255,
        lo >>> 8 & 255,
        lo & 255
      );
    }
  }
  var fbuf = new DataView(new ArrayBuffer(8));
  function tryF16Bits(n) {
    fbuf.setFloat32(0, n);
    const bits = fbuf.getUint32(0);
    const sign = (bits >>> 31 & 1) << 15;
    const exp = bits >>> 23 & 255;
    const mant = bits & 8388607;
    if (exp === 0 && mant === 0) return sign;
    const e = exp - 127;
    if (e >= -14 && e <= 15) {
      if ((mant & 8191) !== 0) return null;
      return sign | e + 15 << 10 | mant >>> 13;
    }
    if (e >= -24 && e <= -15) {
      const shift = -(e + 1);
      const sig = 8388608 | mant;
      if ((sig & (1 << shift) - 1) !== 0) return null;
      return sign | sig >>> shift;
    }
    return null;
  }
  function writeFloat(sink, value) {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite number is not representable: ${value}`);
    }
    const n = value + 0;
    if (Math.fround(n) === n) {
      const h = tryF16Bits(n);
      if (h !== null) {
        sink.push(249, h >>> 8 & 255, h & 255);
        return;
      }
      fbuf.setFloat32(0, n);
      sink.push(250, fbuf.getUint8(0), fbuf.getUint8(1), fbuf.getUint8(2), fbuf.getUint8(3));
    } else {
      fbuf.setFloat64(0, n);
      sink.push(
        251,
        fbuf.getUint8(0),
        fbuf.getUint8(1),
        fbuf.getUint8(2),
        fbuf.getUint8(3),
        fbuf.getUint8(4),
        fbuf.getUint8(5),
        fbuf.getUint8(6),
        fbuf.getUint8(7)
      );
    }
  }
  function cmpBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = a[i] - b[i];
      if (d !== 0) return d;
    }
    return a.length - b.length;
  }
  var utf8 = new TextEncoder();
  function encodeInto(sink, val) {
    switch (val.t) {
      case "tstr": {
        const bytes = utf8.encode(val.v.normalize("NFC"));
        writeHead(sink, 3, bytes.length);
        sink.pushBytes(bytes);
        return;
      }
      case "bool":
        sink.push(val.v ? 245 : 244);
        return;
      case "float":
        writeFloat(sink, val.v);
        return;
      case "array":
        writeHead(sink, 4, val.v.length);
        for (const item of val.v) encodeInto(sink, item);
        return;
      case "map": {
        const entries = val.v.map(([k, v]) => {
          const ks = new ByteSink();
          encodeInto(ks, tstr(k));
          return { key: ks.toUint8Array(), value: v };
        });
        entries.sort((a, b) => cmpBytes(a.key, b.key));
        for (let i = 1; i < entries.length; i++) {
          if (cmpBytes(entries[i - 1].key, entries[i].key) === 0) {
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
  function encode(val) {
    const sink = new ByteSink();
    encodeInto(sink, val);
    return sink.toUint8Array();
  }
  var utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  var ByteReader = class {
    constructor(bytes) {
      this.bytes = bytes;
    }
    bytes;
    pos = 0;
    u8() {
      if (this.pos >= this.bytes.length) throw new Error("cbor: unexpected end of input");
      return this.bytes[this.pos++];
    }
    take(n) {
      if (this.pos + n > this.bytes.length) throw new Error("cbor: unexpected end of input");
      const out = this.bytes.subarray(this.pos, this.pos + n);
      this.pos += n;
      return out;
    }
    done() {
      return this.pos === this.bytes.length;
    }
  };
  function readLength(r, info) {
    if (info < 24) return info;
    if (info === 24) return r.u8();
    if (info === 25) return r.u8() << 8 | r.u8();
    if (info === 26) return (r.u8() << 24 | r.u8() << 16 | r.u8() << 8 | r.u8()) >>> 0;
    throw new Error(`cbor: unsupported length encoding (info ${info})`);
  }
  function f16BitsToNumber(bits) {
    const sign = bits & 32768 ? -1 : 1;
    const exp = bits >> 10 & 31;
    const mant = bits & 1023;
    if (exp === 0) return sign * mant * 2 ** -24;
    if (exp === 31) throw new Error("cbor: non-finite f16 is not representable");
    return sign * (1 + mant / 1024) * 2 ** (exp - 15);
  }
  function decodeItem(r) {
    const head = r.u8();
    const major = head >> 5;
    const info = head & 31;
    switch (major) {
      case 3: {
        const len = readLength(r, info);
        return tstr(utf8Decoder.decode(r.take(len)));
      }
      case 4: {
        const len = readLength(r, info);
        const items = [];
        for (let i = 0; i < len; i++) items.push(decodeItem(r));
        return array(items);
      }
      case 5: {
        const len = readLength(r, info);
        const entries = [];
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
          return float(f16BitsToNumber(b[0] << 8 | b[1]));
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
  function decode(bytes) {
    const r = new ByteReader(bytes);
    const v = decodeItem(r);
    if (!r.done()) throw new Error("cbor: trailing bytes after item");
    return v;
  }

  // node_modules/@noble/hashes/esm/crypto.js
  var crypto = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

  // node_modules/@noble/hashes/esm/utils.js
  function isBytes(a) {
    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
  }
  function anumber(n) {
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error("positive integer expected, got " + n);
  }
  function abytes(b, ...lengths) {
    if (!isBytes(b))
      throw new Error("Uint8Array expected");
    if (lengths.length > 0 && !lengths.includes(b.length))
      throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
  }
  function aexists(instance, checkFinished = true) {
    if (instance.destroyed)
      throw new Error("Hash instance has been destroyed");
    if (checkFinished && instance.finished)
      throw new Error("Hash#digest() has already been called");
  }
  function aoutput(out, instance) {
    abytes(out);
    const min = instance.outputLen;
    if (out.length < min) {
      throw new Error("digestInto() expects output buffer of length at least " + min);
    }
  }
  function u8(arr) {
    return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  }
  function u32(arr) {
    return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
  }
  function clean(...arrays) {
    for (let i = 0; i < arrays.length; i++) {
      arrays[i].fill(0);
    }
  }
  function createView(arr) {
    return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  }
  function rotr(word, shift) {
    return word << 32 - shift | word >>> shift;
  }
  var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
  function byteSwap(word) {
    return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
  }
  var swap8IfBE = isLE ? (n) => n : (n) => byteSwap(n);
  function byteSwap32(arr) {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = byteSwap(arr[i]);
    }
    return arr;
  }
  var swap32IfBE = isLE ? (u) => u : byteSwap32;
  var hasHexBuiltin = /* @__PURE__ */ (() => (
    // @ts-ignore
    typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
  ))();
  var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
  function bytesToHex(bytes) {
    abytes(bytes);
    if (hasHexBuiltin)
      return bytes.toHex();
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += hexes[bytes[i]];
    }
    return hex;
  }
  var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
  function asciiToBase16(ch) {
    if (ch >= asciis._0 && ch <= asciis._9)
      return ch - asciis._0;
    if (ch >= asciis.A && ch <= asciis.F)
      return ch - (asciis.A - 10);
    if (ch >= asciis.a && ch <= asciis.f)
      return ch - (asciis.a - 10);
    return;
  }
  function hexToBytes(hex) {
    if (typeof hex !== "string")
      throw new Error("hex string expected, got " + typeof hex);
    if (hasHexBuiltin)
      return Uint8Array.fromHex(hex);
    const hl = hex.length;
    const al = hl / 2;
    if (hl % 2)
      throw new Error("hex string expected, got unpadded hex of length " + hl);
    const array2 = new Uint8Array(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
      const n1 = asciiToBase16(hex.charCodeAt(hi));
      const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
      if (n1 === void 0 || n2 === void 0) {
        const char = hex[hi] + hex[hi + 1];
        throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
      }
      array2[ai] = n1 * 16 + n2;
    }
    return array2;
  }
  function utf8ToBytes(str) {
    if (typeof str !== "string")
      throw new Error("string expected");
    return new Uint8Array(new TextEncoder().encode(str));
  }
  function toBytes(data) {
    if (typeof data === "string")
      data = utf8ToBytes(data);
    abytes(data);
    return data;
  }
  function concatBytes(...arrays) {
    let sum = 0;
    for (let i = 0; i < arrays.length; i++) {
      const a = arrays[i];
      abytes(a);
      sum += a.length;
    }
    const res = new Uint8Array(sum);
    for (let i = 0, pad = 0; i < arrays.length; i++) {
      const a = arrays[i];
      res.set(a, pad);
      pad += a.length;
    }
    return res;
  }
  var Hash = class {
  };
  function createHasher(hashCons) {
    const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
    const tmp = hashCons();
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = () => hashCons();
    return hashC;
  }
  function createXOFer(hashCons) {
    const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
    const tmp = hashCons({});
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = (opts) => hashCons(opts);
    return hashC;
  }
  function randomBytes(bytesLength = 32) {
    if (crypto && typeof crypto.getRandomValues === "function") {
      return crypto.getRandomValues(new Uint8Array(bytesLength));
    }
    if (crypto && typeof crypto.randomBytes === "function") {
      return Uint8Array.from(crypto.randomBytes(bytesLength));
    }
    throw new Error("crypto.getRandomValues must be defined");
  }

  // node_modules/@noble/hashes/esm/_md.js
  function setBigUint64(view, byteOffset, value, isLE2) {
    if (typeof view.setBigUint64 === "function")
      return view.setBigUint64(byteOffset, value, isLE2);
    const _32n2 = BigInt(32);
    const _u32_max = BigInt(4294967295);
    const wh = Number(value >> _32n2 & _u32_max);
    const wl = Number(value & _u32_max);
    const h = isLE2 ? 4 : 0;
    const l = isLE2 ? 0 : 4;
    view.setUint32(byteOffset + h, wh, isLE2);
    view.setUint32(byteOffset + l, wl, isLE2);
  }
  var HashMD = class extends Hash {
    constructor(blockLen, outputLen, padOffset, isLE2) {
      super();
      this.finished = false;
      this.length = 0;
      this.pos = 0;
      this.destroyed = false;
      this.blockLen = blockLen;
      this.outputLen = outputLen;
      this.padOffset = padOffset;
      this.isLE = isLE2;
      this.buffer = new Uint8Array(blockLen);
      this.view = createView(this.buffer);
    }
    update(data) {
      aexists(this);
      data = toBytes(data);
      abytes(data);
      const { view, buffer, blockLen } = this;
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        if (take === blockLen) {
          const dataView = createView(data);
          for (; blockLen <= len - pos; pos += blockLen)
            this.process(dataView, pos);
          continue;
        }
        buffer.set(data.subarray(pos, pos + take), this.pos);
        this.pos += take;
        pos += take;
        if (this.pos === blockLen) {
          this.process(view, 0);
          this.pos = 0;
        }
      }
      this.length += data.length;
      this.roundClean();
      return this;
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      this.finished = true;
      const { buffer, view, blockLen, isLE: isLE2 } = this;
      let { pos } = this;
      buffer[pos++] = 128;
      clean(this.buffer.subarray(pos));
      if (this.padOffset > blockLen - pos) {
        this.process(view, 0);
        pos = 0;
      }
      for (let i = pos; i < blockLen; i++)
        buffer[i] = 0;
      setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE2);
      this.process(view, 0);
      const oview = createView(out);
      const len = this.outputLen;
      if (len % 4)
        throw new Error("_sha2: outputLen should be aligned to 32bit");
      const outLen = len / 4;
      const state = this.get();
      if (outLen > state.length)
        throw new Error("_sha2: outputLen bigger than state");
      for (let i = 0; i < outLen; i++)
        oview.setUint32(4 * i, state[i], isLE2);
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
    _cloneInto(to) {
      to || (to = new this.constructor());
      to.set(...this.get());
      const { blockLen, buffer, length, finished, destroyed, pos } = this;
      to.destroyed = destroyed;
      to.finished = finished;
      to.length = length;
      to.pos = pos;
      if (length % blockLen)
        to.buffer.set(buffer);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
  };
  var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    4089235720,
    3144134277,
    2227873595,
    1013904242,
    4271175723,
    2773480762,
    1595750129,
    1359893119,
    2917565137,
    2600822924,
    725511199,
    528734635,
    4215389547,
    1541459225,
    327033209
  ]);

  // node_modules/@noble/hashes/esm/_u64.js
  var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
  var _32n = /* @__PURE__ */ BigInt(32);
  function fromBig(n, le = false) {
    if (le)
      return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
    return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
  }
  function split(lst, le = false) {
    const len = lst.length;
    let Ah = new Uint32Array(len);
    let Al = new Uint32Array(len);
    for (let i = 0; i < len; i++) {
      const { h, l } = fromBig(lst[i], le);
      [Ah[i], Al[i]] = [h, l];
    }
    return [Ah, Al];
  }
  var shrSH = (h, _l, s) => h >>> s;
  var shrSL = (h, l, s) => h << 32 - s | l >>> s;
  var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
  var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
  var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
  var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
  function add(Ah, Al, Bh, Bl) {
    const l = (Al >>> 0) + (Bl >>> 0);
    return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
  }
  var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
  var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
  var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
  var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
  var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
  var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

  // node_modules/@noble/hashes/esm/_blake.js
  function G1s(a, b, c, d, x) {
    a = a + b + x | 0;
    d = rotr(d ^ a, 16);
    c = c + d | 0;
    b = rotr(b ^ c, 12);
    return { a, b, c, d };
  }
  function G2s(a, b, c, d, x) {
    a = a + b + x | 0;
    d = rotr(d ^ a, 8);
    c = c + d | 0;
    b = rotr(b ^ c, 7);
    return { a, b, c, d };
  }

  // node_modules/@noble/hashes/esm/blake2.js
  var BLAKE2 = class extends Hash {
    constructor(blockLen, outputLen) {
      super();
      this.finished = false;
      this.destroyed = false;
      this.length = 0;
      this.pos = 0;
      anumber(blockLen);
      anumber(outputLen);
      this.blockLen = blockLen;
      this.outputLen = outputLen;
      this.buffer = new Uint8Array(blockLen);
      this.buffer32 = u32(this.buffer);
    }
    update(data) {
      aexists(this);
      data = toBytes(data);
      abytes(data);
      const { blockLen, buffer, buffer32 } = this;
      const len = data.length;
      const offset = data.byteOffset;
      const buf = data.buffer;
      for (let pos = 0; pos < len; ) {
        if (this.pos === blockLen) {
          swap32IfBE(buffer32);
          this.compress(buffer32, 0, false);
          swap32IfBE(buffer32);
          this.pos = 0;
        }
        const take = Math.min(blockLen - this.pos, len - pos);
        const dataOffset = offset + pos;
        if (take === blockLen && !(dataOffset % 4) && pos + take < len) {
          const data32 = new Uint32Array(buf, dataOffset, Math.floor((len - pos) / 4));
          swap32IfBE(data32);
          for (let pos32 = 0; pos + blockLen < len; pos32 += buffer32.length, pos += blockLen) {
            this.length += blockLen;
            this.compress(data32, pos32, false);
          }
          swap32IfBE(data32);
          continue;
        }
        buffer.set(data.subarray(pos, pos + take), this.pos);
        this.pos += take;
        this.length += take;
        pos += take;
      }
      return this;
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      const { pos, buffer32 } = this;
      this.finished = true;
      clean(this.buffer.subarray(pos));
      swap32IfBE(buffer32);
      this.compress(buffer32, 0, true);
      swap32IfBE(buffer32);
      const out32 = u32(out);
      this.get().forEach((v, i) => out32[i] = swap8IfBE(v));
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
    _cloneInto(to) {
      const { buffer, length, finished, destroyed, outputLen, pos } = this;
      to || (to = new this.constructor({ dkLen: outputLen }));
      to.set(...this.get());
      to.buffer.set(buffer);
      to.destroyed = destroyed;
      to.finished = finished;
      to.length = length;
      to.pos = pos;
      to.outputLen = outputLen;
      return to;
    }
    clone() {
      return this._cloneInto();
    }
  };
  function compress(s, offset, msg, rounds, v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15) {
    let j = 0;
    for (let i = 0; i < rounds; i++) {
      ({ a: v0, b: v4, c: v8, d: v12 } = G1s(v0, v4, v8, v12, msg[offset + s[j++]]));
      ({ a: v0, b: v4, c: v8, d: v12 } = G2s(v0, v4, v8, v12, msg[offset + s[j++]]));
      ({ a: v1, b: v5, c: v9, d: v13 } = G1s(v1, v5, v9, v13, msg[offset + s[j++]]));
      ({ a: v1, b: v5, c: v9, d: v13 } = G2s(v1, v5, v9, v13, msg[offset + s[j++]]));
      ({ a: v2, b: v6, c: v10, d: v14 } = G1s(v2, v6, v10, v14, msg[offset + s[j++]]));
      ({ a: v2, b: v6, c: v10, d: v14 } = G2s(v2, v6, v10, v14, msg[offset + s[j++]]));
      ({ a: v3, b: v7, c: v11, d: v15 } = G1s(v3, v7, v11, v15, msg[offset + s[j++]]));
      ({ a: v3, b: v7, c: v11, d: v15 } = G2s(v3, v7, v11, v15, msg[offset + s[j++]]));
      ({ a: v0, b: v5, c: v10, d: v15 } = G1s(v0, v5, v10, v15, msg[offset + s[j++]]));
      ({ a: v0, b: v5, c: v10, d: v15 } = G2s(v0, v5, v10, v15, msg[offset + s[j++]]));
      ({ a: v1, b: v6, c: v11, d: v12 } = G1s(v1, v6, v11, v12, msg[offset + s[j++]]));
      ({ a: v1, b: v6, c: v11, d: v12 } = G2s(v1, v6, v11, v12, msg[offset + s[j++]]));
      ({ a: v2, b: v7, c: v8, d: v13 } = G1s(v2, v7, v8, v13, msg[offset + s[j++]]));
      ({ a: v2, b: v7, c: v8, d: v13 } = G2s(v2, v7, v8, v13, msg[offset + s[j++]]));
      ({ a: v3, b: v4, c: v9, d: v14 } = G1s(v3, v4, v9, v14, msg[offset + s[j++]]));
      ({ a: v3, b: v4, c: v9, d: v14 } = G2s(v3, v4, v9, v14, msg[offset + s[j++]]));
    }
    return { v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15 };
  }

  // node_modules/@noble/hashes/esm/blake3.js
  var B3_Flags = {
    CHUNK_START: 1,
    CHUNK_END: 2,
    PARENT: 4,
    ROOT: 8,
    KEYED_HASH: 16,
    DERIVE_KEY_CONTEXT: 32,
    DERIVE_KEY_MATERIAL: 64
  };
  var B3_IV = SHA256_IV.slice();
  var B3_SIGMA = /* @__PURE__ */ (() => {
    const Id = Array.from({ length: 16 }, (_, i) => i);
    const permute = (arr) => [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8].map((i) => arr[i]);
    const res = [];
    for (let i = 0, v = Id; i < 7; i++, v = permute(v))
      res.push(...v);
    return Uint8Array.from(res);
  })();
  var BLAKE3 = class _BLAKE3 extends BLAKE2 {
    constructor(opts = {}, flags = 0) {
      super(64, opts.dkLen === void 0 ? 32 : opts.dkLen);
      this.chunkPos = 0;
      this.chunksDone = 0;
      this.flags = 0 | 0;
      this.stack = [];
      this.posOut = 0;
      this.bufferOut32 = new Uint32Array(16);
      this.chunkOut = 0;
      this.enableXOF = true;
      const { key, context } = opts;
      const hasContext = context !== void 0;
      if (key !== void 0) {
        if (hasContext)
          throw new Error('Only "key" or "context" can be specified at same time');
        const k = toBytes(key).slice();
        abytes(k, 32);
        this.IV = u32(k);
        swap32IfBE(this.IV);
        this.flags = flags | B3_Flags.KEYED_HASH;
      } else if (hasContext) {
        const ctx = toBytes(context);
        const contextKey = new _BLAKE3({ dkLen: 32 }, B3_Flags.DERIVE_KEY_CONTEXT).update(ctx).digest();
        this.IV = u32(contextKey);
        swap32IfBE(this.IV);
        this.flags = flags | B3_Flags.DERIVE_KEY_MATERIAL;
      } else {
        this.IV = B3_IV.slice();
        this.flags = flags;
      }
      this.state = this.IV.slice();
      this.bufferOut = u8(this.bufferOut32);
    }
    // Unused
    get() {
      return [];
    }
    set() {
    }
    b2Compress(counter, flags, buf, bufPos = 0) {
      const { state: s, pos } = this;
      const { h, l } = fromBig(BigInt(counter), true);
      const { v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15 } = compress(B3_SIGMA, bufPos, buf, 7, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], B3_IV[0], B3_IV[1], B3_IV[2], B3_IV[3], h, l, pos, flags);
      s[0] = v0 ^ v8;
      s[1] = v1 ^ v9;
      s[2] = v2 ^ v10;
      s[3] = v3 ^ v11;
      s[4] = v4 ^ v12;
      s[5] = v5 ^ v13;
      s[6] = v6 ^ v14;
      s[7] = v7 ^ v15;
    }
    compress(buf, bufPos = 0, isLast = false) {
      let flags = this.flags;
      if (!this.chunkPos)
        flags |= B3_Flags.CHUNK_START;
      if (this.chunkPos === 15 || isLast)
        flags |= B3_Flags.CHUNK_END;
      if (!isLast)
        this.pos = this.blockLen;
      this.b2Compress(this.chunksDone, flags, buf, bufPos);
      this.chunkPos += 1;
      if (this.chunkPos === 16 || isLast) {
        let chunk = this.state;
        this.state = this.IV.slice();
        for (let last, chunks = this.chunksDone + 1; isLast || !(chunks & 1); chunks >>= 1) {
          if (!(last = this.stack.pop()))
            break;
          this.buffer32.set(last, 0);
          this.buffer32.set(chunk, 8);
          this.pos = this.blockLen;
          this.b2Compress(0, this.flags | B3_Flags.PARENT, this.buffer32, 0);
          chunk = this.state;
          this.state = this.IV.slice();
        }
        this.chunksDone++;
        this.chunkPos = 0;
        this.stack.push(chunk);
      }
      this.pos = 0;
    }
    _cloneInto(to) {
      to = super._cloneInto(to);
      const { IV, flags, state, chunkPos, posOut, chunkOut, stack, chunksDone } = this;
      to.state.set(state.slice());
      to.stack = stack.map((i) => Uint32Array.from(i));
      to.IV.set(IV);
      to.flags = flags;
      to.chunkPos = chunkPos;
      to.chunksDone = chunksDone;
      to.posOut = posOut;
      to.chunkOut = chunkOut;
      to.enableXOF = this.enableXOF;
      to.bufferOut32.set(this.bufferOut32);
      return to;
    }
    destroy() {
      this.destroyed = true;
      clean(this.state, this.buffer32, this.IV, this.bufferOut32);
      clean(...this.stack);
    }
    // Same as b2Compress, but doesn't modify state and returns 16 u32 array (instead of 8)
    b2CompressOut() {
      const { state: s, pos, flags, buffer32, bufferOut32: out32 } = this;
      const { h, l } = fromBig(BigInt(this.chunkOut++));
      swap32IfBE(buffer32);
      const { v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15 } = compress(B3_SIGMA, 0, buffer32, 7, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], B3_IV[0], B3_IV[1], B3_IV[2], B3_IV[3], l, h, pos, flags);
      out32[0] = v0 ^ v8;
      out32[1] = v1 ^ v9;
      out32[2] = v2 ^ v10;
      out32[3] = v3 ^ v11;
      out32[4] = v4 ^ v12;
      out32[5] = v5 ^ v13;
      out32[6] = v6 ^ v14;
      out32[7] = v7 ^ v15;
      out32[8] = s[0] ^ v8;
      out32[9] = s[1] ^ v9;
      out32[10] = s[2] ^ v10;
      out32[11] = s[3] ^ v11;
      out32[12] = s[4] ^ v12;
      out32[13] = s[5] ^ v13;
      out32[14] = s[6] ^ v14;
      out32[15] = s[7] ^ v15;
      swap32IfBE(buffer32);
      swap32IfBE(out32);
      this.posOut = 0;
    }
    finish() {
      if (this.finished)
        return;
      this.finished = true;
      clean(this.buffer.subarray(this.pos));
      let flags = this.flags | B3_Flags.ROOT;
      if (this.stack.length) {
        flags |= B3_Flags.PARENT;
        swap32IfBE(this.buffer32);
        this.compress(this.buffer32, 0, true);
        swap32IfBE(this.buffer32);
        this.chunksDone = 0;
        this.pos = this.blockLen;
      } else {
        flags |= (!this.chunkPos ? B3_Flags.CHUNK_START : 0) | B3_Flags.CHUNK_END;
      }
      this.flags = flags;
      this.b2CompressOut();
    }
    writeInto(out) {
      aexists(this, false);
      abytes(out);
      this.finish();
      const { blockLen, bufferOut } = this;
      for (let pos = 0, len = out.length; pos < len; ) {
        if (this.posOut >= blockLen)
          this.b2CompressOut();
        const take = Math.min(blockLen - this.posOut, len - pos);
        out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
        this.posOut += take;
        pos += take;
      }
      return out;
    }
    xofInto(out) {
      if (!this.enableXOF)
        throw new Error("XOF is not possible after digest call");
      return this.writeInto(out);
    }
    xof(bytes) {
      anumber(bytes);
      return this.xofInto(new Uint8Array(bytes));
    }
    digestInto(out) {
      aoutput(out, this);
      if (this.finished)
        throw new Error("digest() was already called");
      this.enableXOF = false;
      this.writeInto(out);
      this.destroy();
      return out;
    }
    digest() {
      return this.digestInto(new Uint8Array(this.outputLen));
    }
  };
  var blake3 = /* @__PURE__ */ createXOFer((opts) => new BLAKE3(opts));

  // src/hash.ts
  var BLAKE3_MULTICODEC = 30;
  var DIGEST_LEN = 32;
  function contentAddress(data) {
    const digest = blake3(data, { dkLen: DIGEST_LEN });
    const mh = new Uint8Array(2 + digest.length);
    mh[0] = BLAKE3_MULTICODEC;
    mh[1] = digest.length;
    mh.set(digest, 2);
    return bytesToHex(mh);
  }

  // src/delta.ts
  function targetToCbor(t) {
    switch (t.kind) {
      case "primitive": {
        const v = t.value;
        if (typeof v === "string") return tstr(v);
        if (typeof v === "boolean") return bool(v);
        return float(v);
      }
      case "entity": {
        const entries = [["id", tstr(t.entity.id)]];
        if (t.entity.context !== void 0) entries.push(["context", tstr(t.entity.context)]);
        return map(entries);
      }
      case "delta": {
        const entries = [["delta", tstr(t.deltaRef.delta)]];
        if (t.deltaRef.context !== void 0) entries.push(["context", tstr(t.deltaRef.context)]);
        return map(entries);
      }
    }
  }
  function pointerToCbor(p) {
    return map([
      ["role", tstr(p.role)],
      ["target", targetToCbor(p.target)]
    ]);
  }
  function claimsToCbor(claims) {
    return map([
      ["author", tstr(claims.author)],
      ["pointers", array(claims.pointers.map(pointerToCbor))],
      ["timestamp", float(claims.timestamp)]
    ]);
  }
  function assertNfc(s, what) {
    if (s.normalize("NFC") !== s) {
      throw new Error(`${what} must be NFC-normalized (ERRATA D11): ${JSON.stringify(s)}`);
    }
  }
  function assertValidClaims(claims) {
    if (typeof claims.author !== "string") throw new Error("author must be a string");
    if (claims.author.length === 0) throw new Error("author must be non-empty");
    assertNfc(claims.author, "author");
    if (!Number.isFinite(claims.timestamp)) throw new Error("timestamp must be finite");
    if (claims.pointers.length < 1) throw new Error("a delta MUST contain at least one pointer");
    for (const p of claims.pointers) {
      if (typeof p.role !== "string") throw new Error("role must be a string");
      if (p.role.length === 0) throw new Error("role must be non-empty");
      assertNfc(p.role, "role");
      if (p.target.kind === "primitive") {
        const v = p.target.value;
        const t = typeof v;
        if (t !== "string" && t !== "number" && t !== "boolean") {
          throw new Error(
            `primitive value must be string, number, or boolean; got ${v === null ? "null" : t}`
          );
        }
        if (typeof v === "number" && !Number.isFinite(v)) {
          throw new Error("numeric primitive must be finite");
        }
        if (typeof v === "string") assertNfc(v, "string primitive");
      }
      if (p.target.kind === "entity") assertNfc(p.target.entity.id, "entity id");
      if (p.target.kind === "delta") assertNfc(p.target.deltaRef.delta, "delta ref");
      const ctx = p.target.kind === "entity" ? p.target.entity.context : p.target.kind === "delta" ? p.target.deltaRef.context : void 0;
      if (ctx !== void 0) {
        if (typeof ctx !== "string") throw new Error("context, when present, must be a string");
        if (ctx.length === 0) throw new Error("context, when present, must be non-empty");
        assertNfc(ctx, "context");
      }
    }
  }
  function canonicalBytes(claims) {
    assertValidClaims(claims);
    return encode(claimsToCbor(claims));
  }
  function canonicalHex(claims) {
    return bytesToHex(canonicalBytes(claims));
  }
  function computeId(claims) {
    return contentAddress(canonicalBytes(claims));
  }

  // src/hview.ts
  function targetToCborWithExpansion(t, expansion) {
    if (expansion !== void 0) return hviewToCbor(expansion);
    switch (t.kind) {
      case "primitive": {
        const v = t.value;
        if (typeof v === "string") return tstr(v);
        if (typeof v === "boolean") return bool(v);
        return float(v);
      }
      case "entity": {
        const entries = [["id", tstr(t.entity.id)]];
        if (t.entity.context !== void 0) entries.push(["context", tstr(t.entity.context)]);
        return map(entries);
      }
      case "delta": {
        const entries = [["delta", tstr(t.deltaRef.delta)]];
        if (t.deltaRef.context !== void 0) entries.push(["context", tstr(t.deltaRef.context)]);
        return map(entries);
      }
    }
  }
  function claimsToCborWithExpansions(claims, expanded) {
    return map([
      ["author", tstr(claims.author)],
      [
        "pointers",
        array(
          claims.pointers.map(
            (p, i) => map([
              ["role", tstr(p.role)],
              ["target", targetToCborWithExpansion(p.target, expanded?.get(i))]
            ])
          )
        )
      ],
      ["timestamp", float(claims.timestamp)]
    ]);
  }
  function hvEntryToCbor(e) {
    const entries = [
      ["id", tstr(e.delta.id)],
      ["claims", claimsToCborWithExpansions(e.delta.claims, e.expanded)]
    ];
    if (e.delta.sig !== void 0) entries.push(["sig", tstr(e.delta.sig)]);
    if (e.negated) entries.push(["negated", bool(true)]);
    return map(entries);
  }
  function hviewToCbor(h) {
    const props = [...h.props.entries()].map(([prop, entries]) => [
      prop,
      array(entries.map(hvEntryToCbor))
    ]);
    return map([
      ["id", tstr(h.id)],
      ["props", map(props)]
    ]);
  }
  function hviewCanonicalHex(h) {
    return bytesToHex(encode(hviewToCbor(h)));
  }

  // src/pred.ts
  function resolveParam(p, bindings) {
    if (typeof p !== "object") return p;
    const bound = bindings?.get(p.name);
    if (bound === void 0) throw new Error(`unbound hole "${p.name}" (E15)`);
    return bound;
  }
  function predContainsInView(pred) {
    switch (pred.kind) {
      case "inView":
        return true;
      case "and":
      case "or":
        return predContainsInView(pred.left) || predContainsInView(pred.right);
      case "not":
        return predContainsInView(pred.pred);
      default:
        return false;
    }
  }
  var utf82 = new TextEncoder();
  function utf8Compare(a, b) {
    const ab = utf82.encode(a);
    const bb = utf82.encode(b);
    const n = Math.min(ab.length, bb.length);
    for (let i = 0; i < n; i++) {
      const d = ab[i] - bb[i];
      if (d !== 0) return d;
    }
    return ab.length - bb.length;
  }
  function typeRank(v) {
    if (typeof v === "boolean") return 0;
    if (typeof v === "number") return 1;
    return 2;
  }
  function comparePrimitives(a, b) {
    const ra = typeRank(a);
    const rb = typeRank(b);
    if (ra !== rb) return ra - rb;
    if (typeof a === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
    if (typeof a === "number") {
      const bn = b;
      return a < bn ? -1 : a > bn ? 1 : 0;
    }
    return utf8Compare(a, b);
  }
  function compareWith(cmp, subject, constant) {
    if (cmp === "inSet") {
      const values = constant;
      return values.some((v) => comparePrimitives(subject, v) === 0);
    }
    if (cmp === "prefix") {
      return typeof subject === "string" && typeof constant === "string" && subject.startsWith(constant);
    }
    const c = comparePrimitives(subject, constant);
    switch (cmp) {
      case "eq":
        return c === 0;
      case "neq":
        return c !== 0;
      case "lt":
        return c < 0;
      case "lte":
        return c <= 0;
      case "gt":
        return c > 0;
      case "gte":
        return c >= 0;
    }
  }
  function strMatch(m, s) {
    switch (m.kind) {
      case "exact":
        return s === m.value;
      case "prefix":
        return s.startsWith(m.value);
      case "inSet":
        return m.values.includes(s);
      case "aliased":
        throw new Error(`aliased("${m.name}") must be expanded before matching (SPEC-9)`);
    }
  }
  function valMatch(m, v, bindings) {
    switch (m.kind) {
      case "vcmp":
        return compareWith(m.cmp, v, resolveParam(m.value, bindings));
      case "between":
        return comparePrimitives(v, m.lo) >= 0 && comparePrimitives(v, m.hi) <= 0;
      case "inSet":
        return m.values.some((x) => comparePrimitives(v, x) === 0);
    }
  }
  function entityWant(m, root, bindings) {
    if (m.kind === "const") return m.id;
    if (m.kind === "root") return root;
    const bound = resolveParam(m, bindings);
    if (typeof bound !== "string") {
      throw new Error(`hole "${m.name}" bound to a non-string where an entity id is required (E15)`);
    }
    return bound;
  }
  function pointerMatches(p, ptr, root, bindings) {
    if (p.role !== void 0 && !strMatch(p.role, ptr.role)) return false;
    if (p.targetEntity !== void 0) {
      if (ptr.target.kind !== "entity") return false;
      const want = entityWant(p.targetEntity, root, bindings);
      if (want === void 0 || ptr.target.entity.id !== want) return false;
    }
    if (p.targetDelta !== void 0) {
      if (ptr.target.kind !== "delta" || ptr.target.deltaRef.delta !== p.targetDelta) return false;
    }
    if (p.context !== void 0) {
      const ctx = ptr.target.kind === "entity" ? ptr.target.entity.context : ptr.target.kind === "delta" ? ptr.target.deltaRef.context : void 0;
      if (ctx === void 0 || !strMatch(p.context, ctx)) return false;
    }
    if (p.targetIsPrimitive !== void 0) {
      if (ptr.target.kind === "primitive" !== p.targetIsPrimitive) return false;
    }
    if (p.targetValue !== void 0) {
      if (ptr.target.kind !== "primitive" || !valMatch(p.targetValue, ptr.target.value, bindings)) {
        return false;
      }
    }
    return true;
  }
  function substituteHoles(pred, bindings) {
    switch (pred.kind) {
      case "true":
      case "false":
        return pred;
      case "match": {
        const c = pred.constant;
        if (typeof c === "object" && !Array.isArray(c)) {
          return { ...pred, constant: resolveParam(c, bindings) };
        }
        return pred;
      }
      case "hasPointer": {
        const p = pred.ppred;
        let te = p.targetEntity;
        if (te !== void 0 && te.kind === "hole") {
          const bound = resolveParam(te, bindings);
          if (typeof bound !== "string") {
            throw new Error(
              `hole "${te.name}" bound to a non-string where an entity id is required (E15)`
            );
          }
          te = { kind: "const", id: bound };
        }
        let tv = p.targetValue;
        if (tv !== void 0 && tv.kind === "vcmp" && typeof tv.value === "object") {
          tv = { ...tv, value: resolveParam(tv.value, bindings) };
        }
        if (te === p.targetEntity && tv === p.targetValue) return pred;
        return {
          kind: "hasPointer",
          ppred: {
            ...p,
            ...te === void 0 ? {} : { targetEntity: te },
            ...tv === void 0 ? {} : { targetValue: tv }
          }
        };
      }
      case "and":
        return {
          kind: "and",
          left: substituteHoles(pred.left, bindings),
          right: substituteHoles(pred.right, bindings)
        };
      case "or":
        return {
          kind: "or",
          left: substituteHoles(pred.left, bindings),
          right: substituteHoles(pred.right, bindings)
        };
      case "not":
        return { kind: "not", pred: substituteHoles(pred.pred, bindings) };
      case "inView":
        return pred;
    }
  }
  function evalPred(pred, delta, root, bindings) {
    switch (pred.kind) {
      case "true":
        return true;
      case "false":
        return false;
      case "match": {
        const subject = pred.field === "author" ? delta.claims.author : pred.field === "timestamp" ? delta.claims.timestamp : delta.id;
        const c = pred.constant;
        const constant = typeof c === "object" && !Array.isArray(c) ? resolveParam(c, bindings) : c;
        return compareWith(pred.cmp, subject, constant);
      }
      case "hasPointer":
        return delta.claims.pointers.some((ptr) => pointerMatches(pred.ppred, ptr, root, bindings));
      case "and":
        return evalPred(pred.left, delta, root, bindings) && evalPred(pred.right, delta, root, bindings);
      case "or":
        return evalPred(pred.left, delta, root, bindings) || evalPred(pred.right, delta, root, bindings);
      case "not":
        return !evalPred(pred.pred, delta, root, bindings);
      case "inView":
        throw new Error("inView must be resolved before matching (SPEC-2 \xA73.1)");
    }
  }

  // src/policy.ts
  function cmpByOrder(order, a, b) {
    switch (order.kind) {
      case "byTimestamp": {
        const d = a.delta.claims.timestamp - b.delta.claims.timestamp;
        if (d !== 0) return order.dir === "desc" ? -d : d;
        return 0;
      }
      case "byAuthorRank": {
        const rank = (author) => {
          const i = order.authors.indexOf(author);
          return i === -1 ? order.authors.length : i;
        };
        return rank(a.delta.claims.author) - rank(b.delta.claims.author);
      }
      case "byPred": {
        const am = evalPred(order.pred, a.delta) ? 0 : 1;
        const bm = evalPred(order.pred, b.delta) ? 0 : 1;
        if (am !== bm) return am - bm;
        return cmpByOrder(order.then, a, b);
      }
      case "chain": {
        for (const o of order.orders) {
          const c = cmpByOrder(o, a, b);
          if (c !== 0) return c;
        }
        return 0;
      }
      case "lexById":
        return a.delta.id < b.delta.id ? -1 : a.delta.id > b.delta.id ? 1 : 0;
    }
  }
  function sortEntries(order, entries) {
    return [...entries].sort((a, b) => {
      const primary = cmpByOrder(order, a, b);
      if (primary !== 0) return primary;
      return a.delta.id < b.delta.id ? -1 : a.delta.id > b.delta.id ? 1 : 0;
    });
  }
  function renderTarget(t, expansion, policy) {
    if (expansion !== void 0) return resolveView(policy, expansion);
    switch (t.kind) {
      case "primitive":
        return t.value;
      case "entity":
        return t.entity.id;
      case "delta":
        return t.deltaRef.delta;
    }
  }
  function candidateValue(e, root, policy) {
    const nonFiling = [];
    e.delta.claims.pointers.forEach((p, i) => {
      const filing = p.target.kind === "entity" && p.target.entity.id === root;
      if (filing) return;
      nonFiling.push([p.role, renderTarget(p.target, e.expanded?.get(i), policy)]);
    });
    if (nonFiling.length === 0) return true;
    if (nonFiling.length === 1) return nonFiling[0][1];
    const obj = {};
    for (const [role, v] of nonFiling) {
      const existing = obj[role];
      if (existing === void 0) obj[role] = v;
      else if (Array.isArray(existing)) obj[role] = [...existing, v];
      else obj[role] = [existing, v];
    }
    return obj;
  }
  function viewToCbor(v) {
    if (typeof v === "string") return tstr(v);
    if (typeof v === "number") return float(v);
    if (typeof v === "boolean") return bool(v);
    if (Array.isArray(v)) return array(v.map(viewToCbor));
    const entries = Object.entries(v).map(
      ([k, x]) => [k, viewToCbor(x)]
    );
    return map(entries);
  }
  function viewCanonicalHex(v) {
    return bytesToHex(encode(viewToCbor(v)));
  }
  var ABSENT = /* @__PURE__ */ Symbol("absent");
  function isPrimitive(v) {
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  }
  function applyMerge(fn, entries, root, policy) {
    const sorted = sortEntries({ kind: "lexById" }, entries);
    if (fn === "count") return sorted.length === 0 ? ABSENT : sorted.length;
    const prims = sorted.map((e) => candidateValue(e, root, policy)).filter((v) => isPrimitive(v));
    switch (fn) {
      case "max":
      case "min": {
        if (prims.length === 0) return ABSENT;
        return prims.reduce((acc, v) => {
          const c = comparePrimitives(v, acc);
          return (fn === "max" ? c > 0 : c < 0) ? v : acc;
        });
      }
      case "sum": {
        const nums = prims.filter((v) => typeof v === "number");
        if (nums.length === 0) return ABSENT;
        return nums.reduce((a, b) => a + b, 0);
      }
      case "and":
      case "or": {
        const bools = prims.filter((v) => typeof v === "boolean");
        if (bools.length === 0) return ABSENT;
        return fn === "and" ? bools.every(Boolean) : bools.some(Boolean);
      }
      case "concatSorted": {
        if (prims.length === 0) return ABSENT;
        return [...prims].sort(comparePrimitives);
      }
    }
  }
  function applyPropPolicy(pp, entries, root, policy) {
    switch (pp.kind) {
      case "pick": {
        if (entries.length === 0) return ABSENT;
        const sorted = sortEntries(pp.order, entries);
        return candidateValue(sorted[0], root, policy);
      }
      case "all": {
        if (entries.length === 0) return ABSENT;
        return sortEntries(pp.order, entries).map((e) => candidateValue(e, root, policy));
      }
      case "merge":
        return applyMerge(pp.fn, entries, root, policy);
      case "conflicts": {
        const sorted = sortEntries(pp.order, entries);
        const seen = /* @__PURE__ */ new Set();
        const distinct = [];
        for (const e of sorted) {
          const v = candidateValue(e, root, policy);
          const key = viewCanonicalHex(v);
          if (!seen.has(key)) {
            seen.add(key);
            distinct.push(v);
          }
        }
        return distinct.length >= 2 ? distinct : ABSENT;
      }
      case "absentAs": {
        const inner = applyPropPolicy(pp.then, entries, root, policy);
        return inner === ABSENT ? pp.constant : inner;
      }
    }
  }
  function resolveView(policy, hview) {
    const keys = /* @__PURE__ */ new Set([...policy.props.keys(), ...hview.props.keys()]);
    const obj = {};
    for (const key of keys) {
      const entries = hview.props.get(key) ?? [];
      const pp = policy.props.get(key) ?? policy.default;
      const v = applyPropPolicy(pp, entries, hview.id, policy);
      if (v !== ABSENT) obj[key] = v;
    }
    return obj;
  }

  // src/vocab.ts
  var VOCAB_PREFIX = "rhizomatic";

  // src/set.ts
  function makeDelta(claims, sig) {
    const id = computeId(claims);
    return sig === void 0 ? { id, claims } : { id, claims, sig };
  }
  function makeNegationClaims(author, timestamp, targetDeltaId, reason) {
    const pointers = [
      { role: "negates", target: { kind: "delta", deltaRef: { delta: targetDeltaId } } }
    ];
    if (reason !== void 0) {
      pointers.push({ role: "reason", target: { kind: "primitive", value: reason } });
    }
    return { timestamp, author, pointers };
  }
  var DeltaSet = class _DeltaSet {
    byId = /* @__PURE__ */ new Map();
    static from(deltas) {
      const s = new _DeltaSet();
      for (const d of deltas) s.add(d);
      return s;
    }
    // Idempotent insert; returns false when the id was already present. Verifies content
    // addressing on the way in (P6): a delta whose id does not recompute is rejected, never
    // repaired (SPEC-4 §2) — set semantics depend on true ids.
    add(delta) {
      if (this.byId.has(delta.id)) return false;
      if (computeId(delta.claims) !== delta.id) {
        throw new Error(`delta id ${delta.id} does not match its claims (content addressing, P6)`);
      }
      this.byId.set(delta.id, delta);
      return true;
    }
    has(id) {
      return this.byId.has(id);
    }
    get(id) {
      return this.byId.get(id);
    }
    get size() {
      return this.byId.size;
    }
    [Symbol.iterator]() {
      return this.byId.values();
    }
    // Sorted lexicographically — the canonical enumeration order.
    ids() {
      return [...this.byId.keys()].sort();
    }
    // Canonical membership fingerprint (ERRATA D10, provisional helper — not the SPEC-6 digest).
    digest() {
      return contentAddress(encode(array(this.ids().map(tstr))));
    }
  };
  function merge(a, b) {
    const s = DeltaSet.from(a);
    for (const d of b) s.add(d);
    return s;
  }
  function fork(a, p) {
    const s = new DeltaSet();
    for (const d of a) if (p(d)) s.add(d);
    return s;
  }

  // src/eval.ts
  var dsetResult = (set) => ({
    sort: "dset",
    set,
    negated: /* @__PURE__ */ new Set(),
    annotated: false
  });
  function expectDSet(r, op) {
    if (r.sort !== "dset") throw new Error(`${op} requires a DSet operand (E9)`);
    return r;
  }
  function expectHView(r, op) {
    if (r.sort !== "hview") throw new Error(`${op} requires an HView operand (E9)`);
    return r;
  }
  function computeNegated(d, trusted) {
    const negators = /* @__PURE__ */ new Map();
    for (const n of d) {
      if (trusted !== void 0 && !trusted(n)) continue;
      for (const ptr of n.claims.pointers) {
        if (ptr.role === "negates" && ptr.target.kind === "delta") {
          const list = negators.get(ptr.target.deltaRef.delta);
          if (list === void 0) negators.set(ptr.target.deltaRef.delta, [n.id]);
          else list.push(n.id);
        }
      }
    }
    const memo = /* @__PURE__ */ new Map();
    const isNegated = (id) => {
      const cached = memo.get(id);
      if (cached !== void 0) return cached;
      memo.set(id, false);
      const result = (negators.get(id) ?? []).some((nid) => !isNegated(nid));
      memo.set(id, result);
      return result;
    };
    const out = /* @__PURE__ */ new Set();
    for (const delta of d) if (isNegated(delta.id)) out.add(delta.id);
    return out;
  }
  var ALIAS_FRAGMENT = `${VOCAB_PREFIX}.alias.fragment`;
  var ALIAS_SLOT = `${VOCAB_PREFIX}.alias.slot`;
  var ALIAS_CONCEPT = `${VOCAB_PREFIX}.alias.concept`;
  function aliasClosure(input, spec, root) {
    const trustPred = spec.trust;
    const trusted = trustPred === void 0 ? void 0 : (n) => evalPred(trustPred, n, root);
    const negated = computeNegated(input, trusted);
    const mappings = [];
    const slotConcepts = /* @__PURE__ */ new Map();
    for (const d of input) {
      if (trusted !== void 0 && !trusted(d)) continue;
      if (negated.has(d.id)) continue;
      const fragments = [];
      const slots = [];
      const concepts = [];
      for (const ptr of d.claims.pointers) {
        if (ptr.role === ALIAS_FRAGMENT && ptr.target.kind === "primitive") {
          if (typeof ptr.target.value === "string") fragments.push(ptr.target.value);
        } else if (ptr.role === ALIAS_SLOT && ptr.target.kind === "entity") {
          slots.push(ptr.target.entity.id);
        } else if (ptr.role === ALIAS_CONCEPT && ptr.target.kind === "entity") {
          concepts.push(ptr.target.entity.id);
        }
      }
      for (const fragment of fragments) for (const slot of slots) mappings.push({ fragment, slot });
      for (const slot of slots) {
        for (const concept of concepts) {
          let set = slotConcepts.get(slot);
          if (set === void 0) {
            set = /* @__PURE__ */ new Set();
            slotConcepts.set(slot, set);
          }
          set.add(concept);
        }
      }
    }
    const eligible = spec.via === void 0 ? mappings : mappings.filter((m) => slotConcepts.get(m.slot)?.has(spec.via) ?? false);
    const slotsOfName = new Set(eligible.filter((m) => m.fragment === spec.name).map((m) => m.slot));
    const closure = /* @__PURE__ */ new Set([spec.name]);
    for (const m of eligible) if (slotsOfName.has(m.slot)) closure.add(m.fragment);
    return [...closure].sort(comparePrimitives);
  }
  function expandStrMatch(m, input, root) {
    if (m.kind !== "aliased") return m;
    return { kind: "inSet", values: aliasClosure(input, m, root) };
  }
  function expandAliased(pred, input, root) {
    switch (pred.kind) {
      case "true":
      case "false":
      case "match":
        return pred;
      case "hasPointer": {
        const p = pred.ppred;
        const role = p.role === void 0 ? void 0 : expandStrMatch(p.role, input, root);
        const context = p.context === void 0 ? void 0 : expandStrMatch(p.context, input, root);
        if (role === p.role && context === p.context) return pred;
        return {
          kind: "hasPointer",
          ppred: {
            ...p,
            ...role === void 0 ? {} : { role },
            ...context === void 0 ? {} : { context }
          }
        };
      }
      case "and":
        return {
          kind: "and",
          left: expandAliased(pred.left, input, root),
          right: expandAliased(pred.right, input, root)
        };
      case "or":
        return {
          kind: "or",
          left: expandAliased(pred.left, input, root),
          right: expandAliased(pred.right, input, root)
        };
      case "not":
        return { kind: "not", pred: expandAliased(pred.pred, input, root) };
      case "inView":
        return pred;
    }
  }
  function extractReflected(extract, set) {
    const out = /* @__PURE__ */ new Set();
    for (const d of set) {
      if (extract.kind === "field") {
        out.add(extract.field === "author" ? d.claims.author : d.id);
        continue;
      }
      for (const ptr of d.claims.pointers) {
        if (ptr.role !== extract.role) continue;
        const t = ptr.target;
        if (t.kind === "entity") out.add(t.entity.id);
        else if (t.kind === "delta") out.add(t.deltaRef.delta);
        else if (typeof t.value === "string") out.add(t.value);
      }
    }
    return [...out].sort(comparePrimitives);
  }
  function resolveReflective(pred, input, root, registry, bindings) {
    switch (pred.kind) {
      case "inView": {
        const sub = evalTerm(pred.term, input, root, registry, bindings);
        if (sub.sort !== "dset") throw new Error("inView.term must evaluate to a DSet (E9)");
        return {
          kind: "match",
          field: pred.field,
          cmp: "inSet",
          constant: extractReflected(pred.extract, sub.set)
        };
      }
      case "and":
        return {
          kind: "and",
          left: resolveReflective(pred.left, input, root, registry, bindings),
          right: resolveReflective(pred.right, input, root, registry, bindings)
        };
      case "or":
        return {
          kind: "or",
          left: resolveReflective(pred.left, input, root, registry, bindings),
          right: resolveReflective(pred.right, input, root, registry, bindings)
        };
      case "not":
        return { kind: "not", pred: resolveReflective(pred.pred, input, root, registry, bindings) };
      default:
        return pred;
    }
  }
  function termContainsInView(t) {
    switch (t.kind) {
      case "input":
      case "fix":
        return false;
      case "select":
        return predContainsInView(t.pred) || termContainsInView(t.of);
      case "union":
        return termContainsInView(t.left) || termContainsInView(t.right);
      case "mask":
        return t.policy.kind === "trust" && predContainsInView(t.policy.pred) || termContainsInView(t.of);
      case "group":
      case "prune":
      case "expand":
      case "resolve":
        return termContainsInView(t.of);
    }
  }
  function evalGroup(key, operand, root) {
    const buckets = /* @__PURE__ */ new Map();
    const file = (prop, d) => {
      let bucket = buckets.get(prop);
      if (bucket === void 0) {
        bucket = /* @__PURE__ */ new Map();
        buckets.set(prop, bucket);
      }
      if (!bucket.has(d.id)) bucket.set(d.id, { delta: d, negated: operand.negated.has(d.id) });
    };
    for (const d of operand.set) {
      if (key.kind === "const") {
        file(key.prop, d);
        continue;
      }
      for (const ptr of d.claims.pointers) {
        if (ptr.target.kind !== "entity" || ptr.target.entity.id !== root) continue;
        if (key.kind === "byTargetContext") {
          const ctx = ptr.target.entity.context;
          if (ctx !== void 0) file(ctx, d);
        } else {
          file(ptr.role, d);
        }
      }
    }
    const props = /* @__PURE__ */ new Map();
    for (const [prop, bucket] of buckets) {
      props.set(
        prop,
        [...bucket.values()].sort((a, b) => a.delta.id < b.delta.id ? -1 : 1)
      );
    }
    return { id: root, props };
  }
  function evalTerm(term, input, root, registry, bindings) {
    switch (term.kind) {
      case "input":
        return dsetResult(input);
      case "select": {
        const of = expectDSet(evalTerm(term.of, input, root, registry, bindings), "select");
        const pred = resolveReflective(
          expandAliased(substituteHoles(term.pred, bindings), input, root),
          input,
          root,
          registry,
          bindings
        );
        return dsetResult(fork(of.set, (d) => evalPred(pred, d, root)));
      }
      case "union": {
        const left = expectDSet(evalTerm(term.left, input, root, registry, bindings), "union");
        const right = expectDSet(evalTerm(term.right, input, root, registry, bindings), "union");
        return dsetResult(merge(left.set, right.set));
      }
      case "mask": {
        const of = expectDSet(evalTerm(term.of, input, root, registry, bindings), "mask");
        switch (term.policy.kind) {
          case "drop": {
            const negated = computeNegated(of.set);
            return dsetResult(fork(of.set, (d) => !negated.has(d.id)));
          }
          case "annotate": {
            const negated = computeNegated(of.set);
            return { sort: "dset", set: of.set, negated, annotated: true };
          }
          case "trust": {
            const pred = resolveReflective(
              expandAliased(substituteHoles(term.policy.pred, bindings), input, root),
              input,
              root,
              registry,
              bindings
            );
            const negated = computeNegated(of.set, (n) => evalPred(pred, n, root));
            return dsetResult(fork(of.set, (d) => !negated.has(d.id)));
          }
        }
        break;
      }
      case "group": {
        if (root === void 0) throw new Error("group requires an ambient root entity (E9)");
        const of = expectDSet(evalTerm(term.of, input, root, registry, bindings), "group");
        return { sort: "hview", hview: evalGroup(term.key, of, root) };
      }
      case "prune": {
        const of = expectHView(evalTerm(term.of, input, root, registry, bindings), "prune");
        if (term.keep === "all") return of;
        const keep = expandStrMatch(term.keep, input, root);
        const props = /* @__PURE__ */ new Map();
        for (const [prop, entries] of of.hview.props) {
          if (strMatch(keep, prop)) props.set(prop, entries);
        }
        return { sort: "hview", hview: { id: of.hview.id, props } };
      }
      case "expand": {
        const of = expectHView(evalTerm(term.of, input, root, registry, bindings), "expand");
        const role = expandStrMatch(term.role, input, root);
        const props = /* @__PURE__ */ new Map();
        for (const [prop, entries] of of.hview.props) {
          props.set(
            prop,
            entries.map((e) => {
              let expanded;
              e.delta.claims.pointers.forEach((ptr, i) => {
                if (ptr.target.kind !== "entity" || !strMatch(role, ptr.role)) return;
                const nested = evalSchema(
                  term.schema,
                  input,
                  ptr.target.entity.id,
                  registry,
                  bindings
                );
                expanded = expanded ?? new Map(e.expanded ?? []);
                expanded.set(i, nested);
              });
              return expanded === void 0 ? e : { ...e, expanded };
            })
          );
        }
        return { sort: "hview", hview: { id: of.hview.id, props } };
      }
      case "fix":
        return {
          sort: "hview",
          hview: evalSchema(term.schema, input, term.entity, registry, term.bindings ?? bindings)
        };
      case "resolve": {
        const of = expectHView(evalTerm(term.of, input, root, registry, bindings), "resolve");
        return { sort: "view", view: resolveView(term.policy, of.hview) };
      }
    }
  }
  function evalSchema(ref, input, root, registry, bindings) {
    const label = ref.kind === "name" ? ref.name : `pinned:${ref.hash.slice(0, 12)}\u2026`;
    if (registry === void 0)
      throw new Error(`schema ${label} referenced but no registry supplied (E10)`);
    const schema = registry.resolve(ref);
    if (schema === void 0) throw new Error(`unknown schema: ${label} (E10/E13)`);
    const result = evalTerm(schema.body, input, root, registry, bindings);
    if (result.sort !== "hview") {
      throw new Error(`schema ${label} body must be an HView-sort term (E10)`);
    }
    return result.hview;
  }
  function resultCanonicalHex(result) {
    if (result.sort === "view") return viewCanonicalHex(result.view);
    if (result.sort === "hview") return hviewCanonicalHex(result.hview);
    const ids = result.set.ids().map(tstr);
    if (!result.annotated) return bytesToHex(encode(array(ids)));
    const negated = [...result.negated].sort().map(tstr);
    return bytesToHex(
      encode(
        map([
          ["ids", array(ids)],
          ["negated", array(negated)]
        ])
      )
    );
  }

  // src/term-io.ts
  function paramToJson(v) {
    return typeof v === "object" ? { hole: v.name } : v;
  }
  function strMatchToJson(m) {
    switch (m.kind) {
      case "exact":
        return { exact: m.value };
      case "prefix":
        return { prefix: m.value };
      case "inSet":
        return { inSet: [...m.values] };
      case "aliased": {
        const a = { name: m.name };
        if (m.via !== void 0) a["via"] = m.via;
        if (m.trust !== void 0) a["trust"] = predToJson(m.trust);
        return { aliased: a };
      }
    }
  }
  function valMatchToJson(m) {
    switch (m.kind) {
      case "vcmp":
        return { vcmp: { cmp: m.cmp, value: paramToJson(m.value) } };
      case "between":
        return { between: [m.lo, m.hi] };
      case "inSet":
        return { inSet: [...m.values] };
    }
  }
  function ppredToJson(p) {
    const out = {};
    if (p.role !== void 0) out["role"] = strMatchToJson(p.role);
    if (p.targetEntity !== void 0) {
      out["targetEntity"] = p.targetEntity.kind === "const" ? p.targetEntity.id : p.targetEntity.kind === "hole" ? { hole: p.targetEntity.name } : { var: "root" };
    }
    if (p.targetDelta !== void 0) out["targetDelta"] = p.targetDelta;
    if (p.context !== void 0) out["context"] = strMatchToJson(p.context);
    if (p.targetIsPrimitive !== void 0) out["targetIsPrimitive"] = p.targetIsPrimitive;
    if (p.targetValue !== void 0) out["targetValue"] = valMatchToJson(p.targetValue);
    return out;
  }
  function predToJson(pred) {
    switch (pred.kind) {
      case "true":
        return "true";
      case "false":
        return "false";
      case "match":
        return {
          match: {
            field: pred.field,
            cmp: pred.cmp,
            const: Array.isArray(pred.constant) ? [...pred.constant] : paramToJson(pred.constant)
          }
        };
      case "hasPointer":
        return { hasPointer: ppredToJson(pred.ppred) };
      case "and":
        return { and: [predToJson(pred.left), predToJson(pred.right)] };
      case "or":
        return { or: [predToJson(pred.left), predToJson(pred.right)] };
      case "not":
        return { not: predToJson(pred.pred) };
      case "inView":
        return {
          inView: {
            term: termToJson(pred.term),
            field: pred.field,
            extract: pred.extract.kind === "field" ? { field: pred.extract.field } : { role: pred.extract.role }
          }
        };
    }
  }
  function orderToJson(o) {
    switch (o.kind) {
      case "byTimestamp":
        return { byTimestamp: o.dir };
      case "byAuthorRank":
        return { byAuthorRank: [...o.authors] };
      case "byPred":
        return { byPred: { pred: predToJson(o.pred), then: orderToJson(o.then) } };
      case "chain":
        return { chain: o.orders.map(orderToJson) };
      case "lexById":
        return "lexById";
    }
  }
  function propPolicyToJson(pp) {
    switch (pp.kind) {
      case "pick":
        return { pick: { order: orderToJson(pp.order) } };
      case "all":
        return { all: { order: orderToJson(pp.order) } };
      case "merge":
        return { merge: pp.fn };
      case "conflicts":
        return { conflicts: { order: orderToJson(pp.order) } };
      case "absentAs":
        return { absentAs: { const: pp.constant, then: propPolicyToJson(pp.then) } };
    }
  }
  function policyToJson(p) {
    const props = {};
    for (const [k, v] of p.props) props[k] = propPolicyToJson(v);
    return { props, default: propPolicyToJson(p.default) };
  }
  function termToJson(term) {
    switch (term.kind) {
      case "input":
        return "input";
      case "select":
        return { op: "select", pred: predToJson(term.pred), in: termToJson(term.of) };
      case "union":
        return { op: "union", left: termToJson(term.left), right: termToJson(term.right) };
      case "mask": {
        const policy = term.policy.kind === "trust" ? { trust: predToJson(term.policy.pred) } : term.policy.kind;
        return { op: "mask", policy, in: termToJson(term.of) };
      }
      case "group": {
        const key = term.key.kind === "const" ? { const: term.key.prop } : term.key.kind;
        return { op: "group", key, in: termToJson(term.of) };
      }
      case "prune":
        return {
          op: "prune",
          keep: term.keep === "all" ? "all" : strMatchToJson(term.keep),
          in: termToJson(term.of)
        };
      case "expand":
        return {
          op: "expand",
          role: strMatchToJson(term.role),
          schema: schemaRefToJson(term.schema),
          in: termToJson(term.of)
        };
      case "fix": {
        const out = {
          op: "fix",
          schema: schemaRefToJson(term.schema),
          entity: term.entity
        };
        if (term.bindings !== void 0 && term.bindings.size > 0) {
          const bindings = {};
          for (const key of [...term.bindings.keys()].sort()) {
            bindings[key] = term.bindings.get(key);
          }
          out["bindings"] = bindings;
        }
        return out;
      }
      case "resolve":
        return { op: "resolve", policy: policyToJson(term.policy), in: termToJson(term.of) };
    }
  }
  function schemaRefToJson(ref) {
    return ref.kind === "name" ? ref.name : { pinned: ref.hash };
  }
  function jsonToCbor(v) {
    if (typeof v === "string") return tstr(v);
    if (typeof v === "number") return float(v);
    if (typeof v === "boolean") return bool(v);
    if (Array.isArray(v)) return array(v.map(jsonToCbor));
    if (typeof v === "object" && v !== null) {
      return map(
        Object.entries(v).map(([k, x]) => [
          k,
          jsonToCbor(x)
        ])
      );
    }
    throw new Error("json value outside the CBOR profile (null/undefined are not representable)");
  }
  function termCanonicalBytes(term) {
    return encode(jsonToCbor(termToJson(term)));
  }
  function termHash(term) {
    return contentAddress(termCanonicalBytes(term));
  }

  // src/term-json.ts
  var CMPS = ["eq", "neq", "lt", "lte", "gt", "gte", "prefix", "inSet"];
  function nfc(s) {
    return s.normalize("NFC");
  }
  function asObject(x, what) {
    if (typeof x !== "object" || x === null || Array.isArray(x)) {
      throw new Error(`expected object for ${what}`);
    }
    return x;
  }
  function parsePrimitive(v, what) {
    if (typeof v === "string") return nfc(v);
    if (typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`${what}: numeric constant must be finite`);
      return v;
    }
    throw new Error(`${what}: constant must be string | number | boolean`);
  }
  function parseHole(v) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return void 0;
    const h = v["hole"];
    return typeof h === "string" ? { kind: "hole", name: nfc(h) } : void 0;
  }
  function parseParam(v, what) {
    return parseHole(v) ?? parsePrimitive(v, what);
  }
  function parseCmp(v, what) {
    if (typeof v !== "string" || !CMPS.includes(v)) {
      throw new Error(`${what}: unknown cmp ${String(v)}`);
    }
    return v;
  }
  function parseStrMatch(raw, what) {
    const o = asObject(raw, what);
    if (typeof o["exact"] === "string") return { kind: "exact", value: nfc(o["exact"]) };
    if (typeof o["prefix"] === "string") return { kind: "prefix", value: nfc(o["prefix"]) };
    if (Array.isArray(o["inSet"])) {
      return {
        kind: "inSet",
        values: o["inSet"].map((s) => {
          if (typeof s !== "string") throw new Error(`${what}: inSet members must be strings`);
          return nfc(s);
        })
      };
    }
    if (o["aliased"] !== void 0) {
      const a = asObject(o["aliased"], `${what}.aliased`);
      if (typeof a["name"] !== "string") throw new Error(`${what}: aliased.name must be a string`);
      const out = { name: nfc(a["name"]) };
      if (a["via"] !== void 0) {
        if (typeof a["via"] !== "string")
          throw new Error(`${what}: aliased.via must be an entity id`);
        out.via = nfc(a["via"]);
      }
      if (a["trust"] !== void 0) {
        const trust = parsePred(a["trust"]);
        assertClosedTrustPred(trust, `${what}.aliased.trust`);
        out.trust = trust;
      }
      return { kind: "aliased", ...out };
    }
    throw new Error(`${what}: StrMatch must be exact | prefix | inSet | aliased`);
  }
  function assertClosedTrustPred(p, what) {
    switch (p.kind) {
      case "true":
      case "false":
        return;
      case "match":
        if (typeof p.constant === "object" && !Array.isArray(p.constant)) {
          throw new Error(`${what}: holes are not allowed inside an aliased trust predicate`);
        }
        return;
      case "hasPointer": {
        const pp = p.ppred;
        if (pp.targetEntity?.kind === "hole" || pp.targetValue?.kind === "vcmp" && typeof pp.targetValue.value === "object") {
          throw new Error(`${what}: holes are not allowed inside an aliased trust predicate`);
        }
        if (pp.role?.kind === "aliased" || pp.context?.kind === "aliased") {
          throw new Error(`${what}: nested aliased is not allowed inside an aliased trust predicate`);
        }
        return;
      }
      case "and":
      case "or":
        assertClosedTrustPred(p.left, what);
        assertClosedTrustPred(p.right, what);
        return;
      case "not":
        assertClosedTrustPred(p.pred, what);
        return;
      case "inView":
        throw new Error(`${what}: inView is not allowed inside an aliased trust predicate`);
    }
  }
  function parseValMatch(raw, what) {
    const o = asObject(raw, what);
    if (o["vcmp"] !== void 0) {
      const v = asObject(o["vcmp"], `${what}.vcmp`);
      const cmp = parseCmp(v["cmp"], `${what}.vcmp`);
      if (cmp === "inSet")
        throw new Error(`${what}: vcmp cmp inSet is not allowed; use the inSet arm`);
      const value = parseParam(v["value"], `${what}.vcmp`);
      if (cmp === "prefix" && typeof value !== "string" && typeof value !== "object") {
        throw new Error(`${what}: prefix requires a string constant`);
      }
      return { kind: "vcmp", cmp, value };
    }
    if (Array.isArray(o["between"])) {
      if (o["between"].length !== 2) throw new Error(`${what}: between takes [lo, hi]`);
      return {
        kind: "between",
        lo: parsePrimitive(o["between"][0], `${what}.between`),
        hi: parsePrimitive(o["between"][1], `${what}.between`)
      };
    }
    if (Array.isArray(o["inSet"])) {
      return { kind: "inSet", values: o["inSet"].map((v) => parsePrimitive(v, `${what}.inSet`)) };
    }
    throw new Error(`${what}: ValMatch must be vcmp | between | inSet`);
  }
  function parsePPred(raw) {
    const o = asObject(raw, "hasPointer");
    const out = {};
    if (o["role"] !== void 0) out.role = parseStrMatch(o["role"], "hasPointer.role");
    if (o["targetEntity"] !== void 0) {
      const te = o["targetEntity"];
      if (typeof te === "string") {
        out.targetEntity = { kind: "const", id: nfc(te) };
      } else {
        const hole = parseHole(te);
        if (hole !== void 0) {
          out.targetEntity = hole;
        } else {
          const v = asObject(te, "targetEntity");
          if (v["var"] !== "root") {
            throw new Error('targetEntity must be a string, {var: "root"}, or {hole: "name"}');
          }
          out.targetEntity = { kind: "root" };
        }
      }
    }
    if (o["targetDelta"] !== void 0) {
      if (typeof o["targetDelta"] !== "string") throw new Error("targetDelta must be a string");
      out.targetDelta = o["targetDelta"];
    }
    if (o["context"] !== void 0) out.context = parseStrMatch(o["context"], "hasPointer.context");
    if (o["targetIsPrimitive"] !== void 0) {
      if (typeof o["targetIsPrimitive"] !== "boolean") {
        throw new Error("targetIsPrimitive must be a boolean");
      }
      out.targetIsPrimitive = o["targetIsPrimitive"];
    }
    if (o["targetValue"] !== void 0) {
      out.targetValue = parseValMatch(o["targetValue"], "hasPointer.targetValue");
    }
    if (Object.keys(out).length === 0) throw new Error("hasPointer requires at least one field (E1)");
    return out;
  }
  function parsePred(raw) {
    if (raw === "true") return { kind: "true" };
    if (raw === "false") return { kind: "false" };
    const o = asObject(raw, "pred");
    if (o["match"] !== void 0) {
      const m = asObject(o["match"], "match");
      const field = m["field"];
      if (field !== "author" && field !== "timestamp" && field !== "id") {
        throw new Error(`match: unknown field ${String(field)}`);
      }
      const cmp = parseCmp(m["cmp"], "match");
      const rawConst = m["const"];
      const constant = cmp === "inSet" ? (() => {
        if (!Array.isArray(rawConst)) throw new Error("match: inSet requires an array const");
        return rawConst.map((v) => parsePrimitive(v, "match.const"));
      })() : parseParam(rawConst, "match.const");
      if (cmp === "prefix" && typeof constant !== "string" && typeof constant !== "object") {
        throw new Error("match: prefix requires a string const");
      }
      return { kind: "match", field, cmp, constant };
    }
    if (o["hasPointer"] !== void 0)
      return { kind: "hasPointer", ppred: parsePPred(o["hasPointer"]) };
    if (o["and"] !== void 0 || o["or"] !== void 0) {
      const key = o["and"] !== void 0 ? "and" : "or";
      const arr = o[key];
      if (!Array.isArray(arr) || arr.length !== 2)
        throw new Error(`${key} takes exactly [Pred, Pred] (E1)`);
      const left = parsePred(arr[0]);
      const right = parsePred(arr[1]);
      return key === "and" ? { kind: "and", left, right } : { kind: "or", left, right };
    }
    if (o["not"] !== void 0) return { kind: "not", pred: parsePred(o["not"]) };
    if (o["inView"] !== void 0) {
      const v = asObject(o["inView"], "inView");
      const term = parseTerm(v["term"]);
      if (term.kind !== "input" && term.kind !== "select" && term.kind !== "union" && term.kind !== "mask") {
        throw new Error("inView.term must be a DSet-sort term (input | select | union | mask)");
      }
      if (termContainsInView(term)) {
        throw new Error("inView is stratified: no inView inside inView.term (SPEC-2 \xA73.1)");
      }
      const field = v["field"];
      if (field !== "author" && field !== "id") throw new Error("inView.field must be author | id");
      return { kind: "inView", term, field, extract: parseExtract(v["extract"]) };
    }
    throw new Error("pred must be true | false | match | hasPointer | and | or | not | inView");
  }
  function parseExtract(raw) {
    const o = asObject(raw, "inView.extract");
    if (o["field"] !== void 0) {
      if (o["field"] !== "author" && o["field"] !== "id") {
        throw new Error("inView.extract.field must be author | id");
      }
      return { kind: "field", field: o["field"] };
    }
    if (typeof o["role"] === "string") return { kind: "role", role: nfc(o["role"]) };
    throw new Error("inView.extract must be {field: author|id} | {role: string}");
  }
  function parseMaskPolicy(raw) {
    if (raw === "drop") return { kind: "drop" };
    if (raw === "annotate") return { kind: "annotate" };
    const o = asObject(raw, "mask.policy");
    if (o["trust"] !== void 0) return { kind: "trust", pred: parsePred(o["trust"]) };
    throw new Error("mask policy must be drop | annotate | {trust: Pred}");
  }
  var MERGE_FNS = ["max", "min", "sum", "count", "and", "or", "concatSorted"];
  function parseOrder(raw) {
    if (raw === "lexById") return { kind: "lexById" };
    const o = asObject(raw, "order");
    if (o["byTimestamp"] !== void 0) {
      if (o["byTimestamp"] !== "desc" && o["byTimestamp"] !== "asc") {
        throw new Error("byTimestamp must be desc | asc");
      }
      return { kind: "byTimestamp", dir: o["byTimestamp"] };
    }
    if (Array.isArray(o["byAuthorRank"])) {
      return {
        kind: "byAuthorRank",
        authors: o["byAuthorRank"].map((a) => {
          if (typeof a !== "string") throw new Error("byAuthorRank entries must be strings");
          return nfc(a);
        })
      };
    }
    if (o["byPred"] !== void 0) {
      const p = asObject(o["byPred"], "byPred");
      const pred = parsePred(p["pred"]);
      if (predContainsInView(pred)) {
        throw new Error("inView is not allowed inside a policy byPred predicate (SPEC-2 \xA73.1)");
      }
      return { kind: "byPred", pred, then: parseOrder(p["then"]) };
    }
    if (Array.isArray(o["chain"])) {
      if (o["chain"].length === 0) throw new Error("chain must name at least one order");
      return { kind: "chain", orders: o["chain"].map(parseOrder) };
    }
    throw new Error("order must be lexById | byTimestamp | byAuthorRank | byPred | chain");
  }
  function parsePropPolicy(raw) {
    const o = asObject(raw, "propPolicy");
    if (o["pick"] !== void 0) {
      return { kind: "pick", order: parseOrder(asObject(o["pick"], "pick")["order"]) };
    }
    if (o["all"] !== void 0) {
      return { kind: "all", order: parseOrder(asObject(o["all"], "all")["order"]) };
    }
    if (o["merge"] !== void 0) {
      if (!MERGE_FNS.includes(o["merge"])) {
        throw new Error("unknown merge fn " + String(o["merge"]));
      }
      return { kind: "merge", fn: o["merge"] };
    }
    if (o["conflicts"] !== void 0) {
      return { kind: "conflicts", order: parseOrder(asObject(o["conflicts"], "conflicts")["order"]) };
    }
    if (o["absentAs"] !== void 0) {
      const a = asObject(o["absentAs"], "absentAs");
      return {
        kind: "absentAs",
        constant: parsePrimitive(a["const"], "absentAs.const"),
        then: parsePropPolicy(a["then"])
      };
    }
    throw new Error("propPolicy must be pick | all | merge | conflicts | absentAs");
  }
  function parsePolicy(raw) {
    const o = asObject(raw, "policy");
    const props = /* @__PURE__ */ new Map();
    if (o["props"] !== void 0) {
      for (const [k, v] of Object.entries(asObject(o["props"], "policy.props"))) {
        props.set(nfc(k), parsePropPolicy(v));
      }
    }
    return { props, default: parsePropPolicy(o["default"]) };
  }
  function parseGroupKey(raw) {
    if (raw === "byTargetContext") return { kind: "byTargetContext" };
    if (raw === "byRole") return { kind: "byRole" };
    const o = asObject(raw, "group.key");
    if (typeof o["const"] === "string") return { kind: "const", prop: nfc(o["const"]) };
    throw new Error("group key must be byTargetContext | byRole | {const: string}");
  }
  function parseSchemaRef(raw) {
    if (typeof raw === "string") return { kind: "name", name: nfc(raw) };
    const o = asObject(raw, "schemaRef");
    if (typeof o["pinned"] === "string") return { kind: "pinned", hash: o["pinned"] };
    throw new Error("schema ref must be a name string or {pinned: hash} (E13)");
  }
  function parseTerm(raw) {
    if (raw === "input") return { kind: "input" };
    const o = asObject(raw, "term");
    switch (o["op"]) {
      case "select":
        return { kind: "select", pred: parsePred(o["pred"]), of: parseTerm(o["in"]) };
      case "union":
        return { kind: "union", left: parseTerm(o["left"]), right: parseTerm(o["right"]) };
      case "mask":
        return { kind: "mask", policy: parseMaskPolicy(o["policy"]), of: parseTerm(o["in"]) };
      case "group":
        return { kind: "group", key: parseGroupKey(o["key"]), of: parseTerm(o["in"]) };
      case "expand": {
        return {
          kind: "expand",
          role: parseStrMatch(o["role"], "expand.role"),
          schema: parseSchemaRef(o["schema"]),
          of: parseTerm(o["in"])
        };
      }
      case "fix": {
        if (typeof o["entity"] !== "string") throw new Error("fix.entity must be a string");
        const fix = {
          kind: "fix",
          schema: parseSchemaRef(o["schema"]),
          entity: nfc(o["entity"])
        };
        if (o["bindings"] === void 0) return fix;
        const bo = asObject(o["bindings"], "fix.bindings");
        const bindings = /* @__PURE__ */ new Map();
        for (const key of Object.keys(bo).sort()) {
          bindings.set(nfc(key), parsePrimitive(bo[key], `fix.bindings.${key}`));
        }
        return { ...fix, bindings };
      }
      case "resolve":
        return { kind: "resolve", policy: parsePolicy(o["policy"]), of: parseTerm(o["in"]) };
      case "prune": {
        const keep = o["keep"] === "all" ? "all" : parseStrMatch(o["keep"], "prune.keep");
        return { kind: "prune", keep, of: parseTerm(o["in"]) };
      }
      default:
        throw new Error(`unknown term op ${String(o["op"])}`);
    }
  }

  // src/schema-deltas.ts
  var ROLE_DEFINES = `${VOCAB_PREFIX}.schema.defines`;
  var ROLE_NAME = `${VOCAB_PREFIX}.schema.name`;
  var ROLE_ALG = `${VOCAB_PREFIX}.schema.alg`;
  var ROLE_TERM = `${VOCAB_PREFIX}.schema.term`;
  var SCHEMA_SCHEMA = {
    name: `${VOCAB_PREFIX}.SchemaSchema`,
    alg: 1,
    body: parseTerm({
      op: "group",
      key: "byTargetContext",
      in: {
        op: "select",
        pred: { hasPointer: { targetEntity: { var: "root" } } },
        // mask BEFORE select (ERRATA-3 S5): negations target deltas, not the root, so a
        // select-first idiom would exclude them before mask could suppress anything.
        in: { op: "mask", policy: "drop", in: "input" }
      }
    })
  };

  // node_modules/@noble/hashes/esm/sha2.js
  var K512 = /* @__PURE__ */ (() => split([
    "0x428a2f98d728ae22",
    "0x7137449123ef65cd",
    "0xb5c0fbcfec4d3b2f",
    "0xe9b5dba58189dbbc",
    "0x3956c25bf348b538",
    "0x59f111f1b605d019",
    "0x923f82a4af194f9b",
    "0xab1c5ed5da6d8118",
    "0xd807aa98a3030242",
    "0x12835b0145706fbe",
    "0x243185be4ee4b28c",
    "0x550c7dc3d5ffb4e2",
    "0x72be5d74f27b896f",
    "0x80deb1fe3b1696b1",
    "0x9bdc06a725c71235",
    "0xc19bf174cf692694",
    "0xe49b69c19ef14ad2",
    "0xefbe4786384f25e3",
    "0x0fc19dc68b8cd5b5",
    "0x240ca1cc77ac9c65",
    "0x2de92c6f592b0275",
    "0x4a7484aa6ea6e483",
    "0x5cb0a9dcbd41fbd4",
    "0x76f988da831153b5",
    "0x983e5152ee66dfab",
    "0xa831c66d2db43210",
    "0xb00327c898fb213f",
    "0xbf597fc7beef0ee4",
    "0xc6e00bf33da88fc2",
    "0xd5a79147930aa725",
    "0x06ca6351e003826f",
    "0x142929670a0e6e70",
    "0x27b70a8546d22ffc",
    "0x2e1b21385c26c926",
    "0x4d2c6dfc5ac42aed",
    "0x53380d139d95b3df",
    "0x650a73548baf63de",
    "0x766a0abb3c77b2a8",
    "0x81c2c92e47edaee6",
    "0x92722c851482353b",
    "0xa2bfe8a14cf10364",
    "0xa81a664bbc423001",
    "0xc24b8b70d0f89791",
    "0xc76c51a30654be30",
    "0xd192e819d6ef5218",
    "0xd69906245565a910",
    "0xf40e35855771202a",
    "0x106aa07032bbd1b8",
    "0x19a4c116b8d2d0c8",
    "0x1e376c085141ab53",
    "0x2748774cdf8eeb99",
    "0x34b0bcb5e19b48a8",
    "0x391c0cb3c5c95a63",
    "0x4ed8aa4ae3418acb",
    "0x5b9cca4f7763e373",
    "0x682e6ff3d6b2b8a3",
    "0x748f82ee5defb2fc",
    "0x78a5636f43172f60",
    "0x84c87814a1f0ab72",
    "0x8cc702081a6439ec",
    "0x90befffa23631e28",
    "0xa4506cebde82bde9",
    "0xbef9a3f7b2c67915",
    "0xc67178f2e372532b",
    "0xca273eceea26619c",
    "0xd186b8c721c0c207",
    "0xeada7dd6cde0eb1e",
    "0xf57d4f7fee6ed178",
    "0x06f067aa72176fba",
    "0x0a637dc5a2c898a6",
    "0x113f9804bef90dae",
    "0x1b710b35131c471b",
    "0x28db77f523047d84",
    "0x32caab7b40c72493",
    "0x3c9ebe0a15c9bebc",
    "0x431d67c49c100d4c",
    "0x4cc5d4becb3e42b6",
    "0x597f299cfc657e2a",
    "0x5fcb6fab3ad6faec",
    "0x6c44198c4a475817"
  ].map((n) => BigInt(n))))();
  var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
  var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
  var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
  var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
  var SHA512 = class extends HashMD {
    constructor(outputLen = 64) {
      super(128, outputLen, 16, false);
      this.Ah = SHA512_IV[0] | 0;
      this.Al = SHA512_IV[1] | 0;
      this.Bh = SHA512_IV[2] | 0;
      this.Bl = SHA512_IV[3] | 0;
      this.Ch = SHA512_IV[4] | 0;
      this.Cl = SHA512_IV[5] | 0;
      this.Dh = SHA512_IV[6] | 0;
      this.Dl = SHA512_IV[7] | 0;
      this.Eh = SHA512_IV[8] | 0;
      this.El = SHA512_IV[9] | 0;
      this.Fh = SHA512_IV[10] | 0;
      this.Fl = SHA512_IV[11] | 0;
      this.Gh = SHA512_IV[12] | 0;
      this.Gl = SHA512_IV[13] | 0;
      this.Hh = SHA512_IV[14] | 0;
      this.Hl = SHA512_IV[15] | 0;
    }
    // prettier-ignore
    get() {
      const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
    }
    // prettier-ignore
    set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
      this.Ah = Ah | 0;
      this.Al = Al | 0;
      this.Bh = Bh | 0;
      this.Bl = Bl | 0;
      this.Ch = Ch | 0;
      this.Cl = Cl | 0;
      this.Dh = Dh | 0;
      this.Dl = Dl | 0;
      this.Eh = Eh | 0;
      this.El = El | 0;
      this.Fh = Fh | 0;
      this.Fl = Fl | 0;
      this.Gh = Gh | 0;
      this.Gl = Gl | 0;
      this.Hh = Hh | 0;
      this.Hl = Hl | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4) {
        SHA512_W_H[i] = view.getUint32(offset);
        SHA512_W_L[i] = view.getUint32(offset += 4);
      }
      for (let i = 16; i < 80; i++) {
        const W15h = SHA512_W_H[i - 15] | 0;
        const W15l = SHA512_W_L[i - 15] | 0;
        const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
        const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
        const W2h = SHA512_W_H[i - 2] | 0;
        const W2l = SHA512_W_L[i - 2] | 0;
        const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
        const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
        const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
        const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
        SHA512_W_H[i] = SUMh | 0;
        SHA512_W_L[i] = SUMl | 0;
      }
      let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      for (let i = 0; i < 80; i++) {
        const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
        const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
        const CHIh = Eh & Fh ^ ~Eh & Gh;
        const CHIl = El & Fl ^ ~El & Gl;
        const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
        const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
        const T1l = T1ll | 0;
        const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
        const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
        const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
        const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
        Hh = Gh | 0;
        Hl = Gl | 0;
        Gh = Fh | 0;
        Gl = Fl | 0;
        Fh = Eh | 0;
        Fl = El | 0;
        ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
        Dh = Ch | 0;
        Dl = Cl | 0;
        Ch = Bh | 0;
        Cl = Bl | 0;
        Bh = Ah | 0;
        Bl = Al | 0;
        const All = add3L(T1l, sigma0l, MAJl);
        Ah = add3H(All, T1h, sigma0h, MAJh);
        Al = All | 0;
      }
      ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
      ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
      ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
      ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
      ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
      ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
      ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
      ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
      this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
    }
    roundClean() {
      clean(SHA512_W_H, SHA512_W_L);
    }
    destroy() {
      clean(this.buffer);
      this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  };
  var sha512 = /* @__PURE__ */ createHasher(() => new SHA512());

  // node_modules/@noble/curves/esm/utils.js
  var _0n = /* @__PURE__ */ BigInt(0);
  var _1n = /* @__PURE__ */ BigInt(1);
  function _abool2(value, title = "") {
    if (typeof value !== "boolean") {
      const prefix = title && `"${title}"`;
      throw new Error(prefix + "expected boolean, got type=" + typeof value);
    }
    return value;
  }
  function _abytes2(value, length, title = "") {
    const bytes = isBytes(value);
    const len = value?.length;
    const needsLen = length !== void 0;
    if (!bytes || needsLen && len !== length) {
      const prefix = title && `"${title}" `;
      const ofLen = needsLen ? ` of length ${length}` : "";
      const got = bytes ? `length=${len}` : `type=${typeof value}`;
      throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
    }
    return value;
  }
  function hexToNumber(hex) {
    if (typeof hex !== "string")
      throw new Error("hex string expected, got " + typeof hex);
    return hex === "" ? _0n : BigInt("0x" + hex);
  }
  function bytesToNumberBE(bytes) {
    return hexToNumber(bytesToHex(bytes));
  }
  function bytesToNumberLE(bytes) {
    abytes(bytes);
    return hexToNumber(bytesToHex(Uint8Array.from(bytes).reverse()));
  }
  function numberToBytesBE(n, len) {
    return hexToBytes(n.toString(16).padStart(len * 2, "0"));
  }
  function numberToBytesLE(n, len) {
    return numberToBytesBE(n, len).reverse();
  }
  function ensureBytes(title, hex, expectedLength) {
    let res;
    if (typeof hex === "string") {
      try {
        res = hexToBytes(hex);
      } catch (e) {
        throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
      }
    } else if (isBytes(hex)) {
      res = Uint8Array.from(hex);
    } else {
      throw new Error(title + " must be hex string or Uint8Array");
    }
    const len = res.length;
    if (typeof expectedLength === "number" && len !== expectedLength)
      throw new Error(title + " of length " + expectedLength + " expected, got " + len);
    return res;
  }
  function equalBytes(a, b) {
    if (a.length !== b.length)
      return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
      diff |= a[i] ^ b[i];
    return diff === 0;
  }
  function copyBytes(bytes) {
    return Uint8Array.from(bytes);
  }
  var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
  function inRange(n, min, max) {
    return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
  }
  function aInRange(title, n, min, max) {
    if (!inRange(n, min, max))
      throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
  }
  function bitLen(n) {
    let len;
    for (len = 0; n > _0n; n >>= _1n, len += 1)
      ;
    return len;
  }
  var bitMask = (n) => (_1n << BigInt(n)) - _1n;
  function _validateObject(object, fields, optFields = {}) {
    if (!object || typeof object !== "object")
      throw new Error("expected valid options object");
    function checkField(fieldName, expectedType, isOpt) {
      const val = object[fieldName];
      if (isOpt && val === void 0)
        return;
      const current = typeof val;
      if (current !== expectedType || val === null)
        throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
    }
    Object.entries(fields).forEach(([k, v]) => checkField(k, v, false));
    Object.entries(optFields).forEach(([k, v]) => checkField(k, v, true));
  }
  var notImplemented = () => {
    throw new Error("not implemented");
  };
  function memoized(fn) {
    const map2 = /* @__PURE__ */ new WeakMap();
    return (arg, ...args) => {
      const val = map2.get(arg);
      if (val !== void 0)
        return val;
      const computed = fn(arg, ...args);
      map2.set(arg, computed);
      return computed;
    };
  }

  // node_modules/@noble/curves/esm/abstract/modular.js
  var _0n2 = BigInt(0);
  var _1n2 = BigInt(1);
  var _2n = /* @__PURE__ */ BigInt(2);
  var _3n = /* @__PURE__ */ BigInt(3);
  var _4n = /* @__PURE__ */ BigInt(4);
  var _5n = /* @__PURE__ */ BigInt(5);
  var _7n = /* @__PURE__ */ BigInt(7);
  var _8n = /* @__PURE__ */ BigInt(8);
  var _9n = /* @__PURE__ */ BigInt(9);
  var _16n = /* @__PURE__ */ BigInt(16);
  function mod(a, b) {
    const result = a % b;
    return result >= _0n2 ? result : b + result;
  }
  function pow2(x, power, modulo) {
    let res = x;
    while (power-- > _0n2) {
      res *= res;
      res %= modulo;
    }
    return res;
  }
  function invert(number, modulo) {
    if (number === _0n2)
      throw new Error("invert: expected non-zero number");
    if (modulo <= _0n2)
      throw new Error("invert: expected positive modulus, got " + modulo);
    let a = mod(number, modulo);
    let b = modulo;
    let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
    while (a !== _0n2) {
      const q = b / a;
      const r = b % a;
      const m = x - u * q;
      const n = y - v * q;
      b = a, a = r, x = u, y = v, u = m, v = n;
    }
    const gcd = b;
    if (gcd !== _1n2)
      throw new Error("invert: does not exist");
    return mod(x, modulo);
  }
  function assertIsSquare(Fp2, root, n) {
    if (!Fp2.eql(Fp2.sqr(root), n))
      throw new Error("Cannot find square root");
  }
  function sqrt3mod4(Fp2, n) {
    const p1div4 = (Fp2.ORDER + _1n2) / _4n;
    const root = Fp2.pow(n, p1div4);
    assertIsSquare(Fp2, root, n);
    return root;
  }
  function sqrt5mod8(Fp2, n) {
    const p5div8 = (Fp2.ORDER - _5n) / _8n;
    const n2 = Fp2.mul(n, _2n);
    const v = Fp2.pow(n2, p5div8);
    const nv = Fp2.mul(n, v);
    const i = Fp2.mul(Fp2.mul(nv, _2n), v);
    const root = Fp2.mul(nv, Fp2.sub(i, Fp2.ONE));
    assertIsSquare(Fp2, root, n);
    return root;
  }
  function sqrt9mod16(P) {
    const Fp_ = Field(P);
    const tn = tonelliShanks(P);
    const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
    const c2 = tn(Fp_, c1);
    const c3 = tn(Fp_, Fp_.neg(c1));
    const c4 = (P + _7n) / _16n;
    return (Fp2, n) => {
      let tv1 = Fp2.pow(n, c4);
      let tv2 = Fp2.mul(tv1, c1);
      const tv3 = Fp2.mul(tv1, c2);
      const tv4 = Fp2.mul(tv1, c3);
      const e1 = Fp2.eql(Fp2.sqr(tv2), n);
      const e2 = Fp2.eql(Fp2.sqr(tv3), n);
      tv1 = Fp2.cmov(tv1, tv2, e1);
      tv2 = Fp2.cmov(tv4, tv3, e2);
      const e3 = Fp2.eql(Fp2.sqr(tv2), n);
      const root = Fp2.cmov(tv1, tv2, e3);
      assertIsSquare(Fp2, root, n);
      return root;
    };
  }
  function tonelliShanks(P) {
    if (P < _3n)
      throw new Error("sqrt is not defined for small field");
    let Q = P - _1n2;
    let S = 0;
    while (Q % _2n === _0n2) {
      Q /= _2n;
      S++;
    }
    let Z = _2n;
    const _Fp = Field(P);
    while (FpLegendre(_Fp, Z) === 1) {
      if (Z++ > 1e3)
        throw new Error("Cannot find square root: probably non-prime P");
    }
    if (S === 1)
      return sqrt3mod4;
    let cc = _Fp.pow(Z, Q);
    const Q1div2 = (Q + _1n2) / _2n;
    return function tonelliSlow(Fp2, n) {
      if (Fp2.is0(n))
        return n;
      if (FpLegendre(Fp2, n) !== 1)
        throw new Error("Cannot find square root");
      let M = S;
      let c = Fp2.mul(Fp2.ONE, cc);
      let t = Fp2.pow(n, Q);
      let R = Fp2.pow(n, Q1div2);
      while (!Fp2.eql(t, Fp2.ONE)) {
        if (Fp2.is0(t))
          return Fp2.ZERO;
        let i = 1;
        let t_tmp = Fp2.sqr(t);
        while (!Fp2.eql(t_tmp, Fp2.ONE)) {
          i++;
          t_tmp = Fp2.sqr(t_tmp);
          if (i === M)
            throw new Error("Cannot find square root");
        }
        const exponent = _1n2 << BigInt(M - i - 1);
        const b = Fp2.pow(c, exponent);
        M = i;
        c = Fp2.sqr(b);
        t = Fp2.mul(t, c);
        R = Fp2.mul(R, b);
      }
      return R;
    };
  }
  function FpSqrt(P) {
    if (P % _4n === _3n)
      return sqrt3mod4;
    if (P % _8n === _5n)
      return sqrt5mod8;
    if (P % _16n === _9n)
      return sqrt9mod16(P);
    return tonelliShanks(P);
  }
  var isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2;
  var FIELD_FIELDS = [
    "create",
    "isValid",
    "is0",
    "neg",
    "inv",
    "sqrt",
    "sqr",
    "eql",
    "add",
    "sub",
    "mul",
    "pow",
    "div",
    "addN",
    "subN",
    "mulN",
    "sqrN"
  ];
  function validateField(field) {
    const initial = {
      ORDER: "bigint",
      MASK: "bigint",
      BYTES: "number",
      BITS: "number"
    };
    const opts = FIELD_FIELDS.reduce((map2, val) => {
      map2[val] = "function";
      return map2;
    }, initial);
    _validateObject(field, opts);
    return field;
  }
  function FpPow(Fp2, num, power) {
    if (power < _0n2)
      throw new Error("invalid exponent, negatives unsupported");
    if (power === _0n2)
      return Fp2.ONE;
    if (power === _1n2)
      return num;
    let p = Fp2.ONE;
    let d = num;
    while (power > _0n2) {
      if (power & _1n2)
        p = Fp2.mul(p, d);
      d = Fp2.sqr(d);
      power >>= _1n2;
    }
    return p;
  }
  function FpInvertBatch(Fp2, nums, passZero = false) {
    const inverted = new Array(nums.length).fill(passZero ? Fp2.ZERO : void 0);
    const multipliedAcc = nums.reduce((acc, num, i) => {
      if (Fp2.is0(num))
        return acc;
      inverted[i] = acc;
      return Fp2.mul(acc, num);
    }, Fp2.ONE);
    const invertedAcc = Fp2.inv(multipliedAcc);
    nums.reduceRight((acc, num, i) => {
      if (Fp2.is0(num))
        return acc;
      inverted[i] = Fp2.mul(acc, inverted[i]);
      return Fp2.mul(acc, num);
    }, invertedAcc);
    return inverted;
  }
  function FpLegendre(Fp2, n) {
    const p1mod2 = (Fp2.ORDER - _1n2) / _2n;
    const powered = Fp2.pow(n, p1mod2);
    const yes = Fp2.eql(powered, Fp2.ONE);
    const zero = Fp2.eql(powered, Fp2.ZERO);
    const no = Fp2.eql(powered, Fp2.neg(Fp2.ONE));
    if (!yes && !zero && !no)
      throw new Error("invalid Legendre symbol result");
    return yes ? 1 : zero ? 0 : -1;
  }
  function nLength(n, nBitLength) {
    if (nBitLength !== void 0)
      anumber(nBitLength);
    const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
    const nByteLength = Math.ceil(_nBitLength / 8);
    return { nBitLength: _nBitLength, nByteLength };
  }
  function Field(ORDER, bitLenOrOpts, isLE2 = false, opts = {}) {
    if (ORDER <= _0n2)
      throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
    let _nbitLength = void 0;
    let _sqrt = void 0;
    let modFromBytes = false;
    let allowedLengths = void 0;
    if (typeof bitLenOrOpts === "object" && bitLenOrOpts != null) {
      if (opts.sqrt || isLE2)
        throw new Error("cannot specify opts in two arguments");
      const _opts = bitLenOrOpts;
      if (_opts.BITS)
        _nbitLength = _opts.BITS;
      if (_opts.sqrt)
        _sqrt = _opts.sqrt;
      if (typeof _opts.isLE === "boolean")
        isLE2 = _opts.isLE;
      if (typeof _opts.modFromBytes === "boolean")
        modFromBytes = _opts.modFromBytes;
      allowedLengths = _opts.allowedLengths;
    } else {
      if (typeof bitLenOrOpts === "number")
        _nbitLength = bitLenOrOpts;
      if (opts.sqrt)
        _sqrt = opts.sqrt;
    }
    const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, _nbitLength);
    if (BYTES > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    let sqrtP;
    const f = Object.freeze({
      ORDER,
      isLE: isLE2,
      BITS,
      BYTES,
      MASK: bitMask(BITS),
      ZERO: _0n2,
      ONE: _1n2,
      allowedLengths,
      create: (num) => mod(num, ORDER),
      isValid: (num) => {
        if (typeof num !== "bigint")
          throw new Error("invalid field element: expected bigint, got " + typeof num);
        return _0n2 <= num && num < ORDER;
      },
      is0: (num) => num === _0n2,
      // is valid and invertible
      isValidNot0: (num) => !f.is0(num) && f.isValid(num),
      isOdd: (num) => (num & _1n2) === _1n2,
      neg: (num) => mod(-num, ORDER),
      eql: (lhs, rhs) => lhs === rhs,
      sqr: (num) => mod(num * num, ORDER),
      add: (lhs, rhs) => mod(lhs + rhs, ORDER),
      sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
      mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
      pow: (num, power) => FpPow(f, num, power),
      div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
      // Same as above, but doesn't normalize
      sqrN: (num) => num * num,
      addN: (lhs, rhs) => lhs + rhs,
      subN: (lhs, rhs) => lhs - rhs,
      mulN: (lhs, rhs) => lhs * rhs,
      inv: (num) => invert(num, ORDER),
      sqrt: _sqrt || ((n) => {
        if (!sqrtP)
          sqrtP = FpSqrt(ORDER);
        return sqrtP(f, n);
      }),
      toBytes: (num) => isLE2 ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES),
      fromBytes: (bytes, skipValidation = true) => {
        if (allowedLengths) {
          if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
            throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
          }
          const padded = new Uint8Array(BYTES);
          padded.set(bytes, isLE2 ? 0 : padded.length - bytes.length);
          bytes = padded;
        }
        if (bytes.length !== BYTES)
          throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
        let scalar = isLE2 ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
        if (modFromBytes)
          scalar = mod(scalar, ORDER);
        if (!skipValidation) {
          if (!f.isValid(scalar))
            throw new Error("invalid field element: outside of range 0..ORDER");
        }
        return scalar;
      },
      // TODO: we don't need it here, move out to separate fn
      invertBatch: (lst) => FpInvertBatch(f, lst),
      // We can't move this out because Fp6, Fp12 implement it
      // and it's unclear what to return in there.
      cmov: (a, b, c) => c ? b : a
    });
    return Object.freeze(f);
  }

  // node_modules/@noble/curves/esm/abstract/curve.js
  var _0n3 = BigInt(0);
  var _1n3 = BigInt(1);
  function negateCt(condition, item) {
    const neg = item.negate();
    return condition ? neg : item;
  }
  function normalizeZ(c, points) {
    const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
    return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
  }
  function validateW(W, bits) {
    if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
      throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
  }
  function calcWOpts(W, scalarBits) {
    validateW(W, scalarBits);
    const windows = Math.ceil(scalarBits / W) + 1;
    const windowSize = 2 ** (W - 1);
    const maxNumber = 2 ** W;
    const mask = bitMask(W);
    const shiftBy = BigInt(W);
    return { windows, windowSize, mask, maxNumber, shiftBy };
  }
  function calcOffsets(n, window, wOpts) {
    const { windowSize, mask, maxNumber, shiftBy } = wOpts;
    let wbits = Number(n & mask);
    let nextN = n >> shiftBy;
    if (wbits > windowSize) {
      wbits -= maxNumber;
      nextN += _1n3;
    }
    const offsetStart = window * windowSize;
    const offset = offsetStart + Math.abs(wbits) - 1;
    const isZero = wbits === 0;
    const isNeg = wbits < 0;
    const isNegF = window % 2 !== 0;
    const offsetF = offsetStart;
    return { nextN, offset, isZero, isNeg, isNegF, offsetF };
  }
  function validateMSMPoints(points, c) {
    if (!Array.isArray(points))
      throw new Error("array expected");
    points.forEach((p, i) => {
      if (!(p instanceof c))
        throw new Error("invalid point at index " + i);
    });
  }
  function validateMSMScalars(scalars, field) {
    if (!Array.isArray(scalars))
      throw new Error("array of scalars expected");
    scalars.forEach((s, i) => {
      if (!field.isValid(s))
        throw new Error("invalid scalar at index " + i);
    });
  }
  var pointPrecomputes = /* @__PURE__ */ new WeakMap();
  var pointWindowSizes = /* @__PURE__ */ new WeakMap();
  function getW(P) {
    return pointWindowSizes.get(P) || 1;
  }
  function assert0(n) {
    if (n !== _0n3)
      throw new Error("invalid wNAF");
  }
  var wNAF = class {
    // Parametrized with a given Point class (not individual point)
    constructor(Point, bits) {
      this.BASE = Point.BASE;
      this.ZERO = Point.ZERO;
      this.Fn = Point.Fn;
      this.bits = bits;
    }
    // non-const time multiplication ladder
    _unsafeLadder(elm, n, p = this.ZERO) {
      let d = elm;
      while (n > _0n3) {
        if (n & _1n3)
          p = p.add(d);
        d = d.double();
        n >>= _1n3;
      }
      return p;
    }
    /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param point Point instance
     * @param W window size
     * @returns precomputed point tables flattened to a single array
     */
    precomputeWindow(point, W) {
      const { windows, windowSize } = calcWOpts(W, this.bits);
      const points = [];
      let p = point;
      let base = p;
      for (let window = 0; window < windows; window++) {
        base = p;
        points.push(base);
        for (let i = 1; i < windowSize; i++) {
          base = base.add(p);
          points.push(base);
        }
        p = base.double();
      }
      return points;
    }
    /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * More compact implementation:
     * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
     * @returns real and fake (for const-time) points
     */
    wNAF(W, precomputes, n) {
      if (!this.Fn.isValid(n))
        throw new Error("invalid scalar");
      let p = this.ZERO;
      let f = this.BASE;
      const wo = calcWOpts(W, this.bits);
      for (let window = 0; window < wo.windows; window++) {
        const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
        n = nextN;
        if (isZero) {
          f = f.add(negateCt(isNegF, precomputes[offsetF]));
        } else {
          p = p.add(negateCt(isNeg, precomputes[offset]));
        }
      }
      assert0(n);
      return { p, f };
    }
    /**
     * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
     * @param acc accumulator point to add result of multiplication
     * @returns point
     */
    wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
      const wo = calcWOpts(W, this.bits);
      for (let window = 0; window < wo.windows; window++) {
        if (n === _0n3)
          break;
        const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
        n = nextN;
        if (isZero) {
          continue;
        } else {
          const item = precomputes[offset];
          acc = acc.add(isNeg ? item.negate() : item);
        }
      }
      assert0(n);
      return acc;
    }
    getPrecomputes(W, point, transform) {
      let comp = pointPrecomputes.get(point);
      if (!comp) {
        comp = this.precomputeWindow(point, W);
        if (W !== 1) {
          if (typeof transform === "function")
            comp = transform(comp);
          pointPrecomputes.set(point, comp);
        }
      }
      return comp;
    }
    cached(point, scalar, transform) {
      const W = getW(point);
      return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
    }
    unsafe(point, scalar, transform, prev) {
      const W = getW(point);
      if (W === 1)
        return this._unsafeLadder(point, scalar, prev);
      return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
    }
    // We calculate precomputes for elliptic curve point multiplication
    // using windowed method. This specifies window size and
    // stores precomputed values. Usually only base point would be precomputed.
    createCache(P, W) {
      validateW(W, this.bits);
      pointWindowSizes.set(P, W);
      pointPrecomputes.delete(P);
    }
    hasCache(elm) {
      return getW(elm) !== 1;
    }
  };
  function pippenger(c, fieldN, points, scalars) {
    validateMSMPoints(points, c);
    validateMSMScalars(scalars, fieldN);
    const plength = points.length;
    const slength = scalars.length;
    if (plength !== slength)
      throw new Error("arrays of points and scalars must have equal length");
    const zero = c.ZERO;
    const wbits = bitLen(BigInt(plength));
    let windowSize = 1;
    if (wbits > 12)
      windowSize = wbits - 3;
    else if (wbits > 4)
      windowSize = wbits - 2;
    else if (wbits > 0)
      windowSize = 2;
    const MASK = bitMask(windowSize);
    const buckets = new Array(Number(MASK) + 1).fill(zero);
    const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
    let sum = zero;
    for (let i = lastBits; i >= 0; i -= windowSize) {
      buckets.fill(zero);
      for (let j = 0; j < slength; j++) {
        const scalar = scalars[j];
        const wbits2 = Number(scalar >> BigInt(i) & MASK);
        buckets[wbits2] = buckets[wbits2].add(points[j]);
      }
      let resI = zero;
      for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
        sumI = sumI.add(buckets[j]);
        resI = resI.add(sumI);
      }
      sum = sum.add(resI);
      if (i !== 0)
        for (let j = 0; j < windowSize; j++)
          sum = sum.double();
    }
    return sum;
  }
  function createField(order, field, isLE2) {
    if (field) {
      if (field.ORDER !== order)
        throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
      validateField(field);
      return field;
    } else {
      return Field(order, { isLE: isLE2 });
    }
  }
  function _createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
    if (FpFnLE === void 0)
      FpFnLE = type === "edwards";
    if (!CURVE || typeof CURVE !== "object")
      throw new Error(`expected valid ${type} CURVE object`);
    for (const p of ["p", "n", "h"]) {
      const val = CURVE[p];
      if (!(typeof val === "bigint" && val > _0n3))
        throw new Error(`CURVE.${p} must be positive bigint`);
    }
    const Fp2 = createField(CURVE.p, curveOpts.Fp, FpFnLE);
    const Fn2 = createField(CURVE.n, curveOpts.Fn, FpFnLE);
    const _b = type === "weierstrass" ? "b" : "d";
    const params = ["Gx", "Gy", "a", _b];
    for (const p of params) {
      if (!Fp2.isValid(CURVE[p]))
        throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
    }
    CURVE = Object.freeze(Object.assign({}, CURVE));
    return { CURVE, Fp: Fp2, Fn: Fn2 };
  }

  // node_modules/@noble/curves/esm/abstract/edwards.js
  var _0n4 = BigInt(0);
  var _1n4 = BigInt(1);
  var _2n2 = BigInt(2);
  var _8n2 = BigInt(8);
  function isEdValidXY(Fp2, CURVE, x, y) {
    const x2 = Fp2.sqr(x);
    const y2 = Fp2.sqr(y);
    const left = Fp2.add(Fp2.mul(CURVE.a, x2), y2);
    const right = Fp2.add(Fp2.ONE, Fp2.mul(CURVE.d, Fp2.mul(x2, y2)));
    return Fp2.eql(left, right);
  }
  function edwards(params, extraOpts = {}) {
    const validated = _createCurveFields("edwards", params, extraOpts, extraOpts.FpFnLE);
    const { Fp: Fp2, Fn: Fn2 } = validated;
    let CURVE = validated.CURVE;
    const { h: cofactor } = CURVE;
    _validateObject(extraOpts, {}, { uvRatio: "function" });
    const MASK = _2n2 << BigInt(Fn2.BYTES * 8) - _1n4;
    const modP = (n) => Fp2.create(n);
    const uvRatio2 = extraOpts.uvRatio || ((u, v) => {
      try {
        return { isValid: true, value: Fp2.sqrt(Fp2.div(u, v)) };
      } catch (e) {
        return { isValid: false, value: _0n4 };
      }
    });
    if (!isEdValidXY(Fp2, CURVE, CURVE.Gx, CURVE.Gy))
      throw new Error("bad curve params: generator point");
    function acoord(title, n, banZero = false) {
      const min = banZero ? _1n4 : _0n4;
      aInRange("coordinate " + title, n, min, MASK);
      return n;
    }
    function aextpoint(other) {
      if (!(other instanceof Point))
        throw new Error("ExtendedPoint expected");
    }
    const toAffineMemo = memoized((p, iz) => {
      const { X, Y, Z } = p;
      const is0 = p.is0();
      if (iz == null)
        iz = is0 ? _8n2 : Fp2.inv(Z);
      const x = modP(X * iz);
      const y = modP(Y * iz);
      const zz = Fp2.mul(Z, iz);
      if (is0)
        return { x: _0n4, y: _1n4 };
      if (zz !== _1n4)
        throw new Error("invZ was invalid");
      return { x, y };
    });
    const assertValidMemo = memoized((p) => {
      const { a, d } = CURVE;
      if (p.is0())
        throw new Error("bad point: ZERO");
      const { X, Y, Z, T } = p;
      const X2 = modP(X * X);
      const Y2 = modP(Y * Y);
      const Z2 = modP(Z * Z);
      const Z4 = modP(Z2 * Z2);
      const aX2 = modP(X2 * a);
      const left = modP(Z2 * modP(aX2 + Y2));
      const right = modP(Z4 + modP(d * modP(X2 * Y2)));
      if (left !== right)
        throw new Error("bad point: equation left != right (1)");
      const XY = modP(X * Y);
      const ZT = modP(Z * T);
      if (XY !== ZT)
        throw new Error("bad point: equation left != right (2)");
      return true;
    });
    class Point {
      constructor(X, Y, Z, T) {
        this.X = acoord("x", X);
        this.Y = acoord("y", Y);
        this.Z = acoord("z", Z, true);
        this.T = acoord("t", T);
        Object.freeze(this);
      }
      static CURVE() {
        return CURVE;
      }
      static fromAffine(p) {
        if (p instanceof Point)
          throw new Error("extended point not allowed");
        const { x, y } = p || {};
        acoord("x", x);
        acoord("y", y);
        return new Point(x, y, _1n4, modP(x * y));
      }
      // Uses algo from RFC8032 5.1.3.
      static fromBytes(bytes, zip215 = false) {
        const len = Fp2.BYTES;
        const { a, d } = CURVE;
        bytes = copyBytes(_abytes2(bytes, len, "point"));
        _abool2(zip215, "zip215");
        const normed = copyBytes(bytes);
        const lastByte = bytes[len - 1];
        normed[len - 1] = lastByte & ~128;
        const y = bytesToNumberLE(normed);
        const max = zip215 ? MASK : Fp2.ORDER;
        aInRange("point.y", y, _0n4, max);
        const y2 = modP(y * y);
        const u = modP(y2 - _1n4);
        const v = modP(d * y2 - a);
        let { isValid, value: x } = uvRatio2(u, v);
        if (!isValid)
          throw new Error("bad point: invalid y coordinate");
        const isXOdd = (x & _1n4) === _1n4;
        const isLastByteOdd = (lastByte & 128) !== 0;
        if (!zip215 && x === _0n4 && isLastByteOdd)
          throw new Error("bad point: x=0 and x_0=1");
        if (isLastByteOdd !== isXOdd)
          x = modP(-x);
        return Point.fromAffine({ x, y });
      }
      static fromHex(bytes, zip215 = false) {
        return Point.fromBytes(ensureBytes("point", bytes), zip215);
      }
      get x() {
        return this.toAffine().x;
      }
      get y() {
        return this.toAffine().y;
      }
      precompute(windowSize = 8, isLazy = true) {
        wnaf.createCache(this, windowSize);
        if (!isLazy)
          this.multiply(_2n2);
        return this;
      }
      // Useful in fromAffine() - not for fromBytes(), which always created valid points.
      assertValidity() {
        assertValidMemo(this);
      }
      // Compare one point to another.
      equals(other) {
        aextpoint(other);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const { X: X2, Y: Y2, Z: Z2 } = other;
        const X1Z2 = modP(X1 * Z2);
        const X2Z1 = modP(X2 * Z1);
        const Y1Z2 = modP(Y1 * Z2);
        const Y2Z1 = modP(Y2 * Z1);
        return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
      }
      is0() {
        return this.equals(Point.ZERO);
      }
      negate() {
        return new Point(modP(-this.X), this.Y, this.Z, modP(-this.T));
      }
      // Fast algo for doubling Extended Point.
      // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
      // Cost: 4M + 4S + 1*a + 6add + 1*2.
      double() {
        const { a } = CURVE;
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const A2 = modP(X1 * X1);
        const B2 = modP(Y1 * Y1);
        const C = modP(_2n2 * modP(Z1 * Z1));
        const D = modP(a * A2);
        const x1y1 = X1 + Y1;
        const E = modP(modP(x1y1 * x1y1) - A2 - B2);
        const G = D + B2;
        const F = G - C;
        const H = D - B2;
        const X3 = modP(E * F);
        const Y3 = modP(G * H);
        const T3 = modP(E * H);
        const Z3 = modP(F * G);
        return new Point(X3, Y3, Z3, T3);
      }
      // Fast algo for adding 2 Extended Points.
      // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
      // Cost: 9M + 1*a + 1*d + 7add.
      add(other) {
        aextpoint(other);
        const { a, d } = CURVE;
        const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
        const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
        const A2 = modP(X1 * X2);
        const B2 = modP(Y1 * Y2);
        const C = modP(T1 * d * T2);
        const D = modP(Z1 * Z2);
        const E = modP((X1 + Y1) * (X2 + Y2) - A2 - B2);
        const F = D - C;
        const G = D + C;
        const H = modP(B2 - a * A2);
        const X3 = modP(E * F);
        const Y3 = modP(G * H);
        const T3 = modP(E * H);
        const Z3 = modP(F * G);
        return new Point(X3, Y3, Z3, T3);
      }
      subtract(other) {
        return this.add(other.negate());
      }
      // Constant-time multiplication.
      multiply(scalar) {
        if (!Fn2.isValidNot0(scalar))
          throw new Error("invalid scalar: expected 1 <= sc < curve.n");
        const { p, f } = wnaf.cached(this, scalar, (p2) => normalizeZ(Point, p2));
        return normalizeZ(Point, [p, f])[0];
      }
      // Non-constant-time multiplication. Uses double-and-add algorithm.
      // It's faster, but should only be used when you don't care about
      // an exposed private key e.g. sig verification.
      // Does NOT allow scalars higher than CURVE.n.
      // Accepts optional accumulator to merge with multiply (important for sparse scalars)
      multiplyUnsafe(scalar, acc = Point.ZERO) {
        if (!Fn2.isValid(scalar))
          throw new Error("invalid scalar: expected 0 <= sc < curve.n");
        if (scalar === _0n4)
          return Point.ZERO;
        if (this.is0() || scalar === _1n4)
          return this;
        return wnaf.unsafe(this, scalar, (p) => normalizeZ(Point, p), acc);
      }
      // Checks if point is of small order.
      // If you add something to small order point, you will have "dirty"
      // point with torsion component.
      // Multiplies point by cofactor and checks if the result is 0.
      isSmallOrder() {
        return this.multiplyUnsafe(cofactor).is0();
      }
      // Multiplies point by curve order and checks if the result is 0.
      // Returns `false` is the point is dirty.
      isTorsionFree() {
        return wnaf.unsafe(this, CURVE.n).is0();
      }
      // Converts Extended point to default (x, y) coordinates.
      // Can accept precomputed Z^-1 - for example, from invertBatch.
      toAffine(invertedZ) {
        return toAffineMemo(this, invertedZ);
      }
      clearCofactor() {
        if (cofactor === _1n4)
          return this;
        return this.multiplyUnsafe(cofactor);
      }
      toBytes() {
        const { x, y } = this.toAffine();
        const bytes = Fp2.toBytes(y);
        bytes[bytes.length - 1] |= x & _1n4 ? 128 : 0;
        return bytes;
      }
      toHex() {
        return bytesToHex(this.toBytes());
      }
      toString() {
        return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
      }
      // TODO: remove
      get ex() {
        return this.X;
      }
      get ey() {
        return this.Y;
      }
      get ez() {
        return this.Z;
      }
      get et() {
        return this.T;
      }
      static normalizeZ(points) {
        return normalizeZ(Point, points);
      }
      static msm(points, scalars) {
        return pippenger(Point, Fn2, points, scalars);
      }
      _setWindowSize(windowSize) {
        this.precompute(windowSize);
      }
      toRawBytes() {
        return this.toBytes();
      }
    }
    Point.BASE = new Point(CURVE.Gx, CURVE.Gy, _1n4, modP(CURVE.Gx * CURVE.Gy));
    Point.ZERO = new Point(_0n4, _1n4, _1n4, _0n4);
    Point.Fp = Fp2;
    Point.Fn = Fn2;
    const wnaf = new wNAF(Point, Fn2.BITS);
    Point.BASE.precompute(8);
    return Point;
  }
  var PrimeEdwardsPoint = class {
    constructor(ep) {
      this.ep = ep;
    }
    // Static methods that must be implemented by subclasses
    static fromBytes(_bytes) {
      notImplemented();
    }
    static fromHex(_hex) {
      notImplemented();
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    // Common implementations
    clearCofactor() {
      return this;
    }
    assertValidity() {
      this.ep.assertValidity();
    }
    toAffine(invertedZ) {
      return this.ep.toAffine(invertedZ);
    }
    toHex() {
      return bytesToHex(this.toBytes());
    }
    toString() {
      return this.toHex();
    }
    isTorsionFree() {
      return true;
    }
    isSmallOrder() {
      return false;
    }
    add(other) {
      this.assertSame(other);
      return this.init(this.ep.add(other.ep));
    }
    subtract(other) {
      this.assertSame(other);
      return this.init(this.ep.subtract(other.ep));
    }
    multiply(scalar) {
      return this.init(this.ep.multiply(scalar));
    }
    multiplyUnsafe(scalar) {
      return this.init(this.ep.multiplyUnsafe(scalar));
    }
    double() {
      return this.init(this.ep.double());
    }
    negate() {
      return this.init(this.ep.negate());
    }
    precompute(windowSize, isLazy) {
      return this.init(this.ep.precompute(windowSize, isLazy));
    }
    /** @deprecated use `toBytes` */
    toRawBytes() {
      return this.toBytes();
    }
  };
  function eddsa(Point, cHash, eddsaOpts = {}) {
    if (typeof cHash !== "function")
      throw new Error('"hash" function param is required');
    _validateObject(eddsaOpts, {}, {
      adjustScalarBytes: "function",
      randomBytes: "function",
      domain: "function",
      prehash: "function",
      mapToCurve: "function"
    });
    const { prehash } = eddsaOpts;
    const { BASE, Fp: Fp2, Fn: Fn2 } = Point;
    const randomBytes2 = eddsaOpts.randomBytes || randomBytes;
    const adjustScalarBytes2 = eddsaOpts.adjustScalarBytes || ((bytes) => bytes);
    const domain = eddsaOpts.domain || ((data, ctx, phflag) => {
      _abool2(phflag, "phflag");
      if (ctx.length || phflag)
        throw new Error("Contexts/pre-hash are not supported");
      return data;
    });
    function modN_LE(hash) {
      return Fn2.create(bytesToNumberLE(hash));
    }
    function getPrivateScalar(key) {
      const len = lengths.secretKey;
      key = ensureBytes("private key", key, len);
      const hashed = ensureBytes("hashed private key", cHash(key), 2 * len);
      const head = adjustScalarBytes2(hashed.slice(0, len));
      const prefix = hashed.slice(len, 2 * len);
      const scalar = modN_LE(head);
      return { head, prefix, scalar };
    }
    function getExtendedPublicKey(secretKey) {
      const { head, prefix, scalar } = getPrivateScalar(secretKey);
      const point = BASE.multiply(scalar);
      const pointBytes = point.toBytes();
      return { head, prefix, scalar, point, pointBytes };
    }
    function getPublicKey(secretKey) {
      return getExtendedPublicKey(secretKey).pointBytes;
    }
    function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
      const msg = concatBytes(...msgs);
      return modN_LE(cHash(domain(msg, ensureBytes("context", context), !!prehash)));
    }
    function sign(msg, secretKey, options = {}) {
      msg = ensureBytes("message", msg);
      if (prehash)
        msg = prehash(msg);
      const { prefix, scalar, pointBytes } = getExtendedPublicKey(secretKey);
      const r = hashDomainToScalar(options.context, prefix, msg);
      const R = BASE.multiply(r).toBytes();
      const k = hashDomainToScalar(options.context, R, pointBytes, msg);
      const s = Fn2.create(r + k * scalar);
      if (!Fn2.isValid(s))
        throw new Error("sign failed: invalid s");
      const rs = concatBytes(R, Fn2.toBytes(s));
      return _abytes2(rs, lengths.signature, "result");
    }
    const verifyOpts = { zip215: true };
    function verify(sig, msg, publicKey, options = verifyOpts) {
      const { context, zip215 } = options;
      const len = lengths.signature;
      sig = ensureBytes("signature", sig, len);
      msg = ensureBytes("message", msg);
      publicKey = ensureBytes("publicKey", publicKey, lengths.publicKey);
      if (zip215 !== void 0)
        _abool2(zip215, "zip215");
      if (prehash)
        msg = prehash(msg);
      const mid = len / 2;
      const r = sig.subarray(0, mid);
      const s = bytesToNumberLE(sig.subarray(mid, len));
      let A2, R, SB;
      try {
        A2 = Point.fromBytes(publicKey, zip215);
        R = Point.fromBytes(r, zip215);
        SB = BASE.multiplyUnsafe(s);
      } catch (error) {
        return false;
      }
      if (!zip215 && A2.isSmallOrder())
        return false;
      const k = hashDomainToScalar(context, R.toBytes(), A2.toBytes(), msg);
      const RkA = R.add(A2.multiplyUnsafe(k));
      return RkA.subtract(SB).clearCofactor().is0();
    }
    const _size = Fp2.BYTES;
    const lengths = {
      secretKey: _size,
      publicKey: _size,
      signature: 2 * _size,
      seed: _size
    };
    function randomSecretKey(seed = randomBytes2(lengths.seed)) {
      return _abytes2(seed, lengths.seed, "seed");
    }
    function keygen(seed) {
      const secretKey = utils.randomSecretKey(seed);
      return { secretKey, publicKey: getPublicKey(secretKey) };
    }
    function isValidSecretKey(key) {
      return isBytes(key) && key.length === Fn2.BYTES;
    }
    function isValidPublicKey(key, zip215) {
      try {
        return !!Point.fromBytes(key, zip215);
      } catch (error) {
        return false;
      }
    }
    const utils = {
      getExtendedPublicKey,
      randomSecretKey,
      isValidSecretKey,
      isValidPublicKey,
      /**
       * Converts ed public key to x public key. Uses formula:
       * - ed25519:
       *   - `(u, v) = ((1+y)/(1-y), sqrt(-486664)*u/x)`
       *   - `(x, y) = (sqrt(-486664)*u/v, (u-1)/(u+1))`
       * - ed448:
       *   - `(u, v) = ((y-1)/(y+1), sqrt(156324)*u/x)`
       *   - `(x, y) = (sqrt(156324)*u/v, (1+u)/(1-u))`
       */
      toMontgomery(publicKey) {
        const { y } = Point.fromBytes(publicKey);
        const size = lengths.publicKey;
        const is25519 = size === 32;
        if (!is25519 && size !== 57)
          throw new Error("only defined for 25519 and 448");
        const u = is25519 ? Fp2.div(_1n4 + y, _1n4 - y) : Fp2.div(y - _1n4, y + _1n4);
        return Fp2.toBytes(u);
      },
      toMontgomerySecret(secretKey) {
        const size = lengths.secretKey;
        _abytes2(secretKey, size);
        const hashed = cHash(secretKey.subarray(0, size));
        return adjustScalarBytes2(hashed).subarray(0, size);
      },
      /** @deprecated */
      randomPrivateKey: randomSecretKey,
      /** @deprecated */
      precompute(windowSize = 8, point = Point.BASE) {
        return point.precompute(windowSize, false);
      }
    };
    return Object.freeze({
      keygen,
      getPublicKey,
      sign,
      verify,
      utils,
      Point,
      lengths
    });
  }
  function _eddsa_legacy_opts_to_new(c) {
    const CURVE = {
      a: c.a,
      d: c.d,
      p: c.Fp.ORDER,
      n: c.n,
      h: c.h,
      Gx: c.Gx,
      Gy: c.Gy
    };
    const Fp2 = c.Fp;
    const Fn2 = Field(CURVE.n, c.nBitLength, true);
    const curveOpts = { Fp: Fp2, Fn: Fn2, uvRatio: c.uvRatio };
    const eddsaOpts = {
      randomBytes: c.randomBytes,
      adjustScalarBytes: c.adjustScalarBytes,
      domain: c.domain,
      prehash: c.prehash,
      mapToCurve: c.mapToCurve
    };
    return { CURVE, curveOpts, hash: c.hash, eddsaOpts };
  }
  function _eddsa_new_output_to_legacy(c, eddsa2) {
    const Point = eddsa2.Point;
    const legacy = Object.assign({}, eddsa2, {
      ExtendedPoint: Point,
      CURVE: c,
      nBitLength: Point.Fn.BITS,
      nByteLength: Point.Fn.BYTES
    });
    return legacy;
  }
  function twistedEdwards(c) {
    const { CURVE, curveOpts, hash, eddsaOpts } = _eddsa_legacy_opts_to_new(c);
    const Point = edwards(CURVE, curveOpts);
    const EDDSA = eddsa(Point, hash, eddsaOpts);
    return _eddsa_new_output_to_legacy(c, EDDSA);
  }

  // node_modules/@noble/curves/esm/ed25519.js
  var _0n5 = /* @__PURE__ */ BigInt(0);
  var _1n5 = BigInt(1);
  var _2n3 = BigInt(2);
  var _3n2 = BigInt(3);
  var _5n2 = BigInt(5);
  var _8n3 = BigInt(8);
  var ed25519_CURVE_p = BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
  var ed25519_CURVE = /* @__PURE__ */ (() => ({
    p: ed25519_CURVE_p,
    n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
    h: _8n3,
    a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
    d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
    Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
    Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
  }))();
  function ed25519_pow_2_252_3(x) {
    const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
    const P = ed25519_CURVE_p;
    const x2 = x * x % P;
    const b2 = x2 * x % P;
    const b4 = pow2(b2, _2n3, P) * b2 % P;
    const b5 = pow2(b4, _1n5, P) * x % P;
    const b10 = pow2(b5, _5n2, P) * b5 % P;
    const b20 = pow2(b10, _10n, P) * b10 % P;
    const b40 = pow2(b20, _20n, P) * b20 % P;
    const b80 = pow2(b40, _40n, P) * b40 % P;
    const b160 = pow2(b80, _80n, P) * b80 % P;
    const b240 = pow2(b160, _80n, P) * b80 % P;
    const b250 = pow2(b240, _10n, P) * b10 % P;
    const pow_p_5_8 = pow2(b250, _2n3, P) * x % P;
    return { pow_p_5_8, b2 };
  }
  function adjustScalarBytes(bytes) {
    bytes[0] &= 248;
    bytes[31] &= 127;
    bytes[31] |= 64;
    return bytes;
  }
  var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
  function uvRatio(u, v) {
    const P = ed25519_CURVE_p;
    const v3 = mod(v * v * v, P);
    const v7 = mod(v3 * v3 * v, P);
    const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
    let x = mod(u * v3 * pow, P);
    const vx2 = mod(v * x * x, P);
    const root1 = x;
    const root2 = mod(x * ED25519_SQRT_M1, P);
    const useRoot1 = vx2 === u;
    const useRoot2 = vx2 === mod(-u, P);
    const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
    if (useRoot1)
      x = root1;
    if (useRoot2 || noRoot)
      x = root2;
    if (isNegativeLE(x, P))
      x = mod(-x, P);
    return { isValid: useRoot1 || useRoot2, value: x };
  }
  var Fp = /* @__PURE__ */ (() => Field(ed25519_CURVE.p, { isLE: true }))();
  var Fn = /* @__PURE__ */ (() => Field(ed25519_CURVE.n, { isLE: true }))();
  var ed25519Defaults = /* @__PURE__ */ (() => ({
    ...ed25519_CURVE,
    Fp,
    hash: sha512,
    adjustScalarBytes,
    // dom2
    // Ratio of u to v. Allows us to combine inversion and square root. Uses algo from RFC8032 5.1.3.
    // Constant-time, u/√v
    uvRatio
  }))();
  var ed25519 = /* @__PURE__ */ (() => twistedEdwards(ed25519Defaults))();
  var SQRT_M1 = ED25519_SQRT_M1;
  var SQRT_AD_MINUS_ONE = /* @__PURE__ */ BigInt("25063068953384623474111414158702152701244531502492656460079210482610430750235");
  var INVSQRT_A_MINUS_D = /* @__PURE__ */ BigInt("54469307008909316920995813868745141605393597292927456921205312896311721017578");
  var ONE_MINUS_D_SQ = /* @__PURE__ */ BigInt("1159843021668779879193775521855586647937357759715417654439879720876111806838");
  var D_MINUS_ONE_SQ = /* @__PURE__ */ BigInt("40440834346308536858101042469323190826248399146238708352240133220865137265952");
  var invertSqrt = (number) => uvRatio(_1n5, number);
  var MAX_255B = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  var bytes255ToNumberLE = (bytes) => ed25519.Point.Fp.create(bytesToNumberLE(bytes) & MAX_255B);
  function calcElligatorRistrettoMap(r0) {
    const { d } = ed25519_CURVE;
    const P = ed25519_CURVE_p;
    const mod2 = (n) => Fp.create(n);
    const r = mod2(SQRT_M1 * r0 * r0);
    const Ns = mod2((r + _1n5) * ONE_MINUS_D_SQ);
    let c = BigInt(-1);
    const D = mod2((c - d * r) * mod2(r + d));
    let { isValid: Ns_D_is_sq, value: s } = uvRatio(Ns, D);
    let s_ = mod2(s * r0);
    if (!isNegativeLE(s_, P))
      s_ = mod2(-s_);
    if (!Ns_D_is_sq)
      s = s_;
    if (!Ns_D_is_sq)
      c = r;
    const Nt = mod2(c * (r - _1n5) * D_MINUS_ONE_SQ - D);
    const s2 = s * s;
    const W0 = mod2((s + s) * D);
    const W1 = mod2(Nt * SQRT_AD_MINUS_ONE);
    const W2 = mod2(_1n5 - s2);
    const W3 = mod2(_1n5 + s2);
    return new ed25519.Point(mod2(W0 * W3), mod2(W2 * W1), mod2(W1 * W3), mod2(W0 * W2));
  }
  function ristretto255_map(bytes) {
    abytes(bytes, 64);
    const r1 = bytes255ToNumberLE(bytes.subarray(0, 32));
    const R1 = calcElligatorRistrettoMap(r1);
    const r2 = bytes255ToNumberLE(bytes.subarray(32, 64));
    const R2 = calcElligatorRistrettoMap(r2);
    return new _RistrettoPoint(R1.add(R2));
  }
  var _RistrettoPoint = class __RistrettoPoint extends PrimeEdwardsPoint {
    constructor(ep) {
      super(ep);
    }
    static fromAffine(ap) {
      return new __RistrettoPoint(ed25519.Point.fromAffine(ap));
    }
    assertSame(other) {
      if (!(other instanceof __RistrettoPoint))
        throw new Error("RistrettoPoint expected");
    }
    init(ep) {
      return new __RistrettoPoint(ep);
    }
    /** @deprecated use `import { ristretto255_hasher } from '@noble/curves/ed25519.js';` */
    static hashToCurve(hex) {
      return ristretto255_map(ensureBytes("ristrettoHash", hex, 64));
    }
    static fromBytes(bytes) {
      abytes(bytes, 32);
      const { a, d } = ed25519_CURVE;
      const P = ed25519_CURVE_p;
      const mod2 = (n) => Fp.create(n);
      const s = bytes255ToNumberLE(bytes);
      if (!equalBytes(Fp.toBytes(s), bytes) || isNegativeLE(s, P))
        throw new Error("invalid ristretto255 encoding 1");
      const s2 = mod2(s * s);
      const u1 = mod2(_1n5 + a * s2);
      const u2 = mod2(_1n5 - a * s2);
      const u1_2 = mod2(u1 * u1);
      const u2_2 = mod2(u2 * u2);
      const v = mod2(a * d * u1_2 - u2_2);
      const { isValid, value: I } = invertSqrt(mod2(v * u2_2));
      const Dx = mod2(I * u2);
      const Dy = mod2(I * Dx * v);
      let x = mod2((s + s) * Dx);
      if (isNegativeLE(x, P))
        x = mod2(-x);
      const y = mod2(u1 * Dy);
      const t = mod2(x * y);
      if (!isValid || isNegativeLE(t, P) || y === _0n5)
        throw new Error("invalid ristretto255 encoding 2");
      return new __RistrettoPoint(new ed25519.Point(x, y, _1n5, t));
    }
    /**
     * Converts ristretto-encoded string to ristretto point.
     * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-decode).
     * @param hex Ristretto-encoded 32 bytes. Not every 32-byte string is valid ristretto encoding
     */
    static fromHex(hex) {
      return __RistrettoPoint.fromBytes(ensureBytes("ristrettoHex", hex, 32));
    }
    static msm(points, scalars) {
      return pippenger(__RistrettoPoint, ed25519.Point.Fn, points, scalars);
    }
    /**
     * Encodes ristretto point to Uint8Array.
     * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-encode).
     */
    toBytes() {
      let { X, Y, Z, T } = this.ep;
      const P = ed25519_CURVE_p;
      const mod2 = (n) => Fp.create(n);
      const u1 = mod2(mod2(Z + Y) * mod2(Z - Y));
      const u2 = mod2(X * Y);
      const u2sq = mod2(u2 * u2);
      const { value: invsqrt } = invertSqrt(mod2(u1 * u2sq));
      const D1 = mod2(invsqrt * u1);
      const D2 = mod2(invsqrt * u2);
      const zInv = mod2(D1 * D2 * T);
      let D;
      if (isNegativeLE(T * zInv, P)) {
        let _x = mod2(Y * SQRT_M1);
        let _y = mod2(X * SQRT_M1);
        X = _x;
        Y = _y;
        D = mod2(D1 * INVSQRT_A_MINUS_D);
      } else {
        D = D2;
      }
      if (isNegativeLE(X * zInv, P))
        Y = mod2(-Y);
      let s = mod2((Z - Y) * D);
      if (isNegativeLE(s, P))
        s = mod2(-s);
      return Fp.toBytes(s);
    }
    /**
     * Compares two Ristretto points.
     * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-equals).
     */
    equals(other) {
      this.assertSame(other);
      const { X: X1, Y: Y1 } = this.ep;
      const { X: X2, Y: Y2 } = other.ep;
      const mod2 = (n) => Fp.create(n);
      const one = mod2(X1 * Y2) === mod2(Y1 * X2);
      const two = mod2(Y1 * Y2) === mod2(X1 * X2);
      return one || two;
    }
    is0() {
      return this.equals(__RistrettoPoint.ZERO);
    }
  };
  _RistrettoPoint.BASE = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519.Point.BASE))();
  _RistrettoPoint.ZERO = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519.Point.ZERO))();
  _RistrettoPoint.Fp = /* @__PURE__ */ (() => Fp)();
  _RistrettoPoint.Fn = /* @__PURE__ */ (() => Fn)();

  // src/sign.ts
  var AUTHOR_PREFIX = "ed25519:";
  function publicKeyFromSeed(seedHex) {
    return bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)));
  }
  function authorForSeed(seedHex) {
    return AUTHOR_PREFIX + publicKeyFromSeed(seedHex);
  }
  function signClaims(claims, seedHex) {
    const expected = authorForSeed(seedHex);
    if (claims.author !== expected) {
      throw new Error(`author must be ${expected} for this signing key, got ${claims.author}`);
    }
    const id = computeId(claims);
    const sig = bytesToHex(ed25519.sign(hexToBytes(id), hexToBytes(seedHex)));
    return { id, claims, sig };
  }
  function verifyDelta(delta) {
    if (computeId(delta.claims) !== delta.id) return "invalid";
    if (delta.sig === void 0) return "unsigned";
    if (!delta.claims.author.startsWith(AUTHOR_PREFIX)) return "invalid";
    const pubHex = delta.claims.author.slice(AUTHOR_PREFIX.length);
    try {
      return ed25519.verify(hexToBytes(delta.sig), hexToBytes(delta.id), hexToBytes(pubHex)) ? "verified" : "invalid";
    } catch {
      return "invalid";
    }
  }

  // src/derivation.ts
  function emissionKey(substantive, contexts) {
    const pairs = [];
    for (const p of substantive) {
      if (p.target.kind !== "entity") continue;
      const ctx = p.target.entity.context;
      if (ctx !== void 0 && contexts.includes(ctx)) {
        pairs.push(`${p.target.entity.id}${ctx}`);
      }
    }
    return pairs.sort().join("");
  }
  function provenancePointers(spec, inputHex) {
    return [
      {
        role: `${VOCAB_PREFIX}.derived.by`,
        target: { kind: "entity", entity: { id: spec.fnId } }
      },
      { role: `${VOCAB_PREFIX}.derived.from`, target: { kind: "primitive", value: inputHex } },
      {
        role: `${VOCAB_PREFIX}.derived.under`,
        target: { kind: "entity", entity: { id: spec.name } }
      }
    ];
  }
  function derivedClaims(spec, author, substantive, inputHex) {
    return {
      timestamp: 0,
      author,
      pointers: [...substantive, ...provenancePointers(spec, inputHex)]
    };
  }
  var DerivationHost = class {
    constructor(reactor) {
      this.reactor = reactor;
    }
    reactor;
    bindings = /* @__PURE__ */ new Map();
    // Installation is an assertion: a signed rdb.derived.binds delta (SPEC-7 §3).
    install(spec, fn, seedHex) {
      if (this.bindings.has(spec.name)) throw new Error(`duplicate binding: ${spec.name}`);
      const author = authorForSeed(seedHex);
      const binds = signClaims(
        {
          timestamp: 0,
          author,
          pointers: [
            {
              role: `${VOCAB_PREFIX}.derived.binds`,
              target: { kind: "entity", entity: { id: spec.fnId, context: "bindings" } }
            },
            { role: `${VOCAB_PREFIX}.derived.author`, target: { kind: "primitive", value: author } }
          ]
        },
        seedHex
      );
      this.reactor.ingest(binds);
      this.bindings.set(spec.name, {
        spec,
        fn,
        seedHex,
        author,
        liveEmissions: /* @__PURE__ */ new Map(),
        triggerCount: 0,
        suspended: false
      });
      return author;
    }
    isSuspended(name) {
      return this.bindings.get(name)?.suspended ?? false;
    }
    authorOf(name) {
      return this.bindings.get(name)?.author;
    }
    // The write-back loop (G2): ingest, then drain triggers until quiescent.
    ingest(delta) {
      const result = this.reactor.ingest(delta);
      if (result.status !== "accepted") return result;
      this.drain([...this.reactor.changesFromLastIngest()]);
      return result;
    }
    drain(pending) {
      let depth = 0;
      while (pending.length > 0 && depth < 32) {
        depth += 1;
        const next = [];
        for (const change of pending) {
          for (const b of this.bindings.values()) {
            if (b.spec.materialization !== change.materialization) continue;
            next.push(...this.trigger(b, change));
          }
        }
        pending = next;
      }
    }
    emitSigned(b, claims) {
      const signed = signClaims(claims, b.seedHex);
      const result = this.reactor.ingest(signed);
      if (result.status === "rejected") throw new Error("derived emission rejected");
      return result.status === "accepted" ? [...this.reactor.changesFromLastIngest()] : [];
    }
    trigger(b, change) {
      if (b.suspended) return [];
      const own = change.responsibleDeltaIds.every(
        (id) => this.reactor.get(id)?.claims.author === b.author
      );
      if (own) return [];
      if (b.triggerCount >= b.spec.budget) {
        b.suspended = true;
        return this.emitSigned(b, {
          timestamp: 0,
          author: b.author,
          pointers: [
            {
              role: `${VOCAB_PREFIX}.derived.suspended`,
              target: { kind: "entity", entity: { id: b.spec.name, context: "suspensions" } }
            }
          ]
        });
      }
      b.triggerCount += 1;
      const view = this.reactor.materializedView(change.materialization, change.root);
      if (view === void 0) return [];
      const out = [];
      if (b.spec.emit === "supersede") {
        for (const prior of [...b.liveEmissions.values()].flat()) {
          out.push(...this.emitSigned(b, makeNegationClaims(b.author, 0, prior)));
        }
        b.liveEmissions.clear();
      }
      const keyed = typeof b.spec.emit === "object" ? b.spec.emit.keyed : void 0;
      for (const substantive of b.fn(view, change.root)) {
        const claims = derivedClaims(b.spec, b.author, substantive, change.newHex);
        const signed = signClaims(claims, b.seedHex);
        const key = keyed === void 0 ? "" : emissionKey(substantive, keyed);
        if (keyed !== void 0 && key !== "") {
          for (const prior of b.liveEmissions.get(key) ?? []) {
            out.push(...this.emitSigned(b, makeNegationClaims(b.author, 0, prior)));
          }
          b.liveEmissions.set(key, []);
        }
        const result = this.reactor.ingest(signed);
        if (result.status === "accepted") {
          const bucket = b.liveEmissions.get(key);
          if (bucket === void 0) b.liveEmissions.set(key, [signed.id]);
          else bucket.push(signed.id);
          out.push(...this.reactor.changesFromLastIngest());
        }
      }
      return out;
    }
  };
  function verifyPureDerivation(emitted, spec, fn, view, root, viewHex) {
    if (verifyDelta(emitted) !== "verified") return false;
    const fromPtr = emitted.claims.pointers.find(
      (p) => p.role === `${VOCAB_PREFIX}.derived.from` && p.target.kind === "primitive"
    );
    if (fromPtr?.target.kind !== "primitive" || fromPtr.target.value !== viewHex) return false;
    const ids = fn(view, root).map(
      (substantive) => computeId(derivedClaims(spec, emitted.claims.author, substantive, viewHex))
    );
    return ids.includes(emitted.id);
  }

  // src/json-profile.ts
  function asObject2(x, what) {
    if (typeof x !== "object" || x === null || Array.isArray(x)) {
      throw new Error(`expected object for ${what}`);
    }
    return x;
  }
  function parsePrimitive2(v) {
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("numeric primitive must be finite");
      return v;
    }
    throw new Error("primitive must be string | number | boolean");
  }
  function parseContext(o) {
    const context = o["context"];
    if (context === void 0) return void 0;
    if (typeof context !== "string") throw new Error("context, when present, must be a string");
    return context;
  }
  function parseTarget(raw) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      return { kind: "primitive", value: parsePrimitive2(raw) };
    }
    const o = asObject2(raw, "target");
    if ("id" in o) {
      const id = o["id"];
      if (typeof id !== "string") throw new Error("entity ref id must be a string");
      const context = parseContext(o);
      return context === void 0 ? { kind: "entity", entity: { id } } : { kind: "entity", entity: { id, context } };
    }
    if ("delta" in o) {
      const delta = o["delta"];
      if (typeof delta !== "string") throw new Error("delta ref delta must be a string");
      const context = parseContext(o);
      return context === void 0 ? { kind: "delta", deltaRef: { delta } } : { kind: "delta", deltaRef: { delta, context } };
    }
    throw new Error("target must be a primitive, {id, context?}, or {delta, context?}");
  }
  function parsePointer(raw) {
    const o = asObject2(raw, "pointer");
    if (typeof o["role"] !== "string") throw new Error("pointer.role must be a string");
    return { role: o["role"], target: parseTarget(o["target"]) };
  }
  function claimsToJson(claims) {
    return {
      timestamp: claims.timestamp,
      author: claims.author,
      pointers: claims.pointers.map((p) => {
        let target;
        switch (p.target.kind) {
          case "primitive":
            target = p.target.value;
            break;
          case "entity":
            target = {
              id: p.target.entity.id,
              ...p.target.entity.context === void 0 ? {} : { context: p.target.entity.context }
            };
            break;
          case "delta":
            target = {
              delta: p.target.deltaRef.delta,
              ...p.target.deltaRef.context === void 0 ? {} : { context: p.target.deltaRef.context }
            };
            break;
        }
        return { role: p.role, target };
      })
    };
  }
  function parseClaims(raw) {
    const o = asObject2(raw, "claims");
    if (typeof o["timestamp"] !== "number") throw new Error("claims.timestamp must be a number");
    if (typeof o["author"] !== "string") throw new Error("claims.author must be a string");
    if (!Array.isArray(o["pointers"])) throw new Error("claims.pointers must be an array");
    return {
      timestamp: o["timestamp"],
      author: o["author"],
      pointers: o["pointers"].map(parsePointer)
    };
  }

  // src/schema.ts
  function collectRefs(term) {
    const out = [];
    const walk = (t) => {
      switch (t.kind) {
        case "input":
          return;
        case "select":
        case "mask":
        case "group":
        case "prune":
        case "resolve":
          walk(t.of);
          return;
        case "union":
          walk(t.left);
          walk(t.right);
          return;
        case "expand":
          out.push(t.schema);
          walk(t.of);
          return;
        case "fix":
          out.push(t.schema);
          return;
      }
    };
    walk(term);
    return out;
  }
  var SchemaRegistry = class _SchemaRegistry {
    constructor(byName, byHash) {
      this.byName = byName;
      this.byHash = byHash;
    }
    byName;
    byHash;
    // Rejects duplicate names, unresolved refs, and reference cycles (SPEC-3 §3).
    // Data cycles remain legal — the DAG constraint is on programs, not data.
    static build(schemas) {
      const byName = /* @__PURE__ */ new Map();
      const byHash = /* @__PURE__ */ new Map();
      const hashOf = /* @__PURE__ */ new Map();
      for (const s of schemas) {
        if (byName.has(s.name)) throw new Error(`duplicate schema name: ${s.name}`);
        byName.set(s.name, s);
        const h = termHash(s.body);
        hashOf.set(s.name, h);
        if (!byHash.has(h)) byHash.set(h, s);
      }
      const resolveName = (ref, from) => {
        if (ref.kind === "name") {
          const s2 = byName.get(ref.name);
          if (s2 === void 0)
            throw new Error(`schema ${from} references unknown schema ${ref.name}`);
          return s2.name;
        }
        const s = byHash.get(ref.hash);
        if (s === void 0) {
          throw new Error(`schema ${from} references unknown pinned schema ${ref.hash} (E13)`);
        }
        return s.name;
      };
      const refs = /* @__PURE__ */ new Map();
      for (const s of schemas) {
        refs.set(
          s.name,
          collectRefs(s.body).map((r) => resolveName(r, s.name))
        );
      }
      const state = /* @__PURE__ */ new Map();
      const visit = (name, path) => {
        const st = state.get(name);
        if (st === "done") return;
        if (st === "visiting") {
          throw new Error(`schema reference cycle: ${[...path, name].join(" -> ")} (SPEC-3 \xA73)`);
        }
        state.set(name, "visiting");
        for (const r of refs.get(name) ?? []) visit(r, [...path, name]);
        state.set(name, "done");
      };
      for (const s of schemas) visit(s.name, []);
      return new _SchemaRegistry(byName, byHash);
    }
    get(name) {
      return this.byName.get(name);
    }
    getByHash(hash) {
      return this.byHash.get(hash);
    }
    resolve(ref) {
      return ref.kind === "name" ? this.byName.get(ref.name) : this.byHash.get(ref.hash);
    }
  };

  // src/reactor.ts
  var Reactor = class {
    // The append-only log in arrival order (v0: in-memory; the log is still the truth — V2).
    log = [];
    set = new DeltaSet();
    // target index: EntityId -> delta ids whose pointers target that entity (SPEC-4 §3)
    targetIndex = /* @__PURE__ */ new Map();
    // negation index: delta id -> ids of negations targeting it (SPEC-4 §3)
    negationIndex = /* @__PURE__ */ new Map();
    materializations = /* @__PURE__ */ new Map();
    // value index: role -> canonical primitive key -> { value, ids } (V1: keyed by role)
    valueIndex = /* @__PURE__ */ new Map();
    // Validate -> persist -> index. Idempotent by id; rejected deltas leave no trace (V3).
    ingest(delta) {
      if (this.set.has(delta.id)) return { status: "duplicate" };
      if (delta.sig !== void 0 && verifyDelta(delta) !== "verified") {
        return { status: "rejected", reason: "signature does not verify" };
      }
      try {
        this.set.add(delta);
      } catch (e) {
        return { status: "rejected", reason: e instanceof Error ? e.message : String(e) };
      }
      this.log.push(delta);
      this.index(delta);
      for (const cb of this.rawSubscribers) cb(delta);
      this.lastChanges = this.dispatchAndUpdate([delta]);
      return { status: "accepted" };
    }
    index(delta) {
      for (const ptr of delta.claims.pointers) {
        switch (ptr.target.kind) {
          case "entity": {
            const id = ptr.target.entity.id;
            let bucket = this.targetIndex.get(id);
            if (bucket === void 0) {
              bucket = /* @__PURE__ */ new Set();
              this.targetIndex.set(id, bucket);
            }
            bucket.add(delta.id);
            break;
          }
          case "delta": {
            if (ptr.role === "negates") {
              const target = ptr.target.deltaRef.delta;
              let bucket = this.negationIndex.get(target);
              if (bucket === void 0) {
                bucket = /* @__PURE__ */ new Set();
                this.negationIndex.set(target, bucket);
              }
              bucket.add(delta.id);
            }
            break;
          }
          case "primitive": {
            let roleBucket = this.valueIndex.get(ptr.role);
            if (roleBucket === void 0) {
              roleBucket = /* @__PURE__ */ new Map();
              this.valueIndex.set(ptr.role, roleBucket);
            }
            const key = viewCanonicalHex(ptr.target.value);
            let entry = roleBucket.get(key);
            if (entry === void 0) {
              entry = { value: ptr.target.value, ids: /* @__PURE__ */ new Set() };
              roleBucket.set(key, entry);
            }
            entry.ids.add(delta.id);
            break;
          }
        }
      }
    }
    // --- queries over the core indexes (sorted ids — canonical enumeration order) ---
    byTarget(entityId) {
      return [...this.targetIndex.get(entityId) ?? []].sort();
    }
    negationsOf(deltaId) {
      return [...this.negationIndex.get(deltaId) ?? []].sort();
    }
    // Range/equality queries over primitive payloads filed under a role (V1; ValMatch per SPEC-2 §3).
    byValue(role, match) {
      const bucket = this.valueIndex.get(role);
      if (bucket === void 0) return [];
      const out = [];
      for (const { value, ids } of bucket.values()) {
        if (match(value)) out.push(...ids);
      }
      return out.sort();
    }
    byValueBetween(role, lo, hi) {
      return this.byValue(
        role,
        (v) => comparePrimitives(v, lo) >= 0 && comparePrimitives(v, hi) <= 0
      );
    }
    // --- the log and the set ---
    get size() {
      return this.set.size;
    }
    has(id) {
      return this.set.has(id);
    }
    get(id) {
      return this.set.get(id);
    }
    // Arrival order — a transport artifact, never consulted by evaluation (SPEC-4 §2).
    arrivalLog() {
      return this.log;
    }
    digest() {
      return this.set.digest();
    }
    snapshot() {
      return DeltaSet.from(this.set);
    }
    // Batch evaluation over the current set — the oracle hookup (SPEC-4 §1). Read-your-writes
    // holds trivially: ingest is synchronous, so an accepted delta is visible immediately (§6).
    eval(term, root, registry) {
      return evalTerm(term, this.set, root, registry);
    }
    // --- materializations (SPEC-4 §4, ERRATA-4 V5) ---
    lastChanges = [];
    // Register a live materialization: an HView-sort term (a function of $root) kept
    // incrementally equal to batch evaluation at each root (SPEC-4 §1).
    register(name, term, roots, registry) {
      if (this.materializations.has(name)) throw new Error(`duplicate materialization: ${name}`);
      const mat = {
        name,
        term,
        roots: [...roots],
        registry,
        rootAnchored: isRootAnchored(term, registry),
        views: /* @__PURE__ */ new Map(),
        hexes: /* @__PURE__ */ new Map(),
        propHexes: /* @__PURE__ */ new Map(),
        supportEntities: /* @__PURE__ */ new Map(),
        evalCount: 0
      };
      for (const root of mat.roots) void this.refresh(mat, root);
      this.materializations.set(name, mat);
    }
    materializedHex(name, root) {
      return this.materializations.get(name)?.hexes.get(root);
    }
    materializedView(name, root) {
      return this.materializations.get(name)?.views.get(root);
    }
    evalCountOf(name) {
      return this.materializations.get(name)?.evalCount ?? 0;
    }
    changesFromLastIngest() {
      return this.lastChanges;
    }
    refresh(mat, root) {
      const result = evalTerm(mat.term, this.set, root, mat.registry);
      if (result.sort !== "hview") throw new Error("materialized terms must be HView-sort");
      mat.evalCount += 1;
      const hex = hviewCanonicalHex(result.hview);
      const changed = mat.hexes.get(root) !== hex;
      const newPropHexes = propHexesOf(result.hview);
      const changedProps = changed ? diffProps(mat.propHexes.get(root) ?? /* @__PURE__ */ new Map(), newPropHexes) : void 0;
      mat.views.set(root, result.hview);
      mat.hexes.set(root, hex);
      mat.propHexes.set(root, newPropHexes);
      const entities = /* @__PURE__ */ new Set([root]);
      collectNestedIds(result.hview, entities);
      mat.supportEntities.set(root, entities);
      return changedProps;
    }
    // Sound dispatch (V5): over-match allowed, under-match forbidden.
    dispatchAndUpdate(deltas) {
      const responsible = deltas.map((d) => d.id);
      const changes = [];
      for (const mat of this.materializations.values()) {
        for (const root of mat.roots) {
          if (!deltas.some((d) => this.affects(d, mat, root))) continue;
          const changedProps = this.refresh(mat, root);
          if (changedProps !== void 0) {
            changes.push({
              materialization: mat.name,
              root,
              changedProps,
              responsibleDeltaIds: responsible,
              newHex: mat.hexes.get(root)
            });
          }
        }
      }
      for (const c of changes) {
        for (const cb of this.matSubscribers.get(c.materialization) ?? []) cb(c);
      }
      return changes;
    }
    affects(delta, mat, root) {
      if (!mat.rootAnchored) return true;
      const support = mat.supportEntities.get(root) ?? /* @__PURE__ */ new Set([root]);
      if (this.targetsSupport(delta, support)) return true;
      for (const ptr of delta.claims.pointers) {
        if (ptr.role !== "negates" || ptr.target.kind !== "delta") continue;
        if (this.chainTouchesSupport(ptr.target.deltaRef.delta, support, 0)) return true;
      }
      return false;
    }
    targetsSupport(delta, support) {
      return delta.claims.pointers.some(
        (p) => p.target.kind === "entity" && support.has(p.target.entity.id)
      );
    }
    chainTouchesSupport(id, support, depth) {
      if (depth > 64) return true;
      const target = this.set.get(id);
      if (target === void 0) return false;
      if (this.targetsSupport(target, support)) return true;
      for (const ptr of target.claims.pointers) {
        if (ptr.role !== "negates" || ptr.target.kind !== "delta") continue;
        if (this.chainTouchesSupport(ptr.target.deltaRef.delta, support, depth + 1)) return true;
      }
      return false;
    }
    // --- subscriptions (SPEC-4 §5) ---
    rawSubscribers = [];
    matSubscribers = /* @__PURE__ */ new Map();
    // The raw stream: every accepted delta (federation relays, audit, mirrors).
    subscribeRaw(cb) {
      this.rawSubscribers.push(cb);
    }
    // Change events on a registered materialization's HyperViews.
    subscribe(materialization, cb) {
      const list = this.matSubscribers.get(materialization);
      if (list === void 0) this.matSubscribers.set(materialization, [cb]);
      else list.push(cb);
    }
    // --- atomic batch ingestion (SPEC-1 §9, SPEC-4 §6) ---
    // Manifest-keyed atomic ingestion: validate everything first; all members become visible to
    // dispatch in one step, or none do. The transaction vocabulary supplies the batch boundary;
    // the reactor supplies the courtesy.
    ingestBundle(manifest, members) {
      const fresh = [...members, manifest].filter((d) => !this.set.has(d.id));
      for (const d of fresh) {
        if (d.sig !== void 0 && verifyDelta(d) !== "verified") {
          return { status: "rejected", reason: `bundle member ${d.id}: signature does not verify` };
        }
        try {
          const probe = new DeltaSet();
          probe.add(d);
        } catch (e) {
          return {
            status: "rejected",
            reason: `bundle member ${d.id}: ${e instanceof Error ? e.message : String(e)}`
          };
        }
      }
      const committed = new Set(manifestMemberIds(manifest));
      for (const m of members) {
        if (!committed.has(m.id)) {
          return { status: "rejected", reason: `member ${m.id} is not claimed by the manifest` };
        }
      }
      if (fresh.length === 0) return { status: "duplicate" };
      for (const d of fresh) {
        this.set.add(d);
        this.log.push(d);
        this.index(d);
        for (const cb of this.rawSubscribers) cb(d);
      }
      this.lastChanges = this.dispatchAndUpdate(fresh);
      return { status: "accepted" };
    }
    // Completeness is verifiable, not enforced (SPEC-1 §9): a hash check.
    holdsAllMembers(manifestId) {
      const manifest = this.set.get(manifestId);
      if (manifest === void 0) return false;
      return manifestMemberIds(manifest).every((id) => this.set.has(id));
    }
  };
  function manifestMemberIds(manifest) {
    return manifest.claims.pointers.filter((p) => p.role === `${VOCAB_PREFIX}.txn.member` && p.target.kind === "delta").map((p) => p.target.deltaRef.delta);
  }
  function propHexesOf(h) {
    const out = /* @__PURE__ */ new Map();
    for (const [prop, entries] of h.props) {
      out.set(prop, bytesToHex(encode(array(entries.map(hvEntryToCbor)))));
    }
    return out;
  }
  function diffProps(before, after) {
    const changed = /* @__PURE__ */ new Set();
    for (const [prop, hex] of after) if (before.get(prop) !== hex) changed.add(prop);
    for (const prop of before.keys()) if (!after.has(prop)) changed.add(prop);
    return [...changed].sort();
  }
  function collectNestedIds(h, out) {
    for (const entries of h.props.values()) {
      for (const e of entries) {
        if (e.expanded === void 0) continue;
        for (const nested of e.expanded.values()) {
          out.add(nested.id);
          collectNestedIds(nested, out);
        }
      }
    }
  }
  function predRequiresRoot(pred) {
    switch (pred.kind) {
      case "hasPointer":
        return pred.ppred.targetEntity?.kind === "root";
      case "and":
        return predRequiresRoot(pred.left) || predRequiresRoot(pred.right);
      case "or":
        return predRequiresRoot(pred.left) && predRequiresRoot(pred.right);
      default:
        return false;
    }
  }
  function pipelineAnchored(t) {
    switch (t.kind) {
      case "input":
        return false;
      case "select":
        return predRequiresRoot(t.pred) || pipelineAnchored(t.of);
      case "mask":
        return pipelineAnchored(t.of);
      case "union":
        return pipelineAnchored(t.left) && pipelineAnchored(t.right);
      default:
        return false;
    }
  }
  function termAnchored(t) {
    switch (t.kind) {
      case "group":
        return pipelineAnchored(t.of);
      case "prune":
      case "expand":
      case "resolve":
        return termAnchored(t.of);
      case "fix":
        return true;
      // anchoring of the referenced schema is checked via the registry walk below
      default:
        return false;
    }
  }
  function isRootAnchored(term, registry) {
    if (!termAnchored(term) || termContainsInView(term)) return false;
    const seen = /* @__PURE__ */ new Set();
    const queue = [...collectRefs(term)];
    while (queue.length > 0) {
      const ref = queue.pop();
      const key = ref.kind === "name" ? `n:${ref.name}` : `h:${ref.hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const schema = registry?.resolve(ref);
      if (schema === void 0) return false;
      if (!termAnchored(schema.body) || termContainsInView(schema.body)) return false;
      queue.push(...collectRefs(schema.body));
    }
    return true;
  }

  // src/pack.ts
  var PACK_VERSION = 1;
  function stringsOf(delta, out) {
    out.add(delta.id);
    out.add(delta.claims.author);
    if (delta.sig !== void 0) out.add(delta.sig);
    for (const p of delta.claims.pointers) {
      out.add(p.role);
      switch (p.target.kind) {
        case "entity":
          out.add(p.target.entity.id);
          if (p.target.entity.context !== void 0) out.add(p.target.entity.context);
          break;
        case "delta":
          out.add(p.target.deltaRef.delta);
          if (p.target.deltaRef.context !== void 0) out.add(p.target.deltaRef.context);
          break;
        case "primitive":
          if (typeof p.target.value === "string") out.add(p.target.value);
          break;
      }
    }
  }
  function ptrToCbor(p, idx) {
    const entries = [["r", float(idx(p.role))]];
    let context;
    switch (p.target.kind) {
      case "entity":
        entries.push(["e", float(idx(p.target.entity.id))]);
        context = p.target.entity.context;
        break;
      case "delta":
        entries.push(["d", float(idx(p.target.deltaRef.delta))]);
        context = p.target.deltaRef.context;
        break;
      case "primitive": {
        const v = p.target.value;
        if (typeof v === "string") entries.push(["s", float(idx(v))]);
        else if (typeof v === "number") entries.push(["n", float(v)]);
        else entries.push(["b", bool(v)]);
        break;
      }
    }
    if (context !== void 0) entries.push(["c", float(idx(context))]);
    return map(entries);
  }
  function hydratedRecord(d, idx) {
    const entries = [
      ["i", float(idx(d.id))],
      ["a", float(idx(d.claims.author))],
      ["t", float(d.claims.timestamp)],
      ["p", array(d.claims.pointers.map((p) => ptrToCbor(p, idx)))]
    ];
    if (d.sig !== void 0) entries.push(["s", float(idx(d.sig))]);
    return map(entries);
  }
  function memberRecord(d, manifest, envelopeIdx, idx) {
    const entries = [
      ["i", float(idx(d.id))],
      ["m", float(envelopeIdx)],
      ["p", array(d.claims.pointers.map((p) => ptrToCbor(p, idx)))]
    ];
    if (d.claims.author !== manifest.claims.author) entries.push(["a", float(idx(d.claims.author))]);
    const dt = d.claims.timestamp - manifest.claims.timestamp;
    if (dt !== 0) entries.push(["dt", float(dt)]);
    if (d.sig !== void 0) entries.push(["s", float(idx(d.sig))]);
    return map(entries);
  }
  function packSet(set) {
    const deltas = [...set].sort((a, b) => a.id < b.id ? -1 : 1);
    const manifests = deltas.filter((d) => manifestMemberIds(d).length > 0);
    const memberToManifest = /* @__PURE__ */ new Map();
    manifests.forEach((m, i) => {
      for (const id of manifestMemberIds(m)) {
        if (set.has(id) && !memberToManifest.has(id)) memberToManifest.set(id, i);
      }
    });
    const manifestIds = new Set(manifests.map((m) => m.id));
    const members = deltas.filter((d) => memberToManifest.has(d.id) && !manifestIds.has(d.id));
    const loose = deltas.filter((d) => !memberToManifest.has(d.id) && !manifestIds.has(d.id));
    const stringSet = /* @__PURE__ */ new Set();
    for (const d of deltas) stringsOf(d, stringSet);
    const strings = [...stringSet].sort();
    const indexOf = new Map(strings.map((s, i) => [s, i]));
    const idx = (s) => indexOf.get(s);
    const packed = map([
      ["version", float(PACK_VERSION)],
      ["strings", array(strings.map(tstr))],
      ["envelopes", array(manifests.map((m) => hydratedRecord(m, idx)))],
      [
        "members",
        array(
          members.map(
            (d) => memberRecord(
              d,
              manifests[memberToManifest.get(d.id)],
              memberToManifest.get(d.id),
              idx
            )
          )
        )
      ],
      ["loose", array(loose.map((d) => hydratedRecord(d, idx)))]
    ]);
    return encode(packed);
  }
  function packId(bytes) {
    return contentAddress(bytes);
  }
  function asMap(v, what) {
    if (v.t !== "map") throw new Error(`pack: expected map for ${what}`);
    return new Map(v.v);
  }
  function asArray(v, what) {
    if (v === void 0 || v.t !== "array") throw new Error(`pack: expected array for ${what}`);
    return v.v;
  }
  function asNum(v, what) {
    if (v === void 0 || v.t !== "float") throw new Error(`pack: expected number for ${what}`);
    return v.v;
  }
  function ptrFromCbor(v, strings) {
    const o = asMap(v, "pointer");
    const str = (key) => strings[asNum(o.get(key), key)];
    const role = str("r");
    const context = o.has("c") ? str("c") : void 0;
    let target;
    if (o.has("e")) {
      target = {
        kind: "entity",
        entity: context === void 0 ? { id: str("e") } : { id: str("e"), context }
      };
    } else if (o.has("d")) {
      target = {
        kind: "delta",
        deltaRef: context === void 0 ? { delta: str("d") } : { delta: str("d"), context }
      };
    } else if (o.has("s")) {
      target = { kind: "primitive", value: str("s") };
    } else if (o.has("n")) {
      target = { kind: "primitive", value: asNum(o.get("n"), "n") };
    } else if (o.has("b")) {
      const b = o.get("b");
      if (b.t !== "bool") throw new Error("pack: expected bool for b");
      target = { kind: "primitive", value: b.v };
    } else {
      throw new Error("pack: pointer record has no target");
    }
    return { role, target };
  }
  function hydrateRecord(v, strings) {
    const o = asMap(v, "record");
    const claims = {
      author: strings[asNum(o.get("a"), "a")],
      timestamp: asNum(o.get("t"), "t"),
      pointers: asArray(o.get("p"), "p").map((p) => ptrFromCbor(p, strings))
    };
    const sig = o.has("s") ? strings[asNum(o.get("s"), "s")] : void 0;
    return verifiedDelta(claims, sig, strings[asNum(o.get("i"), "i")]);
  }
  function verifiedDelta(claims, sig, storedId) {
    const d = makeDelta(claims, sig);
    if (d.id !== storedId) {
      throw new Error(`pack: rehydrated delta ${d.id} does not match stored id ${storedId}`);
    }
    return d;
  }
  function unpackSet(bytes) {
    const top = asMap(decode(bytes), "pack");
    if (asNum(top.get("version"), "version") !== PACK_VERSION) {
      throw new Error("pack: unsupported version");
    }
    const strings = asArray(top.get("strings"), "strings").map((s) => {
      if (s.t !== "tstr") throw new Error("pack: string table entries must be text");
      return s.v;
    });
    const out = new DeltaSet();
    const envelopes = asArray(top.get("envelopes"), "envelopes").map(
      (e) => hydrateRecord(e, strings)
    );
    for (const m of envelopes) out.add(m);
    for (const rec of asArray(top.get("members"), "members")) {
      const o = asMap(rec, "member");
      const manifest = envelopes[asNum(o.get("m"), "m")];
      if (manifest === void 0) throw new Error("pack: member references missing envelope");
      const author = o.has("a") ? strings[asNum(o.get("a"), "a")] : manifest.claims.author;
      const timestamp = manifest.claims.timestamp + (o.has("dt") ? asNum(o.get("dt"), "dt") : 0);
      const claims = {
        author,
        timestamp,
        pointers: asArray(o.get("p"), "p").map((p) => ptrFromCbor(p, strings))
      };
      const sig = o.has("s") ? strings[asNum(o.get("s"), "s")] : void 0;
      out.add(verifiedDelta(claims, sig, strings[asNum(o.get("i"), "i")]));
    }
    for (const rec of asArray(top.get("loose"), "loose")) out.add(hydrateRecord(rec, strings));
    return out;
  }

  // src/peer.ts
  var ALL = { kind: "input" };
  var Peer = class {
    constructor(seedHex, offeredLens = ALL, admission = void 0) {
      this.seedHex = seedHex;
      this.offeredLens = offeredLens;
      this.admission = admission;
      this.author = authorForSeed(seedHex);
    }
    seedHex;
    offeredLens;
    admission;
    reactor = new Reactor();
    author;
    // Author a claim as this peer: sign and ingest (read-your-writes).
    authorClaims(claims) {
      const signed = signClaims({ ...claims, author: this.author }, this.seedHex);
      const result = this.reactor.ingest(signed);
      if (result.status === "rejected") throw new Error(`own claim rejected: ${result.reason}`);
      return signed;
    }
    // The admission judgment (SPEC-6 §5 step 3), exposed for transport bindings (F5).
    admits(d) {
      return this.admission === void 0 || evalPred(this.admission, d);
    }
    // The offered set: eval(lens, log) — lens fidelity is a tested invariant (F4).
    offeredSet() {
      const result = evalTerm(this.offeredLens, this.reactor.snapshot());
      if (result.sort !== "dset") throw new Error("a lens must be a DSet-sort term (F4)");
      return [...result.set];
    }
    // Pull from another peer: WANT(my ids) -> OFFER/BUNDLE -> verify -> admission -> ingest (§5).
    pullFrom(other) {
      const have = /* @__PURE__ */ new Set();
      for (const d of this.reactor.arrivalLog()) have.add(d.id);
      const offered = other.offeredSet().filter((d) => !have.has(d.id));
      const offeredIds = new Set(offered.map((d) => d.id));
      const isSignedManifest = (d) => d.sig !== void 0 && verifyDelta(d) === "verified" && manifestMemberIds(d).length > 0;
      const bundles = [];
      const covered = /* @__PURE__ */ new Set();
      for (const m of offered.filter(isSignedManifest)) {
        const members = manifestMemberIds(m).filter((id) => offeredIds.has(id)).map((id) => offered.find((d) => d.id === id)).filter((d) => !isSignedManifest(d));
        bundles.push({ manifest: m, members });
        for (const mem of members) covered.add(mem.id);
        covered.add(m.id);
      }
      const loose = offered.filter(
        (d) => !covered.has(d.id) && d.sig !== void 0 && verifyDelta(d) === "verified"
      );
      const withheld = offered.length - covered.size - loose.length;
      let accepted = 0;
      let rejected = 0;
      const admit = (d) => this.admits(d);
      const count = (r) => {
        if (r.status === "accepted") accepted += 1;
        else if (r.status === "rejected") rejected += 1;
      };
      for (const { manifest, members } of bundles) {
        if (![manifest, ...members].every(admit)) {
          rejected += 1 + members.length;
          continue;
        }
        count(this.reactor.ingestBundle(manifest, members));
      }
      for (const d of loose) {
        if (!admit(d)) {
          rejected += 1;
          continue;
        }
        count(this.reactor.ingest(d));
      }
      return {
        offered: offered.length,
        bundles: bundles.length,
        loose: loose.length,
        withheld,
        accepted,
        rejected
      };
    }
  };
  function syncBoth(a, b) {
    for (let i = 0; i < 4; i++) {
      const before = a.reactor.digest() + b.reactor.digest();
      a.pullFrom(b);
      b.pullFrom(a);
      if (a.reactor.digest() + b.reactor.digest() === before) return;
    }
  }

  // ../../vectors/keys/keys.json
  var keys_default = [
    {
      keyId: "test-key-1",
      seedHex: "0101010101010101010101010101010101010101010101010101010101010101",
      publicKeyHex: "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c",
      author: "ed25519:8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"
    },
    {
      keyId: "test-key-2",
      seedHex: "0202020202020202020202020202020202020202020202020202020202020202",
      publicKeyHex: "8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394",
      author: "ed25519:8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"
    },
    {
      keyId: "test-key-3",
      seedHex: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      publicKeyHex: "ff57575dc7af8bfc4d0837cc1ce2017b686a88145dc5579a958e3462fe9a908e",
      author: "ed25519:ff57575dc7af8bfc4d0837cc1ce2017b686a88145dc5579a958e3462fe9a908e"
    }
  ];

  // ../../vectors/l0-delta/deltas.json
  var deltas_default = [
    {
      name: "single-primitive-string",
      spec: "SPEC-1 \xA72",
      claims: {
        timestamp: 0,
        author: "did:key:zAuthorA",
        pointers: [
          {
            role: "title",
            target: "The Matrix"
          }
        ]
      },
      canonicalCborHex: "a366617574686f72706469643a6b65793a7a417574686f724168706f696e7465727381a264726f6c65657469746c65667461726765746a546865204d61747269786974696d657374616d70f90000",
      id: "1e2030d96d325c7cfeb599f488598055041fb5303f062d3b32b43d5abedc6d3cee18"
    },
    {
      name: "primitive-number",
      spec: "SPEC-1 \xA72 / ERRATA D1",
      claims: {
        timestamp: 17179776e5,
        author: "did:key:zAuthorA",
        pointers: [
          {
            role: "releaseYear",
            target: 1999
          }
        ]
      },
      canonicalCborHex: "a366617574686f72706469643a6b65793a7a417574686f724168706f696e7465727381a264726f6c656b72656c656173655965617266746172676574f967cf6974696d657374616d70fb4278fff71d000000",
      id: "1e20a3a0a90a8c87aab1bad05dc7e971d20c772976658691ede840d5f38865c9de60"
    },
    {
      name: "primitive-boolean",
      spec: "SPEC-1 \xA72",
      claims: {
        timestamp: 0,
        author: "did:key:zAuthorA",
        pointers: [
          {
            role: "isCanonical",
            target: true
          }
        ]
      },
      canonicalCborHex: "a366617574686f72706469643a6b65793a7a417574686f724168706f696e7465727381a264726f6c656b697343616e6f6e6963616c66746172676574f56974696d657374616d70f90000",
      id: "1e2060947ef77cb97b5d8905129276e5d14d4fe81a32de9514da1da1ac210b7b68ee"
    },
    {
      name: "entity-ref-no-context",
      spec: "SPEC-1 \xA72 / ERRATA D5",
      claims: {
        timestamp: 0,
        author: "did:key:zAuthorA",
        pointers: [
          {
            role: "subject",
            target: {
              id: "entity:the_matrix"
            }
          }
        ]
      },
      canonicalCborHex: "a366617574686f72706469643a6b65793a7a417574686f724168706f696e7465727381a264726f6c65677375626a65637466746172676574a162696471656e746974793a7468655f6d61747269786974696d657374616d70f90000",
      id: "1e2061705edb89869037fb5d850bcb235e5584292470249e650a0d790b28712c3949"
    },
    {
      name: "entity-ref-with-context",
      spec: "SPEC-1 \xA72 / ERRATA D5",
      claims: {
        timestamp: 0,
        author: "did:key:zAuthorA",
        pointers: [
          {
            role: "cast",
            target: {
              id: "entity:keanu",
              context: "actor"
            }
          }
        ]
      },
      canonicalCborHex: "a366617574686f72706469643a6b65793a7a417574686f724168706f696e7465727381a264726f6c65646361737466746172676574a26269646c656e746974793a6b65616e7567636f6e74657874656163746f726974696d657374616d70f90000",
      id: "1e20b210c4e3eb8a91fde259c7d2171cbf730685354f9f7a8df5e322da3f576e25a5"
    },
    {
      name: "negation-delta-ref",
      spec: "SPEC-1 \xA77 / ERRATA D5",
      claims: {
        timestamp: 1,
        author: "did:key:zAuthorB",
        pointers: [
          {
            role: "negates",
            target: {
              delta: "1e2000000000000000000000000000000000000000000000000000000000000000"
            }
          },
          {
            role: "reason",
            target: "superseded"
          }
        ]
      },
      canonicalCborHex: "a366617574686f72706469643a6b65793a7a417574686f724268706f696e7465727382a264726f6c65676e65676174657366746172676574a16564656c74617842316532303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030a264726f6c6566726561736f6e667461726765746a737570657273656465646974696d657374616d70f93c00",
      id: "1e207b4310e7d0247d5f4671ae0cff5f2fd1df36cc7ab5e198f121008ee3dd3f8e91"
    },
    {
      name: "multi-pointer-purchase",
      spec: "SPEC-1 \xA73",
      claims: {
        timestamp: 17179776e5,
        author: "did:key:zAuthorA",
        pointers: [
          {
            role: "buyer",
            target: {
              id: "entity:alice",
              context: "purchases"
            }
          },
          {
            role: "seller",
            target: {
              id: "entity:bob",
              context: "sales"
            }
          },
          {
            role: "item",
            target: {
              id: "entity:widget",
              context: "soldVia"
            }
          },
          {
            role: "price",
            target: 19.99
          }
        ]
      },
      canonicalCborHex: "a366617574686f72706469643a6b65793a7a417574686f724168706f696e7465727384a264726f6c6565627579657266746172676574a26269646c656e746974793a616c69636567636f6e7465787469707572636861736573a264726f6c656673656c6c657266746172676574a26269646a656e746974793a626f6267636f6e746578746573616c6573a264726f6c65646974656d66746172676574a26269646d656e746974793a77696467657467636f6e7465787467736f6c64566961a264726f6c6565707269636566746172676574fb4033fd70a3d70a3d6974696d657374616d70fb4278fff71d000000",
      id: "1e200561a1f0ed9b4f3619e1657ff6319fd6ca2812b8cd89ece6e46fb3608c219485"
    },
    {
      name: "unicode-nfc-author",
      spec: "SPEC-1 \xA74.1 / ERRATA D2",
      claims: {
        timestamp: 0,
        author: "did:key:caf\xE9",
        pointers: [
          {
            role: "note",
            target: "\xFCn\xEFc\xF6d\xE9"
          }
        ]
      },
      canonicalCborHex: "a366617574686f726d6469643a6b65793a636166c3a968706f696e7465727381a264726f6c65646e6f7465667461726765746bc3bc6ec3af63c3b664c3a96974696d657374616d70f90000",
      id: "1e20ae8d97020b460597ffd10075fb7aa4d69af7ded1fd06fdaf013e5d3f26e0513e"
    }
  ];

  // ../../vectors/l0-delta/deltas-signed.json
  var deltas_signed_default = [
    {
      name: "signed-single-claim",
      spec: "SPEC-1 \xA75 / ERRATA D8-D9",
      keyId: "test-key-1",
      claims: {
        timestamp: 17179776e5,
        author: "ed25519:8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c",
        pointers: [
          {
            role: "title",
            target: "The Matrix"
          }
        ]
      },
      canonicalCborHex: "a366617574686f727848656432353531393a3861383865336464373430396631393566643532646232643363626135643732636136373039626631643934313231626633373438383031623430663666356368706f696e7465727381a264726f6c65657469746c65667461726765746a546865204d61747269786974696d657374616d70fb4278fff71d000000",
      id: "1e205b744c395553a498e17204d46c22293de849532d7394e71ec4ea25665c1cc2fa",
      sig: "07d38cc0b478a7f501fd51356a98383032725389adfa5a8fe00f589612181bd7f545299c621980255e6ded4fae30fc47860d8e64acb5ff8bcd32d02937d7f601"
    },
    {
      name: "signed-entity-ref",
      spec: "SPEC-1 \xA75 / ERRATA D8-D9",
      keyId: "test-key-2",
      claims: {
        timestamp: 42,
        author: "ed25519:8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394",
        pointers: [
          {
            role: "cast",
            target: {
              id: "entity:keanu",
              context: "actor"
            }
          }
        ]
      },
      canonicalCborHex: "a366617574686f727848656432353531393a3831333937373065613837643137356635366133353436366333346337656363636238643861393162346565333761323564663630663562386663396233393468706f696e7465727381a264726f6c65646361737466746172676574a26269646c656e746974793a6b65616e7567636f6e74657874656163746f726974696d657374616d70f95140",
      id: "1e20a8576e58e5cd51ff689252e4279927de268f524aa1a5deb60d24d788e91af512",
      sig: "ef55abc24edb782b4d2be028cd2aa1c322df534875635b3643977990b4f879da9386fd21705d77331c2a221a69eb5a55c82a912034283ad3ea99c477b1440204"
    },
    {
      name: "signed-negation",
      spec: "SPEC-1 \xA75 \xA77 / ERRATA D8-D9",
      keyId: "test-key-3",
      claims: {
        timestamp: 43,
        author: "ed25519:ff57575dc7af8bfc4d0837cc1ce2017b686a88145dc5579a958e3462fe9a908e",
        pointers: [
          {
            role: "negates",
            target: {
              delta: "1e2000000000000000000000000000000000000000000000000000000000000000"
            }
          }
        ]
      },
      canonicalCborHex: "a366617574686f727848656432353531393a6666353735373564633761663862666334643038333763633163653230313762363836613838313435646335353739613935386533343632666539613930386568706f696e7465727381a264726f6c65676e65676174657366746172676574a16564656c746178423165323030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030306974696d657374616d70f95160",
      id: "1e20de9cd104bc3d76e4062ec748ae98fb10f18fd7a99b9a80d1f1beaee38e48ef8e",
      sig: "c13d762c618a5432d90dd0658570f92023be3b21de3cd25b1c4eb36e922e1be57bc7f57a5f49b11f2776af1f004ef45df8d087c583a4433ec229a5501ec7e309"
    }
  ];

  // ../../vectors/l0-delta/set-digest.json
  var set_digest_default = {
    spec: "ERRATA D10 (provisional helper, not the SPEC-6 reconciliation digest)",
    ids: [
      "1e200561a1f0ed9b4f3619e1657ff6319fd6ca2812b8cd89ece6e46fb3608c219485",
      "1e2030d96d325c7cfeb599f488598055041fb5303f062d3b32b43d5abedc6d3cee18",
      "1e2060947ef77cb97b5d8905129276e5d14d4fe81a32de9514da1da1ac210b7b68ee",
      "1e2061705edb89869037fb5d850bcb235e5584292470249e650a0d790b28712c3949",
      "1e207b4310e7d0247d5f4671ae0cff5f2fd1df36cc7ab5e198f121008ee3dd3f8e91",
      "1e20a3a0a90a8c87aab1bad05dc7e971d20c772976658691ede840d5f38865c9de60",
      "1e20ae8d97020b460597ffd10075fb7aa4d69af7ded1fd06fdaf013e5d3f26e0513e",
      "1e20b210c4e3eb8a91fde259c7d2171cbf730685354f9f7a8df5e322da3f576e25a5"
    ],
    digest: "1e2045ed910984d0adf599284650e16f071d52eed8d4da39c0a8eac22698d5e9ce5d"
  };

  // ../../vectors/l1-eval/eval-basic.json
  var eval_basic_default = {
    fixture: {
      note: "deltas are listed with their fixture names; negations pin earlier deltas by id",
      deltas: [
        {
          name: "d1-title-matrix",
          id: "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
          claims: {
            timestamp: 100,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "title"
                }
              },
              {
                role: "value",
                target: "The Matrix"
              }
            ]
          }
        },
        {
          name: "d2-title-reloaded",
          id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
          claims: {
            timestamp: 200,
            author: "did:key:zBob",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "title"
                }
              },
              {
                role: "value",
                target: "Matrix Reloaded"
              }
            ]
          }
        },
        {
          name: "d3-year",
          id: "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
          claims: {
            timestamp: 150,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "releaseYear"
                }
              },
              {
                role: "value",
                target: 1999
              }
            ]
          }
        },
        {
          name: "d4-negates-d2",
          id: "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97",
          claims: {
            timestamp: 300,
            author: "did:key:zBob",
            pointers: [
              {
                role: "negates",
                target: {
                  delta: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
                }
              },
              {
                role: "reason",
                target: "typo"
              }
            ]
          }
        },
        {
          name: "d5-negates-d4",
          id: "1e20d52bc0da7ffc13ae23d2504ab0a2a06bbd943ff1d473c4915c4f3256f2dc059a",
          claims: {
            timestamp: 400,
            author: "did:key:zCarol",
            pointers: [
              {
                role: "negates",
                target: {
                  delta: "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97"
                }
              }
            ]
          }
        },
        {
          name: "d6-rating",
          id: "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f",
          claims: {
            timestamp: 500,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "rating"
                }
              },
              {
                role: "value",
                target: 8.7
              }
            ]
          }
        },
        {
          name: "d7-tag",
          id: "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8",
          claims: {
            timestamp: 120,
            author: "did:key:zCarol",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "tag"
                }
              },
              {
                role: "value",
                target: "scifi"
              }
            ]
          }
        },
        {
          name: "d8-other-movie",
          id: "1e20db70d6f537e65ce2a14d3b32a0abf3d48435be6dbc06aedba2f40ea1a3a5f709",
          claims: {
            timestamp: 600,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:johnwick",
                  context: "title"
                }
              },
              {
                role: "value",
                target: "John Wick"
              }
            ]
          }
        }
      ]
    },
    cases: [
      {
        name: "select-author-eq",
        spec: "SPEC-2 \xA73 \xA74.1",
        term: {
          op: "select",
          pred: {
            match: {
              field: "author",
              cmp: "eq",
              const: "did:key:zAlice"
            }
          },
          in: "input"
        },
        expected: {
          ids: [
            "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
            "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
            "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f",
            "1e20db70d6f537e65ce2a14d3b32a0abf3d48435be6dbc06aedba2f40ea1a3a5f709"
          ]
        },
        expectedCanonicalHex: "8478443165323031323866636339303366323237306337396130666534646536376265323465383564643763393564643131623464633235653761393339663432393937396331784431653230356566663439626236643033643362353362303932396538623761393635646132363064663935623234383934616136633338316265353834636633393339327844316532303662633536653039366535383535373332613266623863333739323338646239636332386236313332336165346366303534333631313665373366613866316678443165323064623730643666353337653635636532613134643362333261306162663364343834333562653664626330366165646261326634306561316133613566373039"
      },
      {
        name: "select-timestamp-lte",
        spec: "SPEC-2 \xA73 (time-travel as a filter)",
        term: {
          op: "select",
          pred: {
            match: {
              field: "timestamp",
              cmp: "lte",
              const: 200
            }
          },
          in: "input"
        },
        expected: {
          ids: [
            "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
            "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
            "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
            "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8"
          ]
        },
        expectedCanonicalHex: "8478443165323031323866636339303366323237306337396130666534646536376265323465383564643763393564643131623464633235653761393339663432393937396331784431653230356566663439626236643033643362353362303932396538623761393635646132363064663935623234383934616136633338316265353834636633393339327844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343478443165323063363930396266666239653162313938653334323139313165396232663434383263366130343263303939353435653762663464323631646230643837386238"
      },
      {
        name: "select-target-entity",
        spec: "SPEC-2 \xA73 hasPointer",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              targetEntity: "movie:matrix"
            }
          },
          in: "input"
        },
        expected: {
          ids: [
            "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
            "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
            "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f",
            "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
            "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8"
          ]
        },
        expectedCanonicalHex: "857844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633178443165323035656666343962623664303364336235336230393239653862376139363564613236306466393562323438393461613663333831626535383463663339333932784431653230366263353665303936653538353537333261326662386333373932333864623963633238623631333233616534636630353433363131366537336661386631667844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343478443165323063363930396266666239653162313938653334323139313165396232663434383263366130343263303939353435653762663464323631646230643837386238"
      },
      {
        name: "select-context-exact",
        spec: "SPEC-2 \xA73 hasPointer.context",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              context: {
                exact: "title"
              }
            }
          },
          in: "input"
        },
        expected: {
          ids: [
            "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
            "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
            "1e20db70d6f537e65ce2a14d3b32a0abf3d48435be6dbc06aedba2f40ea1a3a5f709"
          ]
        },
        expectedCanonicalHex: "83784431653230356566663439626236643033643362353362303932396538623761393635646132363064663935623234383934616136633338316265353834636633393339327844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343478443165323064623730643666353337653635636532613134643362333261306162663364343834333562653664626330366165646261326634306561316133613566373039"
      },
      {
        name: "select-role-prefix",
        spec: "SPEC-2 \xA73 StrMatch.prefix",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              role: {
                prefix: "neg"
              }
            }
          },
          in: "input"
        },
        expected: {
          ids: [
            "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97",
            "1e20d52bc0da7ffc13ae23d2504ab0a2a06bbd943ff1d473c4915c4f3256f2dc059a"
          ]
        },
        expectedCanonicalHex: "827844316532303831336133633235353266626537363033643666646163633336393735326635623037376337653663326534623266636433623835306437633638636262393778443165323064353262633064613766666331336165323364323530346162306132613036626264393433666631643437336334393135633466333235366632646330353961"
      },
      {
        name: "select-value-between",
        spec: "SPEC-2 \xA73 ValMatch.between (value index contract)",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              targetValue: {
                between: [
                  5,
                  2e3
                ]
              }
            }
          },
          in: "input"
        },
        expected: {
          ids: [
            "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
            "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f"
          ]
        },
        expectedCanonicalHex: "827844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633178443165323036626335366530393665353835353733326132666238633337393233386462396363323862363133323361653463663035343336313136653733666138663166"
      },
      {
        name: "select-value-gt-mixed-types",
        spec: "SPEC-2 \xA73 / ERRATA-2 E3 (bool < number < string)",
        note: "strings rank above all numbers in the canonical order, so every string value matches",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              targetValue: {
                vcmp: {
                  cmp: "gt",
                  value: 100
                }
              }
            }
          },
          in: "input"
        },
        expected: {
          ids: [
            "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
            "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
            "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97",
            "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
            "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8",
            "1e20db70d6f537e65ce2a14d3b32a0abf3d48435be6dbc06aedba2f40ea1a3a5f709"
          ]
        },
        expectedCanonicalHex: "86784431653230313238666363393033663232373063373961306665346465363762653234653835646437633935646431316234646332356537613933396634323939373963317844316532303565666634396262366430336433623533623039323965386237613936356461323630646639356232343839346161366333383162653538346366333933393278443165323038313361336332353532666265373630336436666461636333363937353266356230373763376536633265346232666364336238353064376336386362623937784431653230623735386430383439316436323464343562343163343862386363643761383438313564393466396565323237333336303735616331336436613762633734347844316532306336393039626666623965316231393865333432313931316539623266343438326336613034326330393935343565376266346432363164623064383738623878443165323064623730643666353337653635636532613134643362333261306162663364343834333562653664626330366165646261326634306561316133613566373039"
      },
      {
        name: "select-value-inset",
        spec: "SPEC-2 \xA73 ValMatch.inSet",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              targetValue: {
                inSet: [
                  "scifi",
                  "typo"
                ]
              }
            }
          },
          in: "input"
        },
        expected: {
          ids: [
            "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97",
            "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8"
          ]
        },
        expectedCanonicalHex: "827844316532303831336133633235353266626537363033643666646163633336393735326635623037376337653663326534623266636433623835306437633638636262393778443165323063363930396266666239653162313938653334323139313165396232663434383263366130343263303939353435653762663464323631646230643837386238"
      },
      {
        name: "select-and-not",
        spec: "SPEC-2 \xA73 connectives",
        term: {
          op: "select",
          pred: {
            and: [
              {
                match: {
                  field: "author",
                  cmp: "eq",
                  const: "did:key:zAlice"
                }
              },
              {
                not: {
                  hasPointer: {
                    context: {
                      exact: "title"
                    }
                  }
                }
              }
            ]
          },
          in: "input"
        },
        expected: {
          ids: [
            "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
            "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f"
          ]
        },
        expectedCanonicalHex: "827844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633178443165323036626335366530393665353835353733326132666238633337393233386462396363323862363133323361653463663035343336313136653733666138663166"
      },
      {
        name: "select-false-is-empty",
        spec: "SPEC-2 \xA73",
        term: {
          op: "select",
          pred: "false",
          in: "input"
        },
        expected: {
          ids: []
        },
        expectedCanonicalHex: "80"
      },
      {
        name: "union-two-selects",
        spec: "SPEC-2 \xA74.2",
        term: {
          op: "union",
          left: {
            op: "select",
            pred: {
              match: {
                field: "author",
                cmp: "eq",
                const: "did:key:zBob"
              }
            },
            in: "input"
          },
          right: {
            op: "select",
            pred: {
              match: {
                field: "author",
                cmp: "eq",
                const: "did:key:zCarol"
              }
            },
            in: "input"
          }
        },
        expected: {
          ids: [
            "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97",
            "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
            "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8",
            "1e20d52bc0da7ffc13ae23d2504ab0a2a06bbd943ff1d473c4915c4f3256f2dc059a"
          ]
        },
        expectedCanonicalHex: "8478443165323038313361336332353532666265373630336436666461636333363937353266356230373763376536633265346232666364336238353064376336386362623937784431653230623735386430383439316436323464343562343163343862386363643761383438313564393466396565323237333336303735616331336436613762633734347844316532306336393039626666623965316231393865333432313931316539623266343438326336613034326330393935343565376266346432363164623064383738623878443165323064353262633064613766666331336165323364323530346162306132613036626264393433666631643437336334393135633466333235366632646330353961"
      },
      {
        name: "mask-drop-chain",
        spec: "SPEC-2 \xA74.3 (even-length chain reinstates)",
        note: "d4 negates d2, d5 negates d4 => d4 suppressed, d2 reinstated",
        term: {
          op: "mask",
          policy: "drop",
          in: "input"
        },
        expected: {
          ids: [
            "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
            "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
            "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f",
            "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
            "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8",
            "1e20d52bc0da7ffc13ae23d2504ab0a2a06bbd943ff1d473c4915c4f3256f2dc059a",
            "1e20db70d6f537e65ce2a14d3b32a0abf3d48435be6dbc06aedba2f40ea1a3a5f709"
          ]
        },
        expectedCanonicalHex: "8778443165323031323866636339303366323237306337396130666534646536376265323465383564643763393564643131623464633235653761393339663432393937396331784431653230356566663439626236643033643362353362303932396538623761393635646132363064663935623234383934616136633338316265353834636633393339327844316532303662633536653039366535383535373332613266623863333739323338646239636332386236313332336165346366303534333631313665373366613866316678443165323062373538643038343931643632346434356234316334386238636364376138343831356439346639656532323733333630373561633133643661376263373434784431653230633639303962666662396531623139386533343231393131653962326634343832633661303432633039393534356537626634643236316462306438373862387844316532306435326263306461376666633133616532336432353034616230613261303662626439343366663164343733633439313563346633323536663264633035396178443165323064623730643666353337653635636532613134643362333261306162663364343834333562653664626330366165646261326634306561316133613566373039"
      },
      {
        name: "mask-annotate",
        spec: "SPEC-2 \xA74.3 / ERRATA-2 E2",
        term: {
          op: "mask",
          policy: "annotate",
          in: "input"
        },
        expected: {
          ids: [
            "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
            "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
            "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f",
            "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97",
            "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
            "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8",
            "1e20d52bc0da7ffc13ae23d2504ab0a2a06bbd943ff1d473c4915c4f3256f2dc059a",
            "1e20db70d6f537e65ce2a14d3b32a0abf3d48435be6dbc06aedba2f40ea1a3a5f709"
          ],
          negated: [
            "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97"
          ]
        },
        expectedCanonicalHex: "a263696473887844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633178443165323035656666343962623664303364336235336230393239653862376139363564613236306466393562323438393461613663333831626535383463663339333932784431653230366263353665303936653538353537333261326662386333373932333864623963633238623631333233616534636630353433363131366537336661386631667844316532303831336133633235353266626537363033643666646163633336393735326635623037376337653663326534623266636433623835306437633638636262393778443165323062373538643038343931643632346434356234316334386238636364376138343831356439346639656532323733333630373561633133643661376263373434784431653230633639303962666662396531623139386533343231393131653962326634343832633661303432633039393534356537626634643236316462306438373862387844316532306435326263306461376666633133616532336432353034616230613261303662626439343366663164343733633439313563346633323536663264633035396178443165323064623730643666353337653635636532613134643362333261306162663364343834333562653664626330366165646261326634306561316133613566373039676e6567617465648178443165323038313361336332353532666265373630336436666461636333363937353266356230373763376536633265346232666364336238353064376336386362623937"
      },
      {
        name: "mask-trust-restricts-candidates",
        spec: "SPEC-2 \xA74.3 / ERRATA-2 E4",
        note: "only B's negations count: d4 counts (d5 by C does not), so d2 is suppressed",
        term: {
          op: "mask",
          policy: {
            trust: {
              match: {
                field: "author",
                cmp: "eq",
                const: "did:key:zBob"
              }
            }
          },
          in: "input"
        },
        expected: {
          ids: [
            "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
            "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
            "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f",
            "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97",
            "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8",
            "1e20d52bc0da7ffc13ae23d2504ab0a2a06bbd943ff1d473c4915c4f3256f2dc059a",
            "1e20db70d6f537e65ce2a14d3b32a0abf3d48435be6dbc06aedba2f40ea1a3a5f709"
          ]
        },
        expectedCanonicalHex: "8778443165323031323866636339303366323237306337396130666534646536376265323465383564643763393564643131623464633235653761393339663432393937396331784431653230356566663439626236643033643362353362303932396538623761393635646132363064663935623234383934616136633338316265353834636633393339327844316532303662633536653039366535383535373332613266623863333739323338646239636332386236313332336165346366303534333631313665373366613866316678443165323038313361336332353532666265373630336436666461636333363937353266356230373763376536633265346232666364336238353064376336386362623937784431653230633639303962666662396531623139386533343231393131653962326634343832633661303432633039393534356537626634643236316462306438373862387844316532306435326263306461376666633133616532336432353034616230613261303662626439343366663164343733633439313563346633323536663264633035396178443165323064623730643666353337653635636532613134643362333261306162663364343834333562653664626330366165646261326634306561316133613566373039"
      },
      {
        name: "select-then-mask-scopes-to-operand",
        spec: "SPEC-2 \xA74.3 (negated(d, D) ranges over the operand set)",
        note: "the negation d4 is excluded by the select, so nothing in the subset is suppressed",
        term: {
          op: "mask",
          policy: "drop",
          in: {
            op: "select",
            pred: {
              hasPointer: {
                targetEntity: "movie:matrix"
              }
            },
            in: "input"
          }
        },
        expected: {
          ids: [
            "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
            "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
            "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f",
            "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
            "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8"
          ]
        },
        expectedCanonicalHex: "857844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633178443165323035656666343962623664303364336235336230393239653862376139363564613236306466393562323438393461613663333831626535383463663339333932784431653230366263353665303936653538353537333261326662386333373932333864623963633238623631333233616534636630353433363131366537336661386631667844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343478443165323063363930396266666239653162313938653334323139313165396232663434383263366130343263303939353435653762663464323631646230643837386238"
      }
    ]
  };

  // ../../vectors/l1-eval/eval-hview.json
  var eval_hview_default = {
    fixture: {
      note: "the eval-basic fixture plus d9 (multi-context filing) and d10 (contextless pointer)",
      deltas: [
        {
          name: "d1-title-matrix",
          id: "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
          claims: {
            timestamp: 100,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "title"
                }
              },
              {
                role: "value",
                target: "The Matrix"
              }
            ]
          }
        },
        {
          name: "d2-title-reloaded",
          id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
          claims: {
            timestamp: 200,
            author: "did:key:zBob",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "title"
                }
              },
              {
                role: "value",
                target: "Matrix Reloaded"
              }
            ]
          }
        },
        {
          name: "d3-year",
          id: "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
          claims: {
            timestamp: 150,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "releaseYear"
                }
              },
              {
                role: "value",
                target: 1999
              }
            ]
          }
        },
        {
          name: "d4-negates-d2",
          id: "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97",
          claims: {
            timestamp: 300,
            author: "did:key:zBob",
            pointers: [
              {
                role: "negates",
                target: {
                  delta: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
                }
              },
              {
                role: "reason",
                target: "typo"
              }
            ]
          }
        },
        {
          name: "d5-negates-d4",
          id: "1e20d52bc0da7ffc13ae23d2504ab0a2a06bbd943ff1d473c4915c4f3256f2dc059a",
          claims: {
            timestamp: 400,
            author: "did:key:zCarol",
            pointers: [
              {
                role: "negates",
                target: {
                  delta: "1e20813a3c2552fbe7603d6fdacc369752f5b077c7e6c2e4b2fcd3b850d7c68cbb97"
                }
              }
            ]
          }
        },
        {
          name: "d6-rating",
          id: "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f",
          claims: {
            timestamp: 500,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "rating"
                }
              },
              {
                role: "value",
                target: 8.7
              }
            ]
          }
        },
        {
          name: "d7-tag",
          id: "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8",
          claims: {
            timestamp: 120,
            author: "did:key:zCarol",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "tag"
                }
              },
              {
                role: "value",
                target: "scifi"
              }
            ]
          }
        },
        {
          name: "d8-other-movie",
          id: "1e20db70d6f537e65ce2a14d3b32a0abf3d48435be6dbc06aedba2f40ea1a3a5f709",
          claims: {
            timestamp: 600,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:johnwick",
                  context: "title"
                }
              },
              {
                role: "value",
                target: "John Wick"
              }
            ]
          }
        },
        {
          name: "d9-variant",
          id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2",
          claims: {
            timestamp: 700,
            author: "did:key:zCarol",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "title"
                }
              },
              {
                role: "variantOf",
                target: {
                  id: "movie:matrix",
                  context: "related"
                }
              },
              {
                role: "value",
                target: "The Matrix (1999)"
              }
            ]
          }
        },
        {
          name: "d10-contextless-mention",
          id: "1e20068781e4ad85fb3d8509cee8f3654fc2a2795c09dedce91a5a308e720de2c83f",
          claims: {
            timestamp: 800,
            author: "did:key:zBob",
            pointers: [
              {
                role: "mentions",
                target: {
                  id: "movie:matrix"
                }
              }
            ]
          }
        }
      ]
    },
    cases: [
      {
        name: "group-by-target-context-canonical-idiom",
        spec: "SPEC-2 \xA74.4 / SPEC-3 \xA72 / E6",
        note: "select relevant, drop negated, file by target-context \u2014 the canonical schema body",
        root: "movie:matrix",
        term: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "select",
            pred: {
              hasPointer: {
                targetEntity: "movie:matrix"
              }
            },
            in: {
              op: "mask",
              policy: "drop",
              in: "input"
            }
          }
        },
        expected: {
          id: "movie:matrix",
          props: {
            rating: [
              {
                id: "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f"
              }
            ],
            related: [
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              }
            ],
            releaseYear: [
              {
                id: "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1"
              }
            ],
            tag: [
              {
                id: "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8"
              }
            ],
            title: [
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              },
              {
                id: "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392"
              },
              {
                id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
              }
            ]
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a56374616781a26269647844316532306336393039626666623965316231393865333432313931316539623266343438326336613034326330393935343565376266346432363164623064383738623866636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787463746167a264726f6c656576616c7565667461726765746573636966696974696d657374616d70f95780657469746c6583a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f96178a26269647844316532303565666634396262366430336433623533623039323965386237613936356461323630646639356232343839346161366333383162653538346366333933393266636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f95640a26269647844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343466636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746f4d61747269782052656c6f616465646974696d657374616d70f95a4066726174696e6781a26269647844316532303662633536653039366535383535373332613266623863333739323338646239636332386236313332336165346366303534333631313665373366613866316666636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c656576616c756566746172676574fb40216666666666666974696d657374616d70f95fd06772656c6174656481a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f961786b72656c656173655965617281a26269647844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746b72656c6561736559656172a264726f6c656576616c756566746172676574f967cf6974696d657374616d70f958b0"
      },
      {
        name: "group-by-role",
        spec: "SPEC-2 \xA74.4 / E6",
        root: "movie:matrix",
        term: {
          op: "group",
          key: "byRole",
          in: {
            op: "select",
            pred: {
              hasPointer: {
                targetEntity: "movie:matrix"
              }
            },
            in: "input"
          }
        },
        expected: {
          id: "movie:matrix",
          props: {
            mentions: [
              {
                id: "1e20068781e4ad85fb3d8509cee8f3654fc2a2795c09dedce91a5a308e720de2c83f"
              }
            ],
            subject: [
              {
                id: "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1"
              },
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              },
              {
                id: "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392"
              },
              {
                id: "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f"
              },
              {
                id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
              },
              {
                id: "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8"
              }
            ],
            variantOf: [
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              }
            ]
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a3677375626a65637486a26269647844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746b72656c6561736559656172a264726f6c656576616c756566746172676574f967cf6974696d657374616d70f958b0a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f96178a26269647844316532303565666634396262366430336433623533623039323965386237613936356461323630646639356232343839346161366333383162653538346366333933393266636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f95640a26269647844316532303662633536653039366535383535373332613266623863333739323338646239636332386236313332336165346366303534333631313665373366613866316666636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c656576616c756566746172676574fb40216666666666666974696d657374616d70f95fd0a26269647844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343466636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746f4d61747269782052656c6f616465646974696d657374616d70f95a40a26269647844316532306336393039626666623965316231393865333432313931316539623266343438326336613034326330393935343565376266346432363164623064383738623866636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787463746167a264726f6c656576616c7565667461726765746573636966696974696d657374616d70f95780686d656e74696f6e7381a26269647844316532303036383738316534616438356662336438353039636565386633363534666332613237393563303964656463653931613561333038653732306465326338336666636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727381a264726f6c65686d656e74696f6e7366746172676574a16269646c6d6f7669653a6d61747269786974696d657374616d70f962406976617269616e744f6681a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f96178"
      },
      {
        name: "group-const-bags-everything",
        spec: "SPEC-2 \xA74.4 / E6 (const files without a filing pointer)",
        root: "movie:matrix",
        term: {
          op: "group",
          key: {
            const: "claims"
          },
          in: {
            op: "select",
            pred: {
              match: {
                field: "author",
                cmp: "eq",
                const: "did:key:zAlice"
              }
            },
            in: "input"
          }
        },
        expected: {
          id: "movie:matrix",
          props: {
            claims: [
              {
                id: "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1"
              },
              {
                id: "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392"
              },
              {
                id: "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f"
              },
              {
                id: "1e20db70d6f537e65ce2a14d3b32a0abf3d48435be6dbc06aedba2f40ea1a3a5f709"
              }
            ]
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a166636c61696d7384a26269647844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746b72656c6561736559656172a264726f6c656576616c756566746172676574f967cf6974696d657374616d70f958b0a26269647844316532303565666634396262366430336433623533623039323965386237613936356461323630646639356232343839346161366333383162653538346366333933393266636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f95640a26269647844316532303662633536653039366535383535373332613266623863333739323338646239636332386236313332336165346366303534333631313665373366613866316666636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c656576616c756566746172676574fb40216666666666666974696d657374616d70f95fd0a26269647844316532306462373064366635333765363563653261313464336233326130616266336434383433356265366462633036616564626132663430656131613361356637303966636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646e6d6f7669653a6a6f686e7769636b67636f6e74657874657469746c65a264726f6c656576616c756566746172676574694a6f686e205769636b6974696d657374616d70f960b0"
      },
      {
        name: "group-threads-annotate-tags",
        spec: "SPEC-5 \xA74 audit views / E7",
        note: "d2 is negated in the full input, so its entry carries negated: true",
        root: "movie:matrix",
        term: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "mask",
            policy: "annotate",
            in: "input"
          }
        },
        expected: {
          id: "movie:matrix",
          props: {
            rating: [
              {
                id: "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f"
              }
            ],
            related: [
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              }
            ],
            releaseYear: [
              {
                id: "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1"
              }
            ],
            tag: [
              {
                id: "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8"
              }
            ],
            title: [
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              },
              {
                id: "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392"
              },
              {
                id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
              }
            ]
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a56374616781a26269647844316532306336393039626666623965316231393865333432313931316539623266343438326336613034326330393935343565376266346432363164623064383738623866636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787463746167a264726f6c656576616c7565667461726765746573636966696974696d657374616d70f95780657469746c6583a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f96178a26269647844316532303565666634396262366430336433623533623039323965386237613936356461323630646639356232343839346161366333383162653538346366333933393266636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f95640a26269647844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343466636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746f4d61747269782052656c6f616465646974696d657374616d70f95a4066726174696e6781a26269647844316532303662633536653039366535383535373332613266623863333739323338646239636332386236313332336165346366303534333631313665373366613866316666636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c656576616c756566746172676574fb40216666666666666974696d657374616d70f95fd06772656c6174656481a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f961786b72656c656173655965617281a26269647844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746b72656c6561736559656172a264726f6c656576616c756566746172676574f967cf6974696d657374616d70f958b0"
      },
      {
        name: "group-by-target-context-skips-contextless",
        spec: "E6 (a filing pointer without context files nothing)",
        root: "movie:matrix",
        term: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "select",
            pred: {
              match: {
                field: "author",
                cmp: "eq",
                const: "did:key:zBob"
              }
            },
            in: "input"
          }
        },
        expected: {
          id: "movie:matrix",
          props: {
            title: [
              {
                id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
              }
            ]
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a1657469746c6581a26269647844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343466636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746f4d61747269782052656c6f616465646974696d657374616d70f95a40"
      },
      {
        name: "group-by-role-files-contextless",
        spec: "E6 (byRole files under the pointer role)",
        root: "movie:matrix",
        term: {
          op: "group",
          key: "byRole",
          in: {
            op: "select",
            pred: {
              match: {
                field: "author",
                cmp: "eq",
                const: "did:key:zBob"
              }
            },
            in: "input"
          }
        },
        expected: {
          id: "movie:matrix",
          props: {
            mentions: [
              {
                id: "1e20068781e4ad85fb3d8509cee8f3654fc2a2795c09dedce91a5a308e720de2c83f"
              }
            ],
            subject: [
              {
                id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
              }
            ]
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a2677375626a65637481a26269647844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343466636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746f4d61747269782052656c6f616465646974696d657374616d70f95a40686d656e74696f6e7381a26269647844316532303036383738316534616438356662336438353039636565386633363534666332613237393563303964656463653931613561333038653732306465326338336666636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727381a264726f6c65686d656e74696f6e7366746172676574a16269646c6d6f7669653a6d61747269786974696d657374616d70f96240"
      },
      {
        name: "group-empty-root",
        spec: "SPEC-3 \xA77 (empty props, never null)",
        root: "movie:nonexistent",
        term: {
          op: "group",
          key: "byTargetContext",
          in: "input"
        },
        expected: {
          id: "movie:nonexistent",
          props: {}
        },
        expectedCanonicalHex: "a2626964716d6f7669653a6e6f6e6578697374656e746570726f7073a0"
      },
      {
        name: "prune-keep-exact",
        spec: "SPEC-2 \xA74.6 / E8",
        root: "movie:matrix",
        term: {
          op: "prune",
          keep: {
            exact: "title"
          },
          in: {
            op: "group",
            key: "byTargetContext",
            in: {
              op: "select",
              pred: {
                hasPointer: {
                  targetEntity: "movie:matrix"
                }
              },
              in: {
                op: "mask",
                policy: "drop",
                in: "input"
              }
            }
          }
        },
        expected: {
          id: "movie:matrix",
          props: {
            title: [
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              },
              {
                id: "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392"
              },
              {
                id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
              }
            ]
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a1657469746c6583a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f96178a26269647844316532303565666634396262366430336433623533623039323965386237613936356461323630646639356232343839346161366333383162653538346366333933393266636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f95640a26269647844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343466636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746f4d61747269782052656c6f616465646974696d657374616d70f95a40"
      },
      {
        name: "prune-keep-inset",
        spec: "SPEC-2 \xA74.6 / E8",
        root: "movie:matrix",
        term: {
          op: "prune",
          keep: {
            inSet: [
              "title",
              "rating"
            ]
          },
          in: {
            op: "group",
            key: "byTargetContext",
            in: {
              op: "select",
              pred: {
                hasPointer: {
                  targetEntity: "movie:matrix"
                }
              },
              in: {
                op: "mask",
                policy: "drop",
                in: "input"
              }
            }
          }
        },
        expected: {
          id: "movie:matrix",
          props: {
            rating: [
              {
                id: "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f"
              }
            ],
            title: [
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              },
              {
                id: "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392"
              },
              {
                id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
              }
            ]
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a2657469746c6583a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f96178a26269647844316532303565666634396262366430336433623533623039323965386237613936356461323630646639356232343839346161366333383162653538346366333933393266636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f95640a26269647844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343466636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746f4d61747269782052656c6f616465646974696d657374616d70f95a4066726174696e6781a26269647844316532303662633536653039366535383535373332613266623863333739323338646239636332386236313332336165346366303534333631313665373366613866316666636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c656576616c756566746172676574fb40216666666666666974696d657374616d70f95fd0"
      },
      {
        name: "prune-keep-prefix",
        spec: "SPEC-2 \xA74.6 / E8",
        root: "movie:matrix",
        term: {
          op: "prune",
          keep: {
            prefix: "re"
          },
          in: {
            op: "group",
            key: "byTargetContext",
            in: {
              op: "select",
              pred: {
                hasPointer: {
                  targetEntity: "movie:matrix"
                }
              },
              in: {
                op: "mask",
                policy: "drop",
                in: "input"
              }
            }
          }
        },
        expected: {
          id: "movie:matrix",
          props: {
            related: [
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              }
            ],
            releaseYear: [
              {
                id: "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1"
              }
            ]
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a26772656c6174656481a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f961786b72656c656173655965617281a26269647844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746b72656c6561736559656172a264726f6c656576616c756566746172676574f967cf6974696d657374616d70f958b0"
      },
      {
        name: "prune-all-is-identity",
        spec: "SPEC-2 \xA74.6 / E8",
        root: "movie:matrix",
        term: {
          op: "prune",
          keep: "all",
          in: {
            op: "group",
            key: "byTargetContext",
            in: {
              op: "select",
              pred: {
                hasPointer: {
                  targetEntity: "movie:matrix"
                }
              },
              in: {
                op: "mask",
                policy: "drop",
                in: "input"
              }
            }
          }
        },
        expected: {
          id: "movie:matrix",
          props: {
            rating: [
              {
                id: "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f"
              }
            ],
            related: [
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              }
            ],
            releaseYear: [
              {
                id: "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1"
              }
            ],
            tag: [
              {
                id: "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8"
              }
            ],
            title: [
              {
                id: "1e205ed1ab653742434cc1dcd417ea55f1a150ebd3d50dba8ce50be8df83cd9f87a2"
              },
              {
                id: "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392"
              },
              {
                id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
              }
            ]
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a56374616781a26269647844316532306336393039626666623965316231393865333432313931316539623266343438326336613034326330393935343565376266346432363164623064383738623866636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787463746167a264726f6c656576616c7565667461726765746573636966696974696d657374616d70f95780657469746c6583a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f96178a26269647844316532303565666634396262366430336433623533623039323965386237613936356461323630646639356232343839346161366333383162653538346366333933393266636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f95640a26269647844316532306237353864303834393164363234643435623431633438623863636437613834383135643934663965653232373333363037356163313364366137626337343466636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746f4d61747269782052656c6f616465646974696d657374616d70f95a4066726174696e6781a26269647844316532303662633536653039366535383535373332613266623863333739323338646239636332386236313332336165346366303534333631313665373366613866316666636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c656576616c756566746172676574fb40216666666666666974696d657374616d70f95fd06772656c6174656481a26269647844316532303565643161623635333734323433346363316463643431376561353566316131353065626433643530646261386365353062653864663833636439663837613266636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727383a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656976617269616e744f6666746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746772656c61746564a264726f6c656576616c75656674617267657471546865204d6174726978202831393939296974696d657374616d70f961786b72656c656173655965617281a26269647844316532303132386663633930336632323730633739613066653464653637626532346538356464376339356464313162346463323565376139333966343239393739633166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746b72656c6561736559656172a264726f6c656576616c756566746172676574f967cf6974696d657374616d70f958b0"
      }
    ]
  };

  // ../../vectors/l1-eval/eval-expand.json
  var eval_expand_default = {
    fixture: {
      note: "actors/movies with a keanu<->brzrkr data cycle; schema DAG depth 3",
      deltas: [
        {
          name: "a1-keanu-name",
          id: "1e20537093438b01909c6e1712242059f38f66f089ea45414cb7ddf7c9ed29ded216",
          claims: {
            timestamp: 100,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "actor:keanu",
                  context: "name"
                }
              },
              {
                role: "value",
                target: "Keanu Reeves"
              }
            ]
          }
        },
        {
          name: "m1-matrix-title",
          id: "1e2066627aab9274f448bbcac65c548038bd035e9118a3a9a09a3a9a7f9a5972483e",
          claims: {
            timestamp: 110,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "title"
                }
              },
              {
                role: "value",
                target: "The Matrix"
              }
            ]
          }
        },
        {
          name: "m2-brzrkr-title",
          id: "1e201f3746069c9313015cec661386a7e766378557dbe95764ce61e1e051810a467d",
          claims: {
            timestamp: 120,
            author: "did:key:zBob",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:brzrkr",
                  context: "title"
                }
              },
              {
                role: "value",
                target: "BRZRKR"
              }
            ]
          }
        },
        {
          name: "c1-cast",
          id: "1e207ea21fff501c626cdb8e592db4162519c89a84feadfbbf5851577e5ef2c04d9d",
          claims: {
            timestamp: 130,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "movie",
                target: {
                  id: "movie:matrix",
                  context: "cast"
                }
              },
              {
                role: "actor",
                target: {
                  id: "actor:keanu",
                  context: "filmography"
                }
              },
              {
                role: "character",
                target: "Neo"
              }
            ]
          }
        },
        {
          name: "c2-created",
          id: "1e20e941d451956d79a42ac465f2f832b3e47903522fc9eb6b3d41e0871da3943430",
          claims: {
            timestamp: 140,
            author: "did:key:zCarol",
            pointers: [
              {
                role: "creator",
                target: {
                  id: "actor:keanu",
                  context: "createdWorks"
                }
              },
              {
                role: "work",
                target: {
                  id: "movie:brzrkr",
                  context: "createdBy"
                }
              }
            ]
          }
        }
      ]
    },
    schemas: [
      {
        name: "MovieBasic",
        alg: 1,
        body: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "select",
            pred: {
              hasPointer: {
                targetEntity: {
                  var: "root"
                }
              }
            },
            in: {
              op: "mask",
              policy: "drop",
              in: "input"
            }
          }
        }
      },
      {
        name: "ActorName",
        alg: 1,
        body: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "select",
            pred: {
              hasPointer: {
                targetEntity: {
                  var: "root"
                }
              }
            },
            in: {
              op: "mask",
              policy: "drop",
              in: "input"
            }
          }
        }
      },
      {
        name: "MovieWithCast",
        alg: 1,
        body: {
          op: "expand",
          role: {
            exact: "actor"
          },
          schema: "ActorName",
          in: {
            op: "group",
            key: "byTargetContext",
            in: {
              op: "select",
              pred: {
                hasPointer: {
                  targetEntity: {
                    var: "root"
                  }
                }
              },
              in: {
                op: "mask",
                policy: "drop",
                in: "input"
              }
            }
          }
        }
      },
      {
        name: "ActorWithWorks",
        alg: 1,
        body: {
          op: "expand",
          role: {
            exact: "work"
          },
          schema: "MovieBasic",
          in: {
            op: "group",
            key: "byTargetContext",
            in: {
              op: "select",
              pred: {
                hasPointer: {
                  targetEntity: {
                    var: "root"
                  }
                }
              },
              in: {
                op: "mask",
                policy: "drop",
                in: "input"
              }
            }
          }
        }
      },
      {
        name: "MovieDeep",
        alg: 1,
        body: {
          op: "expand",
          role: {
            exact: "actor"
          },
          schema: "ActorWithWorks",
          in: {
            op: "group",
            key: "byTargetContext",
            in: {
              op: "select",
              pred: {
                hasPointer: {
                  targetEntity: {
                    var: "root"
                  }
                }
              },
              in: {
                op: "mask",
                policy: "drop",
                in: "input"
              }
            }
          }
        }
      }
    ],
    cases: [
      {
        name: "fix-terminal-schema",
        spec: "SPEC-2 \xA74.8 / E10",
        note: "no expands: entity refs stay bare (terminal schema, SPEC-3 \xA73)",
        term: {
          op: "fix",
          schema: "MovieBasic",
          entity: "movie:matrix"
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a2646361737481a26269647844316532303765613231666666353031633632366364623865353932646234313632353139633839613834666561646662626635383531353737653565663263303464396466636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727383a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746b66696c6d6f677261706879a264726f6c656963686172616374657266746172676574634e656f6974696d657374616d70f95810657469746c6581a26269647844316532303636363237616162393237346634343862626361633635633534383033386264303335653931313861336139613039613361396137663961353937323438336566636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f956e0"
      },
      {
        name: "fix-expand-one-level",
        spec: "SPEC-2 \xA74.5 \xA74.8 / E11",
        note: "c1's actor pointer is replaced by the ActorName HView at actor:keanu",
        term: {
          op: "fix",
          schema: "MovieWithCast",
          entity: "movie:matrix"
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a2646361737481a26269647844316532303765613231666666353031633632366364623865353932646234313632353139633839613834666561646662626635383531353737653565663263303464396466636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727383a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646b6163746f723a6b65616e756570726f7073a3646e616d6581a26269647844316532303533373039333433386230313930396336653137313232343230353966333866363666303839656134353431346362376464663763396564323964656432313666636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646b6163746f723a6b65616e7567636f6e74657874646e616d65a264726f6c656576616c7565667461726765746c4b65616e75205265657665736974696d657374616d70f956406b66696c6d6f67726170687981a26269647844316532303765613231666666353031633632366364623865353932646234313632353139633839613834666561646662626635383531353737653565663263303464396466636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727383a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746b66696c6d6f677261706879a264726f6c656963686172616374657266746172676574634e656f6974696d657374616d70f958106c63726561746564576f726b7381a26269647844316532306539343164343531393536643739613432616334363566326638333262336534373930333532326663396562366233643431653038373164613339343334333066636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727382a264726f6c656763726561746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746c63726561746564576f726b73a264726f6c6564776f726b66746172676574a26269646c6d6f7669653a62727a726b7267636f6e74657874696372656174656442796974696d657374616d70f95860a264726f6c656963686172616374657266746172676574634e656f6974696d657374616d70f95810657469746c6581a26269647844316532303636363237616162393237346634343862626361633635633534383033386264303335653931313861336139613039613361396137663961353937323438336566636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f956e0"
      },
      {
        name: "fix-data-cycle-terminates",
        spec: "SPEC-3 \xA73 (DAG on programs, not data)",
        note: "keanu -> brzrkr -> keanu is a data cycle; the schema chain MovieDeep -> ActorWithWorks -> MovieBasic is finite, so expansion terminates with brzrkr's createdBy as a bare ref",
        term: {
          op: "fix",
          schema: "MovieDeep",
          entity: "movie:matrix"
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a2646361737481a26269647844316532303765613231666666353031633632366364623865353932646234313632353139633839613834666561646662626635383531353737653565663263303464396466636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727383a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646b6163746f723a6b65616e756570726f7073a3646e616d6581a26269647844316532303533373039333433386230313930396336653137313232343230353966333866363666303839656134353431346362376464663763396564323964656432313666636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646b6163746f723a6b65616e7567636f6e74657874646e616d65a264726f6c656576616c7565667461726765746c4b65616e75205265657665736974696d657374616d70f956406b66696c6d6f67726170687981a26269647844316532303765613231666666353031633632366364623865353932646234313632353139633839613834666561646662626635383531353737653565663263303464396466636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727383a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746b66696c6d6f677261706879a264726f6c656963686172616374657266746172676574634e656f6974696d657374616d70f958106c63726561746564576f726b7381a26269647844316532306539343164343531393536643739613432616334363566326638333262336534373930333532326663396562366233643431653038373164613339343334333066636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727382a264726f6c656763726561746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746c63726561746564576f726b73a264726f6c6564776f726b66746172676574a26269646c6d6f7669653a62727a726b726570726f7073a2657469746c6581a26269647844316532303166333734363036396339333133303135636563363631333836613765373636333738353537646265393537363463653631653165303531383130613436376466636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a62727a726b7267636f6e74657874657469746c65a264726f6c656576616c7565667461726765746642525a524b526974696d657374616d70f957806963726561746564427981a26269647844316532306539343164343531393536643739613432616334363566326638333262336534373930333532326663396562366233643431653038373164613339343334333066636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727382a264726f6c656763726561746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746c63726561746564576f726b73a264726f6c6564776f726b66746172676574a26269646c6d6f7669653a62727a726b7267636f6e74657874696372656174656442796974696d657374616d70f958606974696d657374616d70f95860a264726f6c656963686172616374657266746172676574634e656f6974696d657374616d70f95810657469746c6581a26269647844316532303636363237616162393237346634343862626361633635633534383033386264303335653931313861336139613039613361396137663961353937323438336566636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f956e0"
      },
      {
        name: "fix-actor-perspective",
        spec: "SPEC-2 \xA74.8",
        term: {
          op: "fix",
          schema: "ActorWithWorks",
          entity: "actor:keanu"
        },
        expectedCanonicalHex: "a26269646b6163746f723a6b65616e756570726f7073a3646e616d6581a26269647844316532303533373039333433386230313930396336653137313232343230353966333866363666303839656134353431346362376464663763396564323964656432313666636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646b6163746f723a6b65616e7567636f6e74657874646e616d65a264726f6c656576616c7565667461726765746c4b65616e75205265657665736974696d657374616d70f956406b66696c6d6f67726170687981a26269647844316532303765613231666666353031633632366364623865353932646234313632353139633839613834666561646662626635383531353737653565663263303464396466636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727383a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746b66696c6d6f677261706879a264726f6c656963686172616374657266746172676574634e656f6974696d657374616d70f958106c63726561746564576f726b7381a26269647844316532306539343164343531393536643739613432616334363566326638333262336534373930333532326663396562366233643431653038373164613339343334333066636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727382a264726f6c656763726561746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746c63726561746564576f726b73a264726f6c6564776f726b66746172676574a26269646c6d6f7669653a62727a726b726570726f7073a2657469746c6581a26269647844316532303166333734363036396339333133303135636563363631333836613765373636333738353537646265393537363463653631653165303531383130613436376466636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a62727a726b7267636f6e74657874657469746c65a264726f6c656576616c7565667461726765746642525a524b526974696d657374616d70f957806963726561746564427981a26269647844316532306539343164343531393536643739613432616334363566326638333262336534373930333532326663396562366233643431653038373164613339343334333066636c61696d73a366617574686f726e6469643a6b65793a7a4361726f6c68706f696e7465727382a264726f6c656763726561746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746c63726561746564576f726b73a264726f6c6564776f726b66746172676574a26269646c6d6f7669653a62727a726b7267636f6e74657874696372656174656442796974696d657374616d70f958606974696d657374616d70f95860"
      },
      {
        name: "expand-no-matching-role-is-identity",
        spec: "SPEC-3 \xA77 (graceful degradation)",
        term: {
          op: "expand",
          role: {
            exact: "nonexistent"
          },
          schema: "ActorName",
          in: {
            op: "fix",
            schema: "MovieBasic",
            entity: "movie:matrix"
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a2646361737481a26269647844316532303765613231666666353031633632366364623865353932646234313632353139633839613834666561646662626635383531353737653565663263303464396466636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727383a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746b66696c6d6f677261706879a264726f6c656963686172616374657266746172676574634e656f6974696d657374616d70f95810657469746c6581a26269647844316532303636363237616162393237346634343862626361633635633534383033386264303335653931313861336139613039613361396137663961353937323438336566636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f956e0"
      },
      {
        name: "expand-skips-primitive-targets",
        spec: "E11 (only EntityRef targets expand)",
        note: 'c1.character targets the primitive "Neo"; role matches but the target kind does not',
        term: {
          op: "expand",
          role: {
            exact: "character"
          },
          schema: "ActorName",
          in: {
            op: "fix",
            schema: "MovieBasic",
            entity: "movie:matrix"
          }
        },
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a2646361737481a26269647844316532303765613231666666353031633632366364623865353932646234313632353139633839613834666561646662626635383531353737653565663263303464396466636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727383a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646b6163746f723a6b65616e7567636f6e746578746b66696c6d6f677261706879a264726f6c656963686172616374657266746172676574634e656f6974696d657374616d70f95810657469746c6581a26269647844316532303636363237616162393237346634343862626361633635633534383033386264303335653931313861336139613039613361396137663961353937323438336566636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65677375626a65637466746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c656576616c7565667461726765746a546865204d61747269786974696d657374616d70f956e0"
      },
      {
        name: "fix-unknown-entity-is-empty",
        spec: "SPEC-3 \xA77",
        term: {
          op: "fix",
          schema: "MovieDeep",
          entity: "movie:unknown"
        },
        expectedCanonicalHex: "a26269646d6d6f7669653a756e6b6e6f776e6570726f7073a0"
      }
    ]
  };

  // ../../vectors/l1-eval/eval-resolve.json
  var eval_resolve_default = {
    fixture: {
      note: "superposed titles, competing ratings, mixed-type sizes, a negation, and a cast edge for nested resolution",
      deltas: [
        {
          name: "t1-title-a",
          id: "1e205eff49bb6d03d3b53b0929e8b7a965da260df95b24894aa6c381be584cf39392",
          claims: {
            timestamp: 100,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "title"
                }
              },
              {
                role: "value",
                target: "The Matrix"
              }
            ]
          }
        },
        {
          name: "t2-title-b",
          id: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744",
          claims: {
            timestamp: 200,
            author: "did:key:zBob",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "title"
                }
              },
              {
                role: "value",
                target: "Matrix Reloaded"
              }
            ]
          }
        },
        {
          name: "y1-year",
          id: "1e20128fcc903f2270c79a0fe4de67be24e85dd7c95dd11b4dc25e7a939f429979c1",
          claims: {
            timestamp: 150,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "releaseYear"
                }
              },
              {
                role: "value",
                target: 1999
              }
            ]
          }
        },
        {
          name: "r1-rating-a",
          id: "1e206bc56e096e5855732a2fb8c379238db9cc28b61323ae4cf05436116e73fa8f1f",
          claims: {
            timestamp: 500,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "rating"
                }
              },
              {
                role: "value",
                target: 8.7
              }
            ]
          }
        },
        {
          name: "r2-rating-b",
          id: "1e2020389ed306335a0a3462af525c34b9db4bd79d79d91f61fbfcddc0af0ec1aa2d",
          claims: {
            timestamp: 600,
            author: "did:key:zBob",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "rating"
                }
              },
              {
                role: "value",
                target: 9.1
              }
            ]
          }
        },
        {
          name: "g1-tag-scifi",
          id: "1e20c6909bffb9e1b198e3421911e9b2f4482c6a042c099545e7bf4d261db0d878b8",
          claims: {
            timestamp: 120,
            author: "did:key:zCarol",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "tag"
                }
              },
              {
                role: "value",
                target: "scifi"
              }
            ]
          }
        },
        {
          name: "g2-tag-action",
          id: "1e20a75bf8b77f15ec02483c1c86443ccde70d1be01e7a011df22009346c4630975c",
          claims: {
            timestamp: 610,
            author: "did:key:zBob",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "tag"
                }
              },
              {
                role: "value",
                target: "action"
              }
            ]
          }
        },
        {
          name: "s1-size-str",
          id: "1e20a22266ce59718d14044c011026779b17e6da1ded148ee7fe01b94ba1931e82cf",
          claims: {
            timestamp: 700,
            author: "did:key:zCarol",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "size"
                }
              },
              {
                role: "value",
                target: "large"
              }
            ]
          }
        },
        {
          name: "s2-size-num",
          id: "1e20ae788b814e849a0c8d5c26a5ac260bf85cde7c8802f126168d0c1f72037ef487",
          claims: {
            timestamp: 710,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "movie:matrix",
                  context: "size"
                }
              },
              {
                role: "value",
                target: 3
              }
            ]
          }
        },
        {
          name: "n1-negates-t2",
          id: "1e204b62bb91e392af6ff668d0d8a974e6df49b722ca265f357740380532ee892c26",
          claims: {
            timestamp: 300,
            author: "did:key:zBob",
            pointers: [
              {
                role: "negates",
                target: {
                  delta: "1e20b758d08491d624d45b41c48b8ccd7a84815d94f9ee227336075ac13d6a7bc744"
                }
              }
            ]
          }
        },
        {
          name: "a1-keanu-name",
          id: "1e20a3819b9abb8b7b3e1bd06687fdf661d8c58496494c3bff907a62138db3983174",
          claims: {
            timestamp: 110,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "actor:keanu",
                  context: "name"
                }
              },
              {
                role: "value",
                target: "Keanu Reeves"
              }
            ]
          }
        },
        {
          name: "c1-cast",
          id: "1e207ea21fff501c626cdb8e592db4162519c89a84feadfbbf5851577e5ef2c04d9d",
          claims: {
            timestamp: 130,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "movie",
                target: {
                  id: "movie:matrix",
                  context: "cast"
                }
              },
              {
                role: "actor",
                target: {
                  id: "actor:keanu",
                  context: "filmography"
                }
              },
              {
                role: "character",
                target: "Neo"
              }
            ]
          }
        },
        {
          name: "w1-bio-old",
          id: "1e201dcf76c37cc1e509557f84a5c9602e3b93f4adcc64b2a2fff1adf007191d79d0",
          claims: {
            timestamp: 100,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "person:wren",
                  context: "bio"
                }
              },
              {
                role: "value",
                target: "Founder of the village archive"
              }
            ]
          }
        },
        {
          name: "w2-bio-new",
          id: "1e20fbc7c918d328eb930d126b52c67e106f121d97faa00643390670f162aa277025",
          claims: {
            timestamp: 500,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "person:wren",
                  context: "bio"
                }
              },
              {
                role: "value",
                target: "Archivist and cartographer"
              }
            ]
          }
        },
        {
          name: "f1-bio-unranked",
          id: "1e204ba8cfdda0237d8a1a3eb1e63c6712d78555528129d56f2f47288b8c28c168e8",
          claims: {
            timestamp: 900,
            author: "did:key:zCarol",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "person:wren",
                  context: "bio"
                }
              },
              {
                role: "value",
                target: "Retired from public life"
              }
            ]
          }
        },
        {
          name: "m1-motto-a",
          id: "1e207a4a17d0653ce00ba5d45aacbc2a294a0c583d2193ec09a79b7ecabe8aca3ddb",
          claims: {
            timestamp: 400,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "person:wren",
                  context: "motto"
                }
              },
              {
                role: "value",
                target: "measure twice"
              }
            ]
          }
        },
        {
          name: "m2-motto-b",
          id: "1e20abd7e2d841c82eb797b2b113fbae203637fb158b5664ae8d7b8fd9d4dbb0bfeb",
          claims: {
            timestamp: 400,
            author: "did:key:zBob",
            pointers: [
              {
                role: "subject",
                target: {
                  id: "person:wren",
                  context: "motto"
                }
              },
              {
                role: "value",
                target: "cut once"
              }
            ]
          }
        }
      ]
    },
    schemas: [
      {
        name: "MovieRaw",
        alg: 1,
        body: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "select",
            pred: {
              hasPointer: {
                targetEntity: {
                  var: "root"
                }
              }
            },
            in: "input"
          }
        }
      },
      {
        name: "PersonRaw",
        alg: 1,
        body: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "select",
            pred: {
              hasPointer: {
                targetEntity: {
                  var: "root"
                }
              }
            },
            in: "input"
          }
        }
      },
      {
        name: "MovieView",
        alg: 1,
        body: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "select",
            pred: {
              hasPointer: {
                targetEntity: {
                  var: "root"
                }
              }
            },
            in: {
              op: "mask",
              policy: "drop",
              in: "input"
            }
          }
        }
      },
      {
        name: "ActorNameV",
        alg: 1,
        body: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "select",
            pred: {
              hasPointer: {
                targetEntity: {
                  var: "root"
                }
              }
            },
            in: {
              op: "mask",
              policy: "drop",
              in: "input"
            }
          }
        }
      },
      {
        name: "MovieCast",
        alg: 1,
        body: {
          op: "expand",
          role: {
            exact: "actor"
          },
          schema: "ActorNameV",
          in: {
            op: "group",
            key: "byTargetContext",
            in: {
              op: "select",
              pred: {
                hasPointer: {
                  targetEntity: {
                    var: "root"
                  }
                }
              },
              in: {
                op: "mask",
                policy: "drop",
                in: "input"
              }
            }
          }
        }
      }
    ],
    cases: [
      {
        name: "pick-latest-superposed",
        spec: "SPEC-5 \xA73 pick/byTimestamp",
        note: "no mask: both titles superposed; last-claim-wins picks Matrix Reloaded; size picks 3 (ts 710)",
        term: {
          op: "resolve",
          policy: {
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "MovieRaw",
            entity: "movie:matrix"
          }
        },
        expectedView: {
          title: "Matrix Reloaded",
          releaseYear: 1999,
          rating: 9.1,
          tag: "action",
          size: 3,
          cast: {
            actor: "actor:keanu",
            character: "Neo"
          }
        },
        expectedCanonicalHex: "a66374616766616374696f6e6463617374a2656163746f726b6163746f723a6b65616e7569636861726163746572634e656f6473697a65f94200657469746c656f4d61747269782052656c6f6164656466726174696e67fb40223333333333336b72656c6561736559656172f967cf"
      },
      {
        name: "pick-latest-after-mask-drop",
        spec: "SPEC-5 \xA74 (negation already happened upstream)",
        note: "t2 negated by n1: title resolves to The Matrix",
        term: {
          op: "resolve",
          policy: {
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "MovieView",
            entity: "movie:matrix"
          }
        },
        expectedView: {
          title: "The Matrix",
          releaseYear: 1999,
          rating: 9.1,
          tag: "action",
          size: 3,
          cast: {
            actor: "actor:keanu",
            character: "Neo"
          }
        },
        expectedCanonicalHex: "a66374616766616374696f6e6463617374a2656163746f726b6163746f723a6b65616e7569636861726163746572634e656f6473697a65f94200657469746c656a546865204d617472697866726174696e67fb40223333333333336b72656c6561736559656172f967cf"
      },
      {
        name: "pick-by-author-rank",
        spec: "SPEC-5 \xA73 byAuthorRank (the trust primitive)",
        term: {
          op: "resolve",
          policy: {
            default: {
              pick: {
                order: {
                  byAuthorRank: [
                    "did:key:zAlice",
                    "did:key:zBob",
                    "did:key:zCarol"
                  ]
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "MovieRaw",
            entity: "movie:matrix"
          }
        },
        expectedView: {
          title: "The Matrix",
          releaseYear: 1999,
          rating: 8.7,
          tag: "action",
          size: 3,
          cast: {
            actor: "actor:keanu",
            character: "Neo"
          }
        },
        expectedCanonicalHex: "a66374616766616374696f6e6463617374a2656163746f726b6163746f723a6b65616e7569636861726163746572634e656f6473697a65f94200657469746c656a546865204d617472697866726174696e67fb40216666666666666b72656c6561736559656172f967cf"
      },
      {
        name: "pick-by-pred-prefers-carol",
        spec: "SPEC-5 \xA73 byPred",
        note: "tag prefers scifi (Carol's), size prefers large (Carol's)",
        term: {
          op: "resolve",
          policy: {
            default: {
              pick: {
                order: {
                  byPred: {
                    pred: {
                      match: {
                        field: "author",
                        cmp: "eq",
                        const: "did:key:zCarol"
                      }
                    },
                    then: {
                      byTimestamp: "desc"
                    }
                  }
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "MovieRaw",
            entity: "movie:matrix"
          }
        },
        expectedView: {
          title: "Matrix Reloaded",
          releaseYear: 1999,
          rating: 9.1,
          tag: "scifi",
          size: "large",
          cast: {
            actor: "actor:keanu",
            character: "Neo"
          }
        },
        expectedCanonicalHex: "a6637461676573636966696463617374a2656163746f726b6163746f723a6b65616e7569636861726163746572634e656f6473697a65656c61726765657469746c656f4d61747269782052656c6f6164656466726174696e67fb40223333333333336b72656c6561736559656172f967cf"
      },
      {
        name: "all-ascending",
        spec: "SPEC-5 \xA73 all",
        term: {
          op: "resolve",
          policy: {
            props: {
              tag: {
                all: {
                  order: {
                    byTimestamp: "asc"
                  }
                }
              }
            },
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "MovieRaw",
            entity: "movie:matrix"
          }
        },
        expectedView: {
          tag: [
            "scifi",
            "action"
          ],
          title: "Matrix Reloaded",
          releaseYear: 1999,
          rating: 9.1,
          size: 3,
          cast: {
            actor: "actor:keanu",
            character: "Neo"
          }
        },
        expectedCanonicalHex: "a6637461678265736369666966616374696f6e6463617374a2656163746f726b6163746f723a6b65616e7569636861726163746572634e656f6473697a65f94200657469746c656f4d61747269782052656c6f6164656466726174696e67fb40223333333333336b72656c6561736559656172f967cf"
      },
      {
        name: "merge-max-min-sum-count",
        spec: "SPEC-5 \xA73 MergeFn / ERRATA-5 R2",
        note: "sum folds in id order (8.7+9.1); size max is the STRING large by canonical type order",
        term: {
          op: "resolve",
          policy: {
            props: {
              rating: {
                merge: "sum"
              },
              tag: {
                merge: "count"
              },
              size: {
                merge: "max"
              },
              releaseYear: {
                merge: "min"
              }
            },
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "MovieRaw",
            entity: "movie:matrix"
          }
        },
        expectedView: {
          rating: 17.799999999999997,
          tag: 2,
          size: "large",
          releaseYear: 1999,
          title: "Matrix Reloaded",
          cast: {
            actor: "actor:keanu",
            character: "Neo"
          }
        },
        expectedCanonicalHex: "a663746167f940006463617374a2656163746f726b6163746f723a6b65616e7569636861726163746572634e656f6473697a65656c61726765657469746c656f4d61747269782052656c6f6164656466726174696e67fb4031cccccccccccc6b72656c6561736559656172f967cf"
      },
      {
        name: "merge-concat-sorted",
        spec: "SPEC-5 \xA73 MergeFn",
        term: {
          op: "resolve",
          policy: {
            props: {
              tag: {
                merge: "concatSorted"
              }
            },
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "MovieRaw",
            entity: "movie:matrix"
          }
        },
        expectedView: {
          tag: [
            "action",
            "scifi"
          ],
          title: "Matrix Reloaded",
          releaseYear: 1999,
          rating: 9.1,
          size: 3,
          cast: {
            actor: "actor:keanu",
            character: "Neo"
          }
        },
        expectedCanonicalHex: "a6637461678266616374696f6e6573636966696463617374a2656163746f726b6163746f723a6b65616e7569636861726163746572634e656f6473697a65f94200657469746c656f4d61747269782052656c6f6164656466726174696e67fb40223333333333336b72656c6561736559656172f967cf"
      },
      {
        name: "conflicts-surfaces-disagreement",
        spec: "SPEC-5 \xA73 conflicts",
        note: "title has 2 distinct claims -> surfaced; releaseYear has 1 -> absent",
        term: {
          op: "resolve",
          policy: {
            props: {
              title: {
                conflicts: {
                  order: {
                    byTimestamp: "desc"
                  }
                }
              },
              releaseYear: {
                conflicts: {
                  order: {
                    byTimestamp: "desc"
                  }
                }
              }
            },
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "MovieRaw",
            entity: "movie:matrix"
          }
        },
        expectedView: {
          title: [
            "Matrix Reloaded",
            "The Matrix"
          ],
          rating: 9.1,
          tag: "action",
          size: 3,
          cast: {
            actor: "actor:keanu",
            character: "Neo"
          }
        },
        expectedCanonicalHex: "a56374616766616374696f6e6463617374a2656163746f726b6163746f723a6b65616e7569636861726163746572634e656f6473697a65f94200657469746c65826f4d61747269782052656c6f616465646a546865204d617472697866726174696e67fb4022333333333333"
      },
      {
        name: "absent-as-default",
        spec: "SPEC-5 \xA73 absentAs / \xA74 empty property",
        note: "no director deltas exist; the policy names the property so absentAs fires",
        term: {
          op: "resolve",
          policy: {
            props: {
              director: {
                absentAs: {
                  const: "unknown",
                  then: {
                    pick: {
                      order: {
                        byTimestamp: "desc"
                      }
                    }
                  }
                }
              }
            },
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "MovieRaw",
            entity: "movie:matrix"
          }
        },
        expectedView: {
          director: "unknown",
          title: "Matrix Reloaded",
          releaseYear: 1999,
          rating: 9.1,
          tag: "action",
          size: 3,
          cast: {
            actor: "actor:keanu",
            character: "Neo"
          }
        },
        expectedCanonicalHex: "a76374616766616374696f6e6463617374a2656163746f726b6163746f723a6b65616e7569636861726163746572634e656f6473697a65f94200657469746c656f4d61747269782052656c6f6164656466726174696e67fb4022333333333333686469726563746f7267756e6b6e6f776e6b72656c6561736559656172f967cf"
      },
      {
        name: "resolve-nested-expansion",
        spec: "ERRATA-5 R1/R6 (multi-pointer candidate; nested View with same policy)",
        note: "cast candidate is {actor: {name: Keanu Reeves}, character: Neo}",
        term: {
          op: "resolve",
          policy: {
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "MovieCast",
            entity: "movie:matrix"
          }
        },
        expectedView: {
          title: "The Matrix",
          releaseYear: 1999,
          rating: 9.1,
          tag: "action",
          size: 3,
          cast: {
            actor: {
              name: "Keanu Reeves",
              filmography: {
                movie: "movie:matrix",
                character: "Neo"
              }
            },
            character: "Neo"
          }
        },
        expectedCanonicalHex: "a66374616766616374696f6e6463617374a2656163746f72a2646e616d656c4b65616e75205265657665736b66696c6d6f677261706879a2656d6f7669656c6d6f7669653a6d617472697869636861726163746572634e656f69636861726163746572634e656f6473697a65f94200657469746c656a546865204d617472697866726174696e67fb40223333333333336b72656c6561736559656172f967cf"
      },
      {
        name: "author-rank-terminal-ties-lexById",
        spec: "SPEC-5 \xA73 byAuthorRank (tie-permissive: ties fall to the structural lexById)",
        note: "rank alone cannot see recency: Alice's two bios tie, whichever id sorts first wins",
        term: {
          op: "resolve",
          policy: {
            props: {
              bio: {
                pick: {
                  order: {
                    byAuthorRank: [
                      "did:key:zAlice"
                    ]
                  }
                }
              }
            },
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "PersonRaw",
            entity: "person:wren"
          }
        },
        expectedView: {
          bio: "Founder of the village archive",
          motto: "measure twice"
        },
        expectedCanonicalHex: "a26362696f781e466f756e646572206f66207468652076696c6c6167652061726368697665656d6f74746f6d6d656173757265207477696365"
      },
      {
        name: "chain-trusted-then-latest",
        spec: "SPEC-5 \xA73 chain (trusted, then latest)",
        note: "unranked Carol's newest bio loses to Alice; among Alice's own, recency decides: Archivist and cartographer",
        term: {
          op: "resolve",
          policy: {
            props: {
              bio: {
                pick: {
                  order: {
                    chain: [
                      {
                        byAuthorRank: [
                          "did:key:zAlice"
                        ]
                      },
                      {
                        byTimestamp: "desc"
                      }
                    ]
                  }
                }
              }
            },
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "PersonRaw",
            entity: "person:wren"
          }
        },
        expectedView: {
          bio: "Archivist and cartographer",
          motto: "measure twice"
        },
        expectedCanonicalHex: "a26362696f781a41726368697669737420616e6420636172746f67726170686572656d6f74746f6d6d656173757265207477696365"
      },
      {
        name: "chain-latest-then-rank",
        spec: "SPEC-5 \xA73 chain (latest, rank as tiebreak)",
        note: "mottoes tie at ts 400; rank breaks the tie: Alice's first",
        term: {
          op: "resolve",
          policy: {
            props: {
              motto: {
                all: {
                  order: {
                    chain: [
                      {
                        byTimestamp: "desc"
                      },
                      {
                        byAuthorRank: [
                          "did:key:zAlice",
                          "did:key:zBob",
                          "did:key:zCarol"
                        ]
                      }
                    ]
                  }
                }
              }
            },
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "PersonRaw",
            entity: "person:wren"
          }
        },
        expectedView: {
          motto: [
            "measure twice",
            "cut once"
          ],
          bio: "Retired from public life"
        },
        expectedCanonicalHex: "a26362696f7818526574697265642066726f6d207075626c6963206c696665656d6f74746f826d6d65617375726520747769636568637574206f6e6365"
      },
      {
        name: "chain-indecisive-falls-to-lexById",
        spec: "SPEC-5 \xA73 chain / R3 (a fully tied chain ends at the implicit lexById)",
        note: "a one-link chain is its link: same View as author-rank-terminal-ties-lexById",
        term: {
          op: "resolve",
          policy: {
            props: {
              bio: {
                pick: {
                  order: {
                    chain: [
                      {
                        byAuthorRank: [
                          "did:key:zAlice"
                        ]
                      }
                    ]
                  }
                }
              }
            },
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "PersonRaw",
            entity: "person:wren"
          }
        },
        expectedView: {
          bio: "Founder of the village archive",
          motto: "measure twice"
        },
        expectedCanonicalHex: "a26362696f781e466f756e646572206f66207468652076696c6c6167652061726368697665656d6f74746f6d6d656173757265207477696365"
      },
      {
        name: "chain-under-byPred",
        spec: "SPEC-5 \xA73 byPred + chain compose",
        note: "Alice's claims first, then her oldest: Founder of the village archive",
        term: {
          op: "resolve",
          policy: {
            props: {
              bio: {
                pick: {
                  order: {
                    byPred: {
                      pred: {
                        match: {
                          field: "author",
                          cmp: "eq",
                          const: "did:key:zAlice"
                        }
                      },
                      then: {
                        chain: [
                          {
                            byTimestamp: "asc"
                          }
                        ]
                      }
                    }
                  }
                }
              }
            },
            default: {
              pick: {
                order: {
                  byTimestamp: "desc"
                }
              }
            }
          },
          in: {
            op: "fix",
            schema: "PersonRaw",
            entity: "person:wren"
          }
        },
        expectedView: {
          bio: "Founder of the village archive",
          motto: "measure twice"
        },
        expectedCanonicalHex: "a26362696f781e466f756e646572206f66207468652076696c6c6167652061726368697665656d6f74746f6d6d656173757265207477696365"
      }
    ]
  };

  // ../../vectors/l1-eval/eval-holes.json
  var eval_holes_default = {
    fixture: {
      note: "one movie with a title, two ratings, two cast edges; holes bind asOf/min/who",
      deltas: [
        {
          name: "h1-title",
          id: "1e20283257b1bb9a907a55812a07dd3b8dbdc4ab331c5edd4cec2fa59056d4897851",
          claims: {
            timestamp: 100,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "movie",
                target: {
                  id: "movie:matrix",
                  context: "title"
                }
              },
              {
                role: "title",
                target: "The Matrix"
              }
            ]
          }
        },
        {
          name: "h2-rating-low",
          id: "1e20bda18d31031ea14dcca962464bce5a145d379ca0b4d98591cbd57a5ee225f93a",
          claims: {
            timestamp: 150,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "movie",
                target: {
                  id: "movie:matrix",
                  context: "rating"
                }
              },
              {
                role: "rating",
                target: 7.5
              }
            ]
          }
        },
        {
          name: "h3-rating-high",
          id: "1e202739d82800731c0d9c8db6b6932c2fdacc0707c7224b5f248e4d40e21077cd62",
          claims: {
            timestamp: 200,
            author: "did:key:zBob",
            pointers: [
              {
                role: "movie",
                target: {
                  id: "movie:matrix",
                  context: "rating"
                }
              },
              {
                role: "rating",
                target: 9.2
              }
            ]
          }
        },
        {
          name: "h4-cast-keanu",
          id: "1e209d227c3a6ec77643ecbcd63324c84958b20342d05aea815196b58066d6548f4a",
          claims: {
            timestamp: 250,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "movie",
                target: {
                  id: "movie:matrix",
                  context: "cast"
                }
              },
              {
                role: "actor",
                target: {
                  id: "entity:keanu",
                  context: "filmography"
                }
              }
            ]
          }
        },
        {
          name: "h5-cast-carrie",
          id: "1e20e85aefd48ee2a234c0f235c1547e1893ca15bbe2b961d4f681edd0ead46c79b3",
          claims: {
            timestamp: 300,
            author: "did:key:zAlice",
            pointers: [
              {
                role: "movie",
                target: {
                  id: "movie:matrix",
                  context: "cast"
                }
              },
              {
                role: "actor",
                target: {
                  id: "entity:carrie",
                  context: "filmography"
                }
              }
            ]
          }
        }
      ]
    },
    schemas: [
      {
        name: "ViewAsOf",
        alg: 1,
        body: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "mask",
            policy: "drop",
            in: {
              op: "select",
              pred: {
                match: {
                  field: "timestamp",
                  cmp: "lte",
                  const: {
                    hole: "asOf"
                  }
                }
              },
              in: "input"
            }
          }
        }
      },
      {
        name: "RatedAtLeast",
        alg: 1,
        body: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "mask",
            policy: "drop",
            in: {
              op: "select",
              pred: {
                or: [
                  {
                    not: {
                      hasPointer: {
                        context: {
                          exact: "rating"
                        }
                      }
                    }
                  },
                  {
                    hasPointer: {
                      targetValue: {
                        vcmp: {
                          cmp: "gte",
                          value: {
                            hole: "min"
                          }
                        }
                      }
                    }
                  }
                ]
              },
              in: "input"
            }
          }
        }
      },
      {
        name: "LinkedTo",
        alg: 1,
        body: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "mask",
            policy: "drop",
            in: {
              op: "select",
              pred: {
                hasPointer: {
                  targetEntity: {
                    hole: "who"
                  }
                }
              },
              in: "input"
            }
          }
        }
      }
    ],
    cases: [
      {
        name: "asof-150-sees-two",
        spec: "E15 (hole in match const)",
        note: "title + the t=150 rating; later deltas are outside the bound horizon",
        term: {
          op: "fix",
          schema: "ViewAsOf",
          entity: "movie:matrix",
          bindings: {
            asOf: 150
          }
        },
        termHash: "1e2047b998eb6a28ff6c0e28b97ed0c6831cf8854dd2bfb30324cbede05aa561613f",
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a2657469746c6581a26269647844316532303238333235376231626239613930376135353831326130376464336238646264633461623333316335656464346365633266613539303536643438393738353166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c65657469746c65667461726765746a546865204d61747269786974696d657374616d70f9564066726174696e6781a26269647844316532306264613138643331303331656131346463636139363234363462636535613134356433373963613062346439383539316362643537613565653232356639336166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c6566726174696e6766746172676574f947806974696d657374616d70f958b0"
      },
      {
        name: "asof-999-sees-all",
        spec: "E15 (same body, different binding, different view)",
        term: {
          op: "fix",
          schema: "ViewAsOf",
          entity: "movie:matrix",
          bindings: {
            asOf: 999
          }
        },
        termHash: "1e20986a04bc7bf70609d6c2ee19edf9c8f45aff0a536cad067767403537625b0090",
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a3646361737482a26269647844316532303964323237633361366563373736343365636263643633333234633834393538623230333432643035616561383135313936623538303636643635343866346166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646c656e746974793a6b65616e7567636f6e746578746b66696c6d6f6772617068796974696d657374616d70f95bd0a26269647844316532306538356165666434386565326132333463306632333563313534376531383933636131356262653262393631643466363831656464306561643436633739623366636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646d656e746974793a63617272696567636f6e746578746b66696c6d6f6772617068796974696d657374616d70f95cb0657469746c6581a26269647844316532303238333235376231626239613930376135353831326130376464336238646264633461623333316335656464346365633266613539303536643438393738353166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c65657469746c65667461726765746a546865204d61747269786974696d657374616d70f9564066726174696e6782a26269647844316532303237333964383238303037333163306439633864623662363933326332666461636330373037633732323462356632343865346434306532313037376364363266636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c6566726174696e6766746172676574fb40226666666666666974696d657374616d70f95a40a26269647844316532306264613138643331303331656131346463636139363234363462636535613134356433373963613062346439383539316362643537613565653232356639336166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c6566726174696e6766746172676574f947806974696d657374616d70f958b0"
      },
      {
        name: "rated-at-least-9",
        spec: "E15 (hole in vcmp value)",
        note: "the 7.5 rating drops; non-rating properties pass through",
        term: {
          op: "fix",
          schema: "RatedAtLeast",
          entity: "movie:matrix",
          bindings: {
            min: 9
          }
        },
        termHash: "1e20cfedfebbf2eaf1f85ab80d9668bc7452349e4e07bc6861b675077dc9497ad12a",
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a3646361737482a26269647844316532303964323237633361366563373736343365636263643633333234633834393538623230333432643035616561383135313936623538303636643635343866346166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646c656e746974793a6b65616e7567636f6e746578746b66696c6d6f6772617068796974696d657374616d70f95bd0a26269647844316532306538356165666434386565326132333463306632333563313534376531383933636131356262653262393631643466363831656464306561643436633739623366636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646d656e746974793a63617272696567636f6e746578746b66696c6d6f6772617068796974696d657374616d70f95cb0657469746c6581a26269647844316532303238333235376231626239613930376135353831326130376464336238646264633461623333316335656464346365633266613539303536643438393738353166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c65657469746c65667461726765746a546865204d61747269786974696d657374616d70f9564066726174696e6781a26269647844316532303237333964383238303037333163306439633864623662363933326332666461636330373037633732323462356632343865346434306532313037376364363266636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c6566726174696e6766746172676574fb40226666666666666974696d657374616d70f95a40"
      },
      {
        name: "rated-at-least-5",
        spec: "E15 (hole in vcmp value)",
        term: {
          op: "fix",
          schema: "RatedAtLeast",
          entity: "movie:matrix",
          bindings: {
            min: 5
          }
        },
        termHash: "1e203100e4720cd552ca5329263ca7a576e00b4413deb8b556532c957aa36a36fca3",
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a3646361737482a26269647844316532303964323237633361366563373736343365636263643633333234633834393538623230333432643035616561383135313936623538303636643635343866346166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646c656e746974793a6b65616e7567636f6e746578746b66696c6d6f6772617068796974696d657374616d70f95bd0a26269647844316532306538356165666434386565326132333463306632333563313534376531383933636131356262653262393631643466363831656464306561643436633739623366636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646d656e746974793a63617272696567636f6e746578746b66696c6d6f6772617068796974696d657374616d70f95cb0657469746c6581a26269647844316532303238333235376231626239613930376135353831326130376464336238646264633461623333316335656464346365633266613539303536643438393738353166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e74657874657469746c65a264726f6c65657469746c65667461726765746a546865204d61747269786974696d657374616d70f9564066726174696e6782a26269647844316532303237333964383238303037333163306439633864623662363933326332666461636330373037633732323462356632343865346434306532313037376364363266636c61696d73a366617574686f726c6469643a6b65793a7a426f6268706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c6566726174696e6766746172676574fb40226666666666666974696d657374616d70f95a40a26269647844316532306264613138643331303331656131346463636139363234363462636535613134356433373963613062346439383539316362643537613565653232356639336166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e7465787466726174696e67a264726f6c6566726174696e6766746172676574f947806974696d657374616d70f958b0"
      },
      {
        name: "cast-member-keanu",
        spec: "E15 (hole in targetEntity)",
        note: "only the edge that also points at the bound entity files",
        term: {
          op: "fix",
          schema: "LinkedTo",
          entity: "movie:matrix",
          bindings: {
            who: "entity:keanu"
          }
        },
        termHash: "1e2065b06265a2373dce68155b176f2128db953aa54ac980cd81233fc057e5465060",
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a1646361737481a26269647844316532303964323237633361366563373736343365636263643633333234633834393538623230333432643035616561383135313936623538303636643635343866346166636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646c656e746974793a6b65616e7567636f6e746578746b66696c6d6f6772617068796974696d657374616d70f95bd0"
      },
      {
        name: "cast-member-carrie",
        spec: "E15 (hole in targetEntity)",
        term: {
          op: "fix",
          schema: "LinkedTo",
          entity: "movie:matrix",
          bindings: {
            who: "entity:carrie"
          }
        },
        termHash: "1e204c6d3f98a8d6b97a1c41cbd8774b1741cccd181c26e9901e6f27cc5b27d2af8c",
        expectedCanonicalHex: "a26269646c6d6f7669653a6d61747269786570726f7073a1646361737481a26269647844316532306538356165666434386565326132333463306632333563313534376531383933636131356262653262393631643466363831656464306561643436633739623366636c61696d73a366617574686f726e6469643a6b65793a7a416c69636568706f696e7465727382a264726f6c65656d6f76696566746172676574a26269646c6d6f7669653a6d617472697867636f6e746578746463617374a264726f6c65656163746f7266746172676574a26269646d656e746974793a63617272696567636f6e746578746b66696c6d6f6772617068796974696d657374616d70f95cb0"
      }
    ]
  };

  // ../../vectors/l1-eval/eval-aliased.json
  var eval_aliased_default = {
    fixture: {
      note: "two employment dialects, a decoy residence concept, mappings (one negated, one sloppy cross-concept stray, one two-fragment cross product), slot declarations",
      deltas: [
        {
          name: "a1-employment-ada",
          id: "1e204ca3e79caaa86e53cba0b39f3009d92ff1087becd4dbcada2ababeb1bcb548b2",
          claims: {
            timestamp: 100,
            author: "did:key:zAppA",
            pointers: [
              {
                role: "worker",
                target: {
                  id: "person:ada",
                  context: "employer"
                }
              },
              {
                role: "organization",
                target: {
                  id: "company:acme",
                  context: "employees"
                }
              }
            ]
          }
        },
        {
          name: "b1-employment-bob",
          id: "1e20b1f5de6d4806c9af854e314991b6f38d5058868e133bd669334775332ea94742",
          claims: {
            timestamp: 200,
            author: "did:key:zAppB",
            pointers: [
              {
                role: "worker",
                target: {
                  id: "person:bob",
                  context: "job"
                }
              },
              {
                role: "org",
                target: {
                  id: "company:initech",
                  context: "staff"
                }
              }
            ]
          }
        },
        {
          name: "b2-address-bob",
          id: "1e203cd579d9725d4daff72f1dd6029e05bad1bb543738c84764568dadc4592dd034",
          claims: {
            timestamp: 210,
            author: "did:key:zAppB",
            pointers: [
              {
                role: "resident",
                target: {
                  id: "person:bob",
                  context: "address"
                }
              },
              {
                role: "place",
                target: "42 Elm St"
              }
            ]
          }
        },
        {
          name: "w1-manager-eve",
          id: "1e20dc7764de920ac1b2af54384090a9323c244584f4427a9f97b54641fcef4db0b0",
          claims: {
            timestamp: 220,
            author: "did:key:zAppA",
            pointers: [
              {
                role: "worker",
                target: {
                  id: "person:eve",
                  context: "manager"
                }
              },
              {
                role: "org",
                target: {
                  id: "company:acme"
                }
              }
            ]
          }
        },
        {
          name: "p1-note",
          id: "1e209a329c90a28044ba17f8c376cfc2e1ec28fe8d0ab464cc8d23b7ee54a6285ec2",
          claims: {
            timestamp: 230,
            author: "did:key:zAppB",
            pointers: [
              {
                role: "note",
                target: "reorg pending"
              }
            ]
          }
        },
        {
          name: "s1-slot-worker",
          id: "1e20a2a876dd5ec17974257df3d02d2f59afb6d613ce93b91e39e77f68bf08a85acb",
          claims: {
            timestamp: 300,
            author: "did:key:zHuman",
            pointers: [
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:employment#worker",
                  context: "rhizomatic.alias.concept"
                }
              },
              {
                role: "rhizomatic.alias.concept",
                target: {
                  id: "concept:employment",
                  context: "rhizomatic.alias.slots"
                }
              }
            ]
          }
        },
        {
          name: "s2-slot-organization",
          id: "1e2046a556436898e55f7c79cea39b8b1fb6e8c8fd15033ced8cdc7f7e892e8bb596",
          claims: {
            timestamp: 310,
            author: "did:key:zHuman",
            pointers: [
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:employment#organization",
                  context: "rhizomatic.alias.concept"
                }
              },
              {
                role: "rhizomatic.alias.concept",
                target: {
                  id: "concept:employment",
                  context: "rhizomatic.alias.slots"
                }
              }
            ]
          }
        },
        {
          name: "s3-slot-location",
          id: "1e207c9048661a0fdb18c4a1f3ad886e9b8d53e98b46319dc357976377733d3ca9d2",
          claims: {
            timestamp: 320,
            author: "did:key:zHuman",
            pointers: [
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:residence#location",
                  context: "rhizomatic.alias.concept"
                }
              },
              {
                role: "rhizomatic.alias.concept",
                target: {
                  id: "concept:residence",
                  context: "rhizomatic.alias.slots"
                }
              }
            ]
          }
        },
        {
          name: "m1-employer",
          id: "1e20f94c061c3bbb6e726ab73f22fea4de901b9144eda1835450cb5ef760c8af270d",
          claims: {
            timestamp: 400,
            author: "did:key:zLibrarian",
            pointers: [
              {
                role: "rhizomatic.alias.fragment",
                target: "employer"
              },
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:employment#organization",
                  context: "rhizomatic.alias.mappings"
                }
              },
              {
                role: "rhizomatic.alias.confidence",
                target: 0.97
              }
            ]
          }
        },
        {
          name: "m2-job",
          id: "1e2073c00404f88385ea752b0e59dce0ed47c0cef1fdba561125a75ad43da0691abe",
          claims: {
            timestamp: 410,
            author: "did:key:zLibrarian",
            pointers: [
              {
                role: "rhizomatic.alias.fragment",
                target: "job"
              },
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:employment#organization",
                  context: "rhizomatic.alias.mappings"
                }
              },
              {
                role: "rhizomatic.alias.confidence",
                target: 0.91
              }
            ]
          }
        },
        {
          name: "m3-organization",
          id: "1e20231a7abab5a0bbb3339453aab8eab66a79bf8745ac8a2e779a64c15b5f22e023",
          claims: {
            timestamp: 420,
            author: "did:key:zLibrarian",
            pointers: [
              {
                role: "rhizomatic.alias.fragment",
                target: "organization"
              },
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:employment#organization",
                  context: "rhizomatic.alias.mappings"
                }
              },
              {
                role: "rhizomatic.alias.confidence",
                target: 0.93
              }
            ]
          }
        },
        {
          name: "m4-org",
          id: "1e208ef2c59bb7f97a692a304d19d9f9f520ca397bb73dd3ab8e4bdd5116f6715fd1",
          claims: {
            timestamp: 430,
            author: "did:key:zLibrarian",
            pointers: [
              {
                role: "rhizomatic.alias.fragment",
                target: "org"
              },
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:employment#organization",
                  context: "rhizomatic.alias.mappings"
                }
              },
              {
                role: "rhizomatic.alias.confidence",
                target: 0.9
              }
            ]
          }
        },
        {
          name: "m5-employees",
          id: "1e208d432cdd295daadde582a967dc849a6a4c461024217ab7c87171030151c4ba4f",
          claims: {
            timestamp: 440,
            author: "did:key:zLibrarian",
            pointers: [
              {
                role: "rhizomatic.alias.fragment",
                target: "employees"
              },
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:employment#worker",
                  context: "rhizomatic.alias.mappings"
                }
              },
              {
                role: "rhizomatic.alias.confidence",
                target: 0.95
              }
            ]
          }
        },
        {
          name: "m6-staff",
          id: "1e20cee6d7a8a040f2662eb26585d7cb2096415f22f6d46ee0fc423612c1a4d6ab7b",
          claims: {
            timestamp: 450,
            author: "did:key:zLibrarian",
            pointers: [
              {
                role: "rhizomatic.alias.fragment",
                target: "staff"
              },
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:employment#worker",
                  context: "rhizomatic.alias.mappings"
                }
              },
              {
                role: "rhizomatic.alias.confidence",
                target: 0.88
              }
            ]
          }
        },
        {
          name: "m7-manager",
          id: "1e20f0fba16da63cc9805c63987ff60f979e48946c6b3c5187840c2aaae098a5ae42",
          claims: {
            timestamp: 460,
            author: "did:key:zLibrarian",
            pointers: [
              {
                role: "rhizomatic.alias.fragment",
                target: "manager"
              },
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:employment#worker",
                  context: "rhizomatic.alias.mappings"
                }
              },
              {
                role: "rhizomatic.alias.confidence",
                target: 0.55
              }
            ]
          }
        },
        {
          name: "m8-address",
          id: "1e202d45d39693dd3a07cae33c46b1c063215b9d78faa42a9d53340b1003596eaa72",
          claims: {
            timestamp: 470,
            author: "did:key:zLibrarian",
            pointers: [
              {
                role: "rhizomatic.alias.fragment",
                target: "address"
              },
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:residence#location",
                  context: "rhizomatic.alias.mappings"
                }
              },
              {
                role: "rhizomatic.alias.confidence",
                target: 0.92
              }
            ]
          }
        },
        {
          name: "m9-employer-location",
          id: "1e205e277940a4640b5a6a82be7bc60cd2654b5c4f027c568fb37fc06e069c0457ba",
          claims: {
            timestamp: 480,
            author: "did:key:zSloppy",
            pointers: [
              {
                role: "rhizomatic.alias.fragment",
                target: "employer"
              },
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:residence#location",
                  context: "rhizomatic.alias.mappings"
                }
              },
              {
                role: "rhizomatic.alias.confidence",
                target: 0.3
              }
            ]
          }
        },
        {
          name: "m10-personnel-workforce",
          id: "1e2056eb2eca31851d68ddb64f246179bf216ec7f63b1a0ee06cfa3731a40264527d",
          claims: {
            timestamp: 490,
            author: "did:key:zLibrarian",
            pointers: [
              {
                role: "rhizomatic.alias.fragment",
                target: "personnel"
              },
              {
                role: "rhizomatic.alias.fragment",
                target: "workforce"
              },
              {
                role: "rhizomatic.alias.slot",
                target: {
                  id: "concept:employment#worker",
                  context: "rhizomatic.alias.mappings"
                }
              },
              {
                role: "rhizomatic.alias.confidence",
                target: 0.85
              }
            ]
          }
        },
        {
          name: "n1-negates-m7",
          id: "1e202aa972bef5e6c5c925233bfbb418f08de6a573ff809035517418c2c6cb869420",
          claims: {
            timestamp: 500,
            author: "did:key:zHuman",
            pointers: [
              {
                role: "negates",
                target: {
                  delta: "1e20f0fba16da63cc9805c63987ff60f979e48946c6b3c5187840c2aaae098a5ae42"
                }
              },
              {
                role: "reason",
                target: "manager names a different relation"
              }
            ]
          }
        }
      ]
    },
    schemas: [
      {
        name: "RecallWork",
        alg: 1,
        body: {
          op: "group",
          key: "byTargetContext",
          in: {
            op: "mask",
            policy: "drop",
            in: {
              op: "select",
              pred: {
                and: [
                  {
                    hasPointer: {
                      targetEntity: {
                        var: "root"
                      }
                    }
                  },
                  {
                    hasPointer: {
                      context: {
                        aliased: {
                          name: "employer",
                          via: "concept:employment"
                        }
                      }
                    }
                  }
                ]
              },
              in: "input"
            }
          }
        }
      }
    ],
    cases: [
      {
        name: "closure-via-restricted",
        spec: "SPEC-9 \xA74.1 (via restricts slots to the named concept)",
        note: "employer/job converge through employment#organization; the residence stray is excluded by via",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              context: {
                aliased: {
                  name: "employer",
                  via: "concept:employment"
                }
              }
            }
          },
          in: "input"
        },
        termHash: "1e20e62623cb0cd4de857dc656c67bb31bc416e6ce85864cdf4be27bd072d9718246",
        expectedClosure: [
          "employer",
          "job",
          "org",
          "organization"
        ],
        expected: {
          ids: [
            "1e204ca3e79caaa86e53cba0b39f3009d92ff1087becd4dbcada2ababeb1bcb548b2",
            "1e20b1f5de6d4806c9af854e314991b6f38d5058868e133bd669334775332ea94742"
          ]
        },
        expectedCanonicalHex: "827844316532303463613365373963616161383665353363626130623339663330303964393266663130383762656364346462636164613261626162656231626362353438623278443165323062316635646536643438303663396166383534653331343939316236663338643530353838363865313333626436363933333437373533333265613934373432"
      },
      {
        name: "closure-unrestricted-crosses-concepts",
        spec: "SPEC-9 \xA74.1 (no via: every slot the name maps to participates)",
        note: "the sloppy employer->location mapping pulls in address \u2014 why via exists",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              context: {
                aliased: {
                  name: "employer"
                }
              }
            }
          },
          in: "input"
        },
        termHash: "1e20b589886528e998c251f32a1070fcd0c4ec66c9c03c809a0a742206a7cd1effbc",
        expectedClosure: [
          "address",
          "employer",
          "job",
          "org",
          "organization"
        ],
        expected: {
          ids: [
            "1e203cd579d9725d4daff72f1dd6029e05bad1bb543738c84764568dadc4592dd034",
            "1e204ca3e79caaa86e53cba0b39f3009d92ff1087becd4dbcada2ababeb1bcb548b2",
            "1e20b1f5de6d4806c9af854e314991b6f38d5058868e133bd669334775332ea94742"
          ]
        },
        expectedCanonicalHex: "83784431653230336364353739643937323564346461666637326631646436303239653035626164316262353433373338633834373634353638646164633435393264643033347844316532303463613365373963616161383665353363626130623339663330303964393266663130383762656364346462636164613261626162656231626362353438623278443165323062316635646536643438303663396166383534653331343939316236663338643530353838363865313333626436363933333437373533333265613934373432"
      },
      {
        name: "closure-trust-confidence-gate",
        spec: "SPEC-9 \xA74.1 (trust restricts every participant)",
        note: "confidence >= 0.8 excludes the 0.3 stray without via; same closure as via-restricted, different mechanism",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              context: {
                aliased: {
                  name: "employer",
                  trust: {
                    hasPointer: {
                      role: {
                        exact: "rhizomatic.alias.confidence"
                      },
                      targetValue: {
                        vcmp: {
                          cmp: "gte",
                          value: 0.8
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          in: "input"
        },
        termHash: "1e20dc081d70707f8f94d3645e80741a82e682d9c0f191dcbb2e7020a97cec8bc8aa",
        expectedClosure: [
          "employer",
          "job",
          "org",
          "organization"
        ],
        expected: {
          ids: [
            "1e204ca3e79caaa86e53cba0b39f3009d92ff1087becd4dbcada2ababeb1bcb548b2",
            "1e20b1f5de6d4806c9af854e314991b6f38d5058868e133bd669334775332ea94742"
          ]
        },
        expectedCanonicalHex: "827844316532303463613365373963616161383665353363626130623339663330303964393266663130383762656364346462636164613261626162656231626362353438623278443165323062316635646536643438303663396166383534653331343939316236663338643530353838363865313333626436363933333437373533333265613934373432"
      },
      {
        name: "closure-negated-mapping-dead",
        spec: "SPEC-9 \xA73 \xA74.1 (a wrong mapping dies by one signed negation)",
        note: "manager->worker is negated by human review, so the misfiled manager edge stays out; the cross-product fragments enter",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              context: {
                aliased: {
                  name: "employees",
                  via: "concept:employment"
                }
              }
            }
          },
          in: "input"
        },
        termHash: "1e20a6294b67e0918872b740045d97d90d8c514c481b626ad6b445623983ecef65a6",
        expectedClosure: [
          "employees",
          "personnel",
          "staff",
          "workforce"
        ],
        expected: {
          ids: [
            "1e204ca3e79caaa86e53cba0b39f3009d92ff1087becd4dbcada2ababeb1bcb548b2",
            "1e20b1f5de6d4806c9af854e314991b6f38d5058868e133bd669334775332ea94742"
          ]
        },
        expectedCanonicalHex: "827844316532303463613365373963616161383665353363626130623339663330303964393266663130383762656364346462636164613261626162656231626362353438623278443165323062316635646536643438303663396166383534653331343939316236663338643530353838363865313333626436363933333437373533333265613934373432"
      },
      {
        name: "closure-trust-excludes-the-negation",
        spec: "SPEC-9 \xA74.1 (negation chains are walked within the trusted set only \u2014 mask(trust) parity)",
        note: "trusting only the librarian excludes the human's negation, so manager revives and the misfiled edge matches",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              context: {
                aliased: {
                  name: "employees",
                  trust: {
                    match: {
                      field: "author",
                      cmp: "eq",
                      const: "did:key:zLibrarian"
                    }
                  }
                }
              }
            }
          },
          in: "input"
        },
        termHash: "1e2054052c4836792cc7ac62fd75239364b8f0bbb5efc2c0836845703232c1dc1bd5",
        expectedClosure: [
          "employees",
          "manager",
          "personnel",
          "staff",
          "workforce"
        ],
        expected: {
          ids: [
            "1e204ca3e79caaa86e53cba0b39f3009d92ff1087becd4dbcada2ababeb1bcb548b2",
            "1e20b1f5de6d4806c9af854e314991b6f38d5058868e133bd669334775332ea94742",
            "1e20dc7764de920ac1b2af54384090a9323c244584f4427a9f97b54641fcef4db0b0"
          ]
        },
        expectedCanonicalHex: "83784431653230346361336537396361616138366535336362613062333966333030396439326666313038376265636434646263616461326162616265623162636235343862327844316532306231663564653664343830366339616638353465333134393931623666333864353035383836386531333362643636393333343737353333326561393437343278443165323064633737363464653932306163316232616635343338343039306139333233633234343538346634343237613966393762353436343166636566346462306230"
      },
      {
        name: "closure-identity",
        spec: "SPEC-9 \xA74.1 (the name is always in its own closure)",
        note: "no mappings: degrades to exact(name); nothing in the fixture uses it",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              context: {
                aliased: {
                  name: "quarterly-review"
                }
              }
            }
          },
          in: "input"
        },
        termHash: "1e20e4f96bf3908a3e12d9065cae5eb754f868e3f3d21086f7ff6795c0172dcb86c0",
        expectedClosure: [
          "quarterly-review"
        ],
        expected: {
          ids: []
        },
        expectedCanonicalHex: "80"
      },
      {
        name: "closure-role-position",
        spec: "SPEC-9 \xA73 \xA74 (fragments are position-blind; the StrMatch position decides what is matched)",
        note: "organization/org are role fragments of the same slot; matched in role position here",
        term: {
          op: "select",
          pred: {
            hasPointer: {
              role: {
                aliased: {
                  name: "organization",
                  via: "concept:employment"
                }
              }
            }
          },
          in: "input"
        },
        termHash: "1e2036eaf79faa4ba0c57dac6dda7ce26242d011a1f9090e44d247acf587a46d1300",
        expectedClosure: [
          "employer",
          "job",
          "org",
          "organization"
        ],
        expected: {
          ids: [
            "1e204ca3e79caaa86e53cba0b39f3009d92ff1087becd4dbcada2ababeb1bcb548b2",
            "1e20b1f5de6d4806c9af854e314991b6f38d5058868e133bd669334775332ea94742",
            "1e20dc7764de920ac1b2af54384090a9323c244584f4427a9f97b54641fcef4db0b0"
          ]
        },
        expectedCanonicalHex: "83784431653230346361336537396361616138366535336362613062333966333030396439326666313038376265636434646263616461326162616265623162636235343862327844316532306231663564653664343830366339616638353465333134393931623666333864353035383836386531333362643636393333343737353333326561393437343278443165323064633737363464653932306163316232616635343338343039306139333233633234343538346634343237613966393762353436343166636566346462306230"
      },
      {
        name: "recall-bob-keeps-bobs-vocabulary",
        spec: "SPEC-9 \xA74.1 (matching, never renaming) + \xA77",
        note: "bob's employment files under HIS dialect's name: job",
        term: {
          op: "fix",
          schema: "RecallWork",
          entity: "person:bob"
        },
        termHash: "1e200de26866ef62cd0daee6c29897f1ab2e0d2f1b166cb929765542351e850f466b",
        expected: {
          id: "person:bob",
          props: {
            job: [
              "1e20b1f5de6d4806c9af854e314991b6f38d5058868e133bd669334775332ea94742"
            ]
          }
        },
        expectedCanonicalHex: "a26269646a706572736f6e3a626f626570726f7073a1636a6f6281a26269647844316532306231663564653664343830366339616638353465333134393931623666333864353035383836386531333362643636393333343737353333326561393437343266636c61696d73a366617574686f726d6469643a6b65793a7a4170704268706f696e7465727382a264726f6c6566776f726b657266746172676574a26269646a706572736f6e3a626f6267636f6e74657874636a6f62a264726f6c65636f726766746172676574a26269646f636f6d70616e793a696e697465636867636f6e746578746573746166666974696d657374616d70f95a40"
      },
      {
        name: "recall-ada-keeps-adas-vocabulary",
        spec: "SPEC-9 \xA74.1 (matching, never renaming) + \xA77",
        note: "ada's employment files under employer",
        term: {
          op: "fix",
          schema: "RecallWork",
          entity: "person:ada"
        },
        termHash: "1e20c519114c8182b3de52b05aa19ee3aac332f36278d3ae7aa61b9a9038b78c388a",
        expected: {
          id: "person:ada",
          props: {
            employer: [
              "1e204ca3e79caaa86e53cba0b39f3009d92ff1087becd4dbcada2ababeb1bcb548b2"
            ]
          }
        },
        expectedCanonicalHex: "a26269646a706572736f6e3a6164616570726f7073a168656d706c6f79657281a26269647844316532303463613365373963616161383665353363626130623339663330303964393266663130383762656364346462636164613261626162656231626362353438623266636c61696d73a366617574686f726d6469643a6b65793a7a4170704168706f696e7465727382a264726f6c6566776f726b657266746172676574a26269646a706572736f6e3a61646167636f6e7465787468656d706c6f796572a264726f6c656c6f7267616e697a6174696f6e66746172676574a26269646c636f6d70616e793a61636d6567636f6e7465787469656d706c6f796565736974696d657374616d70f95640"
      }
    ],
    signatures: [
      {
        name: "sig-two-contexted-pairs",
        delta: "a1-employment-ada",
        signature: [
          [
            "worker",
            "employer"
          ],
          [
            "organization",
            "employees"
          ]
        ],
        canonicalHex: "828266776f726b657268656d706c6f796572826c6f7267616e697a6174696f6e69656d706c6f79656573"
      },
      {
        name: "sig-contextless-pointer",
        delta: "w1-manager-eve",
        signature: [
          [
            "org"
          ],
          [
            "worker",
            "manager"
          ]
        ],
        canonicalHex: "8281636f72678266776f726b6572676d616e61676572"
      },
      {
        name: "sig-mapping-delta",
        delta: "m1-employer",
        signature: [
          [
            "rhizomatic.alias.slot",
            "rhizomatic.alias.mappings"
          ]
        ],
        canonicalHex: "8182757268697a6f6d617469632e616c6961732e736c6f7478197268697a6f6d617469632e616c6961732e6d617070696e6773"
      },
      {
        name: "sig-no-entity-pointers",
        delta: "p1-note",
        signature: [],
        canonicalHex: "80"
      }
    ]
  };

  // demo/tour/tour.ts
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  }
  var $ = (id) => document.getElementById(id);
  function labeled(text, input) {
    return el("label", { class: "field" }, el("span", {}, text), input);
  }
  function flash(node) {
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
  }
  function valueOf(claims) {
    const neg = claims.pointers.find((x) => x.role === "negates");
    if (neg !== void 0) return "(retraction)";
    const p = claims.pointers.find((x) => x.target.kind === "primitive");
    if (p !== void 0) {
      return JSON.stringify(p.target.value);
    }
    return "(edge)";
  }
  function parseValue(raw) {
    const n = Number(raw);
    return Number.isFinite(n) && raw.trim() !== "" ? n : raw;
  }
  function widgetAtom() {
    const host = $("w-atom");
    const author = el("input", { value: "alice" });
    const ts = el("input", { value: "1", type: "number" });
    const entity = el("input", { value: "movie:blade_runner" });
    const role = el("input", { value: "movie" });
    const prop = el("input", { value: "director" });
    const val = el("input", { value: "Ridley Scott" });
    const claimsOut = el("pre", { class: "code" });
    const bytesOut = el("div", { class: "bytes mono" });
    const bytesMeta = el("div", { class: "meta" });
    const idOut = el("div", { class: "id mono" });
    const rustLine = el("div", { class: "meta", style: "margin-top:0.5em" });
    const err = el("div", { class: "error" });
    const render = () => {
      const claims = {
        author: author.value,
        timestamp: Number(ts.value),
        pointers: [
          {
            role: role.value,
            target: { kind: "entity", entity: { id: entity.value, context: prop.value } }
          },
          { role: prop.value, target: { kind: "primitive", value: parseValue(val.value) } }
        ]
      };
      claimsOut.textContent = JSON.stringify(claimsToJson(claims), null, 2);
      try {
        const hex = canonicalHex(claims);
        bytesOut.textContent = hex.replace(/(..)/g, "$1 ").trimEnd();
        bytesMeta.textContent = `${hex.length / 2} bytes of canonical CBOR \u2014 this IS the wire format`;
        const id = computeId(claims);
        idOut.textContent = id;
        err.textContent = "";
        flash(idOut);
        if (RUST !== null) {
          const r = RUST.call({ op: "canonical", claims: claimsToJson(claims) });
          const agree = okStr(r, "hex") === hex && okStr(r, "id") === id;
          rustLine.textContent = agree ? `\u{1F980} the Rust witness (compiled to WebAssembly, also on this page) just computed the same ${hex.length / 2} bytes and the same id \u2014 two languages, zero coordination` : `\u{1F980} RUST DISAGREES: ${r.err ?? "different bytes"} \u2014 this would be a P0 parity bug`;
          rustLine.className = agree ? "meta" : "error";
        } else {
          rustLine.textContent = rustFailed ? "(the Rust WASM witness couldn't load in this browser \u2014 CI still enforces byte parity)" : "loading the Rust witness (WASM)\u2026";
        }
      } catch (e) {
        bytesOut.textContent = "\u2014";
        bytesMeta.textContent = "";
        idOut.textContent = "\u2014";
        rustLine.textContent = "";
        err.textContent = `the format refuses this delta: ${e.message}`;
      }
    };
    host.append(
      el(
        "div",
        { class: "controls" },
        labeled("author", author),
        labeled("timestamp", ts),
        labeled("entity", entity),
        labeled("its role", role),
        labeled("property (context)", prop),
        labeled("value", val)
      ),
      el("div", { class: "panel-title" }, "the claims, as data (JSON debug profile)"),
      claimsOut,
      el("div", { class: "panel-title" }, "canonical bytes"),
      bytesOut,
      bytesMeta,
      el("div", { class: "panel-title" }, "content-derived identity (blake3-256 multihash)"),
      idOut,
      rustLine,
      err
    );
    for (const i of [author, ts, entity, role, prop, val]) i.addEventListener("input", render);
    rustReady.push(render);
    render();
  }
  function widgetPerspectives() {
    const host = $("w-perspectives");
    const leftId = el("input", { value: "movie:blade_runner" });
    const leftCtx = el("input", { value: "director" });
    const rightId = el("input", { value: "person:ridley_scott" });
    const rightCtx = el("input", { value: "movies" });
    const deltaOut = el("pre", { class: "code" });
    const idOut = el("div", { class: "meta mono" });
    const leftPane = el("pre", { class: "code" });
    const rightPane = el("pre", { class: "code" });
    const leftTitle = el("div", { class: "panel-title" });
    const rightTitle = el("div", { class: "panel-title" });
    const err = el("div", { class: "error" });
    const VIEW_TERM = parseTerm({
      op: "group",
      key: "byTargetContext",
      in: { op: "mask", policy: "drop", in: "input" }
    });
    const LATEST = parsePolicy({ default: { pick: { order: { byTimestamp: "desc" } } } });
    const paneFor = (set, root) => {
      const result = evalTerm(VIEW_TERM, set, root);
      if (result.sort !== "hview") return "(not an hview)";
      const view = resolveView(LATEST, result.hview);
      return Object.keys(view).length === 0 ? "{}  \u2190 no backpointer. The reference exists;\n    the property was never granted." : JSON.stringify(view, null, 2);
    };
    const render = () => {
      const entityRef = (id, ctx) => ctx === "" ? { id } : { id, context: ctx };
      const claims = {
        author: "alice",
        timestamp: 1,
        pointers: [
          {
            role: "movie",
            target: { kind: "entity", entity: entityRef(leftId.value, leftCtx.value) }
          },
          {
            role: "director",
            target: { kind: "entity", entity: entityRef(rightId.value, rightCtx.value) }
          }
        ]
      };
      deltaOut.textContent = JSON.stringify(claimsToJson(claims), null, 2);
      try {
        const delta = makeDelta(claims);
        const set = DeltaSet.from([delta]);
        idOut.textContent = `one delta \xB7 id ${delta.id.slice(0, 24)}\u2026`;
        leftTitle.textContent = `the view at ${leftId.value}`;
        rightTitle.textContent = `the view at ${rightId.value}`;
        leftPane.textContent = paneFor(set, leftId.value);
        rightPane.textContent = paneFor(set, rightId.value);
        err.textContent = "";
      } catch (e) {
        leftPane.textContent = "\u2014";
        rightPane.textContent = "\u2014";
        err.textContent = `the format refuses this delta: ${e.message}`;
      }
    };
    host.append(
      el(
        "div",
        { class: "controls" },
        labeled("entity A (role: movie)", leftId),
        labeled("context at A", leftCtx),
        labeled("entity B (role: director)", rightId),
        labeled("context at B", rightCtx)
      ),
      el("div", { class: "panel-title" }, "the delta (JSON debug profile)"),
      deltaOut,
      idOut,
      el(
        "div",
        { class: "persp-grid" },
        el("div", { class: "persp-cell" }, leftTitle, leftPane),
        el("div", { class: "persp-cell" }, rightTitle, rightPane)
      ),
      err
    );
    for (const i of [leftId, leftCtx, rightId, rightCtx]) i.addEventListener("input", render);
    render();
  }
  var ROOT = "movie:blade_runner";
  function makeWorldA() {
    const alice = new Peer("a1".repeat(32));
    const bob = new Peer("b2".repeat(32));
    let clock = 0;
    const tick = () => ++clock;
    const claim = (context, value) => ({
      timestamp: tick(),
      pointers: [
        { role: "movie", target: { kind: "entity", entity: { id: ROOT, context } } },
        { role: context, target: { kind: "primitive", value: parseValue(String(value)) } }
      ]
    });
    alice.authorClaims(claim("title", "Blade Runner"));
    alice.authorClaims(claim("director", "Ridley Scott"));
    bob.authorClaims(claim("director", "Denis Villeneuve"));
    bob.authorClaims(claim("year", 1982));
    syncBoth(alice, bob);
    return {
      alice,
      bob,
      tick,
      clock: () => clock,
      whoIs(author) {
        if (author === alice.author) return "Alice";
        if (author === bob.author) return "Bob";
        return `${author.slice(8, 16)}\u2026`;
      }
    };
  }
  var A = makeWorldA();
  function bodyTerm(asOf, audit) {
    const base = asOf === void 0 ? "input" : {
      op: "select",
      pred: { match: { field: "timestamp", cmp: "lte", const: asOf } },
      in: "input"
    };
    return parseTerm({
      op: "group",
      key: "byTargetContext",
      in: { op: "mask", policy: audit ? "annotate" : "drop", in: base }
    });
  }
  function hviewAt(peer, asOf, audit) {
    const result = peer.reactor.eval(bodyTerm(asOf, audit), ROOT);
    if (result.sort !== "hview") throw new Error("expected hview");
    return result.hview;
  }
  function renderSuperposition() {
    const host = $("w-superposition-list");
    host.replaceChildren();
    const hview = hviewAt(A.alice, void 0, false);
    const entries = hview.props.get("director") ?? [];
    for (const e of entries) {
      host.append(
        el(
          "div",
          { class: "entry" },
          el("span", { class: "mono val" }, valueOf(e.delta.claims)),
          el(
            "span",
            { class: "meta" },
            ` \u2014 claimed by ${A.whoIs(e.delta.claims.author)} at t=${e.delta.claims.timestamp} \xB7 `
          ),
          el("span", { class: "mono dim" }, `${e.delta.id.slice(4, 16)}\u2026`)
        )
      );
    }
    host.append(
      el(
        "div",
        { class: "meta" },
        `${entries.length} claims about "director" coexist. None of them won. None of them had to.`
      )
    );
  }
  function widgetSuperposition() {
    const host = $("w-superposition");
    host.append(el("div", { class: "panel-title" }, 'the property "director", as stored'));
    host.append(el("div", { id: "w-superposition-list" }));
    const who = el("select", {});
    who.append(el("option", {}, "Alice"), el("option", {}, "Bob"));
    const val = el("input", { placeholder: "your candidate director" });
    const add2 = el("button", {}, "add a third opinion");
    add2.onclick = () => {
      if (!val.value) return;
      const peer = who.value === "Alice" ? A.alice : A.bob;
      peer.authorClaims({
        timestamp: A.tick(),
        pointers: [
          {
            role: "movie",
            target: { kind: "entity", entity: { id: ROOT, context: "director" } }
          },
          { role: "director", target: { kind: "primitive", value: parseValue(val.value) } }
        ]
      });
      syncBoth(A.alice, A.bob);
      val.value = "";
      refreshWorldA();
    };
    host.append(el("div", { class: "controls" }, labeled("as", who), labeled("value", val), add2));
  }
  var POLICIES = [
    {
      label: "latest wins",
      note: "pick by timestamp, newest first",
      make: () => parsePolicy({ default: { pick: { order: { byTimestamp: "desc" } } } })
    },
    {
      label: "trust Alice",
      note: "pick by author rank: Alice first",
      make: () => parsePolicy({ default: { pick: { order: { byAuthorRank: [A.alice.author] } } } })
    },
    {
      label: "trust Bob",
      note: "pick by author rank: Bob first",
      make: () => parsePolicy({ default: { pick: { order: { byAuthorRank: [A.bob.author] } } } })
    },
    {
      label: "surface conflicts",
      note: "directors disagree? say so, loudly",
      make: () => parsePolicy({
        props: { director: { conflicts: { order: { byTimestamp: "desc" } } } },
        default: { pick: { order: { byTimestamp: "desc" } } }
      })
    }
  ];
  function renderLenses() {
    const host = $("w-lens");
    host.replaceChildren();
    const hview = hviewAt(A.alice, void 0, false);
    for (const p of POLICIES) {
      const view = resolveView(p.make(), hview);
      host.append(
        el(
          "div",
          { class: "lens-cell" },
          el("div", { class: "panel-title" }, p.label),
          el("div", { class: "meta" }, p.note),
          el("pre", { class: "code" }, JSON.stringify(view, null, 2))
        )
      );
    }
  }
  function renderHistory() {
    const host = $("w-history-claims");
    host.replaceChildren();
    const audit = $("w-history-audit").checked;
    const slider = $("w-history-asof");
    slider.max = String(A.clock());
    if (slider.dataset["touched"] !== "yes") slider.value = slider.max;
    const asOf = Number(slider.value) >= A.clock() ? void 0 : Number(slider.value);
    $("w-history-asof-label").textContent = asOf === void 0 ? "now" : `as of t\u2264${asOf}`;
    const describeTarget = (id) => {
      const target = A.alice.reactor.get(id);
      if (target === void 0) return "?";
      const subject = target.claims.pointers.find((p) => p.target.kind === "entity");
      const ctx = subject?.target.kind === "entity" ? subject.target.entity.context ?? "?" : "?";
      return `t=${target.claims.timestamp}'s ${ctx} = ${valueOf(target.claims)}`;
    };
    for (const d of A.alice.reactor.arrivalLog()) {
      const negPtr = d.claims.pointers.find((p) => p.role === "negates");
      if (negPtr !== void 0) {
        const targetId = negPtr.target.kind === "delta" ? negPtr.target.deltaRef.delta : "";
        host.append(
          el(
            "div",
            { class: "entry negation" },
            el("span", { class: "mono" }, `t=${d.claims.timestamp} `),
            `${A.whoIs(d.claims.author)} negates ${describeTarget(targetId)} `,
            el("span", { class: "meta" }, "\u2014 a new claim about an old claim; nothing was edited")
          )
        );
        continue;
      }
      const negIds = A.alice.reactor.negationsOf(d.id);
      const negAt = negIds.map((id) => A.alice.reactor.get(id)?.claims.timestamp).filter((t) => t !== void 0).sort((x, y) => x - y)[0];
      const retracted = negAt !== void 0;
      const subject = d.claims.pointers.find((p) => p.target.kind === "entity");
      const ctx = subject?.target.kind === "entity" ? subject.target.entity.context ?? "?" : "?";
      const row = el(
        "div",
        { class: `entry${retracted ? " retracted" : ""}` },
        el("span", { class: "mono" }, `t=${d.claims.timestamp} `),
        `${A.whoIs(d.claims.author)}: ${ctx} = `,
        el("span", { class: "mono val" }, valueOf(d.claims)),
        " "
      );
      if (!retracted) {
        const btn = el("button", { class: "small" }, "retract");
        btn.onclick = () => {
          const peer = d.claims.author === A.alice.author ? A.alice : A.bob;
          const neg = makeNegationClaims(peer.author, A.tick(), d.id, "retracted in the tour");
          peer.authorClaims({ timestamp: neg.timestamp, pointers: [...neg.pointers] });
          syncBoth(A.alice, A.bob);
          refreshWorldA();
        };
        row.append(btn);
      } else {
        row.append(el("span", { class: "meta" }, ` [negated at t=${negAt} \u2014 still right here]`));
      }
      host.append(row);
    }
    const out = $("w-history-out");
    const hview = hviewAt(A.alice, asOf, audit);
    if (audit) {
      const lines = [];
      for (const [prop, entries] of [...hview.props.entries()].sort()) {
        for (const e of entries) {
          lines.push(
            `${e.negated ? "\u2717" : "\u2713"} ${prop} = ${valueOf(e.delta.claims)}  \u2014 ${A.whoIs(
              e.delta.claims.author
            )} @ t=${e.delta.claims.timestamp}${e.negated ? "  [retracted]" : ""}`
          );
        }
      }
      out.textContent = lines.join("\n") || "(nothing here yet)";
    } else {
      const view = resolveView(POLICIES[0].make(), hview);
      out.textContent = JSON.stringify(view, null, 2);
    }
  }
  function widgetHistory() {
    const host = $("w-history");
    const audit = el("input", { type: "checkbox", id: "w-history-audit" });
    const slider = el("input", {
      type: "range",
      id: "w-history-asof",
      min: "1",
      max: String(A.clock()),
      value: String(A.clock())
    });
    slider.addEventListener("input", () => {
      slider.dataset["touched"] = "yes";
      renderHistory();
    });
    audit.addEventListener("input", renderHistory);
    host.append(
      el("div", { class: "panel-title" }, "every claim ever made (the arrival log)"),
      el("div", { id: "w-history-claims" }),
      el(
        "div",
        { class: "controls" },
        el("label", { class: "field row" }, audit, el("span", {}, "audit lens (see retractions)")),
        el(
          "label",
          { class: "field grow" },
          el("span", {}, "time travel"),
          slider,
          el("span", { id: "w-history-asof-label", class: "mono" }, "now")
        )
      ),
      el("div", { class: "panel-title" }, "the view, through your chosen lens"),
      el("pre", { class: "code", id: "w-history-out" })
    );
  }
  function refreshWorldA() {
    renderSuperposition();
    renderLenses();
    renderHistory();
    renderStats();
  }
  var ANAKIN = "person:anakin_skywalker";
  function makeWorldB() {
    const kenobi = new Peer("d4".repeat(32));
    const vader = new Peer("e5".repeat(32));
    let clock = 100;
    const tick = () => ++clock;
    const claim = (peer, context, value) => {
      peer.authorClaims({
        timestamp: tick(),
        pointers: [
          { role: "person", target: { kind: "entity", entity: { id: ANAKIN, context } } },
          { role: context, target: { kind: "primitive", value } }
        ]
      });
    };
    claim(kenobi, "fate", "betrayed and murdered by Darth Vader");
    claim(kenobi, "lightsaber", "kept for his son");
    claim(vader, "fate", "became Darth Vader");
    claim(vader, "father_of", "Luke Skywalker");
    return { kenobi, vader, tick };
  }
  var B = makeWorldB();
  function renderFederation() {
    for (const [name, peer] of [
      ["Obi-Wan", B.kenobi],
      ["Vader", B.vader]
    ]) {
      const card = $(`w-fed-${name}`);
      card.replaceChildren();
      const digest = peer.reactor.digest();
      card.append(
        el("h3", {}, name),
        el(
          "div",
          { class: "digest mono", title: digest },
          `digest ${digest.slice(4, 16)}\u2026 \xB7 ${peer.reactor.size} deltas`
        )
      );
      const list = el("div", { class: "claims" });
      for (const d of peer.reactor.arrivalLog()) {
        const subject = d.claims.pointers.find((p) => p.target.kind === "entity");
        const ctx = subject?.target.kind === "entity" ? subject.target.entity.context ?? "?" : "?";
        const own = d.claims.author === peer.author;
        list.append(
          el(
            "div",
            { class: "entry" },
            el("span", { class: "meta" }, own ? "(own) " : "(synced) "),
            `${ctx} = `,
            el("span", { class: "mono val" }, valueOf(d.claims))
          )
        );
      }
      card.append(list);
      const prop = el("input", { placeholder: "property" });
      const val = el("input", { placeholder: "value" });
      const add2 = el("button", { class: "small" }, "claim");
      add2.onclick = () => {
        if (!prop.value || !val.value) return;
        peer.authorClaims({
          timestamp: B.tick(),
          pointers: [
            {
              role: "person",
              target: { kind: "entity", entity: { id: ANAKIN, context: prop.value } }
            },
            { role: prop.value, target: { kind: "primitive", value: parseValue(val.value) } }
          ]
        });
        prop.value = "";
        val.value = "";
        renderFederation();
        renderStats();
      };
      card.append(el("div", { class: "form" }, prop, val, add2));
    }
    const a = B.kenobi.reactor.digest();
    const b = B.vader.reactor.digest();
    const verdict = $("w-fed-verdict");
    verdict.replaceChildren();
    if (a === b) {
      verdict.append(
        el(
          "div",
          { class: "ok" },
          "\u2713 digests identical \u2014 the peers converged. Both points of view now travel together."
        )
      );
    } else {
      verdict.append(
        el("div", { class: "meta" }, "digests differ \u2014 the peers have diverged. Sync to converge.")
      );
    }
  }
  function widgetFederation() {
    const sync = $("w-fed-sync");
    sync.onclick = () => {
      syncBoth(B.kenobi, B.vader);
      renderFederation();
      renderStats();
    };
    renderFederation();
  }
  function widgetReplay() {
    const btn = $("w-replay-btn");
    const out = $("w-replay-out");
    btn.onclick = () => {
      const log = [...B.kenobi.reactor.arrivalLog()];
      const shuffled = [...log];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const fresh = new Reactor();
      for (const d of shuffled) fresh.ingest(d);
      const original = B.kenobi.reactor.digest();
      const replayed = fresh.digest();
      const order = shuffled.map((d) => log.indexOf(d) + 1).join(", ");
      const same = original === replayed;
      out.textContent = `replayed ${log.length} deltas in order [${order}]
original digest  ${original.slice(4, 36)}\u2026
replayed digest  ${replayed.slice(4, 36)}\u2026
` + (same ? "\u2713 byte-identical. Order never matters." : "\u2717 DIVERGED \u2014 file a bug, this is a P0");
      flash(out);
    };
  }
  var RUST = null;
  var rustFailed = false;
  var rustReady = [];
  async function loadRustWitness() {
    try {
      const res = await fetch("rust-witness.wasm");
      if (!res.ok) return null;
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
      const ex = instance.exports;
      return {
        call(req) {
          const bytes = new TextEncoder().encode(JSON.stringify(req));
          const ptr = ex.rhz_alloc(bytes.length);
          new Uint8Array(ex.memory.buffer).set(bytes, ptr);
          const packed = ex.rhz_call(ptr, bytes.length);
          ex.rhz_dealloc(ptr, bytes.length);
          const outPtr = Number(packed >> 32n);
          const outLen = Number(packed & 0xffffffffn);
          const out = new TextDecoder().decode(
            new Uint8Array(ex.memory.buffer.slice(outPtr, outPtr + outLen))
          );
          ex.rhz_dealloc(outPtr, outLen);
          return JSON.parse(out);
        }
      };
    } catch {
      return null;
    }
  }
  function okStr(r, key) {
    const v = r.ok?.[key];
    return typeof v === "string" ? v : void 0;
  }
  function okBool(r, key) {
    return r.ok?.[key] === true;
  }
  var tryCase = (name, check) => {
    try {
      return { name, pass: check() };
    } catch {
      return { name, pass: false };
    }
  };
  function evalSuite(label, file, doc) {
    const set = DeltaSet.from(doc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims))));
    const registry = doc.schemas === void 0 ? void 0 : SchemaRegistry.build(
      doc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) }))
    );
    const cases = [
      tryCase(
        "fixture ids are pinned",
        () => doc.fixture.deltas.every((d) => makeDelta(parseClaims(d.claims)).id === d.id)
      ),
      ...doc.cases.map(
        (c) => tryCase(c.name, () => {
          const result = evalTerm(parseTerm(c.term), set, c.root, registry);
          return resultCanonicalHex(result) === c.expectedCanonicalHex;
        })
      )
    ];
    return { label, file, cases };
  }
  function runConformance() {
    const keys = keys_default;
    const deltas = deltas_default;
    const signed = deltas_signed_default;
    const setDigest = set_digest_default;
    return [
      {
        label: "canonical CBOR bytes + content addresses",
        file: "vectors/l0-delta/deltas.json",
        cases: deltas.map(
          (v) => tryCase(v.name, () => {
            const claims = parseClaims(v.claims);
            return canonicalHex(claims) === v.canonicalCborHex && computeId(claims) === v.id;
          })
        )
      },
      {
        label: "Ed25519 keys derive from pinned seeds",
        file: "vectors/keys/keys.json",
        cases: keys.map(
          (k) => tryCase(k.keyId, () => {
            return publicKeyFromSeed(k.seedHex) === k.publicKeyHex && k.author === `ed25519:${k.publicKeyHex}`;
          })
        )
      },
      {
        label: "deterministic signatures, verification, tamper-rejection",
        file: "vectors/l0-delta/deltas-signed.json",
        cases: signed.map(
          (v) => tryCase(v.name, () => {
            const key = keys.find((k) => k.keyId === v.keyId);
            if (key === void 0) return false;
            const claims = parseClaims(v.claims);
            const resigned = signClaims(claims, key.seedHex);
            const tampered = verifyDelta({
              id: resigned.id,
              claims: { ...claims, timestamp: claims.timestamp + 1 },
              sig: resigned.sig ?? ""
            });
            return canonicalHex(claims) === v.canonicalCborHex && computeId(claims) === v.id && resigned.sig === v.sig && verifyDelta(resigned) === "verified" && tampered === "invalid";
          })
        )
      },
      {
        label: "delta-set digest (order-independent)",
        file: "vectors/l0-delta/set-digest.json",
        cases: [
          tryCase("set of all deltas.json vectors", () => {
            const s = DeltaSet.from(deltas.map((v) => makeDelta(parseClaims(v.claims))));
            return JSON.stringify(s.ids()) === JSON.stringify(setDigest.ids) && s.digest() === setDigest.digest;
          })
        ]
      },
      evalSuite(
        "evaluator: select / union / mask",
        "vectors/l1-eval/eval-basic.json",
        eval_basic_default
      ),
      evalSuite(
        "evaluator: group / prune (HyperViews)",
        "vectors/l1-eval/eval-hview.json",
        eval_hview_default
      ),
      evalSuite(
        "evaluator: expand / fix (schemas)",
        "vectors/l1-eval/eval-expand.json",
        eval_expand_default
      ),
      evalSuite(
        "evaluator: resolve (policies \u2192 Views)",
        "vectors/l1-eval/eval-resolve.json",
        eval_resolve_default
      ),
      evalSuite(
        "evaluator: parameterized terms (holes)",
        "vectors/l1-eval/eval-holes.json",
        eval_holes_default
      ),
      evalSuite(
        "evaluator: the aliased closure (SPEC-9)",
        "vectors/l1-eval/eval-aliased.json",
        eval_aliased_default
      )
    ];
  }
  function runRustConformance(rust) {
    const keys = keys_default;
    const deltas = deltas_default;
    const signed = deltas_signed_default;
    const setDigest = set_digest_default;
    const out = /* @__PURE__ */ new Map();
    out.set(
      "canonical CBOR bytes + content addresses",
      deltas.map(
        (v) => tryCase(v.name, () => {
          const r = rust.call({ op: "canonical", claims: v.claims });
          return okStr(r, "hex") === v.canonicalCborHex && okStr(r, "id") === v.id;
        })
      )
    );
    out.set(
      "deterministic signatures, verification, tamper-rejection",
      signed.map(
        (v) => tryCase(v.name, () => {
          const key = keys.find((k) => k.keyId === v.keyId);
          if (key === void 0) return false;
          const r = rust.call({ op: "sign", claims: v.claims, seedHex: key.seedHex });
          return okStr(r, "sig") === v.sig && okBool(r, "verified") && okBool(r, "tamperRejected");
        })
      )
    );
    out.set("delta-set digest (order-independent)", [
      tryCase("set of all deltas.json vectors", () => {
        const r = rust.call({ op: "setDigest", deltas: deltas.map((v) => v.claims) });
        return JSON.stringify(r.ok?.["ids"]) === JSON.stringify(setDigest.ids) && okStr(r, "digest") === setDigest.digest;
      })
    ]);
    const rustEval = (label, doc) => {
      out.set(
        label,
        doc.cases.map(
          (c) => tryCase(c.name, () => {
            const req = {
              op: "eval",
              fixture: doc.fixture.deltas.map((d) => d.claims),
              term: c.term
            };
            if (c.root !== void 0) req["root"] = c.root;
            if (doc.schemas !== void 0) req["schemas"] = doc.schemas;
            return okStr(rust.call(req), "hex") === c.expectedCanonicalHex;
          })
        )
      );
    };
    rustEval("evaluator: select / union / mask", eval_basic_default);
    rustEval("evaluator: group / prune (HyperViews)", eval_hview_default);
    rustEval("evaluator: expand / fix (schemas)", eval_expand_default);
    rustEval("evaluator: resolve (policies \u2192 Views)", eval_resolve_default);
    rustEval("evaluator: parameterized terms (holes)", eval_holes_default);
    rustEval("evaluator: the aliased closure (SPEC-9)", eval_aliased_default);
    return out;
  }
  function widgetConformance() {
    const host = $("w-conformance");
    const btn = el("button", { class: "big" }, "\u25B6 re-run the vectors");
    const out = el("div", { class: "suites" });
    const run = () => {
      const t0 = performance.now();
      const suites = runConformance();
      const rustSuites = RUST === null ? null : runRustConformance(RUST);
      const ms = Math.max(1, Math.round(performance.now() - t0));
      out.replaceChildren();
      let pass = 0;
      let total = 0;
      for (const s of suites) {
        const ok = s.cases.filter((c) => c.pass).length;
        pass += ok;
        total += s.cases.length;
        const rust = rustSuites?.get(s.label);
        let rustNote = "";
        if (rust !== void 0) {
          const rustOk = rust.filter((c) => c.pass).length;
          pass += rustOk;
          total += rust.length;
          rustNote = ` \xB7 Rust ${rustOk}/${rust.length}`;
        }
        const allGreen = ok === s.cases.length && (rust === void 0 || rust.every((c) => c.pass));
        const row = el(
          "div",
          { class: "entry" },
          el("span", { class: allGreen ? "val" : "error" }, allGreen ? "\u2713 " : "\u2717 "),
          `${s.label} \u2014 TS ${ok}/${s.cases.length}${rustNote} `,
          el("span", { class: "meta mono" }, s.file)
        );
        for (const c of s.cases.filter((x) => !x.pass)) {
          row.append(el("div", { class: "error" }, `  \u2717 TS: ${c.name}`));
        }
        for (const c of (rust ?? []).filter((x) => !x.pass)) {
          row.append(el("div", { class: "error" }, `  \u2717 Rust: ${c.name}`));
        }
        out.append(row);
      }
      const witnesses = rustSuites === null ? rustFailed ? " (TypeScript only \u2014 the Rust WASM witness couldn't load in this browser; CI still enforces parity)" : " (TypeScript \u2014 the Rust WASM witness is still loading\u2026)" : " across BOTH witnesses \u2014 TypeScript, and Rust compiled to WebAssembly";
      out.append(
        el(
          "div",
          { class: pass === total ? "ok" : "error", style: "margin-top:0.8em" },
          pass === total ? `\u2713 ${pass}/${total} green in ${ms} ms${witnesses}. Your browser is now a conformance witness.` : `\u2717 ${pass}/${total} \u2014 a vector failed; this page is out of sync with the suite.`
        )
      );
      flash(out);
    };
    btn.onclick = run;
    host.append(out, btn);
    rustReady.push(run);
    run();
  }
  function widgetPack() {
    const btn = $("w-pack-btn");
    const out = $("w-pack-out");
    btn.onclick = () => {
      const snapshot = B.kenobi.reactor.snapshot();
      const bytes = packSet(snapshot);
      const restored = unpackSet(bytes);
      const match = restored.digest() === snapshot.digest();
      out.textContent = `packed ${snapshot.size} deltas \u2192 ${bytes.length} bytes of canonical CBOR
packId   ${packId(bytes).slice(0, 32)}\u2026  (same set \u21D2 same bytes \u21D2 same id)
unpacked \u2192 ${restored.size} deltas, digest ${match ? "IDENTICAL" : "MISMATCH"}
` + (match ? "\u2713 rehydration is self-verifying \u2014 a corrupted pack fails, loudly." : "\u2717 round-trip diverged \u2014 file a bug, this is a P0");
      flash(out);
    };
  }
  function widgetDerivation() {
    const host = $("w-derivation");
    const root = "movie:blade_runner";
    const body = parseTerm({
      op: "group",
      key: "byTargetContext",
      in: {
        op: "select",
        pred: { hasPointer: { targetEntity: { var: "root" } } },
        in: { op: "mask", policy: "drop", in: "input" }
      }
    });
    const reactor = new Reactor();
    reactor.register("movie", body, [root]);
    const bot = new DerivationHost(reactor);
    let clock = 1e3;
    const dataClaim = (context, value, author) => makeDelta({
      timestamp: ++clock,
      author,
      pointers: [
        { role: "movie", target: { kind: "entity", entity: { id: root, context } } },
        { role: context, target: { kind: "primitive", value } }
      ]
    });
    const avgFn = (view, r) => {
      const nums = (view.props.get("rating") ?? []).flatMap((e) => e.delta.claims.pointers).filter((p) => p.target.kind === "primitive").map((p) => p.target.value).filter((v) => typeof v === "number");
      if (nums.length === 0) return [];
      const avg = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100;
      return [
        [
          { role: "movie", target: { kind: "entity", entity: { id: r, context: "avgRating" } } },
          { role: "avgRating", target: { kind: "primitive", value: avg } }
        ]
      ];
    };
    const tamperedFn = (v, r) => avgFn(v, r).map(
      (ptrs) => ptrs.map(
        (p) => p.target.kind === "primitive" && typeof p.target.value === "number" ? { ...p, target: { kind: "primitive", value: p.target.value + 1 } } : p
      )
    );
    const spec = {
      name: "binding:avg",
      fnId: "fn:avgRating",
      materialization: "movie",
      pure: true,
      budget: 100,
      emit: "supersede"
    };
    const botAuthor = bot.install(spec, avgFn, "f6".repeat(32));
    let lastInputLen = 0;
    const rate = (n, author) => {
      const before = reactor.arrivalLog().length;
      bot.ingest(dataClaim("rating", n, author));
      lastInputLen = before + 1;
    };
    bot.ingest(dataClaim("title", "Blade Runner", "did:key:zAlice"));
    rate(9, "did:key:zCarol");
    rate(8, "did:key:zDana");
    const ratingsOut = el("div", { class: "meta" });
    const receiptOut = el("pre", { class: "code" });
    const verifyOut = el("div", {});
    const latestEmission = () => {
      const log = reactor.arrivalLog();
      for (let i = log.length - 1; i >= 0; i--) {
        const d = log[i];
        if (d.claims.author !== botAuthor) continue;
        if (d.claims.pointers.some((p) => p.role === "negates")) continue;
        return d;
      }
      return void 0;
    };
    const render = () => {
      const view = reactor.materializedView("movie", root);
      const ratings = view ? view.props.get("rating") ?? [] : [];
      ratingsOut.textContent = `${ratings.length} ratings on record: ${ratings.map((e) => valueOf(e.delta.claims)).join(", ")}`;
      const emitted = latestEmission();
      if (emitted === void 0) {
        receiptOut.textContent = "(no emission yet \u2014 rate the movie)";
        return;
      }
      const prov = (suffix) => {
        const p = emitted.claims.pointers.find((x) => x.role === `${VOCAB_PREFIX}.derived.${suffix}`);
        if (p === void 0) return "?";
        if (p.target.kind === "primitive") return String(p.target.value);
        if (p.target.kind === "entity") return p.target.entity.id;
        return p.target.kind;
      };
      receiptOut.textContent = [
        `avgRating = ${valueOf(emitted.claims)}`,
        ``,
        `author  ${emitted.claims.author.slice(0, 32)}\u2026  (the bot's own keypair)`,
        `id      ${emitted.id.slice(0, 32)}\u2026`,
        `${VOCAB_PREFIX}.derived.by    = ${prov("by")}`,
        `${VOCAB_PREFIX}.derived.from  = ${prov("from").slice(0, 24)}\u2026  (the exact input view, pinned byte for byte)`,
        `${VOCAB_PREFIX}.derived.under = ${prov("under")}`
      ].join("\n");
      verifyOut.replaceChildren();
    };
    const verify = () => {
      const emitted = latestEmission();
      if (emitted === void 0) return;
      const probe = new Reactor();
      probe.register("movie", body, [root]);
      for (const d of reactor.arrivalLog().slice(0, lastInputLen)) probe.ingest(d);
      const viewHex = probe.materializedHex("movie", root);
      const view = probe.materializedView("movie", root);
      if (view === void 0 || viewHex === void 0) return;
      const genuine = verifyPureDerivation(emitted, spec, avgFn, view, root, viewHex);
      const tampered = verifyPureDerivation(emitted, spec, tamperedFn, view, root, viewHex);
      verifyOut.replaceChildren(
        el(
          "div",
          { class: genuine ? "ok" : "error" },
          genuine ? "\u2713 replay verified \u2014 re-ran the function on the pinned input; the recomputed content address matches the claim's id, and the signature checks out" : "\u2717 replay FAILED \u2014 this receipt does not check out"
        ),
        el(
          "div",
          { class: tampered ? "error" : "ok" },
          tampered ? "\u2717 the tampered function ALSO verified \u2014 that would be a bug" : "\u2713 and a tampered function (+1 to every average) fails the same replay \u2014 forgery is detectable, not just discouraged"
        )
      );
      flash(verifyOut);
    };
    const buttons = el("div", { class: "controls" });
    for (const n of [6, 7, 8, 9, 10]) {
      const b = el("button", {}, `rate ${n}`);
      b.onclick = () => {
        rate(n, "did:key:zYou");
        render();
      };
      buttons.append(b);
    }
    const verifyBtn = el(
      "button",
      { class: "big", style: "margin-top:0.8em" },
      "\u{1F50D} replay-verify the receipt"
    );
    verifyBtn.onclick = verify;
    host.append(
      el("div", { class: "panel-title" }, "rate the movie (as did:key:zYou)"),
      buttons,
      ratingsOut,
      el(
        "div",
        { class: "panel-title" },
        "the bot's latest claim \u2014 an ordinary signed delta, carrying its receipt"
      ),
      receiptOut,
      verifyBtn,
      verifyOut
    );
    render();
  }
  function renderStats() {
    const n = A.alice.reactor.size + A.bob.reactor.size + B.kenobi.reactor.size + B.vader.reactor.size;
    $("live-stats").textContent = `${n} signed deltas currently live in this tab \u2014 authored, hashed, and verified by the real implementation.`;
  }
  widgetAtom();
  widgetPerspectives();
  widgetSuperposition();
  widgetHistory();
  widgetFederation();
  widgetReplay();
  widgetPack();
  widgetDerivation();
  widgetConformance();
  refreshWorldA();
  void loadRustWitness().then((w) => {
    RUST = w;
    rustFailed = w === null;
    for (const cb of rustReady) cb();
  });
})();
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/utils.js:
@noble/curves/esm/abstract/modular.js:
@noble/curves/esm/abstract/curve.js:
@noble/curves/esm/abstract/edwards.js:
@noble/curves/esm/ed25519.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
