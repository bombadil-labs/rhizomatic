// Canonical journal frames for effective erasure and purge reports. Admission policy runs before
// these frames are formed; replay verifies the signed additions and the durable state transition.
import { array, bstr, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { contentAddress } from "../delta/hash.js";
import { DeltaSet } from "../delta/set.js";
import { verifyDelta } from "../delta/sign.js";
import { packSet, unpackSet } from "../storage/pack.js";
import { decodeOrdinaryJournalCheckpoint, decodeOrdinaryPeerFrame } from "./ordinary-journal.js";
import {
  emptyDurablePeerState,
  decodeDurablePeerState,
  encodeDurablePeerState,
  planPermanentCommitFromVerified,
  validateDurablePeerStateTransition,
  type DurablePeerState,
  type PermanentCommitInput,
} from "./durable-state.js";
import { isCanonicalPeerId } from "./peer-identity.js";

const VERSION = 2;
const DIGEST = /^1e20[0-9a-f]{64}$/;

export interface PermanentJournalRebase {
  readonly peerId: string;
  /** Head that the store must compare before atomically replacing the old payload frames. */
  readonly prior: string;
  readonly state: DurablePeerState;
}

/** A new content-addressed anchor whose canonical image omits already refused payloads. */
export function encodePermanentJournalRebase(value: PermanentJournalRebase): Uint8Array {
  if (
    !isCanonicalPeerId(value.peerId) ||
    value.state.base.peerId !== value.peerId ||
    !DIGEST.test(value.prior)
  )
    throw new Error("permanent journal: invalid rebase peer or prior");
  if (value.state.events.length === 0)
    throw new Error("permanent journal: rebase requires refusal history");
  return encode(
    map([
      ["version", float(VERSION)],
      ["kind", tstr("rebase")],
      ["peer", tstr(value.peerId)],
      ["prior", tstr(value.prior)],
      ["image", bstr(encodeDurablePeerState(value.state))],
    ]),
  );
}

export function decodePermanentJournalRebase(bytesValue: Uint8Array): PermanentJournalRebase {
  const row = fields(decode(bytesValue), 5);
  if (number(row.get("version")) !== VERSION || text(row.get("kind")) !== "rebase")
    throw new Error("permanent journal: invalid rebase");
  const peerId = text(row.get("peer"));
  const value: PermanentJournalRebase = {
    peerId,
    prior: text(row.get("prior")),
    state: decodeDurablePeerState(bytes(row.get("image")), peerId),
  };
  const canonical = encodePermanentJournalRebase(value);
  if (canonical.length !== bytesValue.length || canonical.some((byte, i) => byte !== bytesValue[i]))
    throw new Error("permanent journal: noncanonical rebase");
  return value;
}

export type PermanentPeerFrame =
  | ({
      readonly kind: "admission";
      readonly peerId: string;
      readonly prior: string;
    } & PermanentCommitInput)
  | {
      readonly kind: "purge";
      readonly peerId: string;
      readonly prior: string;
      readonly targetId: string;
      readonly generation: number;
      readonly status: "failed" | "removed";
      readonly fault?: string;
    };

function text(value: CborValue | undefined): string {
  if (value?.t !== "tstr") throw new Error("permanent journal: expected text");
  return value.v;
}

function number(value: CborValue | undefined): number {
  if (value?.t !== "float") throw new Error("permanent journal: expected number");
  return value.v;
}

function bytes(value: CborValue | undefined): Uint8Array {
  if (value?.t !== "bstr") throw new Error("permanent journal: expected bytes");
  return value.v;
}

function fields(value: CborValue, count: number): Map<string, CborValue> {
  if (value.t !== "map" || value.v.length !== count)
    throw new Error("permanent journal: invalid fields");
  const row = new Map(value.v);
  if (row.size !== count) throw new Error("permanent journal: duplicate field");
  return row;
}

function validSender(sender: string, peerId: string): boolean {
  return (
    sender === "local" ||
    sender === "unattributed" ||
    (isCanonicalPeerId(sender) && sender !== peerId)
  );
}

function validateFrame(frame: PermanentPeerFrame): void {
  if (!isCanonicalPeerId(frame.peerId) || (frame.prior !== "" && !DIGEST.test(frame.prior)))
    throw new Error("permanent journal: invalid peer or prior");
  if (frame.kind === "purge") {
    if (
      !DIGEST.test(frame.targetId) ||
      !Number.isSafeInteger(frame.generation) ||
      frame.generation < 1 ||
      !["failed", "removed"].includes(frame.status) ||
      (frame.status === "failed" ? !frame.fault : frame.fault !== undefined)
    )
      throw new Error("permanent journal: invalid purge report");
    return;
  }
  if (
    !Number.isFinite(frame.at) ||
    !validSender(frame.sender, frame.peerId) ||
    !Number.isSafeInteger(frame.quotaCharge) ||
    frame.quotaCharge < 0 ||
    frame.additions.length === 0 ||
    frame.erasures.length === 0
  )
    throw new Error("permanent journal: invalid admission");
  const ids = new Set<string>();
  for (const delta of frame.additions) {
    if (ids.has(delta.id) || delta.sig === undefined || verifyDelta(delta) !== "verified")
      throw new Error("permanent journal: invalid signed addition");
    ids.add(delta.id);
  }
  const targets = new Set<string>();
  for (const group of frame.erasures) {
    if (
      !DIGEST.test(group.targetId) ||
      targets.has(group.targetId) ||
      group.orderIds.length === 0 ||
      typeof group.surfaceHoldsBytes !== "boolean" ||
      group.orderIds.some((id) => !ids.has(id))
    )
      throw new Error("permanent journal: invalid erasure group");
    for (const orderId of group.orderIds) {
      const order = frame.additions.find((delta) => delta.id === orderId)!;
      const signedTargets = order.claims.pointers
        .filter((pointer) => pointer.role === "erases" && pointer.target.kind === "delta")
        .map((pointer) => (pointer.target.kind === "delta" ? pointer.target.deltaRef.delta : ""));
      if (signedTargets.length !== 1 || signedTargets[0] !== group.targetId)
        throw new Error("permanent journal: effective order target is not signed");
    }
    targets.add(group.targetId);
  }
}

/** Version 2 frame bytes; version 1 ordinary frames remain readable in the same chain. */
export function encodePermanentPeerFrame(frame: PermanentPeerFrame): Uint8Array {
  validateFrame(frame);
  const common: [string, CborValue][] = [
    ["version", float(VERSION)],
    ["kind", tstr(frame.kind)],
    ["peer", tstr(frame.peerId)],
    ["prior", tstr(frame.prior)],
  ];
  if (frame.kind === "purge")
    return encode(
      map([
        ...common,
        ["target", tstr(frame.targetId)],
        ["generation", float(frame.generation)],
        ["status", tstr(frame.status)],
        ...(frame.fault === undefined ? [] : [["fault", tstr(frame.fault)] as [string, CborValue]]),
      ]),
    );
  return encode(
    map([
      ...common,
      ["at", float(frame.at)],
      ["sender", tstr(frame.sender)],
      ["pack", bstr(packSet(DeltaSet.from(frame.additions)))],
      ["quota", float(frame.quotaCharge)],
      [
        "erasures",
        array(
          [...frame.erasures]
            .sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0))
            .map((group) =>
              map([
                ["target", tstr(group.targetId)],
                ["orders", array([...group.orderIds].sort().map(tstr))],
                ["bytes", float(group.surfaceHoldsBytes ? 1 : 0)],
              ]),
            ),
        ),
      ],
    ]),
  );
}

