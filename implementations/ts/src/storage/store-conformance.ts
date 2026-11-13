// The store conformance runner (SPEC-18 proposal §8). It runs the shared store vectors against
// any implementation of the store interface. `vectors/store/README.md` specifies the documents;
// this file follows that text and must not accept anything the text does not.

import { compareUtf8 } from "../delta/cbor.js";
import { computeId } from "../delta/delta.js";
import { parseClaims } from "../delta/json-profile.js";
import type { Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import {
  PURGE_BOUNDARY,
  StoreError,
  type AppliedPushdown,
  type ChangePage,
  type ChangeRecord,
  type PeerStore,
  type Pushdown,
  type Snapshot,
  type Store,
  type VerifiedDelta,
} from "./store.js";
import {
  PUSHDOWN_FIELDS,
  STORE_SCOPE_FORMAT,
  STORE_SCRIPTS_FORMAT,
  passesSelection,
  scopeOver,
  type PushdownField,
  type RevisionRef,
  type StoreScopeCase,
  type StoreVectorStep,
  type StoreVectors,
  type VectorHeader,
  type VectorPushdown,
  type VectorRefusal,
  type VectorRequirement,
} from "./store-vector-format.js";
import { storeVectors } from "./store-vectors.js";

export type StoreConformanceFailure = { readonly name: string; readonly message: string };
export type StoreConformanceReport = {
  /** Scripts and scope cases that ran and passed. */
  readonly passed: readonly string[];
  /** Scripts that did not run because the store's profile lacks what they need. */
  readonly skipped: readonly { readonly name: string; readonly missing: VectorRequirement }[];
};

export class StoreConformanceError extends Error {
  readonly failures: readonly StoreConformanceFailure[];
  constructor(failures: readonly StoreConformanceFailure[]) {
    super(
      `store conformance: ${failures.length} failed\n` +
        failures.map((f) => `  ${f.name}: ${f.message}`).join("\n"),
    );
    this.name = "StoreConformanceError";
    this.failures = failures;
  }
}

const key = (fields: readonly PushdownField[]): string =>
  PUSHDOWN_FIELDS.filter((f) => fields.includes(f)).join(",");
const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const show = (ids: readonly string[]): string => `[${ids.map((id) => id.slice(0, 12)).join(" ")}]`;

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const codes = (refusal: VectorRefusal): readonly string[] =>
  typeof refusal === "string" ? [refusal] : refusal;

/** The outcome must be a refusal with one of the codes the vector lists. */
function refused(outcome: { value: unknown } | { error: string }, refusal: VectorRefusal): void {
  const allowed = codes(refusal);
  check("error" in outcome, `expected a refusal: ${allowed.join(" or ")}`);
  check(
    allowed.includes(outcome.error),
    `refused with ${outcome.error}, expected ${allowed.join(" or ")}`,
  );
}

/** Runs `action`; returns the store error code it refused with, or its value. */
async function attempt<T>(action: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await action() };
  } catch (error) {
    if (error instanceof StoreError) return { error: error.code };
    throw error;
  }
}

/**
 * What the runner expects of one peer's change feed (README §3.9), kept from the steps alone.
 * `revisions` holds the revision at creation and then the revision after each advance, so
 * `revisions[i + 1]` is `records[i].revision`.
 */
type Feed = {
  readonly revisions: number[];
  readonly records: ChangeRecord[];
  head: string | null;
  /** Every id this peer has held at some time. Its feed may name no other id. */
  readonly everHeld: Set<string>;
  /** Each record as the store first answered it, to see a record change after it is written. */
  readonly seen: Map<number, string>;
};

/** The exact keys of each answer of `changes` (README §3.9.1), sorted. */
const PAGE_KEYS = {
  record: ["added", "head", "removed", "revision"],
  ok: ["records", "status", "through"],
  resync: ["current", "status"],
} as const;

function exactKeys(value: unknown, keys: readonly string[], what: string): void {
  check(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `a ${what} is not an object`,
  );
  const own = Object.keys(value).sort();
  check(same(own, keys), `a ${what} has the keys ${own.join(", ")}, not ${keys.join(", ")}`);
}

/**
 * An answer of `changes` has exactly the keys of its status, and each record exactly its four.
 * A store that adds a field (bytes, say) to a record or a page fails. An answer of another
 * status is left to the caller's own check.
 */
function shaped(page: unknown): void {
  const status =
    typeof page === "object" && page !== null ? (page as { status?: unknown }).status : undefined;
  if (status === "resync-required") exactKeys(page, PAGE_KEYS.resync, "resync answer");
  if (status !== "ok") return;
  exactKeys(page, PAGE_KEYS.ok, "change page");
  const records: unknown = (page as { records: unknown }).records;
  check(Array.isArray(records), "a change page's records is not a list");
  for (const record of records) exactKeys(record, PAGE_KEYS.record, "change record");
}

/**
 * Changes, as a careless caller might, everything an answer of `changes` returned: the record
 * list, each record and its id lists. A frozen value refuses quietly. A store that owns what it
 * answers is not moved by any of it.
 */
function tamper(records: ChangeRecord[]): void {
  const quietly = (change: () => void): void => {
    try {
      change();
    } catch {
      // A frozen value: nothing changed, which is the point.
    }
  };
  const first = records[0];
  if (first !== undefined) quietly(() => records.push({ ...first, head: "tampered" }));
  for (const record of records) {
    const writable = record as unknown as {
      head: string | null;
      added: string[];
      removed: string[];
    };
    quietly(() => (writable.head = "tampered"));
    quietly(() => writable.added.push("tampered"));
    quietly(() => writable.removed.push("tampered"));
  }
}

