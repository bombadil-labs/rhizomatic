// The model behind vectors/store/views.json (SPEC-18 proposal §4.6, "Held views"). Every
// expectation comes from plain lists: the holdings are the list-scanning store model of
// `store-vectors.ts`, a read is `evalTerm` over the holdings the selection admits, and a scope is
// found by scanning. Nothing here opens a store or runs `StoreViews`.
//
// The model holds views as the contract says a holder does, and it proves the contract by brute
// force at every step. Rule 1: every answer, and every held view after a refresh, equals a fresh
// read over the model's holdings at that time. Rule 4: a view is touched by the rule of
// `touching` exactly when its raw scope changed (ids, arrival records, or a member left and came
// back). A case that breaks either fails generation.

import { compareUtf8 } from "../src/delta/cbor.js";
import { claimsToJson, parseClaims } from "../src/delta/json-profile.js";
import { DeltaSet, makeDelta, makeNegationClaims } from "../src/delta/set.js";
import type { Claims, Pointer } from "../src/delta/types.js";
import { anchorAnalysis, hviewAnchors } from "../src/resolve/anchored.js";
import { evalTerm, resultCanonicalHex } from "../src/resolve/eval.js";
import { SchemaRegistry } from "../src/schema/schema.js";
import type { Term } from "../src/syntax/model.js";
import { parseTerm } from "../src/syntax/term-json.js";
import {
  STORE_VIEWS_FORMAT,
  type StoreViewsCase,
  type StoreViewsDocument,
  type ViewsCaseStep,
  type ViewsKey,
  type ViewsProgram,
} from "../src/reactor/views-conformance.js";
import { proveWindow } from "../src/storage/freshness-vectors.js";
import { MEMORY_STORE_FORMAT } from "../src/storage/memory-store.js";
import {
  PUSHDOWN_FIELDS,
  passesSelection,
  scopeOver,
  type StoreVectorStep,
} from "../src/storage/store-vector-format.js";
import {
  Model,
  PEERS,
  type Entry,
  type ModelPeer,
  type Named,
} from "../src/storage/store-vectors.js";
import type { Pushdown } from "../src/storage/store.js";
import { roundVectors } from "./store-round-vectors.js";

const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";
const CAROL = "did:key:zCarol";
const SPEC = "SPEC-18 §4.6";
const NOW = 100;

const at = (id: string, context: string, role = "subject"): Pointer => ({
  role,
  target: { kind: "entity", entity: { id, context } },
});
const value = (v: string | number): Pointer => ({
  role: "value",
  target: { kind: "primitive", value: v },
});
const fact = (author: string, t: number, pointers: Pointer[]): Claims => ({
  timestamp: t,
  validFrom: t,
  author,
  pointers,
});

/** The round corpus, and the deltas only these vectors append. */
function corpus(rounds: ReturnType<typeof roundVectors>): Named[] {
  const named: Named[] = rounds.deltas.map((d) => ({
    name: d.name,
    delta: { id: d.id, claims: parseClaims(d.claims) },
  }));
  const id = (name: string): string => named.find((n) => n.name === name)!.delta.id;
  const add = (name: string, claims: Claims): void => {
    named.push({ name, delta: makeDelta(claims) });
  };
  // Nothing any view reads.
  add("x-elsewhere", fact(ALICE, 81, [at("elsewhere:1", "name"), value("a far field")]));
  // A negator of a member, and a negator of a negator that is a member.
  add("x-p2-name-neg", makeNegationClaims(BOB, 82, id("p2-name")));
  add("x-c1-height-neg-neg-neg", makeNegationClaims(BOB, 83, id("c1-height-neg-neg")));
  // A new child of plant:2, then a fact at that child: a dynamic anchor gained by a re-read.
  add(
    "x-p2-has-c9",
    fact(ALICE, 84, [at("plant:2", "cuttings"), at("cutting:9", "parent", "child")]),
  );
  add("x-c9-height", fact(ALICE, 85, [at("cutting:9", "height"), value(5)]));
  // A fact at plant:s: an anchor that several views share.
  add("x-ps-height", fact(ALICE, 86, [at("plant:s", "height"), value(12)]));
  // Carol may strike now: a static anchor (`grants`) of the lawful program.
  add(
    "x-grant-carol",
    fact(ALICE, 87, [
      at("grants", "grant"),
      { role: "grantee", target: { kind: "primitive", value: CAROL } },
    ]),
  );
  return named;
}

