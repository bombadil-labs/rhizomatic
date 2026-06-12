# Progress

> **RESUME HERE (2026-06-11). THE NEXT ARC IS CHORUS — agent memory as the killer app.**
> The substrate is finished and folded: M0-M5 in both witnesses (TS 190 / Rust 19 suites,
> byte parity, CI green), vocabulary = rhizomatic.*, parameterized terms (holes) + keyed
> emission shipped, ALL errata upstreamed into the spec docs (spec/ERRATA-REVIEW.md records
> dispositions; five DECIDEs resolved). Docs are live on Pages: docs/index.html (landing) →
> tour.html (the interactive tour, both witnesses in-browser) + agents.html (the agent-memory
> case — read it first, it IS the product brief).
>
> **To resume:** read CLAUDE.md + this file + docs/agents.html + the "Chorus arc" section
> below. Verify green: `node tools/check-all.mjs`. Preview: launch config `docs`.
> **Phases 0–1 are done** (SPEC-9 + eval-aliased vectors in both witnesses, 149/149 in-browser;
> chorus-core with the full memory API) — see the Chorus build log below. Next: **Phase 2,
> trust dynamics** (adjudicator via keyed emission; decision replay + retroactive distrust as
> first-class operations).
> The working agreement holds: vectors first, two witnesses in lockstep for anything
> normative, checkpoint commits on main, artifacts read as designed-from-the-start.


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

## Post-v0 sprint: the "holy shit" documentation

- **The interactive tour** ✅ — docs/index.html + tour.bundle.js (`npm run docs:build`,
  launch config `docs`): a six-section narrated walk where every widget runs the real
  implementation — live canonical-CBOR + content-address builder (with fail-loud rejection),
  superposition, four simultaneous policy lenses, retraction + audit + time travel (all three
  lenses over ONE shared world, so §4 retractions visibly update §2/§3), two sovereign peers
  converging by sync, shuffle-&-replay order-independence, and the cross-language interop
  digest. docs/playground.html is the free-form companion. CI gates docs freshness
  (bundle bytes must match committed). **Verified in-browser: rejection path, audit ✗ marks,
  time travel, sync convergence, replay digest equality, zero console errors.**
- **Finding en route (ERRATA-2 E14):** `mask(annotate)`'s annotation channel does not survive
  `select`/`union` — group(select(mask(annotate,…))) silently loses ✗ marks. Pinned for v0
  (both witnesses agree); supported audit idiom is group(mask(annotate,…)) directly, since
  group's E6 filing already scopes to the root. Tour AND playground terms fixed accordingly;
  open question filed for v1 (should channels thread through set-preserving operators?).
- **The in-browser conformance run** ✅ — §6 of the tour now bundles the committed vector
  files (l0-delta deltas/signed/set-digest, keys, all four l1-eval suites) via build-time JSON
  imports and runs them live: 62/62 green in ~60 ms, with per-suite rows, a tamper-rejection
  check (flip a timestamp → signature verification must fail), and a re-run button. "Your
  browser is now a conformance witness." CI's docs-freshness gate means the page can never
  drift from the vectors. Mobile pass done (375px: no overflow, grids collapse).
- **THE SECOND WITNESS IS ON THE PAGE** ✅ — the Rust implementation compiled to
  wasm32-unknown-unknown (cdylib, src/wasm.rs: JSON-over-linear-memory ABI, no wasm-bindgen;
  the one sanctioned `unsafe` boundary in the crate; http.rs cfg-gated host-only). The tour
  loads docs/rust-witness.wasm (~730 KB) and (a) §1's delta builder asks Rust to reproduce
  every live edit — byte agreement shown inline; (b) §6 runs the conformance vectors through
  BOTH witnesses side by side: 117/117 green in ~90 ms in-browser. CI builds + clippy-checks
  the wasm target on every push. Verified live: edits agree, suites green, zero console
  errors, graceful degradation if the wasm fails to load.
