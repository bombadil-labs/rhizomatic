// The shared store vectors (SPEC-18 proposal §8), as data. `tools/gen-store-vectors.ts` writes
// these documents to `vectors/store/`; the format is specified in `vectors/store/README.md`.
//
// Expectations come from the model below, never from a store. The model keeps each peer's
// holdings in a plain list and answers every question by scanning it, so it is easy to check
// against the proposal by reading. It is the oracle: do not make it faster.

import { compareUtf8 } from "../delta/cbor.js";
import { claimsToJson } from "../delta/json-profile.js";
import { makeDelta, makeNegationClaims } from "../delta/set.js";
import { authorForSeed, signClaims } from "../delta/sign.js";
import type { Claims, Delta, Pointer } from "../delta/types.js";
import { MEMORY_STORE_FORMAT } from "./memory-store.js";
import {
  PUSHDOWN_FIELDS,
  STORE_SCOPE_FORMAT,
  STORE_SCRIPTS_FORMAT,
  passesSelection,
  scopeOver,
  type PushdownField,
  type RevisionRef,
  type StoreScopeCase,
  type StoreScript,
  type StoreVectorStep,
  type StoreVectors,
  type VectorArrival,
  type VectorDelta,
  type VectorPushdown,
  type VectorRecord,
  type VectorRequirement,
} from "./store-vector-format.js";
import type { ErasurePosture, PurgeOutcome, Pushdown, VerifiedDelta } from "./store.js";

// ---- corpus -------------------------------------------------------------------------------

const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";
const KEY_SEED = "01".repeat(32);

const at = (id: string, context: string, role = "subject"): Pointer => ({
  role,
  target: { kind: "entity", entity: { id, context } },
});
const value = (v: string | number): Pointer => ({
  role: "value",
  target: { kind: "primitive", value: v },
});
const fact = (author: string, timestamp: number, pointers: Pointer[]): Claims => ({
  timestamp,
  validFrom: timestamp,
  author,
  pointers,
});

type Named = { readonly name: string; readonly delta: Delta; readonly forged?: true };

function corpus(): Named[] {
  const named: Named[] = [];
  const add = (name: string, claims: Claims): Delta => {
    const delta = makeDelta(claims);
    named.push({ name, delta });
    return delta;
  };
  const aHeight = add("a-height", fact(ALICE, 10, [at("plant:a", "height"), value(10)]));
  const aName = add("a-name", fact(ALICE, 20, [at("plant:a", "name"), value("fern")]));
  const aHeightNeg = add("a-height-neg", makeNegationClaims(BOB, 30, aHeight.id));
  const aHeightNegNeg = add("a-height-neg-neg", makeNegationClaims(ALICE, 40, aHeightNeg.id));
  add("a-height-neg-neg-neg", makeNegationClaims(BOB, 60, aHeightNegNeg.id));
  const bName = add("b-name", fact(ALICE, 15, [at("plant:b", "name"), value("moss")]));
  add("b-name-neg", makeNegationClaims(BOB, 35, bName.id));
  // One delta that two anchors yield.
  add("bed-link", fact(ALICE, 25, [at("bed:1", "plants"), at("plant:a", "bed", "plant")]));
  // Two pointers at one entity: an index must file the delta once.
  add("a-twice", fact(ALICE, 26, [at("plant:a", "tag"), at("plant:a", "label", "also")]));
  const ghost = add("ghost", fact(ALICE, 5, [at("plant:a", "note"), value("early")]));
  add("ghost-neg", makeNegationClaims(BOB, 45, ghost.id));
  add("far", fact(ALICE, 50, [at("elsewhere", "name"), value("far")]));
  // A delta reference under another role is not a negation, and names no entity.
  add("cites-a-height", {
    ...fact(BOB, 55, [at("elsewhere", "source")]),
    pointers: [
      at("elsewhere", "source"),
      { role: "cites", target: { kind: "delta", deltaRef: { delta: aHeight.id } } },
    ],
  });
  // The role `negates` on an entity target is not a negation either.
  add("negates-entity", fact(BOB, 56, [at("plant:b", "x", "negates")]));

  // A negation signed before its target. A cut on signed time between the two keeps the
  // negation and drops the target, so the negation is in no scope.
  const cLate = add("c-late", fact(ALICE, 70, [at("plant:c", "name"), value("late")]));
  add("c-early-neg", makeNegationClaims(BOB, 65, cLate.id));

  // One id in two appearances: unsigned, and signed by its author.
  const keyClaims = fact(authorForSeed(KEY_SEED), 12, [at("plant:a", "note"), value("signed")]);
  named.push({ name: "k-note", delta: makeDelta(keyClaims) });
  named.push({ name: "k-note-signed", delta: signClaims(keyClaims, KEY_SEED) });

  // Signatures no store accepts: too short, and a real one in uppercase.
  const signed = named.find((n) => n.name === "k-note-signed")!.delta;
  named.push({ name: "k-note-upper", delta: { ...signed, sig: signed.sig!.toUpperCase() } });
  named.push({
    name: "short-sig",
    delta: { ...makeDelta(fact(ALICE, 13, [at("plant:a", "note"), value("x")])), sig: "abc" },
  });

  // Claims that do not hash to the id they carry: a-name's id over far's claims.
  named.push({
    name: "forged",
    delta: { id: aName.id, claims: named.find((n) => n.name === "far")!.delta.claims },
    forged: true,
  });
  return named;
}

const PEERS: Readonly<Record<string, string>> = {
  // A's id sorts after B's and C's, so a peer listing ordered by creation fails.
  A: `ed25519:${"c3".repeat(32)}`,
  B: `ed25519:${"a1".repeat(32)}`,
  C: `ed25519:${"b2".repeat(32)}`,
  P: `ed25519:${"d4".repeat(32)}`,
  // Not a peer id: a store refuses to create a peer under the empty name.
  EMPTY: "",
};

// ---- the model ----------------------------------------------------------------------------

type Entry = VerifiedDelta & { readonly name: string };
type ModelPeer = {
  readonly name: string;
  readonly posture: ErasurePosture;
  /** One record per revision advance: `revision` is the model's own integer. */
  readonly feed: { readonly revision: number; readonly record: VectorRecord }[];
  head: string | null;
  revision: number;
  lastSequence: number;
  held: Entry[];
  owed: Set<string>;
};
type ModelSnapshot = {
  readonly peer: ModelPeer;
  readonly revision: number;
  readonly head: string | null;
  readonly held: readonly Entry[];
  released: boolean;
};
type Added = {
  readonly delta: string;
  readonly sequence: number;
  readonly arrivalId?: string;
  readonly sender?: string;
  readonly transfer?: number;
  readonly at?: number;
};

const SIG = /^[0-9a-f]{128}$/;
const MAX_COUNT = 2 ** 53 - 1;
const isCount = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_COUNT;

class Model {
  readonly steps: StoreVectorStep[] = [];
  private readonly byName: Map<string, Named>;
  private readonly peers = new Map<string, ModelPeer>();
  /** Handle name to peer name. A peer's first handle carries the peer's own name. */
  private readonly handles = new Map<string, string>();
  private readonly snapshots = new Map<string, ModelSnapshot>();
  /** Revision names, each with its peer and the model's integer. */
  private readonly revisions = new Map<string, { peer: ModelPeer; revision: number }>();
  private transfer = 0;

  /**
   * With `feed`, the model names every revision: `<peer>.0` when the peer is created (a `mark`
   * step), and `<peer>.<n>` on each step that advances it (`revisionAs`).
   */
  constructor(
    named: readonly Named[],
    private readonly feed = false,
  ) {
    this.byName = new Map(named.map((n) => [n.name, n]));
  }

  private nameRevision(state: ModelPeer): string {
    const name = `${state.name}.${state.revision}`;
    this.revisions.set(name, { peer: state, revision: state.revision });
    return name;
  }