type Program = {
  readonly doc: ViewsProgram;
  readonly term: Term;
  readonly selection: Pushdown | undefined;
};

/** What one read depends on, by scanning, and what it answers. */
type ModelRead = {
  readonly bytes: string;
  /** Every anchor of the read, ascending. */
  readonly scope: readonly string[];
  /** The raw scope: id → its arrival record, as text. */
  readonly raw: ReadonlyMap<string, string>;
  readonly since: number | null;
  readonly expiresAt: number | null;
};

type HeldModel = ModelRead & {
  readonly program: string;
  readonly root: string;
  /** The program's epoch when the view was read. */
  readonly epoch: string;
  /** The bytes at the previous refresh, or at the view's first read since. */
  base: string;
};

const keyOf = (program: string, root: string): string => JSON.stringify([program, root]);
const byKey = (a: ViewsKey, b: ViewsKey): number =>
  compareUtf8(a.program, b.program) || compareUtf8(a.root, b.root);
const arrivalText = (e: Entry): string => JSON.stringify(e.arrival);

class Case {
  readonly steps: ViewsCaseStep[] = [];
  readonly model: Model;
  private readonly idOf: Map<string, string>;
  private readonly views = new Map<string, HeldModel>();
  private readonly epochs = new Map<string, string>();
  /** Views read since the previous refresh. */
  private readonly dirty = new Set<string>();
  private processed: number | undefined;
  /** Facts the generator checked, so the document cannot drift from what the cases claim. */
  readonly seen = { touched: 0, untouched: 0, windows: 0, epochs: 0, resyncs: 0 };

  constructor(
    named: readonly Named[],
    setup: (c: Case) => void,
    private readonly world: World,
    private readonly store: StoreViewsCase["store"],
    private readonly maxViews: number | undefined,
    private readonly peer = "A",
  ) {
    this.model = new Model(named, true);
    this.idOf = new Map(named.map((n) => [n.name, n.delta.id]));
    setup(this);
    this.steps.length = 0;
  }

  private flush(): void {
    this.steps.push(...this.model.steps.splice(0));
  }
  private state(peer = this.peer): Readonly<ModelPeer> {
    return this.model.peerState(peer);
  }

  create(peer: string): this {
    this.model.createPeer(peer, "unproven");
    this.flush();
    return this;
  }
  /** One committed append of these deltas, in this arrival order, or a head-only commit. */
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

  register(program: string, epoch?: string): this {
    const p = this.world.program(program);
    const analysis = anchorAnalysis(p.term, this.world.registry);
    if (!analysis.anchored) {
      this.steps.push({ op: "register", program, expect: { reason: analysis.reason } });
      return this;
    }
    this.epochs.set(program, epoch ?? "");
    this.steps.push({ op: "register", program, ...(epoch === undefined ? {} : { epoch }) });
    return this;
  }

  setEpoch(program: string, epoch: string): this {
    this.epochs.set(program, epoch);
    this.steps.push({ op: "setEpoch", program, epoch });
    return this;
  }

  drop(program: string, root: string): this {
    const key = keyOf(program, root);
    this.views.delete(key);
    this.dirty.delete(key);
    this.steps.push({ op: "drop", program, root, expect: { nextBoundary: this.boundary() } });
    return this;
  }

  private boundary(): number | null {
    let least: number | null = null;
    for (const v of this.views.values())
      if (v.expiresAt !== null && (least === null || v.expiresAt < least)) least = v.expiresAt;
    return least;
  }

  private floor(state: Readonly<ModelPeer>): number {
    const retention = this.store?.changeRetention;
    const kept =
      retention === undefined || retention === "unbounded" ? Infinity : retention.revisions;
    const n = state.feed.length;
    return n > kept ? state.feed[n - kept - 1]!.revision : 0;
  }

  /** A fresh read over the model's holdings now, by scanning. */
  private read(program: string, root: string, now: number): ModelRead {
    return this.world.read(this.state().held, program, root, now);
  }

