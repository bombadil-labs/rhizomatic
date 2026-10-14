// Scoped source snapshots (SPEC-17 §7): the shared corpus both witnesses must decode alike.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { bstr, encode, map, tstr, type CborValue } from "../src/delta/cbor.js";
import { bytesToHex } from "../src/delta/hash.js";
import {
  decodeMaterializationBindingSpec,
  decodeMaterializationCaptureBasis,
  decodeMaterializationSnapshot,
  materializationBindingScoped,
  materializationCaptureBasis,
  MaterializationSourceError,
  produceMaterializationSnapshot,
} from "../src/federation/materialization-source.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../vectors/materialization/scoped-source.json", import.meta.url),
    "utf8",
  ),
) as {
  bindings: { id: string; specHex: string; expected: { scoped: boolean } }[];
  positives: {
    id: string;
    snapshotHex: string;
    basisHex: string;
    expected: { revision: string; scope: string[]; operandIds: string[] };
  }[];
  negatives: { id: string; snapshotHex: string; expected: string }[];
};
const bytes = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

for (const b of vectors.bindings)
  it(`binding ${b.id}`, () => {
    expect(materializationBindingScoped(decodeMaterializationBindingSpec(bytes(b.specHex)))).toBe(
      b.expected.scoped,
    );
  });

for (const f of vectors.positives)
  it(`scoped snapshot ${f.id}`, () => {
    const s = decodeMaterializationSnapshot(bytes(f.snapshotHex));
    expect(bytesToHex(encode(s.value))).toBe(f.snapshotHex);
    expect(s.revision).toBe(f.expected.revision);
    expect(s.scope).toEqual(f.expected.scope);
    expect(s.deltas.map((d) => d.id)).toEqual(f.expected.operandIds);
    expect(bytesToHex(materializationCaptureBasis(bytes(f.snapshotHex)))).toBe(f.basisHex);
    const basis = decodeMaterializationCaptureBasis(bytes(f.basisHex));
    expect(basis.scope).toEqual(f.expected.scope);
    expect(basis.revision).toBe(f.expected.revision);
  });

for (const f of vectors.negatives)
  it(`scoped snapshot refuses ${f.id}`, () => {
    let code: string | undefined;
    try {
      decodeMaterializationSnapshot(bytes(f.snapshotHex));
    } catch (e) {
      if (e instanceof MaterializationSourceError) code = e.code;
    }
    expect(code).toBe(f.expected);
  });

// The producer reproduces every shared fixture byte for byte from its parts: the library owns the
// format, so a host that hands it the same selection gets the same snapshot as the oracle.
const selectionOf = (profile: string) =>
  map([
    ["profile", tstr(profile)],
    ["parameters", bstr(encode(map([])))],
  ]);
const fieldsOf = (v: CborValue): Map<string, CborValue> => new Map(v.t === "map" ? v.v : []);
function reproduce(snapshotHex: string, profile: string) {
  const s = decodeMaterializationSnapshot(bytes(snapshotHex));
  const fields = new Map(s.value.t === "map" ? s.value.v : []);
  const exclusions = (fields.get("exclusions")!.v as CborValue[]).map((e) => {
    const f = fieldsOf(e);
    return {
      id: f.get("id")!.v as string,
      peers: (f.get("peers")!.v as CborValue[]).map((p) => p.v as string),
      reason: f.get("reason")!.v as string,
    };
  });
  const operandPeers = new Map(
    (fields.get("operands")!.v as CborValue[]).map((o) => {
      const f = fieldsOf(o);
      return [
        f.get("id")!.v as string,
        (f.get("peers")!.v as CborValue[]).map((p) => p.v as string),
      ];
    }),
  );
  const components = s.components.map((c) => {
    const f = fieldsOf(c);
    const peer = f.get("peer")!.v as string;
    return {
      peer,
      revision: f.get("revision")!.v as string,
      capturedAt: f.get("capturedAt")!.v as number,
      operands: s.deltas.filter((d) => operandPeers.get(d.id)!.includes(peer)),
      heldIds: (f.get("rawIds")!.v as CborValue[])
        .map((x) => x.v as string)
        .filter((x) => !(f.get("operandIds")!.v as CborValue[]).some((o) => o.v === x)),
    };
  });
  return produceMaterializationSnapshot({
    binding: s.binding,
    authority: s.authority,
    selection: selectionOf(profile),
    servingAt: s.servingAt,
    ...(s.historicalCutoff === undefined ? {} : { historicalCutoff: s.historicalCutoff }),
    ...(s.scope === undefined ? {} : { scope: s.scope }),
    components,
    exclusions: exclusions.map((e) => ({ id: e.id, reason: e.reason })),
  });
}

for (const f of vectors.positives)
  it(`the producer reproduces scoped fixture ${f.id}`, () => {
    const produced = reproduce(f.snapshotHex, "scoped-snapshot/1");
    expect(bytesToHex(produced.snapshotBytes)).toBe(f.snapshotHex);
    expect(bytesToHex(produced.basisBytes)).toBe(f.basisHex);
    expect(produced.revision).toBe(f.expected.revision);
  });

const full = JSON.parse(
  readFileSync(
    new URL("../../../vectors/materialization/source-snapshot.json", import.meta.url),
    "utf8",
  ),
) as { positives: { id: string; snapshotHex: string; basisHex: string }[] };
for (const f of full.positives)
  it(`the producer reproduces full fixture ${f.id}`, () => {
    const produced = reproduce(f.snapshotHex, "host-authorized-snapshot/1");
    expect(bytesToHex(produced.snapshotBytes)).toBe(f.snapshotHex);
    expect(bytesToHex(produced.basisBytes)).toBe(f.basisHex);
  });
