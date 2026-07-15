# Rhizomatic

**A portable format for arbitrarily relational data — composable, forkable, mergeable, and federate-able by default.**

Rhizomatic is not a database. A database is one kind of machine you can build on top of it. Rhizomatic is the format underneath: a way of writing down anything anyone claims about anything, such that any two collections of such claims can be combined by set union — no migration, no coordination protocol, no merge conflicts, no central authority deciding what's true.

This repository contains the specification and two parallel implementations — TypeScript and
Rust — built in lockstep against a shared conformance-vector suite ([vectors/](vectors)). All
six substrate milestones (M0-M5, conformance Levels 0-4) are implemented in both witnesses. See
[PROGRESS.md](PROGRESS.md) for the full build log and [§ For the Implementer](#for-the-implementer)
for the rules of engagement.

> **Applications live in their own repos.** The substrate is published as
> [`@bombadil/rhizomatic`](https://www.npmjs.com/package/@bombadil/rhizomatic); products consume it
> as a dependency. Chorus (agent memory built on the format) was extracted from this repo and is
> being reborn as a **loam app**.

**See it run:** the docs site is live at **https://mbilokonsky.github.io/rhizomatic/** —
a landing page leading to the interactive tour and the playground. Locally: open
[docs/index.html](docs/index.html) in a browser
(`npx serve docs` from the repo root, or any static server) — a guided, narrated walk through
the format where every widget runs the real implementation: live content addressing,
superposition, policy lenses, retraction + audit, time travel, and two peers converging by
union. **Both witnesses are on the page**: the TypeScript implementation is bundled, the Rust
implementation is loaded as WebAssembly, and the tour runs the committed conformance vectors
through each — then has Rust reproduce, byte for byte, every delta you author live. The free-form version is
[docs/playground.html](docs/playground.html) — three sovereign peers, no narration.

For the terminal version: `cd implementations/ts && npm install && npm run demo` — a seven-act
story covering superposition, policy lenses, retraction + audit views, time travel, federation,
derived authors, and packs.

---

## The Dream

Most data systems are towers: a single source of truth at the center, a schema enforced at the gates, a hierarchy of access radiating outward. Towers are legible and efficient and they all share one failure mode — they concentrate the authority to say what is real. When two towers disagree, one must submit, or they must build a third tower above them both.

Rhizomatic is built on the other architecture — the mushroom, the rhizome, the network that grows from any point and survives the loss of any point. Its commitments:

- **There is no single source of truth.** There are only *claims*: who asserted what, when, about which things. Contradiction is not an error to be resolved at write time; it is information, held in superposition, adjudicated at read time by whoever is reading, according to *their* policy of trust.
- **History is not overwritten.** Nothing is ever updated or deleted. Retraction is a new claim about an old claim. The past remains queryable forever; "current state" is just a lens.
- **Merging is union.** Fork a dataset by taking a subset. Merge two datasets by combining them. Federate by exchanging filtered subsets. These are not features built on top of the system — they are arithmetic facts about how the atoms are defined.
- **No instance can issue another instance an order.** Peers exchange assertions and lenses, never commands and never code-with-implicit-trust. We call this the *sich principle*: coordination without conscription. Every participant — human, organization, or autonomous process — joins as a sovereign making signed claims, or not at all.

The wager underneath all of it: if you get the *atom* right — small enough to be universal, structured enough to carry provenance, context-free enough that it means the same thing everywhere — then the capabilities everyone bolts awkwardly onto databases (audit, time-travel, offline-first, sync, federation, multi-perspective views) stop being features and become *consequences*.

## What It Actually Is

One hardcoded structure: the **delta** — an immutable, content-addressed, signed assertion connecting any number of entities and values through role-labeled pointers ([SPEC-1](spec/01-delta.md)). Everything else in the system — schemas, queries, indexes, negations, trust lists, transactions, even the vocabulary for all of the above — is expressed *as deltas*. Semantics travel as payload. The system cannot ossify around an external authority because there is nowhere external for authority to stand.

Above the atom sits a deliberately tiny, closed **operator algebra** ([SPEC-2](spec/02-operators.md)) — the instruction set everything compiles to. Ten operators, decidable predicates, no Turing-complete escape hatch. The exclusions are the design: because terms are inspectable rather than executable-and-opaque, schemas serialize as data, indexes maintain themselves incrementally, and federated peers can accept each other's queries with structural safety instead of trust.

Arbitrary computation is not banished — it is *given an identity*. The **derivation layer** ([SPEC-7](spec/07-derivation.md)) hosts unrestricted functions (reducers, ML models, LLM adjudicators, humans-in-the-loop) as **derived authors**: content-addressed, consent-installed processes whose outputs re-enter the system as ordinary signed claims. Everything that computes is an author. One rule, all the way up.

The full stack, each layer specified in its own document:

| Layer | What it is | Spec |
|---|---|---|
| L7 | **Derivation** — computation as authorship; the write-back loop | [SPEC-7](spec/07-derivation.md) |
| L6 | **Federation** — sync as set union; sovereignty and trust | [SPEC-6](spec/06-federation.md) |
| L5 | **Resolution & Views** — collapsing superposition, per declared policy; the vocabulary ABI | [SPEC-5](spec/05-resolution.md) |
| L4 | **Reactor** — the execution engine; live, incrementally-maintained indexes | [SPEC-4](spec/04-reactor.md) |
| L3 | **Schemas & HyperViews** — programs in the algebra; lenses over the rhizome | [SPEC-3](spec/03-schema.md) |
| L2 | **Operator Algebra** — the closed instruction set | [SPEC-2](spec/02-operators.md) |
| L1 | **Deltas** — the atom; the wire format | [SPEC-1](spec/01-delta.md) |
| L0 | **Storage Profile** — packs; physical compression beneath an invariant logical form | [SPEC-8](spec/08-storage.md) |

Above the stack sit two further documents: [SPEC-9](spec/09-alias.PROPOSAL.md) (proposal:
concepts with oriented slots, mapping claims, and the `aliased` closure — accountable semantic
convergence, vectored in both witnesses) and [Note 10](spec/10-patch-theory.NOTE.md) (how this
design relates to darcs/Pijul patch theory, and the one piece of their machinery we refuse).

Start with [SPEC-0](spec/00-overview.md): the six load-bearing principles, the architecture, and the conformance philosophy.

Where this sits among its neighbors: JSON is portable but has no merge semantics. Git forks and merges but has no semantics — it merges text and hands conflicts to humans. RDF has semantics and federation but thin provenance and no superposition. Datomic has immutable facts but one transactor, one truth. Event sourcing has the log but couples it to one application's interpretation. Rhizomatic is the cell in that table nothing occupies: **portable format + n-ary relations + provenance inside the atom + conflicts in superposition + merge-is-union.** Every design decision in `spec/` exists to keep all five properties true simultaneously.

## Decisions Already Made

So that no implementer re-litigates them by accident (re-litigating them *on purpose* is welcome — see below):

1. **Format, not machine.** The normative artifact is a spec plus conformance vectors, not a reference implementation. Any codebase that passes the vectors is a first-class citizen ([SPEC-0 §5](spec/00-overview.md)).
2. **Identity is content-derived.** A delta's id is the hash of its canonical bytes. No instance mints identity; negations pin their targets cryptographically (Merkle); signatures sign hashes ([SPEC-1 §4–5](spec/01-delta.md)).
3. **Timestamps are claims.** There is no clock in the format. Trust in claimed time is resolution policy ([SPEC-1 §6](spec/01-delta.md)).
4. **Determinism is layered; pluralism is parameterized.** `eval(schema, deltaSet)` and `resolve(policy, hyperview)` are pure functions. Two people see different truths only because they chose different inputs — never because the machine wobbled ([SPEC-0 P5](spec/00-overview.md)).
5. **Kernel closed, userland open.** Terms ship and run automatically; code ships as content-addressed blobs and runs by explicit consent. A trust gradient, not a trust cliff ([SPEC-0 P4](spec/00-overview.md), [SPEC-7 §7](spec/07-derivation.md)).
6. **Grouping is a claim, never a container.** Transactions are manifest deltas committing to sovereign members by hash. Deltas are always independently extractable; atomic acceptance is a verifiable courtesy, not a format invariant ([SPEC-1 §9](spec/01-delta.md)).
7. **The logical form is sacred; the physical form is free.** At rest, transaction members dehydrate against their manifest's envelope and rehydrate byte-exactly on extraction. Hash the hydrated form, always ([SPEC-8 §2](spec/08-storage.md)).

## For the Implementer

You may be a person. You may be a Claude instance reading this at the top of a fresh context window with instructions to make this real. Either way — welcome. Here is what you need to know that the spec's confident tone won't tell you:

**The spec is ahead of the evidence, on purpose.** There are zero implementations and zero proofs behind these documents. Every MUST in SPEC-2 through SPEC-8 is *provisional until a conformance vector exists for it*. The operator set is version `alg: 1` until the relational-completeness proof ([SPEC-2 §6](spec/02-operators.md)) and at least one real workload have weighed in. The conformance suite is the mechanism by which guesses graduate into law. **Therefore: build the suite alongside the thing, not after it.**

**Build order.** Each milestone maps to a conformance level ([SPEC-0 §5.1](spec/00-overview.md)) and is independently valuable:

- **M0 — The atom.** Canonical CBOR serialization, content addressing, signatures, the delta-set operations. Smallest possible library, heaviest possible test vectors. Everything else stands on this; get it boring and bulletproof. *(Level 0)*
- **M1 — The evaluator.** The eight operators as a pure function over in-memory delta sets. No persistence, no reactivity — just `eval(term, set)` matching vectors byte-for-byte. This is also where the `rhizomatic.HyperSchemaSchema` bootstrap ([SPEC-3 §5](spec/03-schema.md)) gets pinned. *(Level 1)*
- **M2 — The reactor.** Ingest pipeline, the four core indexes, dispatch, incremental maintenance with the incremental-equivalence property tested against batch evaluation under randomized ingestion orders. *(Level 2)*
- **M3 — Packs.** The L0 round-trip. Can be built any time after M0; pairs well with M2's checkpoints. *(Level 0 extension)*
- **M4 — Federation.** Two reactors converging from arbitrary divergent states. Property-test it: random fork pairs MUST converge to union. *(Level 3)*
- **M5 — Derivation.** Binding lifecycle, pure-function replay verification, loop budgets. The WASM host ABI ([SPEC-7 §10](spec/07-derivation.md)) is the largest unresolved design surface in the project — expect to draft spec text, not just code. *(Level 4)*

**Rules of engagement with the spec.** When implementation contradicts specification, *the contradiction is the deliverable*. Do not silently diverge; do not silently comply with something broken. Record it (an `ERRATA.md` per spec doc works), propose the amendment, and keep the open-questions sections in each document updated — they are the project's honest frontier, and several of the best design decisions in `spec/` were made by promoting an open question to a closed one. The spec documents are the coordination surface for every collaborator, human and otherwise; treat them as the single thing this project is *least* relaxed about, in cheerful contrast to its data model.

**Style of the thing.** Prefer boring code at L0–L2 — these layers aspire to be the kind of software that gets rewritten in five languages by strangers. Save the cleverness for the reactor's dispatch structures and the pack formats, where it pays. And when you hit a fork in the road the spec doesn't cover, you have the design tradition to steer by: *when in doubt, push authority toward the edges, keep the kernel inspectable, and make the judgment a signed claim rather than a hidden mechanism.*

## Status

Specification draft **with two working witnesses**: TypeScript and Rust parity-verified
byte-for-byte against shared vectors at every layer — canonical CBOR, content addressing (now
including the `bytes` Target kind, 0.4), Ed25519 signatures, the operator algebra
(including parameterized terms and the SPEC-9 alias closure), resolution policies, the
schemas-as-deltas bootstrap, the incremental reactor, packs, federation, and derivation.
The interactive tour at the docs site runs the committed vectors through BOTH witnesses in your
browser (the Rust one as WebAssembly): 149/149. Cross-implementation HTTP federation is proven
(a Rust peer converging with a live TypeScript server to identical canonical digests). Gaps and
contradictions found during implementation are recorded in per-spec ERRATA files
(`spec/*.ERRATA.md`) — including genuine spec bugs the conformance suite caught — and every
resolved erratum has been folded back into the spec documents themselves.
The dream is old; this articulation of it is new. The arc that produced it — assembly language for data → portable IR → format-with-a-guaranteed-algebra → closed kernel with a sovereign userland — is preserved in the spec documents' structure itself, and the documents are the durable residue of that thinking.

Mushrooms versus towers, all the way down. It compiles.

## License

Dual-licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the
work by you shall be dual-licensed as above, without any additional terms or conditions.

Published: [`@bombadil/rhizomatic`](implementations/ts) on npm. The [`rhizomatic`](implementations/rust) Rust
crate is an in-repo conformance witness (independent validation + the WASM tour), not published to crates.io.
