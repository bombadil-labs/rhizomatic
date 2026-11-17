// The SQLite store (SPEC-18 proposal §5.2; slice 4 plan, steps 4a and 4b). Every contract read is
// one indexed statement, and the engine keeps the consistency it can: foreign keys, uniqueness,
// checks and strict types. A snapshot holds a revision, not a transaction: each call is one short
// read transaction that checks the revision first (decision S4-2).
//
// Erasure (plan §7). A deleted row can leave copies of its bytes in the free space of live pages,
// so a purge by a peer of posture `proven` rebuilds the pages (`VACUUM`) and empties the log
// (`wal_checkpoint(TRUNCATE)`). The residue belongs to the file, and two counters keep it: a
// trigger raises `residue.dirty` in the transaction of every delete or update of a row that holds
// erasable material, and a rebuild that read `dirty = d` before it began raises `residue.clean`
// to `d`. A write that does not commit deletes no row, but its pages can stay in the log, so the
// counters do not see it. A file surface is `absent` only when both hold in the purge's last
// transaction: the log was empty when it took the write lock, and `clean = dirty`.
//
// Importing this module registers the `sqlite:` scheme of `openStore`. The package root never
// imports it, so a host without `better-sqlite3` can still load the root.

import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { compareUtf8, decode, type CborValue } from "../delta/cbor.js";
import { canonicalBytes } from "../delta/delta.js";
import { contentAddress } from "../delta/hash.js";
import type { Claims, Delta, Pointer, Target } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import { isPlainObject, ownFields } from "./copy.js";
import { LOCAL_HISTORY_PREFIX } from "./freshness.js";
import { refuseMissing, registerStoreScheme, type OpenOptions } from "./open-store.js";
import {
  admit,
  strings,
  takeAppend,
  takeAppFormat,
  takeScope,
  wellFormed,
  wellFormedSig,
  type Admitted,
} from "./request.js";
import { SQLITE_SCHEMA, SQLITE_STATEMENTS } from "./sqlite-statements.js";
import {
  PURGE_BOUNDARY,
  StoreError,
  StoreIntegrityError,
  type AppendResult,
  type ChangePage,
  type ChangeRecord,
  type CreatePeerOptions,
  type ErasureClass,
  type ErasurePosture,
  type Exporter,
  type FsckReport,
  type History,
  type Id,
  type IntegrityFault,
  type PeerId,
  type PeerStore,
  type PurgeOutcome,
  type PurgeReport,
  type Revision,
  type Snapshot,
  type Store,
  type StoreProfile,
} from "./store.js";

/** The package that this module needs, named in the error when a host has not installed it. */
const DRIVER = "better-sqlite3";

/**
 * Where `require` of the driver starts: this module in an ES module, the bundle in a CommonJS
 * bundle (where `import.meta.url` is undefined). An `import.meta.url` that is not a `file:` URL
 * is not a location on disk. With neither, the load refuses: the working directory is not a
 * location of this module, and a module there is not the host's driver.
 */
function location(): string {
  if (typeof import.meta.url === "string" && /^file:/i.test(import.meta.url))
    return import.meta.url;
  if (typeof __filename === "string" && isAbsolute(__filename)) return __filename;
  throw new Error(
    `@bombadil/rhizomatic/store/sqlite cannot find its own module location, so it does not know where to load ${DRIVER} from. Load the package as a module, or as a CommonJS bundle from a file.`,
  );
}

/**
 * The driver, loaded when this module loads. When Node cannot find it, or a module it needs, the
 * error names the package to install and keeps Node's error as its cause. A static import would
 * fail with Node's message alone, which names neither this module nor the remedy. Any other
 * error passes up unchanged.
 */
function loadDriver(): typeof BetterSqlite3 {
  try {
    return createRequire(location())(DRIVER) as typeof BetterSqlite3;
  } catch (cause) {
    if ((cause as { code?: unknown } | null)?.code !== "MODULE_NOT_FOUND") throw cause;
    throw new Error(
      `@bombadil/rhizomatic/store/sqlite needs the package ${DRIVER}, an optional peer dependency, and Node could not find it or a module it needs. Install it: npm install ${DRIVER}`,
      { cause },
    );
  }
}
const Database = loadDriver();

export const SQLITE_STORE_FORMAT = "rhizomatic-store-sqlite/5";

export type SqliteStoreOptions = {
  /** How long a call waits for a lock another connection holds, in ms. Default 5000. */
  readonly busyTimeoutMs?: number;
  /**
   * How many change records each peer keeps (§4.6). Default `{revisions: 1024}`. It is fixed
   * when the file is created; a later open that names another value is refused.
   */
  readonly changeRetention?: "unbounded" | { readonly revisions: number };
  /** At most this many records in one page of `changes`. Default 256. */
  readonly changePageSize?: number;
  /**
   * Mints the history of each peer this store creates (§4.6), as in the memory store. The
   * default is `sqlite:` and 32 hex digits from the system random source.
   */
  readonly mintHistory?: (peer: PeerId) => History;
  /**
   * The file was restored from a backup since its last open (§4.6, "History"). Open then gives
   * every peer a new history, once. A restore that makes a new file is seen without it: the file
   * has another identity. A restore that writes over the same file keeps the identity, so its
   * host passes this on the first open after the restore. Default false.
   */
  readonly restored?: boolean;
};

const DEFAULT_RETENTION = { revisions: 1024 } as const;
/**
 * The store's erasure class, read once from the platform. A rebuild writes the live deltas to a
 * temporary file. On Linux the engine unlinks that file when it creates it, so a crash leaves
 * nothing, and the erasure rails run there. On Windows the file is deleted at close, and a power
 * loss during a rebuild can leave a file of live deltas that a later purge does not reach. On
 * macOS no rail has run, and `fsync` does not flush the drive's cache without `fullfsync`. The
 * class is `unprovable` on every platform but Linux.
 */
const ERASURE_CLASS: ErasureClass = process.platform === "linux" ? "proven" : "unprovable";
const EXPORT_PAGE = 256;
/** How many times a purge's last transaction takes the write lock to find the log empty. */
const LAST_TRIES = 3;
const LOG_NOT_EMPTY = new Error("the log holds frames");

/** A read of `fsck` met a page that the engine reports damaged, with the engine's code. */
class Unreadable {
  constructor(readonly code: string) {}
}

/**
 * The connection rules (plan §4), as the engine reports them: `foreign_keys` and `secure_delete`
 * 1 (on), `journal_mode` "wal", `synchronous` 2 (full), `temp_store` 1 (file), and
 * `busy_timeout` in ms.
 */
export type SqliteConnection = {
  readonly foreign_keys: unknown;
  readonly secure_delete: unknown;
  readonly journal_mode: unknown;
  readonly synchronous: unknown;
  readonly temp_store: unknown;
  readonly busy_timeout: unknown;
};

/** The SQLite store's whole-store operations, with a read of its connection rules. */
export interface SqliteExporter extends Exporter {
  /**
   * The effective value of each connection rule, read from the engine now. For an operator: open
   * refuses a connection whose values differ from the rules, so these are the rules' values.
   */
  connection(): SqliteConnection;
}

/** A store opened by `openSqliteStore`. */
export interface SqliteStore extends Store {
  openAdmin(): SqliteExporter;
}

// The connection rules: each pragma is set, then read back, and open refuses a difference. The
// open sets the wait itself, before each statement, to the time left of the host's wait.
const RULES = (
  busyTimeoutMs: number,
): readonly (readonly [keyof SqliteConnection, string, unknown])[] => [
  ["busy_timeout", String(busyTimeoutMs), busyTimeoutMs],
  ["foreign_keys", "ON", 1],
  ["secure_delete", "ON", 1],
  ["journal_mode", "WAL", "wal"],
  ["synchronous", "FULL", 2],
  ["temp_store", "FILE", 1],
];
const MAX_BUSY_TIMEOUT = 2 ** 31 - 1;
const BUSY_PAUSE_MS = 5;

