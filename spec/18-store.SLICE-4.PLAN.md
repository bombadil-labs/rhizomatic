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
  identity (device and file index, as two decimal strings, read as 64-bit integers) in `meta`. At
  open, inside `BEGIN IMMEDIATE`, a different identity gives every peer a new history, once. This
  catches a copy at a new path and a restore by rename. **It does not catch a restore that writes
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
  to a peer. A purge writes a `surface_debt` row, state `owed`, for each id it removes, inside its
  own transaction. Then it rebuilds and truncates. A rebuild and truncate that both succeed mark
  **every** `owed` row of the store `settled`. A report gives a file surface `absent` only when
  its own call rebuilt and truncated after its delete, or when no row of any peer is `owed`.
  Otherwise every file surface is `owed` and the claim is not `proven`. A purge that removes
  nothing still runs the rebuild when any row is `owed`.
- **S4-13. A later purge gives the later proof.** A purge of an id whose `surface_debt` row is
  this peer's answers `removed` with the present surface states, and deletes the row once it is
  `settled`. It is a new reading. `retains` names `surface-debt` while such a row exists.
- **S4-16. A peer with posture `unproven` does not pay for a rebuild.** Its purge writes the
  debts, reports every file surface `owed` and claims `unproven`. The next rebuild by any peer
  settles them.
- **S4-14. Process memory is outside the claim of a store that keeps its data in files.** The
  memory store declares `process-memory: unprovable` because memory is its only medium. A durable
  store's page cache and statement memory hold bytes until the process frees them. The boundary
  text of every report says so. Without this, no durable store could claim `proven`. **This states
  a limit of the erasure promise; it is flagged for Myk in the PR that lands it.**
- **S4-15. Strings must be well-formed.** A lone surrogate takes two byte forms in SQLite (a
  direct bind and `json_each` differ), so a stored entity would not be found. Append refuses a
  delta that carries a string that is not well-formed (`invalid-admission`), and a read refuses
  such a key (`invalid-request`), in every store and both witnesses. It is a new reading.

## 4. Schema

`peer` leads every per-peer key, so one peer's read never pays for another peer's rows. Every
table is `STRICT`. Tables with a composite primary key are `WITHOUT ROWID`. Foreign keys are on.

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
           PRIMARY KEY (peer, revision))
debt         (peer TEXT NOT NULL, delta TEXT NOT NULL, PRIMARY KEY (peer, delta))
surface_debt (peer TEXT NOT NULL, delta TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('owed','settled')),
              PRIMARY KEY (peer, delta))                       -- step 4b
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
- `surface_debt` names a peer only so that its owner can ask again (S4-13). The debt itself is
  the file's: one `owed` row of any peer keeps every report from `absent` (S4-12).
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
- **Purge** is one transaction: record a `surface_debt` row per removed id, delete this peer's
  `holding` rows (the pointer rows cascade), write the `change` row, then delete each `delta` row
  that no `holding` row names. Then, outside it, the rebuild and the truncate (§7), from step 4b.
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
  the temp directory, and a later purge of those deltas does not reach it. **On Windows the
  store's class stays `unprovable` until 4b closes this**, by a temp directory the store controls
  or by a sweep at open. 4b decides and records it.

**The report.**

- Declared surfaces: `rows`, `index-entries`, `page-free-space`, `freed-pages`,
  `write-ahead-log`. The experiment adds a surface for whatever side files the method uses.
- After the delete commits and before the rebuild and truncate succeed, **every** surface is
  `owed`. A busy checkpoint leaves the bytes in the database file, not in the log, so no file
  surface can be `absent` then. The checkpoint pragma answers `busy` as a row and does not throw;
  the store reads it.
- The debt is written in the purge transaction, so a crash between the delete and the rebuild
  keeps it. A reopened store still reports `owed` for those ids.
- A later purge of the same ids runs the rebuild again and answers `removed` with the present
  states (S4-13). That is the path to the later proof.

**Settled for 4b by the third review round.** The 4b builder implements these; they are not open.

- *A rebuild settles only older debts.* `meta` holds a generation number. A purge stamps its
  `surface_debt` rows with the present generation. A rebuild raises the generation first, in its
  own transaction, then runs, and settles only rows of an older generation. A purge that another
  process commits during the rebuild keeps its debt. `surface_debt` gains a `generation` column,
  and a rail runs the two processes.
- *The asking peer gets its own debt row.* When a settled purge debt answers `removed` while any
  row is `owed`, the store writes a `surface_debt` row for the asking peer in that transaction.
  Its next ask can then be answered `proven` (rail 9).
- *A second purge of a re-held id* upserts the row to `owed` under the present generation.
- *A store of `unproven` peers keeps one mark, not a row per id.* An `unproven` peer's purge sets
  one file-level mark, "residue owed since generation g", in `meta`. A rebuild clears it. S4-16
  reads that way; no id is kept for a peer that asked for no proof. The mark holds the generation
  of the latest such purge. A rebuild clears it only when that generation is older than the one
  the rebuild raised. The mark counts as an `owed` row in the S4-12 rule and in the rule for the
  asking peer's row.
- *A file that 4a wrote holds residue with no debt row.* 4b raises the format string to
  `rhizomatic-store-sqlite/2`. Opening a `/1` file runs one rebuild first, then stamps `/2`. When that rebuild or its truncate is
  busy, open stamps `/2` and sets the file mark, so every report says `owed` until a rebuild
  succeeds.

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
    and a later rebuild by another peer settles its debts.

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
    both.
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
| 4c | Many writing processes (S4-7); persisted histories, file identity and `restored` (S4-8); bounded default retention (S4-6) | Two writing processes and one follower in a third: the feed arrives in order with no gap; a copied file opens under new histories |
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
| Bounded default retention | 4c (S4-6) |
| Records visible in revision order; a second-process writer seen through the feed | 4c (S4-7) |
| Persisted history; new history on restore | 4c (S4-8) |
| Lost index entries | 4d |
| Frame and head (G11); fault report (G6); peer delete (G5 f) | 4d |
| Whole-peer version address | 4d |
| Journal frames and payload; purge and the head compare-and-set; arrival history after a purge | 4d |
| Release-mode cost rails | 4e |

## 11. Risks

- A rebuild costs O(store) per purge. That is the price of an honest `proven` on this engine. A
  host with a large store may batch purges; a cheaper method is a later question.
- SQLite has one write lock per file. A rebuild or a truncate blocks every peer of the store while
  it runs.
- A reader under constant writes can meet `snapshot-moved` on every try. The readers stop after a
  fixed number of tries. A long pass of held views under a second writing process can fail all of
  them, and that holds back a host's erasure report for those views. The trial measures it.
- Another process with an open statement can keep the log from truncating. The report then says
  `owed`. It must never say `proven`.
- A rolled-back transaction leaves its pages in the log until a truncate. Append therefore checks
  before it writes (§6), and the next truncate clears the rest.
- `better-sqlite3` is a native module. It stays optional, so a browser bundle never loads it.
