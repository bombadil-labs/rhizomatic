// The conformance runner's own rules (vectors/store/README.md §3, §4). The runner is the
// instrument every store is judged by, so each rule it checks has a store here that breaks that
// rule and nothing before it. The run must fail, in the named document, with the message of
// that rule: a runner that stops checking the rule passes the store, or fails it with another
// rule's message, and the case goes red either way.
//
// A script stops at its first failing step. A wrong store is therefore built so that some
// script reaches the step that shows the rule.
//
// Rules no wrapped store can reach, and why:
// - The checks of the documents themselves (an unknown format, a corpus id that does not
//   recompute, a step that names an unknown delta, peer or snapshot, a scope case without the
//   scope of a subset). No store answer leads there. "a wrong document" below covers them with
//   wrong documents.
// - "the vector's purge claim has no entry for erasure class none" is reached with a document of
//   this file. The shared scripts that purge are skipped for such a store (README §3.4, §6); its
//   refusal is a test of each witness (README §7, test 8), not a rule of the runner.
// - In a scope case, "the case lacks a scope for the applied fields" cannot fail for a correct
//   document: applied ⊆ requested is checked first, and the document holds every subset.
// - The trim comparison (§4 step 7) follows from the two bounds and the member checks, so a
//   store that passes those passes it. It is reached here through a `get` that returns held
//   deltas with other claims, which this runner reads the held deltas from; and in
//   store-vectors.test.ts through a document whose exact scope is wrong.
//
// - A `changes` step (README §3.9.6), "changes answered ok from <from>, and the step expects
//   resync-required": the step expects it only for a cursor from the future, and there an `ok`
//   page always fails "the page's through T lies outside [last, end]" first, because `last` is
//   `from`, which is past `end`. "changes answered the records of" follows from the checks of
//   every page and is reached here with a wrong document.
//
// Not covered here: what a store must do (store-vectors.test.ts, "each broken store fails"),
// and ownership, which no conformance run checks (store.test.ts).

import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { runStoreConformance, StoreConformanceError } from "../src/storage/store-conformance.js";
import type { StoreVectors } from "../src/storage/store-vector-format.js";
import { storeVectors } from "../src/storage/store-vectors.js";
import type {
  AppendResult,
  ChangePage,
  ChangeRecord,
  Exporter,
  PeerExporter,
  PeerStore,
  PurgeReport,
  ScopeResult,
  Snapshot,
  Store,
  StoreErrorCode,
  StoreProfile,
  VerifiedDelta,
} from "../src/storage/store.js";
import { StoreError } from "../src/storage/store.js";
import type { Delta } from "../src/delta/types.js";
import {
  broken,
  sparse,
  stale,
  staleAfterSettledDebt,
  type Break,
} from "./support/broken-store.js";

const vectors = storeVectors();

// ---- parts of a wrong store -----------------------------------------------------------------

/** Not the reference store: the runner holds it to the general rules only. */
const other: Break = { profile: (p) => ({ ...p, formatVersion: "test.other/1" }) };
const join = (...faults: Break[]): Break => Object.assign({}, ...faults) as Break;

const codeOf = (error: unknown): string | undefined =>
  error instanceof StoreError ? error.code : undefined;
/** Runs `action`; a refusal with code `from` becomes one with code `to`. */
async function recoded<T>(
  from: StoreErrorCode,
  to: StoreErrorCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (codeOf(error) === from) throw new StoreError(to, "another code");
    throw error;
  }
}

type Query = "get" | "arrivals" | "targets" | "negators" | "scope";
const QUERIES: readonly Query[] = ["get", "arrivals", "targets", "negators", "scope"];
/** Replaces every query of a snapshot by `wrap` around it. */
const queries =
  (wrap: (run: () => Promise<unknown>) => Promise<unknown>) =>
  (s: Snapshot): Partial<Snapshot> =>
    Object.fromEntries(
      QUERIES.map((name) => [
        name,
        (argument: never) => wrap(() => (s[name] as (a: never) => Promise<unknown>)(argument)),
      ]),
    ) as Partial<Snapshot>;

const scope =
  (
    change: (
      result: ScopeResult,
      s: Snapshot,
      peer: PeerStore,
      inner: Store,
    ) => Promise<ScopeResult>,
    ask: (request: ScopeRequest) => ScopeRequest = (r) => r,
  ) =>
  (s: Snapshot, peer: PeerStore, inner: Store): Partial<Snapshot> => ({
    scope: async (request) => change(await s.scope(ask(request)), s, peer, inner),
  });
type ScopeRequest = Parameters<Snapshot["scope"]>[0];
/** The request without the ids the read holds: a store that ignores `exclude` sees this. */
const withoutExclude = (request: ScopeRequest): ScopeRequest => ({
  anchors: request.anchors,
  ...(request.pushdown === undefined ? {} : { pushdown: request.pushdown }),
});
const members =
  (change: (deltas: readonly VerifiedDelta[]) => readonly VerifiedDelta[]) =>
  async (result: ScopeResult): Promise<ScopeResult> => ({
    ...result,
    deltas: change(result.deltas),
  });

const get = (change: (deltas: readonly Delta[]) => readonly Delta[]): Break => ({
  snapshot: (s) => ({ get: async (ids) => change(await s.get(ids)) }),
});
const purge = (change: (report: PurgeReport, ids: readonly string[]) => PurgeReport): Break => ({
  peer: (peer) => ({ purge: async (ids) => change(await peer.purge(ids), ids) }),
});
const append = (change: (result: AppendResult) => AppendResult | Promise<AppendResult>): Break => ({
  peer: (peer) => ({ append: async (batch) => change(await peer.append(batch)) }),
});
const exporter = (change: (listing: PeerExporter, admin: Exporter) => Partial<PeerExporter>) => ({
  store: (_store: Store, inner: Store): Partial<Store> => ({
    openAdmin: () => {
      const admin = inner.openAdmin();
      return {
        ...admin,
        peer: (id) => {
          const listing = admin.peer(id);
          return { ...listing, ...change(listing, admin) };
        },
      };
    },
  }),
});
async function* listed<T>(items: AsyncIterable<T>, change: (all: T[]) => T[]): AsyncIterable<T> {
  const all: T[] = [];
  for await (const item of items) all.push(item);
  yield* change(all);
}
const reversed = <T>(all: readonly T[]): T[] => [...all].reverse();
const otherClaims = (delta: Delta): Delta => ({
  ...delta,
  claims: { ...delta.claims, timestamp: delta.claims.timestamp + 1 },
});
const unsigned = ({ id, claims }: Delta): Delta => ({ id, claims });

/**
 * A store whose revisions are the memory store's plus an offset this wrapper moves. `moved`
 * says how far to move it after an append or a purge; `reported` skews the revision a result
 * or a report states.
 */
function revisions(rule: {
  append?: (outcome: "refused" | "conflict" | "committed", advanced: boolean) => number;
  purge?: (advanced: boolean) => number;
  reported?: { append?: number; purge?: number };
}): Break {
  const offsets = new WeakMap<Store, Map<string, number>>();
  return {
    peer: (peer, inner) => {
      if (!offsets.has(inner)) offsets.set(inner, new Map());
      const of = offsets.get(inner)!;
      const offset = (): number => of.get(peer.id) ?? 0;
      const move = (by: number): void => void of.set(peer.id, offset() + by);
      const real = async (): Promise<number> => (await peer.read()).revision;
      return {
        read: async () => {
          const snapshot = await peer.read();
          return { ...snapshot, revision: snapshot.revision + offset() };
        },
        append: async (batch) => {
          const before = await real();
          let result: AppendResult;
          try {
            result = await peer.append(batch);
          } catch (error) {
            move(rule.append?.("refused", false) ?? 0);
            throw error;
          }
          if (result.status !== "committed") {
            move(rule.append?.("conflict", false) ?? 0);
            return result;
          }
          move(rule.append?.("committed", result.revision > before) ?? 0);
          return {
            ...result,
            revision: result.revision + offset() + (rule.reported?.append ?? 0),
          };
        },
        purge: async (ids) => {
          const before = await real();
          const report = await peer.purge(ids);
          move(rule.purge?.(report.revision > before) ?? 0);
          return {
            ...report,
            revision: report.revision + offset() + (rule.reported?.purge ?? 0),
          };
        },
      };
    },
  };
}

/** A stand-in of class `proven`: the memory store with its class and its reports relabelled. */
const provenClass: Break = {
  profile: (p) => ({
    ...p,
    formatVersion: "test.proven/1",
    capabilities: { ...p.capabilities, erasure: "proven" },
  }),
  peer: (peer) => ({ erasure: { ...peer.erasure, storeClass: "proven" } }),
};

/**
 * A store whose `changes` answers `change(page, from, to, current)` in place of the memory
 * store's page. `current` is the peer's revision when it is asked.
 */
const feed = (
  change: (
    page: ChangePage,
    from: number,
    to: number | undefined,
    current: number,
    peer: PeerStore,
  ) => ChangePage | Promise<ChangePage>,
): Break => ({
  peer: (peer) => ({
    changes: async (from, to) => {
      const snapshot = await peer.read();
      const current = snapshot.revision;
      snapshot.release();
      return change(await peer.changes(from, to), from, to, current, peer);
    },
  }),
});
/** The same, for an `ok` page only; `resync-required` passes through. */
const records = (
  change: (
    page: Extract<ChangePage, { status: "ok" }>,
    from: number,
    current: number,
  ) => ChangePage,
): Break =>
  feed((page, from, _to, current) => (page.status === "ok" ? change(page, from, current) : page));
