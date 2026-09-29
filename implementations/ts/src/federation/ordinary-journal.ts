// Canonical append records for signed-loose ordinary admissions. Storage CAS is a separate seam.
import { bstr, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { DeltaSet } from "../delta/set.js";
import { verifyDelta } from "../delta/sign.js";
import { contentAddress } from "../delta/hash.js";
import type { Delta } from "../delta/types.js";
import { packSet, unpackSet } from "../storage/pack.js";
import { planArrivals } from "./arrival.js";
import {
  emptyDurablePeerState,
  decodeDurablePeerState,
  encodeDurablePeerState,
  type DurablePeerState,
} from "./durable-state.js";
import { isCanonicalPeerId } from "./peer-identity.js";
import { rememberVerifiedSignature } from "./peer-state.js";

const VERSION = 1;
const FRAME_ID = /^1e20[0-9a-f]{64}$/;

export interface OrdinaryJournalCheckpoint {
  readonly peerId: string;
  readonly head: string;
  readonly state: DurablePeerState;
}

function ordinaryCheckpointState(state: DurablePeerState): void {
  if (
    state.events.length !== 0 ||
    state.exclusions.length !== 0 ||
    state.obligations.length !== 0 ||
    state.base.refusedIds.size !== 0 ||
    state.quotaUsed !== state.base.admitted.size ||
    state.base.cursor.lastSequence !== state.base.admitted.size
  )
    throw new Error("ordinary journal: checkpoint is not ordinary-only");
}

/** Canonical verified prefix and its exact frame-chain boundary. */
export function encodeOrdinaryJournalCheckpoint(checkpoint: OrdinaryJournalCheckpoint): Uint8Array {
  if (!isCanonicalPeerId(checkpoint.peerId) || checkpoint.state.base.peerId !== checkpoint.peerId)
    throw new Error("ordinary journal: checkpoint peer mismatch");
  if (checkpoint.head !== "" && !FRAME_ID.test(checkpoint.head))
    throw new Error("ordinary journal: invalid checkpoint head");
  ordinaryCheckpointState(checkpoint.state);
  if ((checkpoint.head === "") !== (checkpoint.state.base.admitted.size === 0))
    throw new Error("ordinary journal: checkpoint head/state mismatch");
  return encode(
    map([
      ["version", float(VERSION)],
      ["peer", tstr(checkpoint.peerId)],
      ["head", tstr(checkpoint.head)],
      ["image", bstr(encodeDurablePeerState(checkpoint.state))],
    ]),
  );
}

export function decodeOrdinaryJournalCheckpoint(bytes: Uint8Array): OrdinaryJournalCheckpoint {
  const value = decode(bytes);
  if (value.t !== "map" || value.v.length !== 4)
    throw new Error("ordinary journal: invalid checkpoint fields");
  const row = new Map(value.v);
  if (row.size !== 4 || row.get("version")?.t !== "float" || row.get("version")?.v !== VERSION)
    throw new Error("ordinary journal: invalid checkpoint fields");
  const image = row.get("image");
  if (image?.t !== "bstr") throw new Error("ordinary journal: invalid checkpoint image");
  const peerId = string(row.get("peer"));
  const checkpoint = {
    peerId,
    head: string(row.get("head")),
    state: decodeDurablePeerState(image.v, peerId),
  };
  const canonical = encodeOrdinaryJournalCheckpoint(checkpoint);
  if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i]))
    throw new Error("ordinary journal: noncanonical checkpoint");
  return checkpoint;
}

export interface OrdinaryPeerFrame {
  readonly peerId: string;
  /** Empty for the first frame; otherwise the content id of the preceding frame. */
  readonly prior: string;
  readonly at: number;
  readonly sender: string;
  /** Nonempty, distinct, verified signed loose deltas. */
  readonly additions: readonly Delta[];
}

function validFrame(frame: OrdinaryPeerFrame): void {
  if (!isCanonicalPeerId(frame.peerId)) throw new Error("ordinary journal: invalid peer id");
  if (frame.prior !== "" && !FRAME_ID.test(frame.prior))
    throw new Error("ordinary journal: invalid prior head");
  if (
    frame.sender !== "local" &&
    frame.sender !== "unattributed" &&
    (!isCanonicalPeerId(frame.sender) || frame.sender === frame.peerId)
  )
    throw new Error("ordinary journal: invalid sender");
  if (!Number.isFinite(frame.at)) throw new Error("ordinary journal: invalid arrival time");
  if (frame.additions.length === 0) throw new Error("ordinary journal: empty transfer");
  const ids = new Set<string>();
  for (const delta of frame.additions) {
    if (ids.has(delta.id) || delta.sig === undefined || verifyDelta(delta) !== "verified")
      throw new Error("ordinary journal: invalid signed addition");
    rememberVerifiedSignature(delta);
    ids.add(delta.id);
  }
}

