# RhizomeDB Specification — SPEC-1: The Delta Layer (L1)

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
  target:  EntityRef | DeltaRef | Primitive
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
```

### 2.1 Normative constraints

- A delta MUST contain at least one pointer.
- `null`/`undefined` are not representable. Absence of a fact is absence of deltas.
- Arrays are not primitives. Multiplicity is expressed by multiple pointers or multiple deltas.
- `role` and `context` MUST be non-empty UTF-8 strings, NFC-normalized, case-sensitive. (Vocabulary conventions live at L5; L1 imposes no vocabulary.)
- Numbers MUST be IEEE-754 doubles serializable without loss; implementations MUST reject NaN and ±Infinity at ingestion. *(Open: integer/decimal extension — see §9.)*
- `DeltaRef` vs `EntityRef` are structurally distinct. Targeting a delta (e.g., negation, annotation) is explicit, never inferred from the shape of an id.

### 2.2 The `system` field is removed

The legacy design carried a `system` UUID identifying the originating instance. Under the portable-format framing this is machine-coupled identity and is **removed from the core**. Provenance of *transport* (which instance relayed this delta) is a federation-layer concern (SPEC-6) and MAY be tracked as annotation deltas. Provenance of *assertion* is `author`, which is cryptographic (§5).

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

### 4.1 Canonical serialization

Conformance Level 0 requires byte-exact canonicalization:

- Encoding: deterministic CBOR (RFC 8949 §4.2.1) — definite lengths, sorted map keys, shortest-form integers and floats.
- Strings NFC-normalized before encoding.
- `pointers` array order is **preserved and significant for hashing** (it is part of what the author signed) but MUST be treated as **semantically unordered** by all higher layers: no operator (SPEC-2) may distinguish deltas by pointer order.
- A JSON profile (RFC 8785 / JCS) MAY be offered for debugging and MUST round-trip losslessly to the CBOR form; the CBOR bytes are normative for hashing.

Test vectors: the conformance suite includes `(claims JSON, canonical CBOR hex, multihash)` triples.

## 5. Authorship and Signatures

- `author` is a public key (default Ed25519) or its multihash fingerprint.
- `sig`, when present, is a detached signature over `id`. Because `id` commits to the full claims, signing the hash signs the delta.
- Signatures are OPTIONAL at L1 (local/trusted contexts may omit them). For any delta crossing a federation boundary, signature coverage is REQUIRED in one of two forms: the delta carries its own `sig`, **or** it is accompanied by a signed transaction manifest (§9) whose `DeltaRef` pointers cover it — Merkle coverage, exactly as a git commit authenticates its blobs. An extracted delta travels with its proof.
- An unsigned delta's `author` field is an unverified claim. Resolution policies (SPEC-5) MAY weight signed and unsigned claims differently. The legacy "spoofable author" problem is thereby reframed: spoofing is detectable wherever signatures are demanded, and policy decides what unsigned claims are worth.

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

## 9. Transaction Manifests (`rdb.txn`)

A **transaction** is the unit of authorship-as-act: one or more deltas asserted together, in one breath. It is expressed not as a container but as a **claim** — an ordinary delta in the normative `rdb.txn` vocabulary:

```
ManifestDelta := a delta whose pointers include
  { role: "rdb.txn.member", target: DeltaRef{ delta: <member hash> } }   // one per member
and MAY include
  { role: "rdb.txn.prior",  target: DeltaRef{ delta: <prior manifest hash> } }  // causality
  { role: "rdb.txn.intent", target: <primitive> }                        // human-readable label
```

Normative semantics:

- **Grouping is a claim, never a container.** Members are sovereign deltas (P1, §8): independently extractable, shareable, mergeable, and negatable. A manifest commits to its members by content address (Merkle); it does not imprison them. A delta MAY be claimed by multiple manifests.
- **No new primitive.** Manifests are deltas. P3 holds; the entire transaction concept is vocabulary plus layer behaviors: signature coverage (§5), atomic batch ingestion (SPEC-4 §6), bundle transfer (SPEC-6 §4), completeness policies (SPEC-5 §7), and physical packing (SPEC-8).
- **Negating a manifest negates the grouping claim only** — never the members. Bulk retraction is tooling that emits individual member negations (which MAY themselves be bundled under a new manifest). `mask`'s well-foundedness (SPEC-2 §4.3) is untouched.
- **Completeness is verifiable, not enforced.** "Do I hold every member of manifest M" is a hash check. Atomic acceptance is a protocol courtesy (L4/L6) and a checkable property — never a format invariant. Sovereigns may take part of a transaction; policies may demand the whole (SPEC-5 §7).
- **`rdb.txn.prior` provides causality at the act level:** "asserted having seen X" — happened-before as claims, not clocks. This subsumes the HLC question of §10 for most purposes.
- A manifest whose envelope metadata (author, timestamp) disagrees with its members' is detectably lying; admission policies and lint MAY flag it. Member self-containment is deliberately redundant with the manifest — sovereignty costs bytes at L1 and recovers them at L0 (SPEC-8).

## 10. Open Questions (L1)

- **Numeric extension:** arbitrary-precision integers/decimals as tagged CBOR? Needed before financial use cases.
- **Binary primitives:** byte-string primitive (for embeddings, media hashes)? Leaning yes via CBOR byte strings; vectors needed.
- **Causality annotation:** largely subsumed by `rdb.txn.prior` (§9); remaining question is whether a vector-clock vocabulary is needed beyond act-level happened-before.
- **Compression/compaction:** resolved in principle by the L0 pack format (SPEC-8); open details live there.
- **Erasure:** content addressing makes true deletion even harder than before (hashes pin content). GDPR strategy likely requires payload-encryption-with-key-destruction or off-set "blob" indirection for personal data. Tracked in SPEC-6 §7; unresolved.
