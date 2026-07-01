# Decision Journal

A Chorus app-skill for keeping an **honest** decision log. Its whole point is time-honest hindsight:
every decision pins *what you knew when you made it*, and everything you learn afterward is **appended**,
never edited over the original.

> You cannot rewrite what you knew; you can only append what you later learned.

It leans on three Chorus power tools most catalog apps never touch:

- **`decide`** — at the moment of choosing, it resolves your view *now* and pins one signed record of the
  basis (the instant, the trust policy, the resolved view hash, the arrival prefix). You store the
  returned `decisionId` on the decision as `basis`.
- **`replay {decisionId}`** — re-resolves that pinned instant byte-for-byte: exactly the belief set and
  policy the decision saw, with anything **retracted since** flagged. This is the "what I knew THEN" view.
- **`as-of {entity, at}`** — resolves a single entity as it stood at a past instant.

The app renders each decision with two columns — **what I knew THEN** (the replayed basis) beside
**what I know NOW** (the live view + the frozen rationale/confidence) — plus an append-only hindsight
log of outcomes and review notes.

## What it answers

1. **What did I know when I decided X?** — `replay` the pinned basis.
2. **How did my past decisions turn out?** — the confidence you recorded *then* against the outcomes you
   appended *later*. Over- and under-confidence become visible.
3. **Which decisions are due for review?** — old decisions with no outcome or review note yet.

## Use through Claude

Install the skill (below), then say something in-domain:

- "I've decided to switch our backend to SQLite — log it, I'm about 70% sure."
- "What did I know when I decided to defer federation? Replay it."
- "The SQLite switch shipped — the migration took a day longer than I planned. Log that outcome."
- "Which of my decisions are due for review?"

The skill introduces a Chorus session, loads your journal, renders the app, pins the basis with `decide`
when you record a decision, `replay`s it when you review, and **appends** outcomes as observations —
never rewriting the original.

## Install

Build the package from the repo root, then install the `.skill` through your Claude client:

```
node skills/build-skills.mjs        # writes skills/dist/decision-journal.skill
```

## Deploy standalone

`app/index.html` is self-contained — no build, no framework. It opens directly in a browser and shows
seeded sample data (a THEN-vs-NOW example) so it never blank-screens. To run it against a Chorus HTTP
node ([apps/chorus/src/mcp-http.ts](../../apps/chorus/src/mcp-http.ts)), set before load:

```html
<script>
  window.CHORUS_ENDPOINT = { url: "https://<node>/mcp/<token>", token: "<token>", session: "<id>" };
</script>
```

In standalone mode the page speaks MCP JSON-RPC directly for reads and writes (`decide`, `remember`,
`replay`). Turning free text into structured writes (the LLM step) and the `replay`→THEN-column wiring
are yours to host — the app emits `chorus:write` and `chorus:replay` intents a runtime can act on.
Honest caveat: hosting, keys, and the replay round-trip are the deployer's to wire; this path is
scaffolded and documented, not turnkey.

## Privacy — recommended tier: `private`

**Decisions are frequently sensitive** — hiring, money, strategy, relationships, mistakes you'd rather
own quietly. Keep this journal in a **`private`** store: one that **never federates** and is **encrypted
at rest** (see [spec/12](../../spec/12-instances-provenance-privacy.NOTE.md)). Do **not** publish or
federate a decision journal by default. The append-only ethic keeps your *history* honest; the private
tier keeps it *yours*. If you ever want to share a specific decision's track record, export that one
deliberately — never flip the whole store to federated.