  /**
   * One pass at `now`, as the contract says a holder makes it: the records since the processed
   * position decide the touched views; then time; then epochs. Proves rules 1 and 4 as it goes.
   */
  private pass(now: number): { reads: Set<string>; resynced: boolean } {
    const state = this.state();
    const reads = new Set<string>();
    let resynced = false;
    const fail = (why: string): never => {
      throw new Error(`views vectors: ${why}`);
    };
    if (this.views.size > 0 && this.processed !== undefined) {
      if (this.processed < this.floor(state)) resynced = true;
      else if (state.revision > this.processed) {
        const records = state.feed.filter((r) => r.revision > this.processed!).map((r) => r.record);
        const held = new Map(state.held.map((e) => [e.delta.id, e]));
        const removed = new Set(records.flatMap((r) => r.removed).map((n) => this.idOf.get(n)!));
        const added = new Set(records.flatMap((r) => r.added).map((n) => this.idOf.get(n)!));
        for (const [key, view] of this.views) {
          // The rule of `touching`, by a plain scan of the records.
          const scope = new Set(view.scope);
          let touched = [...removed].some((id) => view.raw.has(id));
          for (const id of added) {
            const entry = held.get(id);
            if (entry === undefined || touched) continue;
            touched = entry.delta.claims.pointers.some(
              ({ role, target }) =>
                (target.kind === "entity" && scope.has(target.entity.id)) ||
                (role === "negates" &&
                  target.kind === "delta" &&
                  view.raw.has(target.deltaRef.delta)),
            );
          }
          // Rule 4, by brute force: touched exactly when the raw scope changed, an arrival record
          // changed, or a member left (and perhaps came back).
          const now = scopeOver(state.held, view.scope);
          const changed =
            now.length !== view.raw.size ||
            now.some((id) => view.raw.get(id) !== arrivalText(held.get(id)!)) ||
            [...removed].some((id) => view.raw.has(id));
          if (changed !== touched)
            fail(
              `${key} is ${touched ? "" : "not "}touched, and its raw scope ${changed ? "changed" : "did not change"}`,
            );
          if (touched) {
            reads.add(key);
            this.seen.touched += 1;
          } else this.seen.untouched += 1;
        }
      }
    }
    if (resynced) {
      this.seen.resyncs += 1;
      for (const key of this.views.keys()) reads.add(key);
    } else
      for (const [key, view] of this.views) {
        if (
          (view.since !== null && now < view.since) ||
          (view.expiresAt !== null && now >= view.expiresAt)
        ) {
          reads.add(key);
          this.seen.windows += 1;
        }
        if (view.epoch !== this.epochs.get(view.program)) {
          reads.add(key);
          this.seen.epochs += 1;
        }
      }
    // Rule 1, by brute force: a view the pass keeps answers what a fresh read answers now.
    for (const [key, view] of this.views) {
      const fresh = this.read(view.program, view.root, now);
      if (!reads.has(key) && fresh.bytes !== view.bytes)
        fail(`${key} is kept at ${state.revision}, now ${now}, and a fresh read differs`);
      if (reads.has(key)) {
        this.views.set(key, {
          ...fresh,
          program: view.program,
          root: view.root,
          epoch: this.epochs.get(view.program)!,
          base: view.base,
        });
        this.dirty.add(key);
      }
    }
    this.processed = state.revision;
    return { reads, resynced };
  }

  private plain(keys: Iterable<string>): ViewsKey[] {
    return [...keys]
      .map((key) => {
        const [program, root] = JSON.parse(key) as [string, string];
        return { program, root };
      })
      .filter((k) => this.world.program(k.program).selection === undefined)
      .sort(byKey);
  }

  hold(program: string, root: string, now = NOW): this {
    const key = keyOf(program, root);
    const was = this.views.has(key);
    const { reads } = this.pass(now);
    if (!was) {
      if (this.maxViews !== undefined && this.views.size >= this.maxViews) {
        const oldest = this.views.keys().next().value!;
        this.views.delete(oldest);
        this.dirty.delete(oldest);
      }
      const fresh = this.read(program, root, now);
      this.views.set(key, {
        ...fresh,
        program,
        root,
        epoch: this.epochs.get(program)!,
        base: fresh.bytes,
      });
      this.dirty.add(key);
    }
    const view = this.views.get(key)!;
    this.views.delete(key);
    this.views.set(key, view);
    const selected = this.world.program(program).selection !== undefined;
    this.steps.push({
      op: "hold",
      program,
      root,
      now,
      expect: {
        bytes: view.bytes,
        ...(selected
          ? {}
          : { from: was && !reads.has(key) ? ("held" as const) : ("read" as const) }),
        position: `${this.peer}.${this.state().revision}`,
        expiresAt: view.expiresAt,
        nextBoundary: this.boundary(),
        reread: this.plain(reads),
      },
    });
    return this;
  }

