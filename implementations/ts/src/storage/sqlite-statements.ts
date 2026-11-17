// The SQLite store's schema and every statement it prepares (SPEC-18 slice 4 plan §4, §5). The
// statements are kept in one list so that a rail can read the plan of each one. A base table is
// never given an alias, so a plan names the table it reads. A table whose rows can overflow a
// page (`delta`, `holding`, `change`) has a rowid: a seek in a WITHOUT ROWID table reads whole
// cells. A holding's arrival record has no size bound.

/**
 * The tables whose rows hold erasable material: claims, an author, an arrival record, a
 * signature, an entity id or a referenced id. A trigger counts every delete and every update of
 * one of their rows in `residue.dirty` (plan §7). A cascade from `holding` fires the triggers of
 * `target` and `reference` too. A `REPLACE` deletes rows and fires no delete trigger while
 * `recursive_triggers` is off, so no statement of the store uses it (a rail reads the list).
 *
 * The `digest` table and `peer.root` hold hashes over sets of held ids, so an old hash can confirm
 * that an id was held. They need no trigger of their own: a hash of a peer's digest that depends
 * on an id changes only while the peer holds the id, or in the transaction that releases the
 * peer's own holding of it, and that transaction deletes a `holding` row. So a rebuild that makes
 * `clean = dirty` begins after every such hash left the live rows, and it rewrites every page
 * (§4.13 reading 142).
 *
 * A peer delete (§4.13 reading 143) removes the peer's change records, debts, records and digest
 * rows, and then its peer row, which holds its id and its head. A trigger on the delete of a
 * `peer` row counts that removal in `residue.dirty`, so a rebuild that makes `clean = dirty`
 * begins after it, also for a peer that held nothing. No statement deletes a `peer` row but the
 * delete's last, and every row of the peer is gone by then: the foreign keys refuse it otherwise.
 * An update of a `peer` row counts nothing: every append writes one.
 */
const ERASABLE = ["holding", "delta", "target", "reference"] as const;

