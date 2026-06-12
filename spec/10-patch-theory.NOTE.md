# Rhizomatic Specification — Note 10: Relationship to Patch Theory (darcs, Pijul)

**Status:** Note — situates the design against prior art; records two adoptable lessons and
one explicit refusal. Nothing here is normative yet; the proposals at the end name their
landing sites.

---

## 1. The shared ancestor

Darcs's founding claim — *a repository is a **set** of patches, not a sequence of snapshots*
— is Rhizomatic's claim too (SPEC-1 §8: a delta set is a grow-only set CRDT; merge is union).
The difference is how each system pays for set semantics:

- **Darcs** keeps patches *context-dependent* ("insert at line 12") and buys commutativity
  with a rewriting algebra: reordering two patches may rewrite both, and the theory must
  prove the rewrites coherent. The cost is the commute machinery and its pathological merges.
- **Pijul** grounds the same ambition in a graph-shaped pristine with **explicit minimal
  dependencies** per patch, and makes conflicts first-class states of the graph rather than
  failures.
- **Rhizomatic** exits the problem: deltas are *context-free by construction* — complete,
  self-contained, content-addressed assertions. Every pair of deltas commutes **on the
  nose**, with no rewriting. In patch-theory terms the commutation algebra is degenerate
  (trivial), which is the design: order-blindness is bought at write time, not litigated at
  merge time.

Correspondences worth naming:

| Patch theory | Rhizomatic |
|---|---|
| Repo = set of patches | DSet = set of deltas (SPEC-1 §8) |
| Commutation (after rewriting) | Trivial commutation (order-blind eval, SPEC-2 §5) |
| Inverse patch (rollback erases) | Negation (rollback **appends**, SPEC-1 §7) |
| Pijul: conflict as first-class graph state | Superposition; resolution per-reader (SPEC-5) |
| Cherry-picking via commutation | Lenses + admission take arbitrary subsets (SPEC-6); a negation of an absent target is inert |
| Pijul: explicit minimal dependencies | **Partially present** — see §2 |

## 2. Lesson one (adoptable): explicit semantic dependencies

Structural dependencies are already explicit Merkle links: a negation pins its target; a
manifest pins its members. *Semantic* dependencies are silent: a claim asserted in light of
some resolved view records nothing about what it was responding to.

The product layer has already grown this organ once, deliberately: a **decision record**
(Chorus) pins the basis (content address of the resolved view) and the arrival prefix — a
Pijul-style dependency edge in everything but name. The generalization is additive:

> *Proposal:* an optional, conventional **basis pointer** on any claim —
> `…basis → <content address of the view (or delta set digest) the author read before
> asserting>` — making causal structure data. Buys: dependency-closure transfer ("pull this
> claim and what it knew", darcs `--and-deps` done honestly), sharper replay, and "what was
> this claim responding to?" as an ordinary query. Costs: nothing semantic; deltas without a
> basis stay first-class. Landing site: a SPEC-1 §7-adjacent vocabulary convention plus
> SPEC-6 "closure mode" admission; Chorus can pilot it as `chorus.belief.basis`.

## 3. Lesson two (adoptable): packs should compress along the causal graph

SPEC-8 v0 dehydrates members against the *lexicographically-first claiming manifest* — git
packfile mechanics: compression keyed on containment accident. The Pijul-shaped alternative
orders and compresses along the **dependency graph**: negations adjacent to their targets,
claims adjacent to their basis, topologically sorted so a streaming reader never holds an
unresolvable reference. This is safe precisely because rehydration is order-independent (the
set is the truth); it is a compression/streaming optimization, not a semantics change.
Landing site: the deferred SPEC-8 P3 (indexes/dictionaries) work.

## 4. The refusal: no commutation-by-rewriting, ever

A rewritten delta is a *different* delta — different canonical bytes, different content
address, broken signature. Darcs's commute functions and destructive inverses belong to a
world where state is "apply the sequence"; Rhizomatic has no `apply` — evaluation is a pure
function over the set. Importing the machinery would shatter identity (P6) and the
append-only audit trail. The fold, if one wants the slogan: **trivially-commutative set
below the read boundary; causal/dependency structure above it.** Each theory deployed where
it is strong.

## 5. Open questions

- Should the basis pointer pin a View hash, an HView hash, or a set digest? (The decision
  vocabulary pins view basis + arrival prefix; a general convention may want the weakest
  thing that still answers "what did the author know".)
- Does closure-mode admission (SPEC-6) need its own conformance vectors, or is it derivable
  from existing lens/admission semantics plus the basis convention?
- Pack ordering by causal graph: measure first — string-table interning may dominate the win
  at realistic store sizes.
