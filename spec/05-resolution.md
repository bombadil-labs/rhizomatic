# Rhizomatic Specification — SPEC-5: Resolution, Views & the ABI (L5)

**Status:** Draft
**Layer:** L5 — output boundary / calling convention
**Depends on:** SPEC-0 … SPEC-3 (SPEC-4 informative)

---

## 1. Purpose

L5 is the system's **ABI**: the layer where the format's deliberate pluralism meets applications that need a single value, and where independent authors' vocabularies meet each other. It has two halves:

- **Resolution** (§2–§5): collapsing a HyperView's superposed claims into a View, deterministically, per declared schema.
- **Vocabulary conventions** (§6): the calling-convention discipline for `role`/`context` names, without which independently-authored deltas don't compose.

The framing matters: assembly languages achieved interop not by restricting the instruction set but by layering conventions on top (cdecl, ELF, ABIs). Naming divergence and conflict handling are *convention* problems and live here — not at L1 (which accepts any vocabulary) and not at L2 (which has no opinions about truth).

## 2. The `resolve` Boundary

`resolve : Schema → HView → View` (SPEC-2 §4.7) is the only exit from the algebra. Its contract:

Naming (the layer grid): `Schema : View :: HyperSchema : HyperView`. The `Hyper-` prefix marks the superposed layer, uniformly for data and programs — a HyperSchema is the program that yields HyperViews, a Schema is the program that yields Views. A Schema is **not** derived from a HyperSchema; each is the program of its own layer, and only data (HyperView → View) crosses between them.

- **Deterministic:** same (HView, Schema) ⇒ identical View, byte-for-byte canonical. All pluralism is in schema choice, never in evaluation (P5).
- **Total:** every schema MUST produce a defined result for every HView, including the empty-property and all-negated cases (§4).
- **Provenance-optional, never provenance-destroying upstream:** a View may discard provenance; the HyperView beneath it never does. `explain` (SPEC-4 §7) reconstructs any View value's justification.

The same HyperView legitimately yields different Views under different schemas, simultaneously, within one application: an admin surface resolving `surfaceAll`, a public API resolving `trustedAuthors`, a quality dashboard resolving `conflictsOnly`. This is the original "feature, not a bug," now with a normative shape.

### 2.1 Candidate value extraction

What part of an HVEntry's delta *is* the value a policy adjudicates? The rule is total and
deterministic:

