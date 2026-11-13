// The model behind vectors/store/rounds.json (SPEC-18 proposal §4.4, §8 "round vectors"). Every
// expectation comes from plain lists: the peer's holdings are an array, a selection is a filter
// over it, the answer is `evalTerm` over everything the filter keeps, and a scope is `scopeOver`
// scanning that array. Nothing here opens a store or runs the store-backed read.

import { compareUtf8 } from "../src/delta/cbor.js";
import { claimsToJson } from "../src/delta/json-profile.js";
import { DeltaSet, makeDelta, makeNegationClaims } from "../src/delta/set.js";
import type { Claims, Delta, Pointer, Primitive } from "../src/delta/types.js";
import { anchorAnalysis, hviewAnchors } from "../src/resolve/anchored.js";
import { evalTerm, resultCanonicalHex } from "../src/resolve/eval.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import type { Bindings } from "../src/syntax/pred.js";
import { parseTerm } from "../src/syntax/term-json.js";
import { termHash } from "../src/syntax/term-io.js";
import {
  PUSHDOWN_FIELDS,
  passesSelection,
  scopeOver,
  type VectorArrival,
  type VectorDelta,
  type VectorPushdown,
} from "../src/storage/store-vector-format.js";
import type { Pushdown, VerifiedDelta } from "../src/storage/store.js";

export const STORE_ROUNDS_FORMAT = "rhizomatic-store-rounds/1";

export type RoundsAdmission = {
  readonly expectedHead: string | null;
  readonly nextHead: string;
  readonly added: readonly { readonly delta: string; readonly arrival: VectorArrival }[];
};
export type RoundsAnswer = {
  readonly canonicalHex: string;
  readonly scope: readonly string[];
  readonly members: readonly string[];
  /** The greatest validFrom or validUntil at or before `now` among the members, or null (§4.6). */
  readonly since: number | null;
  /** The least validFrom or validUntil after `now` among the members, or null (§4.6). */
  readonly expiresAt: number | null;
  /** The raw scope of `scope`: S(scope) over everything held, with no selection. A capture's members. */
  readonly rawMembers: readonly string[];
  readonly rounds: readonly { readonly anchors: readonly string[] }[];
};
export type RoundsRead = {
  readonly term: unknown;
  readonly root: string;
  readonly now: number;
  readonly bindings?: Readonly<Record<string, Primitive>>;
  readonly selection: VectorPushdown;
};
export type RoundsCase = RoundsRead & {
  readonly name: string;
  readonly note: string;
  readonly expect: RoundsAnswer;
};
/** Exactly one of `append` and `purge`: what changes the peer between two rounds. */
export type RoundsInterleavedCase = RoundsRead & {
  readonly name: string;
  readonly note: string;
  readonly afterRound: number;
  readonly append?: RoundsAdmission;
  /** Corpus names, ascending by id. */
  readonly purge?: readonly string[];
  readonly expect: { readonly before: RoundsAnswer; readonly after: RoundsAnswer };
};
export type RoundsRefusal = {
  readonly name: string;
  readonly term: unknown;
  readonly root: string;
  readonly now: number;
  readonly expect: { readonly reason: string };
};
export type StoreRoundsDocument = {
  readonly format: typeof STORE_ROUNDS_FORMAT;
  readonly note: string;
  readonly deltas: readonly VectorDelta[];
  readonly schemas: readonly {
    readonly name: string;
    readonly alg: number;
    readonly body: unknown;
  }[];
  readonly load: {
    readonly peer: string;
    readonly erasure: "unproven";
    readonly admissions: readonly RoundsAdmission[];
  };
  readonly cases: readonly RoundsCase[];
  readonly interleaved: readonly RoundsInterleavedCase[];
  readonly refusals: readonly RoundsRefusal[];
};

const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";
const CAROL = "did:key:zCarol";
const PEER = `ed25519:${"5a".repeat(32)}`;
const NOW = 100;
/** A time between the fixture's validity boundaries. */
const EARLY = 55;

const at = (id: string, context: string, role = "subject"): Pointer => ({
  role,
  target: { kind: "entity", entity: { id, context } },
});
const value = (v: string | number): Pointer => ({
  role: "value",
  target: { kind: "primitive", value: v },
});
const fact = (author: string, t: number, pointers: Pointer[], until?: number): Claims => ({
  timestamp: t,
  validFrom: t,
  ...(until === undefined ? {} : { validUntil: until }),
  author,
  pointers,
});
const child = (parent: string, context: string, kid: string): Pointer[] => [
  at(parent, context),
  at(kid, "parent", "child"),
];
/** A negation that also points at an entity, so an anchor other than its target's fetches it. */
const strikeAt = (author: string, t: number, id: string, entity: string): Claims => {
  const claims = makeNegationClaims(author, t, id);
  return { ...claims, pointers: [...claims.pointers, at(entity, "log")] };
};

type Named = { readonly name: string; readonly delta: Delta };

