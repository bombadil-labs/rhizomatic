// Internal single-writer image for the currently held set, full first-epoch arrival history, and
// permanent refusals. This is not the complete SPEC-6 admission or handoff transaction: it has no
// purge obligations, exclusion epochs, quota counters, re-entry acts, or handoff record.

import { array, bstr, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { computeId } from "../delta/delta.js";
import { DeltaSet } from "../delta/set.js";
import { verifyDelta } from "../delta/sign.js";
import { packSet, unpackSet } from "../storage/pack.js";
import type { Delta } from "../delta/types.js";
import type { ArrivalCursor, ArrivalRecord } from "./arrival.js";

const VERSION = 1;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const DELTA_ID = /^1e20[0-9a-f]{64}$/;
// Recompute the content id on every validation, so a runtime mutation cannot reuse a prior
// result. Strict Ed25519 verification is reusable only while this object's id and signature
// remain equal to the verified pair.
const verifiedSignatures = new WeakMap<Delta, { id: string; sig: string }>();

function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch >= 0xd800 && ch <= 0xdbff) {
      if (++i >= text.length) return false;
      const low = text.charCodeAt(i);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (ch >= 0xdc00 && ch <= 0xdfff) return false;
  }
  return true;
}

export interface PeerState {
  readonly peerId: string;
  readonly admitted: DeltaSet;
  readonly cursor: ArrivalCursor;
  /** Full peer-local history in sequence order. */
  readonly arrivals: readonly ArrivalRecord[];
  /** Permanent refusals only; lower-posture re-entry needs a later image version. */
  readonly refusedIds: ReadonlySet<string>;
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SEQUENCE;
}

function validateState(state: PeerState): void {
  if (!state.peerId || !wellFormed(state.peerId))
    throw new Error("peer state: invalid peer id text");
  if (!validCounter(state.cursor.lastSequence) || !validCounter(state.cursor.lastTransfer))
    throw new Error("peer state: invalid arrival cursor");
  if (state.arrivals.length !== state.cursor.lastSequence)
    throw new Error("peer state: arrival history does not match cursor");
  let lastTransfer = 0;
  let lastId = "";
  let lastAt = 0;
  let lastSender = "";
  const activeEpochs = new Set<string>();
  for (let i = 0; i < state.arrivals.length; i++) {
    const row = state.arrivals[i]!;
    if (
      !DELTA_ID.test(row.id) ||
      !row.sender ||
      !wellFormed(row.sender) ||
      !Number.isFinite(row.at) ||
      row.sequence !== i + 1
    )
      throw new Error("peer state: invalid arrival record");
    if (
      !validCounter(row.transfer) ||
      row.transfer === 0 ||
      row.transfer < lastTransfer ||
      row.transfer > lastTransfer + 1
    )
      throw new Error("peer state: invalid transfer ordinal");
    if (
      row.transfer === lastTransfer &&
      (row.id <= lastId || row.at !== lastAt || row.sender !== lastSender)
    )
      throw new Error("peer state: inconsistent transfer arrivals");
    lastTransfer = row.transfer;
    lastId = row.id;
    lastAt = row.at;
    lastSender = row.sender;
    if (activeEpochs.has(row.id))
      throw new Error("peer state: repeated arrival epoch needs a richer image");
    activeEpochs.add(row.id);
  }
  if (lastTransfer !== state.cursor.lastTransfer)
    throw new Error("peer state: transfer history does not match cursor");
  for (const id of state.refusedIds) {
    if (!DELTA_ID.test(id) || state.admitted.has(id))
      throw new Error("peer state: invalid refusal set");
  }
  for (const id of activeEpochs) {
    if (!state.admitted.has(id) && !state.refusedIds.has(id))
      throw new Error("peer state: arrived id has no holding or refusal");
  }
  for (const delta of state.admitted) {
    if (!activeEpochs.has(delta.id)) throw new Error("peer state: admitted id has no arrival");
    if (computeId(delta.claims) !== delta.id)
      throw new Error("peer state: invalid admitted content id");
    const verified = verifiedSignatures.get(delta);
    if (delta.sig !== undefined && (verified?.id !== delta.id || verified.sig !== delta.sig)) {
      if (verifyDelta(delta) !== "verified")
        throw new Error("peer state: invalid admitted signature");
      verifiedSignatures.set(delta, { id: delta.id, sig: delta.sig });
    }
  }
}

