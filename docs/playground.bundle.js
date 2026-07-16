"use strict";
(() => {
  // src/cbor.ts
  var tstr = (v) => ({ t: "tstr", v });
  var bstr = (v) => ({ t: "bstr", v });
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
      case "bstr":
        writeHead(sink, 2, val.v.length);
        sink.pushBytes(val.v);
        return;
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

  // src/resolution.ts
  function isBytesView(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v) && v.value instanceof Uint8Array;
  }
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
  function renderTarget(t, expansion, schema) {
    if (expansion !== void 0) return resolveView(schema, expansion);
    switch (t.kind) {
      case "primitive":
        return t.value;
      case "entity":
        return t.entity.id;
      case "delta":
        return t.deltaRef.delta;
      case "bytes":
        return { mime: t.mime, value: t.value };
    }
  }
  function candidateValue(e, root, schema) {
    const nonFiling = [];
    e.delta.claims.pointers.forEach((p, i) => {
      const filing = p.target.kind === "entity" && p.target.entity.id === root;
      if (filing) return;
      nonFiling.push([p.role, renderTarget(p.target, e.expanded?.get(i), schema)]);
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
    if (isBytesView(v)) {
      return map([
        ["mime", tstr(v.mime)],
        ["value", bstr(v.value)]
      ]);
    }
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
  function applyMerge(fn, entries, root, schema) {
    const sorted = sortEntries({ kind: "lexById" }, entries);
    if (fn === "count") return sorted.length === 0 ? ABSENT : sorted.length;
    const prims = sorted.map((e) => candidateValue(e, root, schema)).filter((v) => isPrimitive(v));
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
  function applyPolicy(policy, entries, root, schema) {
    switch (policy.kind) {
      case "pick": {
        if (entries.length === 0) return ABSENT;
        const sorted = sortEntries(policy.order, entries);
        return candidateValue(sorted[0], root, schema);
      }
      case "all": {
        if (entries.length === 0) return ABSENT;
        return sortEntries(policy.order, entries).map((e) => candidateValue(e, root, schema));
      }
      case "merge":
        return applyMerge(policy.fn, entries, root, schema);
      case "conflicts": {
        const sorted = sortEntries(policy.order, entries);
        const seen = /* @__PURE__ */ new Set();
        const distinct = [];
        for (const e of sorted) {
          const v = candidateValue(e, root, schema);
          const key = viewCanonicalHex(v);
          if (!seen.has(key)) {
            seen.add(key);
            distinct.push(v);
          }
        }
        return distinct.length >= 2 ? distinct : ABSENT;
      }
      case "absentAs": {
        const inner = applyPolicy(policy.then, entries, root, schema);
        return inner === ABSENT ? policy.constant : inner;
      }
    }
  }
  function resolveView(schema, hview) {
    const keys = /* @__PURE__ */ new Set([...schema.props.keys(), ...hview.props.keys()]);
    const obj = {};
    for (const key of keys) {
      const entries = hview.props.get(key) ?? [];
      const policy = schema.props.get(key) ?? schema.default;
      const v = applyPolicy(policy, entries, hview.id, schema);
      if (v !== ABSENT) obj[key] = v;
    }
    return obj;
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
      case "bytes":
        return map([
          ["mime", tstr(t.mime)],
          ["value", bstr(t.value)]
        ]);
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

  // src/vocab.ts
  var VOCAB_PREFIX = "rhizomatic";

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
      // Bytes: map { "mime": tstr, "value": bstr } — the raw payload is the bstr and identity is its
      // hash (SPEC-1 §4.1, ERRATA D12); keys are sorted at encode time (D4).
      case "bytes":
        return map([
          ["mime", tstr(t.mime)],
          ["value", bstr(t.value)]
        ]);
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
      if (p.target.kind === "bytes") {
        if (typeof p.target.mime !== "string") throw new Error("bytes target mime must be a string");
        if (p.target.mime.length === 0) {
          throw new Error("bytes target mime must be non-empty (SPEC-1 \xA72.1)");
        }
        assertNfc(p.target.mime, "bytes mime");
        if (!(p.target.value instanceof Uint8Array)) {
          throw new Error("bytes target value must be a Uint8Array");
        }
      }
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
  function computeId(claims) {
    return contentAddress(canonicalBytes(claims));
  }

  // src/set.ts
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
      case "intersect":
        return termContainsInView(t.left) || termContainsInView(t.right);
      case "difference":
        return termContainsInView(t.of) || termContainsInView(t.without);
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
      case "intersect": {
        const left = expectDSet(evalTerm(term.left, input, root, registry, bindings), "intersect");
        const right = expectDSet(evalTerm(term.right, input, root, registry, bindings), "intersect");
        return dsetResult(fork(left.set, (d) => right.set.has(d.id)));
      }
      case "difference": {
        const of = expectDSet(evalTerm(term.of, input, root, registry, bindings), "difference");
        const without = expectDSet(
          evalTerm(term.without, input, root, registry, bindings),
          "difference"
        );
        return dsetResult(fork(of.set, (d) => !without.set.has(d.id)));
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
        return { sort: "view", view: resolveView(term.schema, of.hview) };
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
        case "intersect":
          walk(t.left);
          walk(t.right);
          return;
        case "difference":
          walk(t.of);
          walk(t.without);
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
  function parsePolicy(raw) {
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
        then: parsePolicy(a["then"])
      };
    }
    throw new Error("propPolicy must be pick | all | merge | conflicts | absentAs");
  }
  function parseSchema(raw) {
    const o = asObject(raw, "schema");
    const props = /* @__PURE__ */ new Map();
    if (o["props"] !== void 0) {
      for (const [k, v] of Object.entries(asObject(o["props"], "policy.props"))) {
        props.set(nfc(k), parsePolicy(v));
      }
    }
    const name = typeof o["name"] === "string" ? nfc(o["name"]) : void 0;
    const alg = typeof o["alg"] === "number" ? o["alg"] : void 0;
    return {
      props,
      default: parsePolicy(o["default"]),
      ...name !== void 0 ? { name } : {},
      ...alg !== void 0 ? { alg } : {}
    };
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
      case "intersect":
        return { kind: "intersect", left: parseTerm(o["left"]), right: parseTerm(o["right"]) };
      case "difference":
        return { kind: "difference", of: parseTerm(o["of"]), without: parseTerm(o["without"]) };
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
        return { kind: "resolve", schema: parseSchema(o["schema"]), of: parseTerm(o["in"]) };
      case "prune": {
        const keep = o["keep"] === "all" ? "all" : parseStrMatch(o["keep"], "prune.keep");
        return { kind: "prune", keep, of: parseTerm(o["in"]) };
      }
      default:
        throw new Error(`unknown term op ${String(o["op"])}`);
    }
  }

  // src/schema-deltas.ts
  var ROLE_DEFINES = `${VOCAB_PREFIX}.hyperschema.defines`;
  var ROLE_NAME = `${VOCAB_PREFIX}.hyperschema.name`;
  var ROLE_ALG = `${VOCAB_PREFIX}.hyperschema.alg`;
  var ROLE_TERM = `${VOCAB_PREFIX}.hyperschema.term`;
  var HYPER_SCHEMA_SCHEMA = {
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
        in: { op: "mask", policy: "drop", in: "input" }
      }
    })
  };
  var SCHEMA_DEFINES = `${VOCAB_PREFIX}.schema.defines`;
  var SCHEMA_NAME = `${VOCAB_PREFIX}.schema.name`;
  var SCHEMA_ALG = `${VOCAB_PREFIX}.schema.alg`;
  var SCHEMA_TERM = `${VOCAB_PREFIX}.schema.term`;
  var SCHEMA_SCHEMA = {
    name: `${VOCAB_PREFIX}.SchemaSchema`,
    alg: 1,
    body: HYPER_SCHEMA_SCHEMA.body
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
    constructor(Point2, bits) {
      this.BASE = Point2.BASE;
      this.ZERO = Point2.ZERO;
      this.Fn = Point2.Fn;
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
      if (!(other instanceof Point2))
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
    class Point2 {
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
        if (p instanceof Point2)
          throw new Error("extended point not allowed");
        const { x, y } = p || {};
        acoord("x", x);
        acoord("y", y);
        return new Point2(x, y, _1n4, modP(x * y));
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
        return Point2.fromAffine({ x, y });
      }
      static fromHex(bytes, zip215 = false) {
        return Point2.fromBytes(ensureBytes("point", bytes), zip215);
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
        return this.equals(Point2.ZERO);
      }
      negate() {
        return new Point2(modP(-this.X), this.Y, this.Z, modP(-this.T));
      }
      // Fast algo for doubling Extended Point.
      // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
      // Cost: 4M + 4S + 1*a + 6add + 1*2.
      double() {
        const { a } = CURVE;
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const A = modP(X1 * X1);
        const B = modP(Y1 * Y1);
        const C = modP(_2n2 * modP(Z1 * Z1));
        const D = modP(a * A);
        const x1y1 = X1 + Y1;
        const E = modP(modP(x1y1 * x1y1) - A - B);
        const G = D + B;
        const F = G - C;
        const H = D - B;
        const X3 = modP(E * F);
        const Y3 = modP(G * H);
        const T3 = modP(E * H);
        const Z3 = modP(F * G);
        return new Point2(X3, Y3, Z3, T3);
      }
      // Fast algo for adding 2 Extended Points.
      // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
      // Cost: 9M + 1*a + 1*d + 7add.
      add(other) {
        aextpoint(other);
        const { a, d } = CURVE;
        const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
        const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
        const A = modP(X1 * X2);
        const B = modP(Y1 * Y2);
        const C = modP(T1 * d * T2);
        const D = modP(Z1 * Z2);
        const E = modP((X1 + Y1) * (X2 + Y2) - A - B);
        const F = D - C;
        const G = D + C;
        const H = modP(B - a * A);
        const X3 = modP(E * F);
        const Y3 = modP(G * H);
        const T3 = modP(E * H);
        const Z3 = modP(F * G);
        return new Point2(X3, Y3, Z3, T3);
      }
      subtract(other) {
        return this.add(other.negate());
      }
      // Constant-time multiplication.
      multiply(scalar) {
        if (!Fn2.isValidNot0(scalar))
          throw new Error("invalid scalar: expected 1 <= sc < curve.n");
        const { p, f } = wnaf.cached(this, scalar, (p2) => normalizeZ(Point2, p2));
        return normalizeZ(Point2, [p, f])[0];
      }
      // Non-constant-time multiplication. Uses double-and-add algorithm.
      // It's faster, but should only be used when you don't care about
      // an exposed private key e.g. sig verification.
      // Does NOT allow scalars higher than CURVE.n.
      // Accepts optional accumulator to merge with multiply (important for sparse scalars)
      multiplyUnsafe(scalar, acc = Point2.ZERO) {
        if (!Fn2.isValid(scalar))
          throw new Error("invalid scalar: expected 0 <= sc < curve.n");
        if (scalar === _0n4)
          return Point2.ZERO;
        if (this.is0() || scalar === _1n4)
          return this;
        return wnaf.unsafe(this, scalar, (p) => normalizeZ(Point2, p), acc);
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
        return normalizeZ(Point2, points);
      }
      static msm(points, scalars) {
        return pippenger(Point2, Fn2, points, scalars);
      }
      _setWindowSize(windowSize) {
        this.precompute(windowSize);
      }
      toRawBytes() {
        return this.toBytes();
      }
    }
    Point2.BASE = new Point2(CURVE.Gx, CURVE.Gy, _1n4, modP(CURVE.Gx * CURVE.Gy));
    Point2.ZERO = new Point2(_0n4, _1n4, _1n4, _0n4);
    Point2.Fp = Fp2;
    Point2.Fn = Fn2;
    const wnaf = new wNAF(Point2, Fn2.BITS);
    Point2.BASE.precompute(8);
    return Point2;
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
  function eddsa(Point2, cHash, eddsaOpts = {}) {
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
    const { BASE, Fp: Fp2, Fn: Fn2 } = Point2;
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
      let A, R, SB;
      try {
        A = Point2.fromBytes(publicKey, zip215);
        R = Point2.fromBytes(r, zip215);
        SB = BASE.multiplyUnsafe(s);
      } catch (error) {
        return false;
      }
      if (!zip215 && A.isSmallOrder())
        return false;
      const k = hashDomainToScalar(context, R.toBytes(), A.toBytes(), msg);
      const RkA = R.add(A.multiplyUnsafe(k));
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
        return !!Point2.fromBytes(key, zip215);
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
        const { y } = Point2.fromBytes(publicKey);
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
      precompute(windowSize = 8, point = Point2.BASE) {
        return point.precompute(windowSize, false);
      }
    };
    return Object.freeze({
      keygen,
      getPublicKey,
      sign,
      verify,
      utils,
      Point: Point2,
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
    const Point2 = eddsa2.Point;
    const legacy = Object.assign({}, eddsa2, {
      ExtendedPoint: Point2,
      CURVE: c,
      nBitLength: Point2.Fn.BITS,
      nByteLength: Point2.Fn.BYTES
    });
    return legacy;
  }
  function twistedEdwards(c) {
    const { CURVE, curveOpts, hash, eddsaOpts } = _eddsa_legacy_opts_to_new(c);
    const Point2 = edwards(CURVE, curveOpts);
    const EDDSA = eddsa(Point2, hash, eddsaOpts);
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
  var Point = ed25519.ExtendedPoint;
  var L = ed25519.CURVE.n;
  function bytesToNumberLE2(bytes) {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) n = n << 8n | BigInt(bytes[i]);
    return n;
  }
  function verifySigStrict(sig, msg, pub) {
    if (sig.length !== 64 || pub.length !== 32) return false;
    const rBytes = sig.subarray(0, 32);
    const s = bytesToNumberLE2(sig.subarray(32));
    if (s >= L) return false;
    let A;
    let R;
    try {
      A = Point.fromHex(pub, false);
      R = Point.fromHex(rBytes, false);
    } catch {
      return false;
    }
    if (A.isSmallOrder() || R.isSmallOrder()) return false;
    const k = bytesToNumberLE2(sha512(concatBytes(rBytes, pub, msg))) % L;
    const lhs = Point.BASE.multiplyUnsafe(s);
    const rhs = R.add(A.multiplyUnsafe(k));
    return lhs.equals(rhs);
  }
  function verifyDelta(delta) {
    if (computeId(delta.claims) !== delta.id) return "invalid";
    if (delta.sig === void 0) return "unsigned";
    if (!delta.claims.author.startsWith(AUTHOR_PREFIX)) return "invalid";
    const pubHex = delta.claims.author.slice(AUTHOR_PREFIX.length);
    try {
      return verifySigStrict(hexToBytes(delta.sig), hexToBytes(delta.id), hexToBytes(pubHex)) ? "verified" : "invalid";
    } catch {
      return "invalid";
    }
  }

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
          case "bytes":
            break;
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

  // demo/playground/playground.ts
  var peers = {
    Alice: new Peer("a1".repeat(32)),
    Bob: new Peer("b2".repeat(32)),
    Carol: new Peer("c3".repeat(32))
  };
  var clock = 0;
  var tick = () => ++clock;
  peers["Alice"].authorClaims(seedClaim("movie:blade_runner", "title", "Blade Runner"));
  peers["Alice"].authorClaims(seedClaim("movie:blade_runner", "director", "Ridley Scott"));
  peers["Bob"].authorClaims(seedClaim("movie:blade_runner", "director", "Denis Villeneuve"));
  peers["Bob"].authorClaims(seedClaim("movie:blade_runner", "year", 1982));
  peers["Carol"].authorClaims(seedClaim("movie:blade_runner", "rating", 9));
  function seedClaim(entity, context, value) {
    return {
      timestamp: tick(),
      pointers: [
        { role: "movie", target: { kind: "entity", entity: { id: entity, context } } },
        { role: context, target: { kind: "primitive", value } }
      ]
    };
  }
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
  function schemaFor(kind) {
    switch (kind) {
      case "trust-alice":
        return parseSchema({
          default: { pick: { order: { byAuthorRank: [peers["Alice"].author] } } }
        });
      case "trust-bob":
        return parseSchema({
          default: { pick: { order: { byAuthorRank: [peers["Bob"].author] } } }
        });
      case "conflicts":
        return parseSchema({
          props: { director: { conflicts: { order: { byTimestamp: "desc" } } } },
          default: { pick: { order: { byTimestamp: "desc" } } }
        });
      case "all":
        return parseSchema({ default: { all: { order: { byTimestamp: "asc" } } } });
      default:
        return parseSchema({ default: { pick: { order: { byTimestamp: "desc" } } } });
    }
  }
  function hviewAt(peer, root, asOf, audit) {
    const result = peer.reactor.eval(bodyTerm(asOf, audit), root);
    if (result.sort !== "hview") throw new Error("expected hview");
    return result.hview;
  }
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
  function whoIs(author) {
    for (const [name, p] of Object.entries(peers)) if (p.author === author) return name;
    return `${author.slice(8, 16)}\u2026`;
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
  function renderPeers() {
    for (const [name, peer] of Object.entries(peers)) {
      const card = $(`peer-${name}`);
      card.replaceChildren();
      card.append(
        el("h2", {}, name),
        el(
          "div",
          { class: "meta" },
          `${peer.reactor.size} deltas \xB7 digest ${peer.reactor.digest().slice(4, 12)}\u2026`
        )
      );
      const list = el("div", { class: "claims" });
      for (const d of peer.reactor.arrivalLog()) {
        if (d.claims.author !== peer.author) continue;
        if (d.claims.pointers.some((p) => p.role === "negates")) continue;
        const alreadyRetracted = peer.reactor.negationsOf(d.id).length > 0;
        const subject = d.claims.pointers.find((p) => p.target.kind === "entity");
        const ctx2 = subject?.target.kind === "entity" ? subject.target.entity.context ?? "?" : "?";
        const row = el(
          "div",
          { class: `claim${alreadyRetracted ? " retracted" : ""}` },
          `t=${d.claims.timestamp} ${ctx2} = ${valueOf(d.claims)} `
        );
        if (!alreadyRetracted) {
          const btn = el("button", { class: "small" }, "retract");
          btn.onclick = () => {
            const neg = makeNegationClaims(peer.author, tick(), d.id, "retracted in playground");
            peer.authorClaims({ timestamp: neg.timestamp, pointers: [...neg.pointers] });
            refresh();
          };
          row.append(btn);
        }
        list.append(row);
      }
      card.append(list);
      const entity = el("input", { value: "movie:blade_runner", title: "entity" });
      const ctx = el("input", { placeholder: "property (context)", title: "context" });
      const val = el("input", { placeholder: "value", title: "value" });
      const add2 = el("button", {}, "claim");
      add2.onclick = () => {
        if (!ctx.value || !val.value) return;
        const num = Number(val.value);
        const value = Number.isFinite(num) && val.value.trim() !== "" ? num : val.value;
        peer.authorClaims(seedClaim(entity.value, ctx.value, value));
        ctx.value = "";
        val.value = "";
        refresh();
      };
      card.append(el("div", { class: "form" }, entity, ctx, val, add2));
      const syncRow = el("div", { class: "sync" }, "sync \u21C4 ");
      for (const other of Object.keys(peers)) {
        if (other === name) continue;
        const btn = el("button", { class: "small" }, other);
        btn.onclick = () => {
          peer.pullFrom(peers[other]);
          peers[other].pullFrom(peer);
          refresh();
        };
        syncRow.append(btn);
      }
      card.append(syncRow);
    }
  }
  function renderView() {
    const root = $("root").value;
    const viewer = $("viewer").value;
    const schemaKind = $("schema").value;
    const audit = $("audit").checked;
    const asOfRaw = $("asof").value;
    const asOf = Number(asOfRaw) >= clock ? void 0 : Number(asOfRaw);
    $("asof").max = String(clock);
    $("asof-label").textContent = asOf === void 0 ? "now" : `t\u2264${asOf}`;
    const peer = peers[viewer];
    const hview = hviewAt(peer, root, asOf, audit);
    if (audit) {
      const lines = [];
      for (const [prop, entries] of [...hview.props.entries()].sort()) {
        for (const e of entries) {
          lines.push(
            `${e.negated ? "\u2717" : "\u2713"} ${prop} = ${valueOf(e.delta.claims)}  \u2014 ${whoIs(e.delta.claims.author)} @ t=${e.delta.claims.timestamp}${e.negated ? "  [retracted]" : ""}`
          );
        }
      }
      $("view-output").textContent = lines.join("\n") || "(nothing here yet)";
    } else {
      const resolved = resolveView(schemaFor(schemaKind), hview);
      $("view-output").textContent = JSON.stringify(resolved, null, 2);
    }
    const plainView = hviewAt(peer, root, asOf, true);
    const prov = [];
    for (const [prop, entries] of [...plainView.props.entries()].sort()) {
      for (const e of entries) {
        prov.push(
          `${prop}: ${e.delta.id.slice(4, 14)}\u2026 by ${whoIs(e.delta.claims.author)} t=${e.delta.claims.timestamp}${e.negated ? " [retracted]" : ""}`
        );
      }
    }
    $("provenance").textContent = prov.join("\n") || "(no contributing deltas)";
  }
  function refresh() {
    renderPeers();
    renderView();
  }
  for (const id of ["root", "viewer", "schema", "audit", "asof"]) {
    $(id).addEventListener("input", renderView);
  }
  refresh();
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
