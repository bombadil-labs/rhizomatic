# Work order — the pluggable persistence tier

**Status: ✅ SHIPPED** (2026-06-15, branch `feature/persistence-tier`). The `Store` interface
([src/store-tier.ts](src/store-tier.ts)) is the seam; JSONL ([src/shared-store.ts](src/shared-store.ts))
and SQLite ([src/sqlite-store.ts](src/sqlite-store.ts)) are the two witnesses to it, both passing
one shared conformance harness ([test/chorus-store-conformance.test.ts](test/chorus-store-conformance.test.ts)).
Backend is env-selectable (`CHORUS_STORE_BACKEND`, default `jsonl`); migration is
[src/migrate.ts](src/migrate.ts) (`npm run chorus:migrate`); the indexed reverse-adjacency read is
[src/store-reads.ts](src/store-reads.ts). All five Definition-of-done points (§6) hold; the prose
below is the original work order, kept as the rationale of record.

**Layer:** app (Chorus) — TS-only, no vectors, no two-witness requirement (per the root
[CLAUDE.md](../../CLAUDE.md): nothing in `apps/` is normative). **Audience:** a fresh `/loop`
session. This document is self-contained — you do not have the conversation that produced it. Read
it top to bottom, then build.

---

## 1. Intention

Chorus persists to a **single append-only JSONL file** today
([`src/shared-store.ts`](src/shared-store.ts)). That was the right v0 — legible, zero-dependency,
git-diffable, and correct because the data model carries its own correctness (a grow-only set of
content-addressed, signed deltas; merge is union; any interleaving converges). It is also the
weak point:

- **Concurrency.** Correctness rides a **lock directory** (`mkdir`-atomic, stale-steal at 10 s).
  This has already produced a real incident — the `field-bug:post-hang` (a desktop session's
  write hung ~4 min and its delta never reached the log; suspects: lock contention during a
  concurrent restart, or compact-at-boot's tmp-then-rename racing an open Windows read handle).
  Federation and multi-surface use will only multiply concurrent writers.
- **Reads scan.** `recall`, `backlinks`, and `gql-prepare` walk the whole surviving set. Fine at
  personal scale; not at fleet scale.

**We are NOT replacing the JSONL.** It stays — the legible dev/audit/inspection tier, forever. The
goal is to make persistence **pluggable**: extract the seam (a `Store` interface), keep JSONL as
one conforming backend, and add a **SQLite** backend that solves concurrency + indexed reads. The
interface is the deliverable; the backends are interchangeable witnesses to it — the same posture
the repo takes toward the format itself.

## 2. The through-line (why the interface looks the way it does)

A grow-only signed delta log makes **persistence and federation the same shape**: durable append,
content-addressed dedup, and "give me the deltas since watermark X." That triple is the local
persistence primitive AND the remote sync primitive. So design the `Store` interface around it now
— the same interface federation v1 will reuse.

The north star (do **not** build it in this unit; just don't foreclose it) is in
[`spec/11-federation-as-query.NOTE.md`](../../spec/11-federation-as-query.NOTE.md): federation as
publish/subscribe over arbitrary **queries**, where what flows to a peer is exactly the _relevance
closure_ of a published query, and privacy is the default-deny property of what you publish. The
only concession this unit makes to that future: the read seam should be shaped so a later
`since(watermark, closure)` (closure-scoped reads) is an additive change, not a rewrite. SQLite's
indexes (by target entity, by role/value) are exactly what make closure-scoped reads efficient
later — so building them now does double duty.

## 3. Current shape (what you're refactoring)

[`src/shared-store.ts`](src/shared-store.ts) exposes `SharedStore`:

- `constructor(filePath)`
- `refresh(agent): number` — read lines appended since last look, ingest into the agent's reactor
  (host-aware), tolerate torn trailing lines, advance a byte offset + an `onDisk` id-set watermark.
- `persist(agent): number` — under the lock: `refresh` first (union), append the agent's deltas
  not yet on disk, sealing a torn tail if present.
- `wasteful(agent, slack=64): boolean` — parsed-line count exceeds distinct-delta count.
- `compact(agent): number` — atomic tmp-then-rename rewrite from the agent's full world.

Callers: [`src/mcp-server.ts`](src/mcp-server.ts) (the default path) and
[`src/mcp-http.ts`](src/mcp-http.ts) (one `SharedStore` per HTTP session — note this, it matters).
Tests: [`test/chorus-shared-store.test.ts`](test/chorus-shared-store.test.ts) (two-session
convergence, no duplicate lines, torn-line recovery, fresh-boot, the loud-lock-timeout test).

## 4. The interface to extract

Name it `Store` (in a new `src/store-tier.ts` or similar; keep the existing `src/store.ts`
pack helpers untouched — different concern). Shape it around the delta-level primitive so SQLite
can implement it natively, with the agent-sync ergonomics layered on top. A starting sketch (adapt
as the code wants — match the existing idiom, don't impose a new one):

```ts
export interface Store {
  // Pull everything durably stored that the agent's reactor does not yet hold. Returns count
  // accepted. Host-aware ingestion (so derived authors react), exactly as refresh does today.
  refresh(agent: ChorusAgent): number;

  // Durably append every delta the agent holds that the store does not. Concurrency-safe:
  // converge with any concurrent writers first (union), then add the difference. Returns count.
  persist(agent: ChorusAgent): number;

  // Maintenance: is a rewrite/vacuum worth doing, and do it. (JSONL: wasteful/compact.
  // SQLite: likely no-ops or VACUUM — the duplicate-accretion problem is a JSONL artifact.)
  wasteful?(agent: ChorusAgent): boolean;
  compact?(agent: ChorusAgent): number;
}
```

Underneath, both backends want the same lower primitive — keep it explicit so the conformance
test can drive it directly:

```ts
// Idempotent by delta id. The watermark is the set of stored ids (order-free, like onDisk today).
appendDeltas(deltas: Iterable<Delta>): number;     // count newly stored
deltasSince(knownIds: ReadonlySet<string>): Delta[]; // stored deltas whose id ∉ knownIds
```

`refresh`/`persist` become thin layers over `appendDeltas`/`deltasSince` + the agent's reactor.
(The JSONL backend keeps its byte-offset optimization internally; the interface speaks deltas.)

## 5. Plan (slices — checkpoint per slice on a feature branch, PR at the end)

1. **Extract the interface, no behavior change.** Define `Store`; make `SharedStore` implement it
   (rename to `JsonlStore` or keep `SharedStore` as the JSONL impl — your call, but the type the
   callers hold becomes `Store`). `mcp-server.ts` / `mcp-http.ts` depend on `Store`, constructed
   by a small factory. The existing shared-store tests pass **unchanged in intent** (adjust only
   construction if you rename). Commit.
2. **Shared conformance test.** Write `test/chorus-store-conformance.test.ts` that takes a
   `() => Store` factory and asserts the backend-agnostic contract: idempotent append, two-agent
   convergence to identical digests, `deltasSince` correctness, torn/partial resilience where
   applicable, fresh-boot from durable state. Run it against the JSONL backend. Commit.
3. **SQLite backend.** Add `better-sqlite3`. Implement `Store` over a table of deltas keyed by id
   (store the canonical claims JSON + sig; recompute/verify id on read via `makeDelta`, mirroring
   how `refresh` rehydrates today). Real transactional writes — the lock-directory dance goes away.
   Pass the SAME conformance test. Commit.
4. **Selection + migration.** `CHORUS_STORE_BACKEND=jsonl|sqlite` (default `jsonl`) chooses the
   backend in the factory; `CHORUS_STORE` stays the path (`.jsonl` or `.sqlite`). Add a one-shot
   migration (a tool script or a `migrate(jsonlPath, sqlitePath)` fn) that imports an existing
   `memory.jsonl` into a fresh SQLite store and asserts the agent's digest is identical before and
   after. Commit.
5. **Indexed reads.** Give the SQLite backend indexed `deltasByTarget(entityId)` /
   `deltasByValue(role, key)` reads (mirroring the reactor's `targetIndex` / `valueIndex`), and
   wire them where the hot scans are (the `gql-prepare` inbound-index build and/or `recall`
   relevance select are the candidates — pick the one with the clearest win). Prove it: a test
   seeds a large store and asserts the indexed read returns identical results to the scan, faster.
   This is also the seam the closure-scoped federation read will extend. Commit, open the PR.

## 6. Definition of done (the loop runs until ALL hold)

1. A `Store` interface exists; the JSONL store implements it; callers depend on the interface.
   The existing shared-store tests pass unmodified in intent.
2. A SQLite backend implements the same interface and passes the **same** shared conformance test
   as JSONL (convergence, idempotent append, `since` reads, resilience).
3. Backend is env-selectable (`CHORUS_STORE_BACKEND`, default `jsonl`); a lossless `memory.jsonl`
   → SQLite migration exists and is tested (identical digest after import).
4. The SQLite backend serves at least one **indexed** read backing a path that scans today
   (`recall` / `backlinks` / `gql-prepare`), with a test asserting identical-to-scan results.
5. `npm run check` is green (format + lint + typecheck + tests, 78+ and climbing); the MCP server
   boots on **either** backend and a smoke test drives `remember → recall` through each.

## 7. Constraints & non-goals

- **Keep JSONL.** It is a first-class tier, not a legacy path. Do not regress its legibility.
- **App-layer rules apply:** TS-only, no vectors, no Rust parity, no spec changes required. Work on
  a feature branch, PR to main, green gates before every commit (mirror how Slice Q / PR #1 landed).
- **Do NOT build federation, subscriptions, closure-scoped reads, or encryption here.** Leave the
  `since` seam shaped to accept a closure later; that's the only forward concession.
- **Don't over-engineer the backend.** SQLite via `better-sqlite3` (synchronous, embedded, one
  file) is the target — not a DB server, not an ORM, not async. One notch up from a flat file.
- **The CRDT is your safety net.** Content-addressed, order-independent, idempotent — lean on it;
  a backend that preserves "a set of deltas, dedup by id" is correct by construction.

## 8. Pointers

- Current store: [`src/shared-store.ts`](src/shared-store.ts) · its tests:
  [`test/chorus-shared-store.test.ts`](test/chorus-shared-store.test.ts)
- Callers: [`src/mcp-server.ts`](src/mcp-server.ts) · [`src/mcp-http.ts`](src/mcp-http.ts)
- The federation north star: [`spec/11-federation-as-query.NOTE.md`](../../spec/11-federation-as-query.NOTE.md)
- Storage spec (packs as the at-rest interchange form, complementary to a live store):
  [`spec/08-storage.md`](../../spec/08-storage.md)
- Working agreement: [root CLAUDE.md](../../CLAUDE.md) · [ts CLAUDE.md](../../implementations/ts/CLAUDE.md)