  /** Records the revision advance just made, and answers the name of its revision. */
  private advance(state: ModelPeer, added: readonly string[], removed: readonly string[]): string {
    state.revision++;
    const revision = this.nameRevision(state);
    state.feed.push({
      revision: state.revision,
      record: { revision, head: state.head, added: [...added], removed: [...removed] },
    });
    return revision;
  }

  /** Names the peer's current revision. */
  mark(peer: string, as: string): void {
    const state = this.handle(peer);
    if (this.revisions.has(as)) throw new Error(`vector: revision ${as} named twice`);
    this.revisions.set(as, { peer: state, revision: state.revision });
    this.steps.push({ op: "mark", peer, as });
  }

  /** `changes(from, to)` on an unbounded feed (README §3.9). */
  changes(peer: string, from: RevisionRef, to?: RevisionRef): void {
    const state = this.handle(peer);
    const value = (ref: RevisionRef): number => {
      const named = this.revisions.get(ref.revision);
      if (named === undefined || named.peer !== state)
        throw new Error(`vector: revision ${ref.revision} is not ${peer}'s`);
      return named.revision + (ref.ahead ?? 0);
    };
    const after = value(from);
    const upTo = to === undefined ? undefined : value(to);
    const step = { op: "changes", peer, from, ...(to === undefined ? {} : { to }) } as const;
    if (upTo !== undefined && upTo < after)
      this.steps.push({ ...step, expect: { error: "invalid-request" } });
    else if (after > state.revision)
      this.steps.push({ ...step, expect: { status: "resync-required" } });
    else {
      const end = Math.min(upTo ?? state.revision, state.revision);
      const records = state.feed
        .filter((r) => r.revision > after && r.revision <= end)
        .map((r) => r.record);
      this.steps.push({ ...step, expect: { status: "ok", records } });
    }
  }

  private delta(name: string): Delta {
    return this.byName.get(name)!.delta;
  }
  private id(name: string): string {
    return this.delta(name).id;
  }
  private names(entries: readonly Entry[]): string[] {
    return [...entries].sort((a, b) => compareUtf8(a.delta.id, b.delta.id)).map((e) => e.name);
  }
  private pick(held: readonly Entry[], ids: readonly string[]): string[] {
    return this.names(held.filter((e) => ids.includes(e.delta.id)));
  }
  private elsewhere(asking: ModelPeer, id: string): boolean {
    return [...this.peers.values()].some(
      (peer) => peer !== asking && peer.held.some((e) => e.delta.id === id),
    );
  }

  private handle(handle: string): ModelPeer {
    return this.peers.get(this.handles.get(handle) ?? handle)!;
  }

  createPeer(peer: string, erasure: ErasurePosture): void {
    const step = { op: "createPeer", peer, erasure } as const;
    const exists = this.peers.has(peer);
    if (PEERS[peer] === "") {
      this.steps.push({ ...step, expect: { error: "invalid-request" } });
    } else if (erasure === "proven") {
      // The model is a store of class `unprovable`. A `proven` store creates this peer, or
      // refuses it as existing; no later step uses it.
      this.steps.push({
        ...step,
        expect: exists
          ? { error: ["posture-refused", "peer-exists"] }
          : { error: "posture-refused", unlessStoreErasure: "proven" },
      });
    } else if (exists) {
      this.steps.push({ ...step, expect: { error: "peer-exists" } });
    } else {
      this.peers.set(peer, {
        name: peer,
        posture: erasure,
        feed: [],
        head: null,
        revision: 0,
        lastSequence: 0,
        held: [],
        owed: new Set(),
      });
      this.handles.set(peer, peer);
      this.steps.push({ ...step, expect: { status: "created" } });
      if (this.feed) this.mark(peer, `${peer}.0`);
    }
  }

  /** With `handle`, the new handle gets that name and the earlier one stays in use. */
  openPeer(peer: string, handle?: string): void {
    const state = this.peers.get(peer);
    if (state !== undefined && handle !== undefined) this.handles.set(handle, peer);
    this.steps.push({
      op: "openPeer",
      peer,
      ...(handle === undefined ? {} : { handle }),
      expect:
        state === undefined
          ? { error: "peer-absent" }
          : { status: "opened", posture: state.posture },
    });
  }

  append(
    peer: string,
    expectedHead: string | null,
    nextHead: string,
    added: readonly Added[],
    frame: string | null = null,
  ): void {
    const state = this.handle(peer);
    const transfer = ++this.transfer;
    const batch = added.map((a) => {
      const arrival: VectorArrival = {
        at: a.at ?? 1000 + a.sequence,
        sequence: a.sequence,
        transfer: a.transfer ?? transfer,
        sender: a.sender ?? "local",
        ...(a.arrivalId === undefined ? {} : { id: a.arrivalId }),
      };
      return { delta: a.delta, arrival };
    });
    const step = { op: "append", peer, expectedHead, nextHead, frame, added: batch } as const;
    const refuse = (code: "invalid-admission" | "capability-absent"): void => {
      // Against a stale expected head a store may answer `conflict` instead. That pair has no
      // fixed order, so no vector reaches it.
      if (state.head !== expectedHead) throw new Error("vector: two causes in one append");
      this.steps.push({ ...step, expect: { error: code } });
    };

    if (nextHead === "") return refuse("invalid-admission");
    if (frame !== null) return refuse("capability-absent");
    // A stale writer learns it is stale before the store looks at its batch.
    if (state.head !== expectedHead) {
      this.steps.push({ ...step, expect: { status: "conflict" } });
      return;
    }
    const fresh: Entry[] = [];
    const sequences = new Set<number>();
    for (const { delta: name, arrival } of batch) {
      const entry = this.byName.get(name)!;
      const invalid = (): void => {
        this.steps.push({ ...step, expect: { error: "invalid-admission" } });
      };
      // Every entry is checked, also one whose id the peer already holds.
      if (entry.forged === true) return invalid();
      if (entry.delta.sig !== undefined && !SIG.test(entry.delta.sig)) return invalid();
      if (arrival.id !== undefined && this.id(arrival.id) !== entry.delta.id) return invalid();
      if (!isCount(arrival.sequence) || !isCount(arrival.transfer) || arrival.sender === "")
        return invalid();
      const id = entry.delta.id;
      if (fresh.some((e) => e.delta.id === id) || state.held.some((e) => e.delta.id === id))
        continue;
      if (arrival.sequence <= state.lastSequence || sequences.has(arrival.sequence))
        return invalid();
      sequences.add(arrival.sequence);
      fresh.push({
        name,
        delta: entry.delta,
        arrival: {
          id,
          at: arrival.at,
          sequence: arrival.sequence,
          transfer: arrival.transfer,
          sender: arrival.sender,
        },
      });
    }
    const revisionAdvanced = fresh.length > 0 || state.head !== nextHead;
    state.held = [...state.held, ...fresh];
    for (const entry of fresh) {
      state.owed.delete(entry.delta.id);
      state.lastSequence = Math.max(state.lastSequence, entry.arrival.sequence);
    }
    state.head = nextHead;
    const newly = this.names(fresh);
    const revisionAs = revisionAdvanced ? this.advance(state, newly, []) : undefined;
    this.steps.push({
      ...step,
      ...(this.feed && revisionAs !== undefined ? { revisionAs } : {}),
      expect: { status: "committed", added: newly, revisionAdvanced },
    });
  }

