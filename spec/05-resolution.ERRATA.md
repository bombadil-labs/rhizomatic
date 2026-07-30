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

## R9 — `all(order, distinct: true)`: opt-in value-dedup at the boundary (2026-07-30, issue #33)

Identified during the relational-completeness proof (NOTE-13 §4, E21): `group` + `prune` yields
projection *with lineage*; Codd's set-semantic π needs value-keyed duplicate elimination, whose
boundary-level form was designed there and is now built. Normative text folded into §3/§7;
recorded here for the decisions:

- **Order first, dedup second, keep the first occurrence.** The representative is thereby
  meaningful — under `byAuthorRank` the survivor is the most-trusted author's copy, which is what
  `explain` should trace — and the array order is first-occurrence order, so the same value set
  under `asc` vs `desc` can legitimately list in different orders (pinned by vectors).
- **Equality is the View's canonical CBOR bytes** — the equality `conflicts` already uses. No new
  sameness: numeric spellings collapse, bytes leaves dedup by `(mime, bytes)` jointly, mixed types
  never collide, expansions dedup by their resolved child Views.
- **Literal `true` only.** `distinct: false` rejects rather than meaning "omitted" — one spelling
  per meaning (the `-0.0 → +0.0` / `negated`-flag discipline), so schema canonicalization gains no
  normalization rule and byte-identical schemas stay byte-identical.
- **`all` only; everywhere else the key fails closed** (SPEC-2 §8 closed records) — which is the
  versioning story: additive and parse-visible, no `alg` bump; a predating witness rejects loudly.
- Multiplicity is not destroyed, only unsurfaced: the HyperView keeps every entry; pair with
  `merge(count)` when "how many said so" matters.

Pinned by `vectors/l1-eval/eval-distinct.json` (positive: basic dedup, asc/desc representative
order, numeric collapse, bytes-leaf dedup incl. same-bytes-different-mime staying distinct,
mixed types, absentAs composition, and a no-distinct control proving default-off changes nothing;
rejects: `distinct: false`, non-boolean, `distinct` on `pick`).
