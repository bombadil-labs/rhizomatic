// Opening a store by URL (SPEC-18 proposal §4.10). A connection string can carry credentials,
// so nothing here logs it, and every error names the scheme only.

import { createMemoryStore } from "./memory-store.js";
import { missingRequirements, StoreError, type Store, type StoreRequirement } from "./store.js";

export type OpenOptions = {
  /** Capabilities the host needs. Open refuses, naming each one the store lacks. */
  readonly requires?: readonly StoreRequirement[];
};

/** Builds a store from its URL. It must not put the URL in any error it throws. */
export type StoreFactory = (url: string, options: OpenOptions) => Promise<Store>;

const SCHEME = /^([a-z][a-z0-9+.-]*):/;

const schemes = new Map<string, StoreFactory>([
  [
    "memory",
    async (url) => {
      if (url !== "memory:")
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
export function registerStoreScheme(scheme: string, factory: StoreFactory): () => void {
  if (!SCHEME.test(`${scheme}:`) || scheme.includes(":"))
    throw new StoreError("invalid-url", "a store scheme is lowercase letters, digits, +, . or -");
  if (schemes.has(scheme))
    throw new StoreError("scheme-exists", `store scheme "${scheme}" is already registered`);
  schemes.set(scheme, factory);
  return () => {
    if (schemes.get(scheme) === factory) schemes.delete(scheme);
  };
}

export async function openStore(url: string, options: OpenOptions = {}): Promise<Store> {
  const scheme = typeof url === "string" ? SCHEME.exec(url)?.[1] : undefined;
  if (scheme === undefined)
    throw new StoreError("invalid-url", "a store URL starts with a scheme, as in memory:");
  const factory = schemes.get(scheme);
  if (factory === undefined)
    throw new StoreError("unknown-scheme", `no store is registered for scheme "${scheme}"`);
  let store: Store;
  try {
    store = await factory(url, options);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    // A driver's own error text may quote the connection string. It stops here.
    throw new StoreError("open-failed", `store scheme "${scheme}": the store did not open`);
  }
  const missing = missingRequirements(store.profile, options.requires ?? []);
  if (missing.length > 0) {
    await store.close();
    throw new StoreError(
      "capability-absent",
      `store scheme "${scheme}" lacks required capabilities: ${missing.join(", ")}`,
    );
  }
  return store;
}
