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
  ts/                  TypeScript implementation (@bombadil/rhizomatic).
  rust/                Rust implementation.
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

## ADLC — issues become tickets

This repo runs the **Agentic Development Lifecycle**. A GitHub issue is a proposal; the
executable contract is a **ticket** in `.adlc/tickets.json`, two-way synced with its issue.
We are migrating from the bespoke workflow above to ADLC — when a convention here conflicts
with an ADLC convention, defer to ADLC.

- **Committed vs runtime.** Per ADLC's own `init` convention, only `.adlc/tickets.json` and
  `.adlc/specs/` are committed contracts. Everything else in `.adlc/` — including
  `config.json` and the `ticket-sync.state.json` sidecar — is a **gitignored runtime
  artifact** (the `.gitignore` already encodes this: `.adlc/*` + `!.adlc/tickets.json` +
  `!.adlc/specs/`). Recreate `config.json` via `/adlc:adlc-init` or by hand
  (provider/repo/label-selector; no secrets — network auth is `gh`).
- **Convert an existing issue → ticket** (the native, issue-first path):
  1. Label the issue `adlc` — the `config.json` selector matches that label.
  2. `adlc-ticket-sync pull --write` — imports it as ticket `gh:<owner>/<repo>#<n>`; the
     issue prose becomes the ticket `body` and stays **remote-authoritative** (never
     enrich `body` locally — the next pull overwrites it).
  3. Add the execution fields to that ticket in `tickets.json` — `scope`, `rails`,
     `edges`, `duration`, `category`, `budget`. These become the ADLC "block."
  4. `adlc-ticket-sync push --write` — writes the block into the issue body (between
     `<!-- adlc:begin -->` sentinels; prose preserved verbatim) and renders one
     marker-anchored `<!-- adlc:status -->` comment. Routine syncs leave `tickets.json`
     byte-identical (bookkeeping is in the gitignored sidecar), so they never trip rails-guard.
  5. `adlc coldstart '<ticket-id>' --prompt-only` — the executability gate. In Claude Code
     you ARE the model: answer the printed rubric and flag only gaps a fresh agent could
     **not** derive from the repo (the repo-wide definition of done in this file counts as
     derivable). Empty gaps = executable.
- **Keep the issue a live mirror of the work — the ticket → issue lifecycle.** Beyond the
  gate-driven `<!-- adlc:status -->` comment, post these four human-readable milestones on the
  issue as the work moves, so the tracker always shows exactly where it is:
  1. **Ingested / started** — when you begin building a ticket, comment that it is in progress:
     `gh issue comment <n> -b "🔨 In progress — building this ticket."`
  2. **PR opened** — comment the PR link: `gh issue comment <n> -b "PR: <pr-url>"`.
  3. **Merged** — comment that it is done **pending a release** (merged ≠ shipped):
     `gh issue comment <n> -b "Merged to main; ships in the next release."`
  4. **Released** — **close** the issue with the release link:
     `gh issue close <n> -c "Shipped in @bombadil/rhizomatic@<x.y.z> — <tag/release url>."`
  **Do NOT put `Closes #<n>` (or `Fixes`/`Resolves`) in the PR body** — GitHub would auto-close
  the issue at *merge*, collapsing stages 3 and 4. Reference the issue plainly (`Addresses #<n>`
  / `gh:...#<n>`) so merge and release stay distinct states, and close explicitly at step 4.
- **Never `push` a local-only `T<n>` ticket at an issue that already exists** — push
  *creates* a fresh issue for local tickets and would duplicate it. Always `pull` the
  existing issue first; its id becomes `gh:...#<n>`.
- **Don't hand-edit `tickets.json` formatting** — it is machine-written (2-space
  `JSON.stringify`); reformatting reds CI once any ticket declares `rails`.

Tooling lore (2026-07-12, setting this up the first time): `@adlc/ticket-sync@1.3.0` on npm
ships broken — its `files` whitelist omits `scripts/`, so the CLI dies at load with
`ERR_MODULE_NOT_FOUND` for `scripts/gen-schema.mjs`. Fix: copy that one file from the plugin
source (`…/.claude/plugins/marketplaces/adlc/packages/ticket-sync/scripts/gen-schema.mjs`)
into the global install's `scripts/`. Separately, the Windows `adlc-ticket-sync` shim drops
its args — invoke the bin directly: `node <global>/@adlc/ticket-sync/bin/ticket-sync.mjs <sub>`.

## Commands

Filled in as each implementation is scaffolded.

- TypeScript: `cd implementations/ts && npm test`
- Rust: `cd implementations/rust && cargo test`
- Parity (both witnesses, one command): `node tools/check-all.mjs` from the repo root
- ADLC: tickets live in `.adlc/tickets.json` (synced to GitHub issues). Sync with
  `adlc-ticket-sync pull|push --write`, health-check with `adlc-ticket-sync doctor`, and gate
  executability with `adlc coldstart '<id>' --prompt-only`. See the **ADLC** section above.
- CI: `.github/workflows/ci.yml` runs both green-gates + docs- and vector-freshness checks on
  every push. Any TS source change also requires `npm run docs:build` (the tour + playground
  bundles under `docs/` are committed bytes and CI diffs them) — regenerate and commit alongside.

## Releasing (`@bombadil/rhizomatic` to npm)

Publishing is cutting a tag; CI does the rest. When asked to cut a release:

1. Preconditions: main is green (CI passed on the head commit), tree clean, work already merged —
   the release commit should contain nothing but the version bump.
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

Failure lore (2026-07-10): `ENEEDAUTH` in the workflow is almost never about logging in — a 404 on
the `…/oidc/token/exchange/…` request means the npmjs.com Trusted Publisher fields don't match
(filename `release.yml`, org `bombadil-labs`, repo `rhizomatic`, environment blank). Never
`npm install -g npm` inside CI — it half-replaces the running npm tree (missing-sigstore crashes,
silent auth failures); the workflow pins Node 24 for its bundled npm ≥ 11.5.1. A tag that predates
a workflow fix can be re-run with `gh workflow run release.yml -f tag=rhizomatic-vX.Y.Z`, and
re-running an already-published tag is the standard harmless probe: it must fail on the version
conflict only, *after* a 201 token exchange.
