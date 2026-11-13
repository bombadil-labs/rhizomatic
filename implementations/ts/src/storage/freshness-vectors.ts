// The freshness vectors (SPEC-18 proposal §4.6, "Freshness check"), as data.
// `tools/gen-store-freshness-vectors.ts` writes this document to `vectors/store/freshness.json`;
// the format is specified in `vectors/store/README.md` §9.
//
// Expectations come from the list-scanning store model of `store-vectors.ts`, never from a
// store or from the freshness code. Each capture's members are S(anchors) over the model's
// holdings, its expiry the least boundary of the selected scope. Each check's touch comes from
// a plain scan of the model's records. Then the model proves the touch exact by brute force:
// with no selection, there is no touch exactly when S(anchors) over the holdings at the check
// equals the members, with the same arrival records, and no member left and came back. A case
// that breaks this fails generation.

import { compareUtf8 } from "../delta/cbor.js";
import { claimsToJson } from "../delta/json-profile.js";
import { makeDelta, makeNegationClaims } from "../delta/set.js";
import type { Claims, Delta, Pointer } from "../delta/types.js";
import type { TouchReason } from "./freshness.js";
import { MEMORY_STORE_FORMAT } from "./memory-store.js";
import {
  PUSHDOWN_FIELDS,
  STORE_FRESHNESS_FORMAT,
  passesSelection,
  scopeOver,
  type FreshnessStep,
  type StoreFreshnessCase,
  type StoreFreshnessDocument,
  type StoreTouchingCase,
  type VectorPushdown,
  type VectorTouch,
  type VectorVerdict,
} from "./store-vector-format.js";
import { Model, PEERS, type Entry, type ModelPeer, type Named } from "./store-vectors.js";
import type { ChangeRetention, Pushdown } from "./store.js";

const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";
const NOW = 100;

const at = (id: string, context: string, role = "subject"): Pointer => ({
  role,
  target: { kind: "entity", entity: { id, context } },
});
const value = (v: string | number): Pointer => ({
  role: "value",
  target: { kind: "primitive", value: v },
});
const fact = (
  timestamp: number,
  pointers: Pointer[],
  valid: { from?: number; until?: number } = {},
): Claims => ({
  timestamp,
  validFrom: valid.from ?? timestamp,
  ...(valid.until === undefined ? {} : { validUntil: valid.until }),
  author: ALICE,
  pointers,
});

function corpus(): Named[] {
  const named: Named[] = [];
  const add = (name: string, claims: Claims): Delta => {
    const delta = makeDelta(claims);
    named.push({ name, delta });
    return delta;
  };
  // The scope of plant:a at first: a fact, and a fact with a negation.
  const aName = add("a-name", fact(10, [at("plant:a", "name"), value("fern")]));
  const aHeight = add("a-height", fact(11, [at("plant:a", "height"), value(10)]));
  const aHeightNeg = add("a-height-neg", makeNegationClaims(BOB, 20, aHeight.id));
  const bName = add("b-name", fact(12, [at("plant:b", "name"), value("moss")]));

  // Later arrivals. Each touches plant:a's capture, or does not, in its own way.
  add("a-note-late", fact(60, [at("plant:a", "note"), value("late")]));
  add("a-name-neg", makeNegationClaims(BOB, 40, aName.id));
  add("a-height-neg-neg", makeNegationClaims(ALICE, 30, aHeightNeg.id));
  add("b-name-neg", makeNegationClaims(BOB, 41, bName.id));
  add("b-height", fact(13, [at("plant:b", "height"), value(3)]));
  add("d-name", fact(14, [at("plant:d", "name"), value("ivy")]));
  // A reference under another role is no negation: it does not enter the scope.
  add("a-height-remark", {
    ...fact(42, [at("elsewhere", "remark")]),
    pointers: [
      at("elsewhere", "remark"),
      { role: "annotates", target: { kind: "delta", deltaRef: { delta: aHeight.id } } },
    ],
  });
  // A strike of a-name that also points at plant:a: it both targets the anchor and negates a member.
  const strike = makeNegationClaims(BOB, 43, aName.id);
  add("a-name-strike-at-a", { ...strike, pointers: [...strike.pointers, at("plant:a", "log")] });

  // A child reached by expansion: bed:1 links plant:c.
  add("bed-has-c", fact(15, [at("bed:1", "plants"), at("plant:c", "parent", "child")]));
  add("c-name", fact(16, [at("plant:c", "name"), value("sage")]));
  add("c-note-late", fact(61, [at("plant:c", "note"), value("late")]));

  // Validity. At now = 100: a-expiring ends at 150, a-future starts at 120, a-from-now started
  // exactly at 100 (no boundary after now), b-expiring ends at 110 outside the scope.
  add("a-expiring", fact(17, [at("plant:a", "size"), value(4)], { until: 150 }));
  add("a-future", fact(18, [at("plant:a", "size"), value(5)], { from: 120 }));
  add("a-from-now", fact(19, [at("plant:a", "tag"), value("now")], { from: 100 }));
  add("b-expiring", fact(21, [at("plant:b", "size"), value(1)], { until: 110 }));

  // Signed late: a selection `timestampAtMost: 50` rejects it. Its boundary at 105 is in the raw
  // scope and not in the read's operand.
  const aLate = add("a-late", fact(70, [at("plant:a", "late"), value(1)], { until: 105 }));
  add("a-late-neg", makeNegationClaims(BOB, 45, aLate.id));
  return named;
}

