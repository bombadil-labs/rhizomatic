// Internal permanent-posture image: the v1 holding/arrival base and erasure ledger commit together.
// Handoff, imported qualified references, lower-posture re-entry, and storage proof are later work.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { array, bstr, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { DeltaSet } from "../delta/set.js";
import type { Delta } from "../delta/types.js";
import { planArrivals } from "./arrival.js";
import type { PeerStateWriteOutcome, PeerState } from "./peer-state.js";
import { decodePeerState, encodePeerState } from "./peer-state.js";
import { isCanonicalPeerId } from "./peer-identity.js";

const VERSION = 2;
const DELTA_ID = /^1e20[0-9a-f]{64}$/;

export interface RefusalEvent {
  readonly sequence: number;
  readonly targetId: string;
  readonly orderIds: readonly string[];
  /** The target's peer-local first admission sequence, when it was held. */
  readonly priorEpoch?: number;
}

export interface ErasureExclusion {
  readonly orderId: string;
  readonly targetId: string;
  readonly eventSequence: number;
  readonly priorEpoch?: number;
}

export interface PurgeObligation {
  /** Stable local obligation identity, separate from refusal sequence. */
  readonly sequence: number;
  readonly targetId: string;
  /** Storage worker fence; remains stable across later orders for this target. */
  readonly generation: number;
  readonly eventSequence: number;
  readonly priorEpoch?: number;
  readonly status: "pending" | "failed" | "removed";
  readonly fault?: string;
}

export interface DurablePeerState {
  readonly base: PeerState;
  readonly refusalCounter: number;
  readonly obligationCounter: number;
  readonly quotaUsed: number;
  readonly events: readonly RefusalEvent[];
  readonly exclusions: readonly ErasureExclusion[];
  readonly obligations: readonly PurgeObligation[];
}

/** Fresh permanent-posture peer, before its first admission. */
export function emptyDurablePeerState(peerId: string): DurablePeerState {
  if (!isCanonicalPeerId(peerId)) throw new Error("durable peer state: invalid canonical peer id");
  return {
    base: {
      peerId,
      admitted: new DeltaSet(),
      cursor: { lastSequence: 0, lastTransfer: 0 },
      arrivals: [],
      refusedIds: new Set(),
    },
    refusalCounter: 0,
    obligationCounter: 0,
    quotaUsed: 0,
    events: [],
    exclusions: [],
    obligations: [],
  };
}

/** Verified, final admission decisions. The caller supplies the surface ownership fact. */
export interface PermanentCommitInput {
  readonly additions: readonly Delta[];
  readonly erasures: readonly {
    readonly targetId: string;
    readonly orderIds: readonly string[];
    readonly surfaceHoldsBytes: boolean;
  }[];
  readonly quotaCharge: number;
  readonly at: number;
  readonly sender: string;
}

function counter(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`durable peer state: invalid ${label}`);
}

