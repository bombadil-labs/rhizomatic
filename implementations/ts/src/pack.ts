// The pack format (SPEC-8, ERRATA-8): a content-addressed physical container whose logical form
// is invariant. Never hash the dehydrated form; rehydration is byte-exact by construction because
// unpacking rebuilds claims through the standard makeDelta path.

import { array, bool, decode, encode, float, map, tstr, type CborValue } from "./cbor.js";
import { contentAddress } from "./hash.js";
import { manifestMemberIds } from "./reactor.js";
import { DeltaSet, makeDelta } from "./set.js";
import type { Claims, Delta, Pointer, Target } from "./types.js";

const PACK_VERSION = 1;

// --- string interning -------------------------------------------------------------------------------

function stringsOf(delta: Delta, out: Set<string>): void {
  out.add(delta.id); // stored ids make rehydration self-verifying (SPEC-8 §4)
  out.add(delta.claims.author);
  if (delta.sig !== undefined) out.add(delta.sig);
  for (const p of delta.claims.pointers) {
    out.add(p.role);
    switch (p.target.kind) {
      case "entity":
        out.add(p.target.entity.id);
        if (p.target.entity.context !== undefined) out.add(p.target.entity.context);
        break;
      case "delta":
        out.add(p.target.deltaRef.delta);
        if (p.target.deltaRef.context !== undefined) out.add(p.target.deltaRef.context);
        break;
      case "primitive":
        if (typeof p.target.value === "string") out.add(p.target.value);
        break;
    }
  }
}

// --- packing ----------------------------------------------------------------------------------------

function ptrToCbor(p: Pointer, idx: (s: string) => number): CborValue {
  const entries: Array<[string, CborValue]> = [["r", float(idx(p.role))]];
  let context: string | undefined;
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
  if (context !== undefined) entries.push(["c", float(idx(context))]);
  return map(entries);
}

function hydratedRecord(d: Delta, idx: (s: string) => number): CborValue {
  const entries: Array<[string, CborValue]> = [
    ["i", float(idx(d.id))],
    ["a", float(idx(d.claims.author))],
    ["t", float(d.claims.timestamp)],
    ["p", array(d.claims.pointers.map((p) => ptrToCbor(p, idx)))],
  ];
  if (d.sig !== undefined) entries.push(["s", float(idx(d.sig))]);
  return map(entries);
}

function memberRecord(
  d: Delta,
  manifest: Delta,
  envelopeIdx: number,
  idx: (s: string) => number,
): CborValue {
  const entries: Array<[string, CborValue]> = [
    ["i", float(idx(d.id))],
    ["m", float(envelopeIdx)],
    ["p", array(d.claims.pointers.map((p) => ptrToCbor(p, idx)))],
  ];
  // Dehydrate against the envelope (SPEC-8 §3.1); divergent fields stored explicitly (P2).
  if (d.claims.author !== manifest.claims.author) entries.push(["a", float(idx(d.claims.author))]);
  const dt = d.claims.timestamp - manifest.claims.timestamp;
  if (dt !== 0) entries.push(["dt", float(dt)]);
  if (d.sig !== undefined) entries.push(["s", float(idx(d.sig))]);
  return map(entries);
}

export function packSet(set: DeltaSet): Uint8Array {
  const deltas = [...set].sort((a, b) => (a.id < b.id ? -1 : 1));
  // Manifests: deltas carrying rdb.txn.member pointers, sorted by id.
  const manifests = deltas.filter((d) => manifestMemberIds(d).length > 0);
  // Each member is dehydrated against the lexicographically FIRST claiming manifest (P1).
  const memberToManifest = new Map<string, number>();
  manifests.forEach((m, i) => {
    for (const id of manifestMemberIds(m)) {
      if (set.has(id) && !memberToManifest.has(id)) memberToManifest.set(id, i);
    }
  });
  const manifestIds = new Set(manifests.map((m) => m.id));
  const members = deltas.filter((d) => memberToManifest.has(d.id) && !manifestIds.has(d.id));
  const loose = deltas.filter((d) => !memberToManifest.has(d.id) && !manifestIds.has(d.id));

  const stringSet = new Set<string>();
  for (const d of deltas) stringsOf(d, stringSet);
  const strings = [...stringSet].sort();
  const indexOf = new Map(strings.map((s, i) => [s, i]));
  const idx = (s: string): number => indexOf.get(s)!;

  const packed = map([
    ["version", float(PACK_VERSION)],
    ["strings", array(strings.map(tstr))],
    ["envelopes", array(manifests.map((m) => hydratedRecord(m, idx)))],
    [
      "members",
      array(
        members.map((d) =>
          memberRecord(
            d,
            manifests[memberToManifest.get(d.id)!]!,
            memberToManifest.get(d.id)!,
            idx,
          ),
        ),
      ),
    ],
    ["loose", array(loose.map((d) => hydratedRecord(d, idx)))],
  ]);
  return encode(packed);
}

