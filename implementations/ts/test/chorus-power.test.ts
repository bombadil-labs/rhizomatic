// Slice F power tools: decide/replay over MCP, model- and session-level distrust, compaction.

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SharedStore } from "../chorus/shared-store.js";
import { callTool, createSession } from "../chorus/mcp-server.js";

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const MASTER = "0f".repeat(32);
const dir = mkdtempSync(join(tmpdir(), "chorus-power-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mk = (sessionId: string, t0: number) =>
  createSession({ masterSeedHex: MASTER, sessionId, clock: clockFrom(t0) });

describe("chorus MCP: decide & replay", () => {
  it("a decision pins what was known; replay verifies it after the world moves on", () => {
    const ctx = mk("decider", 1000);
    callTool(ctx, "begin-session", { model: "claude-fable-5" });
    const r = callTool(ctx, "remember", {
      about: "deploy:42",
      attribute: "approved",
      value: true,
    }) as { deltaId: string };

    const d = callTool(ctx, "decide", { about: "deploy:42", intent: "ship it" }) as {
      decisionId: string;
      view: unknown;
      basis: string;
    };
    expect(d.view).toEqual({ approved: true });

    callTool(ctx, "retract", { deltaId: r.deltaId, reason: "stale CI" });
    expect(callTool(ctx, "recall", { entity: "deploy:42" })).toEqual({});

    const replay = callTool(ctx, "replay", { decisionId: d.decisionId }) as {
      view: unknown;
      verified: boolean;
      intent: string;
      retractedSince: string[];
      receipts: Array<{ speaker: string; model?: string }>;
    };
    expect(replay.view).toEqual({ approved: true });
    expect(replay.verified).toBe(true);
    expect(replay.intent).toBe("ship it");
    expect(replay.retractedSince).toEqual([r.deltaId]);
    // Receipts carry identity even through replay.
    expect(replay.receipts[0]!.model).toBe("claude-fable-5");
  });
});

describe("chorus MCP: model- and session-level distrust", () => {
  it("distrustModel demotes every session of that model in one edit", () => {
    const h1 = mk("h1", 1000);
    callTool(h1, "begin-session", { model: "claude-haiku-4-5" });
    callTool(h1, "remember", { about: "svc:api", attribute: "owner", value: "wrong-a" });
    const h2 = mk("h2", 2000);
    callTool(h2, "begin-session", { model: "claude-haiku-4-5" });
    h2.agent.importSet(h1.agent.snapshot());
    callTool(h2, "remember", { about: "svc:db", attribute: "owner", value: "wrong-b" });

    const me = mk("me", 3000);
    callTool(me, "begin-session", { model: "claude-fable-5" });
    me.agent.importSet(h2.agent.snapshot());
    callTool(me, "remember", { about: "svc:api", attribute: "owner", value: "right-a" });
    callTool(me, "remember", { about: "svc:db", attribute: "owner", value: "right-b" });

    const result = callTool(me, "trust", {
      distrustModel: "claude-haiku-4-5",
      reason: "bad fine-tune week",
    }) as { distrusted: string[] };
    expect(result.distrusted.sort()).toEqual([h1.agent.author, h2.agent.author].sort());
    expect(callTool(me, "recall", { entity: "svc:api" })).toEqual({ owner: "right-a" });
    expect(callTool(me, "recall", { entity: "svc:db" })).toEqual({ owner: "right-b" });
  });

  it("distrustSession targets exactly one session; unknown selectors fail loudly", () => {
    const s1 = mk("tuesday", 1000);
    callTool(s1, "begin-session", { model: "claude-fable-5" });
    callTool(s1, "remember", { about: "x:1", attribute: "v", value: "from-tuesday" });
    const me = mk("now", 2000);
    me.agent.importSet(s1.agent.snapshot());
    callTool(me, "begin-session", { model: "claude-fable-5" });

    const r = callTool(me, "trust", { distrustSession: "tuesday" }) as { distrusted: string[] };
    expect(r.distrusted).toEqual([s1.agent.author]);
    expect(() => callTool(me, "trust", { distrustSession: "never-happened" })).toThrow(
      /no session/,
    );
    expect(() => callTool(me, "trust", {})).toThrow(/give one of/);
  });
});

describe("chorus: log compaction", () => {
  it("duplicates and torn garbage vanish; the world is byte-identical after", () => {
    const file = join(dir, "compact.jsonl");
    const ctx = mk("writer", 1000);
    const store = new SharedStore(file);
    callTool(ctx, "begin-session", { model: "claude-fable-5" });
    callTool(ctx, "remember", { about: "a", attribute: "p", value: 1 });
    callTool(ctx, "remember", { about: "b", attribute: "q", value: 2 });
    store.persist(ctx.agent);

    // Simulate a messy history: duplicate lines + a torn tail from a crashed writer.
    const original = readFileSync(file, "utf8");
    appendFileSync(file, original); // every line duplicated
    appendFileSync(file, '{"claims": {"timestamp": 9, "auth'); // torn

    const reader = mk("reader", 5000);
    const rstore = new SharedStore(file);
    rstore.refresh(reader.agent);
    const digestBefore = reader.agent.digest();
    expect(rstore.wasteful(reader.agent, 2)).toBe(true);

    rstore.compact(reader.agent);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(reader.agent.peer.reactor.arrivalLog().length);
    expect(new Set(lines).size).toBe(lines.length);

    // A fresh boot from the compacted log reproduces the identical world.
    const fresh = mk("fresh", 9000);
    new SharedStore(file).refresh(fresh.agent);
    expect(fresh.agent.digest()).toBe(digestBefore);
  });
});
