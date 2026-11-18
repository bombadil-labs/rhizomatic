// The memory reference store (SPEC-18 proposal §5.1). Other stores must answer every operation
// with the same ids. Claims are kept once per id and counted by holdings; membership, indexes,
// arrivals, signatures, head and revision are per peer.

import { compareUtf8 } from "../delta/cbor.js";
import { computeId } from "../delta/delta.js";
import type { Claims, Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import {
  EMPTY_DIGEST,
  childrenOf,
  digestRows,
  isDigestPrefix,
  leafHash,
  updateDigest,
  type DigestNode,
  type DigestRow,
  type DigestStore,
} from "./digest.js";
import { copyArrival, copyClaims, isPlainObject, ownFields } from "./copy.js";
import { LOCAL_HISTORY_PREFIX } from "./freshness.js";
import {
  admit,
  strings,
  takeAppend,
  takeAppFormat,
  takeScope,
  wellFormed,
  type OwnScope,
} from "./request.js";
import {
  PURGE_BOUNDARY,
  StoreError,
  StoreIntegrityError,
  type Admission,
  type AppendResult,
  type AppliedPushdown,
  type ChangePage,
  type ChangeRecord,
  type ChangeRetention,
  type CreatePeerOptions,
  type DeleteReport,
  type Entity,
  type ErasureClass,
  type ErasurePosture,
  type Exporter,
  type FsckReport,
  type Head,
  type History,
  type Id,
  type IntegrityFault,
  type PeerId,
  type PeerStore,
  type PurgeOutcome,
  type PurgeReport,
  type Revision,
  type ScopeResult,
  type Snapshot,
  type Store,
  type StoreProfile,
  type VerifiedDelta,
} from "./store.js";

export const MEMORY_STORE_FORMAT = "rhizomatic.store.memory/1";

/**
 * Counts the index work a memory store does. `lookups` is keyed reads and writes, `visited`
 * is members read from an index entry, `scans` is whole-map iterations. Cost rails compare
 * these numbers; they never time anything.
 */
export type StoreMeter = { lookups: number; visited: number; scans: number };

export type MemoryStoreOptions = {
  readonly meter?: StoreMeter;
  /** Pushdown fields this store applies. A field set to false is ignored and reported so. */
  readonly pushdown?: Partial<AppliedPushdown>;
  /**
   * How many change records each peer keeps (§4.6). The default keeps every record. With
   * `{revisions: n}` a peer keeps the records of its latest n revision advances; n is an
   * integer of 1 or more.
   */
  readonly changeRetention?: "unbounded" | { readonly revisions: number };
  /**
   * For tests: at most this many records in one page of `changes`, so a caller's paging runs.
   * An integer of 1 or more. The default has no limit.
   */
  readonly changePageSize?: number;
  /**
   * Mints the history of each peer this store creates (§4.6). The default is unique only within
   * the process (`memory:local:<n>`). With a process-local history, a capture that outlives its
   * process could be judged against another history and answer `current` falsely, which is why
   * `parseCapture` refuses one. A host that keeps captures across a serialization boundary passes
   * a mint unique across processes, such as 128 random bits. A minted history that is empty,
   * starts with `memory:local:`, or repeats one this store has issued to any peer is refused
   * `invalid-request` when the peer is created. The mint runs after every other check of
   * `createPeer`, `peer-exists` included, and takes the peer's id.
   */
  readonly mintHistory?: (peer: PeerId) => History;
};

// The only door to the store's maps. Everything keyed counts a lookup; `scan` is the single way
// to iterate a whole map and it counts, so a core operation that walks a set shows in the meter.
class Index<V> {
  readonly #map = new Map<string, V>();
  readonly #meter: StoreMeter;
  constructor(meter: StoreMeter) {
    this.#meter = meter;
  }
  get(key: string): V | undefined {
    this.#meter.lookups++;
    return this.#map.get(key);
  }
  set(key: string, value: V): void {
    this.#meter.lookups++;
    this.#map.set(key, value);
  }
  delete(key: string): void {
    this.#meter.lookups++;
    this.#map.delete(key);
  }
  scan(): [string, V][] {
    this.#meter.scans++;
    return [...this.#map.entries()].sort(([a], [b]) => compareUtf8(a, b));
  }
}

type Row = { readonly claims: Claims; holders: number };
type Holding = { readonly sig: string | undefined; readonly arrival: ArrivalRecord };

/**
 * One peer's change records. Slots `[start, records.length)` hold the kept records, whose
 * revisions are `floor + 1` up to the peer's revision: this store advances a revision by one,
 * and every advance writes one record. So a revision finds its slot by arithmetic, not by a
 * search. A dropped record leaves an empty slot; the slots are compacted once the empty ones
 * are half the list, so dropping costs O(1) amortized.
 */
type Feed = {
  records: (ChangeRecord | undefined)[];
  start: number;
  /** The revision just before the oldest kept record: a `from` below it cannot be answered. */
  floor: Revision;
};

type PeerState = {
  readonly id: PeerId;
  readonly history: History;
  readonly posture: ErasurePosture;
  readonly appFormat: string | null;
  readonly holdings: Index<Holding>;
  readonly targets: Index<Set<Id>>;
  readonly negators: Index<Set<Id>>;
  /** Ids this peer purged while another peer still held the bytes. */
  readonly owed: Index<true>;
  head: Head | null;
  count: number;
  revision: Revision;
  lastSequence: number;
  /** The highest transfer ordinal of a committed new holding; 0 before the first. */
  lastTransfer: number;
  /** The revision of the last purge that released a holding of this peer; 0 before one. */
  removedAt: Revision;
  readonly feed: Feed;
  /** The holdings digest by prefix (§4.7.6): the root and each node of more than 16 ids' children. */
  readonly digest: Index<DigestRow>;
  root: DigestNode;
  /** Set by `deletePeer`. A snapshot of this state refuses from then on. */
  deleted: boolean;
};

// The default histories: one counter for every memory store in this copy of the module, so two
// peers, two stores, or one name created twice never share one. They are unique only within the
// process, and say so by their prefix: `parseCapture` refuses a capture that carries one. The
// counter is per module copy, not on `globalThis`, which the package boundary forbids; a second
// copy of the module counts again, and a capture from one copy that is checked against the
// other fails `checkFresh`'s own check, because the other copy did not build it.
let minted = 0;
const mintMemoryHistory = (): History => `${LOCAL_HISTORY_PREFIX}${++minted}`;

const sorted = (ids: Iterable<Id>): Id[] => [...new Set(ids)].sort(compareUtf8);

function file(index: Map<string, Set<Id>>, key: string, id: Id): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, new Set([id]));
  else bucket.add(id);
}

