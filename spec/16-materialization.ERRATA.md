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

## E5 — Decisions from the first independent review of M3 (PR #65)

Decided 2026-10-10 after the review of 17032db. Each item names the text it reads and the
shared vector that pins it in `vectors/materialization/lifecycle.json`.

- **Roots and aliases are typed by role at the description grammar.** MR-13 says roots are
  entities and aliases texts. A text root or an entity alias is not a registration descriptor,
  so install refuses `invalid-arguments` at stage 4 (E3), in preflight too
  (`install_text_root`, `install_entity_alias`).
- **Text sets order by UTF-8 bytes.** MR-04 and MR-13 order text by bytes; JavaScript's default
  order compares UTF-16 code units and disagrees above U+FFFF. The TypeScript witness now orders
  every set-valued role and every root result by code point, which equals byte order
  (`install_private_use_roots`).
- **The five control verbs need an administrator at stage 3.** MR-08 reserves install,
  replace-source, advance-time, retire and restore for administrators; MR-21 stage 3 refuses
  `unauthorized` once the operation is known and before any argument (`caller_without_administrator_*`).
- **The roots limit binds at the descriptor's first decode.** MR-04 bounds the complete root
  partition at 64, lowerable by boot. Install refuses `resource-limit` at stage 4 and preflight
  reports over-input-limit; a stored descriptor over the limit refuses `resource-limit` at
  stage 5; readback refuses more results than the limit (`install_65_roots`,
  `install_two_roots_lowered_limit`).
- **Restore checks the stored capture's commitments.** MR-17 requires capture revision and
  binding agreement for active entries. The stage-5 reader decodes each active capture basis
  and requires its revision, binding and authority to equal the entry and descriptor; a signed
  image that disagrees is `invalid-control` (`restore_inconsistent_capture`).
- **Expected-source compares after the other stage-6 checks.** MR-21 stage 6 lists the grant,
  binding validity, capture and snapshot validation and authority validity before
  expected-source. A missing grant is `unauthorized` and an expired authority `invalid-source`
  before a wrong expected-source is `precondition-failed` (`read_wrong_source_without_grant`,
  `read_wrong_source_expired_authority`).
- **Readback links a mutating request to its transition.** MR-20 requires request agreement.
  With the control image, a transition body's selected transition must carry the request's
  verb and its prior control must equal the request's expected-control, and every serving
  request's serving-at must equal the outcome time. Pinned by the hostile-context tests in both
  witnesses.

## E6 — Decisions from the second independent review of M3 (PR #65)

Decided 2026-10-10 after the review of 1c81d7f. Each item names the text it reads and the
shared vector or witness test that pins it.

- **Root partitions compare element by element.** MR-19 requires the results to cover the
  registered roots exactly. A text join of the roots is not injective: a single result whose
  root is the registered roots joined by NUL reads as the partition under a joined compare.
  Both witnesses compare the sorted roots one by one; the joined result refuses
  `invalid-evidence`. Pinned by the single-result tests in both witnesses over
  `install_private_use_roots`.
- **Restore validates the stored program against the retained acts.** MR-17 requires the
  descriptor's pins and exact closure to hold against the retained definition acts at the
  descriptor's definition-at. The stage-5 reader runs the same program check install runs,
  from the retained acts; a signed image whose descriptor and entry agree on a pin the retained
  hyperschema does not carry is `invalid-control` (`restore_bad_hyperschema_pin`). Validity of
  an expired descriptor is not checked at stage 5; expiry is not corruption.
- **The stored capture basis is a complete MR-10 basis.** MR-17 says the capture commits to the
  entry's source revision and binding. A basis that carries only the three commitment fields
  states no such commitment, because the revision is a hash over the full basis. The stage-5
  reader decodes the complete basis with the batch grammar and recomputes the revision; a
  truncated basis is `invalid-control` (`restore_truncated_capture_basis`).
- **Readback links an install or replacement request to the selected capture.** MR-20 requires
  request agreement. With the control image and no capture in the context, the request's
  capture must equal the capture the image selected for the registration; a request that names
  another capture refuses `invalid-evidence`. Pinned by the hostile-context tests in both
  witnesses.

## E7 — Decisions from the third independent review of M3 (PR #65)

