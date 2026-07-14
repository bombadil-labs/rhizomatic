# Rhizomatic Specification — Note 12: Instances, Provenance, and Privacy Tiers (the constellation)

**Status:** Note — records a direction and unifies threads already present across SPEC-1, SPEC-6,
and SPEC-8. Nothing here is normative yet; §7 names the landing sites. The motivating context: a
single Chorus store has accreted into a real personal knowledge graph across several surfaces, and
the next want is a *constellation* — many named stores that specialize and federate (a media log, a
synchronicity log, an aggregator that exposes both), some **private and leak-proof**, some shared
with friends by intention — while nothing accumulated so far is lost. This note situates that vision
inside the existing algebra. It is the companion to [Note 11](11-federation-as-query.NOTE.md)
(federation as query): Note 11 says *what flows*; this note says *between whom, under what name, and
at what exposure*.

---

## 1. The claim

**A "store," in the product sense the user means, is a federating instance (SPEC-6 §2): a keypair, a
delta log, and a set of published/subscribed queries.** Everything asked for — specialized stores,
a private store that never leaves the machine, an aggregator that ingests several and serves them
over one query surface, friends running their own — is *instances composed by queries*. There is no
new mechanism to invent for the topology; the mechanisms are SPEC-6 (peers, lenses, admission) and
Note 11 (publish/subscribe as symmetric queries, privacy as closure).

What a *constellation* of instances additionally needs — and what this note pins — is three answers
the single-store world never had to give:

1. **Identity & provenance.** What identity does an instance carry, and how is "which store made or
   holds this delta" recorded *without* touching the delta's content-addressed identity (§2)?
2. **Namespacing.** How does an entity name like `person:myk` stay stable and collision-safe when
   two independently-authored instances mint the same string for different referents (§3)?
3. **Privacy tiers.** How does exposure stratify from "never leaves, and safe even if the file
   leaks" through "shared exactly by a published query" to "shared but erasable" (§4)?

## 2. Instances have identity; deltas do not carry it

A peer is identified by a keypair (SPEC-6 §3, `PeerId` = public key). An **instance** (equivalently,
a "store" in Chorus's product vocabulary) is that keypair plus a backing log plus its lenses.

The hard constraint is SPEC-8 §2.1 (invariant 1): **a delta's identity is the hash of its canonical
hydrated bytes, and nothing else.** The same delta created in store A and store B is *the same
delta* — same id, same bytes, deduplicated on union. If store-origin entered a delta's identity, two
copies of one fact would disagree about their own id and the CRDT element type would fracture. So:

> **Instance-origin is provenance *about* a delta, never a field *of* it.**

This is exactly SPEC-6 §3's sanctioned pattern — "relay provenance MAY be recorded as annotation
deltas authored by the receiving instance's key" — generalized from relay to origin. Two honest
recordings, used together:

- **A backend column** (local truth): the persistence tier notes which instance first durably held
  each id. Cheap, private, never federates, answers "where did I get this."
- **An annotation delta** authored by the instance key (federatable truth): `<instance> asserts
  origin(<deltaId>) = <instanceId>`. Queryable and shareable like any claim, and — being a claim —
  contestable and negatable.

Note the distinction the single-store world blurred: a delta's **author** identifies the *signer*
(a session keypair, the user keypair); the delta's **origin** identifies the *venue* (which
instance). In Chorus these often share a root — a store's authors are children of its master seed
(`deriveSeed(master, "session/…")`) — but seed
derivation is one-way, so an aggregator *cannot infer* author→instance cryptographically. An
instance that wants its authorship attributable across a boundary must **declare its authors** (an
ordinary identity claim: "these public keys are mine"), or the receiver records relay provenance on
receipt. Both are just deltas. No registry, no global table.

## 3. Namespacing: local ids, type-as-claim, converge by `sameAs`, disambiguate at the boundary

The repo has a deliberate, load-bearing position (SPEC-6 §1; Chorus discovery): **no naming
authority. Ids are cheap and local; convergence is asserted, not assigned (a signed `sameAs`
judgment, negatable and policy-ranked); a registrar is just an author whose naming claims you rank
highly.** This note keeps that position intact. The brittleness the user senses in `person:myk` is
real, but it is **collision on federation**, not fragility at home: `person:myk` here and
`person:myk` in a friend's store are *distinct referents that happen to share a string*. Three
additive moves address it without a registry:

- **(a) Type as a declared belief, not only an id-prefix.** Today "entity type" is the `person:` /
  `proj:` / `concept:` prefix convention, which the Chorus gql layer reflects over — and an inbox
  note from a dogfooding session already
  flagged that this is inference, not assertion. Make type an ordinary claim (a `rhizomatic.type`
  convention, or app-level `chorus`), so an entity's kind is stated and contestable; keep the prefix
  as a human shorthand. This also sharpens reflection: the schema reads the claim, not a substring.
- **(b) Optional key-scoped minting for ids that must be globally distinct.** When an author knows an
  id will federate, it MAY mint a qualified id derived from its own key (a namespace prefix, or a
  content-addressed id) so two instances cannot collide by accident. This is opt-in: local scratch
  ids stay short and free; only ids destined to travel pay for distinctness.
