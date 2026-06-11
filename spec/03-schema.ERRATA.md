# ERRATA & Decisions — SPEC-3 (Schemas & HyperViews)

## S1 — Schema-as-deltas vocabulary (pins SPEC-3 §5's illustrative draft)

SPEC-3 §5 sketches one-entity-per-term-node and says the conformance suite will pin the actual
encoding. v0 pins a **blob form**: one definition delta per schema, carrying the term as the hex of
its canonical CBOR (E12). The spec's own sketch already ships predicate leaves as opaque canonical
blobs; v0 extends that economy to the whole term. (The fully-exploded node-per-entity form remains
open — it buys queryability of term internals at significant vocabulary weight; revisit when a
consumer needs to query *inside* schema bodies.)

```
SchemaDefinitionDelta := a delta whose pointers are
  { role: "rhizomatic.schema.defines", target: EntityRef(schemaEntity, context: "definition") }
  { role: "rhizomatic.schema.name",    target: <string: human name> }
  { role: "rhizomatic.schema.alg",     target: <number: L2 algebra version> }
  { role: "rhizomatic.schema.term",    target: <string: hex of the term's canonical CBOR> }
```

Because schemas are deltas: definitions federate as payload, evolution is append (a newer
definition delta for the same entity), deprecation is negation, and conflict is ordinary
superposition resolved by policy.

## S2 — The bootstrap schema `rhizomatic.SchemaSchema`

The one hand-specified schema (SPEC-3 §5): the HyperSchema for reading schema definitions out of
the rhizome. Its body is the (amended, see S5) canonical idiom —

```
group(byTargetContext, select(hasPointer(targetEntity: $root), mask(drop, input)))
```

— evaluated at a schema entity, yielding `props.definition = [definition deltas]`. Its term hash is
pinned as a constant in `vectors/l1-eval/schema-deltas.json`; every other schema is read using it.
This closes P3's loop with a single axiom.

## S5 — SPEC CONTRADICTION: §2's canonical body does not deliver §2.1's closure

SPEC-3 §2 writes the canonical body as `group(byTargetContext, mask(drop, select(targeting root)))`
— **select before mask**. But a negation delta targets a *delta* (SPEC-1 §7), not the root entity,
so the select excludes every negation before mask runs, and nothing in the schema's view is ever
suppressed. This contradicts §2.1, which promises the relevance closure includes "negations of any
of the above (via mask)". Caught by the conformance suite: a published-then-negated schema
definition kept loading.

**Amendment (adopted here, proposed for SPEC-3):** the canonical idiom is **mask first, then
select** — `group(key, select(p, mask(drop, D)))`. Negations do their suppression over the full
operand set, then relevance filtering applies; the negation deltas themselves (having no
root-targeting pointer) never appear in the grouped view, which is correct. The reactor's
relevance-closure tracking (SPEC-4 §4.2's support sets) must likewise include negations of
supporting deltas — already implied by SPEC-4 §3's negation index.

## S3 — Loading schemas from deltas (eager evolvable resolution)

`loadSchema(deltaSet, schemaEntity)`: evaluate `rhizomatic.SchemaSchema` at the entity, take the
`definition` property's surviving entries, choose the **latest by claimed timestamp (lexById
tiebreak)** — the v0 default-definition policy, explicitly a policy choice — then decode
`rhizomatic.schema.term` (hex → canonical CBOR → term; the decoder re-encodes and compares bytes, so
non-canonical blobs are rejected). The round-trip `deltas → term → canonical CBOR → hash` MUST
reproduce the hash of the directly-encoded term (SPEC-3 §5's normative core). The hash of every
schema actually used is recordable for reproducibility (SPEC-3 §6's pin-recording requirement —
full materialization metadata arrives with the reactor).

## S4 — The `rhizomatic.*` prefix remains a configurable constant

The vocabulary prefix is **`rhizomatic.*`** (decided 2026-06-11) — the full product name,
collision-proof and self-describing; wire cost is negligible since packs intern strings. It
remains one constant per implementation (`VOCAB_PREFIX`), so any future change stays a one-line
edit plus a vector regen. The HTTP path `/rhz/v0/sync` is the transport binding's name (ERRATA-6
F5), not the vocabulary prefix, and is unchanged.
