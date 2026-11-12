// Opening a store by URL (SPEC-18 proposal §4.10). A connection string can carry credentials,
// so nothing here logs it, and every error names the scheme only.

import { isPlainObject } from "./copy.js";
import { createMemoryStore } from "./memory-store.js";
import { missingRequirements, StoreError, type Store, type StoreRequirement } from "./store.js";

export type OpenOptions = {
  /** Capabilities the host needs. Open refuses, naming each one the store lacks. */
  readonly requires?: readonly StoreRequirement[];
};

/** Builds a store from its URL. It must not put the URL in any error it throws. */
export type StoreFactory = (url: string, options: OpenOptions) => Promise<Store>;

// RFC 3986 §3.1. A scheme is case-insensitive; lookups use its lowercase form.
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const UNKNOWN = "no store is registered for this URL's scheme";
const OPTIONS = "openStore: the options must be an object, and requires a list of names";

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
  if (options === undefined) return Object.freeze({ requires: Object.freeze([]) });
  try {
    if (!isPlainObject(options)) throw new TypeError("options");
    const requires: unknown = options["requires"];
    if (requires === undefined) return Object.freeze({ requires: Object.freeze([]) });
    if (!Array.isArray(requires)) throw new TypeError("requires");
    const own: StoreRequirement[] = [];
    for (let i = 0; i < requires.length; i++) {
      const name: unknown = requires[i];
      if (typeof name !== "string") throw new TypeError("a requirement");
      own.push(name as StoreRequirement);
    }
    return Object.freeze({ requires: Object.freeze(own) });
  } catch {
    throw new StoreError("invalid-request", OPTIONS);
  }
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
  let missing: readonly string[];
  try {
    missing = missingRequirements(store.profile, own.requires ?? []);
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
  if (missing.length > 0) {
    // A failing close must not replace this refusal with a driver's own text.
    await store.close().catch(() => undefined);
    throw new StoreError(
      "capability-absent",
      `store scheme "${scheme}" lacks required capabilities: ${missing.join(", ")}`,
    );
  }
  return store;
}
