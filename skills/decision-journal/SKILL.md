---
name: decision-journal
description: Record a decision and what you knew when you made it, then replay and review it honestly later — a decision journal in Chorus that never rewrites history. Trigger when the user wants to log a decision they're making, capture the rationale/options/confidence for a choice, ask "what did I know when I decided X?", replay or review a past decision, record how a decision turned out, or see which decisions are due for review. Built on Chorus's decide/replay/as-of power tools.
---

# Decision Journal

A Chorus app-skill for keeping an **honest** decision log. Its thesis: *you cannot rewrite what you
knew; you can only append what you later learned.* Every decision pins the epistemic basis it was made
on (via `decide`), and hindsight — outcomes, reviews — is **appended** as fresh observations, never
edited over the original. See [chorus.md](chorus.md) for the id schemes, attributes, and the exact
decide/replay/as-of flow this relies on, and [app/index.html](app/index.html) for the UI.

## When invoked

1. **Introduce the session.** `begin-session {model, surface, mode, topics: ["decision:"]}`.
2. **Load the decisions.** `gql-prepare {prefix: "decision:"}` then a `gql-query` for the list
   (`id title question chosen confidence decidedAt basis`); or `recall {entity, all: true}` per
   decision — you **must** use `all: true` for the set-valued `options` and for the append-only
   `outcome`/`review-note` logs, which accrue multiple values. Shape the result into the array
   `app/index.html` expects (see its CONFIG / `window.CHORUS_DATA`).
3. **Render** `app/index.html` as an artifact with `window.CHORUS_DATA` set to that array. The app
   shows a decision timeline, a two-column THEN-vs-NOW detail view, and two forms.

## Recording a decision (the "record a decision" form → a `decide` intent)

When the app emits a `chorus:write` with `intent: "decide"` (or the user says "I've decided X"):

1. **Pin the basis first.** `decide {about: "decision:<slug>", intent: "<the question / what I'm choosing>"}`.
   Keep the returned `decisionId`.
2. **Remember the fields** (all `kind: fact` unless noted):
   `title`, `question`, `chosen`, `rationale`, `confidence` (0–1 number), `decided-at` (now, ms epoch),
   and `basis` = the `decisionId` from step 1. For `options`, emit one `remember` **per** option value
   (the attribute is set-valued — declare `attr:options` plurality `set` once if it isn't already).
   Use an **entity reference** (`{entity: "person:…"}`, `{entity: "tool:…"}`) for any `chosen`/`options`
   value that names something the store could hold beliefs about — reference, don't transcribe.
3. Confirm with receipts and re-render.

## Reviewing a decision (the detail view's THEN vs NOW → `replay`)

When the user asks "what did I know when I decided X?" or opens a decision to review:

1. `replay {decisionId}` using the decision's stored `basis` → this is the **THEN** column: the exact
   belief set and policy the decision resolved, re-verified, with anything **retracted SINCE** flagged.
2. A live `recall`/`gql` read of the same referents → the **NOW** column. Present the diff plainly:
   *"what I know now that I didn't then."* Use `as-of {entity, at: <decided-at>}` when you only need one
   entity's past state rather than the whole basis.
3. Never silently reconcile the two. The gap between then and now is the product.

## Logging an outcome (the "log an outcome" form → an APPEND, never a revise)

When the app emits a `chorus:write` with `intent: "append"` (or the user says how a decision turned out):

- `remember {about: "decision:<slug>", attribute: "outcome", value: "<what happened>", kind: "observation"}`
- and/or `remember {about: "decision:<slug>", attribute: "review-note", value: "<what I know now>", kind: "observation"}`

**Do NOT `revise` the original decision.** Outcomes and reviews accrue as a log. The `rationale`,
`confidence`, and `chosen` recorded at decision time stay frozen — that is the only way the track record
stays honest. `revise` is reserved solely for fixing a mis-*recorded* fact (a typo, a wrong timestamp),
not a changed mind; a changed mind is an appended `review-note`.

## Answering the three questions

- **"What did I know when I decided X?"** → `replay {decisionId}` (+ `as-of` for single entities).
- **"How did my past decisions turn out?"** → read `confidence` (then) against the appended `outcome`
  (now); surface over/under-confidence honestly. Don't hide a bad call.
- **"Which decisions are due for review?"** → decisions whose `decided-at` is older than a threshold and
  which have no `outcome`/`review-note` yet.

## Persist & summarize

Confirm each write with receipts (`explain` if the user wants provenance). Let disagreement and
appended contradictions stand — show them, don't collapse them. `end-session {summary}` on exit.

## Privacy

Decisions are frequently sensitive (hiring, money, relationships, strategy). Recommend a **`private`**
store — one that never federates and is encrypted at rest. Do not publish a decision journal by default.
See [README.md](README.md).
