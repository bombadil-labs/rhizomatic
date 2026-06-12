# Chorus

Memory for agents, built on [Rhizomatic](../../README.md). Every belief is a signed claim;
an agent is a keypair, a reactor, and a policy. This package is the product layer: the agent
handle, trust dynamics, the librarian, the demo, and the MCP server.

```
npm run chorus:demo     # the whole thesis, one deterministic receipt-printing story
npm run chorus:mcp      # the MCP server over stdio
npm run chorus:console  # the human's web console over the same store (default :4820)
```

## The console

`chorus:console` serves a zero-dependency local UI over `CHORUS_STORE`: the live briefing
(preferences, open tasks, **contested facts**, recent session summaries), a topic browser and
search, and a per-entity inspector — every receipt with its author resolved to _which model,
which session_, retracted claims struck through but present, an **as-of time scrubber** that
re-resolves the entity at any past instant, and a **distrust button** whose edit is signed by
_your_ persistent key and rehydrates into every future session's lens. The console is the
human seat at the table: it reads the same log the sessions write, live.

## The identity model

One MCP server process = **one session = one author**. Session keypairs derive from a single
master seed (`blake3(master + "/session/" + sessionId)`), so the master holder can re-derive
and audit any session's key while nobody else can forge one. The human is **one persistent
author** (`speaker: "user"`) across every session. Only public keys ever touch the substrate.

A session binds itself to its model name with a signed **identity claim** (`begin-session`):
author → `{model, sessionId, startedAt, purpose}`. The binding is data — exactly as
trustworthy as the claims it scopes, auditable like everything else. An author with no
identity claim shows up as `"unknown"` in receipts: visible, never silently trusted.

**Introductions read as intervals.** The model name is testimony about a span of time, never
a property of the keypair — a serving model can change mid-conversation (a safety-refusal
failover, an upgrade) while the process and its keypair continue. Call `begin-session` again
when that happens: each introduction binds from its `startedAt` until the next one, and every
claim attributes to the model in effect _at its own timestamp_. Nothing is relabeled
wholesale, in either direction. `distrustModel` is conservative on purpose: it demotes any
session author that _ever_ introduced as that model, because a failed-over session carries
that model's testimony too.

What this buys, concretely:

- **`explain` answers "who said this, exactly"** — not just a key, but _which model, in which
  session, started when, doing what_.
- **Retroactive distrust works at session granularity**: "that Tuesday session was working
  from a bad premise" is one `trust {distrust: <its author>}` call. Its testimony demotes
  everywhere; its history stays queryable.
- Model-level trust ("prefer fable-5 sessions over haiku sessions") is a policy built by
  expanding identity claims into an author list — judgment over data, planned for the
  briefing slice.

Environment: `CHORUS_MASTER_SEED` (all keys derive from it), `CHORUS_PACK` (store file),
`CHORUS_SESSION_ID` (optional; default minted per process).

## MCP tools

