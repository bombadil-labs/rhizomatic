// An admission built from a snapshot, for a host that keeps no journal (SPEC-18 proposal §4.13
// reading 133). A journal peer builds its own frame and next head; the store only commits them.

import { compareUtf8 } from "../delta/cbor.js";
import { idOfOwn } from "../delta/delta.js";
import { ownDelta } from "../delta/own.js";
import type { Delta } from "../delta/types.js";
import { isPlainObject, ownFields } from "./copy.js";
import { wellFormed, wellFormedSig } from "./request.js";
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
  /** `local`, `unattributed` or the sending peer's id (SPEC-6 §3). Non-empty and well-formed. */
  readonly sender: string;
  /**
   * The head this append commits. There is no default: a made-up head could be taken for a
   * journal head. Choose one the peer never had, so an admission built on an older snapshot
   * answers `conflict`.
   */
  readonly nextHead: Head;
};

/**
 * An `Admission` of `deltas` on the snapshot's state: `expectedHead` is the snapshot's head,
 * `frame` is null, the arrival sequences start at `snapshot.lastSequence + 1` in ascending id
 * order (SPEC-6 §3), one per distinct id, and every arrival record carries the transfer ordinal
 * `snapshot.lastTransfer + 1`, `at` and `sender`. Every entry is checked as the store checks it,
 * a repeat of an id too: its id recomputes from its claims and its signature has the store's
 * form. Of a repeated id the first entry is kept. An empty list builds a head-only append. It
 * reads no store and does not check what the peer holds: an id the peer already holds keeps the
 * store's rule (it is skipped and its sequence is not used), so a host that wants no gap passes
 * only ids that `snapshot.get` does not answer. An append of this admission after another commit
 * that moved the head answers `conflict`. After one that kept the head it is refused
 * `invalid-admission` when a new id's sequence or transfer does not pass the peer's last one,
 * and otherwise commits with sequences and a transfer above every committed one. Refuses
 * `invalid-request` for a malformed snapshot, list, delta or option, and for a sequence or a
 * transfer past 2^53 − 1. The options are read once, own fields only.
 */
export function admissionOf(
  snapshot: Pick<Snapshot, "head" | "lastSequence" | "lastTransfer">,
  deltas: readonly Delta[],
  options: AdmissionOptions,
): Admission {
  const refuse = (what: string): never => {
    throw new StoreError("invalid-request", `admissionOf: ${what}`);
  };
  let head: unknown;
  let last: unknown;
  let lastTransfer: unknown;
  try {
    head = snapshot.head;
    last = snapshot.lastSequence;
    lastTransfer = snapshot.lastTransfer;
  } catch {
    return refuse("the snapshot is malformed");
  }
  if (head !== null && (typeof head !== "string" || head.length === 0 || !wellFormed(head)))
    refuse("the snapshot's head is null or a non-empty, well-formed string");
  if (!Number.isSafeInteger(last) || (last as number) < 0)
    refuse("the snapshot's lastSequence is an integer, 0 or more");
  if (!Number.isSafeInteger(lastTransfer) || (lastTransfer as number) < 0)
    refuse("the snapshot's lastTransfer is an integer, 0 or more");

  let at: unknown;
  let sender: unknown;
  let nextHead: unknown;
  try {
    if (!isPlainObject(options)) throw new TypeError("options");
    ({ at, sender, nextHead } = ownFields(options));
  } catch {
    return refuse("the options are malformed");
  }
  if (typeof at !== "number" || !Number.isFinite(at)) refuse("at is a finite number");
  if (typeof sender !== "string" || sender.length === 0 || !wellFormed(sender))
    refuse("sender is a non-empty, well-formed string");
  if (typeof nextHead !== "string" || nextHead.length === 0 || !wellFormed(nextHead))
    refuse("nextHead is a non-empty, well-formed string");

  if (!Array.isArray(deltas)) refuse("the deltas must be a list");
  const own = new Map<string, Delta>();
  for (let i = 0; i < deltas.length; i++) {
    let delta: Delta;
    try {
      delta = ownDelta(deltas[i]);
      if (idOfOwn(delta.claims) !== delta.id) throw new TypeError("id");
    } catch {
      return refuse("a delta is malformed, or its id does not match its claims");
    }
    if (delta.sig !== undefined && !wellFormedSig(delta.sig))
      refuse("a signature is not 128 lowercase hex characters");
    if (!own.has(delta.id)) own.set(delta.id, delta);
  }
  const ids = [...own.keys()].sort(compareUtf8);
  if (ids.length > Number.MAX_SAFE_INTEGER - (last as ArrivalSeq))
    refuse("the arrival sequences would pass 2^53 − 1");
  if (ids.length > 0 && (lastTransfer as number) >= Number.MAX_SAFE_INTEGER)
    refuse("the transfer ordinal would pass 2^53 − 1");
  const transfer = (lastTransfer as number) + 1;
  const added: VerifiedDelta[] = ids.map((id, i) => ({
    delta: own.get(id)!,
    arrival: {
      id,
      at: (at as number) + 0,
      sequence: (last as ArrivalSeq) + i + 1,
      transfer,
      sender: sender as string,
    },
  }));
  return { expectedHead: head as Head | null, nextHead: nextHead as Head, frame: null, added };
}
