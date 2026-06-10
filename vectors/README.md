# Conformance Vectors

Language-agnostic test data. **This directory is the source of truth for correctness.** Every
conformant implementation — TypeScript, Rust, and any future citizen — is tested against these exact
files and must produce byte-identical canonical output.

Vectors are plain JSON so any language can load them. Binary values (canonical CBOR, hashes,
signatures, keys) are encoded as **lowercase hex strings**. Where a field is "canonical," the bytes
are normative: implementations compare bytes, not parsed structures.

## Layout

```
vectors/
  l0-delta/            SPEC-1: canonical serialization, content addressing, signatures, delta-set ops
  l1-eval/             SPEC-2 / SPEC-3 / SPEC-5: operator-algebra evaluation over delta sets
  keys/                shared test keypairs (Ed25519 seeds) so signature vectors are reproducible
  manifest.json        index of vector files with the spec section each one pins
```

(Levels here name the conformance level being exercised, per SPEC-0 §5.1 — Level 0 = Format,
Level 1 = Evaluator.)

## Vector shapes

### Delta / canonicalization (`l0-delta/`)

```json
{
  "name": "single-pointer-entity-ref",
  "spec": "SPEC-1 §4.1",
  "claims": { "timestamp": 0, "author": "<hex>", "pointers": [ ... ] },
  "canonicalCborHex": "a3...",
  "multihash": "1e20...",
  "sig": { "keyId": "test-key-1", "hex": "..." }
}
```

- `claims` is the human-readable input (the JSON debug profile, RFC 8785-style).
- `canonicalCborHex` is the normative deterministic-CBOR encoding of `claims` (RFC 8949 §4.2.1).
- `multihash` is `multihash(canonicalCborHex)` — the delta `id`.
- `sig`, when present, is a detached signature over the `id` by the named test key in `keys/`.

### Evaluation (`l1-eval/`)

```json
{
  "name": "select-then-group-with-negation",
  "spec": "SPEC-2 §4 / SPEC-3 §2",
  "deltas": [ /* input delta set, claims form */ ],
  "schemaProgram": { /* an L2 term, JSON-encoded */ },
  "policy": { /* optional: an L5 policy term, for resolve vectors */ },
  "rootEntity": "...",
  "expectedCanonicalHex": "..."
}
```

`expectedCanonicalHex` is the canonical serialization of the result (HyperView or View). Two
implementations are at parity when both reproduce it byte-for-byte.

## Rules

- A vector is added **before or with** the code it pins (see [CLAUDE.md](../CLAUDE.md)).
- If a vector is wrong, fix the vector (and the spec, if it was faithfully wrong) — never patch one
  implementation to match a bad vector.
- Cover edge cases explicitly: negation chains (even/odd length), pointer permutations, empty and
  all-negated properties, mixed primitive types, divergent transaction members.