const recordText = (r: ChangeRecord): string =>
  JSON.stringify([r.revision, r.head, r.added, r.removed]);
const ascending = (ids: readonly string[]): boolean =>
  ids.every((id, i) => i === 0 || compareUtf8(ids[i - 1]!, id) < 0);

/**
 * One run of steps against one store, with the runner's bookkeeping and feed model. Not part of
 * the package surface: the freshness runner reuses it for its own documents.
 */
export class Run {
  private readonly corpus = new Map<string, Delta>();
  /** Peer handles by handle name, and the peer name each belongs to. */
  private readonly peers = new Map<string, PeerStore>();
  private readonly owners = new Map<string, string>();
  private readonly snapshots = new Map<string, { peer: string; snapshot: Snapshot }>();
  /** What each peer holds, with the arrival it was first admitted under. */
  readonly holdings = new Map<string, Map<string, VerifiedDelta>>();
  /** Each peer's expected feed, by peer name; empty when the store serves no feed. */
  private readonly feeds = new Map<string, Feed>();
  /** Revision names (`mark`, `revisionAs`), each with the peer it belongs to. */
  private readonly named = new Map<string, { peer: string; revision: number }>();
  readonly reference: boolean;

  constructor(
    readonly store: Store,
    private readonly header: VectorHeader,
  ) {
    for (const entry of header.deltas) {
      const claims = parseClaims(entry.claims);
      // A forged entry pairs claims with another delta's id on purpose; only the others must
      // recompute.
      if (entry.forged !== true)
        check(computeId(claims) === entry.id, `vector delta ${entry.name}: id does not recompute`);
      this.corpus.set(
        entry.name,
        entry.sig === undefined
          ? { id: entry.id, claims }
          : { id: entry.id, claims, sig: entry.sig },
      );
    }
    this.reference = store.profile.formatVersion === header.reference.formatVersion;
  }

  /**
   * How many records each peer keeps: infinite for `unbounded`, n for `{revisions: n}`, and
   * undefined when the store serves no feed. A profile with another value fails the script.
   */
  private keep(): number | undefined {
    const retention: unknown = this.store.profile.changeRetention;
    if (retention === "none") return undefined;
    if (retention === "unbounded") return Number.POSITIVE_INFINITY;
    const n: unknown =
      typeof retention === "object" && retention !== null
        ? (retention as { revisions?: unknown }).revisions
        : undefined;
    check(
      Number.isSafeInteger(n) && (n as number) >= 1,
      "the profile's changeRetention is not none, unbounded or {revisions: n}",
    );
    return n as number;
  }

  private feed(peer: string): Feed {
    return this.feeds.get(peer)!;
  }

  /** The revision just before the oldest record a peer keeps: a `from` below it is too old. */
  private floor(feed: Feed): { floor: number; index: number } {
    const kept = Math.min(feed.records.length, this.keep() ?? 0);
    const index = feed.records.length - kept;
    return { floor: feed.revisions[index]!, index };
  }

  private revisionOf(ref: RevisionRef, peer: string): number {
    const named = this.named.get(ref.revision);
    check(named !== undefined, `the vector names an unknown revision ${ref.revision}`);
    check(named.peer === peer, `the vector names revision ${ref.revision} of another peer`);
    const ahead: unknown = ref.ahead ?? 0;
    check(
      Number.isSafeInteger(ahead) && (ahead as number) >= 0,
      "the vector's ahead is not a whole number",
    );
    return named.revision + (ahead as number);
  }

  private name(as: string, peer: string, revision: number): void {
    check(!this.named.has(as), `the vector names revision ${as} twice`);
    this.named.set(as, { peer, revision });
  }

  /** The feed may name only ids its peer has held. */
  private ownIds(peer: string, records: readonly ChangeRecord[]): void {
    const held = this.feed(peer).everHeld;
    for (const record of records)
      for (const id of [...record.added, ...record.removed])
        check(
          held.has(id),
          `the feed of ${peer} names ${id.slice(0, 12)}, which ${peer} never held`,
        );
  }

  /**
   * After a step that committed, conflicted or was refused: the records after `before` are
   * exactly the one record of this step, or none when the revision did not advance. Reads raw
   * pages; the checks of every page are `pages`'s, after the step.
   */
  private async committed(peer: string, handle: PeerStore, before: number): Promise<void> {
    const feed = this.feed(peer);
    const current = feed.revisions[feed.revisions.length - 1]!;
    const records: ChangeRecord[] = [];
    for (let at = before; ; ) {
      const outcome = await attempt(() => handle.changes(at));
      check("value" in outcome, `changes refused with ${"error" in outcome ? outcome.error : ""}`);
      const page = outcome.value;
      shaped(page);
      check(page.status === "ok", "changes from the revision before a commit is not ok");
      records.push(...page.records);
      if (page.through <= at || page.through >= current) break;
      at = page.through;
    }
    this.ownIds(peer, records);
    check(
      records.every((r) => ascending(r.added) && ascending(r.removed)),
      "a record's ids are not ascending and distinct",
    );
    if (current === before) {
      check(records.length === 0, "a step that did not advance the revision wrote a record");
      return;
    }
    const expected = feed.records[feed.records.length - 1]!;
    const headOnly = expected.added.length === 0 && expected.removed.length === 0;
    check(
      records.length > 0,
      `the ${headOnly ? "head-only " : ""}commit to revision ${current} wrote no record`,
    );
    check(
      records.length === 1 && records[0]!.revision === current,
      `the commit to revision ${current} wrote records at ${records.map((r) => r.revision).join(", ")}`,
    );
    const record = records[0]!;
    check(
      record.head === expected.head,
      `the record of revision ${current} has head ${String(record.head)}, expected ${String(expected.head)}`,
    );
    check(
      same(record.added, expected.added),
      `the record of revision ${current} adds ${show(record.added)}, expected ${show(expected.added)}`,
    );
    check(
      same(record.removed, expected.removed),
      `the record of revision ${current} removes ${show(record.removed)}, expected ${show(expected.removed)}`,
    );
  }

