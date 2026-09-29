// Typed, permanent-posture single-peer admission over a host-supplied atomic image store.
import type { Delta } from "../delta/types.js";
import { DeltaSet } from "../delta/set.js";
import { claimsToJson, parseClaims } from "../delta/json-profile.js";
import {
  decodeDurablePeerState,
  emptyDurablePeerState,
  encodeDurablePeerState,
  type DurablePeerState,
} from "./durable-state.js";
import { isCanonicalPeerId } from "./peer-identity.js";
import type { CandidateGuard } from "./preflight.js";
import {
  planSignedLooseOrdinaryTransferFromVerified,
  type SignedLooseOutcome,
} from "./signed-loose-admission.js";

export type ArrivalOrigin =
  | { readonly kind: "local" }
  | { readonly kind: "authenticated-peer"; readonly peerId: string }
  | { readonly kind: "unattributed" };

export type PeerImageWrite =
  | { readonly status: "durable" }
  | { readonly status: "committed-unconfirmed"; readonly fault: string }
  | { readonly status: "conflict" };

export type PeerImageRead =
  | { readonly status: "empty" }
  | { readonly status: "image"; readonly image: Uint8Array }
  | { readonly status: "rows-without-image" };

/**
 * The adapter reports rows without an image instead of treating them as an empty peer. It
 * atomically compares the exact prior bytes and persists the next image together with newly
 * admitted delta rows. Empty-peer creation must also verify that no rows already exist.
 * `durable` means all of that survives restart. A conflict has no effect; an uncertain commit
 * requires recovery before retrying.
 */
export interface DurablePeerStore {
  readImage(peerId: string): Promise<PeerImageRead>;
  compareAndSet(
    peerId: string,
    expectedPrior: Uint8Array | null,
    nextImage: Uint8Array,
    newlyAdmitted: readonly Delta[],
  ): Promise<PeerImageWrite>;
}

interface VerifiedImage {
  readonly peerId: string;
  readonly image: Uint8Array;
  readonly state: DurablePeerState;
}

const verifiedImages = new WeakMap<DurablePeerStore, VerifiedImage>();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function copyState(state: DurablePeerState, cloneDeltas: boolean): DurablePeerState {
  return {
    ...state,
    base: {
      ...state.base,
      admitted: cloneDeltas
        ? DeltaSet.from([...state.base.admitted].map((delta) => structuredClone(delta)))
        : state.base.admitted.copy(),
      cursor: { ...state.base.cursor },
      arrivals: state.base.arrivals.map((row) => ({ ...row })),
      refusedIds: new Set(state.base.refusedIds),
    },
    events: state.events.map((row) => ({ ...row, orderIds: [...row.orderIds] })),
    exclusions: state.exclusions.map((row) => ({ ...row })),
    obligations: state.obligations.map((row) => ({ ...row })),
  };
}

function rememberImage(
  store: DurablePeerStore,
  peerId: string,
  image: Uint8Array,
  state: DurablePeerState,
): void {
  verifiedImages.set(store, {
    peerId,
    image: Uint8Array.from(image),
    state: copyState(state, false),
  });
}

function verifiedState(
  store: DurablePeerStore,
  peerId: string,
  image: Uint8Array,
): DurablePeerState {
  const cached = verifiedImages.get(store);
  if (cached?.peerId === peerId && sameBytes(cached.image, image)) return cached.state;
  const state = decodeDurablePeerState(image, peerId);
  rememberImage(store, peerId, image, state);
  return verifiedImages.get(store)!.state;
}

export type OpenSinglePeerResult =
  | { readonly status: "open"; readonly state: DurablePeerState; readonly image: Uint8Array }
  | { readonly status: "conflict" }
  | { readonly status: "rows-without-image" }
  | { readonly status: "committed-unconfirmed"; readonly fault: string };

export function assertCanonicalPeerId(peerId: string): void {
  if (!isCanonicalPeerId(peerId)) throw new Error("single peer: invalid canonical peer id");
}

