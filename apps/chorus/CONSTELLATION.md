# Work order — the constellation (multi-store, private-by-key, federating)

**Status: 🚧 IN PROGRESS** (2026-07-01, branch `feature/constellation-store-identity`). **Phase A is
landing** (identity + registry + the rename + non-destructive adoption — all green). This is the plan
to carry Chorus from _one shared store_ to a **constellation of named, keyed stores** that specialize,
aggregate, federate, and — where you want it — stay private and leak-proof. It supersedes the
standalone "federation v1" line item in PROGRESS.md by situating federation inside the larger shape
the user asked for. The substrate model
is [spec/12-instances-provenance-privacy.NOTE.md](../../spec/12-instances-provenance-privacy.NOTE.md)
(read it first) and its companion [spec/11-federation-as-query.NOTE.md](../../spec/11-federation-as-query.NOTE.md).

**Layer:** app (Chorus) — TS-only, no vectors, no two-witness requirement (root
[CLAUDE.md](../../CLAUDE.md): nothing in `apps/` is normative). **Audience:** a fresh `/loop`
session per phase. Each phase is self-contained and shippable behind its own feature branch + PR,
green gates before every commit, exactly as PR #1 (gql) and PR #2 (persistence) landed.

---

## 1. Intention

Today there is **one** store: `~/.chorus/memory.sqlite`, served by one manual HTTP node, written by
every session. It has become a real personal knowledge graph — media, synchronicities, project
lineage, identity work. The user's vision has four moving parts, all expressible as _federating
instances composed by queries_ (spec/12 §1):

1. **Named, keyed stores** — a delta is associated with the store that created/holds it; stores are
   first-class, addressable things, not one flat file.
2. **Specialize + aggregate** — a media-log store, a synchronicity store, and an **aggregator** that
   ingests both and exposes everything via gql-on-demand over MCP. On one machine or across many.
3. **Private and leak-proof** — a store for the personal material that **never federates by default**
   and is **encrypted to the owner's key**, so a leaked file is ciphertext, not a diary.
4. **Friends** — others clone the repo, run their own stores, and federate into a collective rhizome,
   **with intentional control of what is shared with whom** — the real goal.

The reassuring fact underneath all of it: because every delta is a **content-addressed, grow-only,
signed fact**, none of this loses data. Splitting one store into several, or changing a store's form,
is _re-filing the same deltas into new containers_ — ids are stable, union is idempotent, digests are
verifiable. The migration (§7) is safe by construction.

## 2. The through-line (what already exists — build on it, don't reinvent)

Almost every mechanism is already in the repo; the work is composition and ergonomics, not invention:

- **A store is a peer.** [`implementations/ts/src/peer.ts`](../../implementations/ts/src/peer.ts)
  already implements `Peer` = keypair + reactor + **offered lens** + **admission** predicate, with
  `pullFrom(other)` doing signature-boundary partitioning (bundles / loose / withheld) and admission.
  Federation between two stores is `Peer.pullFrom`, over HTTP
  ([`src/http.ts`](../../implementations/ts/src/http.ts): `POST /rhz/v0/sync`, ids recomputed on the
  wire) or in-process.
- **Persistence is already a seam.** [`src/store-tier.ts`](src/store-tier.ts) `Store` interface
  (`appendDeltas` / `deltasSince` / `refresh` / `persist` + optional `deltasByTarget` /
  `deltasByValue`) — _this is the federation-sync primitive too_ (spec/11 §4). JSONL + SQLite
  backends pass one shared conformance harness.
- **The read surface is already gql-on-demand.** [`src/gql.ts`](src/gql.ts) pins a `(snapshot,
policy)` and synthesizes a schema; the aggregator's query surface is this, over the union.
- **Keys already derive from one seed.** [`src/identity.ts`](src/identity.ts):
  `deriveSeed(master, label)`. A store's identity keypair is just another labeled derivation.
- **There is already a console.** [`src/console.ts`](src/console.ts): a zero-dep web UI over the
  store. The admin interface is its evolution, not a greenfield app.

**The one true gap** (spec/12 §2): a delta is associated with its **author**, never with a **store**.
Everything below either adds store-origin _as provenance beside the delta_ (never in its identity —
SPEC-8 §2.1) or leans on the fact that origin is not needed for correctness, only for attribution.

## 3. Naming (resolve this before Phase A)