export function decodePermanentPeerFrame(image: Uint8Array): PermanentPeerFrame {
  const raw = decode(image);
  if (raw.t !== "map") throw new Error("permanent journal: invalid fields");
  const initial = new Map(raw.v);
  if (initial.size !== raw.v.length || number(initial.get("version")) !== VERSION)
    throw new Error("permanent journal: unsupported version");
  const kind = text(initial.get("kind"));
  let frame: PermanentPeerFrame;
  if (kind === "purge") {
    const row = fields(raw, initial.has("fault") ? 8 : 7);
    frame = {
      kind,
      peerId: text(row.get("peer")),
      prior: text(row.get("prior")),
      targetId: text(row.get("target")),
      generation: number(row.get("generation")),
      status: text(row.get("status")) as "failed" | "removed",
      ...(row.has("fault") ? { fault: text(row.get("fault")) } : {}),
    };
  } else if (kind === "admission") {
    const row = fields(raw, 9);
    const erasures = row.get("erasures");
    if (erasures?.t !== "array") throw new Error("permanent journal: expected erasures");
    frame = {
      kind,
      peerId: text(row.get("peer")),
      prior: text(row.get("prior")),
      at: number(row.get("at")),
      sender: text(row.get("sender")),
      additions: [...unpackSet(bytes(row.get("pack")))],
      quotaCharge: number(row.get("quota")),
      erasures: erasures.v.map((value) => {
        const group = fields(value, 3);
        const orders = group.get("orders");
        if (orders?.t !== "array") throw new Error("permanent journal: expected orders");
        const byteFlag = number(group.get("bytes"));
        if (byteFlag !== 0 && byteFlag !== 1)
          throw new Error("permanent journal: invalid byte flag");
        return {
          targetId: text(group.get("target")),
          orderIds: orders.v.map((value) => text(value)),
          surfaceHoldsBytes: byteFlag === 1,
        };
      }),
    };
  } else throw new Error("permanent journal: invalid kind");
  const canonical = encodePermanentPeerFrame(frame);
  if (canonical.length !== image.length || canonical.some((byte, i) => byte !== image[i]))
    throw new Error("permanent journal: noncanonical frame");
  return frame;
}

