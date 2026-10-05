# Original M1 builder freeze evidence (965b223)

This records the original M1 freeze, independently accepted by Fable at 965b223. The bounded
follow-up is recorded separately in [M1-FOLLOWUP.md](M1-FOLLOWUP.md). Hosted integration
remains supervisor-owned. M2–M5 are specified, not implemented. The exact local freeze SHA is
reported in the supervisor handoff; the generated ignored `artifacts/materialization-m1/REPORT.json`
pins that SHA, source tree and clean status when the gate is rerun on the frozen commit.

## Executed scope

- TS full gate: 966 passing tests across 52 files, including 81 focused M1 tests.
- Rust full native gate: fmt, clippy with warnings denied, and 244 passing tests. Focused M1
  includes six test functions executing shared schedules plus native fix/binding/metadata and
  hand-counted syntax boundaries. Owned Rust types cannot represent native object cycles.
- Rust WASM release clippy/build pass; no new WASM runtime codec capability is advertised.
- All 15 allocated M1 IDs executed. COVERAGE.json names each actual case and its TS/Rust logs.
  Four fixtures (original, reading metadata, legacy missing reading and reserved keys) each run
  both serialized directions and three seeded towers with exact replay: eight fixed routes and
  twelve towers. Two codec stages have only two distinct mixed assignments; the third records
  its repeatedFrom explicitly.
- 76 hostile receiving checks (38 shared vectors in both witnesses), eight additional corrupted
  receiving artifacts, and six named harness sensitivity negatives pass.
- Independent exact bytes: 25 envelope positives, seven reading appearances, two independent
  empty grammar oracles; six hand-counted syntax fixtures. Native signature-spelling refusals,
  repeated native syntax sharing and cycles are exercised separately.

## Reproduced commands

From the repository root (cargo/rustc on PATH), heavy witness suites were serialized:

```
npm run check --prefix implementations/ts
cargo fmt --check --manifest-path implementations/rust/Cargo.toml
cargo clippy --locked --all-targets --manifest-path implementations/rust/Cargo.toml -- -D warnings
cargo test --locked --manifest-path implementations/rust/Cargo.toml
cargo clippy --locked --release --target wasm32-unknown-unknown --manifest-path implementations/rust/Cargo.toml -- -D warnings
cargo build --locked --release --target wasm32-unknown-unknown --manifest-path implementations/rust/Cargo.toml
npm run build --prefix implementations/ts
npm run docs:build --prefix implementations/ts
npm run gen-vectors --prefix implementations/ts
npm run gen-command-vectors --prefix implementations/ts
npm run gen-evidence-vectors --prefix implementations/ts
node contracts/materialization/validate.mjs --self-test
node tools/check-command-contracts.mjs --self-test
node tools/check-package-graph.mjs
node tools/check-rust-command-boundaries.mjs
node tools/check-command-bootstrap.mjs
node tools/check-command-boundary-negatives.mjs
node tools/check-command-description-transport.mjs
node --test tools/command-inventory.test.mjs tools/check-rust-command-boundaries.test.mjs tools/check-command-bootstrap.test.mjs tools/command-tower-plan.test.mjs
node tools/check-evidence-acceptance.mjs
node tools/check-evidence-towers.mjs --replay artifacts/materialization-m1
git diff --check
```

The baseline harness regression command passes 59 tests. M0 validates 99 specified cases,
24 requirements and 15 structural negative checks. Live inventories classify 1,977 TS exports
and 595 Rust exports/5,165 dependency records; the existing owner graph remains acyclic.
Original vectors, profile1 coverage/capability cards and lockfiles are unchanged. Docs bundles
are rebuilt from source. The explicitly approved previously lossy reserved-key TS correction is
recorded in SPEC-16 and E23; it is not an unexplained hash change.

## Limits of this evidence

No hosted CI or independent review acceptance is claimed. This machine lacks GHC and has
Elixir 1.12/OTP 24, below the declared Elixir 1.18/OTP 27 requirements. Their unchanged L0 gates
remain required in CI. The complete existing profile1 acceptance gate requires real exact-head
four-witness conformance evidence; that external certification is not fabricated locally.
Its TS/Rust full suites, actual bootstrap pins, both description crossings and ten complete
result-readback transport cases pass locally; the full existing CI gate remains in place.
No source grant, receiver permission, durable lifecycle or execution proof follows from M1.
