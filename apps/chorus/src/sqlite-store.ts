// The SQLite backend: the second witness to the `StoreBackend` interface (store-tier.ts). Where the
// JSONL tier is the legible flat file, this is the concurrency + indexed-read tier — real
// transactional writes (no lock-directory dance, the `field-bug:post-hang` failure mode gone)
// and B-tree indexes over pointer targets and values, so `recall`/`backlinks`/`gql-prepare`
// stop scanning the whole surviving set.
//
// It stays one notch up from a flat file, deliberately: better-sqlite3 (synchronous, embedded,
// one file), one table of deltas keyed by id plus a pointer index. The CRDT is still the safety
// net — a row per delta, deduped by id (UNIQUE), is correct by construction. The canonical
// claims JSON + signature are stored verbatim; the id is recomputed on read via `makeDelta`,
// exactly as the JSONL refresh rehydrates, so the bytes are never trusted blindly.

import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import {
  DeltaSet,
  claimsToJson,
  makeDelta,
  parseClaims,
  viewCanonicalHex,
  type Delta,
  type Primitive,
} from "@bombadil/rhizomatic";
import type { ChorusAgent } from "./agent.js";
import type { StoreBackend } from "./store-tier.js";

interface DeltaRow {
  readonly seq: number;
  readonly id: string;
  readonly claims: string;
  readonly sig: string | null;
}

export class SqliteStore implements StoreBackend {
  private readonly db: Database.Database;
  // refresh's cursor: every row with seq <= lastSeq has been read into this instance's agent.
  // SQLite serializes writers, so AUTOINCREMENT seq commits in order — no out-of-order gap can
  // sneak in below the cursor. Writes never advance it; a future refresh re-reads our own rows
  // (the agent dedups them) — bounded, correct, and far simpler than a write-side watermark.
  private lastSeq = 0;
  // Ids known durable (read or written by us): skip re-inserting them. UNIQUE(id) is the real
  // guard against concurrent double-writes; this is just the cheap fast-path.
  private readonly onDisk = new Set<string>();

