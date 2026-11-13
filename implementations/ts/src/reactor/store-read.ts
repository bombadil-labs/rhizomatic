// The store-backed read (SPEC-18 proposal §4.4, §6.2; slice 2 plan §3). The store boundary is
// asynchronous and batch-shaped; evaluation is synchronous. A read fetches its scope one round
// at a time from one snapshot and evaluates in memory between rounds. It never scans: a term
// with no anchors is refused, not served some other way.

import { compareUtf8 } from "../delta/cbor.js";
import type { DeltaSet } from "../delta/set.js";
import type { Delta } from "../delta/types.js";
import {
  anchorAnalysis,
  hviewAnchors,
  scopeIds,
  type AnchoredRead,
  type UnanchoredReason,
} from "../resolve/anchored.js";
import type { HView } from "../algebra/hview.js";
import { evalTerm, type ChildMemo, type EvalResult } from "../resolve/eval.js";
import type { SchemaRegistry } from "../schema/schema.js";
import type { SchemaRefT, Term } from "../syntax/model.js";
import type { Bindings } from "../syntax/pred.js";
import type { ArrivalRecord } from "../storage/arrival-record.js";
import { createReadCache, type HeldMembers } from "../storage/fetch-cache.js";
import {
  makeCapture,
  rawScope,
  validityWindow,
  type Capture,
  type ValidityWindow,
} from "../storage/freshness.js";
import type { ScopeSource } from "../storage/scope-source.js";
import {
  StoreError,
  collectDeltaSet,
  type AppliedPushdown,
  type Entity,
  type Id,
  type PeerExporter,
  type PeerStore,
  type Pushdown,
  type Revision,
  type ScopeRequest,
  type Snapshot,
} from "../storage/store.js";

/** The refusal of a store-backed read of an unanchored term. `reason` is SPEC-17 §5's. */
export class UnanchoredTermError extends Error {
  readonly reason: UnanchoredReason;
  constructor(reason: UnanchoredReason) {
    super(`term is not anchored: ${reason}`);
    this.name = "UnanchoredTermError";
    this.reason = reason;
  }
}

/**
 * A host selection the store cannot apply (SPEC-17 §3): decided per delta, from that delta, its
 * arrival record at this peer and host state the read does not change.
 */
export type StoreAdmits = (delta: Delta, arrival: ArrivalRecord) => boolean;

/** The selection of a store read: what the store may apply, and what only the host can. */
export interface StoreSelection {
  /** A dropped delta is absent from the read, and negation chains stop at it. */
  readonly pushdown?: Pushdown;
  readonly admits?: StoreAdmits;
}

export interface StoreReadRequest extends StoreSelection {
  readonly term: Term;
  readonly root: string;
  readonly now: number;
  readonly registry?: SchemaRegistry;
  readonly bindings?: Bindings;
  /**
   * Called after each round's evaluation and before the next store call, with that round's
   * report. A returned promise is awaited. For route reports and tests.
   */
  readonly onRound?: (round: StoreRoundReport) => void | Promise<void>;
  /**
   * Also answer a capture of the read (SPEC-18 §4.6): its raw scope as ids, on the same
   * snapshot. A read that pushed no selection down already holds its raw scope; one that did
   * makes the id-only calls of `rawScope` after its last round.
   */
  readonly capture?: boolean;
}

/** What one round did. */
export interface StoreRoundReport {
  /** 1 for the first round of each attempt. */
  readonly round: number;
  /**
   * Which snapshot of the read this round ran on: 1 for the first. `StoreReactor.read` counts
   * up when it starts again after `snapshot-moved`; `readAnchored` always reports 1.
   */
  readonly attempt: number;
  /** The revision of the snapshot this round ran on. */
  readonly revision: Revision;
  /** The entities this round's `scope` call asked for, ascending. */
  readonly anchors: readonly Entity[];
  /** How many deltas the store returned for this round. */
  readonly fetched: number;
  /** How many deltas the read holds after this round. */
  readonly held: number;
  /** How many deltas are in the exact scope of every anchor fetched so far. */
  readonly members: number;
  /** What the store reported applied for this round's request. */
  readonly applied: AppliedPushdown;
}

