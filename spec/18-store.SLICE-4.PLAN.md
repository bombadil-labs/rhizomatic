# SPEC-18 slice 4: the durable store (build plan)

**Status:** plan, revision 3 (after two rounds of design review on PR #85). It is deleted when the slice
lands; its decisions fold into §12 of `18-store.PROPOSAL.md` and its owed items into §10.2, as the
slice 2 and slice 3 plans did.

**Rule for this slice (Myk, 2026-11-15).** The durable store uses the database properly. A read is
an indexed query. The engine does the scanning, and the engine enforces every consistency it can.
Loam's present driver stored whole records and scanned them in the host; it is a list of erasure
surfaces to clear, not a design to port.

## 1. What the slice delivers

A store at `sqlite:///path/file.db` that passes the same four conformance suites as the memory
store (`runStoreConformance`, freshness, follow, views), keeps its data across processes, and
proves erasure on the files it controls.

The first consumer trial needs only steps 4a and 4b: one Loam read door, on a host with no pools,
over a store that a fixture filled.

## 2. A finding that changes the basis of "proven"

The proposal (§5.2) and Loam's present driver both rest "proven" on `secure_delete = ON` plus a
truncated write-ahead log. **That basis is false.** Measured on PR #85, and reproduced separately:

- When SQLite rebalances a b-tree page it copies live cells and leaves the old copies in the
  unallocated space of a live page. A later purge zeroes only the live cell.
- On this plan's schema, 6,000 deltas with 3,000 purged left 17 fragments in the database file
  after a clean truncate: ids, an arrival record, an author prefix, an entity id.
- On a Loam-shaped table, 8,000 rows left 59 fragments, 49 of them payload. A second script left 1
  of 2,667. With `secure_delete` off the count was 1,865. After `VACUUM` it was 0.
- A test with few rows never rebalances a page, so it passes with the defect present.

So a store that claims `proven` must rebuild its pages after a purge, and its tests must run at a
scale that rebalances. §7 is written from that.

## 3. Decisions

Each is made here under the store-arc delegation. Each moves to §12 when its step lands.

- **S4-1. The binding is `better-sqlite3`,** an optional peer dependency behind the subpath
  `@bombadil/rhizomatic/store/sqlite` (§9). Rust uses `rusqlite` behind the cargo feature
  `sqlite`.
- **S4-2. A snapshot never pins pages.** A `Snapshot` holds a peer id, a history and a revision,
  not a read transaction. Each call runs one short read transaction: it reads the peer's history
  and revision, refuses `snapshot-moved` when either differs, then runs the data statement, then
  ends. A call that finds no rows is therefore still checked. No open snapshot can keep purged
  bytes readable or block a truncate. The cost is a retry under write load; the readers already
  retry (§4.13 reading 102).
- **S4-3. Bytes are counted by rows, not by a counter.** The proposal's `delta.refs` column is
  dropped. A foreign key from `holding.delta` to `delta(id)` makes a holding without bytes
  impossible, and "does another peer hold this id" is an indexed `EXISTS`.
- **S4-4. One reference table serves negators and gap G2.** Every delta pointer is a row in
  `reference(peer, ref, role, delta)`. `negators` is that table at `role = 'negates'`.
- **S4-5. The purge report names what it retains, conservatively.** `PurgeReport` gains
  `retains: readonly { surface: "change-feed" | "purge-debt" | "surface-debt"; holds: "id" }[]`. It lists
  `change-feed` whenever the peer's retention is not `none`, and `purge-debt` whenever a debt row
  names a removed target. The list may name a surface that no longer holds the id; it never omits
  one that does. The claim rule is unchanged (decision O4). A purge debt ends when the owing peer
  asks again and is answered `removed`. The memory store reports the same field. This is a
  contract change in both witnesses.
- **S4-6. A durable store's default retention is `{revisions: 1024}`.** `unbounded` is opt-in.
- **S4-7. Revision order is enforced by the write lock.** An append or purge runs in
  `BEGIN IMMEDIATE`, reads the peer's revision and writes revision + 1 in the same transaction.
  The profile says `writers: "many-processes"`.
- **S4-8. A new history when the file has a new identity.** The store records the file's
  identity (device, file index and birth time in nanoseconds, as three decimal strings, read as
  64-bit integers) in `meta`. At
  open, inside `BEGIN IMMEDIATE`, a different identity gives every peer a new history, once. This
  catches a copy at a new path and a restore by rename. Step 4c added the birth time: ext4 gave a
  backup copied to the path of a removed file the removed file's index (proposal §4.13 reading
  122). **It does not catch a restore that writes
  over the same file**: the identity is unchanged, so that host must pass
  `openStore(url, {restored: true})`. A device number can change on a remount; the wrong mint
  costs a resync and nothing else. Every history a store issued stays in a table, so a repeated
  host mint is refused after a reopen too.