const ok = (records: readonly ChangeRecord[], through: number): ChangePage => ({
  status: "ok",
  records,
  through,
});

/**
 * A store whose purge records also name each settled debt: an id the purge reports `removed`
 * that the peer no longer held.
 */
function settledInRemoved(): Break {
  const books = new WeakMap<
    Store,
    Map<string, { held: Set<string>; extra: Map<number, string[]> }>
  >();
  return {
    peer: (peer, inner) => {
      if (!books.has(inner)) books.set(inner, new Map());
      const byPeer = books.get(inner)!;
      if (!byPeer.has(peer.id)) byPeer.set(peer.id, { held: new Set(), extra: new Map() });
      const { held, extra } = byPeer.get(peer.id)!;
      return {
        append: async (batch) => {
          const result = await peer.append(batch);
          if (result.status === "committed") for (const id of result.added) held.add(id);
          return result;
        },
        purge: async (ids) => {
          const report = await peer.purge(ids);
          const settled = report.targets
            .filter((t) => t.outcome === "removed" && !held.has(t.id))
            .map((t) => t.id);
          for (const t of report.targets) held.delete(t.id);
          if (settled.length > 0) extra.set(report.revision, settled);
          return report;
        },
        changes: async (from, to) => {
          const page = await peer.changes(from, to);
          if (page.status !== "ok") return page;
          return ok(
            page.records.map((r) => {
              const more = extra.get(r.revision);
              return more === undefined || r.removed.length === 0
                ? r
                : { ...r, removed: [...r.removed, ...more].sort() };
            }),
            page.through,
          );
        },
      };
    },
  };
}

/** A store whose every peer's feed also carries the records of the other peers it opened. */
function onePoolOfRecords(): Break {
  const opened = new WeakMap<Store, Map<string, PeerStore>>();
  return {
    peer: (peer, inner) => {
      if (!opened.has(inner)) opened.set(inner, new Map());
      const peers = opened.get(inner)!;
      peers.set(peer.id, peer);
      return {
        changes: async (from, to) => {
          const page = await peer.changes(from, to);
          if (page.status !== "ok") return page;
          const others: ChangeRecord[] = [];
          for (const [id, other] of peers) {
            if (id === peer.id) continue;
            const theirs = await other.changes(0);
            if (theirs.status === "ok")
              others.push(
                ...theirs.records.filter((r) => r.revision > from && r.revision <= page.through),
              );
          }
          const all = [...page.records, ...others].sort((a, b) => a.revision - b.revision);
          return ok(all, page.through);
        },
      };
    },
  };
}

// ---- the table ------------------------------------------------------------------------------

type Rule = {
  /** The document the failure must be in. */
  readonly doc: "scripts" | "scope";
  /** Text of the rule's own message. A step's failure starts with `step N (op): `. */
  readonly says: string | RegExp;
  readonly store: Break;
  readonly vectors?: StoreVectors;
};

const FEED_RULES: Readonly<Record<string, Rule>> = {
  // -- the change feed (README §3.9). Most break a feed only when two or more records are
  // pending, so the check of each commit, which asks for one record, still passes. --
  "the feed: no record for a head-only commit": {
    doc: "scripts",
    says: /the head-only commit to revision \d+ wrote no record/,
    store: records((page) =>
      ok(
        page.records.filter((r) => r.added.length > 0 || r.removed.length > 0),
        page.through,
      ),
    ),
  },
  "the feed: no record for a commit that adds": {
    doc: "scripts",
    says: /the commit to revision \d+ wrote no record/,
    store: records((page) =>
      ok(
        page.records.filter((r) => r.added.length === 0),
        page.through,
      ),
    ),
  },
  "the feed: a commit that writes two records": {
    doc: "scripts",
    says: /the commit to revision \d+ wrote records at/,
    store: records((page, from, current) =>
      from === current - 1 ? ok([...page.records, ...page.records], page.through) : page,
    ),
  },
  "the feed: a record for a step that did not advance the revision": {
    doc: "scripts",
    says: "a step that did not advance the revision wrote a record",
    store: feed(async (page, from, _to, current, peer) =>
      from === current && current > 0 ? peer.changes(current - 1) : page,
    ),
  },
  "the feed: a record with another head": {
    doc: "scripts",
    says: /the record of revision \d+ has head/,
    store: records((page) =>
      ok(
        page.records.map((r) => ({ ...r, head: `${r.head}!` })),
        page.through,
      ),
    ),
  },
  "the feed: a record that adds nothing": {
    doc: "scripts",
    says: /the record of revision \d+ adds \[\], expected/,
    store: records((page) =>
      ok(
        page.records.map((r) => ({ ...r, added: [] })),
        page.through,
      ),
    ),
  },
  "the feed: a settled debt in removed": {
    doc: "scripts",
    says: /the record of revision \d+ removes \[.* .*\], expected/,
    store: settledInRemoved(),
  },
  "the feed: ids out of order inside a record": {
    doc: "scripts",
    says: "a record's ids are not ascending and distinct",
    store: records((page) =>
      ok(
        page.records.map((r) => ({ ...r, added: [...r.added].reverse() })),
        page.through,
      ),
    ),
  },
  "the feed: the check of a commit is not answered ok": {
    doc: "scripts",
    says: "changes from the revision before a commit is not ok",
    store: feed((page, from, _to, current) =>
      from === current - 1 ? { status: "resync-required", current } : page,
    ),
  },
  "the feed: ids out of order inside a record, in a range of two or more": {
    doc: "scripts",
    says: "a record's ids are not ascending and distinct",
    store: records((page, from, current) =>
      from < current - 1
        ? ok(
            page.records.map((r) => ({ ...r, added: [...r.added].reverse() })),
            page.through,
          )
        : page,
    ),
  },
  "the feed: changes refuses the check of a commit": {
    doc: "scripts",
    says: "changes refused with invalid-request",
    store: feed((page, from, _to, current) => {
      if (from === current - 1) throw new StoreError("invalid-request", "not this range");
      return page;
    }),
  },
  "the feed: changes refuses where it must answer resync-required": {
    doc: "scripts",
    says: "changes refused with invalid-request",
    store: {
      options: { changeRetention: { revisions: 2 } },
      ...feed((page) => {
        if (page.status === "resync-required")
          throw new StoreError("invalid-request", "no resync today");
        return page;
      }),
    },
  },
  "the feed: changes refuses": {
    doc: "scripts",
    says: "changes refused with invalid-request",
    store: feed(() => {
      throw new StoreError("invalid-request", "no feed today");
    }),
  },
  "the feed: a silent gap": {
    doc: "scripts",
    says: /the feed has no record for revision \d+/,
    // It keeps two records and says it keeps all, answering ok from below what it kept.
    store: records((page, _from, current) =>
      ok(
        page.records.filter((r) => r.revision > current - 2),
        page.through,
      ),
    ),
  },
  "the feed: resync-required inside the window": {
    doc: "scripts",
    says: /changes answered resync-required from \d+, and every record after \d+ is retained/,
    store: feed((page, from, _to, current) =>
      from < current - 1 ? { status: "resync-required", current } : page,
    ),
  },
  "the feed: resync-required on a later page": {
    doc: "scripts",
    says: "changes answered resync-required in the middle of a range",
    store: {
      options: { changePageSize: 1 },
      ...feed((page, from, _to, current) =>
        from > 0 && from < current - 1 ? { status: "resync-required", current } : page,
      ),
    },
  },
  "the feed: a resync answer with another current": {
    doc: "scripts",
    says: "a resync answer carries current",
    store: feed((page) =>
      page.status === "resync-required" ? { ...page, current: page.current + 1 } : page,
    ),
  },
  "the feed: a page that is neither ok nor resync-required": {
    doc: "scripts",
    says: "changes answered neither ok nor resync-required",
    store: feed((page, from, _to, current) =>
      from < current - 1 ? ({ status: "later" } as unknown as ChangePage) : page,
    ),
  },
  "the feed: an overstated page": {
    doc: "scripts",
    says: /the page claims through \d+ and leaves out the record at \d+/,
    store: records((page) => ok(page.records.slice(0, 1), page.through)),
  },
  "the feed: records out of order": {
    doc: "scripts",
    says: "the page's records are not ascending by revision",
    store: records((page) => ok([...page.records].reverse(), page.through)),
  },
  "the feed: a record outside the range asked": {
    doc: "scripts",
    says: /a record lies outside the range/,
    store: feed(async (page, from, to, current, peer) =>
      from > 0 && from < current - 1 ? peer.changes(from - 1, to) : page,
    ),
  },
  "the feed: a through past the range": {
    doc: "scripts",
    says: /the page's through \d+ lies outside/,
    store: records((page, from, current) =>
      from < current - 1 ? ok(page.records, page.through + 1) : page,
    ),
  },
  "the feed: no progress on a range with records": {
    doc: "scripts",
    says: /the page from \d+ made no progress toward \d+/,
    store: records((page, from, current) => (from < current - 1 ? ok([], from) : page)),
  },
  "the feed: two peers mixed": {
    doc: "scripts",
    says: /the feed of \w+ names \w+, which \w+ never held/,
    store: onePoolOfRecords(),
  },
  "the feed: a record changed after it was written": {
    doc: "scripts",
    says: /the record at revision 1 changed after it was written/,
    store: records((page, _from, current) =>
      ok(
        page.records.map((r) =>
          r.revision === 1 && current >= 3 ? { ...r, head: "rewritten" } : r,
        ),
        page.through,
      ),
    ),
  },
  "the feed: a record that differs from its commit the first time it is seen": {
    doc: "scripts",
    says: /the record at revision \d+ differs from its commit/,
    // The newest record is wrong only in a range of two or more, so the check of its commit,
    // a range of one, sees it right.
    store: records((page, from, current) =>
      from < current - 1
        ? ok(
            page.records.map((r) => (r.revision === current ? { ...r, head: "other" } : r)),
            page.through,
          )
        : page,
    ),
  },
  "the feed: a bounded store that answers ok below its floor": {
    doc: "scripts",
    says: /changes answered ok from \d+, below the retention floor \d+/,
    store: { profile: (p) => ({ ...p, changeRetention: { revisions: 2 } }) },
  },
};