  purge(peer: string, names: readonly string[]): void {
    const state = this.handle(peer);
    const distinct = new Map<string, string>();
    for (const name of names) if (!distinct.has(this.id(name))) distinct.set(this.id(name), name);
    const targets: { delta: string; outcome: PurgeOutcome }[] = [];
    // Only ids that leave this peer's holdings enter its record; a settled debt does not.
    const released: Entry[] = [];
    for (const id of [...distinct.keys()].sort(compareUtf8)) {
      let outcome: PurgeOutcome;
      const holding = state.held.find((e) => e.delta.id === id);
      if (holding !== undefined) {
        state.held = state.held.filter((e) => e.delta.id !== id);
        released.push(holding);
        outcome = this.elsewhere(state, id) ? "held-by-other-peer" : "removed";
        if (outcome === "held-by-other-peer") state.owed.add(id);
      } else if (state.owed.has(id)) {
        outcome = this.elsewhere(state, id) ? "held-by-other-peer" : "removed";
        if (outcome === "removed") state.owed.delete(id);
      } else outcome = "not-held";
      targets.push({ delta: distinct.get(id)!, outcome });
    }
    const changed = released.length > 0;
    const revisionAs = changed ? this.advance(state, [], this.names(released)) : undefined;
    // The claim speaks only for targets this report removed. With none, it asserts nothing.
    const removed = targets.some((t) => t.outcome === "removed");
    this.steps.push({
      op: "purge",
      peer,
      ...(this.feed && revisionAs !== undefined ? { revisionAs } : {}),
      ids: [...names],
      expect: {
        targets,
        revisionAdvanced: changed,
        claim: removed
          ? { unprovable: "unproven", proven: "proven" }
          : { unprovable: "nothing-removed", proven: "nothing-removed" },
        referenceSurfaces: [
          { surface: "rows", state: "absent" },
          { surface: "index-entries", state: "absent" },
          { surface: "process-memory", state: "unprovable" },
        ],
      },
    });
  }

  read(peer: string, snapshot: string): void {
    const state = this.handle(peer);
    this.snapshots.set(snapshot, {
      peer: state,
      revision: state.revision,
      head: state.head,
      held: state.held,
      released: false,
    });
    this.steps.push({ op: "read", peer, snapshot });
  }

  release(snapshot: string): void {
    this.snapshots.get(snapshot)!.released = true;
    this.steps.push({ op: "release", snapshot });
  }

  head(snapshot: string): void {
    this.steps.push({ op: "head", snapshot, expect: { head: this.snapshots.get(snapshot)!.head } });
  }

  // A released snapshot refuses. A snapshot the peer has moved past either refuses with
  // `snapshot-moved` or answers as it would have at its own revision. One that is both may
  // refuse with either code.
  private answer<T extends object>(
    snapshot: string,
    answer: (held: readonly Entry[]) => T,
  ):
    | (T & { orError?: "snapshot-moved" })
    | { error: "snapshot-released" | ["snapshot-released", "snapshot-moved"] } {
    const state = this.snapshots.get(snapshot)!;
    const moved = state.peer.revision !== state.revision;
    if (state.released)
      return { error: moved ? ["snapshot-released", "snapshot-moved"] : "snapshot-released" };
    return { ...answer(state.held), ...(moved ? { orError: "snapshot-moved" as const } : {}) };
  }

  get(snapshot: string, names: readonly string[]): void {
    const ids = names.map((n) => this.id(n));
    this.steps.push({
      op: "get",
      snapshot,
      ids: [...names],
      expect: this.answer(snapshot, (held) => ({ deltas: this.pick(held, ids) })),
    });
  }

  targets(snapshot: string, entities: readonly string[]): void {
    this.steps.push({
      op: "targets",
      snapshot,
      entities: [...entities],
      expect: this.answer(snapshot, (held) => ({
        ids: this.names(
          held.filter((e) =>
            e.delta.claims.pointers.some(
              (p) => p.target.kind === "entity" && entities.includes(p.target.entity.id),
            ),
          ),
        ),
      })),
    });
  }

  negators(snapshot: string, names: readonly string[]): void {
    const ids = names.map((n) => this.id(n));
    this.steps.push({
      op: "negators",
      snapshot,
      ids: [...names],
      expect: this.answer(snapshot, (held) => ({
        ids: this.names(
          held.filter((e) =>
            e.delta.claims.pointers.some(
              (p) =>
                p.role === "negates" &&
                p.target.kind === "delta" &&
                ids.includes(p.target.deltaRef.delta),
            ),
          ),
        ),
      })),
    });
  }

  private selection(vector: VectorPushdown): Pushdown {
    return {
      ...(vector.timestampAtMost === undefined ? {} : { timestampAtMost: vector.timestampAtMost }),
      ...(vector.arrivalAtMost === undefined ? {} : { arrivalAtMost: vector.arrivalAtMost }),
      ...(vector.excludeIds === undefined
        ? {}
        : { excludeIds: vector.excludeIds.map((n) => this.id(n)) }),
    };
  }

  /** S(A over the members of `held` that pass `fields` of the selection), as names. */
  private scopeNames(
    held: readonly Entry[],
    entities: readonly string[],
    vector: VectorPushdown,
    fields: readonly PushdownField[],
  ): string[] {
    const selection = this.selection(vector);
    const admitted = held.filter((e) => passesSelection(e, selection, fields));
    return this.pick(held, scopeOver(admitted, entities));
  }

  scope(
    snapshot: string,
    entities: readonly string[],
    pushdown?: VectorPushdown,
    exclude?: readonly string[],
  ): void {
    const omit = (exclude ?? []).map((n) => this.id(n));
    const bound = pushdown?.arrivalAtMost;
    const malformed =
      bound !== undefined && !(Number.isInteger(bound) && bound >= 0 && bound <= MAX_COUNT);
    this.steps.push({
      op: "scope",
      snapshot,
      anchors: entities.map((entity) => ({ kind: "entity", entity })),
      ...(pushdown === undefined ? {} : { pushdown }),
      ...(exclude === undefined ? {} : { exclude: [...exclude] }),
      expect: malformed
        ? { error: "invalid-request" }
        : this.answer(snapshot, (held) => ({
            lower: this.scopeNames(held, entities, pushdown ?? {}, PUSHDOWN_FIELDS).filter(
              (name) => !omit.includes(this.id(name)),
            ),
            upper: this.scopeNames(held, entities, {}, []),
          })),
    });
  }

  count(snapshot: string): void {
    const count = this.snapshots.get(snapshot)!.held.length;
    this.steps.push({ op: "count", snapshot, expect: { count } });
  }

  arrivals(snapshot: string, names: readonly string[]): void {
    const ids = names.map((n) => this.id(n));
    this.steps.push({
      op: "arrivals",
      snapshot,
      ids: [...names],
      expect: this.answer(snapshot, (held) => ({ ids: this.pick(held, ids) })),
    });
  }

  export(peer: string): void {
    const state = this.peers.get(peer);
    this.steps.push({
      op: "export",
      peer,
      expect: state === undefined ? { error: "peer-absent" } : { deltas: this.names(state.held) },
    });
  }

  /** The whole store keeps each id once. Name it by the first corpus entry with that id. */
  exportStored(): void {
    const held = new Set([...this.peers.values()].flatMap((p) => p.held.map((e) => e.delta.id)));
    const ids = [...held]
      .sort(compareUtf8)
      .map((id) => [...this.byName.values()].find((n) => n.delta.id === id && !n.forged)!.name);
    this.steps.push({ op: "exportStored", expect: { ids } });
  }

  exportPeers(): void {
    const peers = [...this.peers.keys()].sort((a, b) => compareUtf8(PEERS[a]!, PEERS[b]!));
    this.steps.push({ op: "exportPeers", expect: { peers } });
  }

  scopeCase(
    name: string,
    spec: string,
    peer: string,
    entities: readonly string[],
    selection: VectorPushdown,
    held: readonly string[] = [],
  ): StoreScopeCase {
    const state = this.handle(peer);
    const present = PUSHDOWN_FIELDS.filter((field) => selection[field] !== undefined);
    const subsets = present.reduce<PushdownField[][]>(
      (all, field) => [...all, ...all.map((subset) => [...subset, field])],
      [[]],
    );
    return {
      name,
      spec,
      peer,
      anchors: entities.map((entity) => ({ kind: "entity", entity })),
      selection,
      held: [...held],
      scopes: subsets.map((fields) => ({
        fields,
        ids: this.scopeNames(state.held, entities, selection, fields),
      })),
    };
  }
}

