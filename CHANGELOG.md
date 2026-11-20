# Changelog

All notable changes to **`@bombadil/rhizomatic`**. This project is pre-1.0, so breaking changes may
land in **minor** bumps (see [CLAUDE.md → Releasing](CLAUDE.md#releasing-bombadilrhizomatic-to-npm)).
Format follows [Keep a Changelog](https://keepachangelog.com/); newest first.

## Unreleased

## 0.11.0-next.12 — 2026-11-20

Follow-ups from the reviews of slice 4 and from the first Loam trial on `0.11.0-next.11`
(TypeScript). Three changes can need action from a consumer: the `unknown-scheme` message has
new text, a busy open of a SQLite file refuses `store-unavailable` where it refused
`open-failed`, and a host that runs the SQLite subpath with no module location gets an error.
Step 4d adds more, listed under Breaking.

- The package root exports `withSnapshot(peer, body, retry?)`, with the types `SnapshotRetry`
  and `OnSnapshot`. It runs several reads on one snapshot and runs them all again on a new
  snapshot after `snapshot-moved`. It answers `{value, attempts}`. It starts at most
  `retry.snapshots` snapshots (default 4, at most 16). With `retry.withinMs` and
  `retry.clock` (the host's clock in ms) it starts no new snapshot after that many ms. It never
  retries `store-unavailable`. `StoreReactor.read` and `fetch`, `checkFresh`, a feed pull and a
  pass of held views now use it, with the same behavior as before. `SNAPSHOT_RETRIES` is still
  exported, with the same value. A `retry` with an own field of another name is refused
  `invalid-request`. A clock reading below the reading at the start of the call is refused
  `invalid-request`, as a reading that is not a finite number is. An error that the clock throws
  passes up unchanged, after the snapshot is released (§4.13 readings 127 to 129).
- The package root exports the store's id types: `Id`, `Entity`, `Head` and `ArrivalSeq`.
- **The hash covers exactly what the delta holds (issue #133).** One step in `delta/own.ts`
  reads a delta for the core and for the stores. Each holder (the delta, the claims, a pointer, a
  target, an entity reference, a delta reference) must be a plain object: its prototype is null
  or a realm's `Object.prototype`, as the store's `isPlainObject` already decided for a request. It reads each object's own keys once (`Reflect.ownKeys`) and each
  own enumerable field once, through its property descriptor. So a Proxy's `get` trap is never
  called, and its `getOwnPropertyDescriptor` trap is called once per key. A field that only
  `Object.prototype` holds and a field whose value is `undefined` are absent, at any key. It
  refuses an own schema key that is not enumerable, and another own key with a value that the
  schema does not name, text or Symbol, also a key of another target kind. It refuses a value of
  the wrong type and converts nothing: an entity id and a referenced delta id must be strings, and
  a target's `kind` must be one of the four kinds. `pointers` must pass `Array.isArray` (an Array
  subclass passes) and is read by index; a hole or an extra key on it refuses. It writes `+0` for
  `-0` and copies the bytes of a bytes target. The copy is made of ordinary plain objects that
  hold exactly the schema's fields. The returned claims have the step's key order, not the
  caller's. The step refuses with an `Error` that names the holder or the field, where many shapes
  threw a raw `TypeError` before. No delta of plain data changes its id: the 4272 claims objects of
  the shared vectors that parse keep their canonical bytes. This supersedes the entry below on an
  inherited `validUntil`: the core and both stores now refuse claims whose `validUntil` only a
  class or an `Object.create` prototype holds, and read one set on `Object.prototype` as absent.
- **A field set on `Object.prototype` reaches no hash and no decision of the core.** The core
  reads an optional field of a delta (`validUntil`, an entity or delta reference's `context`,
  `sig`) only when the object holds it as its own (`ownField`, `Object.hasOwn`). A required field
  is always own on a copy. The BLAKE3 and Ed25519 calls pass options with no prototype: both
  libraries read `context` (BLAKE3 also `key`) from their options, so a polluted
  `Object.prototype.context` changed every id and refused every signature. The core cannot guard
  a read that a caller makes: a caller that reads `delta.sig` on an unsigned delta that the core
  or a store returned reads `Object.prototype.sig` when that is set. Use `Object.hasOwn`.
- **Each exported function that decides on a caller's delta takes the step once, and then reads
  only its copy.** These are `computeId`, `canonicalBytes`, `canonicalHex`, `claimsToCbor`,
  `assertValidClaims`, `makeDelta`, `signClaims`, `verifyDelta`, `verifyCanonicalDelta`,
  `DeltaSet.add`, `Reactor.ingest`, `ingestBatch`, `ingestBundle`, `claimsToJson`,
  `parseClaims`, `looseEntryStatus`, `bundleEntryStatus`, `preflightTransfer`,
  `manifestMemberIds`, `relationSignature`, `relationSignatureCanonicalHex`, `evalPred`,
  `Peer.admits`, `admissionOf`, a store's `append`, the command and HView writers, the command
  readers (`commandFields`, `readConfiguration`, `readOperation`, `readRequestCommon`,
  `readRequestArguments`, `readOutcome`, `verifyCommandAppearance`, `readCommandResult`,
  `readCommandDefinition`), the materialization readers (`materializationFields`,
  `readMaterializationDescription`, `readMaterializationResult` for its outcome, request and
  evidence, `encodeMaterializationAppearance`) and `verifyPureDerivation`. `scopeSource` reads
  each member's delta into a copy of its own enumerable fields (`ownFields`), skips a repeated id
  unread, and then takes the step on that copy. So for the delta object itself, not its claims,
  it does not refuse a class instance or a field that is not enumerable: it reads store answers.
  `preflightTransfer` returns the copies it decided on, not `structuredClone` copies, so
  `Object.prototype` reaches no decision there; it answers an `invalid` unit as given, and does
  not read or copy it again. These still read a caller's object as given, because they decide no
  id and admit nothing: `packSet` (it reads a `DeltaSet`, which holds copies), `validityWindow`,
  `touching`, `scopeOver` and `passesSelection` (they read store answers), and the callbacks of
  `fork`, `federate`, `DeltaSet.filtered`, `latestByKey` and `subscribeRaw` (they receive set
  members). `readMaterializationResult` reads `capture` and `snapshot` of its context as given;
  it compares only their ids. `verifyCanonicalDelta` checks the format of the author and of the
  `sig` before it hashes the claims, as it did before this change, so an empty author is
  `invalid` and not a thrown `Error`. `verifyPureDerivation` answers `false` for an emitted delta
  whose claims are not valid; before, it threw.
- **A malformed wire entry is one rejected entry, and the pull goes on, in both witnesses.**
  `pullFromUrl` (TypeScript) and `pull_from_url` (Rust) reject a wire entry that is not
  `{claims, sig?}`: an unknown key, a `sig` that is not text, or claims that do not parse. Before,
  TypeScript threw on such an entry and dropped the rest of the offer, after it ingested the
  entries before it. Rust read a `sig` that is not text as absent, so it could accept a bundle
  member with `"sig": null` as an unsigned member, where TypeScript refused it. Now an offer of a
  good entry, a bad entry and a good entry gives accepted 2 and rejected 1 in both. A bundle
  whose `members` is not a list is one rejected entry too; before, both witnesses read it as no
  members and accepted the manifest alone. A top-level `bundles` or `loose` that is not a list
  is still read as empty.
- `Reactor.ingest`, `ingestBatch` and `ingestBundle` copy each delta once and hash it once. Before
  this change, a signed delta was copied three times. A signed delta whose claims are not valid
  is now rejected; before, `ingest` threw.
- A store reads a delta's `sig` and `validUntil` as own fields. Before, an append of an unsigned
  delta stored a `sig` that only `Object.prototype` held. The core's delta id does not change.
  The store computes the id over its own copy of the claims, which has no prototype, so a delta
  whose id hashes an inherited `validUntil` is refused `invalid-admission` (§4.13 reading 126).
- A refused open of a file that is not a whole SQLite store writes nothing. The open checks the
  schema names, the `format` row and the `retention` row before it sets the journal mode. Three
  exceptions remain: a leftover `-wal` file is checkpointed into the file at close, the `-shm`
  bytes change when another process holds the file, and a hot `-journal` file that a killed
  writer left is rolled back by the first read. A SQLite file with no schema object still opens
  as a new store (reading 126).
- An open of a SQLite file that another connection holds asks again while its first reads or its
  switch to WAL answer busy, until `busyTimeoutMs` has passed. After that it refuses
  `store-unavailable`. Before, it refused `open-failed` at once. Before each statement the open
  sets the engine's wait to the time left, so the whole open takes about `busyTimeoutMs` at most,
  also when a holder takes the lock again before each statement. A busy read of the `format` row
  refuses `store-unavailable` too, and an engine error there that is not busy refuses
  `open-failed` with its code. Only a file with no `meta` table is "not a rhizomatic store"; an
  index or a view named `meta` is not that table. A `meta` table of other columns refuses
  `open-failed` with `SQLITE_ERROR`. A trigger named `meta` is not that table either. The second
  read of the schema and of the `retention` row, in the open's write transaction, refuses by the
  same rule; before, any error there refused `store-unavailable` (reading 126).
- The SQLite subpath refuses to load when it cannot find its own module location. The released
  `0.11.0-next.11` imported `better-sqlite3` statically. So a host with no module location, such
  as an IIFE bundle run through `vm`, loaded it; that host now gets the location error. The
  subpath takes `import.meta.url` before `__filename`, and only when it is a `file:` URL. For
  another URL, and with neither, it gives the location error. An ES module bundle whose bundler
  writes an absolute path, not a URL, for `import.meta.url` loaded before and now gets the
  location error. A CommonJS bundle of that kind now loads the driver beside the bundle.
- The `unknown-scheme` message has new text: it says that the `sqlite` scheme is registered when
  the host imports `@bombadil/rhizomatic/store/sqlite`. A host that matches the old text must
  change its match. It is still one fixed message for every unrouted URL.
- Importing `@bombadil/rhizomatic/store/sqlite` without `better-sqlite3` fails with an error that
  names the package and `npm install better-sqlite3`, with Node's error as its `cause`. Any other
  error of the driver passes up unchanged. The subpath loads the driver with `require`, through
  `createRequire`. It loads in an ES module, through `require()`, and in an ES module or a
  CommonJS bundle that leaves `better-sqlite3` external.
- Tools: the command acceptance check pins the ignored Rust tests by name, and its report lists
  them. The release-mode step of the Rust witness job runs the two cost rails by their full names.
  The boundary scan treats `__filename` and `__dirname` as a module location, as `import.meta`.
- Tests: the many-process rails ask again on `store-unavailable`, and the crash rail no longer
  needs a fast disk. Rails bound the busy open from above at one and a half times
  `busyTimeoutMs`, also under a holder that takes the lock again before each statement. A rail
  holds that both stores refuse a delta whose id hashes an inherited `validUntil`. PR #93 added
  eight rails, not six as its text said. Rails now hold the answer "not a rhizomatic store", the
  wait before the open's second write transaction, the case of the `file:` scheme, and that no
  statement after the open sets `busy_timeout`.
- A snapshot of the memory store and of the SQLite store answers after appends as at its own
  revision (step 4d, §4.13 readings 130 to 132). Before, every append moved a snapshot, and a read
  of six calls under a writer in another process failed 147 of 200 times. The same measurement
  now has no failure in 3,200 runs. A
  purge that releases a holding of the peer still moves every older snapshot, from the commit of
  its delete. So do a new history and a peer row at a lower revision. A purge that releases
  nothing, another peer's purge and the trim of records do not. `Snapshot.lastSequence` is new:
  the peer's last arrival sequence at the snapshot's revision, fixed when the snapshot is read.
- The shared store vectors are tightened: a snapshot older than a purge that released a holding
  must refuse `snapshot-moved`. Five steps of `a-snapshot-across-a-purge` expect the refusal, not
  an answer. The Rust memory store refuses after any advance and conforms unchanged. The Rust
  tests change: the runner's rule table accepts the text "expected a refusal `snapshot-moved`,
  the store refused `invalid-request`" for its wrong store that refuses `targets`.
- The `snapshots` script gains a second peer that holds the first peer's later ids, and a
  `scope` with `arrivalAtMost` above an old snapshot's own bound. Both stores must keep the old
  snapshot's set, or refuse `snapshot-moved`. The Rust feed rules now expect a feed that mixes
  peers to fail this script.
- The package root exports `admissionOf(snapshot, deltas, {at, sender, nextHead})` and its type
  `AdmissionOptions` (§4.13 reading 133). It builds an `Admission` for a host with no journal:
  the snapshot's head as `expectedHead`, no frame, sequences from `snapshot.lastSequence + 1` in
  ascending id order, and the transfer ordinal `snapshot.lastTransfer + 1`. It calls no store.
  Every option is required. It checks every entry as the store does, a repeated id too, and
  refuses `invalid-request` for a malformed call or a forged delta. A host that guessed the next
  sequence as `count + 1` is refused after a purge; this helper is not.
- `createPeer(id, {erasure, appFormat})` takes an optional application format string, 1 to 256
  UTF-8 bytes, and `PeerStore.appFormat` reads it, or null (§4.13 reading 134). It is fixed at
  creation. The SQLite column checks the bound itself. The string lies outside erasure: put no
  personal data in it. After `close`, `appFormat` and `history` refuse `store-closed` on both
  stores; the memory store answered before.
- The store keeps each peer's last transfer ordinal (§4.13 reading 135). `Snapshot.lastTransfer`
  reads it, fixed when the snapshot is read. An append whose new entry's `transfer` does not pass
  it is refused `invalid-admission`. A head-only append and a purge keep it.
- The package root exports `StoreIntegrityError` and the types `IntegrityFault`,
  `IntegrityFaultKind` and `FsckReport` (§4.13 reading 136). A read that meets a stored row that
  is wrong throws `StoreIntegrityError` with one fault `{kind, peer, id, key, detail}`: claims
  that do not hash to their id, bytes that are not claims, an arrival record that is not one. The
  call answers nothing; other rows still read.
- `Exporter.fsck()` checks every row of the store and answers `{checked: {peers, holdings,
  deltas}, faults}` (§4.13 reading 137). It only reads, takes no write lock, and holds no
  transaction between its steps. On the SQLite store each step is one read transaction over a
  page of 256 rows, and a write by another process commits between steps. Every fault it reports
  was true at the moment of the step that found it. It finds a lost `target` or `reference` row
  (`index-missing`), which hides a delta from `targets` and `scope` without a failure (reading
  138). Measured: 50 ms at 2,000 deltas and 730 ms at 32,000.
- A read through `readAnchored`, `StoreReactor`, a pass of held views or `fetchScope` reports a
  malformed `scope` member from the store as the store fault `malformed-member`
  (`StoreFaultError`), not as `invalid-request` (§4.13 reading 21).
- A read never answers from a damaged row (§4.13 reading 136, follow-ups of PR #97). On the
  SQLite store, `arrivals` and `scope` check the whole arrival record: its five fields, its id and
  sequence against the holding, a `transfer` from 1 to the peer's last, a finite `at` and a
  non-empty `sender`. `get`, `scope` and an export check the form of a stored signature.
  `changes` checks that a change record holds two lists of ids. A holding whose `delta` row is
  gone fails `get`, `arrivals`, `targets`, `negators`, `scope` and an export with
  `claims-unreadable`; before, the SQLite store answered without it. The memory store throws the
  same fault in `arrivals`, `targets` and `negators` too. Each costs at most one index seek per
  answered id.
- `fsck` reports each of these faults with the same kind, peer, id and key as the read. It reads
  the content of every change record. A holding whose `delta` row is gone is reported with its
  peer and id. On a file with a damaged page it answers a report with one `engine` fault that
  names the engine's code, where it rejected `store-unavailable` before (reading 137).
- The memory store's `purge` of a held id with no stored claims throws `StoreIntegrityError`
  (`claims-unreadable`, with the peer and the id) before it removes anything, and the store is
  unchanged. Before, it threw a plain `Error`, and the ids sorted before that id were already
  removed, with no change record. The SQLite store's purge of a damaged id completes, as before.
  A memory-store purge that completes is proposed in its own pull request (reading 136).
- Tests: rails for every `fsck` check that had none, two repaired rails of the transfer ordinal,
  and a timeout of its own for the statement-list rail, which runs the whole store conformance.
- Follow-ups of PR #98. `fsck` reports every fault of a holding: a holding whose claims are
  wrong still gets the checks of its signature, its arrival record and its sequence (reading
  137). The memory store's test meter `StoreMeter.lookups` rises by one for each id that
  `arrivals`, `targets` and `negators` answer, because each looks up the id's row (reading 136).
  Reading 136 states when a damaged row is dropped before it is read, where the memory store
  differs, and that a lowered `max_transfer` has no purge remedy. Rails hold `fsck` on a change
  record past the first page and on a file whose header is not a database header.
- The holdings digest (§4.7.6; §4.13 readings 139 to 142). `Snapshot.root` names the exact set
  of ids the peer holds at the snapshot's revision, in any order of arrival: the version address
  of the set. `Snapshot.digest(prefix)` answers `{count, hash}` for the node of one hex prefix of
  a 16-way tree whose leaves hold at most 16 ids. `digest` is a strict call: it refuses
  `snapshot-moved` once the peer's held set differs from the snapshot's. Both TypeScript stores
  keep the tree and declare `digest: true`. An append and a purge change it in their own
  transaction, at O(depth) rows per changed id. On SQLite each leaf the update writes drops every digest
  row of the peer below it, so a damaged count or a lost row keeps no hash of a purged id below
  a rewritten leaf. `fsck` reports `digest-mismatch`, also for a stray row. A row that damage
  moved off a purged id's path is outside a `proven` claim (reading 142). The package root
  exports `digestOf`, `EMPTY_DIGEST`, `DigestNode`, `runDigestConformance`, `digestVectors` and
  `STORE_DIGEST_FORMAT`. New shared vectors: `vectors/store/digest.json` (README §12). The Rust
  witness checks the file's trees byte for byte, and takes the digest in its stores in step 4e.
- A purge of a peer of posture `proven` on the SQLite store tries its truncate again while
  another connection is in a checkpoint (§4.13 reading 143). SQLite answers that truncate busy
  at once, with `log = -1`, also during the automatic checkpoint of another process's commit.
  Before, the purge then answered `unproven` in 3 of 30 rounds beside one appending process.
  Now the truncate tries again every 5 ms until one `busyTimeoutMs` has passed, and the same
  measurement gave 30 of 30 `proven`. The rule of the proof does not change, and no report can
  be false because of the tries. A checkpoint that stays busy past the bound still gives
  `unproven`, with every file surface `owed`.
  One truncate can now take about two `busyTimeoutMs`, and the three truncates of one purge
  about six. Before, they took about three.
- The memory store's test meter counts the digest's path in `append` and `purge`. A rail bounds
  their lookups by a fixed cost per level of the tree for each changed id, with the levels
  counted from the ids.
- **Peer delete** (step 4d, §4.13 reading 144). `Store.deletePeer(id)` deletes a peer: its
  holdings, index entries, change records, purge debts, records of removals and digest, then the
  peer. Bytes that another peer holds stay. It answers a `DeleteReport`
  `{claim, boundary, surfaces, retains, released, keptByOtherPeers}`, in the purge report's
  words, with two counts and no ids. The SQLite store marks the peer first, releases its
  holdings in pages of 256, one write transaction each, removes the peer row last, and then
  rebuilds and decides the report as a purge does. A delete that dies leaves the mark, and the
  next `deletePeer` of the id finishes it. From the mark on, every call on the peer with a
  well-formed request refuses `peer-absent`, every snapshot refuses `snapshot-moved`, and `createPeer` of the id refuses
  `peer-exists` until the delete ends. A history is never issued again, so a peer created later under the id gets a
  new one. The memory store deletes all at once, and its claim is always `unproven`. The package
  root exports `DeleteReport`. Rust takes peer delete in step 4e.
- Every call is bound to one peer, not to its id. A delete works only on the peer row its first
  transaction read (`peer.origin`, the history `createPeer` issued), and removes that row only on
  the same terms. A purge's last transaction refuses `peer-absent` for a peer created again under
  the id. Every call of an old handle with a well-formed request refuses `peer-absent` after a
  delete, also after a `createPeer` of the id: a host gets a new handle. The same holds for a
  page of an export listing of one peer.
- Both stores check a call of a handle in one order: `store-closed`, then the form of the
  request, then the peer. The form is what the call checks before it reads the peer: the ids of
  `purge`, `from` and `to` of `changes`, and the fields, next head and frame of an `append` (not
  its entries). So a malformed request answers the same code on a live peer's handle and on a
  deleted peer's handle. The memory store checked the peer first before; a live peer's answers
  do not change.
- A delete of a `proven` peer can answer `unproven`, also with one deleter: when another
  connection's checkpoint stays busy past the truncate's bound (reading 143), when a reader
  holds the log, or when a lock wait passes `busyTimeoutMs`. A host does not repeat the call
  to get the proof: a second `deletePeer` of the id refuses `peer-absent` or deletes a new peer.
  It calls `Store.prove()` (below). Two deletes of one peer at once
  share the work. The other delete's report carries the proof only when it answered `proven`.
  When no wait passes `busyTimeoutMs`, at least one of the two answers `proven`.
- After the round-6 review of PR #101: the memory store's `append` copies and checks its
  entries before it reads the peer, as the SQLite store does. An accessor of an entry that
  deletes the peer now makes the append refuse `peer-absent`; before, the append wrote bytes
  that no peer held. Among several faults of one batch, a malformed entry now answers before a
  sequence that does not pass, as on the SQLite store; the code is `invalid-admission` in both
  cases. The `peer-deleting` fault and the `peer-exists` refusal of `createPeer` say that a
  delete "has not ended" and may still run. Reading 144 states what `close()` during a delete
  does, and a rail holds the `origin` compare of `fsck`.
- After the transaction that removes the peer row, a delete does not refuse
  `store-unavailable`. When its last transaction fails for any engine error (a lock, a full
  disk, an I/O error), it answers its counts with every file surface `owed` (`temp-files` is
  `unprovable` on a store of class `unprovable`). The host sees the cause at its next call. If
  the commit that removes the peer row fails in doubt, the call refuses, and a repeat answers
  `peer-absent` when that commit was durable.
- A refusal before the transaction that removes the peer row leaves the mark. For every engine
  error, its message says that the call did not finish, that a peer it marked stays marked for
  delete until a delete ends it, and that a repeat deletes the peer that has the id at that time.
  For a transient error (reading 105) it says that the store cannot serve the call now, and does
  not say "ask again". For any other error it first names the error and says that it is not a
  lock. A failed commit of the transaction that removes the peer row gives the same message. A
  repeat goes on from there while the mark is there; its
  counts cover only what the repeat released. If another delete of the peer ended and the id
  was created again, the repeat is a new call and deletes the new peer. A host that must not
  delete a new peer reads the peer before it repeats.
- On the memory store, a delete's `retains` names `purge-debt` also when another peer's
  purge debt names an id the deleted peer owed from an earlier purge. Before, it checked only
  the ids the delete released. Its rule is now the purge's. What a delete removes does not
  change.
- On the memory store, a delete refuses `count-mismatch` (key `holders`) for a held id whose row
  counts fewer than 1 holder, before it removes anything, by the purge's check. Before, it
  removed the peer and its report counted that id as kept by another peer, though none held it.
  What a delete removes does not grow.
- Known gap: on a damaged memory store, a row can count 1 or more holders but fewer than hold
  it. A delete of one holder then removes the row, and another holder's `get` fails
  `claims-unreadable`. The purge has the same gap. The delete report gives no sign of the loss:
  its values are the values of a correct delete. Only `fsck` shows it. Before the call, `fsck`
  reports the row (`count-mismatch`, key `holders`). After the call, it reports
  `claims-unreadable` and `index-stray` for the other peer. The SQLite store keeps no count and
  cannot reach it.
- `IntegrityFaultKind` gains `peer-deleting` in both witnesses; the Rust witness has it as data,
  with no producer until step 4e.
- What can now be deleted that could not be deleted before: every holding, index entry, change
  record, purge debt, record of a removal, digest row and peer row of one peer, and the bytes of
  each delta that no other peer holds, by one call. Never a peer created later under the same
  id. The exception: on a damaged memory store, where a row counts fewer holders than hold it,
  one call deletes bytes that another peer holds (the known gap above).
- **A proof for the whole store** (step 4d, §4.13 reading 145). `Store.prove()` asks for the
  proof of every removal that committed before its last transaction, and names no peer and no
  id. It answers a `ProofReport` `{claim, boundary, surfaces}` in the purge report's words. The
  SQLite store runs the rebuild of a purge and decides the report by the same rule, in one
  shared copy: every file surface is `absent` only when the log is empty at the lock, the file
  is clean, and no peer is marked by a delete that has not ended. It removes no row and ends no
  record of a removal: a record ends in its own peer's next ask. On a store of class
  `unprovable` it runs no rebuild and never says `proven`. The memory store answers `unproven`,
  as its purge does. Both refuse `store-closed` after close. The package root exports
  `ProofReport`. Rust takes `prove()` in step 4e. What can now be deleted that could not be
  deleted before: nothing.
- Step 4e starts. The Rust purge report gains `retains` (`Retained`, `RetainedSurface`), and
  the Rust refusal codes gain `StoreErrorCode::StoreUnavailable` (§4.13 readings 105 and 108).
  The Rust memory store names `change-feed`, and `purge-debt` while a purge debt of any peer
  names a target the peer released or owes. It counts the peers that owe each id, so it finds a
  debt without a walk of the peers. Every purge step of the shared store vectors now carries
  `expect.retains`, and both runners check it (README §3.4). The format names do not change.
  What a purge removes does not change.
- Step 4e: a Rust snapshot answers after appends (§4.13 readings 130 and 131).
  `Snapshot::last_sequence` is fixed at read. The Rust memory store records `removed_at`, the
  revision of the last purge that released a holding. A snapshot's five reads keep the holdings
  within its last sequence, and refuse `snapshot-moved` once such a purge follows the read. Every
  `read` step of `scripts.json` now carries `expect.lastSequence`, and both runners check it.
  Both runners now hold a memory reference store to an answer where a step allows
  `snapshot-moved` (README §3.7). The format names do not change. What a purge removes does not
  change.
- Step 4e: a new holding's transfer must pass the peer's last one, in Rust and in the shared
  vectors (§4.13 reading 135). `Snapshot::last_transfer` is fixed at read. The Rust memory store
  refuses `invalid-admission` for a new entry whose transfer is not above the peer's last one.
  A skipped entry, a head-only append and a purge keep the last transfer. Each peer has its own
  last transfer. The new script
  `a-transfer-must-pass-the-peers-last` holds the rule, and every `read` step carries
  `expect.lastTransfer`. The format names do not change. What a purge removes does not change.
- Step 4e: Rust `Store::create_peer` takes `&CreatePeerOptions`, as TypeScript's `createPeer`
  takes its options (decision D10 of the 4e plan). `CreatePeerOptions { erasure }` has one
  constructor, `new(erasure)`, and no `Default`: the caller always states the posture. Behavior
  does not change.
- Step 4e: a Rust peer carries an application format string (§4.13 reading 134).
  `CreatePeerOptions.app_format` takes 1 to 256 UTF-8 bytes (`APP_FORMAT_MAX_BYTES`); the
  Rust memory store refuses any other value `invalid-request` before `posture-refused` and
  `peer-exists`, and creates nothing. `PeerStore::app_format` reads it, `None` when none was
  given. `CreatePeerOptions::new(erasure).with_app_format(f)` gives it. It is fixed at creation.
  After `close`, the memory store's `history` and `app_format` refuse `store-closed`. The new
  script `a-peer-carries-an-application-format-string` holds the
  rules, and every `createPeer` step that creates and every `openPeer` step that opens carries
  `expect.appFormat`; both runners check it on every store. The script also gives a string
  with a NUL and a control character, kept byte for byte, and a number, refused. Each runner's
  rule table has a handle whose `appFormat` or `history` refuses on an open store. The script
  `a-transfer-must-pass-the-peers-last` gains two last steps: an append of a new id twice in one
  batch, whose first appearance does not pass the last transfer, is refused although its repeat
  would pass; a read then shows that the refusal changed nothing.
  The format names do not change. What a purge removes does not change.
- Step 4e: a Rust host with no journal builds an admission (§4.13 reading 133).
  `store_admission::admission_of(snapshot, deltas, AdmissionOptions {at, sender, next_head})`
  has the rules of TypeScript's `admissionOf`: the snapshot's head as `expected_head`, no frame,
  sequences from `last_sequence() + 1` in ascending id order, one entry per id with the first
  kept, the transfer `last_transfer() + 1`, and `at + 0`. It checks every entry, a repeat too, and
  refuses `invalid-request` as TypeScript does. It has no `transfer` option and calls no snapshot
  query. `AdmissionOptions` has no `Default`. Each runner's rule table now also has an opened
  handle whose `appFormat` refuses on an open store (finding N1 of the #110 review). What a purge
  removes does not change.
- Step 4e: Rust reads several times at one revision (§4.13 readings 127 to 129).
  `store_with_snapshot::with_snapshot(peer, body, &retry)` has the rules of TypeScript's
  `withSnapshot`. It answers `OnSnapshot {value, attempts}`. `SnapshotRetry {snapshots,
  within_ms, clock}` bounds it: 1 to 16 snapshots (default 4), and with `within_ms` and the
  host's `clock` no new snapshot after that many ms. A body's error type implements the new
  trait `StoreRefusal`; only the code `snapshot-moved` starts the body again. A clock reading
  that is not finite, or below the first, is refused `invalid-request`. A panic of the clock
  passes up after the snapshot is released. `StoreReactor::read` and `fetch`, `check_fresh`, a
  feed pull and a pass of held views now call it, with the same behavior as before.
  `SNAPSHOT_RETRIES` moves to `store_with_snapshot`. What a purge removes does not change.
- Step 4e, follow-ups of the `with_snapshot` review (#112). Rust `StoreError` no longer
  implements `StoreRefusal`: no body of `with_snapshot` could use it, because `StoreError` has no
  `From<StoreFault>`. The doc of `with_snapshot` names `FeedError` as the smallest body error.
  Both witnesses gain three tests: each earlier snapshot is released before the next body starts,
  a clock with no bound in time is never read, and the bound in time also ends the call on a
  refused `read()`. Two comments of the TypeScript `with-snapshot.ts` now say that a purge that
  releases a holding moves a snapshot and an append does not. A purge is not the only cause:
  reading 130 also names an absent peer row, another history and a lower revision. No behavior
  changes.
- Step 4e: a Rust read can fail with damage that is not a refusal (§4.13 reading 136). The new
  `store::StoreFailure` is `Refused(StoreError)` or `Integrity(IntegrityFault)`. The five
  `Snapshot` reads, `PeerStore::purge`, `PeerStore::changes` and every `Listing` answer it. The
  new `IntegrityFault {kind, peer, id, key, detail}` and `IntegrityFaultKind` (the kinds of
  TypeScript) are data only: no Rust store produces a fault yet. `FeedError` and
  `StoreReadError` gain an `Integrity` arm and `From<StoreFailure>`. An integrity fault has no
  refusal code, so `with_snapshot` and every reader pass it up after one run. No behavior
  changes. What a purge removes does not change.
- Step 4e: the Rust memory store reports damage and checks itself (§4.13 readings 136 and
  137). A held id whose stored claims are gone fails `get`, `arrivals`, `targets`, `negators`,
  `scope` and the export listings with `StoreFailure::Integrity`, kind `claims-unreadable`, with
  the peer and the id. Before, the read left the id out. `scope` and `get` read the row before
  the bound and the pushdown, as TypeScript does. A `purge` that names such an id fails with the
  same fault before it removes anything. Before, it removed the id and its holding. The new
  `Exporter::fsck()` answers `FsckReport {checked: FsckChecked {peers, holdings, deltas},
  faults}` with every kind of the TypeScript memory `fsck` except `digest-mismatch`, which comes
  with the digest. A purge that succeeds removes what it removed before. Tests damage the store
  only from top-level `#[cfg(test)]` items inside `memory_store.rs`, not from a module; `src` has
  no test hook. The Rust memory `fsck` has no peer `count-mismatch` check: the store keeps no
  peer counter, and a snapshot's count is the number of its holdings.
- Step 4e: a damaged store refuses a purge and a feed read that it answered falsely (§4.13
  reading 136), in both witnesses.
  - A memory `purge` that names a held id whose row counts fewer than 1 holder fails before it
    removes anything. The fault is `count-mismatch`, key `holders`, with the peer and the id.
    Before, TypeScript took the count to -1 and reported `held-by-other-peer` and `purge-debt`
    while no other peer held the row. A Rust debug build panicked after it removed the holding
    and its index entries; a release build wrapped the count.
  - `changes` fails with `feed-gap`, with the peer, when the kept records are not the revisions
    of the page it answers. This covers the memory store in both witnesses and the TypeScript
    SQLite store. Before, TypeScript answered `ok` without the lost record and with a `through`
    past it, so a follower passed that revision. Rust panicked.
  - The fault has `fsck`'s kind, key and detail. The `count-mismatch` detail of a purge says
    "this peer holds it", because a purge does not count the other holders.
  - The checks cost nothing on an undamaged store. The purge check reads the row that the purge
    reads already. The feed check compares the revision of each record that the page answers.
    The SQLite store counts the feed only to name a gap it found.
  - The SQLite store keeps no count of holders: its purge asks whether another holding exists.
    So the purge rule has no SQLite case.
  - Rust `fsck` reports `feed-gap` for a floor at `u64::MAX`. Before, a debug build panicked.
  - What can now be deleted that could not be deleted before: nothing. Each change refuses where
    the store answered or removed before.
- Step 4e: a Rust reader names a malformed `scope` member (§4.13 reading 21). `read_anchored`,
  `StoreReactor::read` and `fetch`, `fetch_scope`, `capture_scope` and a pass of held views
  report a member whose id does not recompute, or whose arrival record names another id, as the
  store fault `StoreFault::MalformedMember {revision, detail}`. Before, they refused
  `invalid-request`, as if the caller had erred. The fault has no refusal code, so no reader
  starts again on it. `ScopeSource::extend` still refuses `invalid-request` for a host that
  calls it directly. A held-views pass passes a store fault of its read up as
  `FeedError::Fault`, not as `FeedError::Read`. `StoreReadError` gains `From<FeedError>`. In
  both witnesses, the freshness runner fails a capture that meets a store fault with
  `the store broke <rule>: `, as it fails a check. No shared vector holds the rule: no
  conforming store answers a malformed member. A wrong-store row in each witness holds it for
  a capture and for a hold. What a purge removes does not change.
- Step 4e: the Rust memory store keeps the holdings digest (§4.13 readings 139 to 141). The new
  module `store_digest` has TypeScript's tree, hashes and update rule, `DigestNode`,
  `DIGEST_LEAF`, `empty_digest` and the reference `digest_of`. `Snapshot::root()` is fixed at
  read. `Snapshot::digest(prefix)` is strict: it refuses `snapshot-moved` after an append that
  adds an id and after a purge that releases one, and answers after a head-only append and a
  purge that releases nothing. An append and a purge move the digest along the path of each
  changed id, at most 24 lookups per level on average. The memory profile says `digest: true`.
  `fsck` reports `digest-mismatch` for a damaged, lost or stray node and for a damaged root,
  after the change records of each peer. `store_conformance::run_digest_conformance` runs
  `vectors/store/digest.json`; the memory store passes its 12 trees and 8 cases. Two new cases
  hold that each peer answers its own tree, and that a moved snapshot refuses a bad prefix as
  `invalid-request`. The runner table of each witness has a wrong store or a wrong document for
  each line of the digest runner. Two time rails in `store_cost.rs` hold an append and a purge
  of one id against the holdings. What a purge removes does not change.
- Follow-ups of the review of #120: TypeScript tests hold a malformed `scope` member through
  `StoreReactor.read`, `StoreReactor.fetch`, `captureScope`, a hold and a refresh; a Rust test
  holds each arm of `From<FeedError> for StoreReadError`.
- Follow-ups of PR #95: a Rust test pins the moved-snapshot text of `targets` to the script
  `a-snapshot-across-a-purge`, and reading 130 states that a restored peer row at a higher
  revision refuses when its `removed_at` is above the snapshot's revision.

### ⚠️ Breaking

- **A delta holder that is not a plain object is refused (issue #133).** The delta, the claims, a
  pointer, a target, an entity reference and a delta reference must each have a prototype that is
  null or a realm's `Object.prototype`. An object literal from another realm (`vm`) passes. A
  class instance and an object made with `Object.create(proto)` are refused, with an `Error` that
  names the holder, at every entry point and in both stores. Before, the core hashed and read
  fields that such a prototype held. A host must build these objects as object literals,
  `structuredClone` copies or `JSON.parse` results.
- **An own schema field that is not enumerable is refused.** A host that defines `validUntil`,
  `context`, `sig` or another schema field with `Object.defineProperty` and no
  `enumerable: true` gets an `Error` that names the field. Before, the core hashed it. A field that
  only `Object.prototype` holds is still absent.
- **An own field whose value is `undefined` is absent, at any key.** This is the JSON rule.
  `{kind: "primitive", value: 1, entity: undefined}` now has the id of `{kind: "primitive",
  value: 1}`; before this change it was refused. An unknown key with the value `undefined` is
  also absent, in the step and in `parseClaims`.
- **An own accessor of a delta is called once.** The step reads each field through its own
  property descriptor. A Proxy's `get` trap is never called. Its `getOwnPropertyDescriptor` trap is
  called once per key, and its `ownKeys` trap once per object. A Proxy that changes a value only
  in its `get` trap is read as its target.
- **An unknown own key of a delta is refused, at any level, in the core and in the store.** This
  covers a Symbol key, a key of another target kind and an extra key on the `pointers` array.
  `computeId`, `makeDelta` and the other core entry points throw; a store's `append` and
  `admissionOf` refuse `invalid-admission` and `invalid-request`. Before, the core ignored such a
  key, and a store committed the delta with the key dropped. A host that keeps its own fields on
  a delta object must keep them elsewhere. A store still drops an extra key of the arrival record
  and of the append entry: the hash does not cover them.
- **A delta value of the wrong type is refused, with no conversion.** An entity id or a
  referenced delta id that is a number, a boolean or a `String` object is refused, as is a
  `pointers` value that is not an array.
- **`makeDelta` and `signClaims` return a copy of the claims.** A caller that compares
  `delta.claims === claims`, or changes its claims object after the call to change the delta,
  must use the returned delta. `DeltaSet` and `Reactor` also hold their own copy: `get` and the
  reactor's reads answer that copy, not the caller's object. The copy has the step's key order,
  so `JSON.stringify(makeDelta(c).claims)` can differ from `JSON.stringify(c)`.
- **`preflightTransfer` returns the copies it decided on.** `GuardedUnit.unit` holds the step's
  copies for a unit that is not `invalid`, and the given unit itself for one that is `invalid`.
- **`evalPred`, `Peer.admits`, `manifestMemberIds`, `relationSignature` and the command and
  materialization readers throw, or fail as they fail for a wrong description, for a delta of the
  wrong shape.** Before, some of them read such a delta as it was.
- **SQLite format `rhizomatic-store-sqlite/7`.** The `peer` table gains `removed_at`,
  `max_transfer`, `root`, `state` and `origin`, `app_format` gains a check, the `digest` table is new, and
  a trigger counts the delete of a `peer` row in `residue.dirty`. Open refuses a file of format
  `/1` to `/6` with `open-failed`, names both formats and changes no byte. No migration ships:
  create a new file and append again.
- **`Store` has two new members, `deletePeer` and `prove`.** A host that builds its own `Store`
  object must give both.
- **`IntegrityFaultKind` has a new kind, `peer-deleting`.** `fsck` reports it for a peer that is
  marked when the scan lists it, and checks no other row of that peer. A peer that a delete marks
  later in the scan gets no fault from that scan: each later step of a peer reads the peer row in
  its own transaction and stops when the row is marked, absent or of another `origin`. A host
  that matches every kind must add it.
- **`Snapshot` has two more new members, `root` and `digest`.** A host that builds its own
  `Snapshot` object must pass them through. A store without the digest gives `root` null and
  refuses `digest` with `capability-absent`.
- **`IntegrityFaultKind` has a new kind, `digest-mismatch`.** A host that matches every kind
  must add it.
- **The memory store's profile says `digest: true`.** A host that required its absence, or
  compared the whole profile, must change its check.
- **The store checks transfer ordinals.** A new holding's `transfer` must pass the peer's last
  one. A host that gave every append the same transfer, such as 1, is refused
  `invalid-admission` at its second append. Number each transfer from `snapshot.lastTransfer + 1`.
- **Rust `Store::create_peer(id, erasure)` is now `create_peer(id, &options)`.** A Rust caller
  passes `&CreatePeerOptions::new(posture)`. A Rust `impl Store` takes the options and passes
  them on.
- **Rust `PeerStore` has a new method, `app_format`, and `history` returns
  `Result<&str, StoreError>`.** A Rust `impl PeerStore` must add `app_format` and pass both
  through. A Rust caller of `history` handles the `store-closed` refusal.
- **Rust `store_read::SNAPSHOT_RETRIES` is now `store_with_snapshot::SNAPSHOT_RETRIES`.** The
  value is still 3. `rhizomatic::SNAPSHOT_RETRIES` still names it. A Rust caller that used the
  module path changes the path.
- **Rust `StoreError` no longer implements `StoreRefusal`.** A Rust caller that called
  `store_code` on a `StoreError` reads its `code` field.
- **Rust reads, `purge`, `changes` and listings return `StoreFailure`, not `StoreError`.**
  This covers `Snapshot::get`, `arrivals`, `targets`, `negators` and `scope`,
  `PeerStore::purge` and `changes`, and the item of `Listing`. A Rust `impl Snapshot`,
  `impl PeerStore`, `impl Exporter` or `impl PeerExporter` changes these signatures, and wraps
  a refusal with `.into()`. A Rust caller matches `StoreFailure::Refused(e)` where it read `e`,
  and handles `StoreFailure::Integrity`.
- **Rust functions that read a snapshot or a listing return `StoreFailure`.** These are
  `store::collect_delta_set` and `store_fresh::raw_scope`. `store_read::fetch_scope`,
  `store_read::capture_scope` and `FreshnessReader::capture` return `FeedError` (below).
- **Rust `FeedError` and `StoreReadError` have a new arm, `Integrity(IntegrityFault)`.** A
  Rust `match` on either type handles it.
- **Rust `Exporter` has a new required method, `fsck`.** A Rust `impl Exporter` must give one:
  it delegates to the store it wraps, or answers a report with no fault.
- **A Rust memory-store read of a held id with no stored claims fails.** It answers
  `StoreFailure::Integrity`, where before it left the id out. A memory `purge` of such an id
  fails and removes nothing.
- **A memory `purge` of a held id whose row counts fewer than 1 holder fails.** It throws
  `StoreIntegrityError` (Rust: `StoreFailure::Integrity`) with `count-mismatch`, key `holders`,
  and removes nothing. A host restores the store and runs `fsck`.
- **`changes` over a lost change record fails with `feed-gap`.** This covers both memory stores
  and the TypeScript SQLite store. Before, it answered `ok` with fewer records. A follower's pull
  throws the fault and does not move. A host restores the store and runs `fsck`.
- **A host's own body error of `with_snapshot` needs `From<StoreFailure>`** when its body uses
  `?` on a snapshot call. Its `store_code` must answer `None` for an integrity fault. A fault
  that reads as `snapshot-moved` starts the body again.
- **`admissionOf` has no `transfer` option.** It numbers the transfer itself. Drop the field. The
  option shipped in no release.
- **A body no longer runs again after its own append.** A `withSnapshot` body, a held-views pass
  or a `StoreReactor.read` that appends to its own peer does not see the append and is not run
  again for it. A host that read its own write through an old snapshot must take a new one.
- **`Snapshot` has two new members, `lastSequence` and `lastTransfer`.** A host that builds its
  own `Snapshot` object, such as a wrapper over a store's snapshot, must pass them through.
- **`PeerStore` has a new member, `appFormat`.** A host that builds its own `PeerStore` object
  must pass it through.
- **A bad stored row throws `StoreIntegrityError`, not a plain `Error`.** A host that caught the
  plain `Error` of a read, or of a memory-store `purge`, must catch `StoreIntegrityError`. It is
  not a `StoreError`.
- **A malformed `scope` member is the store fault `malformed-member`.** A host that caught
  `invalid-request` from a read for it must catch `StoreFaultError`.
- **Rust `StoreFault` has a new variant, `MalformedMember`.** A Rust `match` on `StoreFault`
  handles it. A Rust host that matched `invalid-request` from a read for a malformed member
  matches `StoreReadError::Fault` or `FeedError::Fault`.
- **Rust `fetch_scope`, `capture_scope` and `FreshnessReader::capture` return `FeedError`.**
  They returned `StoreFailure`. A Rust `impl FreshnessReader` changes its signature. A caller
  that used `?` into its own error type needs `From<FeedError>`.
- **`Exporter` has a new member, `fsck`.** A host that builds its own `Exporter` must give one.
- **The memory store's `history` and `appFormat` refuse `store-closed` after `close`.** They
  answered before. A host that reads them after `close` must read them first.
- **A read of a damaged row throws `StoreIntegrityError` where it answered.** On the SQLite store
  this covers an arrival record of the wrong form, a signature of the wrong form, a holding whose
  `delta` row is gone, and a change record that is not two lists of ids (`changes` threw a plain
  `SyntaxError`). A host catches the error, purges the id or restores the file, and runs `fsck`.
- **The memory store's `fsck` names an arrival record that names another id with key
  `holding.arrival`, as the SQLite store does.** It used `arrival`. A host that matched the key
  must change its match.
- **Rust `Snapshot` has two new required methods, `root` and `digest`.** A Rust
  `impl Snapshot` that wraps a store's snapshot passes both through. One with no digest answers
  `root` `None` and refuses `digest` with `capability-absent`. `digest` returns
  `Result<DigestNode, StoreFailure>`, so a durable store can answer damage in its digest.
- **The Rust memory store's profile says `digest: true`.** A Rust host that required its
  absence, or compared the whole profile, must change its check.
- **The Rust memory `fsck` reports a new kind, `digest-mismatch`.** A host that expected no
  fault of that kind, or matched the list of faults, must allow it.

## 0.11.0-next.11 — 2026-11-16

Release D: the store (SPEC-18 proposal), slices 1 to 3 in TypeScript and Rust, and slice 4 steps
4a to 4c in TypeScript. A host opens a store by URL, creates peers with a declared erasure
posture, appends and purges, reads anchored programs in rounds on one snapshot, follows the
change feed, checks freshness and holds views. The memory store is the reference. A durable SQLite
store ships at the subpath `@bombadil/rhizomatic/store/sqlite`; many processes can write one file,
and on Linux a purge by a peer of posture `proven` proves erasure. The reactor and Loam do not
read through the store yet: Loam moves in slice 5. Elixir and Haskell remain Level 0.

### Known limits

- The SQLite store is TypeScript only. The Rust witness gets it in step 4e.
- The SQLite store's erasure class is `proven` on Linux only. It is `unprovable` on Windows,
  macOS and elsewhere, and a peer of posture `proven` is refused there.
- A log beside another name of the database file is outside an erasure report (§4.13 reading
  119). Examples: a hard link that was removed, a rename of the file without its log, a bind
  mount of the file. The store reads only the log beside the path the engine reports.
- The process memory of a store that keeps its data in files is outside the erasure claim
  (§4.7.2).
- A purge report covers bytes, not ids. `PurgeReport.retains` names the surfaces that may still
  hold a target's id.
- The SQLite store serves no journal, value index, stored view, derived index or digest yet.
- `better-sqlite3` is an optional peer dependency. Install it to import the subpath; the package
  root never loads it.

The store, slice 1 (SPEC-18 proposal): one store interface with declared capabilities, and the
memory reference store, in both witnesses against the same vectors. Nothing existing changes
behavior, and the reactor does not use the store yet.

The store, slice 2 (SPEC-18 proposal): the reactor reads through a store. An anchored read runs in
rounds on one snapshot, with a fetch cache and an evaluation memo; a term with no anchor runs only
as an explicit full-surface read through the exporter. The delta source is the one read type for
consumers. Every existing read vector family runs a second time through a memory store with the
same expected bytes. The memory `Reactor` keeps its whole-set methods, deprecated, until Loam moves
in slice 5. The store is read-only in slice 2: only test fixtures fill one. The TypeScript witness
is complete; the Rust witness follows the same documents.

The store, slice 3 (SPEC-18 proposal §4.6, §4.13 readings 1 to 102): revisions, the change feed,
freshness, a feed cursor and held views, in both witnesses against the same vectors.

The store, slice 4, step 4a (TypeScript): a SQLite store at `@bombadil/rhizomatic/store/sqlite`
(`openSqliteStore`, and `openStore("sqlite:///path")` once the subpath is imported). It passes
the four shared suites. Its erasure class is `unprovable` until step 4b. `better-sqlite3` is an
optional peer dependency. Three contract changes reach both stores: the refusal `store-unavailable`
(§4.13 reading 105), strings must be well-formed (reading 104), and -0 answers as +0
(reading 106). Rust follows in step 4e for the first and the third. A Rust string is well-formed
by its type, so the second needs no Rust work.

The store, slice 4, step 4b (TypeScript): the SQLite store proves erasure. A purge by a peer of
posture `proven` rebuilds the pages (`VACUUM`) and truncates the log, and the report says
`proven` only when that succeeded after the delete (§4.13 readings 107 to 116). The store's class
is `proven` on Linux only, and `unprovable` on Windows, macOS and elsewhere. Rust follows in step
4e.

- ⚠️ **`PurgeReport.retains`** is a new required field in both TypeScript stores: the surfaces that
  may still hold a target's id (decision S4-5). A store written outside this package adds it.
- Step 4b raised the SQLite format from `/1` to `/2`. Step 4c raised it again, to `/3` (below).
  This release writes and reads `/3` only.
- The SQLite store declares a sixth surface, `temp-files`. Two counters, kept by triggers, tell
  whether the file is clean (reading 117). Every file surface is `owed` while it is not: after a
  busy checkpoint, a failed rebuild, a crash, or a purge by a peer of posture `unproven`. A later
  purge of the same ids answers `removed` with the proof, until an append of the id ends the
  record (reading 118).
- A purge report speaks for the state at the last transaction of the call, which looks again at
  every target it released or answers from a record (reading 115). If that transaction cannot
  commit, the purge refuses `store-unavailable`; its delete may have committed (reading 105).
- `peer()` refuses `posture-refused` for a peer of posture `proven` on a store of another class.
- A purge that releases a holding another peer keeps still leaves the residue of its own rows,
  and the file is not clean until a rebuild (reading 114).
- The process memory of a store that keeps its data in files lies outside the erasure claim
  (Myk's ruling, 2026-11-15; §4.7.2).

The store, slice 4, step 4c (TypeScript): many processes can write one SQLite store, and a copy
or a restore of its file opens under new histories (§4.13 readings 120 to 125). Rust follows in
step 4e.

- The SQLite store's profile says `writers: "many-processes"`. A write that cannot take the lock
  within `busyTimeoutMs` refuses `store-unavailable` and writes nothing.
- ⚠️ **The SQLite format is `rhizomatic-store-sqlite/3`.** The file records its identity (device,
  file index, birth time). Open refuses a `/1` or `/2` file. No migration ships: make a new store.
- A new file identity at open gives every peer a new history, once. `openStore(url, {restored:
  true})` and `openSqliteStore(path, {restored: true})` do the same for a restore that writes over
  the same file. `OpenOptions.restored` is new, and a scheme's factory now gets it.
- The SQLite store's `PeerStore.history` reads the file at each ask, so a handle sees a new
  history that another process gave.
- An `openStore` call that refuses `capability-absent` changes nothing: the SQLite factory checks
  `requires` before it creates a file or mints (reading 126).
- Stores, reads, held views and `OrdinaryJournalPeer.open` read options and requests as own
  fields only. A field set on `Object.prototype` reads as absent (reading 126).

- **The change feed.** `PeerStore.changes(from, to?)` answers pages of records, one per revision
  advance, with the head and the ids added and removed; never bytes. A `from` below the
  retention floor, or above the current revision, answers `resync-required`. The memory store
  serves it, and the shared store vectors check the feed after every step of every script.
- **Freshness.** A capture records what one anchored read depended on: its peer's history and
  revision, its anchors, its raw scope as ids and the validity window of its operand.
  `touching` and `checkFresh(peer, capture, now)` decide from the feed whether a capture is
  current, in calls that depend only on the changes since it. A revision means something only in
  one history of one peer; a capture that crosses a process needs a minted history.
- **The feed cursor.** A follower takes `positionOf(snapshot)`, reads its state, and calls
  `followFeed(peer, position)`; each `pull()` reads one page with the bytes of every added id the
  peer still holds, and never the bytes of a purged delta (SPEC-4 ERRATA V6). A full mirror may
  start from a position and then an export. A follower's copies lie outside the store's erasure,
  and it replaces its mirror after `resync-required`. `StoreReactor.follow(from)` makes a cursor;
  a read and a fetched scope carry their `position`.
- **Held views.** A `StoreViews` holds, for one peer, a bounded set of views: each an anchored
  read of a registered program at a root, with its capture. `hold(name, root, now)` and
  `refresh(now)` each make one pass over the feed for the whole set. The pass finds the touched
  views through an inverted index and reads only those again, on its own snapshot; then the views
  whose window no longer holds `now`, and the views whose program's epoch changed (`setEpoch`).
  After a pass every held view equals a fresh read. There is no push: `refresh` answers the views
  read again, the views whose bytes changed (`changed`, with `before` null when the baseline was
  released) and the views evictions forgot (`evicted`). `ViewRead.from` is `"new"`, `"read"` or
  `"held"`. A host keeps its copies by one rule: copy a `"new"` answer, then only
  `changed[].after`, and stop at `evicted`. Only a pass that succeeds after a purge releases a held
  view's copy of the payload; a pass that throws applies nothing, and a host does not report
  erasure then.
- **Store faults.** A store that breaks its contract is an error value that names the broken
  rule, never an abort: `no-progress`, `past-the-bound`, `mismatched-answers`, `unasked-ids` and
  `revision-out-of-range` (a snapshot whose revision is not an integer from 0 to 2^53 − 1).
  `checkFresh`, a pull and a pass of held views find a fault before they judge or apply anything.
  TypeScript throws `StoreFaultError`; Rust returns `FeedError::Fault`.
- **Vectors.** `vectors/store/freshness.json`, `follow.json` and `views.json`, with
  `capture-defects.json` and `capture-interchange.json`; each witness's runner reports with the
  same fixed words (`vectors/store/README.md` §9 to §11).
- **Agreement of the witnesses.** Both witnesses refuse in one order, count reads the same way,
  and pass one table of each. An evaluator error in a pass passes up unchanged. `StoreReactor`
  starts a read again when `read()` itself answers `snapshot-moved`. A fourth cost rail holds the
  release of baselines to its records; the Rust wrong holders that scan every view run in release
  mode in CI.
- The slice 2 and slice 3 build plans are deleted. Their decisions are in the proposal's §12,
  and what later slices owe is in its §10.2.
- **The wrong-holder switches leave the public surface.** The TypeScript `StoreViews`
  constructor takes `(peer, options)` only. The rails build a wrong holder with
  `storeViewsWithQuirks`, which the package root does not export. In Rust, `ViewQuirk`,
  `StoreViews::with_quirk` and `StoreViewsReader::quirk` exist only with the feature
  `wrong-holders`, which only the tests turn on.
- `StoreReactor.read` and `fetch` refuse a snapshot whose revision is out of range with the store
  fault `revision-out-of-range` (SPEC-18 §4.13 reading 103).

### ⚠️ Breaking

The store is new in this release. The first ten items below break only a store, a factory or a
caller written against an unreleased build, with one exception: the own-fields item also reaches
`OrdinaryJournalPeer.open`, which `0.11.0-next.10` exported. The later items are from slices 1 to
3. Of those, the change to `DeltaSource.targets`, `DeltaSource.negators`, `Reactor.targets` and
`Reactor.negators` (the last item) reaches a consumer of `0.11.0-next.10`.

The first four items are in the TypeScript witness only in this release. "Both stores" there
means the two TypeScript stores, memory and SQLite. The Rust witness gets them in step 4e.

- ⚠️ **`PurgeReport.retains` is required.** A store written outside this package adds it to every
  purge report: the surfaces that may still hold a target's id (decision S4-5).
- ⚠️ **`store-unavailable` is a new refusal code** (§4.13 reading 105). A durable store gives it
  when a lock is held past the wait or the engine cannot read the file. A `switch` over
  `StoreErrorCode` adds it. A purge refused `store-unavailable` may have committed its delete:
  purge again.
- ⚠️ **Strings must be well-formed** (reading 104). A string with a lone surrogate is refused in
  both stores: `invalid-admission` in an append (`nextHead`, an arrival `sender`), and
  `invalid-request` in a read key, a purge id, a peer id and a minted history.
- ⚠️ **-0 answers as +0** (reading 106). Both stores answer every -0 in the claims and in an
  arrival `at` as +0, the value the id hashes. A caller that tells -0 from +0 stops doing so.
- ⚠️ **The SQLite format is `rhizomatic-store-sqlite/3`.** Open refuses a `/1` or `/2` file with
  `open-failed` and names both formats. No migration ships: make a new store.
- ⚠️ **The SQLite profile says `writers: "many-processes"`.** A write that cannot take the lock
  within `busyTimeoutMs` refuses `store-unavailable` and writes nothing.
- ⚠️ **`OpenOptions.restored` is new, and a `StoreFactory` gets it.** A factory with files to
  restore gives every peer a new history when it is `true`. A factory without files ignores it.
- ⚠️ **Options and requests are read as own fields only** (reading 126). A field set on
  `Object.prototype` reads as absent. A caller that passes options through a prototype passes a
  plain object. This reaches `OrdinaryJournalPeer.open`: `allowDegraded` and `requireExisting`
  given through a prototype now read as absent, so the open uses the defaults.
- ⚠️ **A factory checks `requires` before it changes a file** (reading 126). A registered factory
  that can create a file or mint histories refuses `capability-absent` first, with
  `missingRequirements(profile, options.requires ?? [])`. `openStore` still checks the opened
  profile again.
- ⚠️ **`storeViewsWithQuirks` is not exported from the package root.** It builds a wrong holder for
  the rails only, and no release exported it. Use `new StoreViews(peer, options)`.

- A store fault in `checkFresh` and `FeedCursor.pull` throws `StoreFaultError` (with `rule` and
  `values`), where the unreleased step-7 shape threw a plain `Error`. In Rust, `check_fresh`,
  `FeedCursor::pull`, `Follower::pull` and `FreshnessReader::check_fresh` return
  `Result<_, FeedError>` (`Refused(StoreError)` or `Fault(StoreFault)`), where the unreleased
  shape returned `StoreError` and panicked on a fault. This breaks only the unreleased step-7
  and step-8 API.

- A third argument to the TypeScript `StoreViews` constructor has no effect. In Rust,
  `StoreViews::with_quirk`, `ViewQuirk` and `StoreViewsReader::quirk` need the feature
  `wrong-holders`. Rust `StoreReactor::fetch` returns `Result<_, FeedError>`, and
  `StoreReadError` has the variant `Fault(StoreFault)`. This breaks only the unreleased slice 3
  API.
- `StoreFaultRule` has a fifth rule, `revision-out-of-range`. In Rust, `StoreFault` has the
  variant `RevisionOutOfRange { revision }`, and `FeedError` has `Read(String)`: the message of
  an error of a read in a pass of held views that is not a store refusal. It was
  `Refused(invalid-request)`. An exhaustive `match` adds the arms. This breaks only the unreleased
  slice 3 API.
- `StoreViews.register` refuses a name given twice before it reads the term. A name given twice
  with an unanchored term is now refused `invalid-request`, not `UnanchoredTermError`. The Rust
  `hold` refuses a program not registered before a `now` that is not finite.
- `StoreRead` and `FetchedScope` have a new required member, `position`. A consumer that builds
  either itself adds it.
- `makeCapture(snapshot, anchors, members, window)` takes a `Snapshot`, where the unreleased
  step-5 shape took any `{history, revision}`. It reads both from the live snapshot. A stored
  capture comes back only through `parseCapture`. This breaks only the unreleased step-5 API.
- `PeerStore` and `Snapshot` have a new required member, `history`: an opaque identity of the
  peer's revision history (SPEC-18 §4.6). A consumer that implements either adds it. A store
  gives a peer created anew, and a store restored to an earlier state, another value.
- `PeerStore` has a new required method, `changes(from, to?)`. A consumer that implements
  `PeerStore` adds it. A store with no feed declares `changeRetention: "none"` and refuses
  `changes` with `capability-absent`.
- The memory store's profile says `changeRetention: "unbounded"`, where it said `"none"`. The
  requirement `changes` now holds for it at open.
- `DeltaSource.targets` and `DeltaSource.negators` return `readonly string[]`: each id once,
  ascending by the UTF-8 bytes of the id (SPEC-17 §3). They returned `Iterable<string>` in any
  order. An implementer that returns a `Set`, or a list in arrival order, no longer conforms; sort
  with `compareUtf8`. `Reactor.targets` and `Reactor.negators` now return sorted arrays, where
  they returned the index sets in arrival order.

### Added

- Freshness (SPEC-18 §4.6): `Capture` (`history`, `revision`, `anchors`, `members`, `since`,
  `expiresAt`), `Touch`, `Freshness` and `ValidityWindow`. A capture is built only by
  `makeCapture`, or by `parseCapture`, which checks a stored capture and refuses lists out of
  UTF-8 order. `touching(capture, records, added)` answers the first change that can have
  altered a capture's raw scope, or null; it is exact without a selection and sound with one.
  `checkFresh(peer, capture, now)` answers `current`, `stale`, `not-yet`, `expired` or
  `resync-required`. `rawScope(snapshot, anchors)` computes a raw scope from ids alone, and
  `validityWindow(deltas, now)` a window.
- A read's validity window: `StoreRead.since` and `StoreRead.expiresAt`. The read answers the
  same at every time t with `since <= t < expiresAt` while nothing touches it. `capture: true`
  on a `StoreReadRequest` adds `StoreRead.capture`. `FetchedScope.validityAt(now)` answers the window
  of a fetched scope at any `now`. `captureScope(snapshot, entities, now, selection?)` takes a
  capture beside a fetched scope.
- `createMemoryStore({ mintHistory })`: a host's own mint for peer histories. The default,
  `memory:local:<n>` (`LOCAL_HISTORY_PREFIX`), is unique only within the process, and
  `parseCapture` refuses a capture that carries it. A minted history may not use that prefix,
  and may not repeat a history the store already issued: `createPeer` refuses both
  `invalid-request` and creates no peer. The mint takes the peer's id and runs after
  `peer-exists`.
- `parseCapture` refuses a `value` or `derived-index` anchor `capability-absent`, and a
  malformed anchor (an unknown kind included) `invalid-request`. It reads a revision written
  `1.0` as 1. `checkFresh` and `captureScope` refuse a `now` that is NaN or ±Infinity. In
  `checkFresh`, a feed page that makes no progress throws `StoreFaultError` (`no-progress`): it
  is a store fault, not a verdict. The freshness runner reports a store refusal in a check as
  `checkFresh refused with <code>`, and a store fault as `the store broke <rule>: …`.
- `StoreFaultError` and `StoreFaultRule`: a store that broke its contract, distinct from a
  refusal (`StoreError`). A host catches it with `instanceof`.
- `vectors/store/capture-defects.json`: captures with two defects, and the code and reason each
  witness's parser refuses them with (`vectors/store/README.md` §9.7).
- `vectors/store/capture-interchange.json`: one capture JSON from each witness; each witness
  parses both (`vectors/store/README.md` §9.8).
- `touching` and `checkFresh` answer only for a capture that `makeCapture` or `parseCapture`
  built, and refuse a copy, a cast object or a parsed value with `invalid-request`. Captures and
  their lists are frozen. `makeCapture` checks what `parseCapture` checks and does not sort.
- Store vectors: `freshness.json` (29 cases and 6 `touching` cases), with its runner
  `runFreshnessConformance` and `freshnessVectors()`. `rounds.json` gains `since`, `expiresAt`
  and `rawMembers` on every expected answer, and four reads at `now` 55. The script runner checks
  that every handle and snapshot of a peer reports its history and that peers differ, and asks
  below the floor at no more than 24 fixed points
  (`vectors/store/README.md` §1.3, §5.4, §9).
- SPEC-16 MR-10b allows a host to judge a scoped capture current by the feed check over its raw
  ids, its own epoch and the window, without recomputing the scoped revision (ERRATA E14).
- The change feed (SPEC-18 §4.6): `ChangeRecord` (`revision`, `head`, `added`, `removed`),
  `ChangePage` (`ok` with `records` and `through`, or `resync-required` with `current`) and
  `ChangeRetention`. A head-only commit writes a record with no ids. A purge records only the ids
  that leave the peer; a settled debt is in no record. `resync-required` answers a `from` below
  the retention floor or above the current revision. An explicit `to` below `from` is refused
  `invalid-request`.
- `createMemoryStore({ changeRetention: { revisions: n } })` keeps each peer's latest n records.
  `changePageSize: n` bounds a page, for tests. Finding `from` costs O(1), and dropping a
  record O(1) amortized.
- Store vectors: the requirement `changes`, the steps `mark` and `changes`, and `revisionAs` on
  `append` and `purge`. Four feed scripts. The runner checks each peer's feed after every step,
  and each witness runs the scripts again keeping two records and with pages of one record
  (`vectors/store/README.md` §3.9).
- The feed runner also checks each answer's exact keys (a record carries no bytes), changes every
  page it reads and asks again (a store owns what it returned), and probes the floor where
  revisions skip values. Stores whose revisions are two or three apart pass every vector.
- `negationWitnesses(source, now, suppression)` and `negationPredicate(source, now, suppression)`:
  the reactor's negation readers as free functions over any `DeltaSource`, such as a
  `scopeSource` of a fetched scope. A free reader keeps its memo for its whole life; build a new
  one when the source changes. The `Reactor` methods delegate to them and still follow ingests.
  An optional fourth argument `epoch: () => number` makes a free reader follow a source that
  changes: the reader looks at the value at every step of a walk and drops its memo when it
  moved. The `Reactor` methods pass the membership revision, so a suppression callback that
  ingests in the middle of a walk gets a fresh answer in the same call.
- A `DeltaSource` holds content-addressed deltas, and `targets` and `negators` list only ids it
  holds. A negation reader does not count a listed negator that `get` cannot return. A negation
  cycle, which only a source with forged ids can hold, fails loudly: TypeScript throws
  `negation cycle: the delta source holds deltas that are not content-addressed`, and Rust
  `NegationReader::witnesses` panics with the same message, where it returned an empty list
  that depended on the walk order. The TypeScript error `negation reader re-entered during
  suppression` now names only a suppression callback that calls its own reader.
- `Reactor.revision`: the membership counter. Equal values on one reactor mean equal membership.
  It rises by one for each `ingest`, `ingestBatch` or `ingestBundle` call that adds at least one
  member, including a call whose subscriber then throws, and at no other time. It is comparable
  only within one reactor object and is not a store `Revision`.
- `ScopeReads`: the input type of `scopeIds` and `evalAnchored`. It is a `DeltaSource` without the
  order rule, because scope computation sorts its own answer. Every `DeltaSource` is one.
- The store interface types: `Store`, `PeerStore`, `Snapshot`, `ScopeRequest`, `ScopeResult`,
  `Pushdown`, `Admission`, `AppendResult`, `PurgeReport`, `Revision`, `StoreProfile`, `Exporter`,
  and `StoreError` with its codes.
- `createMemoryStore()`, the reference store. Its profile reports only what slice 1 implements:
  entity anchors, arrival records, the three pushdown fields, erasure class `unprovable`, and from
  slice 3 the change feed. It serves no journal, value index, stored view, derived index or digest
  yet.
- Peers are created with a declared erasure posture (`createPeer(id, { erasure })`). A peer that
  promises proven erasure is refused on a store whose class is not `proven`.
- `openStore(url)` with the `memory:` scheme, and `registerStoreScheme(scheme, factory)`. Schemes
  match without regard to case. An error names a scheme only when it is registered, and never
  the URL.
- A store owns what it holds: it copies what it is given and what it returns, so no caller can
  change stored state through a reference. It never converts: a value that is not of its type (an
  `ArrayBuffer` where a `Uint8Array` payload belongs, a numeric string, a list that is not a
  list) is refused `invalid-admission` in `append` and `invalid-request` elsewhere.
- A purge report's `claim` is `proven`, `unproven` or `nothing-removed`, and covers only the
  targets that report removed.
- `scopeSource(members)`: a synchronous SPEC-17 delta source over a fetched scope.
- `runStoreConformance(factory)`: runs the shared store vectors against any store. `storeVectors()`
  returns those vectors.
- Shared vectors `vectors/store/scripts.json` and `vectors/store/scope.json`, with their format in
  `vectors/store/README.md`.

- Rust witness: the same interface as synchronous traits (`Store`, `PeerStore`, `Snapshot`,
  `Exporter`), `MemoryStore`, `StoreSchemes` and `open_store`, `scope_source`, and
  `run_store_conformance`. It passes every script and scope case of `vectors/store/`. A Rust host
  owns its scheme registry as a value; there is no process-wide table. A timed rail holds the
  build of a `ScopeSource` to linear scaling, and a table of wrong stores holds the Rust runner to
  each of its rules.

- Rust witness, slice 2: `NegationReader` is generic over any `DeltaSource` and lives in `set`,
  with the free functions `negation_reader`, `negation_witnesses` and `negation_predicate`.
  `Reactor::negation_reader` builds the same reader over the reactor; `reactor` still exports the
  type. No answer changes.
- Rust witness, slice 2: `Reactor::revision()`, the membership counter. It rises by one for each
  `ingest`, `ingest_batch` or `ingest_bundle` call that adds at least one member, and at no other
  time. It compares only within one reactor object; it is not a store revision.
- Slice 2, TypeScript: the store-backed read. `readAnchored(snapshot, request)` is an anchored
  read in rounds on one snapshot (SPEC-18 §4.4): one `scope` call per round for the anchors not
  yet fetched, a fetch cache, and the residual selection applied in memory. It answers the same
  bytes as `evalTerm` over everything the peer holds that the selection admits, and returns the
  scope, the members, the snapshot's revision and a report per round. It throws
  `UnanchoredTermError` for an unanchored term before any store call, and never scans.
  `fetchScope(snapshot, entities, selection?)` makes one fetch and returns a synchronous source
  over the exact scope. `StoreReactor.open(peerStore)` reads nothing; its `read` and `fetch` take
  a snapshot each, release it, and start again on `snapshot-moved` up to `SNAPSHOT_RETRIES`
  (three) times. `createFetchCache()` is the growing, verified set behind them. It owns what it
  holds: it checks and copies each member as `scopeSource` does, refuses a member whose arrival
  record is missing or names another id, adds nothing on a refused call, and hands out copies or
  frozen lists only. It has no `subset`; use `source(ids)`. Each `StoreRoundReport` carries the
  `attempt` and the snapshot `revision`. The memory `Reactor` is unchanged.
- Slice 2, TypeScript: the evaluation memo of the store-backed read (SPEC-18 §4.4, §4.12
  readings 21 to 26). `readAnchored` keeps one memo per snapshot. It stores a child evaluation
  under (schema reference, bindings object, root) only when every anchor the child's HView shows
  has been fetched, and a later round of the same read uses it without evaluating that child
  again. `evalTerm` takes an optional `ChildMemo` (`get`, `put`) as its last argument; the
  evaluator asks it before each `expand` child and `fix` body and decides nothing about what
  stays right. `evalTermWithHooks` carries a budget and a memo together; a budget turns the memo
  off. No answer changes. The round vectors gain `one-child-under-two-bindings` and
  `one-child-under-two-pinned-schemas`.
- Shared vectors `vectors/store/rounds.json`: reads in rounds, with the anchors of each round,
  interleaved appends, a purge between two rounds, and refusals. Format in `vectors/store/README.md` §5. Both witnesses run
  them.
- Slice 2, Rust: the store-backed read, in the new module `store_read` (reactor boundary).
  `read_anchored(&dyn Snapshot, ReadRequest)` reads in rounds on one snapshot, with a fetch cache
  (`FetchCache::On`) or without one (`FetchCache::Off`), and returns a `StoreRead`: the result, the
  scope, the members, the revision, a `RoundReport` per round and the snapshot count. The
  selection is a `Pushdown` and an optional host predicate over a delta and its arrival record.
  An unanchored term is refused `StoreReadError::Unanchored(reason)` before any store call.
  `fetch_scope(snapshot, entities, selection)` returns a `FetchedScope`: a `ScopeSource` over
  exactly S(entities), and the revision. `StoreReactor::open(peer)` reads nothing; `read` and
  `fetch` take a snapshot, release it on every path, and start again on `snapshot-moved` up to
  `SNAPSHOT_RETRIES` (three) times, each time with a new fetch cache. Any other refusal passes up
  after one attempt. Each `RoundReport` carries the `attempt` (from 1) and the snapshot
  `revision`, and its `round` counts from 1 on each snapshot. `ScopeSource::extend` refuses
  `InvalidRequest` for a member whose arrival record names another id, and a refused call adds
  nothing. `ScopeSource::restrict(ids)` is a source over some of its members, without a second
  hash.
- Slice 2, Rust: the evaluation memo of the store-backed read (SPEC-18 §4.4, §4.12 readings 21
  to 26). `ReadRequest.memo` is `EvalMemo::On` (the default) or `EvalMemo::Off`. With it on,
  `read_anchored` and each attempt of `StoreReactor::read` keep a new `FinalChildMemo`. It stores
  a child evaluation under (schema reference, bindings by their entries, root) only when every
  anchor the child's HView shows has been asked for, and a later round and the final `resolve`
  evaluation use it. `read_anchored_with_memo(snapshot, request, &mut dyn RoundMemo)` reads with
  a memo the caller owns. The evaluator hook is `eval::ChildMemo` (`get`, `put`) over a
  `ChildKey` and a `ChildValue`; `eval_term_at_with_memo` takes one. An evaluation budget turns
  the hook off. No answer, scope, member or round report changes.
- `resolvePrincipal`, `authorsForPrincipal` and `associatedKeys` take a `DeltaSource` as their
  first parameter, where they took a `Reactor`. A `Reactor` is a `DeltaSource`, so no call
  changes. Each read asks only for the scope of one entity, the principal root: over a
  `scopeSource` of `scope({ anchors: [root] })` it answers the same as over the whole set. A
  source fetched for another entity holds no evidence, and the read then answers as for an empty
  set. Rust witness: `resolve_principal`, `authors_for_principal` and `associated_keys` are
  generic over `S: DeltaSource + ?Sized`, so they take `&Reactor`, `&ScopeSource` or
  `&dyn DeltaSource`. No answer changes in either witness.
- The shared principal cases and history cases (`vectors/principal/evidence.json`) run a second
  time in each witness, over a scope fetched from a memory store peer.
- Slice 2, TypeScript: `readFullSurface(peerExporter, request)`, the explicit full-surface read of
  SPEC-18 §6.6. It lists the peer through its exporter, keeps what the selection admits, and
  evaluates any term, anchored or not, over that. Its `route` says `optimized: false` and how many
  deltas it listed and admitted. It takes `timestampAtMost` and `excludeIds` and refuses
  `invalid-request`, before it lists anything, for `arrivalAtMost` or `admits`: a listing carries
  no arrival record. A `StoreReactor` holds no exporter, so a serving path cannot reach it.
  `collectDeltaSet(peerExporter)` lists one peer into a `DeltaSet`, recomputing each id.
- Slice 2, TypeScript: `StoreRead.memoStored`, the number of child evaluations the read's memo
  held when it ended, and 0 with the memo off (SPEC-18 §4.12 reading 27). The memo changes no
  answer, so this is how a test sees whether a read used it.
- Slice 2, TypeScript: the existing read families run a second time through a memory store: every
  evaluation case of `vectors/l1-eval` (56 anchored ones through `readAnchored`, 56 unanchored
  ones through `readFullSurface`), the SPEC-17 read and scope cases through `readAnchored` and
  `fetchScope`, and the negation-witness cases of `vectors/l2-reactor/governed.json` over a
  fetched scope. Ingest, dispatch and journal families wait for slices 3 and 4.
- Slice 2, Rust: `read_full_surface(&dyn PeerExporter, FullSurfaceRequest)`, the explicit
  full-surface read (SPEC-18 §6.6, §4.12 reading 28). It lists the peer, keeps what the selection
  admits, and evaluates any term, anchored or not, with an optional root. Its
  `FullSurfaceRoute` says `optimized: false` and how many deltas it listed and admitted. It takes
  `timestamp_at_most` and `exclude_ids`, and refuses `InvalidRequest` for `arrival_at_most` or a
  host predicate before it lists anything. `StoreReactor` holds no exporter.
  `store::collect_delta_set(&dyn PeerExporter)` lists one peer into a `DeltaSet` and refuses
  `InvalidRequest` for a listed delta whose id does not recompute.
- Slice 2, Rust: `StoreRead.memo_stored`, the number of child evaluations the read's memo held
  when it ended, and 0 with the memo off (§4.12 reading 27). `RoundMemo` gains `stored()`, which
  a caller-owned memo now implements; `FinalChildMemo::stored` is that trait method.
- Slice 2, Rust: the existing read families run a second time through a memory store
  (`tests/store_read_families.rs`): every evaluation case of `vectors/l1-eval`, 56 anchored ones
  through `read_anchored` and 56 others through `read_full_surface`, with the count per family
  pinned; the SPEC-17 read and scope cases through `read_anchored` and `fetch_scope`; and the
  negation-witness cases of `governed.json` over a fetched scope. Every round case of
  `rounds.json` that has no `arrivalAtMost` also answers its bytes through `read_full_surface`.
- `Reactor.legacyHoldings()`: the whole held set, its arrival order and its digest, for the memory
  `Peer` of `federation` only. Not a read path. It is deprecated from the start (below).

### Deprecated

- `Reactor.snapshot()`, `Reactor.arrivalLog()`, `Reactor.digest()` and `Reactor.eval()`: each
  reads the whole set. Use `readAnchored` or `fetchScope` over a store snapshot,
  `Reactor.evalAnchored`, `readFullSurface` for a term with no anchor, `Snapshot.arrivals`, and
  `collectDeltaSet` for a whole listing. They stay until Loam moves to a store (slice 5). Nothing
  in the package calls them any more; a rail holds that.
- `Reactor.legacyHoldings()`: the same whole-set access, for the legacy in-memory `Peer` and its
  HTTP binding only. Use the store path: `PeerExporter.ids`, `collectDeltaSet` or `readAnchored`.
  The rail allows it in `federation/peer.ts` and `federation/http.ts` and nowhere else in the
  package. The rail judges an access by the type of its receiver, so a call through an interface
  that `Reactor` satisfies, a destructured method or a template-literal key also counts.
- Rust witness: `Reactor::snapshot`, `arrival_log`, `digest` and `eval` carry `#[deprecated]`,
  each note naming its replacement. A consumer that calls one gets a deprecation warning. The
  crate root carries `#![forbid(deprecated)]`, so no call in the crate compiles, however it is
  written. The legacy memory `Peer` and its HTTP pull read through `pub(crate)` accessors that
  nothing outside the crate can reach.

### Changed

- `DeltaSource` and `Suppression` are defined in the TypeScript `delta` package boundary.
  `resolve/anchored`, `reactor` and the package root still export them; no import needs to
  change. `ScopeSource` extends `DeltaSource`.
- `ArrivalRecord` is defined in the `storage` package boundary. `federation` and the package root
  still export it; no import needs to change. The Rust witness does the same, and its
  `DeltaSource` trait now lives in `set` (`anchored` still exports it).
- The Rust witness builds two integration test programs instead of 74. Each former test file is
  a module of `tests/witness.rs`; run one with `cargo test store_vectors::`, not `--test`.
  `tools/check-rust-test-programs.test.mjs` refuses a new test target (AGENTS.md, "Build size").

## 0.11.0-next.10 — 2026-10-14

Release C: reads cost their footprint, not the store (SPEC-17 proposal, slices R1, R1b and R2),
in TypeScript and Rust. An anchored program evaluates over S(E), the deltas that point at the
entities it reads, closed under negation. Warm views refresh over their own scope. A portable
batch read can capture one read's scope with the new `scoped-snapshot/1` profile, and the library
now produces the snapshot and basis bytes. Both witnesses pass the new shared vectors, and both
PRs (#72, #73) were independently reviewed. Elixir and Haskell remain Level 0.

### ⚠️ Breaking

- A scope array on the wire is ordered by UTF-8 bytes (SPEC-16 MR-10a). Hosts that build a scope
  by hand must sort with that order, or call `produceMaterializationSnapshot`, which does it.
- A TypeScript caller that counted strict signature checks will see fewer: successful checks are
  remembered per process (`verifyDelta`). Answers do not change.
- `scope-miss` is a new refusal code. A consumer that matches refusal codes exhaustively must add
  it.

### Known limits

- Unanchored programs (aliased roles, reflection without a pinned entity, `actsFor`, a const
  group without a pinned entity) still evaluate over the whole store.
- Maintained (M3) lifecycle reads still use full captures; only batch gather is scoped.
- A lowered (governed) program dispatches broadly unless its hook names its dependencies.
- The trust-state snapshot and the repudiation operation (SPEC-17 §9) are design notes, not code.

### Added

- Anchored reads (SPEC-17 proposal, slice R1), in TypeScript and Rust. A read now costs its
  footprint, not the store:
  - `DeltaSource` is the read side of a store: `get`, `targets(entity)` and `negators(id)`, each
    answered from an index. `Reactor` implements it with its existing target and negation indexes.
  - `scopeIds` / `scope_ids` builds S(E): every delta pointing at an entity in E, closed under its
    negation chains, with an optional per-delta selection (`admits`).
  - `anchorAnalysis` / `anchor_analysis` decides statically whether a gather is anchored, and names
    its constant anchors. Unanchored reasons: `aliased`, `reflection`, `const-group`, `acts-for`,
    `unknown-schema`, `result-sort`.
  - `evalAnchored` / `eval_anchored` (and `Reactor.evalAnchored` / `Reactor::eval_anchored`)
    evaluate an anchored gather over its discovered scope. The answer is byte-identical to a
    whole-set evaluation; the shared vectors and a property test in each witness check it.
  - `DeltaSet.subset` / `DeltaSet::subset` carries already-verified members without hashing them
    again.
- Shared vectors `vectors/l1-eval/eval-anchored.json`: scope closure, anchor analysis and anchored
  reads.

- Warm views refresh over their own scope (slice R1b), in TypeScript and Rust. A materialization
  root re-evaluates with anchored evaluation, and its support set for dispatch is that scope. An
  ingest that touches no root's scope refreshes nothing, and a refresh no longer reads the whole
  store. `Reactor.register` takes an optional `lowerDeps` (Rust: `register_at_lowered_with_deps`):
  the entities a host's lowering reads. With it, a lowered anchored program dispatches by scope;
  without it, it dispatches broadly as before.

### Changed

- Materialization dispatch uses `anchorAnalysis` instead of the V5 analyzer (SPEC-4 ERRATA V5,
  amended). It is more precise: an author-keyed select under a root `group` and `intersect` /
  `difference` no longer force broad dispatch. It is also stricter where V5 was unsound: an
  `aliased` term now dispatches broadly, so a new alias mapping refreshes it (SPEC-9). Answers do
  not change; only the number of refreshes does.

- Scoped sources for batch gather (slice R2, SPEC-16 §4a), in TypeScript and Rust:
  - A binding may select `scoped-snapshot/1`. Its captures carry a `scope`, which joins the
    revision; the operands must be exactly S(scope), checked from the snapshot itself.
  - `checkCurrent` receives the scope (Rust: `check_current_scoped`, defaulted).
  - A scoped gather refuses an unanchored program (`unsupported-operation`) and a scope that misses
    the root, a constant anchor or an expanded child (`scope-miss`, a new refusal code).
  - Lifecycle verbs refuse a scoped binding (`unsupported-operation`).
  - `produceMaterializationSnapshot` / `produce_materialization_snapshot` build snapshot and basis
    bytes from a host's selection. Hosts no longer assemble MR-10 documents by hand.
  - TypeScript keeps a bounded memo of verified appearances, so one read stops checking every
    signature four times.
  - Shared vectors `vectors/materialization/scoped-source.json` (codec) and
    `vectors/materialization/scoped-commands.json` (six endpoint deliveries; Rust reproduces every
    TypeScript outcome byte for byte).

### Fixed

- The snapshot and basis decoders checked each component's operand ids against its raw ids with
  a nested scan, quadratic in the inventory. They use a set.
- A scope array is ordered by UTF-8 bytes in both witnesses (SPEC-16 MR-10a). TypeScript compared
  entity ids by UTF-16 code units, so a scope holding U+E000 and U+10000 was accepted by one
  witness and refused by the other. `compareUtf8` is the shared comparator; both producers write
  a scope as a set in that order. New vectors: `scoped_supplementary_order` and
  `utf16_ordered_scope`.
- TypeScript checked the same signature again at each layer a delta crossed: at ingest, in the
  snapshot producer, in each HView envelope decode. `verifyDelta` now remembers successful strict
  checks, keyed by id and signature (bounded at 65536). It still recomputes the id each time, so
  other claims never reuse a remembered success. A 400-delta portable read went from 11.8 s to
  4.0 s in the Loam trial.
- The TypeScript CBOR encoder wrote into a JavaScript number array, one byte at a time. It writes
  into a growing byte buffer, and writes ASCII text without `TextEncoder`. The bytes do not change;
  every shared vector still matches.

`evalTerm`, `Reactor.eval` and the full-source materialization profile still scan their whole
input; callers move to anchored reads and scoped captures explicitly.

## 0.11.0-next.9 — 2026-10-14

Release B: the maintained materialization lifecycle (SPEC-16 M3) and its cumulative acceptance
(M4) in TypeScript and Rust. Install, replace-source, advance-time, retire, read and restore run
over an explicit control store, with fault points, support erasure and configuration rotation.
All M0–M4 cases are executed in both witnesses and independently reviewed. Elixir and Haskell
remain Level 0. A release-A configuration (gather and resolve only) still boots without a control
store; a configuration that installs a lifecycle verb needs one (`controlStore` /
`boot_maintained`). Loam's selected batch-read trial (M5) follows against this release.

### Known limits

- No performance promise. The M4 baseline measured a 4,096-appearance install at about 24 s in
  TypeScript and 1 s in Rust, with whole-process peak memory near 1 GiB and 136 MiB. The nested
  32-plant Bed fixture installs in about 1.2 s and 0.1 s. See `contracts/materialization/M4.md`.
- Journal-backed published Plant and Bed counts are not measured yet; they are owed at M5.
- Source and control writes are not atomic with each other, and evidence is not a proof of
  execution.

### Fixed

- Anchor analysis (both witnesses) kept the ambient root as the string `"root"`, so a constant or
  bound hole naming an entity called `root` dropped out of the static anchors. An anchored read,
  and a warm view refreshed by one, then answered empty where whole evaluation had data. The
  ambient root is now a tagged value. New `eval-anchored` vectors cover a const group, an `inView`
  and a bound hole naming `root`, and both witnesses check a warm view against it.
- Materialization gather in TypeScript returns a signed `resource-limit` refusal when a produced
  definition appearance exceeds `artifactBytes`; it previously threw with no outcome while Rust
  refused. Pinned by the shared `definition_appearance_bytes_over` vector.
- Both witnesses check the complete Basis field grammar at stage 4, before any stage-7 definition
  category (SPEC-16 ERRATA E1). A Basis with an empty closure and a malformed pin now refuses
  `invalid-evidence` in both; TypeScript previously answered `definition-closure`.

### Added

- SPEC-16 M4 slice M4a: a cumulative gate over the M1, M2 and M3 bundles of one CI run checks
  artifact integrity, three replayed mixed plans and both fixed routes per required scenario,
  shared goldens, the capability gate against each real manifest, a common wrong answer the
  oracle must refuse, and exact replay against a mutated bundle. The M3 runner gains
  control-edge corruption probes in both directions, a tower-isolation probe and the
  unsupported-stage and missing-evidence negatives. Seven of the nine M4 cases are executed.
- SPEC-16 M4 slice M4b: a lifecycle resource baseline. For the fixed nested Bed fixture (32
  plants, four buckets each, two expansion levels) and at 0, 128, 1024, 4096 and 4097 selected
  source appearances, both witnesses run install, equal-size replacement, fresh restore and fresh
  read, each step from a cold boot over its stored image. The report records byte lengths, wall
  time, strict signature verifications, source checks and peak memory. Byte lengths agree between
  the witnesses; 4097 refuses at install before any source check. No thresholds are set. Eight of
  the nine M4 cases are executed.
- SPEC-16 M4 review round 1: the cumulative gate now requires each milestone's report and coverage
  to name every required case, variant, tower, refusal branch and fault branch; pins every bundle
  to one clean source (the CI checkout in CI); checks every executed record against its plan role
  and witness; and requires exact measurement phase sequences. M1 crossings record their writer
  and reader, and M3 records name the plan role whose witness ran them. Each new check has a
  refusal probe. The independent re-review of this head found no remaining findings, so all nine
  M4 cases are executed.
- SPEC-16 M3 groundwork in TypeScript and Rust: the reactor-owned `rhizomatic.materialization-control/1`
  image codec and pure transition planner, the storage-owned control store seam, a federation
  facade, and the `registration/1`, `state/1` and `control-image/1` descriptions plus the six
  lifecycle request grammars. Shared vectors: `vectors/materialization/control-image.json` and new
  description oracles.
- SPEC-16 M3 lifecycle verbs in both endpoints: install, replace-source, advance-time, retire,
  read and restore over an explicitly initialized control store, with stage-5 control
  classification, prospective receiver-signed transitions, bounded images and the four CAS
  outcomes. Release B boots need the store (`controlStore` / `boot_maintained`). The shared
  schedule `vectors/materialization/lifecycle.json` pins twenty steps, each from an explicit
  control image, with signed outcomes and images equal in both witnesses. ERRATA E3 records three
  small decisions.
- SPEC-16 MR-20 readback for the six maintained bodies and both indeterminate bodies
  (`readMaterializationResult` / `read_materialization_result`): strict root-result envelopes
  and Views, the nine M3 refusal codes, and contextual linkage to the request and the named
  control image (ERRATA E4). The preflight projection covers install. `contracts/materialization/M3-CASES.json`
  allocates the M3 cases and `tools/check-materialization-m3-acceptance.mjs` checks both
  witnesses' receipts in CI.
- SPEC-16 M3 durable fixture hosts in both witnesses with a shared file layout, the seven MR-18
  fault points, and `tools/check-materialization-m3-towers.mjs`: three tower scenarios in both
  fixed directions and three seeded mixed plans each with exact replay, plus eight fault
  schedules.
- SPEC-16 M3 slice C2: the shared schedule grew to 47 steps with two more sources, an authority
  change, an equal-count replacement, a physical removal, a second descriptor on one source, an
  expiring descriptor retired without a grant, a later-definition descriptor after retirement,
  and a read after authority expiry. Steps may name a source, a receive time or no grant. Every
  step checks the image holds no snapshot payload. The towers add the two-writers race.
  Validity boundaries, source races, rotation, shared-basis limits and support erasure follow.
- Fixes from the first independent review of M3 (ERRATA E5): roots and aliases are typed by
  role, text sets and root results order by UTF-8 bytes in TypeScript, the five control verbs
  require an administrator at stage 3, the roots limit binds at install, on stored descriptors
  and in readback, restore checks each stored capture's commitments, expected-source compares
  after the other stage-6 checks, and readback links a mutating request to its transition and
  its serving time. Thirteen shared steps and hostile-context tests in both witnesses pin them.
- Fixes from the second independent review of M3 (ERRATA E6): readback compares root partitions
  element by element, restore validates the stored descriptor's pins and closure against the
  retained acts, the stored capture basis is decoded as a complete MR-10 basis
  (`decodeMaterializationCaptureBasis` / `decode_materialization_capture_basis`), and readback
  links an install or replacement request to the capture the image selected. Two shared steps
  and hostile-context tests in both witnesses pin them.
- Fixes from the third independent review of M3 (ERRATA E7): the capture basis decoder enforces
  the snapshot's inventory rules and recomputes both digests, and restore requires the stored
  capture's signed claims to name the observation its basis carries. Three shared steps pin
  them.
- SPEC-16 M3 slice C3a: the shared schedule grew to 89 steps with the validity boundaries over a
  bounded fact, the expired-descriptor read and advance, two-root and 64-root programs under
  lowered per-envelope counters, aggregate body and image byte overflows refused before CAS,
  four more hostile images, the unknown-snapshot-key priority pair, and retire and restore
  beside an expired unrelated binding. ERRATA E8 records the readings. Twenty-four of the
  thirty-three M3 cases are executed.
- SPEC-16 M3 slice C3b: both fixture hosts gain three fault points on the current-source
  check and a source-unavailable flag; the tower runner boots every stage from the step's own
  fixture and runs six tower scenarios and thirteen fault schedules, adding the source races
  around the final check, the rebuild after a source replacement, restore with an unavailable
  provider, the equal-count replacement and the 64-root program. The post-check race moves
  the provider's durable source state in the host directory after the final check and before
  CAS dispatch, and a later process over that directory sees the moved source. ERRATA E9
  records the readings. Twenty-eight of the thirty-three M3 cases are executed.
- SPEC-16 M3 slice C3c1: every shared step asserts the stored image carries no operand bytes,
  using a marker fact; the hosts retain ordinary deltas in a reactor before booting and the
  empty image stays empty. Two tower scenarios and one fault schedule pin them. ERRATA E10
  records the readings. Thirty of the thirty-three M3 cases and all six variants are executed.
- SPEC-16 M3 slice C3c2: a step may name refused acts; the schedule's grant refuses a current
  check whose required support names one, retire of the blocked registrations completes, and the
  shared marker definitions leave the image and the host directory with their last active
  consumer. Both hosts keep the refused acts as durable facts and every superseded image as a
  historical copy; settlement purges the copies once no active entry reaches a refused act, and a
  reopen settles debt a crash left. One tower scenario and eight fault schedules pin erasure, its
  targeted and between-checks variants, and its crash schedule through settlement. ERRATA E11
  records the readings. Thirty-two of the thirty-three M3 cases are executed.
- SPEC-16 M3 slice C3c3: the 64-entry lifetime refuses the 65th distinct install with no source
  check and no write, and retirement frees no slot; a new receiver-signed configuration starts an
  empty scope with new installs, configuration-mismatch for requests of the other configuration,
  and retirements kept in the old scope. Both fixture hosts select a configuration by one renamed
  file and refuse an explicit attempt to serve by the signed request's verb, and the rotation
  crossing crashes on either side of activation. A state/1 act carries a required
  `configuration` ref; an image whose state act names another configuration is `invalid-control`.
  ERRATA E12 records the readings. All thirty-three M3 cases are executed.

### Changed

- Batch gather and contextual readback validate capture metadata from one freshly decoded source
  snapshot per invocation, preserving canonical outputs, refusal priority and fresh source checks.


## 0.11.0-next.8 — 2026-10-06

Release A: portable batch gather/resolve and lossless evidence in TypeScript and Rust.
Elixir and Haskell remain Level 0; maintained lifecycle and Loam adoption follow separately.

### ⚠️ Breaking

- TS schema props, fix bindings and CBOR JSON bridges now preserve legal `__proto__` keys as own
  properties. Native inputs that previously lost this key can produce different canonical hashes.
  If you computed pins from affected native inputs, recompute them and explicitly republish affected
  definitions/update their references. Existing signed acts are not rewritten; unaffected hashes
  and existing profile1 behavior remain unchanged.

### Added

- TS/Rust lossless HView envelope and full reading appearance codecs (SPEC-16 M1), with strict
  canonical decoding, original validity/signatures, reading metadata, finite semantic AST budgets,
  shared independent golden fixtures and serialized mixed codec towers.
- TS/Rust portable batch gather and pure evidence resolve (SPEC-16 M2), explicit source grants,
  three-time context, supplied-input preflight and strict contextual result readback. Shared
  independent signed goldens, mixed command crossings/replay and resource measurements accompany
  the typed APIs. Maintained lifecycle and Loam integration remain unimplemented.
- Materialization-profile evaluation bounds each logical HView operator result, including discarded
  intermediates, without changing native default/profile1 evaluation. Input preflight makes no
  permission, output-capacity or execution guarantee. Large-source latency and whole-process memory
  limits are recorded in contracts/materialization/M2.md for independent release review.

### Fixed

- Materialization delivery validates canonical byte sizes before decoded/canonical payload copies,
  preserving malformed-appearance priority. New invoke/preflight capture one JSON-debug representation;
  transparent Proxy fields may now pass instead of an incidental structuredClone refusal. Getters
  run as host code outside a sandbox; existing Delta/profile1/M1 behavior is unchanged.
- HView evidence codecs verify each distinct full signed appearance once per invocation, including
  decode's final re-encode. Repeated entries preserve validation, canonical bytes and refusal codes.

### Known limits

- This prerelease does not promise low-latency serving at its capacity ceiling. Independent review
  measured TS gather at about 26 seconds for 4,096 appearances and whole-fixture-process peak RSS
  around 1.17 GiB, including retained fixtures/results/runtime. Repeated snapshot verification is
  a tracked optimization; no per-phase memory attribution or total evaluator work quota is claimed.
  See `contracts/materialization/M2.md` for scope and reproducible measurement boundaries.

## 0.11.0-next.7 — 2026-10-01

### Added

- TS command endpoints accept an explicit author/sign capability. A pure Claims constructor supports hosts that keep seeds private. Seed convenience APIs remain compatible; altered response testimony fails visibly after any durable effect.

- TS/Rust signed description codecs, strict canonical View readback, explicit receiver configuration and durable retain/evaluate endpoints with attributed outcomes.
- Coherent admitted/catalog sources, exact foreign definition closure and pins, explicit time/bindings and both principal suppression profiles; retained descriptions stay ordinary inert data.
- Shared golden vectors, real crash/reopen and uncertain-commit tests, both mixed directions, seeded four-stage towers and exact replay. CI records 77 technical cases and leaves the independent exact-commit review gate explicit.
- Public API and owner inventories, direct dependency/ambient-observation checks and native bootstrap pin equality. Elixir/Haskell remain at Level 0; full HView, reactor lifecycle and derivation portability remain deferred.

### Fixed

- In individual journal admission, an erasure aimed at an already effective order or verified
  co-offered order candidate now receives a typed `erasure-ineligible` outcome. Co-offered order
  identity survives later candidate filtering; erasure-shaped testimony offered or held as
  ordinary data stays erasable, and a misclassified plain delta does not block another order.
  Unrelated ordinary candidates in the transfer can still commit. The co-offered refusal reason
  remains `erasure targets an order`.

## 0.11.0-next.6 — 2026-09-29

### ⚠️ Breaking

- Rust candidate guards now return `GuardDecision` so a rejection can carry its reason.
- TypeScript canonical CBOR encoding, `computeId`, and `signClaims` now reject text containing
  unpaired UTF-16 surrogates instead of replacing them with U+FFFD. Callers must supply valid
  Unicode text or replace malformed code units before computing an id or signature.
- The new peer journal opens only a fresh empty store or an existing journal under the same
  governing key. A store with rows but no journal is refused at boot; create a fresh peer store
  rather than replaying legacy rows. Existing-pool handoff is outside this greenfield release.

### Added

- The step-6 journal now offers a writable degraded open that names damaged or missing admitted
  rows and excludes them from its serving projection. A purge cannot report `removed` for a
  previously arrived target until a v2 rebase after its refusal excludes its payload, and erasure-aware rebase stays
  available after purge settlement to bound replay work. Shared TypeScript and Rust vectors and
  store tests cover these contracts.
- Step-6 admission building blocks in both TypeScript and Rust: shared arrival testimony vectors,
  signed loose and bundle entry checks, candidate-local guard preflight against the pre-transfer
  admitted set, conservative erasure authority and target-budget filtering, set-level ordinary
  quota selection, and atomic in-memory Reactor batch ingestion.
  An internal typed signed-loose ordinary transfer path now composes those stages with the
  durable image and pins outcomes and bytes in shared vectors.
  A public typed single-peer API now opens a fresh canonical peer image and commits signed loose
  ordinary deltas through an atomic image-and-row storage seam. It supports atomic local append,
  per-candidate receive, refusal reasons, explicit local/authenticated/unattributed origins, and
  fail-closed detection of rows without an image. Shared vectors pin canonical empty and admitted
  image bytes in both witnesses. The pure API remains browser-bundleable; the single-writer file
  adapter is available from the Node-only `@bombadil/rhizomatic/node` subpath. This whole-image
  surface handles ordinary deltas only; the journal facade below handles effective erasures.
  New peers start on empty journals; stores with rows but no journal are refused under the
  greenfield contract.
  The TypeScript backend-agnostic facade reuses a verified exact image on a long-lived store
  object; it rechecks content ids but does not repeat Ed25519 checks for unchanged held deltas.
  A changed image is decoded and verified before use. Rust and the Node file adapter still verify
  the full image on each admit. No-op offers skip the storage write and re-encoding. The verified
  store path now avoids redundant full-state planner checks, and both witnesses reuse validated
  base bytes during durable encoding. Permanent commits retain already verified set members
  without re-hashing them; only newly added members cross the set insertion check. The v2 image
  still grows with admitted history.
  Canonical v1 ordinary journal frames and digest-chain replay are now pinned in both witnesses
  by shared bytes. A typed journal-backed single-peer admission facade exposes an atomic
  head/frame/row storage seam, warm append, no-op receipts and fail-closed reopen. It covers
  signed loose ordinary additions, effective erasure orders and mixed transfers. An erasure CAS
  checks asserted target absence; purge settlement requires a storage proof of physical absence.
  A refuted proof is distinct from a head conflict. A durable rebase replaces payload-bearing
  frames with a current-state checkpoint before a removed report can be truthful; storage must
  still prove absence across rows, frames, checkpoints and physical remnants. Reopen also checks
  that every admitted row is present with the frame-derived id and signature. Canonical ordinary
  checkpoints now bind a verified
  v2 image to an exact frame head and let a backend atomically prune that verified prefix;
  retained frames replay from the boundary. Reopen rechecks the head after reading admitted
  rows and returns a retryable conflict if it changed.

### Internal structure

- A canonical peer-local state image and single-writer file adapter preserve current holdings,
  first-epoch arrival testimony, counters, and permanent refusals across restart. An internal v2
  image and commit planner now bind verified final additions, erasure exclusions, refusal events,
  quota usage, and stable purge obligations in one local replacement. Writes require the expected
  prior image and check newly arrived orders and ordinary quota growth. CBOR and pack readers
  reject malformed lengths, excessive nesting, and invalid table indices before admission.

## 0.11.0-next.1 — 2026-09-25

### Improved

- Timed materializations keep their read clock current without re-evaluation when no validity boundary was crossed. The same rule applies when time moves backward; refresh at a crossed boundary still emits the same view changes.

## 0.11.0-next.0 — 2026-09-25

### Breaking

- **Signed validity and explicit read time** ([#43](https://github.com/bombadil-labs/rhizomatic/pull/43), SPEC-1 §6): every delta now requires `validFrom` and may set `validUntil`; valid intervals are `[validFrom, validUntil)`. The new fields change content addresses and pack version 2. Validity reads and published definition loaders require a caller-supplied `now`. A bounded negation stops suppressing its target at its end time.
- **Two Schema time orders:** `byTimestamp` compares signed creation claims; `byValidFrom` compares signed validity starts. Both finish ties by ascending delta id. The substrate keeps claims in superposition and chooses no winner. Shared time vectors pin both orders and boundary behavior.

### Added

- Reactors report the next validity boundary from a maintained index and refresh materializations when the host advances time, including backward time changes. The tour's Rust WASM witness and browser bundles are refreshed for this format.

- **Structured Term and Pred parser errors** ([#39](https://github.com/bombadil-labs/rhizomatic/issues/39), SPEC-2 §8): rejected JSON now has a stable `kind` (`unknown-op`, `unknown-key`, or `invalid-shape`) and an RFC 6901 `path` while human messages remain free to change. TypeScript `parseTerm`/`parsePred` throw the exported `ParseError`; Rust exposes `parse_term_diagnostic`/`parse_pred_diagnostic` alongside its string-error entry points. Shared reject vectors pin both witnesses. Loam can use `kind` to link to its manual without matching English text.

### Internal structure

- **vNext steps 1–2** ([#38](https://github.com/bombadil-labs/rhizomatic/pull/38)):
  the TypeScript witness now has an explicit, mechanically checked
  acyclic source package graph. Runtime imports and declaration imports are checked before
  the green gate runs. Source modules moved behind internal boundaries while the aggregate
  `@bombadil/rhizomatic` barrel and old source module paths remain available. Manifest parsing,
  shared term syntax, terminal resolve composition, and self-hosted schema loading have named
  owners. Canonical bytes and shared vectors are unchanged.

### ⚠️ Breaking-ish (a loosening: nothing valid changes meaning; previously-rejected inputs become valid)

- **Strings are byte-honest — NFC demoted from boundary law to authoring hygiene; D15 resolved
  by dissolution** ([#36](https://github.com/bombadil-labs/rhizomatic/issues/36), SPEC-1
  §2.1/§4.1, SPEC-2 §3/§9, ERRATA D16 + E22). L1 admits any valid UTF-8; the bytes the author
  wrote are the bytes that hash; canonically-equivalent spellings are different claims (the
  `image/PNG` ≠ `image/png` honesty, now uniform). **No existing canonical bytes move.** The
  kernel consults no Unicode tables anywhere — the Rust witness dropped `unicode-normalization`,
  the Haskell witness deleted its generated UCD module — so the D15 table-vintage admission seam
  is gone rather than answered. Term parsing likewise stops normalizing (a normalized term
  silently matches different data). The authoring SHOULD (normalize in mutation helpers, before
  the hash exists) plus the tiered consumer playbook (query-time `inSet` expansion → alias
  sentinel → renderer display normalization) live in SPEC-4 §6 / SPEC-5 §6. Vectors:
  `author-not-nfc` leaves `deltas-invalid.json`; the new `unicode-non-nfc-spelling` positive
  vector pins a decomposed spelling with its own id, distinct from its composed sibling.
  **Interop:** peers on ≤0.10.0 fail closed on newly-legal deltas — the standard version-skew
  story; upgrade before federating byte-honest data.

## 0.10.0 — 2026-07-30

### Added

- **`vectors/l1-eval/eval-bytes.json` exists now**
  ([#34](https://github.com/bombadil-labs/rhizomatic/issues/34)) — the family the vectors README
  had documented since 0.4 but which was never generated (bytes-at-resolve behavior was pinned
  only by per-witness unit tests). Six cases, byte-exact in both L1 witnesses: `pick` yielding a
  bytes View leaf (with `leafCanonicalHex` pinning that the leaf's canonical CBOR is exactly the
  target's), `conflicts` staying quiet on an identical `(mime, bytes)` pair while firing on the
  same bytes under a different mime, `merge(sum)` folding past bytes, `merge(count)` counting
  them, and `all` ordering leaves by entry metadata. Also in #34: a docs-freshness sweep — README
  now says four witnesses (and its "For the Implementer" section acknowledges the
  relational-completeness proof it was waiting for), CLAUDE.md's layout block lists all four
  implementations, PROGRESS's queued-next list dropped two shipped items and one
  already-made decision.

- **`all(order, distinct: true)` — opt-in value-dedup at the resolve boundary**
  ([#33](https://github.com/bombadil-labs/rhizomatic/issues/33), SPEC-5 §3/§7, ERRATA-5 R9;
  designed in NOTE-13 §4). Orders the property's candidates, then keeps the **first occurrence**
  of each distinct value — so under `byAuthorRank` the survivor is the most-trusted author's copy,
  and the array order is first-occurrence order. Value equality is the resolved View's canonical
  CBOR bytes (the equality `conflicts` already dedups by): numeric spellings collapse, bytes
  leaves dedup by `(mime, bytes)` jointly, mixed types never collide. Only the literal `true` is
  legal — `distinct: false` rejects (one spelling per meaning), so schema hashing gains no
  normalization rule. Default off and additive/parse-visible (no `alg` bump): plain `all` is
  byte-identical to before, pinned by a control vector. New vector family
  `vectors/l1-eval/eval-distinct.json` (7 cases + 3 rejects); new TS export `viewToJson` (the
  SPEC-5 §5 JSON rendering, used by the first vectors to pin a bytes leaf inside an
  `expectedView`).

- **Relational completeness is settled** ([#31](https://github.com/bombadil-labs/rhizomatic/issues/31),
  SPEC-2 §6/§10, ERRATA-2 E21, [NOTE-13](spec/13-relational-completeness.NOTE.md)). The selective
  fragment of Codd's algebra (σ against constants with boolean closure, ∪, −, ∩, π-with-lineage)
  is expressed exactly by L2 terms over the tuple-as-delta encoding; Cartesian product is
  **provably inexpressible as a term** (the no-minting lemma — every DSet-sort result is a subset
  of its input), and that same lemma is the §5 complexity envelope and §1's federation sandbox, so
  §10's "admit a ninth operator?" closes with a principled no. The *system* is relationally
  complete by stratification (L2 + L7 derivations). New vector family
  `vectors/l1-eval/eval-relational.json`: 9 positive cases (including Codd's ∩ = R − (R − S) as an
  evaluated byte-identity) + 3 `rejects[]` pinning that product-shaped terms fail closed in every
  witness. **No behavior change** — no canonical bytes move; the closed §9 profile already rejected
  unknown operators, and the new vectors pin that this is a theorem, not an accident.

- **`implementations/haskell` — the fourth witness, at conformance Level 0**
  ([#29](https://github.com/bombadil-labs/rhizomatic/issues/29)). Zero dependencies (GHC boot
  packages only); *all* crypto hand-rolled from the standards — BLAKE3, SHA-512, and Ed25519
  signing **and** the SPEC-1 §5.1 five-check strict verifier. The typed claims AST discharges
  D14 by construction (a claims number is only ever a `Double`). 178 checks across the full L0
  vector surface; pack bytes reproduced byte-exactly. Bring-up record in
  `implementations/haskell/FINDINGS.md` — headline: every #19 finding folded into normative
  text carried this witness to first-try byte parity, and no new L0 underspecification
  surfaced. **No package change**: nothing in `@bombadil/rhizomatic` moves; this entry records
  the parity contract widening to four witnesses.

## 0.9.0 — 2026-07-21

### Documentation

- **`inView` stratification at depth 1 is now stated as permanent**
  ([#27](https://github.com/bombadil-labs/rhizomatic/issues/27), SPEC-2 §3.1, ERRATA-2 E20) — a
  settled decision rather than a provisional limit awaiting a consumer, closing the "Reflective
  depth" open question in §10. **No behavior change:** the depth-1 parse rejection already shipped;
  this documents what it means and how to work with it.
  - The recursive case (a container tree whose every level carries its own trust declaration) has
    **two sanctioned routes, selected by freshness requirement, not preference**: flatten in the
    host to an `inSet` predicate — zero-lag when computed per read, and **required** wherever a
    change must bind on the very next read, revocation being the motivating case; or have a derived
    author (SPEC-7) emit the closure as signed deltas and read it with a depth-1 `inView` — one
    derivation cascade of lag, in exchange for provenance and third-party replay verification.
  - The routes **compose**: the binding path uses the first, an auditable artifact alongside uses
    the second. They answer different questions.
  - ⚠️ **A closure one cascade behind is indistinguishable from a current one by inspection**, so
    using the derived route on a revocation path regresses a zero-lag guarantee *silently*. If your
    spec states such a guarantee, flatten in the host.

**Fail-closed parsing now covers keys, not just tags**
([#25](https://github.com/bombadil-labs/rhizomatic/issues/25), SPEC-2 §8 + SPEC-1 §4.2,
ERRATA-2 E19). The fail-closed rule was normative for **tags** — an unknown `op`/`cmp`/`policy`
must be rejected — because that rejection is exactly what lets additive forms enter the closed
profiles without an `alg` bump. Two sibling laxities survived it, both silent, and both are now
rejections.

### ⚠️ Breaking

- **Unknown object keys are rejected.** Every object node in the term profile (SPEC-2 §9), the
  schema profile (SPEC-5 §7), and the L0 claims profile (SPEC-1 §4.2) is a **closed record**. A
  key outside the node's declared set is an error naming the offending key. Previously such keys
  were silently dropped — so `{"op": "expand", …, "readng": "Post"}` parsed as a *legacy* expand
  (0.8.0's `reading`, #23), hashed as one, gathered happily, and failed far away at resolve time.
- **Ambiguous one-of nodes are rejected.** `StrMatch`, `ValMatch`, `Pred`, `Order`, `Policy`,
  `GroupKey`, `SchemaRef`, and `inView.extract` carry **exactly one** arm; two or more present is
  ambiguous rather than resolved by declaration order. At L0, a pointer target carrying more than
  one of `id`/`delta`/`mime` is likewise ambiguous — SPEC-1 §4.2's "first match wins" is retired.
- **`{mime, value}` bytes targets reject a `context` key** (ERRATA D12 always said a bytes literal
  has no context; it was silently ignored until now).
- **For consumers:** every *correctly authored* body, term, schema, and delta is unaffected —
  this makes parsers strictly stricter, so all currently-valid input stays valid and no canonical
  bytes, ids, or hashes move. What starts failing is input that was only *accidentally* valid, and
  each failure is a bug the old parser was hiding. **No `alg` bump** and no migration: if you have
  no junk keys, there is nothing to do. If a body does trip this, the error names the key and, for
  a plausible typo, suggests the intended one.
- **This closes the mixed-version hazard 0.8.0 documented.** A pre-0.9 peer handed a body with a
  from-the-future key silently ignores it and evaluates a *different, still-valid* program — a
  silent semantic fork rather than a detectable partition. Post-0.9 witnesses refuse instead, which
  is the guarantee the whole "the version lives in the vocabulary" story assumed it already had.

### Added

- `vectors/l1-eval/eval-strict-keys.json` — 23 rejects covering every node kind in the L2 grammar
  (unknown-key and ambiguous-arm cases), verified to reject at generation time.
- `vectors/l0-delta/deltas-invalid.json` grows 26 → 34 with the L0 unknown-key and
  ambiguous-target cases; all three witnesses consume them.
- Rejection messages follow SPEC-2 §8's SHOULD: they name the offending key, suggest the nearest
  known key when it is a plausible typo (`unknown key "readng" on expand; did you mean
  "reading"?`), and point at version skew otherwise. **Error text is not normative** — only the
  rejection is — so witnesses may word it differently.

### Note for implementers

The **Elixir witness needed no behavioral change** — written from spec + vectors alone (#19), it
had been fail-closed on keys by construction since day one, and passed all eight new L0 vectors
before being touched. The two witnesses written alongside the spec both carried the laxity. The
gap was in the spec text, and only a third, independent reading surfaced it (ERRATA-2 E19,
`implementations/elixir/FINDINGS.md` F10).

Exactly **two** nodes in the whole profile stay open, because their keys are author-chosen data
rather than grammar: `fix.bindings` (hole names) and a Schema's `props` (property names). Both say
so explicitly at their call sites. The witnesses make this structural by taking the known-key list
as a **required argument** of the object-parsing helper, so the type checker — not vigilance —
guarantees no node was left lax during the sweep; a new node cannot compile without declaring its
keys. Recommended for any new witness.

## 0.8.0 — 2026-07-19

**`expand` names the child's reading** ([#23](https://github.com/bombadil-labs/rhizomatic/issues/23),
SPEC-2 §4.5/E18, SPEC-5 §4/R8): an expand term now states **both halves of the child's lens** —
`schema` (how the child gathers) and `reading` (the resolution Schema the child resolves through
when the expansion crosses the `resolve` boundary). Before this, an expanded child was silently
resolved with the **parent's** Schema — a child's intended reading was unstatable, and two parents
embedding the same child under different Schemas produced different child views with nothing in
the program identifying either. Surfaced by Loam's multi-lens coexistence work (Loam T25).

### ⚠️ Breaking

- **Resolving an expansion under a legacy body (no `reading`) is now a loud error** — there is no
  fallback to the parent's Schema. Gather is unchanged: legacy bodies still parse, evaluate, and
  hash byte-identically; only `resolve` over their expansions refuses. **Migration — this is not
  optional and there is no compatibility path:** every expand-carrying hyperschema body in every
  store MUST be re-published with `"reading": <its Schema's name or pinned hash>` before anything
  resolves through it. Every pre-#23 hyperschema had exactly one Schema (coexistence postdates
  them), so the choice is mechanical. Bodies gaining `reading` mint new termHashes — **and every
  `{pinned: <old hash>}` reference elsewhere keeps pointing at the legacy body, which will refuse
  to resolve forever. Walk pinned refs too and re-pin them to the migrated hashes.** Regenerate
  any deltas that would hit either path; do not ship a store that mixes migrated and unmigrated
  expand bodies.
- `SchemaRegistry.build` gains a second argument: `readings` (named resolution Schemas), indexed
  by name and content address (`schemaHash`, newly exported); reading refs validate at build.
  Existing single-argument calls compile unchanged (defaults to none).

### Added (readings)

- `expand.reading` in the term grammar (SPEC-2 §9) — present-iff-authored, so legacy hashes are
  untouched; `schemaHash(schema)` — a resolution Schema's content address, the referent of
  `reading: {pinned: …}`; registry `resolveReading`/`getReading`; `collectReadingRefs`.
- **Serialized HyperViews stay self-describing** (SPEC-3 §4): an expanded target's canonical form
  carries the reading's content address (`{"id", "props", "reading"}`, key present iff the expand
  named one) — a rehydrated hview can name its readings and be resolved through a registry. Legacy
  hview bytes are untouched.
- `vectors/l1-eval/eval-resolve.json` regenerated: a `readings` registry section, the
  `resolve-nested-expansion` case now observably resolved through the child's own reading, and a
  `legacy-expand-resolve-rejected` reject (verified to reject at generation time).
  `eval-expand.json` gains `fix-expand-with-reading`, pinning the reading hash in canonical bytes.

### Integrating (consumers)

**1. Author the expand with both halves of the child's lens.**

```jsonc
// before — the child was silently resolved with the PARENT's Schema
{ "op": "expand", "role": { "exact": "post" }, "schema": "PachyPost", "in": <Term> }

// after — the child's gather AND its reading are named in the term
{ "op": "expand", "role": { "exact": "post" }, "schema": "PachyPost",
  "reading": "Post", "in": <Term> }

// or pin the reading by content address (immutable; survives a rename)
{ "op": "expand", "role": { "exact": "post" }, "schema": "PachyPost",
  "reading": { "pinned": "1e20…" }, "in": <Term> }
```

**2. Register readings alongside hyperschemas.** `SchemaRegistry.build` takes a second argument;
a registered reading MUST carry a `name` (an inline, anonymous Schema cannot be referenced).

```ts
import { SchemaRegistry, parseSchema, parseTerm, schemaHash, loadSchema } from "@bombadil/rhizomatic";

const readings = [
  parseSchema({
    name: "Post",                       // required to be registerable
    alg: 1,
    props: { title: { pick: { order: { byTimestamp: "desc" } } } },
    default: { pick: { order: "lexById" } },
  }),
];
const registry = SchemaRegistry.build(hyperSchemas, readings);

// Schemas published as deltas (0.5.0) load straight back into this slot — loadSchema
// reattaches name/alg, which is exactly what registration requires:
const fromStore = loadSchema(dset, "schema:Post");
const registry2 = SchemaRegistry.build(hyperSchemas, [fromStore]);

// The referent of `reading: {pinned: …}`:
schemaHash(readings[0]); // => "1e20…"
```

**3. Errors you will see, and what each means.** All three are loud and none fall back:

| Message | Cause | Fix |
|---|---|---|
| `schema <X> references unknown reading <Y> (issue #23)` | thrown at **`SchemaRegistry.build`** | register `Y` (or correct the ref) — this is the good failure: it fires before any evaluation |
| `unknown reading: <Y> (issue #23)` | thrown at **eval**, registry built without the reading | same, for registries assembled dynamically |
| `expansion at pointer <i> of delta <id> carries no reading — legacy expand bodies must name the child's resolution Schema` | thrown at **resolve**, body predates `reading` | migrate that body (below) — gather succeeded, so this surfaces late |

**4. Migration checklist.**

1. Find every hyperschema body containing an `expand` (`collectRefs`/`collectReadingRefs` over
   parsed bodies makes this mechanical).
2. For each, add `"reading": <the one Schema that hyperschema was used with>` — pre-0.8 stores
   have exactly one candidate per hyperschema, since multi-lens coexistence postdates them.
3. Re-publish the body. It mints a **new termHash**.
4. **Walk every `{"pinned": <hash>}` schema reference and re-pin it** to the migrated hash —
   pinned refs to pre-migration bodies keep resolving to the legacy body and refuse forever.
5. Regenerate any stored deltas carrying old bodies or old pinned refs. Do not ship a store
   mixing migrated and unmigrated expand bodies.

**5. What does not change.** Gather semantics, canonical delta bytes, ids, signatures, and the
`resolve` API surface are all untouched; a body with no `expand` is entirely unaffected. Terms
without `reading` still parse and hash identically, so migration is detectable but not forced at
parse time. No `alg` bump.

**6. One mixed-version hazard, worth knowing before you federate.** A **pre-0.8 witness** handed a
`reading`-carrying body does **not** fail closed — it silently ignores the unknown key and
evaluates the body as a legacy expand, resolving children under the parent's Schema. Two peers on
different versions therefore produce *different views from the same term* without either erroring.
This is a gap in the fail-closed doctrine (which covers unknown **tags** but not unknown **keys**)
and is tracked in [#25](https://github.com/bombadil-labs/rhizomatic/issues/25). Adopting 0.8.0 does
**not** require #25 — but until it lands, upgrade all peers that share bodies together, and treat
"peer resolves this expansion differently" as a version-skew symptom rather than a logic bug.

---

**A third witness** ([#19](https://github.com/bombadil-labs/rhizomatic/issues/19)):
`implementations/elixir`, at conformance Level 0, written from `spec/` + `vectors/` **alone** —
the first real test of SPEC-0 §5's claim that the conformance suite is sufficient to conform to.
Zero dependencies (pure-Elixir BLAKE3 and Edwards arithmetic; OTP `:crypto` for signing only).
Its findings drove the rest of this release.

### Added

- **`implementations/elixir`** — the L0 witness (106 tests), plus `FINDINGS.md`: the full record
  of where spec/vectors underspecified the work (the experiment's actual deliverable).
- **`vectors/l0-pack/pack-bytes.json`** — the bytes-target pack vector promised by D12 and the
  vectors README since 0.4 but never generated (finding F1); all three witnesses now consume it.
- **N-witness parity runner** — `tools/check-all.mjs` discovers `implementations/*/witness.json`
  manifests (machine-readable conformance level + checks); CI gains an Elixir job.
- **The L0 bring-up path** in `vectors/README.md` — attack order, gate, and the no-peeking rule,
  for the next citizen.
- **SPEC-1 §4.1 + ERRATA D14 — host-boundary numeric policy**: hosts distinguishing integer from
  float terms MUST reject native integer terms at claim construction; the JSON-profile parser is
  the single blessed coercion point (an integer token is a float spelling). Pinned by the new
  `number-integer-spelling` vector.

### Changed

- **SPEC-8 §3 reconciled with its own vector** (findings F2–F4, ERRATA-8 P4): the record grammar
  gains the `"i"` stored-id field it always needed (§4's fsck presupposed it), the `strings`
  table's raw-bytewise sort order is stated, interned string sources are enumerated, and
  `"version": 1` is noted to encode as a float. **No byte changes** — the spec text now describes
  what every witness already emits.
- SPEC-8 §3.1: **envelopes win** (F6, ERRATA-8 P5) — a manifest claimed by another manifest stays
  hydrated in `envelopes`; manifest-ness = a `rhizomatic.txn.member` pointer with a DeltaRef
  target. Open questions recorded: MemberRecord `dt` lossiness (F5, P6) and the Unicode version
  behind NFC validation (ERRATA D15).
- CLAUDE.md: lockstep binds per conformance level, not per repo.
  - **For consumers:** nothing — no wire bytes, ids, or evaluation semantics change. New vectors
    are additive (`deltas.json` +1 case regenerates the provisional D10 set digest).

## 0.7.0 — 2026-07-16

The Ed25519 signature-acceptance criterion is **pinned to strict** ([#20](https://github.com/bombadil-labs/rhizomatic/issues/20),
SPEC-1 §5.1, ERRATA D13). The two witnesses verified under different criteria — TS on `@noble/curves`'
permissive ZIP215 default, Rust on `ed25519-dalek`'s `verify_strict` — which agree on every honest
signature but split on adversarial edge cases (non-canonical encodings, small-order components).
Verification is admission, so a criterion split is a federation split; the spec now states one
criterion normatively, in its own words.

### Added

- **SPEC-1 §5.1 — the strict acceptance criterion**, five explicit checks: canonical scalar
  (`S < L`), canonical point encodings of `A` and `R` (decompress–recompress must reproduce the
  bytes), no small-order `A` or `R`, and the **cofactorless** verification equation, exactly.
  Mixed-order (torsion-carrying but large-order) points are deliberately *not* rejected by the
  small-order check; the equation decides them.
- **`vectors/l0-delta/deltas-sig-edge.json`** — ten speccheck-style vectors machine-checking every
  clause, six of which a ZIP215 verifier accepts and a conformant witness MUST refuse (each carries
  an informative `zip215Accepts` flag). Verdicts are re-verified at generation time.

### Changed

- **Both witnesses now implement the five checks explicitly** rather than delegating to a library's
  notion of "strict" (noble point/scalar primitives in TS, `curve25519-dalek` + `sha2` in Rust).
  - **For consumers:** signing is untouched (RFC 8032 signing is deterministic and identical under
    both criteria), and every honestly-generated signature verifies exactly as before. The only
    behavior change is that the TS witness now *refuses* edge-case signatures it previously
    admitted under ZIP215 — a tightening, and the point of the pin.

## 0.6.0 — 2026-07-15

First-class **set algebra over delta-sets**: the operator algebra had `union` but no difference or
intersection ([#16](https://github.com/bombadil-labs/rhizomatic/issues/16), SPEC-2 §4.9, ERRATA-2
E17). This is what Loam's container work (membership = a delta-query; excluded/"sandbox" containers)
needs: read scope = *the union of active containers **minus** the excluded ones*.

### Added

- **`difference` and `intersect` term operators** (SPEC-2 §4.9). Two new `dset`-sort ops, symmetric
  with `union`, whole-delta and keyed by content-addressed id, nestable to any depth:
  `{ "op": "difference", "of": Term, "without": Term }` (asymmetric — `of ∖ without`) and
  `{ "op": "intersect", "left": Term, "right": Term }`. Unlike the old `select(not(inView(…)))`
  workaround, a `difference` may difference against another `difference` (the reflective route is
  stratified at depth 1), so containers defined relative to other containers compose. The
  `mask(annotate)` tag channel does not survive either op, exactly as through `select`/`union`.

### Changed

- **No `alg` bump — the instruction set stays `alg: 1`.** Adding an operator to the **closed** §9
  Term profile is *parse-visible*: an implementation that predates it meets an unknown `op` and
  rejects at parse time, loudly, before evaluation — which is the safety an `alg` bump would have
  provided. SPEC-2 §8 is reconciled to say a bump is required **iff** a change is *not* parse-visible
  (altered semantics of an existing form), and to make the fail-closed parse rule normative (a
  conformant parser MUST reject any unrecognized `op`/`policy`/`cmp`/… tag). `difference`/`intersect`
  enter under this rule, exactly as `inView` and `chain` did.
  - **For consumers:** no migration, no data changes. A term using these ops is rejected — never
    silently mis-evaluated — by any older witness, and the rejection now SHOULD name the tag and
    point at version skew. Loam, the sole current consumer, is built in lockstep, so there is no
    older witness in the wild regardless.

## 0.5.0 — 2026-07-14

Schema/HyperSchema vocabulary reconciliation + self-hosting parity, landed as **one migration wave**
(issues [#10](https://github.com/bombadil-labs/rhizomatic/issues/10) +
[#11](https://github.com/bombadil-labs/rhizomatic/issues/11)) so consumers pull a single new version.

### ⚠️ Breaking

- **`loadSchema` / `publishSchemaClaims` → `loadHyperSchema` / `publishHyperSchemaClaims`** (#10).
  These always operated on **HyperSchemas** (the gather program), not resolution Schemas — the names
  predated the 0.3.0 L5 realignment. The old names are now **reused for resolution Schemas** (see
  Added), so this is *not* a silent no-op: `loadSchema` now returns a `Schema` (not a `HyperSchema`)
  and `publishSchemaClaims` now takes a `Schema` — TypeScript flags both at your call sites.
  - **Migrate:** rename every HyperSchema use — TS `loadSchema`→`loadHyperSchema`,
    `publishSchemaClaims`→`publishHyperSchemaClaims`; Rust `load_schema`→`load_hyper_schema`,
    `publish_schema_claims`→`publish_hyper_schema_claims`. `HYPER_SCHEMA_SCHEMA` and the
    `rhizomatic.hyperschema.*` roles are unchanged, so **no at-rest data migrates** — code only.

### Added

- **`SCHEMA_SCHEMA`** (`rhizomatic.SchemaSchema`) + **`publishSchemaClaims` / `loadSchema` for
  resolution Schemas** (#11, SPEC-3 ERRATA S6). A resolution `Schema` (`{ props, default }`) can now
  be a first-class, self-hosting, versionable entity — published as deltas over the new
  `rhizomatic.schema.*` vocabulary and read back through `SCHEMA_SCHEMA`, exactly as a HyperSchema
  is. This is what Loam §21's `name@hash` schema versioning builds on.
- **`Schema` gained optional `name` and `alg`.** Inline `resolve`-term schemas stay anonymous
  (byte-identical to 0.4.0); a *published* Schema must carry both. New export `schemaCanonicalHex`
  hashes the resolution content (props+default); `name`/`alg` are identity metadata (roles),
  excluded from the hash — mirroring a HyperSchema's body-only term hash.

## 0.4.0 — 2026-07-14

### Added

- **The `bytes` Target kind** ([#7](https://github.com/bombadil-labs/rhizomatic/issues/7),
  SPEC-1 §2/§4 + ERRATA D12) — `{ kind: "bytes", mime, value }`, a 4th `Target` for raw binary
  payloads with a **required in-kind MIME type**. Identity is the hash of the raw bytes (canonical
  CBOR byte string); JSON transport is canonical **unpadded base64url**, reject-never-repair. Fully
  **additive** — no existing content address moves, and a pre-0.4 peer fails closed on the unknown
  kind (version discipline, not breakage). New exports: `bstr`, `b64uEncode` / `b64uDecode`,
  `BytesView`. Both witnesses verified at byte parity.

---

Earlier releases (**0.1.0 – 0.3.0**) predate this changelog; see the git tags `rhizomatic-v*` and
[PROGRESS.md](PROGRESS.md) for the slice-by-slice history.