function validate(state: DurablePeerState): void {
  encodePeerState(state.base);
  counter(state.refusalCounter, "refusal counter");
  counter(state.obligationCounter, "obligation counter");
  counter(state.quotaUsed, "quota counter");
  if (state.events.length !== state.refusalCounter)
    throw new Error("durable peer state: refusal history does not match counter");
  if (state.obligations.length !== state.obligationCounter)
    throw new Error("durable peer state: obligation history does not match counter");

  const arrived = new Map(state.base.arrivals.map((row) => [row.id, row.sequence]));
  const latestByTarget = new Map<string, RefusalEvent>();
  const eventByOrder = new Map<string, RefusalEvent>();
  for (let i = 0; i < state.events.length; i++) {
    const event = state.events[i]!;
    if (event.sequence !== i + 1 || !DELTA_ID.test(event.targetId) || !event.orderIds.length)
      throw new Error("durable peer state: invalid refusal event");
    const epoch = arrived.get(event.targetId);
    if (event.priorEpoch !== epoch)
      throw new Error("durable peer state: refusal targets wrong admission epoch");
    let lastOrder = "";
    for (const orderId of event.orderIds) {
      const order = state.base.admitted.get(orderId);
      if (
        !DELTA_ID.test(orderId) ||
        orderId <= lastOrder ||
        orderId === event.targetId ||
        order?.sig === undefined ||
        eventByOrder.has(orderId)
      )
        throw new Error("durable peer state: invalid effective order");
      eventByOrder.set(orderId, event);
      lastOrder = orderId;
    }
    latestByTarget.set(event.targetId, event);
  }
  if (
    latestByTarget.size !== state.base.refusedIds.size ||
    [...latestByTarget.keys()].some((id) => !state.base.refusedIds.has(id))
  )
    throw new Error("durable peer state: refusals do not match events");

  const excludedOrders = new Set<string>();
  for (const exclusion of state.exclusions) {
    const event = eventByOrder.get(exclusion.orderId);
    if (
      event === undefined ||
      excludedOrders.has(exclusion.orderId) ||
      exclusion.targetId !== event.targetId ||
      exclusion.eventSequence !== event.sequence ||
      exclusion.priorEpoch !== event.priorEpoch
    )
      throw new Error("durable peer state: invalid exclusion");
    excludedOrders.add(exclusion.orderId);
  }
  if (excludedOrders.size !== eventByOrder.size)
    throw new Error("durable peer state: effective order lacks exclusion");

  const obligationTargets = new Set<string>();
  for (let i = 0; i < state.obligations.length; i++) {
    const obligation = state.obligations[i]!;
    const event = latestByTarget.get(obligation.targetId);
    if (
      obligation.sequence !== i + 1 ||
      obligation.generation !== 1 ||
      event === undefined ||
      obligationTargets.has(obligation.targetId) ||
      obligation.eventSequence !== event.sequence ||
      obligation.priorEpoch !== event.priorEpoch ||
      !["pending", "failed", "removed"].includes(obligation.status) ||
      (obligation.status === "failed" ? !obligation.fault : obligation.fault !== undefined)
    )
      throw new Error("durable peer state: invalid purge obligation");
    obligationTargets.add(obligation.targetId);
  }
  for (const event of latestByTarget.values()) {
    if (event.priorEpoch !== undefined && !obligationTargets.has(event.targetId))
      throw new Error("durable peer state: held refusal lacks purge obligation");
  }
}

function object(value: CborValue, label: string): Map<string, CborValue> {
  if (value.t !== "map") throw new Error(`durable peer state: ${label} must be a map`);
  const out = new Map(value.v);
  if (out.size !== value.v.length) throw new Error(`durable peer state: duplicate ${label} key`);
  return out;
}
function numeric(value: CborValue | undefined, label: string): number {
  if (value?.t !== "float") throw new Error(`durable peer state: ${label} must be a number`);
  counter(value.v, label);
  return value.v;
}
function string(value: CborValue | undefined, label: string): string {
  if (value?.t !== "tstr") throw new Error(`durable peer state: ${label} must be text`);
  return value.v;
}
function items(value: CborValue | undefined, label: string): readonly CborValue[] {
  if (value?.t !== "array") throw new Error(`durable peer state: ${label} must be an array`);
  return value.v;
}

function epochField(epoch: number | undefined): Array<[string, CborValue]> {
  return epoch === undefined ? [] : [["epoch", float(epoch)]];
}

/** Canonical local image; it embeds the complete v1 base as bytes. */
export function encodeDurablePeerState(state: DurablePeerState): Uint8Array {
  validate(state);
  return encode(
    map([
      ["version", float(VERSION)],
      ["peer", tstr(state.base.peerId)],
      ["base", bstr(encodePeerState(state.base))],
      ["refusalCounter", float(state.refusalCounter)],
      ["obligationCounter", float(state.obligationCounter)],
      ["quotaUsed", float(state.quotaUsed)],
      [
        "events",
        array(
          state.events.map((event) =>
            map([
              ["sequence", float(event.sequence)],
              ["target", tstr(event.targetId)],
              ["orders", array(event.orderIds.map(tstr))],
              ...epochField(event.priorEpoch),
            ]),
          ),
        ),
      ],
      [
        "exclusions",
        array(
          [...state.exclusions]
            .sort((a, b) => (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0))
            .map((exclusion) =>
              map([
                ["order", tstr(exclusion.orderId)],
                ["target", tstr(exclusion.targetId)],
                ["event", float(exclusion.eventSequence)],
                ...epochField(exclusion.priorEpoch),
              ]),
            ),
        ),
      ],
      [
        "obligations",
        array(
          state.obligations.map((obligation) =>
            map([
              ["sequence", float(obligation.sequence)],
              ["target", tstr(obligation.targetId)],
              ["generation", float(obligation.generation)],
              ["event", float(obligation.eventSequence)],
              ["status", tstr(obligation.status)],
              ...epochField(obligation.priorEpoch),
              ...(obligation.fault === undefined
                ? []
                : [["fault", tstr(obligation.fault)] as [string, CborValue]]),
            ]),
          ),
        ),
      ],
    ]),
  );
}

