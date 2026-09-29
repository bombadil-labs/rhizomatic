// Typed signed-loose ordinary and effective-erasure admission over an atomic append journal.
import type { Delta } from "../delta/types.js";
import { computeId } from "../delta/delta.js";
import { DeltaSet } from "../delta/set.js";
import { contentAddress } from "../delta/hash.js";
import { claimsToJson, parseClaims } from "../delta/json-profile.js";
import {
  emptyDurablePeerState,
  encodeDurablePeerState,
  planPermanentCommitFromVerified,
  validateDurablePeerStateTransition,
  type DurablePeerState,
} from "./durable-state.js";
import { planErasureFilter, type ErasureOrderCandidate } from "./erasure-filter.js";
import { preflightTransfer, type CandidateGuard } from "./preflight.js";
import { isCanonicalPeerId } from "./peer-identity.js";
import { encodeOrdinaryJournalCheckpoint, encodeOrdinaryPeerFrame } from "./ordinary-journal.js";
import {
  applyPermanentPeerFrame,
  decodePermanentPeerFrame,
  encodePermanentPeerFrame,
  replayPermanentPeerFrames,
} from "./permanent-journal.js";
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
  /** Atomically append an erasure frame and newly admitted orders, checking every declared
   * absent target against this peer's complete storage surface. Use `surfaceHoldsBytes = true`
   * conservatively when uncertain; that creates a purge obligation. */
  compareAndAppendErasure?(
    peerId: string,
    expectedHead: string,
    nextHead: string,
    frame: Uint8Array,
    newlyAdmitted: readonly Delta[],
    assertedAbsentTargetIds: readonly string[],
  ): Promise<PeerImageWrite>;
  /** Atomically replace a verified frame prefix at expectedHead; keep admitted rows and head. */
  compareAndCheckpoint?(
    peerId: string,
    expectedHead: string,
    checkpoint: Uint8Array,
  ): Promise<PeerImageWrite>;
  /** Atomically prove all bytes for target are absent from this peer's declared surface and append the report. */
  compareAndSettlePurge?(
    peerId: string,
    expectedHead: string,
    nextHead: string,
    frame: Uint8Array,
    targetId: string,
    generation: number,
  ): Promise<PeerImageWrite>;
}

export interface EffectiveErasureOrder {
  readonly delta: Delta;
  readonly targetId: string;
  readonly surfaceHoldsBytes: boolean;
}

