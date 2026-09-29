import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planArrivals, type ArrivalCursor, type ArrivalPlan } from "../src/federation/arrival.js";

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/peer/arrival.json"), "utf8"),
) as {
  initial: ArrivalCursor;
  steps: Array<{
    name: string;
    active: string[];
    accepted: string[];
    at: number;
    sender: string;
    expected: ArrivalPlan;
  }>;
};

describe("shared SPEC-6 arrival vectors", () => {
  it("assigns receiver-local sequence and transfer testimony", () => {
    let cursor = vector.initial;
    for (const step of vector.steps) {
      const planned = planArrivals(
        cursor,
        new Set(step.active),
        step.accepted,
        step.at,
        step.sender,
      );
      expect(planned, step.name).toEqual(step.expected);
      cursor = planned;
    }
  });

  it("refuses exhausted counters rather than repeating testimony", () => {
    expect(() =>
      planArrivals(
        { lastSequence: Number.MAX_SAFE_INTEGER, lastTransfer: 0 },
        new Set(),
        ["a"],
        1,
        "local",
      ),
    ).toThrow("arrival counter exhausted");
  });
});