  /**
   * The checks of one `ok` page from `at` (README §3.9.5, checks 4 to 13). */
  private page(
    peer: string,
    at: number,
    end: number,
    page: Extract<ChangePage, { status: "ok" }>,
  ): void {
    const feed = this.feed(peer);
    const records = page.records;
    this.ownIds(peer, records);
    check(
      records.every((r, i) => i === 0 || records[i - 1]!.revision < r.revision),
      "the page's records are not ascending by revision",
    );
    check(
      records.every((r) => r.revision > at && r.revision <= end),
      `a record lies outside the range (${at}, ${end}]`,
    );
    check(
      records.every((r) => ascending(r.added) && ascending(r.removed)),
      "a record's ids are not ascending and distinct",
    );
    const last = records.length > 0 ? records[records.length - 1]!.revision : at;
    const returned = new Set(records.map((r) => r.revision));
    check(
      page.through >= last && page.through <= end,
      `the page's through ${page.through} lies outside [${last}, ${end}]`,
    );
    // Every record the peer ever wrote, dropped ones included.
    for (const expected of feed.records)
      if (expected.revision > at && expected.revision <= last)
        check(
          returned.has(expected.revision),
          `the feed has no record for revision ${expected.revision}`,
        );
    for (const expected of feed.records)
      if (expected.revision > last && expected.revision <= page.through)
        throw new Error(
          `the page claims through ${page.through} and leaves out the record at ${expected.revision}`,
        );
    check(page.through > at || at === end, `the page from ${at} made no progress toward ${end}`);
    check(
      page.through === last || page.through === end,
      `the page's through ${page.through} is past its last record and short of ${end}`,
    );
    const byRevision = new Map(feed.records.map((r) => [r.revision, r]));
    for (const record of records) {
      const text = recordText(record);
      const seen = feed.seen.get(record.revision);
      check(
        seen === undefined || seen === text,
        `the record at revision ${record.revision} changed after it was written`,
      );
      feed.seen.set(record.revision, text);
      const expected = byRevision.get(record.revision);
      check(
        expected !== undefined && recordText(expected) === text,
        `the record at revision ${record.revision} differs from its commit`,
      );
    }
  }

  /**
   * Every record in `(from, to]`, following pages, each page checked against the expected feed.
   * Answers `resync` when the first page says so.
   */
  private async pages(
    peer: string,
    handle: PeerStore,
    from: number,
    to: number | undefined,
  ): Promise<ChangeRecord[] | "resync"> {
    const feed = this.feed(peer);
    const current = feed.revisions[feed.revisions.length - 1]!;
    const end = Math.min(to ?? current, current);
    const out: ChangeRecord[] = [];
    for (let at = from; ; ) {
      const outcome = await attempt(() => handle.changes(at, to));
      check("value" in outcome, `changes refused with ${"error" in outcome ? outcome.error : ""}`);
      const page = outcome.value;
      shaped(page);
      if (page.status === "resync-required") {
        check(out.length === 0, "changes answered resync-required in the middle of a range");
        check(
          page.current === current,
          `a resync answer carries current ${page.current}, not the peer's revision ${current}`,
        );
        return "resync";
      }
      check(page.status === "ok", "changes answered neither ok nor resync-required");
      this.page(peer, at, end, page);
      const records = page.records;
      // Ownership (README §7, test 9): change what this answer returned and ask again. The
      // store may answer another prefix of the range (§4.6), but every record it shares a
      // revision with the first answer must be the record it answered then.
      const before = new Map(records.map((r) => [r.revision, recordText(r)]));
      out.push(...records.map((r) => ({ ...r, added: [...r.added], removed: [...r.removed] })));
      tamper(records as unknown as ChangeRecord[]);
      const again = await attempt(() => handle.changes(at, to));
      check("value" in again, `changes refused with ${"error" in again ? again.error : ""}`);
      shaped(again.value);
      const second = again.value;
      check(
        second.status === "ok" &&
          second.records.every((r) => {
            const first = before.get(r.revision);
            return first === undefined || first === recordText(r);
          }) &&
          new Set(second.records.map((r) => r.revision)).size === second.records.length,
        "changes answered differently after the caller changed what it returned",
      );
      this.page(peer, at, end, second as Extract<ChangePage, { status: "ok" }>);
      if (page.through === end) return out;
      at = page.through;
    }
  }

  /**
   * One call `changes(from)` with no `to`, below the floor: it must answer `resync-required`
   * with the peer's current revision (README §3.9.4).
   */
  private async below(peer: string, handle: PeerStore, from: number, floor: number) {
    const feed = this.feed(peer);
    const current = feed.revisions[feed.revisions.length - 1]!;
    const outcome = await attempt(() => handle.changes(from));
    check("value" in outcome, `changes refused with ${"error" in outcome ? outcome.error : ""}`);
    shaped(outcome.value);
    check(
      outcome.value.status === "resync-required",
      `changes answered ok from ${from}, below the retention floor ${floor}`,
    );
    check(
      outcome.value.current === current,
      `a resync answer carries current ${outcome.value.current}, not the peer's revision ${current}`,
    );
  }

