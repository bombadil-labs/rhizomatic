# M0 repair dispositions for independent re-review

Input: Fable's independent review of `422a8e40178074fca0041734f90c179c785ab0ed`,
2026-10-05, and supervisor M0 repair decisions including S1 selected-support erasure.
This records builder changes, **not reviewer acceptance or runtime evidence**. Normative
semantics now live in SPEC-16; cases/allocation remain in ACCEPTANCE/MILESTONES. No production
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
| B8 | MR-10/21: original authority timestamp/interval stable across captures. Current authority validity, original capture-observation validity; expiry/interval containment invalid-source stage6; malformed delivered intervals invalid-appearance stage1, embedded invalid-control stage5 (N1). | `cmd_authority_capture_validity` added, including stable IDs/two captures, retained expired-now capture, current authority expiry and malformed interval. |
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

## M1 source clarifications

Supervisor confirmed complete encoded-CBOR-key sorting (SPEC-1 §4.1), semantic AST budget family
traversal, and the bounded TS '__proto__' bridge correction documented in SPEC-16. Earlier empty
oracles using raw UTF-8 sorting were withdrawn and corrected independently. The shared M1 vectors
pin reserved own properties/nested bridges and exact syntax depth/count boundaries. These are
implementation clarifications, not claims of completed runtime acceptance.

Concrete M1 hostile-boundary repairs: duplicate CBOR map keys are rejected before the Rust
canonical encoder can panic; malformed container map keys are structural errors and do not
consume HView node counters in either witness. A shared lowered-node-limit counterexample pins
that priority. Conservative UTF-8/payload byte lower bounds are checked before native bridge
serialization and accumulated across distinct tables and repeated node text; exact canonical
artifact length still decides the boundary. Shared exact/one-over schedules cover cumulative
payloads, repeated multibyte node text and primitive author-rank metadata. Metadata still adds
zero syntax nodes. Original profile1 vectors and hashes remain unchanged outside E23's explicitly
approved reserved-key correction.

## M2 implementation clarification (supervisor ruling)

MR03/cmd_core_feature_boundary now distinguishes native grammar-illegal reading-order inView (invalid-definition stage7) from successfully parsed unsupported reading features (invalid-program after pins/closure). The exact reader and native parseOrder guards remain unchanged. Shared top/child reflective acts and wrong-pin precedence variants are required M2 evidence; existing profile1/M1 refusal contracts remain preserved.

M2 stage-order clarification: original signed definition features remain stage7. Supplied evaluated reading features cannot be inspected before the mandated stage8 strict envelope decode. They are checked after structural/contextual evidence and before policy resolution; known envelope limits/invalid-evidence precede invalid-program there. Pure preflight keeps this order. No early raw opening or M1 domain amendment; supervisor confirmed the bounded split for cmd_core_feature_boundary precedence vectors.

## M2 supervisor pointer-count clarification

MR04 pointers includes each delivered materialization request/support/carrier appearance. The
profile-local stage1 guard first bounds delivery length, then scans every debug claims.pointers
container without target decoding. Unknown container counts refuse invalid-appearance; otherwise
any per-appearance overflow refuses resource-limit before target parsing/signature verification,
then closed-grammar/canonical-size counting checks deliveryBytes before payload decode. Repeats count before dedup. Nested byte
artifacts keep their first decode phases (source6, embedded original definitions7, envelope8).
No unrelated boot description is newly inspected at invocation, and profile1/Delta acquire no
global pointer cap. Shared exact/overflow request, carrier and definition schedules pin this.

Source-faithful grammar note: native assertClosedTrustPred also rejects actsFor in aliased trust
before an exact definition is returned. The canonical signed hostile act is invalid-definition,
while native-valid unsupported principal orders remain invalid-program after pins/closure. The
ordinary gather alias/reflection positives preserve native behavior.

## M2 bounded evaluation operational amendment

Supervisor approved per-logical-operator HView node/entry bounds, per-node buckets, active expansion path depth, occurrence charging and non-cumulative wrappers. Independently bounded child intermediates may prune before parent attachment; at most one pending child per active frame, no total CPU/temporary-allocation guarantee. Existing default/profile1 evaluation unchanged. See normative MR04 amendment and shared bounded-evaluation schedules.

## M2 delivery allocation repair and native-domain clarification

Supervisor requires shared delta JSON grammar capture/count before payload decoding and full
canonical buffering. Base64url and CBOR sizes retain their lower semantic owners. All appearances
are validated despite saturated byte counts, preserving malformed-sibling priority and preliminary
known-pointer precedence. Captured pointer counts are checked again before member allocation.
Invoke/preflight count and decode the same owned snapshot, never clone or re-read raw payloads.

Explicit new-port native compatibility exception: transparent Proxy fields may pass instead of
incidental structuredClone refusal. Own enumerable JSON-debug data are captured synchronously;
getter/trap host code is not sandboxed and no atomic origin snapshot/termination is promised.
No toJSON/builtin coercion, unknown/inherited field dropping, raw unbounded clone or Proxy detector.
Later mutation cannot change counted/decoded evidence. Global Delta/profile1 and M1 domains stay
unchanged. This ruling follows the c3bcfc4 counterexample and is not silent domain preservation.

Supervisor approved exact allocation scope: over-deliveryBytes offers refuse before full payload
decoder/canonical-payload-buffer allocation; retained captured grammar containers are bounded
by profile counts, and count/decode/verification use the same representation. Existing input
storage, own-key enumeration/reflection arrays, runtime/GC and user accessor/Proxy-trap
allocations/execution are excluded, not claimed constant-memory. Enumerable symbols/unknown
fields still refuse. Six Rust route probes and TS spies observe exactly decoder entries and offered
carrier canonical-buffer entries; a pre-gate decoding bypass makes the rail red. No global Delta,
profile1, M1, hash, old vector-row or refusal-code change follows from this limitation.

Final native-failure provenance repair: getter/Proxy failures may throw exported scanner error
classes. `instanceof` cannot prove an error came from this scan. Only refusal objects issued by
the current invocation retain their scanner code; every foreign thrown value maps to
invalid-appearance. Invocation-local identity tracking adds no cache/global state or domain
change. Native count/capture/ownKeys spoof probes execute both invoke and preflight.

## Accepted M2 follow-up P1/A1/A2

The bounded follow-up to Fable review-m2-fbd3df8 is specified in [M2-FOLLOWUP.md](M2-FOLLOWUP.md).
P1 removes one redundant same-invocation snapshot decode through a federation-owned private
commitment checker, with defensive TS source copies and fresh independent readback. A1 adds the
malformed capture authority-pointer stage-4 vector. A2 makes serialized host snapshots opaque
and measures actual source4097 endpoint refusals in both witnesses, separately from native
preparation. Original goldens/error order/native source checks remain unchanged; there is no
public skip-verification proof or cross-call cache. Exact-head independent diff review is pending.
