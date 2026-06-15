// The SQLite tier's reason to exist: indexed reads that reproduce the full-store scan exactly,
// and beat it on a large store. Same world in both backends — JSONL takes the scan branch of
// `backlinks` (no by-target index), SQLite takes the indexed branch — so equality is a true
// identical-to-scan check, and the timing is a true index-vs-scan comparison.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { JsonlStore } from "../src/shared-store.js";
import { SqliteStore } from "../src/sqlite-store.js";
import { backlinks } from "../src/store-reads.js";
import { ROLE_VALUE } from "../src/vocab.js";
import { callTool, createSession } from "../src/mcp-server.js";

const MASTER = "0f".repeat(32);
const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const dir = mkdtempSync(join(tmpdir(), "chorus-indexed-"));
const sqlitePath = join(dir, "big.sqlite");
const jsonlPath = join(dir, "big.jsonl");
const jsonl = new JsonlStore(jsonlPath);
const sqlite = new SqliteStore(sqlitePath);
afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

// Seed one large world of reference edges: many `proj:N` entities, each pointing at one of a
// handful of `team:H` hubs, plus primitive noise. Persisted once into both backends.
const HUBS = 8;
const PROJECTS = 400; // a clean multiple of HUBS so each hub gets exactly PROJECTS/HUBS edges
const writer = createSession({ masterSeedHex: MASTER, sessionId: "seed", clock: clockFrom(1000) });
callTool(writer, "begin-session", { model: "claude-fable-5" });
for (let i = 0; i < PROJECTS; i++) {
  const hub = `team:${i % HUBS}`;
  callTool(writer, "remember", {
    about: `proj:${i}`,
    attribute: "ownedBy",
    value: { entity: hub },
  });
  callTool(writer, "remember", { about: `proj:${i}`, attribute: "priority", value: i % 5 });
}
jsonl.persist(writer.agent);
sqlite.persist(writer.agent);

describe("chorus SQLite tier: indexed reads reproduce the scan, and beat it", () => {
  it("deltasByTarget equals a full-store scan for the same target", () => {
    const target = "team:3";
    const indexed = new Set(sqlite.deltasByTarget(target).map((d) => d.id));
    // The scan reference: every stored delta with any pointer at the target.
    const scanned = new Set(
      sqlite
        .deltasSince(new Set())
        .filter((d) =>
          d.claims.pointers.some(
            (p) => p.target.kind === "entity" && p.target.entity.id === target,
          ),
        )
        .map((d) => d.id),
    );
    expect(indexed).toEqual(scanned);
    expect(indexed.size).toBe(PROJECTS / HUBS); // every Nth project points here
  });

  it("deltasByValue equals a full-store scan for the same (role, value)", () => {
    const indexed = new Set(sqlite.deltasByValue("chorus.belief.value", 3).map((d) => d.id));
    const scanned = new Set(
      sqlite
        .deltasSince(new Set())
        .filter((d) =>
          d.claims.pointers.some(
            (p) =>
              p.role === "chorus.belief.value" &&
              p.target.kind === "primitive" &&
              p.target.value === 3,
          ),
        )
        .map((d) => d.id),
    );
    expect(indexed).toEqual(scanned);
    expect(indexed.size).toBeGreaterThan(0);
  });

  it("backlinks: indexed (SQLite) == scan (JSONL), and the index is faster over many queries", () => {
    // Identical results: the JSONL store has no by-target index, so its backlinks() scans the
    // whole log; SQLite's uses the index. Same world → byte-identical answer.
    for (const h of [0, 3, 7]) {
      const target = `team:${h}`;
      expect(backlinks(sqlite, target)).toEqual(backlinks(jsonl, target));
    }
    // Every backlink is a value-edge filed under ownedBy, and there are PROJECTS/HUBS of them.
    const sample = backlinks(sqlite, "team:0");
    expect(sample.length).toBe(PROJECTS / HUBS);
    expect(sample.every((b) => b.attribute === "ownedBy" && b.role === ROLE_VALUE)).toBe(true);

    // Faster: run the same batch of queries against each and compare wall-clock. The asymptotics
    // (one indexed lookup vs a full-log parse, ×N) make this a comfortable margin, not a photo
    // finish — but assert only "strictly faster" to stay robust on a noisy CI box.
    const targets = Array.from({ length: HUBS }, (_, h) => `team:${h}`);
    const ROUNDS = 3;
    const time = (store: JsonlStore | SqliteStore): number => {
      const t0 = performance.now();
      for (let r = 0; r < ROUNDS; r++) for (const t of targets) backlinks(store, t);
      return performance.now() - t0;
    };
    time(sqlite); // warm the prepared statements / page cache before measuring
    time(jsonl);
    const sqliteMs = time(sqlite);
    const jsonlMs = time(jsonl);
    expect(sqliteMs).toBeLessThan(jsonlMs);
  });
});
