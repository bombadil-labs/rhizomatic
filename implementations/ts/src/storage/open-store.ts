// Opening a store by URL (SPEC-18 proposal §4.10). A connection string can carry credentials,
// so nothing here logs it, and every error names the scheme only.

import { isPlainObject, ownFields } from "./copy.js";
import { createMemoryStore } from "./memory-store.js";
import {
  missingRequirements,
  StoreError,
  type Store,
  type StoreProfile,
  type StoreRequirement,
} from "./store.js";

export type OpenOptions = {
  /** Capabilities the host needs. Open refuses, naming each one the store lacks. */
  readonly requires?: readonly StoreRequirement[];
  /**
   * The store's files were restored from a backup since its last open. A durable store then gives
   * every peer a new history, once, at this open (§4.6, "History"). Pass it on the first open
   * after a restore only: each open with it gives new histories again.
   */
  readonly restored?: boolean;
};

/**
 * Builds a store from its URL. It must not put the URL in any error it throws. `options` are the
 * caller's, read once and checked: `requires` is a list and `restored` a boolean. A store
 * without files to restore (the memory store) ignores `restored`. A factory that can change its
 * files at open (create them, or give peers new histories) refuses with `refuseMissing` before
 * the first change (§4.13 reading 126); `openStore` checks the opened profile again.
 */
export type StoreFactory = (url: string, options: OpenOptions) => Promise<Store>;

// RFC 3986 §3.1. A scheme is case-insensitive; lookups use its lowercase form.
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
// One text for every unrouted URL; it names the built-in scheme that a host most often forgets.
const UNKNOWN =
  "no store is registered for this URL's scheme. The sqlite scheme is registered when the host imports @bombadil/rhizomatic/store/sqlite";
const OPTIONS =
  "openStore: the options must be an object, requires a list of names, and restored a boolean";

const schemes = new Map<string, StoreFactory>([
  [
    "memory",
    async (url) => {
      if (url.length !== "memory:".length)
        throw new StoreError(
          "invalid-url",
          'store scheme "memory" takes no address: use "memory:"',
        );
      return createMemoryStore();
    },
  ],
]);

/**
 * Adds a consumer's store implementation under a URL scheme. Returns a function that removes
 * it. A scheme can have one factory; the built-in schemes cannot be replaced.
 */
export function registerStoreScheme(name: string, factory: StoreFactory): () => void {
  if (typeof name !== "string" || SCHEME.exec(`${name}:`)?.[1] !== name)
    throw new StoreError(
      "invalid-url",
      "a store scheme is a letter, then letters, digits, +, . or -",
    );
  const scheme = name.toLowerCase();
  if (schemes.has(scheme))
    throw new StoreError("scheme-exists", `store scheme "${scheme}" is already registered`);
  schemes.set(scheme, factory);
  return () => {
    if (schemes.get(scheme) === factory) schemes.delete(scheme);
  };
}

/**
 * The caller's options, read once into values this module owns. Absent options and an absent
 * `requires` mean none. Refuses `invalid-request` for anything else that is not of its type.
 */
function takeOptions(options: unknown): OpenOptions {
  if (options === undefined) return Object.freeze({ requires: Object.freeze([]), restored: false });
  try {
    if (!isPlainObject(options)) throw new TypeError("options");
    const { requires, restored } = ownFields<Record<string, unknown>>(options);
    if (restored !== undefined && typeof restored !== "boolean") throw new TypeError("restored");
    const own: StoreRequirement[] = [];
    if (requires !== undefined) {
      if (!Array.isArray(requires)) throw new TypeError("requires");
      for (let i = 0; i < requires.length; i++) {
        const name: unknown = requires[i];
        if (typeof name !== "string") throw new TypeError("a requirement");
        own.push(name as StoreRequirement);
      }
    }
    return Object.freeze({ requires: Object.freeze(own), restored: restored === true });
  } catch {
    throw new StoreError("invalid-request", OPTIONS);
  }
}

/**
 * Refuses `capability-absent`, naming each requirement the profile does not meet, and
 * `invalid-request` for a name that is not a requirement. Not part of the package surface.
 */
export function refuseMissing(
  scheme: string,
  profile: StoreProfile,
  requires: readonly StoreRequirement[],
): void {
  const missing = missingRequirements(profile, requires);
  if (missing.length > 0)
    throw new StoreError(
      "capability-absent",
      `store scheme "${scheme}" lacks required capabilities: ${missing.join(", ")}`,
    );
}

export async function openStore(url: string, options?: OpenOptions): Promise<Store> {
  // The shape of the call comes first, as in append.
  const own = takeOptions(options);
  const scheme = typeof url === "string" ? SCHEME.exec(url)?.[1]?.toLowerCase() : undefined;
  const factory = scheme === undefined ? undefined : schemes.get(scheme);
  // One fixed message whether the text has no scheme or an unregistered one. What stands before
  // the first colon of a malformed connection string can be a user name or a password.
  if (scheme === undefined || factory === undefined)
    throw new StoreError("unknown-scheme", UNKNOWN);
  let store: Store;
  try {
    store = await factory(url, own);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    // A driver's own error text may quote the connection string. It stops here.
    throw new StoreError("open-failed", `store scheme "${scheme}": the store did not open`);
  }
  try {
    refuseMissing(scheme, store.profile, own.requires ?? []);
  } catch (error) {
    // A failing close must not replace this refusal with a driver's own text.
    await store.close().catch(() => undefined);
    throw error;
  }
  return store;
}
