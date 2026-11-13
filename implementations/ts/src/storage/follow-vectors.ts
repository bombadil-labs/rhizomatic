// The follow vectors (SPEC-18 proposal §4.6, "Following the feed"), as data.
// `tools/gen-store-follow-vectors.ts` writes this document to `vectors/store/follow.json`; the
// format is specified in `vectors/store/README.md` §10.
//
// Expectations come from the list-scanning store model of `store-vectors.ts`, never from a store
// or from the cursor. Each pull's records are a scan of the model's feed, its deltas the added
// ids the model holds. Then the model proves the follower's guarantee by brute force: a mirror
// that starts from the holdings at the follow and applies every pull by the rule of §4.6 equals
// the holdings, with their arrival records, at the end of every pull step. It does so with pages
// of every size from one to three and with whole pages. A case that breaks this fails generation.

import { compareUtf8 } from "../delta/cbor.js";
import { claimsToJson } from "../delta/json-profile.js";
import { makeDelta, makeNegationClaims } from "../delta/set.js";
import type { Claims, Pointer } from "../delta/types.js";
import { MEMORY_STORE_FORMAT } from "./memory-store.js";
import {
  STORE_FOLLOW_FORMAT,
  type FollowCaseStep,
  type StoreFollowCase,
  type StoreFollowDocument,
} from "./store-vector-format.js";
import { Model, PEERS, type Entry, type ModelPeer, type Named } from "./store-vectors.js";

const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";

const at = (id: string, context: string): Pointer => ({
  role: "subject",
  target: { kind: "entity", entity: { id, context } },
});
const fact = (timestamp: number, entity: string, context: string, value: string): Claims => ({
  timestamp,
  validFrom: timestamp,
  author: ALICE,
  pointers: [at(entity, context), { role: "value", target: { kind: "primitive", value } }],
});

function corpus(): Named[] {
  const named: Named[] = [];
  const add = (name: string, claims: Claims) => {
    const delta = makeDelta(claims);
    named.push({ name, delta });
    return delta;
  };
  const aName = add("a-name", fact(10, "plant:a", "name", "fern"));
  add("a-height", fact(11, "plant:a", "height", "10"));
  add("b-name", fact(12, "plant:b", "name", "moss"));
  add("c-name", fact(13, "plant:c", "name", "sage"));
  add("d-name", fact(14, "plant:d", "name", "ivy"));
  add("e-name", fact(15, "plant:e", "name", "rue"));
  add("a-note", fact(16, "plant:a", "note", "late"));
  add("a-name-neg", makeNegationClaims(BOB, 20, aName.id));
  return named;
}

// ---- the model ------------------------------------------------------------------------------

type Mirror = Map<string, Entry>;
/** The page sizes the proof runs with. Infinity is a store with no page limit. */
const PROOF_PAGES = [Number.POSITIVE_INFINITY, 1, 2, 3];

type Follower = {
  readonly peer: string;
  /** The peer whose history the position carries. */
  readonly history: string;
  revision: number;
  /** The revision name of the first resync-required answer. */
  stopped?: string;
  /** One mirror per page size of the proof; none for a follower that must resync. */
  readonly mirrors: Map<number, Mirror> | undefined;
};

const arrivalText = (e: Entry): string => JSON.stringify(e.arrival);

class Case {
  readonly steps: FollowCaseStep[] = [];
  readonly model: Model;
  private readonly followers = new Map<string, Follower>();
  private readonly idOf: Map<string, string>;

  constructor(
    named: readonly Named[],
    private readonly store: StoreFollowCase["store"] = undefined,
  ) {
    this.model = new Model(named, true);
    this.idOf = new Map(named.map((n) => [n.name, n.delta.id]));
  }

