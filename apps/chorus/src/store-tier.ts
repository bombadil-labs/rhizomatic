// The persistence seam. Chorus persists a grow-only set of content-addressed, signed deltas;
// correctness rides the CRDT (merge is union, any interleaving converges), so a backend is
// correct by construction as long as it preserves "a set of deltas, deduped by id." That makes
// persistence PLUGGABLE: the interface is the asset, the backends are interchangeable witnesses
// to it — the same posture the repo takes toward the format itself.
//
// The shape is deliberately the FEDERATION-SYNC shape (spec/11-federation-as-query.NOTE.md): a
// grow-only signed log makes durable persistence and remote sync the same primitive — append
// (idempotent by id) and "give me the deltas since a watermark." The one forward concession to
// closure-scoped federation reads is that `deltasSince` is shaped to grow a closure argument
// additively later, never a rewrite.
//
// Naming (spec/12 §3): this interface is the persistence BACKEND. The product-level unit a user
// calls a "store" — a named, keyed, federating instance — is `Store` (stores.ts), which wraps a
// `StoreBackend`. Interface renamed from `Store` → `StoreBackend` so the domain word is free.

import type { Delta } from "@bombadil/rhizomatic";
import type { ChorusAgent } from "./agent.js";
import { JsonlStore } from "./shared-store.js";
import { SqliteStore } from "./sqlite-store.js";

export interface StoreBackend {
  // --- the delta-level primitive: durable append + read-since-watermark ---------------------
  // Both halves are idempotent / order-free, exactly like the CRDT they persist. This pair is
  // the LOCAL persistence primitive and the REMOTE sync primitive at once; `refresh`/`persist`
  // are thin agent-aware layers over it.

  // Durably store every supplied delta the store does not already hold. Idempotent by id.
  // Returns the count newly stored.
  appendDeltas(deltas: Iterable<Delta>): number;

  // Every durably-stored delta whose id is NOT in `knownIds` — the watermark read. The watermark
  // is a set of ids (order-free), so a derived emission seen mid-sync is never skipped.
  deltasSince(knownIds: ReadonlySet<string>): Delta[];

  // --- agent-sync ergonomics -----------------------------------------------------------------

  // Pull everything durably stored that the agent's reactor does not yet hold, ingesting it
  // host-aware (so derived authors react). Returns the count accepted.
  refresh(agent: ChorusAgent): number;

  // Durably append every delta the agent holds that the store does not. Concurrency-safe:
  // converge with any concurrent writers first (union), then add the difference. Returns count.
  persist(agent: ChorusAgent): number;

  // --- indexed reads (optional; the SQLite tier's reason to exist) ---------------------------
  // Mirror the reactor's targetIndex / valueIndex without scanning the whole surviving set.
  // The same indexes a later closure-scoped federation read will lean on (spec/11 §4).

  // Stored deltas with a pointer targeting this entity id.
  deltasByTarget?(entityId: string): Delta[];
  // Stored deltas with a primitive pointer under `role` whose canonical key equals `valueKey`.
  deltasByValue?(role: string, valueKey: string): Delta[];

  // --- maintenance (a JSONL artifact; SQLite no-ops or VACUUMs) ------------------------------
  wasteful?(agent: ChorusAgent): boolean;
  compact?(agent: ChorusAgent): number;

  // Release any held resources (an open DB handle). JSONL holds none; SQLite closes its file.
  close?(): void;
}

// --- backend selection ------------------------------------------------------------------------

// JSONL is the default tier — legible, git-diffable, the one every collaborator can read.
// SQLite is opt-in via CHORUS_STORE_BACKEND for concurrency + indexed reads.
export type BackendKind = "jsonl" | "sqlite";

const BACKENDS: readonly BackendKind[] = ["jsonl", "sqlite"];

export function backendFromEnv(env: NodeJS.ProcessEnv = process.env): BackendKind {
  const raw = (env["CHORUS_STORE_BACKEND"] ?? "jsonl").toLowerCase();
  if ((BACKENDS as readonly string[]).includes(raw)) return raw as BackendKind;
  throw new Error(
    `CHORUS_STORE_BACKEND="${raw}" is not a known backend (expected: ${BACKENDS.join(" | ")})`,
  );
}

// Construct the durable persistence backend for a path. Callers depend on the `StoreBackend`
// interface, never on a concrete backend — the seam the whole tier exists to provide.
export function createBackend(path: string, kind: BackendKind = backendFromEnv()): StoreBackend {
  switch (kind) {
    case "jsonl":
      return new JsonlStore(path);
    case "sqlite":
      return new SqliteStore(path);
  }
}
