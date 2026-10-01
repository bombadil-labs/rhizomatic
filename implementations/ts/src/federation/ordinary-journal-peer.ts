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
import { planOrdinaryQuota, type OrdinaryQuotaUnit } from "./ordinary-quota.js";
import { preflightTransfer, type CandidateGuard } from "./preflight.js";
import { isCanonicalPeerId } from "./peer-identity.js";
import { encodeOrdinaryJournalCheckpoint, encodeOrdinaryPeerFrame } from "./ordinary-journal.js";
import {
  applyPermanentPeerFrame,
  decodePermanentJournalRebase,
  decodePermanentPeerFrame,
  encodePermanentJournalRebase,
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

export interface AdmittedRowRead {
  readonly id: string;
  readonly row?: Delta;
  readonly fault?: string;
}

export interface UnavailableAdmittedRow {
  readonly id: string;
  readonly reason: string;
}

/** A verified absence claim can fail without changing the head. This is not writer contention. */
export type ErasureJournalWrite =
  | PeerImageWrite
  | { readonly status: "absence-refuted"; readonly targetId: string };

/** Consistent open, immutable committed frames, cheap head read, atomic head/frame/row CAS. */
export interface DurableOrdinaryJournalStore {
  readJournal(peerId: string): Promise<OrdinaryJournalRead>;
  /** Return exactly the stored rows for these admitted ids; extras outside the list stay external. */
  readAdmittedRows(peerId: string, ids: readonly string[]): Promise<readonly Delta[]>;
  /** Isolate per-row read faults for a writable degraded open. Return one result per requested id. */
  readAdmittedRowsDegraded?(
    peerId: string,
    ids: readonly string[],
  ): Promise<readonly AdmittedRowRead[]>;
  readHead(peerId: string): Promise<OrdinaryJournalHead>;
  /** On empty create (expectedHead = null), compare both absent head and absence of existing rows. */
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
  ): Promise<ErasureJournalWrite>;
  /** Atomically replace a verified frame prefix at expectedHead; keep admitted rows and head. */
  compareAndCheckpoint?(
    peerId: string,
    expectedHead: string,
    checkpoint: Uint8Array,
  ): Promise<PeerImageWrite>;
  /** Atomically replace all prior frames/checkpoint with a new current-state anchor and head.
   * The adapter must ensure old frame payloads are removed from its declared storage surface;
   * physical remanence remains purge debt until `compareAndSettlePurge` proves absence. */
  compareAndRebase?(
    peerId: string,
    expectedHead: string,
    nextHead: string,
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
  ): Promise<ErasureJournalWrite>;
}

export interface EffectiveErasureOrder {
  readonly delta: Delta;
  readonly targetId: string;
  readonly surfaceHoldsBytes: boolean;
}

export interface EffectiveErasureTransferInput<State> {
  readonly orders: readonly EffectiveErasureOrder[];
  /** Loose ordinary appearances in this same transfer, considered after the order appearances. */
  readonly ordinary?: readonly Delta[];
  /** Capacity for ordinary additions only. */
  readonly capacity?: number;
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
  | {
      readonly status: "degraded";
      readonly peer: OrdinaryJournalPeer;
      readonly unavailable: readonly UnavailableAdmittedRow[];
    }
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
  | { readonly status: "absence-refuted"; readonly targetId: string }
  | { readonly status: "committed-unconfirmed"; readonly fault: string };

export type OrdinaryJournalPurgeResult =
  | { readonly status: "committed"; readonly head: string }
  | { readonly status: "conflict" }
  | { readonly status: "absence-refuted"; readonly targetId: string }
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

function classifyAdmittedRows(
  state: DurablePeerState,
  reads: readonly AdmittedRowRead[],
): UnavailableAdmittedRow[] {
  const ids = state.base.admitted.ids();
  if (reads.length !== ids.length)
    throw new Error("ordinary journal: incomplete degraded row read");
  const byId = new Map<string, AdmittedRowRead>();
  for (const read of reads) {
    if (!state.base.admitted.has(read.id) || byId.has(read.id))
      throw new Error("ordinary journal: invalid degraded row read");
    byId.set(read.id, read);
  }
  return ids.flatMap((id) => {
    const read = byId.get(id);
    if (read === undefined) throw new Error("ordinary journal: incomplete degraded row read");
    if (read.fault !== undefined) return [{ id, reason: read.fault }];
    const row = read.row;
    if (row === undefined) return [{ id, reason: read.fault ?? "missing row" }];
    const expected = state.base.admitted.get(id)!;
    try {
      if (row.id === id && row.sig === expected.sig && computeId(row.claims) === id) return [];
    } catch {
      /* The bad row is isolated below. */
    }
    return [{ id, reason: read.fault ?? "admitted row mismatch" }];
  });
}

/** A verified in-memory projection of one durable ordinary journal head. */
export class OrdinaryJournalPeer {
  private live = true;
  private constructor(
    private readonly store: DurableOrdinaryJournalStore,
    readonly peerId: string,
    private state: DurablePeerState,
    private head: string,
    private unavailableIds: Set<string>,
    private rebasedThrough: number,
    private rebasedRefusedIds: Set<string>,
  ) {}