- **S4-9. The journal split is step 4d, after the trial.** Steps 4a to 4c ship with
  `journal: false` and `digest: false`: a non-null `frame` is refused `capability-absent`, and the
  head compare-and-set still runs (§4.5).
- **S4-10. TypeScript first; Rust before the slice counts as conformant.** This is the witness
  policy the necessity audit proposed and Myk accepted on 2026-11-15. The Rust builder works from
  this plan, the proposal and the vectors only.
- **S4-11. Value indexes stay in slice 6.**
- **S4-12. `proven` needs a rebuild of the pages** (§2), and the residue belongs to the file, not
  to a peer. Two counters keep it, in a one-row table `residue`. A trigger raises `dirty` in the
  transaction of every delete and every update of a `holding`, `delta`, `target` or `reference`
  row. A rebuild reads `dirty` as `d` before `VACUUM`. When `VACUUM` and
  `wal_checkpoint(TRUNCATE)` both succeed and the log is empty at the last transaction's lock,
  that transaction sets `clean = max(clean, d)`. The file is clean iff `clean = dirty` in that
  transaction. A file surface is `absent` only when the file is clean and the log was empty when
  the last transaction took the write lock (§4.13 reading 119); otherwise every file surface is
  `owed` and the claim is not `proven`. A peer of posture `proven` rebuilds whenever the file is
  not clean after its first transaction, also when it removed nothing, and it always truncates the
  log before its last transaction.
- **S4-13. A later purge gives the later proof.** A peer of posture `proven` that removes an id
  writes a `surface_debt` row `(peer, delta)` in the delete's transaction. A later purge of that id
  by that peer answers `removed`. The row ends when that answer finds the file clean, and stays
  while it does not. An append of the id ends every peer's row for it: the bytes are live again,
  and no proof of absence exists. `retains` names `surface-debt` while such a row exists. It is a
  new reading.
- **S4-16. A peer with posture `unproven` does not pay for a rebuild.** Its purge runs none and
  keeps no row per id: the counter is its record. It reports every file surface `owed` while the
  file is not clean, and never claims `proven`. The next rebuild by a peer of posture `proven`
  cleans the file.
- **S4-14. Process memory is outside the claim of a store that keeps its data in files.** The
  memory store declares `process-memory: unprovable` because memory is its only medium. A durable
  store's page cache and statement memory hold bytes until the process frees them. The boundary
  text of every report says so. Without this, no durable store could claim `proven`. **This states
  a limit of the erasure promise. Myk ruled it on 2026-11-15; §4.7.2 of the proposal records
  it.**
- **S4-15. Strings must be well-formed.** A lone surrogate takes two byte forms in SQLite (a
  direct bind and `json_each` differ), so a stored entity would not be found. Append refuses a
  delta that carries a string that is not well-formed (`invalid-admission`), and a read refuses
  such a key (`invalid-request`), in every store and both witnesses. It is a new reading.

## 4. Schema

`peer` leads every per-peer key, so one peer's read never pays for another peer's rows. Every
table is `STRICT`. Tables with a composite primary key are `WITHOUT ROWID`. Foreign keys are on. A table
whose rows can overflow a page (`delta`, `holding`, `change`) is a rowid table, because a seek in a
`WITHOUT ROWID` table reads whole neighbour cells. A holding's arrival record has no size bound
(step 4b, after the round 2 review of 4a). Its primary key is then a unique index, which the
foreign keys of `target` and `reference` reference.

