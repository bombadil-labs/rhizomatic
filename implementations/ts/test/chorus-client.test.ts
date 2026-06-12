// The real-client check: spawn the ACTUAL server process (the same command `claude mcp add`
// runs) and drive the full MCP stdio handshake the way Claude Code does — initialize with
// protocolVersion + clientInfo, initialized notification, ping, tools/list, tools/call —
// including across two sequential processes sharing one store.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "../chorus/mcp-server.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

const dir = mkdtempSync(join(tmpdir(), "chorus-client-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

class Client {
  private readonly proc: ChildProcess;
  private buffer = "";
  private readonly pending = new Map<number, (v: Record<string, unknown>) => void>();
  private nextId = 1;

  constructor(sessionId: string, storePath: string) {
    this.proc = spawn(process.execPath, [tsxCli, serverPath], {
      env: {
        ...process.env,
        CHORUS_MASTER_SEED: "0f".repeat(32),
        CHORUS_SESSION_ID: sessionId,
        CHORUS_STORE: storePath,
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (;;) {
        const nl = this.buffer.indexOf("\n");
        if (nl === -1) break;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line === "") continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg["id"];
        if (typeof id === "number") this.pending.get(id)?.(msg);
      }
    });
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const p = new Promise<Record<string, unknown>>((res, rej) => {
      this.pending.set(id, res);
      setTimeout(() => rej(new Error(`timeout waiting for ${method} (#${id})`)), 15_000);
    });
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return p;
  }

  notify(method: string): void {
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const resp = await this.request("tools/call", { name, arguments: args });
    const result = resp["result"] as { content: Array<{ text: string }>; isError?: boolean };
    if (result.isError === true) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text);
  }

  // The exact opening sequence Claude Code performs.
  async handshake(): Promise<Record<string, unknown>> {
    const init = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2.0.0" },
    });
    this.notify("notifications/initialized");
    return init;
  }

  close(): void {
    this.proc.stdin!.end();
    this.proc.kill();
  }
}

describe("chorus MCP: the spawned server, driven like a real client", () => {
  it("handshake → ping → tools → a working session → a second process resumes the world", async () => {
    const store = join(dir, "real.jsonl");

    // ── Process one: a session does real work. ──────────────────────────────────────────────
    const c1 = new Client("real-session-1", store);
    try {
      const init = await c1.handshake();
      const initResult = init["result"] as {
        protocolVersion: string;
        capabilities: { tools: object };
        serverInfo: { name: string };
      };
      expect(initResult.serverInfo.name).toBe("chorus");
      expect(initResult.capabilities.tools).toBeDefined();

      // Claude Code keepalives must get an empty result, not an error.
      const pong = await c1.request("ping");
      expect(pong["result"]).toEqual({});
      expect(pong["error"]).toBeUndefined();

      const list = await c1.request("tools/list");
      const names = (list["result"] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(names).toContain("begin-session");
      expect(names).toContain("briefing");
      expect(names).toHaveLength(16);

      await c1.call("begin-session", { model: "claude-fable-5", purpose: "client smoke" });
      await c1.call("remember", {
        about: "user:mike",
        attribute: "tone",
        value: "direct",
        kind: "preference",
        speaker: "user",
      });
      await c1.call("end-session", { summary: "verified the real handshake" });
      expect(await c1.call("recall", { entity: "user:mike" })).toEqual({ tone: "direct" });
    } finally {
      c1.close();
    }

    // ── Process two: a fresh server on the same store picks up the world. ──────────────────
    const c2 = new Client("real-session-2", store);
    try {
      await c2.handshake();
      await c2.call("begin-session", { model: "claude-fable-5", purpose: "second process" });
      const b = (await c2.call("briefing", {})) as {
        preferences: Array<{ value: unknown }>;
        recentSessions: Array<{ sessionId: string; summary?: string }>;
      };
      expect(b.preferences.map((p) => p.value)).toContain("direct");
      const s1 = b.recentSessions.find((s) => s.sessionId === "real-session-1")!;
      expect(s1.summary).toBe("verified the real handshake");
    } finally {
      c2.close();
    }
  }, 60_000);
});
