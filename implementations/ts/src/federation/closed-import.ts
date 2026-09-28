// Internal v4 closed handoff stage. Durable bytes alone never prove import or grant serving.
import { randomBytes } from "node:crypto";
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
import { dirname, resolve } from "node:path";
import { bstr, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { contentAddress } from "../delta/hash.js";
import {
  decodeImportedHoldings,
  encodeImportedHoldings,
  type ImportedHoldings,
} from "./imported-holdings.js";
import {
  decodeImportedObligations,
  encodeImportedObligations,
  type ImportedObligationCarry,
} from "./imported-obligations.js";
import {
  decodeClosedPeerState,
  encodeClosedPeerState,
  type ClosedPeerState,
} from "./inherited-state.js";
import type { PeerStateWriteOutcome } from "./peer-state.js";
import { encodeRefusalSnapshot, verifyRefusalSnapshotCopy } from "./refusal-snapshot.js";

const VERSION = 4;

function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i === value.length) return false;
      const low = value.charCodeAt(i);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export interface ClosedImportState {
  readonly attemptId: string;
  readonly oldPeerId: string;
  readonly oldStateVersion: number;
  readonly deadline: number;
  readonly closed: ClosedPeerState;
  readonly obligations: ImportedObligationCarry;
  readonly holdings: ImportedHoldings;
  readonly policyFormat: string;
  readonly policyBytes: Uint8Array;
}

function emptyLocal(closed: ClosedPeerState): boolean {
  const local = closed.local;
  return (
    local.base.admitted.size === 0 &&
    local.base.arrivals.length === 0 &&
    local.base.cursor.lastSequence === 0 &&
    local.base.cursor.lastTransfer === 0 &&
    local.base.refusedIds.size === 0 &&
    local.refusalCounter === 0 &&
    local.obligationCounter === 0 &&
    local.quotaUsed === 0 &&
    local.events.length === 0 &&
    local.exclusions.length === 0 &&
    local.obligations.length === 0
  );
}

function components(state: ClosedImportState) {
  if (
    !state.attemptId ||
    !wellFormed(state.attemptId) ||
    !state.oldPeerId ||
    !wellFormed(state.oldPeerId) ||
    state.oldPeerId === state.closed.local.base.peerId ||
    !Number.isSafeInteger(state.oldStateVersion) ||
    state.oldStateVersion < 0 ||
    !Number.isFinite(state.deadline) ||
    !state.policyFormat ||
    !wellFormed(state.policyFormat) ||
    state.policyBytes.length === 0
  )
    throw new Error("closed import: invalid attempt or policy descriptor");
  if (!emptyLocal(state.closed)) throw new Error("closed import: local candidate is not empty");
  if (
    state.obligations.obligations.some((row) => row.sourcePeerId === state.closed.local.base.peerId)
  )
    throw new Error("closed import: carried obligation uses new peer id");
  const closed = encodeClosedPeerState(state.closed);
  const obligations = encodeImportedObligations(state.closed.inherited, state.obligations);
  const holdings = encodeImportedHoldings(state.closed.inherited, state.holdings);
  return { closed, obligations, holdings };
}

function carriedBytes(parts: ReturnType<typeof components>): Uint8Array {
  return encode(
    map([
      ["closed", bstr(parts.closed)],
      ["obligations", bstr(parts.obligations)],
      ["holdings", bstr(parts.holdings)],
    ]),
  );
}

function policyBytes(state: ClosedImportState): Uint8Array {
  return encode(
    map([
      ["format", tstr(state.policyFormat)],
      ["bytes", bstr(state.policyBytes)],
    ]),
  );
}

/** Digest the validated canonical carried components, excluding attempt and destination policy. */
export function closedImportCarriedDigest(state: ClosedImportState): string {
  return contentAddress(carriedBytes(components(state)));
}

/** Digest the destination policy format and opaque bytes as one object. */
export function closedImportPolicyDigest(state: ClosedImportState): string {
  components(state);
  return contentAddress(policyBytes(state));
}