```sql
meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL)   -- format; file identity; retention
history   (value TEXT PRIMARY KEY)                      -- every history issued
peer      (id TEXT PRIMARY KEY,
           posture TEXT NOT NULL CHECK (posture IN ('proven','unproven')),
           store_class TEXT NOT NULL CHECK (store_class IN ('proven','unprovable')),
           history TEXT NOT NULL UNIQUE REFERENCES history,
           revision INTEGER NOT NULL, floor INTEGER NOT NULL, head TEXT,
           count INTEGER NOT NULL CHECK (count >= 0), max_seq INTEGER NOT NULL,
           app_format TEXT)

delta     (id TEXT PRIMARY KEY, claims BLOB NOT NULL,   -- the canonical bytes the id hashes
           author TEXT NOT NULL, timestamp REAL NOT NULL)      -- copied out for pushdown

holding   (peer TEXT NOT NULL REFERENCES peer, delta TEXT NOT NULL REFERENCES delta(id),
           seq INTEGER NOT NULL, arrival TEXT NOT NULL, sig TEXT, author TEXT NOT NULL,
           PRIMARY KEY (peer, delta),  UNIQUE (peer, seq))     -- arrival pushdown; ranges (G4)
          INDEX (delta)                                        -- "held by another peer"
          INDEX (peer, author)                                 -- count per author (G3)

target    (peer TEXT NOT NULL, entity TEXT NOT NULL, delta TEXT NOT NULL,
           PRIMARY KEY (peer, entity, delta),
           FOREIGN KEY (peer, delta) REFERENCES holding ON DELETE CASCADE)
          INDEX (peer, delta)                                  -- find a delta's rows to remove
reference (peer TEXT NOT NULL, ref TEXT NOT NULL, role TEXT NOT NULL, delta TEXT NOT NULL,
           PRIMARY KEY (peer, ref, role, delta),
           FOREIGN KEY (peer, delta) REFERENCES holding ON DELETE CASCADE)
          INDEX (peer, delta)

change    (peer TEXT NOT NULL, revision INTEGER NOT NULL, head TEXT,
           added TEXT NOT NULL, removed TEXT NOT NULL,         -- sorted JSON arrays of ids
           PRIMARY KEY (peer, revision))                       -- a rowid table
debt         (peer TEXT NOT NULL, delta TEXT NOT NULL, PRIMARY KEY (peer, delta))
surface_debt (peer TEXT NOT NULL, delta TEXT NOT NULL,
              PRIMARY KEY (peer, delta))                       -- step 4b
residue   (one INTEGER PRIMARY KEY CHECK (one = 1),            -- step 4b: exactly one row
           dirty INTEGER NOT NULL, clean INTEGER NOT NULL CHECK (clean <= dirty))
          -- AFTER DELETE and AFTER UPDATE triggers on holding, delta, target and
          -- reference: dirty = dirty + 1
```

- **A signature belongs to a holding.** Two peers can hold one id under different appearances
  (§4.11 reading 5). `delta.claims` holds the canonical claims only; `holding.sig` and
  `holding.arrival` are the peer's own and leave with its row. `arrival` is the record in the
  canonical JSON form the vectors use; `sig` and `head` are the strings the contract carries.
- **A delta's pointer rows cannot be stranded.** They cascade from the holding row, and the
  `(peer, delta)` indexes make that delete a point lookup. After the delete the purge reads those
  indexes again and reports `index-entries` from what it finds.
- Ids are `TEXT` under the default `BINARY` collation, so `ORDER BY id` is the byte order §4.2
  requires.
- `change.added` and `change.removed` are sorted id lists in one value each. A record is read
  whole and never searched by id.
- `surface_debt` names a peer only so that its owner can ask again (S4-13). It decides no surface
  state: the residue is the file's, and `residue` counts it (S4-12). Pointer rows cascade from
  `holding`, and the cascade fires their own triggers. `change`, `debt` and `surface_debt` hold
  ids only (decision O4), and no trigger counts them. No statement uses `REPLACE`: it deletes
  rows without a delete trigger while `recursive_triggers` is off.
- `delta.timestamp` is `REAL`: a signed creation time is any finite number, and the memory store
  accepts one that is not whole.
- `peer.count` and `peer.floor` are written in the same transaction as the rows they summarize. A
  rail compares each with a count over the rows after every step of the conformance scripts.

**Connection rules.** Pragmas are per connection. At every open the store sets and then reads
back `foreign_keys = ON`, `secure_delete = ON`, `journal_mode = WAL`, `synchronous = FULL` and
`temp_store = FILE`, and refuses to open on a mismatch. The store never runs `ANALYZE`: the statistics
tables would copy index keys.

## 5. Each contract read is one indexed statement

