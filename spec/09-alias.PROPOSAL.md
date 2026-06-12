# Rhizomatic Specification — SPEC-9: Aliases, Concepts & Slots (PROPOSAL)

**Status:** Proposal — adoption gated on conformance vectors green in two witnesses
(`vectors/l1-eval/eval-aliased.json`)
**Layer:** L5 §6 vocabulary (the `rhizomatic.alias.*` namespace) + one L2 grammar extension
(the `aliased` StrMatch)
**Depends on:** SPEC-1, SPEC-2, SPEC-3 (informative), SPEC-5 §6, SPEC-7 (informative)

---

## 1. Purpose

Independently-authored vocabularies drift: two applications that never met describe employment
as `employer`/`employees` and `job`/`staff`. SPEC-5 §6 places the repair at the calling
convention — **aliases as deltas** — and defers the mechanism. This document is the mechanism:

- a normative vocabulary (`rhizomatic.alias.*`) for **concept entities with oriented slots**
  and for **mapping claims** that bind a vocabulary fragment to a slot;
- the **`aliased`** StrMatch form: a deterministic, inspectable closure over those claims,
  expanded statically per evaluation — never a runtime fuzzy match.

The division of labor is the same as everywhere else in the system: *judgment* (these two
names mean the same thing) is produced above the read boundary by accountable authors — humans
or embedding-model derived authors (SPEC-7) — and persists as signed, negatable claims;
*evaluation* of those claims is closed, total, and byte-deterministic. Semantic similarity
MUST NOT participate in evaluation except through this vocabulary (SPEC-5 §6).

## 2. Concepts and Oriented Slots

A **concept** is an ordinary entity standing for a relation in the abstract —
`concept:employment` — independent of any application's spelling of it. A concept has
**slots**: one entity per *end* of the relation, e.g. `concept:employment#worker` and
`concept:employment#organization`. (The `#` spelling is a convention, not a parser rule;
slot identity is the entity id as a whole.)

Slots exist to make relation **direction** explicit. Which end of a relation a vocabulary
fragment names is *which slot it maps to* — so `employer` (the property at the person) and
`staff` (the property at the company) can both converge on `concept:employment` without ever
gluing the wrong ends together. Mapping fragments to slots also keeps the judgment space
linear: each fragment is judged against concepts (O(n) claims), never pairwise against every
other fragment (O(n²)).

A slot is declared to belong to its concept by a **slot declaration delta**:

```
SlotDeclarationDelta := a delta whose pointers include
  { role: "rhizomatic.alias.slot",    target: EntityRef(slotEntity,    context: "rhizomatic.alias.concept") }
  { role: "rhizomatic.alias.concept", target: EntityRef(conceptEntity, context: "rhizomatic.alias.slots") }
```

Read natively (SPEC-1 §2.3): at the slot, the declaration files under
`rhizomatic.alias.concept`; at the concept, under `rhizomatic.alias.slots`. Declarations are
deltas like any other — signed, negatable, federate-able.

## 3. Mapping Claims