/** A store that hands out the same record objects on every answer, `copy` deciding what else. */
function liveRecords(copy: (r: ChangeRecord) => ChangeRecord): Break {
  const kept = new WeakMap<Store, Map<string, ChangeRecord>>();
  return {
    peer: (peer, inner) => {
      if (!kept.has(inner)) kept.set(inner, new Map());
      const live = kept.get(inner)!;
      return {
        changes: async (from, to) => {
          const page = await peer.changes(from, to);
          if (page.status !== "ok") return page;
          const records = page.records.map((r) => {
            const key = `${peer.id} ${r.revision}`;
            if (!live.has(key)) live.set(key, copy(r));
            return live.get(key)!;
          });
          return ok(records, page.through);
        },
      };
    },
  };
}
/** One pair of id lists per record, shared by every answer; the record objects are new. */
function liveIdLists(): Break {
  const kept = new WeakMap<Store, Map<string, { added: string[]; removed: string[] }>>();
  return {
    peer: (peer, inner) => {
      if (!kept.has(inner)) kept.set(inner, new Map());
      const live = kept.get(inner)!;
      return {
        changes: async (from, to) => {
          const page = await peer.changes(from, to);
          if (page.status !== "ok") return page;
          const records = page.records.map((r) => {
            const key = `${peer.id} ${r.revision}`;
            if (!live.has(key)) live.set(key, { added: [...r.added], removed: [...r.removed] });
            return { ...r, ...live.get(key)! };
          });
          return ok(records, page.through);
        },
      };
    },
  };
}

/** The shared vectors with one script only, and no scope case. */
const onlyScript = (name: string): StoreVectors => ({
  scripts: { ...vectors.scripts, scripts: vectors.scripts.scripts.filter((s) => s.name === name) },
  scope: { ...vectors.scope, cases: [] },
});
/** Says `{revisions: 2}` over a store that keeps every record. */
const declaresTwo: Break = { profile: (p) => ({ ...p, changeRetention: { revisions: 2 } }) };

// Two checks share each of these messages: the check after every step (README §3.9.4) and the
// `changes` step (§3.9.6). Each pair of rows reaches one of them only: a script with no
// `changes` step, and a store that is wrong only when a `to` is given, which the check after
// every step never gives.
const SHARED_MESSAGES: Readonly<Record<string, Rule>> = {
  "the feed: resync-required inside the window, after a step": {
    doc: "scripts",
    says: /every record after \d+ is retained/,
    store: feed((page, from, _to, current) =>
      from < current - 1 ? { status: "resync-required", current } : page,
    ),
    vectors: onlyScript("duplicates-add-nothing"),
  },
  "the feed: resync-required inside the window, in a changes step with a to": {
    doc: "scripts",
    says: /\(changes\): changes answered resync-required from \d+, and every record/,
    store: feed((page, from, to, current) =>
      to !== undefined && from < current - 1 ? { status: "resync-required", current } : page,
    ),
  },
  "the feed: ok below the floor, after a step": {
    doc: "scripts",
    says: /changes answered ok from \d+, below the retention floor \d+/,
    store: declaresTwo,
    vectors: onlyScript("duplicates-add-nothing"),
  },
  "the feed: ok below the floor, in a changes step with a to": {
    doc: "scripts",
    says: /\(changes\): changes answered ok from \d+, below the retention floor \d+/,
    store: {
      ...declaresTwo,
      ...feed((page, from, to, current) =>
        to === undefined && from < current - 2 ? { status: "resync-required", current } : page,
      ),
    },
  },
};

const SHAPES_AND_SPARSE: Readonly<Record<string, Rule>> = {
  "the feed: a record with an extra field that carries bytes": {
    doc: "scripts",
    says: "a change record has the keys added, deltas, head, removed, revision, not added, head, removed, revision",
    store: records((page) =>
      ok(
        page.records.map((r) => ({ ...r, deltas: [{ bytes: new Uint8Array([1]) }] })),
        page.through,
      ),
    ),
  },
  "the feed: an ok page with an extra field": {
    doc: "scripts",
    says: "a change page has the keys more, records, status, through, not records, status, through",
    store: records((page) => ({ ...page, more: true }) as ChangePage),
  },
  "the feed: a resync answer with an extra field": {
    doc: "scripts",
    says: "a resync answer has the keys current, floor, status, not current, status",
    store: feed((page) =>
      page.status === "resync-required" ? ({ ...page, floor: 0 } as ChangePage) : page,
    ),
  },
  "the feed: a store that hands out its live records": {
    doc: "scripts",
    says: "changes answered differently after the caller changed what it returned",
    store: liveRecords((r) => ({ ...r, added: [...r.added], removed: [...r.removed] })),
  },
  "the feed: a store that hands out its live id lists": {
    doc: "scripts",
    says: "changes answered differently after the caller changed what it returned",
    store: liveIdLists(),
  },
  "the feed: sparse revisions, and a partial page whose through is past its last record": {
    doc: "scripts",
    says: /the page's through \d+ is past its last record and short of \d+/,
    store: { options: { changePageSize: 1 }, ...sparse(2, { partialThroughPlusOne: true }) },
  },
  "the feed: sparse revisions, and the floor read as just before the oldest kept record": {
    doc: "scripts",
    says: /changes answered resync-required from \d+, above the retention floor \d+/,
    store: {
      options: { changeRetention: { revisions: 2 } },
      ...sparse(3, { oldestKeptFloor: true }),
    },
  },
};

