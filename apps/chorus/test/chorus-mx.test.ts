// MX: the model experience. A session begins, gets briefed, works, summarizes, ends; the
// next session starts where it stopped — with provenance native memory can't offer.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SharedStore } from "../src/shared-store.js";
import { callTool, createSession, type SessionContext } from "../src/mcp-server.js";
import type { Briefing } from "../src/briefing.js";

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

  it("a set is not a contest: plurality declarations make divergence read as union", () => {
    const ctx = mk("setter", 1000);
    callTool(ctx, "remember", {
      about: "sync:m",
      attribute: "composed-of",
      value: { entity: "event:a" },
    });
    callTool(ctx, "remember", {
      about: "sync:m",
      attribute: "composed-of",
      value: { entity: "event:b" },
    });
    const solo = callTool(ctx, "briefing", {}) as Briefing;
    expect(solo.contested).toEqual([]); // two relata, one voice — a set, not a dispute

    // A second AUTHOR diverging on an UNDECLARED attribute reads as a contest…
    const rival = mk("rival", 5000);
    rival.agent.importSet(ctx.agent.snapshot());
    callTool(rival, "remember", {
      about: "sync:m",
      attribute: "composed-of",
      value: { entity: "event:z" },
    });
    const undeclared = callTool(rival, "briefing", {}) as Briefing;
    expect(undeclared.contested.map((c) => c.attribute)).toContain("composed-of");

    // …until someone DECLARES the attribute set-valued — an ordinary, negatable claim —
    // and multi-author divergence dissolves into accretion (the field finding, live data:
    // second sitting added event:alice-vision, third added recast members; joint building).
    callTool(rival, "remember", {
      about: "attr:composed-of",
      attribute: "plurality",
      value: "set",
      kind: "fact",
    });
    const declared = callTool(rival, "briefing", {}) as Briefing;
    expect(declared.contested).toEqual([]);
    // The union itself stays readable: every member, both authors.
    expect(
      callTool(rival, "recall", { entity: "sync:m", attribute: "composed-of", all: true }),
    ).toEqual({ "composed-of": ["event:a", "event:b", "event:z"] });
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

  it("contested facts surface even when the entity has fallen out of the recent topics", () => {
    // Regression: the first field session's one real contest sat at recency position 17 and
    // the briefing read "no contests". Disagreement does not expire by recency.
    const s1 = mk("a", 1000);
    callTool(s1, "remember", { about: "svc:api", attribute: "owner", value: "team-a" });
    const s2 = mk("b", 2000);
    s2.agent.importSet(s1.agent.snapshot());
    callTool(s2, "remember", { about: "svc:api", attribute: "owner", value: "team-b" });
    // Bury the contested entity under more recent, uncontested topics than the display window.
    for (let i = 0; i < 15; i++) {
      callTool(s2, "remember", { about: `note:${i}`, attribute: "text", value: `note ${i}` });
    }

    const b = callTool(s2, "briefing", {}) as Briefing;
    expect(b.topics.map((t) => t.entity)).not.toContain("svc:api");
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

  it("declared topics scope the briefing; out-of-scope contests compress to a count", () => {
    const a = mk("builder-a", 1000);
    callTool(a, "remember", {
      about: "proj:alpha",
      attribute: "blocker",
      value: "alpha task",
      kind: "task",
    });
    callTool(a, "remember", {
      about: "proj:beta",
      attribute: "blocker",
      value: "beta task",
      kind: "task",
    });
    callTool(a, "remember", { about: "proj:alpha", attribute: "owner", value: "team-a" });
    callTool(a, "remember", { about: "proj:beta", attribute: "owner", value: "team-x" });
    const b = mk("builder-b", 5000);
    b.agent.importSet(a.agent.snapshot());
    callTool(b, "remember", { about: "proj:alpha", attribute: "owner", value: "team-b" });
    callTool(b, "remember", { about: "proj:beta", attribute: "owner", value: "team-y" });
    callTool(b, "remember", {
      about: "user:mike",
      attribute: "tone",
      value: "direct",
      kind: "preference",
      speaker: "user",
    });

    callTool(b, "begin-session", {
      model: "claude-fable-5",
      topics: ["proj:alpha"],
      surface: "claude-code",
      mode: "work",
    });
    const br = callTool(b, "briefing", {}) as Briefing;
    expect(br.scope?.declared).toEqual(["proj:alpha"]);
    expect(br.openTasks.map((t) => t.entity)).toEqual(["proj:alpha"]);
    expect(br.contested.map((c) => c.entity)).toEqual(["proj:alpha"]);
    expect(br.contestedElsewhere).toBe(1); // beta's dispute: never hidden, never broadcast
    expect(br.topics.map((t) => t.entity)).toEqual(["proj:alpha"]);
    // Preferences are about the principal, who is party to every session: always global.
    expect(br.preferences.map((p) => p.value)).toContain("direct");

    // An explicit empty scope asks for the global view — both contests in full.
    const global = callTool(b, "briefing", { topics: [] }) as Briefing;
    expect(global.scope).toBeUndefined();
    expect(global.contested.map((c) => c.entity).sort()).toEqual(["proj:alpha", "proj:beta"]);
  });

  it("prefix topics scope id families; typed references pull the one-hop neighborhood in", () => {
    const ctx = mk("crawler", 1000);
    callTool(ctx, "remember", { about: "event:a", attribute: "what", value: "the event" });
    callTool(ctx, "remember", {
      about: "sync:x",
      attribute: "composed-of",
      value: { entity: "event:a" },
    });
    callTool(ctx, "remember", { about: "unrelated:z", attribute: "what", value: "noise" });
    const other = mk("disputant", 5000);
    other.agent.importSet(ctx.agent.snapshot());
    callTool(other, "remember", {
      about: "event:a",
      attribute: "what",
      value: "the event, revised",
    });

    callTool(other, "begin-session", { model: "claude-fable-5", topics: ["sync:"] });
    const br = callTool(other, "briefing", {}) as Briefing;
    // event:a is in scope only because sync:x REFERENCES it (slice J's typed edge).
    expect(br.topics.map((t) => t.entity).sort()).toEqual(["event:a", "sync:x"]);
    expect(br.contested.map((c) => c.entity)).toEqual(["event:a"]);
    expect(br.contestedElsewhere).toBe(0);
  });

  it("recent sessions sharing a declared topic outrank fresher unrelated ones", () => {
    const file = join(dir, "intent.jsonl");
    const s1 = mk("alpha-work", 1000);
    callTool(s1, "begin-session", { model: "claude-fable-5", topics: ["proj:alpha"] });
    callTool(s1, "end-session", { summary: "alpha progress" });
    new SharedStore(file).persist(s1.agent);
    const s2 = mk("beta-work", 5000);
    new SharedStore(file).refresh(s2.agent);
    callTool(s2, "begin-session", { model: "claude-fable-5", topics: ["proj:beta"] });
    callTool(s2, "end-session", { summary: "beta progress" });
    new SharedStore(file).persist(s2.agent);

    const s3 = mk("alpha-again", 9000);
    new SharedStore(file).refresh(s3.agent);
    callTool(s3, "begin-session", { model: "claude-fable-5", topics: ["proj:alpha"] });
    const br = callTool(s3, "briefing", {}) as Briefing;
    const ids = br.recentSessions.map((s) => s.sessionId);
    // Continuity is per project, not per wall-clock: the older alpha session sorts first.
    expect(ids.indexOf("alpha-work")).toBeLessThan(ids.indexOf("beta-work"));
    expect(br.recentSessions.find((s) => s.sessionId === "alpha-work")!.summary).toBe(
      "alpha progress",
    );
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
