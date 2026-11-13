// Held views over a store (SPEC-18 proposal §4.6, "Held views"). A `StoreViews` keeps, for one
// peer, a bounded set of views: each the result of one anchored read (program, root) with its
// capture. It keeps them current through the change feed, one pass for the whole set: it reads
// the records since its processed position once, finds the views those records touch through an
// inverted index (anchor entity → views, member id → views), and reads those views again on the
// pass's snapshot. Untouched views keep their bytes. Then time and the host's epochs.
//
// The claim (SPEC-4 §1 through a store): after a pass at position p and time `now`, every held
// view's bytes equal a fresh `readAnchored` of its program and root on the snapshot at p at
// `now`. It rests on three things: the feed claim of `touching` (no touch means the raw scope is
// unchanged, arrival records included), the window claim of a capture (the read answers the same
// at every time inside `[since, expiresAt)`), and every re-read running on the pass's snapshot.
//
// What it does not see: state the host's selection or authority reads outside the store. The
// host names that state with an epoch per program and calls `setEpoch` when it changes.
//
// A held view is a copy outside the store. It can hold a purged delta's payload until the next
// pass reads the purge's record. A host that erases calls `refresh` (or `drop`) before it
// reports.

import { compareUtf8 } from "../delta/cbor.js";
import type { Delta } from "../delta/types.js";
import { resultCanonicalHex } from "../resolve/eval.js";
import { anchorAnalysis } from "../resolve/anchored.js";
import type { SchemaRegistry } from "../schema/schema.js";
import type { Term } from "../syntax/model.js";
import { advanceCapture, touching, type Capture } from "../storage/freshness.js";
import { positionOf, type Position } from "../storage/follow.js";
import {
  StoreError,
  type ChangeRecord,
  type Entity,
  type Id,
  type PeerStore,
  type Snapshot,
} from "../storage/store.js";
import {
  STANDARD_ROUNDS,
  UnanchoredTermError,
  readAnchoredWith,
  type RoundPolicy,
  type StoreSelection,
} from "./store-read.js";

/** A registered program: an anchored term, read at a root. */
export interface ViewProgram {
  readonly term: Term;
  readonly registry?: SchemaRegistry;
  readonly selection?: StoreSelection;
  /**
   * The host's name for the state its selection and authority read outside the store. A view
   * read under one epoch is read again once the program's epoch is another. Default: "".
   */
  readonly epoch?: string;
}

/** A view: one program at one root. */
export interface ViewKey {
  readonly name: string;
  readonly root: Entity;
}

/** What `hold` answers. */
export interface ViewRead extends ViewKey {
  /** The canonical bytes of the read's result (the HView, or the View of a `resolve`), as hex. */
  readonly bytes: string;
  /** The position of the pass's snapshot: the bytes are a read on it. */
  readonly position: Position;
  /** The least validity boundary after the read's time among its operand, or null. */
  readonly expiresAt: number | null;
  /** "held": the view was held and the pass kept its bytes. "read": the pass read it. */
  readonly from: "held" | "read";
  /** The view's capture, at `position`. */
  readonly capture: Capture;
}

/** A view whose bytes differ from those it had at the previous refresh. Bytes as hex. */
export interface ViewChange extends ViewKey {
  readonly before: string;
  readonly after: string;
}

/** What `refresh` answers. */
export interface Refresh {
  readonly position: Position;
  /** Ascending by name, then root (UTF-8 bytes). Views first held since then are not here. */
  readonly changed: readonly ViewChange[];
  /** The views this refresh read again, ascending by name, then root. */
  readonly reread: readonly ViewKey[];
  /** The feed could not take the views from their position: every held view was read again. */
  readonly resynced: boolean;
}

export interface StoreViewsOptions {
  /** How many views are held at most. An integer of 1 or more. Default 1024. */
  readonly maxViews?: number;
  /** The round policy of every read. Default `STANDARD_ROUNDS`. */
  readonly rounds?: RoundPolicy;
}

