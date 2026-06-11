# Rhizomatic Specification — SPEC-7: The Derivation Layer (L7)

**Status:** Draft
**Layer:** L7 — userland / the write-back loop
**Depends on:** SPEC-0 … SPEC-6

---

## 1. Purpose

L7 is where arbitrary computation lives. L1–L6 form a closed, deterministic kernel: terms, not code; inspection, not trust. L7 is the open, Turing-complete userland that the kernel exists to host — with one governing rule that keeps the kernel's guarantees intact:

> **Everything that computes is an author.**

A custom reducer, a statistical combiner, an embedding-based alias matcher, an LLM adjudicator, a simulation, a human-in-the-loop review queue — each is a **derived author**: an identified function, installed by consent, subscribed to materializations, whose outputs re-enter L1 as ordinary signed deltas. Computation is never embedded *inside* evaluation, where it would wield invisible authority; it joins the system the way a federated peer does — as a sovereign making claims. One rule, all the way up.

This dissolves the apparent loss of "arbitrarily complex resolver logic": the logic is unrestricted; only its *interface* to the system is disciplined (identity in, deltas out).

## 2. Derived Author Identity

A derived author is the pair (function artifact, signing key):

- **Function identity:** `fnHash` = content address of the function artifact (§7) plus its declared interface. Any change to the code is a *different function* and therefore a different author.
- **Signing identity:** a keypair bound to `(fnHash, hostInstance)`. RECOMMENDED derivation: host signs a key-binding delta `{ rhizomatic.derived.binds: fnHash → authorPubKey }`, making the binding itself queryable provenance. The same function installed on two instances yields two authors with a shared `fnHash` — comparable (§8) but distinct, which is correct: the host is part of the trust story.
- **Versioning consequence:** upgrading a function strands nothing. Old claims remain attributed to the old author/brain; policies (`byAuthorRank`) choose whether to prefer the successor; an `rhizomatic.derived.supersedes` delta links the lineage.

## 3. Registration (the Binding)

Installing a derived author on a host reactor creates a **binding**:

```
Binding {
  fn:        fnHash
  input:     TermHash            // an L2/L3 term; the materialization it watches
  inputPins: SchemaRef pins      // per SPEC-3 §6, recorded for reproducibility
  trigger:   onChange | periodic(interval) | manual
  budget:    ResourceBounds      // cpu/memory/output-rate ceilings (§6)
  emit:      EmissionPolicy      // §5
  class:     pure | effectful    // §4
}
```

Bindings are themselves expressed as deltas (`rhizomatic.derived.*` vocabulary, §9) — installation is an assertion by the host's key, auditable and negatable like everything else (P3 does not stop at the kernel boundary).

## 4. Determinism Classes

Declared at registration; normative consequences differ:

- **`pure`:** output is a function of `(fnHash, input HyperView content hash)` only. Pure derived authors are **replayable**: any party holding the function and the input hash can recompute and verify the claims. Conformance Level 4 vectors test exactly this. Pure derivations are the system's safe extension mechanism — deterministic computation that simply wasn't worth an algebra operator (aggregates, format converters, derived metrics).
- **`effectful`:** consults the world — clocks, randomness, models, networks, humans. Its claims are *testimony*, not *computation*: unverifiable by replay, weighable only by trust (`byAuthorRank`, track record). LLM adjudicators and human review queues are effectful by definition. The spec makes no attempt to launder testimony into proof; it only guarantees the testimony is signed, timestamped, input-pinned, and negatable.

## 5. Emission & Provenance

Every delta emitted by a derived author MUST carry derivation provenance pointers:

```
{ role: "rhizomatic.derived.by",    target: EntityRef(fnEntity) }        // fnHash-identified
{ role: "rhizomatic.derived.from",  target: <input HyperView content hash as primitive> }
{ role: "rhizomatic.derived.under", target: EntityRef(bindingEntity) }
```

plus the substantive claim pointers. `explain` (SPEC-4 §7) therefore traces any derived value to: function → exact input snapshot → the underlying deltas in that snapshot → *their* authors. Judgment all the way down, with receipts.

**EmissionPolicy** — what happens when inputs change and the author recomputes:

- `append` — accumulate claims (a running log of judgments; readers resolve by recency or rank).
- `supersede` — emit negations of the binding's prior claims alongside new ones (the materialized-resolution pattern: at most one live verdict per subject).
- `keyed(contextSet)` — supersede per-subject rather than wholesale (the common case for per-entity adjudications).