  /** README §3.9: after every step, each peer's whole kept feed, and the floor below it. */
  async checkFeeds(): Promise<void> {
    if (this.keep() === undefined) return;
    for (const [peer, feed] of this.feeds) {
      const handle = this.peer(peer);
      const { floor, index } = this.floor(feed);
      const records = await this.pages(peer, handle, floor, undefined);
      check(
        records !== "resync",
        `changes answered resync-required from ${floor}, and every record after ${floor} is retained`,
      );
      if (index > 0) {
        const previous = feed.revisions[index - 1]!;
        await this.below(peer, handle, previous, floor);
        // Where revisions skip values, every `from` between the previous revision and the floor
        // is not a revision the peer had, and it is below the floor all the same.
        for (let from = previous + 1; from < floor; from++)
          await this.below(peer, handle, from, floor);
        // The floor is the newest dropped revision, not the one just before the oldest kept
        // record. Where revisions skip values the two differ, and a `from` between them is
        // above the floor.
        const oldestKept = feed.revisions[index + 1];
        if (oldestKept !== undefined && floor + 1 < oldestKept)
          check(
            (await this.pages(peer, handle, floor + 1, undefined)) !== "resync",
            `changes answered resync-required from ${floor + 1}, above the retention floor ${floor}`,
          );
      }
    }
  }

  /** The peer a handle belongs to. */
  ownerOf(handle: string): string {
    this.peer(handle);
    return this.owners.get(handle)!;
  }

  /** The integer a revision reference names, for the peer a handle belongs to. */
  resolve(ref: RevisionRef, handle: string): number {
    return this.revisionOf(ref, this.ownerOf(handle));
  }

  /**
   * The runner's own model of a peer's feed: every record since creation, kept or not, the
   * retention floor and the current revision. Undefined when the store serves no feed.
   */
  model(peer: string):
    | {
        readonly records: readonly ChangeRecord[];
        readonly floor: number;
        readonly current: number;
      }
    | undefined {
    const feed = this.feeds.get(peer);
    if (feed === undefined) return undefined;
    return {
      records: feed.records,
      floor: this.floor(feed).floor,
      current: feed.revisions[feed.revisions.length - 1]!,
    };
  }

  delta(name: string): Delta {
    const delta = this.corpus.get(name);
    check(delta !== undefined, `the vector names an unknown delta ${name}`);
    return delta;
  }
  ids(names: readonly string[]): string[] {
    return names.map((name) => this.delta(name).id);
  }
  peerId(name: string): string {
    const id = this.header.peers[name];
    check(id !== undefined, `the vector names an unknown peer ${name}`);
    return id;
  }
  peer(name: string): PeerStore {
    const peer = this.peers.get(name);
    check(peer !== undefined, `the vector uses peer ${name} before creating it`);
    return peer;
  }
  /** The bookkeeping of the peer a handle belongs to. */
  held(handle: string): Map<string, VerifiedDelta> {
    return this.holdings.get(this.owners.get(handle)!)!;
  }
  snapshot(name: string): { peer: string; snapshot: Snapshot } {
    const snapshot = this.snapshots.get(name);
    check(snapshot !== undefined, `the vector uses snapshot ${name} before reading it`);
    return snapshot;
  }
  pushdown(vector: VectorPushdown, fields: readonly PushdownField[]): Pushdown {
    return {
      ...(fields.includes("timestampAtMost") && vector.timestampAtMost !== undefined
        ? { timestampAtMost: vector.timestampAtMost }
        : {}),
      ...(fields.includes("arrivalAtMost") && vector.arrivalAtMost !== undefined
        ? { arrivalAtMost: vector.arrivalAtMost }
        : {}),
      ...(fields.includes("excludeIds") && vector.excludeIds !== undefined
        ? { excludeIds: this.ids(vector.excludeIds) }
        : {}),
    };
  }

  private async revision(peer: string): Promise<number> {
    const snapshot = await this.peer(peer).read();
    const revision = snapshot.revision;
    snapshot.release();
    return revision;
  }

  /** A returned delta must be the named appearance: id, signature and claims. */
  matches(actual: Delta, name: string): void {
    const expected = this.delta(name);
    check(actual.id === expected.id, `expected delta ${name}, got id ${actual.id.slice(0, 12)}`);
    check(actual.sig === expected.sig, `delta ${name}: the signature differs`);
    check(computeId(actual.claims) === expected.id, `delta ${name}: the claims differ`);
  }

  /** An arrival record a store returns must be the one this peer admitted the id under. */
  sameArrival(peer: string, got: ArrivalRecord): void {
    const arrival = this.holdings.get(peer)?.get(got.id)?.arrival;
    check(arrival !== undefined, `the store answered for ${got.id.slice(0, 12)}, not held`);
    check(
      got.at === arrival.at &&
        got.sequence === arrival.sequence &&
        got.transfer === arrival.transfer &&
        got.sender === arrival.sender,
      `${got.id.slice(0, 12)} carries another arrival record`,
    );
  }

  /** Scope members must be ascending, distinct, held, and carry this peer's own arrival. */
  members(peer: string, deltas: readonly VerifiedDelta[]): string[] {
    const ids = deltas.map((entry) => entry.delta.id);
    check(
      ids.every((id, i) => i === 0 || compareUtf8(ids[i - 1]!, id) < 0),
      "scope members are not ascending and distinct",
    );
    for (const entry of deltas) {
      check(computeId(entry.delta.claims) === entry.delta.id, "a scope member's claims differ");
      check(entry.arrival.id === entry.delta.id, "a scope member carries another id's arrival");
      this.sameArrival(peer, entry.arrival);
      check(
        entry.delta.sig === this.holdings.get(peer)!.get(entry.delta.id)!.delta.sig,
        "a scope member carries another appearance's signature",
      );
    }
    return ids;
  }

