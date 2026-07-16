# Rhizomatic Specification — SPEC-1: The Delta Layer (L1)

**Status:** Draft
**Layer:** L1 — memory / wire format
**Depends on:** SPEC-0

---

## 1. Purpose

L1 defines the single hardcoded structure in the system: the **delta**. Everything else — schemas, indexes, negations, policies, vocabularies — is encoded *in* deltas. L1 therefore carries the entire portability burden: if two implementations agree on L1, they can exchange everything.

A delta is simultaneously:

1. an **assertion** — a claim about reality, made by an author at a moment;
2. a **hyperedge** — an n-ary, role-labeled connection among entities and values;
3. a **CRDT element** — a member of a grow-only set whose merge operation is union.

It is *not* an instruction. It carries no operational semantics and presumes no machine state (P1).

## 2. Structure

```
Delta {
  id:        Hash          // content-derived; see §4
  claims: {
    timestamp: number      // milliseconds since Unix epoch; a CLAIM, not an authority (§6)
    author:    AuthorId    // public key or key fingerprint; see §5
    pointers:  Pointer[]   // 1 or more
  }
  sig?:      Signature     // detached signature over `id` by `author`'s key; see §5
}

Pointer {
  role:    string                          // this delta's name for what the target IS
  target:  EntityRef | DeltaRef | Primitive | Bytes
}

EntityRef {
  id:       EntityId       // opaque identifier for a domain entity
  context?: string         // the property under which this delta files itself
                           // when the target entity is queried
}

DeltaRef {
  delta:    Hash           // content address of another delta (Merkle reference)
  context?: string
}

Primitive = string | number | boolean

Bytes {
  mime:     string         // IANA media type; REQUIRED, non-empty, NFC, case-sensitive-opaque (§2.1)
  value:    bytes          // the raw payload; identity is the hash of these bytes (§4.1)
                           // a literal, like Primitive: no context slot
}
```

### 2.1 Normative constraints

- A delta MUST contain at least one pointer.
- `null`/`undefined` are not representable. Absence of a fact is absence of deltas.
- Arrays are not primitives. Multiplicity is expressed by multiple pointers or multiple deltas.
- `role` and `context` MUST be non-empty UTF-8 strings, NFC-normalized, case-sensitive. (Vocabulary conventions live at L5; L1 imposes no vocabulary.)
- Numbers MUST be IEEE-754 doubles serializable without loss; implementations MUST reject NaN and ±Infinity at ingestion. *(Open: integer/decimal extension — see §10.)*
- `DeltaRef` vs `EntityRef` are structurally distinct. Targeting a delta (e.g., negation, annotation) is explicit, never inferred from the shape of an id.
- A `Bytes` target's `mime` MUST be a non-empty, NFC-normalized string; it is case-sensitive and otherwise opaque — implementations MUST NOT lowercase or otherwise repair it (`image/PNG` and `image/png` are different claims). Its `value` is a raw byte payload; a zero-length payload is legal. A bytes target carries no `context` — a literal is not a vertex (§2.3). All four target kinds are structurally distinct (§4.1): `Bytes` is discriminated by its `mime` key, never inferred. *(Informative: authors SHOULD use the lowercase IANA form; payload-size caps are deployment configuration — doors, admission requirements — not substrate law, §10.)*

### 2.2 The `system` field is removed

The legacy design carried a `system` UUID identifying the originating instance. Under the portable-format framing this is machine-coupled identity and is **removed from the core**. Provenance of *transport* (which instance relayed this delta) is a federation-layer concern (SPEC-6) and MAY be tracked as annotation deltas. Provenance of *assertion* is `author`, which is cryptographic (§5).

### 2.3 Context is the backpointer's name — and its consent

A delta is readable from the perspective of **any** entity it points at; there is no privileged
subject. What `context` does is name the property under which the delta files itself *at that
target* when the target is queried. The same delta may carry a different context on each of its
entity pointers — a purchase filing under `purchases` at the buyer and `sales` at the seller —
and the relation's full payload at any vertex is composed from the *other* pointers'
role/target pairs (pinned at L5, ERRATA-5 R1).

Three consequences, all deliberate:

- **A missing context means no backpointer.** The reference still exists — the delta still
  matches predicates, still travels, still names the entity — but the target's view does not
  grow a property for it. Backpointers are consent, granted per pointer at write time. (Pinned
  at L2 as *contextless exclusion*, ERRATA-2 E6.)
- **Primitives are not vertices.** A bare string or number carries no context slot at all —
  there is no "perspective of the number 3" to file under. If a value needs a perspective,
  promote it to an entity.
