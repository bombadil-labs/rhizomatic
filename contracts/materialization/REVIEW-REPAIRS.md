# M0 repair dispositions for independent re-review

Input: Fable's independent review of `422a8e40178074fca0041734f90c179c785ab0ed`,
2026-10-05, and supervisor M0 repair decisions including S1 selected-support erasure.
This records builder changes, **not reviewer acceptance or runtime evidence**. Normative
semantics remain in SPEC; cases/allocation remain in ACCEPTANCE/MILESTONES. No production
implementation or profile-1 changes are part of this repair.

## Follow-up N1/N2 at a07fb25

- N1: malformed authority/capture claim intervals fail existing Delta validation at stage 1
  (delivered invalid-appearance) or stage 5 (embedded invalid-control). Only interval containment
  and expiry reach stage 6. Cases: `cmd_authority_capture_validity`, `ctl_control_strict`.
- N2: stage-4 snapshot decoding checks byte bounds, canonical CBOR well-formedness and format
  text only; map shape/counts/digests wait until stage 6. `ctl_control_strict` pairs an unknown
  snapshot key with wrong expected-control, then correct expected-control, to pin the priority.

These are the supervisor's bounded follow-up changes, pending Fable's exact diff check.

## Blocking findings

| Finding | Disposition in repaired packet | Exact acceptance evidence to build |
| --- | --- | --- |
| B1 | MR-24/LOAM-TRIAL use M2 batch gather/resolve for present and historical PRIMARY, arbitrary per-call entity/time. No maintained CAS at this door. M3/M4 remain required. | `loam_primary_actual_door`, `loam_time_authority`, `loam_declared_restore`, `loam_concurrent_basis`, `loam_production_delete_duplicate` changed. |
| B2 | MR-04/14:64-entry configuration lifetime incl retirement; 65th install known no-write resource-limit. Native durable boot rotation has explicit new-scope preparation/installs/activation/crash rules, no cross-scope atomic claim. | `ctl_capacity_rotation` added: pre-source overflow, pre/post activation restart, old request refusal, old retirement/new-scope distinction. |
| B3 | MR-24/LOAM-TRIAL: exact authorized source/program/carrier input-capacity predispatch exclusion, frozen route/basis/time, no truncation or post-dispatch fallback. Exact4096/4097 and encoded byte boundaries include carrier/delivery overhead. No output-capacity availability promise. | `loam_bystander_exclusions`, `nested_resource_baseline`, `cmd_limits_complete` changed. |
| B4 | MR-08/12/19: resolve delivery exactly request+evidence; embedded full signed closure INCLUDING top acts, Delta-ID order. Missing embedded acts definition-closure; extra delivered acts unexpected-support. | `cmd_resolve_embedded_closure` added; `cmd_delivery_support` and mixed-route expectation updated. |
| B5 | MR-08/API/TRANSPORT/bootstrap: invoke receives finite trusted native receivedAt sampled once before preparation. No endpoint clock/global slot; serving-at mismatch invalid-arguments stage4. | `cmd_three_times`, `cmd_input_snapshot`, `loam_concurrent_basis` changed. |
| B6 | MR-04/21: source-binding validity stage6; first nested decode/produce stages and phase priorities fixed. Per-envelope counters, aggregate body bytes, active descriptor expiry invalid-definition; deterministic pre-CAS overflow. | `cmd_error_priority`, `cmd_limits_complete`, `ctl_validity_advance` changed; `ctl_capacity_rotation`, `ctl_shared_basis_limits` added. |
| B7 | MR-19/20: public components only peer/revision/capturedAt; inventories remain private. Recomputable evidence hashes separate from attested source commitments. One Basis/closure per maintained body, root adjacent for batch. | `cmd_public_basis_privacy`, `ctl_shared_basis_limits` added; `ctl_install_complete` changed. |
| B8 | MR-10/21: original authority timestamp/interval stable across captures. Current authority validity, original capture-observation validity; malformed/expired authority or invalid-at-original capture invalid-source stage6. | `cmd_authority_capture_validity` added, including stable IDs/two captures, retained expired-now capture, current authority expiry and malformed interval. |
| B9 | MR-05/07: native encode domain explicitly verifyCanonicalDelta/verify_canonical_delta including lowercase author/signature text. Noncanonical native spellings invalid-evidence; never normalize and claim losslessness. | `env_signature_choice` changed to uppercase-author/signature legacy-verifiable counterexamples and exact HView byte comparison. |
| S1 | MR-14/15/17: active supports complete, retired only signed terminal IDs/scalar pins, no original payload. Host retires ALL consumers, purges unreachable and historical/temp/free-page/WAL copies before settlement. This retained program support is an honest host erasure surface. Explicit checkCurrent requiredSupport IDs distinguish affected/unrelated programs sharing binding/revision; host existing refusal facts enforce it, no second interpreter/journal/ambient context. | `ctl_support_erasure`, `ctl_support_erasure_crashes` added with same-binding/revision A/B vs C, shared definition and targeted descriptor, refusal between identical initial/final support checks despite equal source revision, uncertain absent/present, pre/post retire crash, physical cleanup and payload-free cross-witness retired reopen. `ctl_control_strict`, `ctl_retired_restart`, `ctl_metadata_no_payload` changed. |

