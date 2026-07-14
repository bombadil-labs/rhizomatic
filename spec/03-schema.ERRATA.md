# ERRATA & Decisions — SPEC-3 (Schemas & HyperViews)

## S1 — Schema-as-deltas vocabulary

Folded into SPEC-3 §5 (2026-06-11); history in git.

## S2 — The bootstrap schema `rhizomatic.HyperSchemaSchema`

Folded into SPEC-3 §5 (2026-06-11); history in git.

## S5 — SPEC CONTRADICTION: canonical body must mask before select

Folded into SPEC-3 §2 (2026-06-11) — the spec now carries the amended idiom and its rationale; the discovery story stays in git history.

## S3 — Loading schemas from deltas (eager evolvable resolution)

`loadHyperSchema(deltaSet, schemaEntity)`: evaluate `rhizomatic.HyperSchemaSchema` at the entity, take the
`definition` property's surviving entries, choose the **latest by claimed timestamp (lexById
tiebreak)** — the v0 default-definition policy, explicitly a policy choice — then decode
`rhizomatic.hyperschema.term` (hex → canonical CBOR → term; the decoder re-encodes and compares bytes, so
non-canonical blobs are rejected). The round-trip `deltas → term → canonical CBOR → hash` MUST
reproduce the hash of the directly-encoded term (SPEC-3 §5's normative core). The hash of every
schema actually used is recordable for reproducibility (SPEC-3 §6's pin-recording requirement —
full materialization metadata arrives with the reactor).

## S6 — Self-hosting the resolution Schema (issue #11, 0.5)

Parity for the resolution `Schema` (`{ props, default }`) with the HyperSchema self-hosting story
(S1–S3), landed in the same 0.5 wave as the #10 naming reconciliation (which freed the names
`publishSchemaClaims` / `loadSchema`). **Mechanical parity**: the same gather idiom, a Schema
serialized as a canonical-CBOR-hex blob, decoded on load — no new resolution semantics.

- **`Schema` gains OPTIONAL `name` and `alg`.** A published/named Schema carries a `name` (string)
  and `alg` (number — the L5 algebra version), exactly as a HyperSchema does, so a Schema becomes a
  first-class, versionable, self-hosting entity (Loam §21's `name@hash`). Both are optional: an
  inline Schema in a `resolve` term stays anonymous, so **existing resolve vectors are
  byte-unchanged**. The schema JSON profile (SPEC-5 §7) emits `name`/`alg` only when present.
- **Vocabulary `rhizomatic.schema.*`** (parallel to `rhizomatic.hyperschema.*`): a definition delta
  carries `rhizomatic.schema.defines` (→ the schema entity, context `definition`),
  `rhizomatic.schema.name`, `rhizomatic.schema.alg`, and `rhizomatic.schema.term` — the canonical
  CBOR hex of the serialized Schema, `hex(canonical_cbor(schemaJson(schema)))`.
- **`SCHEMA_SCHEMA`** (`rhizomatic.SchemaSchema`): the bootstrap through which Schemas are read.
  Mechanical parity means it reuses the **same generic gather idiom** as
  `rhizomatic.HyperSchemaSchema` (group `byTargetContext` of a root-select after `mask(drop)`); the
  only difference from the HyperSchema path is which roles the loader extracts (`schema.*` vs
  `hyperschema.*`) and that the decoded blob is a Schema, not a Term.
- **`publishSchemaClaims` / `loadSchema`** (the names freed by #10): the resolution-Schema parallel
  of `publishHyperSchemaClaims` / `loadHyperSchema`. `loadSchema` gathers the definition deltas at
  the entity via `SCHEMA_SCHEMA`, takes the latest surviving definition (claimed timestamp, lexById
  tiebreak — the same v0 policy as S3), decodes `rhizomatic.schema.term`, and rejects non-canonical
  blobs by re-encoding and comparing bytes (the S3 discipline).
- **Round-trip invariant** (the normative core, pinned by `vectors/l1-eval/schema-deltas.json`):
  `Schema → deltas → Schema → canonical hex` reproduces the hash of the directly-serialized Schema.

Additive: no existing vector entry changes; the new behavior arrives as appended entries in the
schema-deltas vector (a `SCHEMA_SCHEMA` bootstrap hash + a published-Schema round-trip).

## S4 — The `rhizomatic.*` prefix remains a configurable constant

The vocabulary prefix is **`rhizomatic.*`** (decided 2026-06-11) — the full product name,
collision-proof and self-describing; wire cost is negligible since packs intern strings. It
remains one constant per implementation (`VOCAB_PREFIX`), so any future change stays a one-line
edit plus a vector regen. The HTTP path `/rhz/v0/sync` is the transport binding's name (ERRATA-6
F5), not the vocabulary prefix, and is unchanged.
