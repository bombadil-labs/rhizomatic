// The Chorus MCP server: identity (per-session model authors, one persistent user author),
// every tool through the dispatcher, and the full JSON-RPC protocol loop in-process.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { sessionSeed, userSeed } from "../chorus/identity.js";
import { ChorusAgent } from "../chorus/index.js";
import { callTool, createSession, handleRequest, serve } from "../chorus/mcp-server.js";

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const MASTER = "0f".repeat(32);

const mkCtx = (sessionId = "s1", t0 = 1000) =>
  createSession({ masterSeedHex: MASTER, sessionId, clock: clockFrom(t0) });

describe("chorus MCP: identity (who said this, exactly)", () => {
  it("each session is a distinct author; the user is persistent across sessions", () => {
    const s1 = mkCtx("session-one");
    const s2 = mkCtx("session-two");
    expect(s1.agent.author).not.toBe(s2.agent.author);
    expect(s1.userAuthor).toBe(s2.userAuthor);
    expect(s1.userAuthor).not.toBe(s1.agent.author);
    // Derivation is deterministic: the master holder can re-derive any session key.
    expect(sessionSeed(MASTER, "session-one")).toBe(sessionSeed(MASTER, "session-one"));
    expect(sessionSeed(MASTER, "session-one")).not.toBe(sessionSeed(MASTER, "session-two"));
    expect(userSeed(MASTER)).not.toBe(sessionSeed(MASTER, "user"));
  });

  it("begin-session binds the author to model + purpose; explain attributes by session", () => {
    const ctx = mkCtx("abc123");
    const intro = callTool(ctx, "begin-session", {
      model: "claude-fable-5",
      purpose: "testing identity",
    }) as { sessionAuthor: string; model: string };
    expect(intro.model).toBe("claude-fable-5");
    expect(intro.sessionAuthor).toBe(ctx.agent.author);

    callTool(ctx, "remember", { about: "user:mike", attribute: "theme", value: "dark" });
    callTool(ctx, "remember", {
      about: "user:mike",
      attribute: "theme",
      value: "light",
      speaker: "user",
    });

    const receipts = callTool(ctx, "explain", {
      entity: "user:mike",
      attribute: "theme",
    }) as Array<{
      author: string;
      speaker: string;
      model?: string;
      sessionId?: string;
      thisSession?: boolean;
    }>;
    expect(receipts).toHaveLength(2);
    const fromModel = receipts.find((r) => r.speaker === "session")!;
    expect(fromModel.model).toBe("claude-fable-5");
    expect(fromModel.sessionId).toBe("abc123");
    expect(fromModel.thisSession).toBe(true);
    const fromUser = receipts.find((r) => r.speaker === "user")!;
    expect(fromUser.author).toBe(ctx.userAuthor);
  });

  it("a write before begin-session still binds an identity — visibly 'unknown'", () => {
    const ctx = mkCtx("lazy");
    callTool(ctx, "remember", { about: "t:1", attribute: "x", value: 1 });
    const receipts = callTool(ctx, "explain", { entity: "t:1" }) as Array<{
      speaker: string;
      model?: string;
    }>;
    expect(receipts[0]!.speaker).toBe("session");
    expect(receipts[0]!.model).toBe("unknown");
  });

  it("two sessions sharing a store stay auditable — and one can be distrusted wholesale", () => {
    // Session 1 writes, exports its world; session 2 imports and contradicts.
    const s1 = mkCtx("one", 1000);
    callTool(s1, "begin-session", { model: "claude-haiku-4-5" });
    callTool(s1, "remember", { about: "svc:api", attribute: "owner", value: "team-a" });

    const s2 = mkCtx("two", 2000);
    callTool(s2, "begin-session", { model: "claude-fable-5" });
    s2.agent.importSet(s1.agent.snapshot());
    callTool(s2, "remember", { about: "svc:api", attribute: "owner", value: "team-b" });

    expect(callTool(s2, "recall", { entity: "svc:api" })).toEqual({ owner: "team-b" });
    // Audit: which session said what.
    const receipts = callTool(s2, "explain", { entity: "svc:api" }) as Array<{
      sessionId?: string;
      model?: string;
    }>;
    expect(receipts.map((r) => r.sessionId).sort()).toEqual(["one", "two"]);
    // Retroactively distrust session one's author — its testimony demotes, history intact.
    callTool(s2, "trust", { distrust: s1.agent.author, reason: "bad premise that day" });
    expect(callTool(s2, "recall", { entity: "svc:api" })).toEqual({ owner: "team-b" });
    expect(receipts.find((r) => r.sessionId === "one")?.model).toBe("claude-haiku-4-5");
  });
});