  private flush(): void {
    this.steps.push(...this.model.steps.splice(0));
  }
  private state(peer: string): Readonly<ModelPeer> {
    return this.model.peerState(peer);
  }
  private byId(names: Iterable<string>): string[] {
    return [...new Set(names)].sort((x, y) => compareUtf8(this.idOf.get(x)!, this.idOf.get(y)!));
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

  follow(peer: string, as: string, how: { ahead?: number; historyOf?: string } = {}): this {
    const state = this.state(peer);
    const sound = how.ahead === undefined && how.historyOf === undefined;
    const start = (): Mirror => new Map(state.held.map((e) => [e.delta.id, e]));
    this.followers.set(as, {
      peer,
      history: how.historyOf ?? peer,
      revision: state.revision + (how.ahead ?? 0),
      // A case that pins its page size is read only in pages of that size.
      mirrors: sound
        ? new Map(
            (this.store?.changePageSize === undefined
              ? PROOF_PAGES
              : [this.store.changePageSize]
            ).map((k) => [k, start()]),
          )
        : undefined,
    });
    this.steps.push({
      op: "follow",
      peer,
      as,
      ...how,
      expect: { revision: `${peer}.${state.revision}` },
    });
    return this;
  }

  /** The retention floor of the case's store, by the model's revisions (README §3.9.2). */
  private floor(state: Readonly<ModelPeer>): number {
    const retention = this.store?.changeRetention;
    const kept =
      retention === undefined || retention === "unbounded" ? Infinity : retention.revisions;
    const n = state.feed.length;
    return n > kept ? state.feed[n - kept - 1]!.revision : 0;
  }

  /**
   * A pull step: pulls until the follower stands at the peer's revision; with `once`, exactly
   * one pull, in a case whose store pins its page size and retention.
   */
  pull(as: string, once = false): this {
    const f = this.followers.get(as)!;
    const state = this.state(f.peer);
    const current = `${f.peer}.${state.revision}`;
    const size = this.store?.changePageSize;
    if (once && (size === undefined || this.store?.changeRetention === undefined))
      throw new Error(
        "follow vectors: a single pull needs a case that pins its page and retention",
      );
    const step = once
      ? ({ op: "pull", follower: as, once: true } as const)
      : ({ op: "pull", follower: as } as const);
    if (f.stopped !== undefined) {
      this.steps.push({ ...step, expect: { status: "resync-required", current: f.stopped } });
      return this;
    }
    if (f.history !== f.peer || f.revision > state.revision || f.revision < this.floor(state)) {
      f.stopped = current;
      this.steps.push({ ...step, expect: { status: "resync-required", current } });
      return this;
    }
    const pending = state.feed.filter((r) => r.revision > f.revision);
    const records = once ? pending.slice(0, size) : pending;
    const through =
      records.length === pending.length ? state.revision : records[records.length - 1]!.revision;
    const held = new Map(state.held.map((e) => [e.delta.id, e]));
    const added = this.byId(records.flatMap((r) => r.record.added));
    this.prove(as, f, state, records, held, through);
    f.revision = through;
    this.steps.push({
      ...step,
      expect: {
        status: "ok",
        position: `${f.peer}.${through}`,
        records: records.map((r) => r.record.revision),
        delivered: added.filter((n) => held.has(this.idOf.get(n)!)),
        absent: added.filter((n) => !held.has(this.idOf.get(n)!)),
        ...(size === undefined || once
          ? {}
          : { pulls: Math.max(1, Math.ceil(records.length / size)) }),
      },
    });
    return this;
  }

  /**
   * The follower's guarantee, by brute force: for each page size, pull page by page, deliver the
   * added ids the model holds now, apply the rule of §4.6, and compare with the holdings: all of
   * them at the peer's revision, and, short of it, every id that no record after the pull names.
   */
  private prove(
    as: string,
    f: Follower,
    state: Readonly<ModelPeer>,
    records: ModelPeer["feed"],
    held: ReadonlyMap<string, Entry>,
    through: number,
  ): void {
    const later = new Set(
      state.feed
        .filter((r) => r.revision > through)
        .flatMap((r) => [...r.record.added, ...r.record.removed])
        .map((name) => this.idOf.get(name)!),
    );
    for (const [size, mirror] of f.mirrors ?? []) {
      const step = size === Infinity ? Math.max(1, records.length) : size;
      for (let i = 0; i < records.length; i += step)
        for (const { record } of records.slice(i, i + step)) {
          for (const name of record.removed) mirror.delete(this.idOf.get(name)!);
          for (const name of record.added) {
            const id = this.idOf.get(name)!;
            const entry = held.get(id);
            if (entry !== undefined) mirror.set(id, entry);
            else mirror.delete(id);
          }
        }
      const fail = (why: string): never => {
        throw new Error(`follow vectors: follower ${as} with pages of ${size}: ${why}`);
      };
      for (const id of new Set([...mirror.keys(), ...held.keys()])) {
        if (later.has(id)) continue;
        const mine = mirror.get(id);
        const theirs = held.get(id);
        if (mine === undefined && theirs !== undefined)
          fail(`the mirror lacks ${id} at ${through}`);
        if (mine !== undefined && theirs === undefined)
          fail(`the mirror holds ${id} at ${through}`);
        if (mine !== undefined && theirs !== undefined && arrivalText(mine) !== arrivalText(theirs))
          fail(`the mirror holds ${id} with another arrival at ${through}`);
      }
    }
  }
}

// ---- the cases ------------------------------------------------------------------------------

const SPEC = "SPEC-18 §4.6";

function cases(named: readonly Named[]): StoreFollowCase[] {
  const out: StoreFollowCase[] = [];
  const add = (
    name: string,
    note: string,
    body: (c: Case) => void,
    store?: StoreFollowCase["store"],
  ): void => {
    const c = new Case(named, store);
    body(c);
    out.push({
      name,
      note,
      spec: SPEC,
      requires: ["changes"],
      ...(store === undefined ? {} : { store }),
      steps: c.steps,
    });
  };
  const id = (name: string): string => named.find((n) => n.name === name)!.delta.id;
  // Three deltas in the reverse of id order: their arrival order is not their id order.
  const reversed = ["c-name", "d-name", "e-name"].sort((x, y) => compareUtf8(id(y), id(x)));
  const base = (c: Case): Case => c.create("A").append("A", "a-name", "a-height");

  add("nothing-new", "A pull at the peer's own revision reads no feed and returns nothing.", (c) =>
    base(c).follow("A", "f").pull("f").pull("f"),
  );
  add("one-append", "One append after the follow: one record and its one delta.", (c) =>
    base(c).follow("A", "f").append("A", "b-name").pull("f").pull("f"),
  );
  add(
    "several-records-in-one-page",
    "Three commits, one with three deltas that arrive in the reverse of id order. The deltas come ascending by id.",
    (c) =>
      base(c)
        .follow("A", "f")
        .append("A", "b-name")
        .append("A", ...reversed)
        .append("A")
        .pull("f"),
  );
  add(
    "pages-of-one",
    "The store's pages hold one record. A pull reads one page, so a step takes one pull per record. a-note is added, purged and added again across the pulls of one step.",
    (c) =>
      base(c)
        .follow("A", "f")
        .append("A", "b-name")
        .append("A")
        .append("A", "c-name", "d-name")
        .pull("f")
        .append("A", "a-note")
        .purge("A", "a-note")
        .append("A", "a-note")
        .pull("f")
        .pull("f"),
    { changePageSize: 1 },
  );
  add(
    "a-head-only-commit",
    "A commit that moves only the head: a record with no ids, and no get.",
    (c) => base(c).follow("A", "f").append("A").pull("f"),
  );
  add(
    "a-purge-of-a-held-id",
    "a-height leaves the holdings. The record removes it; nothing is delivered.",
    (c) => base(c).follow("A", "f").purge("A", "a-height").pull("f"),
  );
  add(
    "add-then-purge-in-one-page",
    "b-name is added and purged after the follow. The page names it twice, and no bytes come: the peer no longer holds it.",
    (c) => base(c).follow("A", "f").append("A", "b-name").purge("A", "b-name").pull("f"),
  );
  add(
    "add-purge-add-in-one-page",
    "b-name is added, purged and added again under a new arrival record. It comes once, with its current arrival record.",
    (c) =>
      base(c)
        .follow("A", "f")
        .append("A", "b-name")
        .purge("A", "b-name")
        .append("A", "b-name")
        .pull("f"),
  );
  add(
    "add-purge-add-across-pulls",
    "b-name is added and pulled, purged and pulled, added again and pulled. Then purged and added again between two pulls.",
    (c) =>
      base(c)
        .follow("A", "f")
        .append("A", "b-name")
        .pull("f")
        .purge("A", "b-name")
        .pull("f")
        .append("A", "b-name")
        .pull("f")
        .purge("A", "b-name")
        .append("A", "b-name")
        .pull("f"),
  );
  add(
    "a-purge-held-by-another-peer-and-a-settled-debt",
    "A and B hold b-name. A's purge leaves the bytes with B; B's purge removes them; A's second purge settles a debt and writes no record. Neither follower gets bytes.",
    (c) =>
      base(c)
        .create("B")
        .append("B", "b-name")
        .append("A", "b-name")
        .follow("A", "fa")
        .follow("B", "fb")
        .purge("A", "b-name")
        .pull("fa")
        .purge("B", "b-name")
        .purge("A", "b-name")
        .pull("fa")
        .pull("fb"),
  );
  add(
    "two-peers",
    "A and B commit in turn and share bytes. Each follower reads its own peer's records only.",
    (c) =>
      base(c)
        .create("B")
        .follow("A", "fa")
        .follow("B", "fb")
        .append("B", "b-name", "a-name")
        .append("A", "b-name")
        .append("B", "c-name")
        .purge("A", "a-name")
        .append("B")
        .pull("fa")
        .pull("fb"),
  );
  add(
    "retention-too-short",
    "The store keeps one record. Two commits after the follow drop the record the follower needs.",
    (c) => base(c).follow("A", "f").append("A", "b-name").append("A", "c-name").pull("f").pull("f"),
    { changeRetention: { revisions: 1 } },
  );
  add(
    "a-position-from-the-future",
    "The follower stands two revisions past the peer: resync-required, with no feed call.",
    (c) => base(c).follow("A", "f", { ahead: 2 }).pull("f"),
  );
  add(
    "another-peers-history",
    "The follower's position carries B's history. Its revision is one of A's, so a feed call could answer; resync-required comes first, with no feed call.",
    (c) => base(c).create("B").follow("A", "f", { historyOf: "B" }).append("A", "b-name").pull("f"),
  );
  add(
    "pull-after-resync",
    "A position one past the peer answers resync-required. Two commits then pass the position. The next pull answers resync-required again, with the first current: the cursor does not ask the store again.",
    (c) =>
      base(c)
        .follow("A", "f", { ahead: 1 })
        .pull("f")
        .append("A", "b-name")
        .append("A", "c-name")
        .pull("f"),
  );
  add(
    "a-follower-started-mid-history",
    "Four commits, then the follow. Later commits purge an id held before the follow and add it again, and add new ones.",
    (c) =>
      base(c)
        .append("A", "b-name")
        .append("A")
        .purge("A", "a-height")
        .follow("A", "f")
        .purge("A", "a-name")
        .append("A", "a-name-neg", "a-name")
        .append("A", "a-height")
        .pull("f"),
  );
  // Single pulls with commits between them. The page size and retention are pinned, so every
  // run reads the same pages; the bytes a pull delivers are those held at its own snapshot.
  const single = { changePageSize: 1, changeRetention: "unbounded" } as const;
  add(
    "a-purge-between-single-pulls",
    "b-name is added, purged and added again. The first pull reads the add and delivers b-name. Then b-name is purged again. The third pull reads the second add, and no bytes come: the peer does not hold b-name now. A follower that hands out bytes it delivered earlier in the catch-up fails here.",
    (c) =>
      c
        .create("A")
        .follow("A", "f")
        .append("A", "b-name")
        .purge("A", "b-name")
        .append("A", "b-name")
        .pull("f", true)
        .purge("A", "b-name")
        .pull("f", true)
        .pull("f", true)
        .pull("f"),
    single,
  );
  add(
    "an-append-between-single-pulls",
    "Two appends, one pull, a third append, one pull, then the rest.",
    (c) =>
      base(c)
        .follow("A", "f")
        .append("A", "b-name")
        .append("A", "c-name")
        .pull("f", true)
        .append("A", "d-name")
        .pull("f", true)
        .pull("f"),
    single,
  );
  add(
    "a-purge-of-a-mirrored-id-between-single-pulls",
    "The follower read a-name before it followed. After one pull, a-name is purged; the pulls that follow read the purge.",
    (c) =>
      base(c)
        .follow("A", "f")
        .append("A", "b-name")
        .append("A", "c-name")
        .pull("f", true)
        .purge("A", "a-name")
        .pull("f", true)
        .pull("f"),
    single,
  );
  add(
    "a-re-add-between-single-pulls",
    "The first pull delivers b-name. b-name is then purged and added again under a new arrival record. The mirror keeps the old record until a pull reads the re-add.",
    (c) =>
      base(c)
        .follow("A", "f")
        .append("A", "b-name")
        .append("A", "c-name")
        .pull("f", true)
        .purge("A", "b-name")
        .append("A", "b-name")
        .pull("f", true)
        .pull("f", true)
        .pull("f"),
    single,
  );
  return out;
}

/** The shared follow vectors. The committed `vectors/store/follow.json` is exactly this. */
export function followVectors(): StoreFollowDocument {
  const named = corpus();
  return {
    format: STORE_FOLLOW_FORMAT,
    note: "SPEC-18 proposal §4.6: following the change feed with a pull cursor. See vectors/store/README.md §10.",
    reference: { formatVersion: MEMORY_STORE_FORMAT },
    peers: { A: PEERS["A"]!, B: PEERS["B"]! },
    deltas: named.map(({ name, delta }) => ({
      name,
      id: delta.id,
      claims: claimsToJson(delta.claims),
    })),
    cases: cases(named),
  };
}
