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
4. **The boundary is batch-shaped and asynchronous; evaluation stays synchronous.** Handles
   (a peer's store, a snapshot) are owned values: they stay usable after later writes and after
   the peer is opened again, so `snapshot-moved` and `snapshot-released` are run-time refusals in
   every witness. A read
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
- **A store owns what it holds; no caller holds a reference into it.** It keeps its own copy of
  every delta, signature and arrival record, holding only the canonical fields of the claims. A
  caller that changes a value after appending it, or a value a read returned, changes nothing in
  the store, for any peer.
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

The lemma needs the deltas the host "already holds" to come from the **same snapshot** as R:
earlier rounds of the same read. Deltas kept from another snapshot can name negations that are no
longer held, or miss ones that arrived since.

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
  claim: "proven" | "unproven" | "nothing-removed";
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
- **What a purge reveals, by design.** `held-by-other-peer` tells a peer that some other peer
  holds an id this peer itself admitted, and, by asking again, when that holder lets go. It never
  tells who. A report may not say bytes are gone while they remain, so the peer must learn that
  they remain. This is the price of an honest report.
- **The claim covers only the targets a report marks `removed`.** With no such target the claim
  is `nothing-removed` and asserts nothing about bytes. `proven` needs the store's class to be
  `proven`, at least one declared surface, and every surface `absent`. A store may always claim
  less (`unproven` for `proven`), never more. Surface states speak for the removed targets; a
  target another peer holds is told by its outcome.
- A store whose erasure class is `none` refuses `purge` with `capability-absent`.
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
- A connection string can carry credentials. The opener never logs or echoes it. A scheme is
  `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` before the first colon (RFC 3986 §3.1), compared
  without regard to case. An error names a scheme only when that scheme is registered. For
  anything else, a missing scheme or an unregistered one, the error is one fixed message that
  echoes nothing: the text before the first colon of a malformed connection string can be a
  credential.
- A factory's own `StoreError` passes through unchanged; the factory owns its messages. Any other
  error from a factory, and any error from `close` on the missing-capability path, is replaced.

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
   `index-entries` (targets, negators and arrival rows) and `process-memory`. `process-memory` is
   always `unprovable`, so the memory store never claims `proven` (see reading 24).
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
    URL. A URL with no scheme or an unregistered one is refused `unknown-scheme` with one fixed
    message (§4.10).
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
18. **Ownership** (§4.1). The memory store copies claims, signature and arrival at append and
    again on every read, because a bytes payload cannot be frozen. Fields outside the canonical
    claims are dropped at append.
19. **Order of checks in `append`.** Two orders are pinned: the head compare-and-set comes before
    the batch is looked at, and every entry is checked (id, signature form, arrival record) even
    when its id is already held. Nothing else is ordered: an empty next head or an unstorable
    frame against a stale head may answer either way. Refusals on a snapshot that is released,
    moved and on a closed store are not ordered either. Where two causes coincide in a vector,
    the vector lists every code that conforms.
20. **Numbers.** `sequence` and `transfer` are integers from 1 to 2^53 − 1 in every witness. `at`
    is a finite number of milliseconds and may be fractional (SPEC-6 vNext §3 does not restrict
    it). A signature, when present, is 128 lowercase hex characters; the store checks the form
    only. A violation is `invalid-admission`.
21. **`invalid-request`, the closed list:** `createPeer` with an empty peer id or without a
    posture; `scope` with a non-finite `timestampAtMost`; `scope` with an `arrivalAtMost` that is
    not an integer from 0 to 2^53 − 1; an unknown requirement name at open; `scopeSource` given a
    member whose id does not recompute, or a malformed member; and, in a dynamically typed
    witness, a request with a value that is not of its type (reading 34).
22. **Requirements are an allow-list.** A name outside it is refused and named, never looked up
    on the profile. A capability counts only when it is exactly true.
23. **Handles.** An older `PeerStore` stays valid when the peer is opened again; both are views
    of one peer.
24. **The purge claim** (§4.7.2). The memory store says `unproven` when it removed a target and
    `nothing-removed` otherwise; it never says `proven` (reading 9). Its `rows` surface does not
    say `owed` for a target another peer holds; the outcome says that.
25. **Conformance covers both documents.** `runStoreConformance` runs the scripts and the scope
    cases by default. The scripts alone do not hold a store to the exact upper bound. Each
    witness also runs both against the reference store with every subset of pushdown fields
    switched off (8 runs).
26. **Scheme case** (§4.10). `MEMORY:` opens the memory store. `registerStoreScheme` stores the
    lowercase form.
27. **Shape before state on a snapshot.** A `scope` whose bound is outside its legal values is
    refused `invalid-request` before the snapshot's state is consulted, also on a moved or a
    released snapshot. This matches `append`, where the shape of the call comes first. Reading 37
    names the bound that pins this for a typed store.
28. **A typed witness and a stale head.** Where a witness's types cannot hold a vector's value,
    its runner answers for the store at the boundary, head first: a mismatch of `expectedHead`
    is `conflict`; only otherwise is the answer `invalid-admission`. The head wins in every
    witness.
29. **`invalid-url` has two causes:** `memory:` with an address, and a malformed scheme name at
    registration. A malformed or schemeless URL at open is `unknown-scheme`.
30. **`scopeSource` and a repeated id.** The first appearance is kept and checked; a repeated id
    is not examined. A refused call builds nothing. The source owns its members: it copies them
    in, copies out what `get` and `arrival` return, and its id lists are frozen.
31. **Ownership reaches the profile and the payload.** The public `profile` is a deep-frozen
    copy; the store decides by a private one. A bytes payload is copied with the `Uint8Array`
    constructor, because `slice` on a Node `Buffer` returns a view. Reading 33 says when that
    constructor copies, and reading 35 what "private" means.
32. **Sequences.** A skipped entry (held, or repeated in the batch) spends no sequence and does
    not raise the peer's largest committed sequence. That largest sequence survives a purge that
    empties the peer. Heads compare byte for byte, and null is not the empty string. A forged
    entry is refused also when its arrival record names the claims' real id. A vector pins each
    kind of skipped entry apart: after a batch `[x at 11, x at 60]`, an append at 12 commits.
33. **A store never converts** (§4.1, §4.5 "never repairs"). A store takes a value only when it
    has the type its position requires, and refuses every other value: `invalid-admission` in
    `append`, `invalid-request` elsewhere. The TypeScript witness reads each field of an entry
    once, checks its type, and only then takes it; it computes the id over its own copy, so the
    claims it hashes are the claims it keeps. A bytes payload must be a `Uint8Array` of this
    realm (a `Buffer` and a subclass are). An `ArrayBuffer`, a `SharedArrayBuffer`, an array of
    another element size, a number and a list are refused: the `Uint8Array` constructor would
    view the first two and convert the others. Round 3 asked for "validate, then copy"; the
    witness copies without converting and validates the copy, because an object can answer
    differently between a check and a later copy.
34. **Requests are owned too.** A store reads each field of a request once. A list of ids or
    entities that is not a list of strings, an anchor without a kind, and a batch that is not of
    its shape are refused (the closed list, reading 21, gains this for dynamically typed
    witnesses). An `expectedHead` of any other type is a `conflict`: it is not the peer's head.
35. **Private means unreachable.** What the memory store decides by (its own profile, the stored
    claims, the peers, the closed flag) is not a property of the store object. A cast, or a
    property planted under the old name, reaches nothing.
36. **`scopeSource` builds in the size of its members.** N members at one entity, or N negations
    of one delta, cost N steps. A rail in each witness counts the work; it does not time it.
37. **A bound that reaches every store.** The vectors refuse `arrivalAtMost: 2^53` on a moved and
    on a released snapshot (reading 27). A typed runner answers `1.5` and `-1` at its own
    boundary; an unsigned 64-bit field holds 2^53, so that bound pins the store.
38. **Ownership is not a vector.** A conformance run never changes a value after it hands it
    over, so a store that aliases passes. `vectors/store/README.md` §7 lists what each store
    tests for itself.
39. **The runner has rules, and a table holds it to them.** Each witness keeps one wrong store
    per runner rule and asserts that the run fails with that rule's message
    (`vectors/store/README.md` §8). A runner asks the store first and judges the answer
    afterwards. A purge that refuses fails its step.

### 4.12 Slice 2 readings

Slice 2 builds the read of §4.4 and §6.2 beside the memory reactor
(`18-store.SLICE-2.PLAN.md`). Where §4.3, §4.4 and the plan were silent, the store-backed read
decided as follows. `vectors/store/rounds.json` and `vectors/store/README.md` §5 pin each point
that a vector can pin.

1. **The selection of a read** has two parts: a `pushdown` (§4.3), which the store may apply, and
   a host predicate `admits(delta, arrival)`, which it never sees. The predicate receives the
   delta's arrival record at this peer, so a host can select on arrival without a pushdown. Both
   are pointwise (SPEC-17 §3).
2. **The residual selection** is `admits` plus every pushdown field that the answer of **some**
   round of this read did not report applied. A field stays residual for the rest of the read.
   The host applies the residual to everything it holds. A member the store did trim passes the
   field anyway, so applying it again changes nothing.
3. **A round evaluates over the exact members**, `S(anchors so far over cache ∩ residual)`, and
   never over the whole fetch cache. The cache also holds members that fail the residual and
   members a store returned beyond the scope; they must not reach the evaluator.
4. **Why a round asks only for its new anchors.** Let A be the anchors of earlier rounds, B the
   new ones, p the selection and C the cache. Each earlier answer contains
   `S(A_k over H_p) \ C_k`, so `C ⊇ S(A over H_p)`. The new answer contains
   `S(B over H_p) \ C`. So the cache afterwards contains `S(A over H_p) ∪ S(B over H_p)`, which is
   `S(A ∪ B over H_p)` because S is a union over anchors of closures. Every member of the cache
   that passes the residual is in `H_p`, so by monotonicity `S(A ∪ B over cache ∩ residual)` is
   inside `S(A ∪ B over H_p)`; and it contains it, because all of `S(A ∪ B over H_p)` is in the
   cache and passes the residual. The two are equal. All of it needs one snapshot (§4.3).
5. **Where `exclude` must not cut a chain.** A store that returns exactly closed scopes never
   shows the difference between `exclude` and `excludeIds` to a read in rounds: what the read
   holds is then closed under the negations its selection admits. The difference shows when a
   store returns a member beyond the scope without that member's negators, which §4.3 allows.
   Example: x fails the selection, d negates x and passes, n negates d, and d also points at an
   anchor of a later round. A store that leaves the field to the host may return d early. The
   later round owes n, and the read already holds d. The round vectors hold this shape
   (`b1-late-note-neg-at-c2`), and each witness tests it with a store that returns d alone.
6. **The rounds are normative** (plan O3). The first round asks for the request root and the
   term's static anchors. Each later round asks for the anchors the last evaluation shows that
   no round has asked for. SPEC-17 §6 allows lazy growth inside one evaluation; a store-backed
   read does not use it, so two witnesses make the same store calls.
7. **A read makes no store call but `scope`,** one per round. `exclude` names every id held,
   also the ones that fail the residual. Its order is free.
8. **An unanchored term** is refused before any store call, with the SPEC-17 §5 reason
   (TypeScript: `UnanchoredTermError`, with `reason`, and the message
   `term is not anchored: <reason>`). Taking a snapshot is a store call, so `StoreReactor`
   refuses before it opens one. A gather that does not evaluate to an HView is refused
   `result-sort`.
9. **The answer** carries the result, the scope (every anchor asked for), the exact members of
   the last round, the snapshot's revision, and one report per round: its number (from 1 on
   each snapshot), the attempt (1 for the first snapshot; `StoreReactor` counts up when it
   starts again), the revision of the snapshot it ran on, its anchors, how many deltas came
   back, how many the read holds, how many are members, and what the store reported applied.
