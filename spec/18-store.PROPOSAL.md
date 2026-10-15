# SPEC-18 proposal: the store

**Status:** Proposal (2026-10-15). Myk asked for durable, indexed storage with one coherent
interface and specialized implementations (issue #75). This document is the working contract
until its parts are promoted into `spec/04-reactor.md`, `spec/06-peer-admission.PROPOSAL.md`
and a store chapter with shared vectors. The package that carries the interface is
`rhizomatic-store`.

**Depends on:** SPEC-1 (content addressing), SPEC-2 (predicates, `ValMatch`), SPEC-4 (reactor),
SPEC-6 vNext (peers, journal, arrival, erasure), SPEC-8 (packs), SPEC-17 (P7, delta source,
scope of a read).

---

## 1. Why

SPEC-4 §3 says "the log *is* the database." Both witnesses keep the log and every index in
memory instead. A durable store is only a backup that is read whole at open.

- Opening a peer costs O(store): every row or journal frame is read and replayed.
- Memory grows with the store, so RAM is the limit on store size.
- Another process's writes are invisible until reopen.
- Erasure recovery, catch-up and federation sync read whole sets.

SPEC-17 made one read cost its footprint, but only because the in-memory indexes exist. P7 also
applies to the store as a whole: **no operation, including open, may cost O(store).**

This proposal does not choose one database. It defines what any store must answer, what it may
optionally answer, and how a host finds out which it is talking to. Implementations specialize.

## 2. What a store serves

Each requirement below comes from a rule rhizomatic already has.

| # | Requirement | Source |
|---|---|---|
| R1 | Content-addressed, idempotent union: appending a held id is a no-op; any order converges | SPEC-1, SPEC-4 §2 |
| R2 | The delta source: `get`, `targets(entity)`, `negators(id)` in O(log N + result) | SPEC-17 §3 |
| R3 | The scope of a read, S(E), in a few round trips, not one per delta | SPEC-17 §4, §6 |
| R4 | Value ranges over `(role, primitive)`, ordered, for `ValMatch` | SPEC-2 §3, SPEC-4 §3 |
| R5 | Three time axes. Signed time and validity are fields of the delta (no index needed). Arrival is per-peer testimony and needs an index | SPEC-6 vNext §3 |
| R6 | Peers: one membership set per peer over shared bytes; one writer per peer; head compare-and-set | SPEC-6 vNext §1, §2 |
| R7 | Erasure: physical removal with a proof per storage surface, or an honest `unproven` | SPEC-6 vNext §1, §2 |
| R8 | Change: a revision, and the changes between two revisions in O(changes) | SPEC-4 §5, this proposal |
| R9 | Maintained views: persisted views, found by the entities they depend on | SPEC-4 §4, SPEC-17 §6 |
| R10 | Federation: set reconciliation without a whole-set scan | SPEC-6, step 7 |
| R11 | Platforms: server, browser, embedded, object storage, memory | portability (README) |

## 3. Design rules

1. **The contract is logical; the layout is free.** As in SPEC-8, the content address is the
   contract. Two stores that answer every operation with the same ids are equivalent,
   whatever their tables, keys or files.
2. **A small required core, plus declared capabilities.** Every store implements the core
   (§4.1–§4.6). Other operations are capabilities (§4.7). A store declares its capabilities in
   a profile. A host checks the profile at open and refuses to start when a capability it needs
   is absent. It never falls back to a scan.
3. **Whole-store operations live on a separate object.** Listing every id, exporting, repacking
   and backup are on an `Exporter` that `openAdmin()` returns. The serving path never receives
   one. A P7 violation then needs a visible type change, not a stray loop.
4. **The boundary is batch-shaped and asynchronous; evaluation stays synchronous.** A read
   fetches its whole scope in one call per discovery round, then evaluates in memory. The scope
   is footprint-bounded, so holding it in memory is allowed. This keeps the evaluator
   synchronous and lets a store answer a scope in one SQL statement or one network request.
5. **Composition follows from union.** The delta set is a grow-only set, so the union of two
   stores is a store. Tiers, caches, replicas and multi-peer views are compositions (§5.6), not
   special cases.

## 4. The interface

The shapes below are written in TypeScript. The Rust witness mirrors them as traits in its own
idiom. Operation results are sets of delta ids unless stated. "Exact" means the conformance
vectors compare the result byte for byte with the memory reference store (§5.1).

### 4.1 Open and peers

```ts
interface Store {
  readonly profile: StoreProfile;          // §4.8
  peer(id: PeerId): PeerStore;             // one peer's logical store
  openAdmin(): Exporter;                   // whole-store operations, §4.7
  close(): Promise<void>;
}
```

A store holds the bytes of every delta once. Each peer has its own membership, indexes,
arrivals, journal, revision and change feed (R6). A peer's operations never return another
peer's ids. Opening a peer costs O(1) plus the journal checkpoint and tail (§4.7.3), never
O(holdings).

### 4.2 Snapshots and revisions

```ts
interface PeerStore {
  read(): Promise<Snapshot>;               // a consistent, repeatable view at one revision
  append(batch: Admission): Promise<AppendResult>;   // §4.5
  changes(from: Revision, to?: Revision): Promise<ChangePage>;  // §4.6
}
interface Snapshot {
  readonly revision: Revision;
  get(ids: readonly Id[]): Promise<readonly Delta[]>;            // exact, held ids only
  targets(entities: readonly Entity[]): Promise<readonly Id[]>;  // exact, union over entities
  negators(ids: readonly Id[]): Promise<readonly Id[]>;          // exact, direct negators only
  scope(entities: readonly Entity[], selection?: Pushdown): Promise<ScopeResult>;  // §4.3
  release(): void;
}
```

- A revision is a peer-local value that increases with each committed append or purge. Two
  snapshots at the same revision answer every operation identically.
- Every operation on one snapshot sees the same revision. An implementation without native
  read transactions can meet this with a revision check after each batch, retrying the batch
  or failing with `snapshot-moved`.
- A synchronous implementation MAY also expose the SPEC-17 `DeltaSource` directly. The batch
  form above is the portable one.

**Cost.** `get`, `targets` and `negators` cost O(k × log N + result), where k is the number of
keys asked. No core operation may cost O(N).

### 4.3 The scope query

`scope(E, p)` returns the deltas a read over E needs, in one call.

- Let H be the peer's held set, and Hp the members of H that pass the pushdown selection p.
- The result R MUST satisfy `S(E over Hp) ⊆ R ⊆ S(E over H)`, where S is SPEC-17 §4.
- The result also returns the delta bytes for R, so the host needs no second round trip.

**Trim lemma.** S is monotone in the delta set: if D′ ⊆ D then `S(E over D′) ⊆ S(E over D)`.
So a host with a residual selection `a` (anything it did not push down) computes the exact
scope as `S(E over R ∩ a)`, in memory, from R alone. Every negation chain it needs is already
in R. The conformance vectors pin this: the trimmed result equals the memory reference's
`S(E over Hp ∩ a)` for every case.

A store MAY return more than `S(E over Hp)` (for example, closure computed before the pushdown
filter). It MUST NOT return less, and it MUST NOT return ids outside `S(E over H)`. That upper
bound keeps the cost footprint-bounded.

**Pushdown.** A selection the store can apply itself:

```ts
type Pushdown = {
  timestampAtMost?: number;     // signed creation time ≤ t (as-of on signed time)
  arrivalAtMost?: ArrivalSeq;   // arrived at or before this sequence (as-of on arrival)
  exclude?: readonly Id[];      // a small explicit set, e.g. a read closure
};
```

A store that cannot apply a field ignores it and reports so in `ScopeResult.applied`. The host
applies the rest as a residual selection (trim lemma). Pushdown is an optimization, never a
correctness dependency.

### 4.4 Validity is not indexed

Signed time and the validity interval are fields of each delta. Evaluation at an explicit `now`
applies them per delta, inside the scope. A store does not index them. The exception is the
expiry of a maintained view (§4.7.4), which the view records itself.

### 4.5 Write

```ts
type Admission = {
  expectedHead: Head | null;        // journal compare-and-set, SPEC-6 vNext §2
  nextHead: Head;
  frame: Uint8Array | null;         // the canonical journal frame
  added: readonly VerifiedDelta[];  // admitted ids with their arrival records
  erased?: readonly Id[];           // effective erasure targets (§4.7.2)
};
```

- An append is atomic per peer. The new head, frame, membership, all four indexes, arrivals and
  one change record become visible together, or none of them do.
- It is idempotent by id: an id the peer already holds adds nothing.
- One writer per peer. A head mismatch returns `conflict`. An uncertain commit returns
  `uncertain`. The caller reopens and replans (SPEC-6 vNext §2).
- The store receives deltas that admission has already verified. It stores canonical bytes and
  never re-signs or repairs them.

**Cost.** O(Σ|delta| × log N) for the batch. Nothing in an append may read the whole set.

### 4.6 Change feed

`changes(from, to)` returns, in revision order, one record per committed append or purge:
`{revision, added: Id[], removed: Id[]}`.

- Its cost is O(changes returned), never O(store).
- A store MAY drop records older than its retention window. A request older than the window
  returns `resync-required`. The caller then rebuilds only the views it holds (§6), not the
  store.
- The feed replaces three things: the reactor's in-memory dispatch log, `deltasSince(knownIds)`
  catch-up, and Loam's `data_version` detection of other writers. A reader in another process
  follows the feed and sees the other writer's commits.

**Freshness check.** A portable read captured at revision r is still current at revision r′
when no change in `changes(r, r′)` touches its scope: no added delta points at an entity in E
or negates a member, and no removed id is a member. This costs O(changes since capture), not
O(scope) and not O(store). It replaces SPEC-16's recompute-the-whole-scope check.

### 4.7 Capabilities

#### 4.7.1 Values

```ts
values(role: string, range: ValRange, page: PageToken): Promise<ValuePage>;
```

Ordered by the SPEC-5 §4 canonical type order, then id. O(log N + page). This makes a value
range an anchor, like an entity: a read selected by `releaseYear between 1990–1999` costs
its result, not the store. (This is an extension of SPEC-17 §5, listed as open question 6.)

#### 4.7.2 Erasure

```ts
purge(ids: readonly Id[]): Promise<PurgeReport>;
```

- Removes the target bytes from this peer. Bytes another peer still holds stay. The report says
  `held-by-other-peer` for those, without naming the other peer.
- Removes the target's index entries and arrival rows for this peer, and writes one change
  record (`removed`).
- `PurgeReport` lists each declared storage surface (rows, index entries, journal frames,
  checkpoints, freed pages, write-ahead logs, segment files, caches) with `absent`, `owed` or
  `unprovable`.
- The profile declares the erasure class:
  - **`proven`**: every surface can prove absence (for example SQLite with `secure_delete` and a
    truncated WAL, or a file per delta).
  - **`unprovable`**: some surface cannot prove absence (for example IndexedDB, an LSM tree
    before compaction, or a versioned object bucket). The store still deletes, but the host MUST
    report `unproven` for every erasure. It fails closed (SPEC-6 vNext §1).

#### 4.7.3 Journal

The SPEC-6 vNext durable journal (`DurableOrdinaryJournalStore`) is this capability, with one
change: **open reads the checkpoint and the frames after it, not the whole chain.** The checkpoint
cadence is bounded, so the tail is bounded.

This needs a change in SPEC-6 vNext. Today the checkpoint image (`encodeDurablePeerState`) carries
the whole admitted delta set and every arrival record. That makes the checkpoint itself O(store). Under this proposal
the journal image keeps only the head, refusals, purge obligations and counters. Holdings and
arrivals live in the store's indexed tables, written in the same atomic append (§4.5). See open
question 4.

#### 4.7.4 Views

```ts
interface ViewStore {
  get(key: ViewKey): Promise<StoredView | undefined>;
  put(key: ViewKey, view: StoredView): Promise<void>;
  affected(entities: readonly Entity[], ids: readonly Id[]): Promise<readonly ViewKey[]>;
  drop(key: ViewKey): Promise<void>;
}
type StoredView = {
  hview: Uint8Array;           // canonical HView bytes
  scope: readonly Entity[];    // E* of the read that produced it (SPEC-17 §6)
  members: Digest;             // S(E*) membership digest
  revision: Revision;          // the snapshot it was evaluated at
  expiresAt?: number;          // next validFrom/validUntil boundary inside the scope
};
```

`ViewKey` is (term hash, root, pin set, reading hash). `affected` answers "which stored views
include one of these entities in their scope", through a durable scope index. This is the
SPEC-4 §4.1 dispatch structure, held on disk. Cost O(k × log N + result).

#### 4.7.5 Digest

```ts
digest(prefix: IdPrefix): Promise<{ count: number; hash: Uint8Array }>;
```

A hash over the sorted held ids that share an id prefix, maintained incrementally (a Merkle
tree over id prefixes). Two peers reconcile by comparing digests top-down, in
O(differences × log N). This is for step 7 (federation). It is not needed before then.

#### 4.7.6 Export

```ts
interface Exporter {
  ids(): AsyncIterable<Id>;
  deltas(): AsyncIterable<Delta>;
  repack?(): Promise<void>;
}
```

O(N) by definition. Only admin, backup, repack and unanchored-term paths may use it (§6.5).

### 4.8 Profile

```ts
type StoreProfile = {
  capabilities: { values: boolean; arrival: boolean; journal: boolean; views: boolean;
                  digest: boolean; erasure: "proven" | "unprovable" | "none" };
  pushdown: { timestampAtMost: boolean; arrivalAtMost: boolean; exclude: boolean };
  writers: "one-process" | "many-processes";   // who may append concurrently, per peer
  atRest: "trusted" | "untrusted";             // §4.9
  changeRetention: "unbounded" | { revisions: number };
};
```

A host names the capabilities it requires. Open fails with a message that names each missing
one. A store never claims a capability it implements by scanning.

### 4.9 Trust at rest

- **`trusted`**: the bytes on this store are only written by admission in this host. Reads
  check the content id, which is cheap. They do not re-verify signatures.
- **`untrusted`**: other parties can write the medium (a shared bucket, a remote replica).
  Reads verify the content id and the signature. A verified (id, signature) pair is cached, as
  `verifyDelta` already does.

## 5. Architectures

Each architecture implements the same interface. They differ in layout, capabilities and cost
constants. The comparison table is at the end of this section.

### 5.1 Memory (reference)

Maps and sorted arrays: `id → delta`, `entity → ids`, `negated → ids`, `(role, value) → ids`,
`peer → holdings and arrivals`, and a change array.

- **Use:** conformance vectors, tests, the browser playground, short-lived processes.
- **Profile:** every capability except `erasure: proven` (process memory cannot prove absence;
  it declares `unprovable`). `writers: one-process`. `atRest: trusted`.
- **Role:** the reference. Every other store must give the same ids for the same operations.
- **Limit:** RAM. This is today's model, kept as one choice instead of the only one.

### 5.2 Relational (SQLite, Postgres)

```sql
delta   (rowid INTEGER PRIMARY KEY, id BLOB UNIQUE, bytes BLOB, refs INTEGER)  -- shared bytes
pointer (peer, delta, role, entity, context, ref, num, str, bool)              -- one row per pointer
        INDEX (peer, entity, delta)                   -- targets
        INDEX (peer, ref, delta) WHERE role='negates' -- negators
        INDEX (peer, role, num, delta), (peer, role, str, delta)  -- values
holding (peer, delta, seq, transfer, arrived_at, sender)  PRIMARY KEY (peer, delta)
        INDEX (peer, seq)                             -- as-of on arrival
change  (peer, revision, added BLOB, removed BLOB)    PRIMARY KEY (peer, revision)
view    (peer, key, hview, members, revision, expires_at)
view_scope (peer, entity, key)  INDEX (peer, entity)  -- ViewStore.affected
journal tables as today (head, frames, checkpoint, debts)
```

- **Scope in one statement.** A recursive common table expression computes S(E): the first
  term selects pointer rows at E, and the recursive term follows `negates` rows. Pushdown is a
  `JOIN holding … WHERE seq <= ?`.
- **Atomic append** is one transaction. A head mismatch is detected inside it.
- **Per-peer index rows:** the `peer` column leads every index, so one peer's reads never pay for
  another peer's rows. Bytes stay shared and reference-counted.
- **Erasure:** SQLite with `secure_delete = ON` and a truncated WAL proves absence for rows and
  pages (Loam already does this). Postgres cannot prove that freed pages are gone without
  `VACUUM FULL` and no replicas, so it declares `unprovable` unless the operator configures and
  attests otherwise.
- **Use:** servers and CLIs. SQLite also runs in browsers through WASM with OPFS persistence.
- **`writers`:** SQLite `many-processes` (WAL, one writer at a time; the change feed shows other
  writers). Postgres `many-processes`.

### 5.3 Ordered key-value (IndexedDB, LMDB, RocksDB, FoundationDB)

Every index is a key prefix. Prefix scans give O(log N + result).

```
B/<id>                          → canonical bytes          (shared)
R/<id>                          → reference count
H/<peer>/<id>                   → arrival record
A/<peer>/<seq>                  → id                        (as-of on arrival)
T/<peer>/<entity>/<id>          → ∅                         (targets)
N/<peer>/<negated>/<id>         → ∅                         (negators)
V/<peer>/<role>/<ordered value>/<id> → ∅                    (values)
C/<peer>/<revision>             → change record
W/<peer>/<view key>             → stored view;  S/<peer>/<entity>/<view key> → ∅
J/<peer>/…                      → journal
```

- Values use an order-preserving byte encoding: a type tag in SPEC-5 §4 order, then sortable
  number bytes or UTF-8 bytes. Entity and id components are length-prefixed so that prefixes
  cannot collide.
- **Scope** runs iteratively: one batch of `T/` scans, then rounds of `N/` scans until the
  closure stops growing. It takes one read transaction and depth+1 rounds.
- **Use:** browsers (IndexedDB), embedded and edge hosts (LMDB), large single-node servers
  (RocksDB), distributed stores (FoundationDB).
- **Trap:** an IndexedDB transaction commits as soon as the code awaits anything that is not an
  IndexedDB request. A snapshot must issue all of one round's requests before it awaits. The
  adapter enforces this with its batch shape (design rule 4).
- **Erasure:** an LSM tree (RocksDB) keeps deleted values in old files until compaction. It can
  prove absence after a targeted compaction of the key range, so it declares `proven` only when
  it runs that compaction inside `purge`. IndexedDB declares `unprovable`.

### 5.4 Immutable segments (packs plus a sidecar index)

The log becomes immutable files. Each **segment** is a SPEC-8 pack plus a sorted sidecar index:
an id table, `entity → ids`, `negated → ids`, `(role, value) → ids`, and a Bloom filter per key
class. A small **manifest** lists the live segments at each revision.

- **Writes** go to a mutable head tier, which is another store (§5.6 overlay). A compactor seals
  the head into a segment and merges segments by size tiers, as in an LSM tree. The segment
  count stays O(log N), so a lookup costs O(log² N).
- **Reads** need only range requests. A segment set on object storage or a CDN is a read-only
  peer that anyone can query with anchored reads. That is the read side of federation as query
  (NOTE-11).
- **Erasure** rewrites each segment that holds a target, then deletes the old object. A size cap
  per segment bounds the cost. Absence is `proven` only on a bucket with no versioning and no
  retention lock. Otherwise it is `unprovable`.
- **Use:** archives, cold tiers, published read replicas, backups that stay queryable.
- **`atRest`:** `untrusted` when the bucket is shared.

### 5.5 Remote

A store whose operations are requests to another host, which runs any store. `scope` is one
request. The profile is the server's profile, minus whatever the protocol does not carry.
`atRest` is `untrusted`. This is the transport for read replicas and for step 7's federation
reads. It is defined here only as an interface consumer; its wire format belongs to step 7.

### 5.6 Compositions

The set is a grow-only union, so compositions are sound by construction:

- **Union** of stores A and B: `targets`, `negators` and `scope` return the union of results.
  The revision is the pair of revisions. This is used for tiers and multi-source reads.
- **Overlay** (hot over cold): reads are a union. Writes go to hot. A mover seals settled data
  into cold. A purge MUST reach both, and the report combines both surfaces.
- **Cache** over any store: memory entries keyed by revision, invalidated by the change feed. It
  is bounded by size, never by the store.

### 5.7 Comparison

| | Memory | Relational | Ordered KV | Segments | Remote |
|---|---|---|---|---|---|
| Platforms | any | server, CLI, WASM | browser, embedded, edge, server | object storage, CDN | any client |
| Scope round trips | 0 | 1 (recursive CTE) | depth + 1 | depth + 1 | 1 |
| Read cost | O(result) | O(log N + result) | O(log N + result) | O(log² N + result) | server's + network |
| Append | O(batch) | O(batch log N) | O(batch log N) | head tier + compaction | not offered |
| Change feed | yes | yes | yes | manifest log | yes |
| Erasure class | unprovable | SQLite proven; Postgres unprovable by default | LMDB proven; RocksDB proven with compaction; IndexedDB unprovable | proven on unversioned buckets | server's |
| Writers | one process | many processes | engine-specific | one compactor | none |
| At rest | trusted | trusted | trusted | trusted or untrusted | untrusted |

## 6. The reactor over a store

The reactor stops holding the delta set. It holds a store, the registered terms, and a bounded
cache.

1. **Open.** Open the store and check its profile. Load registered terms by hash when a read or
   dispatch first needs them. No replay.
2. **Read** (SPEC-17 §6). Each discovery round makes one `scope(E_i, pushdown)` call on one
   snapshot, trims with the residual selection, and evaluates synchronously in memory. A read
   holds at most its own scope in memory.
3. **Ingest.** Admission validates and verifies. Then `append` commits atomically. Then dispatch
   reads the new change record. For each added delta it calls `ViewStore.affected` with the
   delta's target entities. For a negation of x, it uses x's target entities, from `get(x)`.
   Each affected view is evaluated again over its scope, or marked stale and evaluated on its
   next read.
4. **Views.** A maintained view is a stored, anchored read. It is current when its revision is
   current for its scope (§4.6) and `now` is before `expiresAt`. Incremental equivalence
   (SPEC-4 §1) still holds: a view evaluated again over its scope equals a batch evaluation over
   the full set (SPEC-17 §6 theorem).
5. **Subscriptions.** A subscription to a view is told when dispatch touches that view. A
   subscription to the raw stream reads the change feed from its last revision. A reconnecting
   subscriber resumes from a revision. When that revision is past retention, it receives
   `resync-required` and re-reads its views.
6. **Unanchored terms.** An unanchored term needs the whole set. A host evaluates it through the
   `Exporter` and dispatches it on every change. This mode is an explicit P7 exception. It is
   never silent: the host declares each such term at registration, and it may refuse them
   (open question 5).

## 7. Conformance

- **Store vectors** (`vectors/store/*.json`) are operation scripts: open peers, append batches
  (including negation chains, negations before their targets and duplicates), purge, then
  query. Each step names its expected ids or report. Every store adapter in every witness runs
  them. The memory reference store generates them.
- **Scope vectors** pin the trim lemma: for each case, `S(E over R ∩ a)` equals the reference
  exactly, with and without each pushdown field.
- **Cost rails** count store calls, not milliseconds, as Loam's anchored-read rail does: the
  same read against a store with 0 and with N unrelated deltas makes the same calls with the
  same key counts.
- **Adapter rails** stay local to each adapter: crash during append (all or nothing), a
  second-process writer seen through the feed, and erasure surface proofs on real files.
- **Witness levels.** The store interface is an L2/L4 concern. The Elixir and Haskell witnesses
  at L0 are unaffected.

## 8. Packaging

- `rhizomatic-store` holds the interface, the profile, the memory reference store, the
  composition helpers and the vector runner. It depends only on `delta`. It replaces today's
  `storage` package, which already depends only on `delta`.
- `reactor` gains a dependency on `rhizomatic-store`. `federation` keeps its dependency on
  storage.
- Adapters are separate packages so that a browser bundle does not carry SQLite:
  `rhizomatic-store-sqlite` (Node and Rust), later `-indexeddb`, `-segments`, `-postgres`.
- Rust mirrors the interface as traits. Its SQLite adapter uses `rusqlite`, so both witnesses
  run the same store vectors against a real durable store.

## 9. Slices

1. **Interface and reference.** This document, the TS and Rust interfaces, the memory reference
   store, the store vectors, the scope and trim vectors. Nothing else changes.
2. **Reactor over a store.** Reads in rounds through `scope`; `snapshot()` moves to the
   `Exporter`. Every existing vector passes on the memory store. TS and Rust in lockstep.
3. **Views and the change feed.** Stored views, durable dispatch through `affected`,
   subscriptions from the feed, view expiry. The incremental-equivalence oracle stays.
4. **SQLite adapters** (TS and Rust) with proven erasure. Holdings and arrivals move out of the
   journal image into indexed tables (SPEC-6 vNext change). Open reads checkpoint plus tail.
5. **Loam adoption.** Loam's gateway runs on `rhizomatic-store-sqlite`. Its replay at boot, its
   own SQLite backend and its `data_version` check are deleted.
6. **Later, by need.** IndexedDB (Loam in the browser), segments and the remote store (with
   step 7), the digest capability (with step 7), Postgres.

## 10. What this replaces

- The SPEC-4 §3 normative minimum moves here. The four indexes become store obligations, not
  reactor fields.
- SPEC-4 §4.4 checkpoints become stored views (§4.7.4).
- SPEC-16's current-source check by recomputation becomes the feed check (§4.6).
- `deltasSince(knownIds)` becomes `changes(from)`.
- Loam's `StoreBackend` and its `revision()` check become a `rhizomatic-store` adapter.

## 11. Open questions (Myk)

1. **The async boundary.** Recommended: batch-async calls at the store, synchronous evaluation
   over a fetched scope (design rule 4). The alternative is an async evaluator, which changes
   every operator and is slower per delta. Agree?
2. **Order.** Slices 1–4 before step 7, so step 7's subscribe and catch-up are built on the change
   feed, not on whole-journal reads?
3. **Where adapters live.** Recommended: SQLite in this repo (both witnesses need a durable store
   for parity), browser and cloud adapters as separate packages here too, Loam-specific storage
   nowhere. Agree?
4. **The journal image.** Moving holdings and arrivals out of the journal image changes the step
   6 profile that just shipped (SPEC-6 vNext §2, "Greenfield durable journal profile"). It is
   greenfield, so there is no migration. Is that change acceptable?
5. **Unanchored terms on a durable store.** Allow them as a declared exception (§6.6), or refuse
   them at registration when the store is not in memory?
6. **Value ranges as anchors.** Extend SPEC-17 so a `select` with a `ValMatch` range is anchored
   through the value capability (§4.7.1)? This makes "all plants taller than 30" a
   footprint-bounded read.
7. **Erasure honesty for engines that cannot prove absence.** Recommended: they declare
   `unprovable` and every erasure report says `unproven`. The alternative is to forbid them for
   peers with a `permanent` erasure posture. Which?

## 12. Not in scope

- The L0 pack format (SPEC-8). Segments reuse it unchanged.
- Partitioning one peer across machines. The interface does not prevent it; no slice builds it.
- A query planner for ad hoc unregistered terms (SPEC-4 §8 "cold queries").