Lists of keys go in as one JSON parameter through `json_each`. The key list drives the join
(`CROSS JOIN` fixes the order), and an exclusion is `NOT IN (SELECT value FROM json_each(?))`,
which builds the list once.

| Operation | Statement | Index used, with every key column bound |
|---|---|---|
| `read()` | one row of `peer` | primary key |
| `get(ids)` | keys → `holding` → `delta` | `holding (peer, delta)`; `delta (id)` |
| `arrivals(ids)` | keys → `holding` | `holding (peer, delta)` |
| `targets(entities)` | keys → `target` | `target (peer, entity)` |
| `negators(ids)` | keys → `reference` at role `negates` | `reference (peer, ref, role)` |
| `scope(request)` | a recursive common table expression: `target` rows at the anchors, then `reference` rows at role `negates` until none is new (`UNION` ends a cycle); joined to `holding` and `delta` | the keys above |
| pushdown `arrivalAtMost` | `holding.seq <= ?` inside the recursion | `holding (peer, delta)` |
| pushdown `timestampAtMost` | `delta.timestamp <= ?` inside the recursion | `delta (id)` |
| `exclude` | filters the output only | none |
| `excludeIds` | filters inside the recursion (§4.3) | none |
| `changes(from, to)` | a range of `change` | `change (peer, revision)` |
| `count` | `peer.count` | primary key |

**The query-plan rail.** The first form of this rail refused only a base-table `SCAN`. The review
showed it hollow: a `SEARCH … (peer=?)` reads a whole peer and passes. The rail is now:

1. The store keeps its statements in one list. A test runs `EXPLAIN QUERY PLAN` on each and
   compares the full plan text with a committed expectation. A changed plan fails until a person
   reads it.
2. The test also refuses, by rule: any `SCAN` of a base table; any `AUTOMATIC` index; any `SEARCH`
   of `holding`, `target` or `reference` that binds `peer` alone.
3. A timing rail runs each read against one peer with N and with 16 N unrelated deltas **in the
   same peer**. It also runs one append and one purge at each size: a plan shows no
   foreign-key action, and a cascade without its index costs O(peer). The time may not grow with
   N beyond a logarithmic allowance. It follows the timed
   rails of slice 3 (§4.11 reading 36): shared lock, three measurements.

## 6. Writes

- **Append** runs every check before its first write: the head compare-and-set, id recomputation,
  well-formed strings (S4-15), arrival checks. Then one `BEGIN IMMEDIATE` transaction writes
  `delta` rows for claims not yet stored, `holding`, `target`, `reference`, the `peer` row and one
  `change` row. A refused batch therefore writes no page at all. A crash rail kills the process
  inside the transaction and finds all of the batch or none of it.
- **Purge** runs a first transaction: delete this peer's `holding` rows (the pointer rows
  cascade), delete each `delta` row that no `holding` row names, write a `surface_debt` row per
  removed id for a peer of posture `proven`, and write the `change` row. The triggers count the
  deletes in that transaction. Then the rebuild and the truncate (§7), and a last transaction
  that decides the report.
- **Retention** drops old `change` rows in the transaction that writes the record after the nth.

## 7. Proven erasure (step 4b)

The store's class is `unprovable` until this step lands, and every report says `unproven`. The
conformance suite allows a store to claim less.

**The rebuild is `VACUUM` in place with `temp_store = FILE`.** The design review measured the
candidates on a 156 MB store:

- In place with a file temp store: memory stayed flat (48 MB to 52 MB). SQLite writes the live
  rows to a temporary file in the system temp directory, created after the delete commits and
  unlinked at creation. It never holds a purged byte.
- In place with a memory temp store: memory rose to the size of the store. Refused.
- `VACUUM INTO` a new file and a swap: unsafe. A second open connection replayed its old log onto
  the new file. Refused.

The first task of 4b repeats the measurement at 100,000 deltas with half purged, and records it.
What it must show: no marker of a purged delta in any file of the store's directory; flat memory;
`owed` when another process holds the store.

Limits, stated in the report's boundary text and in the proposal:

- The rebuild needs free disk of about three times the store, and the log grows to the size of
  the store while it runs.
