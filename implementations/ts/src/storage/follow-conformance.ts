// The follow conformance runner (SPEC-18 proposal §4.6, "Following the feed"). It runs
// `vectors/store/follow.json` against a store and a witness's follower: `positionOf` and the
// cursor. `vectors/store/README.md` §10 is the normative text; this file follows it and must not
// accept anything the text does not.

import { compareUtf8 } from "../delta/cbor.js";
import { computeId } from "../delta/delta.js";
import type { FeedCursor, Position, Pull } from "./follow.js";
import {
  Run,
  StoreConformanceError,
  caseStore,
  missing,
  type StoreConformanceFailure,
} from "./store-conformance.js";
import {
  STORE_FOLLOW_FORMAT,
  type FollowStep,
  type PullStep,
  type StoreFollowDocument,
} from "./store-vector-format.js";
import {
  StoreError,
  StoreFaultError,
  type ChangePage,
  type ChangeRecord,
  type ChangeRetention,
  type Id,
  type PeerStore,
  type Snapshot,
  type Store,
  type VerifiedDelta,
} from "./store.js";

/** What a witness offers for following the feed. TypeScript: `positionOf` and `followFeed`. */
export interface FeedFollower {
  positionOf(snapshot: Snapshot): Position;
  follow(peer: PeerStore, from: Position): FeedCursor;
}

/** What a case asks of the store it runs on. Absent fields: as the run builds it. */
export type FollowStoreRequest = {
  readonly changeRetention?: Exclude<ChangeRetention, "none">;
  readonly changePageSize?: number;
};

export type FollowConformanceReport = {
  readonly passed: readonly string[];
  /** Cases that did not run: the profile lacks a requirement, or the factory cannot build the store. */
  readonly skipped: readonly { readonly name: string; readonly missing: string }[];
};

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const show = (ids: readonly string[]): string => `[${ids.map((id) => id.slice(0, 12)).join(" ")}]`;
const revisions = (list: readonly number[]): string => `[${list.join(" ")}]`;
const recordText = (r: ChangeRecord): string =>
  JSON.stringify([r.revision, r.head, r.added, r.removed]);

/** One store call a pull made, as the runner saw it. */
type Call =
  | { readonly op: "read"; readonly revision: number; readonly history: string }
  | {
      readonly op: "changes";
      readonly from: number;
      readonly to: number | undefined;
      readonly page: ChangePage | undefined;
    }
  | { readonly op: "get" | "arrivals"; readonly ids: readonly Id[] }
  | { readonly op: string };

function callText(call: Call): string {
  if ("revision" in call) return "read";
  if ("from" in call) return `changes(${call.from}, ${call.to ?? "none"})`;
  if ("ids" in call) return `${call.op} ${show(call.ids)}`;
  return call.op;
}

const copyPage = (page: ChangePage): ChangePage =>
  page.status === "ok"
    ? {
        status: "ok",
        through: page.through,
        records: page.records.map((r) => ({ ...r, added: [...r.added], removed: [...r.removed] })),
      }
    : { status: page.status, current: page.current };

/** Where the calls of one pull go. The runner gives each pull a new log. */
type Sink = { log: Call[] };

/** A peer handle that writes every call made through it, and through its snapshots, to the sink. */
function logged(peer: PeerStore, sink: Sink): PeerStore {
  const note = (op: string) => sink.log.push({ op });
  const snapshotOf = (snapshot: Snapshot): Snapshot => ({
    revision: snapshot.revision,
    history: snapshot.history,
    head: snapshot.head,
    count: snapshot.count,
    get: (ids) => (sink.log.push({ op: "get", ids: [...ids] }), snapshot.get(ids)),
    arrivals: (ids) => (sink.log.push({ op: "arrivals", ids: [...ids] }), snapshot.arrivals(ids)),
    targets: (entities) => (note("targets"), snapshot.targets(entities)),
    negators: (ids) => (note("negators"), snapshot.negators(ids)),
    scope: (request) => (note("scope"), snapshot.scope(request)),
    release: () => (note("release"), snapshot.release()),
  });
  return {
    id: peer.id,
    history: peer.history,
    erasure: peer.erasure,
    read: async () => {
      // Written when the call is made, so a call no one awaits is seen too.
      const call = { op: "read", revision: -1, history: "" };
      sink.log.push(call);
      const snapshot = await peer.read();
      call.revision = snapshot.revision;
      call.history = snapshot.history;
      return snapshotOf(snapshot);
    },
    append: (batch) => (note("append"), peer.append(batch)),
    purge: (ids) => (note("purge"), peer.purge(ids)),
    changes: async (from, to) => {
      const call: { op: "changes"; from: number; to: number | undefined; page?: ChangePage } = {
        op: "changes",
        from,
        to,
      };
      sink.log.push(call as Call);
      const page = await peer.changes(from, to);
      call.page = copyPage(page);
      return page;
    },
  };
}

