# SPEC-18 slice 4: the durable store (build plan)

**Status:** plan. It is deleted when the slice lands; its decisions fold into §12 of
`18-store.PROPOSAL.md` and its owed items into §10.2, as the slice 2 and slice 3 plans did.

**Rule for this slice (Myk, 2026-11-15).** The durable store uses the database properly. A read is
an indexed query. The engine does the scanning. Loam's present driver stored whole records and
scanned them in the host; it is a list of erasure surfaces to clear, not a design to port.

## 1. What the slice delivers

A store at `sqlite:///path/file.db` that passes the same four conformance suites as the memory
store (`runStoreConformance`, freshness, follow, views), keeps its data across processes, and
proves erasure on the files it controls.

The first consumer trial needs only steps 4a and 4b: one Loam read door, on a host with no pools,
over a store that a fixture filled.

## 2. Decisions

Each is made here under the store-arc delegation. Each moves to §12 when its step lands.

- **S4-1. The binding is `better-sqlite3`,** an optional peer dependency behind the subpath
  `@bombadil/rhizomatic/store/sqlite` (§9). Rust uses `rusqlite` behind the cargo feature
  `sqlite`.
- **S4-2. A snapshot never pins pages.** A `Snapshot` holds a peer id and a revision, not a read
  transaction. Each call is one statement that also reads the peer's revision, and refuses
  `snapshot-moved` when it differs (§4.2 allows this). So no open snapshot can keep purged bytes
  readable, and the write-ahead log can always be truncated. The cost is a retry under write load;
  the readers already retry (§4.13 reading 102).
- **S4-3. Bytes are counted by rows, not by a counter.** The proposal's `delta.refs` column is
  dropped. "Does another peer hold this id" is an indexed `EXISTS` on `holding(delta)`. A counter
  can drift from the rows; a query cannot.
- **S4-4. One reference table serves negators and gap G2.** Every delta pointer is a row in
  `reference(peer, ref, role, delta)`. `negators` is that table at `role = 'negates'`.
- **S4-5. The purge report names what it retains.** `PurgeReport` gains
  `retains: readonly { surface: "change-feed"; holds: "id" }[]`. It lists the feed while a kept
  record names a purged id. The claim rule is unchanged: the feed id lies outside "absent"
  (decision O4). The memory store reports the same field. This is a contract change in both
  witnesses.
- **S4-6. A durable store's default retention is `{revisions: 1024}`.** `unbounded` is opt-in.
- **S4-7. Revision order is enforced by the write lock.** An append or purge runs in
  `BEGIN IMMEDIATE`, reads the peer's revision and writes revision + 1 in the same transaction.
  Two writing processes therefore commit records in revision order. The profile says
  `writers: "many-processes"`.
- **S4-8. A store cannot detect that its file was copied.** `openStore(url, {restored: true})`
  gives every peer a new history. A host that restores a backup passes it. Every history a store
  issued stays in a table, so a repeated host mint is refused after a reopen too.
- **S4-9. The journal split is step 4d, after the trial.** Steps 4a to 4c ship with
  `journal: false` and `digest: false`: a non-null `frame` is refused `capability-absent`, and the
  head compare-and-set still runs (§4.5). Who builds `frame` and `nextHead` (gap G11) and the
  shape of the fault report (gap G6) are decided in 4d.
- **S4-10. TypeScript first; Rust before the slice counts as conformant.** This is the witness
  policy the necessity audit proposed and Myk accepted on 2026-11-15. The Rust builder works from
  this plan, the proposal and the vectors only.
- **S4-11. Value indexes stay in slice 6.** The schema leaves room; nothing is built.

## 3. Schema

`peer` leads every per-peer key, so one peer's read never pays for another peer's rows. Tables
with a composite primary key are `WITHOUT ROWID`, so the key is the clustered index.