/**
 * Rules a holder breaks on purpose. Not part of the package surface: the rails build the wrong
 * holders of `vectors/store/README.md` §11 with it.
 */
export interface ViewQuirks {
  readonly neverReread?: boolean;
  readonly rereadAll?: boolean;
  readonly ignoreRemoved?: boolean;
  readonly ignoreNegators?: boolean;
  readonly keepOldIndex?: boolean;
  readonly keepIndexOnDrop?: boolean;
  readonly ignoreSince?: boolean;
  readonly ignoreExpiresAt?: boolean;
  readonly ignoreEpoch?: boolean;
  readonly newerSnapshot?: boolean;
  readonly advanceOnFailure?: boolean;
  readonly mergeOnResync?: boolean;
  readonly feedPerView?: boolean;
  readonly staleBoundary?: boolean;
  /** Decides touches by asking `touching` of every held view: O(held views) per pass. */
  readonly scanEveryView?: boolean;
}

const DEFAULT_MAX_VIEWS = 1024;
/** How many times a pass starts again on a new snapshot after `snapshot-moved`. */
const SNAPSHOT_RETRIES = 3;

/** A heap over keys with O(log n) insert, update and delete, and a pruned walk of its top. */
class KeyHeap {
  private readonly items: { key: string; value: number }[] = [];
  private readonly at = new Map<string, number>();

  constructor(private readonly before: (a: number, b: number) => boolean) {}

  get size(): number {
    return this.items.length;
  }
  top(): number | null {
    return this.items[0]?.value ?? null;
  }
  set(key: string, value: number | null): void {
    this.delete(key);
    if (value === null) return;
    this.items.push({ key, value });
    this.at.set(key, this.items.length - 1);
    this.up(this.items.length - 1);
  }
  delete(key: string): void {
    const i = this.at.get(key);
    if (i === undefined) return;
    this.at.delete(key);
    const last = this.items.pop()!;
    if (i === this.items.length) return;
    this.items[i] = last;
    this.at.set(last.key, i);
    this.down(this.up(i));
  }
  /** Every key whose value `hit` accepts, where `hit` holds for a prefix of the heap order. */
  walk(hit: (value: number) => boolean, out: Set<string>): void {
    const stack = this.items.length > 0 ? [0] : [];
    while (stack.length > 0) {
      const i = stack.pop()!;
      const item = this.items[i];
      if (item === undefined || !hit(item.value)) continue;
      out.add(item.key);
      stack.push(2 * i + 1, 2 * i + 2);
    }
  }
  private swap(i: number, j: number): void {
    const a = this.items[i]!;
    const b = this.items[j]!;
    this.items[i] = b;
    this.items[j] = a;
    this.at.set(b.key, i);
    this.at.set(a.key, j);
  }
  private up(i: number): number {
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (!this.before(this.items[i]!.value, this.items[parent]!.value)) break;
      this.swap(i, parent);
      i = parent;
    }
    return i;
  }
  private down(i: number): void {
    for (;;) {
      let best = i;
      for (const child of [2 * i + 1, 2 * i + 2])
        if (
          child < this.items.length &&
          this.before(this.items[child]!.value, this.items[best]!.value)
        )
          best = child;
      if (best === i) return;
      this.swap(i, best);
      i = best;
    }
  }
}

type Program = {
  readonly term: Term;
  readonly registry: SchemaRegistry | undefined;
  readonly selection: StoreSelection;
  epoch: string;
};

type Held = {
  readonly key: string;
  readonly name: string;
  readonly root: Entity;
  bytes: string;
  capture: Capture;
  /** The program's epoch when the view was read. */
  epoch: string;
  /** The bytes at the previous refresh, or at the view's first read since. */
  base: string;
};

type Fresh = { readonly bytes: string; readonly capture: Capture; readonly epoch: string };