const RULES: Readonly<Record<string, Rule>> = {
  ...SHARED_MESSAGES,
  ...SHAPES_AND_SPARSE,
  ...FEED_RULES,
  // -- refusals (README §3, "Refusals") --
  "createPeer refuses with a code the step does not list": {
    doc: "scripts",
    says: "(createPeer): refused with invalid-request, expected peer-exists",
    store: {
      store: (store) => ({
        createPeer: (id, options) =>
          recoded("peer-exists", "invalid-request", () => store.createPeer(id, options)),
      }),
    },
  },
  "createPeer refuses a two-cause step with a code outside its list": {
    doc: "scripts",
    says: "(createPeer): refused with invalid-request, expected posture-refused or peer-exists",
    store: {
      store: (store) => ({
        createPeer: async (id, options) => {
          if (options.erasure === "proven")
            await recoded("posture-refused", "invalid-request", () =>
              store.createPeer(id, options),
            );
          return store.createPeer(id, options);
        },
      }),
    },
    vectors: {
      ...vectors,
      scripts: {
        ...vectors.scripts,
        scripts: vectors.scripts.scripts.filter((s) => s.name === "requests-a-store-refuses"),
      },
    },
  },
  "openPeer refuses with a code the step does not list": {
    doc: "scripts",
    says: "(openPeer): refused with invalid-request, expected peer-absent",
    store: {
      store: (store) => ({
        peer: (id) => recoded("peer-absent", "invalid-request", () => store.peer(id)),
      }),
    },
  },
  "append refuses with a code the step does not list": {
    doc: "scripts",
    says: "(append): refused with invalid-request, expected invalid-admission",
    store: {
      peer: (peer) => ({
        append: (batch) =>
          recoded("invalid-admission", "invalid-request", () => peer.append(batch)),
      }),
    },
  },
  "a query refuses with a code the step does not list": {
    doc: "scripts",
    says: /\((targets|get|arrivals|negators|scope)\): refused with store-closed, expected snapshot-released/,
    store: {
      snapshot: queries((run) => recoded("snapshot-released", "store-closed", run)),
    },
  },
  "export refuses with a code the step does not list": {
    doc: "scripts",
    says: "(export): refused with invalid-request, expected peer-absent",
    store: exporter((listing) => ({
      ids: () =>
        (async function* () {
          yield* await recoded("peer-absent", "invalid-request", async () => {
            const ids: string[] = [];
            for await (const id of listing.ids()) ids.push(id);
            return ids;
          });
        })(),
    })),
  },
  "a moved snapshot refuses with a code that is not snapshot-moved": {
    doc: "scripts",
    says: /the query refused with snapshot-released, and only snapshot-moved or an answer conforms/,
    store: {
      snapshot: queries((run) => recoded("snapshot-moved", "snapshot-released", run)),
    },
  },
  "a current snapshot refuses a query": {
    doc: "scripts",
    says: "(targets): the query refused with snapshot-moved, and it must answer",
    store: {
      snapshot: () => ({
        targets: async () => {
          throw new StoreError("snapshot-moved", "never moved");
        },
      }),
    },
  },
  "a released snapshot answers": {
    doc: "scripts",
    says: "expected a refusal: snapshot-released",
    store: { snapshot: () => ({ release: () => {} }) },
  },

  // -- createPeer and openPeer (§3.1, §3.2) --
  "createPeer refuses a peer it must create": {
    doc: "scripts",
    says: "(createPeer): expected the peer to be created",
    store: {
      store: (store) => {
        let created = 0;
        return {
          createPeer: async (id, options) => {
            if (created++ > 0) throw new StoreError("peer-exists", "one peer only");
            return store.createPeer(id, options);
          },
        };
      },
    },
  },
  "a store of class proven refuses the proven-posture peer": {
    doc: "scripts",
    says: "(createPeer): expected the peer to be created",
    store: provenClass,
    vectors: {
      ...vectors,
      scripts: {
        ...vectors.scripts,
        scripts: vectors.scripts.scripts.filter((s) => s.name === "peers-and-postures"),
      },
    },
  },
  "a store of class unprovable creates the proven-posture peer": {
    doc: "scripts",
    says: "(createPeer): expected a refusal: posture-refused",
    store: {
      store: (store) => ({
        createPeer: async (id, options) => {
          const peer = await store.createPeer(id, { erasure: "unproven" });
          return { ...peer, erasure: { ...peer.erasure, posture: options.erasure } };
        },
      }),
    },
  },
  "createPeer creates a peer it must refuse": {
    doc: "scripts",
    says: "(createPeer): expected a refusal: peer-exists",
    store: {
      store: (store) => ({
        createPeer: (id, options) =>
          store.createPeer(id, options).catch((error: unknown) => {
            if (codeOf(error) === "peer-exists") return store.peer(id);
            throw error;
          }),
      }),
    },
  },
  "a created handle reports another posture": {
    doc: "scripts",
    says: "(createPeer): the peer's posture differs",
    store: {
      store: (store) => ({
        createPeer: async (id, options) => {
          const peer = await store.createPeer(id, options);
          return { ...peer, erasure: { ...peer.erasure, posture: "proven" } };
        },
      }),
    },
  },
  "a created handle reports another erasure class than the profile": {
    doc: "scripts",
    says: "(createPeer): the peer did not record its store's erasure class",
    store: {
      store: (store) => ({
        createPeer: async (id, options) => {
          const peer = await store.createPeer(id, options);
          return { ...peer, erasure: { ...peer.erasure, storeClass: "proven" } };
        },
      }),
    },
  },
  "openPeer refuses a peer that exists": {
    doc: "scripts",
    says: "(openPeer): expected the peer to open",
    store: {
      store: () => ({
        peer: async () => {
          throw new StoreError("peer-absent", "never opens");
        },
      }),
    },
  },
  "openPeer creates the peer it must refuse": {
    doc: "scripts",
    says: "(openPeer): expected a refusal: peer-absent",
    store: {
      store: (store) => ({
        peer: (id) => store.peer(id).catch(() => store.createPeer(id, { erasure: "unproven" })),
      }),
    },
  },
  "an opened handle reports another posture": {
    doc: "scripts",
    says: "(openPeer): the posture differs",
    store: {
      store: (store) => ({
        peer: async (id) => {
          const peer = await store.peer(id);
          return { ...peer, erasure: { ...peer.erasure, posture: "proven" } };
        },
      }),
    },
  },

  // -- append (§3.3) --
  "append commits what it must refuse": {
    doc: "scripts",
    says: "(append): expected a refusal: capability-absent",
    store: { peer: (peer) => ({ append: (batch) => peer.append({ ...batch, frame: null }) }) },
  },
  "append refuses what it must commit": {
    doc: "scripts",
    says: "(append): the append refused",
    store: {
      peer: (peer) => ({
        append: async (batch) => {
          if (batch.added.length > 1) throw new StoreError("invalid-admission", "too many");
          return peer.append(batch);
        },
      }),
    },
  },
  "append commits against a stale head": {
    doc: "scripts",
    says: "(append): the append answered committed",
    store: {
      peer: (peer) => ({
        append: async (batch) => peer.append({ ...batch, expectedHead: (await peer.read()).head }),
      }),
    },
  },
  "append answers conflict where it must commit": {
    doc: "scripts",
    says: "(append): the append answered conflict",
    store: {
      peer: (peer) => ({
        append: async (batch) =>
          batch.expectedHead === null ? peer.append(batch) : { status: "conflict" },
      }),
    },
  },
  "append answers uncertain": {
    doc: "scripts",
    says: "(append): the append answered uncertain",
    store: append((result) =>
      result.status === "committed" ? { status: "uncertain", fault: "test" } : result,
    ),
  },
  "append reports ids it did not add": {
    doc: "scripts",
    says: "(append): added [",
    store: {
      peer: (peer) => ({
        append: async (batch) => {
          const result = await peer.append(batch);
          return result.status === "committed"
            ? { ...result, added: [...new Set(batch.added.map((a) => a.delta.id))].sort() }
            : result;
        },
      }),
    },
  },
  "append lists the added ids in descending order": {
    doc: "scripts",
    says: "(append): added [",
    store: append((result) =>
      result.status === "committed" ? { ...result, added: reversed(result.added) } : result,
    ),
  },
  "a refused append moves the revision": {
    doc: "scripts",
    says: "(append): a refused append moved the revision",
    store: revisions({ append: (outcome) => (outcome === "refused" ? 1 : 0) }),
  },
  "a refused append moves the revision down": {
    doc: "scripts",
    says: "(append): a refused append moved the revision",
    store: revisions({ append: (outcome) => (outcome === "refused" ? -1 : 0) }),
  },
  "a conflict moves the revision": {
    doc: "scripts",
    says: "(append): an append that did not commit moved the revision",
    store: revisions({ append: (outcome) => (outcome === "conflict" ? 1 : 0) }),
  },
  "a conflict moves the revision down": {
    doc: "scripts",
    says: "(append): an append that did not commit moved the revision",
    store: revisions({ append: (outcome) => (outcome === "conflict" ? -1 : 0) }),
  },
  "an append result states a revision that is not the peer's": {
    doc: "scripts",
    says: "(append): the append result's revision is not the peer's",
    store: revisions({ reported: { append: 1 } }),
  },
  "an append that changes nothing advances the revision": {
    doc: "scripts",
    says: "(append): the revision advanced",
    store: revisions({
      append: (outcome, advanced) => (outcome === "committed" && !advanced ? 1 : 0),
    }),
  },
  "an append that adds an id does not advance the revision": {
    doc: "scripts",
    says: "(append): the revision did not advance",
    store: revisions({
      append: (outcome, advanced) => (outcome === "committed" && advanced ? -1 : 0),
    }),
  },
  "the last entry of a batch with one id is the one held, not the first": {
    doc: "scripts",
    says: /\((get|arrivals|scope|export)\): .*(the signature differs|carries another arrival record)/,
    store: {
      peer: (peer) => ({
        append: (batch) => peer.append({ ...batch, added: reversed(batch.added) }),
      }),
    },
  },

  // -- purge (§3.4) --
  "purge refuses on a store that offers it": {
    doc: "scripts",
    says: "(purge): the purge refused with capability-absent",
    store: {
      peer: () => ({
        purge: async () => {
          throw new StoreError("capability-absent", "no purge after all");
        },
      }),
    },
  },
  "purge reports an outcome the step does not expect": {
    doc: "scripts",
    says: "(purge): purge targets",
    store: purge((report) => ({
      ...report,
      targets: report.targets.map((t) =>
        t.outcome === "held-by-other-peer" ? { ...t, outcome: "removed" } : t,
      ),
    })),
  },
  "purge lists its targets in descending order": {
    doc: "scripts",
    says: "(purge): purge targets",
    store: purge((report) => ({ ...report, targets: reversed(report.targets) })),
  },
  "purge lists a repeated id twice": {
    doc: "scripts",
    says: "(purge): purge targets",
    store: purge((report, ids) => ({
      ...report,
      targets: [...ids].sort().map((id) => report.targets.find((t) => t.id === id)!),
    })),
  },
  "a purge report states a revision that is not the peer's": {
    doc: "scripts",
    says: "(purge): the purge report's revision is not the peer's",
    store: revisions({ reported: { purge: 1 } }),
  },
  "a purge that removes nothing advances the revision": {
    doc: "scripts",
    says: "(purge): the revision advanced",
    store: revisions({ purge: (advanced) => (advanced ? 0 : 1) }),
  },
  "a purge that removes an id does not advance the revision": {
    doc: "scripts",
    says: "(purge): the revision did not advance",
    store: revisions({ purge: (advanced) => (advanced ? -1 : 0) }),
  },
  "a purge report without its boundary": {
    doc: "scripts",
    says: "(purge): the report does not state its boundary",
    store: purge((report) => ({ ...report, boundary: "" }) as unknown as PurgeReport),
  },
  "a purge report with another boundary text": {
    doc: "scripts",
    says: "(purge): the report does not state its boundary",
    store: purge(
      (report) => ({ ...report, boundary: "Store-Controlled-Surfaces" }) as unknown as PurgeReport,
    ),
  },
  "a purge that claims unproven when it removed nothing": {
    doc: "scripts",
    says: "(purge): the report claims unproven, expected nothing-removed",
    store: purge((report) => ({ ...report, claim: "unproven" })),
  },
  "a purge that claims nothing-removed when it removed a target": {
    doc: "scripts",
    says: "(purge): the report claims nothing-removed, expected unproven",
    store: purge((report) => ({ ...report, claim: "nothing-removed" })),
  },
  "a purge that claims proven on a store of class unprovable": {
    doc: "scripts",
    says: "(purge): the report claims proven, expected unproven on a store of class unprovable",
    store: purge((report) => ({
      ...report,
      claim: report.claim === "unproven" ? "proven" : report.claim,
    })),
  },
  "a store of class proven claims proven where nothing was removed": {
    doc: "scripts",
    says: "(purge): the report claims proven, expected nothing-removed on a store of class proven",
    store: join(provenClass, {
      peer: (peer) => ({
        erasure: { ...peer.erasure, storeClass: "proven" },
        purge: async (ids) => {
          const report = await peer.purge(ids);
          return {
            ...report,
            surfaces: report.surfaces.filter((s) => s.state === "absent"),
            claim: "proven",
          };
        },
      }),
    }),
  },
  "a store of class proven claims proven with a surface that is not absent": {
    doc: "scripts",
    says: "(purge): the report claims proven without surfaces that are all absent",
    store: join(provenClass, {
      peer: (peer) => ({
        erasure: { ...peer.erasure, storeClass: "proven" },
        purge: async (ids) => {
          const report = await peer.purge(ids);
          return { ...report, claim: report.claim === "unproven" ? "proven" : report.claim };
        },
      }),
    }),
  },
  "a store of class proven claims proven with no surface": {
    doc: "scripts",
    says: "(purge): the report claims proven without surfaces that are all absent",
    store: join(provenClass, {
      peer: (peer) => ({
        erasure: { ...peer.erasure, storeClass: "proven" },
        purge: async (ids) => {
          const report = await peer.purge(ids);
          return {
            ...report,
            surfaces: [],
            claim: report.claim === "unproven" ? "proven" : report.claim,
          };
        },
      }),
    }),
  },
  "a surface in a state that is not one of the three": {
    doc: "scripts",
    says: "(purge): a surface reports an unknown state",
    store: join(
      other,
      purge(
        (report) =>
          ({
            ...report,
            surfaces: report.surfaces.map((s) => ({ ...s, state: "gone" })),
          }) as unknown as PurgeReport,
      ),
    ),
  },
  "the reference store lists other surfaces": {
    doc: "scripts",
    says: "(purge): the reference store's surfaces differ",
    store: purge((report) => ({ ...report, surfaces: reversed(report.surfaces) })),
  },
  "the reference store reports another surface state": {
    doc: "scripts",
    says: "(purge): the reference store's surfaces differ",
    store: purge((report) => ({
      ...report,
      surfaces: report.surfaces.map((s) => ({ ...s, state: "unprovable" })),
    })),
  },
  "a store of class none answers a purge": {
    doc: "scripts",
    says: "(purge): the vector's purge claim has no entry for erasure class none",
    store: {
      profile: (p) => ({ ...p, capabilities: { ...p.capabilities, erasure: "none" } }),
      peer: (peer) => ({ erasure: { ...peer.erasure, storeClass: "none" } }),
    },
    vectors: {
      ...vectors,
      scripts: {
        ...vectors.scripts,
        scripts: [
          {
            name: "a-purge-nobody-skips",
            spec: "README §1.3",
            requires: [],
            steps: [
              { op: "createPeer", peer: "A", erasure: "unproven", expect: { status: "created" } },
              {
                op: "purge",
                peer: "A",
                ids: [],
                expect: {
                  targets: [],
                  revisionAdvanced: false,
                  claim: { unprovable: "nothing-removed", proven: "nothing-removed" },
                  referenceSurfaces: [],
                },
              },
            ],
          },
        ],
      },
    },
  },
  "an arrival record that outlives a purge: the runner's books forget a purged id": {
    doc: "scripts",
    says: /\((arrivals|scope)\): .*carries another arrival record/,
    store: stale(() => false),
  },
  "an arrival record that outlives a held-by-other-peer purge only": {
    doc: "scripts",
    says: /\((arrivals|scope)\): .*carries another arrival record/,
    store: stale((outcome) => outcome !== "held-by-other-peer"),
  },
  "an arrival record that outlives a settled debt": {
    doc: "scripts",
    says: /\((arrivals|scope)\): .*carries another arrival record/,
    store: staleAfterSettledDebt(),
  },

  // -- snapshot fields (§3.6) --
  "a snapshot with another head": {
    doc: "scripts",
    says: "(head): the head is",
    store: { snapshot: (s) => ({ head: s.head === null ? "none" : null }) },
  },
  "a new peer's head is the empty string, not null": {
    doc: "scripts",
    says: "(head): the head is ",
    store: { snapshot: (s) => ({ head: s.head ?? "" }) },
  },
  "a snapshot that counts one too many": {
    doc: "scripts",
    says: "(count): the snapshot counts",
    store: { snapshot: (s) => ({ count: s.count + 1 }) },
  },

  // -- point queries (§3.7) --
  "get in descending order": {
    doc: "scripts",
    says: "(get): get answered [",
    store: get(reversed),
  },
  "get drops the signature": {
    doc: "scripts",
    says: /\(get\): delta \S+: the signature differs/,
    store: get((deltas) => deltas.map(unsigned)),
  },
  "get returns other claims under the id": {
    doc: "scripts",
    says: /\(get\): delta \S+: the claims differ/,
    store: get((deltas) => deltas.map(otherClaims)),
  },
  "arrivals in descending order": {
    doc: "scripts",
    says: "(arrivals): arrivals answered [",
    store: { snapshot: (s) => ({ arrivals: async (ids) => reversed(await s.arrivals(ids)) }) },
  },
  "arrivals with a shifted sequence": {
    doc: "scripts",
    says: /\(arrivals\): \S+ carries another arrival record/,
    store: {
      snapshot: (s) => ({
        arrivals: async (ids) =>
          (await s.arrivals(ids)).map((a) => ({ ...a, sequence: a.sequence + 1 })),
      }),
    },
  },
  "arrivals with another sender": {
    doc: "scripts",
    says: /\(arrivals\): \S+ carries another arrival record/,
    store: {
      snapshot: (s) => ({
        arrivals: async (ids) => (await s.arrivals(ids)).map((a) => ({ ...a, sender: "x" })),
      }),
    },
  },
  "arrivals with another time": {
    doc: "scripts",
    says: /\(arrivals\): \S+ carries another arrival record/,
    store: {
      snapshot: (s) => ({
        arrivals: async (ids) => (await s.arrivals(ids)).map((a) => ({ ...a, at: a.at + 0.5 })),
      }),
    },
  },
  "arrivals with another transfer": {
    doc: "scripts",
    says: /\(arrivals\): \S+ carries another arrival record/,
    store: {
      snapshot: (s) => ({
        arrivals: async (ids) =>
          (await s.arrivals(ids)).map((a) => ({ ...a, transfer: a.transfer + 1 })),
      }),
    },
  },
  "targets in descending order": {
    doc: "scripts",
    says: "(targets): targets answered [",
    store: { snapshot: (s) => ({ targets: async (e) => reversed(await s.targets(e)) }) },
  },
  "negators in descending order": {
    doc: "scripts",
    says: "(negators): negators answered [",
    store: { snapshot: (s) => ({ negators: async (ids) => reversed(await s.negators(ids)) }) },
  },

  // -- scope members and bounds in a script (§3.7) --
  "scope members in descending order": {
    doc: "scripts",
    says: "(scope): scope members are not ascending and distinct",
    store: join(other, { snapshot: scope(members(reversed)) }),
  },
  "a scope member listed twice": {
    doc: "scripts",
    says: "(scope): scope members are not ascending and distinct",
    store: join(other, { snapshot: scope(members((d) => [...d.slice(0, 1), ...d])) }),
  },
  "a scope member with other claims under its id": {
    doc: "scripts",
    says: "(scope): a scope member's claims differ",
    store: {
      snapshot: scope(members((d) => d.map((m) => ({ ...m, delta: otherClaims(m.delta) })))),
    },
  },
  "a scope member with the arrival record of another id": {
    doc: "scripts",
    says: "(scope): a scope member carries another id's arrival",
    store: {
      snapshot: scope(
        members((d) =>
          d.map((m, i) => ({
            ...m,
            arrival: { ...m.arrival, id: d[(i + 1) % d.length]!.delta.id },
          })),
        ),
      ),
    },
    // One member cannot carry another member's id. This script has scopes of several.
    vectors: {
      ...vectors,
      scripts: {
        ...vectors.scripts,
        scripts: vectors.scripts.scripts.filter((s) => s.name === "negation-chains"),
      },
    },
  },
  "a scope member with a shifted arrival sequence": {
    doc: "scripts",
    says: /\(scope\): \S+ carries another arrival record/,
    store: {
      snapshot: scope(
        members((d) =>
          d.map((m) => ({ ...m, arrival: { ...m.arrival, sequence: m.arrival.sequence + 1 } })),
        ),
      ),
    },
  },
  "a scope member without the signature it was admitted with": {
    doc: "scripts",
    says: "(scope): a scope member carries another appearance's signature",
    store: { snapshot: scope(members((d) => d.map((m) => ({ ...m, delta: unsigned(m.delta) })))) },
  },
  "a scope member the peer does not hold": {
    doc: "scripts",
    says: /\(scope\): the store answered for \S+, not held/,
    store: join(other, {
      snapshot: scope(async (result, s, peer, inner) => {
        // Every delta another peer holds and this one does not, under a made-up arrival.
        const strangers: VerifiedDelta[] = [];
        const admin = inner.openAdmin();
        for await (const id of admin.peers())
          if (id !== peer.id)
            for await (const delta of admin.peer(id).deltas())
              if ((await s.get([delta.id])).length === 0)
                strangers.push({
                  delta,
                  arrival: { id: delta.id, at: 1, sequence: 1, transfer: 1, sender: "x" },
                });
        const all = new Map([...result.deltas, ...strangers].map((m) => [m.delta.id, m]));
        return { ...result, deltas: [...all.keys()].sort().map((id) => all.get(id)!) };
      }),
    }),
  },
  "applied reports a field nobody asked for": {
    doc: "scripts",
    says: "(scope): applied reports arrivalAtMost, which was not requested",
    store: join(other, {
      snapshot: scope(async (result) => ({
        ...result,
        applied: { ...result.applied, arrivalAtMost: true },
      })),
    }),
  },
  "the reference store reports a field not applied that its profile offers": {
    doc: "scripts",
    says: "(scope): the reference store must apply",
    store: {
      snapshot: scope(async (result) => ({
        ...result,
        applied: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
      })),
    },
  },
  "the reference store applies a field its profile does not offer": {
    doc: "scripts",
    says: "(scope): the reference store must apply",
    store: {
      profile: (p) => ({ ...p, pushdown: { ...p.pushdown, timestampAtMost: false } }),
    },
  },
  "a scope in a script that lacks a member of the lower bound": {
    doc: "scripts",
    says: /\(scope\): scope \[.*\] lacks a member of/,
    store: join(other, { snapshot: scope(members((d) => d.slice(1))) }),
  },
  "a scope in a script that leaves the upper bound": {
    doc: "scripts",
    says: /\(scope\): scope \[.*\] leaves the upper bound/,
    store: join(other, {
      snapshot: scope(async (result, s, peer, inner) => {
        // Everything the peer holds, in scope or not.
        const held: Delta[] = [];
        for await (const delta of inner.openAdmin().peer(peer.id).deltas()) held.push(delta);
        const arrivals = await s.arrivals(held.map((d) => d.id));
        return { ...result, deltas: held.map((delta, i) => ({ delta, arrival: arrivals[i]! })) };
      }),
    }),
  },
  "a scope in a script that answers with every holding when nothing is in scope": {
    doc: "scripts",
    says: /\(scope\): scope \[.+\] leaves the upper bound/,
    store: join(other, {
      snapshot: scope(async (result, s, peer, inner) => {
        if (result.deltas.length > 0) return result;
        const held: Delta[] = [];
        for await (const delta of inner.openAdmin().peer(peer.id).deltas()) held.push(delta);
        const arrivals = await s.arrivals(held.map((d) => d.id));
        return { ...result, deltas: held.map((delta, i) => ({ delta, arrival: arrivals[i]! })) };
      }),
    }),
  },
  "the reference store returns ids the read excluded, in a script": {
    doc: "scripts",
    says: "(scope): the reference store answered",
    store: {
      snapshot: scope(async (result) => result, withoutExclude),
    },
  },
  "the reference store ignores exclude only when no pushdown is asked, in a script": {
    doc: "scripts",
    says: "(scope): the reference store answered",
    store: {
      snapshot: scope(
        async (result) => result,
        (request) => (request.pushdown === undefined ? withoutExclude(request) : request),
      ),
    },
  },

  // -- export (§3.8) --
  "export of an absent peer lists nothing instead of refusing": {
    doc: "scripts",
    says: "(export): expected a refusal: peer-absent",
    store: exporter((listing) => ({
      ids: () =>
        (async function* () {
          try {
            yield* listing.ids();
          } catch {
            // An absent peer reads as an empty one.
          }
        })(),
      deltas: () =>
        (async function* () {
          try {
            yield* listing.deltas();
          } catch {
            // The same.
          }
        })(),
    })),
  },
  "export refuses for a peer that exists": {
    doc: "scripts",
    says: "(export): the export refused",
    store: exporter(() => ({
      ids: () =>
        // eslint-disable-next-line require-yield
        (async function* (): AsyncGenerator<string> {
          throw new StoreError("peer-absent", "never lists");
        })(),
    })),
  },
  "export lists the whole store for one peer": {
    doc: "scripts",
    says: "(export): export ids [",
    store: exporter((_listing, admin) => ({ ids: () => admin.storedIds() })),
  },
  "export lists ids in descending order": {
    doc: "scripts",
    says: "(export): export ids [",
    store: exporter((listing) => ({ ids: () => listed(listing.ids(), reversed) })),
  },
  "export yields fewer deltas than ids": {
    doc: "scripts",
    says: "(export): export deltas and ids disagree",
    store: exporter((listing) => ({ deltas: () => listed(listing.deltas(), (d) => d.slice(1)) })),
  },
  "export yields more deltas than ids": {
    doc: "scripts",
    says: "(export): export deltas and ids disagree",
    store: exporter((listing) => ({
      deltas: () => listed(listing.deltas(), (d) => [...d, ...d.slice(-1)]),
    })),
  },
  "export yields deltas in another order than ids": {
    doc: "scripts",
    says: /\(export\): expected delta \S+, got id/,
    store: exporter((listing) => ({ deltas: () => listed(listing.deltas(), reversed) })),
  },
  "export drops the signature": {
    doc: "scripts",
    says: /\(export\): delta \S+: the signature differs/,
    store: exporter((listing) => ({
      deltas: () => listed(listing.deltas(), (d) => d.map(unsigned)),
    })),
  },
  "export yields other claims under an id": {
    doc: "scripts",
    says: /\(export\): delta \S+: the claims differ/,
    store: exporter((listing) => ({
      deltas: () => listed(listing.deltas(), (d) => d.map(otherClaims)),
    })),
  },
  "the stored listing repeats an id two peers hold": {
    doc: "scripts",
    says: "(exportStored): the store keeps [",
    store: {
      store: (_store, inner) => ({
        openAdmin: () => {
          const admin = inner.openAdmin();
          return {
            ...admin,
            async *storedIds() {
              const ids: string[] = [];
              for await (const peer of admin.peers())
                for await (const id of admin.peer(peer).ids()) ids.push(id);
              yield* ids.sort();
            },
          };
        },
      }),
    },
  },
  "the stored listing is in descending order": {
    doc: "scripts",
    says: "(exportStored): the store keeps [",
    store: {
      store: (_store, inner) => ({
        openAdmin: () => {
          const admin = inner.openAdmin();
          return { ...admin, storedIds: () => listed(admin.storedIds(), reversed) };
        },
      }),
    },
  },
  "peers are listed in descending order": {
    doc: "scripts",
    says: "(exportPeers): the store lists peers",
    store: {
      store: (_store, inner) => ({
        openAdmin: () => {
          const admin = inner.openAdmin();
          return { ...admin, peers: () => listed(admin.peers(), reversed) };
        },
      }),
    },
  },

  // -- a scope case (§4) --
  "a scope case: members in descending order": {
    doc: "scope",
    says: "scope members are not ascending and distinct",
    store: join(other, { snapshot: scope(members(reversed)) }),
  },
  "a scope case: a member with a shifted arrival sequence": {
    doc: "scope",
    says: "carries another arrival record",
    store: {
      snapshot: scope(
        members((d) =>
          d.map((m) => ({ ...m, arrival: { ...m.arrival, sequence: m.arrival.sequence + 1 } })),
        ),
      ),
    },
  },
  "a scope case: applied reports a field outside the pushed-down subset": {
    doc: "scope",
    says: /applied reports \w+, which was not requested/,
    store: join(other, {
      snapshot: scope(async (result) => ({
        ...result,
        applied: { timestampAtMost: true, arrivalAtMost: true, excludeIds: true },
      })),
    }),
  },
  "a scope case: the reference store reports a field not applied": {
    doc: "scope",
    says: "the reference store must apply",
    store: {
      snapshot: scope(async (result) => ({
        ...result,
        applied: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
      })),
    },
  },
  "a scope case: the lower bound, where the residual selection would hide the omission": {
    doc: "scope",
    says: /pushdown \{\}: scope \[.*\] lacks a member of/,
    // Asked for no pushdown, this store leaves out its latest member. The trimmed scope under
    // a signed-time cut is still right, so only the lower bound can see it.
    store: join(other, {
      snapshot: (s) => ({
        scope: async (request) => {
          const result = await s.scope(request);
          if (request.pushdown !== undefined) return result;
          const latest = Math.max(...result.deltas.map((d) => d.delta.claims.timestamp));
          return {
            ...result,
            deltas: result.deltas.filter((d) => d.delta.claims.timestamp !== latest),
          };
        },
      }),
    }),
  },
  "a scope case: the lower bound, a store that leaves out the first id": {
    doc: "scope",
    says: /pushdown \{\}: scope \[.*\] lacks a member of/,
    // Asked for no pushdown, this store leaves out the first member, which is the first id of
    // the lower bound.
    store: join(other, {
      snapshot: (s) => ({
        scope: async (request) => {
          const result = await s.scope(request);
          if (request.pushdown !== undefined) return result;
          return { ...result, deltas: result.deltas.slice(1) };
        },
      }),
    }),
  },
  "a scope case: a store reports a pushdown applied and returns the wider set": {
    doc: "scope",
    says: "leaves S over the applied selection",
    store: join(other, {
      snapshot: (s) => ({
        scope: async ({ pushdown, ...request }) => ({
          ...(await s.scope(request)),
          applied: {
            timestampAtMost: pushdown?.timestampAtMost !== undefined,
            arrivalAtMost: pushdown?.arrivalAtMost !== undefined,
            excludeIds: pushdown?.excludeIds !== undefined,
          },
        }),
      }),
    }),
  },
  "a scope case: the reference store returns ids the read holds": {
    doc: "scope",
    says: "the reference store answered [",
    store: {
      snapshot: scope(async (result) => result, withoutExclude),
    },
  },
  "a scope case: the peer does not hold what the case says the read holds": {
    doc: "scope",
    says: "the peer does not hold a delta the case holds",
    store: get(() => []),
  },
  "a scope case: the trimmed scope, when the held deltas come back with other claims": {
    doc: "scope",
    says: "the trimmed scope is [",
    store: get((deltas) =>
      deltas.map((d) => ({
        ...d,
        claims: {
          ...d.claims,
          pointers: [{ role: "x", target: { kind: "primitive", value: 1 } }],
        },
      })),
    ),
  },
};