/** Host reports physical absence before recording `removed`; an obligation never reopens. */
export function applyPermanentPeerFrame(
  before: DurablePeerState,
  frame: PermanentPeerFrame,
): DurablePeerState {
  validateFrame(frame);
  if (frame.peerId !== before.base.peerId) throw new Error("permanent journal: wrong peer");
  if (frame.kind === "admission") {
    if (
      frame.erasures.some(
        (group) => !group.surfaceHoldsBytes && before.base.admitted.has(group.targetId),
      )
    )
      throw new Error("permanent journal: held target cannot assert absence");
    return planPermanentCommitFromVerified(before, frame);
  }
  const prior = before.obligations.find(
    (row) => row.targetId === frame.targetId && row.generation === frame.generation,
  );
  if (prior === undefined || prior.status === "removed")
    throw new Error("permanent journal: no live purge obligation");
  const after: DurablePeerState = {
    ...before,
    obligations: before.obligations.map((row) => {
      if (row.sequence !== prior.sequence) return row;
      return {
        sequence: row.sequence,
        targetId: row.targetId,
        generation: row.generation,
        eventSequence: row.eventSequence,
        ...(row.priorEpoch === undefined ? {} : { priorEpoch: row.priorEpoch }),
        status: frame.status,
        ...(frame.fault === undefined ? {} : { fault: frame.fault }),
      };
    }),
  };
  encodeDurablePeerState(after);
  validateDurablePeerStateTransition(before, after);
  return after;
}

/** Verify a mixed ordinary/permanent chain, optionally after an ordinary-only checkpoint. */
export function replayPermanentPeerFrames(
  peerId: string,
  frames: readonly Uint8Array[],
  expectedHead: string,
  checkpointBytes?: Uint8Array,
): DurablePeerState {
  const checkpoint =
    checkpointBytes === undefined
      ? undefined
      : (() => {
          const raw = decode(checkpointBytes);
          if (raw.t !== "map") throw new Error("permanent journal: invalid checkpoint");
          const version = new Map(raw.v).get("version");
          if (version?.t !== "float") throw new Error("permanent journal: invalid checkpoint");
          if (version.v === 1) return decodeOrdinaryJournalCheckpoint(checkpointBytes);
          if (version.v === VERSION) {
            const rebased = decodePermanentJournalRebase(checkpointBytes);
            return {
              peerId: rebased.peerId,
              head: contentAddress(checkpointBytes),
              state: rebased.state,
            };
          }
          throw new Error("permanent journal: unsupported checkpoint");
        })();
  if (checkpoint !== undefined && checkpoint.peerId !== peerId)
    throw new Error("permanent journal: checkpoint peer mismatch");
  let state = checkpoint?.state ?? emptyDurablePeerState(peerId);
  let head = checkpoint?.head ?? "";
  for (const image of frames) {
    const value = decode(image);
    if (value.t !== "map") throw new Error("permanent journal: invalid frame");
    const version = new Map(value.v).get("version");
    if (version?.t !== "float") throw new Error("permanent journal: invalid frame version");
    if (version.v === 1) {
      const ordinary = decodeOrdinaryPeerFrame(image);
      if (ordinary.peerId !== peerId || ordinary.prior !== head)
        throw new Error("permanent journal: broken frame chain");
      state = planPermanentCommitFromVerified(state, {
        additions: ordinary.additions,
        erasures: [],
        quotaCharge: ordinary.additions.length,
        at: ordinary.at,
        sender: ordinary.sender,
      });
    } else if (version.v === VERSION) {
      const permanent = decodePermanentPeerFrame(image);
      if (permanent.peerId !== peerId || permanent.prior !== head)
        throw new Error("permanent journal: broken frame chain");
      state = applyPermanentPeerFrame(state, permanent);
    } else throw new Error("permanent journal: unsupported frame version");
    head = contentAddress(image);
  }
  if (head !== expectedHead) throw new Error("permanent journal: head mismatch");
  encodeDurablePeerState(state);
  return state;
}
