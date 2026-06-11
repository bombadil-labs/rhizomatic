# ERRATA & Decisions — SPEC-5 (Resolution, Views & the ABI)

v0 decisions filling gaps SPEC-5 leaves open, pinned by `vectors/l1-eval/eval-resolve.json`.

## R1 — Candidate value extraction

Folded into SPEC-5 §2.1 (2026-06-11); history in git.

## R2 — MergeFn domains and fold order

Folded into SPEC-5 §3 (2026-06-11); history in git.

## R3 — Policy JSON profile

Folded into SPEC-5 §7 (appendix) (2026-06-11); history in git.

## R4 — View shape and canonical form

Folded into SPEC-5 §5 (2026-06-11); history in git.

## R5 — Annotate-tagged entries are candidates

Folded into SPEC-5 §2.1 + §4 (2026-06-11); history in git.

## R6 — Nested resolution

Folded into SPEC-5 §2.1 (2026-06-11); history in git.

## R7 — `resolve` in the term JSON profile

`{ "op": "resolve", "policy": Policy, "in": Term }`. Its operand must be HView-sort; its result
sort View is terminal — no operator consumes a View (SPEC-2 §4.7).
