# CI contract for command intake and library boundaries

CI should reject mechanical boundary violations and observable semantic regressions. Independent review assesses whether the declared boundary is the right one. Neither replaces the other.

The checkout-relative tools and `.github/workflows/ci.yml` implement these gates. No production or CI tool imports the originating audit workspace. The aggregate runner records executed evidence; independent review remains a separate exact-commit gate.

## Existing enforcement to retain

At `454e7ac`, TS `npm run check` includes `tools/check-package-graph.mjs`, formatting, lint, type checking and tests. The package checker accounts for runtime and type edges, rejects upward/undeclared package edges and internal imports of the aggregate barrel. Rust has fmt/clippy/tests and a WASM build. CI also enforces docs/vector freshness and the lower-level Elixir/Haskell gates. `tools/check-all.mjs` invokes declared witness checks; it is not itself an artifact exchange between witnesses.

Keep these checks. Extend their manifests/reporting instead of replacing them with a new ceremonial framework. Fix the documented dependency graph if it differs from the actual enforced map; the audited baseline's principal dependency list is one place to reconcile.

## Required new gates

| Gate | Required evidence | Failure condition |
| --- | --- | --- |
| Contract schema and coverage | Versioned machine-readable cards, bootstrap entries, export classifications, profile capabilities and requirement/case index | Missing field/owner/API/case, invalid reference, duplicate ID, unsupported capability claim, or unknown state |
| Dependency boundaries | TS AST imports/reexports/types; Rust logical ownership and resolved cross-owner references | Undeclared/upward edge, aggregate dependency, unmapped production module, or silently unexamined import form |
| Pure core boundary | Allowed external dependencies and declared intrinsic/capability use | Core source directly reads clock/environment/files/network or reaches a runtime capability through an undeclared dependency |
| Shared canonical conformance | Same committed fixtures loaded independently by TS and Rust | Different expected bytes, invalid accepted data, missing family or semantic case |
| Mixed-witness composition | Serialized producer→executor→reader artifacts in both directions | Private native state needed, unsupported profile, incorrect signature attribution, missing dependency, or unequal specified result |
| Randomized towers | Three seeded stage-language assignments per selected scenario, with explicit portable ports and replay artifacts | Wrong result, undeclared port, unavailable capability, hidden same-language fallback, non-replayable failure or shared mutable tower state |
| Durable behavior | Store/facade tests with deterministic fault and contention injection plus real reopen | Premature success, false refusal after possible commit, partial atomic offer, duplicated arrival, stale/partial successful query, or refusal bypass |
| Evidence completeness | Reports emitted by actual test runners with exact discovered/executed scenario IDs | A required ID missing, skipped, duplicated ambiguously, xfailed, or represented only by a static fixture filename |

These are gating dimensions, not a score. A report must show each library's relevant dimensions and separate deferred target obligations. `not_applicable` requires a reason; it cannot be used for a profile requirement exercised by that library. Report proposed, deferred, implemented-unverified and demonstrated distinctly.

## Machine-readable contract inventory

The repository implementation should adopt strict schemas for:

1. **Library cards:** IDs and allowed dependencies from BOUNDARIES.json; semantic contracts; references to spec requirements and vector/test IDs; bootstrap/native/capability classifications; deferred obligations.
2. **Public semantic API inventory:** stable owner + export/symbol + contract ID + classification. Enumerate real exports through language-aware tooling, including type declarations and reexports. Alias/compatibility exports map to their original contract. Pure implementation helpers can be classified without inventing a wire representation for each function.
3. **Witness capabilities:** current conformance level plus explicitly supported profile names/versions. An L4 declaration alone does not imply intake support. Only TS/Rust must gain this new profile now.
4. **Scenario coverage:** case ID, milestone, requirement IDs, evidence kind, required witness set, concrete vector/test IDs and result artifacts. Reuse existing vector families where they prove the obligation; do not count mere filenames as passing results.

The tool must cross-check the actual code/test inventory with manifests. A manually updated list of "everything passed" is insufficient. Changing the public surface, a declared profile, a vector family or a requirement changes the coverage obligation automatically. A capability cannot become supported while any required scenario lacks executed evidence.

M0 establishes the inventory at the authorized working head. This packet supplies initial semantic cards, not a claim that every current export has already been classified. M0's coverage checker must fail on unclassified production exports after that baseline is adopted. Deferred/native-extension entries require a description of the observable semantics and owner; an empty exemption string is not a classification.

## Dependency analysis and its limits

Use TS AST analysis for imports, exports, inline import types and literal dynamic imports. Ban or explicitly account for nonliteral dynamic imports and other forms the checker cannot resolve in production core code. An unresolved form must not disappear from the graph. External imports need an allowlist by semantic owner; crypto primitives differ from an undeclared application dependency.