- **The author's context is the default reading, not a cage.** Filing is an L2 operator
  parameter (`group` keys, SPEC-2 §4.4): `byTargetContext` defers to the author's naming, but a
  schema MAY impose its own filing — group by the role the root plays, or bag everything under
  a constant property. Semantics travel as payload; lenses stay sovereign.

## 3. Atomicity

A delta is the unit of acceptance and negation. You take all of its pointers or negate all of them. Therefore **delta granularity is a modeling decision made at write time**:

- Facts that can be independently wrong MUST be separate deltas (name, birthdate, nationality → three deltas).
- Facts that are semantically inseparable SHOULD be one delta (a purchase's buyer/seller/item/price/time — changing any one makes it a different purchase).

Rule of thumb: if you cannot imagine one part being false while the rest stays true, it is one delta.

## 4. Identity: Content Addressing

A delta's `id` is the hash of its canonical serialization (§4.1) of the `claims` object:

```
id = multihash( canonical_bytes(claims) )
```

- Default hash function: BLAKE3-256, encoded as a multihash so the function can evolve.
- The `id` field and `sig` field are excluded from the hashed bytes (they derive from / attest to them).
- Consequences (all intended):
  - Anyone can verify or derive any delta's identity. No instance mints identity (P6).
  - Identical claims by the **same author at the same timestamp** are the **same delta**; union deduplicates them. Identical claims by different authors (or times) are distinct deltas — provenance is part of identity.
  - `DeltaRef`s are Merkle links: a negation cryptographically pins exactly what it negates. Tamper-evidence is structural.

### 4.1 Canonical serialization (the normative profile)

Conformance Level 0 requires byte-exact canonicalization. Encoding is deterministic CBOR
(RFC 8949 §4.2.1) — definite lengths, sorted map keys, shortest-form floats — specialized by the
following profile. Test vectors pin `(claims JSON, canonical CBOR hex, multihash)` triples for
all of it.

**Numbers are floats only.** Rhizomatic numbers (primitives and `timestamp`) are finite IEEE-754
doubles; NaN and ±Infinity are rejected at construction (§2.1). They encode in CBOR as floating
point only (major type 7) — integer major types are never used, because the data model has a
single numeric type and emitting only floats removes the integral-double-vs-integer ambiguity
that otherwise fractures cross-implementation interop. `-0.0` normalizes to `+0.0` before
encoding. The shortest-float rule is full RFC 8949 §4.2.1: encode in the shortest of float16 /
float32 / float64 that represents the value *exactly*, including f16 subnormals down to 2^-24.

**Strings** (`role`, `context`, `author`, entity ids, hashes, string primitives) encode as
definite-length CBOR text strings, **NFC-normalized**. Normalization is *validated at the
boundary, never repaired at encode time*: every string in claims MUST already be NFC, and
validation rejects non-NFC strings. (If an implementation silently normalized while encoding, a
non-NFC in-memory string would differ from the bytes its id commits to, and string comparisons
at L2 would diverge from canonical-byte equality. In-memory equality is thereby byte equality
everywhere.) **Booleans** encode as the CBOR simple values (`0xf5`/`0xf4`).

**Byte strings** (a `Bytes` target's `value`) encode as definite-length CBOR byte strings (major
type 2) with the same shortest-form length head the profile applies to every other type
(indefinite lengths are forbidden). The raw payload bytes enter the hash preimage *only* here, as
the `bstr` inside the target map — there is no payload-level content address at L1 (that is the
next rung of the storage ladder, §10). A delta's id therefore attests `(mime, bytes)` jointly:
the `mime` rides in-kind with the bytes it types. A zero-length payload encodes as `0x40`.

**Map keys** sort by the bytewise lexicographic order of their encoded keys. All Rhizomatic map
keys are text strings; for `claims` the encoded order is therefore `author, pointers, timestamp`.

**Pointer and target layout.** A `Pointer` encodes as the map `{ "role": tstr, "target": <target> }`.
Targets are discriminated structurally:

| Target kind | CBOR shape | Discriminator |
|---|---|---|
| **Primitive** | a CBOR scalar: tstr, float, or bool | major type is not a map |
| **EntityRef** | map `{ "id": tstr, "context"?: tstr }` | contains key `id` |
| **DeltaRef**  | map `{ "delta": tstr, "context"?: tstr }` | contains key `delta` |
| **Bytes**     | map `{ "mime": tstr, "value": bstr }` | contains key `mime` |

This satisfies §2.1's "structurally distinct, never inferred from the shape of an id": the
discriminating key (`id` vs `delta` vs `mime`) is explicit, and primitive-vs-map is a
CBOR-major-type distinction. The `Bytes` map has no `context` key (a literal is not a vertex);
its keys sort `mime` before `value` under the D4 rule. `context` is omitted entirely when absent
— there is no null.

**Claims layout.** `claims` encodes as the map
`{ "author": tstr, "pointers": [Pointer...], "timestamp": float }`. The `pointers` array is
definite-length; its order is **preserved and significant for hashing** (it is part of what the
author signed) but MUST be treated as **semantically unordered** by all higher layers: no
operator (SPEC-2) may distinguish deltas by pointer order.

**Content address.**

```
digest = BLAKE3-256( canonical_cbor(claims) )            // 32 bytes
id     = multihash = 0x1e + 0x20 + digest                // blake3 multicodec 0x1e, length 32
```

At boundaries (vectors, refs, signatures) `id` is lowercase hex: `"1e20" + hex(digest)`. The
`id` and `sig` fields are excluded from the hashed bytes (§4).

### 4.2 JSON debug profile

A JSON profile is offered for authoring and inspection (the conformance vectors use it); the
CBOR bytes remain normative for hashing. The profile is **isomorphic to the canonical
encoding**: a pointer target is the bare primitive, an entity ref object, a delta ref object, or
a bytes object — discriminated structurally, exactly as in CBOR (`id` → EntityRef, `delta` →
DeltaRef, else `mime` → Bytes, else a bare scalar; first match wins):

```json
{ "role": "title", "target": "The Matrix" }
{ "role": "cast",  "target": { "id": "keanu", "context": "actor" } }
{ "role": "negates", "target": { "delta": "1e20…", "context": "audit" } }
{ "role": "icon",  "target": { "mime": "image/png", "value": "iVBORw0KGgo" } }
```

**Byte payloads in the JSON profile are base64url (RFC 4648 §5), unpadded, and canonical.**
Canonical means: no `=` padding; the alphabet is strictly `A–Z a–z 0–9 - _`; the length is never
≡ 1 (mod 4); and the final character's unused low bits MUST be zero (e.g. `"Zg"` is the only
acceptable encoding of `0x66` — `"Zh"` decodes to the same byte with nonzero spilled bits and
MUST be rejected). Because identity is computed from the raw bytes, a lax decoder could not
corrupt an id — but laxity is still *repair*, and repaired inputs are how two witnesses drift, so
padded / non-alphabet / bad-length / non-canonical-trailing-bits inputs are all boundary
rejections (§2.1, SPEC-4 §2). Encoding is canonical by construction; decoding validates it.

