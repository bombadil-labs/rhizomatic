// Internal closed staging image. It persists inherited refusals but cannot admit or serve.
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { bstr, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { contentAddress } from "../delta/hash.js";
import {
  decodeDurablePeerState,
  encodeDurablePeerState,
  type DurablePeerState,
} from "./durable-state.js";
import type { PeerStateWriteOutcome } from "./peer-state.js";
import { samePeerId } from "./peer-identity.js";
import {
  decodeRefusalSnapshot,
  encodeRefusalSnapshot,
  localRefusalSnapshot,
  verifyRefusalSnapshotCopy,
  type RefusalSnapshot,
} from "./refusal-snapshot.js";

const VERSION = 3;

export interface ClosedPeerState {
  readonly local: DurablePeerState;
  readonly inherited: RefusalSnapshot;
}

function validate(state: ClosedPeerState): { localBytes: Uint8Array; inheritedBytes: Uint8Array } {
  const localBytes = encodeDurablePeerState(state.local);
  const inheritedBytes = encodeRefusalSnapshot(state.inherited);
  const peerId = state.local.base.peerId;
  if (state.inherited.events.some((event) => samePeerId(event.sourcePeerId, peerId)))
    throw new Error("closed peer state: inherited event uses local peer id");
  if (state.inherited.current.some((row) => state.local.base.admitted.has(row.targetId)))
    throw new Error("closed peer state: inherited refusal is locally admitted");
  encodeRefusalSnapshot(completeRefusalSnapshotUnchecked(state));
  return { localBytes, inheritedBytes };
}

function completeRefusalSnapshotUnchecked(state: ClosedPeerState): RefusalSnapshot {
  const local = localRefusalSnapshot(state.local);
  const current = new Map(state.inherited.current.map((row) => [row.targetId, row]));
  for (const row of local.current) current.set(row.targetId, row);
  return { events: [...state.inherited.events, ...local.events], current: [...current.values()] };
}

/** Full qualified history for a later handoff; new local events supersede inherited current refs. */
export function completeRefusalSnapshot(state: ClosedPeerState): RefusalSnapshot {
  validate(state);
  return completeRefusalSnapshotUnchecked(state);
}

/** Canonical closed image. Its inherited bytes are retained across reopen. */
export function encodeClosedPeerState(state: ClosedPeerState): Uint8Array {
  const { localBytes, inheritedBytes } = validate(state);
  return encode(
    map([
      ["version", float(VERSION)],
      ["peer", tstr(state.local.base.peerId)],
      ["local", bstr(localBytes)],
      ["inherited", bstr(inheritedBytes)],
      ["inheritedDigest", tstr(contentAddress(inheritedBytes))],
    ]),
  );
}

function fields(value: CborValue): Map<string, CborValue> {
  if (value.t !== "map" || value.v.length !== 5)
    throw new Error("closed peer state: invalid fields");
  const result = new Map(value.v);
  if (result.size !== 5) throw new Error("closed peer state: duplicate fields");
  return result;
}

function bytes(value: CborValue | undefined): Uint8Array {
  if (value?.t !== "bstr") throw new Error("closed peer state: expected bytes");
  return value.v;
}

function string(value: CborValue | undefined): string {
  if (value?.t !== "tstr") throw new Error("closed peer state: expected text");
  return value.v;
}

export function decodeClosedPeerState(image: Uint8Array, expectedPeerId: string): ClosedPeerState {
  const top = fields(decode(image));
  const version = top.get("version");
  if (version?.t !== "float" || version.v !== VERSION)
    throw new Error("closed peer state: unsupported version");
  const peerId = string(top.get("peer"));
  if (peerId !== expectedPeerId) throw new Error("closed peer state: wrong peer id");
  const inheritedBytes = bytes(top.get("inherited"));
  verifyRefusalSnapshotCopy(string(top.get("inheritedDigest")), inheritedBytes);
  const state: ClosedPeerState = {
    local: decodeDurablePeerState(bytes(top.get("local")), peerId),
    inherited: decodeRefusalSnapshot(inheritedBytes),
  };
  if (!Buffer.from(encodeClosedPeerState(state)).equals(Buffer.from(image)))
    throw new Error("closed peer state: noncanonical image");
  return state;
}

/** Stage once under a single writer after an independent recovery file already exists. */
export function stageClosedPeerState(
  path: string,
  recoveryPath: string,
  state: ClosedPeerState,
): PeerStateWriteOutcome {
  if (resolve(path) === resolve(recoveryPath))
    throw new Error("closed peer state: recovery path must be separate");
  const image = encodeClosedPeerState(state);
  if (existsSync(path)) throw new Error("closed peer state: stage already exists");
  const inheritedBytes = encodeRefusalSnapshot(state.inherited);
  const backupFd = openSync(recoveryPath, "r");
  try {
    verifyRefusalSnapshotCopy(contentAddress(inheritedBytes), readFileSync(backupFd));
    fsyncSync(backupFd);
  } finally {
    closeSync(backupFd);
  }
  const backupDirFd = openSync(dirname(recoveryPath), "r");
  try {
    fsyncSync(backupDirFd);
  } finally {
    closeSync(backupDirFd);
  }
  const temp = `${path}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  const dirFd = openSync(dirname(path), "r");
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    let offset = 0;
    while (offset < image.length) offset += writeSync(fd, image, offset, image.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temp, path); // fails if a concurrent stage already created the path
    try {
      unlinkSync(temp);
      fsyncSync(dirFd);
      return { status: "durable" };
    } catch (error) {
      return { status: "committed-unconfirmed", fault: String(error) };
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) {
      try {
        unlinkSync(temp);
      } catch {
        // A failed cleanup after the primary link exists is already reported as uncertain.
      }
    }
    closeSync(dirFd);
  }
}

export function readClosedPeerState(
  path: string,
  expectedPeerId: string,
): ClosedPeerState | undefined {
  if (!existsSync(path)) return undefined;
  return decodeClosedPeerState(readFileSync(path), expectedPeerId);
}
