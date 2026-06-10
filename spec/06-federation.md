# RhizomeDB Specification — SPEC-6: Federation (L6)

**Status:** Draft
**Layer:** L6 — networking
**Depends on:** SPEC-0 … SPEC-5

---

## 1. Purpose

L6 specifies how independent instances exchange deltas. Because the lower layers did their jobs, this layer is deliberately thin:

- merge is union (SPEC-1 §8) — there is no merge protocol to design, only transport;
- schemas and policies travel as payload (SPEC-3 §5, SPEC-5 §3) — there is no schema-coordination protocol;
- identity is content-derived and authorship is cryptographic (SPEC-1 §4–5) — there is no naming authority;
- received terms are sandboxed by construction (P4) — there is no remote-code-trust problem.

What remains — and what this document specifies — is **selection and trust**: which deltas to offer, which to accept, and what acceptance means. The governing stance is the sich principle: **coordination without conscription**. No instance can issue another instance an order; the protocol traffics exclusively in assertions and lenses (filters/terms). Peers federate as sovereigns or not at all.

## 2. Topology Assumptions

- Instances are peers. Any instance MAY act as relay, archive, index-specialist, or edge client; these are deployment shapes, not protocol roles.
- No global membership, no canonical instance, no consensus (SPEC-0 §8). Hub-shaped deployments are an emergent choice, never a protocol requirement.
- Transport is pluggable (HTTP, WebSocket, gossip, sneakernet — a pack archive (SPEC-8) on a USB stick is a valid federation event). The protocol is defined over abstract messages (§4).

## 3. Federation Identity & Trust

- A peer is identified by a keypair; `PeerId` = public key. Instances sign their protocol messages.
- **Crossing a boundary requires signatures:** a delta offered to a peer MUST carry a valid author `sig` (SPEC-1 §5). Unsigned local deltas stay local or are re-issued signed.
- Trust is two separate, independently-configured judgments:
  1. **Transport trust** — "I accept *delta traffic* from this peer" (admission, §5).
  2. **Claim trust** — "I weight *assertions by this author*" (resolution policy, SPEC-5 §3, `byAuthorRank`).
  A peer can be a trusted relay of untrusted claims (an archive) or an untrusted relay of trusted claims (a mirror you verify). Conflating these two is the classic federation design error; this spec keeps them orthogonal.
- Relay provenance ("which peer handed me this") MAY be recorded as annotation deltas authored by the receiving instance's key (SPEC-1 §6 pattern), making transport history queryable without polluting assertion provenance.

## 4. Protocol (Abstract Messages)

All messages are signed by the sending peer. Sets are identified by **set digests** (root hash of the canonical delta-id Merkle structure, exact construction TBD with vectors).

```
HELLO     { peerId, algVersions, offeredLenses: TermHash[] }
SUMMARY   { lens: TermHash, setDigest, count }
WANT      { lens, have: DigestRange[] }          // set reconciliation request
OFFER     { deltas: Delta[] }                    // batched, each individually verifiable
BUNDLE    { manifest: Delta, members: Delta[],   // a transaction in transit (SPEC-1 §9);
            atomic: bool }                       // members MAY be sig-less if manifest-covered
ANNOUNCE  { lens, deltaIds: Hash[] }             // live notification (subscription mode)
```

- **Lenses** are L2 terms (by hash) defining what subset a peer offers or wants: `select(hasPointer(targetEntity ∈ S))`, `select(match(author, inSet, A))`, time-bounded slices, schema-relevance closures (SPEC-3 §2.1 — "everything needed to evaluate `MovieSchema`"). Sharing granularity is exactly term granularity; selective sharing is just `fork` (SPEC-1 §8) over the wire.
- **Reconciliation:** because the unit is a grow-only set, anti-entropy reduces to set reconciliation over content ids (Merkle-tree diff or rateless set reconciliation; implementations choose, vectors define the digest). Order never matters; partial transfer is always safe; resumption is free. Partitions are non-events: a partition is just a long gap between unions, and convergence on heal is the CRDT guarantee (SPEC-4 §2).
- **Catch-up vs. live:** WANT/OFFER handles history; ANNOUNCE streams new ids for subscribed lenses, with fetch-by-id fallback. A reactor's raw-stream subscription (SPEC-4 §5) is the natural ANNOUNCE source.