10. **The round hook** runs after each round's evaluation and before the next `scope` call,
    also after the last round. The read waits for it. The interleaved vectors need it. No vector
    can see a hook that skips the last round, so each witness asserts, for every case, that the
    hook's reports equal the read's own round reports.
11. **A moved snapshot.** `readAnchored` passes `snapshot-moved` up and keeps nothing.
    `StoreReactor.read` and `StoreReactor.fetch` then start again on a new snapshot, with a new
    cache: at most three more times, so at most four snapshots. Any other refusal passes up at
    once, after one attempt. Every snapshot is released, also on a refusal. The answer says how
    many snapshots it took. A cache never outlives its snapshot. A wrapper that starts again but
    keeps its old cache still answers `after` under appends alone, because what it kept is
    still held; after a purge it shows a delta the peer no longer holds. The interleaved purge
    vector catches it.
12. **`fetchScope`** makes one `scope` call and returns a source that knows **exactly**
    `S(entities)` under the selection. A delta the store returned beyond that is not in the
    source. Entities are asked once each, ascending.
13. **The fetch cache owns what it holds** (§4.1, §4.11 readings 33–34). It checks and copies
    each member with the same rule as `scopeSource` (each field read once and type-checked, bytes
    only as the byte array type and never converted) and computes the id over its own copy,
    once. It refuses `invalid-request` for a member that is malformed, whose id does not
    recompute, or whose arrival record is missing or names another id; a refused call adds
    nothing. Everything it hands out is a copy or cannot be changed. A delta with two pointers
    at one entity is listed there once; a pointer at a delta is a negation only with the role
    `negates`. This joins the closed list of §4.11 reading 21.