  refresh(now = NOW): this {
    const { reads, resynced } = this.pass(now);
    const changed: (ViewsKey & { before: string; after: string })[] = [];
    for (const key of this.dirty) {
      const view = this.views.get(key)!;
      if (view.bytes !== view.base)
        changed.push({
          program: view.program,
          root: view.root,
          before: view.base,
          after: view.bytes,
        });
      view.base = view.bytes;
    }
    this.dirty.clear();
    this.steps.push({
      op: "refresh",
      now,
      expect: {
        position: `${this.peer}.${this.state().revision}`,
        reread: this.plain(reads),
        changed: changed.sort(byKey),
        resynced,
        nextBoundary: this.boundary(),
      },
    });
    return this;
  }

  /** The bytes of every held view, by key: for the cases' own checks. */
  bytes(program: string, root: string): string {
    return this.views.get(keyOf(program, root))!.bytes;
  }
  idHex(name: string): string {
    return Buffer.from(this.idOf.get(name)!, "utf8").toString("hex");
  }
}

/** The corpus, the schemas and the programs: what every case shares. */
class World {
  readonly registry: SchemaRegistry;
  readonly programs = new Map<string, Program>();
  readonly named: Named[];
  readonly rounds = roundVectors();

  constructor() {
    this.named = corpus(this.rounds);
    this.registry = SchemaRegistry.build(
      this.rounds.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
    );
    const body = (name: string): unknown => this.rounds.schemas.find((s) => s.name === name)!.body;
    const idOf = (name: string): string => this.named.find((n) => n.name === name)!.delta.id;
    const add = (doc: ViewsProgram): void => {
      this.programs.set(doc.name, {
        doc,
        term: parseTerm(doc.term),
        selection:
          doc.selection === undefined
            ? undefined
            : {
                ...doc.selection,
                ...(doc.selection.excludeIds === undefined
                  ? {}
                  : { excludeIds: doc.selection.excludeIds.map(idOf) }),
              },
      });
    };
    add({ name: "leaf", term: body("Leaf") });
    add({ name: "tree1", term: body("Tree1") });
    add({ name: "tree", term: body("Tree2") });
    add({ name: "lawful", term: body("LawfulTree1") });
    add({
      name: "resolved",
      term: this.rounds.cases.find((c) => c.name === "a-resolved-tree")!.term,
    });
    add({ name: "before-60", term: body("Tree1"), selection: { timestampAtMost: 60 } });
    add({
      name: "aliased",
      term: this.rounds.refusals.find((r) => r.name === "an-aliased-role")!.term,
    });
  }

  program(name: string): Program {
    const program = this.programs.get(name);
    if (program === undefined) throw new Error(`views vectors: no program ${name}`);
    return program;
  }

  /** A read over these holdings, by scanning (rounds.json mode 1, with its scope). */
  read(held: readonly Entry[], name: string, root: string, now: number): ModelRead {
    const { term, selection } = this.program(name);
    const admitted =
      selection === undefined
        ? held
        : held.filter((e) => passesSelection(e, selection, PUSHDOWN_FIELDS));
    const result = evalTerm(
      term,
      DeltaSet.from(admitted.map((e) => e.delta)),
      now,
      root,
      this.registry,
    );
    const analysis = anchorAnalysis(term, this.registry);
    if (!analysis.anchored) throw new Error("views vectors: an unanchored program is read");
    const gather = term.kind === "resolve" ? term.of : term;
    const scope = new Set<string>();
    let next = [...new Set([root, ...analysis.anchors])].sort(compareUtf8);
    let members: string[] = [];
    while (next.length > 0) {
      for (const entity of next) scope.add(entity);
      members = scopeOver(admitted, [...scope]);
      const inScope = new Set(members);
      const gathered = evalTerm(
        gather,
        DeltaSet.from(admitted.filter((e) => inScope.has(e.delta.id)).map((e) => e.delta)),
        now,
        root,
        this.registry,
      );
      if (gathered.sort !== "hview") throw new Error("views vectors: a gather is not an HView");
      next = hviewAnchors(gathered.hview).filter((entity) => !scope.has(entity));
    }
    const inScope = new Set(members);
    const operand = admitted.filter((e) => inScope.has(e.delta.id)).map((e) => e.delta);
    let since: number | null = null;
    let expiresAt: number | null = null;
    for (const delta of operand)
      for (const b of [delta.claims.validFrom, delta.claims.validUntil]) {
        if (b === undefined) continue;
        if (b > now && (expiresAt === null || b < expiresAt)) expiresAt = b;
        if (b <= now && (since === null || b > since)) since = b;
      }
    proveWindow(operand, now, since, expiresAt, `a view of ${name} at ${root}, now ${now}`);
    const sorted = [...scope].sort(compareUtf8);
    const byId = new Map(held.map((e) => [e.delta.id, e]));
    return {
      bytes: resultCanonicalHex(result),
      scope: sorted,
      raw: new Map(scopeOver(held, sorted).map((id) => [id, arrivalText(byId.get(id)!)])),
      since,
      expiresAt,
    };
  }
}