- The temporary file holds **live** deltas. On Unix it is unlinked at creation, so a crash leaves
  nothing. On Windows it is deleted at close, so a power loss during a rebuild can leave it in
  the temp directory, and a later purge of those deltas does not reach it. **Decided in 4b: the
  class is `proven` on Linux only, and `unprovable` on Windows, macOS and every other
  platform.** On macOS no rail runs, and `fsync` does not flush the drive's cache without
  `fullfsync`. Both gaps are named in the proposal (§5.2). A temp directory the store controls,
  or a sweep at open, could close the Windows gap later.

**The report.**

- Declared surfaces: `rows`, `index-entries`, `page-free-space`, `freed-pages`,
  `write-ahead-log`. The experiment adds a surface for whatever side files the method uses: the
  rebuild's temporary file, `temp-files`. It is `unprovable` on a store of class `unprovable`.
- After the delete commits and before the rebuild and truncate succeed, **every** surface is
  `owed`. A busy checkpoint leaves the bytes in the database file, not in the log, so no file
  surface can be `absent` then. The checkpoint pragma answers `busy` as a row and does not throw;
  the store reads it.
- The count is raised in the delete's transaction, so a crash at any later point leaves the file
  not clean. A reopened store reports `owed` until a rebuild succeeds.
- A later purge of the same ids runs the rebuild again and answers `removed` with the present
  states (S4-13). That is the path to the later proof, until another peer adds the id again.

**Settled for 4b after the third review of PR #87.** Three review rounds each found a state that
a per-id mechanism (states, generations, a file-level mark) did not list. One invariant replaces
it.

- *The file is clean iff `clean = dirty`, kept by triggers* (S4-12). A delete that commits after a
  rebuild read `d` raises `dirty` past `d`, whichever step of the rebuild it falls between. That
  rebuild then sets `clean` to `d`, and the file stays not clean. No other path gives `absent`.
- *The last transaction decides the report.* It looks again at the delta row of every target the
  call released and of every id it answers from a record or a purge debt. A present row gives
  `held-by-other-peer`, and the peer gets the purge debt it would have had. It consumes the
  records and purge debts it answers from; no earlier transaction does. The answer of each id
  does not depend on the other ids of the call.
- *The asking peer gets its own record.* When a purge debt answers `removed` while the file is not
  clean, a peer of posture `proven` gets a `surface_debt` row in that transaction.
- *A proof needs an empty log under the write lock* (after the fourth review; §4.13 reading
  119). A write that fails or dies leaves its pages in the log, and deletes no row. A peer of
  posture `proven` always truncates the log before its last transaction. That transaction reads
  the size of `store.db-wal` just after `BEGIN IMMEDIATE`. A size other than 0 sends it back to
  truncate again, at most three tries in all; the third answers `owed` without the proof. Every
  peer's `absent` needs the empty log, a peer of posture `unproven` included.
- *The format stays `rhizomatic-store-sqlite/2`* after the fourth review added triggers. No
  release and no `main` commit ever wrote a `/2` file without them: `/2` exists only on the
  branch of PR #87. A file of an earlier head of this branch is test data.
- *A file that 4a wrote is refused.* 4b raises the format string to `rhizomatic-store-sqlite/2`.
  The tables changed too: `holding` became a rowid table. Open refuses a `/1` file with
  `open-failed` and names both formats. No rebuild and no migration ships: the work is greenfield,
  and a `/1` file is test data. (This replaces the earlier rule, which rebuilt a `/1` file at
  open; that rule assumed the same tables.)

**Rails, each seen red first, each two-sided, on real files in a `mkdtempSync` directory.** A
target carries a distinct marker in each place the schema copies erasable material: a primitive
value, an entity id, a referenced id, the author, the arrival record and the signature. A named
bystander delta reads back with the same bytes after every case.

1. **At scale.** 20,000 deltas, deletes of bystanders first so that pages rebalance, then the
   purge. No marker is in any file of the directory. This rail fails on `secure_delete` alone.
2. A purge of every delta leaves no marker anywhere in the directory.
3. A busy checkpoint, held by a second connection, gives `owed` on every file surface, never
   `proven`. The debt survives a kill and a reopen. An unrelated purge under the same busy log is
   reported on its own.
4. A second purge of an owed id, after the reader lets go, answers `removed` and `proven`. A purge
   that removes nothing, while any row is `owed`, runs the rebuild.
5. Bytes another peer holds stay, and the report says `held-by-other-peer` without a name.
6. A peer with posture `proven` is refused on a store whose class is not `proven`.
7. A connection opened without the pragmas is refused.
8. An id leaves the files at the first rebuild after retention drops the record that names it.
   Retention drops inside an append, which runs no rebuild; the report's `retains` says so.