export function encodeClosedImportState(state: ClosedImportState): Uint8Array {
  const parts = components(state);
  return encode(
    map([
      ["version", float(VERSION)],
      ["peer", tstr(state.closed.local.base.peerId)],
      ["oldPeer", tstr(state.oldPeerId)],
      ["attempt", tstr(state.attemptId)],
      ["oldVersion", float(state.oldStateVersion)],
      ["deadline", float(state.deadline)],
      ["closed", bstr(parts.closed)],
      ["obligations", bstr(parts.obligations)],
      ["holdings", bstr(parts.holdings)],
      ["carriedDigest", tstr(contentAddress(carriedBytes(parts)))],
      ["policyFormat", tstr(state.policyFormat)],
      ["policy", bstr(state.policyBytes)],
      ["policyDigest", tstr(contentAddress(policyBytes(state)))],
    ]),
  );
}

function fields(value: CborValue): Map<string, CborValue> {
  if (value.t !== "map" || value.v.length !== 13) throw new Error("closed import: invalid fields");
  const result = new Map(value.v);
  if (result.size !== 13) throw new Error("closed import: duplicate fields");
  return result;
}

function string(value: CborValue | undefined): string {
  if (value?.t !== "tstr") throw new Error("closed import: expected text");
  return value.v;
}

function number(value: CborValue | undefined): number {
  if (value?.t !== "float") throw new Error("closed import: expected number");
  return value.v;
}

function bytes(value: CborValue | undefined): Uint8Array {
  if (value?.t !== "bstr") throw new Error("closed import: expected bytes");
  return value.v;
}

export function decodeClosedImportState(
  image: Uint8Array,
  expectedPeerId: string,
): ClosedImportState {
  const top = fields(decode(image));
  if (number(top.get("version")) !== VERSION) throw new Error("closed import: unsupported version");
  const peerId = string(top.get("peer"));
  if (peerId !== expectedPeerId) throw new Error("closed import: wrong peer id");
  const closed = decodeClosedPeerState(bytes(top.get("closed")), peerId);
  const state: ClosedImportState = {
    attemptId: string(top.get("attempt")),
    oldPeerId: string(top.get("oldPeer")),
    oldStateVersion: number(top.get("oldVersion")),
    deadline: number(top.get("deadline")),
    closed,
    obligations: decodeImportedObligations(bytes(top.get("obligations")), closed.inherited),
    holdings: decodeImportedHoldings(bytes(top.get("holdings")), closed.inherited),
    policyFormat: string(top.get("policyFormat")),
    policyBytes: bytes(top.get("policy")),
  };
  if (string(top.get("carriedDigest")) !== closedImportCarriedDigest(state))
    throw new Error("closed import: wrong carried digest");
  if (string(top.get("policyDigest")) !== closedImportPolicyDigest(state))
    throw new Error("closed import: wrong policy digest");
  if (!Buffer.from(encodeClosedImportState(state)).equals(Buffer.from(image)))
    throw new Error("closed import: noncanonical image");
  return state;
}

/** Create the primary once after a separate snapshot recovery copy is verified and synced. */
export function stageClosedImportState(
  path: string,
  recoveryPath: string,
  state: ClosedImportState,
): PeerStateWriteOutcome {
  if (resolve(path) === resolve(recoveryPath))
    throw new Error("closed import: recovery path must be separate");
  const image = encodeClosedImportState(state);
  if (existsSync(path)) throw new Error("closed import: stage already exists");
  const inheritedBytes = encodeRefusalSnapshot(state.closed.inherited);
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
    while (offset < image.length) {
      const written = writeSync(fd, image, offset, image.length - offset);
      if (written === 0) throw new Error("closed import: zero-length write");
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temp, path);
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
        // A cleanup fault after primary creation is reported as uncertain.
      }
    }
    closeSync(dirFd);
  }
}

export function readClosedImportState(
  path: string,
  expectedPeerId: string,
): ClosedImportState | undefined {
  if (!existsSync(path)) return undefined;
  return decodeClosedImportState(readFileSync(path), expectedPeerId);
}