For Rust, establish a logical owner map and analyze relevant paths/reexports/types with language-aware tooling. Shared files may need symbol-level classification or a small refactor. Enumerate feature/target combinations used by supported builds, including host and WASM; a text search alone must not be advertised as a complete Rust dependency proof. The first implementation can reject unsupported macro/import patterns within classified core code rather than silently accepting unknown edges. Test scaffolding and transport adapters have separate explicit ownership.

Native calls between libraries are allowed. The boundary proof concerns explicit semantics and reproducible representation, not serializing a delta for every local function call. No rule requires each existing source package to become a separate published library, service or Rust crate.

Static analysis catches direct hidden-observation dependencies. Tests hold declared inputs fixed while perturbing unrelated host state and check successful result invariance. Review still checks transitive native choices, unsafe classifications and adapters that subtly change standard meaning. Do not present static scans as a complete purity proof.

## Shared vectors and mixed execution

Shared fixtures fix receiver/caller/foreign signing seeds, selected configuration, request bytes, source state, definitions, clock observations and expected semantic/canonical outcomes. Bytes and floats follow existing canonical profiles. Outcomes from equivalent pointer semantics but different request IDs cannot be compared whole-byte without accounting for their references. Real peers with different keys also require attributed semantic comparison.

Use a fixture transport that only exchanges serialized deltas and explicit host observations. Implement equivalent construction, execution and reading modes in both witnesses. The mixed runner must:

1. Ask TS to construct the request/support descriptions and persist the serialized artifact.
2. Pass that artifact to Rust, with the declared receiver state and observations; persist its signed outcome.
3. Ask TS to verify/read the outcome and assert the expected value/context.
4. Reverse the roles for the same required scenarios.

Do not satisfy mixed execution by running two independent native tests that happen to read the same JSON. Both are necessary: fixed fixtures catch shared regressions against expected behavior; mixed execution catches construction/readback incompatibility. A fixture generator may produce canonical data, but expected outcomes must have an independently explained oracle. A result emitted solely by the implementation under test is not an oracle.

Durable tests run separately from pure codecs. Inject failures at each declared store boundary; exercise successful on-disk reopen as well as controlled uncertainty. Reuse existing store-adapter tests when their evidence is sufficient, but new command outcome mapping and coherent source acquisition still need direct tests.

## Three randomized towers per scenario

The end-state target is a complete stack assembled from independently conforming library implementations in TS, Rust, Elixir and Haskell. The initial machine-readable plan is [TOWERS.json](TOWERS.json). The harness starts with proven portable ports and grows as bindings and witness capabilities become available. It must make the current granularity visible.

For the first delivery, use request construction → description validation → command execution → complete outcome readback as executable stages. Description validation produces the same verified serialized artifact; it does not pass a private parsed object or grant execution authority. Execution must still enforce its own trust boundary. Command execution is initially one unsplit region containing several internal libraries; mark that explicitly. A later split between evaluation and resolution, for example, requires the deferred full HyperView binding. Its absence is a real gap, not a reason to pass lossy serializer output as though it were a complete HView.

The stage manifest needs `stageId`, semantic owner(s), input/output contract IDs and versions, effect class, allowed capability requirements, and dependency edges. A witness manifest advertises each independently tested stage contract, its executable adapter and build identity. Every portable artifact carries the exact definition/context references its contract requires. Test transport may frame artifact bytes in files/stdin, but may not introduce a second semantic representation that the public library contracts cannot read.

For each CI run:

1. Select a fixed required scenario set: successful retain→query, catalog discovery, nested definition closure, principal interpretation, nested bytes result, and a refusal. Use the same fixed scenario inputs for every tower; language randomization is distinct from random input generation.
2. Produce a recorded seed. Use a named, versioned seeded planner to choose an eligible witness for each stage and build three concrete plans. Deterministic planner fixtures pin seed-to-plan behavior. The seed, fixed fixture IDs, capability manifest and planner version determine the plans.
3. Prefer distinct plans and require at least one language switch in every plan where a supported mixed assignment exists. If fewer than three distinct assignments exist, explicit repeats are allowed and reported. If no mixed assignment exists for a required first-profile scenario, fail the gate. Do not pretend that a homogeneous fallback tested cross-language composition.
4. Execute each plan with a fresh isolated copy of the same initial receiver state. Fix receiver/caller keys, signed request bytes, configuration, time/arrival observations and any scheduled effects. Never let tower A's writes become tower B's starting state. Whole signed response equality requires these observations and identities to match.
5. Compare each tower with the independently specified expected output, then compare matching intermediate contract outputs and final results across towers. A divergent intermediate artifact is localized to its owner/port; byte comparison follows that port's canonical contract, not JSON property order.
6. Retain plans, inputs, intermediate/output artifacts and diagnostics even on failure. Print one replay command accepting the stored plan; replay must not reroll assignments or silently resolve a newer capability manifest.