type Statements = { readonly [K in keyof typeof SQLITE_STATEMENTS]: BetterSqlite3.Statement };
type PeerRow = {
  posture: ErasurePosture;
  storeClass: ErasureClass;
  history: History;
  revision: Revision;
  floor: Revision;
  head: string | null;
  count: number;
  maxSeq: number;
  removedAt: Revision;
  maxTransfer: number;
  appFormat: string | null;
};
type DeltaRow = { id: Id; claims: Uint8Array | null; sig: string | null };
type FsckRow = DeltaRow & {
  seq: number;
  arrival: string;
  heldAuthor: string;
  author: string | null;
  timestamp: number | null;
};
type ChangeRow = { revision: Revision; head?: string | null; added: string; removed: string };

const sorted = (ids: Iterable<Id>): Id[] => [...new Set(ids)].sort(compareUtf8);

/**
 * A refusal for an error of the engine (§4.13 reading 105). Only a transient error invites a
 * retry: a busy or locked engine, a lost race for the log's lock (`SQLITE_PROTOCOL`,
 * `SQLITE_IOERR_LOCK`), an interrupted call and a failed allocation. Any other error (a
 * constraint, a damaged file, the disk) answers the same until its cause is fixed, so the message
 * says what failed and does not invite one.
 */
function unavailable(error: unknown): unknown {
  if (!(error instanceof Database.SqliteError)) return error;
  const transient = /^SQLITE_(BUSY|LOCKED|PROTOCOL$|IOERR_LOCK$|INTERRUPT$|NOMEM$)/.test(
    error.code,
  );
  return new StoreError(
    "store-unavailable",
    transient
      ? `the SQLite store cannot serve this call now (${error.code}); ask again`
      : `the SQLite store failed: ${error.message} (${error.code}); this is not a lock, and the same call fails again until the cause is fixed`,
  );
}

/** The refusal of an open for an engine error that is not busy, with the error's code. */
function notOpened(error: unknown): StoreError {
  return new StoreError(
    "open-failed",
    `sqlite store: the file did not open (${error instanceof Database.SqliteError ? error.code : "unknown"})`,
  );
}

/** The cell that `waiting` pauses on, made at its first pause. */
let pause: Int32Array | undefined;

/**
 * Runs `body`, and runs it again while the engine answers `SQLITE_BUSY`, until `deadline` (a
 * time of `performance.now`). The switch to the `wal` journal mode answers busy at once, without
 * the busy handler, while another connection opens the same new file. After the deadline the
 * refusal is `store-unavailable`, as for any lock held past the wait (reading 105). Any other
 * error passes up unchanged.
 */
function waiting<T>(deadline: number, body: () => T): T {
  for (;;) {
    try {
      return body();
    } catch (error) {
      if (!(error instanceof Database.SqliteError && error.code.startsWith("SQLITE_BUSY")))
        throw error;
      const left = deadline - performance.now();
      if (left <= 0) throw unavailable(error);
      pause ??= new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(pause, 0, 0, Math.min(BUSY_PAUSE_MS, left));
    }
  }
}

// ---- claims from their canonical bytes ----------------------------------------------------------

function fieldsOf(value: CborValue | undefined): Map<string, CborValue> {
  if (value?.t !== "map") throw new Error("sqlite store: stored claims are not a map");
  return new Map(value.v);
}
function textOf(value: CborValue | undefined): string {
  if (value?.t !== "tstr") throw new Error("sqlite store: stored claims hold a wrong text");
  return value.v;
}
function numberOf(value: CborValue | undefined): number {
  if (value?.t !== "float") throw new Error("sqlite store: stored claims hold a wrong number");
  return value.v;
}

function targetOf(value: CborValue | undefined): Target {
  if (value?.t === "tstr" || value?.t === "float" || value?.t === "bool")
    return { kind: "primitive", value: value.v };
  const fields = fieldsOf(value);
  const context = fields.has("context") ? { context: textOf(fields.get("context")) } : {};
  if (fields.has("id"))
    return { kind: "entity", entity: { id: textOf(fields.get("id")), ...context } };
  if (fields.has("delta"))
    return { kind: "delta", deltaRef: { delta: textOf(fields.get("delta")), ...context } };
  const bytes = fields.get("value");
  if (bytes?.t !== "bstr") throw new Error("sqlite store: stored claims hold a wrong target");
  return { kind: "bytes", mime: textOf(fields.get("mime")), value: bytes.v };
}

/** The claims whose canonical bytes these are. The caller checked the bytes against the id. */
function claimsOf(bytes: Uint8Array): Claims {
  const fields = fieldsOf(decode(bytes));
  const pointers = fields.get("pointers");
  if (pointers?.t !== "array") throw new Error("sqlite store: stored claims have no pointers");
  return {
    timestamp: numberOf(fields.get("timestamp")),
    validFrom: numberOf(fields.get("validFrom")),
    ...(fields.has("validUntil") ? { validUntil: numberOf(fields.get("validUntil")) } : {}),
    author: textOf(fields.get("author")),
    pointers: pointers.v.map((pointer): Pointer => {
      const parts = fieldsOf(pointer);
      return { role: textOf(parts.get("role")), target: targetOf(parts.get("target")) };
    }),
  };
}

/**
 * The claims of a stored row, or the fault of the row. No bytes (a holding whose `delta` row is
 * gone) is `claims-unreadable`, as on the memory store.
 */
function storedClaims(bytes: Uint8Array | null, id: Id, peer?: PeerId): Claims {
  const at = { ...(peer === undefined ? {} : { peer }), id };
  if (bytes === null)
    throw new StoreIntegrityError({
      kind: "claims-unreadable",
      ...at,
      detail: "sqlite store: a held delta has no stored claims",
    });
  if (contentAddress(bytes) !== id)
    throw new StoreIntegrityError({
      kind: "claims-mismatch",
      ...at,
      detail: "sqlite store: stored claims do not hash to their id",
    });
  try {
    return claimsOf(bytes);
  } catch {
    throw new StoreIntegrityError({
      kind: "claims-unreadable",
      ...at,
      detail: "sqlite store: stored bytes hash to their id and are not claims",
    });
  }
}

const arrivalText = (arrival: ArrivalRecord): string =>
  JSON.stringify({
    id: arrival.id,
    at: arrival.at,
    sequence: arrival.sequence,
    transfer: arrival.transfer,
    sender: arrival.sender,
  });

const ARRIVAL_FIELDS = new Set(["id", "at", "sequence", "transfer", "sender"]);

/**
 * The arrival record of a stored holding, or the fault of the row (§4.13 reading 136). The text
 * must be a record of exactly the five fields the store writes. `id` and `sequence` must equal the
 * holding's own columns. `transfer` must be an integer of 1 or more, and at most the peer's last
 * transfer (`sequence-mismatch`, key `transfer`). `at` and `sender` have no second copy, so only
 * their form is checked: a finite number, and a non-empty, well-formed text.
 */
function arrivalOf(
  text: string,
  peer: PeerId,
  id: Id,
  seq: number,
  lastTransfer: number,
): ArrivalRecord | IntegrityFault {
  let arrival: unknown;
  try {
    arrival = JSON.parse(text);
  } catch {
    arrival = undefined;
  }
  const record = isPlainObject(arrival) ? (arrival as Partial<Record<string, unknown>>) : {};
  const { at, sequence, transfer, sender } = record;
  if (
    !(
      Object.keys(record).every((key) => ARRIVAL_FIELDS.has(key)) &&
      record["id"] === id &&
      sequence === seq &&
      Number.isSafeInteger(transfer) &&
      (transfer as number) >= 1 &&
      typeof at === "number" &&
      Number.isFinite(at) &&
      typeof sender === "string" &&
      sender !== "" &&
      wellFormed(sender)
    )
  )
    return {
      kind: "column-mismatch",
      peer,
      id,
      key: "holding.arrival",
      detail: "sqlite store: a stored arrival record is not the record of its holding",
    };
  if ((transfer as number) > lastTransfer)
    return {
      kind: "sequence-mismatch",
      peer,
      id,
      key: "transfer",
      detail: `sqlite store: transfer ${transfer as number} passes the peer's last ${lastTransfer}`,
    };
  return { id, at, sequence, transfer: transfer as number, sender };
}