| Tool            | What it does                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `begin-session` | Introduce this session: bind its author to your model + purpose. Call first.                                                                                          |
| `whoami`        | This session's author, the user author, session id, declared model.                                                                                                   |
| `briefing`      | Top-of-mind, computed fresh: preferences, open tasks, recent session summaries, top topics, **contested facts**, standing distrust edits. Call after `begin-session`. |
| `remember`      | Assert a belief (`speaker: "user"` to relay the human's own words under their key). Values may be `{entity}` references — see "Reference, don't transcribe".          |
| `recall`        | Resolve an entity to one view under the current trust policy. `aliasedVia` crosses vocabulary dialects; `unified` reads through sameAs equivalences.                  |
| `topics`        | What the store knows about — entities, attributes, claim counts, recency.                                                                                             |
| `search`        | Substring search over surviving beliefs (values, attributes, entity ids).                                                                                             |
| `same`          | Assert two ids name the same thing — identity as a negatable judgment.                                                                                                |
| `retract`       | Append a signed negation. History is never edited.                                                                                                                    |
| `revise`        | Retract + re-assert in one move, linked by a `revises` pointer (for facts that _changed_).                                                                            |
| `end-session`   | Write this session's summary so the next session's briefing starts there.                                                                                             |
| `explain`       | Every candidate with receipts: author, session, model, timestamp, negated flag.                                                                                       |
| `trust`         | Retroactive distrust of an author (a person, a session, a model's bot).                                                                                               |
| `as-of`         | The world as it stood at an instant — claims retracted later are visible again.                                                                                       |

## Reference, don't transcribe

A belief's value should be an **entity reference** whenever it names something the store
could hold beliefs about. The string `"event:eclipse"` is a spelling; `{entity:
"event:eclipse"}` is the thing spelled. Relations are composed of their relata, not of the
words for them — a synchronicity is composed of its events, a project of its tasks, a team of
its people. Pass the reference and the edge is typed and bidirectional: the belief files at
the referent too, `explain` marks it (`reference: true`), and `recall` can follow it. Pass
the string and you have transcribed a name into a place where nothing can dereference it.

The test is one question: _could you ever want to `recall` the value itself?_ If yes, it is
an entity — reference it. Strings, numbers, and booleans are for terminal content: prose,
quantities, flags, things with no further inside.

The same instinct scales up to **atomic modeling**: a rich record is small entities related
by references — observation entities carrying their own provenance, relation entities holding
`composed-of` references plus interpretive attributes — never one fat claim with everything
packed into its value. Fat claims cannot disagree at the attribute level, so they silence the
`contested` machinery; atomic claims light it up.

## Wiring it into Claude Code

```bash
claude mcp add chorus \
  --env CHORUS_MASTER_SEED=<64 hex chars, keep private> \
  --env CHORUS_STORE=~/.chorus/memory.jsonl \
  -- npx tsx <repo>/apps/chorus/src/mcp-server.ts
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
  to the user rather than picking silently. If your serving model changes mid-conversation
  (e.g. a refusal failover), call `begin-session` again with the new model — claims attribute
  to the model in effect at their timestamp.
- As durable facts/preferences/tasks emerge, `remember` them (kind matters). Use
  speaker:"user" when relaying something the user themselves said. Use `revise` when a fact
  changed; `retract` when it was wrong.
- Reference, don't transcribe: when a value names a thing (an event, a person, a work — any
  id), pass {entity: "<id>"} so the edge is typed and followable; strings are for terminal
  content only. Model rich records atomically — small entities (with their own provenance)
  related by references, never one fat claim. Fat claims can't disagree, so they starve
  `contested`.
- When unsure what something is called, try `topics`/`search` before minting a new entity id;
  if you find a duplicate id for the same thing, assert `same`.
- Before ending: `end-session` {summary: what happened + what's still open}.
```

## MX: parity with native memory, and past it

Native Claude memory = an always-loaded index + free-text files. The Chorus equivalents:

- **Index → `briefing`**: same role as MEMORY.md, but computed, salience-ranked, and honest —
  it includes what the record _disagrees about_ (`contested`) instead of silently keeping the
  last edit.
- **Write a file → `remember`/`revise`**: same friction, but every write is signed, kinded,
  and attributable.
- What native memory cannot do at all: **receipts on every read** (`explain`: which model, in
  which session, said this), **time travel** (`as-of`), **retroactive session distrust**
  (standing trust edits rehydrate into every future session's lens), and **append-only
  revision** (`revise` keeps the old fact queryable forever).

## Naming (why there is no DNS here)

Canonical ids for domain objects are a _judgment problem_, not an infrastructure problem.
Chorus's position, inherited from the substrate:

- **Ids are cheap, local, and namespaced by convention** (`person:mike`, `svc:api`,
  `topic:rhizomatic`). Minting requires no coordination.
- **Convergence is asserted, not assigned.** When two sessions mint `person:mike` and
  `user:mbilokonsky` for the same human, the repair is a _sameAs claim_ — signed, negatable,
  confidence-scored, exactly like the librarian's vocabulary mappings (SPEC-9). Recall reads
  through the equivalence closure under YOUR trust policy.
- **A registrar is just an author.** A "DNS-like service" in this architecture is a well-known
  keypair whose naming claims you choose to rank highly — naming as policy, not as a central
  service. Two fleets can trust different registrars and still federate; disputes are held in
  superposition like any other disagreement.

(The sameAs closure and discovery tools land in the discovery slice — see PROGRESS.md.)

## Status

Tracked in [PROGRESS.md](../../PROGRESS.md) ("MX arc"). The full MX arc is landed — identity
(interval introductions), the shared store, discovery, the briefing, decide/replay, the
console — and the system has survived first contact with live dogfooding (which produced the
reference-over-string surface, the unbounded contested scan, and mid-session model
rebinding). Open: scoped briefings (per-topic lenses + curator digests), a real embedding
model behind the librarian, log compaction at scale.
