# SPEC-17 proposal: anchored reads and footprint-bounded cost

**Status:** Proposal (2026-10-14). Myk ruled that no behavior may have a cost that scales with
system size, and assigned this work, including the SPEC-16 amendment, to Claude. This document
is the working contract until its parts are promoted into `spec/02-operators.md`,
`spec/04-reactor.md` and `spec/16-materialization.md` with shared vectors.

## 1. The rule

**P7 — Footprint-bounded operations.** The cost of one operation is bounded by its own footprint
times an index factor. A read's footprint is the deltas that can change its answer. No
operation iterates the whole store, all law, all registrations, or all history. A store will
grow without bound; an operation that is linear in the store fails at some size, whatever its
constant factor.

The rule applies to reads, writes, verification and serving. A design that is correct only at
small sizes is not correct.

## 2. What the audit found (2026-10-14, at `0.11.0-next.9`)

Every read path is linear in the store today.

- The evaluator scans. `DeltaSet` is a map with no index. `evalTerm` forks the whole input on
  validity, `select` and `mask` scan their operands, and each `expand` child re-evaluates its
  schema over the whole input. A cold read costs O(N × (1 + expanded children)).
- The reactor keeps a target index, a negation index and a value index (SPEC-4), but evaluation
  does not use them. `reactor.snapshot()` copies the whole set.
- SPEC-16 requires the full authorized source in every snapshot (MR-04 limits text, MR-09,
  MR-10). One batch read decodes the full snapshot about four times, and checks every
  appearance's signature each time. The 4096-appearance limit then makes the portable route
  disappear on any store above 4096 deltas.
- The host's current-source check rebuilds the full revision.
- Loam adds whole-store copies and rehashes for read closure, as-of and channel reads; O(R)
  registration lookups; O(E) erasure walks per read; and an O(R²) registration replay per query
  when pools exist.

## 3. The delta source

A **delta source** is the read side of a store. It has three operations:

| Operation | Returns | Required cost |
|---|---|---|
| `get(id)` | the delta with that id, or none | O(log N) |
| `targets(e)` | the ids of every delta with at least one pointer whose target is the entity `e`, any role, any context | O(log N + result) |
| `negators(x)` | the ids of every delta with a pointer `{role: "negates", target: DeltaRef(x)}` | O(log N + result) |

The reactor implements all three with its existing indexes. A SQL store implements them with
two secondary indexes (pointer target entity, negated delta id). This is the read contract that
a future `rhizomatic-store` package exposes; it adds nothing a well-indexed table cannot answer.

A host **selection** is a pointwise predicate `admits(d)` over deltas: authorization, read
closure, a historical cutoff on arrival. It is decided per delta, from that delta and from host
state that does not depend on the read. A selection that needs to inspect other deltas to
decide one delta is not pointwise, and is outside this profile.

## 4. The scope of a read

Let D be the deltas the selection admits. For a finite set E of entity ids:

- `S0(E)` = every delta in D with a pointer whose target entity is in E.
- `N*(x)` = every delta in D that negates x, and every delta in D that negates a member of
  `N*(x)`, transitively.
- `S(E)` = `S0(E)` ∪ the union of `N*(x)` for every x in `S0(E)`.

`S(E)` is a function of D and E alone. A host computes it with `targets` and `negators` in
O(|S(E)| × log N). Two witnesses given the same D and E produce the same set, so its membership
digest is a deterministic check.

**Closure lemma.** For every x in `S(E)`, every negation chain that decides whether x is negated
lies in `S(E)`. Therefore `negated(x, A ∩ S(E)) = negated(x, A)` for any operand A, and every
pointwise operator gives the same membership for members of `S(E)` over `S(E)` as over D.

## 5. The anchored fragment

A gather term is **anchored** when every place it reads deltas is tied to an entity it can
name. The static check below decides it. A term that fails the check is **unanchored**.

