// Several reads at one revision (SPEC-18 proposal §4.13, readings 127 to 129). A snapshot holds
// no engine transaction (decision S4-2), so a write between two calls moves it, and each later
// call refuses `snapshot-moved`. `withSnapshot` runs the reads again on a new snapshot. It is a
// reader over the store contract: a store implements nothing for it.

import { isPlainObject, ownFields } from "./copy.js";
import {
  StoreError,
  StoreFaultError,
  type PeerStore,
  type Revision,
  type Snapshot,
} from "./store.js";

/** How many times a read starts again on a new snapshot after `snapshot-moved`, by default. */
export const SNAPSHOT_RETRIES = 3;

/** The most snapshots one call of `withSnapshot` may take. */
const MOST_SNAPSHOTS = 16;

/** How far `withSnapshot` tries. A field that only a prototype holds reads as absent. */
export type SnapshotRetry = {
  /** Snapshots in all, a refused `read()` included: an integer from 1 to 16. Default 4. */
  readonly snapshots?: number;
  /**
   * No snapshot after the first starts once this many ms of `clock` have passed since the call
   * began: an integer of 0 or more. The first snapshot always starts, and a running body is never
   * stopped. It needs `clock`. Default: no bound in time.
   */
  readonly withinMs?: number;
  /**
   * The host's clock in ms, such as `() => performance.now()`, read only for `withinMs`. The
   * package reads no clock of its own.
   */
  readonly clock?: () => number;
};

/** What `withSnapshot` answers: the body's value, and how many snapshots it took. */
export type OnSnapshot<T> = {
  readonly value: T;
  /** Snapshots taken, a `read()` that the peer refused included. 1 when the first held still. */
  readonly attempts: number;
};

/**
 * A snapshot's revision checked before anything uses it: an integer from 0 to 2^53 − 1, else the
 * store fault `revision-out-of-range`.
 */
export function revisionInRange(revision: Revision): void {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new StoreFaultError(
      "revision-out-of-range",
      { revision },
      `the store's snapshot stands at revision ${revision}, not an integer from 0 to 2^53 - 1`,
    );
}

const moved = (error: unknown): boolean =>
  error instanceof StoreError && error.code === "snapshot-moved";

type Within = { readonly ms: number; readonly clock: () => number };

/** The bound of one call. Its fields are own fields, so none reads from a prototype. */
function policy(retry: SnapshotRetry | undefined): {
  snapshots: number;
  within: Within | undefined;
} {
  if (retry === undefined) return { snapshots: SNAPSHOT_RETRIES + 1, within: undefined };
  if (!isPlainObject(retry))
    throw new StoreError("invalid-request", "withSnapshot: retry is a plain object");
  const { snapshots = SNAPSHOT_RETRIES + 1, withinMs, clock } = ownFields(retry);
  if (!Number.isInteger(snapshots) || snapshots < 1 || snapshots > MOST_SNAPSHOTS)
    throw new StoreError(
      "invalid-request",
      `withSnapshot: snapshots is an integer from 1 to ${MOST_SNAPSHOTS}`,
    );
  if (withinMs !== undefined && !(Number.isSafeInteger(withinMs) && withinMs >= 0))
    throw new StoreError("invalid-request", "withSnapshot: withinMs is an integer of 0 or more");
  if (clock !== undefined && typeof clock !== "function")
    throw new StoreError("invalid-request", "withSnapshot: clock is a function");
  if (withinMs !== undefined && clock === undefined)
    throw new StoreError(
      "invalid-request",
      "withSnapshot: withinMs needs clock, the host's clock in ms, such as () => performance.now()",
    );
  return {
    snapshots,
    within: withinMs === undefined ? undefined : { ms: withinMs, clock: clock! },
  };
}

/** One reading of the host's clock. A reading that is not a finite number is refused. */
function reading(clock: () => number): number {
  const at = clock();
  if (typeof at !== "number" || !Number.isFinite(at))
    throw new StoreError("invalid-request", "withSnapshot: clock answered no finite number");
  return at;
}

/**
 * Runs `body` on one snapshot of `peer`, and releases the snapshot on every path. The snapshot's
 * revision is checked first (`revision-out-of-range`). On `snapshot-moved`, from `read()` itself
 * or from `body`, it runs `body` again on a new snapshot, within `retry`; past the bound the last
 * `snapshot-moved` passes up. Any other error passes up at once, unchanged: `store-unavailable`
 * too, because the engine has already waited. A `snapshot-moved` of another peer's snapshot that
 * `body` reads starts it again too.
 *
 * `body` reads only, through the snapshot it is given. It keeps nothing from an earlier attempt,
 * and its side effects go after this returns: it can run up to `retry.snapshots` times. An append
 * or a purge of the same peer inside it moves its own snapshot. It must not keep the snapshot:
 * after each attempt that snapshot refuses `snapshot-released`.
 */
export async function withSnapshot<T>(
  peer: PeerStore,
  body: (snapshot: Snapshot, attempt: number) => T | Promise<T>,
  retry?: SnapshotRetry,
): Promise<OnSnapshot<T>> {
  const { snapshots, within } = policy(retry);
  if (typeof body !== "function")
    throw new StoreError("invalid-request", "withSnapshot: body is a function");
  const started = within === undefined ? 0 : reading(within.clock);
  const again = (attempts: number): boolean =>
    attempts < snapshots && (within === undefined || reading(within.clock) - started < within.ms);
  for (let attempts = 1; ; attempts += 1) {
    let snapshot: Snapshot;
    try {
      snapshot = await peer.read();
    } catch (error) {
      if (moved(error) && again(attempts)) continue;
      throw error;
    }
    try {
      revisionInRange(snapshot.revision);
      return { value: await body(snapshot, attempts), attempts };
    } catch (error) {
      if (!moved(error) || !again(attempts)) throw error;
    } finally {
      snapshot.release();
    }
  }
}
