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
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { compareUtf8, decode, type CborValue } from "../delta/cbor.js";
import { canonicalBytes } from "../delta/delta.js";
import { contentAddress } from "../delta/hash.js";
import type { Claims, Delta, Pointer, Target } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import { isPlainObject } from "./copy.js";
import { LOCAL_HISTORY_PREFIX } from "./freshness.js";
import { registerStoreScheme, type OpenOptions } from "./open-store.js";
import { admit, strings, takeAppend, takeScope, wellFormed, type Admitted } from "./request.js";
import { SQLITE_SCHEMA, SQLITE_STATEMENTS } from "./sqlite-statements.js";
import {
  PURGE_BOUNDARY,
  StoreError,
  type AppendResult,
  type ChangePage,
  type ChangeRecord,
  type CreatePeerOptions,
  type ErasureClass,
  type ErasurePosture,
  type Exporter,
  type History,
  type Id,
  type PeerId,
  type PeerStore,
  type PurgeOutcome,
  type PurgeReport,
  type Revision,
  type Snapshot,
  type Store,
  type StoreProfile,
} from "./store.js";

export const SQLITE_STORE_FORMAT = "rhizomatic-store-sqlite/3";

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
// wait comes first: `journal_mode` reads the file, and must wait only as long as the host asked.
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

type Statements = { readonly [K in keyof typeof SQLITE_STATEMENTS]: Database.Statement };
type PeerRow = {
  posture: ErasurePosture;
  storeClass: ErasureClass;
  history: History;
  revision: Revision;
  floor: Revision;
  head: string | null;
  count: number;
  maxSeq: number;
};
type DeltaRow = { id: Id; claims: Uint8Array; sig: string | null };

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

const arrivalText = (arrival: ArrivalRecord): string =>
  JSON.stringify({
    id: arrival.id,
    at: arrival.at,
    sequence: arrival.sequence,
    transfer: arrival.transfer,
    sender: arrival.sender,
  });

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
  const { busyTimeoutMs, changeRetention, changePageSize, mintHistory, restored } = (options ??
    {}) as Record<string, unknown>;
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
    const revisions = isPlainObject(changeRetention) ? changeRetention["revisions"] : undefined;
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

// ---- the store --------------------------------------------------------------------------------

class SqliteFileStore implements SqliteStore {
  readonly profile: StoreProfile;
  readonly #db: Database.Database;
  readonly #s: Statements;
  readonly #begin: Database.Statement;
  readonly #beginWrite: Database.Statement;
  readonly #commit: Database.Statement;
  readonly #rollback: Database.Statement;
  readonly #keep: number;
  readonly #pageSize: number;
  readonly #mint: ((peer: PeerId) => History) | undefined;
  readonly #rules: ReturnType<typeof RULES>;
  readonly #file: string;
  #closed = false;

