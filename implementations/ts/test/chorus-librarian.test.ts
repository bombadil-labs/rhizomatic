// The librarian (Phase 3): an effectful derived author converges two vocabularies through
// concept slots — and a wrong mapping dies by one signed negation. Mock embeddings: CI is
// deterministic; a real model plugs into the same interface at runtime.

import { describe, expect, it } from "vitest";
import {
  ChorusAgent,
  Librarian,
  MockEmbeddingModel,
  declareConcept,
  slotId,
} from "../chorus/index.js";

const clockFrom = (start: number) => {
  let t = start;
  return () => (t += 10);
};

const SEED_HUB = "11".repeat(32);
const SEED_A = "22".repeat(32);
const SEED_B = "33".repeat(32);
const SEED_L = "66".repeat(32);

// A 2D concept space: the organization axis and the person axis.
const model = new MockEmbeddingModel("mock-embed-v1", {
  organization: [1, 0],
  worker: [0, 1],
  employer: [0.97, 0.05],
  job: [0.9, 0.1],
  org: [0.99, 0.01],
  staff: [0.08, 0.97],
  employees: [0.03, 0.99],
  boss: [0.9, 0.3], // similar enough to map — and wrong enough for a human to veto
  manager: [0.6, 0.75], // genuinely ambiguous: below threshold, never mapped
});

const EMPLOYMENT = "concept:employment";

function world() {
  const hub = new ChorusAgent({ name: "hub", seedHex: SEED_HUB, clock: clockFrom(1000) });
  // A human declares the concept; the librarian only ever maps INTO declared slots.
  declareConcept(hub, EMPLOYMENT, ["worker", "organization"]);
  const librarian = new Librarian(hub, { name: "librarian-v1", seedHex: SEED_L, model });

  // Two applications that never met describe employment differently (docs/agents.html).
  const appA = new ChorusAgent({ name: "appA", seedHex: SEED_A, clock: clockFrom(2000) });
  appA.assert({
    about: "person:ada",
    attribute: "employer",
    value: { entity: "company:acme", context: "employees" },
    kind: "fact",
  });
  const appB = new ChorusAgent({ name: "appB", seedHex: SEED_B, clock: clockFrom(3000) });
  appB.assert({
    about: "person:bob",
    attribute: "job",
    value: { entity: "company:initech", context: "staff" },
    kind: "fact",
  });
  appB.assert({
    about: "person:eve",
    attribute: "boss",
    value: { entity: "person:carol" },
    kind: "fact",
  });
  hub.importSet(appA.snapshot());
  hub.importSet(appB.snapshot());
  return { hub, librarian };
}

// All live (non-negated) mapping deltas for a fragment, as (fragment, slot) pairs.
function mappingsOf(hub: ChorusAgent, fragment: string): string[] {
  const out: string[] = [];
  for (const d of hub.snapshot()) {
    const f = d.claims.pointers.find(
      (p) =>
        p.role === "rhizomatic.alias.fragment" &&
        p.target.kind === "primitive" &&
        p.target.value === fragment,
    );
    if (f === undefined) continue;
    for (const p of d.claims.pointers) {
      if (p.role === "rhizomatic.alias.slot" && p.target.kind === "entity") {
        out.push(`${d.id}:${p.target.entity.id}`);
      }
    }
  }
  return out;
}

describe("chorus: the librarian (judgment as an author)", () => {
  it("converges two dialects through concept slots; recall crosses, output stays native", () => {
    const { hub, librarian } = world();

    // The librarian mapped both dialects' fragments into the declared slots.
    expect(mappingsOf(hub, "employer")).toHaveLength(1);
    expect(mappingsOf(hub, "job")).toHaveLength(1);
    expect(mappingsOf(hub, "staff")).toHaveLength(1);
    expect(mappingsOf(hub, "employees")).toHaveLength(1);
    // The ambiguous fragment was never mapped: no judgment, no claim.
    expect(mappingsOf(hub, "manager")).toHaveLength(0);

    // ALIAS-CLOSURE RECALL, live: ask in A's dialect, find B's data — each answer in the
    // TARGET's own vocabulary (matching, never renaming — SPEC-9 §4.1).
    expect(hub.recall("person:bob", { attribute: "employer", aliasedVia: EMPLOYMENT })).toEqual({
      job: "company:initech",
    });
    expect(hub.recall("person:ada", { attribute: "employer", aliasedVia: EMPLOYMENT })).toEqual({
      employer: "company:acme",
    });
    // Without the closure, the cross-dialect question finds nothing.
    expect(hub.recall("person:bob", { attribute: "employer" })).toEqual({});

    // Every mapping is a signed claim by the MODEL's author, confidence-scored.
    const [m] = mappingsOf(hub, "employer");
    const delta = hub.peer.reactor.get(m!.split(":")[0]!)!;
    expect(delta.claims.author).toBe(librarian.author);
    expect(delta.sig).toBeDefined();
    const conf = delta.claims.pointers.find((p) => p.role === "rhizomatic.alias.confidence");
    expect(conf?.target.kind === "primitive" && typeof conf.target.value === "number").toBe(true);
  });

  it("a wrong mapping dies by one signed negation — and is never re-litigated", () => {
    const { hub } = world();

    // The model glued "boss" (a person!) onto the organization slot. Visible immediately:
    expect(mappingsOf(hub, "boss")).toHaveLength(1);
    expect(hub.recall("person:eve", { attribute: "employer", aliasedVia: EMPLOYMENT })).toEqual({
      boss: "person:carol",
    });

    // A human vetoes the mapping with one negation. No reindex, no rebuild.
    const mappingId = mappingsOf(hub, "boss")[0]!.split(":")[0]!;
    hub.retract(mappingId, "boss names a person, not an organization");

    // The closure updates instantly: eve's boss no longer answers an employer question.
    expect(hub.recall("person:eve", { attribute: "employer", aliasedVia: EMPLOYMENT })).toEqual({});
    // …while the other mappings stand.
    expect(hub.recall("person:bob", { attribute: "employer", aliasedVia: EMPLOYMENT })).toEqual({
      job: "company:initech",
    });

    // New traffic triggers new librarian cycles — the vetoed judgment is NOT re-emitted.
    hub.assert({ about: "person:zed", attribute: "job", value: { entity: "company:acme" } });
    expect(mappingsOf(hub, "boss")).toHaveLength(1); // still just the negated original
  });

  it("the vectors never enter the substrate; the model is an author with a track record", () => {
    const { hub, librarian } = world();
    // Judgments persist; vectors do not: no delta carries embedding-ish payloads.
    for (const d of hub.snapshot()) {
      for (const p of d.claims.pointers) {
        expect(p.role.includes("embed")).toBe(false);
        expect(p.role.includes("vector")).toBe(false);
      }
    }
    // A new model version is a NEW author: its judgments build their own track record.
    const v2 = new Librarian(hub, {
      name: "librarian-v2",
      seedHex: "77".repeat(32),
      model: new MockEmbeddingModel("mock-embed-v2", { organization: [1, 0], worker: [0, 1] }),
    });
    expect(v2.author).not.toBe(librarian.author);
    expect(librarian.author).not.toBe(hub.author);
    expect(librarian.author.startsWith("ed25519:")).toBe(true);
  });

  it("slot ids are plain entities; the # spelling is convention", () => {
    expect(slotId(EMPLOYMENT, "worker")).toBe("concept:employment#worker");
  });
});
