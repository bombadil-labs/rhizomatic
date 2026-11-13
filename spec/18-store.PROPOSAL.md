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
  readonly history: History;               // the identity of this peer's revision history (§4.6)
  read(): Promise<Snapshot>;               // a consistent, repeatable view at one revision
  append(batch: Admission): Promise<AppendResult>;               // §4.5
  purge(ids: readonly Id[]): Promise<PurgeReport>;               // §4.7.2
  changes(from: Revision, to?: Revision): Promise<ChangePage>;   // §4.6: records in (from, to]
}
interface Snapshot {
  readonly revision: Revision;
  readonly history: History;               // the history `revision` belongs to, read with it
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

```ts
type ChangeRecord = {
  revision: Revision;      // the peer's revision after this commit
  head: Head | null;       // the journal head after this commit
  added: readonly Id[];    // ids this peer newly holds at this commit; ascending, unique
  removed: readonly Id[];  // ids this peer stopped holding at this commit; ascending, unique
};
type ChangePage =
  | { status: "ok"; records: readonly ChangeRecord[]; through: Revision }
  | { status: "resync-required"; current: Revision };
```

**Records.**

- Each revision advance of a peer writes exactly one record, and nothing else writes one. A
  head-only append (no new id, the head moves) writes a record with empty `added` and `removed`.
  An append that adds no id and keeps the head, and a purge that releases no held id, write no
  record and advance no revision.
- `removed` lists only the ids that leave this peer's holdings at that commit. A debt that settles
  later (the bytes go after the peer already stopped holding the id) is not a change to this peer
  and is in no record.
- A record carries ids only, never bytes or claims. So a record may name an id the peer has since
  purged (§4.7.2).
- A record never changes once written. One id can be in `removed` of one record and in `added` of
  a later one.
- The record is part of the atomic commit (§4.5): it becomes visible together with the holdings
  and the head. A refused append and a `conflict` write no record.
- Each peer has its own feed. A peer's feed never names an id that peer did not hold. A new peer
  starts with an empty feed whose floor is its first revision.
- **Shape.** A record has exactly the keys `revision`, `head`, `added` and `removed`. An `ok` page
  has exactly `status`, `records` and `through`. A `resync-required` answer has exactly `status`
  and `current`. A store adds no other key: a record never carries bytes.
- **Ownership.** What `changes` returns belongs to the caller. A caller may change the page, its
  list of records, a record, or a record's `added` or `removed` list. No such change alters any
  later answer of the store. This binds every store (§4.1).

**`changes(from, to?)`** answers the records with `from < revision ≤ to`, ascending by revision.

- **The order of the answers.** In this order:
  1. A closed store refuses `store-closed`.
  2. A store whose `changeRetention` is `none` refuses `capability-absent`.
  3. A `from` or `to` that is not an integer from 0 to 2^53 − 1 is refused `invalid-request`.
  4. An explicit `to` below `from` is refused `invalid-request`.
  5. The answer is `resync-required` exactly when `from` is below the floor or above the current
     revision.
  6. Otherwise the answer is `ok`.

