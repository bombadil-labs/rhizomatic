// Freshness over the change feed (SPEC-18 proposal §4.6, "Freshness check"). A capture records
// what one anchored read depended on in the store: its history and revision, its anchors, its
// raw scope as ids and the validity window of its operand. `touching` decides from change
// records alone whether anything since the capture can have changed that raw scope.
// `checkFresh` reads those records from a peer and answers current, stale, not-yet, expired or
// resync-required.
//
// What this does not see: a selection or an authority that reads state outside the capture's
// scope (trust, grants, a clock other than the window). A host keeps its own epoch for that
// state and compares it itself.

import { compareUtf8 } from "../delta/cbor.js";
import type { Delta } from "../delta/types.js";
import {
  StoreError,
  type Anchor,
  type ChangeRecord,
  type Entity,
  type History,
  type Id,
  type PeerStore,
  type Revision,
  type Snapshot,
} from "./store.js";

declare const CAPTURE: unique symbol;

/**
 * What one anchored read depended on in the store. It holds ids, never bytes. Only
 * `makeCapture` and `parseCapture` build one, so its lists are always in the order that
 * `touching` searches.
 */
export type Capture = {
  readonly [CAPTURE]: true;
  /** The history of the peer at the snapshot the read ran on. */
  readonly history: History;
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
   * The greatest `validFrom` or `validUntil` at or before the read's evaluation time, among the
   * deltas of the read's exact trimmed scope (its operand). Null when there is none.
   */
  readonly since: number | null;
  /**
   * The least `validFrom` or `validUntil` strictly after the read's evaluation time, among the
   * same deltas. Null when there is none. With no touch, the read answers the same at every time
   * t with `since <= t < expiresAt`.
   */
  readonly expiresAt: number | null;
};

/** The validity window of an operand at one time (§4.6). A null bound is open. */
export type ValidityWindow = { readonly since: number | null; readonly expiresAt: number | null };

export type TouchReason = "removed-member" | "targets-anchor" | "negates-member";

/** The first change since a capture that can have changed its raw scope. */
export type Touch = {
  /** The revision of the change record that touches. */
  readonly revision: Revision;
  readonly id: Id;
  readonly reason: TouchReason;
};

export type Freshness =
  /** No change since the capture touches it, and `now` is inside its window. */
  | { readonly status: "current" }
  | { readonly status: "stale"; readonly touch: Touch }
  /** No change touches it, but `now` is before `since`. */
  | { readonly status: "not-yet"; readonly since: number }
  /** No change touches it, but `now` is at or past `expiresAt`. */
  | { readonly status: "expired"; readonly expiresAt: number }
  /**
   * The peer's history is not the capture's, the feed no longer holds the records since the
   * capture, or the capture is from a later revision.
   */
  | { readonly status: "resync-required"; readonly current: Revision };

/** How many times `checkFresh` starts again on a new snapshot after `snapshot-moved`. */
const SNAPSHOT_RETRIES = 3;

function entitiesOf(anchors: readonly Anchor[]): Entity[] {
  for (const anchor of anchors)
    if (anchor.kind !== "entity")
      throw new StoreError("capability-absent", "capture: entity anchors only");
  return [...new Set(anchors.map((anchor) => anchor.entity))].sort(compareUtf8);
}

/**
 * The anchor kinds of §4.7.1 that a capture cannot hold yet. A capture that names one is
 * well formed and refused `capability-absent`; another kind is malformed (`invalid-request`).
 * Slice 6 defines their fields, so only the kind is read.
 */
const OTHER_ANCHOR_KINDS: ReadonlySet<string> = new Set(["value", "derived-index"]);

const frozenAnchors = (entities: readonly Entity[]): readonly Anchor[] =>
  Object.freeze(entities.map((entity) => Object.freeze({ kind: "entity" as const, entity })));

/**
 * The prefix of a history that is unique only within one process: the memory store's default.
 * A capture with such a history must not cross a process (`parseCapture` refuses it).
 */
export const LOCAL_HISTORY_PREFIX = "memory:local:";

// Every capture this module built. `touching` and `checkFresh` answer for these alone: a copy, a
// cast object or a parsed value has not been checked, and its lists may be out of order.
const BUILT = new WeakSet<object>();

/** Refuses `invalid-request` unless `capture` was built by `makeCapture` or `parseCapture`. */
function built(capture: Capture): void {
  if (typeof capture !== "object" || capture === null || !BUILT.has(capture))
    throw new StoreError(
      "invalid-request",
      "capture: not built by makeCapture or parseCapture; build it with one of them",
    );
}