  applied(result: AppliedPushdown, requested: Pushdown): PushdownField[] {
    const applied = PUSHDOWN_FIELDS.filter((field) => result[field]);
    for (const field of PUSHDOWN_FIELDS) {
      const asked = requested[field] !== undefined;
      check(asked || !result[field], `applied reports ${field}, which was not requested`);
      if (this.reference)
        check(
          result[field] === (asked && this.store.profile.pushdown[field]),
          `the reference store must apply ${field} exactly when its profile says so`,
        );
    }
    return applied;
  }

  // The store is asked first and the answer is judged afterwards, so a store that answers
  // where it must refuse fails for that, whatever it answered.
  private async query<T>(
    snapshotName: string,
    expect: { readonly error?: VectorRefusal; readonly orError?: "snapshot-moved" },
    ask: (snapshot: Snapshot) => Promise<T>,
    judge: (answer: T, peer: string) => void,
  ): Promise<void> {
    const { peer, snapshot } = this.snapshot(snapshotName);
    const outcome = await attempt(() => ask(snapshot));
    if (expect.error !== undefined) refused(outcome, expect.error);
    else if ("value" in outcome) judge(outcome.value, peer);
    else
      check(
        outcome.error === expect.orError,
        `the query refused with ${outcome.error}, and ${
          expect.orError === undefined
            ? "it must answer"
            : `only ${expect.orError} or an answer conforms`
        }`,
      );
  }

