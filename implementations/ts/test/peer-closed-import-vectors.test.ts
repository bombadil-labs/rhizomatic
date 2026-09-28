import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closedImportCarriedDigest,
  closedImportPolicyDigest,
  decodeClosedImportState,
  encodeClosedImportState,
  readClosedImportState,
  stageClosedImportState,
} from "../src/federation/closed-import.js";
import { encodeRefusalSnapshot } from "../src/federation/refusal-snapshot.js";
import {
  closedImportCase,
  invalidClosedImportCase,
  type ClosedImportCase,
} from "../tools/peer-closed-import-fixture.js";

const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/closed-import.json"), "utf8"),
) as {
  cases: ClosedImportCase[];
  invalidCases: Array<{ name: string; mutation: string; baseCase: number; expected: string }>;
  stageCases: Array<{
    name: string;
    case: number;
    backup: "valid" | "missing" | "corrupt" | "other-valid";
    samePath?: boolean;
    expected: string;
  }>;
};

describe("shared SPEC-6 v4 closed import stage", () => {
  it("rejects malformed JavaScript descriptor text before UTF-8 replacement", () => {
    const state = closedImportCase(vector.cases[0]!);
    for (const field of ["attemptId", "oldPeerId", "policyFormat"] as const) {
      expect(() => encodeClosedImportState({ ...state, [field]: "\ud800" })).toThrow(
        "invalid attempt or policy descriptor",
      );
    }
  });

  for (const c of vector.cases) {
    it(c.name, () => {
      const state = closedImportCase(c);
      const image = encodeClosedImportState(state);
      expect(Buffer.from(image).toString("hex")).toBe(c.expectedHex);
      expect(closedImportCarriedDigest(state)).toBe(c.carriedDigest);
      expect(closedImportPolicyDigest(state)).toBe(c.policyDigest);
      const reopened = decodeClosedImportState(image, "peer-new");
      expect(Buffer.from(encodeClosedImportState(reopened))).toEqual(Buffer.from(image));
      expect(reopened.closed.inherited).toEqual(state.closed.inherited);
      expect(reopened.holdings).toEqual(state.holdings);
      expect(reopened.obligations).toEqual(state.obligations);
      expect(() => decodeClosedImportState(image, "wrong-peer")).toThrow("wrong peer id");
      const damaged = Uint8Array.from(image);
      damaged[damaged.length - 1]! ^= 1;
      expect(() => decodeClosedImportState(damaged, "peer-new")).toThrow();
    });
  }

  for (const c of vector.invalidCases) {
    it(c.name, () => {
      expect(() =>
        encodeClosedImportState(invalidClosedImportCase(vector.cases[c.baseCase]!, c.mutation)),
      ).toThrow(c.expected);
    });
  }

  for (const c of vector.stageCases) {
    it(c.name, () => {
      const state = closedImportCase(vector.cases[c.case]!);
      const dir = mkdtempSync(join(tmpdir(), "rhizomatic-closed-import-"));
      const primary = join(dir, "primary");
      const recovery = join(dir, "recovery");
      try {
        if (c.backup !== "missing") {
          const backupBytes =
            c.backup === "valid"
              ? encodeRefusalSnapshot(state.closed.inherited)
              : c.backup === "other-valid"
                ? encodeRefusalSnapshot({ events: [], current: [] })
                : new Uint8Array([0]);
          writeFileSync(recovery, backupBytes);
        }
        const stage = () => stageClosedImportState(primary, c.samePath ? primary : recovery, state);
        if (c.expected === "durable") {
          expect(stage().status).toBe("durable");
          expect(Buffer.from(readFileSync(primary)).toString("hex")).toBe(
            vector.cases[c.case]!.expectedHex,
          );
          expect(readClosedImportState(primary, "peer-new")?.attemptId).toBe("attempt-1");
          expect(() => stage()).toThrow("stage already exists");
        } else {
          if (c.expected === "error") expect(stage).toThrow();
          else expect(stage).toThrow(c.expected);
          expect(readClosedImportState(primary, "peer-new")).toBeUndefined();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
