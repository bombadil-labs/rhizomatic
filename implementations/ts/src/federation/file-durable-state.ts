// Node-only single-writer file persistence for the durable peer image.
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
  decodeDurablePeerState,
  encodeDurablePeerState,
  validateDurablePeerStateTransition,
  type DurablePeerState,
} from "./durable-state.js";
import type { PeerStateWriteOutcome } from "./peer-state.js";

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
  if (before !== undefined) validateDurablePeerStateTransition(before, state);
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
