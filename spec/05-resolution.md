# RhizomeDB Specification — SPEC-5: Resolution, Views & the ABI (L5)

**Status:** Draft
**Layer:** L5 — output boundary / calling convention
**Depends on:** SPEC-0 … SPEC-3 (SPEC-4 informative)

---

## 1. Purpose

L5 is the system's **ABI**: the layer where the format's deliberate pluralism meets applications that need a single value, and where independent authors' vocabularies meet each other. It has two halves:

- **Resolution** (§2–§5): collapsing a HyperView's superposed claims into a View, deterministically, per declared policy.
- **Vocabulary conventions** (§6): the calling-convention discipline for `role`/`context` names, without which independently-authored deltas don't compose.

The framing matters: assembly languages achieved interop not by restricting the instruction set but by layering conventions on top (cdecl, ELF, ABIs). Naming divergence and conflict handling are *convention* problems and live here — not at L1 (which accepts any vocabulary) and not at L2 (which has no opinions about truth).

## 2. The `resolve` Boundary

`resolve : Policy → HView → View` (SPEC-2 §4.7) is the only exit from the algebra. Its contract:

- **Deterministic:** same (HView, Policy) ⇒ identical View, byte-for-byte canonical. All pluralism is in policy choice, never in evaluation (P5).
- **Total:** every policy MUST produce a defined result for every HView, including the empty-property and all-negated cases (§4).
- **Provenance-optional, never provenance-destroying upstream:** a View may discard provenance; the HyperView beneath it never does. `explain` (SPEC-4 §7) reconstructs any View value's justification.

The same HyperView legitimately yields different Views under different policies, simultaneously, within one application: an admin surface resolving `surfaceAll`, a public API resolving `trustedAuthors`, a quality dashboard resolving `conflictsOnly`. This is the original "feature, not a bug," now with a normative shape.

## 3. Policy Terms

Policies are terms in a closed grammar — serializable as deltas, federate-able, and pinnable, exactly like schemas (P4 applies above the algebra too):

```
Policy      ::= object( Map<propertyName, PropPolicy>, default: PropPolicy )

PropPolicy  ::= pick(Order, Tiebreak)        // collapse to one value
              | all(Order)                   // array of all surviving values
              | merge(MergeFn)               // closed combiners: §3.1
              | conflicts(Order)             // values only if ≥2 distinct survive
              | absentAs(Const, PropPolicy)  // default for empty properties

Order       ::= byTimestamp(desc|asc)
              | byAuthorRank(AuthorId[])     // explicit trust list, first match wins
              | byPred(Pred, then: Order)    // partition by predicate, prefer matches
              | lexById                      // deterministic last resort

Tiebreak    ::= lexById                      // MUST terminate in a total order

MergeFn     ::= max | min | sum | count | and | or | concatSorted
```

Normative notes:

- Every `Order` chain MUST bottom out in `lexById` (delta content hashes give a canonical total order), guaranteeing determinism even among byte-equal claims from distinct deltas.
- `byAuthorRank` is the trust primitive. Trust *lists* are data (representable as deltas), so trust is queryable, forkable, and federated like everything else.
- `MergeFn` is a closed set by the same argument as SPEC-2 §1: arbitrary reducers cannot ship inside policy terms. They are not second-class, however — they are **derived authors** (SPEC-7). *(Open: whether aggregation pressure forces algebra-level support — tracked at SPEC-2 §9.)*
- **Computed resolution is architecture, not workaround.** Any resolution requiring general computation or judgment — domain-specific reducers, statistical combiners, human review queues, LLM adjudication, semantic matching — is performed by a derived author: an identified function subscribed to the relevant materialization, emitting its verdicts as signed deltas (optionally negating losers). The application's policy then resolves with `byAuthorRank([thatAuthor, …])`. The judgment becomes reactive (recomputed when inputs change, not on every read), cached (a delta, evaluated once), versioned (new function hash = new author), and auditable (`explain` traces the value to the function and the exact input hashes it saw). `resolve` stays deterministic; intelligence enters the system as provenance-carrying data. The cost, stated plainly: computed resolutions are eventually consistent with their inputs (SPEC-7 §5).

