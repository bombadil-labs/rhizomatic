// Internal inherited-refusal snapshot. Its digest binds bytes; a handoff commit must authenticate it.
import { array, decode, encode, float, map, tstr, type CborValue } from "../delta/cbor.js";
import { contentAddress } from "../delta/hash.js";
import { encodeDurablePeerState, type DurablePeerState } from "./durable-state.js";

const ID = /^1e20[0-9a-f]{64}$/;
const VERSION = 1;

export interface QualifiedEventRef {
  readonly sourcePeerId: string;
  readonly sequence: number;
}

export interface QualifiedRefusalEvent extends QualifiedEventRef {
  readonly targetId: string;
  readonly orderIds: readonly string[];
  readonly priorEpoch?: number;
}

export interface CurrentRefusal extends QualifiedEventRef {
  readonly targetId: string;
}

export interface RefusalSnapshot {
  readonly events: readonly QualifiedRefusalEvent[];
  readonly current: readonly CurrentRefusal[];
}

/** Capture every local event, including superseded events, from a valid durable image. */
export function localRefusalSnapshot(state: DurablePeerState): RefusalSnapshot {
  encodeDurablePeerState(state);
  const latest = new Map<string, CurrentRefusal>();
  const events = state.events.map((event): QualifiedRefusalEvent => {
    const qualified = {
      sourcePeerId: state.base.peerId,
      sequence: event.sequence,
      targetId: event.targetId,
      orderIds: [...event.orderIds],
      ...(event.priorEpoch === undefined ? {} : { priorEpoch: event.priorEpoch }),
    };
    latest.set(event.targetId, {
      sourcePeerId: qualified.sourcePeerId,
      sequence: qualified.sequence,
      targetId: qualified.targetId,
    });
    return qualified;
  });
  return { events, current: [...latest.values()] };
}

function positive(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

function validText(s: string): boolean {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s)
  );
}

function key(ref: QualifiedEventRef): string {
  return JSON.stringify([ref.sourcePeerId, ref.sequence]);
}

function validate(snapshot: RefusalSnapshot): void {
  const events = new Map<string, QualifiedRefusalEvent>();
  const targets = new Set<string>();
  const orders = new Set<string>();
  for (const event of snapshot.events) {
    if (
      !validText(event.sourcePeerId) ||
      !positive(event.sequence) ||
      !ID.test(event.targetId) ||
      !event.orderIds.length ||
      (event.priorEpoch !== undefined && !positive(event.priorEpoch)) ||
      events.has(key(event))
    )
      throw new Error("refusal snapshot: invalid event");
    for (const order of event.orderIds) {
      if (!ID.test(order) || order === event.targetId || orders.has(order))
        throw new Error("refusal snapshot: invalid order");
      orders.add(order);
    }
    events.set(key(event), event);
    targets.add(event.targetId);
  }
  const current = new Set<string>();
  for (const row of snapshot.current) {
    const event = events.get(key(row));
    if (
      !ID.test(row.targetId) ||
      current.has(row.targetId) ||
      event?.targetId !== row.targetId ||
      snapshot.events.some(
        (other) =>
          other.targetId === row.targetId &&
          other.sourcePeerId === row.sourcePeerId &&
          other.sequence > row.sequence,
      )
    )
      throw new Error("refusal snapshot: invalid current event");
    current.add(row.targetId);
  }
  if (current.size !== targets.size) throw new Error("refusal snapshot: missing current event");
}

function refFields(ref: QualifiedEventRef): Array<[string, CborValue]> {
  return [
    ["source", tstr(ref.sourcePeerId)],
    ["sequence", float(ref.sequence)],
  ];
}

