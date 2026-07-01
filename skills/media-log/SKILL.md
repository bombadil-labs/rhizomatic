---
name: media-log
description: Log films, shows, and books watched/read, rate them, track a watchlist, and get watch-next suggestions — a media diary in Chorus. Trigger when the user wants to record a film/show/book they watched or read, rate or review it, mark something to watch next, ask "what should I watch/read next," ask "what else has person X / theme Y," or review their ratings and watch history.
---

# Media Log

A Chorus app-skill for **media consumption** — films, TV, and books, the people who made them,
the characters and themes inside them, and the personal ratings and watch/read events layered on
top. See [chorus.md](chorus.md) for the id schemes, attributes, and queries this relies on, and
[app/index.html](app/index.html) for the UI.

This skill reuses the entity conventions already in the user's live store (Dune Part One/Two, the
novels, cast, characters, Buffy S6). **Do not mint new ids when one exists** — `search`/`topics`
before every write.

## When invoked

1. **Introduce the session.**
   `begin-session {model, surface: "media-log", mode, topics: ["film:", "book:", "episode:", "person:", "concept:"]}`.
2. **Gather** the domain's data. Prefer the GraphQL-on-demand path:
   - `gql-prepare {prefix: "film:"}` → read `sdl` → `gql-query` for the library list and each detail
     (title, year, director, cast, themes, rating, status). Repeat for `book:` and `episode:`.
   - For "everything with person X / theme Y," use the root `backlinks(target: "person:...")` /
     `backlinks(target: "concept:...")` edge on the pinned schema (reverse traversal).
   - Read set-valued attributes (`cast`, `themes`, `watched-with`) with `all: true` — never collapse
     them to a single winner.
   - Shape the result into the array `app/index.html` expects (see its CONFIG / `window.CHORUS_DATA`).
3. **Render** `app/index.html` as an artifact with `window.CHORUS_DATA` set to that array. The app
   gives a filterable library, a detail panel with clickable cast/crew/theme references, a rating
   control, an "Up next" panel derived from `status: want`, and an "add / log a watch" form.
4. **Capture writes.** When the app emits a `chorus:write` intent (or the user says "save"), perform
   each `remember` / `revise` / `same` call. Honor the contract in chorus.md:
   - **Reference, don't transcribe** — `director`, `written-by`, `cast[]`, `themes[]`, `watched-with[]`
     are entity references (`{entity: "person:..."}`), never plain strings.
   - **Sets stay sets** — before a first set write, ensure the `plurality: set` declaration exists;
     add references, don't overwrite.
   - **`rating` and `status` are `kind: observation`** (they are the user's read on a thing, over
     time). Sign the user's ratings with `speaker: "user"`.
   - A watch/read is an `event:` entity linking a `person:` to a work with a date (see chorus.md).
   - Ratings **change** → `revise {deltaId, value}`. A mistaken claim → `retract`. Two ids for one
     work → `same`. Never edit history away.
5. **Persist & summarize.** Confirm what was written with `explain` receipts; `end-session {summary}`
   on exit so the next briefing carries the watchlist forward.

## The domain contract (summary — full version in chorus.md)

- Primary entity types: `film:` / `work:` (movies), `book:`, `episode:`. Shared: `person:`,
  `character:`, `concept:`, and `event:` for watch/read events.
- Key attributes: `title`, `year`, `type` (primitive facts); `director`, `written-by` (person
  references); `cast`, `themes`, `watched-with` (**set-valued** references — declared once); `rating`
  (1–10) and `status` (`want | watching | watched`) as `observation`s.
- The 2–3 questions this app answers:
  1. **"What should I watch/read next?"** — from `status: want`, ranked by themes the user rates highly.
  2. **"Everything with person X or theme Y?"** — reverse traversal via `backlinks(target: "person:...")`.
  3. **Ratings & history over time** — `rating` observations and `event:` watch/read entities.

## Privacy

Two tiers, deliberately split. **Catalog data** (a film's cast, director, year, themes — facts about
the work) is safe to `federate`; it is the same for everyone and gains from sharing. **Personal data**
(the user's `rating`, `status`, `watched-with`, and their watch/read `event:` entities) is about the
user and belongs in a **`private` store** — never federates, encrypted at rest (see
[spec/12](../../spec/12-instances-provenance-privacy.NOTE.md)). Say so; do not publish a personal media
diary by default.