/** The arrival record of a stored holding. A fault of the row fails the read. */
function arrivalRead(
  text: string,
  peer: PeerId,
  id: Id,
  seq: number,
  lastTransfer: number,
): ArrivalRecord {
  const arrival = arrivalOf(text, peer, id, seq, lastTransfer);
  if ("kind" in arrival) throw new StoreIntegrityError(arrival);
  return arrival;
}

/** The fault of a stored signature that is not 128 lowercase hex digits, or none. */
function sigFault(sig: string | null, peer: PeerId, id: Id): IntegrityFault | undefined {
  if (sig === null || wellFormedSig(sig)) return undefined;
  return {
    kind: "column-mismatch",
    peer,
    id,
    key: "holding.sig",
    detail: "sqlite store: a stored signature is not 128 lowercase hex digits",
  };
}

/**
 * The ids of a stored change record, or the fault of the record: each list must be a JSON list
 * of texts. The fault names the peer and the column; the detail names the revision.
 */
function changeOf(row: ChangeRow, peer: PeerId): { added: Id[]; removed: Id[] } | IntegrityFault {
  const lists: Id[][] = [];
  for (const [key, text] of [
    ["change.added", row.added],
    ["change.removed", row.removed],
  ] as const) {
    let ids: unknown;
    try {
      ids = JSON.parse(text);
    } catch {
      ids = undefined;
    }
    if (!(Array.isArray(ids) && ids.every((id) => typeof id === "string")))
      return {
        kind: "column-mismatch",
        peer,
        key,
        detail: `sqlite store: the change record of revision ${row.revision} holds no list of ids`,
      };
    lists.push(ids as Id[]);
  }
  return { added: lists[0]!, removed: lists[1]! };
}

// ---- options --------------------------------------------------------------------------------

type Retention = "unbounded" | { readonly revisions: number };

type OwnOptions = {
  busyTimeoutMs: number;
  changeRetention: Retention | undefined;
  pageSize: number;
  mint: ((peer: PeerId) => History) | undefined;
  restored: boolean;
};

function takeOptions(options: unknown): OwnOptions {
  const refuse = (what: string): never => {
    throw new StoreError("invalid-request", `sqlite store: ${what}`);
  };
  if (options !== undefined && !isPlainObject(options)) refuse("the options must be an object");
  const { busyTimeoutMs, changeRetention, changePageSize, mintHistory, restored } = ownFields(
    options as Record<string, unknown> | undefined,
  );
  const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;
  if (
    busyTimeoutMs !== undefined &&
    !(
      Number.isSafeInteger(busyTimeoutMs) &&
      (busyTimeoutMs as number) >= 0 &&
      (busyTimeoutMs as number) <= MAX_BUSY_TIMEOUT
    )
  )
    refuse(`busyTimeoutMs is an integer from 0 to ${MAX_BUSY_TIMEOUT}`);
  let retention: Retention | undefined;
  if (changeRetention === "unbounded") retention = "unbounded";
  else if (changeRetention !== undefined) {
    const revisions = isPlainObject(changeRetention)
      ? ownFields(changeRetention)["revisions"]
      : undefined;
    if (!positive(revisions))
      refuse("changeRetention is unbounded or {revisions: n} with n of 1 or more");
    retention = { revisions: revisions as number };
  }
  if (changePageSize !== undefined && !positive(changePageSize))
    refuse("changePageSize is 1 or more");
  if (mintHistory !== undefined && typeof mintHistory !== "function")
    refuse("mintHistory is a function");
  if (restored !== undefined && typeof restored !== "boolean") refuse("restored is a boolean");
  return {
    busyTimeoutMs: (busyTimeoutMs as number | undefined) ?? 5000,
    changeRetention: retention,
    pageSize: (changePageSize as number | undefined) ?? 256,
    mint: mintHistory as ((peer: PeerId) => History) | undefined,
    restored: restored === true,
  };
}

/**
 * The identity of the file at the engine's path (decision S4-8): device, file index and birth
 * time, as decimal strings. A copy, and a new file at the old path, have another file index or
 * another birth time; a rename keeps all three. A file index alone is not enough: a file system
 * can give a new file the index of a file just removed. A platform without birth times reports
 * 0, and the identity is then the first two.
 */
function identityOf(file: string): string {
  let stat;
  try {
    stat = statSync(file, { bigint: true });
  } catch {
    throw new StoreError("open-failed", "sqlite store: the file's identity cannot be read");
  }
  return `${stat.dev} ${stat.ino} ${stat.birthtimeNs}`;
}

function metaOf(db: BetterSqlite3.Database, key: string): string | undefined {
  return (db.prepare(SQLITE_STATEMENTS.metaGet).get(key) as { value: string } | undefined)?.value;
}

/** The name of each table, index and trigger that the store's schema creates. */
const SCHEMA_NAMES = [...SQLITE_SCHEMA.matchAll(/CREATE (?:TABLE|INDEX|TRIGGER) (\w+)/g)].map(
  (m) => m[1]!,
);

/**
 * True when the file holds no schema at all, as a new file does. Refuses `open-failed` for a file
 * that holds a schema but not a whole store of this format: no `meta` table (an index or a view
 * of that name is not one), another format, no `format` row, or a missing table, index, trigger
 * or `retention` row. It only reads, and runs `before` before each statement. An engine error of
 * a read passes up.
 */
function isEmpty(db: BetterSqlite3.Database, before: () => void = () => {}): boolean {
  const read = (key: string): string | undefined => {
    before();
    return metaOf(db, key);
  };
  before();
  const rows = db.prepare(SQLITE_STATEMENTS.schemaNames).all() as { name: string; type: string }[];
  if (rows.length === 0) return true;
  const names = new Set(rows.map((r) => r.name));
  const format = rows.some((r) => r.name === "meta" && r.type === "table")
    ? read("format")
    : undefined;
  if (format !== SQLITE_STORE_FORMAT)
    throw new StoreError(
      "open-failed",
      format === undefined
        ? "sqlite store: the file is not a rhizomatic store"
        : `sqlite store: the file holds format ${format}, and this store reads ${SQLITE_STORE_FORMAT}`,
    );
  if (!SCHEMA_NAMES.every((name) => names.has(name)) || read("retention") === undefined)
    throw new StoreError(
      "open-failed",
      "sqlite store: the file holds the store's format but not the whole store",
    );
  return false;
}

/**
 * The profile of a store that keeps `retention`. Every other field is the same for each file, so
 * `openStore` can check a host's requirements before it opens one (§4.13 reading 126).
 */
function profileOf(retention: Retention): StoreProfile {
  return Object.freeze({
    capabilities: Object.freeze({
      values: false,
      arrival: true,
      journal: false,
      views: false,
      derivedIndexes: false,
      digest: false,
      erasure: ERASURE_CLASS,
    }),
    indexedValueRoles: Object.freeze([]),
    pushdown: Object.freeze({ timestampAtMost: true, arrivalAtMost: true, excludeIds: true }),
    // Each write holds the write lock from its start and reads every value it builds on in
    // that transaction (decision S4-7).
    writers: "many-processes" as const,
    atRest: "trusted" as const,
    changeRetention: typeof retention === "string" ? retention : Object.freeze({ ...retention }),
    formatVersion: SQLITE_STORE_FORMAT,
  });
}

// ---- the store --------------------------------------------------------------------------------

class SqliteFileStore implements SqliteStore {
  readonly profile: StoreProfile;
  readonly #db: BetterSqlite3.Database;
  readonly #s: Statements;
  readonly #begin: BetterSqlite3.Statement;
  readonly #beginWrite: BetterSqlite3.Statement;
  readonly #commit: BetterSqlite3.Statement;
  readonly #rollback: BetterSqlite3.Statement;
  readonly #keep: number;
  readonly #pageSize: number;
  readonly #mint: ((peer: PeerId) => History) | undefined;
  readonly #rules: ReturnType<typeof RULES>;
  readonly #file: string;
  #closed = false;

