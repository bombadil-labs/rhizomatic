// Node-only single-writer adapter for the typed peer storage seam.
import { existsSync, readFileSync } from "node:fs";
import type { Delta } from "../delta/types.js";
import { decodeDurablePeerState } from "./durable-state.js";
import { writeDurablePeerState } from "./file-durable-state.js";
import {
  assertCanonicalPeerId,
  type DurablePeerStore,
  type PeerImageRead,
  type PeerImageWrite,
} from "./single-peer.js";

/** Single-writer file adapter. Multi-writer stores must supply an atomic backend CAS. */
export class FileDurablePeerStore implements DurablePeerStore {
  constructor(
    readonly path: string,
    readonly peerId: string,
  ) {
    assertCanonicalPeerId(peerId);
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