## 5. Admission

Acceptance of an OFFERed delta is a local pipeline, normative in order:

1. **Verify** — canonical form, content address, and signature coverage: an own `sig`, or a covering signed manifest in the same BUNDLE (SPEC-1 §5, §9) (MUST).
2. **Lens check** — matches a lens this instance subscribed to from this peer (SHOULD; over-delivery MAY be dropped silently).
3. **Admission policy** — instance-local `Pred` over the delta (author allow/deny lists, timestamp sanity windows, rate/volume quotas per peer and per author). Spam resistance lives here: admission is the only gate, and it is *local* — there is no global spam authority, by design.
4. **Ingest** — hand to the reactor (SPEC-4 §2); from here a federated delta is indistinguishable from a local one.

Rejected deltas are simply not unioned. Rejection MAY be recorded (annotation deltas) for operator visibility; it is never communicated as authority to other peers — each sovereign judges alone.

## 6. Federating Semantics (Schemas, Policies, Vocabularies)

No special machinery — they are deltas (P3) — but two normative behaviors:

- **Relevance-closure lenses SHOULD include semantic dependencies:** a lens built from `MovieSchema`'s closure SHOULD also match the schema-definition deltas of `MovieSchema` and its `refs` DAG, so data arrives interpretable. (A peer can decline; data without lenses is still valid deltas.)
- **Received schema definitions are claims, not installations.** Evaluating with a received schema is a local choice governed by pinned/evolvable reference semantics (SPEC-3 §6) and resolution policy over competing definitions. Registering a received term as a *materialization* additionally passes resource-bound analysis (SPEC-4 §8) — a peer may hand you a lens; only you decide to grind it.
- **Functions ship as blobs, run by consent.** Derived-author functions (SPEC-7) federate as content-addressed artifacts (WASM recommended) referenced by deltas, exactly like any payload. Receiving one transfers bytes; *installing* one is an explicit, local, sandboxed act with declared resource bounds (SPEC-7 §7). This is the two-tier portability rule of P4 at the wire: terms run automatically because the algebra is safe by construction; code runs only by sovereign consent. Claims produced by a federated peer's *running* of a function arrive as that derived author's ordinary signed deltas — you can trust the author's outputs without ever running its code, or run the code yourself and compare.

## 7. Data Lifecycle Across Boundaries (Open, Flagged Honestly)

Append-only + content-addressing + federation makes erasure the hardest problem in the system. Current position, not yet normative:

- **Negation propagates** like any delta and suppresses in conformant evaluation — but it cannot compel a peer to forget, and the spec will not pretend otherwise.
- **Personal-data pattern (proposed):** payload indirection — sensitive primitives stored as encrypted blobs referenced by hash from deltas; erasure = key destruction. Deltas (structure, provenance) survive; content becomes unrecoverable. Needs a normative vocabulary and vectors before any compliance claim is made.
- **Retention lenses:** instances MAY decline to relay or retain deltas older than a horizon (a lens with a timestamp predicate). This bounds *spread*, not existence.
- The spec MUST eventually state plainly what it can and cannot promise under GDPR-class regimes; overpromising here would be a lie embedded in a trust protocol.

## 8. Conformance (Level 3)

Vectors will cover: signed-message round-trips; set reconciliation convergence from arbitrary divergent states (property-tested: random fork pairs MUST converge to union); admission-pipeline ordering; lens fidelity (offered set ≡ `eval(lens, log)`); schema-dependency lens closure; and partition/heal convergence equivalence with single-instance batch evaluation.

## 9. Open Questions (L6)

- Set-digest construction (Merkle layout vs. rateless IBLT-style reconciliation) — pick one for v1 vectors.
- Lens *negotiation*: can peers compose lenses (intersection of my offer and your want) mechanically? Should be `and(...)` of predicates — confirm it stays in the decidable fragment.
- Relay incentive/abuse asymmetries: quotas are local; is a standard vocabulary for publishing per-author reputation deltas worth blessing, or does that recreate a central authority by stealth?
- Transport bindings: bless one HTTP and one WebSocket binding for interop, leave the rest wild.
- Key rotation and author continuity: vocabulary for "key B succeeds key A" assertions, and how resolution policies should treat claims across a rotation.
