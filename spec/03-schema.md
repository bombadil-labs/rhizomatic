# Rhizomatic Specification — SPEC-3: Schemas & HyperViews (L3)

**Status:** Draft
**Layer:** L3 — programs
**Depends on:** SPEC-0, SPEC-1, SPEC-2

---

## 1. Purpose

L3 defines **HyperSchemas**: named, reusable, DAG-structured programs in the L2 algebra, and **HyperViews**, their outputs. If L2 is the instruction set, L3 is the compiled program format — including how programs are stored in the same memory as data (schemas as deltas, §5), which is the system's stored-program property (P3).

Almost no one should write raw deltas or raw operator terms by hand, for the same reason no one writes assembly: L3 (and DSLs compiled to it) is the intended authoring surface.

## 2. HyperSchema

A HyperSchema is:

```
HyperSchema {
  name:      EntityId          // the schema's identity in the rhizome
  alg:       number            // L2 algebra version
  body:      Term              // an L2 term of sort DSet → HView for a root entity
  refs:      SchemaRef[]       // every SchemaRef appearing in body (declared, checkable)
}
```

The canonical body shape (not mandatory, but the idiom virtually all schemas follow):

```
body(root) =
  group(byTargetContext,
    mask(drop,
      select(hasPointer(ppred(targetEntity: root)), D)))
  |> expand(role₁, SchemaRef₁)
  |> expand(role₂, SchemaRef₂)
  |> prune(...)
```

Read: *select every delta that points at the root; drop negated ones; file the survivors under properties by their target-context; expand chosen pointer roles through child schemas; trim.*

### 2.1 What a HyperSchema means

A HyperSchema defines the **closure of relevance** for an entity:

1. deltas directly targeting the root (via its `select`),
2. deltas reachable through declared `expand`s (recursively, through child schemas),
3. negations of any of the above (via `mask`).

This closure is what bounds an otherwise unbounded stream into a tractable query, and it is *exactly* the maintenance contract for an index (SPEC-4 §4): the relevance closure tells the reactor precisely which incoming deltas can affect a materialization.

## 3. The DAG Constraint

The reference graph `schema —refs→ schema` MUST be acyclic.

- Validation: at schema registration/receipt, walk `refs` transitively; reject cycles. Because `refs` is declared (not discovered by interpreting the body), this check is cheap and static.
- Data cycles remain fully legal (Keanu created BRZRKR; BRZRKR was created by Keanu). The DAG constraint is on *programs*, not *data*. Expansion of a data cycle terminates because the schema chain terminates: a terminal schema (one with no `expand`s) leaves `EntityRef`s as bare references.
- Consequence: every HyperView has a statically known maximum expansion depth — the longest path in the schema DAG — which gives implementations a hard bound for resource planning.

*(Open: bounded self-reference — `expand(..., self, depth: k)` for tree-shaped data like comment threads. Expressible today by k manual schema copies; ugly. A `depth`-bounded SchemaRef would preserve termination and static bounds while restoring ergonomics. Needs vectors before admission.)*

## 4. HyperView

The output sort (L2 §2), restated with guarantees:

```
HView {
  id:    EntityId
  props: Map<propertyName, HVEntry[]>
}
```

- **Provenance-complete:** every HVEntry is a full delta (id, author, timestamp, signature status, all pointers), possibly with expanded targets. Nothing is summarized away below `resolve`.
- **Superposition-preserving:** competing claims for a property coexist as sibling entries. The HyperView is the staging area where conflicts are *visible but not yet adjudicated*.
- **Deterministic & canonical:** same (schema, DSet) ⇒ byte-identical canonical serialization. HyperViews are therefore content-addressable, which is what makes them cacheable and diffable (SPEC-4).
- **Bounded:** membership is exactly the relevance closure of §2.1 — no delta outside the closure may appear.

A HyperView is simultaneously: a query result, an index entry (when materialized, SPEC-4), a federation payload (a self-contained provenance bundle, SPEC-6), and a view template (input to `resolve`, SPEC-5). One abstraction, four duties — this is intentional and normative.

## 5. Schemas as Deltas

The at-rest, federated form of a schema is a set of deltas. Encoding convention (normative vocabulary, `rdb.schema.*` namespace):

