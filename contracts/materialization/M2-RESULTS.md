# M2 builder freeze evidence

This records local M2 batch work against independently accepted M1 43e2c874. The exact local SHA
and tree are reported to the supervisor after freeze; generated ignored REPORT.json pins that SHA
when acceptance is rerun on the clean commit. Independent Fable review, exact-head hosted four-
witness conformance, merge and any release are supervisor-owned and remain outstanding.

## Scope and artifacts

All 27 stable **::batch** obligations are allocated in M2-CASES and executed by shared corpus
receipts plus native probes. Six lifecycle variants remain M3, not green M2 lifecycle capabilities.
The current corpus has 25 successful command schedules, 125 refusals, 15 readback rejections,
4 positive/5 negative descriptions and 5 positive/5 negative source snapshots. Independent full
signed outcomes/body bytes and manually specified native trees are separate from witness code.

Focused acceptance emits actual assertion receipts for both witnesses, 16 fixed five-port mixed
crossings, 24 seeded towers with exact replay and 15 terminating refusal branches. Seven harness
sensitivity negatives and four assertion-accounting negatives are supplemental checks, not proof
of arbitrary semantic assertions. Real retained profile1 journals remain inert; current source
mutation and support-refusal decisions use actual inventory/fact fixtures. Native TS owned input capture
and receive-time interleaving execute; safe Rust invocation slices do not claim an async mutation
port. Deterministic work probes distinguish bounded logical results from cumulative allocations.

Evidence lives in ignored artifacts/materialization-m2: REPORT, COVERAGE, VECTOR-ASSERTIONS,
TS-TESTS, native Rust logs, CAPABILITIES, EVIDENCE, plans, stage artifacts and MEASUREMENTS.
The M1 gate retains separate artifacts/materialization-m1 evidence. Source-pinned profile1 stage/
tower evidence is generated separately; final profile1 acceptance cannot be claimed without hosted
exact-commit four-witness conformance. Temporary /tmp log files are diagnostics, not runtime inputs.

## Local gates

TS format/lint/typecheck/full suite pass: **1,183 tests across 59 files**. Rust fmt/clippy
with warnings denied/full native suite pass: **252 test functions**, plus the finalized three-test
size suite (**253 distinct functions** across the full and focused runs). Shared schedules execute
inside those functions. WASM release clippy/build, TS build, playground and docs bundles pass.
The baseline/new harness regression run passes97 tests; Rust boundary sensitivity passes45.
Focused M2 acceptance runs207 TS tests after the mirrored pending-child work probe. Local
measurements are observational; [M2.md](M2.md) gives exact boundaries and candid limits.

```
npm run check --prefix implementations/ts
cargo fmt --check --manifest-path implementations/rust/Cargo.toml
cargo clippy --locked --all-targets --manifest-path implementations/rust/Cargo.toml -- -D warnings
cargo test --locked --manifest-path implementations/rust/Cargo.toml
cargo clippy --locked --release --target wasm32-unknown-unknown --manifest-path implementations/rust/Cargo.toml -- -D warnings
cargo build --locked --release --target wasm32-unknown-unknown --manifest-path implementations/rust/Cargo.toml
npm run build --prefix implementations/ts
npm run playground:build --prefix implementations/ts
npm run docs:build --prefix implementations/ts
npm run gen-vectors --prefix implementations/ts
npm run gen-command-vectors --prefix implementations/ts
npm run gen-evidence-vectors --prefix implementations/ts
npm run gen-materialization-vectors --prefix implementations/ts
node contracts/materialization/validate.mjs --self-test
node tools/check-command-contracts.mjs --self-test
node tools/check-package-graph.mjs
node tools/check-rust-command-boundaries.mjs
node tools/check-command-bootstrap.mjs
node tools/check-command-boundary-negatives.mjs
node tools/check-command-description-transport.mjs
node tools/check-command-oracle.mjs
node --test tools/check-materialization-accounting.test.mjs tools/command-tower*.test.mjs tools/check-command-acceptance.test.mjs tools/check-command-bootstrap.test.mjs tools/command-inventory.test.mjs tools/check-rust-command-boundaries.test.mjs
node tools/probe-materialization-input-allocation.mjs
node tools/check-materialization-acceptance.mjs
node tools/check-materialization-towers.mjs --replay artifacts/materialization-m2
node tools/measure-materialization.mjs
node tools/check-evidence-acceptance.mjs
node tools/check-evidence-towers.mjs --replay artifacts/materialization-m1
git diff --check
```