## 4. Edge Semantics (Normative)

- **Empty property:** `pick` over zero entries yields *absent* (key omitted from the View) unless wrapped in `absentAs`. Views never contain null (mirrors SPEC-1 §2.1).
- **All entries negated** under the schema's `mask(drop)`: indistinguishable from empty — negation already happened upstream. Policies see only survivors.
- **`mask(annotate)` schemas:** entries carry a negation tag; policies MAY use `byPred` over it (audit views that *show* retractions).
- **Type heterogeneity:** competing claims of different primitive types are legal (someone asserted `size: 3`, someone `size: "large"`). `pick` is type-blind; `merge(max)` over mixed types MUST resolve by canonical type order (bool < number < string) then value — defined, deterministic, and ugly, which is the correct incentive to fix it with vocabulary discipline (§6) or negation.

## 5. View Output Profiles

A View is canonical CBOR/JSON. Profiles (informative): a GraphQL resolver maps each property's PropPolicy to a field resolver over the HyperView — the legacy README's resolver examples become *generated code from policy terms*. REST/JSON and language-native object mappings follow the same pattern. All profiles MUST preserve the determinism contract; presentation may reorder, never re-adjudicate.

## 6. Vocabulary: the Calling Convention

L1 accepts any `role`/`context` strings; composition across authors requires convention. Normative framework (specific vocabularies are ecosystem artifacts, not spec content):

- **Namespacing:** vocabulary names SHOULD be dot-namespaced (`rdb.*` reserved for the spec itself — SPEC-3 §5; `org.example.*` for applications). Bare names are legal and considered local dialect.
- **Vocabularies as data:** a vocabulary is an entity; its terms, documentation, and deprecations are deltas. Publishing a vocabulary is publishing deltas (P3, again).
- **Aliases as deltas:** cross-vocabulary mapping (`parent` ≡ `container`) is asserted by *alias deltas* in a normative `rdb.alias` vocabulary. Schemas opt in: `StrMatch` gains `aliased(string, via: VocabRef)` *(proposed; needs L2 vectors)*, expanding to the alias closure at term-validation time — so aliasing is static and inspectable, never a runtime fuzzy match.
- **Semantic/embedding-based matching:** MUST NOT participate in evaluation (determinism and convergence forbid fuzzy semantics below the View). It enters the system in two sanctioned forms: as an authoring-time suggestion tool (lint: "these contexts look synonymous — assert an alias?"), and as a **derived author** (SPEC-7) continuously emitting `rdb.alias` deltas — fuzzy judgment running live, with its hunches recorded as negatable, provenance-carrying claims rather than as nondeterminism inside the evaluator.
- **Enforcement point:** mutation helpers (SPEC-4 §6). The convention is enforced where deltas are *born*, audited by registry lint, and repaired by alias deltas — never by rejecting well-formed deltas at L1.

## 7. Open Questions (L5)

- `aliased` StrMatch: confirm static-expansion semantics and DAG-check interaction (alias chains must be acyclic).
- Policy composition: can policies import/extend other policies (a trust list shared across an org)? Likely yes via evolvable refs (SPEC-3 §6 semantics apply); needs vectors for the pin-recording requirement.
- Standard library: a small set of blessed, pinned policies (`latest`, `trusted(list)`, `surfaceAll`) shipped as conformance vectors so common cases are interoperable by hash.
- Schema/vocabulary case-sensitivity ergonomics: spec says case-sensitive (SPEC-1 §2.1); lint guidance for the inevitable `Name`/`name` collisions.
- **Transactional completeness policies:** "only resolve claims whose full transaction is present." `Pred` is single-delta, so completeness can't be tested inline; the lean is reactor-asserted completeness annotations (SPEC-4 §6) made selectable via `byPred`. Needs the annotation vocabulary pinned and vectors written.