/** What one pass decided. Applied only when the whole pass succeeded. */
type Plan = {
  readonly position: Position;
  readonly reads: Map<string, Fresh>;
  readonly resynced: boolean;
};

const keyOf = (name: string, root: Entity): string => JSON.stringify([name, root]);
const unkey = (key: string): [string, Entity] => JSON.parse(key) as [string, Entity];

function byKey(a: ViewKey, b: ViewKey): number {
  return compareUtf8(a.name, b.name) || compareUtf8(a.root, b.root);
}

function addTo(index: Map<string, Set<string>>, at: string, key: string): void {
  let keys = index.get(at);
  if (keys === undefined) index.set(at, (keys = new Set()));
  keys.add(key);
}
function removeFrom(index: Map<string, Set<string>>, at: string, key: string): void {
  const keys = index.get(at);
  if (keys === undefined) return;
  keys.delete(key);
  if (keys.size === 0) index.delete(at);
}

/**
 * Memory-held views over one peer of a store, kept current through its change feed (SPEC-18
 * §4.6, "Held views"). The store-backed counterpart of the memory `Reactor`'s materializations.
 *
 * `hold`, `refresh`, `drop` and `setEpoch` run one at a time, in call order. A call that fails
 * changes nothing. There is no push: `refresh` answers what changed, and the host dispatches it.
 */
export class StoreViews {
  private readonly programs = new Map<string, Program>();
  /** Held views, least recently held or asked first. */
  private readonly views = new Map<string, Held>();
  private readonly anchorIndex = new Map<Entity, Set<string>>();
  private readonly memberIndex = new Map<Id, Set<string>>();
  private readonly byProgram = new Map<string, Set<string>>();
  private readonly expiries = new KeyHeap((a, b) => a < b);
  private readonly starts = new KeyHeap((a, b) => a > b);
  /** Programs whose epoch changed since a view of theirs was read. */
  private readonly newEpochs = new Set<string>();
  /** Views read since the previous refresh. */
  private readonly dirty = new Set<string>();
  private readonly evalCounts = new Map<string, number>();
  private processed: Position | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly maxViews: number;
  private readonly rounds: RoundPolicy;

  /**
   * Refuses `invalid-request` for a `maxViews` that is not an integer of 1 or more. Makes no
   * store call.
   */
  constructor(
    private readonly peer: PeerStore,
    options: StoreViewsOptions = {},
    private readonly quirks: ViewQuirks = {},
  ) {
    const max = options.maxViews ?? DEFAULT_MAX_VIEWS;
    if (!Number.isSafeInteger(max) || max < 1)
      throw new StoreError("invalid-request", "views: maxViews must be an integer of 1 or more");
    this.maxViews = max;
    this.rounds = options.rounds ?? STANDARD_ROUNDS;
  }

  /**
   * Registers a program under `name`. Throws `UnanchoredTermError` for a term that is not
   * anchored, as a read does (a full-surface program cannot be held), and refuses
   * `invalid-request` for a name already registered. Makes no store call.
   */
  register(name: string, program: ViewProgram): void {
    const analysis = anchorAnalysis(program.term, program.registry);
    if (!analysis.anchored) throw new UnanchoredTermError(analysis.reason);
    if (this.programs.has(name))
      throw new StoreError("invalid-request", `views: program ${name} is already registered`);
    this.programs.set(name, {
      term: program.term,
      registry: program.registry,
      selection: { ...program.selection },
      epoch: program.epoch ?? "",
    });
  }

  /**
   * The host's state behind `name`'s selection or authority is now `epoch`. Every held view of
   * `name` read under another epoch is read again by the next pass. Refuses `invalid-request`
   * for a name not registered.
   */
  setEpoch(name: string, epoch: string): Promise<void> {
    return this.serial(async () => {
      const program = this.program(name);
      if (program.epoch === epoch) return;
      program.epoch = epoch;
      this.newEpochs.add(name);
    });
  }