The replay bundle includes implementation commit/build identities, toolchain versions, planner version, seed, concrete stage graph, fixture/artifact content hashes, capability snapshot, initial durable state and explicit observation schedule. A seed alone is insufficient after a planner or capability change. Replaying an unavailable build must fail clearly rather than quietly using a newer one.

Log exercised `(producer contract, producer witness, consumer contract, consumer witness)` edges and unsplit regions. This gives a useful coverage history without requiring every Cartesian product in every run. Preserve the two fixed TS→Rust and Rust→TS routes so randomness cannot permanently miss basic interoperability. Scheduled broader runs can sample more seeds later; they are not required to make the three-tower gate useful.

At M4 this proves randomized composition through the first profile's portable stages. It does not certify a fully mixed twelve-library stack. Adding lossless lower-layer bindings and upper-level Elixir/Haskell capabilities makes those finer assignments eligible automatically; it does not justify falsely advertising them in advance.

## Coverage report format

A repository runner report needs at least:

```json
{
  "format": "rhizomatic-conformance-report/1",
  "commit": "exact implementation head",
  "witness": "ts",
  "profile": "rhizomatic.command/1",
  "toolchain": "record actual versions",
  "cases": [
    {
      "id": "query_ephemeral",
      "requirements": ["R-18", "R-20", "R-24"],
      "testIds": ["actual discovered test identity"],
      "status": "passed",
      "artifacts": ["actual canonical artifact reference"]
    }
  ]
}
```

This is a shape example, not a passing report. The coverage gate verifies runner output provenance through the CI job and expected artifact paths, matching exact case IDs to the versioned index. It cannot cryptographically prove a test's quality. Reviewer inspection and negative fixtures address that limit.

Pin each milestone's required case set as all scenarios up to that milestone. Earlier completed requirements remain required as work advances. The final profile gate requires M0–M4, including applicable review evidence in the completion packet; automated jobs do not impersonate the reviewer or send review messages. Existing conformance jobs remain independent required gates.

## Checker negative tests

In disposable fixture trees, prove rejection of: a type-only upward dependency; a runtime upward dependency; an aggregate import; an unresolved dynamic import; an unclassified public export; an unknown spec reference; a missing required case; a skipped required case; a falsely advertised profile; and a deliberately altered canonical result. Verify each fails for the intended reason. This checks the checker, not production implementation behavior.

Run the checkout-relative checks:

```sh
node tools/check-command-contracts.mjs --self-test
node tools/check-package-graph.mjs
node tools/check-command-boundary-negatives.mjs
node tools/check-rust-command-boundaries.mjs
node --test tools/check-rust-command-boundaries.test.mjs tools/check-command-bootstrap.test.mjs
```

These checks compare live exports, dependencies, bootstrap bytes, exact scenario identities and milestone allocation with the adopted manifests. They emit named evidence only after actual assertions. Static coverage references describe executable tests; the aggregate report determines which tests actually passed on the measured source.

## Executed evidence in this checkout

The `command` CI job depends on all four existing witness jobs. It records their actual result and checked-out SHA, runs `tools/check-command-acceptance.mjs`, and uploads logs, discovered test IDs, signed artifacts, isolated journal observations, seeded plans and exact replay. A successful automated job proves 77 technical cases and records `independent_boundary_review` as pending. It cannot issue independent acceptance itself.

Run the aggregate with `--out` outside the checkout, `--conformance` containing actual four-witness CI facts, and an explicit `--seed`. A supervisor may supply `--review` with an independently authored exact-commit acceptance record and `--require-review` to require all 78 cases. The runner refuses dirty source, source drift, missing post-assert test identities, stale builds and changed replay artifacts.

`capabilities.json` advertises four serialized stages for TS/Rust only. Its `stage_evidence` names the exact independently-oracled tower cases; the runner binds those declarations to newly executed case reports and measured build identities. Conformance level does not infer command capability. The prospective `rhizomatic.command/1` declaration includes an external acceptance-evidence contract and the exact 78-case inventory. It embeds no source commit or passing status. Acceptance requires a fresh report binding the actual source commit, all existing witnesses and independent exact-commit review; CI alone continues to report that review as pending.

`API.json`, the TS compiler inventory and Rust syn inventory classify public declarations and member interfaces, including compatibility exports and explicit host capabilities. Rust analysis limits are recorded in [rust-command-boundaries.md](../../tools/rust-command-boundaries.md). Graph checks direct owner dependencies and ambient observations, without claiming proof of transitive implementation purity. Bootstrap pins are compared against actual native exports in both witnesses and shared canonical vectors.
