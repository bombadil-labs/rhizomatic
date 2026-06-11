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
| M2 | The reactor | ✅ complete | ✅ complete |
| M3 | Packs | ✅ complete | ✅ complete |
| M4 | Federation | ✅ complete | ✅ complete |
| M5 | Derivation | ✅ complete | ✅ complete |

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
- **M2.2 — materializations + incremental maintenance.** ✅ **complete.** Root-localized
  recomputation with sound dispatch (ERRATA-4 V5): support entities from nested HView ids;
  negation-chain walks checked against RELEVANCE (not presence) so reinstatement dispatches;
  static root-anchoring analyzer across transitively referenced schema bodies, with broad
  dispatch for non-anchored terms (group(const) etc). Incremental ≡ batch verified after EVERY
  ingest under random permutations in both witnesses (fast-check / seeded proptest), incl. the
  suppress→reinstate cycle and expanded-entity re-materialization; anchored dispatch provably
  skips irrelevant deltas (eval-count assertion); change events fire only on content change.
- **M2.3 — subscriptions + change events.** ✅ **complete.** Change events carry root, changed
  property paths (per-prop canonical-hex diff), responsible delta ids, new content hash (SPEC-4
  §5). TS: push callbacks (raw stream + per-materialization); Rust: pull-based change log — same
  content, transport out of scope.
- **M2.4 — manifest-keyed atomic batch ingestion.** ✅ **complete — M2 done.** rdb.txn vocabulary
  (member/prior/intent); ingestBundle validates everything first (atomic acceptance, no trace on
  reject, manifest-commitment check), makes all members visible to dispatch in ONE step (single
  change event per bundle); holdsAllMembers = the verifiable completeness hash check.

## Discovery: M3 (packs) — done in one slice

**M3 — the pack format.** ✅ **complete.** v0 pack = one canonical-CBOR item (ERRATA-8 P1):
string-table interning, hydrated manifests as envelopes, members dehydrated against the
lexicographically-first claiming manifest (author omitted when equal, dt omitted when 0 —
divergent fields always representable, P2), loose deltas hydrated. Stored per-record ids make
rehydration self-verifying (SPEC-8 §4 free fsck — a corrupted pack FAILS, proven in both).
Deterministic: same set ⇒ same bytes ⇒ same packId. Cross-impl vector (vectors/l0-pack/pack.json):
Rust reproduces the TS pack bytes exactly. Index/dictionaries deferred (P3).

## Discovery: M4 (federation) — done in one slice

**M4 — federation.** ✅ **complete.** Peer = Reactor + keypair + offered lens (any DSet-sort
term, F4) + admission Pred (§5). In-process transport (F1 — sneakernet-legal); v0 reconciliation
is full sorted-id exchange (F2, sublinear digests deferred). The signature boundary (F3):
signed deltas travel loose; signed manifests carry sig-less members as atomic BUNDLEs (Merkle
coverage); unsigned uncovered deltas are WITHHELD. Conformance §8 witnessed in both: random
fork pairs converge to union (property), sync idempotent, lens fidelity, admission filtering
(rejection local + silent), partition/heal through a relay. ERRATA-6 F1-F4.

**Remaining: M5 (derivation)** — pure/effectful derived authors, replay verification, loop
budgets. The WASM host ABI is SPEC-7's biggest open surface; a v0 can implement native-function
derived authors (host-language closures as non-portable authors) with the binding lifecycle,
emission policies, and pure-replay verification, deferring WASM portability.

## Discovery: M5 (derivation) — done in one slice; THE BUILD ORDER IS COMPLETE

**M5 — derivation.** ✅ **complete.** Native-function derived authors (ERRATA-7 G1 — SPEC-7 §7
itself concedes native fns are conformant-but-not-portable; the WASM ABI remains the spec's
flagged open surface). The full lifecycle works: signed binds installation, the write-back loop
(host wraps the reactor, drains triggers to quiescence), provenance emission (by/from/under,
timestamp 0 for replayability — G3), supersede via self-authored negations, the non-reentrancy
guard, budgets with signed rdb.derived.suspended annotations (divergence is observable, not a
melted reactor), and pure-replay verification (re-run fn on the pinned input view → recompute
id → must match; tampered functions fail). Tested identically in both witnesses.

**All six milestones (M0-M5) are now implemented in both witnesses — conformance Levels 0-4
all have two working citizens.** Next per the loop charter: the REFERENCE APP showcasing the
capabilities (superposition, policies-as-lenses, time-travel, federation, derived authors),
plus polish (README status update, top-level parity runner, CI).

## Post-M5: the showcase + mechanical enforcement

- **Reference demo** ✅ — implementations/ts/demo/demo.ts (`npm run demo`): a seven-act story
  (superposition → policy lenses → retraction/audit → time travel → federation → derived
  authors → packs), smoke-tested in the suite.
- **Interactive playground** ✅ — implementations/ts/demo/playground/ (`npm run
  playground:build`, or the `playground` launch config): three sovereign peers in a browser;
  author/retract/sync; policy + as-of + audit lenses; provenance panel. Verified interactively
  (digests converge on screen after sync).
- **CI** ✅ — .github/workflows/ci.yml: both green-gates + vector-freshness + playground build
  on every push; first runs green on ubuntu (canonical bytes reproduce cross-platform).
  Top-level parity runner: `node tools/check-all.mjs`.

## Queued next (in value order)

1. **WASM host ABI proposal** — ✅ drafted: spec/07-derivation-abi.PROPOSAL.md (status:
   proposal, awaiting review). Key moves: fnHash = contentAddress(wasm bytes); input = canonical
   HView CBOR (the same bytes as rdb.derived.from); output = the v0 DerivedFn shape; keys never
   enter guest memory; PURITY = zero imports, statically checkable. Next step after adoption: a
   host implementation + a compiled-module conformance vector.
2. **HTTP transport binding** — ✅ TS side shipped (ERRATA-6 F5: POST /rhz/v0/sync; ids never
   on the wire, recomputed on receipt; lens + signature boundary + admission unchanged; two
   peers converge over real localhost HTTP in the suite). **Rust side shipped too (src/http.rs:
   serve_peer via tiny_http, pull_from_url via ureq) — and the CROSS-IMPLEMENTATION INTEROP IS
   PROVEN: a Rust peer (cargo run --example http_sync) pulled from a live TypeScript server
   (tools/serve-interop.ts), bundle included, and converged to the byte-identical canonical
   digest: 1e20f71d4b7221330eac265aa3f4047c92be0392ec09a0327500f0ca7d7bcacfb6bb (count=5).**
3. **`rdb.*` prefix decision** — the user's call; one-constant change + vector regen when made.
4. Deeper conformance vectors (alias closure, parameterized terms/holes, keyed emission).

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
