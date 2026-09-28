// Typed, permanent-posture single-peer admission over a host-supplied atomic image store.
import { existsSync, readFileSync } from "node:fs";
import type { Delta } from "../delta/types.js";
import {
  decodeDurablePeerState,
  emptyDurablePeerState,
  encodeDurablePeerState,
  writeDurablePeerState,
  type DurablePeerState,
} from "./durable-state.js";
import { isCanonicalPeerId } from "./peer-identity.js";
import type { CandidateGuard } from "./preflight.js";
import {
  planSignedLooseOrdinaryTransfer,
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

export type OpenSinglePeerResult =
  | { readonly status: "open"; readonly state: DurablePeerState; readonly image: Uint8Array }
  | { readonly status: "conflict" }
  | { readonly status: "rows-without-image" }
  | { readonly status: "committed-unconfirmed"; readonly fault: string };

function canonicalPeerId(peerId: string): void {
  if (!isCanonicalPeerId(peerId)) throw new Error("single peer: invalid canonical peer id");
}

/** Open an existing image, or CAS one empty image into a fresh store. */
export async function openSinglePeer(
  store: DurablePeerStore,
  peerId: string,
): Promise<OpenSinglePeerResult> {
  canonicalPeerId(peerId);
  const current = await store.readImage(peerId);
  if (current.status === "rows-without-image") return current;
  if (current.status === "image")
    return {
      status: "open",
      state: decodeDurablePeerState(current.image, peerId),
      image: current.image,
    };
  const state = emptyDurablePeerState(peerId);
  const image = encodeDurablePeerState(state);
  const write = await store.compareAndSet(peerId, null, image, []);
  if (write.status === "conflict") return { status: "conflict" };
  if (write.status === "committed-unconfirmed") return write;
  return { status: "open", state, image };
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

function sender(origin: ArrivalOrigin): string {
  if (origin.kind === "local") return "local";
  if (origin.kind === "unattributed") return "unattributed";
  canonicalPeerId(origin.peerId);
  return origin.peerId;
}

/** Plan against exact prior bytes; CAS image and admitted rows as one backend transaction. */
export async function admitSinglePeerTransfer<State>(
  store: DurablePeerStore,
  peerId: string,
  input: SinglePeerTransferInput<State>,
): Promise<SinglePeerTransferResult> {
  canonicalPeerId(peerId);
  const prior = await store.readImage(peerId);
  if (prior.status !== "image") throw new Error("single peer: peer is not open");
  const before = decodeDurablePeerState(prior.image, peerId);
  const plan = planSignedLooseOrdinaryTransfer(before, {
    offered: input.offered,
    sendingPeerId: sender(input.origin),
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
  const next = encodeDurablePeerState(plan.state);
  const admitted = plan.admittedIds.map((id) => plan.state.base.admitted.get(id)!);
  const write = await store.compareAndSet(peerId, prior.image, next, admitted);
  if (write.status !== "durable") return write;
  return { status: "committed", outcomes: plan.outcomes, state: plan.state, image: next };
}

/** Single-writer file adapter. Multi-writer stores must supply an atomic backend CAS. */
export class FileDurablePeerStore implements DurablePeerStore {
  constructor(
    readonly path: string,
    readonly peerId: string,
  ) {
    canonicalPeerId(peerId);
  }

  readImage(peerId: string): Promise<PeerImageRead> {
    if (peerId !== this.peerId) throw new Error("single peer: wrong file peer id");
    return Promise.resolve(
      existsSync(this.path)
        ? { status: "image", image: readFileSync(this.path) }
        : { status: "empty" },
    );
  }

  compareAndSet(
    peerId: string,
    expectedPrior: Uint8Array | null,
    nextImage: Uint8Array,
    _newlyAdmitted: readonly Delta[],
  ): Promise<PeerImageWrite> {
    void _newlyAdmitted; // The image itself holds all admitted delta bytes in the file adapter.
    if (peerId !== this.peerId) throw new Error("single peer: wrong file peer id");
    const state = decodeDurablePeerState(nextImage, peerId);
    try {
      return Promise.resolve(writeDurablePeerState(this.path, state, expectedPrior));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "durable peer state: expected prior image changed"
      )
        return Promise.resolve({ status: "conflict" });
      throw error;
    }
  }
}