function indexKeys(claims: Claims): { entities: Entity[]; negated: Id[] } {
  const entities: Entity[] = [];
  const negated: Id[] = [];
  for (const pointer of claims.pointers) {
    if (pointer.target.kind === "entity") entities.push(pointer.target.entity.id);
    else if (pointer.target.kind === "delta" && pointer.role === "negates")
      negated.push(pointer.target.deltaRef.delta);
  }
  return { entities, negated };
}

class MemoryStore implements Store {
  /** What callers see: a frozen copy. The store never reads it back. */
  readonly profile: StoreProfile;
  // Everything the store decides by is a `#` field: no caller can reach it, also not through
  // a cast. A caller who replaces `profile` must not be able to switch off the posture gate or
  // change what a scope applies, and no caller may reach the stored claims.
  readonly #own: StoreProfile;
  readonly #meter: StoreMeter;
  readonly #rows: Index<Row>;
  readonly #peers: Index<PeerState>;
  /** How many peers owe each id: a purge report names `purge-debt` from it (decision S4-5). */
  readonly #debtors: Index<number>;
  /** The most records a peer keeps; infinite when unbounded. */
  readonly #keep: number;
  readonly #pageSize: number;
  readonly #mint: (peer: PeerId) => History;
  /** Every history this store has issued, kept after its peer is gone: none is issued twice. */
  readonly #issued = new Set<History>();
  #closed = false;

