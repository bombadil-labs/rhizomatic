import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeImportedHoldings,
  encodeImportedHoldings,
  importedHoldingsDigest,
} from "../src/federation/imported-holdings.js";
import {
  emptySnapshot,
  importedCase,
  invalidCase,
  refusedSnapshot,
} from "../tools/peer-imported-holdings-fixture.js";

interface Case {
  name: string;
  holdings: string[];
  cover: boolean;
  expectedHex: string;
  digest: string;
}
const vector = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/peer/imported-holdings.json"),
    "utf8",
  ),
) as { cases: Case[]; invalidCases: Array<{ name: string; mutation: string; expected: string }> };

describe("shared SPEC-6 closed holding inventory", () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const imported = importedCase(c.holdings, c.cover);
      const image = encodeImportedHoldings(emptySnapshot, imported);
      expect(Buffer.from(image).toString("hex")).toBe(c.expectedHex);
      expect(importedHoldingsDigest(emptySnapshot, imported)).toBe(c.digest);
      const reopened = decodeImportedHoldings(image, emptySnapshot);
      expect(Buffer.from(encodeImportedHoldings(emptySnapshot, reopened))).toEqual(
        Buffer.from(image),
      );
      expect(
        Buffer.from(
          encodeImportedHoldings(emptySnapshot, {
            ...imported,
            holdings: [...imported.holdings].reverse(),
          }),
        ),
      ).toEqual(Buffer.from(image));
      expect(() => decodeImportedHoldings(image, refusedSnapshot)).toThrow(
        "wrong refusal snapshot",
      );
      const damaged = Uint8Array.from(image);
      damaged[damaged.length - 1]! ^= 1;
      expect(() => decodeImportedHoldings(damaged, emptySnapshot)).toThrow();
    });
  }

  for (const c of vector.invalidCases) {
    it(c.name, () => {
      const { imported, snapshot } = invalidCase(c.mutation);
      expect(() => encodeImportedHoldings(snapshot, imported)).toThrow(c.expected);
    });
  }
});