// ---- the model ------------------------------------------------------------------------------

type Capture = {
  readonly peer: string;
  readonly revision: number;
  readonly entities: readonly string[];
  readonly selection: VectorPushdown | undefined;
  readonly held: readonly Entry[];
  readonly members: readonly string[];
  readonly expiresAt: number | null;
};

class Case {
  readonly steps: FreshnessStep[] = [];
  readonly model: Model;
  private readonly captures = new Map<string, Capture>();
  private readonly idOf: Map<string, string>;
  private readonly byId: Map<string, Named>;

  constructor(
    private readonly named: readonly Named[],
    private readonly retention: Exclude<ChangeRetention, "none"> = "unbounded",
  ) {
    this.model = new Model(named, true);
    this.idOf = new Map(named.map((n) => [n.name, n.delta.id]));
    this.byId = new Map(named.map((n) => [n.delta.id, n]));
  }

  private flush(): void {
    this.steps.push(...this.model.steps.splice(0));
  }
  private state(peer: string): Readonly<ModelPeer> {
    return this.model.peerState(peer);
  }
  private selected(held: readonly Entry[], selection: VectorPushdown | undefined): Entry[] {
    if (selection === undefined) return [...held];
    const pushdown: Pushdown = {
      ...selection,
      ...(selection.excludeIds === undefined
        ? {}
        : { excludeIds: selection.excludeIds.map((n) => this.idOf.get(n)!) }),
    };
    return held.filter((e) => passesSelection(e, pushdown, PUSHDOWN_FIELDS));
  }
  private names(ids: readonly string[]): string[] {
    return [...ids].sort(compareUtf8).map((id) => this.byId.get(id)!.name);
  }

  create(peer: string): this {
    this.model.createPeer(peer, "unproven");
    this.flush();
    return this;
  }
  /** One committed append of these deltas, or a head-only commit when there are none. */
  append(peer: string, ...names: string[]): this {
    const state = this.state(peer);
    let sequence = state.lastSequence;
    this.model.append(
      peer,
      state.head,
      `${peer}-head-${state.revision + 1}`,
      names.map((delta) => ({ delta, sequence: ++sequence })),
    );
    this.flush();
    return this;
  }
  purge(peer: string, ...names: string[]): this {
    this.model.purge(peer, names);
    this.flush();
    return this;
  }

