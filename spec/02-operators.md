# Rhizomatic Specification — SPEC-2: The Operator Algebra (L2)

**Status:** Draft
**Layer:** L2 — instruction set
**Depends on:** SPEC-0, SPEC-1

---

## 1. Purpose

L2 is the assembly language of the system: a **small, closed, serializable, decidable** set of operators over delta sets and hyperviews. Every schema, query, index subscription, and federation filter in the system MUST compile to a term in this algebra. Nothing above L1 may require shipping arbitrary computation between instances; instances exchange **terms, not code** (P4).

This closure property simultaneously delivers:

- **Schemas as data** — terms have a finite grammar, so they serialize as deltas (SPEC-3 §5). Arbitrary functions do not.
- **Incremental indexing** — terms are *inspectable*, so a reactor can decide cheaply, per incoming delta, which materializations it affects (SPEC-4 §4). Opaque predicates force full re-evaluation.
- **Safe federation** — a received term can only do what the algebra can do. Sandboxing by construction.
- **Optimization** — terms admit algebraic rewrites (predicate pushdown, common-subterm sharing), exactly as relational algebra underwrites SQL optimizers.

Excluded from the instruction set, deliberately: arbitrary predicates, user-defined functions, recursion at the term level, arithmetic beyond comparison, string manipulation beyond equality and prefix. **The exclusions are the design.** A Turing-complete escape hatch would mean shipping trust instead of terms. Arbitrary computation is not banished from the system — it is relocated to the derivation layer (SPEC-7), where it runs with an identity, by consent, and its outputs re-enter L1 as signed deltas. The kernel stays closed; the userland stays open.

## 2. Sorts (the type system)

The algebra is many-sorted. Every operator's signature is fixed.

```
DSet    — a set of deltas                            (the L1 unit)
HView   — a hyperview: { id: EntityId,
                          props: Map<string, HVEntry[]> }
HVEntry — a delta whose pointers may have been
          recursively expanded into nested HViews
Pred    — a predicate term (restricted grammar, §3)
Schema  — a resolution schema term (defined in SPEC-5,
          referenced here for `resolve`)
View    — a plain resolved value/object (SPEC-5)
```

Closure: every operator maps these sorts to these sorts. Composition can never leave the algebra.

## 3. Predicate Grammar (`Pred`)

Predicates are first-order, quantifier-free formulas over **delta fields only**:

```
Pred  ::= match(Field, Cmp, Const)
        | hasPointer(PPred)
        | and(Pred, Pred) | or(Pred, Pred) | not(Pred)
        | inView(Term, Field, Extract)       // reflective, stratified — §3.1
        | true | false

Extract ::= field(author | id) | role(string)

PPred ::= ppred(role?: StrMatch,
                targetEntity?: EntityId,
                targetDelta?: Hash,
                context?: StrMatch,
                targetIsPrimitive?: bool,
                targetValue?: ValMatch)

ValMatch ::= vcmp(Cmp, Primitive)            // compare primitive pointer targets
           | between(Primitive, Primitive)   // inclusive range (numbers, lex strings)
           | inSet(Set<Primitive>)

Field ::= author | timestamp | id
Cmp   ::= eq | neq | lt | lte | gt | gte | prefix | inSet
Const ::= Primitive | Hash | AuthorId | Set<Const>

StrMatch ::= exact(string) | prefix(string) | inSet(Set<string>)
```

Normative properties:

- **Total and terminating:** evaluating any `Pred` against any delta is O(|delta|). No recursion, no fixpoints, no data dereference — a predicate sees one delta at a time, never the rest of the set (this preserves context-freeness at the instruction level), with the single stratified exception of `inView` (§3.1), which is resolved to a constant set *before* per-delta evaluation. Anything requiring general cross-delta logic (e.g., "select only corroborated claims") remains inexpressible here by design; it belongs at L7 (SPEC-7), where a derived author can compute corroboration and assert it as a delta that *then* becomes selectable. `inView` carves out exactly one cross-delta question — *membership in a view over the same set* — because trust rosters and grant lists are views, and freezing them into predicate constants forfeits the always-current property that makes them data (P3).
- **Value predicates are single-delta:** `targetValue` compares the primitive sitting on a pointer of *this* delta; comparison across primitives of different deltas is cross-delta logic and excluded. Mixed-type comparisons resolve by the canonical type order of SPEC-5 §4.
- **Bytes are invisible to predicates:** value predicates (`targetValue`/`ValMatch`) see only *primitive* payloads; a `bytes` target (SPEC-1 §2) satisfies no value predicate, and bytes never appear as a term `Const` or a hole binding — predicate constants stay `string | number | bool`. This is why the `bytes` kind grows the L2 grammar by exactly zero (SPEC-1 ERRATA D12). Pointer predicates (`hasPointer`) still see a bytes pointer's `role` like any other.
- **Value predicates are indexable:** `ValMatch` over `(role, value)` pairs is the contract behind the reactor's value index (SPEC-4 §3), making range queries (`releaseYear between 1990–1999`) sublinear. (Primitive targets carry no context — SPEC-1 §2 — so the pointer's role is what names a primitive payload.)
- **One total order everywhere:** comparisons (`ValMatch`, `match` ordering, and SPEC-5 §4 mixed-type resolution) use a single canonical order — **type rank first (bool < number < string), then value**. Booleans: false < true. Numbers: IEEE-754 order (finite only, by L1 validation). Strings: **bytewise order of the NFC UTF-8 encoding** — not UTF-16 code-unit order, which diverges for astral-plane characters. This matches CBOR map-key ordering; implementations whose native string comparison is UTF-16 must compare encoded bytes. Cross-type `eq` is always false; cross-type ordering follows type rank.
- **Decidable subsumption (goal):** for the reactor's dispatch optimization, implementations SHOULD be able to test `Pred₁ ⊑ Pred₂` (every delta matching 1 matches 2). The grammar is kept within a decidable fragment for this reason; extensions MUST preserve it.
- `timestamp` comparisons enable time-travel as a filter (`match(timestamp, lte, T)`); per SPEC-1 §6 these range over *claimed* time.

### 3.1 Reflective predicates (`inView`)

`inView(t, f, x)` tests a facet of the candidate delta against a set computed from the **same
delta set** the enclosing evaluation received. It is the trust-set-as-view primitive: "honor
negations from authors currently holding a surviving, operator-rooted grant" is a view over the
grant deltas, and this predicate lets masks and selects reference that view without freezing it
into static policy data.

```
inView(t, f, x)(d) over ambient input I  =  f(d) ∈ extract(x, eval(t, I))
```

Normative semantics:

- **The sub-term `t`** MUST be one of the reflection-free DSet-sort roots `input` | `select` |
  `union` | `mask`; any other root operator is rejected at parse time. This is an explicit
  allowlist, not "any DSet-sort term": `difference`/`intersect` (§4.9), though DSet-sort, are
  deliberately **not** admitted as reflective sub-terms in `alg: 1` — no consumer needs a
  reflected view defined by exclusion, and adding them later is an additive, parse-visible
  extension (§8, no bump). It is evaluated against the **ambient input** — the full
  delta set the enclosing evaluation received, *not* the enclosing operator's operand — with the
  same ambient root and hole bindings. (A grant landing anywhere in the set may flip a negation's
  standing, even when the enclosing mask's operand is a narrow selection.) A `mask(annotate)`
  sub-result contributes its member set; the tag channel is dropped, consistent with §4.3.
- **`extract`** produces a set of strings from the sub-result's deltas. `field(author)` /
  `field(id)` take that facet of each delta. `role(r)` takes, for every pointer with role `r`:
  an EntityRef's entity id, a DeltaRef's delta id, a primitive string as itself; primitive
  non-strings contribute nothing.
- **The candidate test** compares the candidate delta's `Field` (`author` | `id`) for membership
  in the extracted set, under the canonical string equality of §3.
- **Stratified, depth 1:** `inView` MUST NOT appear anywhere within `t` — rejected at parse time.
  The sub-evaluation is therefore one nested pass of the reflection-free algebra: total,
  terminating, and inside the §5 complexity envelope.
- **Sites:** `inView` is legal only where predicates meet the data — `select`'s predicate and
  `mask(trust)`'s predicate. It MUST be rejected at parse time inside SPEC-5 policy predicates
  (`byPred`) and inside `aliased` trust predicates (SPEC-9), which are required to be closed.
- **Resolution timing:** the reflected set is computed **once per operator application**, before
  per-delta evaluation. Implementations SHOULD lower `inView` to the equivalent `inSet` form at
  that point (mirroring hole substitution and alias expansion); the lowered predicate is inside
  the §3 fragment, so per-delta evaluation and subsumption reasoning are unchanged. Evaluation
  stays a pure function of `(term, I)`: same deltas ⇒ same reflected set ⇒ same result, on every
  machine — content-addressed convergence is untouched.
- **Reactor impact:** a term containing `inView` depends on deltas outside its operand's scope;
  dispatch MUST treat it conservatively (SPEC-4 §4.2). Narrowing that is future work, not license
  to under-match.

## 4. The Instruction Set

Ten operators. Each entry: signature, semantics, notes.

### 4.1 `select : Pred → DSet → DSet`

```
select(p, D) = { d ∈ D : p(d) }
```

The σ of the system. Defines relevance boundaries; every schema begins here. Commutes with union; composes by predicate conjunction: `select(p, select(q, D)) = select(and(p,q), D)`.

### 4.2 `union : DSet → DSet → DSet`

Set union by `id`. Its companions `intersect` (∩) and `difference` (−) are first-class operators
too — see §4.9. The three together are the boolean set algebra over delta sets. (Historically ∩/−
were noted here as *derivable within one set* — `select(and(p,q))`, `select(and(p, not(q)))` — but
that derivation only reaches predicates over a single delta; differencing one *term* against
another needs the operator, ERRATA-2 E17.)

### 4.3 `mask : MaskPolicy → DSet → DSet`

Negation-awareness. Given the conventional negation vocabulary (SPEC-1 §7):

```
negated(d, D) = ∃ n ∈ D : n has pointer {role:"negates", target: DeltaRef(d.id)}
                ∧ ¬ negated(n, D)            // well-founded: see below
```

Negation chains terminate because `DeltaRef`s are content addresses: a delta can only reference deltas that existed before it was created, so the "negates" graph is a DAG and the recursion is well-founded. Even-length chains reinstate; odd-length suppress.

```
MaskPolicy ::= drop            // remove negated deltas
             | annotate        // keep, tagged as negated (audit views)
             | trust(Pred)     // only negations matching Pred count
```

`mask` is the only operator whose evaluation of one delta consults other deltas; it is therefore the unit the reactor tracks most carefully (SPEC-4 §4.3).

Pinned semantics:

- `mask(trust(p), D)` behaves exactly like `mask(drop, D)` computed over the restricted negation candidate set `{ n ∈ D : p(n) }`: only trusted negations negate, and negation-of-negation chains are walked within the trusted set only.
- The `negated(d, D)` recursion is well-founded because `DeltaRef`s are content addresses — a cycle would require a hash collision, and sets verify every id on insert. Implementations still guard the recursion (memoized, with an in-progress default of "not negated") so adversarial input degrades safely instead of overflowing a stack.
- `mask(annotate)`'s tag channel is a property of the **immediate operand only**: it is consumed by the next operator (`group` threads tags into HVEntries) or dropped — it does not survive `select` or `union`. The audit idiom is therefore `group(key, mask(annotate, …))` with no DSet operator between. (Threading the channel through set-preserving operators would be an `alg`-versioned addition.)

### 4.4 `group : GroupKey → DSet → HView`  *(for a given root entity)*

```
group(key, D) @ root =
  HView{ id: root,
         props: partition D by key(d, root) }

GroupKey ::= byTargetContext     // default: the pointer targeting `root`
                                 // files d under that pointer's `context`
           | byRole              // file under the role of the root-targeting pointer
           | const(string)       // file everything under one property
```

This is the π-flavored operator: it imposes the property structure of an object onto a flat set of edges. The default `byTargetContext` is exactly the legacy `Reference.context` behavior, now one choice among a closed set rather than a baked-in rule.

Filing rules (normative):

- Only pointers whose target is an `EntityRef` with `id == root` are **filing pointers**.
- `byTargetContext`: the delta files under each filing pointer's `context`; a filing pointer without a context files nothing (a property needs a name), and a delta with no filing pointer is excluded from the HView entirely.
- `byRole`: the delta files under each filing pointer's `role` (roles are always present).
- `const(s)`: **every** delta in the operand files under `s` — no filing pointer required (the "bag it all" projection).
- A delta may file under several properties (one per distinct filing key); within one property a delta appears once (entries are unique by delta id).
- The empty result is `HView{id: root, props: {}}` — present id, empty props, never null (SPEC-3 §7).

### 4.5 `expand : (role: StrMatch, program: SchemaRef, reading: SchemaRef) → HView → HView`

For each delta in each property of the hyperview, for each pointer whose role matches: replace the pointer's `EntityRef` target with the HView produced by evaluating `program` rooted at that entity, **against the same DSet the enclosing evaluation received**.

- `SchemaRef` is a *name or pinned hash* (resolved through the schema registry, SPEC-3 §5), not an inline lambda — this is what keeps the term grammar finite and the DAG constraint checkable.
- **`reading` names the child's resolution Schema** — the other half of the child's lens (issue #23). The term states both halves explicitly: `schema` is how the child *gathers*, `reading` is how the child *resolves* when the expansion later crosses the `resolve` boundary (SPEC-5 §4). `reading` refs resolve against the registry's resolution-Schema index and are validated at registry build exactly as gather refs are (SPEC-3 §5). A pinned reading is `{pinned: <schema content address>}` — Schemas are content-addressed, same multihash as terms.
- `reading` is **required in the current vocabulary**. A *legacy* body (predating this field) still parses and its gather evaluates unchanged, but resolving one of its expansions is a loud error — there is deliberately **no fallback to the parent's Schema** (SPEC-5 §4). Applying the parent's resolution program to a child's hyperview was the pre-#23 behavior and only ever read sensibly when prop names collided harmlessly; it is a defect, not a default. Migration for legacy stores is unambiguous: every legacy body predates reading-coexistence, so each hyperschema had exactly one Schema — re-sign the body naming it.
- `reading` lives in the hyperschema body, so all sibling readings over a gather share the *child's* reading — "what a post *is* when embedded here" is part of the gather program's identity, not of any particular parent lens. **This is in deliberate tension with coexistence** (many resolution Schemas over one HyperSchema), which motivated this field in the first place: two lenses that disagree about the parent must nonetheless agree about the child. The tension is resolved by construction rather than by mechanism — a gather whose children need a different reading *is a different gather program*, and publishing a body variant is one delta, since bodies are content-addressed data. If a consumer ever needs one gather to serve per-lens child readings, the pre-designed escape is parameterization, not a new rule: `reading: {hole: <name>}` bound at `fix` time by the existing hole mechanism (§6, E15), which is additive and shape-distinguishable. Until a consumer demands it, the shared reading is the honest default — it keeps the child's meaning pinned in the program that embeds it.
- Expansion termination is guaranteed by SPEC-3's DAG requirement on schema references, not by anything in L2; L2 merely demands that `SchemaRef` resolution be acyclic at validation time. (Readings cannot recurse — a resolution Schema references no schemas — so they add no edges to the DAG.)
- Joins, in relational terms, are *already materialized* in delta pointers; `expand` is join-navigation, not join-computation.

Replacement form: `expand` replaces a matching pointer's `EntityRef` target with the HView evaluated at that entity, **against the same delta set the enclosing evaluation received**. In the canonical HVEntry encoding the replaced target is the nested HView map `{"id", "props"}` instead of the EntityRef map (the discriminator is the presence of `"props"`). The delta's true id and claims are never re-hashed with replacements — expansion is view structure, not data; provenance stays intact, with the in-memory entry keeping the original delta plus an expansion table keyed by pointer index (authored pointer order is hash-significant and stable, SPEC-1 §4.1). Pointers whose target is a primitive or DeltaRef never expand; a role-matching EntityRef pointer expands; everything else passes through as written (SPEC-3 §7 graceful degradation).

### 4.6 `prune : (roles: StrMatch | all) → HView → HView`

Drop pointers (or whole property entries) not matching. Projection's other half: `group` shapes, `prune` narrows. Guarantees that schemas can produce *minimal* hyperviews, which matters for federation payloads and index footprints.

### 4.7 `resolve : Schema → HView → View`

The boundary instruction — the only way out of the algebra into application space. Collapses each property's delta superposition into a value (or values) according to a `Schema` term (SPEC-5). Deterministic given (HView, Schema).

`resolve` is *in* the instruction set so that views, too, are specifiable as data and reproducible across instances; but its output sort `View` is terminal — no operator consumes a `View`.

### 4.8 `fix : SchemaRef → EntityId → DSet → HView`

The invocation instruction: evaluate the named schema program at the given root over the given set. (Named `fix` for "fix a perspective," not fixpoint — there are no fixpoints in this algebra.) Top-level queries are `fix` applications; `expand` is internal `fix`.

Registry and the root variable:

- A **HyperSchema** is `{name, alg, body}` where `body` is an HView-sort term (SPEC-3 §2). The **registry** is an explicit evaluation input mapping references to schemas; `refs` are derived from the body (every `expand`/`fix` schema reference), not separately declared — equally static and checkable. Registry construction rejects duplicate names, unresolved refs, and reference cycles (SPEC-3 §3); *data* cycles remain legal and terminate because the schema chain terminates.
- Schema bodies are functions of their root: predicates may use the **root variable** (`targetEntity: {"var": "root"}`), resolved against the ambient root at evaluation time. A root-variable predicate evaluated with no ambient root matches nothing.
- `fix` sets the ambient root to its entity explicitly (ignoring any enclosing root); `expand` sets it to each expanded target entity. `fix`'s optional `bindings` introduce the ambient hole environment (§6), flowing through `expand` beneath it.

### 4.9 `difference` and `intersect` — the rest of the set algebra

```
difference : DSet → DSet → DSet        difference(of, without) = { d ∈ of : d.id ∉ ids(without) }
intersect  : DSet → DSet → DSet        intersect(left, right)  = { d ∈ left : d.id ∈ ids(right) }
```

The two companions of `union` (§4.2). With `union` they close the boolean algebra over delta sets:
`∪`, `∩`, `∖`. Both are **whole-delta, keyed by content-addressed `id`**, DSet-sort in and out, and
nestable to any depth — a `difference` may difference against a `difference`, which the reflective
`select(not(inView(…)))` route cannot express (it is stratified at depth 1, §3.1). This composability
is the point: containers defined relative to other containers (read scope = active containers ∖
excluded containers) need it (ERRATA-2 E17).

Pinned semantics:

- **Keying is by `id` only** — membership in `without`/`right` is decided by delta id, the content
  address, so identical claims from the same author collapse to one member (SPEC-1 §4.1) and the ops
  inherit set semantics for free. Neither op inspects claims; they are pure set operations over the
  operand results.
- **`difference` is asymmetric**, hence `of`/`without` (not `left`/`right`): it keeps members of `of`
  absent from `without`. `intersect` is symmetric and mirrors `union`'s `left`/`right`.
- **The annotate tag channel does not survive** (§4.3, E14): if an operand is a `mask(annotate, …)`,
  its `negated` tags are dropped — a set-op result is a plain DSet, never the `{ids, negated}` map.
  The audit idiom stays `group(key, mask(annotate, …))` with no DSet op between.
- **Empty operands are ordinary:** `intersect` with an empty operand is `∅`; `difference(of, ∅) =
  of`; `difference(X, X) = ∅`. No set literals exist in the algebra (E17 Q7).

## 5. Evaluation Semantics

Evaluation is a pure function:

```
eval : Term × DSet → (DSet | HView | View)
```

- **Deterministic (P5):** same term, same set ⇒ identical canonical output. Conformance vectors test this byte-for-byte.
- **Order-blind:** no operator may observe delta-set ordering or pointer ordering (SPEC-1 §4.1).
- **Monotone where claimed:** `select`, `union`, `group`, `expand`, and `intersect` are monotone in `D` (more deltas in ⇒ superset of deltas out). `mask` and `resolve` are **not** monotone (a new negation can remove; a new claim can change a resolved value). `difference` is monotone in its `of` operand but **antitone in `without`**: a delta landing in the `without` sub-result *removes* an output, so the reactor must treat the `without` branch as a retraction source, exactly like a negation edge (SPEC-4 §4.3). This split is normative: it tells the reactor exactly which operators need retraction logic (SPEC-4 §4.3). A `select` whose predicate contains `inView` (§3.1) forfeits monotonicity: a delta landing anywhere can shrink the reflected set (a revocation negating a grant), removing previously selected deltas. Reflection-free `select` remains monotone.
- **Complexity envelope:** for a term `t` and set `D`, evaluation MUST be achievable in O(|D| · |t|) without indexes; the entire point of L4 is to do far better incrementally.

Canonical result encodings (what the conformance vectors compare, byte for byte):

- **DSet result:** the canonical CBOR array of member ids as text strings, sorted lexicographically. A top-level `mask(annotate, …)` result is instead the map `{"ids": [...], "negated": [...]}` (both sorted; `negated` ⊆ `ids`).
- **HView result:**

```
HView   = CBOR map { "id": tstr(root), "props": map { propertyName: [HVEntry...] } }
HVEntry = CBOR map { "id": tstr(deltaId), "claims": <canonical claims map, SPEC-1 §4.1>,
                     "sig"?: tstr, "negated"?: true }
```

Map keys sort canonically; entries within a property sort by delta id. The `negated` flag appears only when true and only when the grouped operand was a `mask(annotate)` result. Expanded entries replace targets per §4.5.
- **View result:** SPEC-5 §5.

## 6. Relational Completeness

Claim: the algebra expresses Codd's six primitive operations over relations encoded as delta sets. Sketch (full proof + vectors are a conformance deliverable):

| Relational | L2 encoding |
|---|---|
| Selection σ_p | `select(p̂)` where p̂ translates attribute predicates to `hasPointer` predicates |
| Projection π_A | `group` + `prune(A)` |
| Cartesian product × / Join ⋈ | joins are materialized as multi-pointer deltas at write time; navigational join is `expand`. Ad-hoc ×: derivable as a schema over pair-entities — see proof doc *(open: whether ad-hoc product needs an additional operator or is acceptable as a write-time encoding)* |
| Union ∪ | `union` |
| Difference − | `difference(of, without)` (§4.9) — first-class; `select(and(p, not(q)))` remains the single-set special case |
| Intersection ∩ | `intersect(left, right)` (§4.9) — first-class; `select(and(p, q))` remains the single-set special case |
| Rename ρ | vocabulary mapping at L5 (an ABI concern, not an algebra concern) |

The honest open edge is ad-hoc product/join over entities not already linked by deltas. Position of this spec: Rhizomatic stores **materialized joins** (P-claim of the original design); ad-hoc joins are an L4 index/query-planner facility built *from* L2 terms, not a missing instruction. This is flagged for the formal proof to confirm or refute.

## 7. Serialization of Terms

Terms have a finite grammar and therefore canonical encodings:

1. **As CBOR** — for transport and hashing: serialize the term AST to its normalized JSON-profile structure (a deterministic serializer — optional fields omitted, strings NFC, bindings keys sorted), interpret that structure in the generic CBOR data model (object→map, array→array, string→tstr, number→float, bool→bool), and encode under the SPEC-1 §4.1 rules. Parse∘serialize is identity on the AST, so semantically identical terms hash identically regardless of authored JSON spelling.
2. **As deltas** — the normative at-rest form (SPEC-3 §5): each term node is an entity; each edge (operator → operand) is a delta. Terms are thereby queryable, forkable, negatable, and federated like everything else (P3: the stored-program property).

A term's content address is the hash of its canonical CBOR; `SchemaRef` MAY pin a specific term hash (immutable reference) or name an entity whose current definition is itself resolved through evaluation (evolvable reference). Both modes are normative; SPEC-3 §6 defines their interaction.

## 8. Versioning the Instruction Set

The algebra version (`alg`) is carried **once, by the HyperSchema wrapper** (`{name, alg, body}`,
§4.8) — the current value is `1`. It is *not* restated on every term node; a bare term, and a term
serialized as deltas (§7.2), do not repeat it. (Earlier prose here said `alg` "is part of every
serialized term"; that was imprecise — the version rides the wrapped program, ERRATA-2 E17.)

**What forces a bump.** An `alg` bump (major) is required **if and only if** the change is *not
parse-visible* — i.e. it alters the meaning of a form a predating implementation already accepts
(same bytes, new semantics). There, and only there, an old witness would *silently* produce a
different result, which on an instruction set is corruption; the version number is the guard.
Implementations MUST reject terms whose `alg` they do not implement, and MUST NOT partially
evaluate them.

**What does not force a bump — and the fail-closed rule that makes that safe.** Additive,
parse-visible changes — a new operator, a new mask policy, a new predicate form, a new order —
need **no** bump. The profiles in §9 and SPEC-5 §7 are **closed enumerations**, so a conformant
implementation that predates the extension meets an unrecognized tag and rejects it *at parse
time, loudly, before any evaluation*. That rejection **is** the safety a bump would have provided,
so the bump would be redundant. This holds only because rejection is mandatory:

> **A conformant parser MUST fail closed on any unrecognized tag in a closed enumeration** — an
> unknown `op`, `policy`, `key`, `cmp`, `extract`, order, or predicate constructor. It MUST NOT
> ignore, skip, or best-effort a term it does not fully recognize.

The rule governs **three** kinds of unrecognized input, not one — tags were merely the first to be
written down (ERRATA-2 E19, issue #25). All three are the same failure: input the witness silently
ignores, which is *repair* in the SPEC-4 §2 sense.

> **1. Unknown tags** (above). **2. Unknown keys:** every object node in the §9 term profile and
> the SPEC-5 §7 schema profile is a **closed record** — a parser MUST reject any key outside that
> node's declared set. **3. Ambiguous tags:** a one-of node (`StrMatch`, `ValMatch`, `Pred`,
> `Order`, `Policy`, `GroupKey`, `SchemaRef`, `inView.extract`) carries **exactly one** arm;
> two or more present is ambiguous and MUST be rejected, never resolved by declaration order.

Exactly two nodes in the whole profile are **open**, because their keys are author-chosen data
rather than grammar: `fix.bindings` (hole names, §6) and a Schema's `props` (property names,
SPEC-5 §7). Every other object node is closed. An implementation SHOULD make this structural — if
the key set is a required argument of the object-parsing helper, the compiler, not vigilance,
guarantees no node is left lax.

Why keys matter as much as tags: the whole no-bump story rests on an old witness *refusing* what
it does not understand. A dropped key does the opposite — it silently reinterprets a newer body as
an older, still-valid program. Two peers on different versions then produce different results from
the same term with neither erroring, which is a silent semantic fork rather than a detectable
partition (the same hazard, one layer up, that SPEC-1 §5.1 pins for signatures).

**Rejection message (SHOULD).** Because additive operators enter *without* an `alg` bump, an
unrecognized tag most often means **version skew** — the term was authored by a newer witness.
Implementations SHOULD name the offending tag and point at that possibility rather than emit a bare
parse error, e.g. *"unknown operator `difference` — this term may have been generated by a newer
rhizomatic/loam; check whether support for it shipped in a release you haven't installed."* Note
the `alg` number **cannot** carry this diagnosis: an additive feature shares the `alg` of the
witnesses that predate it (§4.9 entered at `alg: 1`, unchanged), so a per-node `alg` would not
distinguish "supports `difference`" from "doesn't." The **tag name** is the actionable signal;
this is also why `alg` stays on the wrapper and is not restated per node (ERRATA-2 E17).

This reconciles a contradiction in the prior text, which said both "adding an operator is a major
version" *and* (for `inView`/`chain`) that parse-visible additions need no bump. The first was
over-broad: an operator added to the closed §9 profile **is** parse-visible — an old parser hits an
unknown `op` and rejects — so it enters under the parse-visible rule like any other closed-grammar
extension. `inView` (§3.1), `chain` (SPEC-5 §3), and now `difference`/`intersect` (§4.9) all enter
this way. The negative conformance vectors (`rejects[]` in `vectors/l1-eval/eval-setalgebra.json`)
pin the fail-closed behavior across both witnesses — it is a parity requirement, not merely a
consumer-protection one.

## 9. Appendix: Term JSON Profile (Normative)

The JSON spelling of terms and predicates — the authoring surface, and the form the conformance
vectors and the canonical CBOR pipeline (§7) consume:

```
Term ::= "input"                                          // the delta set under evaluation
       | { "op": "select",     "pred": Pred, "in": Term }
       | { "op": "union",      "left": Term, "right": Term }
       | { "op": "intersect",  "left": Term, "right": Term }   // §4.9
       | { "op": "difference", "of": Term,  "without": Term }  // §4.9 (asymmetric: of ∖ without)
       | { "op": "mask",    "policy": MaskPolicy, "in": Term }
       | { "op": "group",   "key": "byTargetContext" | "byRole" | { "const": string }, "in": Term }
       | { "op": "prune",   "keep": "all" | StrMatch, "in": Term }
       | { "op": "expand",  "role": StrMatch, "schema": SchemaRef, "reading": SchemaRef, "in": Term }
         // "reading" required in the current vocabulary (§4.5); omitted only by legacy bodies,
         // which keep byte-identical hashes and whose expansions refuse to RESOLVE (SPEC-5 §4)
       | { "op": "fix",     "schema": SchemaRef, "entity": EntityId,
           "bindings"?: { name: Primitive, ... } }        // the hole environment (§6)
       | { "op": "resolve", "schema": Schema, "in": Term }   // Schema: SPEC-5 §7

MaskPolicy ::= "drop" | "annotate" | { "trust": Pred }
SchemaRef  ::= name | { "pinned": "<term hash>" }            // SPEC-3 §6

Pred ::= "true" | "false"
       | { "match": { "field": "author"|"timestamp"|"id", "cmp": Cmp, "const": Const } }
       | { "hasPointer": PPred }
       | { "and": [Pred, Pred] } | { "or": [Pred, Pred] } | { "not": Pred }
       | { "inView": { "term": Term, "field": "author"|"id", "extract": Extract } }   // §3.1

Extract ::= { "field": "author"|"id" } | { "role": string }

PPred ::= { "role"?: StrMatch, "targetEntity"?: string | {"var":"root"} | Hole,
            "targetDelta"?: string, "context"?: StrMatch,
            "targetIsPrimitive"?: boolean, "targetValue"?: ValMatch }
          // at least one field; all given fields must hold on the SAME pointer

StrMatch ::= { "exact": string } | { "prefix": string } | { "inSet": [string...] }
ValMatch ::= { "vcmp": { "cmp": Cmp, "value": Primitive | Hole } }
           | { "between": [Primitive, Primitive] }        // inclusive, canonical order (§3)
           | { "inSet": [Primitive...] }
Cmp  ::= "eq"|"neq"|"lt"|"lte"|"gt"|"gte"|"prefix"|"inSet"
Hole ::= { "hole": "<name>" }                             // Const position only; bound at fix (§6)
Const ::= Primitive | Hole | [Primitive...]               // array form only with cmp inSet
```

Parse-time validation: the profile is a **closed enumeration** — an unrecognized `op` (or any
unrecognized `policy` / `key` / `cmp` / `extract` / order / predicate tag) MUST be **rejected**,
loudly, before evaluation (§8 fail-closed rule); never ignored or best-effort. `intersect` requires
`left`/`right`; `difference` requires `of`/`without` (supplying `union`'s `left`/`right` to
`difference`, or vice versa, is malformed). `prefix` requires string (or hole) operands; `match`
with `cmp: inSet` requires an array const; `and`/`or` take exactly two operands; an empty `PPred`
is rejected.
`inView.term` must parse as a DSet-sort term (`"input"` | `select` | `union` | `mask`) and must
not itself contain `inView` (§3.1 stratification); `inView` is rejected inside SPEC-5 policy
predicates and inside `aliased` trust predicates.
All strings in terms are NFC-normalized at parse time, so term-side comparisons are NFC-vs-NFC
with NFC-validated data. `resolve`'s operand must be HView-sort; its View result is terminal —
no operator consumes a View.

## 10. Open Questions (L2)

- **Aggregation:** count/sum/min/max as `resolve` policies (current position) or as algebra-level operators (needed if aggregates must feed back into selection)? Leaning policy-level until a counterexample forces otherwise.
- **Ad-hoc join:** confirm derivability or admit a ninth operator (§6).
- **Predicate subsumption algorithm:** specify the exact decidable fragment and its complexity; needed for reactor dispatch guarantees.
- **Parameterized terms:** queries want runtime parameters ("movies with actor *X*"). `hole(name)` leaves in Const position, bound by an optional `bindings` object on `fix`; terms stay first-order and a body with holes keeps a single hash however it is later bound. Semantics pinned in ERRATA-2 E15; vectors in `vectors/l1-eval/eval-holes.json`.
- **Cost annotations:** should terms carry optional optimizer hints, or is that strictly an L4 concern?
- **Reflective dispatch:** terms containing `inView` (§3.1) currently dispatch conservatively (every ingest may change the reflected set — SPEC-4 §4.2). Narrowing this — e.g., indexing the sub-term's own select predicates so only deltas relevant to the *reflected view* re-trigger — is an optimization awaiting a workload that needs it.
- **Reflective depth:** stratification is pinned at depth 1. A grant-view whose own mask wants a reflective trust predicate ("grants honored per the *grants of grants*") would need depth 2 or an explicit budget; no consumer exists yet, and depth 1 keeps the termination argument trivial.
- **Set-algebra incremental dispatch (E17 Q6):** `difference` is antitone in its `without` operand (§5) — a delta landing in the `without` sub-result retracts an output, so the reactor must track that branch as a retraction source (SPEC-4 §4.3), analogous to a negation edge. `intersect` is monotone in both. The exact dispatch narrowing (which incoming deltas can affect which branch) is L4 work; the monotonicity split is pinned now so the reactor knows where retraction logic is mandatory.
- **N-ary set algebra / literals (E17 Q7):** `union`/`intersect`/`difference` are binary, matching one another; there are no `∅`/`all` set literals and no variadic forms. Binary composes to any arity today. A variadic spelling or explicit literals would be an additive, parse-visible extension (no `alg` bump, §8) if a consumer ever wants the ergonomics.
- **Per-lens child readings (§4.5, issue #23):** `reading` is fixed in the gather body, so sibling resolution Schemas over one HyperSchema necessarily share the child's reading. The escape, if a consumer ever needs it, is a `hole` in reading position bound at `fix` time (parameterization, above) — additive and shape-distinguishable. Deliberately not built until a real workload asks: a differing child reading is currently expressed as a different gather body, which is one delta.