- **Filing pointers** (EntityRef pointers targeting the HView's root) are excluded — they are the
  edge's address, not its payload.
- Render the remaining pointers' targets: a primitive renders as itself; an unexpanded EntityRef
  renders as its entity-id string; a DeltaRef renders as its delta-id string; an **expanded**
  target (SPEC-2 §4.5) renders as the nested HView resolved recursively **with the same schema
  object** as the enclosing resolution (per-depth schemas are a deferred extension; the
  recursion is deterministic either way).
- **Zero** non-filing pointers → the candidate is `true` (the bare fact of the edge).
- **Exactly one** → its rendered target.
- **Several** → an object `{ role: rendered }`; duplicate roles within one delta collect into an
  array in authored pointer order.

Entries that survived into the HView under `mask(annotate)` are candidates even when tagged
negated — the hyperschema chose an audit view; suppression is what `mask(drop)` is for.

## 3. Schema Terms

Schemas are terms in a closed grammar — serializable as deltas, federate-able, and pinnable, exactly like hyperschemas (P4 applies above the algebra too):

```
Schema      ::= object( Map<propertyName, Policy>, default: Policy )

Policy      ::= pick(Order, Tiebreak)        // collapse to one value
              | all(Order)                   // array of all surviving values
              | merge(MergeFn)               // closed combiners: §3.1
              | conflicts(Order)             // values only if ≥2 distinct survive
              | absentAs(Const, Policy)      // default for empty properties

Order       ::= byTimestamp(desc|asc)
              | byAuthorRank(AuthorId[])     // explicit trust list, first match wins
              | byPred(Pred, then: Order)    // partition by predicate, prefer matches
              | chain(Order[])               // compare by each in turn; first decisive wins
              | lexById                      // deterministic last resort

Tiebreak    ::= lexById                      // MUST terminate in a total order

MergeFn     ::= max | min | sum | count | and | or | concatSorted
```

Normative notes:

- Every `Order` chain MUST bottom out in `lexById` (delta content hashes give a canonical total order), guaranteeing determinism even among byte-equal claims from distinct deltas.
- `chain` is the composition form: compare by each member in turn, taking the first decisive
  comparison; a chain whose every member ties falls through to the structural `lexById` like any
  other order. A `chain` MUST be non-empty (an empty chain is a rejected term, not an identity).
  `chain([byAuthorRank([...]), byTimestamp(desc)])` is the canonical spelling of *trusted, then
  latest*; `chain([byTimestamp(desc), byAuthorRank([...])])` of *latest, rank as tiebreak*.
  Encoding a rank as nested single-author `byPred`s is legal but discouraged — it duplicates what
  `byAuthorRank` + `chain` say directly.
- `byAuthorRank` is the trust primitive. Trust *lists* are data (representable as deltas), so trust is queryable, forkable, and federated like everything else. `byAuthorRank` and `byTimestamp` are deliberately tie-*permissive* — composition is `chain`'s job, not a per-order `then`.
- `MergeFn` is a closed set by the same argument as SPEC-2 §1: arbitrary reducers cannot ship inside schema terms. They are not second-class, however — they are **derived authors** (SPEC-7). *(Open: whether aggregation pressure forces algebra-level support — tracked at SPEC-2 §9.)*
- `merge(fn)` folds over the property's candidates in **ascending delta-id order** (float addition is order-dependent; the fold order is pinned). Domains: `max`/`min` take all primitive candidates by the canonical total order (SPEC-2 §3); `sum` numeric candidates only; `and`/`or` boolean only; `count` counts all surviving entries regardless of type; `concatSorted` yields all primitive candidates sorted canonically. Non-primitive candidates (§2.1 objects/arrays) are skipped by every MergeFn except `count`. A MergeFn with no candidates in its domain resolves to **absent**.
- The resolved View includes every property named in `schema.props` — so `absentAs` can fire for properties with no deltas at all — plus every HView property not named, resolved via `default`. Every order chain ends in an **implicit lexById tiebreak**, structurally: determinism does not depend on authors remembering to write it.
- **Computed resolution is architecture, not workaround.** Any resolution requiring general computation or judgment — domain-specific reducers, statistical combiners, human review queues, LLM adjudication, semantic matching — is performed by a derived author: an identified function subscribed to the relevant materialization, emitting its verdicts as signed deltas (optionally negating losers). The application's schema then resolves with `byAuthorRank([thatAuthor, …])`. The judgment becomes reactive (recomputed when inputs change, not on every read), cached (a delta, evaluated once), versioned (new function hash = new author), and auditable (`explain` traces the value to the function and the exact input hashes it saw). `resolve` stays deterministic; intelligence enters the system as provenance-carrying data. The cost, stated plainly: computed resolutions are eventually consistent with their inputs (SPEC-7 §5).

## 4. Edge Semantics (Normative)

- **Empty property:** `pick` over zero entries yields *absent* (key omitted from the View) unless wrapped in `absentAs`. Views never contain null (mirrors SPEC-1 §2.1).
- **All entries negated** under the schema's `mask(drop)`: indistinguishable from empty — negation already happened upstream. Policies see only survivors.
- **`mask(annotate)` schemas:** tagged entries remain candidates (§2.1) — audit views resolve like any other. Ordering *by* the tag is deferred: the Pred grammar sees only the delta, and the tag is entry metadata (likely future: a `negated` pseudo-field on `match`).
- **Type heterogeneity:** competing claims of different primitive types are legal (someone asserted `size: 3`, someone `size: "large"`). `pick` is type-blind; `merge(max)` over mixed types MUST resolve by canonical type order (bool < number < string) then value — defined, deterministic, and ugly, which is the correct incentive to fix it with vocabulary discipline (§6) or negation.

## 5. View Output Profiles

A View is `primitive | View[] | { string: View }`. The View of an HView is the object of its
resolved properties — the root id is context the caller already holds, not a property. Canonical
serialization is the canonical CBOR of that structure (the same profile as everything else,
SPEC-1 §4.1); conformance vectors pin both a JSON rendering and the canonical hex. Profiles (informative): a GraphQL resolver maps each property's Policy to a field resolver over the HyperView — the legacy README's resolver examples become *generated code from schema terms*. REST/JSON and language-native object mappings follow the same pattern. All profiles MUST preserve the determinism contract; presentation may reorder, never re-adjudicate.

## 6. Vocabulary: the Calling Convention

L1 accepts any `role`/`context` strings; composition across authors requires convention. Normative framework (specific vocabularies are ecosystem artifacts, not spec content):

- **Namespacing:** vocabulary names SHOULD be dot-namespaced (`rhizomatic.*` reserved for the spec itself — SPEC-3 §5; `org.example.*` for applications). Bare names are legal and considered local dialect.
- **Vocabularies as data:** a vocabulary is an entity; its terms, documentation, and deprecations are deltas. Publishing a vocabulary is publishing deltas (P3, again).
- **Aliases as deltas:** cross-vocabulary mapping (`parent` ≡ `container`) is asserted by *alias deltas* in a normative `rhizomatic.alias` vocabulary. Schemas opt in: `StrMatch` gains `aliased(string, via: VocabRef)` *(proposed; needs L2 vectors)*, expanding to the alias closure at term-validation time — so aliasing is static and inspectable, never a runtime fuzzy match.
- **Semantic/embedding-based matching:** MUST NOT participate in evaluation (determinism and convergence forbid fuzzy semantics below the View). It enters the system in two sanctioned forms: as an authoring-time suggestion tool (lint: "these contexts look synonymous — assert an alias?"), and as a **derived author** (SPEC-7) continuously emitting `rhizomatic.alias` deltas — fuzzy judgment running live, with its hunches recorded as negatable, provenance-carrying claims rather than as nondeterminism inside the evaluator.
- **Enforcement point:** mutation helpers (SPEC-4 §6). The convention is enforced where deltas are *born*, audited by registry lint, and repaired by alias deltas — never by rejecting well-formed deltas at L1.

## 7. Appendix: Schema JSON Profile (Normative)

The JSON spelling of schema terms, used by the conformance vectors and as the authoring surface:

```
Schema     ::= { "props": { propName: Policy, ... }, "default": Policy }
Policy     ::= { "pick": { "order": Order } }
             | { "all": { "order": Order } }
             | { "merge": "max"|"min"|"sum"|"count"|"and"|"or"|"concatSorted" }
             | { "conflicts": { "order": Order } }
             | { "absentAs": { "const": Primitive, "then": Policy } }
Order      ::= { "byTimestamp": "desc"|"asc" }
             | { "byAuthorRank": [author, ...] }     // first match ranks first; unlisted rank last
             | { "byPred": { "pred": Pred, "then": Order } }   // matches first, then `then`
             | { "chain": [Order, ...] }             // non-empty; first decisive comparison wins
             | "lexById"
```

## 8. Open Questions (L5)

- `aliased` StrMatch: confirm static-expansion semantics and DAG-check interaction (alias chains must be acyclic).
- Schema composition: can schemas import/extend other schemas (a trust list shared across an org)? Likely yes via evolvable refs (SPEC-3 §6 semantics apply); needs vectors for the pin-recording requirement.
- Standard library: a small set of blessed, pinned schemas (`latest`, `trusted(list)`, `surfaceAll`) shipped as conformance vectors so common cases are interoperable by hash.
- Schema/vocabulary case-sensitivity ergonomics: spec says case-sensitive (SPEC-1 §2.1); lint guidance for the inevitable `Name`/`name` collisions.
- **Transactional completeness policies:** "only resolve claims whose full transaction is present." `Pred` is single-delta, so completeness can't be tested inline; the lean is reactor-asserted completeness annotations (SPEC-4 §6) made selectable via `byPred`. Needs the annotation vocabulary pinned and vectors written.
