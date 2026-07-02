// The pluggable tier from the caller's side: env-driven backend selection, the factory, the
// JSONL → SQLite migration (lossless by digest), and an MCP-boot smoke through each backend.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { JsonlStore } from "../src/shared-store.js";
import { SqliteStore } from "../src/sqlite-store.js";
import {
  backendFromEnv,
  createBackend,
  type StoreBackend,
  type BackendKind,
} from "../src/store-tier.js";
import { migrateJsonlToSqlite } from "../src/migrate.js";
import { callTool, createSession } from "../src/mcp-server.js";

const MASTER = "0f".repeat(32);
const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const dir = mkdtempSync(join(tmpdir(), "chorus-tier-"));
const opened: StoreBackend[] = [];
const track = <S extends StoreBackend>(s: S): S => (opened.push(s), s);
afterAll(() => {
  for (const s of opened) s.close?.();
  rmSync(dir, { recursive: true, force: true });
});

describe("chorus persistence tier: selection + migration", () => {
  it("backendFromEnv defaults to jsonl, honors sqlite, is case-insensitive, rejects junk", () => {
    expect(backendFromEnv({})).toBe("jsonl");
    expect(backendFromEnv({ CHORUS_STORE_BACKEND: "jsonl" })).toBe("jsonl");
    expect(backendFromEnv({ CHORUS_STORE_BACKEND: "sqlite" })).toBe("sqlite");
    expect(backendFromEnv({ CHORUS_STORE_BACKEND: "SQLite" })).toBe("sqlite");
    expect(() => backendFromEnv({ CHORUS_STORE_BACKEND: "postgres" })).toThrow(
      /not a known backend/,
    );
  });

  it("the factory builds the backend the selection names", () => {
    expect(track(createBackend(join(dir, "f.jsonl"), "jsonl"))).toBeInstanceOf(JsonlStore);
    expect(track(createBackend(join(dir, "f.sqlite"), "sqlite"))).toBeInstanceOf(SqliteStore);
  });

  it("migrates a JSONL log into SQLite losslessly: identical digest, beliefs intact", () => {
    const jsonlPath = join(dir, "memory.jsonl");
    const sqlitePath = join(dir, "memory.sqlite");

    // Build a real world in JSONL: a belief, a revise, a retract — exercise negation chains.
    const writer = createSession({ masterSeedHex: MASTER, sessionId: "w", clock: clockFrom(1000) });
    const src = track(new JsonlStore(jsonlPath));
    callTool(writer, "begin-session", { model: "claude-fable-5" });
    callTool(writer, "remember", { about: "svc:api", attribute: "owner", value: "team-a" });
    const r = callTool(writer, "remember", {
      about: "svc:api",
      attribute: "tier",
      value: "bronze",
    }) as { deltaId: string };
    callTool(writer, "revise", { deltaId: r.deltaId, value: "gold", reason: "upgraded" });
    src.persist(writer.agent);
    const before = writer.agent.digest();

    const result = migrateJsonlToSqlite(jsonlPath, sqlitePath);
    expect(result.digest).toBe(before); // the migration's own internal verification agrees…

    // …and an independent reader over the SQLite store sees the identical world + live beliefs.
    const reader = createSession({ masterSeedHex: MASTER, sessionId: "r", clock: clockFrom(5000) });
    track(new SqliteStore(sqlitePath)).refresh(reader.agent);
    expect(reader.agent.digest()).toBe(before);
    expect(callTool(reader, "recall", { entity: "svc:api" })).toEqual({
      owner: "team-a",
      tier: "gold",
    });
  });

  it("an empty JSONL log migrates to an empty SQLite store (no spurious deltas)", () => {
    const result = migrateJsonlToSqlite(join(dir, "absent.jsonl"), join(dir, "empty.sqlite"));
    expect(result.deltas).toBe(0);
  });

  // DoD #5: the server path boots on either backend; remember in one process, recall in a fresh
  // one over the same durable store — the resume every real client depends on.
  for (const backend of ["jsonl", "sqlite"] as BackendKind[]) {
    it(`MCP boot smoke — remember → (fresh boot) → recall on ${backend}`, () => {
      const path = join(dir, `boot.${backend}`);
      const s1 = createSession({ masterSeedHex: MASTER, sessionId: "p1", clock: clockFrom(1000) });
      const store1 = track(createBackend(path, backend));
      callTool(s1, "begin-session", { model: "claude-fable-5" });
      callTool(s1, "remember", { about: "user:mike", attribute: "editor", value: "vim" }, () =>
        store1.persist(s1.agent),
      );

      // A second process boots cold from the same store and recalls.
      const s2 = createSession({ masterSeedHex: MASTER, sessionId: "p2", clock: clockFrom(9000) });
      track(createBackend(path, backend)).refresh(s2.agent);
      expect(callTool(s2, "recall", { entity: "user:mike" })).toEqual({ editor: "vim" });
    });
  }
});