```sql
meta      (key TEXT PRIMARY KEY, value)                       -- store format version
peer      (id TEXT PRIMARY KEY, posture, store_class, history, revision INTEGER,
           head BLOB, count INTEGER, max_seq INTEGER, app_format TEXT)
history   (value TEXT PRIMARY KEY)                            -- every history issued (S4-8)

delta     (id TEXT PRIMARY KEY, bytes BLOB NOT NULL,          -- the only table with payload
           author TEXT NOT NULL, timestamp INTEGER NOT NULL)  -- copied out for pushdown and G3

holding   (peer, delta, seq INTEGER, arrival BLOB, author TEXT,
           PRIMARY KEY (peer, delta))
          INDEX (peer, seq)                                   -- arrival pushdown; ranges (G4)
          INDEX (delta)                                       -- "held by another peer" (S4-3)
          INDEX (peer, author)                                -- count per author (G3)

target    (peer, entity, delta,       PRIMARY KEY (peer, entity, delta))
reference (peer, ref, role, delta,    PRIMARY KEY (peer, ref, role, delta))

change    (peer, revision INTEGER, head BLOB, added BLOB, removed BLOB,
           PRIMARY KEY (peer, revision))
debt      (peer, delta,               PRIMARY KEY (peer, delta))   -- purge owes (§4.7.2)
surface_debt (surface TEXT, peer, delta)                      -- a surface not yet cleared (4b)
```

Ids are `TEXT` under the default `BINARY` collation, so `ORDER BY id` is the byte order §4.2
requires. `holding.author` repeats the delta's author so the count per author is an index range;
it leaves with the holding row.

`change.added` and `change.removed` are sorted id lists in one value each. A record is read whole
and never searched by id, so a row per id would buy nothing.

## 4. Each contract read is one indexed statement

Lists of keys go in as one JSON parameter and are joined through `json_each`, so each operation is
one prepared statement whatever the number of keys.

| Operation | Statement | Index used |
|---|---|---|
| `read()` | one row of `peer` | primary key |
| `get(ids)` | `holding` joined to `delta` | `holding` key, `delta` key |
| `arrivals(ids)` | `holding` | `holding` key |
| `targets(entities)` | `target` | `target` key prefix (peer, entity) |
| `negators(ids)` | `reference` at role `negates` | `reference` key prefix (peer, ref, role) |
| `scope(request)` | a recursive common table expression: `target` rows at the anchors, then `reference` rows at role `negates` until none is new; joined to `holding` and `delta` | the keys above |
| pushdown `arrivalAtMost` | `holding.seq <= ?` inside the recursion | `holding` key |
| pushdown `timestampAtMost` | `delta.timestamp <= ?` inside the recursion | `delta` key |
| `exclude`, `excludeIds` | an anti-join on the JSON list; `exclude` filters the output only, `excludeIds` filters inside the recursion (§4.3) | none needed |
| `changes(from, to)` | a range of `change` | `change` key |
| `count` | `peer.count` | primary key |

Every statement also selects the peer's revision and is refused `snapshot-moved` when it differs
(S4-2).

**The query-plan rail.** A test runs `EXPLAIN QUERY PLAN` on every prepared statement of the
store. It fails when a plan scans a base table. A scan of `json_each` is allowed. This is the cost
rule of §4.2 in a form the engine checks, and it is the guard on the rule at the top of this plan.

## 5. Writes

- **Append** is one `BEGIN IMMEDIATE` transaction: head compare-and-set, id recomputation, arrival
  checks, `delta` rows for bytes not yet stored, `holding`, `target`, `reference`, the `peer` row
  and one `change` row. A refusal rolls back all of it.
- **Purge** is one transaction: delete this peer's `holding`, `target` and `reference` rows for
  the ids, write the `change` row, then delete each `delta` row that no `holding` row names. The
  pointer rows repeat erasable information (entity ids), so they go in the same commit as the
  bytes.
- **Retention** drops old `change` rows in the transaction that writes the record after the nth.

## 6. Proven erasure (step 4b)

The store's class is `unprovable` until this step lands, and every report says `unproven`. That is
an honest report, and the conformance suite allows a store to claim less.