  async step(step: StoreVectorStep): Promise<void> {
    switch (step.op) {
      case "createPeer": {
        // A malformed retention is a defect found before the store is called.
        this.keep();
        const outcome = await attempt(() =>
          this.store.createPeer(this.peerId(step.peer), { erasure: step.erasure }),
        );
        const created =
          "status" in step.expect ||
          (step.expect.unlessStoreErasure !== undefined &&
            step.expect.unlessStoreErasure === this.store.profile.capabilities.erasure);
        if (created) {
          check("value" in outcome, "expected the peer to be created");
          check(outcome.value.erasure.posture === step.erasure, "the peer's posture differs");
          check(
            outcome.value.erasure.storeClass === this.store.profile.capabilities.erasure,
            "the peer did not record its store's erasure class",
          );
          this.peers.set(step.peer, outcome.value);
          this.owners.set(step.peer, step.peer);
          this.holdings.set(step.peer, new Map());
          if (this.keep() !== undefined)
            this.feeds.set(step.peer, {
              revisions: [await this.revision(step.peer)],
              records: [],
              head: null,
              everHeld: new Set(),
              seen: new Map(),
            });
        } else if ("error" in step.expect) refused(outcome, step.expect.error);
        return;
      }
      case "openPeer": {
        const outcome = await attempt(() => this.store.peer(this.peerId(step.peer)));
        if ("error" in step.expect) return refused(outcome, step.expect.error);
        check("value" in outcome, "expected the peer to open");
        check(outcome.value.erasure.posture === step.expect.posture, "the posture differs");
        // With `handle`, the earlier handle stays in use under the peer's own name.
        this.peers.set(step.handle ?? step.peer, outcome.value);
        this.owners.set(step.handle ?? step.peer, step.peer);
        return;
      }
      case "append": {
        const before = await this.revision(step.peer);
        const added = step.added.map(({ delta, arrival }) => {
          const { id, ...rest } = arrival;
          return {
            delta: this.delta(delta),
            arrival: { id: this.delta(id ?? delta).id, ...rest },
          };
        });
        const frame = step.frame === null ? null : hexToBytes(step.frame);
        const outcome = await attempt(() =>
          this.peer(step.peer).append({
            expectedHead: step.expectedHead,
            nextHead: step.nextHead,
            frame,
            added,
          }),
        );
        const after = await this.revision(step.peer);
        const owner = this.owners.get(step.peer)!;
        const feed = this.feeds.get(owner);
        if ("error" in step.expect) {
          refused(outcome, step.expect.error);
          check(after === before, "a refused append moved the revision");
          if (feed !== undefined) await this.committed(owner, this.peer(step.peer), before);
          return;
        }
        check("value" in outcome, `the append refused`);
        const result = outcome.value;
        check(result.status === step.expect.status, `the append answered ${result.status}`);
        if (result.status !== "committed" || step.expect.status !== "committed") {
          check(after === before, "an append that did not commit moved the revision");
          if (feed !== undefined) await this.committed(owner, this.peer(step.peer), before);
          return;
        }
        const names = step.expect.added;
        check(
          same(result.added, this.ids(names)),
          `added ${show(result.added)}, expected ${show(this.ids(names))}`,
        );
        check(result.revision === after, "the append result's revision is not the peer's");
        check(
          step.expect.revisionAdvanced ? after > before : after === before,
          `the revision ${step.expect.revisionAdvanced ? "did not advance" : "advanced"}`,
        );
        const held = this.held(step.peer);
        for (const entry of added)
          if (result.added.includes(entry.delta.id) && !held.has(entry.delta.id))
            held.set(entry.delta.id, entry);
        if (step.revisionAs !== undefined) this.name(step.revisionAs, owner, after);
        if (feed !== undefined) {
          feed.head = step.nextHead;
          for (const id of result.added) feed.everHeld.add(id);
          if (after !== before) {
            feed.revisions.push(after);
            feed.records.push({
              revision: after,
              head: step.nextHead,
              added: this.ids(names),
              removed: [],
            });
          }
          await this.committed(owner, this.peer(step.peer), before);
        }
        return;
      }
      case "purge": {
        // A document defect, whatever the store: the claim names the two classes that purge.
        const claim: unknown = step.expect.claim;
        check(
          typeof claim === "object" && claim !== null && !Array.isArray(claim),
          "the vector's purge claim is missing or not an object, not unprovable and proven",
        );
        const claimKeys = Object.keys(claim).sort();
        check(
          same(claimKeys, ["proven", "unprovable"]),
          `the vector's purge claim has keys ${claimKeys.join(", ")}, not unprovable and proven`,
        );
        const before = await this.revision(step.peer);
        const purged = await attempt(() => this.peer(step.peer).purge(this.ids(step.ids)));
        check(
          "value" in purged,
          `the purge refused${"error" in purged ? ` with ${purged.error}` : ""}`,
        );
        const report = purged.value;
        const after = await this.revision(step.peer);
        const expected = step.expect.targets.map((t) => `${this.delta(t.delta).id} ${t.outcome}`);
        const actual = report.targets.map((t) => `${t.id} ${t.outcome}`);
        check(same(actual, expected), `purge targets ${actual.join("; ")}`);
        check(report.revision === after, "the purge report's revision is not the peer's");
        check(
          step.expect.revisionAdvanced ? after > before : after === before,
          `the revision ${step.expect.revisionAdvanced ? "did not advance" : "advanced"}`,
        );
        check(report.boundary === PURGE_BOUNDARY, "the report does not state its boundary");
        const storeClass = this.store.profile.capabilities.erasure;
        // A store of class `none` that answers a purge meets no expectation: the scripts that
        // purge require `purge`, and the claim has no entry for `none`.
        check(
          storeClass !== "none",
          "the vector's purge claim has no entry for erasure class none",
        );
        // A store may claim less than a vector allows, never more: `unproven` is accepted
        // where `proven` is expected, and nothing else is exchanged.
        const expectedClaim = step.expect.claim[storeClass];
        check(
          report.claim === expectedClaim ||
            (expectedClaim === "proven" && report.claim === "unproven"),
          `the report claims ${report.claim}, expected ${expectedClaim} on a store of class ${storeClass}`,
        );
        const states: readonly string[] = ["absent", "owed", "unprovable"];
        check(
          report.surfaces.every((s) => states.includes(s.state)),
          "a surface reports an unknown state",
        );
        check(
          report.claim !== "proven" ||
            (report.surfaces.length > 0 && report.surfaces.every((s) => s.state === "absent")),
          "the report claims proven without surfaces that are all absent",
        );
        if (this.reference)
          check(
            same(
              report.surfaces.map((s) => `${s.surface} ${s.state}`),
              step.expect.referenceSurfaces.map((s) => `${s.surface} ${s.state}`),
            ),
            "the reference store's surfaces differ",
          );
        // Every outcome ends what the peer holds: `removed` and `held-by-other-peer` both stop
        // the holding, and the others find none. An id appended again is held anew.
        const held = this.held(step.peer);
        // The record names the ids that leave the holdings. A settled debt left earlier.
        const released = report.targets
          .filter((target) => held.has(target.id))
          .map((target) => target.id);
        for (const target of report.targets) held.delete(target.id);
        const owner = this.owners.get(step.peer)!;
        if (step.revisionAs !== undefined) this.name(step.revisionAs, owner, after);
        const feed = this.feeds.get(owner);
        if (feed !== undefined) {
          if (after !== before) {
            feed.revisions.push(after);
            feed.records.push({ revision: after, head: feed.head, added: [], removed: released });
          }
          await this.committed(owner, this.peer(step.peer), before);
        }
        return;
      }
      case "read":
        this.snapshots.set(step.snapshot, {
          peer: this.owners.get(step.peer) ?? step.peer,
          snapshot: await this.peer(step.peer).read(),
        });
        return;
      case "release":
        this.snapshot(step.snapshot).snapshot.release();
        return;
      case "head": {
        const { snapshot } = this.snapshot(step.snapshot);
        check(snapshot.head === step.expect.head, `the head is ${String(snapshot.head)}`);
        return;
      }
      case "get":
        return this.query(
          step.snapshot,
          step.expect,
          (snapshot) => snapshot.get(this.ids(step.ids)),
          (deltas) => {
            const names = "deltas" in step.expect ? step.expect.deltas : [];
            check(
              same(
                deltas.map((d) => d.id),
                this.ids(names),
              ),
              `get answered ${show(deltas.map((d) => d.id))}, expected ${show(this.ids(names))}`,
            );
            deltas.forEach((delta, i) => this.matches(delta, names[i]!));
          },
        );
      case "targets":
        return this.query(
          step.snapshot,
          step.expect,
          (snapshot) => snapshot.targets(step.entities),
          (ids) => {
            const expected = this.ids("ids" in step.expect ? step.expect.ids : []);
            check(same(ids, expected), `targets answered ${show(ids)}, expected ${show(expected)}`);
          },
        );
      case "negators":
        return this.query(
          step.snapshot,
          step.expect,
          (snapshot) => snapshot.negators(this.ids(step.ids)),
          (ids) => {
            const expected = this.ids("ids" in step.expect ? step.expect.ids : []);
            check(
              same(ids, expected),
              `negators answered ${show(ids)}, expected ${show(expected)}`,
            );
          },
        );
      case "scope": {
        const pushdown =
          step.pushdown === undefined ? undefined : this.pushdown(step.pushdown, PUSHDOWN_FIELDS);
        return this.query(
          step.snapshot,
          step.expect,
          (snapshot) =>
            snapshot.scope({
              anchors: step.anchors,
              ...(pushdown === undefined ? {} : { pushdown }),
              ...(step.exclude === undefined ? {} : { exclude: this.ids(step.exclude) }),
            }),
          (result, peer) => {
            const ids = this.members(peer, result.deltas);
            const applied = this.applied(result.applied, pushdown ?? {});
            if (!("lower" in step.expect)) return;
            const lower = this.ids(step.expect.lower);
            const upper = new Set(this.ids(step.expect.upper));
            check(
              lower.every((id) => ids.includes(id)),
              `scope ${show(ids)} lacks a member of ${show(lower)}`,
            );
            check(
              ids.every((id) => upper.has(id)),
              `scope ${show(ids)} leaves the upper bound`,
            );
            const requested = PUSHDOWN_FIELDS.filter((f) => pushdown?.[f] !== undefined);
            if (this.reference && applied.length === requested.length)
              check(
                same(ids, lower),
                `the reference store answered ${show(ids)}, not ${show(lower)}`,
              );
          },
        );
      }
      case "count": {
        const { snapshot } = this.snapshot(step.snapshot);
        check(snapshot.count === step.expect.count, `the snapshot counts ${snapshot.count}`);
        return;
      }
      case "arrivals":
        return this.query(
          step.snapshot,
          step.expect,
          (snapshot) => snapshot.arrivals(this.ids(step.ids)),
          (arrivals, peer) => {
            const expected = this.ids("ids" in step.expect ? step.expect.ids : []);
            const ids = arrivals.map((arrival) => arrival.id);
            check(
              same(ids, expected),
              `arrivals answered ${show(ids)}, expected ${show(expected)}`,
            );
            for (const arrival of arrivals) this.sameArrival(peer, arrival);
          },
        );
      case "export": {
        const exporter = this.store.openAdmin().peer(this.peerId(step.peer));
        const outcome = await attempt(async () => {
          const ids: string[] = [];
          for await (const id of exporter.ids()) ids.push(id);
          const deltas: Delta[] = [];
          for await (const delta of exporter.deltas()) deltas.push(delta);
          return { ids, deltas };
        });
        if ("error" in step.expect) return refused(outcome, step.expect.error);
        check("value" in outcome, "the export refused");
        const names = step.expect.deltas;
        const { ids, deltas } = outcome.value;
        check(same(ids, this.ids(names)), `export ids ${show(ids)}`);
        check(deltas.length === ids.length, "export deltas and ids disagree");
        deltas.forEach((delta, i) => this.matches(delta, names[i]!));
        return;
      }
      case "exportStored": {
        const ids: string[] = [];
        for await (const id of this.store.openAdmin().storedIds()) ids.push(id);
        const expected = this.ids(step.expect.ids);
        check(same(ids, expected), `the store keeps ${show(ids)}, expected ${show(expected)}`);
        return;
      }
      case "mark": {
        // `revision` reads through the handle, so a peer not yet created fails there.
        const revision = await this.revision(step.peer);
        this.name(step.as, this.owners.get(step.peer)!, revision);
        return;
      }
      case "changes": {
        const handle = this.peer(step.peer);
        const owner = this.owners.get(step.peer)!;
        const from = this.revisionOf(step.from, owner);
        const to = step.to === undefined ? undefined : this.revisionOf(step.to, owner);
        const expect = step.expect;
        if ("error" in expect) {
          refused(await attempt(() => handle.changes(from, to)), expect.error);
          return;
        }
        const feed = this.feeds.get(owner);
        check(feed !== undefined, "a changes step on a store that serves no feed");
        const { floor } = this.floor(feed);
        // On a store that keeps fewer records, a `from` below its floor answers resync-required
        // whatever the document says about a feed that keeps every record.
        const resync = expect.status === "resync-required" || from < floor;
        const answer = await this.pages(owner, handle, from, to);
        if (resync) {
          check(
            answer === "resync",
            from < floor
              ? `changes answered ok from ${from}, below the retention floor ${floor}`
              : `changes answered ok from ${from}, and the step expects resync-required`,
          );
          return;
        }
        check(
          answer !== "resync",
          `changes answered resync-required from ${from}, and every record after ${from} is retained`,
        );
        const expected = (expect.status === "ok" ? expect.records : []).map((r) => ({
          revision: this.revisionOf({ revision: r.revision }, owner),
          head: r.head,
          added: this.ids(r.added),
          removed: this.ids(r.removed),
        }));
        check(
          same(answer.map(recordText), expected.map(recordText)),
          `changes answered the records of ${answer.map((r) => r.revision).join(", ") || "nothing"}, expected ${expected.map((r) => r.revision).join(", ") || "nothing"}`,
        );
        return;
      }
      case "exportPeers": {
        const peers: string[] = [];
        for await (const id of this.store.openAdmin().peers()) peers.push(id);
        const expected = step.expect.peers.map((name) => this.peerId(name));
        check(same(peers, expected), `the store lists peers ${peers.join(" ")}`);
        return;
      }
    }
  }