```
// schema root
{ pointers: [ { role: "rdb.schema.defines", target: EntityRef(schemaEntity, context: "definition") },
              { role: "rdb.schema.alg",     target: 1 } ] }

// term nodes: one entity per operator node; one delta per edge
{ pointers: [ { role: "rdb.term.op",      target: "select" },
              { role: "rdb.term.of",      target: EntityRef(schemaEntity, context: "body") } ] }
{ pointers: [ { role: "rdb.term.operand", target: EntityRef(childTermEntity, context: "parent") },
              { role: "rdb.term.position",target: 0 } ] }
// predicate leaves serialize their canonical CBOR as a primitive string (base64)
```

*(The exact vocabulary above is illustrative draft; the conformance suite will pin it. What is already normative:)*

- A schema MUST be losslessly round-trippable: deltas → term → canonical CBOR → hash, with the hash matching a directly-encoded term.
- **Bootstrap:** there is exactly one hand-specified schema, `rdb.SchemaSchema` — the HyperSchema for reading HyperSchemas out of the rhizome. Its term is published as a constant (canonical CBOR + hash) in this spec's conformance vectors. Every other schema is read using it. This closes the loop of P3 with a single axiom, mirroring L1's single axiom.

Because schemas are deltas, automatically:

- **Sync carries semantics:** federating data federates the schemas to interpret it.
- **Evolution is append:** extend a schema by adding deltas; old pinned references still resolve (see §6).
- **Conflict is ordinary:** two definitions of `MovieSchema` are superposed claims, resolved by the same policies as any data (trusted authors, etc.).
- **The registry is queryable:** "all schemas that `expand` through `ActorSchema`" is just a query.
- **Schemas are negatable:** deprecation is a negation delta.

## 6. Pinned vs. Evolvable References

`SchemaRef` has two modes (L2 §7), and their semantics interact with everything above:

- **Pinned — `ref(hash)`:** immutable reference to an exact term. Evaluation is reproducible forever. REQUIRED for: conformance vectors, signed/audited views, federation payloads that claim reproducibility.
- **Evolvable — `ref(entity)`:** names a schema entity; the current definition is obtained by evaluating `rdb.SchemaSchema` at that entity under the *evaluator's* delta set and resolution policy. Evaluation can change as definition deltas arrive — by design.

Normative consequences:

- An evolvable reference makes the evaluating instance's policy part of the semantics. Two instances MAY legitimately disagree about what `MovieSchema(entity)` currently means; this is P5 pluralism, surfaced honestly.
- Implementations MUST record, in any materialized HyperView's metadata, the resolved pin (hash) of every schema actually used — so that any concrete result is reproducible even when produced via evolvable references.
- Cycle checking (§3) applies to the *resolved* graph; a definition update that introduces a cycle MUST be rejected at resolution time (the previous resolvable definition remains in effect for that evaluator).

## 7. Graceful Degradation

Schemas MUST be total over arbitrary delta sets:

- Delta matches no `select`: excluded.
- Pointer matches no `expand`: passes through as bare `EntityRef`/primitive.
- Property has no deltas: absent from `props` (never null).
- Unknown roles/contexts/vocabularies: ignored, never errors.

A schema can therefore be evaluated against any delta set from any source without precondition — the property that makes federation-without-coordination workable.

## 8. Authoring Surface (Informative)

L3 terms are the compilation target, not the UX. Expected ecosystem:

- a TypeScript/Elixir builder API (`schema("Movie").property("cast").from(...).expand("actor", NamedEntity)`) emitting validated terms;
- GraphQL SDL → HyperSchema compilation for the common object-shaped case;
- lint tooling over the schema registry (vocabulary drift detection — an L5 concern surfaced at authoring time).

None of this is normative; all of it compiles to SPEC-2 terms or it doesn't exist.

## 9. Open Questions (L3)

- Bounded self-reference / depth-limited recursion (§3).
- Schema *interfaces*: can a schema declare "any schema producing props ⊇ {name}" as an expansion target, enabling structural polymorphism without naming a concrete child? Powerful for federation; risks undecidability — needs a careful fragment.
- Migration story: a convention for "schema B supersedes schema A" deltas, and whether evaluators should auto-chase supersession or treat it as policy.
- Namespace governance for `rdb.*` vocabulary versus user vocabulary (relates to L5 ABI).
