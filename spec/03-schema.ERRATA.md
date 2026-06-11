# ERRATA & Decisions — SPEC-3 (Schemas & HyperViews)

## S1 — Schema-as-deltas vocabulary

Folded into SPEC-3 §5 (2026-06-11); history in git.

## S2 — The bootstrap schema `rhizomatic.SchemaSchema`

Folded into SPEC-3 §5 (2026-06-11); history in git.

## S5 — SPEC CONTRADICTION: canonical body must mask before select

Folded into SPEC-3 §2 (2026-06-11) — the spec now carries the amended idiom and its rationale; the discovery story stays in git history.

## S3 — Loading schemas from deltas (eager evolvable resolution)

`loadSchema(deltaSet, schemaEntity)`: evaluate `rhizomatic.SchemaSchema` at the entity, take the
`definition` property's surviving entries, choose the **latest by claimed timestamp (lexById
tiebreak)** — the v0 default-definition policy, explicitly a policy choice — then decode
`rhizomatic.schema.term` (hex → canonical CBOR → term; the decoder re-encodes and compares bytes, so
non-canonical blobs are rejected). The round-trip `deltas → term → canonical CBOR → hash` MUST
reproduce the hash of the directly-encoded term (SPEC-3 §5's normative core). The hash of every
schema actually used is recordable for reproducibility (SPEC-3 §6's pin-recording requirement —
full materialization metadata arrives with the reactor).

## S4 — The `rhizomatic.*` prefix remains a configurable constant

The vocabulary prefix is **`rhizomatic.*`** (decided 2026-06-11) — the full product name,
collision-proof and self-describing; wire cost is negligible since packs intern strings. It
remains one constant per implementation (`VOCAB_PREFIX`), so any future change stays a one-line
edit plus a vector regen. The HTTP path `/rhz/v0/sync` is the transport binding's name (ERRATA-6
F5), not the vocabulary prefix, and is unchanged.
