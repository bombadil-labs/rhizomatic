// SPEC-16 MR-15: the atomic complete-image control store seam. Initialize, read and
// compare-and-set over opaque canonical bytes. No semantic installation, source authority or
// second journal lives here; adapters report exactly the four CAS outcomes.
export type MaterializationControlInitialize =
  | { readonly status: "initialized"; readonly bytes: Uint8Array }
  | { readonly status: "existing"; readonly bytes: Uint8Array; readonly revision: string };
export type MaterializationControlRead =
  | { readonly status: "image"; readonly bytes: Uint8Array; readonly revision: string }
  | { readonly status: "unavailable"; readonly fault: string };
export type MaterializationControlWrite =
  | { readonly status: "durable"; readonly revision: string }
  | { readonly status: "conflict" }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "committed-unconfirmed"; readonly fault: string };
/**
 * One complete metadata image per (receiver, configuration). `revision` is the external name
 * the host assigns to stored bytes; the empty generation-0 image is named by the empty text.
 * An adapter MUST store the whole image atomically or report `committed-unconfirmed`.
 */
export interface MaterializationControlStore {
  /** Returns the existing exact image, or durably stores `emptyBytes` when nothing exists. */
  initialize(
    receiver: string,
    configuration: string,
    emptyBytes: Uint8Array,
  ): Promise<MaterializationControlInitialize>;
  /** One consistent complete image with its revision, or unavailable. */
  read(receiver: string, configuration: string): Promise<MaterializationControlRead>;
  /** Atomically replaces the image iff the stored revision equals `expectedRevision`. */
  compareAndSet(
    receiver: string,
    configuration: string,
    expectedRevision: string,
    bytes: Uint8Array,
    revision: string,
  ): Promise<MaterializationControlWrite>;
}