const failuresOf = async (rule: Rule): Promise<string[]> => {
  const error = await runStoreConformance(broken(rule.store), rule.vectors ?? vectors).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "the run must fail").toBeInstanceOf(StoreConformanceError);
  return (error as StoreConformanceError).failures.map((f) => `${f.name}: ${f.message}`);
};
const says = (line: string, rule: Rule): boolean =>
  line.startsWith(`${rule.doc}/`) &&
  (typeof rule.says === "string" ? line.includes(rule.says) : rule.says.test(line));

describe("runner rules: each wrong store fails with the message of its rule", () => {
  for (const [name, rule] of Object.entries(RULES)) {
    it(name, async () => {
      const lines = await failuresOf(rule);
      expect(
        lines.filter((line) => says(line, rule)),
        `no failure in ${rule.doc}/ says ${String(rule.says)}:\n${lines.join("\n")}`,
      ).not.toEqual([]);
    });
  }

  it("the wrapper itself changes nothing, with and without the reference label", async () => {
    for (const fault of [{}, other]) {
      const report = await runStoreConformance(broken(fault), vectors);
      expect(report.skipped).toEqual([]);
      expect(report.passed).toHaveLength(
        vectors.scripts.scripts.length + vectors.scope.cases.length,
      );
    }
  });
});