What the profile shows IS the wire shape, key for key. **JSON number parsing MUST be correctly
rounded** (nearest f64, ties-to-even). This is not academic: a fast float path that is 1 ULP off
fractures canonical-bytes parity — caught in practice by the `float-f16-min-subnormal` vector.
Any consuming language needs a correctly-rounded parser guarantee.

## 5. Authorship and Signatures

- For a delta that carries (or will carry) a `sig`, `author` MUST be the string `"ed25519:" + lowercase hex of the 32-byte Ed25519 public key` of the signing key; signing APIs MUST refuse to sign claims whose `author` does not match the signing key (a signature that contradicts its own author field is born broken). Unsigned deltas keep their freedom: any non-empty string is a legal (unverified) author claim.
- `sig`, when present, is the lowercase hex of the 64-byte Ed25519 (RFC 8032) detached signature over the **raw multihash bytes** of the delta's `id` (the 34 bytes whose hex spelling is the id — not the hex string, not the claims bytes). Because `id` commits to the full claims, signing the hash signs the delta. Ed25519 is deterministic, so signature bytes are reproducible and pinned in vectors. Verification checks, in order: the id recomputes from the claims, then the signature verifies over the id bytes against the key named in `author`.
- Signatures are OPTIONAL at L1 (local/trusted contexts may omit them). For any delta crossing a federation boundary, signature coverage is REQUIRED in one of two forms: the delta carries its own `sig`, **or** it is accompanied by a signed transaction manifest (§9) whose `DeltaRef` pointers cover it — Merkle coverage, exactly as a git commit authenticates its blobs. An extracted delta travels with its proof.
- An unsigned delta's `author` field is an unverified claim. Resolution policies (SPEC-5) MAY weight signed and unsigned claims differently. The legacy "spoofable author" problem is thereby reframed: spoofing is detectable wherever signatures are demanded, and policy decides what unsigned claims are worth.