| Form | Rule |
|---|---|
| `input`, `select`, `union`, `intersect`, `difference` | allowed; pointwise |
| predicates (`hasPointer`, `match`, `and`, `or`, `not`, …) | allowed when pure; `aliased` makes the term unanchored |
| `mask drop`, `mask annotate` | allowed (closure lemma) |
| `mask trust(p)` | allowed when `p` is allowed |
| `group byRole`, `group byTargetContext` | allowed; files only deltas that point at the group root |
| `group const` | allowed only when its operand is a `select` whose predicate is a conjunction containing `hasPointer{targetEntity}` at a constant, the root, or a hole; that entity is an anchor |
| `expand`, `fix` | allowed; each child root or `fix` entity is an anchor; an `aliased` role makes the term unanchored |
| `prune` | allowed; an `aliased` keep makes the term unanchored |
| `inView(term, …)` | allowed only when `term` is a `select` whose predicate is a conjunction containing `hasPointer{targetEntity: const G}`; G is a **static anchor** |
| `resolve`, every reading order | no source access |
| `actsFor` | already refused by core/1 |

A term's **static anchors** are its constant `inView` and `group const` entities and its `fix`
entities. Its **dynamic anchors** at a root r over D are r and every entity at which the
evaluation runs a schema (expanded children).

## 6. Anchored evaluation

**Definition.** The scope of an anchored read of term T at root r over D is
`E* = static(T) ∪ dynamic(T, r, D)`.

**Theorem.** Evaluating T at r over `S(E*)` gives the same canonical HView as evaluating T at r
over D.

*Sketch.* By the closure lemma, every member of `S(E*)` has the same membership and negation
status in every operand over `S(E*)` as over D. Each `group` at an anchor files only deltas that
point at that anchor, and all of those are in `S0(E*)`. Each `inView` sub-term selects only
deltas that point at its static anchor. `resolve` reads only the HView.

**Discovery.** A host finds `E*` without scanning D:

1. Set `E0 = static(T) ∪ {r}`.
2. Evaluate T over `S(Ei)` and record the dynamic anchors.
3. If every recorded anchor is in `Ei`, stop: `E* = Ei`. Otherwise set `E(i+1)` to `Ei` plus the
   recorded anchors, and go to step 2.

Each round is exact for the levels it already holds: a member of `S(Ei)` evaluates as it does
over D, so the anchors found are true anchors. Each round adds at least one entity, and the
number of rounds is at most the expansion depth plus one. An implementation MAY grow the scope
lazily inside one evaluation instead of in rounds; the result is the same set.

**Maintenance.** A warm view refreshes over its scope, and that scope replaces the V5 support
set (SPEC-4 ERRATA V5): a new delta can change a root only when it points at an entity in the
root's scope or reaches a member through a negation chain. That is the same relevance test V5
already runs, with a more precise anchor check (`anchorAnalysis` instead of the V5 analyzer). A
lowered program (a host `lowerTerm`) still dispatches broadly unless the host declares the
entities its lowering reads (`lowerDeps`); those entities join every root's support set. An
unanchored program dispatches broadly, as before. The aliased side finding in §9 is closed by
this: an aliased term is unanchored.

**Native reads.** A reactor or store evaluates an anchored read this way. Its cost is
O(rounds × |S(E*)| × term size). An unanchored term keeps today's full evaluation and is not
footprint-bounded; a host that serves one must say so (it is a P7 violation to fix, not a mode).

## 7. SPEC-16 amendment: the scoped snapshot

These changes replace the "full authorized source" model for batch gather.

1. **Selection profile.** Add `rhizomatic.scoped-snapshot/1`. A binding with this profile says
   that each capture covers one declared scope, not the whole source. The existing
   `host-authorized-snapshot/1` keeps its meaning.
2. **Scope field.** source-snapshot/1 and source-basis/1 gain `scope`: a sorted, distinct,
   nonempty array of entity ids. It contains the request root and every static anchor of the
   program.
3. **Membership.** For a scoped capture, each component's `operandIds` is `S(scope)` over the
   host's selection, and `rawIds` is `S(scope)` over the unfiltered store. `exclusions` is
   `rawIds` minus `operandIds`. Appearances are exactly the operands.
4. **Revision.** `revision = H(C({binding, authority, selection, scope, components, membership,
   appearanceDigest, exclusions}))`. A host recomputes it in O(|S(scope)| × log N).
5. **Current check.** `checkCurrent` receives the scope. The host recomputes the scoped revision
   from its indexes. It never rebuilds the whole source.
6. **Structural check.** The endpoint refuses a scoped snapshot with an operand that is not in
   `S(scope)` as computed from the snapshot itself (`invalid-input`). Completeness against the
   host's store stays host testimony, as today (MR-10).