/** Open an existing image, or CAS one empty image into a fresh store. */
export async function openSinglePeer(
  store: DurablePeerStore,
  peerId: string,
): Promise<OpenSinglePeerResult> {
  assertCanonicalPeerId(peerId);
  const current = await store.readImage(peerId);
  if (current.status === "rows-without-image") {
    verifiedImages.delete(store);
    return current;
  }
  if (current.status === "image")
    return {
      status: "open",
      state: copyState(verifiedState(store, peerId, current.image), true),
      image: current.image,
    };
  verifiedImages.delete(store);
  const state = emptyDurablePeerState(peerId);
  const image = encodeDurablePeerState(state);
  const write = await store.compareAndSet(peerId, null, image, []);
  if (write.status === "conflict") return { status: "conflict" };
  if (write.status === "committed-unconfirmed") return write;
  rememberImage(store, peerId, image, state);
  return { status: "open", state: copyState(state, true), image };
}

export interface SinglePeerTransferInput<State> {
  readonly offered: readonly Delta[];
  readonly origin: ArrivalOrigin;
  readonly arrivedAt: number;
  readonly policyState: Readonly<State>;
  readonly guards: readonly CandidateGuard<State>[];
  readonly isErasureCandidate: (delta: Delta) => boolean;
  /** `atomic` refuses the whole local append if any candidate fails. */
  readonly mode: "atomic" | "individual";
  /** Ordinary new-id count capacity; use MAX_SAFE_INTEGER for an application-owned quota. */
  readonly capacity?: number;
}

export type SinglePeerTransferResult =
  | {
      readonly status: "committed";
      readonly outcomes: readonly SignedLooseOutcome[];
      readonly state: DurablePeerState;
      readonly image: Uint8Array;
    }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly outcomes: readonly SignedLooseOutcome[];
    }
  | { readonly status: "conflict" }
  | { readonly status: "committed-unconfirmed"; readonly fault: string };

function sender(origin: ArrivalOrigin, receivingPeerId: string): string {
  if (origin.kind === "local") return "local";
  if (origin.kind === "unattributed") return "unattributed";
  assertCanonicalPeerId(origin.peerId);
  if (origin.peerId === receivingPeerId)
    throw new Error("single peer: authenticated sender is receiving peer");
  return origin.peerId;
}

function plainDelta(delta: Delta): Delta {
  return {
    id: delta.id,
    claims: parseClaims(claimsToJson(delta.claims)),
    ...(delta.sig === undefined ? {} : { sig: delta.sig }),
  };
}

/** Plan against exact prior bytes; CAS image and admitted rows as one backend transaction. */
export async function admitSinglePeerTransfer<State>(
  store: DurablePeerStore,
  peerId: string,
  input: SinglePeerTransferInput<State>,
): Promise<SinglePeerTransferResult> {
  assertCanonicalPeerId(peerId);
  const prior = await store.readImage(peerId);
  if (prior.status !== "image") {
    verifiedImages.delete(store);
    throw new Error("single peer: peer is not open");
  }
  const before = verifiedState(store, peerId, prior.image);
  const plan = planSignedLooseOrdinaryTransferFromVerified(before, {
    offered: input.offered,
    sendingPeerId: sender(input.origin, peerId),
    arrivedAt: input.arrivedAt,
    capacity: input.capacity ?? Number.MAX_SAFE_INTEGER,
    policyState: input.policyState,
    guards: input.guards,
    isErasureCandidate: input.isErasureCandidate,
  });
  if (input.mode === "atomic") {
    const failed = plan.outcomes.find(
      (outcome) => !["admitted", "duplicate"].includes(outcome.status),
    );
    if (failed !== undefined)
      return {
        status: "rejected",
        reason: failed.reason ?? failed.status,
        outcomes: plan.outcomes,
      };
  }
  if (plan.admittedIds.length === 0)
    return {
      status: "committed",
      outcomes: plan.outcomes,
      state: copyState(before, true),
      image: prior.image,
    };
  const next = encodeDurablePeerState(plan.state);
  const admitted = plan.admittedIds.map((id) => plainDelta(plan.state.base.admitted.get(id)!));
  const write = await store.compareAndSet(peerId, prior.image, next, admitted);
  if (write.status !== "durable") {
    verifiedImages.delete(store);
    return write;
  }
  rememberImage(store, peerId, next, plan.state);
  return {
    status: "committed",
    outcomes: plan.outcomes,
    state: copyState(plan.state, true),
    image: next,
  };
}
