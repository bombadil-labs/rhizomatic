// The existing read vector families, run a second time through a store (SPEC-18 slice 2 plan §5,
// O2). Each family's deltas go into a memory store peer by the test fixture loader; the expected
// bytes are the family's own, unchanged.
//
// - The SPEC-17 anchored read cases (`eval-anchored.json`, `readCases`) through `readAnchored`,
//   with their scope and members; its scope cases through `fetchScope`.
// - Every other evaluation case of `vectors/l1-eval`: an anchored term through `readAnchored`,
//   an unanchored one through `readFullSurface`, the explicit full-surface read of §6.6.
// - The negation-witness cases (`l2-reactor/governed.json`, `witnesses`) through the free
//   readers over a fetched scope: the scope of the entities the target points at.
// - The principal cases run over a fetched scope in `principal-store.test.ts` (plan step 3).
//
// Not run on the store in slice 2, and why:
// - The rejects of `l1-eval` and the parse and strict-key files: they refuse a term before any
//   read, so a store adds nothing to them.
// - `l1-eval/schema-deltas.json`, `l3-schema/governed-bindings.json`, and the `governed` and
//   `latestByKey` cases of `l2-reactor/governed.json`: whole-set loads with no anchor. Their store
//   form is a full-surface read, which the evaluation cases already cover.
// - Ingest, dispatch and the journal: the transaction, atomic-transfer, materialization, command
//   and peer families. Their subject is not a read. Slices 3 and 4 move them onto a store.
// - The SPEC-14 `actsFor` cases: their resolver takes a whole input set (principal-store.test.ts).
//
// The original run of every family over a `DeltaSet` or a `Reactor` stays in its own file.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/delta/json-profile.js";
import { negationPredicate, negationWitnesses } from "../src/delta/negation.js";
import { makeDelta } from "../src/delta/set.js";
import type { Delta } from "../src/delta/types.js";
import { fetchScope, readAnchored, readFullSurface } from "../src/reactor/store-read.js";
import { anchorAnalysis } from "../src/resolve/anchored.js";
import { resultCanonicalHex } from "../src/resolve/eval.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import { parseSchema, parseTerm } from "../src/syntax/term-json.js";
import { FIXTURE_PEER, loadPeer, type LoadedPeer } from "./support/store-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(here, "../../../vectors", path), "utf8"));
const NOW = 1_000_000_000_000_000;

type Fixture = { name: string; id: string; claims: unknown }[];
type EvalDocument = {
  fixture: { deltas: Fixture } | Record<string, { id: string; claims: unknown }>;
  schemas?: { name: string; alg: number; body: unknown }[];
  readings?: unknown[];
  cases: {
    name: string;
    term: unknown;
    root?: string;
    now?: number;
    input?: string[];
    expectedCanonicalHex: string;
  }[];
};

/** The deltas of a fixture by name, each checked against its pinned id. */
function fixtureOf(document: EvalDocument): Map<string, Delta> {
  const entries = Array.isArray((document.fixture as { deltas?: Fixture }).deltas)
    ? (document.fixture as { deltas: Fixture }).deltas
    : Object.entries(document.fixture).map(([name, entry]) => ({ name, ...entry }));
  const named = new Map<string, Delta>();
  for (const entry of entries) {
    const delta = makeDelta(parseClaims(entry.claims));
    expect(delta.id, entry.name).toBe(entry.id);
    named.set(entry.name, delta);
  }
  return named;
}

const registryOf = (document: EvalDocument): SchemaRegistry =>
  SchemaRegistry.build(
    (document.schemas ?? []).map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
    (document.readings ?? []).map((r) => parseSchema(r)),
  );

/** Every evaluation family and the root its own test evaluates at, when it names one. */
const FAMILIES: readonly { readonly file: string; readonly root?: string }[] = [
  { file: "eval-basic.json" },
  { file: "eval-setalgebra.json" },
  { file: "eval-relational.json" },
  { file: "eval-reflective.json" },
  { file: "eval-hview.json" },
  { file: "eval-expand.json" },
  { file: "eval-holes.json" },
  { file: "eval-aliased.json" },
  { file: "eval-resolve.json" },
  { file: "eval-distinct.json" },
  { file: "eval-bytes.json" },
  { file: "eval-time.json", root: "entity:time" },
];

