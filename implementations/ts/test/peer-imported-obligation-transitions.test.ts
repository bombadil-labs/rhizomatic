import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateImportedObligationTransition,
  type ImportedObligation,
  type ImportedObligationCarry,
} from "../src/federation/imported-obligations.js";
import { decodeRefusalSnapshot, type RefusalSnapshot } from "../src/federation/refusal-snapshot.js";

const at = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../vectors/peer/${name}`), "utf8"));
const vector = at("imported-obligation-transitions.json") as {
  beforeSnapshotCase: number;
  beforeCarryCase: number;
  interveningPeerId: string;
  cases: Array<{ name: string; mutation: string; afterSnapshotCase: number }>;
  invalidCases: Array<{
    name: string;
    mutation: string;
    afterSnapshotCase: number;
    beforeCarryCase?: number;
    interveningPeerId?: string;
    expected: string;
  }>;
};
const snapshotVector = at("refusal-snapshot.json") as { cases: Array<{ expectedHex: string }> };
const carryVector = at("imported-obligations.json") as {
  cases: Array<ImportedObligationCarry>;
};

function snapshot(index: number): RefusalSnapshot {
  return decodeRefusalSnapshot(Buffer.from(snapshotVector.cases[index]!.expectedHex, "hex"));
}

function successor(mutation: string, original: ImportedObligation, base: RefusalSnapshot) {
  const current = { sourcePeerId: "peer-B", sequence: 3 };
  const advanced = { ...original, event: current };
  const newLocal: ImportedObligation = {
    sourcePeerId: "peer-B",
    sequence: 1,
    targetId: `1e20${"b".repeat(64)}`,
    surfaceId: "pool-z",
    generation: 1,
    event: { sourcePeerId: "peer-ancestor", sequence: 5 },
    priorEpoch: { sourcePeerId: "peer-ancestor", sequence: 3 },
    status: "pending",
  };
  let afterSnapshot = structuredClone(base);
  let after: ImportedObligationCarry = { obligations: [original] };
  switch (mutation) {
    case "retry-failed":
      after = { obligations: [{ ...original, status: "failed", fault: "retryable-io" }] };
      break;
    case "advance-event":
      after = { obligations: [advanced] };
      break;
    case "add-local":
      after = { obligations: [advanced, newLocal] };
      break;
    case "drop-active":
      after = { obligations: [] };
      break;
    case "renumber":
      after = { obligations: [{ ...original, sequence: 2 }] };
      break;
    case "surface-drift":
      after = { obligations: [{ ...original, surfaceId: "pool-y" }] };
      break;
    case "generation-drift":
      after = { obligations: [{ ...original, generation: 5 }] };
      break;
    case "epoch-drift":
      after = {
        obligations: [
          {
            sourcePeerId: original.sourcePeerId,
            sequence: original.sequence,
            targetId: original.targetId,
            surfaceId: original.surfaceId,
            generation: original.generation,
            event: original.event,
            status: original.status,
            ...(original.fault === undefined ? {} : { fault: original.fault }),
          },
        ],
      };
      break;
    case "foreign-obligation":
      after = { obligations: [advanced, { ...newLocal, sourcePeerId: "peer-Z" }] };
      break;
    case "changed-prior-event":
      after = { obligations: [advanced] };
      afterSnapshot = {
        ...afterSnapshot,
        events: afterSnapshot.events.map((event) =>
          event.sourcePeerId === "peer-A" && event.sequence === 3
            ? { ...event, orderIds: [`1e20${"f".repeat(64)}`] }
            : event,
        ),
      };
      break;
    case "foreign-event":
      after = { obligations: [advanced] };
      afterSnapshot = {
        ...afterSnapshot,
        events: [
          ...afterSnapshot.events,
          {
            sourcePeerId: "peer-Z",
            sequence: 1,
            targetId: original.targetId,
            orderIds: [`1e20${"f".repeat(64)}`],
          },
        ],
      };
      break;
    case "stale-current-event":
      break;
    case "local-event-not-current":
      afterSnapshot = {
        ...afterSnapshot,
        current: afterSnapshot.current.map((row) =>
          row.targetId === original.targetId
            ? { ...row, sourcePeerId: "peer-A", sequence: 5 }
            : row,
        ),
      };
      break;
    default:
      throw new Error(`unknown mutation ${mutation}`);
  }
  return { afterSnapshot, after };
}

describe("shared SPEC-6 active carry succession", () => {
  const beforeSnapshot = snapshot(vector.beforeSnapshotCase);
  const before = carryVector.cases[vector.beforeCarryCase]!;
  const original = before.obligations[0]!;
  for (const c of vector.cases) {
    it(c.name, () => {
      const { afterSnapshot, after } = successor(
        c.mutation,
        original,
        snapshot(c.afterSnapshotCase),
      );
      expect(() =>
        validateImportedObligationTransition(
          beforeSnapshot,
          before,
          afterSnapshot,
          after,
          vector.interveningPeerId,
        ),
      ).not.toThrow();
    });
  }
  for (const c of vector.invalidCases) {
    it(c.name, () => {
      const previous = carryVector.cases[c.beforeCarryCase ?? vector.beforeCarryCase]!;
      const { afterSnapshot, after } =
        c.mutation === "identity-reuse"
          ? { afterSnapshot: snapshot(c.afterSnapshotCase), after: previous }
          : successor(c.mutation, original, snapshot(c.afterSnapshotCase));
      expect(() =>
        validateImportedObligationTransition(
          beforeSnapshot,
          previous,
          afterSnapshot,
          after,
          c.interveningPeerId ?? vector.interveningPeerId,
        ),
      ).toThrow(c.expected);
    });
  }
});
