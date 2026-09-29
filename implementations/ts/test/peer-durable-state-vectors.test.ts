import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/delta/json-profile.js";
import { DeltaSet } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { planArrivals, type ArrivalRecord } from "../src/federation/arrival.js";
import {
  decodeDurablePeerState,
  encodeDurablePeerState,
  planPermanentCommit,
  type DurablePeerState,
  type PurgeObligation,
} from "../src/federation/durable-state.js";
import {
  readDurablePeerState,
  writeDurablePeerState,
} from "../src/federation/file-durable-state.js";
import type { PeerState } from "../src/federation/peer-state.js";

interface BaseCase {
  peerId: string;
  admitted: string[];
  cursor: { lastSequence: number; lastTransfer: number };
  arrivals: Array<Omit<ArrivalRecord, "id"> & { id: string }>;
  refused: string[];
}
interface Case {
  name: string;
  baseCase: number;
  extraAdmitted: string[];
  extraRefused?: string[];
  extraArrivalAt?: number;
  extraSender?: string;
  refusalCounter: number;
  obligationCounter: number;
  quotaUsed: number;
  events: Array<{ sequence: number; target: string; orders: string[]; priorEpoch?: number }>;
  exclusions: Array<{ order: string; target: string; event: number; priorEpoch?: number }>;
  obligations: Array<{
    sequence: number;
    target: string;
    generation: number;
    event: number;
    priorEpoch?: number;
    status: PurgeObligation["status"];
    fault?: string;
  }>;
  expectedHex: string;
}
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/durable-state.json"), "utf8"),
) as { cases: Case[] };
const bases = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/state.json"), "utf8"),
) as { cases: BaseCase[] };
const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/principal/evidence.json"), "utf8"),
) as { deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }> };
const named = new Map<string, Delta>(
  fixture.deltas.map((row) => [
    row.name,
    { id: row.id, claims: parseClaims(row.claims), ...(row.sig ? { sig: row.sig } : {}) },
  ]),
);
const id = (name: string) => named.get(name)!.id;
interface CommitCase {
  name: string;
  beforeCase: number;
  afterCase?: number;
  additions: string[];
  erasures: Array<{ target: string; orders: string[]; surfaceHoldsBytes: boolean }>;
  quotaCharge: number;
  at: number;
  sender: string;
  expected?: string;
}
const commits = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/permanent-commit.json"), "utf8"),
) as { cases: CommitCase[]; invalidCases: CommitCase[] };
const writerVectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/peer/durable-writer.json"), "utf8"),
) as {
  cases: Array<{
    name: string;
    beforeCase?: number;
    afterCase?: number;
    actualCase?: number;
    proposedCase?: number;
    expectedCase?: number;
    mutation?: string;
    expected?: string;
    outcome?: string;
  }>;
};
function commitInput(c: CommitCase) {
  return {
    additions: c.additions.map((name) => named.get(name)!),
    erasures: c.erasures.map((group) => ({
      targetId: id(group.target),
      orderIds: group.orders.map(id),
      surfaceHoldsBytes: group.surfaceHoldsBytes,
    })),
    quotaCharge: c.quotaCharge,
    at: c.at,
    sender: c.sender,
  };
}

