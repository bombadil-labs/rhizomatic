// Freshness over the change feed (SPEC-18 proposal §4.6, "Freshness check"). A capture records
// what one anchored read depended on in the store: its revision, its anchors, its raw scope as
// ids and the next validity boundary of its operand. `touching` decides from change records
// alone whether anything since the capture can have changed that raw scope. `checkFresh` reads
// those records from a peer and answers current, stale, expired or resync-required.
//
// What this does not see: a selection or an authority that reads state outside the capture's
// scope (trust, grants, a clock other than `expiresAt`). A host keeps its own epoch for that
// state and compares it itself.

import { compareUtf8 } from "../delta/cbor.js";
import type { Delta } from "../delta/types.js";
import {
  StoreError,
  type Anchor,
  type ChangeRecord,
  type Entity,
  type Id,
  type PeerStore,
  type Revision,
  type Snapshot,
} from "./store.js";

/** What one anchored read depended on in the store. It holds ids, never bytes. */
export type Capture = {
  /** The revision of the snapshot the read ran on. */
  readonly revision: Revision;
  /** The read's whole scope E*: static and dynamic anchors, ascending by entity, unique. */
  readonly anchors: readonly Anchor[];
  /**
   * The raw scope S(anchors over H) at `revision`: every held delta an anchor yields, closed
   * under held negators, with no selection. Ascending, unique.
   */
  readonly members: readonly Id[];
  /**
   * The least `validFrom` or `validUntil` strictly after the read's evaluation time, among the
   * deltas of the read's exact trimmed scope (its operand). Null when there is none.
   */
  readonly expiresAt: number | null;
};

export type TouchReason = "removed-member" | "targets-anchor" | "negates-member";

/** The first change since a capture that can have changed its raw scope. */
export type Touch = {
  /** The revision of the change record that touches. */
  readonly revision: Revision;
  readonly id: Id;
  readonly reason: TouchReason;
};

export type Freshness =
  /** No change since the capture touches it, and it has not expired. */
  | { readonly status: "current" }
  | { readonly status: "stale"; readonly touch: Touch }
  /** No change touches it, but `now` is at or past `expiresAt`. */
  | { readonly status: "expired"; readonly expiresAt: number }
  /** The feed no longer holds the records since the capture, or the capture is from a later revision. */
  | { readonly status: "resync-required"; readonly current: Revision };

/** How many times `checkFresh` starts again on a new snapshot after `snapshot-moved`. */
const SNAPSHOT_RETRIES = 3;

function entitiesOf(anchors: readonly Anchor[]): Entity[] {
  for (const anchor of anchors)
    if (anchor.kind !== "entity")
      throw new StoreError("capability-absent", "capture: entity anchors only");
  return [...new Set(anchors.map((anchor) => anchor.entity))].sort(compareUtf8);
}

/** A capture with its lists in the contract's order, frozen. */
export function makeCapture(
  revision: Revision,
  anchors: readonly Anchor[],
  members: Iterable<Id>,
  expiresAt: number | null,
): Capture {
  return Object.freeze({
    revision,
    anchors: Object.freeze(
      entitiesOf(anchors).map((entity) => Object.freeze({ kind: "entity" as const, entity })),
    ),
    members: Object.freeze([...new Set(members)].sort(compareUtf8)),
    expiresAt,
  });
}

/**
 * The raw scope S(anchors over H) on this snapshot, from ids alone: `targets` of the anchors,
 * then `negators` of each new layer until a layer adds nothing. Ascending, unique. It asks for
 * each member once, so it costs O(|members| × log N), in closure depth plus one calls.
 */
export async function rawScope(snapshot: Snapshot, anchors: readonly Anchor[]): Promise<Id[]> {
  const entities = entitiesOf(anchors);
  const members = new Set<Id>();
  let layer: readonly Id[] = entities.length === 0 ? [] : await snapshot.targets(entities);
  for (;;) {
    const fresh = layer.filter((id) => !members.has(id));
    if (fresh.length === 0) break;
    for (const id of fresh) members.add(id);
    layer = await snapshot.negators(fresh.sort(compareUtf8));
  }
  return [...members].sort(compareUtf8);
}

/**
 * The least validity boundary (`validFrom` or `validUntil`) strictly after `now` among
 * `deltas`, or null. A boundary at `now` has already taken effect: a delta is valid exactly when
 * `validFrom <= now < validUntil`.
 */
export function nextBoundary(deltas: Iterable<Delta>, now: number): number | null {
  let least: number | null = null;
  for (const { claims } of deltas)
    for (const at of [claims.validFrom, claims.validUntil])
      if (at !== undefined && at > now && (least === null || at < least)) least = at;
  return least;
}

/** Binary search in a list ascending by `key`. */
function holds<T>(sorted: readonly T[], wanted: string, key: (item: T) => string): boolean {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const order = compareUtf8(key(sorted[mid]!), wanted);
    if (order === 0) return true;
    if (order < 0) low = mid + 1;
    else high = mid;
  }
  return false;
}

const same = (id: Id): Id => id;

