import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { bytesToHex } from "../src/delta/hash.js";
import { encode } from "../src/delta/cbor.js";
import {
  decodeMaterializationSnapshot,
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