/** Canonical private image, independent of input order. */
export function encodeRefusalSnapshot(snapshot: RefusalSnapshot): Uint8Array {
  validate(snapshot);
  const events = [...snapshot.events].sort(
    (a, b) =>
      Buffer.compare(Buffer.from(a.sourcePeerId, "utf8"), Buffer.from(b.sourcePeerId, "utf8")) ||
      a.sequence - b.sequence,
  );
  const current = [...snapshot.current].sort((a, b) =>
    a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0,
  );
  return encode(
    map([
      ["version", float(VERSION)],
      [
        "events",
        array(
          events.map((event) =>
            map([
              ...refFields(event),
              ["target", tstr(event.targetId)],
              ["orders", array([...event.orderIds].sort().map(tstr))],
              ...(event.priorEpoch === undefined
                ? []
                : [["epoch", float(event.priorEpoch)] as [string, CborValue]]),
            ]),
          ),
        ),
      ],
      [
        "current",
        array(current.map((row) => map([...refFields(row), ["target", tstr(row.targetId)]]))),
      ],
    ]),
  );
}

function fields(value: CborValue, size: number): Map<string, CborValue> {
  if (value.t !== "map" || value.v.length !== size)
    throw new Error("refusal snapshot: invalid fields");
  const result = new Map(value.v);
  if (result.size !== size) throw new Error("refusal snapshot: duplicate field");
  return result;
}

function string(value: CborValue | undefined): string {
  if (value?.t !== "tstr") throw new Error("refusal snapshot: expected text");
  return value.v;
}

function number(value: CborValue | undefined): number {
  if (value?.t !== "float") throw new Error("refusal snapshot: expected number");
  return value.v;
}

function items(value: CborValue | undefined): readonly CborValue[] {
  if (value?.t !== "array") throw new Error("refusal snapshot: expected array");
  return value.v;
}

export function decodeRefusalSnapshot(bytes: Uint8Array): RefusalSnapshot {
  const top = fields(decode(bytes), 3);
  if (number(top.get("version")) !== VERSION)
    throw new Error("refusal snapshot: unsupported version");
  const events = items(top.get("events")).map((value): QualifiedRefusalEvent => {
    if (value.t !== "map") throw new Error("refusal snapshot: invalid event fields");
    const row = fields(value, value.v.length);
    if (row.size !== 4 && row.size !== 5) throw new Error("refusal snapshot: invalid event fields");
    return {
      sourcePeerId: string(row.get("source")),
      sequence: number(row.get("sequence")),
      targetId: string(row.get("target")),
      orderIds: items(row.get("orders")).map(string),
      ...(row.has("epoch") ? { priorEpoch: number(row.get("epoch")) } : {}),
    };
  });
  const current = items(top.get("current")).map((value): CurrentRefusal => {
    const row = fields(value, 3);
    return {
      sourcePeerId: string(row.get("source")),
      sequence: number(row.get("sequence")),
      targetId: string(row.get("target")),
    };
  });
  const snapshot = { events, current };
  const canonical = encodeRefusalSnapshot(snapshot);
  if (!Buffer.from(canonical).equals(Buffer.from(bytes)))
    throw new Error("refusal snapshot: noncanonical image");
  return snapshot;
}

export function refusalSnapshotDigest(snapshot: RefusalSnapshot): string {
  return contentAddress(encodeRefusalSnapshot(snapshot));
}

/** Validate an immutable primary or independent recovery copy against the committed digest. */
export function recoverRefusalSnapshot(
  expectedDigest: string,
  primary?: Uint8Array,
  recovery?: Uint8Array,
): { snapshot: RefusalSnapshot; bytes: Uint8Array; usedRecovery: boolean } {
  for (const [bytes, usedRecovery] of [
    [primary, false],
    [recovery, true],
  ] as const) {
    if (bytes === undefined || contentAddress(bytes) !== expectedDigest) continue;
    try {
      return { snapshot: decodeRefusalSnapshot(bytes), bytes: bytes.slice(), usedRecovery };
    } catch {
      // An exact digest is necessary but the claimed image must also parse canonically.
    }
  }
  throw new Error("refusal snapshot: no verified copy");
}
