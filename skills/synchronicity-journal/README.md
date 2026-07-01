# Synchronicity Journal

A Chorus app-skill for keeping a reflective log of **meaningful coincidences** — the moments that
rhyme. It is introspective and ritual, not a catalog and not an analytical tool. Its whole posture is
**reception**: it records what carried meaning, graded by the *kind* of meaning it carried, never by
the odds of surviving a skeptic.

Each entry is a `synchronicity:<slug>` with:

- **what** — the experience, in your own words;
- **register** — the *kind* of meaning (structural · live-input · referential · decorative), not a
  confidence score;
- **composed-of** — the events and entities the coincidence is made of (entity references);
- **resonance** — the other synchronicities and concepts it rhymes with (entity references);
- **rhyme** and **tension** — the shape of the echo, and whatever is left unresolved.

Because `composed-of` and `resonance` are real references, motifs become navigable: click a
`concept:` and the journal shows *every* synchronicity that resonates through it (reverse traversal
via `backlinks`).

## Reception, by design

There is a standing preference on `tracker:synchronicity` — `calibration: reception`. A deflationary
explanation (base rates, priming, apophenia) is always available for any coincidence, so applying it
by reflex is a bias toward dismissal, not neutrality. This journal therefore does **not** discount
entries, does not ask "is this real?", and offers no confidence slider or skeptic frame. If you want
to argue with a specific entry, you can invoke that explicitly — otherwise, meaning is received.

## Use through Claude

Install the skill (below), then say something in-domain:

> "Open my synchronicity journal."
> "I want to capture a synchronicity — I dreamt of a red door and then…"
> "What rhymes with the number 11?"
> "What's the composed-of structure of the bookshop sync?"

The skill begins a Chorus session, reads your calibration preference and honors it, loads your
entries, renders the app, and saves what you add — using entity references and declared sets.

## Install

Build the package from the repo root, then install the `.skill` through your Claude client:

```
node skills/build-skills.mjs        # writes skills/dist/synchronicity-journal.skill
```

## Run standalone

`app/index.html` is a single self-contained file (vanilla HTML/CSS/JS, no build). Open it directly
in a browser and it shows sample entries so it never blank-screens. To point it at a live Chorus
HTTP node ([apps/chorus/src/mcp-http.ts](../../apps/chorus/src/mcp-http.ts)), set a config before the
page's scripts load:

```html
<script>
  window.CHORUS_ENDPOINT = { url: "https://<node>/mcp/<token>", token: "<token>", session: "<id>" };
</script>
```

In this mode the page speaks MCP JSON-RPC directly for reads/writes. Turning free prose into
structured writes (the LLM step that Claude performs in-session) is yours to wire — the app already
emits fully-formed `remember` calls from the composer, references and all.

## Privacy — read this

A synchronicity journal is deeply personal — dreams, omens, private meaning-making. Treat it that
way:

- **Keep it in a `private` store.** A private Chorus store **never federates** and is **encrypted at
  rest** (see [spec/12](../../spec/12-instances-provenance-privacy.NOTE.md)). This is the intended
  home for this domain — do not use a `federated` store.
- **Do not publish or share by default.** These entries should not appear in briefings scoped to
  shared topics, and should never be pushed to a peer.
- **Standalone hosting is yours to secure.** If you deploy the standalone app against a node, the URL,
  token, and node are under your control — host it privately and don't commit credentials.

The skill's `SKILL.md` instructs Claude to honor this tier. If in doubt, keep it local and keep it
yours.
