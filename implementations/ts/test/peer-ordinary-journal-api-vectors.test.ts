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
    fileURLToPath(new URL("../../../vectors/peer/ordinary-journal.json", import.meta.url)),
    "utf8",
  ),
) as {
  peerId: string;
  firstName: string;
  secondName: string;
  frames: Array<{ at: number; sender: string; prior: string; hex: string; head: string }>;
  expectedImageHex: string;
  checkpoint: { hex: string };
  api: {
    emptyHead: string;
    noOpWrites: number;
    rowsWithoutJournal: string;
    guardReason: string;
    rowMismatchError: string;
  };
};
const evidence = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/principal/evidence.json", import.meta.url)),
    "utf8",
  ),
) as { deltas: Array<{ name: string; id: string; sig?: string; claims: unknown }> };
const named = new Map<string, Delta>(
  evidence.deltas.map((row) => [
    row.name,
    { id: row.id, claims: parseClaims(row.claims), ...(row.sig ? { sig: row.sig } : {}) },
  ]),
);
const first = named.get(vector.firstName)!;
const second = named.get(vector.secondName)!;

class MemoryJournal implements DurableOrdinaryJournalStore {
  head: string | null = null;
  frames: Uint8Array[] = [];
  checkpointBytes?: Uint8Array;
  rows = new Map<string, Delta>();
  writes = 0;
  next: PeerImageWrite = { status: "durable" };

  async readJournal(): Promise<OrdinaryJournalRead> {
    if (this.head === null)
      return this.rows.size ? { status: "rows-without-journal" } : { status: "empty" };
    return {
      status: "journal",
      head: this.head,
      frames: this.frames.map((f) => Uint8Array.from(f)),
      ...(this.checkpointBytes === undefined
        ? {}
        : { checkpoint: Uint8Array.from(this.checkpointBytes) }),
    };
  }
  async readAdmittedRows(_peer: string, ids: readonly string[]): Promise<readonly Delta[]> {
    return ids.flatMap((id) => {
      const row = this.rows.get(id);
      return row === undefined ? [] : [structuredClone(row)];
    });
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
    this.writes++;
    if (
      this.head !== expected ||
      (expected === null && this.rows.size) ||
      this.next.status === "conflict"
    )
      return { status: "conflict" };
    this.head = next;
    if (frame !== null) this.frames.push(Uint8Array.from(frame));
    for (const row of rows) this.rows.set(row.id, structuredClone(row));
    return this.next;
  }
  async compareAndCheckpoint(
    _peer: string,
    expected: string,
    checkpoint: Uint8Array,
  ): Promise<PeerImageWrite> {
    if (this.head !== expected || this.next.status === "conflict") return { status: "conflict" };
    this.checkpointBytes = Uint8Array.from(checkpoint);
    this.frames = [];
    return this.next;
  }
}
const base = {
  policyState: {},
  guards: [],
  isErasureCandidate: () => false,
  mode: "atomic" as const,
};

