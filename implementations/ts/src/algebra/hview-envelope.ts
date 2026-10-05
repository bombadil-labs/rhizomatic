// SPEC-16 MR-04..07: lossless evidence, independent of existing HView evaluation identity.
import {
  type CborValue,
  decode,
  array,
  bool,
  bstr,
  encode,
  float,
  map,
  tstr,
} from "../delta/cbor.js";
import { canonicalBytes } from "../delta/delta.js";
import { bytesToHex, contentAddress } from "../delta/hash.js";
import { parseClaims } from "../delta/json-profile.js";
import { verifyCanonicalDelta } from "../delta/sign.js";
import type { Delta } from "../delta/types.js";
import { cborToJson } from "../syntax/term-io.js";
import { decodeReadingAppearance, encodeReadingAppearance } from "../syntax/reading-appearance.js";
import {
  canonicalEvidence,
  codecBoundary,
  codecBytes,
  codecLimit,
  codecLimits,
  codecMap,
  codecText,
  codecTextSize,
  DEFAULT_READING_APPEARANCE_LIMITS,
  EvidenceCodecError,
  type ReadingAppearanceLimits,
} from "../syntax/evidence-codec.js";
import type { HView, HVEntry } from "./hview.js";

export interface HViewEnvelopeLimits extends ReadingAppearanceLimits {
  readonly appearances: number;
  readonly entries: number;
  readonly nodes: number;
  readonly depth: number;
  readonly pointers: number;
  readonly buckets: number;
  readonly readings: number;
}
export const DEFAULT_HVIEW_ENVELOPE_LIMITS: HViewEnvelopeLimits = Object.freeze({
  ...DEFAULT_READING_APPEARANCE_LIMITS,
  appearances: 4096,
  entries: 16384,
  nodes: 4096,
  depth: 32,
  pointers: 256,
  buckets: 256,
  readings: 256,
});
const invalid = (): never => {
  throw new EvidenceCodecError("invalid-evidence");
};
const id = (value: string): string => (/^1e20[0-9a-f]{64}$/.test(value) ? value : invalid());
const fromHex = (hex: string): Uint8Array => {
  if (!/^(?:[a-f0-9]{2})*$/.test(hex)) return invalid();
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
};
const readingLimits = (limits: HViewEnvelopeLimits): ReadingAppearanceLimits => ({
  artifactBytes: limits.artifactBytes,
  syntaxDepth: limits.syntaxDepth,
  syntaxNodes: limits.syntaxNodes,
});
function asArray(value: CborValue | undefined): readonly CborValue[] {
  if (value?.t !== "array") return invalid();
  return value.v;
}
function index(value: CborValue | undefined): number {
  if (value?.t !== "float" || !Number.isSafeInteger(value.v) || value.v < 0) return invalid();
  return value.v;
}
function original(delta: Delta, limits: HViewEnvelopeLimits, verified: Set<string>): Uint8Array {
  codecLimit(delta.claims.pointers.length, limits.pointers);
  let minimum = codecTextSize(delta.claims.author, limits.artifactBytes);
  const text = (s: string): void => {
    codecLimit((minimum += codecTextSize(s, limits.artifactBytes)), limits.artifactBytes);
  };
  for (const p of delta.claims.pointers) {
    codecLimit(++minimum, limits.artifactBytes);
    text(p.role);
    switch (p.target.kind) {
      case "primitive":
        if (typeof p.target.value === "string") text(p.target.value);
        break;
      case "entity":
        text(p.target.entity.id);
        if (p.target.entity.context !== undefined) text(p.target.entity.context);
        break;
      case "delta":
        text(p.target.deltaRef.delta);
        if (p.target.deltaRef.context !== undefined) text(p.target.deltaRef.context);
        break;
      case "bytes":
        text(p.target.mime);
        codecLimit((minimum += p.target.value.length), limits.artifactBytes);
        break;
    }
  }
  const claims = canonicalBytes(delta.claims);
  codecLimit(claims.length, limits.artifactBytes);
  const deltaId = id(delta.id),
    sig = delta.sig;
  if (deltaId !== contentAddress(claims)) return invalid();
  const fields: [string, CborValue][] = [
    ["id", tstr(deltaId)],
    ["claims", bstr(claims)],
  ];
  if (sig !== undefined) {
    if (!/^[0-9a-f]{128}$/.test(sig)) return invalid();
    fields.push(["sig", bstr(fromHex(sig))]);
  }
  const bytes = encode(map(fields));
  if (sig !== undefined) {
    const key = contentAddress(bytes);
    if (!verified.has(key)) {
      // Verify the captured bytes, not fields reread from a mutable native object.
      const captured = { id: deltaId, claims: parseClaims(cborToJson(decode(claims))), sig };
      if (verifyCanonicalDelta(captured) !== "verified") return invalid();
      verified.add(key); // Only successful checks of these exact full appearance bytes.
    }
  }
  return bytes;
}
function deltaFromBytes(
  bytes: Uint8Array,
  limits: HViewEnvelopeLimits,
  verified: Set<string>,
): Delta {
  const fields = codecMap(canonicalEvidence(bytes, limits.artifactBytes), ["id", "claims", "sig"]);
  const claimsBytes = codecBytes(fields.get("claims"));
  const raw = canonicalEvidence(claimsBytes, limits.artifactBytes, (path, kind, length) => {
    if (path.length === 1 && path[0] === "pointers" && kind === "array")
      codecLimit(length, limits.pointers);
  });
  const claims = parseClaims(cborToJson(raw));
  const sig = fields.has("sig") ? bytesToHex(codecBytes(fields.get("sig"))) : undefined;
  const delta = {
    id: id(codecText(fields.get("id"))),
    claims,
    ...(sig === undefined ? {} : { sig }),
  };
  if (bytesToHex(original(delta, limits, verified)) !== bytesToHex(bytes)) return invalid();
  return delta;
}
function validSlot(entry: HVEntry, slot: number, limits: HViewEnvelopeLimits): void {
  codecLimit(entry.delta.claims.pointers.length, limits.pointers);
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    entry.delta.claims.pointers[slot]?.target.kind !== "entity"
  )
    invalid();
}
export function encodeHViewEnvelope(
  view: HView,
  requested: Partial<HViewEnvelopeLimits> = {},
): Uint8Array {
  return encodeEnvelope(view, requested, new Set());
}

