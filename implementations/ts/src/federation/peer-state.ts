// Peer-local logical state image for a single-writer durable admission store (SPEC-6 vNext §§2–3).
// A file replacement commits this image as one unit. It is not an admission decision by itself.

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
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { array, bstr, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { computeId } from "../delta/delta.js";
import { DeltaSet } from "../delta/set.js";
import { verifyDelta } from "../delta/sign.js";
import { packSet, unpackSet } from "../storage/pack.js";
import type { ArrivalCursor, ArrivalRecord } from "./arrival.js";

const VERSION = 1;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

export interface PeerState {
  readonly peerId: string;
  readonly admitted: DeltaSet;
  readonly cursor: ArrivalCursor;
  /** Full peer-local history in sequence order. */
  readonly arrivals: readonly ArrivalRecord[];
  readonly refusedIds: ReadonlySet<string>;
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SEQUENCE;
}

function validateState(state: PeerState): void {
  if (!state.peerId) throw new Error("peer state: peer id must not be empty");
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
    if (!row.id || !row.sender || !Number.isFinite(row.at) || row.sequence !== i + 1)
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
    activeEpochs.add(row.id);
  }
  if (lastTransfer !== state.cursor.lastTransfer)
    throw new Error("peer state: transfer history does not match cursor");
  for (const id of state.refusedIds) {
    if (!id || state.admitted.has(id)) throw new Error("peer state: invalid refusal set");
  }
  for (const delta of state.admitted) {
    if (!activeEpochs.has(delta.id)) throw new Error("peer state: admitted id has no arrival");
    if (computeId(delta.claims) !== delta.id)
      throw new Error("peer state: invalid admitted content id");
    if (delta.sig !== undefined && verifyDelta(delta) !== "verified")
      throw new Error("peer state: invalid admitted signature");
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
  if (Buffer.compare(Buffer.from(encodePeerState(state)), Buffer.from(bytes)) !== 0)
    throw new Error("peer state: noncanonical image");
  return state;
}

/** Single-writer file backend. The caller serializes writes for this peer and directory. */
export function writePeerState(path: string, state: PeerState): void {
  const bytes = encodePeerState(state);
  const temp = `${path}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function readPeerState(path: string, expectedPeerId: string): PeerState | undefined {
  if (!existsSync(path)) return undefined;
  return decodePeerState(readFileSync(path), expectedPeerId);
}