  capture(peer: string, as: string, entities: readonly string[], selection?: VectorPushdown): this {
    const state = this.state(peer);
    const sorted = [...new Set(entities)].sort(compareUtf8);
    const members = scopeOver(state.held, sorted);
    // The operand: the scope under the whole selection (SPEC-17 §4, the trim lemma).
    const operand = new Set(scopeOver(this.selected(state.held, selection), sorted));
    let expiresAt: number | null = null;
    for (const entry of state.held)
      if (operand.has(entry.delta.id))
        for (const b of [entry.delta.claims.validFrom, entry.delta.claims.validUntil])
          if (b !== undefined && b > NOW && (expiresAt === null || b < expiresAt)) expiresAt = b;
    const anchors = sorted.map((entity) => ({ kind: "entity" as const, entity }));
    this.captures.set(as, {
      peer,
      revision: state.revision,
      entities: sorted,
      selection,
      held: state.held,
      members,
      expiresAt,
    });
    this.steps.push({
      op: "capture",
      peer,
      as,
      // As a read names them: in any order, perhaps twice. The capture sorts them.
      anchors: entities.map((entity) => ({ kind: "entity" as const, entity })),
      ...(selection === undefined ? {} : { selection }),
      now: NOW,
      expect: {
        revision: `${peer}.${state.revision}`,
        anchors,
        members: this.names(members),
        expiresAt,
      },
    });
    return this;
  }

  /** The first touch, by a plain scan of the model's records since the capture. */
  private touchOf(capture: Capture, state: Readonly<ModelPeer>): VectorTouch | null {
    const members = new Set(capture.members);
    const anchors = new Set(capture.entities);
    const heldNow = new Map(state.held.map((e) => [e.delta.id, e.delta]));
    for (const { revision, record } of state.feed) {
      if (revision <= capture.revision) continue;
      const touch = (delta: string, reason: TouchReason): VectorTouch => ({
        revision: record.revision,
        delta,
        reason,
      });
      for (const name of record.removed)
        if (members.has(this.idOf.get(name)!)) return touch(name, "removed-member");
      for (const name of record.added) {
        const delta = heldNow.get(this.idOf.get(name)!);
        if (delta === undefined) continue;
        const pointers = delta.claims.pointers;
        if (pointers.some((p) => p.target.kind === "entity" && anchors.has(p.target.entity.id)))
          return touch(name, "targets-anchor");
        if (
          pointers.some(
            (p) =>
              p.role === "negates" &&
              p.target.kind === "delta" &&
              members.has(p.target.deltaRef.delta),
          )
        )
          return touch(name, "negates-member");
      }
    }
    return null;
  }

  check(peer: string, as: string, now?: number): this {
    const capture = this.captures.get(as)!;
    const state = this.state(peer);
    const touch = this.touchOf(capture, state);

    // Brute force: recompute the raw scope at this revision and compare.
    const now0 = new Map(capture.held.map((e) => [e.delta.id, e.arrival.sequence]));
    const later = new Map(state.held.map((e) => [e.delta.id, e.arrival.sequence]));
    const scope = scopeOver(state.held, capture.entities);
    const leftAndCameBack = state.feed.some(
      ({ revision, record }) =>
        revision > capture.revision &&
        record.removed.some((name) => capture.members.includes(this.idOf.get(name)!)),
    );
    const unchanged =
      scope.length === capture.members.length &&
      scope.every((id, i) => id === capture.members[i] && later.get(id) === now0.get(id)) &&
      !leftAndCameBack;
    if (unchanged !== (touch === null))
      throw new Error(
        `freshness vectors: the touch of ${as} is ${JSON.stringify(touch)}, and the scope ${unchanged ? "did not change" : "changed"}`,
      );
    // With a selection, the check is sound: a change to the operand is always a touch.
    let exact = true;
    if (capture.selection !== undefined) {
      exact = false;
      const before = scopeOver(this.selected(capture.held, capture.selection), capture.entities);
      const after = scopeOver(this.selected(state.held, capture.selection), capture.entities);
      if (touch === null && JSON.stringify(before) !== JSON.stringify(after))
        throw new Error(`freshness vectors: ${as} changed its operand with no touch`);
    }

    // A store that keeps n records answers resync-required for a capture below its floor.
    const kept =
      this.retention === "unbounded"
        ? Infinity
        : (this.retention as { revisions: number }).revisions;
    const records = state.feed.length;
    const floor = records > kept ? state.feed[records - kept - 1]!.revision : 0;
    let verdict: VectorVerdict;
    if (capture.revision < floor) verdict = { status: "resync-required" };
    else if (touch !== null) verdict = { status: "stale", touch };
    else if (now !== undefined && capture.expiresAt !== null && now >= capture.expiresAt)
      verdict = { status: "expired", expiresAt: capture.expiresAt };
    else verdict = { status: "current" };

    this.steps.push({
      op: "check",
      peer,
      capture: as,
      ...(now === undefined ? {} : { now }),
      exact,
      expect: { revision: `${peer}.${state.revision}`, verdict, touching: touch },
    });
    return this;
  }
}