A **mapping claim** asserts that a vocabulary fragment (a `role` or `context` string in some
application's dialect) names a slot:

```
MappingDelta := a delta whose pointers include
  { role: "rhizomatic.alias.fragment",   target: <string: the vocabulary fragment> }
  { role: "rhizomatic.alias.slot",       target: EntityRef(slotEntity, context: "rhizomatic.alias.mappings") }
and MAY include
  { role: "rhizomatic.alias.confidence", target: <number in [0,1]> }
```

Normative notes:

- **Well-formedness:** a mapping delta has at least one `rhizomatic.alias.fragment` pointer
  whose target is a string primitive and at least one `rhizomatic.alias.slot` pointer whose
  target is an EntityRef. Deltas using the alias roles that fail this are not mapping claims
  and are ignored by the closure (graceful degradation, in the spirit of SPEC-3 §7) — they
  remain ordinary deltas for every other purpose.
- **Cross product:** a single delta carrying several fragment pointers and/or several slot
  pointers asserts every (fragment, slot) pair. Atomicity (SPEC-1 §3) applies: negating the
  delta kills all of its pairs.
- **Fragments are position-blind.** A fragment is a *string that some dialect uses to name a
  relation end* — whether a given delta spells it as a pointer `role` or a target `context`
  is authoring idiom. One mapping serves both; the *position* matched is decided by where the
  `aliased` StrMatch sits (§4).
- **Provenance is the point.** The author of a mapping is the judge — a human keypair or a
  derived author wrapping an embedding model (one model version = one author = one rankable
  track record). `confidence` is the judge's own calibration, selectable by trust predicates
  (§4) and policies. A wrong mapping dies by one signed negation (SPEC-1 §7) — no reindex.

## 4. The `aliased` StrMatch (L2 extension)

The StrMatch grammar (SPEC-2 §3) gains one form, legal in **every** StrMatch position
(`PPred.role`, `PPred.context`, `prune.keep`, `expand.role`):

```
StrMatch ::= exact(string) | prefix(string) | inSet(Set<string>)
           | aliased(name: string, via?: EntityId, trust?: Pred)
```

JSON profile (extends SPEC-2 §9):

```
StrMatch ::= … | { "aliased": { "name": string, "via"?: EntityId, "trust"?: Pred } }
```

### 4.1 Closure semantics (normative)

Let **D** be the *ambient evaluation input* — the delta set bound to `input` for the whole
evaluation (the same ambience as the registry, the root, and the hole environment; NOT the
operand of the enclosing operator, so `select`'s conjunction-composition law is preserved).

For an `aliased` node A = (name, via?, trust?), the **closure** is computed as:

1. **Trusted set.** T = { d ∈ D : trust(d) } if `trust` is present, else T = D. The trust
   predicate restricts *every* participant: mappings, slot declarations, and the negations of
   both.
2. **Survivors.** S = the deltas of T not negated within T — exactly the semantics of
   `mask(trust(p))` / `mask(drop)` (SPEC-2 §4.3): negation chains are walked within T only.
3. **Mappings.** M = { (f, s) : some well-formed mapping delta in S asserts fragment f →
   slot s } (§3, cross product included).
4. **Concept restriction.** If `via` = C: drop from M every pair whose slot s has no slot
   declaration delta in S declaring s a slot of C (§2). If `via` is absent, M is unrestricted.
5. **Slots of the name.** Σ = { s : (name, s) ∈ M }.
6. **Closure.** closure(A, D) = { name } ∪ { f : (f, s) ∈ M ∧ s ∈ Σ }.

A matches a candidate string x iff x ∈ closure(A, D) — observationally identical to
`inSet(closure)` with the closure sorted by the canonical string order (SPEC-2 §3).

Normative properties:

- **One hop, no transitivity.** The closure walks name → slots → fragments, once. Fragments
  reachable only through a *second* slot shared by some other fragment do not enter. Slots
  are the hubs; transitive gluing through fragments would reintroduce exactly the
  wrong-end ambiguity slots exist to prevent. (Slot-to-slot equivalence is an open question,
  §8.)
- **The name is always in its own closure** — `aliased` with no surviving mappings degrades
  to `exact(name)`, never to "matches nothing".
- **Matching, never renaming.** The closure decides which deltas *match*; it rewrites
  nothing. A grouped HView keeps the matched deltas' own contexts as property names — recall
  crosses dialects, output stays in the target's vocabulary. Renaming, where wanted, is an
  L5 resolution/presentation concern.
- **Deterministic and pure.** closure(A, D) is a function of the term and the set;
  `eval : Term × DSet → result` stays pure. Same inputs, same bytes (P5). Time-scoped
  aliasing falls out: hand eval an as-of-restricted set and the closure is computed from the
  mappings that existed then.
- **Static and inspectable.** Implementations MUST expose the computed closure for any
  `aliased` node against a given set (the conformance vectors pin closures as sorted string
  arrays). The expansion is what runs; there is nothing fuzzy below the read boundary.
- **Hashing.** An `aliased` node hashes as authored under the SPEC-2 §7 recipe (optional
  fields omitted when absent); the closure NEVER enters the term hash. Like a body with
  holes, a term with `aliased` keeps one hash however the data later expands it.
- **`aliased` is closed under itself and under holes** in this proposal: `name`, `via`, and
  `trust` admit no `{"hole": …}` leaves, and `trust` admits no nested `aliased`;
  implementations MUST reject both at parse time (§8). The trust predicate is evaluated
  against alias-vocabulary deltas during closure computation — outside the hole environment
  and outside any further expansion.
- **Reactor dispatch (SHOULD, for SPEC-4 implementations):** a materialization whose term
  contains `aliased` is alias-sensitive — any ingested delta that is a well-formed mapping
  claim, slot declaration, or a negation targeting one MUST trigger re-dispatch of that
  materialization (conservative broad dispatch is sound; closure-delta precision is an
  optimization).

### 4.2 Versioning

This is a grammar extension to alg 1 **while SPEC-2 is pre-release draft**: implementations
that do not know the form already reject unknown StrMatch keys at parse time, which is the
required failure mode (SPEC-2 §8 — no partial evaluation). If adopted after a released
algebra version, `aliased` would be an alg-versioned addition.

## 5. Relation Signatures

The librarian needs a deterministic answer to "what relation shape does this delta
instantiate?" before judging which concept it resembles. The **relation signature** of a
delta is:

> the array of `[role, context]` pairs (`[role]` when the pointer has no context) of the
> delta's **EntityRef pointers**, each pair encoded per SPEC-1 §4.1, sorted bytewise by
> canonical CBOR encoding; the signature's canonical form is the canonical CBOR of that
> array.

Primitive and DeltaRef pointers contribute nothing (primitives are not vertices, SPEC-1
§2.3; delta references are plumbing, not relation ends). A delta with no EntityRef pointers
has the empty-array signature. Two deltas with equal signatures present the same oriented
shape to the librarian — which says nothing about *meaning*; meaning is what mapping claims
assert and the closure consumes.

Conformance: `eval-aliased.json` pins (delta → signature JSON + canonical hex) cases.

## 6. The Librarian Discipline (informative here; normative for SPEC-7 authors)

The librarian is an effectful derived author (SPEC-7) wrapping an embedding model. The
boundary it MUST respect:

- **Embedding vectors never enter the substrate.** They are the librarian's private working
  memory — a rebuildable cache, never serialized into deltas. What persists is judgment:
  mapping claims with confidence and provenance.
- **The model is an author.** A new model version is a new author with its own keypair and
  its own track record; policies rank it like anyone else (`byAuthorRank`), and a reader can
  demand human-endorsed mappings while another accepts model hunches — per-reader, by policy,
  over the same substrate.
- **Eventual consistency, stated plainly:** mappings lag new vocabulary by one librarian
  cycle (SPEC-5 §3's cost note applies). Recall through `aliased` is exact and deterministic
  over the mappings that exist; novelty pays one trip to the judge.

## 7. Conformance

- `vectors/l1-eval/eval-aliased.json`: one fixture (two employment dialects, a third decoy
  concept, mapping claims incl. a negated mapping and a low-confidence cross-concept stray),
  cases pinning term hash, closure (sorted), and canonical result bytes for: via-restricted
  closure, unrestricted closure crossing concepts, trust-predicate restriction, negated
  mapping exclusion, trust excluding the negation itself (mask(trust) parity), identity
  closure, role-position matching, and a root-anchored recall schema; plus relation-signature
  cases.
- Both witnesses MUST pass identically; closure arrays and result bytes are compared exactly.

## 8. Open Questions

- **Slot-to-slot equivalence:** when two librarians mint parallel concepts, can a claim
  merge their slots (closure unions through declared slot identity)? Leaning yes, as a
  separate `rhizomatic.alias.sameSlot` claim walked exactly one hop, but it needs its own
  vectors and an acyclicity story.
- **Holes inside `aliased`** (`name` as a hole bound at fix — "recall anything aliased to
  X") — wants E15-style eager substitution; deferred until a consumer needs it.
- **Confidence-weighted closure:** v0 trust predicates gate participation binarily; a
  policy-graded closure (fragments weighted by confidence at L5 resolution) is expressible
  today as separate aliased terms with different trust thresholds, which may be enough.
- **Signature-indexed dispatch:** reactors could index mapping claims by slot to make
  alias-sensitive dispatch precise instead of broad (§4.1); optimization, not semantics.