**Retraction cascade:** if a delta in a derived claim's input snapshot is later negated, the claim is *not* auto-invalidated (its provenance honestly records what was seen when). A `supersede`/`keyed` binding repairs it on next trigger; consumers needing strictness can resolve with `byPred` over input-hash freshness. *(Open: a standard staleness predicate — §10.)*

## 6. Loop Discipline

Derived authors write into the same memory they read — cycles are possible (A's outputs trigger B, B's trigger A) and sometimes desired (iterative refinement). Normative guards, host-enforced:

- A binding's input term MUST NOT match the binding's own emissions unless explicitly flagged `reentrant`; the host enforces this by predicate analysis (`not(match(author, eq, self))` is injected by default — decidable, per SPEC-2 §3).
- Reentrant and mutually-recursive bindings run under **budget** (§3): per-trigger and per-window output quotas. Exhausting a budget suspends the binding and emits an `rhizomatic.derived.suspended` annotation — divergence becomes an observable event, not a melted reactor.
- The host SHOULD maintain the binding dependency graph (input terms vs. emission footprints, both inspectable) and surface cycles at registration time.

There is no global termination guarantee in userland, and the spec does not pretend to one. Kernel determinism (P5) is unaffected: whatever deltas the loop has produced *so far* evaluate deterministically.

## 7. Function Portability & Sandboxing

- **Artifact format:** content-addressed blob; **WASM (wasi-minimal) is the RECOMMENDED interchange binding** — host-language-native functions are conformant locally but not portable claims-of-identity (two "identical" JS closures don't share a hash; a WASM blob does).
- **Capability model:** `pure` bindings run with no I/O capabilities (enforced sandbox = the purity claim is checkable, not honor-system). `effectful` bindings declare required capabilities (network, clock, model endpoints) at registration; the host grants explicitly.
- **Federation:** artifacts ship as blobs referenced by deltas (SPEC-6 §6). Receiving ≠ installing; installation is a sovereign local act. You can also skip running entirely and simply *trust the remote author's claims* — verifying pure ones by spot-replay if you hold the artifact. Trust gradient, not trust cliff.

## 8. What This Layer Recovers (Informative)

Mapping the original design's "lost" capabilities onto L7:

| Original desire | L7 form |
|---|---|
| Arbitrary resolver logic (Strategy 1–4) | derived author + `byAuthorRank` policy (SPEC-5 §3) |
| LLM conflict resolution | `effectful` adjudicator, `keyed` emission |
| Computed values (averages, scores) | `pure` derivation; replayable |
| Embedding-based fuzzy context matching | `effectful` author emitting `rhizomatic.alias` deltas (SPEC-5 §6) |
| "Computed schemas" / cross-delta selection | derived author computes the cross-delta property, asserts it; kernel `select` then matches the assertion |
| The latent-space squint | a population of semantic processes whose hunches are negatable data |

The trade, stated once more for honesty: all of these are **eventually consistent** with their inputs — reactive, cached, versioned, auditable, but not synchronous with reads. That is the price of keeping the kernel deterministic, and it is the same price every materialized view in every database already pays silently.

## 9. Vocabulary (`rhizomatic.derived.*`, draft)

`binds`, `by`, `from`, `under`, `supersedes`, `suspended`, `capability`, `budget` — to be pinned with the conformance vectors, same status as SPEC-3 §5's encoding.

## 10. Open Questions (L7)

- **WASM ABI:** exact host interface (input HyperView delivery format, emission API, capability handles). The biggest concrete design task on this layer.
- **Key derivation:** deterministic per-(fnHash, host) keys vs. host-minted + binding delta (current lean: the latter; simpler, and the binding delta is good provenance anyway).
- **Staleness predicate:** standard `Pred`-expressible freshness check over `rhizomatic.derived.from` hashes, so policies can prefer fresh derivations mechanically.
- **Human-in-the-loop binding:** is a review queue a degenerate `effectful` author (current lean: yes — the human is the model), or does consent/attribution need distinct vocabulary?
- **Composition:** pipelines of derived authors (A feeds B feeds C) — bless a pipeline descriptor, or leave it emergent from bindings + the dependency graph?
- **Economic/abuse bounds in federation:** budgets are local; do remote *claims* from runaway derived authors need rate-based admission defaults (SPEC-6 §5) tuned differently than human authors?
