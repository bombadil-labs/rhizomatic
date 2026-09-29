import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/delta/json-profile.js";
import type { Delta } from "../src/delta/types.js";
import { encodeDurablePeerState } from "../src/federation/durable-state.js";
import {
  OrdinaryJournalPeer,
  type DurableOrdinaryJournalStore,
  type ErasureJournalWrite,
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
  conflictingOrder: { id: string; sig: string; claims: unknown };
  priorEffectiveOrderTarget: {
    order: { id: string; sig: string; claims: unknown };
    expectedStatuses: string[];
    reason: string;
    frameHex: string;
    head: string;
  };
  coofferedFilteredOrderTarget: {
    outerOrder: { id: string; sig: string; claims: unknown };
    expectedStatuses: string[];
    reason: string;
    frameHex: string;
    head: string;
  };
  coofferedErasureTestimonyTarget: {
    expectedStatuses: string[];
    reason: string;
    frameHex: string;
    head: string;
  };
  plainMisclassifiedOrder: {
    outerOrder: { id: string; sig: string; claims: unknown };
    expectedStatuses: string[];
    reason: string;
    frameHex: string;
    head: string;
  };
  heldTestimonyOrderTarget: { status: string; reason: string };
  conflictingSurfaceError: string;
  frames: Array<{ hex: string; head: string }>;
  pendingImageHex: string;
  removedImageHex: string;
  advance: { hex: string; head: string; imageHex: string; limitedStatus: string };
  mixed: {
    targetName: string;
    unrelatedName: string;
    hex: string;
    head: string;
    imageHex: string;
    expectedStatuses: string[];
  };
  rebase: {
    hex: string;
    head: string;
    purgedHex: string;
    purgedHead: string;
    settledHex: string;
    settledHead: string;
  };
  payloadProbe: {
    marker: string;
    targetId: string;
    secret: { id: string; sig: string; claims: unknown };
    order: { id: string; sig: string; claims: unknown };
    preErasureRebase: { beforeSecondRebase: string; afterSecondRebase: string };
  };
  degraded: { unavailableId: string; availableId: string; reason: string };
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
const conflictingOrder: Delta = {
  id: vector.conflictingOrder.id,
  sig: vector.conflictingOrder.sig,
  claims: parseClaims(vector.conflictingOrder.claims),
};
const unrelatedRow = evidence.deltas.find((row) => row.name === vector.mixed.unrelatedName)!;
const unrelated: Delta = {
  id: unrelatedRow.id,
  sig: unrelatedRow.sig!,
  claims: parseClaims(unrelatedRow.claims),
};
const thirdRow = evidence.deltas.find((row) => row.name === "bindingUserKey")!;
const third: Delta = {
  id: thirdRow.id,
  sig: thirdRow.sig!,
  claims: parseClaims(thirdRow.claims),
};

class MemoryStore implements DurableOrdinaryJournalStore {
  head: string | null = null;
  frames: Uint8Array[] = [];
  checkpoint: Uint8Array | undefined;
  rows = new Map<string, Delta>();
  async readJournal(): Promise<OrdinaryJournalRead> {
    if (this.head === null)
      return this.rows.size === 0 ? { status: "empty" } : { status: "rows-without-journal" };
    return {
      status: "journal",
      head: this.head,
      frames: this.frames.map((row) => Uint8Array.from(row)),
      ...(this.checkpoint === undefined ? {} : { checkpoint: Uint8Array.from(this.checkpoint) }),
    };
  }
  async readAdmittedRows(_peer: string, ids: readonly string[]): Promise<readonly Delta[]> {
    return ids.flatMap((id) => (this.rows.has(id) ? [structuredClone(this.rows.get(id)!)] : []));
  }
  async readAdmittedRowsDegraded(_peer: string, ids: readonly string[]) {
    return ids.map((id) => ({
      id,
      ...(this.rows.has(id)
        ? { row: structuredClone(this.rows.get(id)!) }
        : { fault: "missing row" }),
    }));
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
    if (this.head !== expected || (expected === null && this.rows.size > 0))
      return { status: "conflict" };
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
  ): Promise<ErasureJournalWrite> {
    const refuted = absentTargets.find((id) => this.rows.has(id));
    if (refuted !== undefined) return { status: "absence-refuted", targetId: refuted };
    return this.compareAndAppend(peer, expected, next, frame, rows);
  }
  async compareAndRebase(
    _peer: string,
    expected: string,
    next: string,
    checkpoint: Uint8Array,
  ): Promise<PeerImageWrite> {
    if (this.head !== expected) return { status: "conflict" };
    this.head = next;
    this.frames = [];
    this.checkpoint = Uint8Array.from(checkpoint);
    return { status: "durable" };
  }
  async compareAndSettlePurge(
    _peer: string,
    expected: string,
    next: string,
    frame: Uint8Array,
    target: string,
  ): Promise<ErasureJournalWrite> {
    if (this.head !== expected) return { status: "conflict" };
    if (this.rows.has(target)) return { status: "absence-refuted", targetId: target };
    this.head = next;
    this.frames.push(Uint8Array.from(frame));
    return { status: "durable" };
  }
}

describe("typed permanent journal erasure boundary", () => {
  it("keeps writes live while isolating one damaged admitted row from serving", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    await opened.peer.admit({
      offered: [held, unrelated],
      origin: { kind: "local" },
      arrivedAt: 100,
      policyState: {},
      guards: [],
      mode: "atomic",
      isErasureCandidate: () => false,
    });
    store.rows.set(held.id, { ...held, claims: unrelated.claims });
    await expect(OrdinaryJournalPeer.open(store, vector.peerId)).rejects.toThrow(
      "admitted row mismatch",
    );
    const degraded = await OrdinaryJournalPeer.open(store, vector.peerId, {
      allowDegraded: true,
    });
    if (degraded.status !== "degraded") throw new Error("expected degraded open");
    expect(degraded.unavailable).toEqual([
      {
        id: vector.degraded.unavailableId,
        reason: vector.degraded.reason,
      },
    ]);
    expect(degraded.peer.availableDeltas().ids()).toEqual([vector.degraded.availableId]);
    expect(degraded.peer.snapshot().base.admitted.has(held.id)).toBe(true);
    expect(
      (
        await degraded.peer.admit({
          offered: [third],
          origin: { kind: "local" },
          arrivedAt: 102,
          policyState: {},
          guards: [],
          mode: "atomic",
          isErasureCandidate: () => false,
        })
      ).status,
    ).toBe("committed");
    expect(degraded.peer.availableDeltas().ids()).toEqual([unrelated.id, third.id].sort());
    store.rows.set(held.id, held);
    const repaired = await OrdinaryJournalPeer.open(store, vector.peerId, {
      allowDegraded: true,
    });
    expect(repaired.status).toBe("open");
  });

  it("rebases away an erased payload before a purge can settle", async () => {
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
    await opened.peer.admitErasures({
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
    store.rows.delete(held.id);
    expect(await opened.peer.reportPurge(held.id, 1, { status: "removed" })).toEqual({
      status: "absence-refuted",
      targetId: held.id,
    });
    store.rows.set(held.id, held);
    expect(await opened.peer.rebase()).toEqual({ status: "durable" });
    expect(store.frames).toHaveLength(0);
    expect(Buffer.from(store.checkpoint!).toString("hex")).toBe(vector.rebase.hex);
    expect(opened.peer.currentHead()).toBe(vector.rebase.head);
    expect((await OrdinaryJournalPeer.open(store, vector.peerId)).status).toBe("open");
    expect(await opened.peer.reportPurge(held.id, 1, { status: "removed" })).toEqual({
      status: "absence-refuted",
      targetId: held.id,
    });
    store.rows.delete(held.id);
    expect(await opened.peer.reportPurge(held.id, 1, { status: "removed" })).toEqual({
      status: "committed",
      head: vector.rebase.purgedHead,
    });
    expect(Buffer.from(store.frames[0]!).toString("hex")).toBe(vector.rebase.purgedHex);
    expect(await opened.peer.rebase()).toEqual({ status: "durable" });
    expect(Buffer.from(store.checkpoint!).toString("hex")).toBe(vector.rebase.settledHex);
    expect(opened.peer.currentHead()).toBe(vector.rebase.settledHead);
    expect((await OrdinaryJournalPeer.open(store, vector.peerId)).status).toBe("open");
  });

  it("refuses an erasure of an effective order while admitting an unrelated delta", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    expect(
      (
        await peer.admit({
          offered: [held],
          origin: { kind: "local" },
          arrivedAt: 100,
          policyState: {},
          guards: [],
          mode: "atomic",
          isErasureCandidate: () => false,
        })
      ).status,
    ).toBe("committed");
    expect(
      (
        await peer.admitErasures({
          orders: [{ delta: order, targetId: held.id, surfaceHoldsBytes: true }],
          origin: { kind: "local" },
          arrivedAt: 101,
          policyState: {},
          guards: [],
          mode: "atomic",
          targetBudget: 1,
          advanceRefusalCap: 0,
          authorize: () => true,
        })
      ).status,
    ).toBe("committed");
    const second = vector.priorEffectiveOrderTarget.order;
    const result = await peer.admitErasures({
      orders: [
        {
          delta: { id: second.id, sig: second.sig, claims: parseClaims(second.claims) },
          targetId: order.id,
          surfaceHoldsBytes: true,
        },
      ],
      ordinary: [unrelated],
      origin: { kind: "local" },
      arrivedAt: 105,
      policyState: {},
      guards: [],
      mode: "individual",
      targetBudget: 1,
      advanceRefusalCap: 0,
      authorize: () => true,
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected commit");
    expect(result.outcomes.map((row) => row.status)).toEqual(
      vector.priorEffectiveOrderTarget.expectedStatuses,
    );
    expect(result.outcomes[0]?.reason).toBe(vector.priorEffectiveOrderTarget.reason);
    expect(result.arrivals.map((row) => row.id)).toEqual([unrelated.id]);
    expect(Buffer.from(store.frames[2]!).toString("hex")).toBe(
      vector.priorEffectiveOrderTarget.frameHex,
    );
    expect(result.head).toBe(vector.priorEffectiveOrderTarget.head);
    expect(peer.snapshot().base.refusedIds.has(order.id)).toBe(false);
    expect((await OrdinaryJournalPeer.open(store, vector.peerId)).status).toBe("open");
  });

  it("recognizes a co-offered order even after an earlier filter removes it", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    await peer.admit({
      offered: [held],
      origin: { kind: "local" },
      arrivedAt: 100,
      policyState: {},
      guards: [],
      mode: "atomic",
      isErasureCandidate: () => false,
    });
    await peer.admitErasures({
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
    const inner = vector.priorEffectiveOrderTarget.order;
    const outer = vector.coofferedFilteredOrderTarget.outerOrder;
    const result = await peer.admitErasures({
      orders: [
        {
          delta: { id: inner.id, sig: inner.sig, claims: parseClaims(inner.claims) },
          targetId: order.id,
          surfaceHoldsBytes: true,
        },
        {
          delta: { id: outer.id, sig: outer.sig, claims: parseClaims(outer.claims) },
          targetId: inner.id,
          surfaceHoldsBytes: false,
        },
      ],
      ordinary: [unrelated],
      origin: { kind: "local" },
      arrivedAt: 105,
      policyState: {},
      guards: [],
      mode: "individual",
      targetBudget: 1,
      advanceRefusalCap: 1,
      authorize: () => true,
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected commit");
    expect(result.outcomes.map((row) => row.status)).toEqual(
      vector.coofferedFilteredOrderTarget.expectedStatuses,
    );
    expect(result.outcomes[1]?.reason).toBe(vector.coofferedFilteredOrderTarget.reason);
    expect(Buffer.from(store.frames[2]!).toString("hex")).toBe(
      vector.coofferedFilteredOrderTarget.frameHex,
    );
    expect(result.head).toBe(vector.coofferedFilteredOrderTarget.head);
    expect(peer.snapshot().base.refusedIds.has(inner.id)).toBe(false);
  });

  it("does not erase an already held erasure-shaped testimony delta", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    expect(
      (
        await peer.admit({
          offered: [order],
          origin: { kind: "local" },
          arrivedAt: 101,
          policyState: {},
          guards: [],
          mode: "atomic",
          isErasureCandidate: () => false,
        })
      ).status,
    ).toBe("committed");
    const second = vector.priorEffectiveOrderTarget.order;
    const result = await peer.admitErasures({
      orders: [
        {
          delta: { id: second.id, sig: second.sig, claims: parseClaims(second.claims) },
          targetId: order.id,
          surfaceHoldsBytes: true,
        },
      ],
      origin: { kind: "local" },
      arrivedAt: 105,
      policyState: {},
      guards: [],
      mode: "individual",
      targetBudget: 1,
      advanceRefusalCap: 0,
      authorize: () => true,
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected no-op receipt");
    expect(result.outcomes[0]).toEqual({
      id: second.id,
      ...vector.heldTestimonyOrderTarget,
    });
    expect(store.frames).toHaveLength(1);
    expect(peer.snapshot().base.refusedIds.has(order.id)).toBe(false);
  });

  it("recognizes co-offered erasure-shaped ordinary testimony before exclusion", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    const second = vector.priorEffectiveOrderTarget.order;
    const result = await peer.admitErasures({
      orders: [
        {
          delta: { id: second.id, sig: second.sig, claims: parseClaims(second.claims) },
          targetId: order.id,
          surfaceHoldsBytes: false,
        },
      ],
      ordinary: [order, unrelated],
      origin: { kind: "local" },
      arrivedAt: 105,
      policyState: {},
      guards: [],
      mode: "individual",
      targetBudget: 1,
      advanceRefusalCap: 1,
      authorize: () => true,
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected commit");
    expect(result.outcomes.map((row) => row.status)).toEqual(
      vector.coofferedErasureTestimonyTarget.expectedStatuses,
    );
    expect(result.outcomes[0]?.reason).toBe(vector.coofferedErasureTestimonyTarget.reason);
    expect(Buffer.from(store.frames[0]!).toString("hex")).toBe(
      vector.coofferedErasureTestimonyTarget.frameHex,
    );
    expect(result.head).toBe(vector.coofferedErasureTestimonyTarget.head);
    expect(peer.snapshot().base.refusedIds.has(order.id)).toBe(false);
  });

  it("does not treat a misclassified plain delta as an erasure target blocker", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    const outer = vector.plainMisclassifiedOrder.outerOrder;
    const result = await peer.admitErasures({
      orders: [
        { delta: unrelated, targetId: held.id, surfaceHoldsBytes: false },
        {
          delta: { id: outer.id, sig: outer.sig, claims: parseClaims(outer.claims) },
          targetId: unrelated.id,
          surfaceHoldsBytes: false,
        },
      ],
      origin: { kind: "local" },
      arrivedAt: 107,
      policyState: {},
      guards: [],
      mode: "individual",
      targetBudget: 1,
      advanceRefusalCap: 1,
      authorize: () => true,
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected commit");
    expect(result.outcomes.map((row) => row.status)).toEqual(
      vector.plainMisclassifiedOrder.expectedStatuses,
    );
    expect(result.outcomes[0]?.reason).toBe(vector.plainMisclassifiedOrder.reason);
    expect(Buffer.from(store.frames[0]!).toString("hex")).toBe(
      vector.plainMisclassifiedOrder.frameHex,
    );
    expect(result.head).toBe(vector.plainMisclassifiedOrder.head);
    expect(peer.snapshot().base.refusedIds.has(unrelated.id)).toBe(true);
  });

  it("keeps purge owed when the last rebase still carried the target", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    const secret: Delta = {
      id: vector.payloadProbe.secret.id,
      sig: vector.payloadProbe.secret.sig,
      claims: parseClaims(vector.payloadProbe.secret.claims),
    };
    const secretOrder: Delta = {
      id: vector.payloadProbe.order.id,
      sig: vector.payloadProbe.order.sig,
      claims: parseClaims(vector.payloadProbe.order.claims),
    };
    expect(
      (
        await peer.admit({
          offered: [secret],
          origin: { kind: "local" },
          arrivedAt: 100,
          policyState: {},
          guards: [],
          mode: "atomic",
          isErasureCandidate: () => false,
        })
      ).status,
    ).toBe("committed");
    const erasure = (delta: Delta, targetId: string, surfaceHoldsBytes: boolean, at: number) =>
      peer.admitErasures({
        orders: [{ delta, targetId, surfaceHoldsBytes }],
        origin: { kind: "local" },
        arrivedAt: at,
        policyState: {},
        guards: [],
        mode: "atomic" as const,
        targetBudget: 1,
        advanceRefusalCap: 1,
        authorize: () => true,
      });
    expect((await erasure(order, held.id, false, 101)).status).toBe("committed");
    expect(await peer.rebase()).toEqual({ status: "durable" });
    expect(Buffer.from(store.checkpoint!).includes(vector.payloadProbe.marker)).toBe(true);
    expect((await erasure(secretOrder, secret.id, true, 111)).status).toBe("committed");
    store.rows.delete(secret.id);
    expect((await peer.reportPurge(secret.id, 1, { status: "removed" })).status).toBe(
      vector.payloadProbe.preErasureRebase.beforeSecondRebase,
    );
    const reopened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (reopened.status !== "open") throw new Error("expected reopen");
    expect((await reopened.peer.reportPurge(secret.id, 1, { status: "removed" })).status).toBe(
      vector.payloadProbe.preErasureRebase.beforeSecondRebase,
    );
    expect(await reopened.peer.rebase()).toEqual({ status: "durable" });
    expect(Buffer.from(store.checkpoint!).includes(vector.payloadProbe.marker)).toBe(false);
    const afterSecondRebase = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (afterSecondRebase.status !== "open") throw new Error("expected second reopen");
    expect(
      (await afterSecondRebase.peer.reportPurge(secret.id, 1, { status: "removed" })).status,
    ).toBe(vector.payloadProbe.preErasureRebase.afterSecondRebase);
  });

  it("rejects conflicting facts for one target before budget accounting", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    await expect(
      opened.peer.admitErasures({
        orders: [
          { delta: order, targetId: held.id, surfaceHoldsBytes: false },
          { delta: conflictingOrder, targetId: held.id, surfaceHoldsBytes: true },
        ],
        origin: { kind: "local" },
        arrivedAt: 104,
        policyState: {},
        guards: [],
        mode: "individual",
        targetBudget: 1,
        advanceRefusalCap: 0,
        authorize: () => true,
      }),
    ).rejects.toThrow(vector.conflictingSurfaceError);
    expect(store.frames).toHaveLength(0);
  });

  it("distinguishes a storage-refuted absence from a head conflict", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    store.rows.set(held.id, held); // A physical row outside the peer image.
    const result = await opened.peer.admitErasures({
      orders: [{ delta: order, targetId: held.id, surfaceHoldsBytes: false }],
      origin: { kind: "local" },
      arrivedAt: 101,
      policyState: {},
      guards: [],
      mode: "atomic",
      targetBudget: 1,
      advanceRefusalCap: 1,
      authorize: () => true,
    });
    expect(result).toEqual({ status: "absence-refuted", targetId: held.id });
    expect(opened.peer.currentHead()).toBe("");
    expect(store.frames).toHaveLength(0);
  });

  it("excludes a co-offered target before ordinary quota in one individual transfer", async () => {
    const store = new MemoryStore();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const result = await opened.peer.admitErasures({
      orders: [{ delta: order, targetId: held.id, surfaceHoldsBytes: false }],
      ordinary: [held, unrelated],
      capacity: 1,
      origin: { kind: "unattributed" },
      arrivedAt: 102,
      policyState: {},
      guards: [],
      mode: "individual",
      targetBudget: 1,
      advanceRefusalCap: 0,
      authorize: () => true,
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected commit");
    expect(result.outcomes.map((row) => row.status)).toEqual(vector.mixed.expectedStatuses);
    expect(result.arrivals.map((row) => row.id)).toEqual([order.id, unrelated.id].sort());
    expect(Buffer.from(store.frames[0]!).toString("hex")).toBe(vector.mixed.hex);
    expect(Buffer.from(encodeDurablePeerState(opened.peer.snapshot())).toString("hex")).toBe(
      vector.mixed.imageHex,
    );
    expect((await OrdinaryJournalPeer.open(store, vector.peerId)).status).toBe("open");
  });

  it("keeps purge debt pending when the row is gone but the old frame still holds payload", async () => {
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
      status: "absence-refuted",
      targetId: held.id,
    });
    expect(reopened.peer.snapshot().obligations[0]?.status).toBe("pending");
    store.rows.delete(held.id);
    const recovered = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (recovered.status !== "open") throw new Error("expected reopen");
    expect(await recovered.peer.reportPurge(held.id, 1, { status: "removed" })).toEqual({
      status: "absence-refuted",
      targetId: held.id,
    });
    expect(store.frames).toHaveLength(2);
    expect(Buffer.from(encodeDurablePeerState(recovered.peer.snapshot())).toString("hex")).toBe(
      vector.pendingImageHex,
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
    expect(result.status).toBe("rejected");
    expect(store.frames).toHaveLength(1);
    expect(opened.peer.snapshot().base.admitted.has(held.id)).toBe(true);
  });
});