  `peer-absent` cannot occur: `changes` is called on a peer handle, and a handle stays valid
  while the store is open (§4.11 reading 23).
- `to` defaults to the current revision. A `to` beyond the current revision is clamped to it. A
  defaulted `to` is never compared with `from`.
- `from` equal to the current revision answers `ok` with no records and `through = from`.
- **Pages.** The store may return a prefix of the range. `through` is the revision the page is
  complete up to: every record in `(from, through]` is in `records`, and `through ≤ to` (clamped).
  When the page holds the whole range, `through` is the clamped `to`. Otherwise `through` is the
  revision of the last record returned, and that is greater than `from`: a page with a record
  pending makes progress. A caller with `through` below the clamped `to` calls again from
  `through`.
- **One answer, one revision.** The clamp of `to` and the records of one answer are read at one
  revision of the peer. A commit between them does not show in that answer.
- **Records appear in revision order.** A record at revision r is visible only when every record
  at or below r is visible. A store open to several writing processes enforces this at commit.
  A sequential runner cannot test it; slice 4 owns its rail.
- **`resync-required`** is a result, not a thrown error, like `conflict`. It carries the current
  revision. A store answers it exactly when `from` is below the floor or above the current
  revision (a cursor from the future), after the checks of the bounds.
- **Retention.** A store MAY drop the oldest records. Its **floor** is the revision of the newest
  record it dropped, or the peer's first revision when it dropped none. A store keeps this one
  number. A `from` below the floor answers `resync-required`. A `from` at or above the floor
  never does, unless it is above the current revision. Where revisions advance by one, the floor
  is also the revision just before the oldest kept record. Where they skip values, a `from`
  between the newest dropped revision and the oldest kept one is above the floor and answers
  `ok`. The caller of a `resync-required` rebuilds only what it derived (views, derived indexes,
  caches), not the store. The profile declares the retention (§4.8).
- **Cost.** `changes` costs O(records returned + ids returned). It never costs O(holdings) or
  O(earlier records): finding `from` must not walk the feed from its start. Dropping a record
  costs O(1) amortized per append: an append costs the same with 0 or N kept records.
- The feed replaces the reactor's in-memory dispatch log, `deltasSince(knownIds)` catch-up and
  Loam's `data_version` detection of other writers. A reader in another process follows the feed.

**Freshness check.** A **capture** records what one anchored read depended on in the store. It
holds ids, never bytes:

```ts
type Capture = {
  history: History;              // the peer's history at the snapshot the read ran on
  revision: Revision;            // the revision of that snapshot
  anchors: readonly Anchor[];    // the read's whole scope E*: static and dynamic anchors; ascending, unique
  members: readonly Id[];        // the raw scope S(anchors over H) at that revision; ascending, unique
  since: number | null;          // the window of the read's operand at its `now`
  expiresAt: number | null;
};
```

- Both lists are strictly ascending by the UTF-8 bytes of the entity or the id. A capture is
  built only by the store side (`makeCapture`) or by a checking constructor (`parseCapture`)
  for one that was stored and read back. The checking constructor refuses `invalid-request`
  for a list out of order or with a repeat, for another shape, an empty history, a revision that
  is not an integer from 0 to 2^53 − 1, or a window with `since ≥ expiresAt`. It never sorts.
  `touching` searches the lists by binary search and trusts their order.
- `history` and `revision` come from one snapshot (`Snapshot.history`, `Snapshot.revision`).
- `members` is the **raw** scope: every held delta an anchor yields, closed under held negators,
  with no selection and no pushdown. It is computed from ids alone, with `targets` and `negators`
  on the read's own snapshot, in O(|members| × log N). A read that pushed no selection down
  already holds it: each answer lies inside S(its anchors over H), and the rounds together hold
  all of S(E* over H). A read that pushed a selection down makes its own id-only calls. A capture
  never takes its members from a pushed-down fetch.
- Anchors are entity anchors. Slices 1 and 2 built no other kind; value and derived-index anchors
  join a capture when their indexes exist.

**The window.** Take the read's operand: the deltas of its exact trimmed scope, what remains
after the read's whole selection (the trim lemma, §4.3). Its validity boundaries are the
`validFrom` and `validUntil` of those deltas, negators included. `since` is the greatest boundary
at or before the read's `now`; `expiresAt` is the least boundary strictly after it. Each is null
when there is none, and a null bound is open. Evaluation keeps exactly the deltas valid at its
time (`validFrom ≤ t < validUntil`, SPEC-2, `evalTerm`), so no delta of the operand changes
validity at any t with `since ≤ t < expiresAt`. **The claim:** with no touch, the read answers the
same at every such t. At `since` itself a delta has already started or stopped, so `since` is
inside the window; just below it, and at `expiresAt`, some delta of the operand has another
validity. The window is per read, never per peer, and it is never taken over what a store
returned: a store may return more than the scope, and two stores must agree.

`touching(capture, records, added)` is pure. `records` are the change records with
`capture.revision < revision ≤ r′`, ascending. `added` holds, by id, the delta of every id in some
record's `added` that the peer still holds at r′. It answers the first touch
`{revision, id, reason}`, or null. The rule is defined by the state at r′. The capture is
touched when:

1. some record's `removed` names a member (`removed-member`), also when the id is added again
   later: its arrival record changed; or
2. an added id that the peer still holds at r′ has a pointer whose target is an anchor entity
   (`targets-anchor`), or a `negates` pointer at a member (`negates-member`).

An added id that the peer no longer holds at r′ is ignored, unless rule 1 applies to it. No
closure over added negators is needed: an added delta that negates a delta which is neither a
member nor a toucher cannot enter the scope. The first touch is in record order. Within one
record, `removed` comes before `added`, and each list is read in its own ascending order. A delta
that both points at an anchor and negates a member reports `targets-anchor`.

**The claim of the feed.** With no touch, `S(anchors over H at r′)` equals `members`, id for id,
with the same arrival records. With a touch, the id set or an arrival record differs at r′, or a
member left and came back. So without a selection the check is **exact**. With a selection it is
**sound**: a touch by a delta the selection rejects gives a false "stale", never a false
"current". With no touch the raw scope is unchanged, so its trim under an unchanged selection is
unchanged too, and so is the window.

**History.** A revision means something only within one history of one peer. `PeerStore.history`
and `Snapshot.history` are an opaque identity of that history, compared for equality only. It
stays the same while the peer's revisions only advance from that history. A peer created anew,
also under a name that existed before, and a store restored to an earlier state, MUST carry
another value. The memory store mints a new value for each peer it creates, unique within the
process; a host that keeps captures across processes passes a mint unique across them
(`mintHistory`). A caller that keeps a revision across calls (a capture, a feed cursor) keeps the
history with it and compares it. `changes` takes no history. This history is the "history epoch"
of plan decision O3.

`checkFresh(peer, capture, now)` answers `current`, `stale` with the touch, `not-yet` with
`since`, `expired` with `expiresAt`, or `resync-required` with the current revision. `now` is
required: a result is current only relative to a time. It makes one `read()`. When the snapshot's
history is not the capture's, it answers `resync-required` at once, with no feed call. When the
snapshot's revision r′ equals the capture's, it reads no feed. When r′ is below it, it answers
`resync-required`. Otherwise it reads `changes(capture.revision, r′)` page by page, with that
explicit `to`. For each page that names an added id, it makes one `get` of those ids on the
snapshot, and then judges the page. It stops at the first touch. **The order of the answers:**
`resync-required`, then `stale`, then the window (`not-yet` when `now < since`, `expired` when
`now ≥ expiresAt`), else `current`. Its calls and cost depend on the records and ids since the
capture, never on what the peer holds and never on records before the capture. It replaces
SPEC-16's recomputation of the whole scope (SPEC-16 MR-10b).

**What the check does not cover.** The feed check sees the store only. A host whose selection or
authority reads state outside the capture's scope (trust, grants, a clock other than the window)
keeps its own epoch for that state and compares it itself. A selection that depends on time is
such state.

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

**Ids in the change feed lie outside "absent"** (decision O4, 2026-11-12). The change feed (§4.6)
is a store-controlled surface. It keeps the id of a purged delta. It never keeps the bytes or
the claims of that delta. A record never changes once written, so a purge does not rewrite it.

- An id is a hash of the claims. A reader who holds a kept id can confirm a guess of the delta:
  it hashes the guessed claims and compares.
- Under `unbounded` retention, the id stays in the feed for as long as the store lives.
- A host that needs ids to leave uses a bounded retention, `{revisions: n}`. The id then leaves
  when the store drops the record that names it.
- Slice 4 adds the feed to the purge report as a surface that still holds the id.

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
  changeRetention: "none" | "unbounded" | { revisions: number };   // §4.6; none: no change feed
  formatVersion: string;                       // §4.7.3
};
```

A host names the capabilities it requires. Open fails with a message that names each missing one.
A store never claims a capability it implements by scanning.

`changeRetention` is `none` (no feed; `changes` refuses `capability-absent`), `unbounded` (every
record is kept), or `{revisions: n}` with n an integer from 1 to 2^53 − 1, in every witness: each
peer keeps exactly the records of its latest n revision advances, and drops the oldest when it
writes the record after the nth.

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
    witness, a request with a value that is not of its type (reading 34), an optional object
    field that is not a plain object (reading 40), and `openStore` options that are not of
    their type (reading 41).
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
36. **`scopeSource` builds in the size of its members.** N members at one entity, N negations
    of one delta, one member with N entity pointers, and N appearances of a few ids each cost N
    steps. A rail in each witness times the build of each of these four shapes from outside with
    a monotonic clock, at N and at 8N, and holds the ratio below 24 (linear is about 8,
    quadratic about 64). N is the smallest power of two whose build takes 50 ms or more; the
    build at N is the fastest of five, the build at 8N the fastest of three
    (`vectors/store/README.md` §6). It is a coarse scaling check, not a count, and a stall during
    the builds at N can let a quadratic build pass. Round 3 had each witness count the work
    with a meter the code under test incremented; a build that copied its bucket on every
    insert was quadratic and passed, because the meter counted calls, not work.
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
40. **An optional object field is a plain object or absent.** Absent (in TypeScript,
    `undefined`) means none. Anything else that is not a plain object (`null`, a list, a number,
    a string, a boolean, a function, a class instance) is refused `invalid-request`; a store
    never reads it as an empty object, because that answers as if nothing had been asked. In
    slice 1 this is `scope`'s `pushdown` and the options of `openStore`. The options of
    `createPeer` are required and follow the same rule: options that are not a plain object, or
    whose `erasure` cannot be read, declare no posture and are refused `invalid-request`.
    Plainness is the shape of the prototype chain, not the identity of one realm's
    `Object.prototype`: a plain object from another realm is plain, as a list from another
    realm is a list.
41. **`openStore` options.** Absent options mean none, and so does an absent `requires`.
    Otherwise the options are a plain object and `requires` is a list of strings; anything else
    is `invalid-request` with one fixed message. The options are read once, before the scheme,
    and the factory receives the opener's own copy. A name that is a string and not a
    requirement is still refused after the store opens, naming it (reading 22).
42. **A purge forgets the holding, whatever kept the bytes.** After `held-by-other-peer` the
    peer holds the id no longer, as after `removed`. An append of the id again holds it under
    the new appearance and arrival record. A vector reads the record back after exactly that
    sequence; until round 4 no vector did, and a store that served the first record again
    passed. The runner's bookkeeping forgets every target of a purge. A second vector appends
    the id again after the debt settles through a later purge (`removed` for an id the peer no
    longer held), and reads the new record back.
43. **Class `none` is not a runner rule.** A store of class `none` refuses every purge with
    `capability-absent`. The scripts that purge require `purge` and are skipped for it, so no
    shared step reaches the refusal: each witness that has such a store tests it
    (`vectors/store/README.md` §7, test 8). A purge `claim` in a document has exactly the keys
    `unprovable` and `proven`; any other shape is a defect of the document, and a store of
    class `none` that reaches a purge step fails it for want of an expectation.
44. **Script requirements are an allow-list too.** An absent `requires` means none. A name
    outside `purge` and `journal-absent` refuses the script as a defect of the document, in
    every runner; it is never read as some other requirement.
45. **One read per field reaches every field.** The rule of reading 33 covers the claims, the
    signature, the id, the five arrival fields and every field of a request, not the claims
    alone. `scopeSource` reads a member's delta and its id once each, and decides a repeat on
    that one read.

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
17. **What slice 2 builds.** The read in rounds (readings 1 to 20), the evaluation memo (readings
    21 to 27), the full-surface read (reading 28), and the second run of the existing read
    families (reading 29).
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
    - the bindings in effect: the request's bindings, or the `bindings` of the nearest enclosing
      `fix` that has them. Each is one object for the whole read, because the term and the
      registry do not change during it. A witness keys them by **identity** within the read
      (TypeScript) or by **content**, entry by entry (Rust; a number by its bits). Two binding
      objects with the same entries may share a key or not. Both are safe, because the evaluator
      reads bindings only as values: a hit on equal content returns what the same evaluation
      returns, and a miss only evaluates again. A key must **never** let two bindings that differ
      in any entry share an entry. Identity is enough only because a bindings object does not
      change during a read. A caller must not change a bindings object while a read uses it; the
      type is read-only. Such a change breaks the read with or without the memo: the anchor
      analysis runs once, at the start of the read, over the bindings as they were then;
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
27. **The answer reports what the memo stored.** The memo changes no answer, so no case can see a
    read that ignores the memo switch, or that uses a memo when the switch is off. The answer
    therefore carries the number of child evaluations its memo held when the read ended
    (TypeScript `StoreRead.memoStored`): 0 with the memo off, and the number of keys stored with
    it on. Over the round vectors, `the-whole-garden` stores 18 with the memo and 0 without. The
    count is of the last attempt; a read that starts again starts a new memo (reading 25).
28. **The full-surface read** (§6.6). `readFullSurface(peerExporter, request)` lists the peer
    through its `PeerExporter`, keeps the deltas the selection admits, and evaluates the term
    over them with the ordinary evaluator. It takes any term, anchored or not, and its route
    report says `optimized: false`, with how many deltas it listed and how many it admitted. It
    keeps nothing. Calling it is the explicit flag of §6.6: it needs an exporter, and a serving
    path that holds only a peer handle (`StoreReactor`, a snapshot) has none. A listing carries
    no arrival record (§4.7.6), so the read applies `timestampAtMost` and `excludeIds` itself and
    refuses `invalid-request`, before it lists anything, a selection with `arrivalAtMost` or a
    host predicate. A listing whose id does not recompute is refused, not repaired.
    `collectDeltaSet(peerExporter)` is the listing as a set. A store that keeps arrival records
    in its listing in a later slice can lift the refusal.
29. **The existing read families run a second time through a store** (plan §5, O2). Each witness
    loads each family's deltas into a memory store peer with its fixture loader and expects the
    family's own bytes: every evaluation case of `vectors/l1-eval` (an anchored term through
    `readAnchored`, from the case's root or else its first static anchor; an unanchored one
    through `readFullSurface`), the SPEC-17 read cases through `readAnchored` with their scope
    and members, its scope cases through `fetchScope` with the exclusions as a pushdown, the
    negation-witness cases of `vectors/l2-reactor/governed.json` over the scope of the entities
    the target points at, and the principal cases (slice 2 step 3). Of the 112 evaluation cases,
    56 are anchored and 56 are not. The rejects, the parse and strict-key files, the schema
    loads and the whole-set `governed` and `latestByKey` cases are not run again: a store adds
    nothing to a refusal, and a whole-set load is a full-surface read. Ingest, dispatch and the
    journal (transaction, atomic-transfer, materialization, command and peer families) move in
    slices 3 and 4.

### 4.13 Slice 3 readings

Slice 3 builds the change feed of §4.6 (`18-store.SLICE-3.PLAN.md`, steps 1 and 3) and freshness
(step 5, readings 24 to 41). Where §4.6 and the plan were silent, the feed decided as follows.
`vectors/store/scripts.json`, `vectors/store/freshness.json` and `vectors/store/README.md` §3.9
and §9 pin each point that a vector can pin.

1. **Revisions are integers.** A revision is an integer from 0 to 2^53 − 1 in every witness. The
   vectors need this to name a revision past the current one (`ahead`, README §3.9).
2. **Bad bounds.** A `from` or `to` that is not such an integer is refused `invalid-request`. It
   joins the closed list of §4.11 reading 21; a typed witness cannot receive one.
3. **The order of the answers** is stated once, in §4.6: `store-closed`, `capability-absent`,
   the shape of the bounds, an explicit `to` below `from`, then `resync-required` exactly when
   `from` is below the floor or above the current revision, then `ok`. The shape of a request
   comes before the feed's state, as in §4.11 reading 27. The TypeScript memory store follows
   this order; it never answers `capability-absent`, because it always serves a feed.
4. **A defaulted `to` is never compared.** A cursor from the future with no `to` answers
   `resync-required`, not `invalid-request`. Otherwise the default `to`, the current revision,
   would turn every cursor from the future into a refusal.
5. **A complete page ends at `to`.** When a page holds every record of the range, `through` is the
   clamped `to`, also when the last record is below it. A store whose revisions skip values would
   otherwise answer a range with no record by `through = from`, and its caller would never stop.
   For a store whose revisions advance by one, as the memory store's do, this is the last
   record's revision, or `from` when there is none. One answer reads the clamp of `to` and its
   records at one revision. Records become visible in revision order: a record at revision r is
   visible only when every record at or below r is. A sequential runner cannot test the second
   rule; a store open to several writing processes enforces it at commit, and slice 4 owns its
   rail.
6. **The floor is one number.** The floor is the revision of the newest dropped record, or the
   peer's first revision when nothing was dropped. `from` below the floor answers
   `resync-required`, also when the range holds no record (`from = to`). `from` at or above the
   floor never does, unless it is above the current revision. A store keeps this one number and
   needs no revision of anything else it dropped. Where revisions advance by one, the floor
   equals the revision just before the oldest kept record. Where they skip values, the two
   differ, and a `from` between them is above the floor; the runner probes this (README
   §3.9.4).
7. **A bounded retention is exact.** `{revisions: n}` keeps exactly the records of the latest n
   advances. The runner then predicts `resync-required` exactly. A store that drops later than
   it writes declares the n it is sure to keep, and fails the vectors if it keeps more.
8. **The name of the bound.** The profile keeps `{revisions: n}` and does not rename it to
   records. One record per advance makes the two counts equal, and the Rust profile already has
   `Revisions(n)`.
9. **No feed.** On a store whose `changeRetention` is `none`, `changes` refuses
   `capability-absent`. The requirement `changes` holds exactly when the retention is not `none`.
   This replaces §4.11 reading 10: the memory store now serves the feed, and its profile says
   `unbounded`.
10. **What `removed` lists.** It lists the targets that this peer held when the purge began, whatever
    their outcome. A target reported `removed` because its debt settled was not held, so it is not
    listed. The outcome alone cannot decide this.
11. **The head of a purge record** is the peer's head, which a purge does not move.
12. **`resync-required` carries `current`**, the peer's revision when it answered. A caller learns
    where to start reading again without a second call.
13. **`changes` belongs to the peer, not to a snapshot.** It reads the current feed. A follower needs
    the newest records, and a snapshot cannot see a later commit.
14. **Records are owned, in every store.** A caller may change anything `changes` returned: the
    page, its list of records, a record, a record's `added` or `removed` list. No later answer of
    the store changes. The runner tests this (README §3.9.5, check 14; §7, test 9). The
    TypeScript memory store meets it by handing out records it froze when it wrote them, in a
    new list per page.
15. **The memory store's options.** `changeRetention` is `unbounded` (the default) or
    `{revisions: n}` with n an integer from 1 to 2^53 − 1, in every witness. `changePageSize: n`
    bounds a page to n records, n an integer of 1 or more; it exists so tests exercise paging.
    Any other value is refused `invalid-request` when the store is made.
16. **The memory store finds `from` by arithmetic.** Its revisions advance by one and every advance
    writes one record, so the record after `from` sits at a fixed offset from the oldest kept
    record. A dropped record frees its slot, and the slots are compacted when half are free.
17. **The vectors check every step.** On a store that serves a feed, the conformance runner checks
    each peer's whole kept feed after every step of every script, the slice 1 scripts and the
    scope setup included. It also checks that each commit wrote exactly its own record, and that
    every other step wrote none. Each witness runs the scripts again on a reference store that
    keeps two records, and on one whose pages hold one record (README §3.9).
18. **A witness without the feed skips it.** The requirement `changes` skips the feed scripts on a
    store whose retention is `none`, as `purge` does (§4.11 reading 44). The Rust witness skips
    them until slice 3 step 2 builds its feed.
19. **Cost is timed.** The two cost promises of §4.6 have rails timed from outside, as §4.11
    reading 36 does: a window of fixed size read once after each of N records, and N appends that
    keep N / 4 records, each at N and 8N (README §3.9).
20. **Exact shape.** Each answer of `changes` has exactly its keys (§4.6, "Shape"). A key the
    contract does not name fails, so a store cannot carry bytes in a record unseen. A typed
    witness whose record and page types have exactly the contract's fields meets this rule by
    construction, and names the rule-table rows it cannot reach. An adapter that decodes a
    serialized answer MUST refuse a field it does not know.
21. **Revisions that skip values conform.** A store whose revisions are two or three apart, kept
    whole or bounded, with any page size, passes every vector. Each witness pins this with
    stores that scale the reference store's revisions (README §8).
22. **Below the floor, between revisions.** Where revisions skip values, every `from` between the
    revision before the newest dropped record and the floor is below the floor and answers
    `resync-required`. The runner asks at every such integer (README §3.9.4, item 2). A store that
    reads on from past the newest dropped record and answers `ok` there loses that record
    silently.
23. **Asking again may give another prefix.** The ownership check asks a range again after
    changing the first answer. The second answer may hold more or fewer records, because a
    store may return any prefix (§4.6). Only the records the two answers share by revision must
    be equal (README §3.9.5, check 14).
24. **Validity in a read.** Evaluation keeps exactly the deltas valid at the read's `now`
    (`validFrom ≤ now < validUntil`), once, at its boundary. So between two boundaries of the
    operand the read cannot change with time, and a boundary at `now` has already taken effect:
    `since` takes the greatest boundary at or before `now`, `expiresAt` the least after it.
25. **A window, not an expiry.** A capture is valid over `[since, expiresAt)`. With `expiresAt`
    alone, a capture of a read at 100 that holds one fact valid from 100 answered `current` at 99,
    where a read at 99 differs (`freshness.json`, `a-fact-that-starts-at-now`). `checkFresh`
    therefore needs `now`, and answers `not-yet` below `since`.
26. **The operand, not the answer of a store.** The window is taken over the read's exact members
    (§4.12 reading 3), negators included, never over what the store returned. A store may return
    more than the scope, and two stores must give one window. The vectors run once on a store
    that applies no pushdown field, so a window over what it returned fails.
27. **A fetched scope has no `now`.** A law reader asks a fetched scope questions at its own times.
    So a fetched scope answers `window(now)`, the window of its members at that `now`, instead
    of carrying one. TypeScript precomputes the sorted boundaries, so a call costs O(log members).
28. **A capture is asked for.** `readAnchored` and `StoreReactor.read` carry `since` and
    `expiresAt` always, and a capture only on request (`capture: true`). With nothing pushed
    down, the read's fetch cache is the raw scope (§4.6), and the capture costs no store call.
    With a pushdown, the read makes the id-only calls of the raw scope after its last round. This
    is the one exception to §4.12 reading 7, and only a read that asks for a capture makes it.
    `captureScope(snapshot, entities, now, selection)` takes a capture beside a fetched scope.
29. **The raw scope from ids.** `rawScope(snapshot, anchors)` asks `targets` of the anchors once,
    then `negators` of each new layer until a layer adds nothing. It asks for each member once,
    so it costs O(|members| × log N) in closure depth plus one calls.
30. **Entity anchors only.** A capture, `rawScope` and `touching` read entity anchors, the only
    kind slices 1 and 2 built. Another kind is refused `capability-absent`, as `scope` refuses it.
31. **The order of the first touch.** Records in revision order; within one record, `removed`
    before `added`; each list in its own ascending order; for one delta, `targets-anchor` before
    `negates-member`. Two witnesses then report one touch. No store yet writes a record with
    both lists, so the shared `touching` cases pin the order within one record.
32. **A re-added member touches twice.** A member is yielded by an anchor or negates a member. So
    when it comes back, rule 2 of §4.6 also touches. Rule 1's clause "also when the id is added
    again" decides only that the first touch is the removal. A reader that ignores a re-add
    therefore reports the touch one record late, and the vectors catch it by the touch.
33. **`checkFresh`'s calls are normative.** One `read`; when its history is not the capture's,
    nothing more; no feed at equal revisions; a capture from a later revision answers
    `resync-required` with no feed call; `changes(c, r′)` with an explicit `to`, then from each
    `through`; one `get` per page that names an added id, of exactly those ids, ascending, before
    the page is judged, and none for a page with no added id; no call after the page that touches
    or after `resync-required`; the release of the snapshot. Cost is a property of calls, and a
    reader that reads past r′ shows only in its calls.
34. **The answers in order.** `resync-required` first, then `stale`, then the window: `not-yet`
    when `now < since`, `expired` when `now ≥ expiresAt`; else `current`. A touch decides before
    time does, because a stale capture is wrong at every time.
35. **A moved snapshot.** On a store without read transactions, a commit during a check moves its
    snapshot, and its `get` refuses `snapshot-moved`. `checkFresh` then starts again on a new
    snapshot, as `StoreReactor` does (§4.12 reading 11): at most four snapshots, each released.
    A `current` answer speaks for the snapshot the check read; a later commit is a later check.
36. **Freshness needs the feed.** Every freshness case requires `changes`. A store that keeps
    fewer records than a case needs answers `resync-required` for a capture below its floor; the
    runner expects that answer there, as it does for `changes` steps (README §9.3).
37. **The history is read with the revision.** `Snapshot.history` is there so that a capture's
    history and revision come from one read, and a check's comparison too. `PeerStore.history`
    is the same value, for a caller that holds no snapshot. Every handle of a peer reports it.
38. **The memory store's history.** Each `createPeer` mints a value: `memory:<n>` from one counter
    for the whole process, so two peers, two stores, or one name created twice in a process never
    share one. The package boundary forbids ambient randomness in the store, so the store does not
    mint 128 random bits itself; a host that keeps captures across processes passes
    `mintHistory`, and a mint that answers no non-empty string is refused `invalid-request`.
39. **The runner checks histories by equality only.** A random value cannot be pinned. A created
    handle's history is a non-empty string, other peers of the store have other values, a
    reopened handle and every snapshot report the peer's value (README §1.3). One name created in
    two stores has two values; no script can delete a peer, so each witness tests that itself.
40. **A capture is checked, never repaired.** `parseCapture` refuses a list that is not strictly
    ascending by UTF-8 bytes; it does not sort. A capture stored by code that sorted by UTF-16
    code units (JavaScript's default `sort`) is refused, not searched in the wrong order and
    answered `current`. The runner checks every capture a witness returns this way.
41. **`rounds.json` pins the window and the raw scope.** Each expected answer carries `since`,
    `expiresAt` and `rawMembers`, the raw scope of `scope` (a capture's members). Four cases read
    at `now` 55, inside the fixture's boundaries, so the window is closed at both ends and the
    dynamic anchors differ from those at 100.


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
- **A stated exception to the cost rule.** A compacting copy of the LMDB file costs O(store). So
  a `proven` purge on LMDB breaks the rule that no operation costs O(store) (§3, §4.2). An LMDB
  store that offers class `proven` states this exception in its documentation. A host that cannot
  pay it opens the store as `unprovable`, and its purge then costs O(targets × log N). The
  forced compaction of RocksDB is bounded by the key range of the targets, not by the store.

### 5.4 Immutable segments (packs plus a sidecar index)

The log becomes immutable files. Each **segment** is a SPEC-8 pack plus a sorted sidecar index:
an id table, `entity → ids`, `negated → ids`, `(role, value) → ids`, and a Bloom filter per key
class. A small **manifest** lists the live segments at each revision.

- **Writes** go to a mutable head tier, which is another store (§5.6 overlay). A compactor seals
  the head into a segment and merges segments by size tiers. The segment count stays O(log N), so
  a lookup costs O(log² N).
- **A stated exception to the cost bound.** O(log² N) per key is above the O(k × log N + result)
  of §4.2. A segment store meets §4.2 only when one merged segment remains. Otherwise it states
  the exception: each key costs one lookup per live segment. A Bloom filter skips most segments
  in practice, but it does not change the bound.
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
4. **Views.** A maintained view is a stored, anchored read with its capture. It is current when no
   change since its revision touches the capture (§4.6), `now` is before `expiresAt`, and the
   host's own epoch for its selection and authority has not moved. Incremental equivalence
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
  A rail on how work scales with its own input, where the code under test could do work it
  does not count, times that work from outside instead (§4.11, reading 36).
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
