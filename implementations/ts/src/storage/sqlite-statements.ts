// The SQLite store's schema and every statement it prepares (SPEC-18 slice 4 plan §4, §5). The
// statements are kept in one list so that a rail can read the plan of each one. A base table is
// never given an alias, so a plan names the table it reads. A table whose rows can overflow a
// page (`delta`, `change`) has a rowid: a seek in a WITHOUT ROWID table compares whole cells.

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
  app_format TEXT
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
) STRICT, WITHOUT ROWID;
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
`;

// The pushdown fields of a scope, as nullable parameters: a null bound keeps every delta.
const PASSES = (id: string): string => `(@seq IS NULL OR holding.seq <= @seq)
    AND (@timestamp IS NULL OR delta.timestamp <= @timestamp)
    AND ${id} NOT IN (SELECT value FROM json_each(@drop))`;

export const SQLITE_STATEMENTS = {
  schemaSize: "SELECT count(*) AS size FROM sqlite_schema",
  metaGet: "SELECT value FROM meta WHERE key = ?",
  metaPut: "INSERT INTO meta (key, value) VALUES (?, ?)",

  historyFind: "SELECT 1 FROM history WHERE value = ?",
  historyAdd: "INSERT INTO history (value) VALUES (?)",
  peerRead: `SELECT posture, store_class AS storeClass, history, revision, floor, head, count,
    max_seq AS maxSeq FROM peer WHERE id = ?`,
  peerAdd: `INSERT INTO peer (id, posture, store_class, history, revision, floor, head, count, max_seq)
    VALUES (?, ?, ?, ?, 0, 0, NULL, 0, 0)`,
  peerAdvance: `UPDATE peer SET revision = @revision, floor = @floor, head = @head, count = @count,
    max_seq = @maxSeq WHERE id = @peer`,

  holdingFind: "SELECT 1 FROM holding WHERE peer = ? AND delta = ?",
  heldElsewhere: "SELECT 1 FROM holding WHERE delta = ? LIMIT 1",
  deltaFind: "SELECT 1 FROM delta WHERE id = ?",
  debtFind: "SELECT 1 FROM debt WHERE peer = ? AND delta = ?",
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

  get: `SELECT holding.delta AS id, delta.claims, holding.sig
    FROM json_each(@keys) AS asked
    CROSS JOIN holding ON holding.peer = @peer AND holding.delta = asked.value
    CROSS JOIN delta ON delta.id = holding.delta
    ORDER BY holding.delta`,
  arrivals: `SELECT holding.arrival
    FROM json_each(@keys) AS asked
    CROSS JOIN holding ON holding.peer = @peer AND holding.delta = asked.value
    ORDER BY holding.delta`,
  targets: `SELECT DISTINCT target.delta
    FROM json_each(@keys) AS asked
    CROSS JOIN target ON target.peer = @peer AND target.entity = asked.value
    ORDER BY target.delta`,
  negators: `SELECT DISTINCT reference.delta
    FROM json_each(@keys) AS asked
    CROSS JOIN reference
      ON reference.peer = @peer AND reference.ref = asked.value AND reference.role = 'negates'
    ORDER BY reference.delta`,
  scope: `WITH RECURSIVE member (id) AS (
    SELECT target.delta
    FROM json_each(@anchors) AS anchor
    CROSS JOIN target ON target.peer = @peer AND target.entity = anchor.value
    CROSS JOIN holding ON holding.peer = @peer AND holding.delta = target.delta
    CROSS JOIN delta ON delta.id = target.delta
    WHERE ${PASSES("target.delta")}
    UNION
    SELECT reference.delta
    FROM member
    CROSS JOIN reference
      ON reference.peer = @peer AND reference.ref = member.id AND reference.role = 'negates'
    CROSS JOIN holding ON holding.peer = @peer AND holding.delta = reference.delta
    CROSS JOIN delta ON delta.id = reference.delta
    WHERE ${PASSES("reference.delta")}
  )
  SELECT member.id, delta.claims, holding.sig, holding.arrival
  FROM member
  CROSS JOIN holding ON holding.peer = @peer AND holding.delta = member.id
  CROSS JOIN delta ON delta.id = member.id
  WHERE member.id NOT IN (SELECT value FROM json_each(@exclude))
  ORDER BY member.id`,
  changes: `SELECT revision, head, added, removed FROM change
    WHERE peer = @peer AND revision > @from AND revision <= @to
    ORDER BY revision LIMIT @limit`,

  exportPeers: "SELECT id FROM peer WHERE id > ? ORDER BY id LIMIT ?",
  exportIds: "SELECT delta FROM holding WHERE peer = ? AND delta > ? ORDER BY delta LIMIT ?",
  exportDeltas: `SELECT holding.delta AS id, delta.claims, holding.sig
    FROM holding CROSS JOIN delta ON delta.id = holding.delta
    WHERE holding.peer = ? AND holding.delta > ?
    ORDER BY holding.delta LIMIT ?`,
  exportStored: "SELECT id FROM delta WHERE id > ? ORDER BY id LIMIT ?",
} as const;
