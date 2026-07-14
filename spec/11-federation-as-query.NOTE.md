# Rhizomatic Specification — Note 11: Federation as Query (publish/subscribe, privacy by closure)

**Status:** Note — records a direction and unifies threads already present across SPEC-3, SPEC-4,
and SPEC-6. Nothing here is normative yet; §6 names the landing sites. The motivating context: an
external party's agent built its own Chorus adapter (the first outside implementer), making
federation a near-term, real-demand surface; and Chorus shipped GraphQL-on-demand (`gql.ts`, now
in the separate loam repo), which turns out to be the same machinery a federation boundary needs.

---

## 1. The claim

**A federation relationship is a pair of queries.** What one instance offers a peer, and what a
peer wants from it, are both expressible as queries over the delta log — and so is the streaming
of updates between them. "Subscribe takes a query; publish takes a query" is the whole interface.

This is not a new mechanism. It is the recognition that three things the spec already has line up
behind a single idea:

- **SPEC-6 §4 — a lens IS a query.** An offered lens is "any DSet-sort term"; its fidelity rule is
  *offered set ≡ `eval(lens, log)`*. So what federates is already defined by evaluating a term.
- **SPEC-6 §9 — lens negotiation is query intersection.** The open question already proposes that
  peers compose "intersection of my offer and your want" as `and(...)` of predicates. That is
  exactly publish ∩ subscribe.
- **SPEC-3 §2.1 — a query's relevance closure is the maintenance contract for an index**, i.e.
  *precisely the set of deltas a query touches.* So a published query does not merely *describe*
  what shares; its closure *defines* the set of deltas that flow.

The sharpening this note adds: make publish and subscribe **symmetric** (both queries), make the
update channel **streaming**, and read off **privacy** as a property of the published query rather
than a separate perimeter.

## 2. Streaming = incremental materialization (already built)

A subscription is a query made continuous. The engine for that is **SPEC-4 §4–§5**: register an
HView-sort term over roots and the reactor keeps it incrementally equal to batch evaluation,
emitting change events (changed property paths, responsible delta ids, new content hash) on every
content change. A subscription is that change stream, projected to the deltas entering/leaving the
query's closure and shipped to the peer.

So the two query temporalities are one language at two clocks:

- **Pinned / retrospective** — evaluate a query against a frozen snapshot, read it as long as you
  like. This is exactly Chorus's `gql-prepare` + `gql-query` (a pinned `(snapshot, policy)` →
  ephemeral schema; the snapshot frozen so a long walk never races a write).
- **Live / streaming** — `subscribe(query)`: register the query as a materialization, stream its
  closure's deltas as they arrive.

This is the OLTP/OLAP split the gql design conversation already named, now with federation as the
consumer of the streaming half.

## 3. Privacy as a default-deny property of the published query

The strong reading of §1: **a delta federates to peer P iff it lies in the relevance closure of
some query published to P.** Default-deny. Deltas no published query reaches never leave — not
because a perimeter blocks them, but because nothing pulls them into scope. Topic-scoped sharing
becomes a *special case* (`publish { everything about topic:X }`), not the mechanism.

Two consequences, one of them a hazard:

- **The closure is the privacy review surface, and it must be exact and auditable.** A published
  query that follows references can transitively pull in deltas you did not mean to share (publish
  "my ideas," an idea references a private person, does that node ride along?). The closure is
  statically bounded (SPEC-3 §3 gives every schema a finite max expansion depth), so "show me
  every delta this published query exposes, now and as my store grows" is computable — and it is
  the most safety-critical view in a federating instance. Build it *with* publish, not after.
- **Grow-only means you cannot un-send (SPEC-6 §7).** Publish a query, sync, then unpublish — the
  peer already holds those deltas. `distrust` (SPEC-5 §3) addresses the *trust* axis (demote what
  a peer's authors said) but there is no confidentiality recall. "Publish a query" honestly means
  "I accept having irrevocably shared this closure up to now." The blob-indirection + key-
  destruction pattern (SPEC-6 §7, SPEC-8 §7) is the eventual mitigation; the honest v0 stance is
  irrevocability, stated plainly — a trust protocol must not lie about this.

## 4. Persistence is the same shape (why the two land together)

A grow-only signed log makes durable persistence and remote sync the same primitive: append
(idempotent by id), snapshot, and **deltas since a watermark**. The Chorus `Store` interface (now
in the separate loam repo) is, deliberately, the federation-sync interface. The one forward concession asked of it: shape the read seam so a later
**closure-scoped** `since(watermark, closure)` is additive. SPEC-8 §8 already anticipates this —
read-optimized pack layouts "by schema relevance closure." The SQLite indexes (by target entity,
by role/value) that make local reads fast are the same indexes that make closure-scoped federation
reads fast. One build, two payoffs.

## 5. What this is NOT

- Not a new query language. It is the existing term algebra (SPEC-2) / HyperSchemas (SPEC-3),
  with GraphQL as one ergonomic surface over it (Chorus's gql layer), never the engine.
- Not a claim that aggregates are solved. Argmax/group-by/path-predicates remain derivation-layer
  work (SPEC-7); a published query bounds *which deltas* flow, not *what is computed from them*.
- Not a privacy guarantee beyond what append-only can give: it governs **spread** (what you send),
  not **existence** (SPEC-6 §7). Erasure stays the flagged-honest hard problem.

## 6. Landing sites

- **SPEC-6 §9** (federation open questions) — promote "lens negotiation = intersection of offer
  and want" to the symmetric publish/subscribe framing; add the streaming subscription channel
  (built on SPEC-4 §5 change events) and the closure-as-privacy-boundary reading with its audit
  requirement.
- **SPEC-6 §7** (data lifecycle) — record the irrevocability statement for published-query sharing
  explicitly, alongside the existing erasure position.
- **SPEC-4 §5** (change events) — note the subscription/federation consumer of the change stream.
- **SPEC-8 §8** (read-optimized layouts) — connect "repack by relevance closure" to closure-scoped
  federation reads.
- **Chorus** (now a separate loam app) — the concrete proving ground: the `Store` interface +
  SQLite tier first, then federation v1 (one published query, one subscribing peer over the HTTP
  transport already shipped, two trust lenses, the closure-audit view) — app-layer, ahead of any
  normative vectors, exactly as the working agreement allows.

A vectorable conformance statement (what an instance MUST expose to a peer given a published query,
and the convergence guarantee under streaming) waits until the chorus prototype has shown the
shape. Pin the model on paper as it firms up; do not vector a guess.
