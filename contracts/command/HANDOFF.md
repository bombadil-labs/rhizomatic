# Implementation handoff: Rhizomatic command profile 1

Implement the bounded profile in [SPEC.md](SPEC.md), with the library acceptance framework in [BOUNDARIES.json](BOUNDARIES.json), scenarios in [ACCEPTANCE.json](ACCEPTANCE.json), and enforcement in [CI.md](CI.md). The originating audit packet targeted a requested implementation worker. This adopted handoff records the implementation contract and provenance; acceptance is established by executed evidence and independent review.

The result is one delta-described command interface supporting durable retain and evaluation, portable descriptions and results, and reproducible composition across TS and Rust. Every current library gets an explicit boundary card and an inventory of its semantic surface. Completing this assignment establishes profile 1; it does not close every item in the broader gap ledger. [DECISIONS.md](DECISIONS.md) records the rationale and scope. The adopted normative source is [spec/15-command.md](../../spec/15-command.md). [MILESTONES.json](MILESTONES.json) freezes the required case identities and milestone allocation independently of their descriptions.

## Working scope

- Work in an explicitly authorized Rhizomatic development checkout. The four `refactor-audit/*-before` and `*-after` snapshots remain read-only. This packet itself grants no release, deployment, Loam modification, or communication authority.
- Read the checkout's `AGENTS.md`, relevant witness notes, normative specs and vectors. ADLC was suspended at the inspected baseline; do not invent an ADLC requirement from old metadata.
- Compare the checkout with baseline `454e7ac` before assigning files or trusting a cited implementation fact. Record changed assumptions in the implementation spec. Do not revert newer work to match the snapshot.
- The new command-profile task is separate from the older step-number roadmap. Do not fold Loam migration, general step 8 work, or arbitrary reactive execution into it.
- Preserve native APIs and canonical formats unless a demonstrated contradiction requires a documented amendment. Resolve contradictions in specification/vectors before encoding them as witness-specific behavior.
- Use ordinary implementation judgment for names, data structures, internal APIs and test layout within this contract. Escalate a semantic contradiction or an unavoidable change to a settled requirement; do not ask Myk to decide routine coding choices.

## Read in this order

1. Rhizomatic README/The Dream, SPEC-0 and package graph, to understand why portable semantics matter.
2. [SPEC.md](SPEC.md), especially R-01–R-03 and R-28–R-34, then [DECISIONS.md](DECISIONS.md).
3. [BOUNDARIES.json](BOUNDARIES.json), [ACCEPTANCE.json](ACCEPTANCE.json), [CI.md](CI.md), [TOWERS.json](TOWERS.json).
4. Existing specs and implementation evidence named by the affected cards: Delta, syntax, Schema/registry, resolution, principal, durable peer admission.
5. Historical external audit resource: `refactor-audit/RHIZOMATIC-GAP-LEDGER.json` records outstanding ecosystem work outside this delivery. It is outside the repository; the relevant deferred boundaries are retained in [TOWERS.json](TOWERS.json).
6. Historical external audit resources: `refactor-audit/intake/PROPOSAL.md` and `refactor-audit/intake/probe.ts` contain earlier design history. They are not repository-local dependencies or executable conformance evidence. Do not copy their draft vocabulary, volatile admission or cached-response semantics into production.

## Milestones

Keep the two witnesses within one milestone of each other. Each milestone ends with concrete source/vector changes and evidence tied to a frozen head. Independent review follows the repository's established process; no new approval ceremony is implied. Do not report “done” after implementing only TypeScript.

Coordinate implementation and independent review within the user’s explicit authorization. The delivery authorization permits supervised TS/Rust workers and fresh independent review; earlier audit-thread restrictions do not override it. If review coordination is unavailable, finish the concrete implementation packet and report review as pending, as described in DECISIONS.md.