- `secure_delete = ON`, so SQLite overwrites freed table and index cells with zeros.
- `journal_mode = WAL`; after the purge commits, `wal_checkpoint(TRUNCATE)`. S4-2 means no
  snapshot blocks it; another process's open statement still can.
- When the checkpoint is busy, the surface `wal` is `owed`, the claim is not `proven`, and a
  `surface_debt` row records it. The debt survives a crash and a reopen. A later purge or an
  explicit settle clears it and only then reports `absent`.
- `temp_store = MEMORY`. The store writes no side files of its own.
- Declared surfaces: `rows`, `index-entries`, `freed-pages`, `write-ahead-log`, `temp-files`.

**Rails, each two-sided and on real files in a `mkdtempSync` directory.** The target carries a
marker in a primitive value and a second marker in an entity id. After the purge, neither marker
is in any file of the directory, and a named bystander delta still reads back with the same
bytes. The cases come from Loam's `test/store/erasure-at-rest.test.ts`, as requirements:

1. A purged delta leaves no marker in the database file, the log or the shared-memory file.
2. A busy checkpoint gives `owed`, never `proven`; the debt survives a crash; an unrelated purge
   under the same busy log is reported on its own.
3. A purge of every delta leaves no marker anywhere in the directory.
4. A purge whose delete finds nothing still settles an owed surface.
5. Bytes another peer holds stay, and the report says `held-by-other-peer` without a name.
6. A peer with posture `proven` is refused on a store whose class is not `proven`.

**This step adds purge code to rhizomatic. It does not widen what Loam purges, because Loam does
not use this store yet.** The Loam change that adopts it is Myk's merge.

## 7. Steps

Each step is one PR with a fresh-context review. Rust follows per S4-10.

| Step | Contents | Gate |
|---|---|---|
| 4a | Schema; peers; append; every read; scope; purge at class `unprovable`; the change feed; the query-plan rail; the subpath export | The four conformance suites pass on `sqlite:`; the cost rails count the same calls at 0 and N unrelated deltas |
| 4b | Proven erasure and posture gating (§6); `retains` in the report (S4-5) in both witnesses | The six rails of §6; each seen red |
| 4c | Many writing processes (S4-7); persisted histories and `restored` (S4-8); bounded default retention (S4-6) | A rail with two writing processes and one follower in a third: the feed arrives in order with no gap |
| trial | Publish a `-next`. One Loam read door on the store | A Loam PR; outside this plan |
| 4d | The journal split (§4.7.3): head chain, small checkpoint, the holdings digest, `fsck`, format markers; G11; G6; whether an erasure order and its purge share one commit; lost index entries | Open costs O(tail); `fsck` finds a deleted `target` row |
| 4e | Rust witness of 4a to 4d, from the documents | The same vectors and rails |
| 4f | The contract reads for G2 (references), G3 (count per author) and G4 (arrival range) | Each is one indexed statement under the query-plan rail |

## 8. What slice 4 owes, and where it lands

| Owed item (§10.2, §12) | Step |
|---|---|
| Fault values for a durable store | 4a |
| Purge report names the feed | 4b (S4-5) |
| No `absent` while a snapshot reads the bytes | 4b (true by S4-2; a rail holds it) |
| Bounded default retention | 4c (S4-6) |
| Records visible in revision order | 4c (S4-7) |
| Persisted history; new history on restore | 4c (S4-8) |
| Release-mode cost rails | 4e |
| Lost index entries | 4d |
| Frame and head (G11); fault report (G6); peer delete (G5 f) | 4d |

## 9. Risks

- A reader under constant writes can meet `snapshot-moved` repeatedly (S4-2). The readers stop
  after a fixed number of tries. The trial measures how often it happens.
- `secure_delete` is the basis of `proven`. The byte rails are what holds it, not the pragma.
- Another process with an open statement can keep the log from truncating. The report then says
  `owed`. It must never say `proven`.
- The recursion in `scope` must end on a negation cycle. `UNION` (not `UNION ALL`) ends it; a
  vector with a cycle holds it.
- `better-sqlite3` is a native module. It stays optional, so a browser bundle never loads it.
