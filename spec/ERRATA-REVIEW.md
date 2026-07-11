# ERRATA upstreaming review

A disposition for every errata entry, reviewed with the maintainer 2026-06-11 and **fully
applied**: every FOLD below now lives in the spec section named (the errata entry is a one-line
pointer; history is in git), every KEEP retains its content, and the five DECIDEs are resolved
in the table that follows.

**Dispositions:**

- **FOLD** — the entry pins normative behavior the spec doc currently lacks or contradicts; its
  text should move into the spec section named, with the errata entry collapsing to a one-line
  pointer ("pinned in SPEC-N §X; history in git"). The vectors already enforce these — folding
  changes where the law is written, not what it says.
- **KEEP** — a v0 implementation profile or explicit deferral that should stay errata until the
  v1 surface it's waiting on exists. Folding these would harden scaffolding into law.
- **DECIDE** — carries a genuine open question; needs your call before anything moves.

## The five DECIDEs — all RESOLVED 2026-06-11

The deciding principle (reviewed with the maintainer): prefer the option whose later reversal
costs one versioned amendment rather than a migration.

| # | Entry | Decision |
|---|---|---|
| 1 | **S4** (vocabulary prefix) | **`rhizomatic.*`** — the full product name; collision-proof and self-describing. Wire cost is negligible (packs intern strings). Executed: constants flipped, vectors regenerated, prose swept. The HTTP path `/rhz/v0/sync` stays — it names the transport binding (F5), not the vocabulary. |
| 2 | **D10** (set digest) | **Stays provisional.** Promoting it would pin SPEC-6 to a full-set digest that v1 sublinear reconciliation would immediately obsolete. Revisit when reconciliation does. |
| 3 | **E14** (annotation channel) | **Closed: consumed-or-dropped is the invariant.** The annotate channel is a property of the immediate operand; the audit idiom is `group(mask(annotate, …))` directly. Threading through set-preserving operators can return as an `alg: 1` capability if a real consumer needs it. |
| 4 | **E8** (prune granularity) | **Closed: property-level is the `alg: 0` law.** Pointer-level pruning, if ever needed (e.g. federation payload minimization), enters as an `alg`-versioned capability — exactly when a consumer exists to vector it. |
| 5 | **WASM ABI** | **Remains a PROPOSAL, adoption mechanically gated** on a working host implementation plus a compiled-module conformance vector — the same vectors-first rule everything else followed. Premature adoption is the only branch with real regret (ABI churn with an external audience). |

## SPEC-1 — Deltas (12 entries)