  constructor(db: BetterSqlite3.Database, options: OwnOptions) {
    this.#db = db;
    this.#rules = RULES(options.busyTimeoutMs);
    // Before each statement of the open, the engine waits only for the time left of one
    // `busyTimeoutMs`, so a holder that takes the lock again before each statement cannot make the
    // open wait longer. The host's value is set again before the rules are checked, and at the end.
    const deadline = performance.now() + options.busyTimeoutMs;
    const left = (): void => {
      db.pragma(`busy_timeout = ${Math.max(0, Math.ceil(deadline - performance.now()))}`);
    };
    const configured = (): void => {
      db.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    };
    // The journal mode pragma writes the file's header and makes the -wal and -shm files. So a
    // file that is not a store is refused first, by reads only (§4.13 reading 126).
    waiting(deadline, () => {
      isEmpty(db, left);
      for (const [name, value] of this.#rules)
        if (name !== "busy_timeout") {
          left();
          db.pragma(`${name} = ${value}`);
        }
    });
    configured();
    const now = this.#connection();
    for (const [name, value, expected] of this.#rules)
      if (now[name] !== expected)
        throw new StoreError(
          "open-failed",
          `sqlite store: the connection refused ${name} = ${value}`,
        );
    // The engine's own full path of the file, so that a later change of directory moves nothing.
    const files = db.prepare(SQLITE_STATEMENTS.files).all() as { name: string; file: string }[];
    this.#file = files.find((f) => f.name === "main")!.file;
    this.#begin = db.prepare("BEGIN");
    this.#beginWrite = db.prepare("BEGIN IMMEDIATE");
    this.#commit = db.prepare("COMMIT");
    this.#rollback = db.prepare("ROLLBACK");
    left();
    const retention = this.#run("write", () => this.#format(options.changeRetention));
    this.#s = Object.fromEntries(
      Object.entries(SQLITE_STATEMENTS).map(([name, sql]) => [name, db.prepare(sql)]),
    ) as unknown as Statements;
    this.#keep = retention === "unbounded" ? Number.POSITIVE_INFINITY : retention.revisions;
    this.#pageSize = options.pageSize;
    this.#mint = options.mint;
    left();
    this.#run("write", () => this.#identify(options.restored));
    configured();
    this.profile = profileOf(retention);
  }

  /** Creates the schema in an empty file, or checks the format and retention of a store. */
  #format(asked: Retention | undefined): Retention {
    const db = this.#db;
    let kept: string | undefined;
    try {
      kept = isEmpty(db) ? undefined : metaOf(db, "retention")!;
    } catch (error) {
      // The second pass and its retention read, in the write transaction, refuse as the first
      // pass does: only busy is `store-unavailable` (§4.13 reading 126).
      if (error instanceof Database.SqliteError && !error.code.startsWith("SQLITE_BUSY"))
        throw notOpened(error);
      throw error;
    }
    if (kept === undefined) {
      const retention = asked ?? DEFAULT_RETENTION;
      db.exec(SQLITE_SCHEMA);
      const put = db.prepare(SQLITE_STATEMENTS.metaSet);
      put.run("format", SQLITE_STORE_FORMAT);
      put.run("retention", JSON.stringify(retention));
      return retention;
    }
    if (asked !== undefined && JSON.stringify(asked) !== kept)
      throw new StoreError(
        "invalid-request",
        `sqlite store: the file keeps changeRetention ${kept}; open it with that value or without one`,
      );
    return JSON.parse(kept) as Retention;
  }

  /**
   * Gives every peer a new history when the file is not the file the store last recorded, or the
   * host says it was restored (decision S4-8). It runs under the write lock, so of two processes
   * that open a copy together, the second finds the identity the first recorded and mints
   * nothing. Every history stays in the `history` table, so none is issued twice. It costs
   * O(peers), and only when it mints.
   */
  #identify(restored: boolean): void {
    const s = this.#s;
    const now = identityOf(this.#file);
    const kept = (s.metaGet.get("identity") as { value: string } | undefined)?.value;
    if (kept === now && !restored) return;
    for (let after = "", found = EXPORT_PAGE; found === EXPORT_PAGE; ) {
      const ids = (s.exportPeers.all(after, EXPORT_PAGE) as { id: PeerId }[]).map((r) => r.id);
      for (const id of ids) {
        const history = this.#history(id);
        s.historyAdd.run(history);
        s.peerHistory.run(history, id);
      }
      found = ids.length;
      after = ids.at(-1) ?? after;
    }
    s.metaSet.run("identity", now);
  }

  /**
   * Runs `body` in one transaction: a read, or a write that holds the write lock from its start.
   * An engine error refuses `store-unavailable` and rolls this transaction back; an earlier
   * transaction of the same call stays committed. `uncertain` answers for a failed commit, after
   * which the store cannot tell whether the transaction committed.
   */
  #run<T>(mode: "read" | "write", body: () => T, uncertain?: (error: unknown) => T): T {
    try {
      (mode === "read" ? this.#begin : this.#beginWrite).run();
    } catch (error) {
      throw unavailable(error);
    }
    let result: T;
    try {
      result = body();
    } catch (error) {
      this.#abort();
      throw unavailable(error);
    }
    try {
      this.#commit.run();
    } catch (error) {
      this.#abort();
      if (uncertain !== undefined) return uncertain(error);
      throw unavailable(error);
    }
    return result;
  }

  #abort(): void {
    try {
      if (this.#db.inTransaction) this.#rollback.run();
    } catch {
      // The connection ends the transaction itself when a rollback fails.
    }
  }