describe("chorus MCP: the six original tools still hold", () => {
  it("remember → recall → retract → explain → as-of round-trip", () => {
    const ctx = mkCtx();
    const r = callTool(ctx, "remember", {
      about: "task:1",
      attribute: "status",
      value: "open",
    }) as { deltaId: string; signed: boolean };
    expect(r.signed).toBe(true);
    expect(callTool(ctx, "recall", { entity: "task:1" })).toEqual({ status: "open" });
    callTool(ctx, "retract", { deltaId: r.deltaId, reason: "done" });
    expect(callTool(ctx, "recall", { entity: "task:1" })).toEqual({});
    expect(callTool(ctx, "as-of", { entity: "task:1", at: 1025 })).toEqual({ status: "open" });
    const receipts = callTool(ctx, "explain", { entity: "task:1" }) as Array<{ negated: boolean }>;
    expect(receipts.some((x) => x.negated)).toBe(true);
  });

  it("trust demotes an author; corroborable voices outrank; history stays", () => {
    const ctx = mkCtx();
    const other = new ChorusAgent({
      name: "other",
      seedHex: "aa".repeat(32),
      clock: clockFrom(2000),
    });
    other.assert({ about: "svc:api", attribute: "owner", value: "team-wrong" });
    ctx.agent.importSet(other.snapshot());
    callTool(ctx, "remember", { about: "svc:api", attribute: "owner", value: "team-right" });
    expect(callTool(ctx, "recall", { entity: "svc:api" })).toEqual({ owner: "team-wrong" });
    callTool(ctx, "trust", { distrust: other.author });
    expect(callTool(ctx, "recall", { entity: "svc:api" })).toEqual({ owner: "team-right" });
  });

  it("unknown tools fail loudly", () => {
    expect(() => callTool(mkCtx(), "forget", {})).toThrow(/unknown tool/);
  });
});

describe("chorus MCP: the protocol loop", () => {
  it("serves initialize → tools/list → tools/call over a stream pair", async () => {
    const ctx = mkCtx();
    const input = new PassThrough();
    const output = new PassThrough();
    serve(ctx, input, output);

    const responses: Record<string, unknown>[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim() !== "") responses.push(JSON.parse(line) as Record<string, unknown>);
      }
    });

    const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "begin-session", arguments: { model: "claude-fable-5" } },
    });
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: { about: "user:mike", attribute: "theme", value: "dark" },
      },
    });
    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "recall", arguments: { entity: "user:mike" } },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(responses).toHaveLength(5); // the notification got no response
    const tools = (responses[1]!["result"] as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    expect(tools).toEqual([
      "begin-session",
      "whoami",
      "briefing",
      "remember",
      "recall",
      "topics",
      "search",
      "same",
      "retract",
      "revise",
      "end-session",
      "explain",
      "trust",
      "as-of",
    ]);
    const recall = responses[4]!["result"] as { content: Array<{ text: string }> };
    expect(JSON.parse(recall.content[0]!.text)).toEqual({ theme: "dark" });
  });

  it("unknown methods answer with errors, never crash", () => {
    const resp = handleRequest(mkCtx(), { jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect((resp?.["error"] as { code: number }).code).toBe(-32601);
  });
});
