// The memory reference store (SPEC-18 proposal §5.1). Other stores must answer every operation
// with the same ids. Claims are kept once per id and counted by holdings; membership, indexes,
// arrivals, signatures, head and revision are per peer.

import { compareUtf8 } from "../delta/cbor.js";
import { computeId } from "../delta/delta.js";
import type { Claims, Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import {
  PURGE_BOUNDARY,
  StoreError,
  type Admission,
  type AppendResult,
  type AppliedPushdown,
  type CreatePeerOptions,
  type Entity,
  type ErasureClass,
  type ErasurePosture,
  type Exporter,
  type Head,
  type Id,
  type PeerId,
  type PeerStore,
  type PurgeOutcome,
  type PurgeReport,
  type Revision,
  type ScopeRequest,
  type ScopeResult,
  type Snapshot,
  type Store,
  type StoreProfile,
  type SurfaceState,
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
};

// The only door to the store's maps. Everything keyed counts a lookup; `scan` is the single way
// to iterate a whole map and it counts, so a core operation that walks a set shows in the meter.
class Index<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly meter: StoreMeter) {}
  get(key: string): V | undefined {
    this.meter.lookups++;
    return this.map.get(key);
  }
  set(key: string, value: V): void {
    this.meter.lookups++;
    this.map.set(key, value);
  }
  delete(key: string): void {
    this.meter.lookups++;
    this.map.delete(key);
  }
  scan(): [string, V][] {
    this.meter.scans++;
    return [...this.map.entries()].sort(([a], [b]) => compareUtf8(a, b));
  }
}

type Row = { readonly claims: Claims; holders: number };
type Holding = { readonly sig: string | undefined; readonly arrival: ArrivalRecord };

type PeerState = {
  readonly id: PeerId;
  readonly posture: ErasurePosture;
  readonly holdings: Index<Holding>;
  readonly targets: Index<Set<Id>>;
  readonly negators: Index<Set<Id>>;
  /** Ids this peer purged while another peer still held the bytes. */
  readonly owed: Index<true>;
  head: Head | null;
  count: number;
  revision: Revision;
  lastSequence: number;
};

const sorted = (ids: Iterable<Id>): Id[] => [...new Set(ids)].sort(compareUtf8);

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

function checkArrival(entry: VerifiedDelta): void {
  const { arrival, delta } = entry;
  const count = (n: number): boolean => Number.isSafeInteger(n) && n >= 1;
  if (
    arrival.id !== delta.id ||
    !count(arrival.sequence) ||
    !count(arrival.transfer) ||
    !Number.isFinite(arrival.at) ||
    typeof arrival.sender !== "string" ||
    arrival.sender.length === 0
  )
    throw new StoreError("invalid-admission", "append: an arrival record is malformed");
}

class MemoryStore implements Store {
  readonly profile: StoreProfile;
  private readonly meter: StoreMeter;
  private readonly rows: Index<Row>;
  private readonly peers: Index<PeerState>;
  private closed = false;

  constructor(options: MemoryStoreOptions) {
    this.meter = options.meter ?? { lookups: 0, visited: 0, scans: 0 };
    this.rows = new Index(this.meter);
    this.peers = new Index(this.meter);
    this.profile = {
      capabilities: {
        values: false,
        arrival: true,
        journal: false,
        views: false,
        derivedIndexes: false,
        digest: false,
        erasure: "unprovable",
      },
      indexedValueRoles: [],
      pushdown: {
        timestampAtMost: options.pushdown?.timestampAtMost ?? true,
        arrivalAtMost: options.pushdown?.arrivalAtMost ?? true,
        excludeIds: options.pushdown?.excludeIds ?? true,
      },
      writers: "one-process",
      atRest: "trusted",
      changeRetention: "none",
      formatVersion: MEMORY_STORE_FORMAT,
    };
  }

  private open(): void {
    if (this.closed) throw new StoreError("store-closed", "the store is closed");
  }

  async createPeer(id: PeerId, options: CreatePeerOptions): Promise<PeerStore> {
    this.open();
    if (typeof id !== "string" || id.length === 0)
      throw new StoreError("invalid-request", "createPeer: the peer id must not be empty");
    if (options.erasure !== "proven" && options.erasure !== "unproven")
      throw new StoreError("invalid-request", "createPeer: declare the erasure posture");
    const storeClass: ErasureClass = this.profile.capabilities.erasure;
    if (options.erasure === "proven" && storeClass !== "proven")
      throw new StoreError(
        "posture-refused",
        `createPeer: the peer promises proven erasure and this store's class is ${storeClass}`,
      );
    if (this.peers.get(id) !== undefined)
      throw new StoreError("peer-exists", "createPeer: the peer already exists");
    const state: PeerState = {
      id,
      posture: options.erasure,
      holdings: new Index(this.meter),
      targets: new Index(this.meter),
      negators: new Index(this.meter),
      owed: new Index(this.meter),
      head: null,
      count: 0,
      revision: 0,
      lastSequence: 0,
    };
    this.peers.set(id, state);
    return this.handle(state);
  }