// ---- the scripts --------------------------------------------------------------------------

function script(
  named: readonly Named[],
  name: string,
  spec: string,
  requires: readonly VectorRequirement[],
  body: (m: Model) => void,
): StoreScript {
  const model = new Model(named, requires.includes("changes"));
  body(model);
  return { name, spec, requires, steps: model.steps };
}

const seq = (start: number, ...names: string[]): Added[] =>
  names.map((delta, i) => ({ delta, sequence: start + i }));

function scripts(named: readonly Named[]): StoreScript[] {
  const s = (
    name: string,
    spec: string,
    body: (m: Model) => void,
    requires: readonly VectorRequirement[] = [],
  ): StoreScript => script(named, name, spec, requires, body);
  return [
    s("peers-and-postures", "SPEC-18 §4.1, §4.7.2, §7", (m) => {
      m.openPeer("A");
      m.createPeer("A", "unproven");
      m.createPeer("A", "unproven");
      m.createPeer("B", "unproven");
      m.openPeer("A");
      m.openPeer("C");
      m.exportPeers();
      m.read("A", "s");
      m.head("s");
      m.count("s");
      m.get("s", ["a-height"]);
      m.arrivals("s", ["a-height"]);
      m.targets("s", ["plant:a"]);
      m.negators("s", ["a-height"]);
      m.scope("s", ["plant:a"]);
      m.export("A");
      m.export("C");
      m.exportStored();
      // Last, because a store of class `proven` creates this peer and others refuse it.
      m.createPeer("P", "proven");
    }),
    s("append-and-point-reads", "SPEC-18 §4.2, §4.5", (m) => {
      m.createPeer("A", "unproven");
      m.append(
        "A",
        null,
        "head-1",
        seq(1, "a-height", "a-name", "bed-link", "a-twice", "b-name", "far", "cites-a-height"),
      );
      m.read("A", "s");
      m.head("s");
      m.get("s", ["a-name", "ghost", "a-height", "a-name"]);
      m.get("s", []);
      m.count("s");
      m.arrivals("s", ["a-name", "ghost", "a-height", "a-name"]);
      m.targets("s", ["plant:a"]);
      m.targets("s", ["plant:b", "plant:a", "plant:b"]);
      m.targets("s", ["bed:1"]);
      m.targets("s", ["elsewhere"]);
      m.targets("s", ["nowhere"]);
      m.targets("s", []);
      m.negators("s", ["a-height"]);
      m.export("A");
    }),
    s("negation-chains", "SPEC-18 §4.2, §4.3; SPEC-17 §4", (m) => {
      m.createPeer("A", "unproven");
      m.append("A", null, "head-1", seq(1, "a-height", "a-name", "b-name", "far"));
      m.append(
        "A",
        "head-1",
        "head-2",
        seq(
          5,
          "a-height-neg",
          "a-height-neg-neg",
          "a-height-neg-neg-neg",
          "b-name-neg",
          "cites-a-height",
          "negates-entity",
        ),
      );
      m.read("A", "s");
      m.negators("s", ["a-height"]);
      m.negators("s", ["a-height-neg"]);
      m.negators("s", ["a-height", "a-height-neg", "b-name"]);
      m.negators("s", ["a-name"]);
      m.negators("s", ["cites-a-height"]);
      m.targets("s", ["plant:b"]);
      m.scope("s", ["plant:a"]);
      m.scope("s", ["plant:b"]);
      m.scope("s", ["plant:a", "plant:b"]);
      m.scope("s", ["elsewhere"]);
      m.scope("s", ["nowhere"]);
      m.scope("s", []);
    }),
    s("negation-before-its-target", "SPEC-18 §4.5; SPEC-1 §8", (m) => {
      m.createPeer("A", "unproven");
      m.append("A", null, "head-1", seq(1, "ghost-neg", "a-name"));
      m.read("A", "s1");
      m.negators("s1", ["ghost"]);
      m.get("s1", ["ghost"]);
      m.scope("s1", ["plant:a"]);
      m.release("s1");
      m.append("A", "head-1", "head-2", seq(3, "ghost"));
      m.read("A", "s2");
      m.negators("s2", ["ghost"]);
      m.scope("s2", ["plant:a"]);
    }),
    s("duplicates-add-nothing", "SPEC-18 §4.5; SPEC-6 vNext §3", (m) => {
      m.createPeer("A", "unproven");
      // The second appearance in one batch is ignored, with its arrival.
      m.append("A", null, "head-1", [
        { delta: "a-height", sequence: 1 },
        { delta: "a-height", sequence: 2 },
        { delta: "a-name", sequence: 3 },
      ]);
      // A held id keeps its first arrival; only the new id is added.
      m.append("A", "head-1", "head-2", [
        { delta: "a-name", sequence: 9, sender: PEERS["B"]! },
        { delta: "b-name", sequence: 4 },
      ]);
      // Nothing new and the head stays: nothing observable changes.
      m.append("A", "head-2", "head-2", seq(5, "a-height", "b-name"));
      // Nothing new, but the head moves: the revision advances.
      m.append("A", "head-2", "head-3", seq(5, "a-height"));
      m.append("A", "head-3", "head-4", []);
      m.read("A", "s");
      m.head("s");
      m.count("s");
      m.arrivals("s", ["a-height", "a-name", "b-name"]);
      m.scope("s", ["plant:a", "plant:b"]);
      m.export("A");
    }),
    s("head-compare-and-set", "SPEC-18 §4.5; SPEC-6 vNext §2", (m) => {
      m.createPeer("A", "unproven");
      m.append("A", "head-0", "head-1", seq(1, "a-height"));
      // No head is null. The empty string is not null.
      m.append("A", "", "head-1", seq(1, "a-height"));
      m.append("A", null, "head-1", seq(1, "a-height"));
      m.append("A", null, "head-2", seq(2, "a-name"));
      m.append("A", "head-2", "head-2", seq(2, "a-name"));
      m.append("A", "head-1", "head-2", seq(2, "a-name"));
      m.append("A", "head-1", "head-3", seq(3, "b-name"));
      // Heads are equal only byte for byte: no trimming, no case folding.
      for (const near of [" head-2", "head-2 ", "head-2\n", "HEAD-2", "head-2\u0000", ""])
        m.append("A", near, "head-3", seq(3, "b-name"));
      m.read("A", "s");
      m.head("s");
      m.get("s", ["a-height", "a-name", "b-name"]);
      m.targets("s", ["plant:a", "plant:b"]);
    }),
    s("a-refused-append-leaves-nothing", "SPEC-18 §4.5", (m) => {
      m.createPeer("A", "unproven");
      m.append("A", null, "head-1", seq(1, "a-height"));
      // A good delta beside a forged one: neither lands.
      m.append("A", "head-1", "head-2", [
        { delta: "b-name", sequence: 2 },
        { delta: "forged", sequence: 3 },
      ]);
      // The forged entry again, with an arrival record that names the id its claims really
      // have (far's). The store refuses; it never files the claims under the recomputed id.
      m.append("A", "head-1", "head-2", [{ delta: "forged", sequence: 2, arrivalId: "far" }]);
      // The arrival record names another delta.
      m.append("A", "head-1", "head-2", [{ delta: "b-name", sequence: 2, arrivalId: "far" }]);
      // The sequence does not pass the peer's last one.
      m.append("A", "head-1", "head-2", [{ delta: "b-name", sequence: 1 }]);
      // Two new ids share one sequence.
      m.append("A", "head-1", "head-2", [
        { delta: "b-name", sequence: 2 },
        { delta: "far", sequence: 2 },
      ]);
      m.read("A", "s");
      m.head("s");
      m.get("s", ["a-height", "b-name", "far", "a-name"]);
      m.targets("s", ["plant:a", "plant:b", "elsewhere"]);
      m.exportStored();
      // The same head still accepts a good batch.
      m.append("A", "head-1", "head-2", seq(2, "b-name", "far"));
      m.read("A", "s2");
      m.targets("s2", ["plant:a", "plant:b", "elsewhere"]);
    }),
    s("two-peers-share-bytes", "SPEC-18 §4.1, §7", (m) => {
      m.createPeer("A", "unproven");
      m.createPeer("B", "unproven");
      m.append("A", null, "a-head-1", seq(1, "a-height", "a-height-neg", "k-note", "b-name"));
      m.append("B", null, "b-head-1", [
        { delta: "a-height", sequence: 7, sender: PEERS["A"]! },
        { delta: "k-note-signed", sequence: 8, sender: PEERS["A"]! },
        { delta: "far", sequence: 9 },
      ]);
      m.read("A", "a");
      m.read("B", "b");
      m.head("a");
      m.head("b");
      // Each peer answers from its own membership, with its own appearance and arrival.
      m.get("a", ["a-height", "k-note", "far", "b-name"]);
      m.get("b", ["a-height", "k-note", "far", "b-name"]);
      m.count("a");
      m.count("b");
      m.arrivals("a", ["a-height", "k-note", "far"]);
      m.arrivals("b", ["a-height", "k-note", "far"]);
      m.targets("a", ["plant:a", "plant:b", "elsewhere"]);
      m.targets("b", ["plant:a", "plant:b", "elsewhere"]);
      m.negators("a", ["a-height"]);
      m.negators("b", ["a-height"]);
      m.scope("a", ["plant:a"]);
      m.scope("b", ["plant:a"]);
      m.export("A");
      m.export("B");
      m.exportStored();
      // One peer's append does not move the other peer's snapshot.
      m.append("A", "a-head-1", "a-head-2", seq(5, "far"));
      m.scope("b", ["plant:a", "elsewhere"]);
    }),
    s(
      "purge",
      "SPEC-18 §4.7.2, §7",
      (m) => {
        m.createPeer("A", "unproven");
        m.createPeer("B", "unproven");
        m.createPeer("C", "unproven");
        m.append(
          "A",
          null,
          "a-head-1",
          seq(1, "a-height", "a-height-neg", "a-height-neg-neg", "a-name", "bed-link"),
        );
        m.append("B", null, "b-head-1", seq(1, "a-height", "a-name"));
        m.read("B", "b");
        // a-height is shared, a-height-neg is A's alone, far is held by nobody; one id twice.
        m.purge("A", ["a-height-neg", "a-height", "far", "a-height-neg"]);
        m.read("A", "a");
        m.head("a");
        m.count("a");
        m.count("b");
        m.get("a", ["a-height", "a-height-neg", "a-height-neg-neg", "a-name"]);
        m.arrivals("a", ["a-height", "a-height-neg", "a-name"]);
        m.targets("a", ["plant:a"]);
        m.negators("a", ["a-height"]);
        m.negators("a", ["a-height-neg"]);
        // The negation of a purged negation is held but no longer in any scope.
        m.scope("a", ["plant:a"]);
        // The bystander: B keeps everything, and its earlier snapshot still answers.
        m.get("b", ["a-height", "a-name"]);
        m.scope("b", ["plant:a"]);
        m.export("A");
        m.export("B");
        m.exportStored();
        // A peer that never held an id learns nothing about who does.
        m.purge("C", ["a-height", "a-name"]);
        // A still owes a-height: asking again changes nothing.
        m.purge("A", ["a-height"]);
        m.purge("B", ["a-height"]);
        // Now the bytes are gone, A's debt settles; after that A has nothing to ask about.
        m.purge("A", ["a-height"]);
        m.purge("A", ["a-height"]);
        m.exportStored();
        // A purged id may be appended again. It arrives anew.
        m.append("A", "a-head-1", "a-head-2", seq(9, "a-height-neg"));
        m.read("A", "a2");
        m.arrivals("a2", ["a-height-neg"]);
        m.negators("a2", ["a-height-neg"]);
        m.scope("a2", ["plant:a"]);
        m.purge("A", []);
      },
      ["purge"],
    ),
    s(
      "purge-clears-a-debt-on-append",
      "SPEC-18 §4.7.2",
      (m) => {
        m.createPeer("A", "unproven");
        m.createPeer("B", "unproven");
        m.append("A", null, "a-head-1", seq(1, "a-name"));
        m.append("B", null, "b-head-1", seq(1, "a-name"));
        m.purge("A", ["a-name"]);
        m.append("A", "a-head-1", "a-head-2", seq(2, "a-name"));
        // A holds the id again, under the new arrival record. The first record ended with the
        // purge, although B kept the bytes.
        m.read("A", "again");
        m.arrivals("again", ["a-name"]);
        m.scope("again", ["plant:a"]);
        m.release("again");
        m.purge("B", ["a-name"]);
        // A holds the id again, so this removes it; it does not settle the old debt.
        m.purge("A", ["a-name"]);
        m.purge("A", ["a-name"]);
        // B's debt settles here: the bytes are gone. B appends the id again, and it arrives
        // anew: the record B held before its first purge is not served again.
        m.purge("B", ["a-name"]);
        m.append("B", "b-head-1", "b-head-2", seq(2, "a-name"));
        m.read("B", "settled");
        m.arrivals("settled", ["a-name"]);
        m.scope("settled", ["plant:a"]);
        m.release("settled");
        m.exportStored();
      },
      ["purge"],
    ),
    s("snapshots", "SPEC-18 §4.2", (m) => {
      m.createPeer("A", "unproven");
      m.append("A", null, "head-1", seq(1, "a-height", "a-name"));
      m.read("A", "s1");
      m.read("A", "s1b");
      m.targets("s1", ["plant:a"]);
      m.targets("s1b", ["plant:a"]);
      m.append("A", "head-1", "head-2", seq(3, "a-height-neg", "bed-link"));
      // The peer moved. An old snapshot refuses, or answers as it did; never the new state.
      m.head("s1");
      m.count("s1");
      m.targets("s1", ["plant:a"]);
      m.get("s1", ["a-height-neg", "a-height"]);
      m.arrivals("s1", ["a-height-neg", "a-height"]);
      m.negators("s1", ["a-height"]);
      m.scope("s1", ["plant:a"]);
      m.read("A", "s2");
      m.head("s2");
      m.targets("s2", ["plant:a"]);
      m.scope("s2", ["plant:a"]);
      m.release("s2");
      m.targets("s2", ["plant:a"]);
      m.get("s2", ["a-height"]);
      m.arrivals("s2", ["a-height"]);
      m.negators("s2", ["a-height"]);
      m.scope("s2", ["plant:a"]);
      m.head("s2");
      m.count("s2");
      // The shape of a request is checked before the snapshot's state: a malformed bound is
      // `invalid-request` on a moved snapshot (s1) and on a released one (s2). 2^53 is the
      // value that reaches the store in every witness: an unsigned 64-bit field holds it, so a
      // typed runner cannot answer for the store at its own boundary.
      for (const snapshot of ["s1", "s2"])
        for (const arrivalAtMost of [1.5, -1, 2 ** 53])
          m.scope(snapshot, ["plant:a"], { arrivalAtMost });
      // Released and moved at once: either refusal conforms.
      m.release("s1");
      m.targets("s1", ["plant:a"]);
      m.scope("s1", ["plant:a"]);
    }),
    s(
      "a-snapshot-across-a-purge",
      "SPEC-18 §4.2, §4.7.2",
      (m) => {
        m.createPeer("A", "unproven");
        m.append("A", null, "head-1", seq(1, "a-height", "a-height-neg", "a-name"));
        m.read("A", "s");
        m.purge("A", ["a-height-neg"]);
        // A purge moves the peer as an append does. The old snapshot never shows the removal.
        m.head("s");
        m.count("s");
        m.get("s", ["a-height-neg", "a-name"]);
        m.arrivals("s", ["a-height-neg"]);
        m.targets("s", ["plant:a"]);
        m.negators("s", ["a-height"]);
        m.scope("s", ["plant:a"]);
        m.read("A", "s2");
        m.count("s2");
        m.scope("s2", ["plant:a"]);
      },
      ["purge"],
    ),
    s(
      "the-last-sequence-survives-a-purge",
      "SPEC-18 §4.5; SPEC-6 vNext §3",
      (m) => {
        m.createPeer("A", "unproven");
        m.append("A", null, "head-1", [
          { delta: "a-height", sequence: 1 },
          { delta: "a-name", sequence: 5 },
        ]);
        m.purge("A", ["a-name"]);
        // The peer holds nothing above sequence 1, and 5 is still spent.
        m.append("A", "head-1", "head-2", [{ delta: "b-name", sequence: 5 }]);
        m.append("A", "head-1", "head-2", [{ delta: "b-name", sequence: 3 }]);
        m.append("A", "head-1", "head-2", [{ delta: "a-name", sequence: 5 }]);
        m.append("A", "head-1", "head-2", [{ delta: "b-name", sequence: 6 }]);
        m.read("A", "s");
        m.arrivals("s", ["a-height", "a-name", "b-name"]);
      },
      ["purge"],
    ),
    s(
      "the-last-sequence-survives-an-empty-peer",
      "SPEC-18 §4.5; SPEC-6 vNext §3",
      (m) => {
        m.createPeer("A", "unproven");
        m.append("A", null, "head-1", [
          { delta: "a-height", sequence: 2 },
          { delta: "a-name", sequence: 4 },
        ]);
        m.purge("A", ["a-height", "a-name"]);
        m.read("A", "s");
        m.count("s");
        m.head("s");
        // The peer holds nothing. Its spent sequences stay spent.
        m.append("A", "head-1", "head-2", [{ delta: "a-height", sequence: 4 }]);
        m.append("A", "head-1", "head-2", [{ delta: "b-name", sequence: 1 }]);
        m.append("A", "head-1", "head-2", [{ delta: "a-height", sequence: 5 }]);
        m.read("A", "s2");
        m.arrivals("s2", ["a-height"]);
      },
      ["purge"],
    ),
    s("a-skipped-entry-spends-no-sequence", "SPEC-18 §4.5", (m) => {
      m.createPeer("A", "unproven");
      m.append("A", null, "head-1", seq(1, "a-name"));
      // The second a-height is a repeat inside the batch and is skipped. Its sequence, 6, is
      // not taken: b-name may use it.
      m.append("A", "head-1", "head-2", [
        { delta: "a-height", sequence: 5 },
        { delta: "a-height", sequence: 6 },
        { delta: "b-name", sequence: 6 },
      ]);
      // a-name is held and is skipped. A new entry may share its sequence, 9.
      m.append("A", "head-2", "head-3", [
        { delta: "a-name", sequence: 9 },
        { delta: "far", sequence: 9 },
      ]);
      // A skipped entry does not raise the largest committed sequence either.
      m.append("A", "head-3", "head-4", [{ delta: "a-name", sequence: 500 }]);
      m.append("A", "head-4", "head-5", [{ delta: "bed-link", sequence: 10 }]);
      // The largest committed sequence is 10: 9 is spent, also for a skipped entry's neighbour.
      m.append("A", "head-5", "head-6", [
        { delta: "a-name", sequence: 9 },
        { delta: "a-twice", sequence: 10 },
      ]);
      // A repeat inside the batch does not raise it either. The second a-twice carries 60 and
      // is skipped; the largest committed sequence is 11, so 12 is free.
      m.append("A", "head-5", "head-6", [
        { delta: "a-twice", sequence: 11 },
        { delta: "a-twice", sequence: 60 },
      ]);
      m.append("A", "head-6", "head-7", [{ delta: "ghost", sequence: 12 }]);
      m.read("A", "s");
      m.head("s");
      m.arrivals("s", ["a-name", "a-height", "b-name", "far", "bed-link", "a-twice", "ghost"]);
    }),
    s("the-first-appearance-is-kept", "SPEC-18 §4.5, §4.11", (m) => {
      m.createPeer("A", "unproven");
      m.createPeer("B", "unproven");
      m.createPeer("C", "unproven");
      // Unsigned first, then the signed appearance of the same id: nothing is added.
      m.append("A", null, "a-head-1", seq(1, "k-note"));
      m.append("A", "a-head-1", "a-head-2", seq(2, "k-note-signed"));
      // The reverse order on another peer.
      m.append("B", null, "b-head-1", seq(1, "k-note-signed"));
      m.append("B", "b-head-1", "b-head-2", seq(2, "k-note"));
      // Both appearances in one batch: the first entry is the one held.
      m.append("C", null, "c-head-1", seq(1, "k-note-signed", "k-note"));
      for (const peer of ["A", "B", "C"]) {
        m.read(peer, peer.toLowerCase());
        m.get(peer.toLowerCase(), ["k-note"]);
        m.arrivals(peer.toLowerCase(), ["k-note"]);
        m.scope(peer.toLowerCase(), ["plant:a"]);
        m.export(peer);
      }
      m.exportStored();
    }),
    s("an-older-handle-stays-valid", "SPEC-18 §3, §4.1", (m) => {
      m.createPeer("A", "unproven");
      m.append("A", null, "head-1", seq(1, "a-height"));
      // A second handle of the same peer. Both stay usable, and each sees the other's writes.
      m.openPeer("A", "A2");
      m.append("A2", "head-1", "head-2", seq(2, "a-name"));
      m.read("A", "s");
      m.head("s");
      m.count("s");
      m.targets("s", ["plant:a"]);
      m.append("A", "head-1", "head-3", seq(3, "b-name"));
      m.append("A", "head-2", "head-3", seq(3, "b-name"));
      m.read("A2", "s2");
      m.head("s2");
      m.count("s2");
      m.arrivals("s2", ["a-height", "a-name", "b-name"]);
      // The snapshot read through the first handle moved when either handle wrote.
      m.targets("s", ["plant:a", "plant:b"]);
    }),
    s("append-checks-before-and-after-the-head", "SPEC-18 §4.5", (m) => {
      m.createPeer("A", "unproven");
      m.append("A", null, "head-1", seq(1, "a-name"));
      // A stale writer learns it is stale first, whatever its batch holds.
      m.append("A", "head-0", "head-2", [{ delta: "forged", sequence: 2 }]);
      m.append("A", null, "head-2", [{ delta: "b-name", sequence: 2, sender: "" }]);
      // Also when the batch holds a value a typed witness cannot represent.
      m.append("A", "head-0", "head-2", [{ delta: "b-name", sequence: -1 }]);
      m.append("A", "head-0", "head-2", [{ delta: "b-name", sequence: 1.5 }]);
      m.append("A", "head-0", "head-2", [{ delta: "b-name", sequence: 2, transfer: 2 ** 53 }]);
      // With the right head every entry is checked, also one whose id is already held.
      // `forged` carries a-name's id, which A holds.
      m.append("A", "head-1", "head-2", [{ delta: "forged", sequence: 2 }]);
      m.append("A", "head-1", "head-2", [{ delta: "a-name", sequence: 2, sender: "" }]);
      m.append("A", "head-1", "head-2", [{ delta: "a-name", sequence: 2, arrivalId: "far" }]);
      m.append("A", "head-1", "head-2", [{ delta: "a-name", sequence: 0 }]);
      // A held id with a well-formed record is skipped; its sequence is not compared.
      m.append("A", "head-1", "head-2", [{ delta: "a-name", sequence: 1 }]);
      m.read("A", "s");
      m.head("s");
      m.count("s");
      m.arrivals("s", ["a-name"]);
    }),
    s("requests-a-store-refuses", "SPEC-18 §4.3, §4.5, §4.11", (m) => {
      m.createPeer("EMPTY", "unproven");
      m.createPeer("A", "unproven");
      // Two causes at once: the posture and the taken id. Either refusal conforms.
      m.createPeer("A", "proven");
      m.append("A", null, "", seq(1, "a-height"));
      const one = (patch: Partial<Added>, delta = "a-height"): void =>
        m.append("A", null, "head-1", [{ delta, sequence: 1, ...patch }]);
      one({ sender: "" });
      one({ sequence: 0 });
      one({ sequence: -1 });
      one({ sequence: 1.5 });
      one({ sequence: 2 ** 53 });
      one({ transfer: 0 });
      one({ transfer: 1.5 });
      one({ transfer: 2 ** 53 });
      one({}, "short-sig");
      one({}, "k-note-upper");
      m.read("A", "s0");
      m.head("s0");
      m.count("s0");
      m.exportStored();
      // The largest sequence and transfer a store accepts, and a fractional arrival time.
      m.append("A", null, "head-1", [
        { delta: "a-height", sequence: 7, at: 1000.5 },
        { delta: "a-name", sequence: MAX_COUNT, transfer: MAX_COUNT },
      ]);
      m.read("A", "s");
      m.arrivals("s", ["a-height", "a-name"]);
      m.scope("s", ["plant:a"], { arrivalAtMost: 0 });
      m.scope("s", ["plant:a"], { arrivalAtMost: 7 });
      m.scope("s", ["plant:a"], { arrivalAtMost: MAX_COUNT });
      m.scope("s", ["plant:a"], { arrivalAtMost: 1.5 });
      m.scope("s", ["plant:a"], { arrivalAtMost: -1 });
      m.scope("s", ["plant:a"], { arrivalAtMost: 2 ** 53 });
      m.scope("s", ["plant:a"], { timestampAtMost: -1.5 });
      // No sequence is left above the largest one.
      m.append("A", "head-1", "head-2", [{ delta: "b-name", sequence: MAX_COUNT }]);
    }),
    s("scope-pushdown-and-exclude", "SPEC-18 §4.3", (m) => {
      m.createPeer("A", "unproven");
      m.append(
        "A",
        null,
        "head-1",
        seq(1, "a-height", "a-height-neg", "a-height-neg-neg", "a-name", "bed-link"),
      );
      m.read("A", "s");
      // `exclude` trims the answer; the chain behind an excluded id is still returned.
      m.scope("s", ["plant:a"], undefined, ["a-height-neg", "a-name"]);
      // `excludeIds` is a selection: the chain stops at the dropped id.
      m.scope("s", ["plant:a"], { excludeIds: ["a-height-neg"] });
      m.scope("s", ["plant:a"], { timestampAtMost: 30 });
      m.scope("s", ["plant:a"], { arrivalAtMost: 2 });
      m.scope("s", ["plant:a"], { timestampAtMost: 40, arrivalAtMost: 4, excludeIds: ["a-name"] }, [
        "a-height",
      ]);
    }),
    s(
      "a-frame-needs-the-journal",
      "SPEC-18 §4.5, §4.7.3",
      (m) => {
        m.createPeer("A", "unproven");
        m.append("A", null, "head-1", seq(1, "a-height"), "a0");
        m.read("A", "s");
        m.head("s");
        m.get("s", ["a-height"]);
      },
      ["journal-absent"],
    ),
    // ---- the change feed (§4.6). The runner also checks the feed after every step of every
    // script above, on a store that serves one (README §3.9).
    s(
      "feed-appends-and-head-only-commits",
      "SPEC-18 §4.6, §4.13",
      (m) => {
        m.createPeer("A", "unproven");
        // A new peer's feed is empty: from its first revision there is nothing.
        m.changes("A", { revision: "A.0" });
        m.append("A", null, "head-1", seq(1, "a-height", "a-name"));
        m.append("A", "head-1", "head-2", seq(3, "b-name"));
        // Nothing new, the head moves: one record with no ids.
        m.append("A", "head-2", "head-3", []);
        // Nothing new, the same head: no record and no revision.
        m.append("A", "head-3", "head-3", seq(4, "a-height", "b-name"));
        // A held id again, the head moves: a record with no ids.
        m.append("A", "head-3", "head-4", seq(4, "a-height"));
        // A refused append and a conflict write no record.
        m.append("A", "head-4", "head-5", [{ delta: "forged", sequence: 5 }]);
        m.append("A", "head-0", "head-5", seq(5, "far"));
        m.mark("A", "middle");
        m.append("A", "head-4", "head-5", seq(5, "far", "bed-link"));
        for (let i = 6; i <= 9; i++) m.append("A", `head-${i - 1}`, `head-${i}`, []);
        m.append("A", "head-9", "head-10", seq(7, "a-twice"));
        // The whole feed: ten records, over more than one page where pages are small.
        m.changes("A", { revision: "A.0" });
        m.changes("A", { revision: "A.1" });
        m.changes("A", { revision: "middle" });
        // A range inside the feed, and a range of one record.
        m.changes("A", { revision: "A.1" }, { revision: "A.4" });
        m.changes("A", { revision: "A.3" }, { revision: "A.4" });
        // from === to, and from === the current revision: no record.
        m.changes("A", { revision: "A.2" }, { revision: "A.2" });
        m.changes("A", { revision: "A.10" });
        m.changes("A", { revision: "A.10" }, { revision: "A.10", ahead: 5 });
        // A `to` past the current revision is clamped to it.
        m.changes("A", { revision: "A.6" }, { revision: "A.10", ahead: 3 });
        // A range that ends before it starts is refused.
        m.changes("A", { revision: "A.3" }, { revision: "A.1" });
        m.changes("A", { revision: "A.10", ahead: 2 }, { revision: "A.10", ahead: 1 });
        // A cursor from the future: resync-required, with and without a `to`.
        m.changes("A", { revision: "A.10", ahead: 1 });
        m.changes("A", { revision: "A.10", ahead: 1 }, { revision: "A.10", ahead: 4 });
      },
      ["changes"],
    ),
    s(
      "feed-purge-and-debts",
      "SPEC-18 §4.6, §4.7.2, §4.13",
      (m) => {
        m.createPeer("A", "unproven");
        m.createPeer("B", "unproven");
        m.createPeer("C", "unproven");
        m.append("A", null, "a-head-1", seq(1, "a-height", "a-height-neg", "a-name", "bed-link"));
        m.append("B", null, "b-head-1", seq(1, "a-height", "a-name"));
        // a-height leaves A although B keeps the bytes: it is in A's record. far was never held.
        m.purge("A", ["a-height-neg", "a-height", "far"]);
        // A owes a-height and B still holds it: no record.
        m.purge("A", ["a-height"]);
        // B lets go. B's record names it; A's feed does not move.
        m.purge("B", ["a-height"]);
        // A's debt for a-height settles here, and a-name leaves A. Only a-name is in the record:
        // A stopped holding a-height at an earlier commit.
        m.purge("A", ["a-height", "a-name"]);
        // Only a settled or an owed debt, or nothing held: no record.
        m.purge("A", ["a-name"]);
        m.purge("B", ["a-name"]);
        m.purge("A", ["a-name"]);
        m.purge("C", ["a-height", "bed-link"]);
        m.purge("A", []);
        // A purged id is added again, purged again, and added again: each is a record.
        m.append("A", "a-head-1", "a-head-2", seq(9, "a-height-neg"));
        m.purge("A", ["a-height-neg"]);
        m.append("A", "a-head-2", "a-head-3", seq(10, "a-height-neg", "a-name"));
        m.changes("A", { revision: "A.0" });
        m.changes("A", { revision: "A.2" }, { revision: "A.4" });
        m.changes("B", { revision: "B.0" });
        m.changes("C", { revision: "C.0" });
        m.exportStored();
      },
      ["changes", "purge"],
    ),
    s(
      "feed-a-debt-ends-on-append",
      "SPEC-18 §4.6, §4.7.2",
      (m) => {
        m.createPeer("A", "unproven");
        m.createPeer("B", "unproven");
        m.append("A", null, "a-head-1", seq(1, "a-name", "b-name"));
        m.append("B", null, "b-head-1", seq(1, "a-name"));
        m.purge("A", ["a-name"]);
        // The append ends A's debt and holds the id again: a record adds it.
        m.append("A", "a-head-1", "a-head-2", seq(3, "a-name"));
        m.purge("B", ["a-name"]);
        // A holds the id again, so this purge releases it: a record removes it.
        m.purge("A", ["a-name", "b-name"]);
        m.changes("A", { revision: "A.0" });
        m.changes("A", { revision: "A.1" }, { revision: "A.3" });
      },
      ["changes", "purge"],
    ),
    s(
      "feed-two-peers-interleaved",
      "SPEC-18 §4.1, §4.6",
      (m) => {
        m.createPeer("A", "unproven");
        m.createPeer("B", "unproven");
        m.append("B", null, "b-head-1", seq(1, "far", "ghost"));
        m.append("A", null, "a-head-1", seq(1, "a-height"));
        m.append("B", "b-head-1", "b-head-2", seq(3, "b-name"));
        m.append("A", "a-head-1", "a-head-2", seq(2, "a-name"));
        m.append("B", "b-head-2", "b-head-3", []);
        // Bytes both peers hold: each feed names the id once, at its own commit.
        m.append("A", "a-head-2", "a-head-3", seq(3, "k-note"));
        m.append("B", "b-head-3", "b-head-4", seq(4, "k-note-signed", "a-height"));
        m.openPeer("A", "A2");
        m.append("A2", "a-head-3", "a-head-4", seq(4, "bed-link"));
        m.changes("A", { revision: "A.0" });
        m.changes("A2", { revision: "A.2" });
        m.changes("B", { revision: "B.0" });
        m.changes("B", { revision: "B.1" }, { revision: "B.3" });
        // Each peer's revisions are its own: B is ahead of A, and A's cursor is A's.
        m.changes("A", { revision: "A.4" });
        m.changes("A", { revision: "A.4", ahead: 1 });
      },
      ["changes"],
    ),
  ];
}

