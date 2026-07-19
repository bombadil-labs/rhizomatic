# ERRATA & Decisions — SPEC-5 (Resolution, Views & the ABI)

v0 decisions filling gaps SPEC-5 leaves open, pinned by `vectors/l1-eval/eval-resolve.json`.

## R1 — Candidate value extraction

Folded into SPEC-5 §2.1 (2026-06-11); history in git.

## R2 — MergeFn domains and fold order

Folded into SPEC-5 §3 (2026-06-11); history in git.

## R3 — Schema JSON profile (formerly "Policy")

Folded into SPEC-5 §7 (appendix) (2026-06-11); history in git.

## R4 — View shape and canonical form

Folded into SPEC-5 §5 (2026-06-11); history in git.

## R5 — Annotate-tagged entries are candidates

Folded into SPEC-5 §2.1 + §4 (2026-06-11); history in git.

## R6 — Nested resolution

Folded into SPEC-5 §2.1 (2026-06-11); history in git.

## R7 — `resolve` in the term JSON profile

Folded into SPEC-2 §9 (appendix) (2026-06-11); history in git.

## R8 — Expansions resolve through their own reading (2026-07-18, issue #23)

Folded into SPEC-5 §4 (expanded-targets bullet) and SPEC-2 §4.5/E18. Supersedes the implicit
pre-#23 behavior R6 described, where `renderTarget` recursed with the parent's Schema. Pinned by
`vectors/l1-eval/eval-resolve.json`: `resolve-nested-expansion` (the child's reading observably
wins over the parent's policy) and the `legacy-expand-resolve-rejected` reject (no parent-Schema
fallback).