export interface EffectiveErasureTransferInput<State> {
  readonly orders: readonly EffectiveErasureOrder[];
  readonly origin: ArrivalOrigin;
  readonly arrivedAt: number;
  readonly policyState: Readonly<State>;
  readonly guards: readonly CandidateGuard<State>[];
  readonly mode: "atomic" | "individual";
  readonly targetBudget: number;
  readonly advanceRefusalCap: number;
  /** Pure authorization over the same pre-transfer holding set, including erasure fixed-point rounds. */
  readonly authorize: (
    order: ErasureOrderCandidate,
    admittedBefore: ReadonlySet<string>,
  ) => boolean;
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

export type OrdinaryJournalPurgeResult =
  | { readonly status: "committed"; readonly head: string }
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
      const state = replayPermanentPeerFrames(
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

  /** Signed loose erasure orders only. The host supplies its policy authorization and surface fact. */
  async admitErasures<State>(
    input: EffectiveErasureTransferInput<State>,
  ): Promise<OrdinaryJournalAdmissionResult> {
    if (!this.live) throw new Error("ordinary journal: reopen required");
    const current = await this.store.readHead(this.peerId);
    if (current.status !== "head" || current.head !== this.head) {
      this.live = false;
      return { status: "conflict" };
    }
    if (!Number.isSafeInteger(input.advanceRefusalCap) || input.advanceRefusalCap < 0)
      throw new Error("permanent journal: invalid advance refusal cap");
    const origin = sender(input.origin, this.peerId);
    const stableOrders = input.orders.map((row) => ({
      delta: structuredClone(row.delta),
      targetId: row.targetId,
      surfaceHoldsBytes: row.surfaceHoldsBytes,
    }));
    const guarded = preflightTransfer(
      stableOrders.map((row) => ({ kind: "loose" as const, delta: row.delta })),
      {
        admittedBefore: this.state.base.admitted,
        refusedIds: this.state.base.refusedIds,
        sendingPeerId: origin,
        receivingPeerId: this.peerId,
        arrivedAt: input.arrivedAt,
        policyState: input.policyState,
        guards: input.guards,
      },
    );
    const byId = new Map<string, EffectiveErasureOrder>();
    const outcomes: SignedLooseOutcome[] = guarded.map((row, i) => {
      const order = stableOrders[i]!;
      if (row.status !== "eligible")
        return {
          id: order.delta.id,
          status: row.status,
          ...(row.reason === undefined ? {} : { reason: row.reason }),
        };
      const signedTargets = order.delta.claims.pointers
        .filter((pointer) => pointer.role === "erases" && pointer.target.kind === "delta")
        .map((pointer) => (pointer.target.kind === "delta" ? pointer.target.deltaRef.delta : ""));
      if (signedTargets.length !== 1 || signedTargets[0] !== order.targetId)
        return {
          id: order.delta.id,
          status: "erasure-ineligible",
          reason: "signed target mismatch",
        };
      const previous = byId.get(order.delta.id);
      if (
        previous !== undefined &&
        (previous.targetId !== order.targetId ||
          previous.surfaceHoldsBytes !== order.surfaceHoldsBytes)
      )
        throw new Error("permanent journal: conflicting order appearances");
      byId.set(order.delta.id, order);
      return { id: order.delta.id, status: "effective-erasure" };
    });
    const offeredOrderIds = new Set(byId.keys());
    for (const [id, order] of byId) {
      if (offeredOrderIds.has(order.targetId)) {
        byId.delete(id);
        for (let i = 0; i < outcomes.length; i++)
          if (outcomes[i]!.id === id && outcomes[i]!.status === "effective-erasure")
            outcomes[i] = { id, status: "erasure-ineligible", reason: "erasure targets an order" };
      }
    }
    const filtered = planErasureFilter(
      [...byId.values()].map((row) => ({ id: row.delta.id, targetId: row.targetId })),
      new Set(this.state.base.admitted.ids()),
      input.targetBudget,
      input.authorize,
    );
    const effective = new Set(filtered.effectiveOrderIds);
    const limited = new Set(filtered.limitedOrderIds);
    const existingAdvance = new Set(
      this.state.events
        .filter(
          (event) =>
            event.priorEpoch === undefined &&
            !this.state.obligations.some((job) => job.targetId === event.targetId),
        )
        .map((event) => event.targetId),
    ).size;
    let newAdvance = 0;
    for (const targetId of filtered.selectedTargets) {
      if (
        ![...byId.values()].some((row) => row.targetId === targetId && effective.has(row.delta.id))
      )
        continue;
      const order = [...byId.values()].find((row) => row.targetId === targetId)!;
      const isAdvance =
        !this.state.base.admitted.has(targetId) &&
        !this.state.base.refusedIds.has(targetId) &&
        !order.surfaceHoldsBytes;
      if (isAdvance && existingAdvance + newAdvance >= input.advanceRefusalCap) {
        for (const row of byId.values())
          if (row.targetId === targetId) {
            effective.delete(row.delta.id);
            limited.add(row.delta.id);
          }
      } else if (isAdvance) newAdvance++;
    }
    // A cap may remove an order that another surviving authority check depended on.
    // Re-run elimination over only the survivors; never refill a skipped target.
    const afterCap = planErasureFilter(
      [...effective].map((id) => ({ id, targetId: byId.get(id)!.targetId })),
      new Set(this.state.base.admitted.ids()),
      effective.size,
      input.authorize,
    );
    effective.clear();
    for (const id of afterCap.effectiveOrderIds) effective.add(id);
    for (let i = 0; i < outcomes.length; i++) {
      const prior = outcomes[i]!;
      if (prior.status !== "effective-erasure") continue;
      const status = effective.has(prior.id)
        ? "effective-erasure"
        : limited.has(prior.id)
          ? "erasure-limit"
          : "erasure-ineligible";
      outcomes[i] = { id: prior.id, status };
    }
    if (input.mode === "atomic") {
      const failed = outcomes.find(
        (outcome) => !["effective-erasure", "duplicate"].includes(outcome.status),
      );
      if (failed !== undefined)
        return { status: "rejected", reason: failed.reason ?? failed.status, outcomes };
    }
    if (effective.size === 0)
      return { status: "committed", outcomes, arrivals: [], head: this.head };
    const groups = new Map<string, { orderIds: string[]; surfaceHoldsBytes: boolean }>();
    for (const id of effective) {
      const order = byId.get(id)!;
      const group = groups.get(order.targetId);
      if (group !== undefined) {
        if (group.surfaceHoldsBytes !== order.surfaceHoldsBytes)
          throw new Error("permanent journal: inconsistent surface fact");
        group.orderIds.push(id);
      } else
        groups.set(order.targetId, { orderIds: [id], surfaceHoldsBytes: order.surfaceHoldsBytes });
    }
    const additions = [...effective].sort().map((id) => plainDelta(byId.get(id)!.delta));
    const erasures = [...groups].map(([targetId, group]) => ({ targetId, ...group }));
    const state = planPermanentCommitFromVerified(this.state, {
      additions,
      erasures,
      quotaCharge: 0,
      at: input.arrivedAt,
      sender: origin,
    });
    encodeDurablePeerState(state);
    validateDurablePeerStateTransition(this.state, state);
    const frame = encodePermanentPeerFrame({
      kind: "admission",
      peerId: this.peerId,
      prior: this.head,
      additions,
      erasures,
      quotaCharge: 0,
      at: input.arrivedAt,
      sender: origin,
    });
    const replayed = applyPermanentPeerFrame(this.state, decodePermanentPeerFrame(frame));
    if (replayed.base.cursor.lastSequence !== state.base.cursor.lastSequence)
      throw new Error("permanent journal: planned transition cannot be replayed");
    const nextHead = contentAddress(frame);
    if (this.store.compareAndAppendErasure === undefined)
      throw new Error("permanent journal: erasure CAS unsupported by store");
    const assertedAbsentTargetIds = erasures
      .filter((group) => !group.surfaceHoldsBytes)
      .map((group) => group.targetId);
    const write = await this.store.compareAndAppendErasure(
      this.peerId,
      this.head,
      nextHead,
      frame,
      additions,
      assertedAbsentTargetIds,
    );
    if (write.status !== "durable") {
      this.live = false;
      return write;
    }
    const arrivals = state.base.arrivals
      .slice(this.state.base.arrivals.length)
      .map((row) => ({ ...row }));
    this.state = state;
    this.head = nextHead;
    return { status: "committed", outcomes, arrivals, head: nextHead };
  }

  /** Record purge failure, or settle only if storage atomically proves physical absence. */
  async reportPurge(
    targetId: string,
    generation: number,
    report: { readonly status: "failed"; readonly fault: string } | { readonly status: "removed" },
  ): Promise<OrdinaryJournalPurgeResult> {
    if (!this.live) throw new Error("ordinary journal: reopen required");
    const current = await this.store.readHead(this.peerId);
    if (current.status !== "head" || current.head !== this.head) {
      this.live = false;
      return { status: "conflict" };
    }
    const frame = encodePermanentPeerFrame({
      kind: "purge",
      peerId: this.peerId,
      prior: this.head,
      targetId,
      generation,
      ...report,
    });
    const state = applyPermanentPeerFrame(this.state, decodePermanentPeerFrame(frame));
    const nextHead = contentAddress(frame);
    if (report.status === "removed" && this.store.compareAndSettlePurge === undefined)
      throw new Error("permanent journal: physical absence proof unsupported by store");
    const write =
      report.status === "removed"
        ? await this.store.compareAndSettlePurge!(
            this.peerId,
            this.head,
            nextHead,
            frame,
            targetId,
            generation,
          )
        : await this.store.compareAndAppend(this.peerId, this.head, nextHead, frame, []);
    if (write.status !== "durable") {
      this.live = false;
      return write;
    }
    this.state = state;
    this.head = nextHead;
    return { status: "committed", head: nextHead };
  }
}