function fromCase(c: Case): DurablePeerState {
  const source = bases.cases[c.baseCase]!;
  let base: PeerState = {
    peerId: source.peerId,
    admitted: DeltaSet.from(source.admitted.map((name) => named.get(name)!)),
    cursor: source.cursor,
    arrivals: source.arrivals.map((row) => ({ ...row, id: id(row.id) })),
    refusedIds: new Set(source.refused.map(id)),
  };
  if (c.extraAdmitted.length) {
    const extras = c.extraAdmitted.map((name) => named.get(name)!);
    const planned = planArrivals(
      base.cursor,
      new Set(base.admitted.ids()),
      extras.map((delta) => delta.id),
      c.extraArrivalAt!,
      c.extraSender!,
    );
    base = {
      ...base,
      admitted: DeltaSet.from([...base.admitted, ...extras]),
      cursor: { lastSequence: planned.lastSequence, lastTransfer: planned.lastTransfer },
      arrivals: [...base.arrivals, ...planned.arrivals],
    };
  }
  if (c.extraRefused?.length)
    base = { ...base, refusedIds: new Set([...base.refusedIds, ...c.extraRefused.map(id)]) };
  return {
    base,
    refusalCounter: c.refusalCounter,
    obligationCounter: c.obligationCounter,
    quotaUsed: c.quotaUsed,
    events: c.events.map((row) => ({
      sequence: row.sequence,
      targetId: id(row.target),
      orderIds: row.orders.map(id).sort(),
      ...(row.priorEpoch === undefined ? {} : { priorEpoch: row.priorEpoch }),
    })),
    exclusions: c.exclusions.map((row) => ({
      orderId: id(row.order),
      targetId: id(row.target),
      eventSequence: row.event,
      ...(row.priorEpoch === undefined ? {} : { priorEpoch: row.priorEpoch }),
    })),
    obligations: c.obligations.map((row) => ({
      sequence: row.sequence,
      targetId: id(row.target),
      generation: row.generation,
      eventSequence: row.event,
      status: row.status,
      ...(row.priorEpoch === undefined ? {} : { priorEpoch: row.priorEpoch }),
      ...(row.fault === undefined ? {} : { fault: row.fault }),
    })),
  };
}

