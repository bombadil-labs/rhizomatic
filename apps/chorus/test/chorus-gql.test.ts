// GraphQL on demand: prepare a schema from a pinned snapshot, query it, release it. The schema
// is a pure function of (snapshot, policy) — never stored, never maintained. The pin is what
// makes a long retrospective walk read one consistent world while the live store moves on.

import { describe, expect, it } from "vitest";
import { callTool, createSession, type SessionContext } from "../src/mcp-server.js";
import { GqlRegistry, prepareGql, queryGql } from "../src/gql.js";

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const mkCtx = (sessionId = "s1", t0 = 1000): SessionContext =>
  createSession({ masterSeedHex: "0f".repeat(32), sessionId, clock: clockFrom(t0) });

// Seed the motivating example: a movie night occasioned a thesis about individuation, which
// invokes the concept and references two characters; plus a couple of plain works.
function seed(ctx: SessionContext): void {
  callTool(ctx, "begin-session", { model: "claude-opus-4-8", topics: ["proj:chorus"] });
  // "references" is set-valued — declare it, the way the store learns any set attribute.
  callTool(ctx, "remember", { about: "attr:references", attribute: "plurality", value: "set" });

  callTool(ctx, "remember", {
    about: "event:movie-night",
    attribute: "occasioned",
    value: { entity: "idea:individuation-thesis" },
  });
  callTool(ctx, "remember", {
    about: "idea:individuation-thesis",
    attribute: "invokes",
    value: { entity: "concept:individuation" },
  });
  callTool(ctx, "remember", {
    about: "idea:individuation-thesis",
    attribute: "references",
    value: { entity: "character:shadow" },
  });
  callTool(ctx, "remember", {
    about: "idea:individuation-thesis",
    attribute: "references",
    value: { entity: "character:self" },
  });
  callTool(ctx, "remember", {
    about: "work:the-last-jedi",
    attribute: "title",
    value: "The Last Jedi",
  });
  callTool(ctx, "remember", { about: "work:the-last-jedi", attribute: "year", value: 2017 });
}

describe("chorus gql: schema synthesis", () => {
  it("reflects entity-types, reference edges, set cardinality, and scalar kinds", () => {
    const ctx = mkCtx();
    seed(ctx);
    const p = prepareGql(ctx.agent);

    // A type per entity-id prefix; reference targets get a type even with nothing asserted ABOUT
    // them (concept:individuation, the characters).
    expect(p.sdl).toContain("type Idea implements Node");
    expect(p.sdl).toContain("type Concept implements Node");
    expect(p.sdl).toContain("type Character implements Node");

    // Reference attributes are typed by their target; a declared-set one is a list.
    expect(p.sdl).toMatch(/invokes: Concept/);
    expect(p.sdl).toMatch(/references: \[Character!\]/);
    expect(p.sdl).toMatch(/occasioned: Idea/);

    // Primitive kinds are narrowed from observation.
    expect(p.sdl).toMatch(/title: String/);
    expect(p.sdl).toMatch(/year: Int/);

    // Reverse adjacency is first-class on every node and at the root.
    expect(p.sdl).toContain("backlinks(");
    expect(p.typeCount).toBeGreaterThanOrEqual(5);
    expect(p.deltaCount).toBeGreaterThan(0);
  });
});

