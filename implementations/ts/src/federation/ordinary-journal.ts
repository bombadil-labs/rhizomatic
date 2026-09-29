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
  encodeDurablePeerState,
  type DurablePeerState,
} from "./durable-state.js";
import { isCanonicalPeerId } from "./peer-identity.js";
import { rememberVerifiedSignature } from "./peer-state.js";

const VERSION = 1;
const FRAME_ID = /^1e20[0-9a-f]{64}$/;

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
): DurablePeerState {
  const empty = emptyDurablePeerState(peerId);
  const admitted = new DeltaSet();
  const arrivals = [] as Array<(typeof empty.base.arrivals)[number]>;
  let cursor = empty.base.cursor;
  let quotaUsed = 0;
  let head = "";
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
    ...empty,
    base: { ...empty.base, admitted, cursor, arrivals },
    quotaUsed,
  };
  encodeDurablePeerState(state);
  return state;
}