Decided 2026-10-10 after the review of 25a1c22. Each item names the text it reads and the
shared vector that pins it in `vectors/materialization/lifecycle.json`.

- **A stored capture basis obeys every MR-10 inventory rule the snapshot obeys.** Recomputing
  the revision does not cover the operand table, because the operand table is not an input to
  that hash. The capture basis decoder in both witnesses now requires each operand and each
  exclusion to name exactly its contributing peers from the components table, requires the
  appearance keys to be distinct, and recomputes `membership` from the operand ids and
  `appearanceDigest` from the sorted appearance keys. None of this needs operand bytes or a
  live source. A basis that fails any rule is `invalid-control` at stage 5
  (`restore_capture_foreign_peer`, `restore_capture_wrong_appearance`).
- **The stored capture's signed claims name its original observation.** MR-10 requires a
  capture's timestamp and validFrom to equal the basis servingAt, and the capture to be valid
  at that observation. The stage-5 reader compares the decoded servingAt to the capture's
  claims and checks validity at that time; disagreement is `invalid-control`
  (`restore_capture_observation_mismatch`). Expiry since the observation is not corruption,
  and no live source is consulted.

## E8 — Readings pinned by slice C3a of M3

Decided 2026-10-10 while building the validity, shared-basis-limit and strict-control schedules.
Each item names the text it reads and the shared vector that pins it in
`vectors/materialization/lifecycle.json`.

- **A descriptor expired at the serving time refuses invalid-definition for advance-time as for
  read.** MR-16 says registration expiry at servingAt refuses before CAS and that a read refuses
  `invalid-definition` at stage 7. Both verbs use the same stage-7 code and leave the selection
  unchanged (`read_expired_descriptor`, `advance_expired_descriptor`). Definition validity stays
  at definition-at; `validity_advance_2100` accepts a finite future at with the stored source.
- **An unrelated binding is one the configuration selects and the descriptor does not use.**
  MR-21 says unrelated boot bindings are never checked at invocation and that expired unrelated
  bindings cannot block retire or restore. A boot carries exactly the bindings the configuration
  selects, so the variant boots a configuration that selects the descriptor's binding and an
  expired second binding, with no source grant (`retire_unrelated_expired_binding`,
  `restore_unrelated_expired_binding`).
- **A snapshot carrier's unknown top-level key waits for stage 6.** Stage 4 checks only the
  carrier's byte bound, canonical form and format text (REVIEW-REPAIRS N2). With a wrong
  expected-control the refusal is `precondition-failed` at stage 5; with the right one the
  unknown key is `invalid-source` at stage 6 (`read_snapshot_unknown_key_wrong_control`,
  `read_snapshot_unknown_key`).
- **Per-envelope counters bind each root envelope; artifactBytes binds the whole body and the
  whole image.** MR-04 says the structural counters never sum across roots and that artifactBytes
  covers the complete result body and the control image. With entries and nodes lowered to 1, a
  64-root program whose roots each hold one fact installs and reads with one shared Basis
  (`limits_install_64_roots`, `limits_read_64_roots`). A body limit below the 64-root body and
  above every other artifact refuses `resource-limit` before CAS for install, replace-source and
  advance-time; an image limit below a fat-alias descriptor's image and above its body refuses
  install the same way, with the prior image unchanged (`limits_*_over_body_bytes`,
  `limits_install_fat_descriptor_over_image_bytes`).

## E9 — Readings pinned by slice C3b of M3

Decided 2026-10-10 while building the source-race and unavailable-source crossings. Each item
names the text it reads and the tower or fault schedule that pins it in
`tools/check-materialization-m3-towers.mjs`.

- **The final current check is the last word before CAS.** MR-16 and MR-18 say a source
  replacement during precompute, before the final check, refuses `source-changed` with the
  prior image and no CAS, and that a replacement after the final check leaves a committed
  selection that the next read refuses. The fixture grant moves or revokes its source at a
  named check: at the second check a transition refuses `source-changed` or `unauthorized` and
  the directory holds the prior image (`ctl_precheck_source_race`,
  `ctl_precheck_authority_revoked`). For the post-check race the fixture's independent source
  provider keeps durable state in the host directory; the fault moves that state after the
  second check succeeded and before CAS dispatch. The host records the moved source as current
  at CAS, makes no third check, commits the checked selection, and a later read over the same
  directory with the original source supplied by the test refuses `source-changed` from the
  host's own state (`ctl_postcheck_precommit_race`). No recapture happens in either case; the
  fixture source cannot recapture.