describe("shared SPEC-6 durable peer image vectors", () => {
  for (const c of vector.cases) {
    it(c.name, () => {
      const state = fromCase(c);
      const bytes = encodeDurablePeerState(state);
      expect(Buffer.from(bytes).toString("hex")).toBe(c.expectedHex);
      const restored = decodeDurablePeerState(bytes, state.base.peerId);
      expect(Buffer.from(encodeDurablePeerState(restored))).toEqual(Buffer.from(bytes));
      expect(restored.base.admitted.ids()).toEqual(state.base.admitted.ids());
      expect(restored.events).toEqual(state.events);
      expect(restored.exclusions).toEqual(
        [...state.exclusions].sort((a, b) => (a.orderId < b.orderId ? -1 : 1)),
      );
      expect(restored.obligations).toEqual(state.obligations);
      expect(() => decodeDurablePeerState(bytes, "another-peer")).toThrow("wrong peer id");
    });
  }

  it("rejects a refusal with no durable purge obligation for a held target", () => {
    const state = fromCase(vector.cases[2]!);
    expect(() =>
      encodeDurablePeerState({ ...state, obligationCounter: 0, obligations: [] }),
    ).toThrow("held refusal lacks purge obligation");
  });

  it("rejects unmatched epochs and exclusions", () => {
    const state = fromCase(vector.cases[2]!);
    expect(() =>
      encodeDurablePeerState({
        ...state,
        events: [{ ...state.events[0]!, priorEpoch: 2 }],
      }),
    ).toThrow("wrong admission epoch");
    expect(() => encodeDurablePeerState({ ...state, exclusions: [] })).toThrow("lacks exclusion");
  });

  it("replaces the whole ledger and base together, then restores them after reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "rhizomatic-durable-state-"));
    const path = join(dir, "peer.bin");
    try {
      expect(readDurablePeerState(path, "peer-A")).toBeUndefined();
      let expected: Uint8Array | null = null;
      for (const c of vector.cases.slice(0, 4)) {
        const state = fromCase(c);
        expect(writeDurablePeerState(path, state, expected)).toEqual({ status: "durable" });
        expect(readFileSync(path).toString("hex")).toBe(c.expectedHex);
        expect(readDurablePeerState(path, "peer-A")!.refusalCounter).toBe(c.refusalCounter);
        expected = readFileSync(path);
      }
      const before = readFileSync(path);
      const rollback = fromCase(vector.cases[3]!);
      expect(() => writeDurablePeerState(path, { ...rollback, quotaUsed: 0 }, before)).toThrow(
        "quota counter cannot shrink",
      );
      expect(readFileSync(path)).toEqual(before);
      expect(() => writeDurablePeerState(path, fromCase(vector.cases[2]!), before)).toThrow(
        "arrival history cannot shrink",
      );
      expect(readFileSync(path)).toEqual(before);
      writeFileSync(path, Uint8Array.of(0xff));
      expect(() => readDurablePeerState(path, "peer-A")).toThrow();
      expect(() => writeDurablePeerState(path, rollback, before)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a failed purge fault without dropping the refusal", () => {
    const dir = mkdtempSync(join(tmpdir(), "rhizomatic-purge-fault-"));
    const path = join(dir, "peer.bin");
    try {
      writeDurablePeerState(path, fromCase(vector.cases[2]!), null);
      writeDurablePeerState(path, fromCase(vector.cases[5]!), readFileSync(path));
      const restored = readDurablePeerState(path, "peer-A")!;
      expect(restored.obligations[0]).toMatchObject({ status: "failed", fault: "disk offline" });
      expect(restored.base.refusedIds.has(id("userRootDeclaration"))).toBe(true);
      expect(readFileSync(path).toString("hex")).toBe(vector.cases[5]!.expectedHex);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shared SPEC-6 permanent commit transitions", () => {
  for (const c of commits.cases) {
    it(c.name, () => {
      const before = fromCase(vector.cases[c.beforeCase]!);
      const after = planPermanentCommit(before, commitInput(c));
      expect(Buffer.from(encodeDurablePeerState(after)).toString("hex")).toBe(
        vector.cases[c.afterCase!]!.expectedHex,
      );
      const reversed = planPermanentCommit(before, {
        ...commitInput(c),
        additions: [...commitInput(c).additions].reverse(),
        erasures: [...commitInput(c).erasures].reverse(),
      });
      expect(encodeDurablePeerState(reversed)).toEqual(encodeDurablePeerState(after));
    });
  }
  for (const c of commits.invalidCases) {
    it(c.name, () => {
      expect(() =>
        planPermanentCommit(fromCase(vector.cases[c.beforeCase]!), commitInput(c)),
      ).toThrow(c.expected);
    });
  }
  it("rejects failed planning before touching durable bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "rhizomatic-commit-"));
    const path = join(dir, "peer.bin");
    try {
      const before = fromCase(vector.cases[2]!);
      writeDurablePeerState(path, before, null);
      const bytes = readFileSync(path);
      const invalid = commits.invalidCases[0]!;
      expect(() => planPermanentCommit(before, commitInput(invalid))).toThrow();
      expect(readFileSync(path)).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shared SPEC-6 durable writer transition vectors", () => {
  for (const c of writerVectors.cases) {
    it(c.name, () => {
      const dir = mkdtempSync(join(tmpdir(), "rhizomatic-writer-"));
      const path = join(dir, "peer.bin");
      try {
        const actual = fromCase(vector.cases[c.actualCase ?? c.beforeCase!]!);
        writeDurablePeerState(path, actual, null);
        const onDisk = readFileSync(path);
        if (c.outcome === "durable") {
          expect(
            writeDurablePeerState(path, fromCase(vector.cases[c.afterCase!]!), onDisk),
          ).toEqual({ status: "durable" });
          expect(readFileSync(path).toString("hex")).toBe(vector.cases[c.afterCase!]!.expectedHex);
          return;
        }
        let proposed: DurablePeerState;
        if (c.mutation === "quotaJump") proposed = { ...actual, quotaUsed: 5000 };
        else if (c.mutation === "heldOrderErasesUserRoot") {
          const targetId = id("userRootDeclaration");
          const orderId = id("operatorRootDeclaration");
          proposed = {
            ...actual,
            base: {
              ...actual.base,
              admitted: actual.base.admitted.filtered((d) => d.id !== targetId),
              refusedIds: new Set([...actual.base.refusedIds, targetId]),
            },
            refusalCounter: 1,
            obligationCounter: 1,
            events: [{ sequence: 1, targetId, orderIds: [orderId], priorEpoch: 1 }],
            exclusions: [{ orderId, targetId, eventSequence: 1, priorEpoch: 1 }],
            obligations: [
              {
                sequence: 1,
                targetId,
                generation: 1,
                eventSequence: 1,
                priorEpoch: 1,
                status: "pending",
              },
            ],
          };
        } else if (c.mutation === "coOfferedRefusedArrival") {
          const targetId = id("userRootDeclaration");
          const orderId = id("operatorRootDeclaration");
          const planned = planArrivals(
            actual.base.cursor,
            new Set(),
            [targetId, orderId],
            100,
            "peer-B",
          );
          const priorEpoch = planned.arrivals.find((row) => row.id === targetId)!.sequence;
          proposed = {
            ...actual,
            base: {
              ...actual.base,
              admitted: DeltaSet.from([named.get("operatorRootDeclaration")!]),
              cursor: { lastSequence: planned.lastSequence, lastTransfer: planned.lastTransfer },
              arrivals: planned.arrivals,
              refusedIds: new Set([targetId]),
            },
            quotaUsed: 1,
            refusalCounter: 1,
            obligationCounter: 1,
            events: [{ sequence: 1, targetId, orderIds: [orderId], priorEpoch }],
            exclusions: [{ orderId, targetId, eventSequence: 1, priorEpoch }],
            obligations: [
              {
                sequence: 1,
                targetId,
                generation: 1,
                eventSequence: 1,
                priorEpoch,
                status: "pending",
              },
            ],
          };
        } else if (c.mutation === "splitSameTransferTarget") {
          const targetId = id("userRootDeclaration");
          const first = id("operatorRootDeclaration");
          const second = id("bindingUserKey");
          const planned = planArrivals(
            actual.base.cursor,
            new Set(actual.base.admitted.ids()),
            [first, second],
            101,
            "peer-C",
          );
          proposed = {
            ...actual,
            base: {
              ...actual.base,
              admitted: DeltaSet.from([
                named.get("operatorRootDeclaration")!,
                named.get("bindingUserKey")!,
              ]),
              cursor: { lastSequence: planned.lastSequence, lastTransfer: planned.lastTransfer },
              arrivals: [...actual.base.arrivals, ...planned.arrivals],
              refusedIds: new Set([targetId]),
            },
            refusalCounter: 2,
            obligationCounter: 1,
            events: [
              { sequence: 1, targetId, orderIds: [first], priorEpoch: 1 },
              { sequence: 2, targetId, orderIds: [second], priorEpoch: 1 },
            ],
            exclusions: [
              { orderId: first, targetId, eventSequence: 1, priorEpoch: 1 },
              { orderId: second, targetId, eventSequence: 2, priorEpoch: 1 },
            ],
            obligations: [
              {
                sequence: 1,
                targetId,
                generation: 1,
                eventSequence: 2,
                priorEpoch: 1,
                status: "pending",
              },
            ],
          };
        } else if (c.mutation === "mixedOrderTransfers") {
          const targetId = id("userRootDeclaration");
          const first = id("operatorRootDeclaration");
          const second = id("bindingUserKey");
          const a = planArrivals(
            actual.base.cursor,
            new Set(actual.base.admitted.ids()),
            [first],
            101,
            "peer-C",
          );
          const b = planArrivals(
            { lastSequence: a.lastSequence, lastTransfer: a.lastTransfer },
            new Set([...actual.base.admitted.ids(), first]),
            [second],
            102,
            "peer-C",
          );
          proposed = {
            ...actual,
            base: {
              ...actual.base,
              admitted: DeltaSet.from([
                named.get("operatorRootDeclaration")!,
                named.get("bindingUserKey")!,
              ]),
              cursor: { lastSequence: b.lastSequence, lastTransfer: b.lastTransfer },
              arrivals: [...actual.base.arrivals, ...a.arrivals, ...b.arrivals],
              refusedIds: new Set([targetId]),
            },
            refusalCounter: 1,
            obligationCounter: 1,
            events: [{ sequence: 1, targetId, orderIds: [first, second].sort(), priorEpoch: 1 }],
            exclusions: [
              { orderId: first, targetId, eventSequence: 1, priorEpoch: 1 },
              { orderId: second, targetId, eventSequence: 1, priorEpoch: 1 },
            ],
            obligations: [
              {
                sequence: 1,
                targetId,
                generation: 1,
                eventSequence: 1,
                priorEpoch: 1,
                status: "pending",
              },
            ],
          };
        } else proposed = fromCase(vector.cases[c.proposedCase!]!);
        const expected =
          c.expectedCase === undefined
            ? c.actualCase === 0 && c.beforeCase === undefined
              ? null
              : onDisk
            : encodeDurablePeerState(fromCase(vector.cases[c.expectedCase]!));
        expect(() => writeDurablePeerState(path, proposed, expected)).toThrow(c.expected);
        expect(readFileSync(path)).toEqual(onDisk);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