function corpus(): Named[] {
  const named: Named[] = [];
  const add = (name: string, claims: Claims): Delta => {
    const delta = makeDelta(claims);
    named.push({ name, delta });
    return delta;
  };

  // The garden (round 1). It names two beds, and one plant directly.
  add("g-name", fact(ALICE, 10, [at("garden:1", "name"), value("Kitchen garden")]));
  add("g-has-b1", fact(ALICE, 11, child("garden:1", "beds", "bed:1")));
  add("g-has-b2", fact(ALICE, 12, child("garden:1", "beds", "bed:2")));
  // plant:s is a child of the garden and of both beds: one entity at two depths.
  add("g-has-ps", fact(ALICE, 13, child("garden:1", "specimens", "plant:s")));
  // One delta at the root and at a depth-three entity. Its role is not `child`.
  const featured = add(
    "g-features-c1",
    fact(ALICE, 14, [at("garden:1", "featured"), at("cutting:1", "featuredIn", "star")]),
  );
  const featuredStrike = add("g-features-c1-neg", makeNegationClaims(BOB, 15, featured.id));
  add("g-features-c1-neg-neg", makeNegationClaims(ALICE, 70, featuredStrike.id));

  // The beds (round 2).
  add("b1-name", fact(ALICE, 20, [at("bed:1", "name"), value("North bed")]));
  add("b1-has-p1", fact(ALICE, 21, child("bed:1", "plants", "plant:1")));
  add("b1-has-ps", fact(ALICE, 22, child("bed:1", "plants", "plant:s")));
  const lateNote = add("b1-late-note", fact(ALICE, 90, [at("bed:1", "note"), value("mulched")]));
  // A strike signed before its target, pointing two rounds deeper, and itself struck. Under
  // `timestampAtMost: 60` the target is gone and the strike is in scope only through cutting:2.
  const lateNoteStrike = add("b1-late-note-neg-at-c2", strikeAt(BOB, 57, lateNote.id, "cutting:2"));
  add("b1-late-note-neg-neg", makeNegationClaims(ALICE, 58, lateNoteStrike.id));
  add("b2-has-ps", fact(ALICE, 23, child("bed:2", "plants", "plant:s")));
  // Two pointers at one entity: indexed at bed:2 once.
  add(
    "b2-name-twice",
    fact(ALICE, 26, [at("bed:2", "name"), at("bed:2", "label"), value("South bed")]),
  );
  const b2p2 = add("b2-has-p2", fact(ALICE, 24, child("bed:2", "plants", "plant:2")));
  add("b2-has-p2-neg", makeNegationClaims(ALICE, 25, b2p2.id));

  // The plants (round 2 for plant:s, round 3 for the others).
  add("p1-height", fact(ALICE, 30, [at("plant:1", "height"), value(40)]));
  add("p1-has-c1", fact(ALICE, 31, child("plant:1", "cuttings", "cutting:1")));
  add("p1-has-c3", fact(ALICE, 80, child("plant:1", "cuttings", "cutting:3")));
  add("p2-name", fact(ALICE, 32, [at("plant:2", "name"), value("mint")]));
  add("ps-name", fact(ALICE, 33, [at("plant:s", "name"), value("sage")]));
  add("ps-note-expired", fact(ALICE, 34, [at("plant:s", "note"), value("repotted")], 60));
  add("ps-has-c1", fact(ALICE, 35, child("plant:s", "cuttings", "cutting:1")));
  add("ps-has-c2", fact(ALICE, 36, child("plant:s", "cuttings", "cutting:2")));

  // The cuttings. cutting:1 has two parents and a seed below it.
  const c1Height = add("c1-height", fact(ALICE, 40, [at("cutting:1", "height"), value(3)]));
  const c1HeightStrike = add("c1-height-neg", makeNegationClaims(BOB, 41, c1Height.id));
  add("c1-height-neg-neg", makeNegationClaims(ALICE, 42, c1HeightStrike.id));
  const c1Note = add("c1-note", fact(ALICE, 43, [at("cutting:1", "note"), value("rooted")]));
  add("c1-note-neg-by-carol", makeNegationClaims(CAROL, 44, c1Note.id));
  add("c1-has-seed", fact(ALICE, 45, child("cutting:1", "seeds", "seed:1")));
  add("seed1-name", fact(ALICE, 46, [at("seed:1", "name"), value("sage seed")]));
  // A chain of three negations at cutting:2.
  const c2Size = add("c2-size", fact(ALICE, 50, [at("cutting:2", "size"), value(7)]));
  const c2n1 = add("c2-size-n1", makeNegationClaims(BOB, 51, c2Size.id));
  const c2n2 = add("c2-size-n2", makeNegationClaims(ALICE, 52, c2n1.id));
  add("c2-size-n3", makeNegationClaims(BOB, 53, c2n2.id));
  // A pointer at a delta whose role is not `negates`: it is no negator of c2-size.
  add(
    "c2-size-remark",
    fact(ALICE, 59, [
      { role: "annotates", target: { kind: "delta", deltaRef: { delta: c2Size.id } } },
      at("cutting:2", "remark"),
      value("measured"),
    ]),
  );
  // A negation that points at bed:1, so round 2 fetches it two rounds before its target.
  const c2Tag = add("c2-tag", fact(ALICE, 54, [at("cutting:2", "tag"), value("gift")]));
  const c2TagStrike = add("c2-tag-neg-at-b1", strikeAt(BOB, 55, c2Tag.id, "bed:1"));
  add("c2-tag-neg-neg", makeNegationClaims(ALICE, 56, c2TagStrike.id));
  add("c3-height", fact(ALICE, 16, [at("cutting:3", "height"), value(1)]));

  // Who may strike, for the lawful mask: Bob may; Carol never could.
  add(
    "grant-bob",
    fact(ALICE, 5, [
      at("grants", "grant"),
      { role: "grantee", target: { kind: "primitive", value: BOB } },
    ]),
  );

  // Bystanders: no read below reaches them.
  const far = add("far-name", fact(ALICE, 17, [at("orchard:9", "name"), value("far away")]));
  add("far-name-neg", makeNegationClaims(BOB, 18, far.id));

  // Arrivals the interleaved cases append.
  add("late-g-note", fact(ALICE, 95, [at("garden:1", "note"), value("visitors welcome")]));
  add("late-seed1-note", fact(ALICE, 96, [at("seed:1", "note"), value("sown")]));
  add("late-c1-height-neg", makeNegationClaims(BOB, 97, c1Height.id));
  return named;
}