9. **Two peers, one file.** A and B hold X. A purges X: `held-by-other-peer`. B purges X under a
   busy log: `removed`, `owed`. A asks again: `removed`, and every file surface is `owed`, not
   `absent`. After a rebuild, both are answered `proven`.
10. A peer with posture `unproven` purges: no rebuild runs, the report says `owed` and `unproven`,
    and a later rebuild by another peer cleans the file.
11. **A write that does not commit** (after the fourth review). Another process's append dies
    after its pages reach the log, or an append fails on a file-size limit, or such an append
    dies in the window before the last transaction. The next proof of the asking peer empties the
    log first; a report that says `absent` finds no marker in any file.

**This step adds purge code to rhizomatic. It does not widen what Loam purges, because Loam does
not use this store yet.** The Loam change that adopts it is Myk's merge. The same finding applies
to Loam's present driver; that fix is a separate Loam PR.

## 8. Step 4a: what the builder does not decide

The review listed every place where a builder would have to guess. Each is decided here.

1. **Types and byte forms.** As in §4. `claims` is the canonical encoding from which the id is
   computed. `added` and `removed` are JSON arrays of ids in ascending byte order.
2. **Errors.** One new refusal code, `store-unavailable`, in both witnesses; the memory store
   never gives it. It is a recorded contract change. The store gives it when SQLite cannot serve
   the call, of which a lock held past `busy_timeout` is the main case:
   - an append, before its first write: nothing changed;
   - a read: nothing was answered, and never an empty answer in its place;
   - a purge, at any point: the caller asks again. A purge is safe to repeat, and the second
     answer reports the present state.
   An append that fails at or after `COMMIT` answers `uncertain`, as §4.5 says.
3. **Connection.** One connection per `Store`. `busy_timeout = 5000`. `synchronous = FULL`: an
   append answered `committed` must survive a power loss, because the head compare-and-set builds
   on it.
4. **Temp store.** `FILE`, set and read back, from 4a.
5. **The purge report in 4a.** `rows` and `index-entries` come from the second look.
   `page-free-space`, `freed-pages` and `write-ahead-log` are `unprovable`. The claim is `unproven`. No
   `surface_debt` row is written and no truncate runs until 4b.
6. **History.** Minted at `createPeer`: `sqlite:` plus 32 hex digits from the system random
   source. The `mintHistory` option works as in the memory store. The `history` table is in use
   from 4a. The file identity check is 4c.
7. **Retention.** The default is `{revisions: 1024}` from 4a. A host sets it in the open options
   at creation. It is stored in `meta`; a later open that names a different value is refused.
8. **Feed pages.** The option `changePageSize`, default 256 records.
9. **Reference rows.** Every pointer that targets a delta id gets a row from 4a, with the
   pointer's role as `role`. Rows added later would miss older deltas.
10. **Pushdown.** One statement with nullable parameters (`? IS NULL OR h.seq <= ?`). If a pinned
    plan gets worse for it, each variant is its own pinned statement.
11. **The `Exporter`.** Its statements scan by definition. The rail lists each by name with its
    reason, and exempts only those.
12. **An append ends a purge debt.** It deletes the peer's `debt` row for an id it adds, in the
    same transaction (§4.7.2).
13. **Well-formed strings (S4-15).** Checked first among the admission checks: every string in the
    claims and the author. A read checks its key strings. The rail is a TypeScript test and a
    reading; a Rust string is well-formed by type.
14. **The boundary value** stays `"store-controlled-surfaces"`. S4-14 is proposal text and a
    reading, not a new value.
15. **The crash rail.** A child process appends batches in a loop. The parent kills it with
    `SIGKILL` at varied delays, 50 times. After each, a reopen finds every batch whole or absent,
    and the count, the floor and the feed agree with the rows. No hook is added to the store.
16. **`close()`** truncates the log when it can, then closes. Every operation after it refuses as
    the memory store's does.
17. **Format.** `rhizomatic-store-sqlite/1` in `meta`. Open refuses any other value and names
    both. Step 4b raises it to `/2` and refuses `/1` (§7).
18. **The timing rail.** 2,000 and 32,000 unrelated deltas in the same peer. The time at the
    larger size is at most four times the time at the smaller. It takes the shared lock and
    measures three times, as the slice 3 timed rails do, on both CI runners.

