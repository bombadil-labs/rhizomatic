// The backend-agnostic contract every `StoreBackend` must honor. One harness, driven against each
// backend — the same posture the repo takes toward the format: a contract with multiple
// witnesses. The CRDT is the safety net (content-addressed, order-free, idempotent), so a
// correct backend is one that preserves "a set of deltas, deduped by id" across append, read,
// reopen, and concurrent writers.
//
// Slice 2 runs it against JSONL; the SQLite backend (slice 3) calls the same harness below.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Delta } from "@rhizomes/rhizomatic";
import { JsonlStore } from "../src/shared-store.js";
import { SqliteStore } from "../src/sqlite-store.js";
import type { StoreBackend } from "../src/store-tier.js";
import { callTool, createSession, type SessionContext } from "../src/mcp-server.js";

const MASTER = "0f".repeat(32);
const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

// A backend under test: a name and a factory that opens a fresh StoreBackend over a given path.
// The harness owns path allocation so the same physical store can be reopened across "processes".
export interface Backend {
  readonly label: string;
  make(path: string): StoreBackend;
}

export function runStoreConformance(backend: Backend): void {
  const dir = mkdtempSync(join(tmpdir(), `chorus-conf-${backend.label}-`));
  // Track every opened store so we can close their handles before unlinking — Windows refuses
  // to remove a file (and the WAL sidecars) while a backend still holds it open.
  const opened: StoreBackend[] = [];
  const open = (path: string): StoreBackend => {
    const s = backend.make(path);
    opened.push(s);
    return s;
  };
  afterAll(() => {
    for (const s of opened) s.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  let counter = 0;
  const freshPath = (): string => join(dir, `world-${(counter += 1)}.store`);

  // A "process": one session author + one Store instance over a shared path.
  const proc = (path: string, id: string, clockStart: number) => ({
    session: createSession({ masterSeedHex: MASTER, sessionId: id, clock: clockFrom(clockStart) }),
    store: open(path),
  });
  const deltasOf = (s: SessionContext): readonly Delta[] => s.agent.peer.reactor.arrivalLog();

  describe(`Store conformance — ${backend.label}`, () => {
    it("two agents converge through the store: persist → refresh → identical digests", () => {
      const path = freshPath();
      const a = proc(path, "proc-a", 1000);
      const b = proc(path, "proc-b", 2000);

      callTool(a.session, "begin-session", { model: "claude-fable-5" });
      callTool(a.session, "remember", { about: "user:mike", attribute: "theme", value: "dark" });
      a.store.persist(a.session.agent);

      b.store.refresh(b.session.agent);
      expect(callTool(b.session, "recall", { entity: "user:mike" })).toEqual({ theme: "dark" });

      callTool(b.session, "remember", { about: "user:mike", attribute: "editor", value: "vim" });
      b.store.persist(b.session.agent);

      a.store.refresh(a.session.agent);
      expect(a.session.agent.digest()).toBe(b.session.agent.digest());
      // Cross-author attribution survives the round-trip.
      const receipts = callTool(a.session, "explain", { entity: "user:mike" }) as Array<{
        sessionId?: string;
      }>;
      expect(new Set(receipts.map((r) => r.sessionId))).toEqual(new Set(["proc-a", "proc-b"]));
    });

    it("appendDeltas is idempotent by id: re-storing the same deltas adds nothing", () => {
      const path = freshPath();
      const a = proc(path, "proc-a", 1000);
      callTool(a.session, "remember", { about: "x", attribute: "p", value: 1 });
      callTool(a.session, "remember", { about: "x", attribute: "q", value: 2 });
      const all = [...deltasOf(a.session)];
      expect(all.length).toBeGreaterThan(0);

      expect(a.store.appendDeltas(all)).toBe(all.length); // first store: all new
      expect(a.store.appendDeltas(all)).toBe(0); // re-store: nothing new
      // Even a brand-new instance over the same path sees no new work to do.
      expect(open(path).appendDeltas(all)).toBe(0);
    });

    it("deltasSince(knownIds) returns exactly the unknown stored deltas", () => {
      const path = freshPath();
      const a = proc(path, "proc-a", 1000);
      callTool(a.session, "remember", { about: "svc:api", attribute: "owner", value: "team-a" });
      callTool(a.session, "remember", { about: "svc:api", attribute: "tier", value: "gold" });
      a.store.persist(a.session.agent);
      const ids = deltasOf(a.session).map((d) => d.id);

      const reader = open(path);
      // Nothing known yet → every stored delta comes back, deduped.
      const since0 = reader.deltasSince(new Set());
      expect(new Set(since0.map((d) => d.id))).toEqual(new Set(ids));
      // All known → nothing comes back.
      expect(reader.deltasSince(new Set(ids))).toEqual([]);
      // A subset known → exactly the complement.
      const known = new Set([ids[0]!]);
      const rest = reader.deltasSince(known);
      expect(new Set(rest.map((d) => d.id))).toEqual(new Set(ids.slice(1)));
    });

    it("a fresh instance loads the whole history from durable state alone", () => {
      const path = freshPath();
      const a = proc(path, "proc-a", 1000);
      callTool(a.session, "begin-session", { model: "claude-fable-5" });
      callTool(a.session, "remember", { about: "svc:api", attribute: "owner", value: "team-a" });
      const r = callTool(a.session, "remember", {
        about: "svc:api",
        attribute: "stale",
        value: 1,
      }) as { deltaId: string };
      callTool(a.session, "retract", { deltaId: r.deltaId, reason: "wrong" });
      a.store.persist(a.session.agent);

      const fresh = createSession({
        masterSeedHex: MASTER,
        sessionId: "proc-later",
        clock: clockFrom(9000),
      });
      open(path).refresh(fresh.agent);
      expect(fresh.agent.digest()).toBe(a.session.agent.digest());
      // The retraction survived: the stale belief is gone, the owner remains.
      expect(callTool(fresh, "recall", { entity: "svc:api" })).toEqual({ owner: "team-a" });
    });

    it("interleaved persists never lose or duplicate a delta; signatures survive", () => {
      const path = freshPath();
      const a = proc(path, "proc-a", 1000);
      const b = proc(path, "proc-b", 2000);
      callTool(a.session, "remember", { about: "x", attribute: "p", value: 1 });
      callTool(b.session, "remember", { about: "x", attribute: "p", value: 2 });
      a.store.persist(a.session.agent);
      b.store.persist(b.session.agent); // pulls a's delta first, then appends only its own
      a.store.persist(a.session.agent); // nothing new of a's
      a.store.refresh(a.session.agent);

      expect(a.session.agent.digest()).toBe(b.session.agent.digest());
      // A fresh reader sees each distinct delta exactly once, signatures intact.
      const stored = open(path).deltasSince(new Set());
      expect(new Set(stored.map((d) => d.id)).size).toBe(stored.length);
      expect(stored.every((d) => typeof d.sig === "string")).toBe(true);
      expect(stored.length).toBe(deltasOf(a.session).length);
    });
  });
}

runStoreConformance({ label: "jsonl", make: (path) => new JsonlStore(path) });
runStoreConformance({ label: "sqlite", make: (path) => new SqliteStore(path) });
