import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/delta/json-profile.js";
import type { Delta } from "../src/delta/types.js";
import { encodeDurablePeerState } from "../src/federation/durable-state.js";
import {
  OrdinaryJournalPeer,
  type DurableOrdinaryJournalStore,
  type OrdinaryJournalHead,
  type OrdinaryJournalRead,
} from "../src/federation/ordinary-journal-peer.js";
import type { PeerImageWrite } from "../src/federation/single-peer.js";

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/peer/permanent-journal.json", import.meta.url)),
    "utf8",
  ),
) as {
  peerId: string;
  order: { id: string; sig: string; claims: unknown };
  frames: Array<{ hex: string; head: string }>;
  pendingImageHex: string;
  removedImageHex: string;
  advance: { hex: string; head: string; imageHex: string; limitedStatus: string };
  expected: { refusedTarget: string };
};
const evidence = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/principal/evidence.json", import.meta.url)),
    "utf8",
  ),
) as { deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }> };
const heldRow = evidence.deltas.find((row) => row.name === "userRootDeclaration")!;
const held: Delta = { id: heldRow.id, sig: heldRow.sig!, claims: parseClaims(heldRow.claims) };
const order: Delta = {
  id: vector.order.id,
  sig: vector.order.sig,
  claims: parseClaims(vector.order.claims),
};

class MemoryStore implements DurableOrdinaryJournalStore {
  head: string | null = null;
  frames: Uint8Array[] = [];
  rows = new Map<string, Delta>();
  async readJournal(): Promise<OrdinaryJournalRead> {
    if (this.head === null) return { status: "empty" };
    return {
      status: "journal",
      head: this.head,
      frames: this.frames.map((row) => Uint8Array.from(row)),
    };
  }
  async readAdmittedRows(_peer: string, ids: readonly string[]): Promise<readonly Delta[]> {
    return ids.flatMap((id) => (this.rows.has(id) ? [structuredClone(this.rows.get(id)!)] : []));
  }
  async readHead(): Promise<OrdinaryJournalHead> {
    return this.head === null ? { status: "missing" } : { status: "head", head: this.head };
  }
  async compareAndAppend(
    _peer: string,
    expected: string | null,
    next: string,
    frame: Uint8Array | null,
    rows: readonly Delta[],
  ): Promise<PeerImageWrite> {
    if (this.head !== expected) return { status: "conflict" };
    this.head = next;
    if (frame !== null) this.frames.push(Uint8Array.from(frame));
    for (const row of rows) this.rows.set(row.id, structuredClone(row));
    return { status: "durable" };
  }
  async compareAndAppendErasure(
    peer: string,
    expected: string,
    next: string,
    frame: Uint8Array,
    rows: readonly Delta[],
    absentTargets: readonly string[],
  ): Promise<PeerImageWrite> {
    if (absentTargets.some((id) => this.rows.has(id))) return { status: "conflict" };
    return this.compareAndAppend(peer, expected, next, frame, rows);
  }
  async compareAndSettlePurge(
    _peer: string,
    expected: string,
    next: string,
    frame: Uint8Array,
    target: string,
  ): Promise<PeerImageWrite> {
    if (this.head !== expected || this.rows.has(target)) return { status: "conflict" };
    this.head = next;
    this.frames.push(Uint8Array.from(frame));
    return { status: "durable" };
  }
}

