// An admission built from a snapshot, for a host that keeps no journal (SPEC-18 proposal §4.13
// reading 133). A journal peer builds its own frame and next head; the store only commits them.

import { compareUtf8 } from "../delta/cbor.js";
import type { Delta } from "../delta/types.js";
import { copyDelta, isPlainObject, ownFields } from "./copy.js";
import { wellFormed } from "./request.js";
import {
  StoreError,
  type Admission,
  type ArrivalSeq,
  type Head,
  type Snapshot,
  type VerifiedDelta,
} from "./store.js";

/** What `admissionOf` cannot read from a snapshot. Every field is required. */
export type AdmissionOptions = {
  /** The receiver's clock when the deltas arrive, in ms. A finite number. */
  readonly at: number;
  /** `local`, `unattributed` or the sending peer's id (SPEC-6 §3). Non-empty. */
  readonly sender: string;
  /**
   * The transfer ordinal of this append, an integer of 1 or more. The host keeps the count: the
   * store does not expose its last transfer, and an append that admits no new id uses none.
   */
  readonly transfer: number;
  /**
   * The head this append commits. There is no default: a made-up head could be taken for a
   * journal head. Choose one the peer never had, so an admission built on an older snapshot
   * answers `conflict`.
   */
  readonly nextHead: Head;
};

/**
 * An `Admission` of `deltas` on the snapshot's state: `expectedHead` is the snapshot's head,
 * `frame` is null, and the arrival sequences start at `snapshot.lastSequence + 1` in ascending id
 * order (SPEC-6 §3), one per distinct id, the first entry of an id kept. Every arrival record
 * carries `at`, `sender` and `transfer`. An empty list builds a head-only append. It reads no
 * store and does not check what the peer holds: an id the peer already holds keeps the store's
 * rule (it is skipped and its sequence is not used), so a host that wants no gap passes only ids
 * that `snapshot.get` does not answer. An append of this admission after another commit moved
 * the head answers `conflict`; one that passes the head but not the sequences is refused
 * `invalid-admission`. Refuses `invalid-request` for a malformed snapshot, list or option, and for
 * sequences past 2^53 − 1. The options are read once, own fields only.
 */
export function admissionOf(
  snapshot: Pick<Snapshot, "head" | "lastSequence">,
  deltas: readonly Delta[],
  options: AdmissionOptions,
): Admission {
  const refuse = (what: string): never => {
    throw new StoreError("invalid-request", `admissionOf: ${what}`);
  };
  let head: unknown;
  let last: unknown;
  try {
    head = snapshot.head;
    last = snapshot.lastSequence;
  } catch {
    return refuse("the snapshot is malformed");
  }
  if (head !== null && (typeof head !== "string" || head.length === 0))
    refuse("the snapshot's head is null or a non-empty string");
  if (!Number.isSafeInteger(last) || (last as number) < 0)
    refuse("the snapshot's lastSequence is an integer, 0 or more");

  let at: unknown;
  let sender: unknown;
  let transfer: unknown;
  let nextHead: unknown;
  try {
    if (!isPlainObject(options)) throw new TypeError("options");
    ({ at, sender, transfer, nextHead } = ownFields(options));
  } catch {
    return refuse("the options are malformed");
  }
  if (typeof at !== "number" || !Number.isFinite(at)) refuse("at is a finite number");
  if (typeof sender !== "string" || sender.length === 0 || !wellFormed(sender))
    refuse("sender is a non-empty, well-formed string");
  if (!Number.isSafeInteger(transfer) || (transfer as number) < 1)
    refuse("transfer is an integer, 1 or more");
  if (typeof nextHead !== "string" || nextHead.length === 0 || !wellFormed(nextHead))
    refuse("nextHead is a non-empty, well-formed string");

  if (!Array.isArray(deltas)) refuse("the deltas must be a list");
  const own = new Map<string, Delta>();
  for (let i = 0; i < deltas.length; i++) {
    let delta: Delta;
    try {
      const given: unknown = deltas[i];
      if (typeof given !== "object" || given === null) throw new TypeError("delta");
      const fields = ownFields(given as { id: unknown });
      delta = copyDelta(fields, fields.id);
    } catch {
      return refuse("a delta is malformed");
    }
    if (!own.has(delta.id)) own.set(delta.id, delta);
  }
  const ids = [...own.keys()].sort(compareUtf8);
  if (ids.length > Number.MAX_SAFE_INTEGER - (last as ArrivalSeq))
    refuse("the arrival sequences would pass 2^53 − 1");
  const added: VerifiedDelta[] = ids.map((id, i) => ({
    delta: own.get(id)!,
    arrival: {
      id,
      at: (at as number) + 0,
      sequence: (last as ArrivalSeq) + i + 1,
      transfer: transfer as number,
      sender: sender as string,
    },
  }));
  return { expectedHead: head as Head | null, nextHead: nextHead as Head, frame: null, added };
}