  constructor(db: Database.Database, options: OwnOptions) {
    this.#db = db;
    this.#rules = RULES(options.busyTimeoutMs);
    for (const [name, value] of this.#rules) db.pragma(`${name} = ${value}`);
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
    const retention = this.#run("write", () => this.#format(options.changeRetention));
    this.#s = Object.fromEntries(
      Object.entries(SQLITE_STATEMENTS).map(([name, sql]) => [name, db.prepare(sql)]),
    ) as unknown as Statements;
    this.#keep = retention === "unbounded" ? Number.POSITIVE_INFINITY : retention.revisions;
    this.#pageSize = options.pageSize;
    this.#mint = options.mint;
    this.#run("write", () => this.#identify(options.restored));
    this.profile = Object.freeze({
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

  /** Creates the schema in an empty file, or checks the format and retention of a store. */
  #format(asked: Retention | undefined): Retention {
    const db = this.#db;
    const meta = (key: string): string | undefined =>
      (db.prepare(SQLITE_STATEMENTS.metaGet).get(key) as { value: string } | undefined)?.value;
    const { size } = db.prepare(SQLITE_STATEMENTS.schemaSize).get() as { size: number };
    if (size === 0) {
      const retention = asked ?? DEFAULT_RETENTION;
      db.exec(SQLITE_SCHEMA);
      const put = db.prepare(SQLITE_STATEMENTS.metaSet);
      put.run("format", SQLITE_STORE_FORMAT);
      put.run("retention", JSON.stringify(retention));
      return retention;
    }
    let format: string | undefined;
    try {
      format = meta("format");
    } catch {
      format = undefined;
    }
    if (format !== SQLITE_STORE_FORMAT)
      throw new StoreError(
        "open-failed",
        format === undefined
          ? "sqlite store: the file is not a rhizomatic store"
          : `sqlite store: the file holds format ${format}, and this store reads ${SQLITE_STORE_FORMAT}`,
      );
    const kept = meta("retention")!;
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

  /** The delta of a stored row. Bytes that do not hash to their id fail the read. */
  #delta(row: DeltaRow): Delta {
    const bytes = new Uint8Array(row.claims);
    if (contentAddress(bytes) !== row.id)
      throw new Error("sqlite store: stored claims do not hash to their id");
    const claims = claimsOf(bytes);
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
    try {
      if (isPlainObject(options)) posture = options["erasure"];
    } catch {
      posture = undefined;
    }
    if (posture !== "proven" && posture !== "unproven")
      throw new StoreError("invalid-request", "createPeer: declare the erasure posture");
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
      this.#s.peerAdd.run(id, posture, storeClass, history);
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
    return {
      id,
      get history() {
        return history();
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
    const { history, revision } = row;
    let released = false;
    // One short read transaction per call: the revision is checked first, so a call on a moved
    // snapshot refuses also when it would find no rows (decision S4-2).
    const at = <T>(body: () => T): T => {
      this.#open();
      if (released) throw new StoreError("snapshot-released", "the snapshot was released");
      return this.#run("read", () => {
        const now = this.#peerRow(peer);
        if (now?.history !== history || now.revision !== revision)
          throw new StoreError("snapshot-moved", "the peer moved past this snapshot's revision");
        return body();
      });
    };
    const keys = (ids: readonly Id[]) => ({ peer, keys: JSON.stringify(ids) });
    return {
      revision,
      history,
      head: row.head,
      count: row.count,
      get: async (ids) => {
        const asked = sorted(strings(ids, "get: ids"));
        return at(() => (this.#s.get.all(keys(asked)) as DeltaRow[]).map((r) => this.#delta(r)));
      },
      arrivals: async (ids) => {
        const asked = sorted(strings(ids, "arrivals: ids"));
        return at(() =>
          (this.#s.arrivals.all(keys(asked)) as { arrival: string }[]).map(
            (r) => JSON.parse(r.arrival) as ArrivalRecord,
          ),
        );
      },
      targets: async (entities) => {
        const asked = sorted(strings(entities, "targets: entities"));
        return at(() => (this.#s.targets.all(keys(asked)) as { delta: Id }[]).map((r) => r.delta));
      },
      negators: async (ids) => {
        const asked = sorted(strings(ids, "negators: ids"));
        return at(() => (this.#s.negators.all(keys(asked)) as { delta: Id }[]).map((r) => r.delta));
      },
      scope: async (request) => {
        const { anchors, asked, exclude } = takeScope(request);
        return at(() => {
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
            seq: asked.arrivalAtMost ?? null,
            timestamp: asked.timestampAtMost ?? null,
            drop: JSON.stringify(asked.excludeIds ?? []),
            exclude: JSON.stringify(exclude),
          }) as (DeltaRow & { arrival: string })[];
          return {
            deltas: rows.map((r) => ({
              delta: this.#delta(r),
              arrival: JSON.parse(r.arrival) as ArrivalRecord,
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
      const rows = this.#s.changes.all({ peer, from: after, to: end, limit: this.#pageSize }) as {
        revision: Revision;
        head: string | null;
        added: string;
        removed: string;
      }[];
      const records: ChangeRecord[] = rows.map((r) => ({
        revision: r.revision,
        head: r.head,
        added: JSON.parse(r.added) as Id[],
        removed: JSON.parse(r.removed) as Id[],
      }));
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
    const { revision, floor, head, count, maxSeq } = next;
    this.#s.peerAdvance.run({ peer, revision, floor, head, count, maxSeq });
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
        for (const entry of entries) {
          if (fresh.has(entry.id) || this.#s.holdingFind.get(peer, entry.id) !== undefined)
            continue;
          const sequence = entry.arrival.sequence;
          if (sequence <= row.maxSeq || sequences.has(sequence))
            throw new StoreError(
              "invalid-admission",
              "append: an arrival sequence does not pass the peer's last sequence",
            );
          sequences.add(sequence);
          maxSeq = Math.max(maxSeq, sequence);
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
          { ...row, revision: row.revision + 1, count: row.count - released.length },
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
      (statement: Database.Statement, ...args: unknown[]) =>
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
                value: this.#delta(r),
              })),
            () => held(peer),
          ),
      }),
      storedIds: () => pages(ids(s.exportStored)),
      connection: () => {
        this.#open();
        return this.#connection();
      },
    };
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
  let db: Database.Database;
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
    throw new StoreError(
      "open-failed",
      `sqlite store: the file did not open (${error instanceof Database.SqliteError ? error.code : "unknown"})`,
    );
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