// Arrival order is not signed-time order: the two as-of selections must not agree.
const FIRST_ADMISSION = [
  "c1-height-neg-neg",
  "g-has-b2",
  "seed1-name",
  "g-name",
  "c2-size-n2",
  "b2-has-ps",
  "g-features-c1-neg-neg",
  "far-name",
  "p2-name",
  "c1-height",
  "g-has-b1",
  "b1-has-p1",
  "c2-size",
  "grant-bob",
  "g-features-c1",
  "ps-name",
  "c3-height",
  "c1-note",
  "b2-has-p2",
  "c2-tag-neg-at-b1",
];
const SECOND_ADMISSION = [
  "g-has-ps",
  "b1-name",
  "c1-height-neg",
  "b1-has-ps",
  "p1-height",
  "p1-has-c1",
  "ps-note-expired",
  "ps-has-c1",
  "ps-has-c2",
  "c1-note-neg-by-carol",
  "c1-has-seed",
  "c2-size-n1",
  "c2-size-n3",
  "c2-tag",
  "g-features-c1-neg",
  "far-name-neg",
  "b1-late-note-neg-at-c2",
  "b1-late-note-neg-neg",
  // Everything from here on arrives after sequence 38, the cut the arrival cases use.
  "b1-late-note",
  "p1-has-c3",
  "b2-has-p2-neg",
  "c2-tag-neg-neg",
  "b2-name-twice",
  "c2-size-remark",
];
const ARRIVAL_CUT = 38;
// The resolve cases cut exactly at a delta: Carol's strike of c1-note is signed at 44 and
// arrives at 30. A cut at its own value keeps it (`<=`), so c1-note stays struck.
const STRIKE_TIME = 44;
const STRIKE_ARRIVAL = 30;
const LATE_APPEND = ["late-g-note", "late-seed1-note", "late-c1-height-neg"];

const leaf = {
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
};
const lawfulLeaf = {
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: {
      op: "mask",
      policy: {
        trust: {
          or: [
            { match: { field: "author", cmp: "eq", const: ALICE } },
            {
              inView: {
                term: {
                  op: "select",
                  pred: { hasPointer: { targetEntity: "grants" } },
                  in: { op: "mask", policy: "drop", in: "input" },
                },
                field: "author",
                extract: { role: "grantee" },
              },
            },
          ],
        },
      },
      in: "input",
    },
  },
};
// Whose strikes bind is a hole: one schema, two answers at one root under two bindings.
const strikerLeaf = {
  op: "group",
  key: "byTargetContext",
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { var: "root" } } },
    in: {
      op: "mask",
      policy: { trust: { match: { field: "author", cmp: "eq", const: { hole: "striker" } } } },
      in: "input",
    },
  },
};
const pinnedByHole = {
  op: "group",
  key: { const: "all" },
  in: {
    op: "select",
    pred: { hasPointer: { targetEntity: { hole: "who" } } },
    in: { op: "mask", policy: "drop", in: "input" },
  },
};
// The leaf filed by role, not by context: at one root, its HView differs from Leaf's.
const roleLeaf = { ...leaf, key: "byRole" };
const expandInto = (schema: unknown, body: unknown) => ({
  op: "expand",
  role: { exact: "child" },
  schema,
  in: body,
});
const SCHEMAS = [
  { name: "Leaf", alg: 1, body: leaf },
  { name: "Tree1", alg: 1, body: expandInto("Leaf", leaf) },
  { name: "Tree2", alg: 1, body: expandInto("Tree1", leaf) },
  { name: "Tree3", alg: 1, body: expandInto("Tree2", leaf) },
  { name: "LawfulLeaf", alg: 1, body: lawfulLeaf },
  { name: "LawfulTree1", alg: 1, body: expandInto("LawfulLeaf", lawfulLeaf) },
  { name: "LawfulTree2", alg: 1, body: expandInto("LawfulTree1", lawfulLeaf) },
  { name: "LawfulTree3", alg: 1, body: expandInto("LawfulTree2", lawfulLeaf) },
  { name: "StrikerLeaf", alg: 1, body: strikerLeaf },
  { name: "StrikerTree1", alg: 1, body: expandInto("StrikerLeaf", strikerLeaf) },
  { name: "StrikerTree2", alg: 1, body: expandInto("StrikerTree1", strikerLeaf) },
  { name: "RoleLeaf", alg: 1, body: roleLeaf },
];
const garden = { op: "fix", schema: "Tree3", entity: "garden:1" };
// The fix reads the tree with Alice's strikes binding. The expand over it follows the garden's
// `star` link to cutting:1 under the request's bindings, with Bob's. The tree reaches cutting:1
// too, through plant:s, under the same schema: one root, one schema, two bindings, one round.
const twoBindings = {
  op: "expand",
  role: { exact: "star" },
  schema: "StrikerLeaf",
  in: { op: "fix", schema: "StrikerTree2", entity: "garden:1", bindings: { striker: ALICE } },
};
// Two expands of one `child` link, each under a schema pinned by hash: Leaf and RoleLeaf. Both
// reach cutting:1 and cutting:2 in round 2, and both children are final there.
const pin = (body: unknown) => ({ pinned: termHash(parseTerm(body)) });
const twoPins = expandInto(pin(roleLeaf), expandInto(pin(leaf), leaf));
const resolvedLeaf = {
  op: "resolve",
  schema: { default: { pick: { order: { byTimestamp: "desc" } } } },
  in: { op: "fix", schema: "Leaf", entity: "cutting:1" },
};

