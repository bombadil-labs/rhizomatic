# Synchronicity journal — Chorus conventions

The contract between this skill's app and the store. A synchronicity journal records **meaningful
coincidences** — moments that rhyme. Reuse existing ids (`search`/`topics` first); the user already
keeps this domain in the store under `tracker:synchronicity` and `synchronicity:<slug>`.

## The calibration preference (read this before anything else)

There is a standing **user preference** on `tracker:synchronicity` called `calibration`, whose value
is **reception**:

```
recall {entity: "tracker:synchronicity", attribute: "calibration"}
# → "reception" (kind: preference)
```

Honor it. This tracker records **meaningfulness, not improbability**. A deflationary explanation
(base rates, priming, apophenia) is *always* available for any coincidence, so applying it per-entry
is not neutrality — it is a standing bias toward dismissal. **Default to reception.** Do not
reflexively ask "is this real?" or discount an entry. Only engage the skeptical frame when the user
*explicitly* invokes it for a specific entry. Grade entries by **register** (the kind of meaning),
never by probability of surviving a skeptic.

## Entity ids

- `synchronicity:<slug>` — the primary entity. One noticed coincidence. e.g.
  `synchronicity:the-book-and-the-dream`.
- `tracker:synchronicity` — the tracker entity that holds the `calibration` preference and the
  register vocabulary. Not a synchronicity itself; the standing frame for all of them.
- `event:<slug>` — a thing that happened (a dream, a phone call, a song on the radio). **Referenced,
  not transcribed.**
- `concept:<slug>` — a recurring motif, symbol, or theme (`concept:the-number-11`, `concept:water`,
  `concept:doorways`). The nodes that synchronicities *rhyme through*.
- `oracular-reading:<slug>` — a tarot pull, I Ching cast, bibliomancy hit, etc. that participated in
  the coincidence.
- `person:<slug>`, `work:<slug>`, `book:<slug>` — shared types; co-refer with `same` if a duplicate
  appears.

## Attributes (on `synchronicity:` entities)

| attribute | value | kind | notes |
|---|---|---|---|
| `what` | primitive (prose) | observation | the experience, in the user's own words |
| `register` | primitive (enum) | observation | **the kind of meaning** — see below. Never a confidence score. |
| `noticed-at` | primitive (ISO date/time) | observation | when it was noticed (not necessarily when it "happened") |
| `composed-of` | `{entity: "event:x"}` × many | observation | **SET** — the events/entities the coincidence is *made of*. References, not strings. |
| `resonance` | `{entity: "synchronicity:y"}` or `{entity: "concept:z"}` × many | observation | **SET** — the rhymes: other syncs/concepts this one echoes. |
| `rhyme` | primitive (prose) | observation | *what* rhymes — the shape of the echo, in words |
| `tension` | primitive (prose) | observation | the friction, the part that doesn't resolve, the ambivalence. Superposition welcome. |

`register` is an **interpretation**, so it is filed as `observation` (not `fact`). The four values —
the KIND of meaning, ordered from most load-bearing to least, never a probability:

- **structural** — the coincidence is doing structural work: it reorganized how you see something, it
  is a hinge. Live meaning embedded in the shape of your life.
- **live-input** — it arrived as input you acted on or are acting on; the world spoke and you are
  answering. Active, ongoing.
- **referential** — it points elsewhere: it refers to a motif, a text, a past sync, without (yet)
  reorganizing anything. A citation more than a hinge.
- **decorative** — it delighted, it ornamented the day, it rhymed lightly. Real and worth keeping;
  not (yet) doing structural work.

None of these is "more true" than another. Register is texture, not confidence. An entry can be
contested — two sessions may read the same sync as `structural` and `referential`. **Let both
stand** (`recall {all: true}`); the app shows both. Do not collapse to a winner.

## Set-valued attributes (declare once)

```
remember {about: "attr:composed-of", attribute: "plurality", value: "set", kind: "fact"}
remember {about: "attr:resonance",   attribute: "plurality", value: "set", kind: "fact"}
```

Then read them with `all: true` so multi-author / multi-session accretion isn't misread as a contest:

```
recall {entity: "synchronicity:the-book-and-the-dream", attribute: "composed-of", all: true}
recall {entity: "synchronicity:the-book-and-the-dream", attribute: "resonance",   all: true}
```

## Writing a synchronicity (references, not strings)

Values that name events, concepts, readings, people, or other synchronicities are **entity
references**, so traversal works (backlinks, gql edges):

```
remember {about: "synchronicity:the-book-and-the-dream", attribute: "what",
          value: "Dreamt of a red door; next morning the used bookshop I'd never entered had one.",
          kind: "observation", speaker: "user"}
remember {about: "synchronicity:the-book-and-the-dream", attribute: "register",
          value: "structural", kind: "observation", speaker: "user"}
remember {about: "synchronicity:the-book-and-the-dream", attribute: "composed-of",
          value: {entity: "event:the-red-door-dream"}, kind: "observation", speaker: "user"}
remember {about: "synchronicity:the-book-and-the-dream", attribute: "composed-of",
          value: {entity: "event:the-bookshop-door"}, kind: "observation", speaker: "user"}
remember {about: "synchronicity:the-book-and-the-dream", attribute: "resonance",
          value: {entity: "concept:doorways"}, kind: "observation", speaker: "user"}
remember {about: "synchronicity:the-book-and-the-dream", attribute: "noticed-at",
          value: "2026-07-01", kind: "observation", speaker: "user"}
```

## Key queries the app relies on

The three questions this journal answers:

**1. "What rhymes with this?"** — the resonance graph, forward and reverse. Reverse traversal (`backlinks`)
finds every synchronicity that resonates with a shared concept — the point of a concept node.

```
gql-prepare {prefix: "synchronicity:"}
# forward: a sync's own resonances
query { synchronicitys(limit: 100) { id what register resonance { id } } }
# reverse: every sync (or concept) that points AT a concept, via resonance
query { backlinks(target: "concept:doorways") { source attribute } }
```

**2. "The composed-of structure of a synchronicity."** — what the coincidence is *made of*.

```
query { synchronicity(id: "synchronicity:the-book-and-the-dream") {
          what register rhyme tension
          composedOf { id }          # the events/entities it is composed of
          resonance { id }           # the syncs/concepts it rhymes with
        } }
```

(Field names in the synthesized schema are camelCased from the attribute — `composed-of` → `composedOf`.
Read `sdl` from `gql-prepare` to confirm the exact spelling before querying.)

**3. Register distribution over time.** — the *texture* of a season, not a scoreboard. Group by
`register` and `noticed-at`; render as a quiet distribution, never a leaderboard.

```
query { synchronicitys(limit: 500) { id register noticedAt } }
# aggregate client-side: counts per register per week/month.
```

## Provenance & superposition

Use `explain {entity, attribute}` to show who noticed a sync and in which session. When `register`
(or any attribute) is contested across sessions, surface **both** values with their receipts —
do not last-write-wins. Disagreement about the kind of meaning is itself part of the record.