function optionalEpoch(row: Map<string, CborValue>): number | undefined {
  return row.has("epoch") ? numeric(row.get("epoch"), "epoch") : undefined;
}

export function decodeDurablePeerState(
  bytes: Uint8Array,
  expectedPeerId: string,
): DurablePeerState {
  const top = object(decode(bytes), "image");
  if (top.size !== 9 || numeric(top.get("version"), "version") !== VERSION)
    throw new Error("durable peer state: unsupported image version or fields");
  const peerId = string(top.get("peer"), "peer");
  if (peerId !== expectedPeerId) throw new Error("durable peer state: wrong peer id");
  const baseBytes = top.get("base");
  if (baseBytes?.t !== "bstr") throw new Error("durable peer state: base must be bytes");
  const base = decodePeerState(baseBytes.v, expectedPeerId);
  const events = items(top.get("events"), "events").map((value): RefusalEvent => {
    const row = object(value, "event");
    if (row.size !== (row.has("epoch") ? 4 : 3))
      throw new Error("durable peer state: invalid event fields");
    const epoch = optionalEpoch(row);
    return {
      sequence: numeric(row.get("sequence"), "event sequence"),
      targetId: string(row.get("target"), "event target"),
      orderIds: items(row.get("orders"), "event orders").map((v) => string(v, "order id")),
      ...(epoch === undefined ? {} : { priorEpoch: epoch }),
    };
  });
  const exclusions = items(top.get("exclusions"), "exclusions").map((value): ErasureExclusion => {
    const row = object(value, "exclusion");
    if (row.size !== (row.has("epoch") ? 4 : 3))
      throw new Error("durable peer state: invalid exclusion fields");
    const epoch = optionalEpoch(row);
    return {
      orderId: string(row.get("order"), "exclusion order"),
      targetId: string(row.get("target"), "exclusion target"),
      eventSequence: numeric(row.get("event"), "exclusion event"),
      ...(epoch === undefined ? {} : { priorEpoch: epoch }),
    };
  });
  const obligations = items(top.get("obligations"), "obligations").map((value): PurgeObligation => {
    const row = object(value, "obligation");
    if (row.size !== 5 + Number(row.has("epoch")) + Number(row.has("fault")))
      throw new Error("durable peer state: invalid obligation fields");
    const epoch = optionalEpoch(row);
    const fault = row.has("fault") ? string(row.get("fault"), "obligation fault") : undefined;
    return {
      sequence: numeric(row.get("sequence"), "obligation sequence"),
      targetId: string(row.get("target"), "obligation target"),
      generation: numeric(row.get("generation"), "obligation generation"),
      eventSequence: numeric(row.get("event"), "obligation event"),
      status: string(row.get("status"), "obligation status") as PurgeObligation["status"],
      ...(epoch === undefined ? {} : { priorEpoch: epoch }),
      ...(fault === undefined ? {} : { fault }),
    };
  });
  const state: DurablePeerState = {
    base,
    refusalCounter: numeric(top.get("refusalCounter"), "refusal counter"),
    obligationCounter: numeric(top.get("obligationCounter"), "obligation counter"),
    quotaUsed: numeric(top.get("quotaUsed"), "quota counter"),
    events,
    exclusions,
    obligations,
  };
  validate(state);
  if (Buffer.compare(Buffer.from(encodeDurablePeerState(state)), Buffer.from(bytes)) !== 0)
    throw new Error("durable peer state: noncanonical image");
  return state;
}

