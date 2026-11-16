// SQLite stores for tests: each lives in a file of one `mkdtempSync` directory, which `cleanup`
// removes after closing every store it opened. `audited` wraps a store from the outside and
// checks, after every call, that each peer's count and floor equal a count over the rows.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  openSqliteStore,
  type SqliteStore,
  type SqliteStoreOptions,
} from "../../src/storage/sqlite-store.js";
import type { PeerStore, Snapshot, Store } from "../../src/storage/store.js";

export type SqliteFixture = {
  readonly dir: string;
  /** A path for a new store file in the directory. */
  path(): string;
  /** A new store in a new file. */
  open(options?: SqliteStoreOptions): Promise<SqliteStore>;
  /** A new store in a new file, checked after every call by `audit`. */
  audited(options?: SqliteStoreOptions): Promise<Store>;
  cleanup(): Promise<void>;
};

/**
 * Throws when a peer's `count` is not the number of its holdings, or its `floor` and revision
 * do not bound exactly the change records it keeps.
 */
export function audit(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const peers = db.prepare("SELECT id, revision, floor, count FROM peer").all() as {
      id: string;
      revision: number;
      floor: number;
      count: number;
    }[];
    for (const peer of peers) {
      const { held } = db
        .prepare("SELECT count(*) AS held FROM holding WHERE peer = ?")
        .get(peer.id) as { held: number };
      const feed = db
        .prepare(
          "SELECT count(*) AS kept, min(revision) AS low, max(revision) AS high FROM change WHERE peer = ?",
        )
        .get(peer.id) as { kept: number; low: number | null; high: number | null };
      if (held !== peer.count)
        throw new Error(`peer ${peer.id}: count ${peer.count}, and it holds ${held} rows`);
      const floor = feed.kept === 0 ? peer.revision : feed.low! - 1;
      const top = feed.kept === 0 ? peer.revision : feed.high!;
      if (floor !== peer.floor || top !== peer.revision || feed.kept !== peer.revision - peer.floor)
        throw new Error(
          `peer ${peer.id}: floor ${peer.floor} at revision ${peer.revision}, and it keeps ${feed.kept} records from ${feed.low} to ${feed.high}`,
        );
    }
  } finally {
    db.close();
  }
}

/** The store, with `audit` run after every call on it, its peers and their snapshots. */
function auditedStore(store: Store, path: string): Store {
  const after = async <T>(call: Promise<T>): Promise<T> => {
    try {
      return await call;
    } finally {
      audit(path);
    }
  };
  const snapshot = (s: Snapshot): Snapshot => ({
    revision: s.revision,
    history: s.history,
    head: s.head,
    count: s.count,
    get: (ids) => after(s.get(ids)),
    arrivals: (ids) => after(s.arrivals(ids)),
    targets: (entities) => after(s.targets(entities)),
    negators: (ids) => after(s.negators(ids)),
    scope: (request) => after(s.scope(request)),
    release: () => s.release(),
  });
  const peer = (p: PeerStore): PeerStore => ({
    id: p.id,
    history: p.history,
    erasure: p.erasure,
    read: async () => snapshot(await after(p.read())),
    append: (batch) => after(p.append(batch)),
    purge: (ids) => after(p.purge(ids)),
    changes: (from, to) => after(p.changes(from, to)),
  });
  return {
    profile: store.profile,
    createPeer: async (id, options) => peer(await after(store.createPeer(id, options))),
    peer: async (id) => peer(await after(store.peer(id))),
    openAdmin: () => store.openAdmin(),
    close: () => store.close(),
  };
}

export function sqliteFixture(prefix: string): SqliteFixture {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const opened: SqliteStore[] = [];
  let n = 0;
  const path = (): string => join(dir, `store-${n++}.db`);
  const open = async (options?: SqliteStoreOptions, at = path()): Promise<SqliteStore> => {
    const store = await openSqliteStore(at, options);
    opened.push(store);
    return store;
  };
  return {
    dir,
    path,
    open: (options) => open(options),
    audited: async (options) => {
      const at = path();
      return auditedStore(await open(options, at), at);
    },
    cleanup: async () => {
      for (const store of opened) await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