  async steps(steps: readonly StoreVectorStep[]): Promise<void> {
    for (const [i, step] of steps.entries()) {
      try {
        await this.step(step);
        await this.checkFeeds();
      } catch (error) {
        throw new Error(
          `step ${i} (${step.op}): ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  /** The trim lemma (§4.3) for one case, once per subset of its selection's fields. */
  async scopeCase(scopeCase: StoreScopeCase): Promise<void> {
    // `peer` is a handle name, as in `read`. The bookkeeping is the peer's it belongs to.
    const peer = this.owners.get(scopeCase.peer) ?? scopeCase.peer;
    const snapshot = await this.peer(scopeCase.peer).read();
    const entities = scopeCase.anchors.map((anchor) => anchor.entity);
    const byFields = new Map(scopeCase.scopes.map((s) => [key(s.fields), this.ids(s.ids)]));
    const present = PUSHDOWN_FIELDS.filter((field) => scopeCase.selection[field] !== undefined);
    const selection = this.pushdown(scopeCase.selection, PUSHDOWN_FIELDS);
    const exact = byFields.get(key(present));
    check(exact !== undefined, "the case lacks the scope under its whole selection");
    const heldIds = this.ids(scopeCase.held);
    const held: VerifiedDelta[] = (await snapshot.get(heldIds)).map((delta) => ({
      delta,
      arrival: this.holdings.get(peer)!.get(delta.id)!.arrival,
    }));
    check(held.length === new Set(heldIds).size, "the peer does not hold a delta the case holds");

    for (const entry of scopeCase.scopes) {
      const label = `pushdown {${key(entry.fields)}}`;
      const pushdown = this.pushdown(scopeCase.selection, entry.fields);
      const result = await snapshot.scope({
        anchors: scopeCase.anchors,
        ...(entry.fields.length === 0 ? {} : { pushdown }),
        exclude: heldIds,
      });
      const ids = this.members(peer, result.deltas);
      const applied = this.applied(result.applied, pushdown);
      const lower = this.ids(entry.ids).filter((id) => !heldIds.includes(id));
      const upper = byFields.get(key(applied));
      check(upper !== undefined, `${label}: the case lacks a scope for the applied fields`);
      check(
        lower.every((id) => ids.includes(id)),
        `${label}: scope ${show(ids)} lacks a member of ${show(lower)}`,
      );
      check(
        ids.every((id) => upper.includes(id)),
        `${label}: scope ${show(ids)} leaves S over the applied selection ${show(upper)}`,
      );
      if (this.reference) {
        const reference = upper.filter((id) => !heldIds.includes(id));
        check(same(ids, reference), `${label}: the reference store answered ${show(ids)}`);
      }
      const residual = present.filter((field) => !applied.includes(field));
      const trimmed = scopeOver(
        [
          ...result.deltas.filter((e) => passesSelection(e, selection, residual)),
          ...held.filter((e) => passesSelection(e, selection, present)),
        ],
        entities,
      );
      check(
        same(trimmed, exact),
        `${label}: the trimmed scope is ${show(trimmed)}, expected ${show(exact)}`,
      );
    }
    snapshot.release();
  }
}

/**
 * The first requirement of a script the store's profile fails. An absent `requires` means
 * none; a name that is not a requirement is a defect of the document.
 */
export function missing(
  store: Store,
  requires: readonly VectorRequirement[] | undefined,
): VectorRequirement | undefined {
  if (requires === undefined) return undefined;
  check(Array.isArray(requires), "the script's requires is not a list");
  for (const requirement of requires) {
    let holds: boolean;
    if (requirement === "purge") holds = store.profile.capabilities.erasure !== "none";
    else if (requirement === "journal-absent") holds = !store.profile.capabilities.journal;
    else if (requirement === "changes") holds = store.profile.changeRetention !== "none";
    else throw new Error(`unknown script requirement ${String(requirement)}`);
    if (!holds) return requirement;
  }
  return undefined;
}

/**
 * Runs the shared store vectors against the stores `factory` makes. Each script, and the scope
 * document, gets a new empty store. Returns what passed and what the profile made it skip.
 * Throws `StoreConformanceError`, listing every failure, when anything fails.
 */
export async function runStoreConformance(
  factory: () => Promise<Store>,
  vectors: StoreVectors = storeVectors(),
): Promise<StoreConformanceReport> {
  const passed: string[] = [];
  const skipped: { name: string; missing: VectorRequirement }[] = [];
  const failures: StoreConformanceFailure[] = [];
  const guarded = async (name: string, body: () => Promise<void>): Promise<boolean> => {
    try {
      await body();
      return true;
    } catch (error) {
      failures.push({ name, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };
  check(vectors.scripts.format === STORE_SCRIPTS_FORMAT, "unknown store scripts format");
  check(vectors.scope.format === STORE_SCOPE_FORMAT, "unknown store scope format");

  for (const script of vectors.scripts.scripts) {
    const name = `scripts/${script.name}`;
    const store = await factory();
    let lacks: VectorRequirement | undefined;
    if (
      await guarded(name, async () => {
        lacks = missing(store, script.requires);
      })
    ) {
      if (lacks !== undefined) skipped.push({ name, missing: lacks });
      else if (await guarded(name, () => new Run(store, vectors.scripts).steps(script.steps)))
        passed.push(name);
    }
    await store.close();
  }

  const store = await factory();
  const run = new Run(store, vectors.scope);
  if (await guarded("scope/setup", () => run.steps(vectors.scope.setup)))
    for (const scopeCase of vectors.scope.cases) {
      const name = `scope/${scopeCase.name}`;
      if (await guarded(name, () => run.scopeCase(scopeCase))) passed.push(name);
    }
  await store.close();

  if (failures.length > 0) throw new StoreConformanceError(failures);
  return { passed, skipped };
}
