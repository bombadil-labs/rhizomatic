# Decisions and scope for implementation

The user established the ecosystem goals: semantic state and operations are describable as deltas; commands include writes and queries; each library has explicit bindings and affordances; languages should compose across those contracts; CI should sample three mixed-language towers. Rhizomatic correctness takes priority, with Loam migration later.

The detailed profile choices below are the spec author's engineering decisions for this first delivery. They are requirements of this implementation packet, not claims that Myk independently selected each wire field or restriction. They are versioned choices, not limits on the eventual ecosystem.

| Choice | Why this profile chooses it | What it leaves for later |
| --- | --- | --- |
| One explicit request root | Makes invocation distinct from storing descriptions; no scan can accidentally activate payload | Batches and workflow graphs |
| Peer-signed boot configuration with two installed intrinsic kinds | Makes initial authority and dispatch reconstructible without inventing an installation language first | Runtime installation, delegated administration, artifacts and finer permissions |
| Explicit supplied program closure | Reproduction does not depend on an ambient registry, mutable latest-name selection or network availability | Registry lookup/retrieval commands and governed named selection profiles |
| Re-evaluate each attempt | Reuses journal payload deduplication without inventing durable request receipts or exactly-once semantics | Effect-specific durable invocation/recovery profiles |
| Expected journal head for composition | States a check the current journal can actually enforce, including after restart | Predecessor execution, historical snapshots, transactions and cross-peer workflows |
| Complete admitted-source reads | Avoids presenting stale or incomplete local memory as authoritative database state | Explicit partial/degraded query profiles; the existing peer's degraded API remains intact |
| Inert ordinary payload for retain | A write stores descriptions; it does not activate commands, artifact bindings or erasure effects | Explicit effective-erasure and executable commands |
| Existing View bytes plus strict readback | Gives a lossless portable result without changing established canonical encoding | Structural queryability and full HView transport |
| Existing library ownership plus command-data/command | Separates descriptions from orchestration and reuses lower algorithms | Package publication or alternative source layouts justified by implementation evidence |
| Four initial tower stages | Tests actual portable ports available from this delivery | Finer mixed-library towers as the intermediate contracts become reconstructible |

These decisions resolve the earlier draft's open implementation choices. The old probe is historical evidence, not a normative implementation template. Its volatile `after` prerequisite, result cache, and materialization command do not belong in profile 1.

## What “the rest” means in this assignment

Implement M0–M4 in [HANDOFF.md](HANDOFF.md), with the exact case allocation in [MILESTONES.json](MILESTONES.json). This includes adopting the profile, materializing concrete vectors, coding both witnesses, inventorying all libraries, and implementing the specified CI checks/towers. It does not mean closing the entire ecosystem ledger or building arbitrary reactive execution.

The first milestone reconciles the actual checkout with the pinned baseline and produces the public API/ownership inventory. Concrete vector bytes, the seeded planner implementation, language-aware tooling, and the local conformance adapters are implementation deliverables; their absence from this audit packet is not a request for another planning round.

The implementer can choose internal signatures, module factoring within the allowed graph, vector filenames, transport framing for tests and checker tooling. A change to observable profile behavior, canonical formats, required witness support or promised completion scope needs a documented spec amendment and updated cases. Raise a concrete conflict to Myk if resolving it would change the agreed objective; do not silently choose a different system.

## Review and authority

The implementation agent should finish authorized code, vectors and runnable evidence before requesting a decision. It must not contact other threads without explicit authorization. If an independent reviewer has not been assigned or cannot be contacted under that constraint, return the exact implementation head and review packet with status `implemented; independent review pending`. Do not fabricate a review or label the full completion criterion satisfied. Review coordination is separate from implementing the work.

The local `check-spec.mjs` checks this packet against its frozen source snapshot. Repository CI must use the adopted contracts and actual checkout, not depend on the audit folder or its baseline paths. The local checker is scaffolding, not a production gate to copy unchanged.