14. **The read with no fetch cache** (mode 2 of the round vectors) asks for every anchor so far
    in every round and sends no `exclude`, so each answer alone carries the whole scope so far.
    It exists so the vectors can show that the cache changes no answer. Whether such a reader
    also drops what earlier rounds returned cannot be observed and is free.
15. **`StoreReactor`** holds a peer handle and nothing else. `open` makes no store call. It has
    `read` and `fetch`, and no `snapshot`, `arrivalLog`, `digest` or `eval`.
16. **Package edge.** The TypeScript `reactor` boundary may import `storage`. The round-vector
    model needs the evaluator, so it lives with the generator and not in `storage`.
17. **Not built yet in slice 2:** `readFullSurface`, and the second run of the existing read
    families. The evaluation memo is readings 21 to 26.
18. **The read trusts `applied`.** It does not check again a field that the store reported
    applied. A check costs work on every honest read, and §4.3 makes a false `applied` a store
    defect that the store vectors catch. Over a store that reports a field applied and does not
    apply it, the read is wrong; each witness has a rail that shows this, so the trust is a
    stated assumption.
19. **The whole-surface mode of the round vectors** (mode 1) derives its scope from the request
    root, the term's static anchors and the anchors that the gather's HView shows. For a
    `resolve` term the gather is the operand: the View shows no anchors. This scope equals the
    scope of the rounds, because SPEC-17 discovery finds only true anchors.
