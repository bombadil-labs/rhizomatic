# ERRATA & Decisions — SPEC-16 (Materialization)

Decisions filling gaps SPEC-16 leaves open, pinned by `vectors/materialization/`. Same rules as
the SPEC-1 ERRATA: explicit, revisitable, never silently encoded in one implementation.

## E1 — Basis field grammar sits at stage 4, before every stage-7 category

Found 2026-10-09 by independent review of 81acfb5. MR-21 placed resolve's outer evidence body
decode at stage 4 and the embedded definition acts at stage 7, but did not say where the grammar of
the Basis map's own fields sits. The witnesses had chosen differently. For evidence whose Basis
carried both an empty `definitions` list and a malformed `hyperschemaPin`, TypeScript refused
`definition-closure` and Rust refused `invalid-evidence`.

Decision: the complete Basis field grammar other than the embedded definition acts belongs to the
stage-4 outer body decode. That is every ID field, every finite-number field, the `interpretation`
text, each component record's shape, the `definitions` list shape and canonical decoding of
`bindings`. Any of these refuses `invalid-evidence` before a stage-7 definition category can be
reached. The definitions list's count and byte bounds, and the acts themselves, stay at stage 7 as
MR-21 already states. The semantic Basis checks (cutoff equals `at`, component bounds and order,
`definitionDigest`) keep their existing stage-8 position.

Pinned by `resolve_basis_pin_grammar_before_closure` and
`resolve_basis_bindings_grammar_before_closure` in `vectors/materialization/commands.json`. Folded
into MR-21 stage 4 the same day.

## E2 — Control image delta count bound and opaque support

Decided 2026-10-09 while building M3. MR-04 bounds every artifact by `artifactBytes` and every
configuration by `registrations`, but gives no count for the `deltas` array of a control image.
Decision: a control image carries at most `registrations × (definitions + 4)` appearance records,
since each active entry can reach its descriptor, its complete definition closure, one capture,
one authority act and one latest transition. The bound is checked before the array is walked.

The reactor codec treats every record in `deltas` as opaque appearance bytes keyed by `H(bytes)`.
It checks that a retired entry keeps exactly one record reachable; command binds that record to
`entry.transition` when it restores, as MR-17 requires. The reactor never decodes an act.

Pinned by `vectors/materialization/control-image.json` (`entries_over_registrations`,
`image_over_artifact_bytes`, `duplicate_delta`, `deltas_unsorted`).
