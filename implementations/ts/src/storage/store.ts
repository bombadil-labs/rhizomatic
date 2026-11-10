// The store interface (SPEC-18 proposal §4). One logical contract; implementations choose their
// own layout. Every id list a store returns is ascending by the UTF-8 bytes of the id and holds
// no duplicate, so two conforming stores answer with the same bytes.

import type { Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";

/** A delta's content address. */
export type Id = string;
/** An entity id, as a pointer target spells it. */
export type Entity = string;
/** A peer's governing key. The store treats it as an opaque, non-empty name. */
export type PeerId = string;
/** A journal head. The store compares heads for equality and never interprets them. */
export type Head = string;
/** A peer-local arrival sequence (SPEC-6 vNext §3). */
export type ArrivalSeq = number;
/**
 * A peer-local revision. It increases each time a committed append or purge changes what a
 * snapshot can observe. Compare revisions of one peer only.
 */
export type Revision = number;

export type StoreErrorCode =
  | "store-closed"
  | "unknown-scheme"
  | "invalid-url"
  | "scheme-exists"
  | "open-failed"
  | "capability-absent"
  | "peer-absent"
  | "peer-exists"
  | "posture-refused"
  | "invalid-admission"
  | "invalid-request"
  | "snapshot-moved"
  | "snapshot-released";

/** Every refusal a store raises. `code` is shared vocabulary; the message is for a person. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

/** What a store can prove after a purge (§4.7.2). `none` means it offers no purge. */
export type ErasureClass = "proven" | "unprovable" | "none";
/** What a peer promises about erasure. It is declared at creation and never changes. */
export type ErasurePosture = "proven" | "unproven";

export type StoreProfile = {
  readonly capabilities: {
    readonly values: boolean;
    readonly arrival: boolean;
    readonly journal: boolean;
    readonly views: boolean;
    readonly derivedIndexes: boolean;
    readonly digest: boolean;
    readonly erasure: ErasureClass;
  };
  readonly indexedValueRoles: readonly string[];
  readonly pushdown: AppliedPushdown;
  readonly writers: "one-process" | "many-processes";
  readonly atRest: "trusted" | "untrusted";
  /** `none`: the store serves no change feed. */
  readonly changeRetention: "none" | "unbounded" | { readonly revisions: number };
  readonly formatVersion: string;
};

/** A capability a host can require at open (§4.8). */
export type StoreRequirement =
  | "values"
  | "arrival"
  | "journal"
  | "views"
  | "derivedIndexes"
  | "digest"
  | "changes"
  | "purge"
  | "erasure-proven";

// Each name maps to its own test. A name outside this table is refused, never looked up on the
// profile: `erasure` holds a string and `constructor` is inherited, and both would read as met.
const REQUIREMENTS: { readonly [K in StoreRequirement]: (profile: StoreProfile) => boolean } = {
  values: (profile) => profile.capabilities.values === true,
  arrival: (profile) => profile.capabilities.arrival === true,
  journal: (profile) => profile.capabilities.journal === true,
  views: (profile) => profile.capabilities.views === true,
  derivedIndexes: (profile) => profile.capabilities.derivedIndexes === true,
  digest: (profile) => profile.capabilities.digest === true,
  changes: (profile) => profile.changeRetention !== "none",
  purge: (profile) => profile.capabilities.erasure !== "none",
  "erasure-proven": (profile) => profile.capabilities.erasure === "proven",
};

/**
 * The requirements this profile does not meet, in the order asked. Refuses `invalid-request`,
 * naming it, for a requirement that is not a `StoreRequirement`.
 */
export function missingRequirements(
  profile: StoreProfile,
  requires: readonly StoreRequirement[],
): StoreRequirement[] {
  return requires.filter((requirement) => {
    if (typeof requirement !== "string" || !Object.hasOwn(REQUIREMENTS, requirement))
      throw new StoreError("invalid-request", `unknown store requirement: ${String(requirement)}`);
    return !REQUIREMENTS[requirement](profile);
  });
}

/**
 * A store owns what it holds; no caller holds a reference into it. It keeps its own copy of
 * every delta and arrival record it is given, and what it returns can be changed by the caller
 * without changing the store. Handles (`PeerStore`, `Snapshot`) stay usable after later writes
 * through any handle of the same peer.
 */
export interface Store {
  readonly profile: StoreProfile;
  /**
   * Creates a peer with no holdings. The erasure posture is required and fixed here, before
   * any write. Refuses `posture-refused` when the posture is `proven` and this store's erasure
   * class is not, and `peer-exists` when the id is taken.
   */
  createPeer(id: PeerId, options: CreatePeerOptions): Promise<PeerStore>;
  /** Opens an existing peer. Refuses `peer-absent`; it never creates one. */
  peer(id: PeerId): Promise<PeerStore>;
  /** Whole-store operations. Never hand this to the serving path. */
  openAdmin(): Exporter;
  close(): Promise<void>;
}

export type CreatePeerOptions = {
  /** `unproven` is the operator's acknowledgement that erasure reports may say `unproven`. */
  readonly erasure: ErasurePosture;
};

export interface PeerStore {
  readonly id: PeerId;
  /** The posture declared at creation, and the store's erasure class recorded with it. */
  readonly erasure: { readonly posture: ErasurePosture; readonly storeClass: ErasureClass };
  /** A consistent view of this peer at one revision. */
  read(): Promise<Snapshot>;
  append(batch: Admission): Promise<AppendResult>;
  /** Removes these ids from this peer (§4.7.2). Refuses `capability-absent` on class `none`. */
  purge(ids: readonly Id[]): Promise<PurgeReport>;
}

/**
 * Every operation on one snapshot answers at `revision`. A store without read transactions
 * fails an operation with `snapshot-moved` once the peer's revision has passed it; it never
 * answers from the later state.
 */
export interface Snapshot {
  readonly revision: Revision;
  /** The peer's journal head at this revision; null before the first committed append. */
  readonly head: Head | null;
  /** How many deltas the peer holds at this revision. Costs O(1). */
  readonly count: number;
  /** The held deltas among `ids`, each as this peer admitted it. */
  get(ids: readonly Id[]): Promise<readonly Delta[]>;
  /** This peer's arrival record for each held id among `ids`. */
  arrivals(ids: readonly Id[]): Promise<readonly ArrivalRecord[]>;
  /** Held deltas with a pointer whose target is one of these entities, any role or context. */
  targets(entities: readonly Entity[]): Promise<readonly Id[]>;
  /** Held deltas with a pointer `{role: "negates", target: DeltaRef(id)}` for one of `ids`. */
  negators(ids: readonly Id[]): Promise<readonly Id[]>;
  scope(request: ScopeRequest): Promise<ScopeResult>;
  /** Ends the snapshot. Later operations fail with `snapshot-released`. */
  release(): void;
}

/**
 * Something a store turns into delta ids from an index (§4.7.1). Value lookups and derived
 * indexes join this union when their indexes exist.
 */
export type Anchor = { readonly kind: "entity"; readonly entity: Entity };

export type Pushdown = {
  /** Keep deltas whose signed `timestamp` is at most this. */
  readonly timestampAtMost?: number;
  /** Keep deltas whose arrival sequence at this peer is at most this. */
  readonly arrivalAtMost?: ArrivalSeq;
  /** Drop these ids from the selection. Negation chains do not pass through them. */
  readonly excludeIds?: readonly Id[];
};

/** For each pushdown field: whether the store applied it to this request. */
export type AppliedPushdown = {
  readonly timestampAtMost: boolean;
  readonly arrivalAtMost: boolean;
  readonly excludeIds: boolean;
};

export type ScopeRequest = {
  readonly anchors: readonly Anchor[];
  readonly pushdown?: Pushdown;
  /**
   * Ids the read already holds. The store may leave them out of the result, but it still
   * follows negation chains through them. This is not a selection; `Pushdown.excludeIds` is.
   */
  readonly exclude?: readonly Id[];
};

/** An admitted delta with the arrival record of the peer that holds it. */
export type VerifiedDelta = { readonly delta: Delta; readonly arrival: ArrivalRecord };

export type ScopeResult = {
  /** Ascending by id. Each member carries this peer's arrival record. */
  readonly deltas: readonly VerifiedDelta[];
  /** True only for a field that was requested and that every returned member passes. */
  readonly applied: AppliedPushdown;
};

export type Admission = {
  /** The head this append replaces; null when the peer has never committed an append. */
  readonly expectedHead: Head | null;
  readonly nextHead: Head;
  /** The canonical journal frame. A store without the `journal` capability refuses one. */
  readonly frame: Uint8Array | null;
  readonly added: readonly VerifiedDelta[];
};

export type AppendResult =
  /** `added` names the ids this peer did not hold before, ascending. */
  | { readonly status: "committed"; readonly revision: Revision; readonly added: readonly Id[] }
  /** The peer's head is not `expectedHead`. Nothing changed. */
  | { readonly status: "conflict" }
  /** The store cannot tell whether the append committed. Reopen and replan. */
  | { readonly status: "uncertain"; readonly fault: string };

export type PurgeOutcome =
  /** This peer held the id; its bytes are no longer in the store. */
  | "removed"
  /** This peer no longer holds the id, but another peer does, so the bytes stay. */
  | "held-by-other-peer"
  /** This peer did not hold the id and owes nothing for it. Nothing changed. */
  | "not-held";

export type SurfaceState = "absent" | "owed" | "unprovable";

/** The limit of every absence claim (§4.7.2). Each report repeats it. */
export const PURGE_BOUNDARY = "store-controlled-surfaces";

export type PurgeReport = {
  /**
   * What the store asserts about the bytes of the targets this report marks `removed`, and
   * about no other target. `nothing-removed`: no target has that outcome, so nothing is
   * asserted. `proven`: the store's class is `proven`, it declares at least one surface, and
   * every surface is `absent`. A store may always say `unproven` instead of `proven`.
   */
  readonly claim: "proven" | "unproven" | "nothing-removed";
  readonly boundary: typeof PURGE_BOUNDARY;
  readonly revision: Revision;
  /** One entry per distinct requested id, ascending by id. */
  readonly targets: readonly { readonly id: Id; readonly outcome: PurgeOutcome }[];
  /**
   * Every storage surface the store declares, in the store's fixed order, with its state for
   * the `removed` targets. A target another peer still holds is told by its outcome, not here.
   */
  readonly surfaces: readonly { readonly surface: string; readonly state: SurfaceState }[];
};

/**
 * Whole-store operations, O(surface) by definition. Admin, backup and declared full-surface
 * reads only. A listing is always one peer's holdings unless its name says `stored`.
 */
export interface Exporter {
  /** Every peer in the store, ascending. */
  peers(): AsyncIterable<PeerId>;
  /** One peer's holdings. Refuses `peer-absent` when a listing is first read. */
  peer(id: PeerId): PeerExporter;
  /**
   * Every id the store keeps bytes for, whichever peers hold it. Never use this to choose
   * what one peer purges or serves: it names other peers' deltas.
   */
  storedIds(): AsyncIterable<Id>;
}

export interface PeerExporter {
  ids(): AsyncIterable<Id>;
  /** The same members as `ids`, in the same order, each as this peer admitted it. */
  deltas(): AsyncIterable<Delta>;
}