  async peer(id: PeerId): Promise<PeerStore> {
    this.open();
    const state = this.peers.get(id);
    if (state === undefined) throw new StoreError("peer-absent", "peer: no such peer");
    return this.handle(state);
  }

  private handle(state: PeerState): PeerStore {
    return {
      id: state.id,
      erasure: { posture: state.posture, storeClass: this.profile.capabilities.erasure },
      read: async () => {
        this.open();
        return this.snapshot(state);
      },
      append: async (batch) => {
        this.open();
        return this.append(state, batch);
      },
      purge: async (ids) => {
        this.open();
        return this.purge(state, ids);
      },
    };
  }

  private members(index: Index<Set<Id>>, key: string): Iterable<Id> {
    const bucket = index.get(key);
    if (bucket === undefined) return [];
    this.meter.visited += bucket.size;
    return bucket;
  }

  private held(state: PeerState, id: Id): VerifiedDelta | undefined {
    const holding = state.holdings.get(id);
    if (holding === undefined) return undefined;
    const row = this.rows.get(id);
    // A holding without its row means the reference count is wrong. Serving nothing would
    // hide it, so the read fails.
    if (row === undefined) throw new Error("memory store: a held delta has no stored claims");
    const delta: Delta =
      holding.sig === undefined
        ? { id, claims: row.claims }
        : { id, claims: row.claims, sig: holding.sig };
    return { delta, arrival: holding.arrival };
  }

  private snapshot(state: PeerState): Snapshot {
    const revision = state.revision;
    const head = state.head;
    const count = state.count;
    let released = false;
    const guard = (): void => {
      this.open();
      if (released) throw new StoreError("snapshot-released", "the snapshot was released");
      // This store has no read transactions. Answering from a later revision would break
      // repeatability, so a snapshot the peer has moved past refuses instead.
      if (state.revision !== revision)
        throw new StoreError("snapshot-moved", "the peer moved past this snapshot's revision");
    };
    return {
      revision,
      head,
      count,
      arrivals: async (ids) => {
        guard();
        const found: ArrivalRecord[] = [];
        for (const id of sorted(ids)) {
          const holding = state.holdings.get(id);
          if (holding !== undefined) found.push(holding.arrival);
        }
        return found;
      },
      get: async (ids) => {
        guard();
        const found: Delta[] = [];
        for (const id of sorted(ids)) {
          const entry = this.held(state, id);
          if (entry !== undefined) found.push(entry.delta);
        }
        return found;
      },
      targets: async (entities) => {
        guard();
        return sorted([...new Set(entities)].flatMap((e) => [...this.members(state.targets, e)]));
      },
      negators: async (ids) => {
        guard();
        return sorted([...new Set(ids)].flatMap((id) => [...this.members(state.negators, id)]));
      },
      scope: async (request) => {
        guard();
        return this.scope(state, request);
      },
      release: () => {
        released = true;
      },
    };
  }

  private scope(state: PeerState, request: ScopeRequest): ScopeResult {
    const asked = request.pushdown ?? {};
    const can = this.profile.pushdown;
    const applied: AppliedPushdown = {
      timestampAtMost: asked.timestampAtMost !== undefined && can.timestampAtMost,
      arrivalAtMost: asked.arrivalAtMost !== undefined && can.arrivalAtMost,
      excludeIds: asked.excludeIds !== undefined && can.excludeIds,
    };
    const dropped = new Set(applied.excludeIds ? asked.excludeIds : []);
    const admits = (entry: VerifiedDelta): boolean =>
      !(applied.timestampAtMost && entry.delta.claims.timestamp > asked.timestampAtMost!) &&
      !(applied.arrivalAtMost && entry.arrival.sequence > asked.arrivalAtMost!) &&
      !dropped.has(entry.delta.id);

    const members = new Map<Id, VerifiedDelta>();
    const pending: Id[] = [];
    const consider = (id: Id): void => {
      if (members.has(id)) return;
      const entry = this.held(state, id);
      if (entry === undefined || !admits(entry)) return;
      members.set(id, entry);
      pending.push(id);
    };
    for (const anchor of request.anchors) {
      if (anchor.kind !== "entity")
        throw new StoreError("capability-absent", "scope: this store serves entity anchors only");
      for (const id of this.members(state.targets, anchor.entity)) consider(id);
    }
    while (pending.length > 0)
      for (const id of this.members(state.negators, pending.pop()!)) consider(id);

    // `exclude` only trims the answer. The walk above already followed chains through it.
    const omit = new Set(request.exclude ?? []);
    const deltas = sorted(members.keys())
      .filter((id) => !omit.has(id))
      .map((id) => members.get(id)!);
    return { deltas, applied };
  }

