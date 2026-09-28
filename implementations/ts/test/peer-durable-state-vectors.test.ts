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
  readDurablePeerState,
  writeDurablePeerState,
  type DurablePeerState,
  type PurgeObligation,
} from "../src/federation/durable-state.js";
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
      for (const c of vector.cases.slice(0, 4)) {
        const state = fromCase(c);
        expect(writeDurablePeerState(path, state)).toEqual({ status: "durable" });
        expect(readFileSync(path).toString("hex")).toBe(c.expectedHex);
        expect(readDurablePeerState(path, "peer-A")!.refusalCounter).toBe(c.refusalCounter);
      }
      const before = readFileSync(path);
      const rollback = fromCase(vector.cases[3]!);
      expect(() => writeDurablePeerState(path, { ...rollback, quotaUsed: 0 })).toThrow(
        "quota counter cannot shrink",
      );
      expect(readFileSync(path)).toEqual(before);
      expect(() => writeDurablePeerState(path, fromCase(vector.cases[2]!))).toThrow(
        "arrival history cannot shrink",
      );
      expect(readFileSync(path)).toEqual(before);
      writeFileSync(path, Uint8Array.of(0xff));
      expect(() => readDurablePeerState(path, "peer-A")).toThrow();
      expect(() => writeDurablePeerState(path, rollback)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a failed purge fault without dropping the refusal", () => {
    const dir = mkdtempSync(join(tmpdir(), "rhizomatic-purge-fault-"));
    const path = join(dir, "peer.bin");
    try {
      writeDurablePeerState(path, fromCase(vector.cases[2]!));
      writeDurablePeerState(path, fromCase(vector.cases[5]!));
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
      writeDurablePeerState(path, before);
      const bytes = readFileSync(path);
      const invalid = commits.invalidCases[0]!;
      expect(() => planPermanentCommit(before, commitInput(invalid))).toThrow();
      expect(readFileSync(path)).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
