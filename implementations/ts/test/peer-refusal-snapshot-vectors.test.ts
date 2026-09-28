import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contentAddress } from "../src/delta/hash.js";
import { decodeDurablePeerState } from "../src/federation/durable-state.js";
import {
  decodeRefusalSnapshot,
  encodeRefusalSnapshot,
  localRefusalSnapshot,
  recoverRefusalSnapshot,
  refusalSnapshotDigest,
  verifyRefusalSnapshotCopy,
  type RefusalSnapshot,
} from "../src/federation/refusal-snapshot.js";

interface Case extends RefusalSnapshot {
  name: string;
  expectedHex: string;
  digest: string;
}
interface InvalidCase {
  name: string;
  baseCase: number;
  mutation: string;
}
interface RecoveryCase {
  name: string;
  sourceCase: number;
  digestCase: number;
  primary: "valid" | "corrupt" | "missing";
  recovery: "valid" | "corrupt" | "missing";
  usedRecovery: boolean | null;
}
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/refusal-snapshot.json"), "utf8"),
) as { cases: Case[]; invalidCases: InvalidCase[]; recoveryCases: RecoveryCase[] };
const durableVectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/durable-state.json"), "utf8"),
) as { cases: Array<{ expectedHex: string }> };

function mutate(base: Case, mutation: string): RefusalSnapshot {
  const snapshot = structuredClone(base);
  switch (mutation) {
    case "drop-current":
      return { ...snapshot, current: snapshot.current.slice(1) };
    case "wrong-source":
      return {
        ...snapshot,
        current: [
          { ...snapshot.current[0]!, sourcePeerId: "another-peer" },
          ...snapshot.current.slice(1),
        ],
      };
    case "duplicate-source-sequence":
      return { ...snapshot, events: [...snapshot.events, { ...snapshot.events[0]! }] };
    case "duplicate-order":
      return {
        ...snapshot,
        events: [
          snapshot.events[0]!,
          { ...snapshot.events[1]!, orderIds: snapshot.events[0]!.orderIds },
          ...snapshot.events.slice(2),
        ],
      };
    case "zero-epoch":
      return {
        ...snapshot,
        events: [{ ...snapshot.events[0]!, priorEpoch: 0 }, ...snapshot.events.slice(1)],
      };
    case "stale-current-same-source":
      return {
        ...snapshot,
        current: [{ ...snapshot.current[0]!, sequence: 3 }, ...snapshot.current.slice(1)],
      };
    case "target-is-order": {
      const targetId = snapshot.events[0]!.orderIds[0]!;
      return {
        events: [
          ...snapshot.events,
          {
            sourcePeerId: "peer-C",
            sequence: 1,
            targetId,
            orderIds: [`1e20${"f".repeat(64)}`],
          },
        ],
        current: [...snapshot.current, { sourcePeerId: "peer-C", sequence: 1, targetId }],
      };
    }
    case "conflicting-prior-epoch":
      return {
        ...snapshot,
        events: [
          snapshot.events[0]!,
          { ...snapshot.events[1]!, priorEpoch: 8 },
          ...snapshot.events.slice(2),
        ],
      };
    case "order-reused-different-target":
      return {
        ...snapshot,
        events: [
          snapshot.events[0]!,
          snapshot.events[1]!,
          { ...snapshot.events[2]!, orderIds: snapshot.events[0]!.orderIds },
        ],
      };
    default:
      throw new Error(`unknown mutation ${mutation}`);
  }
}

describe("shared SPEC-6 inherited refusal snapshot", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const bytes = encodeRefusalSnapshot(c);
      expect(Buffer.from(bytes).toString("hex")).toBe(c.expectedHex);
      expect(refusalSnapshotDigest(c)).toBe(c.digest);
      expect(Buffer.from(encodeRefusalSnapshot(decodeRefusalSnapshot(bytes)))).toEqual(
        Buffer.from(bytes),
      );
      expect(
        Buffer.from(
          encodeRefusalSnapshot({
            events: [...c.events].reverse(),
            current: [...c.current].reverse(),
          }),
        ),
      ).toEqual(Buffer.from(bytes));
    });
  }

  for (const c of vectors.invalidCases) {
    it(c.name, () => {
      expect(() => encodeRefusalSnapshot(mutate(vectors.cases[c.baseCase]!, c.mutation))).toThrow(
        "refusal snapshot:",
      );
    });
  }

  for (const c of vectors.recoveryCases) {
    it(c.name, () => {
      const bytes = Buffer.from(vectors.cases[c.sourceCase]!.expectedHex, "hex");
      const damaged = Buffer.from(bytes);
      damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
      const copy = (kind: RecoveryCase["primary"]) =>
        kind === "valid" ? bytes : kind === "corrupt" ? damaged : undefined;
      const recover = () =>
        recoverRefusalSnapshot(
          vectors.cases[c.digestCase]!.digest,
          copy(c.primary),
          copy(c.recovery),
        );
      if (c.usedRecovery === null) expect(recover).toThrow("no verified copy");
      else {
        const result = recover();
        expect(result.usedRecovery).toBe(c.usedRecovery);
        expect(result.bytes).toEqual(bytes);
        expect(result.snapshot.current).toEqual(decodeRefusalSnapshot(bytes).current);
        expect(verifyRefusalSnapshotCopy(vectors.cases[c.sourceCase]!.digest, bytes)).toEqual(
          result.snapshot,
        );
      }
    });
  }

  it("rejects malformed snapshot bytes before trusting a matching digest", () => {
    const c = vectors.cases[2]!;
    const canonical = encodeRefusalSnapshot(c);
    const tampered = canonical.slice();
    tampered[0] = 0;
    expect(() => decodeRefusalSnapshot(tampered)).toThrow();
    const forgedDigest = contentAddress(tampered);
    expect(() => recoverRefusalSnapshot(forgedDigest, tampered)).toThrow("no verified copy");
  });

  it("captures the entire durable local refusal set, including an unseen target", () => {
    for (const index of [2, 4]) {
      const state = decodeDurablePeerState(
        Buffer.from(durableVectors.cases[index]!.expectedHex, "hex"),
        "peer-A",
      );
      const snapshot = localRefusalSnapshot(state);
      expect(new Set(snapshot.current.map((row) => row.targetId))).toEqual(state.base.refusedIds);
      expect(snapshot.events).toHaveLength(state.events.length);
      expect(() => decodeRefusalSnapshot(encodeRefusalSnapshot(snapshot))).not.toThrow();
    }
  });
});
