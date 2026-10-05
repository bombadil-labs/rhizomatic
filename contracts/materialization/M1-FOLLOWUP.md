# Bounded M1 follow-up to accepted 965b223

Fable accepted original M1 at `965b223f2699b99f71f14d9dd79b74987c0fb102`.
This follow-up addresses F1/A1/A2/A3 only; its independent diff review is pending. No M2+ runtime
work or public codec signature change is included. Canonical bytes, native domain and refusal
codes are preserved. All pre-existing shared vector expectations remain unchanged; four A1
negative fixtures are the only semantic corpus additions.

## Dispositions

| Finding | Repair | Executed evidence |
|---|---|---|
| F1 | Each codec invocation has a private successful-verification set keyed by the full canonical appearance commitment, including signature presence/bytes. Native canonical signature spelling is checked on every occurrence. TS verifies captured claims/ID/signature bytes, without trusting native object identity. Decode reuses its successful table checks in its final exact re-encode. No negative or cross-call cache. | TS spies on the actual verifier; Rust compiles the exact core source with a counter wrapper delegating to the real verifier and compares output with the public crate. Repeats 1/32/1000, distinct signed appearances, signed/unsigned forms, two valid signatures sharing an ID, changed/uppercase signatures and per-call reset are exercised. TS additionally mutates a native object between entries. Measurement hosts exercise 1000/16384 entries. |
| A1 | Wrong format, malformed embedded Schema body, short signature and duplicate key inside claims. Embedded appearance/reading commitments and references are recomputed, so digest mismatch cannot mask the intended boundary. | Four shared negatives in evidence-envelope.json; both witnesses and serialized receiving hosts refuse invalid-evidence. |
| A2 | Require the complete expected vector identity roster, raw corpus SHA-256 and exact assertion counters in addition to passed test names. TS uses expect.assertions and actual expect state; Rust counters increment after executed assert macros. | 82 receipts per witness: 25 positive, 42 negative, 2 native spelling refusals, 7 reading and 6 syntax fixtures. Validator sensitivity rejects missing receipt, zero assertion count and wrong identity. VECTOR-ASSERTIONS.json retains receipts and negatives. These receipts cannot prove arbitrary assertion semantics; independent review and the actual comparisons remain necessary. |
| A3 | Resolve the adapter executable from Cargo's compiler-artifact message, rather than a hardcoded target path. Acceptance propagates the supplied environment to Cargo and the tower host. | Acceptance plus exact replay runs with CARGO_TARGET_DIR=/tmp/rhizomatic-m1-followup-target and M1_ARTIFACT_DIR=/tmp/rhizomatic-m1-followup-evidence. No adapter path is inferred from the repository's target directory. |

## Repeated-entry measurements

The measurement fixture has one distinct signed appearance. Before and after transport IDs and
artifact lengths agree exactly: 111,523 bytes at 1000 entries and 1,819,147 bytes at 16,384.
[Raw measurements](M1-FOLLOWUP-MEASUREMENTS.json) contain toolchains and both phases.
These are illustrative single samples on this host, not CI thresholds or availability promises.
The deterministic verifier-call regression, rather than elapsed time, is the gate.

| Witness / entries | Encode before → after (ms) | Decode before → after (ms) |
|---|---:|---:|
| TS / 1000 | 1560 → 88 | 1548 → 94 |
| TS / 16384 | 26124 → 938 | 23862 → 1509 |
| Rust release / 1000 | 66.5 → 5.7 | 68.2 → 6.4 |
| Rust release / 16384 | 1130 → 84 | 1112 → 111 |

```
./implementations/ts/node_modules/.bin/tsx implementations/ts/tools/measure-evidence-repeats.ts
cargo run --locked --release --manifest-path implementations/rust/Cargo.toml --example measure_evidence_repeats
```

## Gates and scope

Full native gates: TS 976 tests/53 files; Rust fmt/clippy with denied warnings and 245 passing
tests. The focused acceptance includes 91 TS tests and seven Rust test functions. All 15 stable
M1 IDs remain executed; eight fixed serialized directions, twelve seeded towers and exact replay
remain required. Hostile receive checks now total 84, plus eight deliberately corrupted receives
and six original harness negatives; the assertion accounting has three additional negatives per
witness. M0 structure, live inventories/owner graphs, vector and docs freshness remain required.
The recorded executable report pins the clean follow-up SHA/tree after freezing; it makes no new
independent-review or hosted-CI claim. Existing lower witness/profile1 limitations in the original
[freeze evidence](M1-RESULTS.md) remain unchanged.

External build/evidence reproduction from the repository root (cargo/rustc on PATH):

```
CARGO_TARGET_DIR=/tmp/rhizomatic-m1-followup-target \
M1_ARTIFACT_DIR=/tmp/rhizomatic-m1-followup-evidence \
node tools/check-evidence-acceptance.mjs
CARGO_TARGET_DIR=/tmp/rhizomatic-m1-followup-target \
M1_ARTIFACT_DIR=/tmp/rhizomatic-m1-followup-evidence \
node tools/check-evidence-towers.mjs --replay /tmp/rhizomatic-m1-followup-evidence
```

Replay still checks the actual binary fingerprint. An artifact from a different build/directory
must not silently substitute for the pinned executable; generate a fresh plan against the
available build, then replay that plan exactly.
