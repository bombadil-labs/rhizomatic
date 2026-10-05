# Portable read/materialization contract packet

**Proposed M0 contract, not an implementation or a conformance certificate.**

Read [SPEC.md](SPEC.md), [DECISIONS.md](DECISIONS.md), [BOUNDARIES.json](BOUNDARIES.json),
[API.json](API.json), [ACCEPTANCE.json](ACCEPTANCE.json), [MILESTONES.json](MILESTONES.json),
[TRANSPORT.md](TRANSPORT.md), [TOWERS.json](TOWERS.json), [CI.md](CI.md),
[bootstrap.json](bootstrap.json), [LOAM-TRIAL.md](LOAM-TRIAL.md), then [HANDOFF.md](HANDOFF.md).

MR-01–MR-24 live only in SPEC. ACCEPTANCE maps requirements to stable cases; MILESTONES fixes
case allocation. The JSON files describe future gates, not passed results. Run the packet's
structural checks with `node contracts/materialization/validate.mjs --self-test`.

Baseline: Rhizomatic main `21b209ed1b14e749a5e7cf84fd9eef4f8e592fb0`, Loam main `ae0e4e21`.
The supervisor-selected trial is copied into this packet: CI and implementers need no audit
workspace. Prior command/profile-1 contracts are unchanged. The external originating documents
are provenance, not dependencies: `refactor-audit/loam-integration/NEXT-SPAN-PLAN.md`,
`NEXT-MATERIALIZATION-CONTRACT.md`, `COMPLETION.md`, and supervisor `LOAM-TRIAL.md`.