/** An anchored read with the revision it answered at and what each round did. */
export interface StoreRead extends AnchoredRead {
  readonly revision: Revision;
  readonly rounds: readonly StoreRoundReport[];
  /**
   * How many child evaluations the evaluation memo held when the read ended (SPEC-18 §4.12
   * reading 27). 0 when the memo is off. The memo changes no answer, so this is the one place a
   * read shows whether it used one.
   */
  readonly memoStored: number;
  /**
   * The greatest `validFrom` or `validUntil` at or before `now` among the read's exact members,
   * or null.
   */
  readonly since: number | null;
  /**
   * The least `validFrom` or `validUntil` strictly after `now` among the read's exact members,
   * or null. The same read on the same snapshot answers the same at every time t with
   * `since <= t < expiresAt` (a null bound is open).
   */
  readonly expiresAt: number | null;
  /** Present exactly when the request asked for it. */
  readonly capture?: Capture;
}

/** The evaluation memo of one attempt, and how many child evaluations it holds. */
export interface ReadMemo extends ChildMemo {
  readonly stored: number;
}

type PushdownField = keyof AppliedPushdown;
const FIELDS: readonly PushdownField[] = ["timestampAtMost", "arrivalAtMost", "excludeIds"];

/**
 * The decisions of a round that the round vectors hold a reader to. `readAnchored` uses
 * `STANDARD_ROUNDS`. The conformance harness passes others: the read with no fetch cache, and
 * readers that are wrong on purpose, which the vectors must catch.
 */
export interface RoundPolicy {
  /**
   * The one `scope` request of a round. `fresh` are the anchors no earlier round asked for,
   * `anchors` every anchor so far with `fresh` among them, `held` every id the read holds.
   */
  request(round: {
    readonly fresh: readonly Entity[];
    readonly anchors: readonly Entity[];
    readonly held: Iterable<Id>;
    readonly pushdown: Pushdown | undefined;
  }): ScopeRequest;
  /** The fields of the pushdown that was sent which the host must apply itself. */
  residual(sent: Pushdown | undefined, applied: AppliedPushdown): readonly PushdownField[];
  /**
   * The evaluation memo of one attempt of one read (SPEC-18 §4.12 reading 21), made once when
   * the attempt starts. `fetched` is every anchor asked for so far; it grows as the rounds go.
   * Absent: every round evaluates every child it reaches.
   */
  readonly memo?: (fetched: ReadonlySet<Entity>) => ReadMemo;
}

const entityAnchors = (entities: readonly Entity[]): ScopeRequest["anchors"] =>
  entities.map((entity) => ({ kind: "entity" as const, entity }));

/** The trim lemma's residual (§4.3): every requested field the store did not report applied. */
export function unappliedFields(
  sent: Pushdown | undefined,
  applied: AppliedPushdown,
): PushdownField[] {
  return FIELDS.filter((field) => sent?.[field] !== undefined && !applied[field]);
}

/** Is every anchor this HView shows fetched? Its id, and every child expanded in it. */
function finalIn(fetched: ReadonlySet<Entity>, known: WeakSet<HView>, hview: HView): boolean {
  if (known.has(hview)) return true;
  if (!fetched.has(hview.id)) return false;
  for (const entries of hview.props.values())
    for (const entry of entries)
      for (const child of entry.expanded?.values() ?? [])
        if (!finalIn(fetched, known, child)) return false;
  // Fetched anchors are never dropped within an attempt, so a final HView stays final.
  known.add(hview);
  return true;
}

/**
 * The evaluation memo of SPEC-18 §4.4 for one attempt of one read. It keeps a child evaluation
 * under (schema reference, bindings object, root), and only when the child is final: every
 * anchor its HView shows has been fetched. Such a child equals the child over the whole surface,
 * and no later round of the attempt can change it (§4.12 reading 22). A child that is not final
 * is evaluated again by the next round that reaches it.
 */