| Milestone | Deliverables | Acceptance and stopping boundary |
| --- | --- | --- |
| M0 — Contract adoption and inventory | Integrate the normative profile into `spec/` with an available document number; enumerate finite bootstrap; map all exported semantic APIs and Rust/TS ownership; install boundary/capability/coverage manifests and their schemas; create the shared fixture plan and tower stage/port inventory | M0 cases pass as checker/document evidence; all R-IDs and scenario IDs have owners. Existing native gaps stay explicitly deferred. Do not claim runtime support yet. |
| M1 — Portable descriptions | command-data readers/writers; strict existing-format View decoder in resolve-kernel; canonical shared description/result vectors; fixed conformance transport for exchanging descriptions | Both witnesses pass M1 cases and existing affected vectors. Pure parsing has no dispatch/installation effects. Command capability remains incomplete. |
| M2 — Durable retain | Explicit endpoint boot configuration; address/validate/authorize/dispatch; atomic inert signed-loose retain through existing journal; response signing; restart/conflict/uncertainty behavior | Both witnesses pass M2 cases including real durable reopen and fault injection. No native request-ID response cache. No raw-row bypass. Evaluate is not advertised as complete until M3. A development endpoint can gate the unfinished profile as unavailable. |
| M3 — Evaluation and composition | Coherent admitted-source capture; catalog source; complete supplied definition registry; named principal interpretation; typed result readback; head/digest preconditions | Both witnesses pass M3 cases, including stale/degraded sources, nested programs, principal suppression and write→query. Existing algorithms are reused or corrected at their semantic owner. |
| M4 — Interoperability and enforcement | Mixed-witness runs in both directions; three seeded tower assignments per selected scenario at supported ports; replay artifacts; CI gates/negative checker fixtures; all existing gates; documentation and changelog; independent review | All M0–M4 requirements pass on the exact implementation head. Publish exercised boundary edges and unsplit regions as well as remaining library gaps. No release or Loam trial is required or authorized by this packet. |

M0 includes all-library classification, not implementation of every library's future delta binding. A boundary card's `first_delivery_success` is required here. `later_portability_success` states a separate target obligation. In particular: HView transport (V1), materialization declarations (E2), full principal-query/result representation (I2), richer peer policies/testimony (F1/F2), and artifact/reactive bindings (D1) remain tracked.

## Concrete file responsibilities

- `spec/`: adopted command profile and any explicit clarifications to existing contracts. The temporary R-IDs must remain traceable even if the prose moves.
- `vectors/command/`: concrete shared fixtures, including invalid forms and expected canonical output. The final vector filenames are an implementation choice; the scenario IDs are stable coverage keys.
- `contracts/` or an equivalent documented directory: library cards, public semantic API classifications, bootstrap inventory, ownership/dependency mapping, witness/profile capabilities, required scenario index.
- TS `src/command-data/` and `src/command/`: new semantic boundaries; maintain existing aggregate exports intentionally.
- Rust: equivalent logical ownership and public entry points, without a gratuitous workspace/crate split. Shared source files need symbol ownership or a small justified split, not a misleading one-file/one-library claim.
- Existing owners: View decoder in resolve-kernel; complete program reference analysis in syntax/schema; consistent journal source capture in federation. Do not duplicate those algorithms in command.
- `tools/` and existing CI: schema/inventory/dependency/coverage validation and the mixed-witness runner. Actual filenames may follow repository conventions.

## Evidence to return

For each milestone report its exact commit, requirements completed, concrete vectors/tests, TS/Rust results and remaining limitations. Final output includes the boundary matrix by gate dimension, not one undifferentiated pass label. Attach actual scenario coverage reports, mixed-witness artifacts and durable fault results. Record any spec amendment and why it was necessary.

The acceptance artifacts must distinguish: spec completeness, implementation conformance, and later ecosystem portability. A passing import graph is not a proof of semantic closure. A lossless canonical result blob is not proof of structural queryability. A recovered journal is not proof of exactly-once command execution.

The full profile is deliberately small enough to finish. New materialization, stored-function and reactive command profiles should build on the resulting invocation and outcome contract in later assignments.
