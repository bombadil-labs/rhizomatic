// The console: the human's surface. Smoke the HTTP API end to end against a real store file —
// state, entity receipts with identity, the as-of scrubber's backend, and a trust edit signed
// by the USER's key and honored by sessions that load the store afterwards.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startConsole, type ConsoleHandle } from "../chorus/console.js";
import { SharedStore } from "../chorus/shared-store.js";
import { callTool, createSession } from "../chorus/mcp-server.js";

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const MASTER = "0f".repeat(32);
const dir = mkdtempSync(join(tmpdir(), "chorus-console-"));
const handles: ConsoleHandle[] = [];
afterAll(() => {
  for (const h of handles) h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("chorus console", () => {
  it("serves the page, the briefing, receipts with identity, as-of, and user-signed distrust", async () => {
    const file = join(dir, "console.jsonl");
    // A model session does some work first.
    const s1 = createSession({
      masterSeedHex: MASTER,
      sessionId: "workday",
      clock: clockFrom(1000),
    });
    callTool(s1, "begin-session", { model: "claude-fable-5", purpose: "console fixture" });
    const stale = callTool(s1, "remember", {
      about: "svc:api",
      attribute: "owner",
      value: "team-old",
    }) as { deltaId: string };
    callTool(s1, "revise", { deltaId: stale.deltaId, value: "team-new", reason: "reorg" });
    callTool(s1, "remember", {
      about: "user:mike",
      attribute: "tone",
      value: "direct",
      kind: "preference",
      speaker: "user",
    });
    callTool(s1, "end-session", { summary: "fixture session" });
    new SharedStore(file).persist(s1.agent);

    const h = await startConsole({ storePath: file, masterSeedHex: MASTER, port: 0 });
    handles.push(h);

    // The page itself.
    const page = await (await fetch(h.url)).text();
    expect(page).toContain("Chorus console");

    // The state: briefing + topics.
    const state = (await (await fetch(`${h.url}api/state`)).json()) as {
      briefing: {
        preferences: Array<{ value: unknown }>;
        recentSessions: Array<{ summary?: string }>;
      };
      topics: Array<{ entity: string }>;
    };
    expect(state.briefing.preferences.map((p) => p.value)).toContain("direct");
    expect(state.topics.map((t) => t.entity)).toContain("svc:api");

    // Entity receipts: revised claim visible as retracted, identity attached.
    const entity = (await (
      await fetch(`${h.url}api/entity?id=${encodeURIComponent("svc:api")}`)
    ).json()) as {
      view: Record<string, unknown>;
      receipts: Array<{ value: unknown; negated: boolean; who: string; attribute?: string }>;
    };
    expect(entity.view).toEqual({ owner: "team-new" });
    const old = entity.receipts.find((r) => r.value === "team-old")!;
    expect(old.negated).toBe(true);
    expect(old.who).toContain("claude-fable-5");
    expect(old.attribute).toBe("owner");

    // The scrubber's backend: before the revision, the old value resolves.
    const then = (await (
      await fetch(`${h.url}api/entity?id=${encodeURIComponent("svc:api")}&at=1025`)
    ).json()) as { view: Record<string, unknown> };
    expect(then.view).toEqual({ owner: "team-old" });

    // A trust edit from the console is signed by the USER and lands in the store…
    const sessionAuthor = s1.agent.author;
    await fetch(`${h.url}api/distrust`, {
      method: "POST",
      body: JSON.stringify({ author: sessionAuthor, reason: "testing the lever" }),
    });
    // …where a later session rehydrates it via its briefing.
    const s2 = createSession({ masterSeedHex: MASTER, sessionId: "after", clock: clockFrom(9000) });
    new SharedStore(file).refresh(s2.agent);
    const b = callTool(s2, "briefing", {}) as {
      distrusted: Array<{ author: string; by: string }>;
    };
    const edit = b.distrusted.find((d) => d.author === sessionAuthor)!;
    expect(edit.by).toBe(s2.userAuthor); // signed by the human, not by any session
  }, 30_000);
});