export function finalChildMemo(fetched: ReadonlySet<Entity>): ReadMemo {
  const kept = new Map<string, HView>();
  const known = new WeakSet<HView>();
  // Bindings by identity: the term holds each bindings object for the whole read (reading 21).
  const bindingIds = new Map<Bindings, number>();
  const key = (schema: SchemaRefT, bindings: Bindings | undefined, root: string): string => {
    let id = 0;
    if (bindings !== undefined) {
      id = bindingIds.get(bindings) ?? bindingIds.size + 1;
      bindingIds.set(bindings, id);
    }
    const ref = schema.kind === "name" ? `n:${schema.name}` : `h:${schema.hash}`;
    return JSON.stringify([ref, id, root]);
  };
  return {
    get: (schema, bindings, root) => kept.get(key(schema, bindings, root)),
    put: (schema, bindings, root, hview) => {
      if (finalIn(fetched, known, hview)) kept.set(key(schema, bindings, root), hview);
    },
    get stored() {
      return kept.size;
    },
  };
}

// One `scope` call per round, for the new anchors only, naming everything held (§4.4).
const NEW_ANCHORS_ONLY = {
  request: ({ fresh, held, pushdown }: Parameters<RoundPolicy["request"]>[0]): ScopeRequest => {
    const exclude = [...held];
    return {
      anchors: entityAnchors(fresh),
      ...(pushdown === undefined ? {} : { pushdown }),
      ...(exclude.length === 0 ? {} : { exclude }),
    };
  },
  residual: unappliedFields,
};

/** The fetch cache and no evaluation memo: mode 3 of the round vectors. */
export const CACHED_ROUNDS: RoundPolicy = NEW_ANCHORS_ONLY;

/** The fetch cache and the evaluation memo: the read `readAnchored` makes (mode 5). */
export const STANDARD_ROUNDS: RoundPolicy = { ...NEW_ANCHORS_ONLY, memo: finalChildMemo };

/**
 * The same read with no use of the fetch cache and no memo (mode 2): every round fetches every
 * anchor again and names nothing as held, so each answer alone carries the whole scope so far.
 */
export const UNCACHED_ROUNDS: RoundPolicy = {
  request: ({ anchors, pushdown }) => ({
    anchors: entityAnchors(anchors),
    ...(pushdown === undefined ? {} : { pushdown }),
  }),
  residual: unappliedFields,
};

// The host half of a selection over what the read holds: `admits`, and each pushdown field the
// store left to the host. Pointwise, so the trim lemma applies (§4.3).
function residualSelection(
  cache: HeldMembers,
  sent: Pushdown | undefined,
  fields: ReadonlySet<PushdownField>,
  admits: StoreAdmits | undefined,
): ((delta: Delta) => boolean) | undefined {
  const timestampAtMost = fields.has("timestampAtMost") ? sent?.timestampAtMost : undefined;
  const arrivalAtMost = fields.has("arrivalAtMost") ? sent?.arrivalAtMost : undefined;
  const dropped = fields.has("excludeIds") ? new Set(sent?.excludeIds) : undefined;
  if (
    admits === undefined &&
    timestampAtMost === undefined &&
    arrivalAtMost === undefined &&
    dropped === undefined
  )
    return undefined;
  return (delta) => {
    if (timestampAtMost !== undefined && delta.claims.timestamp > timestampAtMost) return false;
    if (dropped?.has(delta.id) === true) return false;
    if (arrivalAtMost === undefined && admits === undefined) return true;
    const arrival = cache.arrival(delta.id);
    if (arrival === undefined) return false;
    if (arrivalAtMost !== undefined && arrival.sequence > arrivalAtMost) return false;
    return admits === undefined || admits(delta, arrival);
  };
}

// One evaluation of the gather over the exact members of a round. With a memo, a child that an
// earlier round finished is not evaluated again.
function evaluateRound(
  gather: Term,
  members: DeltaSet,
  request: StoreReadRequest,
  memo: ChildMemo | undefined,
): Extract<EvalResult, { sort: "hview" }> {
  const gathered = evalTerm(
    gather,
    members,
    request.now,
    request.root,
    request.registry,
    request.bindings,
    memo,
  );
  if (gathered.sort !== "hview") throw new UnanchoredTermError("result-sort");
  return gathered;
}

/**
 * `readAnchored` under a given round policy. Not part of the package surface: the conformance
 * harness and the rails use it. `attempt` is the number each round report carries.
 */