describe("runner rules: revisions that skip values conform", () => {
  // §4.13 reading 1 asks only for integers in order. These stores are right, with revisions
  // two or three apart; the runner must pass them on every vector, kept whole or bounded.
  const right: Readonly<Record<string, Break>> = {
    "revisions times 2": sparse(2),
    "revisions times 3, pages of one record": { options: { changePageSize: 1 }, ...sparse(3) },
    "revisions times 2, two records kept": {
      options: { changeRetention: { revisions: 2 } },
      ...sparse(2),
    },
    "revisions times 3, two records kept, pages of one record": {
      options: { changeRetention: { revisions: 2 }, changePageSize: 1 },
      ...sparse(3),
    },
  };
  for (const [name, fault] of Object.entries(right))
    it(name, async () => {
      const report = await runStoreConformance(broken(fault), vectors);
      expect(report.skipped).toEqual([]);
      expect(report.passed).toHaveLength(
        vectors.scripts.scripts.length + vectors.scope.cases.length,
      );
    });
});

describe("runner rules: what binds the reference store only", () => {
  // The same wrong answers under another format version are right answers: a store may ignore
  // `exclude`, may report a field not applied, and declares its own surfaces.
  const allowed: Readonly<Record<string, Break>> = {
    "returning ids the read excluded": {
      snapshot: scope(async (result) => result, withoutExclude),
    },
    "reporting no field applied": {
      snapshot: scope(async (result) => ({
        ...result,
        applied: { timestampAtMost: false, arrivalAtMost: false, excludeIds: false },
      })),
    },
    "listing other surfaces": purge((report) => ({
      ...report,
      surfaces: [{ surface: "pages", state: "unprovable" }],
    })),
  };
  for (const [name, fault] of Object.entries(allowed)) {
    it(`${name} conforms for a store that is not the reference`, async () => {
      const report = await runStoreConformance(broken(join(other, fault)), vectors);
      expect(report.passed).toHaveLength(
        vectors.scripts.scripts.length + vectors.scope.cases.length,
      );
      await expect(runStoreConformance(broken(fault), vectors)).rejects.toBeInstanceOf(
        StoreConformanceError,
      );
    });
  }
});

