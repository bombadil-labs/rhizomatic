// Discovery: topics, search, and identity-as-judgment (sameAs). Canonical ids without a
// registry: convergence is asserted, negatable, and read through per-reader trust.

import { describe, expect, it } from "vitest";
import { callTool, createSession } from "../chorus/mcp-server.js";
import { sameAsClass } from "../chorus/discovery.js";

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const mkCtx = (sessionId = "s1", t0 = 1000) =>
  createSession({ masterSeedHex: "0f".repeat(32), sessionId, clock: clockFrom(t0) });

describe("chorus discovery: topics & search", () => {
  it("topics lists what the store knows about, most recently touched first", () => {
    const ctx = mkCtx();
    callTool(ctx, "begin-session", { model: "claude-fable-5" });
    callTool(ctx, "remember", { about: "person:mike", attribute: "role", value: "founder" });
    callTool(ctx, "remember", { about: "person:mike", attribute: "city", value: "Denver" });
    callTool(ctx, "remember", { about: "proj:rhizomatic", attribute: "status", value: "shipping" });

    const all = callTool(ctx, "topics", {}) as Array<{
      entity: string;
      attributes: string[];
      claims: number;
    }>;
    expect(all.map((t) => t.entity)).toEqual(["proj:rhizomatic", "person:mike"]);
    expect(all[1]!.attributes).toEqual(["city", "role"]);
    expect(all[1]!.claims).toBe(2);
    // Internal entities (sessions, concepts) never pollute discovery.
    expect(all.some((t) => t.entity.startsWith("session:"))).toBe(false);

    const people = callTool(ctx, "topics", { prefix: "person:" }) as Array<{ entity: string }>;
    expect(people).toHaveLength(1);
  });

  it("search finds beliefs by value, attribute, or entity substring — survivors only", () => {
    const ctx = mkCtx();
    callTool(ctx, "remember", { about: "person:mike", attribute: "editor", value: "neovim" });
    const stale = callTool(ctx, "remember", {
      about: "person:mike",
      attribute: "os",
      value: "windows-vista",
    }) as { deltaId: string };
    callTool(ctx, "retract", { deltaId: stale.deltaId, reason: "upgraded, mercifully" });

    const hits = callTool(ctx, "search", { query: "VIM" }) as Array<{ value: unknown }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe("neovim");
    // The retracted claim is dead to discovery (still in explain, as ever).
    expect(callTool(ctx, "search", { query: "vista" })).toEqual([]);
  });
});

describe("chorus discovery: sameAs (canonical identity as judgment)", () => {
  it("two minted ids converge by one claim; unified recall reads the whole class", () => {
    const ctx = mkCtx();
    callTool(ctx, "begin-session", { model: "claude-fable-5" });
    // Two sessions' worth of vocabulary drift, one human.
    callTool(ctx, "remember", { about: "person:mike", attribute: "city", value: "Denver" });
    callTool(ctx, "remember", { about: "user:mbilokonsky", attribute: "editor", value: "neovim" });
    // Without the judgment, the views are islands.
    expect(callTool(ctx, "recall", { entity: "person:mike" })).toEqual({ city: "Denver" });

    callTool(ctx, "same", { a: "person:mike", b: "user:mbilokonsky", reason: "same human" });
    const unified = callTool(ctx, "recall", { entity: "person:mike", unified: true }) as {
      view: Record<string, unknown>;
      class: string[];
    };
    expect(unified.class).toEqual(["person:mike", "user:mbilokonsky"]);
    expect(unified.view).toEqual({ city: "Denver", editor: "neovim" });
  });

  it("equivalence is transitive; conflicting values surface as arrays, never hidden", () => {
    const ctx = mkCtx();
    callTool(ctx, "remember", { about: "a:1", attribute: "name", value: "Ada" });
    callTool(ctx, "remember", { about: "b:1", attribute: "name", value: "Ada L." });
    callTool(ctx, "remember", { about: "c:1", attribute: "born", value: 1815 });
    callTool(ctx, "same", { a: "a:1", b: "b:1" });
    callTool(ctx, "same", { a: "b:1", b: "c:1" });
    const unified = callTool(ctx, "recall", { entity: "c:1", unified: true }) as {
      view: Record<string, unknown>;
      class: string[];
    };
    expect(unified.class).toEqual(["a:1", "b:1", "c:1"]);
    expect(unified.view["born"]).toBe(1815);
    expect(unified.view["name"]).toEqual(["Ada", "Ada L."]); // the dispute is visible
  });

  it("a wrong sameAs dies by one negation — identity judgments are revisable", () => {
    const ctx = mkCtx();
    callTool(ctx, "remember", { about: "person:mike", attribute: "city", value: "Denver" });
    callTool(ctx, "remember", { about: "person:michael-b", attribute: "city", value: "Boston" });
    const j = callTool(ctx, "same", { a: "person:mike", b: "person:michael-b" }) as {
      deltaId: string;
    };
    expect(sameAsClass(ctx.agent, "person:mike")).toHaveLength(2);
    callTool(ctx, "retract", { deltaId: j.deltaId, reason: "different Michaels" });
    expect(sameAsClass(ctx.agent, "person:mike")).toEqual(["person:mike"]);
  });
});
