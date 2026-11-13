// The shape of the shared store vectors (SPEC-18 proposal §8) and the two definitions a host and
// the vectors share: the scope over a small set, and a pointwise selection. The normative text
// for these documents is `vectors/store/README.md`.

import { compareUtf8 } from "../delta/cbor.js";
import type { TouchReason } from "./freshness.js";
import type {
  Anchor,
  AppliedPushdown,
  ChangeRetention,
  ErasurePosture,
  PurgeOutcome,
  Pushdown,
  StoreErrorCode,
  SurfaceState,
  VerifiedDelta,
} from "./store.js";

export const STORE_SCRIPTS_FORMAT = "rhizomatic-store-scripts/1";
export const STORE_SCOPE_FORMAT = "rhizomatic-store-scope/1";
export const STORE_FRESHNESS_FORMAT = "rhizomatic-store-freshness/1";
export const STORE_FOLLOW_FORMAT = "rhizomatic-store-follow/1";

export type PushdownField = keyof AppliedPushdown;
/** The fixed order of pushdown field names in every vector. */
export const PUSHDOWN_FIELDS: readonly PushdownField[] = [
  "timestampAtMost",
  "arrivalAtMost",
  "excludeIds",
];

export type VectorDelta = {
  readonly name: string;
  readonly id: string;
  readonly claims: unknown;
  readonly sig?: string;
  readonly forged?: true;
};
export type VectorArrival = {
  readonly at: number;
  readonly sequence: number;
  readonly transfer: number;
  readonly sender: string;
  readonly id?: string;
};
export type VectorPushdown = {
  readonly timestampAtMost?: number;
  readonly arrivalAtMost?: number;
  readonly excludeIds?: readonly string[];
};
export type VectorRequirement = "purge" | "journal-absent" | "changes";

/** One code, or a list when more than one cause applies and any listed code conforms. */
export type VectorRefusal = StoreErrorCode | readonly StoreErrorCode[];
type Refusal = { readonly error: VectorRefusal };
type Stale = { readonly orError?: "snapshot-moved" };

