# Decision Journal — Chorus conventions

The contract between this skill's app and the store. The whole point of this domain is **honest
hindsight**: a decision pins *what was known when it was made*, and everything learned afterward is
**appended**, never edited over the original. You cannot rewrite what you knew; you can only append
what you later learned.

Reuse existing ids (`search`/`topics` first). Repair accidental splits with `same`, never by editing.

## Entity ids

- `decision:<slug>` — the primary entity. One journal entry = one decision. e.g.
  `decision:hire-backend-eng`, `decision:switch-to-sqlite`.
- `person:<slug>`, `concept:<slug>`, `project:<slug>`, … — shared types referenced from a decision's
  `options`/`chosen` when the thing chosen is itself something the store holds beliefs about
  (a person, a tool, a project). Use a **reference**, not a string, in that case.

## Attributes (on `decision:` entities)

| attribute | value | kind | notes |
|---|---|---|---|
| `title` | primitive | fact | short headline for the timeline |
| `question` | primitive | fact | what was actually being decided |
| `options` | many (string **or** `{entity}`) | fact | **set-valued** — the choices considered; declare plurality (below), read with `all: true` |
| `chosen` | primitive **or** `{entity}` | fact | which option was picked; a reference when it names an entity |
| `rationale` | primitive | fact | why — the reasoning at the time |
| `confidence` | number 0–1 | fact | how sure you were **then** (compare to outcome later) |
| `decided-at` | number (ms epoch) | fact | when the decision was made |
| `outcome` | primitive | **observation** | **appended later** — how it actually turned out. NEVER a `revise` of the decision. |
| `review-note` | primitive | **observation** | **appended later** — reflection: what you know now that you didn't then. Append-only. |

**The append-only ethic (enforce this):** `outcome` and `review-note` are `kind: observation` and are
added with fresh `remember` calls. They accrue as a log. Do **not** `revise` the original decision to
"correct" it, and do **not** overwrite `rationale`/`confidence`/`chosen` after the fact — those record
what was true at decision time and must stay frozen. If the decision itself was mis-recorded (a typo,
wrong `decided-at`), that is the only case for `revise`; a *changed mind* is an appended `review-note`.

## Set-valued attributes (declare once)

```
remember {about: "attr:options", attribute: "plurality", value: "set", kind: "fact"}
recall   {entity: "decision:switch-to-sqlite", attribute: "options", all: true}
```

## The power tools this domain is built on

These three are why a decision journal belongs in Chorus at all — they make the epistemic state at
decision time a first-class, replayable object.

- **`decide {about, intent, attribute?}`** — call this **at the moment of deciding**. It resolves
  `about` *now* and pins one signed record of the basis: the instant, the trust policy, the resolved
  view hash, and the arrival prefix. Returns a `decisionId`. Store that id as an attribute on the
  decision so review can find it:
  `remember {about: "decision:<slug>", attribute: "basis", value: "<decisionId>", kind: "fact"}`.
- **`replay {decisionId}`** — re-resolves that pinned instant: the exact belief set and policy the
  decision saw, re-verified byte-for-byte, with anything **retracted SINCE** marked. This is the
  "what did I know THEN" column. Diff it against a live `recall`/`gql` read to get "what I know NOW."
- **`as-of {entity, at}`** — resolve any entity as it stood at a past ms-epoch instant. A lighter-weight
  companion to `replay` when you only need one entity's past state (e.g. `decided-at`).

## Flow

**Recording a decision** (the app's "record a decision" form emits this intent):
1. `decide {about: "decision:<slug>", intent: "<the question / what I'm choosing>"}` → capture `decisionId`.
2. `remember` the fields: `title`, `question`, each `options` value, `chosen`, `rationale`,
   `confidence`, `decided-at` (now, ms), and `basis` = the `decisionId`.

**Logging an outcome / review** (the app's "log an outcome" form emits this intent — an **append**):
- `remember {about: "decision:<slug>", attribute: "outcome", value: "<what happened>", kind: "observation"}`
- `remember {about: "decision:<slug>", attribute: "review-note", value: "<what I know now>", kind: "observation"}`
- Never `revise` the original. The track record is only honest if the past is immutable.

**Reviewing a decision** (the detail view's THEN vs NOW):
- `replay {decisionId}` using the stored `basis` → the THEN column (with SINCE-retracted claims flagged).
- Live `recall`/`gql` on the same referents → the NOW column. The diff is "what I know now that I didn't then."

## Key queries the app relies on

```
gql-prepare {prefix: "decision:"}
# then, per the synthesized schema:
query { decisions(limit: 100) { id title question chosen confidence decidedAt basis outcome reviewNote } }
# "which decisions are due for review?" → decisions with a decidedAt older than N days and no outcome/review-note
# "how did past decisions turn out?" → join confidence (then) against outcome (appended)
```

For per-entity reads the app falls back to `recall {entity: "decision:<slug>", all: true}` (needed for
the set-valued `options` and for the append-only `outcome`/`review-note` logs, which accrue multiple
values).