describe("typed permanent journal erasure boundary", () => {
  it("commits refusal and debt, reopens without erased row, then settles only after physical absence", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    const ordinary = await peer.admit({
      offered: [held],
      origin: { kind: "local" },
      arrivedAt: 100,
      policyState: {},
      guards: [],
      mode: "atomic",
      isErasureCandidate: () => false,
    });
    expect(ordinary.status).toBe("committed");
    expect(Buffer.from(store.frames[0]!).toString("hex")).toBe(vector.frames[0]!.hex);
    const erased = await peer.admitErasures({
      orders: [{ delta: order, targetId: held.id, surfaceHoldsBytes: true }],
      origin: { kind: "local" },
      arrivedAt: 101,
      policyState: {},
      guards: [],
      mode: "atomic",
      targetBudget: 1,
      advanceRefusalCap: 0,
      authorize: () => true,
    });
    expect(erased.status).toBe("committed");
    if (erased.status !== "committed") throw new Error("expected erasure commit");
    expect(erased.outcomes[0]?.status).toBe("effective-erasure");
    expect(Buffer.from(store.frames[1]!).toString("hex")).toBe(vector.frames[1]!.hex);
    expect(Buffer.from(encodeDurablePeerState(peer.snapshot())).toString("hex")).toBe(
      vector.pendingImageHex,
    );
    const reopened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (reopened.status !== "open") throw new Error("expected reopen");
    expect(reopened.peer.snapshot().obligations[0]?.status).toBe("pending");
    expect(await reopened.peer.reportPurge(held.id, 1, { status: "removed" })).toEqual({
      status: "conflict",
    });
    expect(() => reopened.peer.snapshot()).toThrow("reopen required");
    store.rows.delete(held.id);
    const recovered = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (recovered.status !== "open") throw new Error("expected reopen");
    expect(await recovered.peer.reportPurge(held.id, 1, { status: "removed" })).toEqual({
      status: "committed",
      head: vector.frames[2]!.head,
    });
    expect(Buffer.from(store.frames[2]!).toString("hex")).toBe(vector.frames[2]!.hex);
    expect(Buffer.from(encodeDurablePeerState(recovered.peer.snapshot())).toString("hex")).toBe(
      vector.removedImageHex,
    );
  });

  it("refuses invalid signed target and does not persist an atomic mixed decision", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    const result = await peer.admitErasures({
      orders: [{ delta: order, targetId: order.id, surfaceHoldsBytes: false }],
      origin: { kind: "local" },
      arrivedAt: 101,
      policyState: {},
      guards: [],
      mode: "atomic",
      targetBudget: 1,
      advanceRefusalCap: 1,
      authorize: () => true,
    });
    expect(result.status).toBe("rejected");
    expect(store.frames).toHaveLength(0);
  });

  it("bounds advance refusals without turning a skipped order into testimony", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    const input = {
      orders: [{ delta: order, targetId: held.id, surfaceHoldsBytes: false }],
      origin: { kind: "local" as const },
      arrivedAt: 101,
      policyState: {},
      guards: [],
      mode: "individual" as const,
      targetBudget: 1,
      authorize: () => true,
    };
    const limited = await peer.admitErasures({ ...input, advanceRefusalCap: 0 });
    expect(limited.status).toBe("committed");
    if (limited.status !== "committed") throw new Error("expected no-op receipt");
    expect(limited.outcomes[0]?.status).toBe(vector.advance.limitedStatus);
    expect(store.frames).toHaveLength(0);
    const admitted = await peer.admitErasures({ ...input, advanceRefusalCap: 1 });
    expect(admitted.status).toBe("committed");
    expect(Buffer.from(store.frames[0]!).toString("hex")).toBe(vector.advance.hex);
    expect(Buffer.from(encodeDurablePeerState(peer.snapshot())).toString("hex")).toBe(
      vector.advance.imageHex,
    );
    expect(peer.snapshot().obligations).toHaveLength(0);
    expect((await OrdinaryJournalPeer.open(store, vector.peerId)).status).toBe("open");
  });

  it("refuses a false physical-absence assertion in the append CAS", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    await opened.peer.admit({
      offered: [held],
      origin: { kind: "local" },
      arrivedAt: 100,
      policyState: {},
      guards: [],
      mode: "atomic",
      isErasureCandidate: () => false,
    });
    const result = await opened.peer.admitErasures({
      orders: [{ delta: order, targetId: held.id, surfaceHoldsBytes: false }],
      origin: { kind: "local" },
      arrivedAt: 101,
      policyState: {},
      guards: [],
      mode: "atomic",
      targetBudget: 1,
      advanceRefusalCap: 0,
      authorize: () => true,
    });
    expect(result.status).toBe("conflict");
    expect(store.frames).toHaveLength(1);
    expect(() => opened.peer.snapshot()).toThrow("reopen required");
  });
});
