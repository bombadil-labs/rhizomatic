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