// Why an added delta touches: it points at an anchor entity, or it negates a member. An anchor
// is checked first, so a delta that does both reports `targets-anchor`.
function reasonOf(capture: Capture, delta: Delta): TouchReason | null {
  const { pointers } = delta.claims;
  for (const { target } of pointers)
    if (target.kind === "entity" && holds(capture.anchors, target.entity.id, (a) => a.entity))
      return "targets-anchor";
  for (const { role, target } of pointers)
    if (
      role === "negates" &&
      target.kind === "delta" &&
      holds(capture.members, target.deltaRef.delta, same)
    )
      return "negates-member";
  return null;
}

/**
 * The first change in `records` that touches `capture`, or null. Pure.
 *
 * `records` are the change records with `capture.revision < revision <= r′`, ascending, and
 * `added` holds, by id, the delta of every id in some record's `added` that the peer still holds
 * at r′. The capture is touched when a record's `removed` names a member (also when the id is
 * added again later: its arrival changed), or when an added id still held at r′ points at an
 * anchor entity or negates a member. An added id that is not held at r′ is ignored.
 *
 * The first touch is in record order; within one record, `removed` before `added`, and each
 * list in its own ascending order. Without a selection the answer is exact: with no touch,
 * S(anchors over H at r′) equals `members` with the same arrival records. With a selection it is
 * sound: a touch by a delta the selection rejects is a false "stale", never a false "current".
 *
 * Cost: O(ids in `records` × pointers × log |members|); it never reads all of `members`.
 */
export function touching(
  capture: Capture,
  records: readonly ChangeRecord[],
  added: ReadonlyMap<Id, Delta>,
): Touch | null {
  for (const record of records) {
    for (const id of record.removed)
      if (holds(capture.members, id, same))
        return { revision: record.revision, id, reason: "removed-member" };
    for (const id of record.added) {
      const delta = added.get(id);
      if (delta === undefined) continue;
      const reason = reasonOf(capture, delta);
      if (reason !== null) return { revision: record.revision, id, reason };
    }
  }
  return null;
}

/**
 * Is `capture` still current on `peer`? One `read()`; then, unless the revisions are equal,
 * `changes(capture.revision, r′)` page by page, where r′ is that snapshot's revision; for each
 * page that names an added id, one `get` of those ids on the snapshot; it stops at the first
 * touch. Then, when `now` is given and `now >= capture.expiresAt`, it answers `expired`.
 *
 * Its calls and cost depend on the records and ids since the capture, never on what the peer
 * holds and never on records before the capture. When the peer moves during the check, it starts
 * again on a new snapshot, as `StoreReactor` does, up to three more times; then `snapshot-moved`
 * passes up. Every snapshot is released. Refuses `invalid-request` for a `now` that is not finite.
 */
export function checkFresh(peer: PeerStore, capture: Capture, now?: number): Promise<Freshness> {
  return checkFreshWith(touching)(peer, capture, now);
}

/**
 * `checkFresh` over another `touching`. Not part of the package surface: the conformance rails
 * build readers that are wrong on purpose with it.
 */
export function checkFreshWith(touch: typeof touching): typeof checkFresh {
  return (peer, capture, now) => check(touch, peer, capture, now);
}

async function check(
  touch: typeof touching,
  peer: PeerStore,
  capture: Capture,
  now: number | undefined,
): Promise<Freshness> {
  if (now !== undefined && !Number.isFinite(now))
    throw new StoreError("invalid-request", "checkFresh: now must be a finite number");
  for (let attempts = 1; ; attempts += 1) {
    const snapshot = await peer.read();
    try {
      return await checkOn(touch, peer, snapshot, capture, now);
    } catch (error) {
      const moved = error instanceof StoreError && error.code === "snapshot-moved";
      if (!moved || attempts > SNAPSHOT_RETRIES) throw error;
    } finally {
      snapshot.release();
    }
  }
}

async function checkOn(
  touch: typeof touching,
  peer: PeerStore,
  snapshot: Snapshot,
  capture: Capture,
  now: number | undefined,
): Promise<Freshness> {
  const current = snapshot.revision;
  // A capture from a later revision: the store was rolled back, or the capture is another peer's.
  if (current < capture.revision) return { status: "resync-required", current };
  for (let at = capture.revision; at < current; ) {
    const page = await peer.changes(at, current);
    if (page.status === "resync-required")
      return { status: "resync-required", current: page.current };
    const ids = [...new Set(page.records.flatMap((record) => record.added))].sort(compareUtf8);
    const added = new Map<Id, Delta>();
    if (ids.length > 0) for (const delta of await snapshot.get(ids)) added.set(delta.id, delta);
    const found = touch(capture, page.records, added);
    if (found !== null) return { status: "stale", touch: found };
    if (page.through <= at) throw new Error("checkFresh: a page of the feed made no progress");
    at = page.through;
  }
  if (now !== undefined && capture.expiresAt !== null && now >= capture.expiresAt)
    return { status: "expired", expiresAt: capture.expiresAt };
  return { status: "current" };
}
