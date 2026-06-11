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
- **Shortest-float rule (full RFC 8949 §4.2.1, closed in M0.2):** encode in the shortest of
  **float16** (`0xf9`) / **float32** (`0xfa`) / **float64** (`0xfb`) that represents the value
  *exactly* (including f16 subnormals down to 2^-24). Vectors include the RFC 8949 Appendix A float
  cases and the f16/f32 boundary probes (65504 vs 65505, 2^-24 vs 2^-25).

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

## D8 — Author encoding for signed deltas

For a delta that carries (or will carry) a `sig`, `author` MUST be the string
`"ed25519:" + lowercase hex of the 32-byte Ed25519 public key` of the signing key. Signing APIs
MUST refuse to sign claims whose `author` does not match the signing key (a signature that
contradicts its own author field is born broken). Unsigned deltas keep SPEC-1's freedom: any
non-empty string is a legal (unverified) author claim.

## D9 — Signature definition

`sig` = lowercase hex of the 64-byte Ed25519 (RFC 8032) detached signature over the **raw multihash
bytes** of the delta's `id` (i.e. the 34 bytes whose hex spelling is the id — NOT the hex string
itself, NOT the claims bytes). Because the id commits to the canonical claims, signing the hash
signs the delta (SPEC-1 §5). Ed25519 is deterministic, so signature bytes are reproducible across
implementations and can be pinned in vectors. Verification of a delta checks, in order: the id
recomputes from the claims (content addressing holds), then the signature verifies over the id
bytes against the key named in `author` (D8).

## D10 — Set digest (PROVISIONAL helper — confirmed 2026-06-11: stays provisional until sublinear reconciliation exists)

`digest(S)` = `contentAddress( canonical CBOR array of S's id strings, sorted lexicographically )`.
A cheap canonical fingerprint of set membership, used by the implementations to compare delta sets
(CRDT property tests, parity checks). It is **NOT** the SPEC-6 §4 reconciliation digest — that
Merkle/IBLT construction is still an open question there. Pinned by
`vectors/l0-delta/set-digest.json` only so both implementations agree while it remains a helper;
promotion to normative status is a SPEC-6 decision.

## D11 — NFC is validated at the boundary, not repaired at encode time

SPEC-1 §2.1 requires NFC for `role`/`context`; §4.1 normalizes all strings before encoding. If an
implementation silently *normalized* at encode time, a non-NFC in-memory string would differ from
the bytes its id commits to, and string comparisons (predicates, SPEC-2) would diverge from
canonical-byte equality. Therefore: **every string in claims (author, roles, contexts, entity ids,
delta refs, string primitives) MUST already be NFC; validation rejects non-NFC strings** ("reject,
never repair", SPEC-4 §2). The encoder's normalize step remains as a safety net but is a no-op for
valid claims. In-memory equality is thereby byte equality everywhere.

## JSON debug profile (for vectors)

The canonical form is CBOR; the JSON profile is for authoring/inspection only (SPEC-1 §4.1). The
profile is **isomorphic to the canonical encoding**: a pointer target is the bare primitive, an
entity ref object, or a delta ref object — discriminated structurally, exactly as in CBOR
(primitives are never objects; the `id`/`delta` key names the ref kind, SPEC-1 §2.1):

```json
{ "role": "title", "target": "The Matrix" }
{ "role": "cast",  "target": { "id": "keanu", "context": "actor" } }
{ "role": "negates", "target": { "delta": "1e20…", "context": "audit" } }
```

What the profile shows you IS the wire shape, key for key. *(Amended 2026-06-11: an earlier
revision wrapped targets in `value`/`entityRef`/`deltaRef` tags; the tags carried no information
the structure doesn't, and the profile now matches the canonical form one-to-one. Canonical bytes
and ids are unaffected — the profile is transport, never hashed.)*

**JSON number parsing MUST be correctly rounded.** A consumer of the JSON profile MUST parse decimal
numbers to the nearest f64 (ties-to-even). This is not academic: serde_json's default fast path can
be 1 ULP off, which the `float-f16-min-subnormal` vector caught as a canonical-bytes divergence
between Rust and JS. The Rust implementation therefore requires serde_json's `float_roundtrip`
feature. Any future implementation language needs the equivalent guarantee.