  private append(state: PeerState, batch: Admission): AppendResult {
    if (typeof batch.nextHead !== "string" || batch.nextHead.length === 0)
      throw new StoreError("invalid-admission", "append: the next head must not be empty");
    if (batch.frame !== null)
      throw new StoreError(
        "capability-absent",
        "append: this store has no journal capability and cannot keep a frame",
      );
    if (state.head !== batch.expectedHead) return { status: "conflict" };

    // Validate the whole batch before the first write, so a refusal leaves nothing behind.
    const fresh = new Map<Id, VerifiedDelta>();
    const sequences = new Set<number>();
    for (const entry of batch.added) {
      // Claims are shared across peers by id. An id that does not recompute would let one
      // peer's append change what another peer reads.
      let id: string;
      try {
        id = computeId(entry.delta.claims);
      } catch {
        throw new StoreError("invalid-admission", "append: a delta's claims are malformed");
      }
      if (id !== entry.delta.id)
        throw new StoreError("invalid-admission", "append: a delta id does not match its claims");
      checkArrival(entry);
      if (fresh.has(id) || state.holdings.get(id) !== undefined) continue;
      if (entry.arrival.sequence <= state.lastSequence || sequences.has(entry.arrival.sequence))
        throw new StoreError(
          "invalid-admission",
          "append: an arrival sequence does not pass the peer's last sequence",
        );
      sequences.add(entry.arrival.sequence);
      fresh.set(id, entry);
    }

    for (const [id, { delta, arrival }] of fresh) {
      const row = this.rows.get(id);
      if (row === undefined) this.rows.set(id, { claims: delta.claims, holders: 1 });
      else row.holders++;
      state.holdings.set(id, { sig: delta.sig, arrival });
      state.count++;
      state.owed.delete(id);
      const keys = indexKeys(delta.claims);
      for (const entity of keys.entities) this.file(state.targets, entity, id);
      for (const negated of keys.negated) this.file(state.negators, negated, id);
      state.lastSequence = Math.max(state.lastSequence, arrival.sequence);
    }
    if (fresh.size > 0 || state.head !== batch.nextHead) state.revision++;
    state.head = batch.nextHead;
    return { status: "committed", revision: state.revision, added: sorted(fresh.keys()) };
  }

  private file(index: Index<Set<Id>>, key: string, id: Id): void {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, new Set([id]));
    else bucket.add(id);
  }

  private unfile(index: Index<Set<Id>>, key: string, id: Id): void {
    const bucket = index.get(key);
    if (bucket === undefined) return;
    bucket.delete(id);
    if (bucket.size === 0) index.delete(key);
  }

  private purge(state: PeerState, ids: readonly Id[]): PurgeReport {
    const targets: { id: Id; outcome: PurgeOutcome }[] = [];
    let changed = false;
    let rowsOwed = false;
    let indexesOwed = false;
    for (const id of sorted(ids)) {
      const holding = state.holdings.get(id);
      let outcome: PurgeOutcome;
      if (holding !== undefined) {
        const row = this.rows.get(id);
        if (row === undefined) throw new Error("memory store: a held delta has no stored claims");
        const keys = indexKeys(row.claims);
        for (const entity of keys.entities) this.unfile(state.targets, entity, id);
        for (const negated of keys.negated) this.unfile(state.negators, negated, id);
        state.holdings.delete(id);
        state.count--;
        row.holders--;
        if (row.holders === 0) this.rows.delete(id);
        else state.owed.set(id, true);
        changed = true;
        // The report states what a second look finds, not what the removal intended.
        indexesOwed ||=
          state.holdings.get(id) !== undefined ||
          keys.entities.some((entity) => state.targets.get(entity)?.has(id) === true) ||
          keys.negated.some((negated) => state.negators.get(negated)?.has(id) === true);
        outcome = this.rows.get(id) === undefined ? "removed" : "held-by-other-peer";
      } else if (state.owed.get(id) === true) {
        // An earlier purge left the bytes with another peer. Report whether they are gone
        // now; a peer that never held the id learns nothing here.
        if (this.rows.get(id) === undefined) {
          state.owed.delete(id);
          outcome = "removed";
        } else outcome = "held-by-other-peer";
      } else outcome = "not-held";
      rowsOwed ||= outcome === "held-by-other-peer";
      targets.push({ id, outcome });
    }
    if (changed) state.revision++;
    const state_ = (owed: boolean): SurfaceState => (owed ? "owed" : "absent");
    return {
      // Process memory cannot prove absence, so this store never says `proven`.
      claim: "unproven",
      boundary: PURGE_BOUNDARY,
      revision: state.revision,
      targets,
      surfaces: [
        { surface: "rows", state: state_(rowsOwed) },
        { surface: "index-entries", state: state_(indexesOwed) },
        { surface: "process-memory", state: "unprovable" },
      ],
    };
  }

  openAdmin(): Exporter {
    this.open();
    const holdings = (peer: PeerId): Delta[] => {
      this.open();
      const state = this.peers.get(peer);
      if (state === undefined) throw new StoreError("peer-absent", "export: no such peer");
      return state.holdings.scan().map(([id]) => this.held(state, id)!.delta);
    };
    const keys = <V>(index: Index<V>): string[] => {
      this.open();
      return index.scan().map(([key]) => key);
    };
    const { peers, rows } = this;
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
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A new, empty memory store. Its contents end with the process. */
export function createMemoryStore(options: MemoryStoreOptions = {}): Store {
  return new MemoryStore(options);
}
