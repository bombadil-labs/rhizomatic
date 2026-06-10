# Rhizomatic Specification — SPEC-0: Overview & Architecture

**Status:** Draft
**Layer:** —
**Depends on:** none

---

## 1. What Rhizomatic Is

Rhizomatic is not a database. It is a **portable interchange format for arbitrarily relational data, with a guaranteed algebra**: any two delta streams can be forked, merged, and federated by construction, with no coordination protocol, no migration step, and no single source of truth.

A *database* is one kind of machine you can build on top of the format. The format is normative; machines are conformant citizens.

### 1.1 Positioning

| | Portable format | N-ary relations | Provenance in the atom | Conflicts in superposition | Merge = union |
|---|---|---|---|---|---|
| JSON | ✓ | — | — | — | — |
| Git | ✓ | — | ✓ (commit) | — | — (textual 3-way) |
| RDF | ✓ | — (triples) | partial (reification) | — | partial |
| Datomic | — (machine-coupled) | ✓ | ✓ | — (transactor decides) | — |
| Event sourcing | — (app-coupled) | ✓ | ✓ | — | — |
| **Rhizomatic** | ✓ | ✓ | ✓ | ✓ | ✓ |

Rhizomatic occupies the cell in this table that nothing else occupies. Every design decision below exists to keep all five columns checked simultaneously.

## 2. Load-Bearing Principles

These are the axioms. A change to any of these is a different project.

**P1 — Context-freeness.** A delta means the same thing in any stream it appears in. Deltas are assertions, not instructions; they do not mutate a machine and their meaning does not depend on prior state. This is the property from which fork/merge/federation follow *for free*: fork is subset, merge is set union, federation is filtered union.

**P2 — Append-only immutability.** Deltas are never modified or deleted. Retraction is a new delta (negation) targeting an old one. History is a first-class citizen; time-travel is a filter, not a feature.

**P3 — One primitive.** The Delta schema is the only hardcoded structure in the system (the OISC property). Schemas, indexes, negations, queries, vocabulary mappings — all are expressed as deltas. Semantics cannot ossify outside the wire format because schemas travel *as payload*.

**P4 — Closed operator algebra; computation as authorship.** All query, schema, and index behavior compiles to a small, closed, serializable set of operators (SPEC-2). No layer above the delta may require arbitrary computation to be shipped between instances with implicit trust: instances exchange *terms*, never *code*. Arbitrary computation is not excluded from the system — it lives at L7 as **derived authors** (SPEC-7): identified, signed, consent-installed processes whose outputs are ordinary provenance-carrying deltas. Terms run automatically (safe by construction); functions run by explicit consent (a trust gradient, not a trust cliff).

**P5 — Determinism is layered; pluralism is parameterized.** Given (delta set, schema program, resolution policy), output is fully deterministic. Divergent views between users arise only from divergent inputs to that function — different delta subsets, different policies — never from nondeterminism in the machine. The system has no opinion about truth; it has rigorous opinions about *evaluation*.

**P6 — Identity is content-derived.** A delta's identity is computable by anyone from the delta itself (content addressing). No instance mints identity; identity is a property of the format, not of a machine.

## 3. The Stack

```
┌─────────────────────────────────────────────┐
│  L6  Federation        (networking)         │   SPEC-6
├─────────────────────────────────────────────┤
│  L7  Derivation        (userland) ────┐     │   SPEC-7
├───────────────────────────────────────┼─────┤
│  L5  Resolution / Views (output ABI)  │     │   SPEC-5
├───────────────────────────────────────┼─────┤
│  L4  Reactor + Indexes (engine)       │     │   SPEC-4
├───────────────────────────────────────┼─────┤
│  L3  Schemas / HyperViews (programs)  │     │   SPEC-3
├───────────────────────────────────────┼─────┤
│  L2  Operator Algebra  (instructions) │     │   SPEC-2
├───────────────────────────────────────┼─────┤
│  L1  Deltas            (memory) ◀─────┘     │   SPEC-1
├─────────────────────────────────────────────┤
│  L0  Storage Profile   (packs, physical)    │   SPEC-8
└─────────────────────────────────────────────┘
       L7 is the write-back loop: arbitrary
       computation reading from L4/L5 and
       writing signed deltas into L1.
       L0 is invisible to everything above it:
       a physical representation contract, never
       a semantic layer.
```

L1–L6 form a strict stratification. L7 is deliberately a **loop**, not a stratum: derived authors consume materializations and views, perform unrestricted computation, and feed signed assertions back into the memory layer. The kernel (L1–L6) stays closed and deterministic; the userland (L7) is open and Turing-complete. Computation is never excluded from the system — it is excluded from *implicit trust* (P4).

The von Neumann analogy is exact and intentional:

| Computing | Rhizomatic |
|---|---|
| Memory / wire format | Deltas (L1) |
| Instruction set | Operator algebra (L2) |
| Compiled programs | HyperSchemas (L3) |
| CPU | Reactor (L4) |
| Calling convention / ABI | Resolution policies & vocabularies (L5) |
| Networking | Federation (L6) |
| Userland programs / coprocessors | Derived authors (L7) |
| Stored-program property | Schemas stored as deltas (P3) |
| Loose objects vs. packfiles (git) | Hydrated deltas vs. packs (L0) |