// Private invocation-local cache; never keyed by a Delta ID or native object identity.
function encodeEnvelope(
  view: HView,
  requested: Partial<HViewEnvelopeLimits>,
  verified: Set<string>,
): Uint8Array {
  return codecBoundary(() => {
    const limits = codecLimits(DEFAULT_HVIEW_ENVELOPE_LIMITS, requested);
    const appearances = new Map<string, Uint8Array>();
    const readings = new Map<string, Uint8Array>();
    const path = new Set<HView>();
    let nodes = 0,
      entries = 0;
    let byteMinimum = 0;
    const addBytes = (n: number): void => codecLimit((byteMinimum += n), limits.artifactBytes);
    function table(values: Map<string, Uint8Array>, bytes: Uint8Array, maximum: number): string {
      const key = contentAddress(bytes);
      if (!values.has(key)) {
        codecLimit(values.size + 1, maximum);
        addBytes(bytes.length);
        values.set(key, bytes);
      }
      return key;
    }
    function node(value: HView, depth: number): CborValue {
      if (path.has(value)) return invalid();
      codecLimit(depth, limits.depth);
      codecLimit(++nodes, limits.nodes);
      codecLimit(value.props.size, limits.buckets);
      if (typeof value.id !== "string") return invalid();
      addBytes(codecTextSize(value.id, limits.artifactBytes));
      path.add(value);
      const props: [string, CborValue][] = [];
      for (const [key, bucket] of value.props) {
        addBytes(codecTextSize(key, limits.artifactBytes));
        codecLimit((entries += bucket.length), limits.entries);
        const items = bucket.map((entry) => {
          if (typeof entry.negated !== "boolean") return invalid();
          const appearance = table(
            appearances,
            original(entry.delta, limits, verified),
            limits.appearances,
          );
          const expanded: CborValue[] = [],
            childReadings: CborValue[] = [];
          for (const [slot, child] of [...(entry.expanded ?? [])].sort(([a], [b]) => a - b)) {
            validSlot(entry, slot, limits);
            expanded.push(
              map([
                ["index", float(slot)],
                ["child", node(child, depth + 1)],
              ]),
            );
          }
          for (const [slot, reading] of [...(entry.readings ?? [])].sort(([a], [b]) => a - b)) {
            validSlot(entry, slot, limits);
            if (!entry.expanded?.has(slot)) return invalid();
            const key = table(
              readings,
              encodeReadingAppearance(reading, readingLimits(limits)),
              limits.readings,
            );
            childReadings.push(
              map([
                ["index", float(slot)],
                ["reading", tstr(key)],
              ]),
            );
          }
          return map([
            ["appearance", tstr(appearance)],
            ["negated", bool(entry.negated)],
            ["expanded", array(expanded)],
            ["readings", array(childReadings)],
          ]);
        });
        props.push([key, array(items)]);
      }
      path.delete(value);
      return map([
        ["id", tstr(value.id)],
        ["props", map(props)],
      ]);
    }
    const root = node(view, 1);
    const records = (values: Map<string, Uint8Array>): CborValue =>
      array(
        [...values]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) =>
            map([
              ["key", tstr(key)],
              ["value", bstr(value)],
            ]),
          ),
      );
    const bytes = encode(
      map([
        ["format", tstr("rhizomatic.hview-envelope/1")],
        ["appearances", records(appearances)],
        ["readings", records(readings)],
        ["root", root],
      ]),
    );
    codecLimit(bytes.length, limits.artifactBytes);
    return bytes;
  });
}