describe("chorus gql: querying a pinned snapshot", () => {
  it("walks forward through reference edges, hop by hop", async () => {
    const ctx = mkCtx();
    seed(ctx);
    const p = prepareGql(ctx.agent);

    const r = await queryGql(
      ctx.agent,
      p,
      `{ event(id: "event:movie-night") { occasioned { id invokes { id } } } }`,
    );
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({
      event: {
        occasioned: {
          id: "idea:individuation-thesis",
          invokes: { id: "concept:individuation" },
        },
      },
    });
  });

  it("returns every member of a set-valued reference attribute", async () => {
    const ctx = mkCtx();
    seed(ctx);
    const p = prepareGql(ctx.agent);

    const r = await queryGql(
      ctx.agent,
      p,
      `{ idea(id: "idea:individuation-thesis") { references { id } } }`,
    );
    expect(r.errors).toBeUndefined();
    const refs = (r.data!["idea"] as { references: Array<{ id: string }> }).references;
    expect(refs.map((x) => x.id).sort()).toEqual(["character:self", "character:shadow"]);
  });

  it("reads narrowed scalars with their JSON types intact", async () => {
    const ctx = mkCtx();
    seed(ctx);
    const p = prepareGql(ctx.agent);

    const r = await queryGql(ctx.agent, p, `{ work(id: "work:the-last-jedi") { title year } }`);
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({ work: { title: "The Last Jedi", year: 2017 } });
  });

  it("walks BACKWARD: who points at a concept, role-discriminated, no substring scan", async () => {
    const ctx = mkCtx();
    seed(ctx);
    const p = prepareGql(ctx.agent);

    const r = await queryGql(
      ctx.agent,
      p,
      `{ backlinks(target: "concept:individuation") { source attribute role } }`,
    );
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({
      backlinks: [
        {
          source: "idea:individuation-thesis",
          attribute: "invokes",
          role: "chorus.belief.value",
        },
      ],
    });
  });

  it("follows a backlink into its source node — reverse traversal, one hop", async () => {
    const ctx = mkCtx();
    seed(ctx);
    const p = prepareGql(ctx.agent);

    const r = await queryGql(
      ctx.agent,
      p,
      `{ concept(id: "concept:individuation") { backlinks { sourceNode { id ... on Idea { invokes { id } } } } } }`,
    );
    expect(r.errors).toBeUndefined();
    const links = (
      r.data!["concept"] as {
        backlinks: Array<{ sourceNode: { id: string; invokes: { id: string } } }>;
      }
    ).backlinks;
    expect(links[0]!.sourceNode.id).toBe("idea:individuation-thesis");
    expect(links[0]!.sourceNode.invokes.id).toBe("concept:individuation");
  });
});

describe("chorus gql: through the MCP tool surface", () => {
  it("prepare → query → release, end to end as an agent would call it", () => {
    const ctx = mkCtx();
    seed(ctx);

    const prep = callTool(ctx, "gql-prepare", {}) as {
      prepId: string;
      sdl: string;
      typeCount: number;
    };
    expect(prep.prepId).toMatch(/^gql-/);
    expect(prep.sdl).toContain("type Query");
    expect(prep.typeCount).toBeGreaterThanOrEqual(5);

    // Forward + backward in one query, through the tool.
    const r = callTool(ctx, "gql-query", {
      prepId: prep.prepId,
      query: `{
        event(id: "event:movie-night") { occasioned { invokes { id } } }
        backlinks(target: "character:self") { source attribute }
      }`,
    }) as { data?: Record<string, unknown>; errors?: string[] };
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({
      event: { occasioned: { invokes: { id: "concept:individuation" } } },
      backlinks: [{ source: "idea:individuation-thesis", attribute: "references" }],
    });

    // The pin shows up in the list, then releases.
    const live = callTool(ctx, "gql-list", {}) as Array<{ id: string }>;
    expect(live.some((p) => p.id === prep.prepId)).toBe(true);
    expect(callTool(ctx, "gql-release", { prepId: prep.prepId })).toEqual({ released: true });
    expect(callTool(ctx, "gql-list", {})).toEqual([]);
  });
});

describe("chorus gql: the pin is frozen", () => {
  it("a prepared snapshot does not see writes that land after it; regenerating does", async () => {
    const ctx = mkCtx();
    seed(ctx);
    const reg = new GqlRegistry();
    const p1 = reg.prepare(ctx.agent);

    // The world moves on AFTER the pin.
    callTool(ctx, "remember", { about: "work:dune", attribute: "title", value: "Dune" });

    // The pinned snapshot is unmoved — work:dune did not exist when it was pinned, so the node
    // resolves to null (not merely a null title): the entity genuinely is not in that world.
    const frozen = await reg.query(ctx.agent, p1.id, `{ work(id: "work:dune") { title } }`);
    expect(frozen.errors).toBeUndefined();
    expect(frozen.data).toEqual({ work: null });

    // A fresh pin sees the new world.
    const p2 = reg.prepare(ctx.agent);
    const live = await reg.query(ctx.agent, p2.id, `{ work(id: "work:dune") { title } }`);
    expect(live.data).toEqual({ work: { title: "Dune" } });

    // Release retires a pin; querying it afterwards is an error.
    expect(reg.release(p1.id)).toBe(true);
    await expect(reg.query(ctx.agent, p1.id, `{ node(id: "x") { id } }`)).rejects.toThrow(
      /unknown prepared snapshot/,
    );
  });
});