/** Canonical one-transfer append bytes; a frame never records a no-op. */
export function encodeOrdinaryPeerFrame(frame: OrdinaryPeerFrame): Uint8Array {
  validFrame(frame);
  return encode(
    map([
      ["version", float(VERSION)],
      ["peer", tstr(frame.peerId)],
      ["prior", tstr(frame.prior)],
      ["at", float(frame.at)],
      ["sender", tstr(frame.sender)],
      ["pack", bstr(packSet(DeltaSet.from(frame.additions)))],
    ]),
  );
}

function fields(value: CborValue): Map<string, CborValue> {
  if (value.t !== "map" || value.v.length !== 6)
    throw new Error("ordinary journal: invalid frame fields");
  const out = new Map(value.v);
  if (out.size !== 6) throw new Error("ordinary journal: duplicate frame field");
  return out;
}
function string(value: CborValue | undefined): string {
  if (value?.t !== "tstr") throw new Error("ordinary journal: expected text");
  return value.v;
}

export function decodeOrdinaryPeerFrame(bytes: Uint8Array): OrdinaryPeerFrame {
  const row = fields(decode(bytes));
  if (row.get("version")?.t !== "float" || row.get("version")?.v !== VERSION)
    throw new Error("ordinary journal: unsupported frame version");
  if (row.get("at")?.t !== "float") throw new Error("ordinary journal: expected arrival time");
  const pack = row.get("pack");
  if (pack?.t !== "bstr") throw new Error("ordinary journal: expected pack bytes");
  const frame: OrdinaryPeerFrame = {
    peerId: string(row.get("peer")),
    prior: string(row.get("prior")),
    at: row.get("at")!.v as number,
    sender: string(row.get("sender")),
    additions: [...unpackSet(pack.v)],
  };
  const canonical = encodeOrdinaryPeerFrame(frame);
  if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i]))
    throw new Error("ordinary journal: noncanonical frame");
  return frame;
}

export function ordinaryPeerFrameId(bytes: Uint8Array): string {
  decodeOrdinaryPeerFrame(bytes);
  return contentAddress(bytes);
}

/** Reconstruct and validate one ordinary-only peer from its complete committed frame chain. */
export function replayOrdinaryPeerFrames(
  peerId: string,
  frames: readonly Uint8Array[],
  expectedHead: string,
  checkpointBytes?: Uint8Array,
): DurablePeerState {
  const initial =
    checkpointBytes === undefined ? undefined : decodeOrdinaryJournalCheckpoint(checkpointBytes);
  if (initial !== undefined && initial.peerId !== peerId)
    throw new Error("ordinary journal: checkpoint peer mismatch");
  const base = initial?.state ?? emptyDurablePeerState(peerId);
  const admitted = DeltaSet.from(base.base.admitted);
  const arrivals = [...base.base.arrivals];
  let cursor = base.base.cursor;
  let quotaUsed = base.quotaUsed;
  let head = initial?.head ?? "";
  for (const bytes of frames) {
    const frame = decodeOrdinaryPeerFrame(bytes);
    if (frame.peerId !== peerId || frame.prior !== head)
      throw new Error("ordinary journal: broken frame chain");
    for (const delta of frame.additions) {
      if (admitted.has(delta.id)) throw new Error("ordinary journal: repeated admitted id");
      admitted.add(delta);
    }
    const arrival = planArrivals(
      cursor,
      new Set(),
      frame.additions.map((delta) => delta.id),
      frame.at,
      frame.sender,
    );
    if (quotaUsed > Number.MAX_SAFE_INTEGER - frame.additions.length)
      throw new Error("ordinary journal: quota counter exhausted");
    cursor = { lastSequence: arrival.lastSequence, lastTransfer: arrival.lastTransfer };
    arrivals.push(...arrival.arrivals);
    quotaUsed += frame.additions.length;
    head = contentAddress(bytes);
  }
  if (head !== expectedHead) throw new Error("ordinary journal: head mismatch");
  const state: DurablePeerState = {
    ...base,
    base: { ...base.base, admitted, cursor, arrivals },
    quotaUsed,
  };
  encodeDurablePeerState(state);
  return state;
}