7. **Program check.** A gather under a scoped binding whose program is unanchored refuses
   `unsupported-operation` before evaluation.
8. **Scope miss.** If evaluation reaches a dynamic anchor that is not in the declared scope, the
   gather refuses with the new code `scope-miss`. The body lists the missing entities, sorted.
   A host widens the scope and makes a new invocation. The evaluator finishes the pass with an
   empty child at each missed anchor so that it reports every miss at once.
9. **Limits.** The `appearances` and `inventoryIds` limits count the scoped snapshot. The text
   "including the full authorized source rather than the facts a particular root happens to use"
   and "A profile deliberately starts with full snapshots" is removed. Over-capacity now means
   that one read's footprint is too large, not that the store is too large.
10. **Verified appearances.** MR-09 forbids a verification cache across calls. Replace that with:
    an implementation MAY keep a process-local set of appearance keys
    (`H(canonical appearance bytes)`) that it has fully verified, and MAY skip the signature and
    content-address checks for a key in that set. Only successes enter the set. The key covers
    the id, the claims and the signature, so this skips repeated work and relaxes no check.
11. **Producer.** rhizomatic exports the producer for snapshot/1, capture/1 and the snapshot
    carrier, given the binding, the authority, the scope, the components and a signer. Hosts
    supply the selection and the key; the library owns the format, the digests and the revision.

The maintained (M3) lifecycle still captures full snapshots. Scoping it per root is a follow-up;
§9 tracks it.

## 8. Loam

- Ordinary reads use anchored evaluation over the reactor's indexes, with read closure and
  as-of cutoffs as the pointwise selection.
- The portable door uses the scoped snapshot, the library producer, and the scoped current check.
  Program selection reads definition acts by index, not by scanning law.
- Per-read lookups by lens use maps. Read closure is computed once per read and cached on the
  store revision. The governed grant ground is built only when lowering applies.

## 9. Open items

- **Maintained trust state (Myk, 2026-10-14: "snapshot trust state and patch it as deltas
  flow").** The governed trust mask reflects over the grants entity, which holds every grant, so
  a read's scope grows with the number of users. The direction: trust state becomes accumulated
  state. A maintained snapshot (the set of lawful strikers, with the revision it reflects) is
  built once and patched by each grant, revocation or negation that arrives, at a cost bounded by
  that delta's own negation chain. A read consults the snapshot by key (is this striker trusted at
  this revision?) instead of re-reflecting every grant. Open questions: how the snapshot is
  represented so both witnesses produce the same bytes; how an as-of read gets the snapshot at a
  past cut; and whether the snapshot is itself a delta-backed artifact or private reactor state.
- **Alias.** `aliased` needs a value-index first hop (`rhizomatic.alias.fragment == name`) to be
  anchored. Until then, an aliased term is unanchored.
- **Maintained reads (M3).** Per-root scoped captures for install, refresh and read.
- **Write side.** Loam's journal catch-up rereads the whole journal after a foreign write.
- **Side finding (closed by slice R1b).** `isRootAnchored` ignores `aliased`, so an aliased
  root-anchored select got narrow dispatch and a new alias mapping did not re-dispatch it (SPEC-9
  says it must). Dispatch now uses `anchorAnalysis`, which treats `aliased` as unanchored.

## 10. Slices

| Slice | Repo | Content |
|---|---|---|
| R1 | rhizomatic | Delta source, `S(E)`, the anchored check, anchored evaluation with discovery, in TS and Rust. Vectors: scope construction, anchored equals full, classification. Property test: anchored equals full on random stores. |
| R1b | rhizomatic | Warm-view refresh over the scope, and scope dispatch (§6 Maintenance), in TS and Rust. Property test: every warm view equals batch after every ingest. |
| R2 | rhizomatic | The SPEC-16 amendment: scoped profile, scope field, scoped revision and current check, `scope-miss`, structural and program checks, verified-appearance memo, producer, and the quadratic inventory check fixed. Vectors in both witnesses. Release C. |
| L1 | Loam | Ordinary native reads on anchored evaluation; the per-read lookup and cache fixes. |
| L2 | Loam | The portable door on scoped snapshots through the producer. |
