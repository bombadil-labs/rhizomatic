# SPEC-18 proposal: the store

**Status:** Proposal. Drafted 2026-10-15 (issue #75). Myk settled every open design question on
2026-11-09; §12 records each answer. This document is the working contract until its parts are
promoted into `spec/04-reactor.md`, `spec/06-peer-admission.PROPOSAL.md` and a store chapter
with shared vectors. **Order:** all six slices in §10 land before step 7 begins.

**Depends on:** SPEC-1 (content addressing), SPEC-2 (predicates, `ValMatch`), SPEC-4 (reactor),
SPEC-6 vNext (peers, journal, arrival, erasure), SPEC-8 (packs), SPEC-9 (aliases), SPEC-17 (P7,
delta source, scope of a read).

---

## 1. Why

SPEC-4 §3 says "the log *is* the database." Both witnesses keep the log and every index in
memory instead. A durable store is only a backup that is read whole at open.

- Opening a peer costs O(store): every row or journal frame is read and replayed.
- Memory grows with the store, so RAM is the limit on store size.
- Another process's writes are invisible until reopen.
- Erasure recovery, catch-up and federation sync read whole sets.

SPEC-17 made one read cost its footprint, but only because the in-memory indexes exist. P7 also
applies to a peer's whole delta set: **no operation, including open, may cost O(store).**

This proposal does not choose one database. It defines what any store must answer, what it may
optionally answer, and how a host finds out which it is talking to. Implementations specialize.

## 2. What a store serves

Each requirement comes from a rule rhizomatic already has.

| # | Requirement | Source |
|---|---|---|
| R1 | Content-addressed, idempotent union: appending a held id is a no-op; any order converges | SPEC-1, SPEC-4 §2 |
| R2 | The delta source: `get`, `targets(entity)`, `negators(id)` in O(log N + result) | SPEC-17 §3 |
| R3 | The scope of a read, S(E), in a few round trips, not one per delta | SPEC-17 §4, §6 |
| R4 | Value ranges over `(role, primitive)`, ordered, for `ValMatch` | SPEC-2 §3, SPEC-4 §3 |
| R5 | Three time axes. Signed time and validity are fields of the delta (no index needed). Arrival is per-peer testimony and needs an index | SPEC-6 vNext §3 |
| R6 | Peers: one membership set per peer over shared bytes; one writer per peer; head compare-and-set | SPEC-6 vNext §1, §2 |
| R7 | Erasure: physical removal with a proof per storage surface, or an honest `unproven`, declared before data is written | SPEC-6 vNext §1, §2; §4.7.2 |
| R8 | Change: a revision, and the changes between two revisions in O(changes) | SPEC-4 §5 |
| R9 | Maintained views and derived indexes, found by what they depend on | SPEC-4 §4, SPEC-17 §6 |
| R10 | Federation: set reconciliation without a whole-set scan | SPEC-6, step 7 |
| R11 | Platforms: server, browser, embedded, object storage, memory | portability (README) |

**Surface.** Every read runs inside one peer, under one authorization. Its **surface** is the
deltas that peer holds and this reader may see. A peer may be a whole host or a pool many levels
down; each has its own surface. "Full-surface" below means the reader's surface, never the
physical store.

## 3. Design rules

1. **The contract is logical; the layout is free.** As in SPEC-8, the content address is the
   contract. Two stores that answer every operation with the same ids are equivalent, whatever
   their tables, keys or files.
2. **A small required core, plus declared capabilities.** Every store implements the core
   (§4.1–§4.6). Other operations are capabilities (§4.7). A store declares its capabilities in a
   profile (§4.8). A host checks the profile and refuses to start when a capability it needs is
   absent. It never falls back to a scan.
3. **Whole-store operations live on a separate object.** Listing every id, exporting, repacking,
   backup and `fsck` are on an `Exporter` that `openAdmin()` returns. The serving path never
   receives one, except for a declared full-surface read (§6.6).
4. **The boundary is batch-shaped and asynchronous; evaluation stays synchronous.** A read
   fetches its scope one round at a time and evaluates in memory between rounds (§4.4). The
   scope is footprint-bounded, so holding it in memory is allowed. The Rust witness uses
   synchronous store traits; the batch shape fits both.
5. **Composition follows from union.** The delta set is a grow-only set, so the union of two
   stores is a store. Tiers, caches, replicas, delegated indexes and multi-peer views are
   compositions (§5.6), not special cases.

## 4. The interface

The shapes below are written in TypeScript. The Rust witness mirrors them as synchronous traits
in its own idiom. Results are sets of delta ids unless stated. "Exact" means the conformance
vectors compare the result byte for byte with the memory reference store (§5.1).

### 4.1 Open and peers

```ts
interface Store {
  readonly profile: StoreProfile;          // §4.8
  createPeer(id: PeerId, options: { erasure: "proven" | "unproven" }): Promise<PeerStore>;
  peer(id: PeerId): Promise<PeerStore>;    // opens an existing peer's logical store
  openAdmin(): Exporter;                   // whole-store operations, §4.7.6
  close(): Promise<void>;
}
function openStore(url: string, options?: OpenOptions): Promise<Store>;   // §4.10
```

- `createPeer` makes a peer with no holdings. Its erasure posture is a required argument, so it
  is fixed before the first write (§4.7.2). It refuses `posture-refused` when the posture is
  `proven` and the store's erasure class is not, and `peer-exists` when the id is taken.
- `peer` opens an existing peer and refuses `peer-absent`. It never creates one: a peer without a
  declared posture cannot exist.
- A `PeerStore` exposes `erasure: { posture, storeClass }`, the posture and the store's class
  recorded at creation.

A store holds the bytes of every delta once. Each peer has its own membership, indexes,
arrivals, journal, revision and change feed (R6). A peer's operations never return another
peer's ids. Opening a peer costs O(1) plus the journal checkpoint and tail (§4.7.3), never
O(holdings).

### 4.2 Snapshots and revisions

```ts
interface PeerStore {
  read(): Promise<Snapshot>;               // a consistent, repeatable view at one revision
  append(batch: Admission): Promise<AppendResult>;               // §4.5
  purge(ids: readonly Id[]): Promise<PurgeReport>;               // §4.7.2
  changes(from: Revision, to?: Revision): Promise<ChangePage>;   // §4.6, from slice 3
}
interface Snapshot {
  readonly revision: Revision;
  readonly head: Head | null;              // the journal head at this revision
  readonly count: number;                  // how many deltas the peer holds, O(1)
  get(ids: readonly Id[]): Promise<readonly Delta[]>;            // exact, held ids only
  arrivals(ids: readonly Id[]): Promise<readonly ArrivalRecord[]>; // exact, held ids only
  targets(entities: readonly Entity[]): Promise<readonly Id[]>;  // exact, union over entities
  negators(ids: readonly Id[]): Promise<readonly Id[]>;          // exact, direct negators only
  scope(request: ScopeRequest): Promise<ScopeResult>;            // §4.3
  release(): void;
}
```

- A revision is a peer-local value that increases with each committed append or purge that
  changes what a snapshot can observe: the holdings or the head. Two snapshots at the same
  revision answer every operation identically.
- Every list a store returns is ascending by the UTF-8 bytes of the id, with no id twice.
- **Probes.** "Does this peer hold x" and "which of these does it hold" are `get` or `arrivals`
  with those ids. "Does it hold anything" is `count`.
- Every operation on one snapshot sees the same revision. An implementation without native
  read transactions meets this with a revision check after each batch, failing with
  `snapshot-moved`.
- A synchronous implementation MAY also expose the SPEC-17 `DeltaSource` directly.
- `scopeSource(members)` builds a synchronous `DeltaSource` over the members one read has
  fetched (`ScopeResult.deltas`, from one or several rounds). It answers `get`, `targets` and
  `negators` restricted to the fetched set, and each member's arrival record. Code that must
  evaluate synchronously fetches once, then reads this.

**Cost.** `get`, `targets` and `negators` cost O(k × log N + result), where k is the number of
keys asked. No core operation may cost O(N).

### 4.3 The scope query

```ts
type ScopeRequest = {
  anchors: readonly Anchor[];   // §4.7.1: entities, value lookups, derived indexes
  pushdown?: Pushdown;
  exclude?: readonly Id[];      // ids the read already holds (§4.4)
};
```

- Let H be the peer's held set, and Hp the members of H that pass the pushdown selection p.
- Let S(A over D) be SPEC-17's scope generalized to anchors: every delta in D an anchor yields,
  closed under negators in D.
- Let q be the part of p the store reports applied (`ScopeResult.applied`), and Hq the members
  of H that pass q.
- The result R MUST satisfy `S(A over Hp) \ exclude ⊆ R ⊆ S(A over Hq)`. It carries the delta
  bytes and this peer's arrival record for each member of R, so the host needs no second round
  trip.

```ts
type ScopeResult = {
  deltas: readonly VerifiedDelta[];   // R: each delta with this peer's arrival record
  applied: { timestampAtMost: boolean; arrivalAtMost: boolean; excludeIds: boolean };
};
```

**Trim lemma.** S is monotone in the delta set: if D′ ⊆ D then `S(A over D′) ⊆ S(A over D)`.
So a host with a residual selection `a` (anything it did not push down) computes the exact scope
as `S(A over R ∩ a)` in memory, from R and what it already holds. Every negation chain it needs
is already there. Conformance vectors pin this against the memory reference.

A store MAY return more than `S(A over Hp)`. It MUST NOT return less, and it MUST NOT return ids
outside `S(A over Hq)`. That upper bound keeps the cost footprint-bounded, and it is what makes
the trim lemma exact: the host re-applies only what the store did not, so a store that reports a
field applied MUST NOT return a member that fails it. A field is reported applied only when it
was requested.

`exclude` and `Pushdown.excludeIds` differ. `exclude` only lets the store leave ids out of R;
negation chains still run through them. `excludeIds` is a selection: a chain stops at a dropped
id. The host applies its whole selection to the deltas it already holds before it trims.

**Pushdown.** A selection the store can apply itself:

```ts
type Pushdown = {
  timestampAtMost?: number;     // signed creation time ≤ t (as-of on signed time)
  arrivalAtMost?: ArrivalSeq;   // arrived at or before this sequence (as-of on arrival)
  excludeIds?: readonly Id[];   // a small explicit set, e.g. a read closure
};
```

A store that cannot apply a field ignores it and reports so in `ScopeResult.applied`. The host
applies the rest as a residual selection. Pushdown is an optimization, never a correctness
dependency.

### 4.4 A read: rounds and in-read caches

A read evaluates in rounds (SPEC-17 §6). All rounds of one read run on **one snapshot**, so
nothing a read caches can go stale during the read.

1. **Fetch.** One `scope` call for the anchors not yet fetched, with `exclude` set to the ids
   already held. The fetched set only grows.
2. **Evaluate** synchronously over the fetched set. Expansion that reaches an entity not yet
   fetched adds it to the next round's anchors.
3. Stop when a round adds no anchor. Rounds are at most the expansion depth plus one.

**Evaluation memo.** Each child evaluation is memoized by (program, schema, root). A child is
**final** once every anchor of its whole subtree has been fetched: by the SPEC-17 closure lemma,
its result over the fetched set equals its result over the surface. Only final children enter
the memo. A later round re-assembles the top level and evaluates the children it has not
finished.

**Across reads,** cached results are keyed by revision and invalidated through the change feed
(§4.6). This is the stored-view mechanism (§4.7.4); it needs nothing new.

**Later, optional:** an *expansion pushdown* capability lets a store follow `expand` roles
itself, so a SQL store can answer a two-level read in one round. It is added only if a benchmark
shows the need.

### 4.5 Write

```ts
type Admission = {
  expectedHead: Head | null;        // journal compare-and-set, SPEC-6 vNext §2
  nextHead: Head;
  frame: Uint8Array | null;         // the canonical journal frame (§4.7.3)
  added: readonly VerifiedDelta[];  // admitted deltas with their arrival records
};
type VerifiedDelta = { delta: Delta; arrival: ArrivalRecord };
type AppendResult =
  | { status: "committed"; revision: Revision; added: readonly Id[] }   // ids newly held
  | { status: "conflict" }
  | { status: "uncertain"; fault: string };
```

**One path for removal.** `purge` (§4.7.2) is the only operation that removes a delta from a
peer. An earlier draft also carried `erased` on `Admission`; it is not offered. An erasure is two
calls: `append` admits the order, then `purge` removes its targets. Slice 4 decides whether the
journal needs both in one commit, and adds that then.

- An append is atomic per peer. The new head, frame, membership, indexes (including every active
  derived index, §4.7.5), arrivals, holdings digest and one change record become visible
  together, or none of them do.
- It is idempotent by id: an id the peer already holds adds nothing, and keeps its first arrival
  record. A second appearance of an id inside one batch is ignored the same way.
- The store checks that each delta's id recomputes from its claims, and refuses
  `invalid-admission` otherwise. Claims are shared across peers by id, so an unchecked id would
  let one peer's append change what another peer reads. It does not check signatures.
- The store checks each new arrival record: it names its delta, and its sequence is greater than
  every sequence the peer has committed. A refused batch commits nothing.
- A store without the `journal` capability refuses a non-null `frame` with `capability-absent`.
  It still keeps the head and runs the compare-and-set.
- One writer per peer. A head mismatch returns `conflict`. An uncertain commit returns
  `uncertain`. The caller reopens and replans (SPEC-6 vNext §2).
- The store receives deltas that admission has already verified. It stores canonical bytes and
  never re-signs or repairs them.

**Cost.** O(Σ|delta| × log N + active derived indexes) for the batch. Nothing in an append may
read the whole set.

### 4.6 Change feed

`changes(from, to)` returns, in revision order, one record per committed append or purge:
`{revision, added: Id[], removed: Id[]}`.

- Its cost is O(changes returned), never O(store).
- A store MAY drop records older than its retention window. A request older than the window
  returns `resync-required`. The caller then rebuilds only what it holds (views, derived
  indexes), not the store.
- The feed replaces the reactor's in-memory dispatch log, `deltasSince(knownIds)` catch-up and
  Loam's `data_version` detection of other writers. A reader in another process follows the feed.

**Freshness check.** A capture at revision r is current at r′ when no change in `changes(r, r′)`
touches its scope: no added delta is yielded by one of its anchors or negates a member, and no
removed id is a member. This costs O(changes since capture). It replaces SPEC-16's recompute-the-
whole-scope check.

### 4.7 Capabilities

#### 4.7.1 Anchors and the value index

An **anchor** is anything the store can turn into delta ids from an index. There are three kinds:

| Anchor | Index | Example |
|---|---|---|
| Entity | target index | the root, a constant, an expanded child |
| Value lookup | value index on (role, primitive) | `releaseYear between 1990 and 1999` |
| Derived index | a registered hyperschema's selection (§4.7.5) | "authors in any group" |

`anchorAnalysis` (SPEC-17 §5) is extended to accept all three. A selection whose only unindexed
part is a value comparison on an indexed role becomes anchored.

```ts
values(role: string, range: ValRange, page: PageToken): Promise<ValuePage>;
```

Ordered by the SPEC-5 §4 canonical type order, then id. O(log N + page).

**Lazy value indexes.** A store keeps a value index for a role only while some active
hyperschema uses a value comparison on that role (the SPEC-4 §3 rule). The profile lists the
indexed roles. A value comparison on an unindexed role is not an anchor.

**`aliased` is anchored.** An `aliased` matcher (SPEC-9 §4) resolves in two indexed hops: a value
lookup on the role `rhizomatic.alias.fragment` finds the mappings for the name and their slots,
then `targets(slot)` finds every mapping to those slots. `via` adds entity lookups at the concept;
`trust` is a per-delta selection. The fragment role's value index is active whenever an active
hyperschema uses `aliased`.

#### 4.7.2 Erasure

```ts
purge(ids: readonly Id[]): Promise<PurgeReport>;   // on PeerStore
type PurgeReport = {
  claim: "proven" | "unproven";
  boundary: "store-controlled-surfaces";
  revision: Revision;
  targets: readonly { id: Id; outcome: "removed" | "held-by-other-peer" | "not-held" }[];
  surfaces: readonly { surface: string; state: "absent" | "owed" | "unprovable" }[];
};
```

- Removes the target bytes from this peer. Bytes another peer still holds stay. The report says
  `held-by-other-peer` for those, without naming the other peer.
- A peer that purged an id while another peer held the bytes **owes** that id. A later purge of
  the same id reports `removed` once the bytes are gone, and `held-by-other-peer` until then. An
  append that makes the peer hold the id again ends the debt.
- A peer that never held an id gets `not-held`, whoever else holds it. A purge never tells a
  peer about holdings it did not have.
- Removes the target's index entries, derived-index entries and arrival rows for this peer,
  updates the holdings digest, and writes one change record (`removed`).
- `PurgeReport` lists each declared storage surface (rows, index entries, journal frames,
  checkpoints, freed pages, write-ahead logs, segment files, caches) with `absent`, `owed` or
  `unprovable`.

**Erasure class.** The profile declares one:

- **`proven`**: every surface can prove absence.
- **`unprovable`**: some surface cannot. The store still removes the delta from every index and
  attempts physical removal, but every erasure report says `unproven`. Reports fail closed.

**Declared before data is written.** A peer declares its erasure posture when it is created.

- A peer that promises proven erasure **refuses to be created or opened** on a store whose class
  is not `proven`.
- A peer with a weaker posture records, at creation, that its store is `unprovable`. Its operator
  acknowledges this before the first write, not at the first erasure.
- Step 7 adds the peer's erasure class to its published peer description, so a sender can refuse
  to share data with a peer that cannot erase it.

**The boundary of "absent".** Absence covers the files and objects the store controls. It does not
cover filesystem or SSD remanence after a file is unlinked, or backups made outside the store.
Every erasure report states this boundary.

**Later extensions, not in scope now:**

- `attested`: an operator signs a declaration of out-of-band conditions (no WAL archive, no
  replicas). Reports would say "attested by X", never "proven".
- Erasure by key destruction: payloads encrypted at rest, keys held in a provable key store.
  Known open problem: indexes repeat payload (values, entity ids), and their remnants in an
  unprovable engine still leak unless index keys are protected, which breaks range queries.

#### 4.7.3 Journal

The SPEC-6 vNext durable journal (`DurableOrdinaryJournalStore`) is this capability, changed as
follows (decided 2026-11-09; greenfield, no migration):

- **The journal stays small.** It keeps the head chain, refusals, purge obligations and counters.
  Today the checkpoint image (`encodeDurablePeerState`) carries the whole admitted delta set and
  every arrival record; that ends.
- **Holdings and arrivals live in the store's indexed tables,** written in the same atomic append
  as the frame.
- **Each frame commits a Merkle root over the peer's holdings,** maintained incrementally at
  O(log N) per change (the digest capability, §4.7.6). The head chain therefore still commits to
  the exact admitted set.
- **Open reads the head, the checkpoint and the frames after it.** Its cost is the tail.
- **Verification moves from boot to use.** A missing or altered row is found when a read touches
  it (the read fails visibly; nothing is served silently) or by `fsck`, an explicit whole-surface
  admin operation on the `Exporter`. A read MAY verify a row's Merkle proof in O(log N). A
  read-only background scrub is a later option; it writes nothing on a quiet cycle.
- **A format-version marker** in the store replaces any boot-time scan for old record formats.
  Open checks it in O(1) and refuses an older format.
- **A consumer keeps its own marker beside it.** `meta` holds one application format string per
  peer, set at creation and returned by open in O(1). A consumer that retires one of its own record
  formats changes that string and refuses the old one. It needs no scan.

#### 4.7.4 Stored views

```ts
interface ViewStore {
  get(key: ViewKey): Promise<StoredView | undefined>;
  put(key: ViewKey, view: StoredView): Promise<void>;
  affected(anchors: readonly Anchor[], ids: readonly Id[]): Promise<readonly ViewKey[]>;
  drop(key: ViewKey): Promise<void>;
}
type StoredView = {
  hview: Uint8Array;           // canonical HView bytes
  anchors: readonly Anchor[];  // the read's final anchor set
  members: Digest;             // scope membership digest
  revision: Revision;          // the snapshot it was evaluated at
  expiresAt?: number;          // next validFrom/validUntil boundary inside the scope
};
```

`ViewKey` is (term hash, root, pin set, schema hash). `affected` answers "which stored views
depend on one of these anchors", through a durable anchor index. This is the SPEC-4 §4.1 dispatch
structure, held on disk. Cost O(k × log N + result).

#### 4.7.5 Derived indexes

**A hyperschema is an index plus meaning.** When a registered hyperschema's selection is not
covered by entity or value anchors, the store keeps a **derived index** for that selection.

- **Created at registration.** Registration runs one full-surface backfill and reports its cost
  and the new index in the registration response. Registering is the opt-in; there is no
  separate "promote" step.
- **Maintained per write.** Each append checks every active derived index's predicate against
  each new delta. Predicates see one delta at a time (SPEC-2 §3), so this is O(1) per write per
  index, independent of the surface. Negations and purges update membership the same way.
- **Shared.** Two hyperschemas with the same selection share one index, keyed by the canonical
  selection hash and the surface. It is reference-counted by the active hyperschemas that use it.
- **Lifecycle.**

  | State | When | Cost per write | Cost to use |
  |---|---|---|---|
  | Active | any active hyperschema uses it | one predicate check | footprint-bounded |
  | Dormant | no active user; kept for a while | none | catch up from the change feed, O(changes since) |
  | Dropped | dormant too long, or under budget pressure | none | a full-surface backfill |

  An index that drives an active hyperschema never goes dormant. Last-used time is local store
  metadata, never a signed delta.
- **A cache, not a rule.** A derived index is unsigned, local to its surface, rebuildable and
  never federated as data. The registered hyperschema is the signed rule; the index is its cost.
- **Delegation.** A peer MAY delegate a derived index to another peer, which serves the index read
  for one or many peers and grows on its own (a union composition, §5.6). Open details before it
  is built: authorization (an index peer must never return one peer's deltas to another peer's
  reader); completeness (returned deltas are checkable by id and signature, omissions are not, so
  a delegate is trusted by configuration until completeness proofs exist; the holdings digest is
  the starting point); freshness (the read's revision is a pair).

#### 4.7.6 Digest and export

```ts
digest(prefix: IdPrefix): Promise<{ count: number; hash: Uint8Array }>;
```

A hash over the sorted held ids that share an id prefix, maintained incrementally (a Merkle tree
over id prefixes). The journal commits its root (§4.7.3). Two peers reconcile by comparing digests
top-down in O(differences × log N); that use is for step 7.

```ts
interface Exporter {
  peers(): AsyncIterable<PeerId>;
  peer(id: PeerId): PeerExporter;        // one peer's holdings
  storedIds(): AsyncIterable<Id>;        // every id the store keeps bytes for
  fsck(): Promise<FsckReport>;           // from slice 4
  repack?(): Promise<void>;
}
interface PeerExporter {
  ids(): AsyncIterable<Id>;
  deltas(): AsyncIterable<Delta>;        // each as this peer admitted it
}
```

A listing is one peer's holdings unless its name says `stored`. `storedIds` names other peers'
deltas, so nothing may use it to choose what one peer purges or serves.

O(surface) by definition. Only admin, backup, `fsck`, repack, derived-index backfill and declared
full-surface reads (§6.6) use it.

### 4.8 Profile

```ts
type StoreProfile = {
  capabilities: { values: boolean; arrival: boolean; journal: boolean; views: boolean;
                  derivedIndexes: boolean; digest: boolean;
                  erasure: "proven" | "unprovable" | "none" };
  indexedValueRoles: readonly string[];
  pushdown: { timestampAtMost: boolean; arrivalAtMost: boolean; excludeIds: boolean };
  writers: "one-process" | "many-processes";   // who may append concurrently, per peer
  atRest: "trusted" | "untrusted";             // §4.9
  changeRetention: "none" | "unbounded" | { revisions: number };   // none: no change feed
  formatVersion: string;                       // §4.7.3
};
```

A host names the capabilities it requires. Open fails with a message that names each missing one.
A store never claims a capability it implements by scanning.

### 4.9 Trust at rest

- **`trusted`**: only admission in this host writes the medium. Reads check the content id.
  They do not re-verify signatures.
- **`untrusted`**: other parties can write the medium (a shared bucket, a remote store). Reads
  verify the content id and the signature. A verified (id, signature) pair is cached, as
  `verifyDelta` already does.

### 4.10 Opening a store

- `openStore(url)` selects an implementation by URL scheme: `memory:`, `sqlite:///path/file.db`,
  `opfs:name`, `postgres://…`, and so on as implementations land. It returns the store with its
  profile.
- `registerStoreScheme(scheme, factory)` adds a consumer's own implementation.
- `runStoreConformance(factory)` runs the shared store vectors (§8) against any implementation, so
  a consumer's own store is tested exactly as the built-in ones are.
- A connection string can carry credentials. The opener never logs or echoes it, and errors name
  the scheme only.

### 4.11 Slice 1 readings

Slice 1 built §4.1–§4.5, §4.7.2, the `Exporter` listings and §4.8–§4.10 on the memory store. Where
the text above was silent, slice 1 decided as follows. The shared vectors and
`vectors/store/README.md` pin each point.

1. **Peer creation.** `createPeer(id, { erasure })` and an async `peer(id)` (§4.1). Declaring
   `unproven` is the operator's acknowledgement of §4.7.2; there is no second flag. A peer id is
   an opaque non-empty string to the store.
2. **Refusals** are a `StoreError` with a `code`: `store-closed`, `unknown-scheme`,
   `invalid-url`, `scheme-exists`, `open-failed`, `capability-absent`, `peer-absent`,
   `peer-exists`, `posture-refused`, `invalid-admission`, `invalid-request`, `snapshot-moved`,
   `snapshot-released`.
3. **Revisions** are integers in the TypeScript witness. The contract is only their order inside
   one peer. A revision advances when the holdings or the head change, and at no other time: a
   committed append that adds nothing and keeps the head, a purge that removes nothing, and the
   settling of a purge debt do not advance it.
4. **The head** is readable on a snapshot (`Snapshot.head`). Without it a caller could not replan
   after `conflict` on a store that has no journal capability.
5. **Signatures are per peer.** Claims are stored once per id. The signature belongs to the
   holding, so a peer reads the appearance it admitted, also when another peer admitted the same
   id unsigned.
6. **The scope bounds** use the applied selection for the upper bound (§4.3). The first draft's
   upper bound, `S(A over H)`, let a store report a field applied and still return members that
   fail it; the trim lemma is false for such a store.
7. **A moved snapshot** refuses with `snapshot-moved` on the memory store. A store with read
   transactions answers at the snapshot's revision instead. Both conform; answering from the
   later state does not. `head` and `count` are fixed at read and never refuse.
8. **Removal** has one path, `purge` (§4.5).
9. **Purge debts** and `not-held` (§4.7.2). The memory store declares three surfaces: `rows`,
   `index-entries` (targets, negators and arrival rows) and `process-memory`. `rows` is `owed`
   while another peer holds a target's bytes. `process-memory` is always `unprovable`, so the
   claim is always `unproven`.
10. **The change feed is absent.** `changes` is not on the slice-1 `PeerStore`, and the memory
    profile says `changeRetention: "none"`. `StoreRequirement` `changes` fails at open.
11. **Requirements at open.** `openStore(url, { requires })` takes names from: `values`,
    `arrival`, `journal`, `views`, `derivedIndexes`, `digest`, `changes`, `purge`,
    `erasure-proven`. It closes the store and refuses `capability-absent`, naming each missing
    one.
12. **Schemes.** `memory:` takes no address; each open is a new empty store.
    `registerStoreScheme` returns a function that removes the scheme, refuses a scheme that is
    taken, and cannot replace a built-in. An error a factory throws that is not a `StoreError`
    is replaced by `open-failed` with the scheme name, because a driver's message may quote the
    URL.
13. **The memory profile in slice 1** reports `values`, `journal`, `views`, `derivedIndexes` and
    `digest` false, and `arrival` true. §5.1's "every capability" is the target for slice 6.
14. **Anchors** are a tagged union with one member, `{ kind: "entity", entity }`. A store refuses
    an anchor kind it has no index for with `capability-absent`.
15. **`ArrivalRecord`** moved from the `federation` package boundary to `storage`, which stores
    it. `federation` re-exports it. `storage` still depends only on `delta`.
16. **Conformance.** `runStoreConformance(factory, vectors?)` runs each script on a new store,
    returns what passed and what the profile made it skip, and throws listing every failure. The
    default vectors are generated in memory from the same model that writes `vectors/store/`.
17. **The cost rail** counts the memory store's index work through one counting door over every
    map (`StoreMeter`: keyed lookups, members visited, whole-map scans). The same operations
    over the same footprint make the same counts with 0 and with N unrelated deltas, and no core
    operation scans. Only the `Exporter` scans.

## 5. Architectures

Each architecture implements the same interface. They differ in layout, capabilities and cost
constants.

### 5.1 Memory (reference)

Maps and sorted arrays: `id → delta`, `entity → ids`, `negated → ids`, `(role, value) → ids`,
derived-index sets, `peer → holdings and arrivals`, and a change array.

- **Use:** conformance vectors, tests, the browser playground, short-lived processes.
- **Profile:** every capability; erasure `unprovable` (process memory cannot prove absence);
  `writers: one-process`; `atRest: trusted`.
- **Role:** the reference. Every other store must give the same ids for the same operations.

### 5.2 Relational (SQLite, Postgres)

```sql
delta   (rowid INTEGER PRIMARY KEY, id BLOB UNIQUE, bytes BLOB, refs INTEGER)  -- shared bytes
pointer (peer, delta, role, entity, context, ref, num, str, bool)              -- one row per pointer
        INDEX (peer, entity, delta)                   -- targets
        INDEX (peer, ref, delta) WHERE role='negates' -- negators
        INDEX (peer, role, num, delta), (peer, role, str, delta)  -- values, lazily per role
holding (peer, delta, seq, transfer, arrived_at, sender)  PRIMARY KEY (peer, delta)
        INDEX (peer, seq)                             -- as-of on arrival
digest  (peer, prefix, count, hash)                   -- holdings Merkle tree
derived (peer, index_key, delta)  INDEX (peer, index_key, delta)
change  (peer, revision, added BLOB, removed BLOB)    PRIMARY KEY (peer, revision)
view    (peer, key, hview, members, revision, expires_at)
view_anchor (peer, anchor, key)  INDEX (peer, anchor)  -- ViewStore.affected
meta    (key, value)                                   -- format version
journal tables (head, frames, small checkpoint, debts)
```

- **Scope in one statement:** a recursive common table expression selects pointer rows at the
  anchors, then follows `negates` rows. Pushdown is a `JOIN holding … WHERE seq <= ?`.
- **Atomic append** is one transaction; a head mismatch is detected inside it.
- **Per-peer index rows:** `peer` leads every index, so one peer's reads never pay for another
  peer's rows. A container that is a fence inside a peer, not its own peer, scans that peer's
  indexes and filters; its cost is the peer's, not the container's.
- **Erasure:** SQLite with `secure_delete = ON` and a truncated WAL is `proven` (Loam does this
  today). Postgres keeps dead rows until `VACUUM`, and even `VACUUM FULL` leaves WAL archives,
  replicas and backups, so it is `unprovable`.
- **Use:** servers and CLIs. SQLite also runs in browsers as WebAssembly over OPFS, where
  `secure_delete` works the same way; that is the browser path to `proven`.

### 5.3 Ordered key-value (IndexedDB, LMDB, RocksDB, FoundationDB)

Every index is a key prefix. Prefix scans give O(log N + result).

```
B/<id>                          → canonical bytes          (shared)
R/<id>                          → reference count
H/<peer>/<id>                   → arrival record
A/<peer>/<seq>                  → id                        (as-of on arrival)
T/<peer>/<entity>/<id>          → ∅                         (targets)
N/<peer>/<negated>/<id>         → ∅                         (negators)
V/<peer>/<role>/<ordered value>/<id> → ∅                    (values, lazily per role)
X/<peer>/<index key>/<id>       → ∅                         (derived indexes)
D/<peer>/<prefix>               → digest node
C/<peer>/<revision>             → change record
W/<peer>/<view key>             → stored view;  S/<peer>/<anchor>/<view key> → ∅
J/<peer>/…                      → journal
```

- Values use an order-preserving byte encoding: a type tag in SPEC-5 §4 order, then sortable
  number bytes or UTF-8 bytes. Components are length-prefixed so prefixes cannot collide.
- **Scope** runs iteratively in one read transaction: anchor scans, then `N/` rounds until the
  closure stops growing.
- **Trap:** an IndexedDB transaction commits as soon as code awaits anything that is not an
  IndexedDB request. The adapter issues all of a round's requests before it awaits.
- **Erasure:** LMDB keeps old bytes in freed pages until reuse; it is `proven` only after a
  compacting copy replaces the file inside `purge`. RocksDB keeps deleted values in old files
  until compaction; it is `proven` only with a forced compaction of the key range inside `purge`.
  IndexedDB is `unprovable`: the browser owns the engine underneath.

### 5.4 Immutable segments (packs plus a sidecar index)

The log becomes immutable files. Each **segment** is a SPEC-8 pack plus a sorted sidecar index:
an id table, `entity → ids`, `negated → ids`, `(role, value) → ids`, and a Bloom filter per key
class. A small **manifest** lists the live segments at each revision.

- **Writes** go to a mutable head tier, which is another store (§5.6 overlay). A compactor seals
  the head into a segment and merges segments by size tiers. The segment count stays O(log N), so
  a lookup costs O(log² N).
- **Reads** need only range requests. A segment set on object storage or a CDN is a read-only
  peer that anyone can query with anchored reads (the read side of NOTE-11).
- **Erasure** rewrites each segment that holds a target, then deletes the old object. A size cap
  per segment bounds the cost. `proven` only on a bucket with no versioning and no retention lock.
- **`atRest`:** `untrusted` when the bucket is shared.

### 5.5 Remote

A store whose operations are requests to another host, which runs any store. `scope` is one
request. The profile is the server's, minus whatever the protocol does not carry. `atRest` is
`untrusted`. Its wire format belongs to step 7.

### 5.6 Compositions

The set is a grow-only union, so compositions are sound by construction:

- **Union** of stores A and B: anchor lookups and `scope` return the union of results. The
  revision is the pair of revisions. Used for tiers, multi-source reads and delegated indexes.
- **Overlay** (hot over cold): reads are a union. Writes go to hot. A mover seals settled data
  into cold. A purge MUST reach both, and the report combines both surfaces.
- **Cache** over any store: memory entries keyed by revision, invalidated by the change feed,
  bounded by size.

### 5.7 Comparison

| | Memory | Relational | Ordered KV | Segments | Remote |
|---|---|---|---|---|---|
| Platforms | any | server, CLI, WASM + OPFS | browser, embedded, edge, server | object storage, CDN | any client |
| Scope round trips per round | 0 | 1 (recursive CTE) | closure depth + 1 | closure depth + 1 | 1 |
| Read cost | O(result) | O(log N + result) | O(log N + result) | O(log² N + result) | server's + network |
| Append | O(batch) | O(batch log N) | O(batch log N) | head tier + compaction | not offered |
| Change feed | yes | yes | yes | manifest log | yes |
| Erasure class | unprovable | SQLite proven; Postgres unprovable | LMDB, RocksDB proven with compaction in `purge`; IndexedDB unprovable | proven on unversioned buckets | server's |
| Writers | one process | many processes | engine-specific | one compactor | none |
| At rest | trusted | trusted | trusted | trusted or untrusted | untrusted |

## 6. The reactor over a store

The reactor stops holding the delta set. It holds a store, the registered terms, and a bounded
cache.

1. **Open.** Open the store and check its profile and format version. Load registered terms by
   hash when a read or dispatch first needs them. No replay.
2. **Read.** Rounds with both in-read caches (§4.4). A read holds at most its own scope in memory.
3. **Ingest.** Admission validates and verifies. `append` commits atomically, maintaining derived
   indexes. Dispatch reads the new change record: for each added delta it calls
   `ViewStore.affected` with the anchors the delta touches (its target entities, its indexed
   values, the derived indexes it entered). For a negation of x, it uses x's anchors, from
   `get(x)`. Each affected view is evaluated again over its scope, or marked stale and evaluated
   on its next read.
4. **Views.** A maintained view is a stored, anchored read. It is current when no change since its
   revision touches its anchors (§4.6) and `now` is before `expiresAt`. Incremental equivalence
   (SPEC-4 §1) still holds: a view evaluated again over its scope equals a batch evaluation over
   the surface (SPEC-17 §6 theorem). A very large view is evaluated again whole when it changes;
   finer maintenance is an optimization, not a contract change.
5. **Subscriptions.** A view subscription is told when dispatch touches that view. A raw-stream
   subscription reads the change feed from its last revision. A reconnecting subscriber resumes
   from a revision; past retention it receives `resync-required` and re-reads its views.
6. **Full-surface reads.** A read with a part that no anchor covers is a full-surface read.
   - A **registered** hyperschema never stays full-surface: registration creates its derived index
     (§4.7.5).
   - An **ad hoc** query that is never registered may run as a full-surface read only with an
     explicit flag. It reads the surface through the `Exporter`, is marked unoptimized in its
     route report and response, and leaves nothing behind.

## 7. Peers and erasure on a shared store

- Bytes are stored once and reference-counted by holdings. Indexes, derived indexes, arrivals,
  digests and change feeds are per peer.
- A purge removes a peer's index entries and holding at once. It removes bytes only when no other
  peer holds them, and its report says so without naming the other peer.
- A peer's erasure posture and its store's erasure class are both fixed and recorded before its
  first write (§4.7.2).

## 8. Conformance

- **Store vectors** (`vectors/store/*.json`) are operation scripts: create peers with a posture,
  append batches (negation chains, negations before their targets, duplicates), register and
  retire derived indexes, purge, then query. Each step names its expected ids or report. The memory
  reference store generates them. `runStoreConformance` runs them against any implementation.
- **Scope vectors** pin the trim lemma, generalized anchors and `aliased` anchoring: for each case,
  `S(A over R ∩ a)` equals the reference exactly, with and without each pushdown field.
- **Round vectors** pin that the fetch and evaluation caches change no answer: a read with caches
  equals the same read evaluated over the full surface.
- **Cost rails** count store calls, not milliseconds: the same read against a surface with 0 and
  with N unrelated deltas makes the same calls with the same key counts. Open counts O(tail).
- **Adapter rails** stay local to each implementation: crash during append (all or nothing), a
  second-process writer seen through the feed, erasure surface proofs on real files, and refusal
  to create a proven-posture peer on an `unprovable` store.
- **Witness levels.** The store is an L2/L4 concern. The Elixir and Haskell witnesses at L0 are
  unaffected.

## 9. Packaging

- **TypeScript:** one npm package, `@bombadil/rhizomatic`, as today. The store interface, the
  memory store, compositions, `openStore` and the conformance runner live in the `storage`
  package boundary, which depends only on `delta`. Each implementation is a subpath export, for
  example `@bombadil/rhizomatic/store/sqlite`. Native and platform dependencies (`better-sqlite3`,
  and later others) are optional peer dependencies, so a browser bundle never pulls SQLite.
- **Rust:** the store traits in the core crate; each implementation behind a cargo feature
  (`sqlite` pulls `rusqlite`).
- **The `reactor` boundary** gains a dependency on `storage`.
- **Every store implementation lives in this repo** and runs the store vectors in CI. Consumers
  keep their own application state on top. Loam keeps its quarantine and repair layer (Loam SPEC
  §25), built on a generic integrity-fault report from the store.

## 10. Slices

All six land before step 7 begins. The order puts a real consumer on the store as early as
possible: Loam moves in slice 5, before stored views and derived indexes exist.

| Slice | Contents |
|---|---|
| 1 | Interface, profile, memory reference store, `openStore`, `registerStoreScheme`, `runStoreConformance`, store and scope vectors. TS and Rust. |
| 2 | Reactor reads through a store: rounds, fetch cache and evaluation memo; `snapshot()` moves to the `Exporter`. Every existing vector passes on the memory store. |
| 3 | Revisions and the change feed: `changes(from, to)`, retention, `resync-required`, the freshness check, raw-stream subscriptions from a revision. |
| 4 | SQLite stores (TS and Rust) with proven erasure and posture gating; the journal split (small checkpoint, holdings Merkle root, open from the tail, `fsck`, format markers). |
| 5 | Loam moves onto `@bombadil/rhizomatic/store/sqlite` (§10.1). Its boot replay, its generic SQLite code and its `data_version` check are deleted; its repair layer stays. |
| 6 | Stored views and durable dispatch; derived indexes and their lifecycle; generalized anchors, lazy value indexes and `aliased` anchoring. |
| later | SQLite WASM over OPFS, IndexedDB (unprovable), Postgres, segments, the remote store, digest reconciliation, delegated index peers, `attested`, key destruction, expansion pushdown, background scrub. |

**Between slice 2 and slice 6** the capabilities `views` and `derivedIndexes` are absent from
every profile. During that time:

- A maintained view is a memory cache. It is keyed by revision and invalidated through the change
  feed once slice 3 lands. A process rebuilds it on first use after open. Open stays O(tail).
- A registered term that entity anchors do not cover runs as a full-surface read. Its route report
  marks it unoptimized. This is the cost such a term has today; slice 6 removes it.
- A value comparison is a residual selection, never an anchor.

### 10.1 What slice 5 covers in Loam

Slice 5 is more than a move. Measured on Loam main at `6cce5a25` (2026-11-09):

| Loam `src` | Count |
|---|---|
| Synchronous `reactor.get` calls | 125 |
| `reactor.snapshot()` calls | 46 |
| `byTarget` and `negationsOf` calls | 53 |
| `deltasSince` calls | 23 |
| Caches keyed on the reactor object | 7 |

- **Synchronous reads.** Loam's read and law code calls the reactor directly and synchronously.
  The store boundary is asynchronous. Each call site becomes one of three things: part of a read's
  scope (fetched in a round, then evaluated synchronously), an indexed store call, or an admin
  operation on the `Exporter`. Slice 2 defines the read shape Loam will use; slice 5 applies it.
- **Law reads are anchored reads.** Grants, erasure orders, slates, registrations and user roots
  each live at known entities. Loam reads each as a scope, once per request, and evaluates over
  it synchronously.
- **Caches key on the revision.** Loam's caches key on the reactor object or its size, and they
  rely on erasure replacing the reactor. A purge is now in place and writes a change record. Each
  cache keys on the peer's revision, or follows the change feed.
- **Reseat goes away.** Erasure no longer rebuilds the process state from the backend.
- **The other drivers.** Loam has five `StoreBackend` drivers: memory, SQLite, archive, mirror and
  local storage. Memory and SQLite become the store's own. Mirror becomes the overlay or union
  composition (§5.6) where it still has a use. Archive and local storage are decided in slice 5:
  each becomes a store implementation with a declared profile, or it is deleted.
- **Erasure rails on memory.** The memory store's class is `unprovable`. A Loam rail that asserts
  a proven erasure runs on SQLite. A rail on memory asserts the index-level removal and an
  `unproven` report.
- **Loam's own format marker.** Loam's check for retired slate records runs inside boot replay
  today. It becomes Loam's application format string (§4.7.3).
- **Review.** Slice 5 moves erasure code. It may not widen what a purge removes. Every erasure
  rail stays two-sided: the target is gone and a named bystander survives.

## 11. What this replaces

- The SPEC-4 §3 normative minimum moves here. The indexes become store obligations, not reactor
  fields.
- SPEC-4 §4.4 checkpoints become stored views (§4.7.4).
- SPEC-6 vNext's checkpoint image no longer carries holdings or arrivals (§4.7.3).
- SPEC-16's current-source check by recomputation becomes the feed check (§4.6).
- SPEC-17's anchors grow from entities to entities, value lookups and derived indexes (§4.7.1).
- `deltasSince(knownIds)` becomes `changes(from)`.
- Loam's `StoreBackend`, its boot replay and its `revision()` check become this store.

## 12. Decision record (Myk, 2026-11-09)

| # | Question | Decision |
|---|---|---|
| 1 | The async boundary | Batch-async store calls; synchronous evaluation in rounds over one snapshot, with a fetch cache and an evaluation memo of final children; cross-read caching by revision. Rust uses synchronous traits. |
| 2 | The journal checkpoint | The journal stays small; holdings and arrivals move to indexed tables in the same atomic append; each frame commits a holdings Merkle root; open reads the tail; verification moves from boot to use and `fsck`; a format-version marker replaces boot scans. |
| 3 | Unanchored terms | "Full-surface", measured against the reader's surface. A hyperschema is an index plus meaning: registration creates its derived index (one backfill, cost reported). Ad hoc full-surface reads need an explicit flag and are marked unoptimized. Derived indexes are shared, reference-counted caches; active while a hyperschema uses them, then dormant, then dropped. Index work may be delegated to another peer. |
| 4 | Value ranges as anchors | Yes. Anchors are entities, value lookups and derived indexes. Value indexes are lazy, per role. `aliased` is anchored through the fragment role's value index. |
| 5 | Erasure where absence is unprovable | Gate by posture: a peer promising proven erasure refuses a store that is not `proven`. Others run anywhere and report `unproven`. The posture and the store's class are fixed before the first write. `attested` and key destruction are later. |
| 6 | Where implementations live | All in this repo: subpath exports in one npm package with optional peer dependencies; cargo features in Rust. `openStore(url)` with ready-made schemes; a published interface and conformance runner for consumers' own stores. Loam keeps its repair layer. |
| 7 | Order relative to step 7 | The store arc first; step 7 begins once it has landed. |

**Amendment (Claude as steward of both repositories, 2026-11-09).** The former slice 3 is split.
The change feed stays slice 3. Stored views, derived indexes and generalized anchors move to
slice 6, after Loam is on the store. No content is removed, and the whole arc still lands before
step 7. The reason: slice 5 depends on the feed and on nothing else in the former slice 3, and a
consumer on the store tests the interface before the largest slice is built on it. §10.1 lists
what slice 5 covers in Loam.

**Open items carried forward** (not blocking slice 1):

- Loam's archive and local-storage drivers: a store implementation each, or deletion (slice 5).
- Delegated index peers: authorization per reader surface, completeness proofs, freshness.
- A container that is a fence inside a peer pays the peer's index cost on scans (§5.2).
- Dormancy timing for orphaned derived indexes, and the per-peer budget.
- Step 7 publishes each peer's erasure class in its peer description.
- **Arrival history after a purge.** §4.7.2 removes the arrival row with the delta, and slice 1
  does so. Loam's arrival history keeps the id after erasure, and its recovery reads it. Whether
  a purge leaves a marker that an id once arrived is not decided (SPEC-6 vNext §3 requires a
  per-id marker when earlier arrival metadata is purged). Slice 1 adds no tombstone.
- **Ids by arrival range.** Slice 1 reads the arrival record of a held id (`arrivals`, and with
  each scope member) and selects by `arrivalAtMost`. It has no query that lists ids in an arrival
  range; that needs the ordered arrival index (§5.2 `INDEX (peer, seq)`).
- **Erasure in one commit.** Whether an erasure order and the removal of its targets must commit
  together (the dropped `Admission.erased`), decided with the journal split in slice 4.
- **Purge is not under the head compare-and-set.** A purge changes holdings without moving the
  journal head. Slice 4 decides how the journal frame of a purge and the removal commit together.

**Gaps found by the Loam call-site inventory** (Loam `refactor/store-move-inventory.md`, 2026-11-09).
Each needs an answer before the slice named. None changes slice 1.

- **Context anchors (slice 5 or 6).** Loam files law under one context at many entities, and reads
  "every delta with a pointer in context C". No anchor kind covers that. Either Loam files law at
  fixed entities (a Loam wire change), or the store gains a context anchor.
- **A reference index (slice 5).** "Every delta that references id X by any role." `negators`
  covers the role `negates` only. Loam's erasure tiers and slate members need the wider read.
- **Counts (slice 5).** A count of held deltas per author, for Loam's append budget. `count` on a
  snapshot answers only the total.
- **A whole-peer version address (slice 3 or 4).** Loam hashes every member of a pool to name its
  version. The holdings Merkle root (§4.7.6) can serve, if consumers accept that hash as the address.
- **Peer deletion (slice 4).** Dropping a pool removes a whole peer. The interface has no such
  operation. It must not be built as "purge every id the store-wide listing names": that listing
  covers other peers. The per-peer listing of slice 1 is the only safe input.
- **Reads that span peers (slice 5).** A pool reads its host's users. A scoped query composes a host
  and its pools. A negation closure crosses both. §4.4 gives one snapshot per read. The union
  composition (§5.6) is the likely answer; its revision is a pair.
- **The next validity boundary (slice 3).** Loam asks one whole-set question: when does any held
  delta next start or stop being valid? `expiresAt` on a stored view arrives only in slice 6.
- **A replica composition (slice 5).** Loam's mirror writes both stores, reads one, purges both and
  heals one from the other. §5.6 lists union, overlay and cache only.
- **The integrity-fault report (slice 4).** §9 names it and gives it no shape. Loam's repair layer
  is built on it.
- **Who builds the frame and the next head (slice 4).** `Admission` carries both. A consumer that
  admits through the journal peer never sees a frame. The journal peer builds the admission; the
  store only commits it. §4.5 should say so.
- **Posture of a default memory pool (slice 5).** Loam defaults a pool to a memory store, and its
  erase verdict needs every pool clean. Memory is `unprovable`.
- **Journal frames and payload (slice 4).** Whether a frame still carries delta bytes after the
  split decides whether the journal is an erasure surface.

## 13. Not in scope

- The L0 pack format (SPEC-8). Segments reuse it unchanged.
- Partitioning one peer across machines. The interface does not prevent it; no slice builds it.
- A query planner for ad hoc unregistered terms beyond full-surface reads (SPEC-4 §8).
