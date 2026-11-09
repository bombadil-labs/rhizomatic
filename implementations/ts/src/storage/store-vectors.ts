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
  type StoreScopeCase,
  type StoreScript,
  type StoreVectorStep,
  type StoreVectors,
  type VectorArrival,
  type VectorDelta,
  type VectorPushdown,
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

  // One id in two appearances: unsigned, and signed by its author.
  const keyClaims = fact(authorForSeed(KEY_SEED), 12, [at("plant:a", "note"), value("signed")]);
  named.push({ name: "k-note", delta: makeDelta(keyClaims) });
  named.push({ name: "k-note-signed", delta: signClaims(keyClaims, KEY_SEED) });

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
};

// ---- the model ----------------------------------------------------------------------------

type Entry = VerifiedDelta & { readonly name: string };
type ModelPeer = {
  readonly posture: ErasurePosture;
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
};

class Model {
  readonly steps: StoreVectorStep[] = [];
  private readonly byName: Map<string, Named>;
  private readonly peers = new Map<string, ModelPeer>();
  private readonly snapshots = new Map<string, ModelSnapshot>();
  private transfer = 0;

  constructor(named: readonly Named[]) {
    this.byName = new Map(named.map((n) => [n.name, n]));
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

  createPeer(peer: string, erasure: ErasurePosture): void {
    const step = { op: "createPeer", peer, erasure } as const;
    if (erasure === "proven") {
      // The model is a store of class `unprovable`. A `proven` store creates this peer; no
      // later step uses it.
      this.steps.push({
        ...step,
        expect: { error: "posture-refused", unlessStoreErasure: "proven" },
      });
    } else if (this.peers.has(peer)) {
      this.steps.push({ ...step, expect: { error: "peer-exists" } });
    } else {
      this.peers.set(peer, {
        posture: erasure,
        head: null,
        revision: 0,
        lastSequence: 0,
        held: [],
        owed: new Set(),
      });
      this.steps.push({ ...step, expect: { status: "created" } });
    }
  }

  openPeer(peer: string): void {
    const state = this.peers.get(peer);
    this.steps.push({
      op: "openPeer",
      peer,
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
    const state = this.peers.get(peer)!;
    const transfer = ++this.transfer;
    const batch = added.map((a) => {
      const arrival: VectorArrival = {
        at: 1000 + a.sequence,
        sequence: a.sequence,
        transfer,
        sender: a.sender ?? "local",
        ...(a.arrivalId === undefined ? {} : { id: a.arrivalId }),
      };
      return { delta: a.delta, arrival };
    });
    const step = { op: "append", peer, expectedHead, nextHead, frame, added: batch } as const;

    if (frame !== null) {
      this.steps.push({ ...step, expect: { error: "capability-absent" } });
      return;
    }
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
      if (entry.forged === true) return invalid();
      if (arrival.id !== undefined && this.id(arrival.id) !== entry.delta.id) return invalid();
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
    if (revisionAdvanced) state.revision++;
    this.steps.push({
      ...step,
      expect: { status: "committed", added: this.names(fresh), revisionAdvanced },
    });
  }

  purge(peer: string, names: readonly string[]): void {
    const state = this.peers.get(peer)!;
    const distinct = new Map<string, string>();
    for (const name of names) if (!distinct.has(this.id(name))) distinct.set(this.id(name), name);
    const targets: { delta: string; outcome: PurgeOutcome }[] = [];
    let changed = false;
    for (const id of [...distinct.keys()].sort(compareUtf8)) {
      let outcome: PurgeOutcome;
      if (state.held.some((e) => e.delta.id === id)) {
        state.held = state.held.filter((e) => e.delta.id !== id);
        changed = true;
        outcome = this.elsewhere(state, id) ? "held-by-other-peer" : "removed";
        if (outcome === "held-by-other-peer") state.owed.add(id);
      } else if (state.owed.has(id)) {
        outcome = this.elsewhere(state, id) ? "held-by-other-peer" : "removed";
        if (outcome === "removed") state.owed.delete(id);
      } else outcome = "not-held";
      targets.push({ delta: distinct.get(id)!, outcome });
    }
    if (changed) state.revision++;
    const shared = targets.some((t) => t.outcome === "held-by-other-peer");
    this.steps.push({
      op: "purge",
      peer,
      ids: [...names],
      expect: {
        targets,
        revisionAdvanced: changed,
        claim: { unprovable: "unproven", proven: shared ? "unproven" : "proven" },
        referenceSurfaces: [
          { surface: "rows", state: shared ? "owed" : "absent" },
          { surface: "index-entries", state: "absent" },
          { surface: "process-memory", state: "unprovable" },
        ],
      },
    });
  }

  read(peer: string, snapshot: string): void {
    const state = this.peers.get(peer)!;
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
  // `snapshot-moved` or answers as it would have at its own revision.
  private answer<T extends object>(
    snapshot: string,
    answer: (held: readonly Entry[]) => T,
  ): (T & { orError?: "snapshot-moved" }) | { error: "snapshot-released" } {
    const state = this.snapshots.get(snapshot)!;
    if (state.released) return { error: "snapshot-released" };
    const moved = state.peer.revision !== state.revision;
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
    this.steps.push({
      op: "scope",
      snapshot,
      anchors: entities.map((entity) => ({ kind: "entity", entity })),
      ...(pushdown === undefined ? {} : { pushdown }),
      ...(exclude === undefined ? {} : { exclude: [...exclude] }),
      expect: this.answer(snapshot, (held) => ({
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
    const state = this.peers.get(peer)!;
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
  const model = new Model(named);
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
      m.append("A", null, "head-1", seq(1, "a-height"));
      m.append("A", null, "head-2", seq(2, "a-name"));
      m.append("A", "head-2", "head-2", seq(2, "a-name"));
      m.append("A", "head-1", "head-2", seq(2, "a-name"));
      m.append("A", "head-1", "head-3", seq(3, "b-name"));
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
        m.purge("B", ["a-name"]);
        // A holds the id again, so this removes it; it does not settle the old debt.
        m.purge("A", ["a-name"]);
        m.purge("A", ["a-name"]);
        m.purge("B", ["a-name"]);
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
  // Another peer holds deltas at the same anchors. They never appear in A's scopes.
  m.append("B", null, "b-head-1", seq(1, "ghost", "k-note-signed", "a-height", "cites-a-height"));
  const setup = [...m.steps];
  const spec = "SPEC-18 §4.3";
  const cases = [
    m.scopeCase("no-selection", spec, "A", ["plant:a"], {}),
    m.scopeCase("two-anchors", spec, "A", ["plant:a", "plant:b"], {}),
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
