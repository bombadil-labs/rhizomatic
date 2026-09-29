// Node-only single-writer file persistence for a peer image.
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
import {
  decodePeerState,
  encodePeerState,
  validatePeerStateTransition,
  type PeerState,
  type PeerStateWriteOutcome,
} from "./peer-state.js";

/** Single-writer file backend. An uncertain post-rename sync is reported distinctly from failure. */
export function writePeerState(path: string, state: PeerState): PeerStateWriteOutcome {
  const bytes = encodePeerState(state);
  const before = readPeerState(path, state.peerId);
  if (before !== undefined) validatePeerStateTransition(before, state);
  const temp = `${path}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  let fd: number | undefined;
  const dirFd = openSync(dirname(path), "r");
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

export function readPeerState(path: string, expectedPeerId: string): PeerState | undefined {
  if (!existsSync(path)) return undefined;
  return decodePeerState(readFileSync(path), expectedPeerId);
}
