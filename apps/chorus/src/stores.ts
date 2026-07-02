// The product-level unit spec/12 §1 calls a "store": a NAMED, KEYED, federating instance — distinct
// from the persistence `StoreBackend` (store-tier.ts) it wraps. The single flat file never had the
// two things this gives a store: an IDENTITY keypair and a place in a REGISTRY. Later phases hang
// the private tier (encrypted backend), aggregation (subscribed peers), and federation (published
// queries) on this first-class thing; slice 2 (Phase A) establishes only identity + registry.
//
// A store's identity is a labeled child of the master seed (the identity.ts scheme): the master
// holder can re-derive and audit any store's key, and nobody else can forge one. A store is an
// AUTHOR too — its origin annotations and, later, its offered-lens signature are signed by this
// key — so StoreId is the same `ed25519:<pubkey>` author string a session or the user carries
// (spec/12 §2: author = who signs; a store signs as itself).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeltaSet, authorForSeed } from "@rhizomes/rhizomatic";
import { deriveSeed } from "./identity.js";
import {
  backendFromEnv,
  createBackend,
  type BackendKind,
  type StoreBackend,
} from "./store-tier.js";

// Two exposure postures (spec/12 §4). A `private` store publishes no lens — default-deny means it
// never federates — and (Phase B) is encrypted at rest. A `federated` store MAY publish queries.
export type StoreTier = "private" | "federated";

// A store's identity seed: deriveSeed(master, "store/<name>"). Deterministic, so opening the same
// name twice — or a fresh clone carrying the same master seed — yields the identical StoreId.
export const storeSeed = (masterSeedHex: string, name: string): string =>
  deriveSeed(masterSeedHex, `store/${name}`);

export interface StoreManifest {
  readonly name: string;
  readonly id: string; // StoreId = authorForSeed(storeSeed) — "ed25519:<pubkey>"
  readonly tier: StoreTier;
  readonly backend: BackendKind;
  readonly createdAt: number;
}

export interface AdoptResult {
  readonly store: Store;
  readonly deltas: number; // distinct deltas newly copied into the store
  readonly digest: string; // canonical digest, identical in source and adopted store
}

const MANIFEST = "store.json";
const BACKEND_FILE: Record<BackendKind, string> = {
  jsonl: "memory.jsonl",
  sqlite: "memory.sqlite",
};

// A named, keyed store: its identity plus the persistence backend it wraps. Constructed through a
// StoreRegistry, which owns the on-disk layout; construct directly only in tests.
export class Store {
  readonly name: string;
  readonly id: string;
  readonly seedHex: string;
  readonly tier: StoreTier;
  readonly backend: StoreBackend;

  constructor(opts: { manifest: StoreManifest; seedHex: string; backend: StoreBackend }) {
    this.name = opts.manifest.name;
    this.id = opts.manifest.id;
    this.tier = opts.manifest.tier;
    this.seedHex = opts.seedHex;
    this.backend = opts.backend;
  }

  close(): void {
    this.backend.close?.();
  }
}

// The registry: discovers and opens named stores under a root (default ~/.chorus/stores). Each
// store is a subdirectory holding a manifest (identity + tier + backend kind) and a backend file.
export class StoreRegistry {
  private readonly root: string;
  private readonly masterSeedHex: string;
  private readonly clock: () => number;

  constructor(root: string, masterSeedHex: string, clock: () => number = () => Date.now()) {
    this.root = root;
    this.masterSeedHex = masterSeedHex;
    this.clock = clock;
  }

  private dirOf(name: string): string {
    return join(this.root, name);
  }

  // Every store the registry can see, by manifest, sorted by name.
  list(): StoreManifest[] {
    if (!existsSync(this.root)) return [];
    const out: StoreManifest[] = [];
    for (const name of readdirSync(this.root)) {
      const manifestPath = join(this.dirOf(name), MANIFEST);
      if (existsSync(manifestPath)) {
        out.push(JSON.parse(readFileSync(manifestPath, "utf8")) as StoreManifest);
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // Open a store by name, creating its directory + manifest on first use. Identity is a pure
  // function of (master seed, name), so a re-open never re-mints; on an existing manifest we VERIFY
  // the stored id matches the derived one, so a wrong master seed or a tampered manifest fails
  // loudly rather than silently mis-signing.
  open(name: string, opts: { tier?: StoreTier; backend?: BackendKind } = {}): Store {
    const dir = this.dirOf(name);
    mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, MANIFEST);
    const seedHex = storeSeed(this.masterSeedHex, name);
    const id = authorForSeed(seedHex);

    let manifest: StoreManifest;
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as StoreManifest;
      if (manifest.id !== id) {
        throw new Error(
          `store "${name}": manifest id ${manifest.id} does not match the id derived from the ` +
            `master seed (${id}) — wrong CHORUS_MASTER_SEED, or a tampered manifest.`,
        );
      }
    } else {
      manifest = {
        name,
        id,
        tier: opts.tier ?? "federated",
        backend: opts.backend ?? backendFromEnv(),
        createdAt: this.clock(),
      };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    const backend = createBackend(join(dir, BACKEND_FILE[manifest.backend]), manifest.backend);
    return new Store({ manifest, seedHex, backend });
  }

  // Adopt an existing store's deltas into a named registry store, NON-DESTRUCTIVELY and LOSSLESSLY.
  // The source backend is only READ; nothing about it changes. Because every delta is
  // content-addressed, "lossless" is an exact claim, not a hope: the adopted store's canonical
  // digest MUST equal the source's, or adoption refuses (it will not claim a success it can't
  // prove). Idempotent by delta id, so re-adopting the same source is a no-op union. This is how
  // the pre-registry ~/.chorus/memory.sqlite becomes the store named "personal" — not one delta
  // rewritten, no id changed (spec/12 §2 + CONSTELLATION.md §7).
  adopt(
    name: string,
    source: StoreBackend,
    opts: { tier?: StoreTier; backend?: BackendKind } = {},
  ): AdoptResult {
    const store = this.open(name, opts);

    // Read the source's FULL set (deltasSince(∅) is cursor-independent, so an already-used source
    // handle is fine) and fingerprint it before copying.
    const all = source.deltasSince(new Set());
    const before = DeltaSet.from(all).digest();
    const added = store.backend.appendDeltas(all);

    // Verify losslessly: the store's full set must fingerprint identically. DeltaSet.digest is a
    // pure function of the (content-addressed) ids, so this is the exact "no delta lost, none
    // altered" claim — not an approximation.
    const after = DeltaSet.from(store.backend.deltasSince(new Set())).digest();
    if (after !== before) {
      throw new Error(`adopting "${name}" changed the delta set: ${before} -> ${after}`);
    }
    return { store, deltas: added, digest: after };
  }
}
