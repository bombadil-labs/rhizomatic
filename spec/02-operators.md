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
Policy  — a resolution policy term (defined in SPEC-5,
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
        | true | false

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

- **Total and terminating:** evaluating any `Pred` against any delta is O(|delta|). No recursion, no fixpoints, no data dereference — a predicate sees one delta at a time, never the rest of the set (this preserves context-freeness at the instruction level). Anything requiring cross-delta logic (e.g., "select only corroborated claims") is not expressible here by design; it belongs at L7 (SPEC-7), where a derived author can compute corroboration and assert it as a delta that *then* becomes selectable.
- **Value predicates are single-delta:** `targetValue` compares the primitive sitting on a pointer of *this* delta; comparison across primitives of different deltas is cross-delta logic and excluded. Mixed-type comparisons resolve by the canonical type order of SPEC-5 §4.
- **Value predicates are indexable:** `ValMatch` over `(context, value)` pairs is the contract behind the reactor's value index (SPEC-4 §3), making range queries (`releaseYear between 1990–1999`) sublinear.
- **Decidable subsumption (goal):** for the reactor's dispatch optimization, implementations SHOULD be able to test `Pred₁ ⊑ Pred₂` (every delta matching 1 matches 2). The grammar is kept within a decidable fragment for this reason; extensions MUST preserve it.
- `timestamp` comparisons enable time-travel as a filter (`match(timestamp, lte, T)`); per SPEC-1 §6 these range over *claimed* time.

## 4. The Instruction Set

Eight operators. Each entry: signature, semantics, notes.

### 4.1 `select : Pred → DSet → DSet`

```
select(p, D) = { d ∈ D : p(d) }
```

The σ of the system. Defines relevance boundaries; every schema begins here. Commutes with union; composes by predicate conjunction: `select(p, select(q, D)) = select(and(p,q), D)`.

### 4.2 `union : DSet → DSet → DSet`

Set union by `id`. With `select`, gives ∪/∩/− over delta sets (∩ and − are derivable: `select(and(p,q))`, `select(and(p, not(q)))`).

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

### 4.5 `expand : (role: StrMatch, program: SchemaRef) → HView → HView`

For each delta in each property of the hyperview, for each pointer whose role matches: replace the pointer's `EntityRef` target with the HView produced by evaluating `program` rooted at that entity, **against the same DSet the enclosing evaluation received**.

- `SchemaRef` is a *name* (resolved through the schema registry, SPEC-3 §5), not an inline lambda — this is what keeps the term grammar finite and the DAG constraint checkable.
- Expansion termination is guaranteed by SPEC-3's DAG requirement on schema references, not by anything in L2; L2 merely demands that `SchemaRef` resolution be acyclic at validation time.
- Joins, in relational terms, are *already materialized* in delta pointers; `expand` is join-navigation, not join-computation.

### 4.6 `prune : (roles: StrMatch | all) → HView → HView`

Drop pointers (or whole property entries) not matching. Projection's other half: `group` shapes, `prune` narrows. Guarantees that schemas can produce *minimal* hyperviews, which matters for federation payloads and index footprints.

### 4.7 `resolve : Policy → HView → View`

The boundary instruction — the only way out of the algebra into application space. Collapses each property's delta superposition into a value (or values) according to a `Policy` term (SPEC-5). Deterministic given (HView, Policy).

`resolve` is *in* the instruction set so that views, too, are specifiable as data and reproducible across instances; but its output sort `View` is terminal — no operator consumes a `View`.

### 4.8 `fix : SchemaRef → EntityId → DSet → HView`

The invocation instruction: evaluate the named schema program at the given root over the given set. (Named `fix` for "fix a perspective," not fixpoint — there are no fixpoints in this algebra.) Top-level queries are `fix` applications; `expand` is internal `fix`.

## 5. Evaluation Semantics

Evaluation is a pure function:

```
eval : Term × DSet → (DSet | HView | View)
```

- **Deterministic (P5):** same term, same set ⇒ identical canonical output. Conformance vectors test this byte-for-byte.
- **Order-blind:** no operator may observe delta-set ordering or pointer ordering (SPEC-1 §4.1).
- **Monotone where claimed:** `select`, `union`, `group`, `expand` are monotone in `D` (more deltas in ⇒ superset of deltas out). `mask` and `resolve` are **not** monotone (a new negation can remove; a new claim can change a resolved value). This split is normative: it tells the reactor exactly which operators need retraction logic (SPEC-4 §4.3).
- **Complexity envelope:** for a term `t` and set `D`, evaluation MUST be achievable in O(|D| · |t|) without indexes; the entire point of L4 is to do far better incrementally.

## 6. Relational Completeness

Claim: the algebra expresses Codd's six primitive operations over relations encoded as delta sets. Sketch (full proof + vectors are a conformance deliverable):

| Relational | L2 encoding |
|---|---|
| Selection σ_p | `select(p̂)` where p̂ translates attribute predicates to `hasPointer` predicates |
| Projection π_A | `group` + `prune(A)` |
| Cartesian product × / Join ⋈ | joins are materialized as multi-pointer deltas at write time; navigational join is `expand`. Ad-hoc ×: derivable as a schema over pair-entities — see proof doc *(open: whether ad-hoc product needs a ninth operator or is acceptable as a write-time encoding)* |
| Union ∪ | `union` |
| Difference − | `select(and(p, not(q)))` |
| Rename ρ | vocabulary mapping at L5 (an ABI concern, not an algebra concern) |

The honest open edge is ad-hoc product/join over entities not already linked by deltas. Position of this spec: Rhizomatic stores **materialized joins** (P-claim of the original design); ad-hoc joins are an L4 index/query-planner facility built *from* L2 terms, not a missing instruction. This is flagged for the formal proof to confirm or refute.

## 7. Serialization of Terms

Terms have a finite grammar and therefore canonical encodings:

1. **As CBOR** — for transport and hashing, same canonicalization rules as SPEC-1 §4.1.
2. **As deltas** — the normative at-rest form (SPEC-3 §5): each term node is an entity; each edge (operator → operand) is a delta. Terms are thereby queryable, forkable, negatable, and federated like everything else (P3: the stored-program property).

A term's content address is the hash of its canonical CBOR; `SchemaRef` MAY pin a specific term hash (immutable reference) or name an entity whose current definition is itself resolved through evaluation (evolvable reference). Both modes are normative; SPEC-3 §6 defines their interaction.

## 8. Versioning the Instruction Set

The algebra version is part of every serialized term (`alg: 1`). Adding an operator is a major version; implementations MUST reject terms whose algebra version they do not implement, and MUST NOT partially evaluate them. (Silent degradation on an instruction set is corruption.)

## 9. Open Questions (L2)

- **Aggregation:** count/sum/min/max as `resolve` policies (current position) or as algebra-level operators (needed if aggregates must feed back into selection)? Leaning policy-level until a counterexample forces otherwise.
- **Ad-hoc join:** confirm derivability or admit a ninth operator (§6).
- **Predicate subsumption algorithm:** specify the exact decidable fragment and its complexity; needed for reactor dispatch guarantees.
- **Parameterized terms:** queries want runtime parameters ("movies with actor *X*"). Proposal: `hole(name)` leaf in `Const` position, bound at `fix` time; keeps terms first-order. Needs vectors.
- **Cost annotations:** should terms carry optional optimizer hints, or is that strictly an L4 concern?
