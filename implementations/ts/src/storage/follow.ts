// Following the change feed (SPEC-18 proposal §4.6, "Following the feed"). A follower takes the
// position of a snapshot, fills a full mirror of the peer (from that snapshot, or from an export
// taken after it), and then pulls the records after the position, one page per pull, with the
// bytes of every added id the peer still holds. It never hands out the bytes of a purged delta
// (plan decision O6).
//
// A follower that applies each ok pull in order (for each record: delete its `removed`, then set
// each of its `added` to the delivered delta, or delete it when none was delivered) holds exactly
// the peer's holdings, with their arrival records, whenever its cursor stands at the peer's
// current revision. A follower that keeps only a scope uses `checkFresh` instead.

import { compareUtf8 } from "../delta/cbor.js";
import { LOCAL_HISTORY_PREFIX, answeredOnly, checkedThrough, onSnapshots } from "./freshness.js";
import {
  StoreError,
  StoreFaultError,
  type ChangeRecord,
  type History,
  type PeerStore,
  type Revision,
  type Snapshot,
  type VerifiedDelta,
} from "./store.js";

/**
 * Where a follower stands in one peer's feed: a revision, and the history it belongs to. A
 * follower saves this between runs. A position saved across a process needs a history from
 * `mintHistory`; `parsePosition` refuses one that is local to a process.
 */
export type Position = { readonly history: History; readonly revision: Revision };

export type Pull =
  /**
   * The records after the cursor's position, one page, and the bytes of every id they add that
   * the peer still holds. `position` is where the cursor now stands: the page's `through`.
   */
  | {
      readonly status: "ok";
      readonly position: Position;
      readonly records: readonly ChangeRecord[];
      /** Ascending by id, each id once, each with this peer's arrival record. */
      readonly deltas: readonly VerifiedDelta[];
    }
  /**
   * The cursor cannot go on: the peer has another history, the feed no longer keeps the records
   * after the position, or the position is past the peer's revision. Read the state again, then
   * follow from that read. `current` is the position of the snapshot the pull read.
   */
  | { readonly status: "resync-required"; readonly current: Position };

/** A pull cursor over one peer's change feed. */
export interface FeedCursor {
  /** Where the cursor stands. Only an ok pull moves it. */
  readonly position: Position;
  /**
   * One snapshot, at most one page of the feed, and one `get` and one `arrivals` call for the
   * page's added ids. Pulls on one cursor run one at a time, in call order. After
   * `resync-required`, every later pull answers the same, with no store call. On
   * `snapshot-moved`, also under `read()` itself, it starts again on a new snapshot, at most four
   * in all.
   *
   * Throws `StoreFaultError` when the store breaks its contract, before anything the store
   * answered is used: a page with no progress (`no-progress`), a page past the snapshot's
   * revision (`past-the-bound`), a `get` or `arrivals` that answers an id it was not asked for,
   * twice, or out of order (`unasked-ids`), and a `get` and `arrivals` that name other ids
   * (`mismatched-answers`). A pull that throws does not move the cursor; it stays usable.
   */
  pull(): Promise<Pull>;
}

/** The position of a snapshot: where a follower that read its state on it starts. */
export function positionOf(snapshot: Snapshot): Position {
  return Object.freeze({ history: snapshot.history, revision: snapshot.revision });
}

function checked(value: unknown, refuseLocal: boolean): Position {
  const refuse = (why: string): never => {
    throw new StoreError("invalid-request", `position: ${why}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return refuse("not an object");
  const { history, revision } = value as { history?: unknown; revision?: unknown };
  if (typeof history !== "string" || history === "") refuse("history is not a non-empty string");
  if (refuseLocal && (history as string).startsWith(LOCAL_HISTORY_PREFIX))
    refuse(
      `history ${String(history)} is local to the process that made it; a position that crosses a process needs histories from mintHistory`,
    );
  if (!Number.isSafeInteger(revision) || (revision as number) < 0)
    refuse("revision is not an integer from 0 to 2^53 - 1");
  return Object.freeze({ history: history as string, revision: revision as number });
}

/**
 * A position that was stored and read back, checked. Refuses `invalid-request` unless `value`
 * has exactly the keys `history` and `revision`, a non-empty history that is not local to a
 * process, and an integer revision from 0 to 2^53 − 1. It checks shape, not truth.
 */
export function parsePosition(value: unknown): Position {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value).sort().join(",");
    if (keys !== "history,revision")
      throw new StoreError(
        "invalid-request",
        `position: the keys are ${keys}, not history, revision`,
      );
  }
  return checked(value, true);
}

/**
 * A cursor over `peer`'s feed, standing at `from`. Makes no store call. Refuses
 * `invalid-request` for a position with an empty history or a revision that is not an integer
 * from 0 to 2^53 − 1. Start from the position of the snapshot on which the caller read its state
 * (`positionOf`): there is no mode that starts from the beginning of the feed.
 */
export function followFeed(peer: PeerStore, from: Position): FeedCursor {
  return new Cursor(peer, checked(from, false));
}

class Cursor implements FeedCursor {
  private at: Position;
  private stopped: Pull | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly peer: PeerStore,
    from: Position,
  ) {
    this.at = from;
  }

  get position(): Position {
    return this.at;
  }

  pull(): Promise<Pull> {
    const next = this.queue.then(() => this.pullNow());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async pullNow(): Promise<Pull> {
    // The position no longer names a revision of this peer's feed. Asking the store again cannot
    // help, and a later answer could be read in another history: the caller reads again first.
    if (this.stopped !== undefined) return this.stopped;
    const pull = await onSnapshots(this.peer, (snapshot) => this.pullOn(snapshot));
    if (pull.status === "ok") this.at = pull.position;
    else this.stopped = pull;
    return pull;
  }

  private async pullOn(snapshot: Snapshot): Promise<Pull> {
    const current = positionOf(snapshot);
    const at = this.at.revision;
    const end = snapshot.revision;
    // Another history: its revisions cannot be compared with the position's at all. A position
    // past the snapshot: the store was rolled back, or the position is another peer's.
    if (snapshot.history !== this.at.history || end < at)
      return Object.freeze({ status: "resync-required", current });
    if (end === at)
      return Object.freeze({ status: "ok", position: this.at, records: [], deltas: [] });
    const page = await this.peer.changes(at, end);
    if (page.status === "resync-required")
      return Object.freeze({ status: "resync-required", current });
    // A store fault, not an answer: such a page cannot say where the cursor stands.
    checkedThrough("pull", at, end, page.through);
    const ids = [...new Set(page.records.flatMap((record) => record.added))].sort(compareUtf8);
    const deltas: VerifiedDelta[] = [];
    if (ids.length > 0) {
      const held = await snapshot.get(ids);
      const arrivals = await snapshot.arrivals(ids);
      // Bytes the call did not ask for are never handed out: they may be a purged delta's.
      const got = held.map((d) => d.id);
      const dated = arrivals.map((a) => a.id);
      answeredOnly("pull", "get", ids, got);
      answeredOnly("pull", "arrivals", ids, dated);
      if (got.length !== dated.length || got.some((id, i) => id !== dated[i]))
        throw new StoreFaultError(
          "mismatched-answers",
          { get: got, arrivals: dated },
          "pull: the store's get and arrivals name other ids on one snapshot",
        );
      held.forEach((delta, i) => deltas.push({ delta, arrival: arrivals[i]! }));
    }
    return Object.freeze({
      status: "ok",
      position: Object.freeze({ history: this.at.history, revision: page.through }),
      records: page.records,
      deltas: Object.freeze(deltas),
    });
  }
}
