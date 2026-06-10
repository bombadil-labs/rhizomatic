# Rhizomatic — Working Agreement

This file defines *how we work* in this repo. The spec in `spec/` defines *what we build*.
Read both before writing code.

Rhizomatic is a portable format for arbitrarily relational data — composable, forkable,
mergeable, and federate-able by default. See [README.md](README.md) and
[spec/00-overview.md](spec/00-overview.md). It is a **format with a conformance suite**, not a
reference implementation: any codebase that passes the vectors is a first-class citizen.

---

## Repo layout

```
spec/                  Normative specification — the source of truth for BEHAVIOR.
vectors/               Language-agnostic conformance vectors — the source of truth for CORRECTNESS.
implementations/
  ts/                  TypeScript implementation.
  rust/                Rust implementation.
ERRATA.md              (created per spec doc, on demand) recorded spec/impl contradictions.
```

Two implementations grow up **in parallel and in lockstep**. They are not a primary and a port —
they are two independent witnesses to the same spec. When they disagree, the spec or the vectors
are underspecified, and that is a finding, not a nuisance.

## Prime directive: the vectors are the contract

- **Behavior** is defined by `spec/`. **Correctness** is proven by `vectors/`.
- Every normative behavior gets a vector *before or alongside* its code — never after.
- Both implementations MUST pass the **same** vectors. Cross-implementation parity is the headline metric.
- A slice of work is **done** only when, together: a vector exists for it · TS passes · Rust passes ·
  their canonical output bytes match each other (byte-exact wherever the spec demands canonical form).
- No implementation ever gets bespoke behavior to make a test pass. If a vector is wrong, fix the
  **vector** (and the spec, if the vector was faithfully wrong) — never one implementation in isolation.

## The workflow loop (per feature / milestone slice)

1. **Spec check.** Locate the normative statements (MUST/SHOULD/MAY). If anything is ambiguous,
   resolve it in `spec/` or `ERRATA.md` *before* coding. Do not encode a guess into one implementation.
2. **Vectors first.** Write or extend vectors in `vectors/`, capturing the behavior and its edge cases
   (negation chains, pointer permutations, empty/all-negated properties, divergent members, …).
3. **Implement in TS.**
4. **Implement in Rust.**
5. **Run both against `vectors/`.** Confirm parity. Diff the canonical bytes, not just "tests pass."
6. **Commit only when both are green.** Keep the two implementations within one slice of each other —
   never let one race more than a slice ahead.

## Testing norms

- **Conformance tests** load `vectors/` and assert byte-exact canonical output. These are shared truth.
- **Property tests** (each implementation, ideally mirrored):
  - merge is commutative, associative, idempotent (grow-only set CRDT, SPEC-1 §8);
  - **ingestion-order independence** — any order of the same deltas converges to identical state
    (this becomes the incremental-equivalence oracle once the reactor exists, SPEC-4 §1);
  - pointer-permuted deltas hash *differently* yet evaluate *identically* (SPEC-1 §4.1 / SPEC-2 §5).
- **Determinism is absolute.** Same inputs → byte-identical canonical bytes. No wobble, ever (P5).
- When a property test finds a divergence between TS and Rust, that is a P0: it means the spec/vectors
  did not pin the behavior. Fix the pin, then both implementations.

## Spec-contradiction protocol (from README, "Rules of engagement")

When implementation contradicts specification, **the contradiction is the deliverable.**

- Do not silently diverge. Do not silently comply with something broken.
- Record it in `ERRATA.md` (per spec doc), propose the amendment, and keep each spec doc's
  "Open Questions" section current. The spec docs are the coordination surface for every collaborator,
  human and otherwise — we are *least* relaxed about them, in cheerful contrast to the data model.

## Code style & scope

- **Boring at L0–L2.** Deltas, the operator algebra, and serialization aspire to be the kind of code
  strangers rewrite in five languages. Prefer obvious over clever. Save the cleverness for the
  reactor's dispatch (L4) and the pack format (L0), where it pays.
- **v0 framing: race to something that works, not to production.** Prefer clarity and cross-impl
  parity over performance, persistence, and deployment polish. Don't build persistence, networking, or
  a WASM host until the milestone in front of us needs it. In-memory and pure-function first.
- Match the surrounding code's idiom in each language; don't impose one language's conventions on the other.

## Milestones (build order, from the README)

| | Milestone | Status |
|---|---|---|
| **M0** | The atom: canonical CBOR, content addressing, signatures, delta-set ops | **in progress** |
| **M1** | The evaluator: the eight operators as a pure function; `rdb.SchemaSchema` bootstrap | **in progress** |
| M2 | The reactor: ingest, core indexes, incremental maintenance, incremental-equivalence | later |
| M3 | Packs: the L0 round-trip | later |
| M4 | Federation: convergence from arbitrary divergent states | later |
| M5 | Derivation: derived authors, replay verification (depends on SPEC-7, in authoring) | later |

M0 and M1 are being built **together**: the batch evaluator (M1) is the oracle the reactor (M2) will
later be tested against, so we want it correct and vector-backed from the start.

## Naming

- The project is **Rhizomatic**. Lowercase **rhizome** is the biological metaphor (the mushroom, the
  network) — never the product name; leave it in prose.
- The reserved vocabulary namespace is currently **`rdb.*`** (`rdb.txn`, `rdb.schema.*`, `rdb.term.*`,
  `rdb.alias`, `rdb.SchemaSchema`). This abbreviated "RhizomeDB" and is **under review** — it may become
  `rhz.*`. Until decided, treat the prefix as a single configurable constant in each implementation, so a
  later change is a one-line edit plus a vector regen, not a sweep.

## Commands

Filled in as each implementation is scaffolded.

- TypeScript: `cd implementations/ts && npm test`
- Rust: `cd implementations/rust && cargo test`
- Parity (both against `vectors/`): _(top-level runner — TBD when both scaffolds exist)_