/**
 * README §10.3, "The calls", for one pull from `at`: none at all after the cursor answered
 * `resync-required`; otherwise one `read`, then, when the snapshot's history is the position's and
 * its revision r′ is above `at`, `changes(at, r′)`, and when that page is ok and adds ids, `get`
 * and then `arrivals` of those ids; then the release of the snapshot, and nothing else.
 */
function checkCalls(log: readonly Call[], from: Position, stopped: boolean): void {
  let i = 0;
  const next = (want: string): Call => {
    const call = log[i++];
    check(call !== undefined, `pull made no call where the contract asks for ${want}`);
    check(
      callText(call) === want,
      `pull made the call ${callText(call)} where the contract asks for ${want}`,
    );
    return call;
  };
  if (!stopped) {
    const read = next("read") as { revision: number; history: string };
    if (read.history === from.history && read.revision > from.revision) {
      const { page } = next(`changes(${from.revision}, ${read.revision})`) as {
        page: ChangePage | undefined;
      };
      if (page !== undefined && page.status === "ok") {
        const ids = [...new Set(page.records.flatMap((r) => r.added))].sort(compareUtf8);
        if (ids.length > 0) {
          next(`get ${show(ids)}`);
          next(`arrivals ${show(ids)}`);
        }
      }
    }
    next("release");
  }
  const extra = log[i];
  check(
    extra === undefined,
    `pull made the call ${extra === undefined ? "" : callText(extra)} after its last call`,
  );
}

type Follower = {
  readonly owner: string;
  readonly handle: string;
  readonly cursor: FeedCursor;
  readonly sink: Sink;
  /** The runner's mirror: what the follower's answers say the peer holds. */
  readonly mirror: Map<Id, VerifiedDelta>;
  /** The `current` revision of the first `resync-required` the cursor answered. */
  stopped: number | undefined;
};

/** One case of `cases` (README §10.1): steps, followers and pulls on one new store. */
class FollowRun {
  private readonly followers = new Map<string, Follower>();

  constructor(
    private readonly run: Run,
    private readonly witness: FeedFollower,
  ) {}

  async follow(step: FollowStep): Promise<void> {
    check(!this.followers.has(step.as), `the vector names follower ${step.as} twice`);
    const owner = this.run.ownerOf(step.peer);
    const handle = this.run.peer(step.peer);
    const snapshot = await handle.read();
    let position: Position;
    try {
      position = this.witness.positionOf(snapshot);
    } finally {
      snapshot.release();
    }
    check(position.history === snapshot.history, "the position's history is not its snapshot's");
    const revision = this.run.resolve({ revision: step.expect.revision }, step.peer);
    check(
      position.revision === revision && revision === snapshot.revision,
      `the position is of revision ${position.revision}, expected ${revision}`,
    );
    const ahead: unknown = step.ahead ?? 0;
    check(
      Number.isSafeInteger(ahead) && (ahead as number) >= 0,
      "the vector's ahead is not a whole number",
    );
    const from: Position = {
      history:
        step.historyOf === undefined ? position.history : this.run.peer(step.historyOf).history,
      revision: position.revision + (ahead as number),
    };
    const sink: Sink = { log: [] };
    let cursor: FeedCursor;
    try {
      cursor = this.witness.follow(logged(handle, sink), from);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      throw new Error(`follow refused with ${error.code}: ${error.message}`);
    }
    check(
      cursor.position.history === from.history && cursor.position.revision === from.revision,
      `a new cursor stands at ${cursor.position.revision}, not at the position it was given`,
    );
    check(
      sink.log.length === 0,
      `following made the call ${callText(sink.log[0] ?? { op: "" })}; it makes no store call`,
    );
    this.followers.set(step.as, {
      owner,
      handle: step.peer,
      cursor,
      sink,
      mirror: new Map(this.run.holdings.get(owner)!),
      stopped: undefined,
    });
  }