// The checks every capture passes, from either constructor. It never sorts: a list out of order
// is refused, not repaired.
function checked(v: Record<string, unknown>, refuseLocal: boolean): Capture {
  const refuse = (why: string): never => {
    throw new StoreError("invalid-request", `capture: ${why}`);
  };
  const { history, revision, anchors, members, since, expiresAt } = v;
  if (typeof history !== "string" || history === "") refuse("history is not a non-empty string");
  if (refuseLocal && (history as string).startsWith(LOCAL_HISTORY_PREFIX))
    refuse(
      `history ${String(history)} is local to the process that made it; a capture that crosses a process needs histories from mintHistory`,
    );
  if (!Number.isSafeInteger(revision) || (revision as number) < 0)
    refuse("revision is not an integer from 0 to 2^53 - 1");
  const ascending = (list: unknown, what: string): string[] => {
    if (!Array.isArray(list)) return refuse(`${what} is not a list`);
    const out: string[] = [];
    for (const item of list as unknown[]) {
      if (typeof item !== "string") return refuse(`${what} holds a value that is not a string`);
      if (out.length > 0 && compareUtf8(out[out.length - 1]!, item) >= 0)
        return refuse(`${what} is not strictly ascending by UTF-8 bytes`);
      out.push(item);
    }
    return out;
  };
  if (!Array.isArray(anchors)) refuse("anchors is not a list");
  const entities = ascending(
    (anchors as unknown[]).map((a) => {
      const anchor = a as { kind?: unknown; entity?: unknown } | null;
      if (typeof anchor !== "object" || anchor === null || Array.isArray(anchor))
        return refuse("an anchor is not an object");
      if (typeof anchor.kind === "string" && OTHER_ANCHOR_KINDS.has(anchor.kind))
        throw new StoreError(
          "capability-absent",
          `capture: a ${anchor.kind} anchor; this witness reads entity anchors only`,
        );
      if (anchor.kind !== "entity")
        return refuse("an anchor's kind is not entity, value or derived-index");
      if (Object.keys(anchor).length !== 2) return refuse("an entity anchor is not {kind, entity}");
      return anchor.entity;
    }),
    "anchors",
  );
  const ids = ascending(members, "members");
  const bound = (b: unknown, what: string): number | null => {
    if (b === null) return null;
    if (typeof b !== "number" || !Number.isFinite(b))
      return refuse(`${what} is not null or finite`);
    return b;
  };
  const validity = { since: bound(since, "since"), expiresAt: bound(expiresAt, "expiresAt") };
  if (
    validity.since !== null &&
    validity.expiresAt !== null &&
    validity.since >= validity.expiresAt
  )
    refuse("since is not before expiresAt");
  const capture = Object.freeze({
    history: history as string,
    revision: revision as number,
    anchors: frozenAnchors(entities),
    members: Object.freeze(ids),
    ...validity,
  }) as Capture;
  BUILT.add(capture);
  return capture;
}

/**
 * A capture of a live snapshot, frozen: `history` and `revision` are read from `snapshot`, the
 * snapshot the read ran on. The caller gives the lists already ascending by UTF-8 bytes and
 * without repeats. Refuses what `parseCapture` refuses, but a history local to this process.
 *
 * It is not a way to reload a stored capture: that comes back only through `parseCapture`, which
 * refuses a process-local history. A host that fabricates a snapshot to feed stored values to
 * this maker defeats that refusal and can get a false `current`.
 */
export function makeCapture(
  snapshot: Snapshot,
  anchors: readonly Anchor[],
  members: Iterable<Id>,
  validity: ValidityWindow,
): Capture {
  return checked(
    {
      history: snapshot.history,
      revision: snapshot.revision,
      anchors,
      members: [...members],
      since: validity.since,
      expiresAt: validity.expiresAt,
    },
    false,
  );
}

/**
 * A capture that was stored and read back, checked. Refuses `invalid-request` unless `value`
 * has exactly the six fields of a capture, a non-empty `history` that is not local to a process
 * (`LOCAL_HISTORY_PREFIX`), an integer `revision` from 0 to 2^53 − 1, entity anchors and member
 * ids each strictly ascending by UTF-8 bytes (so with no repeat), and `since` and `expiresAt`
 * that are null or finite with `since < expiresAt`. It never sorts. An anchor of another kind of
 * §4.7.1 (`value`, `derived-index`) is refused `capability-absent`; an unknown kind is malformed.
 *
 * It checks shape, not truth: a stored capture is believed as its maker wrote it. A host that
 * stores captures where it does not trust what is at rest protects their integrity itself.
 */
export function parseCapture(value: unknown): Capture {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new StoreError("invalid-request", "capture: not an object");
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (keys !== "anchors,expiresAt,history,members,revision,since")
    throw new StoreError(
      "invalid-request",
      `capture: the keys are ${keys}, not anchors, expiresAt, history, members, revision, since`,
    );
  return checked(v, true);
}