type Entry = VerifiedDelta & { readonly name: string };

/** The reads of the document, before their expectations are computed. */
function reads(): (RoundsRead & { name: string; note: string })[] {
  const read = (
    name: string,
    note: string,
    term: unknown,
    root: string,
    selection: VectorPushdown = {},
    bindings?: Record<string, Primitive>,
  ) => ({
    name,
    note,
    term,
    root,
    now: NOW,
    ...(bindings === undefined ? {} : { bindings }),
    selection,
  });
  return [
    read(
      "the-whole-garden",
      "Four rounds. plant:s is reached three ways and cutting:1 twice; seed:1 only through the garden's own link to plant:s. g-features-c1 is fetched in round 1 and files at cutting:1 in round 3. c2-tag-neg-at-b1 is fetched in round 2 and its target in round 3.",
      garden,
      "garden:1",
    ),
    read(
      "an-expand-at-the-root",
      "The same tree written as a bare expand: the root is the only first anchor.",
      SCHEMAS[3]!.body,
      "garden:1",
    ),
    read(
      "a-fixed-entity-read-at-another-root",
      "The first round asks for the fix entity and the request root together.",
      { op: "fix", schema: "Tree2", entity: "bed:1" },
      "garden:1",
    ),
    read(
      "a-subtree",
      "Three rounds from plant:s.",
      { op: "fix", schema: "Tree2", entity: "plant:s" },
      "plant:s",
    ),
    read("a-root-nothing-points-at", "One round and no member.", leaf, "nowhere"),
    read(
      "signed-time-cuts-a-link-and-a-strike",
      "b1-late-note (t=90), p1-has-c3 (t=80) and g-features-c1-neg-neg (t=70) fail timestampAtMost. cutting:3 is never an anchor, and the featured link is struck at the garden and at cutting:1. b1-late-note-neg-at-c2 (t=57) passes while its target does not: it is no member through bed:1, and a member, struck, through cutting:2.",
      garden,
      "garden:1",
      { timestampAtMost: 60 },
    ),
    read(
      "arrival-cuts-a-strike-so-a-child-appears",
      "b2-has-p2-neg arrives after the cut, so plant:2 is a child and an anchor. c2-tag-neg-neg arrives after the cut too, so c2-tag is struck.",
      garden,
      "garden:1",
      { arrivalAtMost: ARRIVAL_CUT },
    ),
    read(
      "an-excluded-id-ends-a-chain-at-its-start",
      "c2-size-n1 is excluded: c2-size stands, and n2 and n3 are not members.",
      garden,
      "garden:1",
      { excludeIds: ["c2-size-n1"] },
    ),
    read(
      "an-excluded-id-in-the-middle-of-a-chain",
      "c2-size-n2 is excluded: n1 stands and strikes c2-size, and n3 is not a member.",
      garden,
      "garden:1",
      { excludeIds: ["c2-size-n2"] },
    ),
    read(
      "an-excluded-link-leaves-the-other-paths",
      "g-has-ps and b1-has-ps are excluded. plant:s is still a child of bed:2, one level deeper, so seed:1 is out of reach.",
      garden,
      "garden:1",
      { excludeIds: ["g-has-ps", "b1-has-ps"] },
    ),
    read(
      "an-excluded-negation-held-before-its-target",
      "c2-tag-neg-at-b1 is excluded. Round 2 would fetch it at bed:1; c2-tag-neg-neg hangs from it and is not a member.",
      garden,
      "garden:1",
      { excludeIds: ["c2-tag-neg-at-b1"] },
    ),
    read("every-field", "All three fields select at once.", garden, "garden:1", {
      timestampAtMost: 60,
      arrivalAtMost: ARRIVAL_CUT,
      excludeIds: ["c1-height-neg-neg", "b1-has-p1"],
    }),
    read("the-selection-admits-nothing", "One round and no member.", garden, "garden:1", {
      timestampAtMost: 1,
    }),
    read(
      "lawful-strikers",
      "The mask reads the grants entity, a static anchor of round 1. Carol's strike of c1-note is inert; Bob's strikes bind.",
      { op: "fix", schema: "LawfulTree3", entity: "garden:1" },
      "garden:1",
    ),
    read(
      "lawful-strikers-as-of-the-first-admission",
      "Only the first admission is admitted. grant-bob (arrival 14) is in it. plant:2 is a child, because the strike of its link arrives later; so is the strike of c2-tag-neg-at-b1, which therefore shows at bed:1.",
      { op: "fix", schema: "LawfulTree3", entity: "garden:1" },
      "garden:1",
      { arrivalAtMost: 20 },
    ),
    read(
      "a-hole-bound-by-the-request",
      "The request binds the hole, so plant:s is a static anchor beside the root.",
      pinnedByHole,
      "garden:1",
      {},
      { who: "plant:s" },
    ),
    read(
      "one-child-under-two-bindings",
      "StrikerLeaf at cutting:1 is evaluated twice in round 2: under the fix's bindings (Alice's strikes bind, so c1-height stands) and under the request's (Bob's strikes bind, so c1-height is struck). A memo whose key leaves out the bindings serves one for the other.",
      twoBindings,
      "garden:1",
      {},
      { striker: BOB },
    ),
    read(
      "one-child-under-two-pinned-schemas",
      "Two expands follow plant:s's child links, one under Leaf and one under RoleLeaf, each pinned by hash. Both evaluate cutting:1 and cutting:2 in round 2, and both children are final there. The two HViews differ. A memo whose key does not tell two pinned references apart serves one for the other.",
      twoPins,
      "plant:s",
    ),
    read(
      "a-resolved-tree",
      "A resolve over the gather: the rounds run on the gather, and the result is a View.",
      resolvedLeaf,
      "cutting:1",
    ),
    read(
      "a-resolved-tree-cut-at-a-strike",
      "timestampAtMost equals the time of c1-note-neg-by-carol, which is kept, so c1-note stays struck. c1-has-seed (t=45) is cut, so the View has no seeds. The resolve runs over the members, not over all that the read holds.",
      resolvedLeaf,
      "cutting:1",
      { timestampAtMost: STRIKE_TIME },
    ),
    read(
      "a-resolved-tree-as-of-an-arrival",
      "arrivalAtMost equals the arrival of c1-note-neg-by-carol, which is kept. c1-has-seed (arrival 31) is cut.",
      resolvedLeaf,
      "cutting:1",
      { arrivalAtMost: STRIKE_ARRIVAL },
    ),
    read(
      "a-resolved-tree-without-a-link",
      "c1-has-seed is excluded, so the View has no seeds.",
      resolvedLeaf,
      "cutting:1",
      { excludeIds: ["c1-has-seed"] },
    ),
  ];
}