### 5.1 Signature acceptance (the strict criterion)

RFC 8032 underspecifies which edge-case signatures verify, and real libraries disagree (see
*"Taming the many EdDSAs"* / ed25519-speccheck). Verification is admission: a federation whose
witnesses admit different delta sets does not converge. So the acceptance criterion is pinned
here, **normatively and in full** — the text below, not any library's default, is the criterion
(ERRATA D13, issue #20).

Let `p = 2^255 − 19`, `L = 2^252 + 27742317777372353535851937790883648493` (the prime order of
the basepoint subgroup), `B` the Ed25519 basepoint, and `M` the message (the 34 raw multihash
bytes of the delta's `id`, per §5). A 64-byte signature `R ‖ S` against the 32-byte public key
`A` verifies **iff every one of these checks passes**:

1. **Canonical scalar.** `S`, read little-endian, satisfies `S < L`.
2. **Canonical encoding of `A`.** The 32 bytes of `A` decompress to a point on the curve, and
   re-compressing that point reproduces the identical 32 bytes. (This rejects `y ≥ p` and a set
   sign bit when `x = 0`.)
3. **Canonical encoding of `R`.** Same check as 2, applied to the first 32 signature bytes.
4. **No small-order components.** Neither `A` nor `R` is a point of small order — i.e.
   `[8]A ≠ 𝒪` and `[8]R ≠ 𝒪`, where `𝒪` is the identity. (A point of *large* order carrying a
   torsion component is NOT rejected by this check; check 5 decides it.)
5. **Cofactorless equation.** `[S]B = R + [k]A` holds **exactly** (no multiplication by the
   cofactor 8 on either side), where `k = SHA-512(R ‖ A ‖ M) mod L`.

The checks are stated in evaluation order for clarity, but they are pure predicates: an input is
accepted iff all five hold, so implementations may evaluate them in any order. Rejection is
rejection — the boundary refuses non-canonical and small-order inputs rather than normalizing
them, exactly as NFC is validated and never repaired (§4.1). Implementations MUST NOT delegate
this criterion to a library default without confirming the library implements precisely these
five checks; the conformance vectors (`vectors/l0-delta/deltas-sig-edge.json`) machine-check
every clause, including inputs that the permissive ZIP215 criterion accepts and this criterion
refuses, and one mixed-torsion input that this criterion deliberately accepts.

*(Why strict and not ZIP215: ZIP215's virtue is inter-verifier agreement, which any pin achieves;
strict additionally matches this spec's boundary discipline. ZIP215's other virtue — batch
verification compatibility — is not exercised by this format. Signing is unaffected: RFC 8032
signing is deterministic and identical under both criteria.)*

## 6. Time

There is no clock in the format. `timestamp` is a **claim made by the author**, with the same epistemic status as every other claim:

- Implementations MUST NOT treat `timestamp` as ground truth for ordering across authors.
- Resolution policies decide how much to trust timestamps (SPEC-5).
- Time-travel queries filter on claimed timestamps and are therefore relative to the claim-graph, not to an objective clock. This is honest: the format records who said what *and when they said they said it*.
- Instances MAY record locally-trusted receipt times as annotation deltas (authored by the instance's own key) when wall-clock ordering matters operationally.

*(Open: optional hybrid-logical-clock annotation convention for causality — §9.)*

## 7. Negation

Negation is not an L1 primitive operation — it is a vocabulary convention over ordinary deltas, given normative meaning by the operator algebra (SPEC-2 `mask`):

```
NegationDelta := a delta containing a pointer
  { role: "negates", target: DeltaRef{ delta: <hash of negated delta> } }
```

- A negation MAY carry additional pointers (e.g., `role: "reason"`).
- Negations are themselves deltas and can be negated. Semantics of negation chains are defined entirely at evaluation time (SPEC-2 §5); L1 merely guarantees the references are unforgeable.
- Negation suppresses at evaluation; it never erases. Both deltas remain in the set forever (P2).

## 8. The Delta Set and Its Algebra

The unit of storage and exchange is the **delta set**: a mathematical set of deltas (deduplicated by `id`).

| Operation | Definition | Guarantee |
|---|---|---|
| merge(A, B) | A ∪ B | commutative, associative, idempotent — a grow-only set CRDT; convergence is trivial |
| fork(A, p) | { d ∈ A : p(d) } | any filter yields a valid delta set |
| federate(A, B, p) | A ∪ fork(B, p) | merge of a filtered fork |

There is **no conflict at L1**. Two contradictory claims are two deltas in superposition; contradiction is a relationship that only exists relative to a schema and policy (L3/L5). This is the precise sense in which "merge is union": the format pushes all conflict upward into evaluation, where it is handled deterministically per policy.

Streams (ordered delivery of deltas over time) are an L4 transport concern. L1 semantics depend only on set membership.

## 9. Transaction Manifests (`rhizomatic.txn`)

A **transaction** is the unit of authorship-as-act: one or more deltas asserted together, in one breath. It is expressed not as a container but as a **claim** — an ordinary delta in the normative `rhizomatic.txn` vocabulary:

```
ManifestDelta := a delta whose pointers include
  { role: "rhizomatic.txn.member", target: DeltaRef{ delta: <member hash> } }   // one per member
and MAY include
  { role: "rhizomatic.txn.prior",  target: DeltaRef{ delta: <prior manifest hash> } }  // causality
  { role: "rhizomatic.txn.intent", target: <primitive> }                        // human-readable label
```

Normative semantics:

- **Grouping is a claim, never a container.** Members are sovereign deltas (P1, §8): independently extractable, shareable, mergeable, and negatable. A manifest commits to its members by content address (Merkle); it does not imprison them. A delta MAY be claimed by multiple manifests.
- **No new primitive.** Manifests are deltas. P3 holds; the entire transaction concept is vocabulary plus layer behaviors: signature coverage (§5), atomic batch ingestion (SPEC-4 §6), bundle transfer (SPEC-6 §4), completeness policies (SPEC-5 §7), and physical packing (SPEC-8).
- **Negating a manifest negates the grouping claim only** — never the members. Bulk retraction is tooling that emits individual member negations (which MAY themselves be bundled under a new manifest). `mask`'s well-foundedness (SPEC-2 §4.3) is untouched.
- **Completeness is verifiable, not enforced.** "Do I hold every member of manifest M" is a hash check. Atomic acceptance is a protocol courtesy (L4/L6) and a checkable property — never a format invariant. Sovereigns may take part of a transaction; policies may demand the whole (SPEC-5 §7).
- **`rhizomatic.txn.prior` provides causality at the act level:** "asserted having seen X" — happened-before as claims, not clocks. This subsumes the HLC question of §10 for most purposes.
- A manifest whose envelope metadata (author, timestamp) disagrees with its members' is detectably lying; admission policies and lint MAY flag it. Member self-containment is deliberately redundant with the manifest — sovereignty costs bytes at L1 and recovers them at L0 (SPEC-8).

## 10. Open Questions (L1)

**Admission test for new target kinds.** A new native kind is warranted only when a value cannot
ride an existing kind without a *representation hazard entering the content address* (precision
loss, a transport encoding inside the hash). Typing and interpretation are vocabulary problems
(roles, contexts, `mime`, schemas); only representation is a substrate problem. Everything below
is read through this test. Corollaries: no `null` (§2.1 — absence of a fact is absence of deltas;
known-absence is an explicit claim; retraction is negation); no array/set literals (§2.1 —
multiplicity is pointers and deltas; set semantics already live at the delta-set CRDT and would
conflict frozen inside a signed literal; ordered compounds are duplicate-role pointers, SPEC-5
§2.1); no date kind (RFC 3339 UTC strings are lossless and sort lexicographically — a vocabulary
convention, SPEC-5 §6).

- **Numeric extension:** arbitrary-precision integers/decimals as tagged CBOR? Needed before
  financial use cases. The one remaining candidate that *passes* the admission test (IEEE doubles
  corrupt past 2^53 and cannot represent decimal fractions exactly; no string convention restores
  ordering or summation) — deferred until a use case forces the L2/L5 semantics (`cmp`, orders,
  `merge(sum)`) that make it genuinely harder than `bytes` was.
- **Binary primitives:** ✅ resolved by the `bytes` target kind (issue #7, 0.4, ERRATA D12) —
  raw bytes + required `mime`, identity over raw bytes, base64url only as JSON transport.
- **Causality annotation:** largely subsumed by `rhizomatic.txn.prior` (§9); remaining question is whether a vector-clock vocabulary is needed beyond act-level happened-before.
- **Compression/compaction:** resolved in principle by the L0 pack format (SPEC-8); open details live there.
- **Erasure:** content addressing makes true deletion even harder than before (hashes pin content). GDPR strategy likely requires payload-encryption-with-key-destruction or off-set "blob" indirection for personal data. Tracked in SPEC-6 §7; unresolved.
