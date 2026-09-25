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
  ts/                  TypeScript implementation (@bombadil/rhizomatic) — full depth.
  rust/                Rust implementation — full depth.
  elixir/              Elixir witness — Level 0 (issue #19).
  haskell/             Haskell witness — Level 0 (issue #29).
ERRATA.md              (created per spec doc, on demand) recorded spec/impl contradictions.
```

This repo is the **substrate**: normative behavior lives only in spec/ + vectors/ + implementations/.
Product/application layers consume the witness as a published dependency (`@bombadil/rhizomatic`)
and live in their own repos — they never live here, and the substrate never depends on them. Chorus
(agent memory built on the format) was extracted from `apps/chorus` and is being reborn as a **loam
app** (2026-07); its git history remains in this repo before the extraction commit.

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
   never let one race more than a slice ahead. **Lockstep binds per conformance level, not per
   repo** (issue #19): a witness that has declared a lower level in its `witness.json` (e.g. the
   Elixir witness at L0) is a complete, first-class citizen at that level — it is "behind" at L1+
   by design, not by racing. Within any level a witness implements, the one-slice rule holds.

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
| M0 | The atom: canonical CBOR, content addressing, signatures, delta-set ops | ✅ both witnesses |
| M1 | The evaluator: the eight operators; `rhizomatic.HyperSchemaSchema` bootstrap | ✅ both witnesses |
| M2 | The reactor: ingest, indexes, incremental-equivalence, events, bundles | ✅ both witnesses |
| M3 | Packs: the L0 round-trip | ✅ both witnesses |
| M4 | Federation: convergence from arbitrary divergent states | ✅ both witnesses |
| M5 | Derivation: derived authors, replay verification, budgets | ✅ both witnesses |

The build order is complete; see [PROGRESS.md](PROGRESS.md) for the slice-by-slice log. Ongoing
work: the reference demo (implementations/ts/demo), CI, and whatever PROGRESS.md lists as next.

## Naming

- The project is **Rhizomatic**. Lowercase **rhizome** is the biological metaphor (the mushroom, the
  network) — never the product name; leave it in prose.
- The reserved vocabulary namespace is **`rhizomatic.*`** (`rhizomatic.txn`, `rhizomatic.hyperschema.*`,
  `rhizomatic.term.*`, `rhizomatic.alias`, `rhizomatic.HyperSchemaSchema`) — decided 2026-06-11. It remains a
  single configurable constant (`VOCAB_PREFIX`) in each implementation, so any future change stays a
  one-line edit plus a vector regen.
- Use [plain language in vNext specs and docs](docs/vnext-language.md). Loam's older vocabulary
  must not become new Rhizomatic terminology. Existing wire keys and formal format names keep
  their spelling until a separately specified format change.

## ADLC status

ADLC is suspended in this repository until Myk restores it. Do not require ADLC tickets,
ticket sync, gate evidence, rail freezes, or phase ceremonies for this refactor. The existing
`.adlc/` files are retained as history and do not govern new work. Use the spec, shared vectors,
witness parity, and the green gates above as the executable contract. Track durable requests in
GitHub issues when useful; coordinate design changes with Myk and Loam's owner.

## Commands

Filled in as each implementation is scaffolded.

- TypeScript: `cd implementations/ts && npm test`
- Rust: `cd implementations/rust && cargo test`
- Parity (every witness, one command): `node tools/check-all.mjs` from the repo root — discovers
  witnesses from `implementations/*/witness.json`; pass names to filter (`node tools/check-all.mjs ts elixir`)
- Elixir: `cd implementations/elixir && mix test`
- Haskell: `cd implementations/haskell && node check.mjs` (needs GHC ≥ 9.4 on PATH; no cabal, no deps)
- CI: `.github/workflows/ci.yml` runs all four witness gates + docs- and vector-freshness checks on
  every push. Any TS source change also requires `npm run docs:build` (the tour + playground
  bundles under `docs/` are committed bytes and CI diffs them) — regenerate and commit alongside.

## Releasing (`@bombadil/rhizomatic` to npm)

Publishing is cutting a tag; CI does the rest. When asked to cut a release:

1. Preconditions: main is green (CI passed on the head commit), tree clean, work already merged —
   the release commit should contain nothing but the version bump. **[CHANGELOG.md](CHANGELOG.md)
   must already carry an entry for the new version** — add it *with the work* (in the feature PR),
   never in the version-bump commit. Call out any breaking change under a `⚠️ Breaking` heading with
   concrete migration steps; consumers (e.g. Loam) read this to know what a jump requires.
2. Pick the bump: `patch` for fixes, `minor` for backward-compatible spec/grammar additions (new
   operators, orders, predicate forms), `major` for anything changing the meaning of existing terms.
3. From `implementations/ts`: `npm run release:patch|minor|major`. That runs the green-gate, bumps,
   commits, tags `rhizomatic-vX.Y.Z`, and pushes. Do NOT use bare `npm version` — its git
   integration silently no-ops in a monorepo subdirectory.
4. The tag triggers `.github/workflows/release.yml`: green-gate → tag==package.json check →
   `npm publish --provenance` via **OIDC trusted publishing**. No npm tokens, secrets, or OTPs
   exist anywhere — the registry trusts this repo's `release.yml` per the package's npmjs.com
   Trusted Publisher setting. Never reintroduce token auth.
5. Verify: watch the run (`gh run watch`), then `npm view @bombadil/rhizomatic versions` must show
   the new version as `latest`.

Remote-session lore (2026-07-30): the Claude Code remote environment's git proxy permits branch
pushes but **403s tag pushes**, so `release:*` lands the version-bump commit on main and then dies
at the tag push. The detour is `.github/workflows/tag-release.yml`: dispatch it with the tag name
and the bump commit's sha (creates the tag from inside Actions), then dispatch `release.yml` with
the same tag — a GITHUB_TOKEN-created tag never triggers tag-push workflows on its own.

Failure lore (2026-07-10): `ENEEDAUTH` in the workflow is almost never about logging in — a 404 on
the `…/oidc/token/exchange/…` request means the npmjs.com Trusted Publisher fields don't match
(filename `release.yml`, org `bombadil-labs`, repo `rhizomatic`, environment blank). Never
`npm install -g npm` inside CI — it half-replaces the running npm tree (missing-sigstore crashes,
silent auth failures); the workflow pins Node 24 for its bundled npm ≥ 11.5.1. A tag that predates
a workflow fix can be re-run with `gh workflow run release.yml -f tag=rhizomatic-vX.Y.Z`, and
re-running an already-published tag is the standard harmless probe: it must fail on the version
conflict only, *after* a 201 token exchange.