export function decodeHViewEnvelope(
  bytes: Uint8Array,
  requested: Partial<HViewEnvelopeLimits> = {},
): HView {
  return codecBoundary(() => {
    const limits = codecLimits(DEFAULT_HVIEW_ENVELOPE_LIMITS, requested);
    let nodeCount = 0,
      entryCount = 0;
    const raw = canonicalEvidence(bytes, limits.artifactBytes, (path, kind, length) => {
      if (path.length === 1 && kind === "array") {
        if (path[0] === "appearances") codecLimit(length, limits.appearances);
        if (path[0] === "readings") codecLimit(length, limits.readings);
      }
      const childNode =
        path.at(-1) === "child" && typeof path.at(-2) === "number" && path.at(-3) === "expanded";
      if (kind === "map" && ((path.length === 1 && path[0] === "root") || childNode)) {
        codecLimit(++nodeCount, limits.nodes);
        let depth = 1;
        for (let i = 0; i < path.length; i++)
          if (path[i] === "expanded" && typeof path[i + 1] === "number" && path[i + 2] === "child")
            depth++;
        codecLimit(depth, limits.depth);
      }
      if (kind === "map" && path.at(-1) === "props") codecLimit(length, limits.buckets);
      if (kind === "array" && path.at(-2) === "props")
        codecLimit((entryCount += length), limits.entries);
    });
    const envelope = codecMap(raw, ["format", "appearances", "readings", "root"]);
    if (codecText(envelope.get("format")) !== "rhizomatic.hview-envelope/1") return invalid();
    function table<T>(
      value: CborValue | undefined,
      parse: (bytes: Uint8Array) => T,
    ): Map<string, T> {
      const result = new Map<string, T>();
      let prior = "";
      for (const record of asArray(value)) {
        const fields = codecMap(record, ["key", "value"]);
        const key = id(codecText(fields.get("key"))),
          payload = codecBytes(fields.get("value"));
        if (key <= prior || key !== contentAddress(payload)) return invalid();
        prior = key;
        result.set(key, parse(payload));
      }
      return result;
    }
    const verified = new Set<string>();
    const appearances = table(envelope.get("appearances"), (value) =>
      deltaFromBytes(value, limits, verified),
    );
    const readings = table(envelope.get("readings"), (value) =>
      decodeReadingAppearance(value, readingLimits(limits)),
    );
    const usedAppearances = new Set<string>(),
      usedReadings = new Set<string>();
    function slots<T>(
      value: CborValue | undefined,
      key: string,
      parse: (value: CborValue) => T,
    ): Map<number, T> {
      const result = new Map<number, T>();
      let prior = -1;
      for (const item of asArray(value)) {
        const fields = codecMap(item, ["index", key]);
        const slot = index(fields.get("index"));
        if (slot <= prior) return invalid();
        prior = slot;
        const data = fields.get(key);
        if (data === undefined) return invalid();
        result.set(slot, parse(data));
      }
      return result;
    }
    function node(value: CborValue): HView {
      const fields = codecMap(value, ["id", "props"]),
        props = new Map<string, HVEntry[]>();
      const buckets = fields.get("props");
      if (buckets === undefined) return invalid();
      for (const [key, bucket] of codecMap(buckets)) {
        const entries = asArray(bucket).map((value) => {
          const entry = codecMap(value, ["appearance", "negated", "expanded", "readings"]);
          const key = id(codecText(entry.get("appearance"))),
            delta = appearances.get(key);
          if (delta === undefined) return invalid();
          usedAppearances.add(key);
          const negated = entry.get("negated");
          if (negated?.t !== "bool") return invalid();
          const expanded = slots(entry.get("expanded"), "child", node);
          const childReadings = slots(entry.get("readings"), "reading", (value) => {
            const key = id(codecText(value)),
              reading = readings.get(key);
            if (reading === undefined) return invalid();
            usedReadings.add(key);
            return reading;
          });
          const result: HVEntry = { delta, negated: negated.v, expanded, readings: childReadings };
          for (const slot of expanded.keys()) validSlot(result, slot, limits);
          for (const slot of childReadings.keys()) {
            validSlot(result, slot, limits);
            if (!expanded.has(slot)) return invalid();
          }
          return result;
        });
        props.set(key, entries);
      }
      return { id: codecText(fields.get("id")), props };
    }
    const root = envelope.get("root");
    if (root === undefined) return invalid();
    const result = node(root);
    if (usedAppearances.size !== appearances.size || usedReadings.size !== readings.size)
      return invalid();
    if (bytesToHex(encodeEnvelope(result, limits, verified)) !== bytesToHex(bytes))
      return invalid();
    return result;
  });
}