  async pull(step: PullStep): Promise<void> {
    const f = this.followers.get(step.follower);
    check(f !== undefined, `the vector uses follower ${step.follower} before following`);
    const model = this.run.model(f.owner);
    check(model !== undefined, "a pull step on a store that serves no feed");
    const history = this.run.peer(f.handle).history;
    const { expect } = step;
    // The `current` a resync-required answer must carry, or undefined when ok is expected.
    let resync: number | undefined;
    let belowFloor = false;
    if (f.stopped !== undefined) {
      // Every pull after resync-required answers the same, whatever the document says: a store
      // that keeps fewer records than the document's may have stopped this cursor earlier.
      resync = f.stopped;
    } else if (expect.status === "resync-required") {
      resync = this.run.resolve({ revision: expect.current }, f.handle);
      check(
        resync === model.current,
        `the vector expects current ${expect.current}, and the peer is at ${model.current}`,
      );
    } else {
      // A step that pulls once stands where its one page ends; any other step at the peer.
      if (step.once !== true)
        check(
          this.run.resolve({ revision: expect.position }, f.handle) === model.current,
          `the vector pulls to ${expect.position}, and the peer is at ${model.current}`,
        );
      // A store that keeps fewer records than the document's answers resync-required below its
      // floor, whatever the document says about a feed that keeps every record.
      const at = f.cursor.position;
      if (at.history === history && at.revision < model.floor) {
        resync = model.current;
        belowFloor = true;
      }
    }

    const read: number[] = [];
    const delivered = new Set<Id>();
    const bound = model.records.filter((r) => r.revision > f.cursor.position.revision).length + 1;
    let pulls = 0;
    for (;;) {
      check(pulls < bound, `the follower took more than ${bound} pulls to reach ${model.current}`);
      pulls += 1;
      const before = f.cursor.position;
      f.sink.log = [];
      let pull: Pull;
      try {
        pull = await f.cursor.pull();
      } catch (error) {
        if (error instanceof StoreFaultError)
          throw new Error(`the store broke ${error.rule}: ${error.message}`);
        if (!(error instanceof StoreError)) throw error;
        throw new Error(`pull refused with ${error.code}: ${error.message}`);
      }
      const want = resync === undefined ? "ok" : "resync-required";
      check(
        pull.status === want,
        belowFloor
          ? `pull answered ${pull.status} for a position below the retention floor ${model.floor}`
          : `pull answered ${pull.status}, expected ${want}`,
      );
      if (pull.status === "resync-required") {
        check(
          pull.current.history === history && pull.current.revision === resync,
          `pull reports resync-required with current ${pull.current.revision}, expected ${resync}`,
        );
        check(
          f.cursor.position.history === before.history &&
            f.cursor.position.revision === before.revision,
          `the cursor moved after resync-required`,
        );
        checkCalls(f.sink.log, before, f.stopped !== undefined);
        f.stopped = resync;
        return;
      }
      this.judge(f, pull, before, model);
      checkCalls(f.sink.log, before, false);
      read.push(...pull.records.map((r) => r.revision));
      for (const { delta } of pull.deltas) delivered.add(delta.id);
      this.apply(f, pull);
      if (step.once === true || pull.position.revision === model.current) break;
    }

    if (expect.status !== "ok") return;
    const stands = f.cursor.position.revision;
    if (step.once === true) {
      const want = this.run.resolve({ revision: expect.position }, f.handle);
      check(stands === want, `the pull stands at ${stands}, expected ${want}`);
    }
    const records = expect.records.map((name) => this.run.resolve({ revision: name }, f.handle));
    check(
      revisions(read) === revisions(records),
      `the pulls read the records at ${revisions(read)}, expected ${revisions(records)}`,
    );
    const names = this.run.ids(expect.delivered);
    const got = [...delivered].sort(compareUtf8);
    check(
      show(got) === show(names) && got.length === names.length,
      `the pulls delivered ${show(got)}, expected ${show(names)}`,
    );
    if (expect.pulls !== undefined)
      check(pulls === expect.pulls, `the follower took ${pulls} pulls, expected ${expect.pulls}`);
    if (stands === model.current) this.quiet(f);
    else this.settled(f, model, stands);
  }