- **A selection restored without its source is reported, never served.** MR-17 says restore
  reports selections with availability unchecked and never calls stale output current. With
  the provider unavailable the restored read refuses `source-unavailable`; with the provider
  back a later read completes against the same selection, without reinstallation
  (`ctl_restore_unavailable`, `read_advanced_source_unavailable`).

## E10 — Readings pinned by slice C3c1 of M3

Decided 2026-10-10 while building the operand-marker and inert-retention crossings. Each item
names the text it reads and the shared step or tower that pins it.

- **The stored image carries no operand bytes.** MR-14 says no operand snapshot or carrier
  persists in the control image. A source fact carries a marker text; every shared step asserts
  the stored image does not contain it, and the marker crossing asserts the exported image and
  every file in the host directory do not contain it, in both witnesses
  (`install_marker`, `ctl_metadata_no_payload`). Reacquisition is the explicit carrier a later
  read supplies in a fresh process; the endpoint checks it against the stored capture's
  commitment, so a reconstructed carrier is exact or the read refuses `invalid-source`.
- **Ordinary retained deltas never activate a selection.** MR-02 and MR-13 say retention is
  inert and install is the only activation. A step may name deltas the host retains in an
  ordinary reactor before booting: a descriptor, authority, capture and state act, or a
  configuration, descriptor and install-shaped request. The empty image still restores empty
  and reads `registration-missing`; only the authorized install that follows activates
  (`restore_empty_retained`, `read_missing_retained`, `restore_empty_retained_request`,
  `ctl_delta_state_inert`, `cmd_inert_retention::empty-control-read`).

## E11 — Readings pinned by slice C3c2 of M3

Decided 2026-10-10 while building the support-erasure crossings. Each item names the text it
reads and the shared step or tower that pins it.

- **The erasure law lives in the grant, and the endpoint only reads its verdict.** MR-15 says
  the host refuses every affected active registration's explicit requiredSupport current check.
  The schedule's grant refuses a check whose required support names a refused act and returns
  `unauthorized`; the endpoint refuses the read, replacement or install with that code and
  decodes no erasure law of its own (`erasure_read_a_refused`, `erasure_read_b_refused`). An
  unrelated registration on the same source passes the same grant (`erasure_read_c_allowed`).
- **Retire is authorized while the support is refused.** The retire verb carries no source
  check, so the exact-control retire of a blocked registration completes and its entry drops
  its capture (`erasure_retire_a`, `erasure_retire_b`). A refused registration that is already
  retired refuses `retired` on read and reinstall without touching the grant
  (`erasure_read_a_retired`, `erasure_install_a_retired`).
- **Support leaves the image with its last active consumer.** Two registrations share the
  marker definitions. After the first retire the image still carries them through the second
  active entry; after the second retire the image carries neither the marker definitions nor
  either descriptor, and both witnesses restore the terminal selections from that image without
  the originals (`erasure_restore_a_retired`, `erasure_restore_settled`,
  `ctl_support_erasure`, `ctl_support_erasure::first-retire`). The crossing asserts the marker
  text on the exported image and every file in the host directory: present while a consumer is
  active, absent once the last one retired.
- **A targeted descriptor leaves shared definitions in place.** When the refused act is one
  registration's descriptor, the other registration keeps the shared definitions and serves
  (`erasure_targeted_read_b_allowed`, `ctl_support_erasure::targeted`).
- **The crash schedule of a retire under erasure matches MR-15.** Before the CAS or with the
  write absent, the registration stays active and blocked and the exact-control retry retires
  it; with the write present or after the CAS, the terminal selection restores without the
  originals (`ctl_support_erasure_crashes::crash-before`, `::uncertain-absent`,
  `::uncertain-present`, `::crash-after`). A refusal between the two checks of a replacement
  refuses `unauthorized` before the CAS with the same required support at both checks
  (`ctl_support_erasure::between-checks`).
- **Physical purge of historical copies is the host's.** The fixture store writes one image
  file through a rename and keeps no history, so the directory scan is the whole surface here.
  A host with history, WAL or spill owes the purge under its own obligations; this profile
  pins only that the control image and the fixture directory settle.