describe("runner rules: what the profile makes the runner do", () => {
  const profiled = (change: (p: StoreProfile) => StoreProfile): Break => ({ profile: change });

  it("a store without purge skips exactly the scripts that require it, and runs the rest", async () => {
    const report = await runStoreConformance(
      broken({
        ...profiled((p) => ({ ...p, capabilities: { ...p.capabilities, erasure: "none" } })),
        peer: (peer) => ({ erasure: { ...peer.erasure, storeClass: "none" } }),
      }),
      vectors,
    );
    const needPurge = vectors.scripts.scripts.filter((s) => s.requires?.includes("purge") === true);
    expect(needPurge.length).toBeGreaterThan(0);
    expect(report.skipped).toEqual(
      needPurge.map((s) => ({ name: `scripts/${s.name}`, missing: "purge" })),
    );
    expect(report.passed).toHaveLength(
      vectors.scripts.scripts.length - needPurge.length + vectors.scope.cases.length,
    );
  });

  it("a store with a journal skips exactly the script that needs its absence", async () => {
    const report = await runStoreConformance(
      broken(profiled((p) => ({ ...p, capabilities: { ...p.capabilities, journal: true } }))),
      vectors,
    );
    expect(report.skipped).toEqual([
      { name: "scripts/a-frame-needs-the-journal", missing: "journal-absent" },
    ]);
  });

  it("a store that offers purge and no journal skips nothing", async () => {
    const report = await runStoreConformance(async () => createMemoryStore(), vectors);
    expect(report.skipped).toEqual([]);
    expect(report.passed).toEqual([
      ...vectors.scripts.scripts.map((s) => `scripts/${s.name}`),
      ...vectors.scope.cases.map((c) => `scope/${c.name}`),
    ]);
  });

  it("each script and the scope document get a new store, and each store is closed", async () => {
    let opened = 0;
    let closed = 0;
    const report = await runStoreConformance(async () => {
      opened++;
      const store = createMemoryStore();
      return {
        profile: store.profile,
        createPeer: (id, options) => store.createPeer(id, options),
        peer: (id) => store.peer(id),
        openAdmin: () => store.openAdmin(),
        close: async () => {
          closed++;
          await store.close();
        },
      };
    }, vectors);
    expect(report.skipped).toEqual([]);
    expect(opened).toBe(vectors.scripts.scripts.length + 1);
    expect(closed).toBe(opened);
  });
});