export async function readAnchoredWith(
  snapshot: Snapshot,
  request: StoreReadRequest,
  policy: RoundPolicy,
  attempt = 1,
): Promise<StoreRead> {
  const { term, root, registry, bindings } = request;
  const analysis = anchorAnalysis(term, registry, bindings);
  if (!analysis.anchored) throw new UnanchoredTermError(analysis.reason);
  const gather = term.kind === "resolve" ? term.of : term;

  // The cache is this read's alone; evaluation reads what it keeps without a copy.
  const { cache, held } = createReadCache();
  const unapplied = new Set<PushdownField>();
  const anchors = new Set<Entity>();
  // The memo reads `anchors` as it grows. It lives as long as this attempt and no longer.
  const memo = policy.memo?.(anchors);
  const rounds: StoreRoundReport[] = [];
  let fresh = [...new Set([root, ...analysis.anchors])].sort(compareUtf8);
  for (;;) {
    for (const entity of fresh) anchors.add(entity);
    const asked = policy.request({
      fresh,
      anchors: [...anchors].sort(compareUtf8),
      held: cache.ids(),
      pushdown: request.pushdown,
    });
    const answer = await snapshot.scope(asked);
    // The cache keeps members that fail the residual, so `exclude` names them next round.
    cache.add(answer.deltas);
    // A field one round left to the host stays with the host: an earlier round's members that
    // the store did trim pass it anyway.
    for (const field of policy.residual(asked.pushdown, answer.applied)) unapplied.add(field);

    // The exact scope of every anchor so far: S(anchors) over what is held, under the residual.
    const members = scopeIds(
      held,
      anchors,
      residualSelection(held, asked.pushdown, unapplied, request.admits),
    );
    const set = held.subset(members);
    const gathered = evaluateRound(gather, set, request, memo);
    const report: StoreRoundReport = {
      round: rounds.length + 1,
      attempt,
      revision: snapshot.revision,
      anchors: asked.anchors.map((anchor) => anchor.entity),
      fetched: answer.deltas.length,
      held: cache.size,
      members: members.length,
      applied: answer.applied,
    };
    rounds.push(report);
    await request.onRound?.(report);

    fresh = hviewAnchors(gathered.hview).filter((entity) => !anchors.has(entity));
    if (fresh.length === 0) {
      const result =
        gather === term
          ? gathered
          : evalTerm(term, set, request.now, root, registry, request.bindings, memo);
      const scope = [...anchors].sort(compareUtf8);
      const validity = validityWindow(set, request.now);
      const capture =
        request.capture === true
          ? makeCapture(
              snapshot,
              entityAnchors(scope),
              // With nothing pushed down, every round's answer lies inside S(its anchors over H)
              // and the rounds together hold all of S(scope over H): the cache is the raw scope.
              pushedDown(request.pushdown)
                ? await rawScope(snapshot, entityAnchors(scope))
                : cache.ids(),
              validity,
            )
          : undefined;
      return {
        result,
        scope,
        members,
        revision: snapshot.revision,
        rounds,
        memoStored: memo?.stored ?? 0,
        ...validity,
        ...(capture === undefined ? {} : { capture }),
      };
    }
  }
}

/**
 * An anchored read in rounds on one snapshot (SPEC-18 §4.4). The answer equals `evalTerm` over
 * everything the peer holds at the snapshot's revision that the selection admits.
 *
 * Each round makes exactly one `scope` call and no other store call. Throws
 * `UnanchoredTermError` before any store call for a term that is not anchored. A
 * `snapshot-moved` refusal passes up unchanged: the caller starts again on a new snapshot.
 */
export function readAnchored(snapshot: Snapshot, request: StoreReadRequest): Promise<StoreRead> {
  return readAnchoredWith(snapshot, request, STANDARD_ROUNDS);
}

/** A full-surface read: no anchors, so the host applies its whole selection itself. */
export interface FullSurfaceRequest {
  readonly term: Term;
  /** Absent for a term that reads no root. */
  readonly root?: string;
  readonly now: number;
  readonly registry?: SchemaRegistry;
  readonly bindings?: Bindings;
  /**
   * Applied by the host to each listed delta. A dropped delta is absent, and negation chains stop
   * at it. No `arrivalAtMost` and no `admits`: a listing carries no arrival record (§4.7.6).
   */
  readonly pushdown?: Omit<Pushdown, "arrivalAtMost">;
}