export function packId(bytes: Uint8Array): string {
  return contentAddress(bytes);
}

// --- unpacking --------------------------------------------------------------------------------------

type Obj = Map<string, CborValue>;

function asMap(v: CborValue, what: string): Obj {
  if (v.t !== "map") throw new Error(`pack: expected map for ${what}`);
  return new Map(v.v);
}

function asArray(v: CborValue | undefined, what: string): readonly CborValue[] {
  if (v === undefined || v.t !== "array") throw new Error(`pack: expected array for ${what}`);
  return v.v;
}

function asNum(v: CborValue | undefined, what: string): number {
  if (v === undefined || v.t !== "float") throw new Error(`pack: expected number for ${what}`);
  return v.v;
}

function ptrFromCbor(v: CborValue, strings: readonly string[]): Pointer {
  const o = asMap(v, "pointer");
  const str = (key: string): string => strings[asNum(o.get(key), key)]!;
  const role = str("r");
  const context = o.has("c") ? str("c") : undefined;
  let target: Target;
  if (o.has("e")) {
    target = {
      kind: "entity",
      entity: context === undefined ? { id: str("e") } : { id: str("e"), context },
    };
  } else if (o.has("d")) {
    target = {
      kind: "delta",
      deltaRef: context === undefined ? { delta: str("d") } : { delta: str("d"), context },
    };
  } else if (o.has("s")) {
    target = { kind: "primitive", value: str("s") };
  } else if (o.has("n")) {
    target = { kind: "primitive", value: asNum(o.get("n"), "n") };
  } else if (o.has("b")) {
    const b = o.get("b")!;
    if (b.t !== "bool") throw new Error("pack: expected bool for b");
    target = { kind: "primitive", value: b.v };
  } else {
    throw new Error("pack: pointer record has no target");
  }
  return { role, target };
}

function hydrateRecord(v: CborValue, strings: readonly string[]): Delta {
  const o = asMap(v, "record");
  const claims: Claims = {
    author: strings[asNum(o.get("a"), "a")]!,
    timestamp: asNum(o.get("t"), "t"),
    pointers: asArray(o.get("p"), "p").map((p) => ptrFromCbor(p, strings)),
  };
  const sig = o.has("s") ? strings[asNum(o.get("s"), "s")]! : undefined;
  return verifiedDelta(claims, sig, strings[asNum(o.get("i"), "i")]!);
}

// SPEC-8 §4: hydrate -> canonical CBOR -> multihash MUST equal the stored id. Free fsck.
function verifiedDelta(claims: Claims, sig: string | undefined, storedId: string): Delta {
  const d = makeDelta(claims, sig);
  if (d.id !== storedId) {
    throw new Error(`pack: rehydrated delta ${d.id} does not match stored id ${storedId}`);
  }
  return d;
}

export function unpackSet(bytes: Uint8Array): DeltaSet {
  const top = asMap(decode(bytes), "pack");
  if (asNum(top.get("version"), "version") !== PACK_VERSION) {
    throw new Error("pack: unsupported version");
  }
  const strings = asArray(top.get("strings"), "strings").map((s) => {
    if (s.t !== "tstr") throw new Error("pack: string table entries must be text");
    return s.v;
  });
  const out = new DeltaSet();
  const envelopes = asArray(top.get("envelopes"), "envelopes").map((e) =>
    hydrateRecord(e, strings),
  );
  for (const m of envelopes) out.add(m);
  for (const rec of asArray(top.get("members"), "members")) {
    const o = asMap(rec, "member");
    const manifest = envelopes[asNum(o.get("m"), "m")];
    if (manifest === undefined) throw new Error("pack: member references missing envelope");
    const author = o.has("a") ? strings[asNum(o.get("a"), "a")]! : manifest.claims.author;
    const timestamp = manifest.claims.timestamp + (o.has("dt") ? asNum(o.get("dt"), "dt") : 0);
    const claims: Claims = {
      author,
      timestamp,
      pointers: asArray(o.get("p"), "p").map((p) => ptrFromCbor(p, strings)),
    };
    const sig = o.has("s") ? strings[asNum(o.get("s"), "s")]! : undefined;
    out.add(verifiedDelta(claims, sig, strings[asNum(o.get("i"), "i")]!));
  }
  for (const rec of asArray(top.get("loose"), "loose")) out.add(hydrateRecord(rec, strings));
  return out;
}