/** How many cases of each family ran each way. The last test pins the table. */
const routed: Record<string, { anchored: number; fullSurface: number }> = {};

async function onSnapshot<T>(
  loaded: LoadedPeer,
  run: (snapshot: Awaited<ReturnType<LoadedPeer["peer"]["read"]>>) => Promise<T>,
): Promise<T> {
  const snapshot = await loaded.peer.read();
  try {
    return await run(snapshot);
  } finally {
    snapshot.release();
  }
}

describe("l1-eval evaluation cases through a store", () => {
  for (const family of FAMILIES) {
    it(family.file, async () => {
      const document = read(`l1-eval/${family.file}`) as EvalDocument;
      const named = fixtureOf(document);
      const registry = registryOf(document);
      const counts = { anchored: 0, fullSurface: 0 };
      // One load serves every case that reads the whole fixture.
      const whole = await loadPeer(named.values());
      for (const c of document.cases) {
        const loaded =
          c.input === undefined ? whole : await loadPeer(c.input.map((name) => named.get(name)!));
        const held = c.input?.length ?? named.size;
        const term = parseTerm(c.term);
        const now = c.now ?? NOW;
        const root = c.root ?? family.root;
        const analysis = anchorAnalysis(term, registry);
        if (analysis.anchored) {
          // A term that reads no root still needs one to start the rounds: its first static
          // anchor, which round 1 fetches anyway.
          const start = root ?? analysis.anchors[0];
          expect(
            start,
            `${c.name}: an anchored term with no root and no static anchor`,
          ).toBeDefined();
          const got = await onSnapshot(loaded, (snapshot) =>
            readAnchored(snapshot, { term, root: start!, now, registry }),
          );
          expect(resultCanonicalHex(got.result), c.name).toBe(c.expectedCanonicalHex);
          counts.anchored += 1;
        } else {
          const got = await readFullSurface(loaded.store.openAdmin().peer(FIXTURE_PEER), {
            term,
            now,
            registry,
            ...(root === undefined ? {} : { root }),
          });
          expect(resultCanonicalHex(got.result), c.name).toBe(c.expectedCanonicalHex);
          expect(got.route, c.name).toEqual({ optimized: false, listed: held, admitted: held });
          counts.fullSurface += 1;
        }
      }
      routed[family.file] = counts;
    });
  }
});

describe("l1-eval anchored cases through a store", () => {
  const document = read("l1-eval/eval-anchored.json") as {
    fixture: { deltas: Fixture };
    schemas: { name: string; alg: number; body: unknown }[];
    scopeCases: {
      name: string;
      entities: string[];
      excluded?: string[];
      expectedMembers: string[];
    }[];
    readCases: {
      name: string;
      term: unknown;
      root: string;
      now: number;
      expectedScope: string[];
      expectedMembers: string[];
      expectedCanonicalHex: string;
    }[];
  };
  const named = fixtureOf(document as unknown as EvalDocument);
  const nameOf = new Map([...named].map(([name, delta]) => [delta.id, name]));
  const names = (ids: readonly string[]): string[] => ids.map((id) => nameOf.get(id) ?? id);
  const registry = registryOf(document as unknown as EvalDocument);

  it("each read case through readAnchored: the same bytes, scope and members", async () => {
    const loaded = await loadPeer(named.values());
    for (const c of document.readCases) {
      const got = await onSnapshot(loaded, (snapshot) =>
        readAnchored(snapshot, { term: parseTerm(c.term), root: c.root, now: c.now, registry }),
      );
      expect(resultCanonicalHex(got.result), c.name).toBe(c.expectedCanonicalHex);
      expect(got.scope, c.name).toEqual(c.expectedScope);
      expect(names(got.members), c.name).toEqual(c.expectedMembers);
    }
    expect(document.readCases.length).toBe(8);
  });

  it("each scope case through fetchScope, its exclusions as a pushdown", async () => {
    const loaded = await loadPeer(named.values());
    for (const c of document.scopeCases) {
      const excludeIds = (c.excluded ?? []).map((name) => named.get(name)!.id);
      const { source } = await onSnapshot(loaded, (snapshot) =>
        fetchScope(
          snapshot,
          c.entities,
          excludeIds.length === 0 ? {} : { pushdown: { excludeIds } },
        ),
      );
      // The vector lists members by name, in id order.
      expect(names(source.ids()), c.name).toEqual(c.expectedMembers);
    }
    expect(document.scopeCases.length).toBe(6);
  });
});