- **(c) Non-merge across a trust boundary by default.** Within one instance, string-equal ids are
  the same entity (convenient, unchanged). **Across a federation boundary, string equality does NOT
  imply co-reference** — a `person:myk` received from a peer stays a distinct node until a signed
  `sameAs` says otherwise. Silence diverges safely; merging is a deliberate, revocable judgment.
  This is the `sameAs` machinery Chorus already has (`discovery.ts`: union-find over surviving
  claims), applied at the boundary rather than assumed away.

The net: names stay local and coordination-free; cross-instance identity is a first-class,
auditable, reversible claim; accidental collision cannot silently merge two people.

## 4. Privacy as tiers — from leak-proof-private to shared-by-query

Exposure stratifies into three tiers that **compose** (one instance can be private wholesale, publish
one query to one friend, and hold selectively-shared blobs):

- **Tier 0 — Private / leak-safe.** An instance that publishes no query never federates — Note 11's
  default-deny gives this for free (nothing pulls its deltas into scope). Add **encryption at rest**,
  keyed from the owner's master seed: leak the file and an attacker gets ciphertext. Because a
  private instance never selectively decrypts *for anyone*, **whole-backend encryption suffices** —
  no per-delta crypto, no key management beyond the seed the owner already holds. This is the
  "cannot be compromised even if it leaks" guarantee, and it is cheap precisely because privacy and
  confidentiality are both wholesale. (SPEC-8 §8 flags whole-pack/whole-backend encryption at rest
  as open; this is its first concrete consumer.)
- **Tier 1 — Federated by published query.** The Note 11 model: a delta leaves to peer P iff it lies
  in the relevance closure of some query published to P. The safety-critical artifact is the
  **closure audit view** — "show me every delta this published query exposes, now and as my store
  grows" — computable because SPEC-3 §3 bounds expansion depth. Build it *with* publish, never after:
  it is the surface on which "what gets shared with whom" is reviewed. Honest caveat, stated in the
  protocol and not hidden: **publish is irrevocable** — grow-only means a synced peer already holds
  the closure (SPEC-6 §7). "Publish this query" means "I accept having irrevocably shared this much."
- **Tier 2 — Sensitive-payload indirection (deferred).** SPEC-6 §7 / SPEC-8 §7: sensitive primitives
  live as encrypted blobs referenced by hash; the deltas (structure, provenance) federate while the
  content stays opaque; selective sharing = encrypt the blob to a recipient's key; erasure = key
  destruction. This is the *only* tier that needs per-item cryptography, and it is the right place to
  spend that complexity — later, behind a vocabulary and vectors, never as an overpromise.

## 5. What the constellation then is

With §2–§4 in place, the user's whole picture is one primitive at two scales:

- **On one machine:** specialized instances (a media log, a synchronicity log) each publish a broad
  lens to a **local aggregator** instance, which subscribes, holds the union, and serves it via
  gql-on-demand over MCP (Chorus's `gql.ts` is already that read surface). "Spin up
  different stores that federate and specialize" = localhost peers syncing over the transport that
  already exists ([http.ts](../implementations/ts/src/http.ts), or in-process `Peer.pullFrom`).
- **Across machines:** friends clone the repo, run their own instances, and federate by publishing
  queries to one another — *coordination without conscription* (SPEC-6 §1), trust as editable policy
  (SPEC-6 §3), privacy as the closure of what each chooses to publish. The collective rhizome is not
  a shared database; it is sovereign instances exchanging exactly the closures they intend.

## 6. What this is NOT

- **Not a global namespace or DNS.** SPEC-6 §1 refuses a naming authority; §3(a–c) add convention
  and boundary discipline, not a registry.
- **Not store-origin in a delta's identity.** SPEC-8 §2.1 forbids it; origin is provenance beside
  the delta, never inside it (§2).
- **Not an erasure promise beyond key-destruction.** SPEC-6 §7 stays honest: Tier-1 publish is
  irrevocable; only Tier-2 blob+key-destruction approaches forgetting, and it remains unproven.
- **Not a new transport or query language.** SPEC-6 abstract messages + SPEC-2 terms as lenses +
  Chorus's gql skin. This note adds identity, naming discipline, and encryption-at-rest — nothing
  below the read boundary changes.

## 7. Landing sites

- **SPEC-6 §3** — instance identity as `PeerId`; delta origin recorded as annotation/relay
  provenance authored by the instance key, never in content identity; the "an instance declares its
  own authors" convention for cross-boundary attribution.
- **SPEC-6 §1 / §9** — string-equal entity ids across instances are distinct referents absent a
  signed `sameAs`; non-merge across a trust boundary as the default; lens-negotiation intersection
  (already open) is the publish/subscribe join.
- **SPEC-8 §8** — whole-backend (whole-pack) encryption at rest, keyed per owner, as Tier 0; its
  interaction with dictionaries (vocabulary-stat leakage) noted there stays the open sub-question.
- **SPEC-1 §7-adjacent + SPEC-3** — a `rhizomatic.type` declared-type convention; type reflection
  reads the claim, with the id-prefix kept as shorthand.
- **[Note 11](11-federation-as-query.NOTE.md)** — the closure audit view as the publish-time privacy
  surface, and the irrevocability statement, are shared with this note; build them once, together.
- **Chorus** (now a separate loam app) — the proving ground, ahead of any normative vectors, per
  the working agreement.

A vectorable conformance statement (what an instance MUST expose about its identity and origin, how
cross-instance `sameAs` composes, and what "leak-safe at rest" must guarantee) waits until the
Chorus prototype has shown the shape. Pin the model on paper as it firms up; do not vector a guess.