// ---- the cases ------------------------------------------------------------------------------

const SPEC = "SPEC-18 §4.6";

function cases(named: readonly Named[]): StoreFreshnessCase[] {
  const out: StoreFreshnessCase[] = [];
  const add = (
    name: string,
    note: string,
    body: (c: Case) => void,
    retention?: Exclude<ChangeRetention, "none">,
  ): void => {
    const c = new Case(named, retention);
    body(c);
    out.push({
      name,
      note,
      spec: SPEC,
      requires: ["changes"],
      ...(retention === undefined ? {} : { store: { changeRetention: retention } }),
      steps: c.steps,
    });
  };
  // Every case starts here: plant:a holds a fact and a struck fact; plant:b holds one fact.
  const base = (c: Case): Case =>
    c.create("A").append("A", "a-name", "a-height", "a-height-neg", "b-name");
  const A = ["plant:a"];

  add("no-change", "The check runs at the capture's own revision. It reads no feed.", (c) =>
    base(c).capture("A", "c", A).check("A", "c"),
  );
  add(
    "a-head-only-commit",
    "A commit that moves only the head writes a record with no ids. Nothing touches.",
    (c) => base(c).capture("A", "c", A).append("A").check("A", "c"),
  );
  add(
    "unrelated-appends",
    "Appends at other entities. The check reads them and finds no touch.",
    (c) =>
      base(c).capture("A", "c", A).append("A", "b-height").append("A", "d-name").check("A", "c"),
  );
  add("an-added-delta-targets-an-anchor", "a-note-late points at plant:a.", (c) =>
    base(c).capture("A", "c", A).append("A", "a-note-late").check("A", "c"),
  );
  add("an-added-negator-of-a-member", "a-name-neg negates a-name, a member.", (c) =>
    base(c).capture("A", "c", A).append("A", "a-name-neg").check("A", "c"),
  );
  add(
    "an-added-negator-of-a-negator",
    "a-height-neg-neg negates a-height-neg, a member only through the negation chain.",
    (c) => base(c).capture("A", "c", A).append("A", "a-height-neg-neg").check("A", "c"),
  );
  add(
    "an-added-negator-of-a-non-member",
    "b-name-neg negates b-name, which plant:a's scope does not hold. It cannot enter the scope.",
    (c) => base(c).capture("A", "c", A).append("A", "b-name-neg").check("A", "c"),
  );
  add(
    "an-annotation-of-a-member",
    "a-height-remark points at a-height under the role annotates. Only negates closes the scope.",
    (c) => base(c).capture("A", "c", A).append("A", "a-height-remark").check("A", "c"),
  );
  add("a-purge-of-a-member", "a-height-neg leaves the holdings.", (c) =>
    base(c).capture("A", "c", A).purge("A", "a-height-neg").check("A", "c"),
  );
  add(
    "a-purge-of-a-non-member",
    "b-name leaves the holdings. It was never in plant:a's scope.",
    (c) => base(c).capture("A", "c", A).purge("A", "b-name").check("A", "c"),
  );
  add(
    "a-member-purged-and-added-again",
    "a-name leaves and comes back under a new arrival record. The ids at the end equal the members; the arrival differs. The purge touches.",
    (c) => base(c).capture("A", "c", A).purge("A", "a-name").append("A", "a-name").check("A", "c"),
  );
  add(
    "a-toucher-added-and-purged",
    "a-note-late would touch, but the peer no longer holds it at the check. The check gets it and finds nothing.",
    (c) =>
      base(c)
        .capture("A", "c", A)
        .append("A", "a-note-late")
        .purge("A", "a-note-late")
        .check("A", "c"),
  );
  add(
    "another-peers-changes",
    "Peer B holds the same bytes and adds deltas at plant:a. B's feed is its own. A's capture stays current.",
    (c) =>
      base(c)
        .capture("A", "c", A)
        .create("B")
        .append("B", "a-name", "a-note-late")
        .append("B", "a-name-neg")
        .purge("B", "a-name")
        .check("A", "c"),
  );
  add(
    "the-first-of-several-touches",
    "An unrelated append, then a purge of a member, then two touchers in one append. The purge is first. A reader that examines every added id before any removed one reports the append.",
    (c) =>
      base(c)
        .capture("A", "c", A)
        .append("A", "d-name")
        .purge("A", "a-height")
        .append("A", "a-note-late", "a-name-neg")
        .check("A", "c"),
  );
  add(
    "two-touchers-in-one-record",
    "Two added ids touch in one record. The one with the lower id is reported.",
    (c) => base(c).capture("A", "c", A).append("A", "a-note-late", "a-name-neg").check("A", "c"),
  );
  add(
    "two-anchors",
    "The capture has plant:a and plant:b, named out of order and twice. b-name-neg now negates a member.",
    (c) =>
      base(c)
        .capture("A", "c", ["plant:b", "plant:a", "plant:b"])
        .append("A", "b-name-neg")
        .check("A", "c"),
  );
  add(
    "a-touch-through-a-dynamic-anchor",
    "A read of bed:1 expands its child plant:c, so its scope E* has both. c-note-late touches through plant:c only. A capture of bed:1 alone stays current.",
    (c) =>
      c
        .create("A")
        .append("A", "bed-has-c", "c-name", "a-name")
        .capture("A", "read", ["bed:1", "plant:c"])
        .capture("A", "root-only", ["bed:1"])
        .append("A", "c-note-late")
        .check("A", "read")
        .check("A", "root-only"),
  );
  add(
    "retention-too-short",
    "The store keeps one record. Two commits after the capture drop the record the check needs.",
    (c) =>
      base(c).capture("A", "c", A).append("A", "b-height").append("A", "d-name").check("A", "c"),
    { revisions: 1 },
  );
  add(
    "expiry",
    "At now 100 the operand's next boundary is a-future's validFrom 120. a-from-now starts at 100, which is not after now. b-expiring ends at 110 outside the scope. Stale wins over expired.",
    (c) =>
      c
        .create("A")
        .append("A", "a-name", "a-expiring", "a-future", "a-from-now", "b-expiring")
        .capture("A", "c", A)
        .check("A", "c", 119)
        .check("A", "c", 120)
        .append("A", "d-name")
        .check("A", "c")
        .check("A", "c", 200)
        .append("A", "a-note-late")
        .check("A", "c", 200),
  );
  const cut = { timestampAtMost: 50 };
  add(
    "a-selection-rejects-the-toucher",
    "The read selects timestampAtMost 50. Its members are the raw scope, a-late included; its expiry ignores a-late's boundary at 105. a-note-late (signed at 60) touches the raw scope and the selection rejects it: stale, and the operand did not change. Sound, not exact.",
    (c) =>
      base(c)
        .append("A", "a-late", "a-future")
        .capture("A", "c", A, cut)
        .append("A", "a-note-late")
        .check("A", "c"),
  );
  add(
    "a-selection-and-a-purged-raw-id",
    "a-late is a raw member the selection rejects. Its purge touches. Sound, not exact.",
    (c) =>
      base(c).append("A", "a-late").capture("A", "c", A, cut).purge("A", "a-late").check("A", "c"),
  );
  add(
    "a-selection-and-a-negator-of-a-raw-id",
    "a-late-neg negates a-late, a raw member the selection rejects. It touches. Sound, not exact.",
    (c) =>
      base(c)
        .append("A", "a-late")
        .capture("A", "c", A, cut)
        .append("A", "a-late-neg")
        .check("A", "c"),
  );
  add(
    "a-selection-admits-the-toucher",
    "a-name-neg is signed at 40 and passes the selection. The operand changes.",
    (c) =>
      base(c)
        .append("A", "a-late")
        .capture("A", "c", A, cut)
        .append("A", "a-name-neg")
        .check("A", "c"),
  );
  return out;
}