const REFUSALS: RoundsRefusal[] = [
  {
    name: "an-aliased-role",
    term: {
      op: "group",
      key: "byRole",
      in: {
        op: "select",
        pred: { hasPointer: { role: { aliased: { name: "height" } } } },
        in: "input",
      },
    },
    root: "garden:1",
    now: NOW,
    expect: { reason: "aliased" },
  },
  {
    name: "a-reflection-over-every-delta",
    term: {
      op: "group",
      key: "byRole",
      in: {
        op: "select",
        pred: {
          inView: {
            term: {
              op: "select",
              pred: { match: { field: "author", cmp: "eq", const: ALICE } },
              in: "input",
            },
            field: "author",
            extract: { field: "author" },
          },
        },
        in: "input",
      },
    },
    root: "garden:1",
    now: NOW,
    expect: { reason: "reflection" },
  },
  {
    name: "a-const-group-over-every-delta",
    term: { op: "group", key: { const: "all" }, in: "input" },
    root: "garden:1",
    now: NOW,
    expect: { reason: "const-group" },
  },
  {
    name: "a-delta-set-result",
    term: { op: "select", pred: { hasPointer: { targetEntity: { var: "root" } } }, in: "input" },
    root: "garden:1",
    now: NOW,
    expect: { reason: "result-sort" },
  },
  {
    name: "an-unknown-schema",
    term: { op: "fix", schema: "Missing", entity: "garden:1" },
    root: "garden:1",
    now: NOW,
    expect: { reason: "unknown-schema" },
  },
];