  static async open(
    store: DurableOrdinaryJournalStore,
    peerId: string,
    options: { readonly allowDegraded?: boolean; readonly requireExisting?: boolean } = {},
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
      let rebasedThrough = 0;
      let rebasedRefusedIds = new Set<string>();
      if (current.checkpoint !== undefined) {
        try {
          const anchor = decodePermanentJournalRebase(current.checkpoint);
          rebasedThrough = anchor.state.base.cursor.lastSequence;
          rebasedRefusedIds = new Set(anchor.state.base.refusedIds);
        } catch {
          // A verified v1 checkpoint still contains old payloads.
        }
      }
      if (options.allowDegraded) {
        if (store.readAdmittedRowsDegraded === undefined)
          throw new Error("ordinary journal: degraded row read unsupported by store");
        const unavailable = classifyAdmittedRows(
          state,
          await store.readAdmittedRowsDegraded(peerId, state.base.admitted.ids()),
        );
        const verifiedHead = await store.readHead(peerId);
        if (verifiedHead.status !== "head" || verifiedHead.head !== current.head)
          return { status: "conflict" };
        const peer = new OrdinaryJournalPeer(
          store,
          peerId,
          state,
          current.head,
          new Set(unavailable.map((row) => row.id)),
          rebasedThrough,
          rebasedRefusedIds,
        );
        return unavailable.length
          ? { status: "degraded", peer, unavailable }
          : { status: "open", peer };
      }
      const rows = await store.readAdmittedRows(peerId, state.base.admitted.ids());
      const verifiedHead = await store.readHead(peerId);
      if (verifiedHead.status !== "head" || verifiedHead.head !== current.head)
        return { status: "conflict" };
      assertAdmittedRows(state, rows);
      return {
        status: "open",
        peer: new OrdinaryJournalPeer(
          store,
          peerId,
          state,
          current.head,
          new Set(),
          rebasedThrough,
          rebasedRefusedIds,
        ),
      };
    }
    if (options.requireExisting) return { status: "conflict" };
    const write = await store.compareAndAppend(peerId, null, "", null, []);
    if (write.status !== "durable") return write;
    return {
      status: "open",
      peer: new OrdinaryJournalPeer(
        store,
        peerId,
        emptyDurablePeerState(peerId),
        "",
        new Set(),
        0,
        new Set(),
      ),
    };
  }

  /** Copy the verified projection for a reader; append receipts avoid this O(history) copy. */
  snapshot(): DurablePeerState {
    if (!this.live) throw new Error("ordinary journal: reopen required");
    return copyState(this.state);
  }