## Advisory findings

| Finding | Disposition | Exact acceptance evidence to build |
| --- | --- | --- |
| A1 | TransitionBody/RetireBody return exact committed state Delta ID; ReadBody has no fabricated transition effect. Strict reader checks control linkage when provided. | `ctl_install_complete`, `ctl_shared_basis_limits`. |
| A2 | Named post-CAS-result-materialization fault must fire even when precomputed result remains held; known failure indeterminate result-unavailable with confirmed control. | `ctl_postcommit_rebuild_fault` changed. |
| A3 | Any finite at, including future relative to servingAt, allowed; maintained advance nondecreasing. live-time is explicit advancement, not freshness proof. | `ctl_validity_advance` changed. |
| A4 | Entry.readings[].reading is full ReadingAppearance transport key, never schemaHash. | Existing `env_reading_metadata`, `env_bound_reading` retained. |
| A5 | expected-source precondition only on verbs carrying it. Gather/install internal capture/snapshot mismatch invalid-source. | `cmd_error_priority`, `cmd_source_metadata_integrity`. |
| A6 | Source-size sweep0/128/1024/4096/4097, signatures and snapshot/capture/carrier/delivery/result sizes; real Loam count/bytes required before acceptance. | `nested_resource_baseline`, `loam_bystander_exclusions`. |
| A7 | Loam batch calls make one attempt, no automatic retry/recapture/native fallback or admin CAS; stale basis typed visible failure. Ingest-then-read captures new basis. | `loam_concurrent_basis`, `loam_production_delete_duplicate`. |
| A8 | LOAM-TRIAL uses actual symbol refs and corrected pinned lines: resolvedNodeImpl577, decorateChildren587, gatherImpl159, registrationDeltaClaims643. | Existing `packet_loam_selection` retained. |

## Frozen scope and verification

Seven cases added explicitly and independently allocated: three M2, four M3. Existing92 IDs
retained unmoved; M5 keeps its ten required actual-door IDs, with capacity schedules included in
its bystander case. Total99 specified cases; no executable outcomes or upper capability invented.
TOWERS includes the new closure/privacy/authority and rotation/shared-support cases, trusted native
observation arguments, source-capacity classification, durable host boot selection and physical
support-purge observations in replay. API/BOUNDARIES retain the original owner dependency graph.

Structural gate: `node contracts/materialization/validate.mjs --self-test`; baseline gates:
`node tools/check-command-contracts.mjs --self-test`, `node tools/check-package-graph.mjs`,
and `git diff --check`. These are the only execution checks for this docs-only M0 repair.
The commit handoff reports their actual results. No full runtime suites are authorized here.

Original signed Loam closure extraction, real fixture sizes, coherent host physical capture,
actual control CAS/rotation/purge and cross-witness behavior remain acceptance evidence for later
milestones. No source-inspection contradiction remains deliberately unresolved in this packet;
independent Fable re-review decides acceptance. Supervisor owns integration, merges and releases.