Each layer consumes only the guarantees of the layer beneath it. A conformant implementation of layer *n* MUST NOT require knowledge of layers above *n*.

## 4. Evaluation Model (Normative Summary)

The entire system is one referentially transparent function, staged:

```
HyperView = eval(schemaProgram, deltaSet)        // L2–L3: deterministic
View      = resolve(policy, HyperView)           // L5:    deterministic given policy
```

- `deltaSet` is an unordered set (P1 makes order irrelevant to meaning; timestamps are claims *inside* deltas, not stream positions).
- `schemaProgram` is a term in the operator algebra, itself representable as deltas.
- `policy` is a resolution strategy (last-claim-wins, trusted-authors, surface-all, etc.), also representable as deltas.
- Two instances holding the same `deltaSet` and evaluating the same program under the same policy MUST produce identical results, byte-for-byte under canonical serialization.

Indexes are not a separate concept: an index is a **materialized prefix** of this pipeline, incrementally maintained by the reactor (SPEC-4).

## 5. Conformance Philosophy

Rhizomatic ships a **conformance suite, not a reference implementation**. The normative artifacts are:

1. These specification documents.
2. A directory of test vectors: `(input deltas, schema program, policy) → expected canonical output` for every normative behavior, including edge cases (negation chains, merge convergence, expansion termination).

An implementation is conformant if it passes the vectors. The TypeScript implementation is one conformant citizen; it has no special authority. Implementations in Elixir, Rust, the browser, or an embedded sensor are equally first-class — this is what "trivial to implement in unexpected places" means operationally.

### 5.1 Conformance Levels

- **Level 0 — Format:** Can parse, canonically serialize, and content-address deltas (SPEC-1).
- **Level 1 — Evaluator:** Can evaluate operator-algebra terms over delta sets and pass all evaluation vectors (SPEC-2, SPEC-3, SPEC-5).
- **Level 2 — Reactor:** Maintains live materialized HyperViews incrementally and passes incremental-equivalence vectors (SPEC-4).
- **Level 3 — Federation:** Implements the sync protocol and signature verification (SPEC-6).
- **Level 4 — Derivation host:** Can install, sandbox, and run derived authors with correct provenance emission, and passes pure-function replay vectors (SPEC-7).

Higher levels imply lower ones.

## 6. Document Map

| Doc | Layer | Contents |
|---|---|---|
| SPEC-0 | — | This document: principles, stack, conformance |
| SPEC-1 | L1 | Delta wire format, canonical serialization, content addressing, signatures, negation structure |
| SPEC-2 | L2 | The operator algebra: instruction set, closure, decidability, relational completeness |
| SPEC-3 | L3 | HyperSchemas as operator programs; HyperViews; DAG constraint; schemas-as-deltas encoding |
| SPEC-4 | L4 | The reactor: streams, subscriptions, incremental index maintenance, determinism guarantees |
| SPEC-5 | L5 | Resolution policies, views, conflict strategies, vocabulary conventions (the ABI) |
| SPEC-6 | L6 | Federation: sync-as-union, trust boundaries, signed identity, vocabulary mapping |
| SPEC-7 | L7 | Derivation: computation as authorship, derived authors, write-back loop, function portability & consent |
| SPEC-8 | L0 | Storage profile: pack format, dehydration/rehydration contract, repacking, archives & bundles |

## 7. Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as in RFC 2119.

- **Delta** — the atomic unit: an immutable, context-free, content-addressed assertion (SPEC-1).
- **Pointer** — a role-tagged reference from a delta to an entity, another delta, or a primitive.
- **Entity** — an identifier that exists only as the intersection of deltas referencing it. Entities have no independent existence (P1).
- **Operator term** — an expression in the closed algebra of SPEC-2.
- **HyperSchema** — a named, DAG-structured operator program (SPEC-3).
- **HyperView** — the deterministic result of evaluating a HyperSchema against a delta set: relevant deltas, organized by property, with provenance intact.
- **View** — a resolved domain object: conflicts collapsed per policy, primitives extracted.
- **Reactor** — an execution engine that evaluates terms and maintains materializations against a live stream.
- **Derived author** — a content-addressed function with its own signing identity, installed by consent, that reads materializations/views and writes deltas (SPEC-7).
- **Transaction manifest** — an ordinary delta (in the `rdb.txn` vocabulary) whose pointers commit, by content address, to a set of member deltas asserted in one act. Grouping is a claim, never a container (SPEC-1 §9).
- **Pack** — a physical container in which a transaction's members are stored dehydrated against their manifest's envelope metadata; rehydration is byte-exact to canonical form (SPEC-8).
- **Instance** — any holder of a delta set plus an evaluator. Instances are peers; none is canonical.

## 8. Non-Goals

- **Global consensus.** There is no canonical state and no protocol for agreeing on one. (Applications MAY layer consensus on top.)
- **Hard deletion semantics.** Negation suppresses; it does not erase. Retention/erasure for regulatory compliance is an instance-level storage policy, addressed (incompletely) in SPEC-6 §7.
- **A query language.** SPEC-2 defines the target an eventual DSL compiles to; surface syntax is out of scope for v1.
- **Access control.** Selective *sharing* is federation policy (SPEC-6); enforcement within an instance is an application concern.