/** How a full-surface read went. It is never optimized: it read everything the peer holds. */
export interface FullSurfaceRoute {
  readonly optimized: false;
  /** How many deltas the listing gave. */
  readonly listed: number;
  /** How many of them passed the selection and were evaluated over. */
  readonly admitted: number;
}

export interface FullSurfaceRead {
  readonly result: EvalResult;
  readonly route: FullSurfaceRoute;
}

/**
 * The explicit full-surface read of SPEC-18 §6.6: list every delta the peer holds through its
 * exporter, keep those the selection admits, and evaluate the term over them. O(surface), for
 * any term, anchored or not. It needs a `PeerExporter`, so a serving path that was never given
 * one (a `StoreReactor`, a snapshot) cannot reach it. It keeps nothing.
 *
 * Refuses `invalid-request`, before it lists anything, for a selection that names
 * `arrivalAtMost` or `admits`: the listing has no arrival record to decide them by.
 */
export async function readFullSurface(
  peer: PeerExporter,
  request: FullSurfaceRequest,
): Promise<FullSurfaceRead> {
  const untyped = request as FullSurfaceRequest & { pushdown?: Pushdown; admits?: unknown };
  if (untyped.pushdown?.arrivalAtMost !== undefined || untyped.admits !== undefined)
    throw new StoreError(
      "invalid-request",
      "a full-surface read cannot select by arrival: a peer listing carries no arrival record",
    );
  const whole = await collectDeltaSet(peer);
  const { timestampAtMost, excludeIds } = request.pushdown ?? {};
  const dropped = new Set(excludeIds);
  const admitted =
    timestampAtMost === undefined && dropped.size === 0
      ? whole
      : whole.filtered(
          (delta) =>
            !dropped.has(delta.id) &&
            (timestampAtMost === undefined || delta.claims.timestamp <= timestampAtMost),
        );
  const result = evalTerm(
    request.term,
    admitted,
    request.now,
    request.root,
    request.registry,
    request.bindings,
  );
  return { result, route: { optimized: false, listed: whole.size, admitted: admitted.size } };
}

/** A fetched scope: a synchronous source over its exact members, and the revision it is of. */
export interface FetchedScope {
  /** Knows exactly S(entities) under the selection. An id outside it reads as not held. */
  readonly source: ScopeSource;
  readonly revision: Revision;
  /**
   * The validity window of the source's members at `now` (`validityWindow`). A fetched scope has
   * no evaluation time of its own: each question to the source names its own `now`.
   * O(log members).
   */
  validityAt(now: number): ValidityWindow;
}

/** Did this selection push any field down to the store? */
const pushedDown = (pushdown: Pushdown | undefined): boolean =>
  FIELDS.some((field) => pushdown?.[field] !== undefined);

/** The window of an ascending list of boundaries at `now`: the last at or before, the first after. */
function windowIn(sorted: readonly number[], now: number): ValidityWindow {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid]! > now) high = mid;
    else low = mid + 1;
  }
  return { since: sorted[low - 1] ?? null, expiresAt: sorted[low] ?? null };
}

/**
 * One `scope` call for the scope of these entities, then a synchronous source over it. A law
 * reader fetches the anchors of everything it will ask about, then reads without a store call.
 */
export async function fetchScope(
  snapshot: Snapshot,
  entities: Iterable<Entity>,
  selection: StoreSelection = {},
): Promise<FetchedScope> {
  const anchors = [...new Set(entities)].sort(compareUtf8);
  const asked: ScopeRequest = {
    anchors: entityAnchors(anchors),
    ...(selection.pushdown === undefined ? {} : { pushdown: selection.pushdown }),
  };
  const answer = await snapshot.scope(asked);
  const { cache, held } = createReadCache();
  cache.add(answer.deltas);
  const unapplied = new Set(unappliedFields(asked.pushdown, answer.applied));
  const members = scopeIds(
    held,
    anchors,
    residualSelection(held, asked.pushdown, unapplied, selection.admits),
  );
  const boundaries = [
    ...new Set(
      members.flatMap((id) => {
        const { validFrom, validUntil } = held.get(id)!.claims;
        return validUntil === undefined ? [validFrom] : [validFrom, validUntil];
      }),
    ),
  ].sort((a, b) => a - b);
  return {
    source: cache.source(members),
    revision: snapshot.revision,
    validityAt: (now) => windowIn(boundaries, now),
  };
}