20. **A sticky residual has no vector.** A memory profile is the same in every round, so each
    witness tests reading 2 with a store double that leaves a field to the host in alternate
    rounds, in both parities.
21. **The evaluation memo** (§4.4, plan §3). A **child evaluation** is one schema body evaluated
    at one root: each child of an `expand`, and the body of a `fix`. The memo maps a key to the
    HView of a child evaluation. The key is (schema reference, bindings, root):
    - the schema reference as the term writes it: the name, or the pinned hash;
    - the bindings in effect, compared by **identity** within the read. They are the request's
      bindings, or the `bindings` of the nearest enclosing `fix` that has them. Each is one object
      for the whole read, because the term and the registry do not change during it. Two binding
      objects with the same entries get two keys; the memo then shares less, and no answer
      changes. Identity is enough only because a bindings object does not change during a read.
      A caller must not change a bindings object while a read uses it; the type is read-only.
      Such a change breaks the read with or without the memo: the anchor analysis runs once, at
      the start of the read, over the bindings as they were then;
    - the root entity.

    The term, the registry, `now` and the selection are the same in every round of one read, so
    they are not in the key. A lookup that finds the key returns the stored HView and evaluates
    nothing under it. A child is **final** when every anchor its HView shows has been fetched:
    the id of the HView, and the id of every child expanded inside it, at any depth. The memo
    stores a child evaluation only when it is final. A child that is not final is evaluated again
    in the next round that reaches it. The static anchors need no check: round 1 fetches all of
    them (reading 6).

    One memo serves **one attempt of one read**: one snapshot, one selection, one request. A new
    snapshot starts a new memo, and so does a new read. The memo is **off** when an evaluation
    budget is present: a hit returns a child without the work the budget counts. The final
    `resolve` evaluation (reading 9) uses the memo of the read.
