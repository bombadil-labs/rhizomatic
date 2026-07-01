# <Domain> — Chorus conventions

The contract between this skill's app and the store. Reuse existing ids (`search`/`topics` first).

## Entity ids

- `<type>:<slug>` — the primary entity. e.g. `film:dune-part-two`.
- `person:<slug>`, `concept:<slug>`, … — shared types; co-refer with `same` if a duplicate appears.

## Attributes (on `<type>:` entities)

| attribute | value | kind | notes |
|---|---|---|---|
| `title` | primitive | fact | headline |
| `<ref-attr>` | `{entity: "person:x"}` | fact | **reference, not string** — enables traversal |
| `<set-attr>` | many | fact | **declare set-valued** (below); read with `all: true` |

## Set-valued attributes (declare once)

```
remember {about: "attr:<set-attr>", attribute: "plurality", value: "set", kind: "fact"}
```

## Key queries the app relies on

```
gql-prepare {prefix: "<type>:"}
# then, per the synthesized schema:
query { <type>s(limit: 50) { id title <fields> } }
query { backlinks(target: "person:x") { source attribute } }   # reverse traversal
```