  /**
   * The view of `name` at `root`, current at `now`: one pass for the whole set (as `refresh`),
   * then, when the view is not held, one read on the pass's snapshot. Holding one view more than
   * `maxViews` forgets the least recently held or asked one. Refuses `invalid-request` for a name
   * not registered and a `now` that is not finite, before any store call.
   */
  hold(name: string, root: Entity, now: number): Promise<ViewRead> {
    return this.serial(async () => {
      this.program(name);
      finite(now);
      const key = keyOf(name, root);
      const was = this.views.has(key);
      const plan = await this.pass(now, { name, root });
      this.commit(plan, key);
      const view = this.views.get(key)!;
      return Object.freeze({
        name,
        root,
        bytes: view.bytes,
        position: plan.position,
        expiresAt: view.capture.expiresAt,
        from: was && !plan.reads.has(key) ? "held" : "read",
        capture: advanceCapture(view.capture, plan.position.history, plan.position.revision),
      });
    });
  }

  /**
   * Brings every held view to one snapshot and to `now`. Answers the views read again, and the
   * views whose bytes differ from those of the previous refresh. Refuses `invalid-request` for a
   * `now` that is not finite, before any store call.
   */
  refresh(now: number): Promise<Refresh> {
    return this.serial(async () => {
      finite(now);
      const plan = await this.pass(now, undefined);
      this.commit(plan, undefined);
      const changed: ViewChange[] = [];
      for (const key of this.dirty) {
        const view = this.views.get(key);
        if (view === undefined) continue;
        if (view.bytes !== view.base)
          changed.push({ name: view.name, root: view.root, before: view.base, after: view.bytes });
        view.base = view.bytes;
      }
      this.dirty.clear();
      const reread = [...plan.reads.keys()].map((key) => {
        const [name, root] = unkey(key);
        return { name, root };
      });
      return Object.freeze({
        position: plan.position,
        changed: Object.freeze(changed.sort(byKey)),
        reread: Object.freeze(reread.sort(byKey)),
        resynced: plan.resynced,
      });
    });
  }

  /** Forgets the view of `name` at `root`, if held. Makes no store call. */
  drop(name: string, root: Entity): Promise<void> {
    return this.serial(async () => this.forget(keyOf(name, root)));
  }

  /** The least `expiresAt` over the held views, or null: when a validity timer should fire. */
  get nextBoundary(): number | null {
    return this.expiries.top();
  }

  /** How many times the views of `name` were read. */
  evalCountOf(name: string): number {
    return this.evalCounts.get(name) ?? 0;
  }

