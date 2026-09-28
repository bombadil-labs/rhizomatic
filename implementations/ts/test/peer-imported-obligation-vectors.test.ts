import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeImportedObligations,
  encodeImportedObligations,
  importedObligationsDigest,
  type ImportedObligationCarry,
} from "../src/federation/imported-obligations.js";
import { decodeRefusalSnapshot } from "../src/federation/refusal-snapshot.js";

interface Case extends ImportedObligationCarry {
  name: string;
  snapshotCase: number;
  expectedHex: string;
  digest: string;
}
interface InvalidCase {
  name: string;
  baseCase: number;
  mutation: string;
}
const vector = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/peer/imported-obligations.json"),
    "utf8",
  ),
) as { cases: Case[]; invalidCases: InvalidCase[] };
const snapshots = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/refusal-snapshot.json"), "utf8"),
) as { cases: Array<{ expectedHex: string }> };

function snapshot(index: number) {
  return decodeRefusalSnapshot(Buffer.from(snapshots.cases[index]!.expectedHex, "hex"));
}

function mutate(base: Case, kind: string): ImportedObligationCarry {
  const rows = structuredClone(base.obligations);
  const first = rows[0]!;
  switch (kind) {
    case "duplicate-identity":
      return { obligations: [...rows, { ...first, surfaceId: "another-surface" }] };
    case "unrefused-target":
      return { obligations: [{ ...first, targetId: `1e20${"c".repeat(64)}` }, ...rows.slice(1)] };
    case "stale-event":
      return {
        obligations: [{ ...first, event: { ...first.event, sequence: 3 } }, ...rows.slice(1)],
      };
    case "outdated-event":
      return {
        obligations: [
          { ...first, event: { sourcePeerId: "peer-A", sequence: 1 } },
          ...rows.slice(1),
        ],
      };
    case "zero-generation":
      return { obligations: [{ ...first, generation: 0 }, ...rows.slice(1)] };
    case "missing-fault":
      return {
        obligations: [
          {
            sourcePeerId: first.sourcePeerId,
            sequence: first.sequence,
            targetId: first.targetId,
            surfaceId: first.surfaceId,
            generation: first.generation,
            event: first.event,
            ...(first.priorEpoch === undefined ? {} : { priorEpoch: first.priorEpoch }),
            status: first.status,
          },
          ...rows.slice(1),
        ],
      };
    case "pending-fault":
      return { obligations: [{ ...first, fault: "unexpected" }, ...rows.slice(1)] };
    default:
      throw new Error(`unknown mutation ${kind}`);
  }
}

describe("shared SPEC-6 active obligation carry", () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const refusal = snapshot(c.snapshotCase);
      const image = encodeImportedObligations(refusal, c);
      expect(Buffer.from(image).toString("hex")).toBe(c.expectedHex);
      expect(importedObligationsDigest(refusal, c)).toBe(c.digest);
      expect(
        Buffer.from(encodeImportedObligations(refusal, decodeImportedObligations(image, refusal))),
      ).toEqual(Buffer.from(image));
      expect(
        Buffer.from(
          encodeImportedObligations(refusal, { obligations: [...c.obligations].reverse() }),
        ),
      ).toEqual(Buffer.from(image));
      const damaged = Uint8Array.from(image);
      damaged[damaged.length - 1]! ^= 1;
      expect(() => decodeImportedObligations(damaged, refusal)).toThrow();
      if (c.snapshotCase !== 0)
        expect(() => decodeImportedObligations(image, snapshot(0))).toThrow(
          "wrong refusal snapshot",
        );
    });
  }

  for (const c of vector.invalidCases) {
    it(c.name, () => {
      const base = vector.cases[c.baseCase]!;
      expect(() =>
        encodeImportedObligations(snapshot(base.snapshotCase), mutate(base, c.mutation)),
      ).toThrow("invalid active obligation");
    });
  }
});