There is a vocabulary collision: the code's `Store` interface is the **persistence backend**, but the
user's "store" is the **federating instance**. Recommendation — **rename the interface `Store` →
`StoreBackend`** (its enum is already `StoreBackend` in [store-tier.ts](src/store-tier.ts), so this
_aligns_ the names) and let **`Store`** name the product-level unit: `{ id, name, backend, keypair,
tier, lenses }`. One mechanical rename on freshly-shipped code, and the domain word matches the
user's mental model. (Alternative if the rename is unwanted: call the product unit an `Instance`. Flag
for the user; do not guess.)

## 4. The pieces to build (data shapes, sketched — adapt to the code's idiom)

```ts
// A Store is a peer with a name, a tier, and a backing persistence backend.
interface Store {
  id: string; // StoreId = ed25519 pubkey of the store's own keypair (spec/12 §2)
  name: string; // human label, e.g. "personal", "media", "aggregator"
  keypair: Keypair; // derived: deriveSeed(master, `store/${name}`)
  backend: StoreBackend; // the renamed persistence interface (jsonl | sqlite | encrypted)
  tier: "private" | "federated";
  peer: Peer; // offered lens + admission; the sync surface
  publishes: PublishedQuery[]; // Tier-1 only: {toPeer, lens, closureAuditedAt}
  subscribes: Subscription[]; // aggregator: {fromPeer, lens}
}

// Origin: never in the delta. A backend column (local) + an optional annotation delta (federatable).
interface Origin {
  deltaId: string;
  storeId: string;
  firstSeen: number;
}
```

- **StoreRegistry** — discovers/opens the stores under `~/.chorus/stores/<name>/` (each a backend
  file + a small `store.json` manifest: name, tier, published/subscribed lenses). The node hosts many.
- **Encrypted backend** (Tier 0) — a `StoreBackend` that is leak-safe at rest (Phase B).
- **Aggregator wiring** — a store whose `subscribes` are pulled on `refresh` from sibling peers
  (localhost or remote), producing the union that gql serves (Phase C).
- **The closure audit** — given a `PublishedQuery`, compute the exact set of deltas its relevance
  closure exposes (spec/12 §4, Note 11 §3). The safety-critical view; built with publish (Phase D/E).

## 5. Phases (each a shippable `/loop` unit — value-ordered, reorderable by the user)

**Phase A — Store identity + registry + the rename.** ✅ **Landing** (this PR). Give a store a keypair
(`StoreId`) and a name; add `StoreRegistry` over `~/.chorus/stores/<name>/`
([src/stores.ts](src/stores.ts)); rename `Store` interface → `StoreBackend` (§3). The existing single
store is adopted as one named store (`personal`) by `StoreRegistry.adopt` — non-destructive
(source read-only) and digest-verified, so **no delta id changes** (§7). No behavior change for the
existing single-store path (callers untouched this slice). **Refined during implementation:** two
pieces the original bullet listed here move to **Phase C**, where they actually pay off — (a)
**delta origin** (which store a delta came from) is only meaningful once an aggregator pulls from
siblings, so it lands as relay-provenance on pull, not a Phase-A column; (b) **rewiring the node /
console through the registry** couples to the multi-store node, so it ships with the aggregator.
**Unlocks:** everything below has a "store" to refer to.

**Phase B — The private, leak-safe store (Tier 0).** An `EncryptedSqliteStore` backend: the on-disk
file is ciphertext (AEAD, e.g. XChaCha20-Poly1305), key = `HKDF(masterSeed, "store/<id>/at-rest")`.
For a personal-scale store, load the decrypted DB into an in-memory SQLite (`better-sqlite3`
`:memory:`) on open and re-encrypt on flush/close, so **plaintext never hits disk** (leak-safe at
rest, honestly). A `tier: "private"` store publishes **no lens** — default-deny means it never
federates. Test the guarantee: write beliefs, close, assert the raw file contains none of the
plaintext; reopen with the right key and read them back; wrong key fails loudly. **Unlocks:** "I can
put my private material somewhere and know a leak is noise." (SQLCipher is the eventual hardening
path; note it, don't block on it.)