export const SQLITE_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE history (value TEXT PRIMARY KEY) STRICT;
CREATE TABLE peer (
  id TEXT PRIMARY KEY,
  posture TEXT NOT NULL CHECK (posture IN ('proven', 'unproven')),
  store_class TEXT NOT NULL CHECK (store_class IN ('proven', 'unprovable')),
  history TEXT NOT NULL UNIQUE REFERENCES history,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  floor INTEGER NOT NULL CHECK (floor >= 0 AND floor <= revision),
  head TEXT,
  count INTEGER NOT NULL CHECK (count >= 0),
  max_seq INTEGER NOT NULL CHECK (max_seq >= 0),
  removed_at INTEGER NOT NULL CHECK (removed_at >= 0 AND removed_at <= revision),
  max_transfer INTEGER NOT NULL CHECK (max_transfer >= 0),
  app_format TEXT CHECK (app_format IS NULL OR length(CAST(app_format AS BLOB)) BETWEEN 1 AND 256),
  root TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'deleting'))
) STRICT;
CREATE TABLE delta (
  id TEXT PRIMARY KEY,
  claims BLOB NOT NULL,
  author TEXT NOT NULL,
  timestamp REAL NOT NULL
) STRICT;
CREATE TABLE holding (
  peer TEXT NOT NULL REFERENCES peer,
  delta TEXT NOT NULL REFERENCES delta,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  arrival TEXT NOT NULL,
  sig TEXT,
  author TEXT NOT NULL,
  PRIMARY KEY (peer, delta),
  UNIQUE (peer, seq)
) STRICT;
CREATE INDEX holding_by_delta ON holding (delta);
CREATE INDEX holding_by_author ON holding (peer, author);
CREATE TABLE target (
  peer TEXT NOT NULL,
  entity TEXT NOT NULL,
  delta TEXT NOT NULL,
  PRIMARY KEY (peer, entity, delta),
  FOREIGN KEY (peer, delta) REFERENCES holding ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX target_by_delta ON target (peer, delta);
CREATE TABLE reference (
  peer TEXT NOT NULL,
  ref TEXT NOT NULL,
  role TEXT NOT NULL,
  delta TEXT NOT NULL,
  PRIMARY KEY (peer, ref, role, delta),
  FOREIGN KEY (peer, delta) REFERENCES holding ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX reference_by_delta ON reference (peer, delta);
CREATE TABLE digest (
  peer TEXT NOT NULL REFERENCES peer,
  prefix TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 1),
  hash TEXT NOT NULL,
  PRIMARY KEY (peer, prefix)
) STRICT, WITHOUT ROWID;
CREATE TABLE change (
  peer TEXT NOT NULL REFERENCES peer,
  revision INTEGER NOT NULL,
  head TEXT,
  added TEXT NOT NULL,
  removed TEXT NOT NULL,
  PRIMARY KEY (peer, revision)
) STRICT;
CREATE TABLE debt (
  peer TEXT NOT NULL REFERENCES peer,
  delta TEXT NOT NULL,
  PRIMARY KEY (peer, delta)
) STRICT, WITHOUT ROWID;
CREATE INDEX debt_by_delta ON debt (delta);
CREATE TABLE surface_debt (
  peer TEXT NOT NULL REFERENCES peer,
  delta TEXT NOT NULL,
  PRIMARY KEY (peer, delta)
) STRICT, WITHOUT ROWID;
CREATE INDEX surface_debt_by_delta ON surface_debt (delta);
CREATE TABLE residue (
  one INTEGER PRIMARY KEY CHECK (one = 1),
  dirty INTEGER NOT NULL CHECK (dirty >= 0),
  clean INTEGER NOT NULL CHECK (clean >= 0 AND clean <= dirty)
) STRICT;
INSERT INTO residue (one, dirty, clean) VALUES (1, 0, 0);
CREATE TRIGGER residue_kept BEFORE DELETE ON residue
  BEGIN SELECT RAISE(ABORT, 'the residue row is kept'); END;
${ERASABLE.flatMap((table) =>
  ["DELETE", "UPDATE"].map(
    (event) => `CREATE TRIGGER ${table}_${event.toLowerCase()}_residue AFTER ${event} ON ${table}
  BEGIN UPDATE residue SET dirty = dirty + 1 WHERE one = 1; END;`,
  ),
).join("\n")}
CREATE TRIGGER peer_delete_residue AFTER DELETE ON peer
  BEGIN UPDATE residue SET dirty = dirty + 1 WHERE one = 1; END;
`;

// A snapshot's statements keep the holdings with a sequence of at most `@bound`, the snapshot's
// last sequence (§4.13 reading 131). A scope binds the lower of that and its `arrivalAtMost`. The
// other pushdown fields are nullable parameters: a null keeps every delta. Every read joins
// `delta` with a left join, so a holding whose `delta` row is gone stays in the answer with a
// null, and the read fails on it (§4.13 reading 136). A held delta whose timestamp cannot be read
// passes the timestamp bound, for the same reason.
const PASSES = (id: string): string => `holding.seq <= @bound
    AND (@timestamp IS NULL OR delta.id IS NULL OR delta.timestamp <= @timestamp)
    AND ${id} NOT IN (SELECT value FROM json_each(@drop))`;

export const SQLITE_STATEMENTS = {
  schemaNames: "SELECT name, type FROM sqlite_schema",
  files: "PRAGMA database_list",
  metaGet: "SELECT value FROM meta WHERE key = ?",
  metaSet: `INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  residueRead: "SELECT dirty, clean FROM residue WHERE one = 1",
  residueDirty: "SELECT dirty FROM residue WHERE one = 1",
  residueClean: "UPDATE residue SET clean = max(clean, ?) WHERE one = 1",

  historyFind: "SELECT 1 FROM history WHERE value = ?",
  historyAdd: "INSERT INTO history (value) VALUES (?)",
  // A peer that a delete marked is absent to every call (§4.13 reading 143). Only `peerState`,
  // `fsckPeers` and the delete's own statements read a marked row.
  peerRead: `SELECT posture, store_class AS storeClass, history, revision, floor, head, count,
    max_seq AS maxSeq, removed_at AS removedAt, max_transfer AS maxTransfer,
    app_format AS appFormat, root FROM peer WHERE id = ? AND state = 'live'`,
  peerAdd: `INSERT INTO peer
    (id, posture, store_class, history, revision, floor, head, count, max_seq, removed_at,
    max_transfer, app_format, root, state)
    VALUES (?, ?, ?, ?, 0, 0, NULL, 0, 0, 0, 0, ?, ?, 'live')`,
  peerState: "SELECT state, posture FROM peer WHERE id = ?",
  peerMark: "UPDATE peer SET state = 'deleting' WHERE id = ?",
  peerDrop: "DELETE FROM peer WHERE id = ?",
  peerHistory: "UPDATE peer SET history = ? WHERE id = ?",
  peerAdvance: `UPDATE peer SET revision = @revision, floor = @floor, head = @head, count = @count,
    max_seq = @maxSeq, removed_at = @removedAt, max_transfer = @maxTransfer, root = @root
    WHERE id = @peer`,

  holdingFind: "SELECT 1 FROM holding WHERE peer = ? AND delta = ?",
  heldElsewhere: "SELECT 1 FROM holding WHERE delta = ? LIMIT 1",
  deltaFind: "SELECT 1 FROM delta WHERE id = ?",
  debtFind: "SELECT 1 FROM debt WHERE peer = ? AND delta = ?",
  debtNames: "SELECT 1 FROM debt WHERE delta = ? LIMIT 1",
  surfaceDebtFind: "SELECT 1 FROM surface_debt WHERE peer = ? AND delta = ?",
  surfaceDebtNames: "SELECT 1 FROM surface_debt WHERE delta = ? LIMIT 1",
  indexLeft: `SELECT EXISTS (SELECT 1 FROM holding WHERE peer = @peer AND delta = @id)
    OR EXISTS (SELECT 1 FROM target WHERE peer = @peer AND delta = @id)
    OR EXISTS (SELECT 1 FROM reference WHERE peer = @peer AND delta = @id) AS found`,

  deltaAdd: `INSERT INTO delta (id, claims, author, timestamp) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING`,
  holdingAdd: `INSERT INTO holding (peer, delta, seq, arrival, sig, author)
    VALUES (?, ?, ?, ?, ?, ?)`,
  targetAdd: `INSERT INTO target (peer, entity, delta) VALUES (?, ?, ?)
    ON CONFLICT (peer, entity, delta) DO NOTHING`,
  referenceAdd: `INSERT INTO reference (peer, ref, role, delta) VALUES (?, ?, ?, ?)
    ON CONFLICT (peer, ref, role, delta) DO NOTHING`,
  changeAdd: "INSERT INTO change (peer, revision, head, added, removed) VALUES (?, ?, ?, ?, ?)",
  changeDrop: "DELETE FROM change WHERE peer = ? AND revision = ?",
  debtAdd: "INSERT INTO debt (peer, delta) VALUES (?, ?) ON CONFLICT (peer, delta) DO NOTHING",
  debtDrop: "DELETE FROM debt WHERE peer = ? AND delta = ?",
  holdingDrop: "DELETE FROM holding WHERE peer = ? AND delta = ?",
  deltaDrop: "DELETE FROM delta WHERE id = ?",
  surfaceDebtAdd: `INSERT INTO surface_debt (peer, delta) VALUES (?, ?)
    ON CONFLICT (peer, delta) DO NOTHING`,
  surfaceDebtDrop: "DELETE FROM surface_debt WHERE peer = ? AND delta = ?",
  surfaceDebtClose: "DELETE FROM surface_debt INDEXED BY surface_debt_by_delta WHERE delta = ?",

  vacuum: "VACUUM",
  checkpoint: "PRAGMA wal_checkpoint(TRUNCATE)",

  get: `SELECT holding.delta AS id, delta.claims, holding.sig
    FROM json_each(@keys) AS asked
    CROSS JOIN holding ON holding.peer = @peer AND holding.delta = asked.value
    LEFT JOIN delta ON delta.id = holding.delta
    WHERE holding.seq <= @bound
    ORDER BY holding.delta`,
  arrivals: `SELECT holding.delta AS id, holding.seq, holding.arrival, delta.id IS NULL AS lost
    FROM json_each(@keys) AS asked
    CROSS JOIN holding ON holding.peer = @peer AND holding.delta = asked.value
    LEFT JOIN delta ON delta.id = holding.delta
    WHERE holding.seq <= @bound
    ORDER BY holding.delta`,
  targets: `SELECT target.delta, max(delta.id IS NULL) AS lost
    FROM json_each(@keys) AS asked
    CROSS JOIN target ON target.peer = @peer AND target.entity = asked.value
    CROSS JOIN holding ON holding.peer = @peer AND holding.delta = target.delta
    LEFT JOIN delta ON delta.id = target.delta
    WHERE holding.seq <= @bound
    GROUP BY target.delta
    ORDER BY target.delta`,
  negators: `SELECT reference.delta, max(delta.id IS NULL) AS lost
    FROM json_each(@keys) AS asked
    CROSS JOIN reference
      ON reference.peer = @peer AND reference.ref = asked.value AND reference.role = 'negates'
    CROSS JOIN holding ON holding.peer = @peer AND holding.delta = reference.delta
    LEFT JOIN delta ON delta.id = reference.delta
    WHERE holding.seq <= @bound
    GROUP BY reference.delta
    ORDER BY reference.delta`,
  scope: `WITH RECURSIVE member (id) AS (
    SELECT target.delta
    FROM json_each(@anchors) AS anchor
    CROSS JOIN target ON target.peer = @peer AND target.entity = anchor.value
    CROSS JOIN holding ON holding.peer = @peer AND holding.delta = target.delta
    LEFT JOIN delta ON delta.id = target.delta
    WHERE ${PASSES("target.delta")}
    UNION
    SELECT reference.delta
    FROM member
    CROSS JOIN reference
      ON reference.peer = @peer AND reference.ref = member.id AND reference.role = 'negates'
    CROSS JOIN holding ON holding.peer = @peer AND holding.delta = reference.delta
    LEFT JOIN delta ON delta.id = reference.delta
    WHERE ${PASSES("reference.delta")}
  )
  SELECT member.id, delta.claims, holding.sig, holding.seq, holding.arrival
  FROM member
  CROSS JOIN holding ON holding.peer = @peer AND holding.delta = member.id
  LEFT JOIN delta ON delta.id = member.id
  WHERE delta.id IS NULL OR member.id NOT IN (SELECT value FROM json_each(@exclude))
  ORDER BY member.id`,
  // The holdings digest (§4.13 reading 139). The ids under a prefix are a range of the key of
  // `holding`: every id is hex, so each id that starts with the prefix sorts below the prefix
  // followed by `g`. The digest keeps no sequence, so a snapshot's call is strict (reading 140).
  digestRows: `SELECT asked.value AS prefix, digest.count, digest.hash
    FROM json_each(@keys) AS asked
    CROSS JOIN digest ON digest.peer = @peer AND digest.prefix = asked.value`,
  digestHeld: `SELECT delta FROM holding
    WHERE peer = @peer AND delta >= @low AND delta < @high ORDER BY delta LIMIT @limit`,
  digestPut: `INSERT INTO digest (peer, prefix, count, hash) VALUES (@peer, @prefix, @count, @hash)
    ON CONFLICT (peer, prefix) DO UPDATE SET count = excluded.count, hash = excluded.hash`,
  digestDrop: "DELETE FROM digest WHERE peer = ? AND prefix = ?",
  digestDropUnder: "DELETE FROM digest WHERE peer = @peer AND prefix > @low AND prefix < @high",
  changes: `SELECT revision, head, added, removed FROM change
    WHERE peer = @peer AND revision > @from AND revision <= @to
    ORDER BY revision LIMIT @limit`,

  // A peer delete reads one page of each per-peer table by the peer's own key, and removes each
  // row it read with that table's own delete. The peer's holdings are read by `exportIds`.
  deleteChanges:
    "SELECT revision FROM change WHERE peer = ? AND revision > ? ORDER BY revision LIMIT ?",
  deleteDigest: "SELECT prefix FROM digest WHERE peer = ? AND prefix >= ? ORDER BY prefix LIMIT ?",
  deleteDebts: "SELECT delta FROM debt WHERE peer = ? AND delta > ? ORDER BY delta LIMIT ?",
  deleteSurfaceDebts: `SELECT delta FROM surface_debt WHERE peer = ? AND delta > ?
    ORDER BY delta LIMIT ?`,

  exportPeers: "SELECT id FROM peer WHERE id > ? AND state = 'live' ORDER BY id LIMIT ?",
  exportIds: "SELECT delta FROM holding WHERE peer = ? AND delta > ? ORDER BY delta LIMIT ?",
  exportDeltas: `SELECT holding.delta AS id, delta.claims, holding.sig
    FROM holding LEFT JOIN delta ON delta.id = holding.delta
    WHERE holding.peer = ? AND holding.delta > ?
    ORDER BY holding.delta LIMIT ?`,
  exportStored: "SELECT id FROM delta WHERE id > ? ORDER BY id LIMIT ?",

  fsckPeers: "SELECT id, state FROM peer WHERE id > ? ORDER BY id LIMIT ?",
  fsckEngine: "PRAGMA integrity_check",
  fsckForeignKeys: "PRAGMA foreign_key_check",
  fsckHoldings: `SELECT holding.delta AS id, holding.seq, holding.arrival, holding.sig,
    holding.author AS heldAuthor, delta.claims, delta.author, delta.timestamp
    FROM holding LEFT JOIN delta ON delta.id = holding.delta
    WHERE holding.peer = ? AND holding.delta > ?
    ORDER BY holding.delta LIMIT ?`,
  fsckChanges: `SELECT revision, added, removed FROM change
    WHERE peer = ? AND revision > ? ORDER BY revision LIMIT ?`,
  fsckTargets: "SELECT entity FROM target WHERE peer = ? AND delta = ?",
  fsckReferences: "SELECT ref, role FROM reference WHERE peer = ? AND delta = ?",
  fsckCount: "SELECT count(*) AS held FROM holding WHERE peer = ?",
  fsckDigest: `SELECT prefix, count, hash FROM digest
    WHERE peer = ? AND prefix > ? ORDER BY prefix LIMIT ?`,
  fsckFeed: `SELECT count(*) AS kept, min(revision) AS low, max(revision) AS high
    FROM change WHERE peer = ?`,
} as const;
