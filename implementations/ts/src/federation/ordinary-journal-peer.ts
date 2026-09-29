// Typed signed-loose ordinary admission over an atomic append journal.
import type { Delta } from "../delta/types.js";
import { computeId } from "../delta/delta.js";
import { DeltaSet } from "../delta/set.js";
import { contentAddress } from "../delta/hash.js";
import { claimsToJson, parseClaims } from "../delta/json-profile.js";
import { emptyDurablePeerState, type DurablePeerState } from "./durable-state.js";
import { isCanonicalPeerId } from "./peer-identity.js";
import {
  encodeOrdinaryJournalCheckpoint,
  encodeOrdinaryPeerFrame,
  replayOrdinaryPeerFrames,
} from "./ordinary-journal.js";
import {
  planSignedLooseOrdinaryTransferFromVerified,
  type SignedLooseOutcome,
} from "./signed-loose-admission.js";
import type { ArrivalOrigin, PeerImageWrite, SinglePeerTransferInput } from "./single-peer.js";
import type { ArrivalRecord } from "./arrival.js";

export type OrdinaryJournalRead =
  | { readonly status: "empty" }
  | { readonly status: "rows-without-journal" }
  | {
      readonly status: "journal";
      readonly head: string;
      readonly frames: readonly Uint8Array[];
      readonly checkpoint?: Uint8Array;
    };

export type OrdinaryJournalHead =
  | { readonly status: "head"; readonly head: string }
  | { readonly status: "missing" };

/** Consistent open, immutable committed frames, cheap head read, atomic head/frame/row CAS. */
export interface DurableOrdinaryJournalStore {
  readJournal(peerId: string): Promise<OrdinaryJournalRead>;
  /** Return exactly the stored rows for these admitted ids; extras outside the list stay external. */
  readAdmittedRows(peerId: string, ids: readonly string[]): Promise<readonly Delta[]>;
  readHead(peerId: string): Promise<OrdinaryJournalHead>;
  compareAndAppend(
    peerId: string,
    expectedHead: string | null,
    nextHead: string,
    frame: Uint8Array | null,
    newlyAdmitted: readonly Delta[],
  ): Promise<PeerImageWrite>;
  /** Atomically replace a verified frame prefix at expectedHead; keep admitted rows and head. */
  compareAndCheckpoint?(
    peerId: string,
    expectedHead: string,
    checkpoint: Uint8Array,
  ): Promise<PeerImageWrite>;
}

export type OrdinaryJournalOpenResult =
  | { readonly status: "open"; readonly peer: OrdinaryJournalPeer }
  | { readonly status: "rows-without-journal" }
  | { readonly status: "conflict" }
  | { readonly status: "committed-unconfirmed"; readonly fault: string };

export type OrdinaryJournalAdmissionResult =
  | {
      readonly status: "committed";
      readonly outcomes: readonly SignedLooseOutcome[];
      readonly arrivals: readonly ArrivalRecord[];
      readonly head: string;
    }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly outcomes: readonly SignedLooseOutcome[];
    }
  | { readonly status: "conflict" }
  | { readonly status: "committed-unconfirmed"; readonly fault: string };

function sender(origin: ArrivalOrigin, receivingPeerId: string): string {
  if (origin.kind === "local") return "local";
  if (origin.kind === "unattributed") return "unattributed";
  if (!isCanonicalPeerId(origin.peerId)) throw new Error("ordinary journal: invalid sender");
  if (origin.peerId === receivingPeerId)
    throw new Error("ordinary journal: authenticated sender is receiving peer");
  return origin.peerId;
}

function plainDelta(delta: Delta): Delta {
  return {
    id: delta.id,
    claims: parseClaims(claimsToJson(delta.claims)),
    ...(delta.sig === undefined ? {} : { sig: delta.sig }),
  };
}

function copyState(state: DurablePeerState): DurablePeerState {
  return {
    ...state,
    base: {
      ...state.base,
      admitted: DeltaSet.from([...state.base.admitted].map((delta) => structuredClone(delta))),
      cursor: { ...state.base.cursor },
      arrivals: state.base.arrivals.map((row) => ({ ...row })),
      refusedIds: new Set(state.base.refusedIds),
    },
    events: state.events.map((row) => ({ ...row, orderIds: [...row.orderIds] })),
    exclusions: state.exclusions.map((row) => ({ ...row })),
    obligations: state.obligations.map((row) => ({ ...row })),
  };
}

function assertAdmittedRows(state: DurablePeerState, rows: readonly Delta[]): void {
  if (rows.length !== state.base.admitted.size)
    throw new Error("ordinary journal: admitted row mismatch");
  const seen = new Set<string>();
  for (const row of rows) {
    const expected = state.base.admitted.get(row.id);
    if (expected === undefined || seen.has(row.id) || row.sig !== expected.sig)
      throw new Error("ordinary journal: admitted row mismatch");
    try {
      if (computeId(row.claims) !== row.id)
        throw new Error("ordinary journal: admitted row mismatch");
    } catch {
      throw new Error("ordinary journal: admitted row mismatch");
    }
    seen.add(row.id);
  }
}

