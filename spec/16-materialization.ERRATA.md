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

## E3 — Three small M3 decisions the text left open

Decided 2026-10-09 while building the lifecycle verbs; pinned by `vectors/materialization/lifecycle.json`.

- **A `registration` argument that names a delivered act which is not a `registration/1`
  descriptor refuses `invalid-arguments` at stage 4.** The argument is wrong, not the support
  set. A missing descriptor is still `missing-support`, and a descriptor whose closure is not
  delivered in full is `missing-support` before any stage-7 category (`install_descriptor_not_registration`,
  `install_missing_closure`).
- **A control store names stored bytes by their external revision.** `read` and `initialize`
  return the empty text for the generation-0 image and `H(bytes)` otherwise, and the endpoint
  refuses `invalid-control` when the name and the bytes disagree. The store never decodes an
  image; the rule keeps `expected-control` comparable across witnesses and hosts.
- **A replacement capture must keep the registration's binding.** `replace-source` with a capture
  on a different binding is `invalid-source` at stage 6. Changing the source binding means
  retire and install under a new descriptor, as MR-13 already says for every other immutable
  field.

## E4 — What "control/transition linkage when provided" means for readback

Decided 2026-10-09 while building MR-20 for the maintained bodies. MR-20 says a strict reader
checks control/transition linkage when the caller provides it and otherwise reports only verified
structure, but does not say what the caller provides or which fields the linkage compares.

Decision: the caller provides the control image bytes the body names (the post-CAS image for a
transition, the unchanged image for read and restore). The reader classifies that image with the
stage-5 reader and requires: `control` equals the image's revision and `generation` its
generation; for a body naming a registration, the entry exists, its latest transition equals
`transition` when the body carries one, and its status is retired exactly for a retire body; for
a serving body, the Basis binding, revision, authority, at, definitionAt, both pins, hyperschema,
schema and bindings equal the stored descriptor and entry, the Basis closure equals the
descriptor's closure, and the root results partition the descriptor's roots exactly; for a
restore body, the selections equal the entries' projection. A maintained body is
`verified-context` only with both the request and the control image; either alone leaves it
`verified-structure`. Readback never executes a program or checks a source: it compares
commitments.

Pinned by the readback tests over `vectors/materialization/lifecycle.json` in both witnesses.