describe("runner rules: a wrong document", () => {
  const memory = async (): Promise<Store> => createMemoryStore();
  const script = vectors.scripts.scripts.find((s) => s.name === "append-and-point-reads")!;
  const only = (steps: StoreVectors["scripts"]["scripts"][number]["steps"]): StoreVectors => ({
    scripts: { ...vectors.scripts, scripts: [{ ...script, steps }] },
    scope: { ...vectors.scope, cases: [] },
  });
  const scopeOnly = (
    change: (c: StoreVectors["scope"]["cases"][number]) => object,
  ): StoreVectors => ({
    scripts: { ...vectors.scripts, scripts: [] },
    scope: {
      ...vectors.scope,
      cases: [
        change(
          vectors.scope.cases.find((c) => c.name === "every-field")!,
        ) as StoreVectors["scope"]["cases"][number],
      ],
    },
  });
  const corpus = (
    change: (d: StoreVectors["scripts"]["deltas"][number]) => object,
  ): StoreVectors => ({
    scripts: {
      ...vectors.scripts,
      deltas: vectors.scripts.deltas.map((d) =>
        d.name === "a-name" ? (change(d) as typeof d) : d,
      ),
      scripts: [script],
    },
    scope: { ...vectors.scope, cases: [] },
  });

  const purgeScript = vectors.scripts.scripts.find(
    (s) => s.name === "purge-clears-a-debt-on-append",
  )!;
  /** The purge script, with the claim of its first purge step replaced. */
  const purgeClaim = (claim: object | null | undefined): StoreVectors => {
    const first = purgeScript.steps.findIndex((step) => step.op === "purge");
    const steps = purgeScript.steps.map((step, i) =>
      i === first && step.op === "purge"
        ? { ...step, expect: { ...step.expect, claim: claim as never } }
        : step,
    );
    return {
      scripts: { ...vectors.scripts, scripts: [{ ...purgeScript, steps }] },
      scope: { ...vectors.scope, cases: [] },
    };
  };
  /** The purge script, with its requirements replaced. */
  const requiring = (requires: unknown): StoreVectors => ({
    scripts: { ...vectors.scripts, scripts: [{ ...purgeScript, requires: requires as never }] },
    scope: { ...vectors.scope, cases: [] },
  });

  const feedScript = vectors.scripts.scripts.find(
    (s) => s.name === "feed-appends-and-head-only-commits",
  )!;
  /** The first `keep` steps of the feed script, then `more`. */
  const feedSteps = (keep: number, ...more: object[]): StoreVectors => ({
    scripts: {
      ...vectors.scripts,
      scripts: [
        {
          ...feedScript,
          steps: [...feedScript.steps.slice(0, keep), ...(more as typeof feedScript.steps)],
        },
      ],
    },
    scope: { ...vectors.scope, cases: [] },
  });
  // Steps 0 to 2: create A (named A.0 by a mark), ask for its empty feed, append (A.1).
  expect(feedScript.steps.slice(0, 3).map((step) => step.op)).toEqual([
    "createPeer",
    "mark",
    "changes",
  ]);

  type Wrong = { vectors: StoreVectors; says: string; store?: () => Promise<Store> };
  const wrong: Readonly<Record<string, Wrong>> = {
    "an unknown scripts format": {
      vectors: { ...vectors, scripts: { ...vectors.scripts, format: "x/1" as never } },
      says: "unknown store scripts format",
    },
    "an unknown scope format": {
      vectors: { ...vectors, scope: { ...vectors.scope, format: "x/1" as never } },
      says: "unknown store scope format",
    },
    "a corpus id that does not recompute and is not marked forged": {
      vectors: corpus((d) => ({ ...d, id: vectors.scripts.deltas[0]!.id })),
      says: "vector delta a-name: id does not recompute",
    },
    "a step that names an unknown delta": {
      vectors: only([
        script.steps[0]!,
        script.steps[1]!,
        script.steps[2]!,
        { op: "get", snapshot: "s", ids: ["nobody"], expect: { deltas: [] } },
      ]),
      says: "the vector names an unknown delta nobody",
    },
    "a step that names an unknown peer": {
      vectors: only([{ op: "exportPeers", expect: { peers: ["Z"] } }]),
      says: "the vector names an unknown peer Z",
    },
    "a step that uses a peer before creating it": {
      vectors: only([{ op: "read", peer: "A", snapshot: "s" }]),
      says: "the vector uses peer A before creating it",
    },
    "a step that uses a snapshot before reading it": {
      vectors: only([{ op: "count", snapshot: "s", expect: { count: 0 } }]),
      says: "the vector uses snapshot s before reading it",
    },
    "a scope case without the scope under its whole selection": {
      vectors: scopeOnly((c) => ({ ...c, scopes: c.scopes.filter((s) => s.fields.length < 3) })),
      says: "the case lacks the scope under its whole selection",
    },
    "a purge claim with a key other than unprovable and proven": {
      vectors: purgeClaim({ unprovable: "unproven", proven: "proven", none: "nothing-removed" }),
      says: "the vector's purge claim has keys none, proven, unprovable, not unprovable and proven",
    },
    "a purge step without a claim": {
      vectors: purgeClaim(undefined),
      says: "the vector's purge claim is missing or not an object, not unprovable and proven",
    },
    "a purge claim that is null": {
      vectors: purgeClaim(null),
      says: "the vector's purge claim is missing or not an object, not unprovable and proven",
    },
    "a purge claim without the key proven": {
      vectors: purgeClaim({ unprovable: "unproven" }),
      says: "the vector's purge claim has keys unprovable, not unprovable and proven",
    },
    "an unknown script requirement": {
      vectors: requiring(["values"]),
      says: "unknown script requirement values",
    },
    "a script requirement list that is not a list": {
      vectors: requiring("purge"),
      says: "the script's requires is not a list",
    },
    "a script requirement list that is null, which is not none": {
      vectors: requiring(null),
      says: "the script's requires is not a list",
    },
    "a changes step that names an unknown revision": {
      vectors: feedSteps(2, { op: "changes", peer: "A", from: { revision: "A.9" }, expect: {} }),
      says: "the vector names an unknown revision A.9",
    },
    "a changes step that names another peer's revision": {
      vectors: feedSteps(
        2,
        { op: "createPeer", peer: "B", erasure: "unproven", expect: { status: "created" } },
        { op: "changes", peer: "B", from: { revision: "A.0" }, expect: {} },
      ),
      says: "the vector names revision A.0 of another peer",
    },
    "a revision named twice": {
      vectors: feedSteps(2, { op: "mark", peer: "A", as: "A.0" }),
      says: "the vector names revision A.0 twice",
    },
    "a mark on a peer not yet created": {
      vectors: feedSteps(0, { op: "mark", peer: "A", as: "x" }),
      says: "the vector uses peer A before creating it",
    },
    "a changes step whose expected records are wrong": {
      vectors: feedSteps(3, {
        op: "changes",
        peer: "A",
        from: { revision: "A.0" },
        expect: {
          status: "ok",
          records: [{ revision: "A.0", head: null, added: [], removed: [] }],
        },
      }),
      says: "changes answered the records of nothing, expected 0",
    },
    "a changes step on a store that serves no feed, in a script that does not require one": {
      vectors: {
        scripts: { ...vectors.scripts, scripts: [{ ...feedScript, requires: [] }] },
        scope: { ...vectors.scope, cases: [] },
      },
      says: "a changes step on a store that serves no feed",
      store: broken({ profile: (p) => ({ ...p, changeRetention: "none" }) }),
    },
    "a profile whose retention is not a retention": {
      vectors: feedSteps(1),
      says: "the profile's changeRetention is not none, unbounded or {revisions: n}",
      store: broken({ profile: (p) => ({ ...p, changeRetention: { revisions: 0 } }) }),
    },
    "a scope case without the scope of an applied subset": {
      vectors: scopeOnly((c) => ({
        ...c,
        scopes: c.scopes.filter((s) => s.fields.length !== 1),
      })),
      says: "the case lacks a scope for the applied fields",
      // Asked for two fields, this store applies one; the document has no scope for it.
      store: async () =>
        createMemoryStore({ pushdown: { arrivalAtMost: false, excludeIds: false } }),
    },
  };
  for (const [name, { vectors: document, says: message, store }] of Object.entries(wrong)) {
    it(name, async () => {
      await expect(runStoreConformance(store ?? memory, document)).rejects.toThrow(message);
    });
  }

  // A wrong `requires` fails its script, as a failure of the run that names the script, and the
  // run still closes that script's store. A runner that read `requires` outside its guard would
  // throw the same text as a raw error and leave the store open.
  for (const [requires, says] of [
    [["values"], "unknown script requirement values"],
    ["purge", "the script's requires is not a list"],
    [null, "the script's requires is not a list"],
  ] as const)
    it(`requires ${JSON.stringify(requires)} fails its script, and the store is closed`, async () => {
      let opened = 0;
      let closed = 0;
      const counted = broken({
        store: (s) => {
          opened++;
          return {
            close: async () => {
              closed++;
              await s.close();
            },
          };
        },
      });
      const failure: unknown = await runStoreConformance(counted, requiring(requires)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(StoreConformanceError);
      expect((failure as StoreConformanceError).failures).toEqual([
        { name: `scripts/${purgeScript.name}`, message: says },
      ]);
      expect([opened, closed]).toEqual([2, 2]);
    });

  it("a script without requires runs on every store, and is not skipped", async () => {
    const bare: typeof purgeScript = { ...purgeScript };
    delete (bare as { requires?: unknown }).requires;
    expect("requires" in bare).toBe(false);
    const report = await runStoreConformance(memory, {
      scripts: { ...vectors.scripts, scripts: [bare] },
      scope: { ...vectors.scope, cases: [] },
    });
    expect(report).toEqual({ passed: [`scripts/${purgeScript.name}`], skipped: [] });
  });

  it("a forged corpus entry is not checked: the documents carry one on purpose", async () => {
    expect(vectors.scripts.deltas.filter((d) => d.forged === true)).toHaveLength(1);
    await expect(runStoreConformance(memory, vectors)).resolves.toBeDefined();
  });
});
