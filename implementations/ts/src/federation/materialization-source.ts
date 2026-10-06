// SPEC-16 MR-09/10: represented source testimony, separate from native host grants.
import { array, bstr, decodeWithGuard, encode, map, tstr, type CborValue } from "../delta/cbor.js";
import { canonicalBytes } from "../delta/delta.js";
import { contentAddress, bytesToHex } from "../delta/hash.js";
import { parseClaims } from "../delta/json-profile.js";
import { verifyCanonicalDelta } from "../delta/sign.js";
import { DeltaSet } from "../delta/set.js";
import type { Delta } from "../delta/types.js";
import { cborToJson } from "../syntax/term-io.js";

export class MaterializationSourceError extends Error {
  constructor(readonly code: "invalid-source" | "resource-limit") {
    super(code);
  }
}
export interface MaterializationSourceLimits {
  readonly artifactBytes: number;
  readonly appearances: number;
  readonly pointers: number;
  readonly components: number;
  readonly inventoryIds: number;
}
export const DEFAULT_MATERIALIZATION_SOURCE_LIMITS: MaterializationSourceLimits = Object.freeze({
  artifactBytes: 16777216,
  appearances: 4096,
  pointers: 256,
  components: 64,
  inventoryIds: 16384,
});
export type MaterializationSourceFailure = "unauthorized" | "source-changed" | "source-unavailable";
/** Native capability: serialized testimony never installs or substitutes this grant. */
export interface MaterializationSourceCapability {
  capture(
    bindingId: string,
    servingAt: number,
    cutoff?: number,
  ): Promise<
    | { status: "captured"; capture: Delta; authority: Delta; snapshot: Delta }
    | { status: MaterializationSourceFailure }
  >;
  checkCurrent(
    bindingId: string,
    revision: string,
    authority: string,
    servingAt: number,
    cutoff: number | undefined,
    requiredSupport: readonly string[],
  ): Promise<{ status: "current" } | { status: MaterializationSourceFailure }>;
  reacquireSnapshot(
    bindingId: string,
    exactCaptureDelta: Delta,
    servingAt: number,
  ): Promise<
    { status: "available"; snapshotBytes: Uint8Array } | { status: MaterializationSourceFailure }
  >;
}
export interface MaterializationBindingSpec {
  readonly sourceId: string;
  readonly capturer: string;
  readonly authorityRoot: string;
  readonly selection: CborValue;
}
export interface MaterializationSourceSnapshot {
  readonly value: CborValue;
  readonly binding: string;
  readonly authority: string;
  readonly selection: string;
  readonly revision: string;
  readonly membership: string;
  readonly appearanceDigest: string;
  readonly servingAt: number;
  readonly historicalCutoff?: number;
  readonly components: readonly CborValue[];
  readonly deltas: readonly Delta[];
}
const invalid = (): never => {
  throw new MaterializationSourceError("invalid-source");
};
function checkedLimits(limits: MaterializationSourceLimits): void {
  for (const [key, maximum] of Object.entries(DEFAULT_MATERIALIZATION_SOURCE_LIMITS)) {
    const value = limits[key as keyof MaterializationSourceLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
  }
}
const limit = (n: number, max: number): void => {
  if (n > max) throw new MaterializationSourceError("resource-limit");
};
const id = (s: string): string => (/^1e20[0-9a-f]{64}$/.test(s) ? s : invalid());
const peer = (s: string): string => (/^ed25519:[0-9a-f]{64}$/.test(s) ? s : invalid());
function fields(
  v: CborValue,
  required: readonly string[],
  optional: readonly string[] = [],
): Map<string, CborValue> {
  if (v.t !== "map") return invalid();
  const f = new Map<string, CborValue>();
  for (const [k, x] of v.v) {
    if (f.has(k) || ![...required, ...optional].includes(k)) invalid();
    f.set(k, x);
  }
  if (required.some((k) => !f.has(k))) invalid();
  return f;
}
const text = (v: CborValue | undefined): string => (v?.t === "tstr" ? v.v : invalid());
const bytes = (v: CborValue | undefined): Uint8Array => (v?.t === "bstr" ? v.v : invalid());
const number = (v: CborValue | undefined): number =>
  v?.t === "float" && Number.isFinite(v.v) ? v.v : invalid();
const list = (v: CborValue | undefined): readonly CborValue[] =>
  v?.t === "array" ? v.v : invalid();
function ordered(xs: readonly string[]): void {
  if (xs.some((x, i) => i > 0 && xs[i - 1]! >= x)) invalid();
}
function ids(v: CborValue | undefined, key: (s: string) => string = id): string[] {
  const xs = list(v).map((x) => key(text(x)));
  ordered(xs);
  return xs;
}
function boundary<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof MaterializationSourceError) throw e;
    return invalid();
  }
}
function canonical(
  bytes: Uint8Array,
  maximum: number,
  guard: Parameters<typeof decodeWithGuard>[1] = () => {},
): CborValue {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16777216) invalid();
  limit(bytes.length, maximum);
  const v = decodeWithGuard(bytes, guard);
  const visit = (x: CborValue): void => {
    if (x.t === "map") {
      const seen = new Set<string>();
      for (const [k, c] of x.v) {
        if (seen.has(k)) invalid();
        seen.add(k);
        visit(c);
      }
    } else if (x.t === "array") x.v.forEach(visit);
  };
  visit(v);
  if (bytesToHex(encode(v)) !== bytesToHex(bytes)) invalid();
  return v;
}
/** Strict canonical full signed appearance; detached signature participates in transport identity. */
export function encodeMaterializationAppearance(
  delta: Delta,
  limits: MaterializationSourceLimits = DEFAULT_MATERIALIZATION_SOURCE_LIMITS,
): Uint8Array {
  return boundary(() => {
    checkedLimits(limits);
    limit(delta.claims.pointers.length, limits.pointers);
    const claims = canonicalBytes(delta.claims);
    limit(claims.length, limits.artifactBytes);
    if (verifyCanonicalDelta(delta) !== "verified" || delta.sig === undefined) invalid();
    const result = encode(
      map([
        ["id", tstr(delta.id)],
        ["claims", bstr(claims)],
        ["sig", bstr(Uint8Array.from(delta.sig!.match(/../g)!, (h) => Number.parseInt(h, 16)))],
      ]),
    );
    limit(result.length, limits.artifactBytes);
    return result;
  });
}
export function decodeMaterializationAppearance(
  input: Uint8Array,
  limits: MaterializationSourceLimits = DEFAULT_MATERIALIZATION_SOURCE_LIMITS,
): Delta {
  return boundary(() => {
    checkedLimits(limits);
    const f = fields(canonical(input, limits.artifactBytes), ["id", "claims", "sig"]);
    const claims = canonical(bytes(f.get("claims")), limits.artifactBytes, (path, kind, length) => {
      if (path.length === 1 && path[0] === "pointers" && kind === "array")
        limit(length, limits.pointers);
    });
    const delta = {
      id: id(text(f.get("id"))),
      claims: parseClaims(cborToJson(claims)),
      sig: bytesToHex(bytes(f.get("sig"))),
    };
    if (bytesToHex(encodeMaterializationAppearance(delta, limits)) !== bytesToHex(input)) invalid();
    return delta;
  });
}
export function decodeMaterializationBindingSpec(
  input: Uint8Array,
  maximum = 16777216,
): MaterializationBindingSpec {
  return boundary(() => {
    const f = fields(canonical(input, maximum), [
      "sourceId",
      "capturer",
      "authorityRoot",
      "selection",
    ]);
    const selection = f.get("selection")!;
    const s = fields(selection, ["profile", "parameters"]);
    if (!text(f.get("sourceId")) || text(s.get("profile")) !== "host-authorized-snapshot/1")
      invalid();
    if (canonical(bytes(s.get("parameters")), maximum).t !== "map") invalid();
    return {
      sourceId: text(f.get("sourceId")),
      capturer: peer(text(f.get("capturer"))),
      authorityRoot: id(text(f.get("authorityRoot"))),
      selection,
    };
  });
}
export function decodeMaterializationAuthoritySpec(
  input: Uint8Array,
  maximum = 16777216,
): { root: string; epoch: number; context: Uint8Array } {
  return boundary(() => {
    const f = fields(canonical(input, maximum), ["root", "epoch", "context"]);
    const epoch = number(f.get("epoch")),
      context = bytes(f.get("context"));
    if (!Number.isSafeInteger(epoch) || epoch < 0 || canonical(context, maximum).t !== "map")
      invalid();
    return { root: id(text(f.get("root"))), epoch, context };
  });
}
const SNAPSHOT_FIELDS = [
  "format",
  "binding",
  "authority",
  "selection",
  "revision",
  "servingAt",
  "components",
  "appearances",
  "operands",
  "exclusions",
  "membership",
  "appearanceDigest",
];
export function decodeMaterializationSnapshot(
  input: Uint8Array,
  limits: MaterializationSourceLimits = DEFAULT_MATERIALIZATION_SOURCE_LIMITS,
): MaterializationSourceSnapshot {
  return boundary(() => {
    checkedLimits(limits);
    const value = canonical(input, limits.artifactBytes, (path, kind, length) => {
      if (kind !== "array") return;
      if (path.length === 1) {
        if (path[0] === "components") limit(length, limits.components);
        if (path[0] === "appearances" || path[0] === "operands") limit(length, limits.appearances);
        if (path[0] === "exclusions") limit(length, limits.inventoryIds);
      }
      if (path.at(-1) === "rawIds" || path.at(-1) === "operandIds")
        limit(length, limits.inventoryIds);
      if (path.at(-1) === "peers") limit(length, limits.components);
    });
    const f = fields(value, SNAPSHOT_FIELDS, ["historicalCutoff"]);
    if (text(f.get("format")) !== "rhizomatic.source-snapshot/1") invalid();
    const getId = (k: string) => id(text(f.get(k)));
    const binding = getId("binding"),
      authority = getId("authority"),
      selection = getId("selection"),
      revision = getId("revision"),
      membership = getId("membership"),
      appearanceDigest = getId("appearanceDigest"),
      servingAt = number(f.get("servingAt"));
    const historicalCutoff = f.has("historicalCutoff")
      ? number(f.get("historicalCutoff"))
      : undefined;
    const components = list(f.get("components"));
    if (!components.length) invalid();
    const raw = new Map<string, Set<string>>(),
      eligible = new Map<string, Set<string>>();
    const componentPeers: string[] = [],
      componentBases: CborValue[] = [];
    for (const c of components) {
      const fs = fields(c, ["peer", "revision", "capturedAt", "rawIds", "operandIds"]);
      const p = peer(text(fs.get("peer")));
      componentPeers.push(p);
      id(text(fs.get("revision")));
      number(fs.get("capturedAt"));
      const raws = ids(fs.get("rawIds")),
        ops = ids(fs.get("operandIds"));
      if (ops.some((x) => !raws.includes(x))) invalid();
      for (const x of raws) {
        if (!raw.has(x)) raw.set(x, new Set());
        raw.get(x)!.add(p);
      }
      for (const x of ops) {
        if (!eligible.has(x)) eligible.set(x, new Set());
        eligible.get(x)!.add(p);
      }
      componentBases.push(map([...fs].filter(([k]) => k !== "capturedAt")));
    }
    ordered(componentPeers);
    limit(raw.size, limits.inventoryIds);
    const table = list(f.get("appearances")),
      tableKeys: string[] = [],
      appearanceBytes = new Map<string, Uint8Array>();
    // Bound all known nested claims pointer counts before verifying any embedded row.
    for (const record of table) {
      const r = fields(record, ["key", "value"]);
      const k = id(text(r.get("key"))),
        b = bytes(r.get("value"));
      tableKeys.push(k);
      if (contentAddress(b) !== k) invalid();
      appearanceBytes.set(k, b);
      limit(b.length, limits.artifactBytes);
      const af = fields(canonical(b, limits.artifactBytes), ["id", "claims", "sig"]);
      canonical(bytes(af.get("claims")), limits.artifactBytes, (path, kind, n) => {
        if (path.length === 1 && path[0] === "pointers" && kind === "array")
          limit(n, limits.pointers);
      });
    }
    ordered(tableKeys);
    const selected = new Map<string, Delta>();
    for (const [k, b] of appearanceBytes)
      selected.set(k, decodeMaterializationAppearance(b, limits));
    const operandIds: string[] = [],
      used = new Set<string>(),
      deltas: Delta[] = [];
    for (const o of list(f.get("operands"))) {
      const of = fields(o, ["id", "appearance", "peers"]),
        i = id(text(of.get("id"))),
        a = id(text(of.get("appearance"))),
        ps = ids(of.get("peers"), peer),
        d = selected.get(a);
      if (
        !d ||
        d.id !== i ||
        !ps.length ||
        ps.join() !== [...(eligible.get(i) ?? [])].sort().join()
      )
        invalid();
      operandIds.push(i);
      used.add(a);
      deltas.push(d!);
    }
    ordered(operandIds);
    if (used.size !== tableKeys.length || eligible.size !== operandIds.length) invalid();
    const exclusionIds: string[] = [];
    for (const e of list(f.get("exclusions"))) {
      const ef = fields(e, ["id", "peers", "reason"]),
        i = id(text(ef.get("id"))),
        ps = ids(ef.get("peers"), peer);
      if (
        !text(ef.get("reason")) ||
        eligible.has(i) ||
        !ps.length ||
        ps.join() !== [...(raw.get(i) ?? [])].sort().join()
      )
        invalid();
      exclusionIds.push(i);
    }
    ordered(exclusionIds);
    if (raw.size !== operandIds.length + exclusionIds.length) invalid();
    if (
      DeltaSet.from(deltas).digest() !== membership ||
      contentAddress(encode(array(tableKeys.map(tstr)))) !== appearanceDigest
    )
      invalid();
    const expected = contentAddress(
      encode(
        map([
          ["binding", tstr(binding)],
          ["authority", tstr(authority)],
          ["selection", tstr(selection)],
          ["components", array(componentBases)],
          ["membership", tstr(membership)],
          ["appearanceDigest", tstr(appearanceDigest)],
          ["exclusions", f.get("exclusions")!],
        ]),
      ),
    );
    if (revision !== expected) invalid();
    return {
      value,
      binding,
      authority,
      selection,
      revision,
      membership,
      appearanceDigest,
      servingAt,
      ...(historicalCutoff === undefined ? {} : { historicalCutoff }),
      components,
      deltas,
    };
  });
}
/** Metadata-only capture commitment: no operand appearance bytes. */
export function materializationCaptureBasis(
  snapshotBytes: Uint8Array,
  limits: MaterializationSourceLimits = DEFAULT_MATERIALIZATION_SOURCE_LIMITS,
): Uint8Array {
  const snapshot = decodeMaterializationSnapshot(snapshotBytes, limits);
  if (snapshot.value.t !== "map") return invalid();
  const result = encode(
    map([
      ...snapshot.value.v.filter(([k]) => k !== "appearances" && k !== "format"),
      ["format", tstr("rhizomatic.source-basis/1")],
      ["snapshot", tstr(contentAddress(snapshotBytes))],
    ]),
  );
  limit(result.length, limits.artifactBytes);
  return result;
}
export function validateMaterializationCaptureBasis(
  basisBytes: Uint8Array,
  snapshotBytes: Uint8Array,
  limits: MaterializationSourceLimits = DEFAULT_MATERIALIZATION_SOURCE_LIMITS,
): void {
  boundary(() => {
    canonical(basisBytes, limits.artifactBytes);
    if (bytesToHex(materializationCaptureBasis(snapshotBytes, limits)) !== bytesToHex(basisBytes))
      invalid();
  });
}
/** Public commitments reveal no private inventories. */
export function materializationComponentCommitments(
  snapshot: MaterializationSourceSnapshot,
): CborValue {
  return array(
    snapshot.components.map((c) => {
      const fs = fields(c, ["peer", "revision", "capturedAt", "rawIds", "operandIds"]);
      return map(["peer", "revision", "capturedAt"].map((k) => [k, fs.get(k)!]));
    }),
  );
}
