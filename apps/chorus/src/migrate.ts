// One-shot migration: import an existing JSONL log into a fresh SQLite store, losslessly. The
// CRDT makes "lossless" an exact claim, not a hope — deltas are content-addressed, so the only
// honest check is that the canonical digest of the delta set is byte-identical before and after.
// We verify by reading the SQLite store back through a NEW agent and comparing digests; a
// mismatch is fatal (the migration refuses to claim success it can't prove).
//
//   npm run chorus:migrate <memory.jsonl> <memory.sqlite>

import { ChorusAgent } from "./agent.js";
import { JsonlStore } from "./shared-store.js";
import { SqliteStore } from "./sqlite-store.js";

// A throwaway keypair: the migration agent is a vessel for ingesting an existing delta set, it
// authors nothing. The digest is a property of the SET, independent of this seed.
const MIGRATION_SEED = "ab".repeat(32);

export interface MigrationResult {
  readonly deltas: number; // distinct deltas written to the SQLite store
  readonly digest: string; // the canonical digest, identical before and after
}

export function migrateJsonlToSqlite(jsonlPath: string, sqlitePath: string): MigrationResult {
  // Load the whole JSONL world into a vessel agent (host-aware ingestion, exactly as a boot).
  const source = new JsonlStore(jsonlPath);
  const loaded = new ChorusAgent({ name: "migrate-source", seedHex: MIGRATION_SEED });
  source.refresh(loaded);
  const before = loaded.digest();
  const all = loaded.peer.reactor.arrivalLog();

  // Write them into a fresh SQLite store.
  const dest = new SqliteStore(sqlitePath);
  try {
    const stored = dest.appendDeltas(all);

    // Verify losslessly: rehydrate a NEW agent from the SQLite store (not the writer's caches —
    // appendDeltas leaves the refresh cursor at zero, so this reads every stored row) and demand
    // an identical canonical digest.
    const verifier = new ChorusAgent({ name: "migrate-verify", seedHex: MIGRATION_SEED });
    dest.refresh(verifier);
    const after = verifier.digest();
    if (after !== before) {
      throw new Error(`migration changed the delta set: ${before} -> ${after}`);
    }
    return { deltas: stored, digest: after };
  } finally {
    dest.close();
  }
}

// Direct run: the migration CLI.
if (
  process.argv[1] !== undefined &&
  process.argv[1].replace(/\\/g, "/").endsWith("src/migrate.ts")
) {
  const [, , jsonlPath, sqlitePath] = process.argv;
  if (jsonlPath === undefined || sqlitePath === undefined) {
    console.error("usage: npm run chorus:migrate <source.jsonl> <dest.sqlite>");
    process.exit(2);
  }
  const result = migrateJsonlToSqlite(jsonlPath, sqlitePath);
  console.error(
    `migrated ${result.deltas} delta(s) ${jsonlPath} -> ${sqlitePath}; ` +
      `digest verified identical (${result.digest.slice(0, 16)}…)`,
  );
}