function validateTransition(before: DurablePeerState, after: DurablePeerState): void {
  if (after.quotaUsed < before.quotaUsed)
    throw new Error("durable peer state: quota counter cannot shrink");
  if (after.base.arrivals.length < before.base.arrivals.length)
    throw new Error("durable peer state: arrival history cannot shrink");
  for (let i = 0; i < before.base.arrivals.length; i++) {
    const a = before.base.arrivals[i]!;
    const b = after.base.arrivals[i]!;
    if (
      a.id !== b.id ||
      a.at !== b.at ||
      a.sequence !== b.sequence ||
      a.transfer !== b.transfer ||
      a.sender !== b.sender
    )
      throw new Error("durable peer state: prior arrival changed");
  }
  for (const id of before.base.refusedIds) {
    if (!after.base.refusedIds.has(id))
      throw new Error("durable peer state: permanent refusal cannot be removed");
  }
  for (const delta of before.base.admitted) {
    const current = after.base.admitted.get(delta.id);
    if (current === undefined && !after.base.refusedIds.has(delta.id))
      throw new Error("durable peer state: holding lost without refusal");
    if (current !== undefined && current.sig !== delta.sig)
      throw new Error("durable peer state: admitted signature changed");
  }
  if (
    after.events.length < before.events.length ||
    after.obligations.length < before.obligations.length
  )
    throw new Error("durable peer state: ledger history cannot shrink");
  for (let i = 0; i < before.events.length; i++) {
    const a = before.events[i]!;
    const b = after.events[i]!;
    if (
      a.sequence !== b.sequence ||
      a.targetId !== b.targetId ||
      a.priorEpoch !== b.priorEpoch ||
      a.orderIds.length !== b.orderIds.length ||
      a.orderIds.some((id, j) => id !== b.orderIds[j])
    )
      throw new Error("durable peer state: prior refusal event changed");
  }
  const newArrivals = after.base.arrivals.slice(before.base.arrivals.length);
  if (newArrivals.some((row) => !after.base.admitted.has(row.id)))
    throw new Error("durable peer state: new arrival is not admitted");
  const newIds = new Set(newArrivals.map((row) => row.id));
  const transferOf = new Map(newArrivals.map((row) => [row.id, row.transfer]));
  const newOrders = new Set<string>();
  const targetsByTransfer = new Set<string>();
  for (const event of after.events.slice(before.events.length)) {
    let transfer: number | undefined;
    for (const orderId of event.orderIds) {
      if (!newIds.has(orderId))
        throw new Error("durable peer state: new effective order lacks new arrival");
      const orderTransfer = transferOf.get(orderId)!;
      if (transfer !== undefined && transfer !== orderTransfer)
        throw new Error("durable peer state: event orders span transfers");
      transfer = orderTransfer;
      newOrders.add(orderId);
    }
    const key = `${transfer}:${event.targetId}`;
    if (targetsByTransfer.has(key))
      throw new Error("durable peer state: target has two refusal events in one transfer");
    targetsByTransfer.add(key);
  }
  if (after.quotaUsed - before.quotaUsed !== newArrivals.length - newOrders.size)
    throw new Error("durable peer state: quota growth must equal new ordinary arrivals");
  const exclusions = new Map(after.exclusions.map((row) => [row.orderId, row]));
  for (const row of before.exclusions) {
    const next = exclusions.get(row.orderId);
    if (
      next?.targetId !== row.targetId ||
      next.eventSequence !== row.eventSequence ||
      next.priorEpoch !== row.priorEpoch
    )
      throw new Error("durable peer state: prior exclusion changed");
  }
  for (let i = 0; i < before.obligations.length; i++) {
    const a = before.obligations[i]!;
    const b = after.obligations[i]!;
    if (
      a.sequence !== b.sequence ||
      a.targetId !== b.targetId ||
      a.generation !== b.generation ||
      a.priorEpoch !== b.priorEpoch ||
      (a.status === "removed" && b.status !== "removed")
    )
      throw new Error("durable peer state: obligation identity or terminal state changed");
  }
}