export function validatePeerStateTransition(before: PeerState, after: PeerState): void {
  if (after.arrivals.length < before.arrivals.length)
    throw new Error("peer state: arrival history cannot shrink");
  for (let i = 0; i < before.arrivals.length; i++) {
    const a = before.arrivals[i]!;
    const b = after.arrivals[i]!;
    if (
      a.id !== b.id ||
      a.at !== b.at ||
      a.sequence !== b.sequence ||
      a.transfer !== b.transfer ||
      a.sender !== b.sender
    )
      throw new Error("peer state: prior arrival testimony changed");
  }
  if (
    after.arrivals.length > before.arrivals.length &&
    after.arrivals[before.arrivals.length]!.transfer !== before.cursor.lastTransfer + 1
  )
    throw new Error("peer state: new arrival must start a new transfer");
  for (const id of before.refusedIds) {
    if (!after.refusedIds.has(id))
      throw new Error("peer state: permanent refusal cannot be removed");
  }
  for (const prior of before.admitted) {
    const current = after.admitted.get(prior.id);
    if (current !== undefined && current.sig !== prior.sig)
      throw new Error("peer state: admitted signature changed");
  }
}

function object(value: CborValue, label: string): Map<string, CborValue> {
  if (value.t !== "map") throw new Error(`peer state: ${label} must be a map`);
  const out = new Map(value.v);
  if (out.size !== value.v.length) throw new Error(`peer state: duplicate ${label} key`);
  return out;
}
function number(value: CborValue | undefined, label: string): number {
  if (value?.t !== "float") throw new Error(`peer state: ${label} must be a number`);
  return value.v;
}
function string(value: CborValue | undefined, label: string): string {
  if (value?.t !== "tstr") throw new Error(`peer state: ${label} must be text`);
  return value.v;
}
function items(value: CborValue | undefined, label: string): readonly CborValue[] {
  if (value?.t !== "array") throw new Error(`peer state: ${label} must be an array`);
  return value.v;
}

/** Canonical private state image; both witnesses emit identical bytes. */
export function encodePeerState(state: PeerState): Uint8Array {
  validateState(state);
  return encode(
    map([
      ["version", float(VERSION)],
      ["peer", tstr(state.peerId)],
      ["pack", bstr(packSet(state.admitted))],
      ["sequence", float(state.cursor.lastSequence)],
      ["transfer", float(state.cursor.lastTransfer)],
      [
        "arrivals",
        array(
          state.arrivals.map((row) =>
            map([
              ["id", tstr(row.id)],
              ["at", float(row.at)],
              ["sequence", float(row.sequence)],
              ["transfer", float(row.transfer)],
              ["sender", tstr(row.sender)],
            ]),
          ),
        ),
      ],
      ["refused", array([...state.refusedIds].sort().map(tstr))],
    ]),
  );
}

export function decodePeerState(bytes: Uint8Array, expectedPeerId: string): PeerState {
  const top = object(decode(bytes), "image");
  if (top.size !== 7 || number(top.get("version"), "version") !== VERSION)
    throw new Error("peer state: unsupported image version or fields");
  const peerId = string(top.get("peer"), "peer");
  if (peerId !== expectedPeerId) throw new Error("peer state: wrong peer id");
  const pack = top.get("pack");
  if (pack?.t !== "bstr") throw new Error("peer state: pack must be bytes");
  const arrivals = items(top.get("arrivals"), "arrivals").map((value): ArrivalRecord => {
    const row = object(value, "arrival");
    if (row.size !== 5) throw new Error("peer state: invalid arrival fields");
    return {
      id: string(row.get("id"), "arrival id"),
      at: number(row.get("at"), "arrival at"),
      sequence: number(row.get("sequence"), "arrival sequence"),
      transfer: number(row.get("transfer"), "arrival transfer"),
      sender: string(row.get("sender"), "arrival sender"),
    };
  });
  const refused = items(top.get("refused"), "refused").map((v) => string(v, "refused id"));
  if (new Set(refused).size !== refused.length) throw new Error("peer state: duplicate refusal");
  const state: PeerState = {
    peerId,
    admitted: unpackSet(pack.v),
    cursor: {
      lastSequence: number(top.get("sequence"), "sequence"),
      lastTransfer: number(top.get("transfer"), "transfer"),
    },
    arrivals,
    refusedIds: new Set(refused),
  };
  validateState(state);
  const canonical = encodePeerState(state);
  if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i]))
    throw new Error("peer state: noncanonical image");
  return state;
}

export type PeerStateWriteOutcome =
  | { readonly status: "durable" }
  | { readonly status: "committed-unconfirmed"; readonly fault: string };