/** The shared round vectors. The committed `vectors/store/rounds.json` is exactly this. */
export function roundVectors(): StoreRoundsDocument {
  const named = corpus();
  const byName = new Map(named.map((n) => [n.name, n.delta]));
  const nameOf = new Map(named.map((n) => [n.delta.id, n.name]));
  const registry = SchemaRegistry.build(
    SCHEMAS.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
  );
  const idOf = (name: string): string => {
    const delta = byName.get(name);
    if (delta === undefined) throw new Error(`round vectors: no delta named ${name}`);
    return delta.id;
  };

  let sequence = 0;
  const admission = (
    expectedHead: string | null,
    nextHead: string,
    transfer: number,
    names: readonly string[],
  ): RoundsAdmission => ({
    expectedHead,
    nextHead,
    added: names.map((delta) => {
      idOf(delta);
      sequence += 1;
      return { delta, arrival: { at: 1000 + sequence, sequence, transfer, sender: "rounds" } };
    }),
  });
  const admissions = [
    admission(null, "rounds-head-1", 1, FIRST_ADMISSION),
    admission("rounds-head-1", "rounds-head-2", 2, SECOND_ADMISSION),
  ];
  const lateAppend = admission("rounds-head-2", "rounds-head-3", 3, LATE_APPEND);
  const loaded = new Set([...FIRST_ADMISSION, ...SECOND_ADMISSION, ...LATE_APPEND]);
  for (const { name } of named)
    if (!loaded.has(name)) throw new Error(`round vectors: ${name} is never admitted`);

  const holdings = (list: readonly RoundsAdmission[]): Entry[] =>
    list.flatMap((a) =>
      a.added.map(({ delta, arrival }) => ({
        name: delta,
        delta: byName.get(delta)!,
        arrival: { id: idOf(delta), ...arrival },
      })),
    );

  // One read over one holding list, by scanning. The rounds are SPEC-17 §6 discovery, each step
  // an evaluation over a scope found by scanning the admitted list.
  const answer = (held: readonly Entry[], read: RoundsRead): RoundsAnswer => {
    const term = parseTerm(read.term);
    const bindings =
      read.bindings === undefined ? undefined : new Map(Object.entries(read.bindings));
    const selection: Pushdown = {
      ...read.selection,
      ...(read.selection.excludeIds === undefined
        ? {}
        : { excludeIds: read.selection.excludeIds.map(idOf) }),
    };
    const admitted = held.filter((entry) => passesSelection(entry, selection, PUSHDOWN_FIELDS));
    const whole = evalTerm(
      term,
      DeltaSet.from(admitted.map((e) => e.delta)),
      read.now,
      read.root,
      registry,
      bindings,
    );
    const analysis = anchorAnalysis(term, registry, bindings);
    if (!analysis.anchored)
      throw new Error(`round vectors: an unanchored case (${analysis.reason})`);
    const gather = term.kind === "resolve" ? term.of : term;

    const scope = new Set<string>();
    const rounds: { anchors: string[] }[] = [];
    let next = [...new Set([read.root, ...analysis.anchors])].sort(compareUtf8);
    let members: string[] = [];
    while (next.length > 0) {
      rounds.push({ anchors: next });
      for (const entity of next) scope.add(entity);
      members = scopeOver(admitted, [...scope]);
      const inScope = new Set(members);
      const gathered = evalTerm(
        gather,
        DeltaSet.from(admitted.filter((e) => inScope.has(e.delta.id)).map((e) => e.delta)),
        read.now,
        read.root,
        registry,
        bindings,
      );
      if (gathered.sort !== "hview") throw new Error("round vectors: a gather is not an HView");
      next = hviewAnchors(gathered.hview).filter((entity) => !scope.has(entity));
    }
    // The whole-set answer shows exactly the scope the rounds found, or the fixture is wrong.
    const wholeGather =
      gather === term
        ? whole
        : evalTerm(
            gather,
            DeltaSet.from(admitted.map((e) => e.delta)),
            read.now,
            read.root,
            registry,
            bindings,
          );
    if (wholeGather.sort !== "hview") throw new Error("round vectors: a gather is not an HView");
    for (const entity of hviewAnchors(wholeGather.hview))
      if (!scope.has(entity)) throw new Error(`round vectors: the rounds missed ${entity}`);
    // The validity window of the operand, by scanning the members.
    const inScope = new Set(members);
    let since: number | null = null;
    let expiresAt: number | null = null;
    for (const { delta } of admitted)
      if (inScope.has(delta.id))
        for (const b of [delta.claims.validFrom, delta.claims.validUntil]) {
          if (b === undefined) continue;
          if (b > read.now && (expiresAt === null || b < expiresAt)) expiresAt = b;
          if (b <= read.now && (since === null || b > since)) since = b;
        }
    const sorted = [...scope].sort(compareUtf8);
    return {
      canonicalHex: resultCanonicalHex(whole),
      scope: sorted,
      members: members.map((id) => nameOf.get(id)!),
      since,
      expiresAt,
      rawMembers: scopeOver(held, sorted).map((id) => nameOf.get(id)!),
      rounds,
    };
  };

  const base = holdings(admissions);
  const after = holdings([...admissions, lateAppend]);
  const cases: RoundsCase[] = reads().map((read) => ({ ...read, expect: answer(base, read) }));
  // The same reads at a time inside the fixture's boundaries: the window is not open at either
  // end, and the scope differs from the one at 100 (some links are not valid yet).
  for (const name of [
    "the-whole-garden",
    "signed-time-cuts-a-link-and-a-strike",
    "arrival-cuts-a-strike-so-a-child-appears",
    "a-resolved-tree",
  ]) {
    const at = cases.find((c) => c.name === name)!;
    const early: RoundsRead = {
      term: at.term,
      root: at.root,
      now: EARLY,
      ...(at.bindings === undefined ? {} : { bindings: at.bindings }),
      selection: at.selection,
    };
    const expect = answer(base, early);
    if (expect.since === null || expect.expiresAt === null)
      throw new Error(`round vectors: ${name} at ${EARLY} has an open window`);
    cases.push({
      name: `${name}-at-${EARLY}`,
      note: `${at.note} Read at ${EARLY}, inside the fixture's validity boundaries.`,
      ...early,
      expect,
    });
  }

  const read: RoundsRead = { term: garden, root: "garden:1", now: NOW, selection: {} };
  const interleave = (name: string, note: string, afterRound: number): RoundsInterleavedCase => ({
    name,
    note,
    ...read,
    afterRound,
    append: lateAppend,
    expect: { before: answer(base, read), after: answer(after, read) },
  });
  const purgeAfter = (
    name: string,
    note: string,
    afterRound: number,
    names: readonly string[],
  ): RoundsInterleavedCase => {
    const gone = new Set(names);
    return {
      name,
      note,
      ...read,
      afterRound,
      purge: [...names].sort((a, b) => compareUtf8(idOf(a), idOf(b))),
      expect: {
        before: answer(base, read),
        after: answer(
          base.filter((entry) => !gone.has(entry.name)),
          read,
        ),
      },
    };
  };
  const interleaved = [
    interleave(
      "an-append-after-the-first-round",
      "late-g-note points at the root, already fetched; late-seed1-note and late-c1-height-neg point below it. A read that keeps going on the later state shows the two deep arrivals without the root one: neither answer.",
      1,
    ),
    interleave(
      "an-append-after-the-third-round",
      "Only seed:1 is still to fetch. A read that keeps going shows late-seed1-note alone.",
      3,
    ),
    interleave(
      "an-append-after-the-last-round",
      "The read has made its last store call. It answers `before`.",
      4,
    ),
    purgeAfter(
      "a-purge-after-the-first-round",
      "g-features-c1-neg-neg is fetched in round 1, then purged. Without it, Bob's strike of the featured link stands. A reader that starts again on a new snapshot but keeps its old cache still holds the purged delta: it answers `before` at the new revision, which is neither answer.",
      1,
      ["g-features-c1-neg-neg"],
    ),
  ];

  const document: StoreRoundsDocument = {
    format: STORE_ROUNDS_FORMAT,
    note: "SPEC-18 proposal §4.4: a read in rounds equals the same read over the whole surface. See vectors/store/README.md §5.",
    deltas: named.map(({ name, delta }) => ({
      name,
      id: delta.id,
      claims: claimsToJson(delta.claims),
    })),
    schemas: SCHEMAS,
    load: { peer: PEER, erasure: "unproven", admissions },
    cases,
    interleaved,
    refusals: REFUSALS,
  };
  checkFixture(document, registry);
  // The resolve cases: the selection changes the View (so the final evaluation must run over
  // the members, not over all the read holds), and a cut one step short changes it again (so
  // each bound keeps a delta at its own value).
  const need = (condition: boolean, what: string): void => {
    if (!condition) throw new Error(`round vectors: the fixture lost ${what}`);
  };
  for (const [name, short] of [
    ["a-resolved-tree-cut-at-a-strike", { timestampAtMost: STRIKE_TIME - 1 }],
    ["a-resolved-tree-as-of-an-arrival", { arrivalAtMost: STRIKE_ARRIVAL - 1 }],
    ["a-resolved-tree-without-a-link", undefined],
  ] as const) {
    const c = cases.find((x) => x.name === name)!;
    need(
      answer(base, { ...c, selection: {} }).canonicalHex !== c.expect.canonicalHex,
      `the effect of ${name}'s selection on the View`,
    );
    if (short !== undefined)
      need(
        answer(base, { ...c, selection: short }).canonicalHex !== c.expect.canonicalHex,
        `the boundary of ${name}`,
      );
  }
  // A member sits exactly on each bound.
  const onBound = (name: string, at: (entry: Entry) => number, bound: number): void => {
    const members = new Set(cases.find((x) => x.name === name)!.expect.members);
    need(
      base.some((entry) => members.has(entry.name) && at(entry) === bound),
      `a member on the bound of ${name}`,
    );
  };
  onBound("a-resolved-tree-cut-at-a-strike", (e) => e.delta.claims.timestamp, STRIKE_TIME);
  onBound("a-resolved-tree-as-of-an-arrival", (e) => e.arrival.sequence, STRIKE_ARRIVAL);
  const [, , , purged] = interleaved;
  need(
    purged!.purge!.every((name) => scopeOver(base, ["garden:1"]).includes(idOf(name))) &&
      purged!.expect.before.canonicalHex !== purged!.expect.after.canonicalHex,
    "the purge of a delta round 1 fetches",
  );
  // The memo cases. Each pins a fixture property that a wrong evaluation memo needs in order to
  // fail (SPEC-18 §4.12 readings 24 and 25).
  const evalAt = (held: readonly Entry[], schema: string, entity: string, b?: Bindings) =>
    resultCanonicalHex(
      evalTerm(
        { kind: "fix", schema: { kind: "name", name: schema }, entity, ...(b && { bindings: b }) },
        DeltaSet.from(held.map((e) => e.delta)),
        NOW,
        entity,
        registry,
      ),
    );
  const two = cases.find((x) => x.name === "one-child-under-two-bindings")!;
  const roundIn = (rounds: RoundsAnswer["rounds"], entity: string): number =>
    rounds.findIndex((r) => r.anchors.includes(entity)) + 1;
  need(
    evalAt(base, "StrikerLeaf", "cutting:1", new Map([["striker", ALICE]])) !==
      evalAt(base, "StrikerLeaf", "cutting:1", new Map([["striker", BOB]])),
    "one child that two bindings read differently",
  );
  need(
    roundIn(two.expect.rounds, "cutting:1") === 2 && roundIn(two.expect.rounds, "plant:s") === 2,
    "both evaluations of the child finished in one round",
  );
  need(
    answer(base, { ...two, bindings: { striker: ALICE } }).canonicalHex !== two.expect.canonicalHex,
    "the request's bindings in the answer",
  );
  // Two pinned references at one root, both final in one round, with two different HViews.
  const pins = cases.find((x) => x.name === "one-child-under-two-pinned-schemas")!;
  const pinnedAt = (body: unknown, entity: string) => {
    const got = evalTerm(
      { kind: "fix", schema: { kind: "pinned", hash: termHash(parseTerm(body)) }, entity },
      DeltaSet.from(base.map((e) => e.delta)),
      NOW,
      entity,
      registry,
    );
    if (got.sort !== "hview") throw new Error("round vectors: a pinned child is not an HView");
    return got;
  };
  for (const entity of ["cutting:1", "cutting:2"]) {
    const [byContext, byRole] = [pinnedAt(leaf, entity), pinnedAt(roleLeaf, entity)];
    need(
      resultCanonicalHex(byContext) !== resultCanonicalHex(byRole),
      `two pinned schemas that read ${entity} differently`,
    );
    need(
      roundIn(pins.expect.rounds, entity) === 2 &&
        [byContext, byRole].every((v) =>
          hviewAnchors(v.hview).every((a) => roundIn(pins.expect.rounds, a) === 2),
        ),
      `both pinned evaluations of ${entity} final in round 2`,
    );
  }
  // A change after round 3 under a child that round 3 finished: a memo kept across the retry
  // shows the old child. Round 3 fetches cutting:1, and the append changes Leaf there.
  const thirdAppend = interleaved[1]!;
  const appended = holdings([lateAppend]);
  need(
    thirdAppend.afterRound === 3 &&
      roundIn(thirdAppend.expect.before.rounds, "cutting:1") === 3 &&
      evalAt(base, "Leaf", "cutting:1") !== evalAt([...base, ...appended], "Leaf", "cutting:1"),
    "an append under a child that the round before it finished",
  );
  return document;
}