| Entry | Gist | Disposition | Lands in |
|---|---|---|---|
| D1–D7 | The entire canonical CBOR profile: floats-only numbers, string/bool encodings, map ordering, pointer/target layout, claims layout, content address | **FOLD** | SPEC-1 §4 (becomes the normative serialization section) |
| D8 | `author = "ed25519:<pubkey hex>"` for signed deltas | **FOLD** | SPEC-1 §5 |
| D9 | Signature over the id's raw multihash bytes; 3-way verification outcome | **FOLD** | SPEC-1 §5 |
| D10 | Set digest (explicitly PROVISIONAL) | **DECIDE** (#2) | — |
| D11 | NFC validated at the boundary, never repaired | **FOLD** | SPEC-1 §2.1 + §4.1 |
| JSON debug profile | Flat target form, isomorphic to CBOR; correctly-rounded number parsing | **FOLD** | SPEC-1 appendix (vectors depend on it; the float_roundtrip trap deserves spec text) |

## SPEC-2 — Operators (15 entries)

| Entry | Gist | Disposition | Lands in |
|---|---|---|---|
| E1 | Term JSON profile | **FOLD** | SPEC-2 appendix |
| E2 | Canonical result encoding (DSet sort) | **FOLD** | SPEC-2 §5 |
| E3 | Total order over primitives (bool < num < str; NFC UTF-8 bytes) | **FOLD** | SPEC-2 §3 |
| E4 | trust(Pred) restricts candidate negations | **FOLD** | SPEC-2 §4.3 |
| E5 | Negation recursion guard (memoized, in-progress = not negated) | **FOLD** | SPEC-2 §4.3 |
| E6 | group filing rules (filing pointers, contextless exclusion, const-bags-all) | **FOLD** | SPEC-2 §4.4 |
| E7 | HyperView canonical form | **FOLD** | SPEC-2 §5 |
| E8 | prune at property granularity; pointer-level deferred | **DECIDE** (#4), then fold the pinned half | SPEC-2 §4.6 |
| E9 | Sorts checked at evaluation time (v0; static checking later) | **KEEP** | — |
| E10 | Schema registry, $root variable, SchemaRef | **FOLD** | split SPEC-2 §4.8 / SPEC-3 §3 |
| E11 | Expanded HVEntry encoding (replacement form, provenance intact) | **FOLD** | SPEC-2 §4.5 |
| E12 | Term canonical CBOR + hashes via the normalized JSON structure | **FOLD** | SPEC-2 §7 |
| E13 | Pinned SchemaRef mode | **FOLD** | SPEC-3 §6 |
| E14 | Annotation channel does not survive select/union | **DECIDE** (#3), v0 pin folds either way | SPEC-2 §4.3 |
| E15 | hole(name) parameterized terms, bound at fix | **FOLD** | SPEC-2 §6 (already cross-referenced) |

## SPEC-3 — Schemas (5 entries)

| Entry | Gist | Disposition | Lands in |
|---|---|---|---|
| S1 | Schema-as-deltas vocabulary (blob form, one delta per definition) | **FOLD** | SPEC-3 §5 |
| S2 | The rhizomatic.HyperSchemaSchema bootstrap constant | **FOLD** | SPEC-3 §5 |
| S5 | THE CONTRADICTION: canonical body must mask before select | **FOLD** (spec text carries the amended idiom; the catch story stays in errata/git) | SPEC-3 §2 |
| S3 | Eager evolvable schema loading (latest-by-timestamp, lexById tiebreak) | **KEEP** (v0; transparent re-resolution arrives with reactive registries) | — |
| S4 | rhizomatic.* prefix is a configurable constant | **DECIDE** (#1) | — |

## SPEC-4 — Reactor (5 entries)

| Entry | Gist | Disposition | Lands in |
|---|---|---|---|
| V1 | Value index keyed (role, primitive) — primitives carry no context in the pinned format | **FOLD** (it corrects a real SPEC-4 §3 / SPEC-2 §3 misstatement) | SPEC-4 §3 + SPEC-2 §3 |
| V2 | v0 persistence in-memory; arrival log is ordering | **KEEP** | — |
| V3 | Ingest outcomes: accepted / duplicate / rejected | **FOLD** | SPEC-4 §2 |
| V5 | Root-localized recomputation + sound dispatch | **KEEP** (an implementation strategy the spec permits, not law — V4 is the contract) | — |
| V4 | Convergence is the tested contract | **FOLD** (merge into §1's wording; it's the defining property) | SPEC-4 §1 |

## SPEC-5 — Resolution (7 entries)

| Entry | Gist | Disposition | Lands in |
|---|---|---|---|
| R1 | Candidate value extraction (filing pointers excluded; 0→true, 1→value, n→{role: value}) | **FOLD** (the spec literally lacked this definition) | SPEC-5 §3 |
| R2 | MergeFn domains + id-order folds | **FOLD** | SPEC-5 §4 |
| R3 | Schema JSON profile (formerly "Policy") | **FOLD** | SPEC-5 appendix |
| R4 | View shape + canonical form | **FOLD** | SPEC-5 §5 |
| R5 | Annotate-tagged entries are candidates (audit views resolve too) | **FOLD** | SPEC-5 §3 |
| R6 | Nested resolution uses the same policy | **FOLD** | SPEC-5 §3 |
| R7 | resolve in the term profile; View is terminal | **FOLD** | SPEC-2 appendix (with E1) |

## SPEC-6 — Federation (5 entries)

| Entry | Gist | Disposition | Lands in |
|---|---|---|---|
| F1 | v0 in-process transport (sneakernet-legal) | **KEEP** | — |
| F2 | v0 reconciliation = full sorted-id exchange | **KEEP** (sublinear digests are the v1 surface) | — |
| F3 | The signature boundary operationalized (loose signed / bundled / withheld) | **FOLD** | SPEC-6 §3 + §5 |
| F4 | Lenses are DSet-sort terms (lens fidelity) | **FOLD** | SPEC-6 §4 |
| F5 | The blessed HTTP binding (POST /rhz/v0/sync; ids recomputed on receipt) | **KEEP** (transport bindings are profiles, not core; it IS the interop-proven binding, so keep it normative-as-annex) | — |

## SPEC-7 — Derivation (5 entries)

| Entry | Gist | Disposition | Lands in |
|---|---|---|---|
| G1 | v0 derived authors are native functions (conformant-but-not-portable) | **KEEP** (until the WASM ABI lands — DECIDE #5) | — |
| G2 | The host wraps the reactor; drain-to-quiescence; budgets suspend observably | **FOLD** | SPEC-7 §6 |
| G3 | Provenance pointers; timestamp 0 for replayability | **FOLD** | SPEC-7 §4 |
| G4 | Emission policies incl. keyed's subject-key definition | **FOLD** | SPEC-7 §5 |
| G5 | Pure-replay verification recipe | **FOLD** | SPEC-7 §4 |

## SPEC-8 — Storage (3 entries)

| Entry | Gist | Disposition | Lands in |
|---|---|---|---|
| P1 | v0 pack = one canonical CBOR item; string interning; dehydration rules | **FOLD** | SPEC-8 §3 |
| P2 | Never hash dehydrated; rehydration self-verifies (free fsck) | **FOLD** | SPEC-8 §2 |
| P3 | Deferred: index, dictionaries, ranged reads | **KEEP** (explicit deferral list) | — |

## Tally

**FOLD 38 · KEEP 12 · DECIDE 5** (counting D1–D7 as seven). The folds are mechanical and
vector-guarded; they can land one spec doc per slice once approved. The five DECIDEs are the
real review queue, listed at the top.
