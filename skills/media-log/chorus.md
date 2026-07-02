# Media Log — Chorus conventions

The contract between this skill's app and the store. **Reuse existing ids** — the user's live store
already holds Dune Part One/Two, the novels, full cast & characters, and Buffy S6. Always
`search`/`topics` before minting; repair an accidental split with `same`, never by editing.

## Entity ids

Lowercase-kebab, namespaced by a `type:` prefix — local, cheap, coordination-free.

- `film:<slug>` / `work:<slug>` — a movie. e.g. `film:dune-part-two`, `work:dune`.
  (`film:` is the concrete release; `work:` the abstract work when they must be distinguished. If a
  duplicate appears, `same {a: "film:...", b: "work:..."}`.)
- `book:<slug>` — a novel. e.g. `book:dune`.
- `episode:<slug>` — a TV episode or season unit. e.g. `episode:buffy-s6e07-once-more-with-feeling`.
- `person:<slug>` — cast & crew. e.g. `person:timothee-chalamet`, `person:denis-villeneuve`.
- `character:<slug>` — a character. e.g. `character:paul-atreides`.
- `concept:<slug>` — a theme. e.g. `concept:prophecy`, `concept:grief`.
- `event:<slug>` — a watch/read event linking a person to a work with a date.
  e.g. `event:myk-bailey-watch-dune`.

## Attributes (on `film:` / `work:` / `book:` / `episode:` entities)

| attribute      | value                          | kind          | notes |
|----------------|--------------------------------|---------------|-------|
| `title`        | primitive (string)             | `fact`        | headline |
| `year`         | primitive (string/number)      | `fact`        | release/publication year |
| `type`         | primitive (`film`/`book`/`tv`) | `fact`        | disambiguates the row |
| `director`     | `{entity: "person:..."}`       | `fact`        | **reference, not string** — enables traversal |
| `written-by`   | `{entity: "person:..."}`       | `fact`        | **reference** — author / screenwriter |
| `cast`         | many `{entity: "person:..."}`  | `fact`        | **set-valued** (below); read with `all: true` |
| `themes`       | many `{entity: "concept:..."}` | `fact`        | **set-valued**; drives watch-next |
| `characters`   | many `{entity: "character:..."}`| `fact`       | **set-valued** (optional) |
| `rating`       | primitive `1`–`10`             | `observation` | the **user's** read; sign `speaker: "user"`; changes → `revise` |
| `status`       | `want` \| `watching` \| `watched` | `observation` | drives "Up next"; transitions → `revise` |
| `watched-with` | many `{entity: "person:..."}`  | `observation` | **set-valued**; companions on a watch |

`rating` and `status` are `observation` (a stance the user takes at a time), not `fact` — the world
doesn't have a rating, the user does, and it moves.

## Watch/read events (`event:` entities)

A watch or read is its own entity so history is first-class and queryable over time:

```
remember {about: "event:myk-bailey-watch-dune", attribute: "actor",   value: {entity: "person:myk-bailey"},   kind: "observation"}
remember {about: "event:myk-bailey-watch-dune", attribute: "work",    value: {entity: "film:dune-part-two"},   kind: "observation"}
remember {about: "event:myk-bailey-watch-dune", attribute: "action",  value: "watched",                        kind: "observation"}
remember {about: "event:myk-bailey-watch-dune", attribute: "date",    value: "2026-06-30",                     kind: "observation"}
```

Because `actor` and `work` are references, `backlinks(target: "film:dune-part-two")` surfaces every
event (and every cast/theme claim) that points at the film — the reverse-traversal read the app uses.

## Set-valued attributes (declare once, before the first set write)

```
remember {about: "attr:cast",         attribute: "plurality", value: "set", kind: "fact"}
remember {about: "attr:themes",       attribute: "plurality", value: "set", kind: "fact"}
remember {about: "attr:characters",   attribute: "plurality", value: "set", kind: "fact"}
remember {about: "attr:watched-with", attribute: "plurality", value: "set", kind: "fact"}
```

Then add members with individual `remember` calls (idempotent union — re-writes are no-ops), and
**read with `all: true`** so multi-author accretion isn't misread as a contest:

```
recall {entity: "film:dune-part-two", attribute: "cast",   all: true}
recall {entity: "film:dune-part-two", attribute: "themes", all: true}
```

## Key queries the app relies on

```
gql-prepare {prefix: "film:"}          # then also {prefix: "book:"} and {prefix: "episode:"}
# per the synthesized schema (types from prefixes, reference edges typed by target,
# plurality:set attrs → list fields, every node gets backlinks):

# 1. Library list + detail
query { films(limit: 100) { id title year type director { id } cast { id } themes { id } rating status } }

# 2. Everything with person X or theme Y (reverse traversal)
query { backlinks(target: "person:timothee-chalamet") { source attribute } }
query { backlinks(target: "concept:prophecy")        { source attribute } }

# 3. Ratings & history over time — read rating observations and event: entities
query { films { id title rating status } }
# events:
gql-prepare {prefix: "event:"}
query { events { id actor { id } work { id } action date } }
```

## The reflex to unlearn: deflation

Ratings and status legitimately disagree across sessions and companions. Read with `all: true`, show
the superposition and the receipts (`explain` — who, which session, when), and let a rating **change**
via `revise` rather than silently last-write-wins. Provenance and disagreement are features here.
