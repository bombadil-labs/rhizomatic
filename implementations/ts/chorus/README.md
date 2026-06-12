# Chorus

Memory for agents, built on [Rhizomatic](../../../README.md). Every belief is a signed claim;
an agent is a keypair, a reactor, and a policy. This package is the product layer: the agent
handle, trust dynamics, the librarian, the demo, and the MCP server.

```
npm run chorus:demo     # the whole thesis, one deterministic receipt-printing story
npm run chorus:mcp      # the MCP server over stdio
```

## The identity model

One MCP server process = **one session = one author**. Session keypairs derive from a single
master seed (`blake3(master + "/session/" + sessionId)`), so the master holder can re-derive
and audit any session's key while nobody else can forge one. The human is **one persistent
author** (`speaker: "user"`) across every session. Only public keys ever touch the substrate.

A session binds itself to its model name with a signed **identity claim** (`begin-session`):
author → `{model, sessionId, startedAt, purpose}`. The binding is data — exactly as
trustworthy as the claims it scopes, auditable like everything else. An author with no
identity claim shows up as `"unknown"` in receipts: visible, never silently trusted.

What this buys, concretely:

- **`explain` answers "who said this, exactly"** — not just a key, but *which model, in which
  session, started when, doing what*.
- **Retroactive distrust works at session granularity**: "that Tuesday session was working
  from a bad premise" is one `trust {distrust: <its author>}` call. Its testimony demotes
  everywhere; its history stays queryable.
- Model-level trust ("prefer fable-5 sessions over haiku sessions") is a policy built by
  expanding identity claims into an author list — judgment over data, planned for the
  briefing slice.

Environment: `CHORUS_MASTER_SEED` (all keys derive from it), `CHORUS_PACK` (store file),
`CHORUS_SESSION_ID` (optional; default minted per process).

## MCP tools

| Tool | What it does |
|---|---|
| `begin-session` | Introduce this session: bind its author to your model + purpose. Call first. |
| `whoami` | This session's author, the user author, session id, declared model. |
| `briefing` | Top-of-mind, computed fresh: preferences, open tasks, recent session summaries, top topics, **contested facts**, standing distrust edits. Call after `begin-session`. |
| `remember` | Assert a belief (`speaker: "user"` to relay the human's own words under their key). |
| `recall` | Resolve an entity to one view under the current trust policy. `aliasedVia` crosses vocabulary dialects; `unified` reads through sameAs equivalences. |
| `topics` | What the store knows about — entities, attributes, claim counts, recency. |
| `search` | Substring search over surviving beliefs (values, attributes, entity ids). |
| `same` | Assert two ids name the same thing — identity as a negatable judgment. |
| `retract` | Append a signed negation. History is never edited. |
| `revise` | Retract + re-assert in one move, linked by a `revises` pointer (for facts that *changed*). |
| `end-session` | Write this session's summary so the next session's briefing starts there. |
| `explain` | Every candidate with receipts: author, session, model, timestamp, negated flag. |
| `trust` | Retroactive distrust of an author (a person, a session, a model's bot). |
| `as-of` | The world as it stood at an instant — claims retracted later are visible again. |

## Wiring it into Claude Code

```bash
claude mcp add chorus \
  --env CHORUS_MASTER_SEED=<64 hex chars, keep private> \
  --env CHORUS_STORE=~/.chorus/memory.jsonl \
  -- npx tsx <repo>/implementations/ts/chorus/mcp-server.ts
```

Concurrent sessions are safe: each server process is its own session author; they share the
append-only `CHORUS_STORE` log and converge by union (the store is a CRDT — the lock only
prevents torn writes).

Then teach the model the protocol — drop this in your `CLAUDE.md`:

```markdown
## Memory (Chorus)
- At conversation start: call chorus `begin-session` {model: <your model id>, purpose: <one line>},
  then `briefing`. Treat preferences as standing instructions; treat openTasks and the last
  session's summary as your starting context. If `contested` is non-empty, flag disagreements
  to the user rather than picking silently.
- As durable facts/preferences/tasks emerge, `remember` them (kind matters). Use
  speaker:"user" when relaying something the user themselves said. Use `revise` when a fact
  changed; `retract` when it was wrong.
- When unsure what something is called, try `topics`/`search` before minting a new entity id;
  if you find a duplicate id for the same thing, assert `same`.
- Before ending: `end-session` {summary: what happened + what's still open}.
```

## MX: parity with native memory, and past it

Native Claude memory = an always-loaded index + free-text files. The Chorus equivalents:

- **Index → `briefing`**: same role as MEMORY.md, but computed, salience-ranked, and honest —
  it includes what the record *disagrees about* (`contested`) instead of silently keeping the
  last edit.
- **Write a file → `remember`/`revise`**: same friction, but every write is signed, kinded,
  and attributable.
- What native memory cannot do at all: **receipts on every read** (`explain`: which model, in
  which session, said this), **time travel** (`as-of`), **retroactive session distrust**
  (standing trust edits rehydrate into every future session's lens), and **append-only
  revision** (`revise` keeps the old fact queryable forever).

## Naming (why there is no DNS here)

Canonical ids for domain objects are a *judgment problem*, not an infrastructure problem.
Chorus's position, inherited from the substrate:

- **Ids are cheap, local, and namespaced by convention** (`person:mike`, `svc:api`,
  `topic:rhizomatic`). Minting requires no coordination.
- **Convergence is asserted, not assigned.** When two sessions mint `person:mike` and
  `user:mbilokonsky` for the same human, the repair is a *sameAs claim* — signed, negatable,
  confidence-scored, exactly like the librarian's vocabulary mappings (SPEC-9). Recall reads
  through the equivalence closure under YOUR trust policy.
- **A registrar is just an author.** A "DNS-like service" in this architecture is a well-known
  keypair whose naming claims you choose to rank highly — naming as policy, not as a central
  service. Two fleets can trust different registrars and still federate; disputes are held in
  superposition like any other disagreement.

(The sameAs closure and discovery tools land in the discovery slice — see PROGRESS.md.)

## Status

Tracked in [PROGRESS.md](../../../PROGRESS.md) ("MX arc"). Landed: identity & session scoping.
Next: shared multi-process store, discovery (topics/search/sameAs), the briefing (MX parity
with native memory, then past it), real-client verification.