  constructor(options: MemoryStoreOptions) {
    this.#meter = options.meter ?? { lookups: 0, visited: 0, scans: 0 };
    this.#rows = new Index(this.#meter);
    this.#peers = new Index(this.#meter);
    this.#debtors = new Index(this.#meter);
    const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;
    let retention: ChangeRetention = "unbounded";
    const asked = options.changeRetention;
    if (asked !== undefined && asked !== "unbounded") {
      const revisions: unknown = isPlainObject(asked) ? ownFields(asked).revisions : undefined;
      if (!positive(revisions))
        throw new StoreError(
          "invalid-request",
          "memory store: changeRetention is unbounded or {revisions: n} with n of 1 or more",
        );
      retention = { revisions };
    }
    this.#keep = retention === "unbounded" ? Number.POSITIVE_INFINITY : retention.revisions;
    const pageSize = options.changePageSize;
    if (pageSize !== undefined && !positive(pageSize))
      throw new StoreError("invalid-request", "memory store: changePageSize is 1 or more");
    this.#pageSize = pageSize ?? Number.POSITIVE_INFINITY;
    const mint = options.mintHistory;
    if (mint !== undefined && typeof mint !== "function")
      throw new StoreError("invalid-request", "memory store: mintHistory is a function");
    this.#mint = (peer) => {
      const history: unknown = mint === undefined ? mintMemoryHistory() : mint(peer);
      if (typeof history !== "string" || history === "" || !wellFormed(history))
        throw new StoreError(
          "invalid-request",
          "memory store: a history is a non-empty, well-formed string",
        );
      if (mint !== undefined && history.startsWith(LOCAL_HISTORY_PREFIX))
        throw new StoreError(
          "invalid-request",
          `memory store: a minted history must not start with ${LOCAL_HISTORY_PREFIX}, which marks a history local to one process`,
        );
      if (this.#issued.has(history))
        throw new StoreError(
          "invalid-request",
          `memory store: the mint answered ${history}, a history this store already issued; a history is never reused`,
        );
      this.#issued.add(history);
      return history;
    };
    const pushdown = ownFields(options.pushdown);
    this.#own = {
      capabilities: {
        values: false,
        arrival: true,
        journal: false,
        views: false,
        derivedIndexes: false,
        digest: true,
        erasure: "unprovable",
      },
      indexedValueRoles: [],
      pushdown: {
        timestampAtMost: pushdown.timestampAtMost !== false,
        arrivalAtMost: pushdown.arrivalAtMost !== false,
        excludeIds: pushdown.excludeIds !== false,
      },
      writers: "one-process",
      atRest: "trusted",
      changeRetention: retention,
      formatVersion: MEMORY_STORE_FORMAT,
    };
    this.profile = Object.freeze({
      ...this.#own,
      changeRetention: typeof retention === "string" ? retention : Object.freeze({ ...retention }),
      capabilities: Object.freeze({ ...this.#own.capabilities }),
      indexedValueRoles: Object.freeze([...this.#own.indexedValueRoles]),
      pushdown: Object.freeze({ ...this.#own.pushdown }),
    });
  }

  #open(): void {
    if (this.#closed) throw new StoreError("store-closed", "the store is closed");
  }

  async createPeer(id: PeerId, options: CreatePeerOptions): Promise<PeerStore> {
    this.#open();
    if (typeof id !== "string" || id.length === 0 || !wellFormed(id))
      throw new StoreError(
        "invalid-request",
        "createPeer: the peer id must be a non-empty, well-formed string",
      );
    // The options are a plain object, read once. A getter that throws is a posture not
    // declared, as is anything that is not a plain object (a list included).
    let posture: unknown;
    let format: unknown;
    try {
      if (isPlainObject(options)) ({ erasure: posture, appFormat: format } = ownFields(options));
    } catch {
      posture = undefined;
    }
    if (posture !== "proven" && posture !== "unproven")
      throw new StoreError("invalid-request", "createPeer: declare the erasure posture");
    const appFormat = takeAppFormat(format);
    const storeClass: ErasureClass = this.#own.capabilities.erasure;
    if (posture === "proven" && storeClass !== "proven")
      throw new StoreError(
        "posture-refused",
        `createPeer: the peer promises proven erasure and this store's class is ${storeClass}`,
      );
    if (this.#peers.get(id) !== undefined)
      throw new StoreError("peer-exists", "createPeer: the peer already exists");
    const state: PeerState = {
      id,
      history: this.#mint(id),
      posture,
      appFormat,
      holdings: new Index(this.#meter),
      targets: new Index(this.#meter),
      negators: new Index(this.#meter),
      owed: new Index(this.#meter),
      head: null,
      count: 0,
      revision: 0,
      lastSequence: 0,
      lastTransfer: 0,
      removedAt: 0,
      // A new peer's feed is empty, and its floor is its first revision.
      feed: { records: [], start: 0, floor: 0 },
      digest: new Index(this.#meter),
      root: EMPTY_DIGEST,
      deleted: false,
    };
    this.#peers.set(id, state);
    return this.#handle(state);
  }

  async peer(id: PeerId): Promise<PeerStore> {
    this.#open();
    const state = typeof id === "string" ? this.#peers.get(id) : undefined;
    if (state === undefined) throw new StoreError("peer-absent", "peer: no such peer");
    return this.#handle(state);
  }

  #handle(state: PeerState): PeerStore {
    // After `close`, `history` and `appFormat` refuse `store-closed`, as on the SQLite store. A
    // handle names the state it was made for: after `deletePeer` every call refuses
    // `peer-absent`, also when a `createPeer` of the id made a new peer (§4.13 reading 144). As on
    // the SQLite store, a call checks `store-closed`, then the form of its request, then the peer.
    const live = (): PeerState => {
      this.#open();
      if (state.deleted) throw new StoreError("peer-absent", "the peer was deleted");
      return state;
    };
    return {
      id: state.id,
      get history() {
        return live().history;
      },
      erasure: { posture: state.posture, storeClass: this.#own.capabilities.erasure },
      get appFormat() {
        return live().appFormat;
      },
      read: async () => this.#snapshot(live()),
      append: async (batch) => {
        this.#open();
        return this.#append(live, batch);
      },
      purge: async (ids) => {
        this.#open();
        const asked = strings(ids, "purge: ids");
        return this.#purge(live(), asked);
      },
      changes: async (from, to) => {
        this.#open();
        return this.#changes(live, from, to);
      },
    };
  }

  /**
   * The peer delete (§4.13 reading 144), all at once: no writer can come between its steps. A
   * held id without its stored claims, or whose row counts no holder, refuses the delete before
   * it removes anything, as the purge of that id does (reading 136). Process memory cannot prove absence, so the claim is
   * `unproven`.
   */
  async deletePeer(id: PeerId): Promise<DeleteReport> {
    this.#open();
    if (typeof id !== "string" || id.length === 0 || !wellFormed(id))
      throw new StoreError(
        "invalid-request",
        "deletePeer: the peer id must be a non-empty, well-formed string",
      );
    const state = this.#peers.get(id);
    if (state === undefined) throw new StoreError("peer-absent", "deletePeer: no such peer");
    const held = state.holdings.scan().map(([key]) => key);
    for (const key of held) this.#releasable(state, key);
    const gone = held.filter((key) => this.#release(state, key).gone);
    const owed = state.owed.scan().map(([key]) => key);
    for (const key of owed) this.#settle(state, key);
    this.#peers.delete(id);
    state.deleted = true;
    return {
      claim: "unproven",
      boundary: PURGE_BOUNDARY,
      // The report states what a second look finds, not what the removal intended.
      surfaces: [
        {
          surface: "rows",
          state: gone.some((key) => this.#rows.get(key) !== undefined) ? "owed" : "absent",
        },
        { surface: "index-entries", state: "absent" },
        { surface: "process-memory", state: "unprovable" },
      ],
      retains: [
        { surface: "change-feed", holds: "id" },
        // As the purge's: a debt another peer still has for an id this peer held or owed.
        ...([...held, ...owed].some((key) => this.#debtors.get(key) !== undefined)
          ? [{ surface: "purge-debt" as const, holds: "id" as const }]
          : []),
      ],
      released: held.length,
      keptByOtherPeers: held.length - gone.length,
    };
  }

  /**
   * The answer of `changes`. Cost O(records returned + ids returned): `from` finds its slot by
   * arithmetic, and the records are frozen when written, so they are handed out as they are.
   */
  #changes(live: () => PeerState, from: unknown, to: unknown): ChangePage {
    const revision = (value: unknown, what: string): Revision => {
      if (!(Number.isSafeInteger(value) && (value as number) >= 0))
        throw new StoreError("invalid-request", `changes: ${what} must be an integer, 0 or more`);
      return value as number;
    };
    const after = revision(from, "from");
    const upTo = to === undefined ? undefined : revision(to, "to");
    // The shape of the request comes first: a range that ends before it starts is refused
    // before the feed is looked at. A defaulted `to` is never compared, so a cursor from the
    // future answers `resync-required`, not this.
    if (upTo !== undefined && upTo < after)
      throw new StoreError("invalid-request", "changes: to must not be less than from");
    const state = live();
    const feed = state.feed;
    const current = state.revision;
    if (after > current || after < feed.floor) return { status: "resync-required", current };
    const end = Math.min(upTo ?? current, current);
    const first = feed.start + (after - feed.floor);
    const last = feed.start + (end - feed.floor);
    const stop = Math.min(last, first + this.#pageSize);
    const page = feed.records.slice(first, stop);
    // Each answered record is the revision it stands for, and none is missing (§4.13 reading
    // 136). The check reads only the records the page answers.
    if (
      page.length !== stop - first ||
      page.some((record, i) => record?.revision !== after + 1 + i)
    )
      throw new StoreIntegrityError(feedGap(state));
    const records = page as ChangeRecord[];
    const through = stop === last ? end : records[records.length - 1]!.revision;
    return { status: "ok", records, through };
  }

  /**
   * Writes the record of the revision advance just made. Called inside the commit, after the
   * revision moved, so the record is visible exactly when the holdings and the head are.
   */
  #record(state: PeerState, added: readonly Id[], removed: readonly Id[]): void {
    const feed = state.feed;
    feed.records.push(
      Object.freeze({
        revision: state.revision,
        head: state.head,
        added: Object.freeze([...added]),
        removed: Object.freeze([...removed]),
      }),
    );
    if (feed.records.length - feed.start > this.#keep) {
      feed.floor = feed.records[feed.start]!.revision;
      feed.records[feed.start] = undefined;
      feed.start++;
      if (feed.start >= 64 && 2 * feed.start >= feed.records.length) {
        feed.records = feed.records.slice(feed.start);
        feed.start = 0;
      }
    }
  }

  #members(index: Index<Set<Id>>, key: string): Iterable<Id> {
    const bucket = index.get(key);
    if (bucket === undefined) return [];
    this.#meter.visited += bucket.size;
    return bucket;
  }

  /**
   * The stored row of a held id. A holding without its row means the reference count is wrong.
   * Serving nothing would hide it, so the read fails (§4.13 reading 136).
   */
  #row(state: PeerState, id: Id): Row {
    const row = this.#rows.get(id);
    if (row === undefined)
      throw new StoreIntegrityError({
        kind: "claims-unreadable",
        peer: state.id,
        id,
        detail: "memory store: a held delta has no stored claims",
      });
    return row;
  }

  /**
   * The stored row of an id this peer holds, checked before a release: a row that counts no
   * holder, though this peer holds it, would stay after the release, so it fails (§4.13 reading
   * 136). It reads only.
   */
  #releasable(state: PeerState, id: Id): Row {
    const row = this.#row(state, id);
    if (!(row.holders >= 1))
      throw new StoreIntegrityError({
        kind: "count-mismatch",
        peer: state.id,
        id,
        key: "holders",
        detail: `memory store: the row counts ${row.holders} holders and this peer holds it`,
      });
    return row;
  }

  #held(state: PeerState, id: Id): VerifiedDelta | undefined {
    const holding = state.holdings.get(id);
    if (holding === undefined) return undefined;
    const row = this.#row(state, id);
    // What a reader receives is a copy. The stored claims and arrival stay the store's own.
    const claims = copyClaims(row.claims);
    const delta: Delta =
      holding.sig === undefined ? { id, claims } : { id, claims, sig: holding.sig };
    return { delta, arrival: copyArrival(holding.arrival) };
  }

  #snapshot(state: PeerState): Snapshot {
    const revision = state.revision;
    const head = state.head;
    const count = state.count;
    const bound = state.lastSequence;
    const root = state.root.hash;
    let released = false;
    // An append gives each new holding a sequence past `bound`, so the holdings with a sequence
    // of at most `bound` are the snapshot's own until the peer releases one. From that purge on,
    // every call refuses (§4.13 reading 130).
    const guard = (): void => {
      this.#open();
      if (released) throw new StoreError("snapshot-released", "the snapshot was released");
      if (state.deleted)
        throw new StoreError("snapshot-moved", "the peer was deleted after this snapshot");
      if (state.removedAt > revision)
        throw new StoreError("snapshot-moved", "the peer released a holding after this snapshot");
    };
    // An id it answers must have its row, as in `get` (reading 136).
    const within = (id: Id): boolean => {
      const holding = state.holdings.get(id);
      if (holding === undefined || holding.arrival.sequence > bound) return false;
      this.#row(state, id);
      return true;
    };
    // The shape of a request comes first, as in append: a malformed request is refused the
    // same way on a current, a moved and a released snapshot.
    return {
      revision,
      history: state.history,
      head,
      count,
      lastSequence: bound,
      lastTransfer: state.lastTransfer,
      root,
      // The digest keeps no sequence, so the call is strict: it answers only while the held set
      // is the snapshot's (§4.13 reading 140).
      digest: async (prefix) => {
        if (!isDigestPrefix(prefix))
          throw new StoreError(
            "invalid-request",
            "digest: the prefix is a string of lowercase hex digits",
          );
        guard();
        if (state.lastSequence !== bound)
          throw new StoreError(
            "snapshot-moved",
            "digest: the peer's holdings moved past this snapshot, and a digest call is strict",
          );
        return this.#digestAt(state, prefix);
      },
      arrivals: async (ids) => {
        const asked = sorted(strings(ids, "arrivals: ids"));
        guard();
        const found: ArrivalRecord[] = [];
        for (const id of asked) {
          const holding = state.holdings.get(id);
          if (holding !== undefined && within(id)) found.push(copyArrival(holding.arrival));
        }
        return found;
      },
      get: async (ids) => {
        const asked = sorted(strings(ids, "get: ids"));
        guard();
        const found: Delta[] = [];
        for (const id of asked) {
          const entry = this.#held(state, id);
          if (entry !== undefined && entry.arrival.sequence <= bound) found.push(entry.delta);
        }
        return found;
      },
      targets: async (entities) => {
        const asked = sorted(strings(entities, "targets: entities"));
        guard();
        return sorted(
          asked.flatMap((entity) => [...this.#members(state.targets, entity)].filter(within)),
        );
      },
      negators: async (ids) => {
        const asked = sorted(strings(ids, "negators: ids"));
        guard();
        return sorted(asked.flatMap((id) => [...this.#members(state.negators, id)].filter(within)));
      },
      scope: async (request) => {
        const own = takeScope(request);
        guard();
        return this.#scope(state, own, bound);
      },
      release: () => {
        released = true;
      },
    };
  }

  /**
   * The node of `prefix`: its row, or, below a leaf, the leaf over the leaf's ids that start with
   * it. A prefix whose nearest row above it is a node of more than 16 ids holds no id.
   */
  #digestAt(state: PeerState, prefix: string): DigestNode {
    const row = state.digest.get(prefix);
    if (row !== undefined) return Object.freeze({ count: row.count, hash: row.hash });
    for (let k = prefix.length - 1; k >= 0; k--) {
      const above = state.digest.get(prefix.slice(0, k));
      if (above === undefined) continue;
      const ids = above.ids?.filter((id) => id.startsWith(prefix)) ?? [];
      return Object.freeze({ count: ids.length, hash: leafHash(ids) });
    }
    return EMPTY_DIGEST;
  }

  /**
   * The peer's digest rows for `updateDigest`. A leaf row keeps its ids, so the ids under a
   * prefix are read from the rows as they were before the change, with the ids `added`, and kept
   * when the peer holds them now.
   */
  #digestStore(state: PeerState, added: readonly Id[]): DigestStore {
    const rows = state.digest;
    const before = (prefix: string): Id[] => {
      const row = rows.get(prefix);
      if (row !== undefined)
        return row.ids !== undefined ? [...row.ids] : childrenOf(prefix).flatMap(before);
      for (let k = prefix.length - 1; k >= 0; k--) {
        const above = rows.get(prefix.slice(0, k));
        if (above !== undefined) return above.ids?.filter((id) => id.startsWith(prefix)) ?? [];
      }
      return [];
    };
    const dropUnder = (prefix: string): void => {
      for (const child of childrenOf(prefix))
        if (rows.get(child) !== undefined) {
          dropUnder(child);
          rows.delete(child);
        }
    };
    return {
      rows: (prefixes) => prefixes.map((prefix) => rows.get(prefix)),
      held: (prefix) =>
        sorted([...before(prefix), ...added.filter((id) => id.startsWith(prefix))]).filter(
          (id) => state.holdings.get(id) !== undefined,
        ),
      put: (prefix, { count, hash }, leaf) =>
        rows.set(prefix, leaf === undefined ? { count, hash } : { count, hash, ids: [...leaf] }),
      drop: (prefix) => rows.delete(prefix),
      dropUnder,
    };
  }

  #scope(state: PeerState, { anchors, asked, exclude }: OwnScope, bound: number): ScopeResult {
    const can = this.#own.pushdown;
    const applied: AppliedPushdown = {
      timestampAtMost: asked.timestampAtMost !== undefined && can.timestampAtMost,
      arrivalAtMost: asked.arrivalAtMost !== undefined && can.arrivalAtMost,
      excludeIds: asked.excludeIds !== undefined && can.excludeIds,
    };
    const dropped = new Set(applied.excludeIds ? asked.excludeIds : []);
    const admits = (entry: VerifiedDelta): boolean =>
      entry.arrival.sequence <= bound &&
      !(applied.timestampAtMost && entry.delta.claims.timestamp > asked.timestampAtMost!) &&
      !(applied.arrivalAtMost && entry.arrival.sequence > asked.arrivalAtMost!) &&
      !dropped.has(entry.delta.id);

    const members = new Map<Id, VerifiedDelta>();
    const pending: Id[] = [];
    const consider = (id: Id): void => {
      if (members.has(id)) return;
      const entry = this.#held(state, id);
      if (entry === undefined || !admits(entry)) return;
      members.set(id, entry);
      pending.push(id);
    };
    for (const anchor of anchors) {
      if (anchor.kind !== "entity")
        throw new StoreError("capability-absent", "scope: this store serves entity anchors only");
      for (const id of this.#members(state.targets, anchor.entity as Entity)) consider(id);
    }
    while (pending.length > 0)
      for (const id of this.#members(state.negators, pending.pop()!)) consider(id);

    // `exclude` only trims the answer. The walk above already followed chains through it.
    const omit = new Set(exclude);
    const deltas = sorted(members.keys())
      .filter((id) => !omit.has(id))
      .map((id) => members.get(id)!);
    return { deltas, applied };
  }

  #append(live: () => PeerState, batch: Admission): AppendResult {
    // Each field of the call is read once. A second read could give another value.
    const { expectedHead, nextHead, added } = takeAppend(batch);
    const state = live();
    if (state.head !== expectedHead) return { status: "conflict" };

    // Validate the whole batch before the first write, so a refusal leaves nothing behind.
    // Every entry is checked, also one whose id is already held: a forged repeat is refused.
    if (!Array.isArray(added))
      throw new StoreError("invalid-admission", "append: the added entries must be a list");
    const fresh = new Map<Id, { claims: Claims; holding: Holding }>();
    const sequences = new Set<number>();
    let lastTransfer = state.lastTransfer;
    for (let i = 0; i < added.length; i++) {
      const { id, claims, sig, arrival } = admit(added[i]);
      const holding: Holding = { sig, arrival };
      if (fresh.has(id) || state.holdings.get(id) !== undefined) continue;
      const sequence = holding.arrival.sequence;
      if (sequence <= state.lastSequence || sequences.has(sequence))
        throw new StoreError(
          "invalid-admission",
          "append: an arrival sequence does not pass the peer's last sequence",
        );
      if (holding.arrival.transfer <= state.lastTransfer)
        throw new StoreError(
          "invalid-admission",
          "append: a transfer ordinal does not pass the peer's last transfer",
        );
      lastTransfer = Math.max(lastTransfer, holding.arrival.transfer);
      sequences.add(sequence);
      fresh.set(id, { claims, holding });
    }

    for (const [id, { claims, holding }] of fresh) {
      const row = this.#rows.get(id);
      if (row === undefined) this.#rows.set(id, { claims, holders: 1 });
      else row.holders++;
      state.holdings.set(id, holding);
      state.count++;
      this.#settle(state, id);
      const keys = indexKeys(claims);
      for (const entity of keys.entities) this.#file(state.targets, entity, id);
      for (const negated of keys.negated) this.#file(state.negators, negated, id);
      state.lastSequence = Math.max(state.lastSequence, holding.arrival.sequence);
    }
    state.lastTransfer = lastTransfer;
    const ids = sorted(fresh.keys());
    if (ids.length > 0) state.root = updateDigest(this.#digestStore(state, ids), ids, []);
    const advanced = fresh.size > 0 || state.head !== nextHead;
    state.head = nextHead;
    if (advanced) {
      state.revision++;
      this.#record(state, ids, []);
    }
    return { status: "committed", revision: state.revision, added: ids };
  }

  #file(index: Index<Set<Id>>, key: string, id: Id): void {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, new Set([id]));
    else bucket.add(id);
  }

  #unfile(index: Index<Set<Id>>, key: string, id: Id): void {
    const bucket = index.get(key);
    if (bucket === undefined) return;
    bucket.delete(id);
    if (bucket.size === 0) index.delete(key);
  }

  #owe(state: PeerState, id: Id): void {
    if (state.owed.get(id) === true) return;
    state.owed.set(id, true);
    this.#debtors.set(id, (this.#debtors.get(id) ?? 0) + 1);
  }

  #settle(state: PeerState, id: Id): void {
    if (state.owed.get(id) !== true) return;
    state.owed.delete(id);
    const left = this.#debtors.get(id)! - 1;
    if (left === 0) this.#debtors.delete(id);
    else this.#debtors.set(id, left);
  }

  /**
   * Releases the peer's holding of `id`: the holding and its index entries, and the stored row
   * when no other peer holds the id (`gone`). A purge and a peer delete release only through this.
   */
  #release(state: PeerState, id: Id): { keys: ReturnType<typeof indexKeys>; gone: boolean } {
    const row = this.#row(state, id);
    const keys = indexKeys(row.claims);
    for (const entity of keys.entities) this.#unfile(state.targets, entity, id);
    for (const negated of keys.negated) this.#unfile(state.negators, negated, id);
    state.holdings.delete(id);
    state.count--;
    row.holders--;
    if (row.holders === 0) this.#rows.delete(id);
    return { keys, gone: row.holders === 0 };
  }

  #purge(state: PeerState, ids: readonly Id[]): PurgeReport {
    const targets: { id: Id; outcome: PurgeOutcome }[] = [];
    // The ids that leave this peer's holdings. A settled debt is not one: the peer stopped
    // holding that id at an earlier purge.
    const released: Id[] = [];
    let rowsOwed = false;
    let indexesOwed = false;
    const order = sorted(ids);
    // A held id without its stored claims, or whose row counts no holder, refuses the whole
    // purge before it removes anything (§4.13 reading 136).
    for (const id of order) if (state.holdings.get(id) !== undefined) this.#releasable(state, id);
    for (const id of order) {
      const holding = state.holdings.get(id);
      let outcome: PurgeOutcome;
      if (holding !== undefined) {
        const { keys, gone } = this.#release(state, id);
        if (!gone) this.#owe(state, id);
        released.push(id);
        // The report states what a second look finds, not what the removal intended.
        indexesOwed ||=
          state.holdings.get(id) !== undefined ||
          keys.entities.some((entity) => state.targets.get(entity)?.has(id) === true) ||
          keys.negated.some((negated) => state.negators.get(negated)?.has(id) === true);
        outcome = this.#rows.get(id) === undefined ? "removed" : "held-by-other-peer";
      } else if (state.owed.get(id) === true) {
        // An earlier purge left the bytes with another peer. Report whether they are gone
        // now; a peer that never held the id learns nothing here.
        if (this.#rows.get(id) === undefined) {
          this.#settle(state, id);
          outcome = "removed";
        } else outcome = "held-by-other-peer";
      } else outcome = "not-held";
      // The surfaces speak for the removed targets only: a row that outlived its removal.
      rowsOwed ||= outcome === "removed" && this.#rows.get(id) !== undefined;
      targets.push({ id, outcome });
    }
    if (released.length > 0) {
      state.root = updateDigest(this.#digestStore(state, []), [], released);
      state.revision++;
      state.removedAt = state.revision;
      this.#record(state, [], released);
    }
    const removed = targets.some((target) => target.outcome === "removed");
    return {
      // Process memory cannot prove absence, so this store never says `proven`.
      claim: removed ? "unproven" : "nothing-removed",
      boundary: PURGE_BOUNDARY,
      revision: state.revision,
      targets,
      surfaces: [
        { surface: "rows", state: rowsOwed ? "owed" : "absent" },
        { surface: "index-entries", state: indexesOwed ? "owed" : "absent" },
        { surface: "process-memory", state: "unprovable" },
      ],
      // The ids the feed or a debt may keep, for the targets this peer released or owes. This
      // store always keeps a feed.
      retains: [
        { surface: "change-feed", holds: "id" },
        ...(targets.some((t) => t.outcome !== "not-held" && this.#debtors.get(t.id) !== undefined)
          ? [{ surface: "purge-debt" as const, holds: "id" as const }]
          : []),
      ],
    };
  }

  openAdmin(): Exporter {
    this.#open();
    const holdings = (peer: PeerId): Delta[] => {
      this.#open();
      const state = typeof peer === "string" ? this.#peers.get(peer) : undefined;
      if (state === undefined) throw new StoreError("peer-absent", "export: no such peer");
      return state.holdings.scan().map(([id]) => this.#held(state, id)!.delta);
    };
    const keys = <V>(index: Index<V>): string[] => {
      this.#open();
      return index.scan().map(([key]) => key);
    };
    const peers = this.#peers;
    const rows = this.#rows;
    return {
      async *peers() {
        yield* keys(peers);
      },
      peer: (peer) => ({
        async *ids() {
          for (const delta of holdings(peer)) yield delta.id;
        },
        async *deltas() {
          yield* holdings(peer);
        },
      }),
      async *storedIds() {
        yield* keys(rows);
      },
      fsck: async () => {
        this.#open();
        return this.#fsck();
      },
    };
  }

  /**
   * `fsck` over this store's own structures (§4.13 reading 137): each holding against its claims
   * and the peer's indexes and counters, each index entry against a holding, each peer's change
   * records, and each row's count of holders. It reads only. O(store).
   */
  #fsck(): FsckReport {
    const faults: IntegrityFault[] = [];
    const checked = { peers: 0, holdings: 0, deltas: 0 };
    const holders = new Map<Id, number>();
    for (const [, state] of this.#peers.scan()) {
      const peer = state.id;
      checked.peers++;
      const fault = (f: Omit<IntegrityFault, "peer">): void => {
        faults.push({ peer, ...f });
      };
      const expected = {
        targets: new Map<string, Set<Id>>(),
        negators: new Map<string, Set<Id>>(),
      };
      const holdings = state.holdings.scan();
      if (holdings.length !== state.count)
        fault({
          kind: "count-mismatch",
          detail: `memory store: the peer's count is ${state.count} and it holds ${holdings.length}`,
        });
      for (const [id, holding] of holdings) {
        checked.holdings++;
        holders.set(id, (holders.get(id) ?? 0) + 1);
        if (holding.arrival.sequence > state.lastSequence)
          fault({
            kind: "sequence-mismatch",
            id,
            key: "seq",
            detail: "memory store: a sequence passes the peer's last",
          });
        if (holding.arrival.transfer > state.lastTransfer)
          fault({
            kind: "sequence-mismatch",
            id,
            key: "transfer",
            detail: "memory store: a transfer passes the peer's last",
          });
        if (holding.arrival.id !== id)
          fault({
            kind: "column-mismatch",
            id,
            key: "holding.arrival",
            detail: "memory store: the arrival record names another id",
          });
        const row = this.#rows.get(id);
        if (row === undefined) {
          fault({
            kind: "claims-unreadable",
            id,
            detail: "memory store: a held delta has no stored claims",
          });
          continue;
        }
        let computed: Id | undefined;
        try {
          computed = computeId(row.claims);
        } catch {
          computed = undefined;
        }
        if (computed !== id)
          fault({
            kind: "claims-mismatch",
            id,
            detail: "memory store: stored claims do not hash to their id",
          });
        const keys = indexKeys(row.claims);
        for (const entity of keys.entities) file(expected.targets, entity, id);
        for (const negated of keys.negated) file(expected.negators, negated, id);
      }
      for (const [index, want, what] of [
        [state.targets, expected.targets, "target"],
        [state.negators, expected.negators, "negation"],
      ] as const) {
        for (const [key, bucket] of index.scan())
          for (const id of bucket)
            if (want.get(key)?.delete(id) !== true)
              fault({
                kind: "index-stray",
                id,
                key,
                detail: `memory store: a ${what} entry that no held claims name`,
              });
        for (const [key, left] of want)
          for (const id of left)
            fault({
              kind: "index-missing",
              id,
              key,
              detail: `memory store: held claims name a ${what} entry that is missing`,
            });
      }
      const { records, start, floor } = state.feed;
      const kept = records.slice(start);
      if (
        kept.length !== state.revision - floor ||
        kept.some((record, i) => record?.revision !== floor + 1 + i)
      )
        faults.push(feedGap(state));
      // The digest against the tree its holdings give (§4.13 reading 141).
      const want = digestRows(holdings.map(([id]) => id));
      const root = want.get("")?.hash ?? EMPTY_DIGEST.hash;
      const same = (a: DigestRow, b: DigestRow | undefined): boolean =>
        b !== undefined &&
        a.count === b.count &&
        a.hash === b.hash &&
        JSON.stringify(a.ids) === JSON.stringify(b.ids);
      for (const [prefix, row] of state.digest.scan()) {
        if (!same(row, want.get(prefix)))
          fault({
            kind: "digest-mismatch",
            key: `digest:${prefix}`,
            detail: "memory store: a stored digest node is not the node the holdings give",
          });
        want.delete(prefix);
      }
      for (const prefix of want.keys())
        fault({
          kind: "digest-mismatch",
          key: `digest:${prefix}`,
          detail: "memory store: a digest node the holdings give is not stored",
        });
      if (state.root.hash !== root || state.root.count !== holdings.length)
        fault({
          kind: "digest-mismatch",
          key: "root",
          detail: "memory store: the peer's root is not the root its holdings give",
        });
    }
    for (const [id, row] of this.#rows.scan()) {
      checked.deltas++;
      const held = holders.get(id) ?? 0;
      if (held === 0)
        faults.push({
          kind: "orphan-bytes",
          id,
          detail: "memory store: no peer holds these bytes",
        });
      else if (row.holders !== held)
        faults.push({
          kind: "count-mismatch",
          id,
          key: "holders",
          detail: `memory store: the row counts ${row.holders} holders and ${held} peers hold it`,
        });
    }
    return { checked, faults };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

/** Change records that do not run from the floor to the revision (§4.13 readings 136, 137). */
function feedGap(state: PeerState): IntegrityFault {
  const { records, start, floor } = state.feed;
  return {
    kind: "feed-gap",
    peer: state.id,
    detail: `memory store: the peer keeps ${records.length - start} change records at floor ${floor} and revision ${state.revision}`,
  };
}

/** A new, empty memory store. Its contents end with the process. */
export function createMemoryStore(options: MemoryStoreOptions = {}): Store {
  return new MemoryStore(ownFields(options));
}
