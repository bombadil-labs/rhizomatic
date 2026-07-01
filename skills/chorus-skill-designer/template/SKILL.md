---
name: TODO-skill-name
description: TODO — one sentence that says WHEN to trigger: the domain nouns and verbs (e.g. "track films/shows/books watched, rate them, and get watch-next suggestions in Chorus"). Trigger phrases matter more than prose.
---

# TODO Skill Title

A Chorus app-skill for <domain>. See [chorus.md](chorus.md) for the id schemes and queries this
relies on, and [app/index.html](app/index.html) for the UI.

## When invoked

1. **Introduce the session.** `begin-session {model, surface, mode, topics: [<domain prefixes>]}`.
2. **Gather** the domain's data — `gql-prepare {prefix: "<type>:"}` then `gql-query`, or `recall` per
   entity. Shape it into the array `app/index.html` expects (see its CONFIG).
3. **Render** `app/index.html` as an artifact with `window.CHORUS_DATA` set to that array.
4. **Capture writes.** When the app emits a `chorus:write` intent (or the user says "save"), perform
   each `remember` / `revise` / `same` call — using entity references and declared sets (chorus.md).
5. **Persist & summarize.** Confirm what was written with receipts; `end-session {summary}` on exit.

## The domain contract

- Primary entity type: `<type>:` — <what an entity is>.
- Key attributes: <list, with which are set-valued and which are entity references>.
- The 2–3 questions this app answers: <…>.

## Privacy

<State the tier. Personal/reflective domains → recommend a `private` store (never federates,
encrypted at rest). Catalog domains → `federated` is fine.>