  /**
   * Between quiet points (SPEC-18 §4.6): after a pull to p, the mirror equals the holdings at p
   * for every id that no record after p names. The runner commits nothing during a pull, so the
   * holdings at p of such an id are its holdings now.
   */
  private settled(f: Follower, model: NonNullable<ReturnType<Run["model"]>>, p: number): void {
    const later = new Set(
      model.records.filter((r) => r.revision > p).flatMap((r) => [...r.added, ...r.removed]),
    );
    const held = this.run.holdings.get(f.owner)!;
    for (const id of new Set([...f.mirror.keys(), ...held.keys()])) {
      if (later.has(id)) continue;
      const a = f.mirror.get(id)?.arrival;
      const b = held.get(id)?.arrival;
      check(
        a === undefined
          ? b === undefined
          : b !== undefined &&
              a.at === b.at &&
              a.sequence === b.sequence &&
              a.transfer === b.transfer &&
              a.sender === b.sender,
        `after the pull to ${p} the follower's mirror differs from the holdings at ${id.slice(0, 12)}`,
      );
    }
  }

  /** README §10.3, checks 4 to 10: one ok pull against the runner's model and bookkeeping. */
  private judge(
    f: Follower,
    pull: Extract<Pull, { status: "ok" }>,
    before: Position,
    model: NonNullable<ReturnType<Run["model"]>>,
  ): void {
    const at = before.revision;
    const end = model.current;
    const p = pull.position.revision;
    check(pull.position.history === before.history, "the pull moved the cursor to another history");
    check(p >= at && p <= end, `the pull's position ${p} lies outside [${at}, ${end}]`);
    check(p > at || at === end, `the pull from ${at} made no progress toward ${end}`);
    const expected = model.records.filter((r) => r.revision > at && r.revision <= p);
    const got = pull.records.map((r) => r.revision);
    check(
      revisions(got) === revisions(expected.map((r) => r.revision)),
      `the pull's records are at ${revisions(got)}, expected ${revisions(expected.map((r) => r.revision))}`,
    );
    pull.records.forEach((record, i) =>
      check(
        recordText(record) === recordText(expected[i]!),
        `the pull's record at revision ${record.revision} differs from its commit`,
      ),
    );
    const ids = pull.deltas.map((d) => d.delta.id);
    check(
      ids.every((id, i) => i === 0 || compareUtf8(ids[i - 1]!, id) < 0),
      "the pull's deltas are not ascending by id and distinct",
    );
    const held = this.run.holdings.get(f.owner)!;
    const added = [...new Set(expected.flatMap((r) => r.added))].filter((id) => held.has(id));
    added.sort(compareUtf8);
    check(
      show(ids) === show(added) && ids.length === added.length,
      `the pull delivered ${show(ids)}, expected ${show(added)}`,
    );
    for (const { delta, arrival } of pull.deltas) {
      const entry = held.get(delta.id)!;
      check(
        delta.sig === entry.delta.sig && computeId(delta.claims) === delta.id,
        `the pull delivered ${delta.id.slice(0, 12)} as another appearance`,
      );
      check(
        arrival.id === delta.id &&
          arrival.at === entry.arrival.at &&
          arrival.sequence === entry.arrival.sequence &&
          arrival.transfer === entry.arrival.transfer &&
          arrival.sender === entry.arrival.sender,
        `the pull delivered ${delta.id.slice(0, 12)} with another arrival record`,
      );
    }
    check(
      f.cursor.position.history === pull.position.history && f.cursor.position.revision === p,
      `the cursor stands at ${f.cursor.position.revision}, not at the pull's position ${p}`,
    );
  }