22. **Why a final child is right.** Let D be what the peer holds at the snapshot that the selection
    admits. By reading 4, the members of round k are exactly `M_k = S(E_k over D)`, where E_k is
    every anchor asked for in rounds 1 to k. This holds whichever fields were residual in which
    round. Take a child evaluation (schema R, bindings B, root c) in round k, with HView V, and let
    `A(V)` be the anchors V shows.

    *Where a schema body reads.* An anchored body (SPEC-17 §5) reads deltas only in these places:
    a `group` at the evaluation root; an `inView` or a `group const` pinned at the root, at a
    constant or at a bound hole; a `select`, which decides each delta by its predicate; a `mask`,
    which decides a delta by its negation chains; a set operator (`union`, `intersect`,
    `difference`), which decides a delta by its membership in both operands; an `expand`, which
    evaluates children; and a `fix`, whose body runs at its own entity. Constants and bound holes are static anchors. The HView-sort spine of
    a body (`prune` and `expand` over their operand) ends in a `group` or a `fix`. When it ends in
    a `group`, the HView id is the root. When it ends in a `fix`, the body reads nothing at its
    own root, and the HView id is the `fix` entity, a static anchor. So every root at which V's
    evaluation reads is a static anchor or is in `A(V)`, apart from children that a `prune`
    drops: those are evaluated and not shown, and nothing they return reaches V.

    *The operands.* Take a level whose root a is in E_k. Write `X(M)` for a DSet-sorted subterm X
    of that level evaluated over the deltas M. Then **`X(M_k) = X(D) ∩ M_k`** for every such X, by
    structural induction on X:
    - `input`: `M_k = D ∩ M_k`, because `M_k ⊆ D`.
    - `select`: its predicate reads the delta itself, and a pinned `inView` at a static anchor
      or at a. Every delta of D that points at such an anchor is in `M_k`, and the inView's own
      term obeys this rule, so the inView selects the same deltas over `M_k` as over D. So the
      predicate decides each delta the same way, and the hypothesis on the operand gives the rule.
    - `mask`: by the SPEC-17 closure lemma, a member of `M_k` has the same negation status in the
      operand over `M_k` as over D. So the mask decides each delta of `X(D) ∩ M_k` the same way,
      and the hypothesis on the operand gives the rule.
    - `union`, `intersect`, `difference`: these are not pointwise, because whether a delta stays
      depends on its membership in the other operand. The rule holds by the hypothesis on both
      operands: intersection with the one set `M_k` distributes over union, intersection and
      difference, so `(X(D) ∩ M_k) op (Y(D) ∩ M_k) = (X(D) op Y(D)) ∩ M_k`.

    *The induction.* Go down V from the top. Take a level whose root a is in E_k. Every delta of D
    that points at a is in `S0(a)`, so it is in `M_k`. A `group` at a files only deltas that point
    at a, and its operand over `M_k` is its operand over D intersected with `M_k` (*The
    operands*). So each `group` at a files the same deltas over `M_k` as over D, and each pinned
    `inView` selects the same deltas. The level has the same entries over `M_k` as over D. So it
    expands the same children, under the same schema and bindings. Finality puts each of those children in E_k, so the argument goes
    down one level. The schema DAG is finite (SPEC-3 §3), so the induction ends. Therefore **V
    equals the same child evaluated over D**. This is the SPEC-17 §6 theorem for the term
    `fix(R, c, B)`: its scope is `E* = static ∪ A(V)`, and `M_k` contains `S(E*)` and is closed
    under negation.

    *Later rounds.* In a round j > k, `M_j = S(E_j over D)` with `E_j ⊇ E_k ⊇ A(V)`. The same
    induction runs over `M_j`, so the child over `M_j` equals the child over D, which is V. **No
    later round can change a final child.** A delta that a later round adds is in `S(E_j)` and not
    in `S(E_k)`. It does not point at any anchor in `A(V)`, because `S0(a) ⊆ M_k` for each of them,
    so no `group` of V files it and no pinned `inView` selects it. It negates no member of V's
    levels either: a negator of such a member x is in `N*(x)`, and `N*(x)` is in the scope of x's
    anchor, which `M_k` holds. A store that returns deltas beyond the scope changes nothing: the
    read evaluates only over the exact members (reading 3).
