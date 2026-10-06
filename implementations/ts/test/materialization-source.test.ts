import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { parseCommandDelta, commandBytes } from "../src/command-data/codec.js";
import { readMaterializationDescription } from "../src/command-data/materialization-codec.js";
import { bytesToHex, contentAddress } from "../src/delta/hash.js";
import { encode, decode, map, bstr, tstr, array, type CborValue } from "../src/delta/cbor.js";
import {
  decodeMaterializationSnapshot,
  decodeMaterializationSnapshotEvidence,
  materializationCaptureBasis,
  materializationComponentCommitments,
  validateMaterializationCaptureBasis,
  DEFAULT_MATERIALIZATION_SOURCE_LIMITS,
  type MaterializationSourceLimits,
} from "../src/federation/materialization-source.js";
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../vectors/materialization/source-snapshot.json", import.meta.url),
    "utf8",
  ),
) as {
  positives: {
    id: string;
    snapshotHex: string;
    basisHex: string;
    expected: {
      revision: string;
      membership: string;
      appearanceDigest: string;
      operandIds: string[];
      components: number;
      excludedId?: string;
    };
  }[];
  negatives: {
    id: string;
    snapshotHex: string;
    limits?: MaterializationSourceLimits;
    expected: string;
  }[];
};
const bytes = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
const assertionCorpusId = createHash("sha256")
  .update(
    readFileSync(new URL("../../../vectors/materialization/source-snapshot.json", import.meta.url)),
  )
  .digest("hex");
function recordAssertions(group: string, f: { id: string }, before: number): void {
  console.log(
    "materialization-m2-assertion:" +
      JSON.stringify({
        corpus: "source-snapshot",
        corpusId: assertionCorpusId,
        group,
        id: f.id,
        assertions: expect.getState().assertionCalls - before,
      }),
  );
}
for (const f of vectors.positives)
  it("source snapshot " + f.id, () => {
    const before = expect.getState().assertionCalls;
    const s = decodeMaterializationSnapshot(bytes(f.snapshotHex));
    expect(bytesToHex(encode(s.value))).toBe(f.snapshotHex);
    expect(s.revision).toBe(f.expected.revision);
    expect(s.membership).toBe(f.expected.membership);
    expect(s.appearanceDigest).toBe(f.expected.appearanceDigest);
    expect(s.deltas.map((d) => d.id)).toEqual(f.expected.operandIds);
    expect(s.components.length).toBe(f.expected.components);
    expect(bytesToHex(materializationCaptureBasis(bytes(f.snapshotHex)))).toBe(f.basisHex);
    validateMaterializationCaptureBasis(bytes(f.basisHex), bytes(f.snapshotHex));
    const commitments = bytesToHex(encode(materializationComponentCommitments(s)));
    if (f.expected.excludedId)
      expect(commitments).not.toContain(
        bytesToHex(new TextEncoder().encode(f.expected.excludedId)),
      );
    recordAssertions("positives", f, before);
  });
for (const f of vectors.negatives)
  it("source refusal " + f.id, () => {
    const before = expect.getState().assertionCalls;
    expect(() =>
      decodeMaterializationSnapshot(
        bytes(f.snapshotHex),
        f.limits ?? DEFAULT_MATERIALIZATION_SOURCE_LIMITS,
      ),
    ).toThrow(f.expected);
    recordAssertions("negatives", f, before);
  });
it("observation alone does not change revision, authority does", () => {
  const byId = (id: string) =>
    decodeMaterializationSnapshot(bytes(vectors.positives.find((f) => f.id === id)!.snapshotHex));
  expect(byId("one").revision).toBe(byId("fresh_observation").revision);
  expect(byId("one").revision).not.toBe(byId("authority_change").revision);
});