**Phase C — Local multi-store + the aggregator + gql/MCP over the union.** Spin up ≥2 specialized
stores (`media`, `synchronicities`) and an `aggregator`. The aggregator's `refresh` pulls each
sibling's offered lens (`Peer.pullFrom`, in-process for localhost). `gql-prepare` over the aggregator
serves the union; **delta origin lands here** — the aggregator stamps relay provenance (which store a
delta came from, SPEC-6 §3) as it pulls, so a result can say where it originated. Also here: rewire
the node / `console.ts` to boot from the registry (opt-in env first, keeping the legacy single-file
`CHORUS_STORE` default intact so the live node never breaks). The MCP node exposes per-store endpoints
(`/mcp/<token>` already keys by token; a store selector rides alongside).
**Unlocks:** "a store that ingests from both and exposes all of it via GQL through an MCP" — the
concrete §1.2 picture, on one machine.

**Phase D — The constellation admin console.** Evolve [`src/console.ts`](src/console.ts) from
single-store into the constellation's cockpit: a store list (name, tier, delta count, StoreId); a
per-store inspector (its briefing/topics/entities — the existing panels, scoped); a **publish
manager** with the **closure audit view** front and center ("this published query currently exposes
these N deltas; here is exactly what a peer would receive"); trust/distrust (already signed by the
user key); and an embedded gql console over the aggregator. New routes extend the existing
`/api/state` · `/api/entity` · `/api/search` · `/api/ack` · `/api/distrust` set. **Unlocks:** "an
admin interface for a store, via web" — and it is _where "what gets shared with whom" is seen and
decided_, so it must land with, not after, publishing.

**Phase E — Federation v1 across machines (friends).** The former "federation v1" unit, now situated:
one store **publishes** a query to a friend's instance and one **subscribes**, over the HTTP transport
that already exists; two trust lenses (transport trust vs claim trust, SPEC-6 §3, kept orthogonal);
the closure audit (Phase D) is the gate you pass before publishing; irrevocability is stated in the UI
and the protocol ("publish = I accept having irrevocably shared this closure", SPEC-6 §7). Cross-store
`sameAs` at the boundary (spec/12 §3c): a friend's `person:myk` is a distinct node until a signed
judgment merges it. **Unlocks:** the collective distributed rhizome, with intention.

**Phase F — Namespacing hardening + Tier-2 payload encryption (later, when the collision/erasure
pressure is real).** `rhizomatic.type` (or `chorus.type`) as a declared-type claim so entity kind is
asserted not inferred (also sharpens gql reflection, closing the flagged inbox gap); optional
key-scoped id minting for ids destined to federate; and the Tier-2 encrypted-blob + key-destruction
pattern for **selectively shared, erasable** sensitive payloads (SPEC-6 §7 / SPEC-8 §7). Deferred on
purpose — it is the only crypto that needs per-item key management, and it should wait behind a real
need and a vocabulary. **Unlocks:** collision-safe global names and the honest erasure story.

## 6. Definition of done (per phase — the `/loop` runs until its phase's points hold)

- **A** ✅: `StoreRegistry` opens named stores; a store has a `StoreId` keypair (derived, verified on
  re-open); the rename is complete; `StoreRegistry.adopt` imports an existing store losslessly (a test
  asserts a **byte-identical canonical digest** and thus **no delta id changed**, plus idempotent
  re-adoption and an untouched source); `npm run check` green (104 tests); existing single-store
  behavior unchanged. (Origin + registry-boot rewiring deferred to Phase C, per §5.)
- **B:** `EncryptedSqliteStore` passes the **same** store-conformance harness as JSONL/SQLite; the
  leak-safety test holds (raw file has no plaintext; wrong key fails); a `private` store federates
  nothing (a test tries to pull from it and gets the empty offered set).
- **C:** ≥2 specialized stores + an aggregator; the aggregator's union digest equals the union of the
  siblings' digests; `gql-query` over the aggregator returns cross-store results with origin; MCP node
  serves the aggregator.
- **D:** the console lists stores and renders the closure audit for a published query (a test asserts
  the audited set equals `eval(publishedLens, store)` exactly — Note 11's fidelity invariant);
  publish/trust actions are signed by the user key.
- **E:** two instances converge on exactly the published closure over HTTP and nothing outside it
  (property-tested from divergent states, per SPEC-6 §8); irrevocability surfaced; boundary `sameAs`
  keeps like-named foreign entities distinct until merged.

## 7. Migration guide — no data lost, even as the form changes

The accumulated store is `~/.chorus/memory.sqlite` (311+ deltas; the frozen `memory.jsonl` is the
legible backup, per PROGRESS.md ops reality). **Nothing below is destructive** — every step _copies_
content-addressed deltas (idempotent by id) into new containers; the originals stay untouched until
you choose to retire them.

1. **Back up first.** Copy `~/.chorus/memory.sqlite` and `~/.chorus/memory.jsonl` aside. (They are
   also never modified by the steps below — this is belt-and-suspenders.)
2. **Adopt (Phase A).** The migration opens the existing file and registers it as the store named
   `personal`, minting its `StoreId` keypair (`deriveSeed(master, "store/personal")`) and recording
   it in `~/.chorus/stores/personal/store.json`. **No delta is rewritten**; ids are unchanged; the
   store's canonical digest before and after adoption is **identical** (assert it, reusing the
   `migrate.ts` digest-verification pattern).