export type CreatePeerStep = {
  readonly op: "createPeer";
  readonly peer: string;
  readonly erasure: ErasurePosture;
  readonly expect:
    | { readonly status: "created" }
    | { readonly error: VectorRefusal; readonly unlessStoreErasure?: "proven" };
};
export type OpenPeerStep = {
  readonly op: "openPeer";
  readonly peer: string;
  readonly handle?: string;
  readonly expect: { readonly status: "opened"; readonly posture: ErasurePosture } | Refusal;
};
export type AppendStep = {
  readonly op: "append";
  readonly peer: string;
  /** Names the peer's revision after the step, for later `changes` steps. */
  readonly revisionAs?: string;
  readonly expectedHead: string | null;
  readonly nextHead: string;
  readonly frame: string | null;
  readonly added: readonly { readonly delta: string; readonly arrival: VectorArrival }[];
  readonly expect:
    | {
        readonly status: "committed";
        readonly added: readonly string[];
        readonly revisionAdvanced: boolean;
      }
    | { readonly status: "conflict" }
    | Refusal;
};
export type PurgeStep = {
  readonly op: "purge";
  readonly peer: string;
  /** Names the peer's revision after the step, for later `changes` steps. */
  readonly revisionAs?: string;
  readonly ids: readonly string[];
  readonly expect: {
    readonly targets: readonly { readonly delta: string; readonly outcome: PurgeOutcome }[];
    readonly revisionAdvanced: boolean;
    readonly claim:
      | { readonly unprovable: "unproven"; readonly proven: "proven" }
      | { readonly unprovable: "nothing-removed"; readonly proven: "nothing-removed" };
    readonly referenceSurfaces: readonly {
      readonly surface: string;
      readonly state: SurfaceState;
    }[];
  };
};
export type ReadStep = { readonly op: "read"; readonly peer: string; readonly snapshot: string };
export type ReleaseStep = { readonly op: "release"; readonly snapshot: string };
export type HeadStep = {
  readonly op: "head";
  readonly snapshot: string;
  readonly expect: { readonly head: string | null };
};
export type GetStep = {
  readonly op: "get";
  readonly snapshot: string;
  readonly ids: readonly string[];
  readonly expect: ({ readonly deltas: readonly string[] } & Stale) | Refusal;
};
export type TargetsStep = {
  readonly op: "targets";
  readonly snapshot: string;
  readonly entities: readonly string[];
  readonly expect: ({ readonly ids: readonly string[] } & Stale) | Refusal;
};
export type NegatorsStep = {
  readonly op: "negators";
  readonly snapshot: string;
  readonly ids: readonly string[];
  readonly expect: ({ readonly ids: readonly string[] } & Stale) | Refusal;
};
export type ScopeStep = {
  readonly op: "scope";
  readonly snapshot: string;
  readonly anchors: readonly Anchor[];
  readonly pushdown?: VectorPushdown;
  readonly exclude?: readonly string[];
  readonly expect:
    | ({ readonly lower: readonly string[]; readonly upper: readonly string[] } & Stale)
    | Refusal;
};
export type CountStep = {
  readonly op: "count";
  readonly snapshot: string;
  readonly expect: { readonly count: number };
};
export type ArrivalsStep = {
  readonly op: "arrivals";
  readonly snapshot: string;
  readonly ids: readonly string[];
  readonly expect: ({ readonly ids: readonly string[] } & Stale) | Refusal;
};
export type ExportStep = {
  readonly op: "export";
  readonly peer: string;
  readonly expect: { readonly deltas: readonly string[] } | Refusal;
};
export type ExportStoredStep = {
  readonly op: "exportStored";
  readonly expect: { readonly ids: readonly string[] };
};
export type ExportPeersStep = {
  readonly op: "exportPeers";
  readonly expect: { readonly peers: readonly string[] };
};
/** Names the peer's current revision. */
export type MarkStep = { readonly op: "mark"; readonly peer: string; readonly as: string };
/**
 * A named revision, or a revision `ahead` steps later than it. Revisions are integers in every
 * witness, so `ahead` adds to the integer; the vectors use it only past the current revision.
 */
export type RevisionRef = { readonly revision: string; readonly ahead?: number };
/** One expected change record. `revision` is a name; the id lists are corpus names. */
export type VectorRecord = {
  readonly revision: string;
  readonly head: string | null;
  readonly added: readonly string[];
  readonly removed: readonly string[];
};
export type ChangesStep = {
  readonly op: "changes";
  readonly peer: string;
  readonly from: RevisionRef;
  readonly to?: RevisionRef;
  readonly expect:
    | { readonly status: "ok"; readonly records: readonly VectorRecord[] }
    | { readonly status: "resync-required" }
    | Refusal;
};
export type StoreVectorStep =
  | CreatePeerStep
  | OpenPeerStep
  | AppendStep
  | PurgeStep
  | ReadStep
  | ReleaseStep
  | HeadStep
  | GetStep
  | TargetsStep
  | NegatorsStep
  | ScopeStep
  | CountStep
  | ArrivalsStep
  | ExportStep
  | ExportStoredStep
  | ExportPeersStep
  | MarkStep
  | ChangesStep;