/**
 * The same capture, moved to a later revision of the same history: anchors, members and window
 * unchanged. Not part of the package surface. Held views use it (SPEC-18 §4.6, "Held views").
 *
 * It assumes what it cannot check: the caller read the feed over `(capture.revision, revision]`
 * of this history and found no record that touches the capture (`touching` answers null). Then
 * S(anchors over H) at `revision` equals `members`, with the same arrival records, so the moved
 * capture states the truth. Called on anything else, it states a falsehood that `checkFresh`
 * later believes. Refuses `invalid-request` for a capture that was not built here, another
 * history, and a revision that is below the capture's or not an integer from 0 to 2^53 − 1.
 */
export function advanceCapture(capture: Capture, history: History, revision: Revision): Capture {
  built(capture);
  if (history !== capture.history)
    throw new StoreError("invalid-request", "capture: a capture moves only within its history");
  if (!Number.isSafeInteger(revision) || revision < capture.revision)
    throw new StoreError(
      "invalid-request",
      "capture: a capture moves only to a later revision of its history",
    );
  if (revision === capture.revision) return capture;
  const moved = Object.freeze({ ...capture, revision }) as Capture;
  BUILT.add(moved);
  return moved;
}

/**
 * The checks of a capture, with no constructor: for a runner that judges a capture a witness
 * returned. Answers the reason it would be refused, or null. A local history is allowed.
 */
export function captureDefect(value: unknown): string | null {
  try {
    if (typeof value !== "object" || value === null) return "capture: not an object";
    const keys = Object.keys(value).sort().join(",");
    if (keys !== "anchors,expiresAt,history,members,revision,since")
      return `capture: the keys are ${keys}, not anchors, expiresAt, history, members, revision, since`;
    checked(value as Record<string, unknown>, false);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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
 * The validity window of `deltas` at `now`: `since`, the greatest boundary (`validFrom` or
 * `validUntil`) at or before `now`, and `expiresAt`, the least strictly after it; each null when
 * there is none. A delta is valid exactly when `validFrom <= now < validUntil`, so no delta
 * changes validity at any t with `since <= t < expiresAt`.
 */
export function validityWindow(deltas: Iterable<Delta>, now: number): ValidityWindow {
  let since: number | null = null;
  let expiresAt: number | null = null;
  for (const { claims } of deltas)
    for (const at of [claims.validFrom, claims.validUntil]) {
      if (at === undefined) continue;
      if (at > now) {
        if (expiresAt === null || at < expiresAt) expiresAt = at;
      } else if (since === null || at > since) since = at;
    }
  return { since, expiresAt };
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
  built(capture);
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
 * Is `capture` still current on `peer` at `now`? One `read()`. A snapshot of another history
 * answers `resync-required` at once. Then, unless the revisions are equal,
 * `changes(capture.revision, r′)` page by page, where r′ is that snapshot's revision; for each
 * page that names an added id, one `get` of those ids on the snapshot; it stops at the first
 * touch. Then it judges `now` against the window: before `since` is `not-yet`, at or after
 * `expiresAt` is `expired`.
 *
 * Its calls and cost depend on the records and ids since the capture, never on what the peer
 * holds and never on records before the capture. When the peer moves during the check, it starts
 * again on a new snapshot, as `StoreReactor` does, up to three more times; then `snapshot-moved`
 * passes up. Every snapshot is released. Refuses `invalid-request` for a `now` that is not a
 * finite number: a capture is current only relative to a time.
 */
export function checkFresh(peer: PeerStore, capture: Capture, now: number): Promise<Freshness> {
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
  now: number,
): Promise<Freshness> {
  built(capture);
  if (typeof now !== "number" || !Number.isFinite(now))
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
  now: number,
): Promise<Freshness> {
  const current = snapshot.revision;
  // Another history: revisions of the two cannot be compared at all.
  if (snapshot.history !== capture.history) return { status: "resync-required", current };
  // A capture from a later revision: the store was rolled back, or the capture is another peer's.
  if (current < capture.revision) return { status: "resync-required", current };
  for (let at = capture.revision; at < current; ) {
    const page = await peer.changes(at, current);
    if (page.status === "resync-required")
      return { status: "resync-required", current: page.current };
    // A store fault, not a verdict: a page with no progress short of r′, or one that claims
    // records past r′, cannot vouch for the range, and its records are not judged.
    if (page.through <= at || page.through > current)
      throw new Error(
        `checkFresh: the store's page from ${at} to ${current} ends at ${page.through}; the store breaks the change feed contract (§4.6)`,
      );
    const ids = [...new Set(page.records.flatMap((record) => record.added))].sort(compareUtf8);
    const added = new Map<Id, Delta>();
    if (ids.length > 0) for (const delta of await snapshot.get(ids)) added.set(delta.id, delta);
    const found = touch(capture, page.records, added);
    if (found !== null) return { status: "stale", touch: found };
    at = page.through;
  }
  if (capture.since !== null && now < capture.since)
    return { status: "not-yet", since: capture.since };
  if (capture.expiresAt !== null && now >= capture.expiresAt)
    return { status: "expired", expiresAt: capture.expiresAt };
  return { status: "current" };
}