/** Form one atomic permanent-posture image from already verified admission decisions. */
export function planPermanentCommit(
  before: DurablePeerState,
  input: PermanentCommitInput,
): DurablePeerState {
  validate(before);
  counter(input.quotaCharge, "quota charge");
  if (
    input.quotaCharge > input.additions.length ||
    input.quotaCharge > Number.MAX_SAFE_INTEGER - before.quotaUsed
  )
    throw new Error("durable peer state: invalid quota charge");
  const additions = new Map<string, Delta>();
  for (const delta of input.additions) {
    if (
      additions.has(delta.id) ||
      before.base.admitted.has(delta.id) ||
      before.base.refusedIds.has(delta.id)
    )
      throw new Error("durable peer state: addition is duplicate or refused");
    additions.set(delta.id, delta);
  }
  const groups = [...input.erasures].sort((a, b) =>
    a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0,
  );
  const usedOrders = new Set<string>();
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    if (
      !DELTA_ID.test(group.targetId) ||
      !group.orderIds.length ||
      (i > 0 && groups[i - 1]!.targetId === group.targetId) ||
      additions.has(group.targetId) ||
      typeof group.surfaceHoldsBytes !== "boolean"
    )
      throw new Error("durable peer state: invalid erasure group");
    for (const orderId of group.orderIds) {
      if (orderId === group.targetId || !additions.get(orderId)?.sig || usedOrders.has(orderId))
        throw new Error("durable peer state: effective order must be a distinct signed addition");
      usedOrders.add(orderId);
    }
  }
  if (input.quotaCharge !== additions.size - usedOrders.size)
    throw new Error("durable peer state: quota charge must equal new ordinary ids");
  const arrivals = planArrivals(
    before.base.cursor,
    new Set(before.base.admitted.ids()),
    [...additions.keys()],
    input.at,
    input.sender,
  );
  const targets = new Set(groups.map((group) => group.targetId));
  const admitted = DeltaSet.from([
    ...before.base.admitted.filtered((delta) => !targets.has(delta.id)),
    ...additions.values(),
  ]);
  const events = [...before.events];
  const exclusions = [...before.exclusions];
  const obligations = before.obligations.map((row) => ({ ...row }));
  const refusedIds = new Set(before.base.refusedIds);
  const arrived = new Map(before.base.arrivals.map((row) => [row.id, row.sequence]));
  for (const group of groups) {
    if (events.length === Number.MAX_SAFE_INTEGER)
      throw new Error("durable peer state: refusal counter exhausted");
    const priorEpoch = arrived.get(group.targetId);
    const sequence = events.length + 1;
    const orderIds = [...group.orderIds].sort();
    if (new Set(orderIds).size !== orderIds.length)
      throw new Error("durable peer state: duplicate order in group");
    events.push({
      sequence,
      targetId: group.targetId,
      orderIds,
      ...(priorEpoch === undefined ? {} : { priorEpoch }),
    });
    refusedIds.add(group.targetId);
    for (const orderId of orderIds)
      exclusions.push({
        orderId,
        targetId: group.targetId,
        eventSequence: sequence,
        ...(priorEpoch === undefined ? {} : { priorEpoch }),
      });
    const existing = obligations.findIndex((row) => row.targetId === group.targetId);
    if (existing >= 0)
      obligations[existing] = { ...obligations[existing]!, eventSequence: sequence };
    else if (priorEpoch !== undefined || group.surfaceHoldsBytes) {
      if (obligations.length === Number.MAX_SAFE_INTEGER)
        throw new Error("durable peer state: obligation counter exhausted");
      obligations.push({
        sequence: obligations.length + 1,
        targetId: group.targetId,
        generation: 1,
        eventSequence: sequence,
        status: "pending",
        ...(priorEpoch === undefined ? {} : { priorEpoch }),
      });
    }
  }
  const after: DurablePeerState = {
    base: {
      ...before.base,
      admitted,
      refusedIds,
      cursor: { lastSequence: arrivals.lastSequence, lastTransfer: arrivals.lastTransfer },
      arrivals: [...before.base.arrivals, ...arrivals.arrivals],
    },
    refusalCounter: events.length,
    obligationCounter: obligations.length,
    quotaUsed: before.quotaUsed + input.quotaCharge,
    events,
    exclusions,
    obligations,
  };
  validate(after);
  validateTransition(before, after);
  return after;
}

/** Single-writer replacement for the complete local permanent-posture image. */
export function writeDurablePeerState(
  path: string,
  state: DurablePeerState,
  expectedPrior: Uint8Array | null,
): PeerStateWriteOutcome {
  const bytes = encodeDurablePeerState(state);
  if (expectedPrior === undefined)
    throw new Error("durable peer state: expected prior image required");
  const priorBytes = existsSync(path) ? readFileSync(path) : null;
  const before =
    priorBytes === null ? undefined : decodeDurablePeerState(priorBytes, state.base.peerId);
  if (
    (priorBytes === null) !== (expectedPrior === null) ||
    (priorBytes !== null &&
      expectedPrior !== null &&
      !Buffer.from(priorBytes).equals(Buffer.from(expectedPrior)))
  )
    throw new Error("durable peer state: expected prior image changed");
  if (before !== undefined) validateTransition(before, state);
  const temp = `${path}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  const dirFd = openSync(dirname(path), "r");
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    try {
      fsyncSync(dirFd);
      return { status: "durable" };
    } catch (error) {
      return { status: "committed-unconfirmed", fault: String(error) };
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
    closeSync(dirFd);
  }
}

export function readDurablePeerState(
  path: string,
  expectedPeerId: string,
): DurablePeerState | undefined {
  if (!existsSync(path)) return undefined;
  return decodeDurablePeerState(readFileSync(path), expectedPeerId);
}
