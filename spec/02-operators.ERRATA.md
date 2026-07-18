# ERRATA & Decisions — SPEC-2 (Operator Algebra)

v0 decisions filling gaps SPEC-2 leaves open, pinned by `vectors/l1-eval/`. Same rules as the
SPEC-1 ERRATA: explicit, revisitable, never silently encoded in one implementation.

## E1 — JSON term profile

Folded into SPEC-2 §9 (appendix) (2026-06-11); history in git.


## E2 — Canonical result encoding for DSet-sort evaluations

Folded into SPEC-2 §5 (2026-06-11); history in git.


## E3 — Canonical total order over primitives

Folded into SPEC-2 §3 (2026-06-11); history in git.


## E4 — `trust(Pred)` semantics

Folded into SPEC-2 §4.3 (2026-06-11); history in git.


## E5 — Negation recursion guard

Folded into SPEC-2 §4.3 (2026-06-11); history in git.


## E6 — `group` filing rules

Folded into SPEC-2 §4.4 (2026-06-11); history in git.


## E7 — HyperView canonical form

Folded into SPEC-2 §5 (2026-06-11); history in git.


## E8 — `prune` operates at property granularity (v0)

`prune(keep: StrMatch | all)` retains the HView properties whose **name** matches (`all` = keep
everything, the identity). SPEC-2 §4.6's "drop pointers" reading — trimming pointer lists inside
entries — is **closed as out of `alg: 1`** (decided 2026-06-11): it tensions with SPEC-3 §4's
provenance-completeness ("every HVEntry is a full delta") and no consumer exists to vector it.
Property-level granularity is the law for `alg: 1`; pointer-level pruning, if a consumer ever
materializes (e.g. federation payload minimization), enters as an `alg`-versioned capability.

## E9 — Sorts are checked at evaluation time (v0)

Terms are dynamically sorted in v0: applying `select`/`union`/`mask` to an HView, `group` to an
HView, or `prune` to a DSet is an evaluation error; `group` without an ambient root (supplied by
the evaluation call, later by `fix`) is an evaluation error. Static term sort-checking can arrive
with the schema registry (M1.3+) without changing any vector.

## E10 — Schema registry, `$root`, and SchemaRef

Folded into SPEC-2 §4.8 (2026-06-11); history in git.


## E11 — Expanded HVEntry encoding

Folded into SPEC-2 §4.5 (2026-06-11); history in git.


## E12 — Term canonical CBOR and term hashes

Folded into SPEC-2 §7 (2026-06-11); history in git.


## E13 — SchemaRef gains the pinned mode

Folded into SPEC-3 §6 (2026-06-11); history in git.


## E14 — Annotation metadata does not survive `select`/`union`

Folded into SPEC-2 §4.3 (decided 2026-06-11: consumed-or-dropped is the invariant) (2026-06-11); history in git.


## E15 — Parameterized terms: `hole(name)`, bound at `fix` time

Folded into SPEC-2 §4.8 + §9 (appendix) (2026-06-11); history in git.


## E16 — Reflective predicates: `inView`, stratified at depth 1

Folded into SPEC-2 §3.1 + §9 (appendix) + SPEC-4 §4.1 (decided 2026-07-09). Dynamic trust sets
(negation masks honoring only currently-granted authors; aggregator admission rosters) are views
over the same delta-set, referenced from `select`/`mask(trust)` predicates via `inView(term,
field, extract)`. Pinned: DSet-sort sub-term over the ambient input; depth-1 stratification
rejected at parse time; resolution once per operator application (lowering to `inSet`, mirroring
E15 holes and SPEC-9 alias expansion); reflective terms dispatch conservatively in the reactor.
Vectors: `vectors/l1-eval/eval-reflective.json`.

## E17 — First-class set algebra: `difference` and `intersect` (no `alg` bump)

Decided 2026-07-15. Folds into SPEC-2 §4.2 (note), new §4.9, §5 (monotonicity), §6
(relational completeness), §8 (versioning doctrine), §9 (Term profile). Raised by rhizomatic#16,
driven by Loam's container work (its §24 quarantine / §27 containers): a container's *membership*
is a delta-query `Term` that evaluates to a DSet, and organizing a store into containers — some
**excluded** (the "sandbox" property) — needs read scope = *"the union of the active containers
**minus** the excluded ones."* That is set algebra over delta-sets: `∪`, `∩`, `∖`. The algebra
shipped `union` (§4.2) but left `∩`/`∖` as *derivations*, not operators. E17 promotes both to
first-class, whole-delta, DSet-sort ops, nestable to any depth, symmetric with `union`:

```
{ "op": "difference", "of": Term, "without": Term }    // of.set ∖ without.set, keyed by id
{ "op": "intersect",  "left": Term, "right": Term }    // left.set ∩ right.set, keyed by id
```

**Why the derivations don't suffice.** §4.2 notes `∩`/`∖` are derivable *within one delta set*
(`select(and(p,q))`, `select(and(p, not(q)))`) — true only when both sides are single-delta
predicates. Differencing against *another term* forces the reflective route, `select(not(inView(T,
…)))`, which is fenced three ways (rhizomatic#16): (1) **depth-1 stratification** — `inView.term`
may not itself contain `inView`, so you cannot difference against a term that is itself a
difference; containers-relative-to-containers don't compose. This is the hard blocker. (2)
DSet-sort operand only. (3) keyed on `id`/`author` only. `union` has none of these limits; its
companions shouldn't either.

**Tensions captured (the open questions we stepped through):**

- **Q1 — one op or two?** Two. `difference` is the concretely-blocking one (exclusion / sandbox);
  `intersect` completes the boolean algebra (`∪` shipped; `∖`+`∩` finish it) and is the natural,
  cheap companion — never cheaper to add than alongside its sibling.
- **Q2 — `alg` bump?** No. See the §8 reconciliation below. Additive + parse-visible ⇒ no bump.
  The only real-world hazard is a *predating* witness meeting a term that uses these ops; that
  fails **loud at parse** (fail-closed), never silently — and Loam, the sole current consumer, is
  built in lockstep, so there is no predating witness in the wild regardless.
- **Q3 — operand names.** `difference` is asymmetric → `of`/`without` (reads "of X without Y").
  `intersect` is symmetric → `left`/`right`, matching `union`. Deliberately *not* Loam's `kind`
  discriminator — rhizomatic terms discriminate on `op`.
- **Q4 — mask(annotate) tag channel.** Dropped, exactly as through `select`/`union` (E14): a DSet
  op's result is a plain id array, never the `{ids, negated}` annotate map. Pinned by the
  `difference-drops-annotate-channel` vector.
- **Q5 — the §8 contradiction.** §8 ¶1 ("adding an operator is a major version") contradicted
  §8 ¶2's parse-visible doctrine (added for `inView`/`chain`, which entered *without* a bump). A
  new `op` in the **closed** §9 profile is parse-visible: a predating parser hits an unknown `op`
  and rejects. So ¶1 was over-broad. Reconciled (§8): an `alg` bump is required **iff** the change
  is *not* parse-visible — i.e. it alters the semantics of a form a predating impl already accepts
  (same bytes, new meaning). Additive, parse-visible changes (new operators, mask policies,
  predicate forms, orders) need no bump, **on the now-normative condition that conformant parsers
  MUST fail-closed on any unrecognized tag in a closed enumeration.** The rejection *is* the safety
  the bump used to provide. `difference`/`intersect` enter under this rule, as `inView`/`chain`
  did. The negative parity vectors (`rejects[]` in the set-algebra vector) are the teeth.
- **Q6 — reactor / monotonicity (SPEC-4).** `intersect` is monotone in both operands. `difference`
  is monotone in `of` but **antitone in `without`**: a delta landing in the `without` sub-result
  *removes* an output, so the `without` branch is a retraction source the reactor must track like a
  negation edge (SPEC-4 §4.3). Recorded as a §5 monotonicity clause + a §10 open question; the
  incremental narrowing is L4 work, not gated on E17.
- **Q7 — n-ary / literals.** Kept binary (symmetry with `union`); no `empty`/`all` set literals and
  no variadic forms in `alg` (as-is). Left as a §10 open question should a consumer want them; the
  binary ops compose to any arity today.

**Scope discipline (from rhizomatic#16 "non-goals"), and the one pre-existing gap we did *not*
widen.** E17 adds set difference/intersection and nothing else: no regex/substring matching, no
bytes-target predicates, no delta-intrinsic context/role, no `between` on `timestamp`. Separately,
§8 ¶1 said `alg` "is part of every serialized term" — imprecise: `alg` rides the **HyperSchema
wrapper** once (`{name, alg, body}`, §4.8), not every term node, and term-nodes-serialized-as-deltas
(§7.2) don't repeat it. E17 corrects the §8 prose to say so and records the gap here; it does **not**
reopen the larger "should `alg` be carried/enforced per node at all" question — no consumer forces
it, and it is a separate design conversation.

**Per-node `alg` (considered, declined).** Q asked whether carrying `alg` on every term node
(not just the wrapper) would yield a cleaner skew error. No — and the reason is a direct
consequence of Q2/Q5: since additive operators enter *without* a bump, `alg` does not track
feature availability. `difference` ships at `alg: 1`, identical to the `alg` a witness that
predates it carries, so a per-node `alg: 1` on a `difference` node is indistinguishable from the
`alg` on any other node — it cannot tell "supports difference" from "doesn't." The unrecognized
**tag** is the only signal that carries that information, and §8 now directs the rejection message
to use it (naming the tag + a version-skew hint). Per-node `alg` would add bytes to every node for
zero diagnostic gain. Wrapper-only `alg` stands; this reinforces the §7/§8 correction rather than
reopening it.

**Downstream consistency swept alongside E17:** SPEC-9 §4.2 (alias versioning) previously said an
`aliased` extension adopted "after a released algebra version" would need an `alg` bump — the exact
pre-E17 muddle; corrected to defer to the reconciled §8 (parse-visible ⇒ no bump). And the stale
`alg: 0` phrasing in E8 / ERRATA-REVIEW / PROGRESS (we never shipped `alg: 0`; the base version is
`1`) is corrected to `alg: 1`, with future non-parse-visible capabilities noted as `alg: 2`.

Vectors: `vectors/l1-eval/eval-setalgebra.json` (8 positive oracles over the eval-basic fixture +
3 fail-closed `rejects`), generated by `tools/gen-vectors.ts` (the rejects are verified to reject at
generation time). Both witnesses implement it, byte-exact and at parity: TS `eval.ts` /
`term-json.ts` / `term-io.ts` and Rust `eval.rs` / `term_json.rs` / `term_io.rs`. Also admitted to
`inView.term` deliberately **not** — the reflective allowlist stays `input | select | union | mask`
in `alg: 1` (§3.1); difference/intersect inside `inView.term` reject at parse in both witnesses.


## E18 — `expand` names the child's reading; no parent-Schema fallback (2026-07-18, issue #23)

Normative text folded into SPEC-2 §4.5 / §9 and SPEC-5 §4; recorded here for the decision and its
rationale, pinned by the regenerated `vectors/l1-eval/eval-resolve.json` (`readings` +
`resolve-nested-expansion` + the `legacy-expand-resolve-rejected` reject).

Before #23, an expanded child was resolved with the **parent's own Schema**, threaded down
unchanged — a child's intended reading was unstatable, two parents embedding the same child under
different Schemas silently produced different child views, and downstream reading-keyed machinery
(Loam's binding-level resolvers) had nothing to reference. This worked only by prop-name
coincidence or when everything fell to `default`.

**Decision (Myk, issue #23 thread): the term names both halves of the child's lens** — `schema`
(gather) and `reading` (resolution), `reading` as structural as `schema`, resolved and validated
through the registry identically. The filed proposal's optional-with-parent-fallback was
rejected: the gather side already names the child's program explicitly per role-matching child;
the parent-Schema recursion in resolution was the asymmetry, not a default worth preserving.

The legacy fate: bodies without `reading` parse and gather byte-identically (hashes unmoved — the
key is present-iff-authored), but resolving one of their expansions MUST fail loudly, naming the
missing reading. Migration is unambiguous for all pre-#23 stores: each hyperschema then had
exactly one Schema; re-sign the body naming it. Post-coexistence ambiguity cannot arise in a
legacy body by construction.

Mechanics pinned alongside: the registry holds resolution Schemas by name and by content address
(`schemaHash`, the same multihash construction as `termHash`); reading refs are collected from
bodies and validated at registry build (unknown reading = build error, never mid-eval); the
resolved reading rides the in-memory HVEntry beside its expansion, and the HView canonical form
carries the reading's **content address** on each expanded target (SPEC-3 §4) — the full Schema
body stays out (registry state, dereferenced by hash), but the *name* of the reading must survive
serialization or a rehydrated hview could never be resolved. Pinned by
`eval-expand.json`'s `fix-expand-with-reading` (bytes differ from the legacy twin only by the
reading hash) and by the untouched legacy cases (reading key present iff authored).
