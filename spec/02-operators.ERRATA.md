# ERRATA & Decisions — SPEC-2 (Operator Algebra)

v0 decisions filling gaps SPEC-2 leaves open, pinned by `vectors/l1-eval/`. Same rules as the
SPEC-1 ERRATA: explicit, revisitable, never silently encoded in one implementation.

## E1 — JSON term profile (for vectors and debugging)

Terms and predicates serialize to JSON for vector files. (The normative at-rest form is deltas,
SPEC-3 §5; canonical CBOR of terms arrives with schema hashing in M1.5. This JSON profile is the
authoring/transport form the vectors use.)

```
Term ::= "input"                                          // the delta set under evaluation
       | { "op": "select", "pred": Pred, "in": Term }
       | { "op": "union",  "left": Term, "right": Term }
       | { "op": "mask",   "policy": MaskPolicy, "in": Term }

MaskPolicy ::= "drop" | "annotate" | { "trust": Pred }

Pred ::= "true" | "false"
       | { "match": { "field": "author"|"timestamp"|"id", "cmp": Cmp, "const": Const } }
       | { "hasPointer": PPred }
       | { "and": [Pred, Pred] } | { "or": [Pred, Pred] } | { "not": Pred }

PPred ::= { "role"?: StrMatch, "targetEntity"?: string, "targetDelta"?: string,
            "context"?: StrMatch, "targetIsPrimitive"?: boolean, "targetValue"?: ValMatch }
          // at least one field; all given fields must hold on the SAME pointer

StrMatch ::= { "exact": string } | { "prefix": string } | { "inSet": [string...] }
ValMatch ::= { "vcmp": { "cmp": Cmp, "value": Primitive } }
           | { "between": [Primitive, Primitive] }        // inclusive, canonical order (E3)
           | { "inSet": [Primitive...] }
Cmp ::= "eq"|"neq"|"lt"|"lte"|"gt"|"gte"|"prefix"|"inSet"
```

Parse-time validation: `prefix` requires string operands; `match` with `cmp: inSet` requires an
array `const`; `and`/`or` take exactly two operands; an empty `PPred` is rejected. All strings in
terms are NFC-normalized at parse time (cf. ERRATA-1 D11 — data strings are NFC by validation, so
comparisons are NFC-vs-NFC).

## E2 — Canonical result encoding for DSet-sort evaluations

For vectors, the canonical serialization of a DSet result is the **canonical CBOR array of the
member ids as text strings, sorted lexicographically**. The result of a top-level
`mask(annotate, …)` is instead the canonical CBOR map `{"ids": [...], "negated": [...]}` (both
sorted; `negated` ⊆ `ids`).

Annotate tags are **top-level metadata only**: if any operator consumes a `mask(annotate, …)`
result, the tags are discarded — they are not part of the DSet sort. (Tags become real structure
at L3, where HVEntries carry negation marks; SPEC-5 §4.)

## E3 — Canonical total order over primitives

Comparisons (`ValMatch`, `match` ordering, and later SPEC-5 §4 mixed-type resolution) use one
total order: **type rank first (bool < number < string), then value**. Booleans: false < true.
Numbers: IEEE-754 order (finite only, by L1 validation). Strings: **bytewise order of the NFC
UTF-8 encoding** — NOT UTF-16 code-unit order, which diverges for astral-plane characters. This
matches CBOR's map-key ordering and Rust's native `str` ordering; the TS implementation must
compare encoded bytes, not use `<` on strings. Cross-type `eq` is always false; cross-type
ordering follows type rank.

## E4 — `trust(Pred)` semantics

`mask(trust(p), D)` behaves exactly like `mask(drop, D)` computed over the restricted negation
candidate set `{ n ∈ D : p(n) }`: only trusted negations negate, and negation-of-negation chains
are walked within the trusted set only.

## E5 — Negation recursion guard

`negated(d, D)` recursion (SPEC-2 §4.3) is well-founded because `DeltaRef`s are content addresses;
a cycle would require a hash collision, and `DeltaSet` verifies every id on insert. Implementations
still guard the recursion (memo with an in-progress default of "not negated") so that adversarial
input degrades safely instead of overflowing the stack.

## E6 — `group` filing rules

`group(key, D) @ root` (SPEC-2 §4.4) partitions D into properties. v0 decisions:

- Only pointers whose target is an `EntityRef` with `id == root` are *filing pointers*.
- `byTargetContext`: the delta files under each filing pointer's `context`; a filing pointer
  **without** a context files nothing (a property needs a name). A delta with no filing pointer is
  excluded from the HView.
- `byRole`: the delta files under each filing pointer's `role` (roles are always present).
- `const(s)`: **every** delta in D files under `s` — no filing pointer required (this is the
  "bag it all" projection).
- A delta may file under several properties (one per distinct filing key); within one property a
  delta appears **once** (entries are unique by delta id).
- The empty result is `HView{id: root, props: {}}` — present id, empty props, never null
  (SPEC-3 §7).

## E7 — HyperView canonical form (v0, pre-expansion)

```
HView   = CBOR map { "id": tstr(root), "props": map { propertyName: [HVEntry...] } }
HVEntry = CBOR map { "id": tstr(deltaId), "claims": <canonical claims map, SPEC-1 §4.1>,
                     "sig"?: tstr, "negated"?: true }
```

Map keys sort canonically (D4). Entries within a property are **sorted by delta id**. The
`negated` flag appears only when true, and only when the grouped operand was a `mask(annotate)`
result — group threads annotate tags into entries (this is how SPEC-5 §4 audit views see
retractions). `expand` (M1.3) will extend HVEntry with expanded targets; the encoding above is the
terminal (unexpanded) form.

## E8 — `prune` operates at property granularity (v0)

`prune(keep: StrMatch | all)` retains the HView properties whose **name** matches (`all` = keep
everything, the identity). SPEC-2 §4.6's "drop pointers" reading — trimming pointer lists inside
entries — is **deferred**: it tensions with SPEC-3 §4's provenance-completeness ("every HVEntry is
a full delta") and no current consumer needs it. Filed as an open question; revisiting costs a
vector regen.

## E9 — Sorts are checked at evaluation time (v0)

Terms are dynamically sorted in v0: applying `select`/`union`/`mask` to an HView, `group` to an
HView, or `prune` to a DSet is an evaluation error; `group` without an ambient root (supplied by
the evaluation call, later by `fix`) is an evaluation error. Static term sort-checking can arrive
with the schema registry (M1.3+) without changing any vector.

## E10 — Schema registry, `$root`, and SchemaRef (v0)

- A **HyperSchema** is `{name, alg, body}` where `body` is an HView-sort term (SPEC-3 §2). The
  **registry** is an explicit evaluation input mapping names to schemas. v0 `SchemaRef` is a
  registry name; the pinned-hash and evolvable-entity modes (SPEC-3 §6) arrive with
  schemas-as-deltas (M1.5).
- `refs` are **derived** from the body (every `expand`/`fix` schema name), not separately declared
  — equally static and checkable. Registry construction rejects duplicate names, unresolved refs,
  and reference cycles (SPEC-3 §3); data cycles remain legal and terminate because the schema
  chain terminates.
- Schema bodies are functions of their root: the term JSON gains a **root variable** —
  `"targetEntity": {"var": "root"}` in a `hasPointer` predicate — resolved against the ambient
  root at evaluation time. A root-variable predicate evaluated with no ambient root matches
  nothing (registry validation may later reject such terms statically instead).
- JSON profile: `{"op": "expand", "role": StrMatch, "schema": name, "in": Term}` and
  `{"op": "fix", "schema": name, "entity": EntityId}`. `fix` sets the ambient root to `entity`
  explicitly (ignoring any enclosing root); `expand` sets it to each expanded target entity.

## E11 — Expanded HVEntry encoding (replacement form)

`expand` replaces a matching pointer's `EntityRef` target with the HView evaluated at that entity
(SPEC-2 §4.5), **against the same DSet the enclosing evaluation received**. In the canonical HVEntry
encoding, the replaced pointer target is the nested HView map `{"id", "props"}` instead of the
EntityRef map `{"id", "context"?}` — the discriminator is the presence of `"props"`. The delta's
true id/claims are NOT re-hashed with replacements (expansion is view structure, not data);
provenance stays intact: the in-memory entry keeps the original delta plus an expansion table keyed
by pointer index (authored pointer order is hash-significant and stable, SPEC-1 §4.1). Pointers
whose target is a primitive or DeltaRef never expand; a role-matching EntityRef pointer expands;
everything else passes through as written (SPEC-3 §7 graceful degradation).