/**
 * A capture of the scope of these entities on this snapshot (SPEC-18 §4.6), as a host takes one
 * beside a fetched scope: `members` is the raw scope, from ids alone and never from a pushed-down
 * fetch; `since` and `expiresAt` are the validity window at `now` of the exact scope under the
 * selection. One `scope` call, then the calls of `rawScope`.
 */
export async function captureScope(
  snapshot: Snapshot,
  entities: Iterable<Entity>,
  now: number,
  selection: StoreSelection = {},
): Promise<Capture> {
  if (!Number.isFinite(now)) throw new StoreError("invalid-request", "now must be a finite number");
  const anchors = entityAnchors([...new Set(entities)].sort(compareUtf8));
  const fetched = await fetchScope(
    snapshot,
    anchors.map((anchor) => anchor.entity),
    selection,
  );
  // With no selection at all, the exact scope is the raw scope and needs no second look.
  const raw =
    !pushedDown(selection.pushdown) && selection.admits === undefined
      ? fetched.source.ids()
      : await rawScope(snapshot, anchors);
  return makeCapture(snapshot, anchors, raw, fetched.validityAt(now));
}

/** How many times `StoreReactor` starts a read again after `snapshot-moved`. */
export const SNAPSHOT_RETRIES = 3;

/** A `StoreReactor` read: the read, and how many snapshots it took. */
export interface StoreReactorRead extends StoreRead {
  /** 1 when the first snapshot held still. */
  readonly attempts: number;
}

/**
 * A reactor's read side over one peer of a store (SPEC-18 §6.1, §6.2). It holds the peer handle
 * and nothing else: opening it reads nothing, and each read takes its own snapshot and releases
 * it. It has no whole-set method; the serving path that holds one cannot scan.
 */
export class StoreReactor {
  private constructor(private readonly peer: PeerStore) {}

  /** O(1). Makes no store call. */
  static open(peer: PeerStore): StoreReactor {
    return new StoreReactor(peer);
  }

  /**
   * `readAnchored` on a new snapshot. When the peer moves under the read, the whole read starts
   * again on a new snapshot, up to `SNAPSHOT_RETRIES` times; then `snapshot-moved` passes up.
   * Nothing fetched from one snapshot is used with another.
   */
  async read(request: StoreReadRequest): Promise<StoreReactorRead> {
    // An unanchored term is refused before the first store call; opening a snapshot is one.
    const analysis = anchorAnalysis(request.term, request.registry, request.bindings);
    if (!analysis.anchored) throw new UnanchoredTermError(analysis.reason);
    const { value, attempts } = await this.onSnapshot((snapshot, attempt) =>
      readAnchoredWith(snapshot, request, STANDARD_ROUNDS, attempt),
    );
    return { ...value, attempts };
  }

  /** `fetchScope` on a new snapshot, with the same retry rule as `read`. */
  async fetch(entities: Iterable<Entity>, selection?: StoreSelection): Promise<FetchedScope> {
    const wanted = [...entities];
    return (await this.onSnapshot((snapshot) => fetchScope(snapshot, wanted, selection))).value;
  }

  private async onSnapshot<T>(
    run: (snapshot: Snapshot, attempt: number) => Promise<T>,
  ): Promise<{ value: T; attempts: number }> {
    for (let attempts = 1; ; attempts += 1) {
      const snapshot = await this.peer.read();
      try {
        return { value: await run(snapshot, attempts), attempts };
      } catch (error) {
        const moved = error instanceof StoreError && error.code === "snapshot-moved";
        if (!moved || attempts > SNAPSHOT_RETRIES) throw error;
      } finally {
        snapshot.release();
      }
    }
  }
}
