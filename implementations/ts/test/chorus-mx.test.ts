// MX: the model experience. A session begins, gets briefed, works, summarizes, ends; the
// next session starts where it stopped — with provenance native memory can't offer.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SharedStore } from "../chorus/shared-store.js";
import { callTool, createSession, type SessionContext } from "../chorus/mcp-server.js";
import type { Briefing } from "../chorus/briefing.js";

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const MASTER = "0f".repeat(32);
const dir = mkdtempSync(join(tmpdir(), "chorus-mx-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mk = (sessionId: string, t0: number): SessionContext =>
  createSession({ masterSeedHex: MASTER, sessionId, clock: clockFrom(t0) });

describe("chorus MX: the session lifecycle", () => {
  it("session 1 works and summarizes; session 2's briefing starts where it stopped", () => {
    const file = join(dir, "lifecycle.jsonl");
    const s1 = mk("monday", 1000);
    const store1 = new SharedStore(file);

    callTool(s1, "begin-session", { model: "claude-fable-5", purpose: "plan the launch" });
    callTool(s1, "remember", {
      about: "user:mike",
      attribute: "tone",
      value: "direct, no fluff",
      kind: "preference",
      speaker: "user",
    });
    callTool(s1, "remember", {
      about: "proj:launch",
      attribute: "blocker",
      value: "pricing page unreviewed",
      kind: "task",
    });
    callTool(s1, "end-session", { summary: "Drafted launch plan; pricing page still open." });
    store1.persist(s1.agent);

    // A new day, a new session, a fresh process.
    const s2 = mk("tuesday", 9000);
    new SharedStore(file).refresh(s2.agent);
    callTool(s2, "begin-session", { model: "claude-fable-5", purpose: "continue launch prep" });

    const b = callTool(s2, "briefing", {}) as Briefing;
    expect(b.preferences.map((p) => p.value)).toContain("direct, no fluff");
    expect(b.openTasks.map((t) => t.value)).toContain("pricing page unreviewed");
    const monday = b.recentSessions.find((s) => s.sessionId === "monday")!;
    expect(monday.model).toBe("claude-fable-5");
    expect(monday.purpose).toBe("plan the launch");
    expect(monday.summary).toBe("Drafted launch plan; pricing page still open.");
    expect(monday.endedAt).toBeDefined();
    // The preference is attributable to the USER, not to a model session.
    expect(b.preferences[0]!.author).toBe(s2.userAuthor);
  });

  it("contested facts surface in the briefing instead of last-write-wins", () => {
    const s1 = mk("a", 1000);
    callTool(s1, "remember", { about: "svc:api", attribute: "owner", value: "team-a" });
    const s2 = mk("b", 2000);
    s2.agent.importSet(s1.agent.snapshot());
    callTool(s2, "remember", { about: "svc:api", attribute: "owner", value: "team-b" });

    const b = callTool(s2, "briefing", {}) as Briefing;
    const dispute = b.contested.find((c) => c.entity === "svc:api" && c.attribute === "owner")!;
    expect(dispute.values).toEqual(["team-a", "team-b"]);
  });

  it("standing distrust edits rehydrate into a fresh session's lens", () => {
    const file = join(dir, "trust.jsonl");
    const s1 = mk("burned", 1000);
    const rogue = mk("rogue", 2000);
    callTool(rogue, "begin-session", { model: "claude-haiku-4-5" });
    callTool(rogue, "remember", { about: "svc:db", attribute: "healthy", value: false });
    s1.agent.importSet(rogue.agent.snapshot());
    callTool(s1, "remember", { about: "svc:db", attribute: "healthy", value: true });
    callTool(s1, "trust", { distrust: rogue.agent.author, reason: "probe was broken" });
    new SharedStore(file).persist(s1.agent);

    const s3 = mk("wednesday", 9000);
    new SharedStore(file).refresh(s3.agent);
    const b = callTool(s3, "briefing", {}) as Briefing;
    expect(b.distrusted.map((d) => d.author)).toContain(rogue.agent.author);
    // The lens already honors the standing edit — no re-distrusting required.
    expect(callTool(s3, "recall", { entity: "svc:db" })).toEqual({ healthy: true });
  });

  it("revise replaces in one move, linked and auditable", () => {
    const ctx = mk("rev", 1000);
    const r = callTool(ctx, "remember", {
      about: "user:mike",
      attribute: "city",
      value: "Boston",
      kind: "fact",
    }) as { deltaId: string };
    const rev = callTool(ctx, "revise", {
      deltaId: r.deltaId,
      value: "Denver",
      reason: "moved",
    }) as { deltaId: string; revised: string };
    expect(rev.revised).toBe(r.deltaId);
    expect(callTool(ctx, "recall", { entity: "user:mike" })).toEqual({ city: "Denver" });
    // The replacement delta carries a revises pointer back to the original.
    const replacement = ctx.agent.peer.reactor.get(rev.deltaId)!;
    const link = replacement.claims.pointers.find((p) => p.role === "chorus.belief.revises");
    expect(link?.target.kind === "delta" && link.target.deltaRef.delta === r.deltaId).toBe(true);
    // And the history is all still there.
    const receipts = callTool(ctx, "explain", { entity: "user:mike", attribute: "city" }) as Array<{
      negated: boolean;
    }>;
    expect(receipts).toHaveLength(2);
  });
});
