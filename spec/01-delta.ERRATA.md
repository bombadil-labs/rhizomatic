# ERRATA & Decisions — SPEC-1 (Delta Layer)

Per the README "Rules of engagement" and [CLAUDE.md](../CLAUDE.md): where implementation meets a gap
or contradiction in the spec, we record it here, resolve it explicitly, and let the conformance
vectors pin it. Nothing here is silently encoded into one implementation.

SPEC-1 specifies the *abstract* delta structure and mandates "deterministic CBOR (RFC 8949 §4.2.1)"
but does not give the *concrete* CBOR layout of pointers/targets or the number-encoding rule. The
decisions below fill that gap for **v0**. They are pinned by `vectors/l0-delta/` and are revisitable
(a change is a vector regen, cheap while pre-conformance).

## D1 — Number encoding (numbers are floats only)

Rhizomatic numbers (primitive numbers and `timestamp`) are finite IEEE-754 doubles; NaN and ±Infinity
are rejected at construction (SPEC-1 §2.1). They are encoded in CBOR **as floating point only**
(major type 7). Integer major types (0/1) are never used for Rhizomatic numbers, because the data
model has a single numeric type — emitting only floats removes the integral-double-vs-integer
ambiguity that otherwise fractures cross-implementation interop.

- **-0.0 is normalized to +0.0** before encoding (`n + 0.0`), so the two never produce distinct ids.
- **v0 shortest-float rule (partial):** encode as **float32** (`0xfa`) when the value round-trips
  exactly through f32 (`fround(n) === n` / `n as f32 as f64 == n`), otherwise **float64** (`0xfb`).
  - **Deviation from RFC 8949 §4.2.1, tracked:** the float16 (`0xf9`) reduction is **deferred** to
    slice M0.x. Until then small values that *could* be half-floats are encoded as f32. This is fully
    deterministic and parity-safe; it is only sub-optimal in size. Closing it is a pure vector regen.

## D2 — String encoding

`role`, `context`, `author`, `EntityId`, `Hash`, and string primitives encode as definite-length CBOR
text strings (major type 3), **NFC-normalized** before encoding (SPEC-1 §2.1, §4.1).

## D3 — Boolean encoding

`true` → `0xf5`, `false` → `0xf4` (major type 7 simple values).

## D4 — Map key ordering

Map entries are sorted by the **bytewise lexicographic order of their encoded keys** (RFC 8949
§4.2.1). All Rhizomatic map keys are text strings. Consequence for `claims` (keys `author`,
`pointers`, `timestamp`): encoded order is **author, pointers, timestamp**.

## D5 — Pointer & target layout (fills the SPEC-1 §2 gap)

A `Pointer` encodes as a CBOR map `{ "role": tstr, "target": <target> }` (sorted → role, target).

`target` is encoded — and decoded — by these structural rules:

| Target kind | CBOR shape | Discriminator |
|---|---|---|
| **Primitive** | a CBOR scalar: tstr, float, or bool | major type is not a map |
| **EntityRef** | map `{ "id": tstr, "context"?: tstr }` | contains key `id` |
| **DeltaRef**  | map `{ "delta": tstr, "context"?: tstr }` | contains key `delta` |

This satisfies SPEC-1 §2.1 ("DeltaRef vs EntityRef are structurally distinct ... never inferred from
the shape of an id"): the discriminating key (`id` vs `delta`) makes the distinction explicit, and
primitive-vs-ref is a CBOR-major-type distinction (scalar vs map), which is unambiguous. `context` is
**omitted entirely when absent** — there is no null (SPEC-1 §2.1).

## D6 — `claims` layout

`claims` encodes as CBOR map `{ "author": tstr, "pointers": [Pointer...], "timestamp": float }`. The
`pointers` array is definite-length; its **order is preserved and significant for hashing** (SPEC-1
§4.1) while remaining semantically unordered for all layers above L1.

## D7 — Content address (`id`)

```
digest = BLAKE3-256( canonical_cbor(claims) )            // 32 bytes
id     = multihash    = 0x1e ‖ 0x20 ‖ digest             // blake3 multicodec 0x1e, length 32 = 0x20
```

At boundaries (vectors, refs, signatures) `id` is lowercase hex: `id = "1e20" + hex(digest)`. The `id`
and `sig` fields are excluded from the hashed bytes (SPEC-1 §4).

## JSON debug profile (for vectors)

The canonical form is CBOR; the JSON profile is for authoring/inspection only (SPEC-1 §4.1). A pointer
target in JSON is tagged to keep parsing unambiguous:

```json
{ "role": "title", "target": { "value": "The Matrix" } }
{ "role": "cast",  "target": { "entityRef": { "id": "keanu", "context": "actor" } } }
{ "role": "negates", "target": { "deltaRef": { "delta": "1e20…", "context": "audit" } } }
```

`value` carries a string | number | boolean primitive; `entityRef`/`deltaRef` carry the ref objects.