export type StoreScript = {
  readonly name: string;
  readonly spec: string;
  /** Absent means none. */
  readonly requires?: readonly VectorRequirement[];
  readonly steps: readonly StoreVectorStep[];
};
export type VectorHeader = {
  readonly note: string;
  readonly reference: { readonly formatVersion: string };
  readonly peers: Readonly<Record<string, string>>;
  readonly deltas: readonly VectorDelta[];
};
export type StoreScriptsDocument = VectorHeader & {
  readonly format: typeof STORE_SCRIPTS_FORMAT;
  readonly scripts: readonly StoreScript[];
};
export type StoreScopeCase = {
  readonly name: string;
  readonly spec: string;
  readonly peer: string;
  readonly anchors: readonly Anchor[];
  readonly selection: VectorPushdown;
  readonly held: readonly string[];
  readonly scopes: readonly {
    readonly fields: readonly PushdownField[];
    readonly ids: readonly string[];
  }[];
};
export type StoreScopeDocument = VectorHeader & {
  readonly format: typeof STORE_SCOPE_FORMAT;
  readonly setup: readonly StoreVectorStep[];
  readonly cases: readonly StoreScopeCase[];
};
/** A touch in a freshness vector: a revision name, a corpus name and the reason. */
export type VectorTouch = {
  readonly revision: string;
  readonly delta: string;
  readonly reason: TouchReason;
};
/** Takes a capture on a new snapshot of `peer` (README §9.2). */
export type CaptureStep = {
  readonly op: "capture";
  readonly peer: string;
  /** The name later `check` steps use for this capture. */
  readonly as: string;
  readonly anchors: readonly Anchor[];
  /** The read's whole selection, in pushdown form. Absent: none. */
  readonly selection?: VectorPushdown;
  /** The read's evaluation time. */
  readonly now: number;
  readonly expect: {
    readonly revision: string;
    readonly anchors: readonly Anchor[];
    readonly members: readonly string[];
    readonly since: number | null;
    readonly expiresAt: number | null;
  };
};
export type VectorVerdict =
  | { readonly status: "current" }
  | { readonly status: "stale"; readonly touch: VectorTouch }
  | { readonly status: "not-yet"; readonly since: number }
  | { readonly status: "expired"; readonly expiresAt: number }
  | { readonly status: "resync-required" };
/** Checks a capture against the peer's current revision (README §9.3). */
export type CheckStep = {
  readonly op: "check";
  readonly peer: string;
  readonly capture: string;
  /** The time the check is asked about. */
  readonly now: number;
  /**
   * The check runs on a peer other than the capture's, on purpose. Its history differs, so the
   * verdict is `resync-required`, and `touching` is not run.
   */
  readonly anotherPeer?: true;
  /**
   * True: the generator proved the verdict exact by recomputing the raw scope. False: the
   * capture has a selection, and the verdict is only sound.
   */
  readonly exact: boolean;
  readonly expect: {
    /** The peer's revision when the check runs. */
    readonly revision: string;
    readonly verdict: VectorVerdict;
    /**
     * What `touching` answers over every record since the capture, kept or not. Null also for a
     * check on another peer, where it is not run.
     */
    readonly touching: VectorTouch | null;
  };
};
export type FreshnessStep = StoreVectorStep | CaptureStep | CheckStep;
export type StoreFreshnessCase = {
  readonly name: string;
  readonly note: string;
  readonly spec: string;
  readonly requires?: readonly VectorRequirement[];
  /** Absent: the reference store as built by default. */
  readonly store?: { readonly changeRetention: Exclude<ChangeRetention, "none"> };
  readonly steps: readonly FreshnessStep[];
};
/** `touching` alone, over records no store wrote (README §9.5). Revisions are integers. */
export type StoreTouchingCase = {
  readonly name: string;
  readonly note: string;
  readonly capture: {
    readonly revision: number;
    readonly anchors: readonly Anchor[];
    readonly members: readonly string[];
  };
  readonly records: readonly {
    readonly revision: number;
    readonly head: string | null;
    readonly added: readonly string[];
    readonly removed: readonly string[];
  }[];
  /** The added ids the peer still holds at the end, as corpus names. */
  readonly held: readonly string[];
  readonly expect: {
    readonly touch: {
      readonly revision: number;
      readonly delta: string;
      readonly reason: TouchReason;
    } | null;
  };
};
export type StoreFreshnessDocument = VectorHeader & {
  readonly format: typeof STORE_FRESHNESS_FORMAT;
  readonly cases: readonly StoreFreshnessCase[];
  readonly touching: readonly StoreTouchingCase[];
};