describe("shared SPEC-6 typed ordinary journal API", () => {
  it("initializes, appends, skips no-op, and reopens the same durable image", async () => {
    const store = new MemoryJournal();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    expect(opened.status).toBe("open");
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    expect(peer.currentHead()).toBe(vector.api.emptyHead);
    let result = await peer.admit({
      ...base,
      offered: [first],
      origin: { kind: "local" },
      arrivedAt: vector.frames[0]!.at,
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected commit");
    expect(result.head).toBe(vector.frames[0]!.head);
    expect(Buffer.from(store.frames[0]!).toString("hex")).toBe(vector.frames[0]!.hex);
    const writes = store.writes;
    result = await peer.admit({
      ...base,
      offered: [first],
      origin: { kind: "local" },
      arrivedAt: 100,
    });
    expect(result.status).toBe("committed");
    expect(store.writes - writes).toBe(vector.api.noOpWrites);
    result = await peer.admit({
      ...base,
      offered: [second],
      origin: { kind: "unattributed" },
      arrivedAt: vector.frames[1]!.at,
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected commit");
    expect(result.head).toBe(vector.frames[1]!.head);
    expect(Buffer.from(store.frames[1]!).toString("hex")).toBe(vector.frames[1]!.hex);
    expect(result.arrivals[0]?.transfer).toBe(2);
    expect(Buffer.from(encodeDurablePeerState(peer.snapshot())).toString("hex")).toBe(
      vector.expectedImageHex,
    );
    const reopened = await OrdinaryJournalPeer.open(store, vector.peerId);
    expect(reopened.status).toBe("open");
    if (reopened.status !== "open") throw new Error("expected reopen");
    expect(Buffer.from(encodeDurablePeerState(reopened.peer.snapshot())).toString("hex")).toBe(
      vector.expectedImageHex,
    );
    expect(store.rows.size).toBe(2);
  });

  it("atomically checkpoints a verified prefix and reopens from the boundary", async () => {
    const store = new MemoryJournal();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const peer = opened.peer;
    await peer.admit({ ...base, offered: [first], origin: { kind: "local" }, arrivedAt: 100 });
    expect(await peer.checkpoint()).toEqual({ status: "durable" });
    expect(store.frames).toHaveLength(0);
    expect(Buffer.from(store.checkpointBytes!).toString("hex")).toBe(vector.checkpoint.hex);
    await peer.admit({
      ...base,
      offered: [second],
      origin: { kind: "unattributed" },
      arrivedAt: 100,
    });
    expect(store.frames).toHaveLength(1);
    const reopened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (reopened.status !== "open") throw new Error("expected reopen");
    expect(Buffer.from(encodeDurablePeerState(reopened.peer.snapshot())).toString("hex")).toBe(
      vector.expectedImageHex,
    );
    store.head = vector.frames[0]!.head;
    expect(await peer.checkpoint()).toEqual({ status: "conflict" });
    expect(() => peer.snapshot()).toThrow("ordinary journal: reopen required");
  });

  it("fails closed on rows without a journal, conflict, and uncertain commit", async () => {
    const legacy = new MemoryJournal();
    legacy.rows.set(first.id, first);
    expect((await OrdinaryJournalPeer.open(legacy, vector.peerId)).status).toBe(
      vector.api.rowsWithoutJournal,
    );
    const store = new MemoryJournal();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    store.head = vector.frames[0]!.head;
    expect(
      (
        await opened.peer.admit({
          ...base,
          offered: [first],
          origin: { kind: "local" },
          arrivedAt: 100,
        })
      ).status,
    ).toBe("conflict");
    expect(() => opened.peer.snapshot()).toThrow("reopen required");
    const uncertain = new MemoryJournal();
    const active = await OrdinaryJournalPeer.open(uncertain, vector.peerId);
    if (active.status !== "open") throw new Error("expected open");
    uncertain.next = { status: "committed-unconfirmed", fault: "sync uncertain" };
    expect(
      (
        await active.peer.admit({
          ...base,
          offered: [first],
          origin: { kind: "local" },
          arrivedAt: 100,
        })
      ).status,
    ).toBe("committed-unconfirmed");
    expect(() => active.peer.currentHead()).toThrow("reopen required");
    const recovered = await OrdinaryJournalPeer.open(uncertain, vector.peerId);
    expect(recovered.status).toBe("open");
    if (recovered.status !== "open") throw new Error("expected recovery");
    expect(recovered.peer.snapshot().base.admitted.has(first.id)).toBe(true);
    uncertain.rows.delete(first.id);
    await expect(OrdinaryJournalPeer.open(uncertain, vector.peerId)).rejects.toThrow(
      vector.api.rowMismatchError,
    );
    uncertain.rows.set(first.id, {
      ...first,
      claims: { ...first.claims, timestamp: first.claims.timestamp + 1 },
    });
    await expect(OrdinaryJournalPeer.open(uncertain, vector.peerId)).rejects.toThrow(
      vector.api.rowMismatchError,
    );
    uncertain.rows.set(first.id, { ...first, sig: "00" });
    await expect(OrdinaryJournalPeer.open(uncertain, vector.peerId)).rejects.toThrow(
      vector.api.rowMismatchError,
    );
  });

  it("keeps atomic rejection and individual refusal reasons out of the journal", async () => {
    const store = new MemoryJournal();
    const opened = await OrdinaryJournalPeer.open(store, vector.peerId);
    if (opened.status !== "open") throw new Error("expected open");
    const guarded = {
      ...base,
      offered: [first, second],
      origin: { kind: "local" as const },
      arrivedAt: 100,
      guards: [
        ({ candidate }: { candidate: Delta }) =>
          candidate.id === second.id
            ? { ok: false as const, reason: vector.api.guardReason }
            : { ok: true as const },
      ],
    };
    const writes = store.writes;
    const atomic = await opened.peer.admit(guarded);
    expect(atomic.status).toBe("rejected");
    if (atomic.status !== "rejected") throw new Error("expected rejection");
    expect(atomic.reason).toBe(vector.api.guardReason);
    expect(store.writes).toBe(writes);
    const individual = await opened.peer.admit({ ...guarded, mode: "individual" });
    expect(individual.status).toBe("committed");
    if (individual.status !== "committed") throw new Error("expected commit");
    expect(individual.outcomes.map((row) => row.status)).toEqual(["admitted", "guard-rejected"]);
    expect(individual.outcomes[1]?.reason).toBe(vector.api.guardReason);
    expect(store.frames).toHaveLength(1);
    expect(store.rows.size).toBe(1);
  });
});
