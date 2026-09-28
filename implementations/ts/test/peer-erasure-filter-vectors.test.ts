import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  planErasureFilter,
  type ErasureAuthority,
  type ErasureOrderCandidate,
} from "../src/federation/erasure-filter.js";

interface Case {
  name: string;
  prior: string[];
  budget: number;
  orders: Array<{ id: string; target: string; rule: string }>;
  effective: string[];
  ineligible: string[];
  limited: string[];
  selectedTargets: string[];
}
const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/peer/erasure-filter.json"), "utf8"),
) as { cases: Case[] };

describe("shared SPEC-6 erasure authority filter vectors", () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const rules = new Map(c.orders.map((order) => [order.id, order.rule]));
      const authorize: ErasureAuthority = (order, visible) => {
        const rule = rules.get(order.id)!;
        if (rule === "always") return true;
        if (rule === "own-target") return visible.has(order.targetId);
        if (rule.startsWith("requires:")) return visible.has(rule.slice(9));
        if (rule.startsWith("same-presence:")) {
          const [a, b] = rule.slice(14).split(":");
          return visible.has(a!) === visible.has(b!);
        }
        throw new Error(`unknown test rule ${rule}`);
      };
      const orders: ErasureOrderCandidate[] = c.orders.map((o) => ({
        id: o.id,
        targetId: o.target,
      }));
      const expected = {
        effectiveOrderIds: c.effective,
        ineligibleOrderIds: c.ineligible,
        limitedOrderIds: c.limited,
        selectedTargets: c.selectedTargets,
      };
      for (const input of [orders, [...orders].reverse()]) {
        expect(planErasureFilter(input, new Set(c.prior), c.budget, authorize)).toEqual(expected);
      }
    });
  }
});