  /** The signed rows safe to serve; unavailable physical rows stay out of product views. */
  availableDeltas(): DeltaSet {
    if (!this.live) throw new Error("ordinary journal: reopen required");
    return DeltaSet.from(
      [...this.state.base.admitted]
        .filter((row) => !this.unavailableIds.has(row.id))
        .map((row) => structuredClone(row)),
    );
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

  /** Compact through erasure by replacing payload-bearing history with the current image. */
  async rebase(): Promise<PeerImageWrite> {
    if (!this.live) throw new Error("ordinary journal: reopen required");
    if (this.state.events.length === 0)
      throw new Error("permanent journal: rebase requires refusal history");
    if (this.head === "" || this.store.compareAndRebase === undefined)
      throw new Error("permanent journal: rebase unsupported by store");
    const checkpoint = encodePermanentJournalRebase({
      peerId: this.peerId,
      prior: this.head,
      state: this.state,
    });
    const nextHead = contentAddress(checkpoint);
    const result = await this.store.compareAndRebase(this.peerId, this.head, nextHead, checkpoint);
    if (result.status !== "durable") this.live = false;
    else {
      this.head = nextHead;
      this.rebasedThrough = this.state.base.cursor.lastSequence;
      this.rebasedRefusedIds = new Set(this.state.base.refusedIds);
    }
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
    const stableOrdinary = (input.ordinary ?? []).map((delta) => structuredClone(delta));
    const guarded = preflightTransfer(
      [
        ...stableOrders.map((row) => ({ kind: "loose" as const, delta: row.delta })),
        ...stableOrdinary.map((delta) => ({ kind: "loose" as const, delta })),
      ],
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
    const offeredOrderIds = new Set(
      guarded
        .slice(0, stableOrders.length)
        .filter((row) => row.status !== "invalid")
        .flatMap((row) =>
          row.unit.kind === "loose" &&
          row.unit.delta.claims.pointers.some((pointer) => pointer.role === "erases")
            ? [row.unit.delta.id]
            : [],
        ),
    );
    const byId = new Map<string, EffectiveErasureOrder>();
    const outcomes: SignedLooseOutcome[] = guarded.slice(0, stableOrders.length).map((row, i) => {
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
    const surfaceByTarget = new Map<string, boolean>();
    for (const order of byId.values()) {
      const prior = surfaceByTarget.get(order.targetId);
      if (prior !== undefined && prior !== order.surfaceHoldsBytes)
        throw new Error("permanent journal: inconsistent surface fact");
      surfaceByTarget.set(order.targetId, order.surfaceHoldsBytes);
    }
    const priorEffectiveOrders = new Set(this.state.exclusions.map((row) => row.orderId));
    for (const [id, order] of byId) {
      const reason = priorEffectiveOrders.has(order.targetId)
        ? "erasure targets an effective order"
        : !order.surfaceHoldsBytes && this.state.base.admitted.has(order.targetId)
          ? "held target has bytes"
          : undefined;
      if (reason !== undefined) {
        byId.delete(id);
        for (let i = 0; i < outcomes.length; i++)
          if (outcomes[i]!.id === id && outcomes[i]!.status === "effective-erasure")
            outcomes[i] = {
              id,
              status: "erasure-ineligible",
              reason,
            };
      }
    }
    for (const [id, order] of byId) {
      if (offeredOrderIds.has(order.targetId)) {
        byId.delete(id);
        for (let i = 0; i < outcomes.length; i++)
          if (outcomes[i]!.id === id && outcomes[i]!.status === "effective-erasure")
            outcomes[i] = {
              id,
              status: "erasure-ineligible",
              reason: "erasure targets an order",
            };
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
    const coofferedOrdinaryIds = new Set(
      guarded
        .slice(stableOrders.length)
        .flatMap((row) =>
          row.status === "eligible" && row.unit.kind === "loose" ? [row.unit.delta.id] : [],
        ),
    );
    let newAdvance = 0;
    for (const targetId of filtered.selectedTargets) {
      if (
        ![...byId.values()].some((row) => row.targetId === targetId && effective.has(row.delta.id))
      )
        continue;
      const order = [...byId.values()].find((row) => row.targetId === targetId)!;
      const isAdvance =
        !this.state.base.admitted.has(targetId) &&
        !coofferedOrdinaryIds.has(targetId) &&
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
    const excludedTargets = new Set([...effective].map((id) => byId.get(id)!.targetId));
    const ordinaryCandidates = new Map<string, Delta>();
    const ordinaryPreflight = guarded.slice(stableOrders.length);
    const ordinaryOutcomes: SignedLooseOutcome[] = ordinaryPreflight.map((row, i) => {
      const delta = stableOrdinary[i]!;
      if (row.status !== "eligible")
        return {
          id: delta.id,
          status: row.status,
          ...(row.reason === undefined ? {} : { reason: row.reason }),
        };
      if (byId.has(delta.id))
        return { id: delta.id, status: "invalid", reason: "order also offered as ordinary" };
      if (excludedTargets.has(delta.id))
        return { id: delta.id, status: "refused", reason: "erased in transfer" };
      ordinaryCandidates.set(delta.id, delta);
      return { id: delta.id, status: "admitted" };
    });
    const ordinaryUnits: OrdinaryQuotaUnit[] = [...ordinaryCandidates.values()].map((delta) => ({
      key: delta.id,
      rank: delta.id,
      freshIds: [delta.id],
      requires: [...ordinaryCandidates.values()]
        .filter((other) =>
          other.claims.pointers.some(
            (pointer) =>
              pointer.role === "negates" &&
              pointer.target.kind === "delta" &&
              pointer.target.deltaRef.delta === delta.id,
          ),
        )
        .map((other) => other.id),
    }));
    const quota = planOrdinaryQuota(
      ordinaryUnits,
      new Set(this.state.base.admitted.ids()),
      excludedTargets,
      effective,
      input.capacity ?? Number.MAX_SAFE_INTEGER,
    );
    const admittedOrdinary = new Set(quota.admittedIds);
    const skippedOrdinary = new Set(quota.skippedKeys);
    const prunedOrdinary = new Set(quota.prunedKeys);
    for (let i = 0; i < ordinaryOutcomes.length; i++) {
      const prior = ordinaryOutcomes[i]!;
      if (prior.status !== "admitted") continue;
      ordinaryOutcomes[i] = {
        id: prior.id,
        status: admittedOrdinary.has(prior.id)
          ? "admitted"
          : skippedOrdinary.has(prior.id)
            ? "quota-skipped"
            : prunedOrdinary.has(prior.id)
              ? "dependency-pruned"
              : "invalid",
      };
    }
    outcomes.push(...ordinaryOutcomes);
    if (input.mode === "atomic") {
      const failed = outcomes.find(
        (outcome) => !["effective-erasure", "admitted", "duplicate"].includes(outcome.status),
      );
      if (failed !== undefined)
        return { status: "rejected", reason: failed.reason ?? failed.status, outcomes };
    }
    if (effective.size === 0 && quota.admittedIds.length === 0)
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
    const additions = [
      ...[...effective].map((id) => plainDelta(byId.get(id)!.delta)),
      ...quota.admittedIds.map((id) => plainDelta(ordinaryCandidates.get(id)!)),
    ];
    const erasures = [...groups].map(([targetId, group]) => ({ targetId, ...group }));
    const state = planPermanentCommitFromVerified(this.state, {
      additions,
      erasures,
      quotaCharge: quota.charged,
      at: input.arrivedAt,
      sender: origin,
    });
    encodeDurablePeerState(state);
    validateDurablePeerStateTransition(this.state, state);
    const frame =
      effective.size === 0
        ? encodeOrdinaryPeerFrame({
            peerId: this.peerId,
            prior: this.head,
            additions,
            at: input.arrivedAt,
            sender: origin,
          })
        : encodePermanentPeerFrame({
            kind: "admission",
            peerId: this.peerId,
            prior: this.head,
            additions,
            erasures,
            quotaCharge: quota.charged,
            at: input.arrivedAt,
            sender: origin,
          });
    const replayed =
      effective.size === 0
        ? state
        : applyPermanentPeerFrame(this.state, decodePermanentPeerFrame(frame));
    if (replayed.base.cursor.lastSequence !== state.base.cursor.lastSequence)
      throw new Error("permanent journal: planned transition cannot be replayed");
    const nextHead = contentAddress(frame);
    if (effective.size > 0 && this.store.compareAndAppendErasure === undefined)
      throw new Error("permanent journal: erasure CAS unsupported by store");
    const assertedAbsentTargetIds = erasures
      .filter((group) => !group.surfaceHoldsBytes)
      .map((group) => group.targetId);
    const write =
      effective.size === 0
        ? await this.store.compareAndAppend(this.peerId, this.head, nextHead, frame, additions)
        : await this.store.compareAndAppendErasure!(
            this.peerId,
            this.head,
            nextHead,
            frame,
            additions,
            assertedAbsentTargetIds,
          );
    if (write.status === "absence-refuted") {
      if (!assertedAbsentTargetIds.includes(write.targetId)) {
        this.live = false;
        throw new Error("permanent journal: invalid absence refutation");
      }
      return write;
    }
    if (write.status !== "durable") {
      this.live = false;
      return write;
    }
    const arrivals = state.base.arrivals
      .slice(this.state.base.arrivals.length)
      .map((row) => ({ ...row }));
    this.state = state;
    this.head = nextHead;
    for (const targetId of excludedTargets) this.unavailableIds.delete(targetId);
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
    const arrival = this.state.base.arrivals.find((row) => row.id === targetId);
    if (
      report.status === "removed" &&
      arrival !== undefined &&
      (arrival.sequence > this.rebasedThrough || !this.rebasedRefusedIds.has(targetId))
    )
      return { status: "absence-refuted", targetId };
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
    if (write.status === "absence-refuted") {
      if (report.status !== "removed" || write.targetId !== targetId) {
        this.live = false;
        throw new Error("permanent journal: invalid absence refutation");
      }
      return write;
    }
    if (write.status !== "durable") {
      this.live = false;
      return write;
    }
    this.state = state;
    this.head = nextHead;
    return { status: "committed", head: nextHead };
  }
}

export type OrdinaryJournalCapture =
  | {
      readonly status: "captured";
      readonly peer: OrdinaryJournalPeer;
      readonly state: DurablePeerState;
      readonly source: DeltaSet;
      readonly head: string;
    }
  | { readonly status: "source-changed" | "source-unavailable" };
/** Complete existing journal capture. Missing storage never initializes a peer. */
export async function captureOrdinaryJournalSource(
  store: DurableOrdinaryJournalStore,
  peerId: string,
  diagnostic: (fault: unknown) => void,
): Promise<OrdinaryJournalCapture> {
  try {
    const existing = await store.readJournal(peerId);
    if (existing.status !== "journal") return { status: "source-unavailable" };
    const opened = await OrdinaryJournalPeer.open(store, peerId, { requireExisting: true });
    if (opened.status !== "open")
      return { status: opened.status === "conflict" ? "source-changed" : "source-unavailable" };
    const state = opened.peer.snapshot();
    return {
      status: "captured",
      peer: opened.peer,
      state,
      source: opened.peer.availableDeltas(),
      head: opened.peer.currentHead(),
    };
  } catch (fault) {
    diagnostic(fault);
    return { status: "source-unavailable" };
  }
}