// The properties the fixture exists for. A change to the corpus that loses one fails here, at
// generation, and not as a vector that quietly pins less.
function checkFixture(document: StoreRoundsDocument, registry: SchemaRegistry): void {
  const need = (condition: boolean, what: string): void => {
    if (!condition) throw new Error(`round vectors: the fixture lost ${what}`);
  };
  const find = (name: string): RoundsCase => {
    const found = document.cases.find((c) => c.name === name);
    if (found === undefined) throw new Error(`round vectors: no case ${name}`);
    return found;
  };
  const roundOf = (c: RoundsCase, entity: string): number =>
    c.expect.rounds.findIndex((r) => r.anchors.includes(entity)) + 1;
  const whole = find("the-whole-garden");
  const differs = (name: string): RoundsCase => {
    const c = find(name);
    need(
      c.expect.canonicalHex !== whole.expect.canonicalHex,
      `the effect of ${name} on the answer`,
    );
    need(
      JSON.stringify(c.expect.members) !== JSON.stringify(whole.expect.members),
      `the effect of ${name} on the members`,
    );
    return c;
  };

  need(whole.expect.rounds.length === 4, "expansion of depth three");
  need(
    roundOf(whole, "garden:1") === 1 && roundOf(whole, "cutting:1") === 3,
    "the early and deep anchors",
  );
  need(
    roundOf(whole, "plant:s") === 2 && roundOf(whole, "seed:1") === 4,
    "the child at two depths",
  );
  need(whole.expect.members.includes("c2-size-n3"), "the chain of three negations");
  need(
    whole.expect.members.includes("b2-name-twice") &&
      whole.expect.members.includes("c2-size-remark"),
    "the two index shapes of the fetch cache",
  );
  need(roundOf(whole, "plant:2") === 0, "the struck child link");
  for (const refusal of document.refusals) {
    const analysis = anchorAnalysis(parseTerm(refusal.term), registry);
    need(
      !analysis.anchored && analysis.reason === refusal.expect.reason,
      `the refusal ${refusal.name}`,
    );
  }

  const time = differs("signed-time-cuts-a-link-and-a-strike");
  need(
    roundOf(time, "cutting:3") === 0 && roundOf(whole, "cutting:3") === 4,
    "the link signed time cuts",
  );
  need(
    time.expect.members.includes("b1-late-note-neg-neg") &&
      !time.expect.members.includes("b1-late-note"),
    "the strike that outlives its target",
  );
  const arrival = differs("arrival-cuts-a-strike-so-a-child-appears");
  need(roundOf(arrival, "plant:2") === 3, "the child an arrival cut reveals");
  const start = differs("an-excluded-id-ends-a-chain-at-its-start");
  need(!start.expect.members.includes("c2-size-n3"), "the chain cut at its start");
  const middle = find("an-excluded-id-in-the-middle-of-a-chain");
  need(
    middle.expect.members.includes("c2-size-n1") && !middle.expect.members.includes("c2-size-n3"),
    "the chain cut in its middle",
  );
  const link = differs("an-excluded-link-leaves-the-other-paths");
  need(
    roundOf(link, "plant:s") === 3 && roundOf(link, "seed:1") === 0,
    "the diamond with one leg cut",
  );
  // The answer is the same here: the excluded strike was itself struck. The members differ.
  const held = find("an-excluded-negation-held-before-its-target");
  need(
    whole.expect.members.includes("c2-tag-neg-neg") &&
      !held.expect.members.includes("c2-tag-neg-neg"),
    "the excluded negation fetched early",
  );
  differs("every-field");
  need(find("the-selection-admits-nothing").expect.members.length === 0, "the empty selection");
  const lawful = differs("lawful-strikers");
  need(lawful.expect.rounds[0]!.anchors.includes("grants"), "the static anchor");
  differs("lawful-strikers-as-of-the-first-admission");
  need(
    find("a-hole-bound-by-the-request").expect.rounds[0]!.anchors.length === 2,
    "the bound hole",
  );

  const [first, third, last] = document.interleaved;
  need(
    first!.expect.before.canonicalHex !== first!.expect.after.canonicalHex,
    "the append's effect",
  );
  need(first!.afterRound === 1 && third!.afterRound === 3, "the interleaved rounds");
  need(last!.afterRound === last!.expect.before.rounds.length, "the append after the last round");
}
