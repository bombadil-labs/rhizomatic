# Media Log

A Chorus app-skill for **media consumption**: a media diary that logs the films, shows, and books you
watch and read, lets you rate them, tracks a watchlist, and suggests what to reach for next — all
stored as signed, content-addressed beliefs in Chorus.

It reuses the entity conventions already in your store (Dune Part One/Two, the novels, cast,
characters, Buffy S6), so a new watch links straight into the graph you already have: click an actor
in a film's detail panel and see everything else they're in.

## Use through Claude

Install the skill (below), then ask Claude something in-domain:

- "Log that I watched Dune Part Two last night, rate it a 9."
- "What should I watch next?"
- "What else has Timothée Chalamet in it?"
- "Show me everything with the theme of prophecy."
- "Add Dune Messiah to my reading list."

The skill introduces a Chorus session, loads your library via GraphQL-on-demand, renders the app as an
artifact, and saves what you add — using entity references (cast and directors are *people*, not
strings) and declared sets, so traversal keeps working.

## The app

`app/index.html` is a self-contained, single-file UI (vanilla HTML/CSS/JS, no build step, themed with
CSS variables, responsive). It gives you:

- a **library** list with status filters (all / want / watching / watched);
- an **"Up next"** panel derived from `status: want`, nudged by the themes you rate highly;
- a **detail panel** with clickable cast, crew, and theme entity references — click one to see its
  backlinks ("more with this person / theme");
- a **rating** control (1–10) and a **status** control (want / watching / watched);
- an **"add to watchlist / log a watch"** form that emits `chorus:write` intents (with entity
  references and declared sets) for Claude to persist.

It is **dual-mode**: Claude-mediated (primary — Claude injects `window.CHORUS_DATA` and performs the
writes) or standalone (point it at a Chorus HTTP node). With neither present it shows seeded sample
data and a "connect to Chorus" notice — it never blank-screens.

## Install

Build the package from the repo root, then install the `.skill` through your Claude client:

```
node skills/build-skills.mjs        # writes skills/dist/media-log.skill
```

## Deploy standalone

`app/index.html` is self-contained. To run it outside Claude against a Chorus HTTP node
([apps/chorus/src/mcp-http.ts](../../apps/chorus/src/mcp-http.ts)), set config before load:

```html
<script>
  window.CHORUS_ENDPOINT = { url: "https://<node>/mcp/<token>", token: "<token>", session: "<id>" };
</script>
```

In this mode the app speaks MCP JSON-RPC directly (`initialize` → `tools/call`) for reads and writes.
Turning free text ("watched Dune, loved it") into structured `remember` calls is the LLM step, and it
is **yours to wire** — hosting and keys are the deployer's to provide. Ship it scaffolded, not turnkey.

## Privacy

Two tiers, deliberately split:

- **Catalog data is federatable.** A film's cast, director, year, and themes are facts about the work,
  the same for everyone — they gain from sharing and can live in a `federated` store.
- **Personal data prefers a private store.** Your `rating`, `status`, `watched-with`, and your
  watch/read `event:` entities are about *you*. Keep them in a **`private` store** — it never
  federates and is encrypted at rest (see
  [spec/12](../../spec/12-instances-provenance-privacy.NOTE.md)).

Don't publish a personal media diary by default. When in doubt, the ratings go private.
