# Portable read/materialization contract packet

**Accepted contract with M1 codec implementation; M2–M5 remain prospective.**

Read [SPEC.md](SPEC.md), [DECISIONS.md](DECISIONS.md), [BOUNDARIES.json](BOUNDARIES.json),
[API.json](API.json), [ACCEPTANCE.json](ACCEPTANCE.json), [MILESTONES.json](MILESTONES.json),
[TRANSPORT.md](TRANSPORT.md), [TOWERS.json](TOWERS.json), [CI.md](CI.md),
[bootstrap.json](bootstrap.json), [LOAM-TRIAL.md](LOAM-TRIAL.md), then [HANDOFF.md](HANDOFF.md) and [REVIEW-REPAIRS.md](REVIEW-REPAIRS.md).

MR-01–MR-24 live only in canonical [SPEC-16](../../spec/16-materialization.md). ACCEPTANCE maps requirements to stable cases; MILESTONES fixes
case allocation. The original JSON cards describe future gates, not passed results. [M1.md](M1.md) describes executable codec gates and their scope. Run the packet's
structural checks with `node contracts/materialization/validate.mjs --self-test`.

Baseline: Rhizomatic main `21b209ed1b14e749a5e7cf84fd9eef4f8e592fb0`, Loam main `ae0e4e21`.
The supervisor-selected trial is copied into this packet: CI and implementers need no audit
workspace. Prior command/profile-1 contracts are unchanged. The external originating documents
are provenance, not dependencies: `refactor-audit/loam-integration/NEXT-SPAN-PLAN.md`,
`NEXT-MATERIALIZATION-CONTRACT.md`, `COMPLETION.md`, and supervisor `LOAM-TRIAL.md`.