  /**
   * The follower's rule (SPEC-18 §4.6): for each record in order, delete its `removed`, then set
   * each of its `added` to the delivered delta, or delete it when none was delivered.
   */
  private apply(f: Follower, pull: Extract<Pull, { status: "ok" }>): void {
    const delivered = new Map(pull.deltas.map((d) => [d.delta.id, d]));
    for (const record of pull.records) {
      for (const id of record.removed) f.mirror.delete(id);
      for (const id of record.added) {
        const delta = delivered.get(id);
        if (delta !== undefined) f.mirror.set(id, delta);
        else f.mirror.delete(id);
      }
    }
  }

  /** The guarantee: at the peer's revision, the mirror is the peer's holdings, arrivals and all. */
  private quiet(f: Follower): void {
    const held = this.run.holdings.get(f.owner)!;
    const mine = [...f.mirror.keys()].sort(compareUtf8);
    const theirs = [...held.keys()].sort(compareUtf8);
    check(
      show(mine) === show(theirs) && mine.length === theirs.length,
      `the follower's mirror holds ${show(mine)}, and the peer holds ${show(theirs)}`,
    );
    for (const id of mine) {
      const a = f.mirror.get(id)!.arrival;
      const b = held.get(id)!.arrival;
      check(
        a.at === b.at &&
          a.sequence === b.sequence &&
          a.transfer === b.transfer &&
          a.sender === b.sender,
        `the follower's mirror holds ${id.slice(0, 12)} with another arrival record`,
      );
    }
  }
}

/**
 * Runs `follow.json` against the stores `factory` makes and a witness's follower. Each case gets
 * a new store, built with the case's checked `store` fields; `factory` answers undefined when it
 * cannot build such a store, which skips the case with the requirement `store`. Any other
 * failure of the factory fails the case. Throws `StoreConformanceError`, listing every failure,
 * when anything fails; a document of another format is one failure, named `follow`.
 */
export async function runFollowConformance(
  factory: (request: FollowStoreRequest) => Promise<Store | undefined>,
  witness: FeedFollower,
  vectors: StoreFollowDocument,
): Promise<FollowConformanceReport> {
  if (vectors.format !== STORE_FOLLOW_FORMAT)
    throw new StoreConformanceError([{ name: "follow", message: "unknown store follow format" }]);
  const passed: string[] = [];
  const skipped: { name: string; missing: string }[] = [];
  const failures: StoreConformanceFailure[] = [];
  const text = (error: unknown): string =>
    error instanceof StoreError
      ? `refused with ${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);

  for (const c of vectors.cases) {
    const name = `follow/${c.name}`;
    let store: Store | undefined;
    try {
      const request = caseStore(c.store, ["changeRetention", "changePageSize"]);
      try {
        store = await factory(request);
      } catch (error) {
        throw new Error(`the factory did not open a store: ${text(error)}`);
      }
    } catch (error) {
      failures.push({ name, message: text(error) });
      continue;
    }
    if (store === undefined) {
      skipped.push({ name, missing: "store" });
      continue;
    }
    try {
      const lacks = missing(store, c.requires);
      if (lacks !== undefined) {
        skipped.push({ name, missing: lacks });
        continue;
      }
      const run = new Run(store, vectors);
      const follow = new FollowRun(run, witness);
      for (const [i, step] of c.steps.entries()) {
        try {
          if (step.op === "follow") await follow.follow(step);
          else if (step.op === "pull") await follow.pull(step);
          else await run.step(step);
          await run.checkFeeds();
        } catch (error) {
          throw new Error(`step ${i} (${step.op}): ${text(error)}`);
        }
      }
      passed.push(name);
    } catch (error) {
      failures.push({ name, message: text(error) });
    } finally {
      await store.close();
    }
  }

  if (failures.length > 0) throw new StoreConformanceError(failures);
  return { passed, skipped };
}
