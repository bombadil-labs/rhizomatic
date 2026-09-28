// Internal active-obligation carry. The old peer owns these until a durable handoff commit.
import { array, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { contentAddress } from "../delta/hash.js";
import {
  encodeRefusalSnapshot,
  refusalSnapshotDigest,
  type QualifiedEventRef,
  type RefusalSnapshot,
} from "./refusal-snapshot.js";

const VERSION = 1;
const ID = /^1e20[0-9a-f]{64}$/;

export interface ImportedObligation extends QualifiedEventRef {
  readonly targetId: string;
  readonly surfaceId: string;
  readonly generation: number;
  readonly event: QualifiedEventRef;
  readonly priorEpoch?: QualifiedEventRef;
  readonly status: "pending" | "failed";
  readonly fault?: string;
}

export interface ImportedObligationCarry {
  readonly obligations: readonly ImportedObligation[];
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function refKey(ref: QualifiedEventRef): string {
  return JSON.stringify([ref.sourcePeerId, ref.sequence]);
}

function validate(snapshot: RefusalSnapshot, carry: ImportedObligationCarry): void {
  encodeRefusalSnapshot(snapshot);
  const current = new Map(snapshot.current.map((row) => [row.targetId, refKey(row)]));
  const identities = new Set<string>();
  for (const row of carry.obligations) {
    if (
      !row.sourcePeerId ||
      !positive(row.sequence) ||
      identities.has(refKey(row)) ||
      !ID.test(row.targetId) ||
      !row.surfaceId ||
      !positive(row.generation) ||
      !row.event.sourcePeerId ||
      !positive(row.event.sequence) ||
      current.get(row.targetId) !== refKey(row.event) ||
      (row.priorEpoch !== undefined &&
        (!row.priorEpoch.sourcePeerId || !positive(row.priorEpoch.sequence))) ||
      (row.status !== "pending" && row.status !== "failed") ||
      (row.status === "failed" ? !row.fault : row.fault !== undefined)
    )
      throw new Error("imported obligations: invalid active obligation");
    identities.add(refKey(row));
  }
}

function reference(ref: QualifiedEventRef): CborValue {
  return map([
    ["source", tstr(ref.sourcePeerId)],
    ["sequence", float(ref.sequence)],
  ]);
}

/** Canonical active debt image bound to one refusal snapshot digest. */
export function encodeImportedObligations(
  snapshot: RefusalSnapshot,
  carry: ImportedObligationCarry,
): Uint8Array {
  validate(snapshot, carry);
  const obligations = [...carry.obligations].sort(
    (a, b) =>
      Buffer.compare(Buffer.from(a.sourcePeerId, "utf8"), Buffer.from(b.sourcePeerId, "utf8")) ||
      a.sequence - b.sequence,
  );
  return encode(
    map([
      ["version", float(VERSION)],
      ["snapshotDigest", tstr(refusalSnapshotDigest(snapshot))],
      [
        "obligations",
        array(
          obligations.map((row) =>
            map([
              ["source", tstr(row.sourcePeerId)],
              ["sequence", float(row.sequence)],
              ["target", tstr(row.targetId)],
              ["surface", tstr(row.surfaceId)],
              ["generation", float(row.generation)],
              ["event", reference(row.event)],
              ["status", tstr(row.status)],
              ...(row.priorEpoch === undefined
                ? []
                : [["priorEpoch", reference(row.priorEpoch)] as [string, CborValue]]),
              ...(row.fault === undefined
                ? []
                : [["fault", tstr(row.fault)] as [string, CborValue]]),
            ]),
          ),
        ),
      ],
    ]),
  );
}

function fields(value: CborValue, size: number): Map<string, CborValue> {
  if (value.t !== "map" || value.v.length !== size)
    throw new Error("imported obligations: invalid fields");
  const result = new Map(value.v);
  if (result.size !== size) throw new Error("imported obligations: duplicate field");
  return result;
}

function string(value: CborValue | undefined): string {
  if (value?.t !== "tstr") throw new Error("imported obligations: expected text");
  return value.v;
}

function number(value: CborValue | undefined): number {
  if (value?.t !== "float") throw new Error("imported obligations: expected number");
  return value.v;
}

function items(value: CborValue | undefined): readonly CborValue[] {
  if (value?.t !== "array") throw new Error("imported obligations: expected array");
  return value.v;
}

function parseRef(value: CborValue | undefined): QualifiedEventRef {
  if (value === undefined) throw new Error("imported obligations: missing reference");
  const row = fields(value, 2);
  return { sourcePeerId: string(row.get("source")), sequence: number(row.get("sequence")) };
}

export function decodeImportedObligations(
  image: Uint8Array,
  snapshot: RefusalSnapshot,
): ImportedObligationCarry {
  const top = fields(decode(image), 3);
  if (number(top.get("version")) !== VERSION)
    throw new Error("imported obligations: unsupported version");
  if (string(top.get("snapshotDigest")) !== refusalSnapshotDigest(snapshot))
    throw new Error("imported obligations: wrong refusal snapshot");
  const obligations = items(top.get("obligations")).map((value): ImportedObligation => {
    if (value.t !== "map") throw new Error("imported obligations: invalid obligation fields");
    const row = fields(value, value.v.length);
    if (row.size !== 7 + Number(row.has("priorEpoch")) + Number(row.has("fault")))
      throw new Error("imported obligations: invalid obligation fields");
    return {
      sourcePeerId: string(row.get("source")),
      sequence: number(row.get("sequence")),
      targetId: string(row.get("target")),
      surfaceId: string(row.get("surface")),
      generation: number(row.get("generation")),
      event: parseRef(row.get("event")),
      ...(row.has("priorEpoch") ? { priorEpoch: parseRef(row.get("priorEpoch")) } : {}),
      status: string(row.get("status")) as ImportedObligation["status"],
      ...(row.has("fault") ? { fault: string(row.get("fault")) } : {}),
    };
  });
  const carry = { obligations };
  if (!Buffer.from(encodeImportedObligations(snapshot, carry)).equals(Buffer.from(image)))
    throw new Error("imported obligations: noncanonical image");
  return carry;
}

export function importedObligationsDigest(
  snapshot: RefusalSnapshot,
  carry: ImportedObligationCarry,
): string {
  return contentAddress(encodeImportedObligations(snapshot, carry));
}
