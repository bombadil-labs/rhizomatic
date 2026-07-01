---
name: chorus-skill-designer
description: Design a Claude Skill that turns Chorus (the sovereign-memory MCP) into a domain app — a bundled UI plus the read/write conventions for one domain (media, journaling, decisions, contacts, …), usable through Claude or deployed standalone. Use when the user wants to build, scaffold, or reify best practices for a Chorus-consuming skill/app, or asks "make a skill for tracking X in Chorus."
---

# Chorus Skill Designer

You are building a **Chorus app-skill**: a Claude Skill that wraps one domain in (a) the vocabulary
and conventions for storing that domain in Chorus, (b) a single-file UI app, and (c) the wiring that
lets it run through Claude or standalone. This skill reifies how to do that well. Read
[reference/chorus-conventions.md](reference/chorus-conventions.md) for the Chorus tool surface, and
copy [template/](template) as your starting scaffold.

## Why this works (the thesis)

Chorus stores every belief as a signed, content-addressed claim and **synthesizes GraphQL on demand**
from whatever the store holds (`gql-prepare` pins a snapshot and reflects a schema; `gql-query` runs
over it). So a domain app needs **no bespoke backend and no fixed schema** — it reflects the data. The
skill's job is only: name the domain's entities and attributes consistently, and paint a UI over the
answers. That is a small, high-leverage surface.

## Anatomy of a Chorus app-skill

Produce exactly this directory (kebab-case name):

```
<skill-name>/
  SKILL.md        Frontmatter (name, description) + instructions telling Claude how to run the domain.
  chorus.md       The domain's Chorus conventions: entity id schemes, attributes, kinds, key queries.
  app/index.html  A self-contained (no build step) single-file UI. Dual-mode (see below).
  README.md       Human-facing: what it is, how to install, how to deploy standalone.
```

Keep it self-contained: no npm install, no framework build. Vanilla HTML/CSS/JS in one file so it
runs as a Claude artifact AND opens directly in a browser.

## The wiring contract (get this right)

**The primary job of a Chorus app-skill is to give Claude an interactive artifact to serve as the
UI.** The bundled `app/index.html` IS the interface; Claude renders it as an artifact and mediates
the store. Standalone deployment is a secondary, optional path — scaffold it, don't over-invest in it
for the initial push.

1. **Claude-mediated (THE mode for now).** Claude is the runtime. On invocation the skill tells
   Claude to: `begin-session`, gather the domain's data via `recall` / `gql-prepare`+`gql-query` /
   `search`, and **render `app/index.html` as an interactive artifact** with the data injected as
   `window.CHORUS_DATA` (a plain JSON snapshot). Writes flow back the other way: the app surfaces an
   *intent* (a form submit → a `chorus:write` event / `window.CHORUS_PENDING`), Claude performs the
   actual `remember` / `revise` / `same` call, then re-renders. No credentials in the page — Claude
   holds the MCP connection. This is where the value is; make it excellent.
2. **Standalone (optional, later).** The same file reads a `window.CHORUS_ENDPOINT` config (an HTTP
   MCP node URL + token, per [apps/chorus/src/mcp-http.ts](../../apps/chorus/src/mcp-http.ts)) and
   speaks MCP JSON-RPC directly. Leave the hook in place and **documented as not-yet-turnkey** (hosting
   + keys are the user's to wire); don't let it complicate the artifact.

The artifact must degrade gracefully: if no `window.CHORUS_DATA` (and no endpoint) is present, show
seeded sample data so it renders fully on its own. **Never blank-screen** — a skill's artifact must
look and feel complete the instant Claude serves it, before any live data arrives.

## Best practices (these are the reified rules — follow them)

- **Search before you mint.** Reuse existing entity ids; call `topics`/`search` first. Two ids for one
  thing is repaired by a `same` claim, never by editing — but avoid the split when you can.
- **Reference, don't transcribe.** A value that *names* something the store could hold beliefs about is
  an **entity reference** (`{entity: "person:zendaya"}`), not a string. Relations are composed of their
  relata, not the words for them — this is what makes traversal (`backlinks`, gql edges) work.
- **Namespace ids by convention**, lowercase-kebab: `person:`, `work:`, `book:`, `event:`, `concept:`,
  plus your domain's own (`film:`, `reading:`, `decision:`, `sync:`). Local and cheap; no registry.
- **Declare set-valued attributes.** If an attribute holds many values (cast, tags, themes), declare it
  once: `remember {about: "attr:<name>", attribute: "plurality", value: "set", kind: "fact"}`, and read
  it with `recall {all: true}`. Otherwise multi-author accretion reads as a false contest.
- **Pick the right `kind`.** `observation` (something happened / was seen), `fact` (world state),
  `preference` (about the user — always global), `task` (open work). If the domain needs a stance the
  enum lacks (an *interpretation*), file `observation` and note it; don't overload `fact`.
- **Let disagreement stand.** Don't last-write-wins in the UI. Surface contested attributes as multiple
  values (`recall {all: true}`); show provenance (`explain`) — who said it, which session, when.
- **Honor the privacy tier.** A journal of private material belongs in a `private` store (never
  federates; encrypted at rest — see [spec/12](../../spec/12-instances-provenance-privacy.NOTE.md)).
  Say so in the skill's README; don't publish a personal domain by default.
- **Idempotent by design.** Writing the same belief twice is a no-op union (content-addressed). Re-runs
  are safe; lean on it.

## Workflow to build one

1. **Scope the domain.** What entities, what attributes, what are the 2–3 questions the app answers
   ("what should I watch next," "what did I know when I decided," "what rhymes with this")?
2. **Write `chorus.md`.** Pin the id schemes and attributes and the exact `gql`/`recall` queries the
   app relies on. This is the contract between the app and the store.
3. **Copy `template/` and customize `app/index.html`.** Keep it one file. Wire the two modes.
4. **Write `SKILL.md`.** Frontmatter `description` must say *when* to trigger (domain nouns + verbs).
   The body tells Claude the session flow: begin-session → gather → render → capture writes → persist.
5. **Write `README.md`.** Install + standalone-deploy notes + the privacy stance.
6. **Package.** `node skills/build-skills.mjs` writes `skills/dist/<name>.skill`.

## Definition of a good app-skill

Triggers on the right domain phrases; renders even with zero live data (sample mode); reads through
`recall`/`gql` and writes through `remember`/`revise` using entity references and declared sets;
surfaces provenance and disagreement instead of hiding them; states its privacy tier; and packages to
a `.skill` that installs clean. When those hold, it is done.
