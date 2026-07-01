# Chorus skills — ephemeral apps over a sovereign memory

Chorus ([apps/chorus](../apps/chorus)) is domain-agnostic substrate: every belief is a signed,
content-addressed claim; reads resolve under a trust policy; and **GraphQL is synthesized on demand**
from whatever the store happens to hold ([apps/chorus/src/gql.ts](../apps/chorus/src/gql.ts)). That
last property is the unlock: because the query surface reflects the data instead of a fixed schema,
you can wrap a domain in a small **skill** — conventions + a UI + the Chorus wiring — and ship a whole
app without a bespoke backend.

That is what this folder is: a set of **Claude Skills** that turn Chorus into domain apps. Each is
usable two ways — **through Claude** (the skill teaches Claude how to read/write the domain and renders
its UI as an artifact) or **standalone** (the same single-file app pointed at a Chorus HTTP node).

## What's here

- **[chorus-skill-designer/](chorus-skill-designer)** — the meta-skill. It reifies the best practices
  for building a Chorus-consuming app-skill, ships a reusable template, and explains the two-mode
  wiring. Invoke it when you want to design a new one. **Start here.**
- **[media-log/](media-log)** — a media consumption guide: films, shows, books; ratings, cast and
  crew traversal, "what to watch next." Expands the media graph already in the live store.
- **[decision-journal/](decision-journal)** — a decision log built on Chorus's `decide`/`replay`
  power tools: pin what you knew when you chose, review it honestly later, never rewrite history.
- **[synchronicity-journal/](synchronicity-journal)** — a reflective capture log for meaningful
  coincidences: register-tagged, resonance-linked, superposition-friendly. Reception by default.

## Installing a skill

Each skill is a directory; a packaged `.skill` is just a zip of it. Build the zips with:

```
node skills/build-skills.mjs        # writes skills/dist/<name>.skill for every skill
```

Then install a `.skill` through your Claude client's skills UI, or drop the unzipped directory into
your skills path. See each skill's `README.md` for its Chorus wiring and standalone deploy notes.

## The rule these follow

Substrate stays sovereign; skills move fast. Nothing here is normative (no vectors, no two-witness) —
same posture the repo takes toward [apps/chorus](../apps/chorus). A skill never changes how Chorus
resolves truth; it only teaches a domain's vocabulary and paints a UI over the answers.
