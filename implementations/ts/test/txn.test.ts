import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/json-profile.js";
import { Reactor, makeManifestClaims, manifestMemberIds } from "../src/reactor.js";
import { SchemaRegistry } from "../src/schema.js";
import { makeDelta } from "../src/set.js";
import { parseSchema, parseTerm } from "../src/term-json.js";
import type { Delta } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const expandDoc = JSON.parse(
  readFileSync(resolve(here, "../../../vectors/l1-eval/eval-expand.json"), "utf8"),
) as {
  fixture: { deltas: Array<{ name: string; claims: unknown }> };
  readings: unknown[];
  schemas: Array<{ name: string; alg: number; body: unknown }>;
};
const baseDeltas = expandDoc.fixture.deltas.map((d) => makeDelta(parseClaims(d.claims)));
const registry = SchemaRegistry.build(
  expandDoc.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
  expandDoc.readings.map((r) => parseSchema(r)),
);

function manifestFor(members: readonly Delta[], intent?: string): Delta {
  return makeDelta(
    makeManifestClaims(
      "did:key:zBundler",
      5000,
      members.map((m) => m.id),
      intent === undefined ? {} : { intent },
    ),
  );
}

describe("transaction manifests + atomic bundles (SPEC-1 §9 / SPEC-4 §6)", () => {
  it("manifests are ordinary deltas; member ids recover by hash", () => {
    const manifest = manifestFor(baseDeltas.slice(0, 3), "test bundle");
    expect(manifest.id.startsWith("1e20")).toBe(true);
    expect(manifestMemberIds(manifest)).toEqual(baseDeltas.slice(0, 3).map((d) => d.id));
  });

  it("an atomic bundle becomes visible to dispatch in ONE step", () => {
    const r = new Reactor();
    r.register("deep", registry.get("MovieDeep")!.body, ["movie:matrix"], registry);
    const events: number[] = [];
    r.subscribe("deep", () => events.push(1));
    const manifest = manifestFor(baseDeltas);
    expect(r.ingestBundle(manifest, baseDeltas).status).toBe("accepted");
    // one refresh, one change event — not one per member
    expect(events).toHaveLength(1);
    const change = r.changesFromLastIngest()[0]!;
    expect(change.responsibleDeltaIds).toContain(baseDeltas[0]!.id);
    expect(r.holdsAllMembers(manifest.id)).toBe(true);
  });

  it("a bundle with an invalid member is rejected wholesale, leaving no trace", () => {
    const r = new Reactor();
    const bad: Delta = { ...baseDeltas[1]!, id: `1e20${"00".repeat(32)}` };
    const manifest = manifestFor([baseDeltas[0]!, bad]);
    const result = r.ingestBundle(manifest, [baseDeltas[0]!, bad]);
    expect(result.status).toBe("rejected");
    expect(r.size).toBe(0);
  });

  it("a member not claimed by the manifest is rejected", () => {
    const r = new Reactor();
    const manifest = manifestFor([baseDeltas[0]!]);
    const result = r.ingestBundle(manifest, [baseDeltas[0]!, baseDeltas[1]!]);
    expect(result.status).toBe("rejected");
    expect(r.size).toBe(0);
  });

  it("completeness is a verifiable hash check", () => {
    const r = new Reactor();
    const manifest = manifestFor(baseDeltas.slice(0, 2));
    // ingest the manifest WITHOUT one member: completeness check fails
    r.ingest(baseDeltas[0]!);
    r.ingest(manifest);
    expect(r.holdsAllMembers(manifest.id)).toBe(false);
    r.ingest(baseDeltas[1]!);
    expect(r.holdsAllMembers(manifest.id)).toBe(true);
  });

  it("raw-stream subscribers see every accepted delta", () => {
    const r = new Reactor();
    const seen: string[] = [];
    r.subscribeRaw((d) => seen.push(d.id));
    const manifest = manifestFor(baseDeltas.slice(0, 2));
    r.ingestBundle(manifest, baseDeltas.slice(0, 2));
    expect(seen).toHaveLength(3); // 2 members + the manifest
  });
});
