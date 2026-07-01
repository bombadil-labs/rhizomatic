# Chorus conventions & tool surface (cheat-sheet for app-skills)

The MCP tools a Chorus node exposes ([apps/chorus/src/mcp-server.ts](../../../apps/chorus/src/mcp-server.ts)),
and the conventions an app-skill relies on. This is reference; the rules-with-rationale are in
[../SKILL.md](../SKILL.md).

## Session

- `begin-session {model, surface?, mode?, purpose?, topics?}` — introduce this session (its writes are
  attributed to it). Declare `topics` (entity ids or `prefix:` families) to scope the briefing.
- `whoami` · `briefing {topics?}` — identity card; the top-of-mind view (preferences, open tasks,
  contested facts, recent sessions) computed through the declared scope.
- `end-session {summary}` — write a session summary the next briefing carries forward.

## Write

- `remember {about, attribute, value, kind?, confidence?, source?, speaker?}` — assert a belief.
  - `about` = the entity id the belief is about (e.g. `"film:dune-part-two"`).
  - `attribute` = the property (e.g. `"rating"`, `"director"`).
  - `value` = a **primitive** (`"2024"`, `9`, `true`) OR an **entity reference** `{entity: "person:x",
    context?}` — use a reference whenever the value names something the store could hold beliefs about.
  - `kind` ∈ `observation | fact | preference | task`. `speaker: "user"` signs as the human.
- `revise {deltaId, value, reason?}` — retract + re-assert in one move (the fact *changed*).
- `recast {deltaId, values[], reason?}` — re-encode without re-deciding (e.g. split a comma-packed
  string into N reference claims); inherits kind/confidence/source.
- `retract {deltaId, reason?}` — append a negation (the claim was *wrong*). History stays.
- `same {a, b, reason?}` — assert two ids co-refer (a negatable judgment; union-find closure).

## Read

- `recall {entity, attribute?, all?, unified?, aliasedVia?}` — resolve an entity to one view under the
  trust policy. `all: true` returns every surviving value (the right read for set-valued attributes).
  `unified: true` merges `sameAs` co-referents.
- `topics {prefix?, limit?}` — entities the store knows about, most-recent first.
- `search {query, limit?}` — case-insensitive substring over values/attributes/ids (survivors only).
- `explain {entity, attribute?}` — receipts: who asserted, which model/session, when, signed, negated.
- `as-of {entity, at, attribute?}` — resolve as it stood at a past instant.

## Query (GraphQL on demand — the app's main read path)

- `gql-prepare {asOf?, prefix?}` → `{prepId, sdl, typeCount, fieldCount, deltaCount}`. Pins a snapshot
  and synthesizes a schema: **types from id-prefixes** (`film:` → `Film`), **reference edges typed by
  their target**, `plurality:set` attributes → **list fields**, every node gets `backlinks` (inbound
  edges, role-discriminated, newest-first). The snapshot is frozen — a long walk never races a write.
- `gql-query {prepId, query, variables?}` → `{data, errors}`. Standard GraphQL over the pinned schema.
- `gql-schema {prepId}` · `gql-list` · `gql-release {prepId}` — inspect / list / retire prepared pins.

Typical app read: `gql-prepare {prefix: "film:"}` → read `sdl` → issue a `gql-query` for the list and
each detail; use root `backlinks(target: "person:zendaya")` for "everything that points at X."

## Entity id conventions

Lowercase-kebab, namespaced by a `type:` prefix — local, cheap, coordination-free:
`person:`, `work:` / `film:` / `book:` / `episode:`, `event:`, `character:`, `concept:`, `tracker:`,
plus your domain's own. Type is currently the prefix by convention (a `*:type` declared claim is the
hardening path). Reuse ids — `search`/`topics` before minting; repair splits with `same`.

## Set-valued attributes

Declare once so multi-author accretion isn't misread as a contest, and read with `all: true`:

```
remember {about: "attr:cast", attribute: "plurality", value: "set", kind: "fact"}
recall   {entity: "film:dune-part-two", attribute: "cast", all: true}
```

## The reflex to unlearn: deflation

For reflective domains, provenance and disagreement are features. Don't collapse contested values to a
single winner in the UI, and don't reflexively "correct." Show the superposition; show the receipts.