describe("l2-reactor negation-witness cases over a fetched scope", () => {
  const document = read("l2-reactor/governed.json") as {
    deltas: Fixture;
    witnesses: { now: number; target: string; permittedAuthors: string[]; expectedIds: string[] }[];
  };
  const named = new Map<string, Delta>();
  for (const entry of document.deltas) {
    const delta = makeDelta(parseClaims(entry.claims));
    expect(delta.id, entry.name).toBe(entry.id);
    named.set(entry.name, delta);
  }
  // A target the vectors name but no delta is: it points at nothing, so the read fetches an
  // entity the fixture uses, and the target reads as not held.
  const ABSENT = `1e20${"00".repeat(32)}`;

  it("each case through negationWitnesses and negationPredicate over the target's scope", async () => {
    const loaded = await loadPeer(named.values());
    let nonEmpty = 0;
    for (const c of document.witnesses) {
      const target = named.get(c.target);
      const entities = target?.claims.pointers.flatMap((p) =>
        p.target.kind === "entity" ? [p.target.entity.id] : [],
      ) ?? ["person:myk"];
      const { source } = await onSnapshot(loaded, (snapshot) => fetchScope(snapshot, entities));
      const permitted = new Set(c.permittedAuthors);
      const suppression = (negation: Delta): boolean => permitted.has(negation.claims.author);
      const id = target?.id ?? ABSENT;
      const label = `${c.target} at ${c.now} by ${c.permittedAuthors.join("")}`;
      expect(
        negationWitnesses(source, c.now, suppression)(id).map((d) => d.id),
        label,
      ).toEqual(c.expectedIds);
      expect(negationPredicate(source, c.now, suppression)(id), label).toBe(
        c.expectedIds.length > 0,
      );
      if (c.expectedIds.length > 0) nonEmpty += 1;
    }
    expect(document.witnesses.length).toBe(12);
    expect(nonEmpty).toBeGreaterThanOrEqual(6);
  });
});

describe("the second run reaches every evaluation case", () => {
  it("routes each family's cases as pinned", () => {
    // Every case of a family ran, and each ran the way its term's anchors decide. A family that
    // stopped running, or a term that changed sides, shows here.
    const expected = Object.fromEntries(
      FAMILIES.map(({ file }) => [file, (read(`l1-eval/${file}`) as EvalDocument).cases.length]),
    );
    const ran = Object.fromEntries(
      Object.entries(routed).map(([file, n]) => [file, n.anchored + n.fullSurface]),
    );
    expect(ran).toEqual(expected);
    // Measured, not chosen: the anchor analysis of each case's term decides its route.
    expect(routed).toEqual({
      "eval-basic.json": { anchored: 0, fullSurface: 15 },
      "eval-setalgebra.json": { anchored: 0, fullSurface: 8 },
      "eval-relational.json": { anchored: 0, fullSurface: 9 },
      "eval-reflective.json": { anchored: 0, fullSurface: 5 },
      "eval-hview.json": { anchored: 10, fullSurface: 1 },
      "eval-expand.json": { anchored: 8, fullSurface: 0 },
      "eval-holes.json": { anchored: 6, fullSurface: 0 },
      "eval-aliased.json": { anchored: 0, fullSurface: 9 },
      "eval-resolve.json": { anchored: 15, fullSurface: 0 },
      "eval-distinct.json": { anchored: 7, fullSurface: 0 },
      "eval-bytes.json": { anchored: 6, fullSurface: 0 },
      "eval-time.json": { anchored: 4, fullSurface: 9 },
    });
  });
});