## 9. Steps

Each step is one PR with a fresh-context review. Every new rail is seen red before its fix. Rust
follows per S4-10.

| Step | Contents | Gate |
|---|---|---|
| 4a | Schema and constraints; connection rules; peers; append; every read; scope; purge at class `unprovable`; the change feed; the query-plan rail; well-formed strings (S4-15, both witnesses); the subpath export | The four conformance suites pass on `sqlite:`; the query-plan rail, all three parts; the crash-during-append rail; the count and floor rail |
| 4b | The rebuild experiment; proven erasure and posture gating (§7); `retains` (S4-5), the later proof (S4-13) and the process-memory boundary (S4-14) in both witnesses | The ten rails of §7 |
| 4c | Many writing processes (S4-7); persisted histories, file identity and `restored` (S4-8); bounded default retention (S4-6). **Done** (proposal §4.13 readings 120 to 125) | Two writing processes and one follower in a third: the feed arrives in order with no gap; a copied file opens under new histories |
| trial | Publish a `-next`. One Loam read door on the store | A Loam PR; outside this plan |
| 4d | The journal split (§4.7.3): head chain, small checkpoint, the holdings digest and the whole-peer version address (decisions g, O9), `fsck`, format markers; who builds the frame and head (G11); the fault report (G6); peer delete (G5 f); whether an erasure order and its purge share one commit, and whether a purge is under the head compare-and-set; whether a journal frame carries payload; arrival history after a purge; lost index entries | Open costs O(tail); `fsck` finds a deleted `target` row; a byte rail over the journal tables at scale |
| 4e | Rust witness of 4a to 4d, from the documents | The same vectors and rails; cost rails in release mode |
| 4f | The contract reads for G2 (references), G3 (count per author) and G4 (arrival range) | Each is one statement under the query-plan rail |

## 10. What slice 4 owes, and where it lands

| Owed item (§8, §10.2, §12 of the proposal) | Step |
|---|---|
| Fault values for a durable store | 4a |
| Crash during append: all or nothing | 4a |
| Purge report names the feed | 4b (S4-5) |
| No `absent` while a snapshot reads the bytes | 4b (S4-2; rail 3 holds the cross-process case) |
| Erasure surface proofs on real files | 4b |
| Refusal of a proven-posture peer on an unprovable store | 4b |
| Bounded default retention | 4c (S4-6), done |
| Records visible in revision order; a second-process writer seen through the feed | 4c (S4-7), done |
| Persisted history; new history on restore | 4c (S4-8), done; a new history at peer delete is 4d (G5 f) |
| Lost index entries | 4d |
| Frame and head (G11); fault report (G6); peer delete (G5 f) | 4d |
| Whole-peer version address | 4d |
| Journal frames and payload; purge and the head compare-and-set; arrival history after a purge | 4d |
| Release-mode cost rails | 4e |
| A refused open of a file that is not a whole store writes nothing: the schema, format and retention check before the journal mode (proposal §4.13 reading 126) | 4e |
| The open asks again while the switch to WAL answers busy, then refuses `store-unavailable` (proposal §4.13 reading 126) | 4e |
| `with_snapshot`: the public form of `on_snapshots`, with `SnapshotRetry { snapshots, within }`, and its tests: the contract tests 1 to 12 over both stores and the process tests M1 to M5 (proposal §4.13 readings 127 to 129) | 4e |

## 11. Risks

- A rebuild costs O(store) per purge. That is the price of an honest `proven` on this engine. A
  host with a large store may batch purges; a cheaper method is a later question.
- SQLite has one write lock per file. A rebuild or a truncate blocks every peer of the store while
  it runs.
- A reader under constant writes can meet `snapshot-moved` on every try. The readers stop after a
  fixed number of tries. A long pass of held views under a second writing process can fail all of
  them, and that holds back a host's erasure report for those views. The trial measures it. The
  measurement is in the pull request that added `withSnapshot` (readings 127 to 129).
- Another process with an open statement can keep the log from truncating. The report then says
  `owed`. It must never say `proven`.
- A rolled-back transaction leaves its pages in the log until a truncate. Append therefore checks
  before it writes (§6), and the next truncate clears the rest.
- `better-sqlite3` is a native module. It stays optional, so a browser bundle never loads it.
