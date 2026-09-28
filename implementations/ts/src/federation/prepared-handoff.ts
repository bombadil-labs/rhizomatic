// An old-peer signature over preparation is not a durable commit or permission to serve.
import { ed25519 } from "@noble/curves/ed25519";
import { hexToBytes } from "@noble/hashes/utils";
import { bstr, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { authorForSeed, verifySigStrict } from "../delta/sign.js";
import {
  closedImportCarriedDigest,
  closedImportPolicyDigest,
  type ClosedImportState,
} from "./closed-import.js";
import { refusalSnapshotDigest } from "./refusal-snapshot.js";

const DOMAIN = "rhizomatic.peer.handoff.prepare.v1";
const PEER_ID = /^ed25519:[0-9a-f]{64}$/;
const DIGEST = /^1e20[0-9a-f]{64}$/;
const VERSION = 1;

export interface PreparedHandoffDescriptor {
  readonly attemptId: string;
  readonly surfaceId: string;
  readonly oldPeerId: string;
  readonly newPeerId: string;
  readonly oldStateVersion: number;
  readonly deadline: number;
  readonly refusalDigest: string;
  readonly carriedDigest: string;
  readonly policyDigest: string;
}

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

function validate(descriptor: PreparedHandoffDescriptor): void {
  if (
    !descriptor.attemptId ||
    !wellFormed(descriptor.attemptId) ||
    !descriptor.surfaceId ||
    !wellFormed(descriptor.surfaceId) ||
    !PEER_ID.test(descriptor.oldPeerId) ||
    !PEER_ID.test(descriptor.newPeerId) ||
    descriptor.oldPeerId === descriptor.newPeerId ||
    !Number.isSafeInteger(descriptor.oldStateVersion) ||
    descriptor.oldStateVersion < 0 ||
    !Number.isFinite(descriptor.deadline) ||
    !DIGEST.test(descriptor.refusalDigest) ||
    !DIGEST.test(descriptor.carriedDigest) ||
    !DIGEST.test(descriptor.policyDigest)
  )
    throw new Error("prepared handoff: invalid descriptor");
}

export function preparedDescriptorFromStage(
  state: ClosedImportState,
  surfaceId: string,
): PreparedHandoffDescriptor {
  const descriptor = {
    attemptId: state.attemptId,
    surfaceId,
    oldPeerId: state.oldPeerId,
    newPeerId: state.closed.local.base.peerId,
    oldStateVersion: state.oldStateVersion,
    deadline: state.deadline,
    refusalDigest: refusalSnapshotDigest(state.closed.inherited),
    carriedDigest: closedImportCarriedDigest(state),
    policyDigest: closedImportPolicyDigest(state),
  };
  validate(descriptor);
  return descriptor;
}

/** Canonical domain-separated bytes signed by the old peer. */
export function encodePreparedHandoffClaim(descriptor: PreparedHandoffDescriptor): Uint8Array {
  validate(descriptor);
  return encode(
    map([
      ["version", float(VERSION)],
      ["domain", tstr(DOMAIN)],
      ["attempt", tstr(descriptor.attemptId)],
      ["surface", tstr(descriptor.surfaceId)],
      ["oldPeer", tstr(descriptor.oldPeerId)],
      ["newPeer", tstr(descriptor.newPeerId)],
      ["oldVersion", float(descriptor.oldStateVersion)],
      ["deadline", float(descriptor.deadline)],
      ["refusalDigest", tstr(descriptor.refusalDigest)],
      ["carriedDigest", tstr(descriptor.carriedDigest)],
      ["policyDigest", tstr(descriptor.policyDigest)],
    ]),
  );
}

function fields(value: CborValue, size: number): Map<string, CborValue> {
  if (value.t !== "map" || value.v.length !== size)
    throw new Error("prepared handoff: invalid fields");
  const result = new Map(value.v);
  if (result.size !== size) throw new Error("prepared handoff: duplicate fields");
  return result;
}

function string(value: CborValue | undefined): string {
  if (value?.t !== "tstr") throw new Error("prepared handoff: expected text");
  return value.v;
}

function number(value: CborValue | undefined): number {
  if (value?.t !== "float") throw new Error("prepared handoff: expected number");
  return value.v;
}

function bytes(value: CborValue | undefined): Uint8Array {
  if (value?.t !== "bstr") throw new Error("prepared handoff: expected bytes");
  return value.v;
}

function decodeClaim(image: Uint8Array): PreparedHandoffDescriptor {
  const row = fields(decode(image), 11);
  if (number(row.get("version")) !== VERSION || string(row.get("domain")) !== DOMAIN)
    throw new Error("prepared handoff: wrong domain or version");
  const descriptor: PreparedHandoffDescriptor = {
    attemptId: string(row.get("attempt")),
    surfaceId: string(row.get("surface")),
    oldPeerId: string(row.get("oldPeer")),
    newPeerId: string(row.get("newPeer")),
    oldStateVersion: number(row.get("oldVersion")),
    deadline: number(row.get("deadline")),
    refusalDigest: string(row.get("refusalDigest")),
    carriedDigest: string(row.get("carriedDigest")),
    policyDigest: string(row.get("policyDigest")),
  };
  if (!Buffer.from(encodePreparedHandoffClaim(descriptor)).equals(Buffer.from(image)))
    throw new Error("prepared handoff: noncanonical claim");
  return descriptor;
}

/** Test and host signing helper; the prepared signature is never a commit proof. */
export function signPreparedHandoff(
  descriptor: PreparedHandoffDescriptor,
  seedHex: string,
): Uint8Array {
  const claim = encodePreparedHandoffClaim(descriptor);
  if (authorForSeed(seedHex) !== descriptor.oldPeerId)
    throw new Error("prepared handoff: wrong old peer signing key");
  const signature = ed25519.sign(claim, hexToBytes(seedHex));
  return encode(
    map([
      ["claim", bstr(claim)],
      ["signature", bstr(signature)],
    ]),
  );
}

/** Authenticate and parse a signed preparation without granting commit authority. */
export function decodePreparedHandoff(image: Uint8Array): PreparedHandoffDescriptor {
  const row = fields(decode(image), 2);
  const claim = bytes(row.get("claim"));
  const signature = bytes(row.get("signature"));
  const descriptor = decodeClaim(claim);
  if (!verifySigStrict(signature, claim, hexToBytes(descriptor.oldPeerId.slice("ed25519:".length))))
    throw new Error("prepared handoff: invalid old peer signature");
  const canonical = encode(
    map([
      ["claim", bstr(claim)],
      ["signature", bstr(signature)],
    ]),
  );
  if (!Buffer.from(canonical).equals(Buffer.from(image)))
    throw new Error("prepared handoff: noncanonical image");
  return descriptor;
}

/** Require the signed descriptor to match every staged field and the declared old surface. */
export function verifyPreparedMatchesStage(
  image: Uint8Array,
  state: ClosedImportState,
  surfaceId: string,
): PreparedHandoffDescriptor {
  const actual = decodePreparedHandoff(image);
  const expected = preparedDescriptorFromStage(state, surfaceId);
  const keys: readonly (keyof PreparedHandoffDescriptor)[] = [
    "attemptId",
    "surfaceId",
    "oldPeerId",
    "newPeerId",
    "oldStateVersion",
    "deadline",
    "refusalDigest",
    "carriedDigest",
    "policyDigest",
  ];
  if (keys.some((key) => actual[key] !== expected[key]))
    throw new Error("prepared handoff: descriptor does not match closed stage");
  return actual;
}