  /** The effective value of each connection rule, read from the engine. */
  #connection(): SqliteConnection {
    return Object.fromEntries(
      this.#rules.map(([name]) => [name, this.#db.pragma(name, { simple: true })]),
    ) as SqliteConnection;
  }

  #open(): void {
    if (this.#closed) throw new StoreError("store-closed", "the store is closed");
  }

  #peerRow(id: PeerId): PeerRow | undefined {
    return this.#s.peerRead.get(id) as PeerRow | undefined;
  }

  /**
   * The delta of a stored row. Bytes that do not hash to their id, or that hash to it and are not
   * claims, fail the read with `StoreIntegrityError` (§4.13 reading 136).
   */
  #delta(row: DeltaRow, peer: PeerId): Delta {
    const claims = storedClaims(row.claims && new Uint8Array(row.claims), row.id, peer);
    const sig = sigFault(row.sig, peer, row.id);
    if (sig !== undefined) throw new StoreIntegrityError(sig);
    return row.sig === null ? { id: row.id, claims } : { id: row.id, claims, sig: row.sig };
  }

  async createPeer(id: PeerId, options: CreatePeerOptions): Promise<PeerStore> {
    this.#open();
    if (typeof id !== "string" || id.length === 0 || !wellFormed(id))
      throw new StoreError(
        "invalid-request",
        "createPeer: the peer id must be a non-empty, well-formed string",
      );
    let posture: unknown;
    let format: unknown;
    try {
      if (isPlainObject(options)) ({ erasure: posture, appFormat: format } = ownFields(options));
    } catch {
      posture = undefined;
    }
    if (posture !== "proven" && posture !== "unproven")
      throw new StoreError("invalid-request", "createPeer: declare the erasure posture");
    const appFormat = takeAppFormat(format);
    // The class is the store's own, never read back from the profile a caller can replace.
    const storeClass: ErasureClass = ERASURE_CLASS;
    if (posture === "proven" && storeClass !== "proven")
      throw new StoreError(
        "posture-refused",
        `createPeer: the peer promises proven erasure and this store's class is ${storeClass}`,
      );
    const row = this.#run("write", () => {
      if (this.#peerRow(id) !== undefined)
        throw new StoreError("peer-exists", "createPeer: the peer already exists");
      const history = this.#history(id);
      this.#s.historyAdd.run(history);
      this.#s.peerAdd.run(id, posture, storeClass, history, appFormat);
      return this.#peerRow(id)!;
    });
    return this.#handle(id, row);
  }

  /** A new history for the peer, checked as the memory store checks it (§4.6, "History"). */
  #history(peer: PeerId): History {
    const history: unknown =
      this.#mint === undefined ? `sqlite:${randomBytes(16).toString("hex")}` : this.#mint(peer);
    if (typeof history !== "string" || history === "" || !wellFormed(history))
      throw new StoreError(
        "invalid-request",
        "sqlite store: a history is a non-empty, well-formed string",
      );
    if (this.#mint !== undefined && history.startsWith(LOCAL_HISTORY_PREFIX))
      throw new StoreError(
        "invalid-request",
        `sqlite store: a minted history must not start with ${LOCAL_HISTORY_PREFIX}, which marks a history local to one process`,
      );
    if (this.#s.historyFind.get(history) !== undefined)
      throw new StoreError(
        "invalid-request",
        `sqlite store: the mint answered ${history}, a history this store already issued; a history is never reused`,
      );
    return history;
  }

  async peer(id: PeerId): Promise<PeerStore> {
    this.#open();
    // An id with a lone surrogate would be stored as another id; no peer has one.
    const row =
      typeof id === "string" && wellFormed(id)
        ? this.#run("read", () => this.#peerRow(id))
        : undefined;
    if (row === undefined) throw new StoreError("peer-absent", "peer: no such peer");
    if (row.posture === "proven" && ERASURE_CLASS !== "proven")
      throw new StoreError(
        "posture-refused",
        `peer: the peer promises proven erasure and this store's class is ${ERASURE_CLASS}`,
      );
    return this.#handle(id, row);
  }

  #handle(id: PeerId, row: PeerRow): PeerStore {
    // Another process can give the peer a new history at its open (decision S4-8), so the handle
    // reads it from the file at each ask.
    const history = (): History => {
      this.#open();
      return this.#run("read", () => this.#peerRow(id)!.history);
    };
    const appFormat = (): string | null => {
      this.#open();
      return this.#run("read", () => this.#peerRow(id)!.appFormat);
    };
    return {
      id,
      get history() {
        return history();
      },
      // Fixed at creation, and read from the file like `history`: a file restored in place
      // can hold another peer row.
      get appFormat() {
        return appFormat();
      },
      erasure: { posture: row.posture, storeClass: ERASURE_CLASS },
      read: async () => {
        this.#open();
        return this.#snapshot(
          id,
          this.#run("read", () => this.#peerRow(id)!),
        );
      },
      append: async (batch) => {
        this.#open();
        return this.#append(id, batch);
      },
      purge: async (ids) => {
        this.#open();
        return this.#purge(id, strings(ids, "purge: ids"));
      },
      changes: async (from, to) => {
        this.#open();
        return this.#changes(id, from, to);
      },
    };
  }

  #snapshot(peer: PeerId, row: PeerRow): Snapshot {
    const { history, revision, maxSeq: bound } = row;
    let released = false;
    // One short read transaction per call. The peer row is checked first, so a call on a moved
    // snapshot refuses also when it would find no rows (decision S4-2). An append gives each new
    // holding a sequence past `bound`, and every statement keeps the holdings at or below it, so
    // a call after appends answers as at `revision`. A release of a holding since `revision`, a
    // new history, or a revision below `revision` refuses (§4.13 reading 130).
    const at = <T>(body: (now: PeerRow) => T): T => {
      this.#open();
      if (released) throw new StoreError("snapshot-released", "the snapshot was released");
      return this.#run("read", () => {
        const now = this.#peerRow(peer);
        if (now?.history !== history || now.revision < revision || now.removedAt > revision)
          throw new StoreError("snapshot-moved", "the peer moved past this snapshot's revision");
        return body(now);
      });
    };
    // An id whose `delta` row is gone fails the read that would answer it (reading 136).
    const found = (rows: { delta: Id; lost: number }[]): Id[] =>
      rows.map((r) => {
        if (r.lost === 1) storedClaims(null, r.delta, peer);
        return r.delta;
      });
    const keys = (ids: readonly Id[]) => ({ peer, keys: JSON.stringify(ids), bound });
    return {
      revision,
      history,
      head: row.head,
      count: row.count,
      lastSequence: bound,
      lastTransfer: row.maxTransfer,
      get: async (ids) => {
        const asked = sorted(strings(ids, "get: ids"));
        return at(() =>
          (this.#s.get.all(keys(asked)) as DeltaRow[]).map((r) => this.#delta(r, peer)),
        );
      },
      arrivals: async (ids) => {
        const asked = sorted(strings(ids, "arrivals: ids"));
        return at((now) =>
          (
            this.#s.arrivals.all(keys(asked)) as {
              id: Id;
              seq: number;
              arrival: string;
              lost: number;
            }[]
          ).map((r) => {
            if (r.lost === 1) storedClaims(null, r.id, peer);
            return arrivalRead(r.arrival, peer, r.id, r.seq, now.maxTransfer);
          }),
        );
      },
      targets: async (entities) => {
        const asked = sorted(strings(entities, "targets: entities"));
        return at(() => found(this.#s.targets.all(keys(asked)) as { delta: Id; lost: number }[]));
      },
      negators: async (ids) => {
        const asked = sorted(strings(ids, "negators: ids"));
        return at(() => found(this.#s.negators.all(keys(asked)) as { delta: Id; lost: number }[]));
      },
      scope: async (request) => {
        const { anchors, asked, exclude } = takeScope(request);
        return at((now) => {
          const entities: string[] = [];
          for (const anchor of anchors) {
            if (anchor.kind !== "entity")
              throw new StoreError(
                "capability-absent",
                "scope: this store serves entity anchors only",
              );
            entities.push(anchor.entity as string);
          }
          const rows = this.#s.scope.all({
            peer,
            anchors: JSON.stringify(entities),
            bound: Math.min(bound, asked.arrivalAtMost ?? bound),
            timestamp: asked.timestampAtMost ?? null,
            drop: JSON.stringify(asked.excludeIds ?? []),
            exclude: JSON.stringify(exclude),
          }) as (DeltaRow & { seq: number; arrival: string })[];
          return {
            deltas: rows.map((r) => ({
              delta: this.#delta(r, peer),
              arrival: arrivalRead(r.arrival, peer, r.id, r.seq, now.maxTransfer),
            })),
            applied: {
              timestampAtMost: asked.timestampAtMost !== undefined,
              arrivalAtMost: asked.arrivalAtMost !== undefined,
              excludeIds: asked.excludeIds !== undefined,
            },
          };
        });
      },
      release: () => {
        released = true;
      },
    };
  }

  #changes(peer: PeerId, from: unknown, to: unknown): ChangePage {
    const revision = (value: unknown, what: string): Revision => {
      if (!(Number.isSafeInteger(value) && (value as number) >= 0))
        throw new StoreError("invalid-request", `changes: ${what} must be an integer, 0 or more`);
      return value as number;
    };
    const after = revision(from, "from");
    const upTo = to === undefined ? undefined : revision(to, "to");
    if (upTo !== undefined && upTo < after)
      throw new StoreError("invalid-request", "changes: to must not be less than from");
    return this.#run("read", () => {
      const { revision: current, floor } = this.#peerRow(peer)!;
      if (after > current || after < floor) return { status: "resync-required", current };
      const end = Math.min(upTo ?? current, current);
      const rows = this.#s.changes.all({
        peer,
        from: after,
        to: end,
        limit: this.#pageSize,
      }) as ChangeRow[];
      const records: ChangeRecord[] = rows.map((r) => {
        const ids = changeOf(r, peer);
        if ("kind" in ids) throw new StoreIntegrityError(ids);
        return { revision: r.revision, head: r.head ?? null, ...ids };
      });
      const through = records.length === this.#pageSize ? records.at(-1)!.revision : end;
      return { status: "ok", records, through };
    });
  }

  /**
   * Writes the change record of a revision advance and the peer row with it, and drops the
   * oldest record when the peer keeps more than its retention.
   */
  #advance(peer: PeerId, row: PeerRow, next: PeerRow, added: Id[], removed: Id[]): void {
    this.#s.changeAdd.run(
      peer,
      next.revision,
      next.head,
      JSON.stringify(added),
      JSON.stringify(removed),
    );
    if (next.revision - row.floor > this.#keep) {
      next.floor = row.floor + 1;
      this.#s.changeDrop.run(peer, next.floor);
    }
    const { revision, floor, head, count, maxSeq, removedAt, maxTransfer } = next;
    this.#s.peerAdvance.run({ peer, revision, floor, head, count, maxSeq, removedAt, maxTransfer });
  }

  #append(peer: PeerId, batch: unknown): AppendResult {
    const { expectedHead, nextHead, added } = takeAppend(batch);
    // The entries are copied and checked before the write lock is taken. A refusal among them
    // still waits for the head compare-and-set, which answers first, as in the memory store.
    let entries: Admitted[] | undefined;
    let refusal: unknown;
    try {
      if (!Array.isArray(added))
        throw new StoreError("invalid-admission", "append: the added entries must be a list");
      entries = added.map((entry: unknown) => admit(entry));
    } catch (error) {
      refusal = error;
    }
    return this.#run(
      "write",
      (): AppendResult => {
        const row = this.#peerRow(peer)!;
        if (row.head !== expectedHead) return { status: "conflict" };
        if (entries === undefined) throw refusal;
        const fresh = new Map<Id, Admitted>();
        const sequences = new Set<number>();
        let maxSeq = row.maxSeq;
        let maxTransfer = row.maxTransfer;
        for (const entry of entries) {
          if (fresh.has(entry.id) || this.#s.holdingFind.get(peer, entry.id) !== undefined)
            continue;
          const sequence = entry.arrival.sequence;
          if (sequence <= row.maxSeq || sequences.has(sequence))
            throw new StoreError(
              "invalid-admission",
              "append: an arrival sequence does not pass the peer's last sequence",
            );
          if (entry.arrival.transfer <= row.maxTransfer)
            throw new StoreError(
              "invalid-admission",
              "append: a transfer ordinal does not pass the peer's last transfer",
            );
          sequences.add(sequence);
          maxSeq = Math.max(maxSeq, sequence);
          maxTransfer = Math.max(maxTransfer, entry.arrival.transfer);
          fresh.set(entry.id, entry);
        }
        for (const { id, claims, sig, arrival } of fresh.values()) {
          this.#s.deltaAdd.run(id, canonicalBytes(claims), claims.author, claims.timestamp);
          this.#s.holdingAdd.run(
            peer,
            id,
            arrival.sequence,
            arrivalText(arrival),
            sig ?? null,
            claims.author,
          );
          for (const { role, target } of claims.pointers)
            if (target.kind === "entity") this.#s.targetAdd.run(peer, target.entity.id, id);
            else if (target.kind === "delta")
              this.#s.referenceAdd.run(peer, target.deltaRef.delta, role, id);
          this.#s.debtDrop.run(peer, id);
          // A record of a removal speaks of bytes that left the file. A holding of the id ends it.
          this.#s.surfaceDebtClose.run(id);
        }
        const ids = sorted(fresh.keys());
        if (ids.length === 0 && row.head === nextHead)
          return { status: "committed", revision: row.revision, added: [] };
        const next: PeerRow = {
          ...row,
          revision: row.revision + 1,
          head: nextHead,
          count: row.count + ids.length,
          maxSeq,
          maxTransfer,
        };
        this.#advance(peer, row, next, ids, []);
        return { status: "committed", revision: next.revision, added: ids };
      },
      (error) => ({
        status: "uncertain",
        fault: `the SQLite store could not commit (${error instanceof Database.SqliteError ? error.code : "unknown"})`,
      }),
    );
  }

  /**
   * The purge (plan §6, §7). The first transaction removes the holdings and writes the change
   * record; the triggers count each deleted row. A peer of posture `proven` then rebuilds while
   * the file is not clean, and always empties the log. The last transaction decides the whole
   * report from what it reads, so the report is true at its commit (§4.13 reading 115). It
   * consumes every record it answers from, and nothing before it does. When it finds frames in
   * the log, a peer of posture `proven` lets go of the lock, empties the log and tries again; the
   * last try answers without the proof (reading 119).
   */
  #purge(peer: PeerId, ids: readonly Id[]): PurgeReport {
    const s = this.#s;
    const asked = sorted(ids);
    const first = this.#run("write", () => {
      const row = this.#peerRow(peer)!;
      const proving = ERASURE_CLASS === "proven" && row.posture === "proven";
      const released: Id[] = [];
      for (const id of asked) {
        if (s.holdingFind.get(peer, id) === undefined) continue;
        s.holdingDrop.run(peer, id);
        released.push(id);
        if (s.heldElsewhere.get(id) !== undefined) s.debtAdd.run(peer, id);
        else {
          s.deltaDrop.run(id);
          // The record of the removal, in the delete's transaction: a crash after it keeps the
          // peer's later proof (decision S4-13).
          if (proving) s.surfaceDebtAdd.run(peer, id);
        }
      }
      if (released.length > 0)
        this.#advance(
          peer,
          row,
          {
            ...row,
            revision: row.revision + 1,
            count: row.count - released.length,
            removedAt: row.revision + 1,
          },
          [],
          released,
        );
      return { proving, released: new Set(released), dirty: !this.#clean() };
    });
    let proof = first.proving ? this.#rebuild(first.dirty) : undefined;
    for (let tries = 1; ; tries++) {
      try {
        return this.#run("write", () => this.#decide(peer, asked, first, proof, tries));
      } catch (error) {
        if (error !== LOG_NOT_EMPTY) throw error;
        if (!this.#truncate()) proof = undefined;
      }
    }
  }

  /**
   * The body of a purge's last transaction (§4.13 readings 115, 117 and 119). It runs under the
   * write lock and decides the whole report from what it reads.
   */
  #decide(
    peer: PeerId,
    asked: readonly Id[],
    first: { proving: boolean; released: ReadonlySet<Id> },
    proof: { d: number | undefined } | undefined,
    tries: number,
  ): PurgeReport {
    const s = this.#s;
    // Only the holder of the write lock writes frames, and a writer that failed or died never
    // shrinks the log. An empty log now holds no frame of any writer, committed or not.
    const empty = this.#logEmpty();
    if (proof !== undefined && !empty && tries < LAST_TRIES) throw LOG_NOT_EMPTY;
    if (empty && proof?.d !== undefined) s.residueClean.run(proof.d);
    const clean = empty && this.#clean();
    let left = false;
    // Each answer reads the state now, under the write lock: another process may have appended
    // or purged the id since the first transaction.
    const answer = (id: Id): PurgeOutcome => {
      const present = s.deltaFind.get(id) !== undefined;
      if (first.released.has(id)) {
        left ||= (s.indexLeft.get({ peer, id }) as { found: number }).found === 1;
        if (present) {
          if (s.holdingFind.get(peer, id) === undefined) s.debtAdd.run(peer, id);
          return "held-by-other-peer";
        }
        s.debtDrop.run(peer, id);
        if (first.proving) s.surfaceDebtAdd.run(peer, id);
        return "removed";
      }
      if (s.debtFind.get(peer, id) !== undefined) {
        if (present) return "held-by-other-peer";
        s.debtDrop.run(peer, id);
        // Another peer's purge removed the bytes. While the file is not clean, this peer gets
        // a record, so that a later ask can give the proof.
        if (first.proving && !clean) s.surfaceDebtAdd.run(peer, id);
        return "removed";
      }
      if (s.surfaceDebtFind.get(peer, id) === undefined) return "not-held";
      if (present) return "held-by-other-peer";
      // The later proof (decision S4-13): the record ends once the file is clean.
      if (clean) s.surfaceDebtDrop.run(peer, id);
      return "removed";
    };
    const targets = asked.map((id) => ({ id, outcome: answer(id) }));
    // The surfaces that may still hold the id of a target this peer released or owes. The list
    // may name one that no longer does; it never omits one that does (decision S4-5).
    const named = targets.filter((t) => t.outcome !== "not-held").map((t) => t.id);
    const retains: PurgeReport["retains"][number][] = [{ surface: "change-feed", holds: "id" }];
    if (named.some((id) => s.debtNames.get(id) !== undefined))
      retains.push({ surface: "purge-debt", holds: "id" });
    if (named.some((id) => s.surfaceDebtNames.get(id) !== undefined))
      retains.push({ surface: "surface-debt", holds: "id" });
    const files = clean ? "absent" : "owed";
    const surfaces: PurgeReport["surfaces"] = [
      { surface: "rows", state: files },
      { surface: "index-entries", state: left ? "owed" : files },
      { surface: "page-free-space", state: files },
      { surface: "freed-pages", state: files },
      { surface: "write-ahead-log", state: files },
      { surface: "temp-files", state: ERASURE_CLASS === "proven" ? files : "unprovable" },
    ];
    return {
      claim: !targets.some((t) => t.outcome === "removed")
        ? "nothing-removed"
        : first.proving && surfaces.every((surface) => surface.state === "absent")
          ? "proven"
          : "unproven",
      boundary: PURGE_BOUNDARY,
      // The peer's revision at this commit, which the report speaks for (reading 115).
      revision: this.#peerRow(peer)!.revision,
      targets,
      surfaces,
      retains,
    };
  }

  /** `clean = dirty`: a rebuild began after the last delete or update of an erasable row. */
  #clean(): boolean {
    const { dirty, clean } = this.#s.residueRead.get() as { dirty: number; clean: number };
    return clean === dirty;
  }

  /**
   * The log file is there and empty, and the database file has one name only: a second hard link
   * has a log of its own, which this stat cannot see. A path stat opens no descriptor, so it drops
   * no lock.
   */
  #logEmpty(): boolean {
    try {
      return statSync(this.#file).nlink === 1 && statSync(`${this.#file}-wal`).size === 0;
    } catch {
      return false;
    }
  }

  /**
   * Rebuilds the pages when the file is not clean, and always empties the log. Answers `{d}`,
   * the count of deletes it read before `VACUUM` (none when it ran none), when every step
   * succeeded, and `undefined` otherwise. A delete that commits after that read raises `dirty`
   * past `d`, so the file stays not clean, whichever step it fell between.
   */
  #rebuild(dirty: boolean): { d: number | undefined } | undefined {
    const s = this.#s;
    let d: number | undefined;
    if (dirty)
      try {
        d = this.#run("read", () => s.residueDirty.get() as { dirty: number }).dirty;
        s.vacuum.run();
      } catch {
        return undefined;
      }
    return this.#truncate() ? { d } : undefined;
  }

  /**
   * Empties the log. A busy checkpoint answers a row and does not throw. Until it truncates,
   * the old pages stay in the database file and the log.
   */
  #truncate(): boolean {
    try {
      const { busy, log } = this.#s.checkpoint.get() as { busy: number; log: number };
      return busy === 0 && log === 0;
    } catch {
      return false;
    }
  }

  openAdmin(): SqliteExporter {
    this.#open();
    const s = this.#s;
    const read = <T>(body: () => T): T => {
      this.#open();
      return this.#run("read", body);
    };
    const held = (peer: PeerId): void => {
      if (!(typeof peer === "string" && wellFormed(peer) && read(() => this.#peerRow(peer))))
        throw new StoreError("peer-absent", "export: no such peer");
    };
    // Each page is one short statement after the last key of the page before it, so a listing
    // never holds a transaction open between pages. `first` runs when the listing is first read.
    async function* pages<T>(
      page: (after: string) => { key: string; value: T }[],
      first = (): void => undefined,
    ) {
      first();
      for (let after = ""; ; ) {
        const found = page(after);
        for (const { value } of found) yield value;
        if (found.length < EXPORT_PAGE) return;
        after = found.at(-1)!.key;
      }
    }
    const ids =
      (statement: BetterSqlite3.Statement, ...args: unknown[]) =>
      (after: string) =>
        read(() => statement.all(...args, after, EXPORT_PAGE) as Record<string, string>[]).map(
          (r) => {
            const key = Object.values(r)[0]!;
            return { key, value: key };
          },
        );
    return {
      peers: () => pages(ids(s.exportPeers)),
      peer: (peer) => ({
        ids: () => pages(ids(s.exportIds, peer), () => held(peer)),
        deltas: () =>
          pages(
            (after) =>
              read(() => s.exportDeltas.all(peer, after, EXPORT_PAGE) as DeltaRow[]).map((r) => ({
                key: r.id,
                value: this.#delta(r, peer),
              })),
            () => held(peer),
          ),
      }),
      storedIds: () => pages(ids(s.exportStored)),
      fsck: () => this.#fsck(),
      connection: () => {
        this.#open();
        return this.#connection();
      },
    };
  }

  /**
   * `fsck` (§4.13 reading 137). Each step is one short read transaction, and the store yields to
   * the host's event loop between steps, so no transaction and no lock is held between them and a
   * write by this store or another connection commits between them. A step reads every fact it
   * compares in its own transaction, so each fault held at that step's moment. Keyset pages visit
   * every row that exists for the whole scan. The steps: the engine's checks; for each peer, its
   * count and change records against its row; for each page of 256 of its change records, the
   * form of each; for each page of 256 of its holdings, each holding's claims, signature,
   * columns, arrival record, sequence, transfer and index entries; for each page of 256 stored
   * deltas, whether any peer holds it. A step that meets a damaged page ends the scan, and the
   * report names it as one `engine` fault.
   */
  async #fsck(): Promise<FsckReport> {
    this.#open();
    const s = this.#s;
    const faults: IntegrityFault[] = [];
    const checked = { peers: 0, holdings: 0, deltas: 0 };
    // A step whose read meets a page the engine cannot read throws `Unreadable`; the scan stops
    // there and the report names it as an `engine` fault. Any other error rejects as before.
    const step = async <T>(body: () => T): Promise<T> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.#open();
      return this.#run("read", () => {
        try {
          return body();
        } catch (error) {
          if (error instanceof Database.SqliteError && /^SQLITE_(CORRUPT|NOTADB)/.test(error.code))
            throw new Unreadable(error.code);
          throw error;
        }
      });
    };
    try {
      await step(() => {
        for (const row of s.fsckEngine.all() as Record<string, string>[]) {
          const text = Object.values(row)[0];
          if (text !== "ok")
            faults.push({ kind: "engine", detail: `sqlite store: integrity_check: ${text}` });
        }
        for (const row of s.fsckForeignKeys.all() as { table: string; parent: string }[])
          faults.push({
            kind: "engine",
            key: row.table,
            detail: `sqlite store: foreign_key_check: a row of ${row.table} names no row of ${row.parent}`,
          });
      });
      for (let after = "", found = EXPORT_PAGE; found === EXPORT_PAGE; ) {
        const peers = await step(() =>
          (s.exportPeers.all(after, EXPORT_PAGE) as { id: PeerId }[]).map((r) => r.id),
        );
        for (const peer of peers) {
          if (!(await step(() => this.#fsckPeer(peer, faults)))) continue;
          checked.peers++;
          for (let from = Number.MIN_SAFE_INTEGER, page = EXPORT_PAGE; page === EXPORT_PAGE; ) {
            const rows = await step(
              () => s.fsckChanges.all(peer, from, EXPORT_PAGE) as ChangeRow[],
            );
            for (const r of rows) {
              const ids = changeOf(r, peer);
              if ("kind" in ids) faults.push(ids);
            }
            page = rows.length;
            from = rows.at(-1)?.revision ?? from;
          }
          for (let from = "", page = EXPORT_PAGE; page === EXPORT_PAGE; ) {
            const last = await step(() => this.#fsckHoldings(peer, from, faults));
            if (last === undefined) break;
            checked.holdings += last.count;
            page = last.count;
            from = last.id;
          }
        }
        found = peers.length;
        after = peers.at(-1) ?? after;
      }
      for (let after = "", found = EXPORT_PAGE; found === EXPORT_PAGE; ) {
        const stored = await step(() => {
          const ids = (s.exportStored.all(after, EXPORT_PAGE) as { id: Id }[]).map((r) => r.id);
          for (const id of ids)
            if (s.heldElsewhere.get(id) === undefined)
              faults.push({
                kind: "orphan-bytes",
                id,
                detail: "sqlite store: no peer holds these bytes",
              });
          return ids;
        });
        checked.deltas += stored.length;
        found = stored.length;
        after = stored.at(-1) ?? after;
      }
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      faults.push({
        kind: "engine",
        detail: `sqlite store: the engine cannot read a page of the file (${error.code}); the scan stopped there`,
      });
    }
    return { checked, faults };
  }

  /** A peer's count and change records against its row. False when the peer is gone. */
  #fsckPeer(peer: PeerId, faults: IntegrityFault[]): boolean {
    const s = this.#s;
    const row = this.#peerRow(peer);
    if (row === undefined) return false;
    const { held } = s.fsckCount.get(peer) as { held: number };
    if (held !== row.count)
      faults.push({
        kind: "count-mismatch",
        peer,
        detail: `sqlite store: the peer's count is ${row.count} and it holds ${held}`,
      });
    const feed = s.fsckFeed.get(peer) as { kept: number; low: number | null; high: number | null };
    if (
      feed.kept !== row.revision - row.floor ||
      (feed.kept > 0 && (feed.low !== row.floor + 1 || feed.high !== row.revision))
    )
      faults.push({
        kind: "feed-gap",
        peer,
        detail: `sqlite store: the peer keeps ${feed.kept} change records from ${feed.low} to ${feed.high}, at floor ${row.floor} and revision ${row.revision}`,
      });
    return true;
  }

  /**
   * One page of a peer's holdings, each against its claims, its arrival record and the peer's
   * row. Answers the count and the last id of the page, or nothing when the peer is gone.
   */
  #fsckHoldings(
    peer: PeerId,
    after: Id,
    faults: IntegrityFault[],
  ): { count: number; id: Id } | undefined {
    const s = this.#s;
    const row = this.#peerRow(peer);
    if (row === undefined) return undefined;
    const rows = s.fsckHoldings.all(peer, after, EXPORT_PAGE) as FsckRow[];
    for (const held of rows) {
      const id = held.id;
      const fault = (kind: IntegrityFault["kind"], key: string, detail: string): void => {
        faults.push({ kind, peer, id, key, detail: `sqlite store: ${detail}` });
      };
      let claims: Claims;
      try {
        claims = storedClaims(held.claims && new Uint8Array(held.claims), id, peer);
      } catch (error) {
        if (!(error instanceof StoreIntegrityError)) throw error;
        faults.push(error.fault);
        continue;
      }
      const sig = sigFault(held.sig, peer, id);
      if (sig !== undefined) faults.push(sig);
      if (held.heldAuthor !== claims.author)
        fault(
          "column-mismatch",
          "holding.author",
          "the holding's author is not the claims' author",
        );
      if (held.author !== claims.author)
        fault("column-mismatch", "delta.author", "the stored author is not the claims' author");
      if (held.timestamp !== claims.timestamp)
        fault("column-mismatch", "delta.timestamp", "the stored timestamp is not the claims'");
      const arrival = arrivalOf(held.arrival, peer, id, held.seq, row.maxTransfer);
      if ("kind" in arrival && arrival.kind === "column-mismatch") faults.push(arrival);
      if (held.seq > row.maxSeq)
        fault(
          "sequence-mismatch",
          "seq",
          `sequence ${held.seq} passes the peer's last ${row.maxSeq}`,
        );
      if ("kind" in arrival && arrival.kind === "sequence-mismatch") faults.push(arrival);
      const entities = new Set<string>();
      const references = new Map<string, string>();
      for (const { role, target } of claims.pointers)
        if (target.kind === "entity") entities.add(target.entity.id);
        else if (target.kind === "delta")
          references.set(JSON.stringify([target.deltaRef.delta, role]), target.deltaRef.delta);
      for (const { entity } of s.fsckTargets.all(peer, id) as { entity: string }[])
        if (!entities.delete(entity))
          fault("index-stray", entity, "a target entry that the claims do not name");
      for (const entity of entities)
        fault("index-missing", entity, "the claims name an entity that has no target entry");
      for (const { ref, role } of s.fsckReferences.all(peer, id) as { ref: Id; role: string }[])
        if (!references.delete(JSON.stringify([ref, role])))
          fault("index-stray", ref, `a reference entry (${role}) that the claims do not name`);
      for (const [pair, ref] of references)
        fault(
          "index-missing",
          ref,
          `the claims name a reference (${(JSON.parse(pair) as string[])[1]}) that has no entry`,
        );
    }
    return { count: rows.length, id: rows.at(-1)?.id ?? after };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#s.checkpoint.get();
    } catch {
      // Another connection holds the log; it is truncated at a later close.
    }
    this.#db.close();
  }
}