// Invocation-local reuse is a factory boundary, never a caller-created proof.
it("snapshot evidence checker owns basis and source independently of returned mutations", () => {
  const f = vectors.positives.find((f) => f.id === "one")!;
  const raw = bytes(f.snapshotHex),
    limits = { ...DEFAULT_MATERIALIZATION_SOURCE_LIMITS };
  const handle = decodeMaterializationSnapshotEvidence(raw, limits);
  const first = handle.snapshot;
  (first.deltas[0]!.claims.pointers as unknown as unknown[]).splice(0);
  if (first.value.t === "map") (first.value.v as unknown as unknown[]).splice(0);
  first.components.slice().forEach((c) => {
    if (c.t === "map") (c.v as unknown as unknown[]).splice(0);
  });
  const byteCopy = handle.snapshot;
  const poisonBytes = (v: CborValue): void => {
    if (v.t === "bstr") v.v.fill(0);
    if (v.t === "map") v.v.forEach(([, child]) => poisonBytes(child));
    if (v.t === "array") v.v.forEach(poisonBytes);
  };
  poisonBytes(byteCopy.value);
  raw.fill(0);
  limits.artifactBytes = 1;
  expect(bytesToHex(encode(handle.snapshot.value))).toBe(f.snapshotHex);
  expect(handle.snapshot.deltas[0]!.claims.pointers.length).toBeGreaterThan(0);
  const commands = JSON.parse(
    readFileSync(
      new URL("../../../vectors/materialization/commands.json", import.meta.url),
      "utf8",
    ),
  );
  const plant = commands.positives.find((f: { id: string }) => f.id === "plant");
  const byteHandle = decodeMaterializationSnapshotEvidence(
    commandBytes(readMaterializationDescription(parseCommandDelta(plant.snapshot)), "data"),
  );
  const target = byteHandle.snapshot.deltas
    .flatMap((d) => d.claims.pointers)
    .find((p) => p.target.kind === "bytes")!.target;
  if (target.kind !== "bytes") throw Error();
  target.value.fill(0);
  const freshTarget = byteHandle.snapshot.deltas
    .flatMap((d) => d.claims.pointers)
    .find((p) => p.target.kind === "bytes")!.target;
  if (freshTarget.kind !== "bytes") throw Error();
  expect([...freshTarget.value]).toEqual([0, 255, 1]);
  const detached = handle.validateCaptureBasis;
  expect(() => detached(bytes(f.basisHex))).not.toThrow();
  expect(() => detached(new Uint8Array([0]))).toThrow("invalid-source");
  const forged = { snapshot: handle.snapshot, validateCaptureBasis: () => {} };
  expect(() => decodeMaterializationSnapshotEvidence(forged as unknown as Uint8Array)).toThrow(
    "invalid-source",
  );
});
it("snapshot evidence verifies each fresh factory but never re-verifies for its basis", async () => {
  const sign = await import("../src/delta/sign.js");
  const spy = vi.spyOn(sign, "verifyCanonicalDelta");
  try {
    const f = vectors.positives.find((f) => f.id === "one")!;
    const h = decodeMaterializationSnapshotEvidence(bytes(f.snapshotHex));
    expect(spy).toHaveBeenCalledTimes(h.snapshot.deltas.length);
    h.validateCaptureBasis(bytes(f.basisHex));
    h.validateCaptureBasis(bytes(f.basisHex));
    expect(spy).toHaveBeenCalledTimes(h.snapshot.deltas.length);
    decodeMaterializationSnapshotEvidence(bytes(f.snapshotHex));
    expect(spy).toHaveBeenCalledTimes(2 * h.snapshot.deltas.length);
  } finally {
    spy.mockRestore();
  }
});
it("snapshot evidence never reuses a same-id unsigned or different-signature appearance", () => {
  const f = vectors.positives.find((f) => f.id === "one")!;
  const original = decodeMaterializationSnapshotEvidence(bytes(f.snapshotHex));
  original.validateCaptureBasis(bytes(f.basisHex));
  const replace = (v: CborValue, k: string, x: CborValue): CborValue =>
    v.t === "map" ? map(v.v.map(([key, value]) => [key, key === k ? x : value])) : v;
  for (const signature of [undefined, new Uint8Array(64)]) {
    const value = decode(bytes(f.snapshotHex));
    if (value.t !== "map") throw Error();
    const table = value.v.find(([k]) => k === "appearances")![1];
    if (table.t !== "array") throw Error();
    const record = table.v[0]!;
    if (record.t !== "map") throw Error();
    const appearance = record.v.find(([k]) => k === "value")![1];
    if (appearance.t !== "bstr") throw Error();
    const decoded = decode(appearance.v);
    if (decoded.t !== "map") throw Error();
    const altered = encode(
      map(
        decoded.v
          .filter(([k]) => k !== "sig")
          .concat(signature === undefined ? [] : [["sig", bstr(signature)]]),
      ),
    );
    const key = contentAddress(altered);
    const alteredTable = array([
      replace(replace(record, "value", bstr(altered)), "key", tstr(key)),
    ]);
    const bad = encode(replace(value, "appearances", alteredTable));
    expect(() => decodeMaterializationSnapshotEvidence(bad)).toThrow("invalid-source");
    expect(() => decodeMaterializationSnapshotEvidence(bytes(f.snapshotHex))).not.toThrow();
  }
});