- **The native idiom restored (design review with the user, 2026-06-11)** ✅ — the user flagged
  the demos' "subject"/"value" role cosplay. Investigation confirmed the FORMAT was always
  faithful (no subject anywhere normative; primitives encode directly; kind never on the wire)
  and the user's clarified intent — context names the property at the target, missing context
  = no backpointer, schemas may override filing — is exactly E6 contextless exclusion +
  byTargetContext/byRole/const + R1 value composition, all pinned and vectored. New SPEC-1
  §2.3 writes the rationale down (backpointers are consent; primitives are not vertices; the
  author's context is the default reading, not a cage). Tour rebuilt: §1 shows the JSON debug
  profile and native roles; NEW §2 "Every pointer is a perspective" — one delta, two live
  views, clear a context and watch that vertex's backpointer vanish; all seed worlds
  de-cosplayed. Verified in-browser; 117/117 conformance unchanged. Playground de-cosplay
  queued next.
- **JSON profile flattened to match the wire (user-approved, 2026-06-11)** ✅ — the debug
  profile's value/entityRef/deltaRef tags carried nothing the structure doesn't: target is now
  the bare primitive | {id, context?} | {delta, context?}, isomorphic to canonical CBOR
  (ERRATA-1 amended). Both witnesses' parsers/serializers updated in lockstep; vectors
  regenerated — PROVEN transport-only (zero changed lines touch canonicalCborHex / ids /
  digests / sigs / pack bytes). WASM witness rebuilt (the tour ships flat JSON over the ABI).
  Playground + CLI demo de-cosplayed in the same pass (movie/value-role idiom gone everywhere;
  caught a real silent regression: the demo's R1 candidate lookup keyed on the old role).
  Verified: 117/117 in-browser across both witnesses, demo prints avgRating=9, zero console
  errors.
- **Tour §7 "Computation is an author"** ✅ — the M5 story, live: a ratings bot
  (DerivationHost + native-fn derived author with its own keypair) watches the movie
  materialization; rate buttons trigger the write-back loop; the bot's signed claim renders
  with its full receipt (author, id, rdb.derived.by/from/under); a replay-verify button
  reconstructs the pinned input view from the arrival prefix (the derivation test's probe
  recipe), re-runs the fn, and checks the recomputed content address — plus the tampered-fn
  (+1) counter-demo failing the same replay. Proof section renumbered §8, its derived-author
  paragraph deduped. Verified in-browser: avg 8.5→9 on rate-10, ✓ genuine / ✗ tampered, zero
  console errors. The tour now walks all of L0→L7.
- **User feedback pass on the live tour (2026-06-11)** ✅ — (1) §5's log now shows negations
  as first-class APPENDED rows ("t=5 Bob negates t=3's …") instead of only striking the target:
  retraction reads as append, never edit; slider before the negation makes the original claim
  briefly true again, end of slider respects it. (2) §6's peers are now Obi-Wan and Vader with
  divergent claims about person:anakin_skywalker ("a certain point of view" — the aside ties
  the quote to policies-as-perspectives); replaces the opaque rover example. Verified live.
- **The stack map + the last layer's widget** ✅ — the hero now ends in an 8-row L0→L7 map:
  each layer links to the tour section that runs it live and to its spec doc ("click a layer
  to see it run; click a spec to read the law"). And L0 stopped being the one undemoed layer:
  §6 gained the pack widget — pack Obi-Wan's world to canonical CBOR (one item, deterministic
  packId), unpack into a fresh set, digest IDENTICAL, self-verifying rehydration. Every layer
  of the architecture now executes on the page. Verified live; zero console errors.
- **Parameterized terms: hole(name), bound at fix (SPEC-2 §6 → specified)** ✅ — the full
  vectors-first loop in one slice. ERRATA-2 E15 pins: v0 hole positions (match scalar const,
  vcmp value, hasPointer.targetEntity, profile spelling {"hole": "name"}); binding via fix's
  optional bindings object, ambient through expand (nested fix may override); bindings are
  primitives only (first-order); unbound = deterministic eval-time error via EAGER
  SUBSTITUTION at select/mask-trust (chosen over lazy per-delta resolution so the
  empty-operand case behaves identically in both witnesses); a body with holes keeps one
  hash, a fix with bindings hashes them (sorted, E12). vectors/l1-eval/eval-holes.json:
  6 cases over 3 schemas (asOf horizon, rating threshold, "cast member X") each pinning
  termHash + result bytes. TS (+10 tests, 189) and Rust (+5 suites' worth, holes.rs) — Rust
  reproduced every TS-generated term hash and canonical hex on the FIRST RUN. WASM witness
  rebuilt; the tour's conformance run now reads 130/130 across both witnesses.
- **keyed(contextSet) emission (SPEC-7 §5 — the third policy, undeferred)** ✅ — G4 amended:
  an emission's key is the sorted (entity id, context) pairs of its substantive entity pointers
  whose context ∈ contextSet; each new claim negates only same-key priors; empty key appends.
  Key is host-internal (never serialized); parity is behavioral, pinned by mirrored tests.
  TS: emit gains {keyed: [...]}; liveEmissions becomes per-key buckets. Rust: supersede: bool
  → Emit enum (Append | Supersede | Keyed), aligning the two hosts' shapes. Test in both:
  per-movie verdict bot over two roots — rating B leaves A's verdict live; re-rating A
  supersedes only A's. TS 190 / Rust 19 suites green; wasm refreshed.
- **ERRATA upstreaming review artifact** ✅ — spec/ERRATA-REVIEW.md: all 57 errata entries
  across the 8 spec docs, each with a one-line gist and a proposed disposition (FOLD 38 /
  KEEP 12 / DECIDE 5). The five DECIDEs — the actual human review queue — are tabled at the
  top: rdb.* prefix, D10 digest promotion, E14 channel threading, E8 pointer-level prune,
  WASM ABI adoption. Folds are mechanical + vector-guarded once approved, one spec doc per
  slice.
- **GitHub Pages is LIVE** ✅ — the human enabled it; the tour + WASM witness serve at
  https://mbilokonsky.github.io/rhizomatic/ (verified 200s). Also fixed: the keyed-emission
  slice changed src/derivation.ts (bundled into the tour) without rebuilding docs bundles —
  the CI docs-freshness gate caught exactly the drift it exists to catch; bundle rebuilt.
  Process note: rebuild docs:build after ANY ts/src change, and pin CI watches by sha.

- **THE FIVE DECIDES — RESOLVED (with the human, 2026-06-11)** ✅ — deciding principle:
  prefer the option whose reversal costs a versioned amendment, not a migration. (1) The
  vocabulary prefix is **rhizomatic.*** — constants flipped in both witnesses, vectors
  regenerated (bootstrap hash and all vocabulary ids moved, as designed), ~55 prose mentions
  swept across spec/README/CLAUDE; /rhz/v0/sync stays (transport name, not vocabulary).
  (2) D10 digest stays provisional until sublinear reconciliation. (3) E14 closed:
  consumed-or-dropped is the invariant; threading would be alg:1. (4) E8 closed:
  property-level prune is the alg:0 law; pointer-level would be alg-versioned. (5) WASM ABI
  stays a proposal, adoption gated on a working host + compiled-module vector. All five
  documented in ERRATA-REVIEW + the entries themselves. Both witnesses green (TS 190 /
  Rust 19 suites); wasm + bundles rebuilt; tour verified live (rhizomatic.derived.* receipts,
  130/130). Next: execute the 38 approved FOLDs, one spec doc per slice.

- **THE FOLDS — EXECUTED (45 entries, 8 spec docs, 6 commits)** ✅ — every approved errata
  pin now lives in its spec doc: SPEC-1 §4.1 is the full normative serialization profile
  (D1-D9, D11, JSON profile → §4.2); SPEC-2 gained the total order (§3), mask semantics incl.
  the E14 channel rule (§4.3), group filing (§4.4), expand replacement form (§4.5), registry +
  root variable + bindings (§4.8), canonical result encodings (§5), the term-hash recipe (§7),
  and a full term-JSON-profile appendix (§9, absorbing E1 + R7 + holes); SPEC-3 carries the
  blob vocabulary + bootstrap (§5), the amended mask-first idiom with its rationale (§2), and
  pinned refs (§6); SPEC-4 the (role, primitive) value index (§3) + ingest outcomes &
  tested convergence (§2); SPEC-5 candidate extraction (§2.1), merge domains (§3), View shape
  (§5), policy profile appendix (§7); SPEC-6 the signature boundary (§3) + lens fidelity (§4);
  SPEC-7 replay recipe (§4), timestamp-0 + emission policies (§5), the write-back loop (§6);
  SPEC-8 the pinned pack layout (§3) + operationalized invariants (§2). Every errata entry is
  now either a one-line pointer (folded), a live KEEP (v0 profile/deferral), or a recorded
  decision. The errata files stay as the index; git carries the archaeology.

## The Chorus arc (agent memory) — the next build

**Chorus** (name confirmed 2026-06-11 — a distinct product brand with Rhizomatic as its
substrate; when branding work starts, tie the two visually: "Chorus — memory built on
Rhizomatic"). One product thesis: a memory substrate for LLM agents
where every belief is a signed claim — sovereign perspectives over shared knowledge,
disagreement in superposition, trust as editable policy, decisions replayable against exactly
what was known. docs/agents.html is the user-facing brief; this section is the build order.

- **Phase 0 — spec/09-alias.PROPOSAL.md.** The `rhizomatic.alias.*` vocabulary: concept
  entities with ORIENTED SLOTS (e.g. employment#worker / employment#organization); mapping
  claims (vocabulary fragment → slot, with confidence + librarian provenance); the `aliased`
  closure for selects (static expansion at term-validation time, SPEC-5 §6's deferred hook).
  Key design points already settled in discussion: slot-level mapping solves relation
  DIRECTION (which end a fragment names = which slot it maps to) and avoids pairwise O(n²);
  canonical relation signature = the (role, context) pairs of a delta's entity pointers,
  sorted by the E3 total order; embedding VECTORS never enter the rhizome (librarian-private
  cache, rebuildable) — only judgment claims persist; the embedding model is an AUTHOR (new
  model version = new author = own track record, rankable by policy). `aliased` is L2 →
  vectors + both witnesses before any Chorus code consumes it.
- **Phase 1 — chorus-core** (implementations/ts/… or packages/chorus): Agent handle
  (keypair + reactor + policy + offered lenses), memory API (assert / retract / recall /
  asOf / explain), a small belief vocabulary (observations, facts, preferences, task state),
  pack-to-disk persistence (v0-sufficient). Scripted multi-agent tests, deterministic in CI.
- **Phase 2 — trust dynamics.** Adjudicator as derived author using KEYED EMISSION (one live
  verdict per subject — already built, SPEC-7 §5); the two set-piece capabilities as
  first-class operations + tests: DECISION REPLAY (resolve at the as-of instant an agent
  acted, retracted claims visible) and RETROACTIVE DISTRUST (demote an author in policy →
  world re-resolves, history intact).
- **Phase 3 — the librarian.** Effectful derived author wrapping an embedding model, emitting
  slot-mapping claims per Phase 0; live employer/staff-style convergence demo; alias-closure
  recall goes live. (Scripted/mock embeddings for CI; real model optional at runtime.)
- **Phase 4 — distribution.** An MCP SERVER exposing Chorus as drop-in memory for any agent
  framework (tools: remember / recall / retract / explain / trust / as-of) — the adoption
  move — plus a console UI (tour tech): provenance dashboard, belief timelines, trust editor,
  time scrubber. Docs page gains live widgets as pieces land.

### Chorus build log (newest first)

- **Phase 1 — chorus-core.** ✅ — implementations/ts/chorus/ (vocab, policies, agent, store):
  `ChorusAgent` = keypair + reactor + policy + offered lens/admission (wraps the SPEC-6 Peer);
  memory API **assert / retract / recall / recallAll / explain / asOf** (asOf is a recall
  option: filtering the operand scopes mask too, so a later negation never reaches back);
  belief vocabulary `chorus.belief.{about,value,kind,confidence,source}` (kind ∈ observation |
  fact | preference | task; the about-pointer's context IS the attribute, so beliefs file at
  the value entity too); standard policies latest/trustFirst/everything/disagreements; the
  Chorus presentation profile (unwrap candidate → value, else about — presentation never
  re-adjudicates, SPEC-5 §5); pack-to-disk persistence (savePack/loadPack/restore,
  self-verifying). explain uses the E14-legal audit idiom group(mask(annotate)); recall uses
  mask-before-select (S5). 10 scripted multi-agent tests, deterministic via injected clocks:
  one substrate two truths, retraction-with-receipts, as-of replay precursor, entity-valued
  beliefs, pack round-trip (same packId from a restored world), trust-edit re-resolution.
  TS 221 tests green. Chorus is product layer, not substrate — TS only, no vectors needed.

- **Phase 0 — the alias layer.** ✅ — spec/09-alias.PROPOSAL.md (SPEC-9): concepts with
  oriented slots (`rhizomatic.alias.slot`/`.concept` declarations), mapping claims
  (`.fragment`/`.slot`/`.confidence`, cross-product per delta), and the **`aliased` StrMatch**
  — a fourth StrMatch form, legal in every position, expanding to the one-hop
  name→slots→fragments closure against the AMBIENT evaluation input (composition law
  preserved; mask(trust)-style negation walking; `via` restricts to a concept's declared
  slots; `trust` Pred gates every participant; closure never enters the term hash; no
  holes/nested-aliased inside, rejected at parse). Relation signatures (§5) pinned: sorted
  canonical-CBOR `[role, context?]` pairs of EntityRef pointers. vectors/l1-eval/
  eval-aliased.json: 19-delta fixture (two employment dialects, decoy concept, negated
  mapping, sloppy cross-concept stray, two-fragment cross product), 9 term cases (each
  pinning termHash + sorted closure + result bytes, incl. trust-excludes-the-negation and
  matching-never-renaming recall) + 4 signature cases. TS 211 tests / Rust 8 suites' worth
  green; **Rust reproduced every TS-generated hash, closure, and canonical byte on the first
  run.** Tour §6 now runs the suite in both witnesses: 149/149 in-browser, zero console
  errors; wasm + bundles rebuilt.

Trio note: the earlier three-example concept (Bindery / Chorus / Commons) collapsed into this
single product thesis on review — the shrinkwrap idea survives inside Chorus as the typed
write surface an agent gets (mutation helpers, SPEC-4 §6), and the Commons survives as the
console + federation story. One argument, not three demos.

**Definition of done for the arc** (the loop runs until ALL of these hold):

1. Fresh clone, both green-gates pass (`node tools/check-all.mjs`), including the new alias
   vectors in BOTH witnesses and all chorus suites.
2. `npm run chorus:demo` (from the chorus package) walks the whole thesis end-to-end,
   scripted and deterministic: multiple agents assert + contradict → adjudicator verdicts
   land via keyed emission → DECISION REPLAY resolves a pinned instant (the later negation
   visibly absent) → RETROACTIVE DISTRUST demotes an author and the world re-resolves with
   history intact → the librarian (mock embeddings in CI; pluggable real model) converges two
   vocabularies through concept slots — printing the receipts (authors, ids, input hashes) at
   every step.
3. The MCP server starts and serves remember / recall / retract / explain / trust / as-of
   against a chorus store, with at least a smoke test driving each tool.
4. docs/agents.html links to the runnable demo ("see it run") and stays accurate to what
   shipped. (Stretch, not gating: the console UI.)

**Kickoff — paste this into a fresh session:**

```
/loop Build the Chorus arc per PROGRESS.md (read RESUME HERE + "The Chorus arc" + docs/agents.html first). Start at Phase 0 (spec/09-alias.PROPOSAL.md) and proceed phase by phase — vectors first, both witnesses for anything normative (the aliased closure is L2), checkpoint commits on main, green gates before every commit — until the Definition of Done holds and the demo runs end-to-end. Keep docs/agents.html honest as pieces land.
```

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
