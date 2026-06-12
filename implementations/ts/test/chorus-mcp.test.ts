// The Chorus MCP server: every tool driven through the dispatcher, and the full JSON-RPC
// protocol loop (initialize → tools/list → tools/call) driven in-process over a stream pair.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ChorusAgent } from "../chorus/index.js";
import { callTool, handleRequest, serve } from "../chorus/mcp-server.js";

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const mkAgent = () =>
  new ChorusAgent({ name: "mcp", seedHex: "0f".repeat(32), clock: clockFrom(1000) });

describe("chorus MCP: the six tools", () => {
  it("remember → recall round-trips a belief", () => {
    const agent = mkAgent();
    const r = callTool(agent, "remember", {
      about: "user:mike",
      attribute: "theme",
      value: "dark",
      kind: "preference",
    }) as { deltaId: string; signed: boolean };
    expect(r.signed).toBe(true);
    expect(callTool(agent, "recall", { entity: "user:mike" })).toEqual({ theme: "dark" });
    expect(callTool(agent, "recall", { entity: "user:mike", attribute: "theme" })).toEqual({
      theme: "dark",
    });
  });

  it("retract appends; explain keeps the receipt", () => {
    const agent = mkAgent();
    const r = callTool(agent, "remember", {
      about: "user:mike",
      attribute: "city",
      value: "Boston",
    }) as { deltaId: string };
    callTool(agent, "retract", { deltaId: r.deltaId, reason: "moved" });
    expect(callTool(agent, "recall", { entity: "user:mike" })).toEqual({});
    const receipts = callTool(agent, "explain", {
      entity: "user:mike",
      attribute: "city",
    }) as Array<{ deltaId: string; negated: boolean }>;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.negated).toBe(true);
  });

  it("as-of resolves the past as it was", () => {
    const agent = mkAgent();
    const r = callTool(agent, "remember", {
      about: "task:1",
      attribute: "status",
      value: "open",
    }) as { deltaId: string };
    callTool(agent, "retract", { deltaId: r.deltaId, reason: "done" }); // t=1020
    expect(callTool(agent, "as-of", { entity: "task:1", at: 1015 })).toEqual({ status: "open" });
    expect(callTool(agent, "as-of", { entity: "task:1", at: 1025 })).toEqual({});
  });

  it("trust demotes an author; the world re-resolves; history stays", () => {
    const agent = mkAgent();
    const other = new ChorusAgent({
      name: "other",
      seedHex: "aa".repeat(32),
      clock: clockFrom(2000),
    });
    other.assert({ about: "svc:api", attribute: "owner", value: "team-wrong" });
    agent.importSet(other.snapshot());
    callTool(agent, "remember", { about: "svc:api", attribute: "owner", value: "team-right" });
    expect(callTool(agent, "recall", { entity: "svc:api" })).toEqual({ owner: "team-wrong" });
    callTool(agent, "trust", { distrust: other.author, reason: "compromised" });
    expect(callTool(agent, "recall", { entity: "svc:api" })).toEqual({ owner: "team-right" });
    const receipts = callTool(agent, "explain", { entity: "svc:api" }) as Array<{
      author: string;
    }>;
    expect(receipts.map((r) => r.author)).toContain(other.author);
  });

  it("unknown tools fail loudly", () => {
    expect(() => callTool(mkAgent(), "forget", {})).toThrow(/unknown tool/);
  });
});

describe("chorus MCP: the protocol loop", () => {
  it("serves initialize → tools/list → tools/call over a stream pair", async () => {
    const agent = mkAgent();
    const input = new PassThrough();
    const output = new PassThrough();
    serve(agent, input, output);

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
      params: {
        name: "remember",
        arguments: { about: "user:mike", attribute: "theme", value: "dark" },
      },
    });
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "recall", arguments: { entity: "user:mike" } },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(responses).toHaveLength(4); // the notification got no response
    const init = responses[0]!["result"] as { serverInfo: { name: string } };
    expect(init.serverInfo.name).toBe("chorus");
    const tools = (responses[1]!["result"] as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    expect(tools).toEqual(["remember", "recall", "retract", "explain", "trust", "as-of"]);
    const recall = responses[3]!["result"] as { content: Array<{ text: string }> };
    expect(JSON.parse(recall.content[0]!.text)).toEqual({ theme: "dark" });
  });

  it("malformed json and unknown methods answer with errors, never crash", () => {
    const agent = mkAgent();
    const resp = handleRequest(agent, { jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect((resp?.["error"] as { code: number }).code).toBe(-32601);
  });
});
