# Progress

Living status for the build loop. Updated at the end of every slice; newest first. A fresh context
window should be able to read this top-to-bottom and know exactly where things stand and what's next.

## Toolchains (verified 2026-06-10)

- **Node** v22.0.0 + **npm** 10.5.1.
- **Rust** `stable-x86_64-pc-windows-gnu` (cargo 1.96.0) via scoop + **gcc** 15.2 as linker.
  Cargo is not on the default PATH — see [implementations/rust/CLAUDE.md](implementations/rust/CLAUDE.md).
- **Dev tooling:** TS = prettier + eslint (flat config) + tsc + vitest (`npm run check`);
  Rust = rustfmt + clippy (`-D warnings`) + cargo test. Lockfiles committed for reproducibility.
  Both green-gates must pass before any slice is committed.

## Milestone status

| | Milestone | TS | Rust |
|---|---|---|---|
| M0 | The atom (canonical form, id, signatures, set-ops) | ✅ complete | ✅ complete |
| M1 | The evaluator (8 operators, schema bootstrap) | ✅ complete | ✅ complete |
| M2 | The reactor | next | next |
| M3 | Packs | — | — |
| M4 | Federation | — | — |
| M5 | Derivation | — | — |

## Discovery: how M1 (the evaluator) decomposes into slices

M1 is `eval(term, deltaSet)` as a pure function (SPEC-2), byte-exact against vectors, in both
implementations. It is the oracle the reactor (M2) will later be property-tested against, so it must
be correct and boring. Slices:

- **M1.1 — Pred grammar + select/union/mask.** ✅ **complete.** Full predicate evaluator, the three
  DSet operators, JSON term profile (ERRATA-2 E1), canonical result encoding (E2), canonical
  primitive total order with NFC-UTF-8 string comparison (E3), trust-restricted negation (E4),
  guarded negation recursion (E5), NFC-at-the-boundary validation (ERRATA-1 D11). 15 vectors over
  an 8-delta fixture incl. negation chains + mixed-type ordering; 5 evaluator-law proptests
  (select conjunction-composition, monotonicity, mask⊆operand, union≡or, select≡fork).
- **M1.2 — group/prune + HyperView canonical form.** ✅ **complete.** Two-sort evaluator (DSet |
  HView, checked at eval time, E9); group filing rules (E6: filing pointers, contextless exclusion,
  multi-property filing, const-bags-all); HView canonical CBOR (E7: sorted props, id-sorted entries,
  annotate tags threaded into entries for audit views); prune at property granularity (E8 — the
  pointer-level reading is deferred, logged as an open question). 11 vectors incl. canonical schema
  idiom, prune-all identity, empty-root, contextless probes.
- **M1.3 — expand/fix + schema registry.** ✅ **complete.** HyperSchema + SchemaRegistry (derived
  refs, duplicate/unresolved/cycle rejection — SPEC-3 §3); `$root` variable in predicates
  ({"var":"root"}, E10) so schema bodies are functions of their root; expand replaces role-matching
  EntityRef targets with nested HViews keyed by pointer index (E11), against the same DSet; fix
  sets the ambient root explicitly. Vectors: keanu↔brzrkr DATA cycle terminating through a finite
  schema DAG (MovieDeep→ActorWithWorks→MovieBasic, depth 3), graceful-degradation cases. v0
  SchemaRef is a registry name; pinned-hash/evolvable modes arrive in M1.5.
- **M1.4 — resolve + policy terms (SPEC-5).** ✅ **complete — all 8 operators now live.** Full
  policy grammar (pick/all/merge/conflicts/absentAs; byTimestamp/byAuthorRank/byPred/lexById with
  structural lexById tiebreak); View sort (terminal) + canonical CBOR; new spec/05-resolution.ERRATA.md
  pins candidate-value extraction (R1), MergeFn domains + id-order folds (R2), policy JSON (R3),
  View shape (R4), annotate-candidates (R5), same-policy nested resolution (R6). 10 vectors incl.
  superposition pick, trust-ranked pick, mixed-type max, float-sum, conflicts, absentAs, nested
  expansion resolution; P5-pluralism witnessed in both impls (same HView, two policies, two truths).