/**
 * Opens the SQLite store in the file at `path`, and creates it when the file is new or empty.
 * Refuses `open-failed` for a file that is not a store of this format, and `invalid-request` for
 * options of the wrong type and for a retention other than the file keeps.
 *
 * Importing this module registers the `sqlite` scheme of `openStore`. A host that registered its
 * own `sqlite` factory first keeps the scheme: the import neither replaces it nor fails. This
 * function always opens this store, whoever holds the scheme.
 */
export async function openSqliteStore(
  path: string,
  options?: SqliteStoreOptions,
): Promise<SqliteStore> {
  const own = takeOptions(options);
  // The engine ends a path at U+0000, so such a path names another file.
  if (typeof path !== "string" || path === "" || path.includes("\0"))
    throw new StoreError(
      "invalid-request",
      "sqlite store: the path is a non-empty string without U+0000",
    );
  let db: BetterSqlite3.Database;
  try {
    db = new Database(path);
  } catch {
    throw new StoreError("open-failed", "sqlite store: the file did not open");
  }
  try {
    return new SqliteFileStore(db, own);
  } catch (error) {
    db.close();
    if (error instanceof StoreError) throw error;
    throw notOpened(error);
  }
}

const URL_FORM = 'store scheme "sqlite" takes a file address: sqlite:///path/to/file.db';

const fromUrl = async (url: string, options: OpenOptions): Promise<Store> => {
  let path: string;
  try {
    if (!/^sqlite:\/\//i.test(url)) throw new TypeError("form");
    const file = new URL(`file:${url.slice("sqlite:".length)}`);
    if (file.search !== "" || file.hash !== "") throw new TypeError("form");
    path = fileURLToPath(file);
    if (path.includes("\0")) throw new TypeError("form");
  } catch {
    throw new StoreError("invalid-url", URL_FORM);
  }
  // Before the file opens: an open can create the file or give its peers new histories, and a
  // refused open changes nothing. Only `changes` reads the retention, and it fails only for
  // `none`, which no file of this store keeps (§4.13 reading 126).
  refuseMissing("sqlite", profileOf(DEFAULT_RETENTION), options.requires ?? []);
  return openSqliteStore(path, options.restored === true ? { restored: true } : {});
};

// Loading this module never fails on the registration. When `sqlite` is taken (by a host's own
// factory, or by this module evaluated once before), the scheme stays as it is.
try {
  registerStoreScheme("sqlite", fromUrl);
} catch (error) {
  if (!(error instanceof Error && (error as { code?: unknown }).code === "scheme-exists"))
    throw error;
}