// ---- touching alone ---------------------------------------------------------------------------

function touchingCases(named: readonly Named[]): StoreTouchingCase[] {
  const id = (name: string): string => named.find((n) => n.name === name)!.delta.id;
  const anchors = [{ kind: "entity" as const, entity: "plant:a" }];
  const members = ["a-name", "a-height", "a-height-neg"].sort((x, y) => compareUtf8(id(x), id(y)));
  const capture = { revision: 4, anchors, members };
  const record = (revision: number, added: string[], removed: string[]) => ({
    revision,
    head: null,
    added: added.sort((x, y) => compareUtf8(id(x), id(y))),
    removed: removed.sort((x, y) => compareUtf8(id(x), id(y))),
  });
  // A member and a toucher whose id sorts before it: a scan that merges both lists by id
  // reports the added one.
  const touchers = ["a-note-late", "a-name-neg", "a-height-neg-neg", "a-name-strike-at-a"];
  const pair = members
    .flatMap((m) => touchers.map((t) => [t, m] as const))
    .find(([t, m]) => compareUtf8(id(t), id(m)) < 0);
  if (pair === undefined) throw new Error("freshness vectors: no toucher sorts before a member");
  const [early, member] = pair;
  return [
    {
      name: "removed-before-added-in-one-record",
      note: `One record adds ${early} and removes ${member}. ${early}'s id is lower, and removed is examined first.`,
      capture,
      records: [record(5, [early], [member])],
      held: [early],
      expect: { touch: { revision: 5, delta: member, reason: "removed-member" } },
    },
    {
      name: "an-anchor-before-a-negation",
      note: "a-name-strike-at-a negates a-name and points at plant:a. The anchor is the reason.",
      capture,
      records: [record(5, ["a-name-strike-at-a"], [])],
      held: ["a-name-strike-at-a"],
      expect: { touch: { revision: 5, delta: "a-name-strike-at-a", reason: "targets-anchor" } },
    },
    {
      name: "an-added-id-no-longer-held",
      note: "a-note-late is added and not held at the end. It is ignored.",
      capture,
      records: [record(5, ["a-note-late"], []), record(6, [], [])],
      held: [],
      expect: { touch: null },
    },
    {
      name: "an-earlier-record-first",
      note: "An added toucher at 5 comes before a removed member at 6.",
      capture,
      records: [record(5, ["a-note-late"], []), record(6, [], ["a-name"])],
      held: ["a-note-late"],
      expect: { touch: { revision: 5, delta: "a-note-late", reason: "targets-anchor" } },
    },
    {
      name: "a-member-removed-and-added-again",
      note: "a-name leaves at 5 and comes back at 6. The removal touches.",
      capture,
      records: [record(5, [], ["a-name"]), record(6, ["a-name"], [])],
      held: ["a-name"],
      expect: { touch: { revision: 5, delta: "a-name", reason: "removed-member" } },
    },
    {
      name: "a-chain-outside-the-scope",
      note: "b-name-neg negates b-name, a non-member. No closure over added negators is needed.",
      capture,
      records: [record(5, ["b-name-neg", "b-height"], ["b-name"])],
      held: ["b-name-neg", "b-height"],
      expect: { touch: null },
    },
  ];
}

/** The shared freshness vectors. The committed `vectors/store/freshness.json` is exactly this. */
export function freshnessVectors(): StoreFreshnessDocument {
  const named = corpus();
  return {
    format: STORE_FRESHNESS_FORMAT,
    note: "SPEC-18 proposal §4.6: captures, touching and checkFresh over the change feed. See vectors/store/README.md §9.",
    reference: { formatVersion: MEMORY_STORE_FORMAT },
    peers: { A: PEERS["A"]!, B: PEERS["B"]! },
    deltas: named.map(({ name, delta }) => ({
      name,
      id: delta.id,
      claims: claimsToJson(delta.claims),
    })),
    cases: cases(named),
    touching: touchingCases(named),
  };
}