23. **A child does not depend on members under other anchors.** The members of a round come from
    every anchor fetched so far, and a child's operands see all of them. They do not change its
    answer. A `group` files only deltas that point at its own root. A pinned `inView` selects only
    deltas at its own anchor. A `select` decides each delta alone, and a set operator decides it
    by its membership in operands that obey the same rule (reading 22, *The operands*). A
    negation that decides one of the child's members is in that member's scope, whatever entity
    the negation points at. So a final child depends only on `S(static ∪ A(V))` over D, which no later round
    changes. A delta that points at the child's root and also at an anchor of a later round is in
    `S0` of the child's root, so it arrives with that root (in the round vectors,
    `g-features-c1` at `garden:1` and `cutting:1`). The residual selection does not change this:
    reading 4 makes the members of every round exact over the same D.
24. **Shapes the key keeps apart.** One entity reached under two schemas, or under two bindings, has
    two keys and two evaluations. The bindings can change what a `mask trust` or a `select`
    decides, so one HView cannot serve both. The case `one-child-under-two-bindings` reaches
    `cutting:1` under one schema with two bindings in one round, and the two HViews differ; a key
    without the bindings fails it. Two pinned references are two schemas too: the case
    `one-child-under-two-pinned-schemas` reaches `cutting:1` and `cutting:2` under two pinned
    hashes in one round, and a key that does not tell the hashes apart fails it. A diamond under
    one schema and one bindings object has one key (`plant:s` under `Tree1`, from both beds).
    Within one round, every evaluation of that key sees the same members and gives the same
    HView; once it is final, every later round gives that HView too (reading 22).
25. **The memo never outlives its attempt.** A child stored on one snapshot can be wrong on
    another, because an append or a purge can change what it reads. The interleaved case
    `an-append-after-the-third-round` strikes `c1-height` at `cutting:1` after the round that
    stores `Leaf` at `cutting:1`. A wrapper that starts again but
    keeps its memo shows the old `cutting:1` beside the new members: neither answer. A change after
    round 1 cannot show it, because round 1 finishes no child. A memo kept across two reads fails a case for the same
    reason: the selection, the bindings or the snapshot change the members, and a stored child
    does not follow.
26. **What the memo saves.** A key is stored at most once and is not evaluated again after that.
    So a read with the memo evaluates each key once as final, plus once for each time a round
    reaches it while it is not final. A read without the memo evaluates every child it reaches in
    every round. A witness counts both through its memo hook, not by timing.


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
  retire derived indexes, purge, then query. Each step names its expected ids or report. An
  independent model that scans plain lists generates them, and the memory reference store must
  pass them before the generator writes. `runStoreConformance` runs them against any
  implementation.
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