/** A verified in-memory projection of one durable ordinary journal head. */
export class OrdinaryJournalPeer {
  private live = true;
  private constructor(
    private readonly store: DurableOrdinaryJournalStore,
    readonly peerId: string,
    private state: DurablePeerState,
    private head: string,
  ) {}

  static async open(
    store: DurableOrdinaryJournalStore,
    peerId: string,
  ): Promise<OrdinaryJournalOpenResult> {
    if (!isCanonicalPeerId(peerId)) throw new Error("ordinary journal: invalid peer id");
    const current = await store.readJournal(peerId);
    if (current.status === "rows-without-journal") return current;
    if (current.status === "journal") {
      const state = replayOrdinaryPeerFrames(
        peerId,
        current.frames,
        current.head,
        current.checkpoint,
      );
      assertAdmittedRows(state, await store.readAdmittedRows(peerId, state.base.admitted.ids()));
      return { status: "open", peer: new OrdinaryJournalPeer(store, peerId, state, current.head) };
    }
    const write = await store.compareAndAppend(peerId, null, "", null, []);
    if (write.status !== "durable") return write;
    return {
      status: "open",
      peer: new OrdinaryJournalPeer(store, peerId, emptyDurablePeerState(peerId), ""),
    };
  }

  /** Copy the verified projection for a reader; append receipts avoid this O(history) copy. */
  snapshot(): DurablePeerState {
    if (!this.live) throw new Error("ordinary journal: reopen required");
    return copyState(this.state);
  }

  currentHead(): string {
    if (!this.live) throw new Error("ordinary journal: reopen required");
    return this.head;
  }

  /** Compact a verified prefix; conflict or uncertain durability requires reopen. */
  async checkpoint(): Promise<PeerImageWrite> {
    if (!this.live) throw new Error("ordinary journal: reopen required");
    if (this.store.compareAndCheckpoint === undefined)
      throw new Error("ordinary journal: checkpoint unsupported by store");
    const checkpoint = encodeOrdinaryJournalCheckpoint({
      peerId: this.peerId,
      head: this.head,
      state: this.state,
    });
    const result = await this.store.compareAndCheckpoint(this.peerId, this.head, checkpoint);
    if (result.status !== "durable") this.live = false;
    return result;
  }

  /** Caller serializes writers for this peer. Conflicts and uncertain commits require reopen. */
  async admit<State>(
    input: SinglePeerTransferInput<State>,
  ): Promise<OrdinaryJournalAdmissionResult> {
    if (!this.live) throw new Error("ordinary journal: reopen required");
    const current = await this.store.readHead(this.peerId);
    if (current.status !== "head" || current.head !== this.head) {
      this.live = false;
      return { status: "conflict" };
    }
    const origin = sender(input.origin, this.peerId);
    const plan = planSignedLooseOrdinaryTransferFromVerified(this.state, {
      offered: input.offered,
      sendingPeerId: origin,
      arrivedAt: input.arrivedAt,
      capacity: input.capacity ?? Number.MAX_SAFE_INTEGER,
      policyState: input.policyState,
      guards: input.guards,
      isErasureCandidate: input.isErasureCandidate,
    });
    if (input.mode === "atomic") {
      const failed = plan.outcomes.find(
        (outcome) => !["admitted", "duplicate"].includes(outcome.status),
      );
      if (failed !== undefined)
        return {
          status: "rejected",
          reason: failed.reason ?? failed.status,
          outcomes: plan.outcomes,
        };
    }
    if (plan.admittedIds.length === 0)
      return { status: "committed", outcomes: plan.outcomes, arrivals: [], head: this.head };
    const arrivals = plan.state.base.arrivals.slice(this.state.base.arrivals.length);
    const ids = [...plan.admittedIds].sort();
    if (
      arrivals.length !== ids.length ||
      arrivals.some(
        (row, i) =>
          row.id !== ids[i] ||
          row.sequence !== this.state.base.cursor.lastSequence + i + 1 ||
          row.transfer !== this.state.base.cursor.lastTransfer + 1 ||
          row.sender !== origin ||
          row.at !== input.arrivedAt,
      ) ||
      plan.state.quotaUsed !== this.state.quotaUsed + ids.length
    )
      throw new Error("ordinary journal: planned transition cannot be replayed");
    const additions = plan.admittedIds.map((id) => plainDelta(plan.state.base.admitted.get(id)!));
    const frame = encodeOrdinaryPeerFrame({
      peerId: this.peerId,
      prior: this.head,
      at: input.arrivedAt,
      sender: origin,
      additions,
    });
    const nextHead = contentAddress(frame);
    const write = await this.store.compareAndAppend(
      this.peerId,
      this.head,
      nextHead,
      frame,
      additions,
    );
    if (write.status !== "durable") {
      this.live = false;
      return write;
    }
    this.state = plan.state;
    this.head = nextHead;
    return {
      status: "committed",
      outcomes: plan.outcomes,
      arrivals: arrivals.map((row) => ({ ...row })),
      head: nextHead,
    };
  }
}
