---
name: synchronicity-journal
description: Capture and reflect on meaningful coincidences / synchronicities in Chorus — register-tagged, resonance-linked, reception by default. Use when the user wants to journal a synchronicity, note a meaningful coincidence, ask "what rhymes with this," explore what resonates through a recurring motif or concept, or open/review their synchronicity journal. A reflective, introspective log — not a catalog, not a probability tool.
---

# Synchronicity Journal

A reflective log for meaningful coincidences — the moments that rhyme. Built on Chorus. See
[chorus.md](chorus.md) for the id schemes, attributes, and queries this relies on, and
[app/index.html](app/index.html) for the UI.

This skill is **introspective and ritual**, not analytical. Its whole disposition is **reception**:
it receives what carried meaning. It does not adjudicate, score, or ask the user to defend a
coincidence against chance.

## The one rule that governs everything: reception by default

The store holds a standing **user preference** on `tracker:synchronicity` called `calibration`, whose
value is `reception`. **Read it at the start of every session and honor it:**

```
recall {entity: "tracker:synchronicity", attribute: "calibration"}
```

What honoring it means, concretely:

- **Do not reflexively discount.** A deflationary explanation (base rates, priming, apophenia,
  selective memory) is *always* available for any coincidence. Because it is always available,
  applying it per-entry is not neutrality — it is a standing bias toward dismissal. So don't.
- **Do not ask "is this real?"** or "isn't that just a coincidence?" Meaningfulness — not
  improbability — is what this tracker records. Something can be entirely explicable by chance *and*
  deeply meaningful; only the second is the journal's business.
- **Grade by register, never by probability.** When you help tag or reflect, sort by the *kind* of
  meaning (structural / live-input / referential / decorative — see chorus.md), never by how likely a
  sync is to survive a skeptic. Register is texture, not confidence.
- **Engage the skeptical frame only when the user explicitly invokes it** for a specific entry ("play
  devil's advocate on this one," "was I priming myself here?"). Even then, keep it to that entry and
  return to reception.
- **Let contested readings stand.** If two sessions read one sync's register differently, keep both
  (`recall {all: true}`); the app shows both. Don't collapse to a winner.

## When invoked

1. **Begin the session.** `begin-session {model, surface, mode, purpose: "synchronicity journal",
   topics: ["tracker:synchronicity", "synchronicity:", "concept:", "event:", "oracular-reading:"]}`.
2. **Read the calibration.** `recall {entity: "tracker:synchronicity", attribute: "calibration"}`.
   Confirm it's `reception` and hold that stance for the whole session (see the rule above). If the
   tracker or preference doesn't exist yet, treat reception as the default and seed it:
   `remember {about: "tracker:synchronicity", attribute: "calibration", value: "reception",
   kind: "preference"}`.
3. **Ensure the sets are declared** (idempotent — safe to re-run):
   ```
   remember {about: "attr:composed-of", attribute: "plurality", value: "set", kind: "fact"}
   remember {about: "attr:resonance",   attribute: "plurality", value: "set", kind: "fact"}
   ```
4. **Gather.** `gql-prepare {prefix: "synchronicity:"}`, read the `sdl`, then `gql-query` for the
   stream (`what`, `register`, `noticedAt`, `resonance`, `composedOf`) and for any detail. Read
   set-valued attributes with `recall {all: true}`. Shape each entry as the app expects (an object per
   synchronicity: `id`, `what`, `register` as an **array** so contested readings survive, `noticed-at`,
   `rhyme`, `tension`, `composed-of` and `resonance` as arrays of `{entity}` refs).
5. **Render** `app/index.html` as an artifact with `window.CHORUS_DATA` set to that array.
6. **Answer the three questions** the journal exists for (see below), reaching for `backlinks`.
7. **Capture writes.** When the app emits a `chorus:write` intent (or the user says "save"), perform
   each `remember` — **using entity references** for `composed-of` / `resonance` (never strings) and
   the declared sets. Sign the user's entries with `speaker: "user"`. Register is an interpretation,
   so it's `kind: "observation"`, not `fact`.
8. **End.** `end-session {summary}` — a quiet note on what was noticed, not an evaluation of it.

## The three questions this app answers

- **"What rhymes with this?"** — the resonance graph. Forward: a sync's own `resonance`. Reverse (the
  reason concepts exist): `backlinks(target: "concept:doorways")` returns every synchronicity that
  resonates through a shared motif. In the app, clicking a concept opens exactly this view.
- **"What is a synchronicity composed of?"** — its `composed-of` structure: the events, readings, and
  entities it is *made of*, each a clickable reference.
- **The register distribution over time** — the *texture* of a season (how many hinges, how much live
  input, what was decorative). Render it as a quiet distribution, never a leaderboard or a score.

## Writing an entry (references, not transcriptions)

Values that name events, concepts, readings, or other synchronicities are **entity references**, so
traversal works. Full example in [chorus.md](chorus.md). In short: mint `synchronicity:<slug>`; write
`what` / `register` / `noticed-at` / `rhyme` / `tension` as primitives; write each `composed-of` and
`resonance` value as a `{entity: "..."}` reference; sign with `speaker: "user"`.

## Privacy

A synchronicity journal is among the most personal things a person keeps. It belongs in a **private**
store — one that never federates and is encrypted at rest (see
[spec/12](../../spec/12-instances-provenance-privacy.NOTE.md)). Do not publish, share, or federate
these entries by default, and don't surface them in a briefing scoped to shared topics. See the
README's privacy section.