  private readonly insertDelta: Database.Statement;
  private readonly insertPointer: Database.Statement;
  private readonly selectSince: Database.Statement;
  private readonly selectAll: Database.Statement;
  private readonly selectByTarget: Database.Statement;
  private readonly selectByValue: Database.Statement;
  private readonly appendTxn: Database.Transaction;

  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    // WAL + a busy timeout makes concurrent processes wait their turn rather than fail; NORMAL
    // syncs are durable under WAL (a crash loses at most the last uncommitted txn — the CRDT
    // tolerates that, the peer re-sends).
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deltas (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        id     TEXT NOT NULL UNIQUE,
        claims TEXT NOT NULL,
        sig    TEXT
      );
      CREATE TABLE IF NOT EXISTS pointers (
        delta_id  TEXT NOT NULL,
        role      TEXT NOT NULL,
        target_id TEXT,
        value_key TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pointers_target ON pointers(target_id);
      CREATE INDEX IF NOT EXISTS idx_pointers_role_value ON pointers(role, value_key);
    `);

    this.insertDelta = this.db.prepare(
      "INSERT OR IGNORE INTO deltas (id, claims, sig) VALUES (@id, @claims, @sig)",
    );
    this.insertPointer = this.db.prepare(
      "INSERT INTO pointers (delta_id, role, target_id, value_key) VALUES (@delta_id, @role, @target_id, @value_key)",
    );
    this.selectSince = this.db.prepare(
      "SELECT seq, id, claims, sig FROM deltas WHERE seq > ? ORDER BY seq",
    );
    this.selectAll = this.db.prepare("SELECT seq, id, claims, sig FROM deltas ORDER BY seq");
    this.selectByTarget = this.db.prepare(
      "SELECT DISTINCT d.seq, d.id, d.claims, d.sig FROM deltas d " +
        "JOIN pointers p ON p.delta_id = d.id WHERE p.target_id = ? ORDER BY d.seq",
    );
    this.selectByValue = this.db.prepare(
      "SELECT DISTINCT d.seq, d.id, d.claims, d.sig FROM deltas d " +
        "JOIN pointers p ON p.delta_id = d.id WHERE p.role = ? AND p.value_key = ? ORDER BY d.seq",
    );

    // The write path runs as one IMMEDIATE transaction: acquire the write lock up front so the
    // inserts + their pointer-index rows commit atomically, and concurrent writers wait.
    this.appendTxn = this.db.transaction((deltas: readonly Delta[]) => {
      let count = 0;
      for (const d of deltas) {
        const info = this.insertDelta.run({
          id: d.id,
          claims: JSON.stringify(claimsToJson(d.claims)),
          sig: d.sig ?? null,
        });
        if (info.changes > 0) {
          this.indexPointers(d);
          this.onDisk.add(d.id);
          count += 1;
        }
      }
      return count;
    });
  }

  private indexPointers(d: Delta): void {
    for (const ptr of d.claims.pointers) {
      if (ptr.target.kind === "entity") {
        this.insertPointer.run({
          delta_id: d.id,
          role: ptr.role,
          target_id: ptr.target.entity.id,
          value_key: null,
        });
      } else if (ptr.target.kind === "primitive") {
        this.insertPointer.run({
          delta_id: d.id,
          role: ptr.role,
          target_id: null,
          value_key: viewCanonicalHex(ptr.target.value),
        });
      }
      // delta-targets (negation/revises/…) are not indexed here — the reverse-adjacency reads
      // this tier accelerates are over entity targets and primitive values.
    }
  }

  private rehydrate(row: DeltaRow): Delta {
    return makeDelta(parseClaims(JSON.parse(row.claims)), row.sig ?? undefined);
  }

  // --- the delta-level primitive (store-tier.ts) -------------------------------------------------

  appendDeltas(deltas: Iterable<Delta>): number {
    const fresh: Delta[] = [];
    const seen = new Set<string>();
    for (const d of deltas) {
      if (this.onDisk.has(d.id) || seen.has(d.id)) continue;
      seen.add(d.id);
      fresh.push(d);
    }
    if (fresh.length === 0) return 0;
    return this.appendTxn.immediate(fresh) as number;
  }

  deltasSince(knownIds: ReadonlySet<string>): Delta[] {
    const rows = this.selectAll.all() as DeltaRow[];
    const out: Delta[] = [];
    for (const row of rows) {
      if (knownIds.has(row.id)) continue;
      out.push(this.rehydrate(row));
    }
    return out;
  }

  // --- indexed reads (mirror the reactor's targetIndex / valueIndex) -----------------------------

  // Every stored delta with a pointer targeting this entity id — the B-tree answer to the scan
  // the gql inbound-index build and recall's relevance select do today.
  deltasByTarget(entityId: string): Delta[] {
    return (this.selectByTarget.all(entityId) as DeltaRow[]).map((r) => this.rehydrate(r));
  }

  // Every stored delta with a primitive pointer under `role` whose canonical key matches. The
  // key is the reactor's own `viewCanonicalHex`, so results align with `byValue` byte-for-byte.
  deltasByValue(role: string, value: Primitive): Delta[] {
    const key = viewCanonicalHex(value);
    return (this.selectByValue.all(role, key) as DeltaRow[]).map((r) => this.rehydrate(r));
  }

  // --- agent-sync ergonomics ---------------------------------------------------------------------

  refresh(agent: ChorusAgent): number {
    const rows = this.selectSince.all(this.lastSeq) as DeltaRow[];
    if (rows.length === 0) return 0;
    const arrived: Delta[] = [];
    for (const row of rows) {
      if (row.seq > this.lastSeq) this.lastSeq = row.seq;
      const d = this.rehydrate(row);
      this.onDisk.add(d.id);
      arrived.push(d);
    }
    return agent.importSet(DeltaSet.from(arrived)).accepted;
  }

  persist(agent: ChorusAgent): number {
    // Converge concurrent writers into the agent first (union — order is irrelevant), then store
    // the difference. The append is a single atomic transaction; no lock directory.
    this.refresh(agent);
    const mine = agent.peer.reactor.arrivalLog().filter((d) => !this.onDisk.has(d.id));
    return this.appendDeltas(mine);
  }

  close(): void {
    this.db.close();
  }
}