// ---- the scope document -------------------------------------------------------------------

function scopeDocument(named: readonly Named[]): {
  setup: StoreVectorStep[];
  cases: StoreScopeCase[];
} {
  const m = new Model(named);
  m.createPeer("A", "unproven");
  m.createPeer("B", "unproven");
  // Arrival order differs from signed time on purpose: the two selections must not agree.
  m.append(
    "A",
    null,
    "a-head-1",
    seq(1, "a-height-neg-neg", "bed-link", "a-height", "b-name-neg", "far"),
  );
  m.append(
    "A",
    "a-head-1",
    "a-head-2",
    seq(6, "a-name", "a-height-neg", "b-name", "a-height-neg-neg-neg", "a-twice", "ghost-neg"),
  );
  m.append("A", "a-head-2", "a-head-3", seq(12, "c-late", "c-early-neg"));
  // Another peer holds deltas at the same anchors. They never appear in A's scopes.
  m.append("B", null, "b-head-1", seq(1, "ghost", "k-note-signed", "a-height", "cites-a-height"));
  // A second handle of A. One case reads through it; its bookkeeping is A's.
  m.openPeer("A", "A2");
  const setup = [...m.steps];
  const spec = "SPEC-18 §4.3";
  const cases = [
    m.scopeCase("no-selection", spec, "A", ["plant:a"], {}),
    m.scopeCase("two-anchors", spec, "A", ["plant:a", "plant:b"], {}),
    m.scopeCase("through-a-second-handle", spec, "A2", ["plant:a"], { arrivalAtMost: 7 }, [
      "a-height",
    ]),
    m.scopeCase("an-anchor-nothing-points-at", spec, "A", ["nowhere"], { timestampAtMost: 30 }),
    m.scopeCase("no-anchors", spec, "A", [], {}),
    // a-height-neg-neg (t=40) is cut, so a-height-neg stands alone.
    m.scopeCase("signed-time-cuts-a-chain", spec, "A", ["plant:a"], { timestampAtMost: 30 }),
    // a-height-neg arrived at 7; its own negation arrived at 1 and is unreachable without it.
    m.scopeCase("arrival-cuts-a-chain", spec, "A", ["plant:a"], { arrivalAtMost: 6 }),
    m.scopeCase("excluded-ids-cut-a-chain", spec, "A", ["plant:a"], {
      excludeIds: ["a-height-neg"],
    }),
    // The anchored delta fails the selection; its negator passes and still is not in scope.
    m.scopeCase("a-negator-without-its-target", spec, "A", ["plant:b"], { arrivalAtMost: 5 }),
    m.scopeCase("every-field", spec, "A", ["plant:a", "plant:b"], {
      timestampAtMost: 40,
      arrivalAtMost: 9,
      excludeIds: ["a-name", "far"],
    }),
    // c-early-neg (t=65) passes and its target c-late (t=70) does not. A store that walks the
    // chain first and filters afterwards returns the negation, outside the upper bound.
    m.scopeCase("a-negation-signed-before-its-target", spec, "A", ["plant:c"], {
      timestampAtMost: 67,
    }),
    m.scopeCase("the-selection-admits-nothing", spec, "A", ["plant:a"], { timestampAtMost: 1 }),
    // The read holds the middle of a chain. The store must still return what negates it.
    m.scopeCase("held-middle-of-a-chain", spec, "A", ["plant:a"], {}, ["a-height-neg", "a-name"]),
    // Held ids that fail the selection must not enter the trimmed scope.
    m.scopeCase(
      "held-ids-that-fail-the-selection",
      spec,
      "A",
      ["plant:a", "plant:b"],
      { timestampAtMost: 30, arrivalAtMost: 8 },
      ["a-height-neg-neg", "a-height", "b-name", "far"],
    ),
    m.scopeCase("held-the-whole-scope", spec, "A", ["plant:b"], { excludeIds: ["a-height"] }, [
      "b-name",
      "b-name-neg",
    ]),
  ];
  return { setup, cases };
}

/** The shared store vectors. The committed files under `vectors/store/` are exactly this. */
export function storeVectors(): StoreVectors {
  const named = corpus();
  const deltas: VectorDelta[] = named.map(({ name, delta, forged }) => ({
    name,
    id: delta.id,
    claims: claimsToJson(delta.claims),
    ...(delta.sig === undefined ? {} : { sig: delta.sig }),
    ...(forged === true ? { forged } : {}),
  }));
  const header = {
    reference: { formatVersion: MEMORY_STORE_FORMAT },
    peers: PEERS,
    deltas,
  };
  return {
    scripts: {
      format: STORE_SCRIPTS_FORMAT,
      note: "SPEC-18 proposal: store operation scripts. Each step names its expected ids or report. See vectors/store/README.md.",
      ...header,
      scripts: scripts(named),
    },
    scope: {
      format: STORE_SCOPE_FORMAT,
      note: "SPEC-18 proposal §4.3: the trim lemma. For each case and each subset of the selection pushed down, the trimmed scope equals the scope under the whole selection. See vectors/store/README.md.",
      ...header,
      ...scopeDocument(named),
    },
  };
}