/** Takes the position of a new snapshot of `peer` and follows the feed from it (README §10.2). */
export type FollowStep = {
  readonly op: "follow";
  readonly peer: string;
  /** The name later `pull` steps use for this follower. */
  readonly as: string;
  /** Added to the position's revision before following: a position from the future. */
  readonly ahead?: number;
  /** Follow with the history of this handle's peer instead: a position of another history. */
  readonly historyOf?: string;
  /** The revision of the snapshot, as a name. */
  readonly expect: { readonly revision: string };
};
/** Pulls until the follower stands at the peer's revision, or until `resync-required` (§10.3). */
export type PullStep = {
  readonly op: "pull";
  readonly follower: string;
  readonly expect:
    | {
        readonly status: "ok";
        /** The revision the follower stands at after the step: the peer's revision. */
        readonly position: string;
        /** The revisions of the records the pulls read, in order, as names. */
        readonly records: readonly string[];
        /** The ids the pulls delivered, as corpus names, ascending by id, each once. */
        readonly delivered: readonly string[];
        /** Ids the records add that the peer no longer holds: no bytes. The runner does not read it. */
        readonly absent: readonly string[];
        /** How many pulls the step takes. Only in a case whose `store` sets `changePageSize`. */
        readonly pulls?: number;
      }
    | { readonly status: "resync-required"; readonly current: string };
};
export type FollowCaseStep = StoreVectorStep | FollowStep | PullStep;
export type StoreFollowCase = {
  readonly name: string;
  readonly note: string;
  readonly spec: string;
  readonly requires?: readonly VectorRequirement[];
  /** Absent: the store of the run. Each field present replaces the run's. */
  readonly store?: {
    readonly changeRetention?: Exclude<ChangeRetention, "none">;
    readonly changePageSize?: number;
  };
  readonly steps: readonly FollowCaseStep[];
};
export type StoreFollowDocument = VectorHeader & {
  readonly format: typeof STORE_FOLLOW_FORMAT;
  readonly cases: readonly StoreFollowCase[];
};

export type StoreVectors = {
  readonly scripts: StoreScriptsDocument;
  readonly scope: StoreScopeDocument;
};

/**
 * S(A over D), SPEC-17 §4, computed by scanning `entries`. A host runs this over the small set
 * one read has fetched. The vectors' expected scopes are computed the same way over a peer's
 * whole holdings.
 */
export function scopeOver(
  entries: readonly VerifiedDelta[],
  entities: readonly string[],
): string[] {
  const wanted = new Set(entities);
  const members = new Set<string>();
  for (const { delta } of entries)
    if (
      delta.claims.pointers.some(
        (p) => p.target.kind === "entity" && wanted.has(p.target.entity.id),
      )
    )
      members.add(delta.id);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { delta } of entries) {
      if (members.has(delta.id)) continue;
      const negates = delta.claims.pointers.some(
        (p) =>
          p.role === "negates" && p.target.kind === "delta" && members.has(p.target.deltaRef.delta),
      );
      if (negates) {
        members.add(delta.id);
        grew = true;
      }
    }
  }
  return [...members].sort(compareUtf8);
}

/** Whether one held delta passes the named fields of a selection. */
export function passesSelection(
  entry: VerifiedDelta,
  selection: Pushdown,
  fields: readonly PushdownField[],
): boolean {
  for (const field of fields) {
    if (field === "timestampAtMost" && selection.timestampAtMost !== undefined) {
      if (entry.delta.claims.timestamp > selection.timestampAtMost) return false;
    } else if (field === "arrivalAtMost" && selection.arrivalAtMost !== undefined) {
      if (entry.arrival.sequence > selection.arrivalAtMost) return false;
    } else if (field === "excludeIds" && selection.excludeIds !== undefined) {
      if (selection.excludeIds.includes(entry.delta.id)) return false;
    }
  }
  return true;
}
