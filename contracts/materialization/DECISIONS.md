# Decisions fixed for this profile

These are concrete engineering choices for review, not claims that Myk dictated every field.
Observable changes require a synchronized contract/case amendment before implementation.

| Decision | Reason / consequence |
| --- | --- |
| New `rhizomatic.materialization/1` endpoint and vocabulary | Profile 1 has a closed two-operation grammar. No broadened caller/source authority or changed hashes. |
| Generic unsigned evidence accepted by M1; commands require signatures | Native HView can contain legal unsigned deltas. Codec validity is distinct from admission. |
| Appearance key hashes full canonical appearance, not Delta ID | Detached signature is outside claims identity. Preserve exact signature presence/choice and repeated entries. |
| Reading key hashes body plus optional metadata | schemaHash/schemaCanonicalHex omit name/alg; Loam child decoration reads name. Same semantic pin can carry distinct native identities. |
| Independent expansion/readings maps; missing legacy reading codec-valid | Native gather permits legacy expansion but resolve refuses it. No parent fallback or native behavior amendment. |
| Embedded finite child trees | No object sharing, cyclic handles or implicit registry traversal crosses a port. |
| Core only in the new profile | The selected Loam trial needs no lowering. Existing profile-1 principal modes remain supported; no invented portable account profile. Pure reading orders exclude context-dependent aliases/inView/actsFor. |
| Separate operand at, definition-at and serving-at | Loam historical reads use current selected schemas, which may have been published after the requested past instant. Signed original definitions are validated at explicit definition-at. Same program pin does not collapse differing temporal selection bases. |
| Trusted host capture, exact selected binding, represented authority context | Canonical bytes and signatures cannot implement application accounts/slates/consent. Grant selection is a native boot root; attributed authority/1 describes the basis without granting itself. |
| Full snapshots, raw inventory separate from operands | Physical removal and equal-count replacement must invalidate; exclusion IDs cannot become fabricated input. Provenance of overlapping peers is retained. |
| Stable revision excludes observation times | A fresh currentness check cannot invalidate an unchanged source merely because time passed. Transport identity still covers observations, and authority/component changes change revision. |
| Final source check followed by independent control CAS | Sequential sources need no global lock. Selection may become stale after the check; completed outcomes describe that basis, and subsequent reads check/refuse. No latest-at-commit guarantee. |
| Durable metadata/program support only | Source payloads and results are disposable inputs/caches. Persisting a second operand database would require new purge/WAL surfaces. Control stores signed capture commitments, not plaintext operand copies. |
| Explicit snapshot on read and time advance | Restore is possible in another witness with control bytes plus independent source artifact. Original commitment can be reconstructed with fresh carrier signatures; no old native signer needed. |
| Terminal retirement by descriptor ID | Names/aliases cannot activate state; restart cannot resurrect it. New definition/time-selection identity needs a new descriptor. |
| Reevaluate attempts, exact expected control/source | No request receipt cache, automatic rebasing, hidden retries or exactly-once claim. |
| Complete batch compute before CAS; disposable rebuild afterward | Known semantic failure refuses before selection changes. A later host rebuild/signing fault cannot falsely claim no effect. |
| Current source/config checks and independently bound returned context | Cached HView equality never reuses old permission. Receiver outcomes are testimony, not execution proofs. |

## Inspected facts and proposal clarifications

- TS `src/algebra/hview.ts` and Rust `src/hview.rs` preserve full native Delta entries but render
  claims without validFrom/validUntil and substitute nested expanded targets. That rendering
  is not reversible; the new envelope is a separate encoding.
- TS `src/syntax/term-io.ts` and Rust `src/term_io.rs` hash reading props/default only. Metadata
  must not be keyed only by schemaHash. SPEC deliberately distinguishes transport keys.
- TS `src/resolve/eval.ts` and Rust `src/eval.rs` file once per delta ID per bucket, thread
  annotations, index expansions by authored pointer position, bind child readings using the
  ambient or fix-local environment and evaluate validity at explicit time. No new codec reorders
  arrays or replaces that evaluator.
- Native pure policy resolution refuses missing child readings; `syntax/pred` refuses inView,
  aliased matches and actsFor unless the consuming stage supplies their context. This profile
  bounds reading orders rather than claiming a lowering capability that does not exist.
- Existing exact definition readers validate a chosen instant. New profile passes explicit
  definition-at; it does not change profile-1's R-22 instant.
- Native reactor materialization objects are volatile; its lowering callback is a native
  extension. This delivery supplies represented lifecycle selection instead of advertising
  the callback as portable semantics.
- Existing coherent journal capture checks full signed admitted rows. Loam's narrower capture
  and physical row inventory remain Loam-owned; a journal head alone cannot prove availability.

No unavoidable change to an existing canonical format was found. The originating proposal's
blanket missing-reading rejection and the early draft's source lease/full durable snapshot
were narrowed before freeze to fit actual native behavior and the approved span. These are
documented decisions, not pending semantic TODOs. Fable may find a contradiction; record any
such finding against the exact requirement/case before code. The API graph is preserved.