- **M1.5 — schemas-as-deltas + the `rdb.SchemaSchema` bootstrap.** ✅ **complete — M1 done.**
  Term canonical CBOR + content hashes (E12, via deterministic termToJson + a strict CBOR
  decoder both impls now share); pinned SchemaRefs resolving by hash (E13); the S1 definition
  vocabulary (one delta per schema, term as canonical hex blob); the bootstrap constant pinned
  in vectors; publish→load round-trip, append-evolution, negation-deprecation all witnessed.
  **SPEC CONTRADICTION FOUND & RESOLVED (ERRATA-3 S5): SPEC-3 §2's canonical body
  (select-then-mask) excludes negations before mask can see them, contradicting §2.1's closure
  promise — caught when a negated schema definition kept loading. Amended idiom: mask FIRST,
  then select. All idiom-using vectors regenerated.**

## Discovery: how M2 (the reactor) decomposes into slices

M2 is the execution engine (SPEC-4): ingest deltas over time, keep registered materializations
incrementally equal to batch evaluation. The batch evaluator (M1) is the ORACLE: every
incremental result must be byte-identical to from-scratch eval (SPEC-4 §1).

- **M2.1 — reactor core + ingest pipeline.** ✅ **complete.** ingest→validate→persist→index with
  accepted|duplicate|rejected outcomes (ERRATA-4 V3); the four core indexes — id (DeltaSet),
  target, negation, value — with the value index keyed by (role, primitive) since primitives
  carry no context in the pinned format (V1, flagged to SPEC-4/SPEC-2); signature gate on ingest;
  order-convergence property-tested in both incl. negation-before-target; read-your-writes;
  index-vs-full-scan agreement; value-index-vs-evaluation agreement. v0 log is in-memory (V2).
- **M2.2 — materializations + incremental maintenance.** register (term, roots, pin-set);
  monotone insertion along support paths; non-monotone repair via the negation index
  (localized recomputation per SPEC-4 §4.3); incremental-equivalence property tests vs the
  M1 oracle under randomized orders incl. negations arriving before their targets.
- **M2.3 — subscriptions + change events.** root entity, affected property paths, responsible
  delta ids, new content hash (SPEC-4 §5); read-your-writes confirmation (§6).
- **M2.4 — manifest-keyed atomic batch ingestion** (rdb.txn vocabulary, SPEC-1 §9 / SPEC-4 §6).

## Slice log

### M0.1 — canonical CBOR + content-addressed id  *(✅ complete, parity verified)*

Scope: `Delta`/`Claims`/`Pointer`/`EntityRef`/`DeltaRef`/`Primitive`; deterministic CBOR encoder per
ERRATA D1–D7; BLAKE3-256 multihash id; shared vectors in `vectors/l0-delta/`. No signatures, no
set-ops yet.

Vectors:
- `cbor-primitives.json` — hand-verified scalar ground truth (anchors the encoder, not self-generated).
- `deltas.json` — `(claims → canonicalCborHex, id)`, generated by the anchored TS pipeline, reproduced
  independently by Rust (the parity check).

Result: **TS** 27 tests + `tsc --noEmit` clean; **Rust** 7 tests + clippy clean. Rust reproduced every
`canonicalCborHex` and `id` byte-for-byte on the first run — two independent CBOR encoders agree.
Both implementations reject non-finite numbers, empty pointer lists, and empty role/context.

### M0.2 — full shortest-form floats  *(✅ complete)*

f16/f32/f64 shortest-exact encoding per RFC 8949 §4.2.1, including f16 subnormals; ERRATA D1's
tracked deviation closed. Vectors now include the Appendix A float cases + boundary probes.
**Cross-impl finding:** serde_json's default float parsing is up to 1 ULP off and fractured parity
(caught by the `float-f16-min-subnormal` vector); fixed via the `float_roundtrip` feature and
recorded in the ERRATA — JSON-profile consumers MUST parse numbers correctly rounded.

### M0.3 — Ed25519 signatures  *(✅ complete)*

ERRATA D8 (author = `ed25519:<pubkey hex>` for signed deltas) and D9 (sig over raw multihash bytes
of id; verify = content addressing holds + signature verifies). 3-way verification outcome
(verified|unsigned|invalid). `vectors/keys/keys.json` + `deltas-signed.json` pin deterministic
RFC 8032 signature bytes; ed25519-dalek reproduced @noble/curves' exact signatures.

### M0.4 — delta-set algebra + negation shape  *(✅ complete — M0 done)*

DeltaSet (dedup by id, content-address verified on insert), merge/fork/federate, makeNegationClaims
(SPEC-1 §7 shape), set digest (ERRATA D10, provisional). CRDT laws property-tested in both:
fast-check (TS) and proptest (Rust) — commutativity, associativity, idempotence, fork-partition,
federate≡merge∘fork, dedup. Cross-impl digest pinned by `set-digest.json`.

**M0 = conformance Level 0 complete in both implementations. Next: M1.1.**