The live inventories classify **2,293 TS exports**, **707 Rust exports/6,366 dependency records**;
the checked TS owner graph has 101 modules/451 imports/14 packages. Rust inventory regeneration
changes the actual dependencies of edited/new source and preserves the live multiset, not a
hand-deduplicated approximation. Against the accepted base it adds 1,265 records and removes 75
(1,190 net); all differences originate in this slice's edited/new modules. The large serialized diff
also reflects record ordering/formatting, not 39,000 new semantic dependencies. The scanner visits
cfg(test) bodies and allows only literal include_str, parsed println arguments and inert builtin test
attributes; hidden environment/upward imports still fail. Private trace Rc/RefCell allowance is
restricted to evaluation_budget, with no new source/clock/I/O root.

M0 structural checks retain 99 specified cases, 24 requirements and six milestones with 19
sensitivity negatives, including missing batch/lifecycle allocation and missing actual vector IDs.
Original prospective cards remain prospective and do not certify runtime capabilities.

## Practical limits and review items

Preliminary source4096: TS gather26.05 s / resolve8.22 s, whole-child peak1,120,440 KiB;
Rust release gather1.17 s / resolve0.37 s, whole-child peak173,640 KiB. Snapshot is3,293,968 bytes.
Real verifier calls: gather12,299; gather-readback12,312; resolve4,111; resolve-readback12,313.
Separate snapshot decoder calls account for the repeated N passes; M1 per-distinct appearance
caching remains per codec invocation. Invocation-local duplicate snapshot validation is a concrete
avoidable-work review candidate, left unchanged here. Fresh native current-support checks remain.

RSS includes parsed fixtures with independent goldens/carriers, phase inputs/results, runtime/GC
and scalar counter instrumentation. Bundler/compiler parents are excluded. No per-phase memory
measurement or causal memory claim is made. The fixed nested fixture and source-size sweep record
canonical lengths/full bytes; 4097 refuses before embedded verification without filtering. No
wall-time threshold or practical Loam feasibility is inferred. M3 install/replacement/restore and
M5 actual Loam trial measurements remain deferred.

Local host has no GHC and Elixir1.12.2/OTP24, below the configured Elixir1.18/OTP27 and GHC9.4
CI toolchains. Their unchanged Level0 gates require hosted execution. No native stack interchange,
whole-Loam migration, source/control lease, execution proof or released package is claimed.

## Delivery allocation repair evidence

Checkpoint c3bcfc499389506b98521201398ce53822480a7c and its completed baseline evidence are
preserved under /tmp/rhizomatic-m2-c3bcfc4-evidence for review; they are not runtime/CI inputs.
All pre-existing commands.json rows compare deep-equal to that checkpoint. Fifteen new shared
refusal schedules cover byte saturation plus malformed base64 alphabet/tails/length, number
shape and signature spelling, in both permutations, including a signed 16KiB carrier.

Actual TS spies and six instrumented Rust invoke/preflight schedules observe zero payload
`decoderEntries` and zero offered `carrierCanonicalBufferEntries` for oversized offers. The
Rust pre-allocation decode-bypass sensitivity probe fails as required. Boot/outcome verification
legitimately constructs its own small canonical bytes; these are not offered-carrier entries.
`ALLOCATION-PROBE.json` carries corpus and instrumented-build digests. No production counters
or altered verifier is introduced. Preferred numeric/header/text widths and every target arm are
checked independently against existing C, including contexts, Unicode and optional validity.

Exact scope: over-deliveryBytes offers refuse before full payload decoder/canonical-payload-
buffer allocation. Retained captured grammar containers are bounded by profile counts, with one
captured representation. Existing input storage, own-key enumeration/reflection arrays, runtime/
GC and user getter/Proxy-trap allocations/execution are excluded. No claim all JS extra allocations
are bounded, constant-memory arbitrary-object enumeration, sandbox or scan-CPU limit is made.
Symbols/unknown fields still refuse. Transparent Proxy admission is the explicit supervisor-
approved new-port native exception; native Delta/profile1/M1 domains and unaffected hashes stay.

The final native TS failure-provenance probe covers forged exported scanner errors from getters
and Proxy ownKeys, in both routes and both count/capture phases. Only this invocation's issued
refusals preserve their code; foreign failures are invalid-appearance. No global mutable brand,
cache or grammar/domain change is introduced.