3. **(Optional) Specialize (Phase C).** To split the graph, define a lens per specialized store and
   copy the matching deltas out: e.g. `media` ← everything about `work:` / `book:` / `character:` /
   `person:` entities and the events referencing them; `synchronicities` ← `synchronicity:` /
   `tracker:` / `oracular-reading:` families. Copying is `targetStore.appendDeltas(sourceLens
deltas)` — idempotent, so a delta relevant to two stores lands in both, and cross-references
   survive because ids are stable. The `personal` store can either keep everything (and _be_ the
   aggregator) or be trimmed to the private identity material; your call, made by which lenses you
   copy where. **Convergence check:** the union of the specialized stores' digests equals the
   original store's digest (a test asserts it — CRDT union is exact).
4. **Privatize (Phase B).** Mark the store holding personal/identity material (`person:myk`, the
   synchronicity preferences and readings) `tier: "private"` and migrate its backend to
   `EncryptedSqliteStore` (decrypt-in-memory, re-encrypt at rest). It publishes nothing. Verify the
   raw file is ciphertext.
5. **Wire the node (Phase C).** Point `~/.chorus/start-chorus-node.cmd` at the registry rather than a
   single `CHORUS_STORE` file; the aggregator becomes the default query surface for Claude Code /
   Desktop / Web, while the private store is reachable only locally by key.
6. **Rollback is trivial.** Every original file is intact; delete `~/.chorus/stores/` to return to the
   single-store world exactly as it was.

**The guarantee to hold onto:** a delta's identity is its content, so "changing form" only ever moves
the _same_ facts between containers. The digest is the receipt; every migration step asserts one.

## 8. Constraints & non-goals

- **App-layer rules:** TS-only, no vectors, no Rust parity, no spec changes required to _build_
  (spec/12 + Note 11 are the direction; promote to normative only once the shape is proven). Feature
  branch per phase, PR to main, green gates before every commit.
- **Never put store-origin in a delta's identity** (SPEC-8 §2.1) — origin is a backend column and/or
  an annotation delta, always beside the delta, never inside it.
- **Keep the plain SQLite + JSONL tiers.** The encrypted backend is an _addition_ for the private
  tier, not a replacement; legibility stays a first-class option for non-private stores.
- **Do not overpromise erasure.** Tier-1 publish is irrevocable and the UI must say so; real
  forgetting waits for Tier-2 (Phase F) and stays honestly flagged until vectored.
- **Lean on the CRDT.** Content-addressed + order-independent + idempotent means every split, merge,
  and migration is verifiable by digest. Assert digests; trust the algebra.

## 9. Pointers

- Substrate model: [spec/12-instances-provenance-privacy.NOTE.md](../../spec/12-instances-provenance-privacy.NOTE.md)
  · [spec/11-federation-as-query.NOTE.md](../../spec/11-federation-as-query.NOTE.md) ·
  [spec/06-federation.md](../../spec/06-federation.md) · [spec/08-storage.md](../../spec/08-storage.md)
- Persistence seam: [src/store-tier.ts](src/store-tier.ts) · [src/sqlite-store.ts](src/sqlite-store.ts)
  · [src/shared-store.ts](src/shared-store.ts) · migration pattern: [src/migrate.ts](src/migrate.ts)
- Federation as built: [implementations/ts/src/peer.ts](../../implementations/ts/src/peer.ts) ·
  [implementations/ts/src/http.ts](../../implementations/ts/src/http.ts)
- Read/admin surfaces: [src/gql.ts](src/gql.ts) · [src/console.ts](src/console.ts) ·
  [src/mcp-server.ts](src/mcp-server.ts) · [src/mcp-http.ts](src/mcp-http.ts)
- Keys/identity: [src/identity.ts](src/identity.ts) · Working agreement: [root CLAUDE.md](../../CLAUDE.md)
