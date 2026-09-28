import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ordinaryUnitKey,
  planOrdinaryQuota,
  type OrdinaryQuotaUnit,
} from "../src/federation/ordinary-quota.js";

interface Case {
  name: string;
  existing: string[];
  excluded: string[];
  capacity: number;
  units: Array<{ key: string; rank: string; fresh: string[]; requires: string[] }>;
  selected: string[];
  skipped: string[];
  pruned: string[];
  admitted: string[];
  charged: number;
}
const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/peer/ordinary-quota.json"), "utf8"),
) as {
  keyCases: Array<{ name: string; deltaId: string; members?: string[]; expected: string }>;
  cases: Case[];
};

describe("shared SPEC-6 ordinary quota vectors", () => {
  it("rejects a malformed UTF-16 private rank before sorting", () => {
    expect(() =>
      planOrdinaryQuota(
        [{ key: "a", rank: "\ud800", freshIds: ["A"], requires: [] }],
        new Set(),
        new Set(),
        1,
      ),
    ).toThrow("well-formed");
  });
  for (const c of vector.keyCases) {
    it(c.name, () => {
      expect(ordinaryUnitKey(c.deltaId, c.members)).toBe(c.expected);
      if (c.members !== undefined)
        expect(ordinaryUnitKey(c.deltaId, [...c.members].reverse())).toBe(c.expected);
    });
  }
  for (const c of vector.cases) {
    it(c.name, () => {
      const units: OrdinaryQuotaUnit[] = c.units.map((u) => ({
        key: u.key,
        rank: u.rank,
        freshIds: u.fresh,
        requires: u.requires,
      }));
      const expected = {
        selectedKeys: c.selected,
        skippedKeys: c.skipped,
        prunedKeys: c.pruned,
        admittedIds: c.admitted,
        charged: c.charged,
      };
      for (const order of [units, [...units].reverse()]) {
        expect(
          planOrdinaryQuota(order, new Set(c.existing), new Set(c.excluded), c.capacity),
        ).toEqual(expected);
      }
    });
  }
});