/** The setup of every case: peer A, loaded with the two admissions of rounds.json. */
function load(world: World): (c: Case) => void {
  const admissions = world.rounds.load.admissions.slice(0, 2);
  return (c) => {
    c.create("A");
    for (const admission of admissions) c.append("A", ...admission.added.map((a) => a.delta));
  };
}

function cases(world: World): StoreViewsCase[] {
  const setup = load(world);
  const out: StoreViewsCase[] = [];
  const add = (
    name: string,
    note: string,
    body: (c: Case) => void,
    options: { store?: StoreViewsCase["store"]; maxViews?: number } = {},
  ): void => {
    const c = new Case(world.named, setup, world, options.store, options.maxViews);
    body(c);
    out.push({
      name,
      note,
      spec: SPEC,
      requires: ["changes"],
      ...(options.store === undefined ? {} : { store: options.store }),
      views: {
        peer: "A",
        ...(options.maxViews === undefined ? {} : { maxViews: options.maxViews }),
      },
      steps: c.steps,
    });
  };
  const leaves = (c: Case): Case => c.register("leaf").register("tree1").register("tree");

  add(
    "no-change",
    "Hold two views, then refresh with no commit: nothing is read again, nothing changes, and no feed call is made.",
    (c) =>
      leaves(c)
        .hold("leaf", "garden:1")
        .hold("tree", "garden:1")
        .hold("leaf", "garden:1")
        .refresh()
        .refresh(),
  );
  add(
    "an-unrelated-append",
    "An append that no view reads: one feed page and one get, and nothing is read again.",
    (c) =>
      leaves(c)
        .hold("leaf", "garden:1")
        .hold("tree", "garden:1")
        .append("A", "x-elsewhere")
        .refresh(),
  );
  add(
    "an-append-at-an-anchor-of-one-view",
    "late-g-note points at garden:1. The leaf at garden:1 is read again and changes; the leaf at bed:1 keeps its bytes.",
    (c) =>
      leaves(c).hold("leaf", "garden:1").hold("leaf", "bed:1").append("A", "late-g-note").refresh(),
  );
  add(
    "a-negator-of-a-member",
    "x-p2-name-neg negates p2-name, a member of the leaf at plant:2. It points at no anchor.",
    (c) =>
      leaves(c)
        .hold("leaf", "plant:2")
        .hold("leaf", "plant:1")
        .append("A", "x-p2-name-neg")
        .refresh(),
  );
  add(
    "a-negator-of-a-negator",
    "x-c1-height-neg-neg-neg negates c1-height-neg-neg, a member of the leaf at cutting:1 two negations deep.",
    (c) =>
      leaves(c)
        .hold("leaf", "cutting:1")
        .hold("leaf", "cutting:2")
        .append("A", "x-c1-height-neg-neg-neg")
        .refresh(),
  );
  add(
    "a-purge-of-a-member",
    "ps-name is purged. The leaf at plant:s is read again, and its bytes no longer hold ps-name. The leaf at plant:2 is a bystander: it is not read again, and its bytes stay.",
    (c) => {
      leaves(c).hold("leaf", "plant:s").hold("leaf", "plant:2");
      const target = c.idHex("ps-name");
      if (!c.bytes("leaf", "plant:s").includes(target))
        throw new Error("views vectors: the purge target is not in the view");
      const bystander = c.bytes("leaf", "plant:2");
      c.purge("A", "ps-name").refresh();
      if (c.bytes("leaf", "plant:s").includes(target))
        throw new Error("views vectors: a purged delta stays in a view");
      if (c.bytes("leaf", "plant:2") !== bystander)
        throw new Error("views vectors: the bystander changed");
    },
  );
  add(
    "a-purge-then-a-re-add",
    "ps-name is purged and a refresh reads the leaf again; ps-name is then added again under a new arrival record, and the next refresh reads it again.",
    (c) =>
      leaves(c)
        .hold("leaf", "plant:s")
        .purge("A", "ps-name")
        .refresh()
        .append("A", "ps-name")
        .refresh(),
  );
  add(
    "a-purge-and-a-re-add-between-refreshes",
    "ps-name is purged and added again between two refreshes. The bytes are the same, but the member left and came back: the view is read again, and nothing changes.",
    (c) => leaves(c).hold("leaf", "plant:s").purge("A", "ps-name").append("A", "ps-name").refresh(),
  );
  add(
    "a-touch-through-a-dynamic-anchor",
    "late-seed1-note points at seed:1, a grandchild the tree at plant:1 expands (plant:1, cutting:1, seed:1). The tree is read again; the leaf at plant:1 is not.",
    (c) =>
      leaves(c)
        .hold("tree", "plant:1")
        .hold("leaf", "plant:1")
        .append("A", "late-seed1-note")
        .refresh(),
  );
  add(
    "a-view-gains-a-dynamic-anchor",
    "x-p2-has-c9 makes cutting:9 a child of plant:2, so the read of tree1 at plant:2 gains the anchor cutting:9. Then x-c9-height points at cutting:9 alone: the view is touched through the anchor it gained.",
    (c) =>
      leaves(c)
        .hold("tree1", "plant:2")
        .hold("leaf", "plant:2")
        .append("A", "x-p2-has-c9")
        .refresh()
        .append("A", "x-c9-height")
        .refresh(),
  );
  add(
    "two-views-share-an-anchor",
    "x-ps-height points at plant:s, an anchor of the tree at bed:1 (a child) and of the leaf at plant:s (the root). Both are read again.",
    (c) =>
      leaves(c)
        .hold("tree", "bed:1")
        .hold("leaf", "plant:s")
        .hold("leaf", "plant:2")
        .append("A", "x-ps-height")
        .refresh(),
  );
  add(
    "a-touch-through-a-static-anchor",
    "x-grant-carol points at grants, a static anchor of the lawful program. Carol's strike of c1-note now binds in the lawful view at cutting:1; the leaf at cutting:1 is not read again.",
    (c) =>
      c
        .register("lawful")
        .register("leaf")
        .hold("lawful", "plant:1")
        .hold("leaf", "cutting:1")
        .append("A", "x-grant-carol")
        .refresh(),
  );
  add(
    "time-moves-past-the-window-and-back",
    "The leaf at plant:s read at 55 has the window [36, 60): ps-note-expired stops at 60. A refresh at 59 keeps it. A refresh at 60 reads it again (the note is gone) and the next boundary moves. A refresh at 30 is below the new window and reads it again.",
    (c) =>
      leaves(c)
        .hold("leaf", "plant:s", 55)
        .hold("leaf", "plant:2", 55)
        .refresh(59)
        .refresh(60)
        .refresh(30)
        .refresh(55),
  );
  add(
    "a-resolved-view",
    "The resolve program reads cutting:1 and answers a View. late-c1-height-neg strikes c1-height there.",
    (c) =>
      c
        .register("resolved")
        .register("leaf")
        .hold("resolved", "cutting:1")
        .hold("leaf", "plant:2")
        .append("A", "late-c1-height-neg")
        .refresh(),
  );
  add(
    "a-program-with-a-selection",
    "before-60 keeps deltas signed at 60 or before. x-ps-height (signed at 86) touches its view at plant:s: the selection rejects it, so the bytes stay. The vectors do not pin whether such a view is read again.",
    (c) =>
      c
        .register("before-60")
        .register("leaf")
        .hold("before-60", "plant:s")
        .hold("leaf", "plant:2")
        .append("A", "x-ps-height")
        .refresh()
        .hold("before-60", "plant:s"),
  );
  add(
    "set-epoch",
    "The host's state behind the leaf program changes. Every view of leaf is read again; the tree is not. A second refresh reads nothing. An epoch set to the value the views were read under reads nothing.",
    (c) =>
      leaves(c)
        .hold("leaf", "garden:1")
        .hold("leaf", "bed:1")
        .hold("tree1", "bed:1")
        .setEpoch("leaf", "e2")
        .refresh()
        .refresh()
        .setEpoch("leaf", "e3")
        .setEpoch("leaf", "e2")
        .refresh(),
  );
  add(
    "retention-too-short",
    "The store keeps one record. Two commits between refreshes drop a record the views need: the refresh resyncs and reads every held view again.",
    (c) =>
      leaves(c)
        .hold("leaf", "garden:1")
        .hold("leaf", "plant:2")
        .append("A", "x-elsewhere")
        .append("A", "late-g-note")
        .refresh()
        .append("A", "x-p2-name-neg")
        .refresh(),
    { store: { changeRetention: { revisions: 1 } } },
  );
  add(
    "another-peers-commits",
    "B commits deltas at garden:1. A's revision does not move: no feed call, nothing read again.",
    (c) =>
      leaves(c)
        .hold("leaf", "garden:1")
        .create("B")
        .append("B", "late-g-note", "x-ps-height")
        .refresh(),
  );
  add(
    "max-views-evicts-the-least-recently-held",
    "The holder keeps two views. Holding leaf at plant:2 asks for garden:1 again, so bed:1 is the least recent and goes. Holding bed:1 again reads it and evicts garden:1. An append at bed:1 then reads only bed:1.",
    (c) =>
      leaves(c)
        .hold("leaf", "garden:1")
        .hold("leaf", "bed:1")
        .hold("leaf", "garden:1")
        .hold("leaf", "plant:2")
        .hold("leaf", "bed:1")
        .hold("leaf", "plant:2")
        .append("A", "late-g-note")
        .refresh(),
    { maxViews: 2 },
  );
  add(
    "drop",
    "The leaf at garden:1 is dropped. An append at garden:1 then reads nothing; holding it again reads it.",
    (c) =>
      leaves(c)
        .hold("leaf", "garden:1")
        .hold("leaf", "bed:1")
        .drop("leaf", "garden:1")
        .append("A", "late-g-note")
        .refresh()
        .hold("leaf", "garden:1"),
  );
  add(
    "a-head-only-commit",
    "A commit that moves only the head: one record with no ids, no get, nothing read again.",
    (c) => leaves(c).hold("leaf", "garden:1").append("A").refresh(),
  );
  add(
    "several-commits-in-pages-of-one",
    "Pages hold one record. Four commits between refreshes, one touching: one get for each page that adds.",
    (c) =>
      leaves(c)
        .hold("leaf", "garden:1")
        .hold("leaf", "plant:2")
        .append("A", "x-elsewhere")
        .append("A")
        .append("A", "x-p2-name-neg")
        .purge("A", "x-elsewhere")
        .refresh(),
    { store: { changePageSize: 1 } },
  );
  add(
    "a-hold-passes-for-the-whole-set",
    "A hold of a held view passes the feed for every view. The tree at garden:1 changes during the hold of the leaf at plant:2, and the next refresh reports that change though it reads nothing again.",
    (c) =>
      leaves(c)
        .hold("tree1", "garden:1")
        .hold("leaf", "plant:2")
        .append("A", "late-g-note")
        .hold("leaf", "plant:2")
        .refresh(),
  );
  add(
    "an-unanchored-program-is-refused",
    "A program whose role is aliased cannot be held: registering it is refused with the reason a read gives.",
    (c) => c.register("aliased").register("leaf").hold("leaf", "garden:1"),
  );
  return out;
}

/** The shared views vectors. The committed `vectors/store/views.json` is exactly this. */
export function viewsVectors(): StoreViewsDocument {
  const world = new World();
  const setupCase = new Case(world.named, () => undefined, world, undefined, undefined);
  load(world)(setupCase);
  return {
    format: STORE_VIEWS_FORMAT,
    note: "SPEC-18 proposal §4.6: held views kept current through the change feed. See vectors/store/README.md §11.",
    reference: { formatVersion: MEMORY_STORE_FORMAT },
    peers: { A: PEERS["A"]!, B: PEERS["B"]! },
    deltas: world.named.map(({ name, delta }) => ({
      name,
      id: delta.id,
      claims: claimsToJson(delta.claims),
    })),
    schemas: world.rounds.schemas,
    programs: [...world.programs.values()].map((p) => p.doc),
    setup: setupCase.steps as StoreVectorStep[],
    cases: cases(world),
  };
}
