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
import { evalTerm, type EvalResult } from "../resolve/eval.js";
import type { SchemaRegistry } from "../schema/schema.js";
import type { Term } from "../syntax/model.js";
import type { Bindings } from "../syntax/pred.js";
import type { ArrivalRecord } from "../storage/arrival-record.js";
import { createFetchCache, type FetchCache } from "../storage/fetch-cache.js";
import type { ScopeSource } from "../storage/scope-source.js";
import {
  StoreError,
  type AppliedPushdown,
  type Entity,
  type Id,
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
}

/** What one round did. */
export interface StoreRoundReport {
  /** 1 for the first round. */
  readonly round: number;
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

/** One `scope` call per round, for the new anchors only, naming everything held (§4.4). */
export const STANDARD_ROUNDS: RoundPolicy = {
  request: ({ fresh, held, pushdown }) => {
    const exclude = [...held];
    return {
      anchors: entityAnchors(fresh),
      ...(pushdown === undefined ? {} : { pushdown }),
      ...(exclude.length === 0 ? {} : { exclude }),
    };
  },
  residual: unappliedFields,
};

/**
 * The same read with no use of the fetch cache: every round fetches every anchor again and
 * names nothing as held, so each answer alone carries the whole scope so far.
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
  cache: FetchCache,
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

// One evaluation of the gather over the exact members of a round. The evaluation memo of the
// slice 2 plan §3 hooks in here: it wraps this call, keyed by (schema reference, bindings,
// root), and may keep a child only when every anchor its HView shows has been fetched.
function evaluateRound(
  gather: Term,
  members: DeltaSet,
  request: StoreReadRequest,
): Extract<EvalResult, { sort: "hview" }> {
  const gathered = evalTerm(
    gather,
    members,
    request.now,
    request.root,
    request.registry,
    request.bindings,
  );
  if (gathered.sort !== "hview") throw new UnanchoredTermError("result-sort");
  return gathered;
}

/**
 * `readAnchored` under a given round policy. Not part of the package surface: the conformance
 * harness and the rails use it.
 */
export async function readAnchoredWith(
  snapshot: Snapshot,
  request: StoreReadRequest,
  policy: RoundPolicy,
): Promise<StoreRead> {
  const { term, root, registry, bindings } = request;
  const analysis = anchorAnalysis(term, registry, bindings);
  if (!analysis.anchored) throw new UnanchoredTermError(analysis.reason);
  const gather = term.kind === "resolve" ? term.of : term;

  const cache = createFetchCache();
  const unapplied = new Set<PushdownField>();
  const anchors = new Set<Entity>();
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
      cache,
      anchors,
      residualSelection(cache, asked.pushdown, unapplied, request.admits),
    );
    const set = cache.subset(members);
    const gathered = evaluateRound(gather, set, request);
    const report: StoreRoundReport = {
      round: rounds.length + 1,
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
          : evalTerm(term, set, request.now, root, registry, request.bindings);
      return {
        result,
        scope: [...anchors].sort(compareUtf8),
        members,
        revision: snapshot.revision,
        rounds,
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

/** A fetched scope: a synchronous source over its exact members, and the revision it is of. */
export interface FetchedScope {
  /** Knows exactly S(entities) under the selection. An id outside it reads as not held. */
  readonly source: ScopeSource;
  readonly revision: Revision;
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
  const cache = createFetchCache();
  cache.add(answer.deltas);
  const unapplied = new Set(unappliedFields(asked.pushdown, answer.applied));
  const members = scopeIds(
    cache,
    anchors,
    residualSelection(cache, asked.pushdown, unapplied, selection.admits),
  );
  return { source: cache.source(members), revision: snapshot.revision };
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
    const { value, attempts } = await this.onSnapshot((snapshot) =>
      readAnchored(snapshot, request),
    );
    return { ...value, attempts };
  }

  /** `fetchScope` on a new snapshot, with the same retry rule as `read`. */
  async fetch(entities: Iterable<Entity>, selection?: StoreSelection): Promise<FetchedScope> {
    const wanted = [...entities];
    return (await this.onSnapshot((snapshot) => fetchScope(snapshot, wanted, selection))).value;
  }

  private async onSnapshot<T>(
    run: (snapshot: Snapshot) => Promise<T>,
  ): Promise<{ value: T; attempts: number }> {
    for (let attempts = 1; ; attempts += 1) {
      const snapshot = await this.peer.read();
      try {
        return { value: await run(snapshot), attempts };
      } catch (error) {
        const moved = error instanceof StoreError && error.code === "snapshot-moved";
        if (!moved || attempts > SNAPSHOT_RETRIES) throw error;
      } finally {
        snapshot.release();
      }
    }
  }
}