  /** The sizes of the indexes. For tests: forgetting a view must leave nothing behind. */
  indexSizes(): {
    views: number;
    anchors: number;
    members: number;
    expiries: number;
    starts: number;
    programs: number;
  } {
    let programs = 0;
    for (const keys of this.byProgram.values()) programs += keys.size;
    return {
      views: this.views.size,
      anchors: this.anchorIndex.size,
      members: this.memberIndex.size,
      expiries: this.expiries.size,
      starts: this.starts.size,
      programs,
    };
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private program(name: string): Program {
    const program = this.programs.get(name);
    if (program === undefined)
      throw new StoreError("invalid-request", `views: no program is registered as ${name}`);
    return program;
  }

  private async pass(now: number, want: ViewKey | undefined): Promise<Plan> {
    for (let attempts = 1; ; attempts += 1) {
      const snapshot = await this.peer.read();
      try {
        return await this.passOn(snapshot, now, want);
      } catch (error) {
        if (this.quirks.advanceOnFailure === true) this.processed = positionOf(snapshot);
        const moved = error instanceof StoreError && error.code === "snapshot-moved";
        if (!moved || attempts > SNAPSHOT_RETRIES) throw error;
      } finally {
        snapshot.release();
      }
    }
  }

  private async passOn(snapshot: Snapshot, now: number, want: ViewKey | undefined): Promise<Plan> {
    const position = positionOf(snapshot);
    const at = this.processed;
    const reread = new Set<string>();
    let resynced = false;
    if (this.views.size > 0 && at !== undefined) {
      if (snapshot.history !== at.history || snapshot.revision < at.revision) resynced = true;
      else if (snapshot.revision > at.revision)
        resynced =
          this.quirks.feedPerView === true
            ? await this.feedPerView(snapshot, at.revision, reread)
            : !(await this.feed(snapshot, at.revision, undefined, reread));
    }
    if (resynced) {
      if (this.quirks.mergeOnResync !== true) for (const key of this.views.keys()) reread.add(key);
    } else {
      // Time: a view whose window does not hold `now`.
      if (this.quirks.ignoreExpiresAt !== true) this.expiries.walk((t) => t <= now, reread);
      if (this.quirks.ignoreSince !== true) this.starts.walk((t) => t > now, reread);
      // The host's state: a view read under an epoch its program has left.
      if (this.quirks.ignoreEpoch !== true)
        for (const name of this.newEpochs)
          for (const key of this.byProgram.get(name) ?? [])
            if (this.views.get(key)?.epoch !== this.programs.get(name)!.epoch) reread.add(key);
      if (this.quirks.rereadAll === true) for (const key of this.views.keys()) reread.add(key);
    }
    if (this.quirks.neverReread === true) reread.clear();
    const reads = new Map<string, Fresh>();
    // Every read runs on the pass's snapshot.
    let on = snapshot;
    if (this.quirks.newerSnapshot === true && reread.size > 0) on = await this.peer.read();
    try {
      for (const key of [...reread].sort()) {
        const [name, root] = unkey(key);
        reads.set(key, await this.read(on, name, root, now));
      }
      if (want !== undefined) {
        const key = keyOf(want.name, want.root);
        if (!this.views.has(key) && !reads.has(key))
          reads.set(key, await this.read(on, want.name, want.root, now));
      }
    } finally {
      if (on !== snapshot) on.release();
    }
    return { position, reads, resynced };
  }

  /**
   * Reads `changes(from, r′)` page by page and adds to `touched` every held view (or every one
   * among `only`) that a record touches: a record removes a member, or an added id still held at
   * r′ points at an anchor or negates a member (the rule of `touching`). Answers false on
   * `resync-required`.
   */
  private async feed(
    snapshot: Snapshot,
    from: number,
    only: readonly string[] | undefined,
    touched: Set<string>,
  ): Promise<boolean> {
    const end = snapshot.revision;
    for (let at = from; at < end; ) {
      const page = await this.peer.changes(at, end);
      if (page.status === "resync-required") return false;
      // A store fault, not a verdict (§4.13 reading 46): the page is not judged.
      if (page.through <= at || page.through > end)
        throw new Error(
          `views: the store's page from ${at} to ${end} ends at ${page.through}; the store breaks the change feed contract (§4.6)`,
        );
      const ids = [...new Set(page.records.flatMap((record) => record.added))].sort(compareUtf8);
      const added = new Map<Id, Delta>();
      if (ids.length > 0) for (const delta of await snapshot.get(ids)) added.set(delta.id, delta);
      if (this.quirks.scanEveryView === true) this.scan(page.records, added, touched);
      else this.touch(page.records, added, only, touched);
      at = page.through;
    }
    return true;
  }

  // The inverted index: O(ids × pointers) lookups, never a walk over the held views.
  private touch(
    records: readonly ChangeRecord[],
    added: ReadonlyMap<Id, Delta>,
    only: readonly string[] | undefined,
    touched: Set<string>,
  ): void {
    const hit = (keys: Set<string> | undefined): void => {
      for (const key of keys ?? []) if (only === undefined || only.includes(key)) touched.add(key);
    };
    for (const record of records) {
      if (this.quirks.ignoreRemoved !== true)
        for (const id of record.removed) hit(this.memberIndex.get(id));
      for (const id of record.added) {
        const delta = added.get(id);
        if (delta === undefined) continue;
        for (const { role, target } of delta.claims.pointers) {
          if (target.kind === "entity") hit(this.anchorIndex.get(target.entity.id));
          else if (
            role === "negates" &&
            target.kind === "delta" &&
            this.quirks.ignoreNegators !== true
          )
            hit(this.memberIndex.get(target.deltaRef.delta));
        }
      }
    }
  }

  private scan(
    records: readonly ChangeRecord[],
    added: ReadonlyMap<Id, Delta>,
    touched: Set<string>,
  ): void {
    for (const [key, view] of this.views)
      if (touching(view.capture, records, added) !== null) touched.add(key);
  }

  private async feedPerView(snapshot: Snapshot, from: number, touched: Set<string>) {
    for (const key of this.views.keys())
      if (!(await this.feed(snapshot, from, [key], touched))) return true;
    return false;
  }

  private async read(snapshot: Snapshot, name: string, root: Entity, now: number): Promise<Fresh> {
    const program = this.programs.get(name)!;
    const read = await readAnchoredWith(
      snapshot,
      {
        term: program.term,
        root,
        now,
        ...(program.registry === undefined ? {} : { registry: program.registry }),
        ...program.selection,
        capture: true,
      },
      this.rounds,
    );
    this.evalCounts.set(name, (this.evalCounts.get(name) ?? 0) + 1);
    return { bytes: resultCanonicalHex(read.result), capture: read.capture!, epoch: program.epoch };
  }

  /** Applies a pass that succeeded: no part of a failed pass is ever applied. */
  private commit(plan: Plan, want: string | undefined): void {
    if (want !== undefined && !this.views.has(want) && this.views.size >= this.maxViews) {
      const oldest = this.views.keys().next().value!;
      this.forget(oldest);
    }
    for (const [key, fresh] of plan.reads) {
      const view = this.views.get(key);
      if (view === undefined && key !== want) continue;
      if (view === undefined) {
        const [name, root] = unkey(key);
        this.views.set(key, { key, name, root, ...fresh, base: fresh.bytes });
        this.index(key, fresh.capture);
        this.time(key, fresh.capture);
        addTo(this.byProgram, name, key);
      } else {
        if (this.quirks.keepOldIndex !== true) {
          this.unindex(key, view.capture);
          this.index(key, fresh.capture);
        }
        if (this.quirks.staleBoundary !== true) this.time(key, fresh.capture);
        view.bytes = fresh.bytes;
        view.capture = fresh.capture;
        view.epoch = fresh.epoch;
      }
      this.dirty.add(key);
    }
    if (want !== undefined) {
      // The most recently held or asked view goes last.
      const view = this.views.get(want)!;
      this.views.delete(want);
      this.views.set(want, view);
    }
    this.processed = plan.position;
    this.newEpochs.clear();
  }

  private time(key: string, capture: Capture): void {
    this.expiries.set(key, capture.expiresAt);
    this.starts.set(key, capture.since);
  }

  private index(key: string, capture: Capture): void {
    for (const { entity } of capture.anchors) addTo(this.anchorIndex, entity, key);
    for (const id of capture.members) addTo(this.memberIndex, id, key);
  }

  private unindex(key: string, capture: Capture): void {
    for (const { entity } of capture.anchors) removeFrom(this.anchorIndex, entity, key);
    for (const id of capture.members) removeFrom(this.memberIndex, id, key);
  }

  private forget(key: string): void {
    const view = this.views.get(key);
    if (view === undefined) return;
    this.views.delete(key);
    this.dirty.delete(key);
    if (this.quirks.keepIndexOnDrop === true) return;
    this.unindex(key, view.capture);
    this.expiries.delete(key);
    this.starts.delete(key);
    removeFrom(this.byProgram, view.name, key);
  }
}

function finite(now: number): void {
  if (typeof now !== "number" || !Number.isFinite(now))
    throw new StoreError("invalid-request", "views: now must be a finite number");
}
