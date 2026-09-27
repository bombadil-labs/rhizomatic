# SPEC-6 vNext proposal: peers, admission, and arrival

**Status:** Proposed contract for plan step 6. Shared vectors and witness parity are required
before this becomes normative. Plan step 7 adds publish/subscribe contracts and signed protocol
messages.

## 1. Peer boundary

A peer has a governing key, an admitted delta set, an admission policy, a sharing policy, and an
erasure posture. Its delta set may be backed by its own storage or by a view over a host's storage.
A shared backend does not collapse two peers into one: each peer keeps its own admission
decisions, arrival records, governing key, sharing policy, refusal set, and erasure reports. A
container hosted inside another peer is still a peer. Since `PeerId` is the peer's public key,
two logical peers MUST have different governing keys; reusing one key identifies one peer, not
two. When one peer erases an id, a shared backend MUST preserve bytes still held by another peer.
An erasing peer may report that it released its own holding, but it MUST NOT report physical byte
removal until removal is confirmed on its declared storage surfaces. A host-level report may say
that bytes remain for another tenant, without naming that tenant; a peer MUST NOT reveal another
peer's holdings through its public report. The physical layout and garbage collection are
implementation choices, subject to that reporting distinction.

The same canonical delta has the same id and bytes in every peer. String-equal entity ids refer to
the same entity after union. The peer boundary does not qualify or rewrite entity ids. A peer
decides which claims travel through its sharing policy; a governed read decides which authors'
claims bind through an explicit author selection. Instance-local ids that must remain distinct
need distinct strings at creation.

## 2. Admission

Admission is a local, ordered pipeline over a proposed transfer. The implementation supplies the
guards; federation does not import an application's rules. A candidate-local guard receives the
candidate, sending and receiving peer ids, the receiver's admitted delta set **before** this
transfer, the receiver's arrival time, and explicit application policy state. It accepts or
rejects that candidate. It MUST NOT use another candidate in the transfer as positive authority:
a grant or roster change first affects the next transfer. A same-transfer revocation and erasure
have the explicit effects described below. This prevents provisional evidence from
authorizing a delta that survives after the evidence is rejected. The receiving
peer MAY use a different guard list for a local append and a foreign transfer, but both pass
through verification and the peer's admission boundary.

The pipeline is:

1. Verify canonical bytes, ids, and signatures or signed-manifest coverage for the complete
   proposed transfer. Apply the receiver's permanent refusal set on **every** entry path,
   including local append and foreign transfer, before any caller-selected guard. An id in that
   set cannot re-enter even when its erasure record is negated. Deduplicate ids already **admitted**
   before any guard or quota. An id with an outstanding purge is outside the admitted set: a
   re-offer gets an explicit `purge-pending` outcome, not a silent duplicate, and cannot re-enter
   yet. Preserve each verified bundle's coverage and any self-signed loose copy as separate
   candidate units until bundle selection; coalesce an id only when it lands. Invalid or refused
   candidates cannot serve as evidence for others.
2. Apply the subscribed lens, when present, and its **declared** closure rule. That rule may add
   related candidates from the verified offer (for example, negations or manifest members), but
   never fabricate a delta or bypass **any** candidate-local guard. It states which selected ids
   require which related ids. There is no implicit closure. A host can write a guard that admits
   an otherwise unrostered negation of a pre-transfer id; closure does not silently override its
   roster rule. A closure rule MUST NOT assign a post-commit requirement to an erasure delta or
   an erasure-bearing bundle. The receiver rejects a configuration that does so; it does not
   silently turn an erasure order into a non-erasure candidate. Target-author binding is a
   verification check, not a closure requirement.
3. Apply candidate-local guards in declared order, each against the same pre-transfer admitted
   set. No general transfer quota is charged at this stage; a candidate rejected later cannot
   consume ordinary capacity. A receiver that limits erasure orders uses an explicit erasure
   guard before step 4, so a quota cannot withdraw an order after its exclusion took effect.
4. Compute a **proposed** final set without changing holdings. Apply any declared, deterministic
   candidate-set conflict rule to candidates that passed steps 1–3, using the pre-transfer
   admitted set. Next form **provisional erasure orders**: candidates that passed every prior
   gate, whose signature and target binding verify, and which the receiver's erasure policy
   authorizes from the pre-transfer admitted set. A candidate may inspect a verified co-offered
   target's claims to check its author, but cannot borrow authority from that target. A bundle
   containing both an erasure and its target is rejected based on its verified member list,
   even if the target was already admitted. An erasure-bearing bundle may contain only its
   manifest and erasure members; mixing ordinary members into an effective erasure unit is
   rejected so they cannot bypass the ordinary quota. An erasure targeting an erasure is invalid.
   A foreign
   erasure is testimony unless the receiving peer's declared policy makes it a provisional local
   order. Before any effect, remove every provisional target from a copy of the pre-transfer
   admitted set and recheck each provisional order's authorization against that reduced set.
   Only orders that pass **both** checks are effective; a failed order is not reconsidered when
   another order fails. This is the default conservative rule: same-transfer erasures cannot
   preserve authority for one another or widen what is purged through batching. A rejected order
   gets an `erasure-ineligible` outcome and reason in the receiver's private report. Only
   effective orders
   exclude and refuse their targets. They may target a separate co-offered candidate: that
   target is refused, the erasure lands, and unrelated candidates remain eligible. If that target
   is a member of another signed bundle, that whole bundle is rejected as
   `bundle-excluded-by-erasure`; its other unsigned members need independent coverage or a later
   re-offer. The erasure does not split the bundle. Erasure authority never comes from a
   co-offered candidate. After fixing these exclusions, prune ordinary candidate
   units whose declared requirements are not met by a surviving candidate or an **admitted,
   non-excluded** pre-transfer id; repeat until stable. Pruning cannot revoke an effective
   erasure, so it only removes candidates.
5. Apply any set-level quota to the post-erasure, post-prune **ordinary** candidates. Effective
   erasure orders are already fixed and cannot be skipped here. The quota MUST use a
   receiver-declared rank independent of wire order. The portable default is ascending delta id,
   with a bundle ranked by manifest id; a receiver MAY use a private, stable rank to make low-id
   grinding ineffective. A unit too large for remaining capacity is skipped, and later units
   are considered. Each selected unit is charged for ids it newly adds after higher-ranked
   selected units; the same id is never charged twice. Prune selected ordinary units whose
   requirements were skipped by quota, repeating until stable. Freed capacity need not be
   refilled, but no id that failed to land is charged.
6. Commit the final additions, logical exclusions, permanent refusals, quota counters, arrival
   records, and **durable pending-purge obligations** in one atomic transaction. If the backend
   cannot commit that logical state together, reject the affected units without changing
   holdings. Physical byte removal and any shared-host reference release follow the commit.
   Until declared storage surfaces prove physical absence, a byte-removal report says `pending`,
   `failed` with the fault, or `shared-held`; a release of this peer's reference is reported
   separately and never called byte removal. A host may disclose `shared-held` to its authorized
   auditor without naming another peer; the peer's public report says only `not removed`. A
   per-peer release can complete while host bytes remain for another peer. The peer's declared
   erasure posture MUST name its re-entry gate: `peer-released` (its reference is verifiably
   absent) or `bytes-removed` (physical absence is proved on declared surfaces). A shared-held id
   cannot pass the latter gate while another peer retains its bytes. Every pending or failed
   obligation remains visible across restart and is retryable through an explicit operation;
   failure never silently counts as completion. The id remains outside serving reads. A lower
   erasure posture may permit re-entry only when its declared gate is complete; a permanent
   refusal never does. A rejected or duplicate id creates no arrival event.
   Quota capacity may remain unused after dependency pruning, but an id that did not land is
   never charged. An internal `purge-pending` outcome reveals that the peer held and erased this
   id; a public endpoint MAY map it to a generic refusal, while preserving the private reason.

A signed bundle is one indivisible candidate unit through every gate: failure of any member
rejects that bundle, not another bundle that covers some of the same ids. Loose self-signed
deltas are independent units even when a third party names them in a bundle. An unsigned delta
can land only through a selected verified bundle that covers it. Each bundle is checked and
ranked independently; if one fails verification, guard, closure, or quota, another covering
bundle remains eligible. When two bundles land with a shared member, that id lands once, has one
arrival event, and costs quota once. No bundle borrows a member from a bundle that failed.
Repeated appearances of one id create at most one arrival event and quota charge. The candidate
set is unordered; every set-level selection uses the declared rank. Separate transfers in
different orders may still produce different admitted sets because their pre-transfer states
differ.

A guard may depend on the receiver's already admitted set. Thus accepting A, changing the roster,
then receiving B can differ from receiving B first. This is a fact about that peer's admission
history. Evaluation over either resulting admitted set remains independent of ingest order.
Under this portable snapshot rule, if a revocation N and an act A by the revoked key arrive in
one transfer, A's candidate-local guard sees the pre-transfer authority and may admit A. N and A
receive distinct arrival sequences, but their shared transfer ordinal says they were admitted under
one authority snapshot. A receiver that wants N to bar A within that transfer can declare a
**candidate-set conflict rule** that rejects A when N is an eligible verified candidate after
steps 1–3, whether or not N later lands. That conservative application choice gives no
provisional N authority; federation
assigns no universal meaning to that application-specific revocation.
The declared closure rule MUST say whether a target requires its eligible negations and what
happens when one is unavailable. A privacy-preserving rule may refuse the target. It MUST NOT
silently add an unoffered delta. Plan step 7 defines the publish-side closure audit and checks
what the peer was actually able to transfer.

An admission decision never edits a delta. The author-signed `timestamp`, `validFrom`, and
`validUntil` remain the author's claims. A receiver MAY enforce a local time-skew guard by comparing
them with its arrival time. There is no universal skew limit. An offered lens selects candidates;
it does not confer authority to bypass admission.

## 3. Arrival testimony

For each newly accepted id, a peer records the receiver-supplied arrival time, a strictly
increasing peer-local arrival sequence that never resets during the peer's lifetime, a
receiver-assigned transfer ordinal that also increases for the peer's lifetime, an admission
epoch identified by that id's arrival sequence, and the sending peer id (or `local` for an
append). The arrival time comes from the receiver's
trusted clock, never from an author-signed field. This is local testimony by the receiver,
outside the delta's canonical bytes and
content id. A relay records its own arrival when it admits a delta; it never copies the upstream
peer's arrival as its own. A duplicate delivery while the id is admitted creates no new arrival.
Local appends also record arrival. All records for one atomic transfer have the same transfer
ordinal and become visible together. Within it, sequence positions follow ascending delta id;
this order is deterministic bookkeeping, not a claim about which author acted first. Authority
decisions for every member use the same pre-transfer state. A consumer deciding whether an act
was admitted before a revocation MUST compare transfer ordinals, not the ids' sequence positions
inside one transfer. An erasure and later re-admission of a revocation starts a new active epoch;
it cannot retroactively change what the peer had admitted at an intervening transfer. This
historical judgement requires the peer's retained admission and exclusion history. A peer that
purges an id's earlier arrival metadata MUST keep a per-id marker that earlier epochs were
purged. If its posture also erases that marker, the peer MUST mark its whole arrival history
incomplete and return `unproven` for all historical authority comparisons. A consumer MUST
treat `unproven` as fail-closed; it cannot guess ordering from currently held ids.

The signed creation time, the claimed validity interval, and the receiver's arrival time are
three independent axes. Validity is evaluated at the caller's explicit read time. A later local
adoption MAY name a foreign delta and choose a local effective time, but receipt never rewrites
the foreign claim's validity interval.

An arrival record can be persisted as private peer metadata or expressed as a receiver-signed
annotation delta. The portable contract is the receiver's observable testimony, not one storage
layout. A shared host MUST keep one arrival history per peer, even when their delta sets view the
same underlying bytes. An erasure removes bytes from one peer's holdings and does not change
another peer's arrival history. Whether the erasing peer retains old arrival metadata is part of
its declared erasure posture (plan step 9). Under permanent refusal, that id never re-enters. If
a lower posture permits re-entry after its declared re-entry gate is complete, the peer
assigns a later lifetime sequence and transfer ordinal. That sequence names the id's new
admission epoch. The peer MUST persist both counters even if it purges earlier arrival metadata.
If the earlier metadata was purged, the new record is described as the first arrival **in that
epoch**, never the first arrival in the peer's lifetime. The marker or whole-history
incompleteness remains after re-entry, so a later consumer cannot infer a false first arrival.

## 4. Conformance cases to freeze

- Two peers view one host storage. Each admits one id at a different time and each reports its own
  arrival. The second peer never inherits the first peer's arrival.
- One peer admits A, changes a roster guard, then receives B; another receives B before A. Their
  admitted sets may differ, while evaluation over either fixed set is order-independent. A and B
  in one transfer see the same pre-transfer roster.
- An earlier guard turns away an otherwise valid erasure T. A later erasure guard cannot use T to
  refuse its target D in that transfer; D and a bystander can land.
- An authorized erasure E targets admitted D but the logical commit fails. D remains admitted and no
  new refusal, purge obligation, or arrival is recorded. A retry can commit the whole logical
  change. With signed loose {D, E, bystander} in one transfer, E lands and refuses D; the
  bystander lands. With E and D in one signed bundle, that bundle is rejected based on its
  verified membership even when D was already admitted. An
  independently signed loose D remains eligible if no other effective erasure refuses it.
- A testimony-only foreign erasure and an unauthorized local erasure co-offered with D have no
  exclusion effect; D and a bystander can land. An effective erasure E of held N makes N
  unavailable as a post-commit requirement for candidate T; T is pruned, while E and an
  unrelated candidate land. E1, authorized by the pinned root, erases grant G, which is E2's sole authority: both are
  provisionally eligible, but the reduced-snapshot recheck rejects E2. Sending E1 first in a
  separate transfer also rejects E2. A closure configuration that assigns post-commit
  requirements to erasures is rejected at setup.
- A committed erasure with an unfinished purge keeps its id outside the admitted and serving
  sets after restart. A re-offer gets `purge-pending`, not silent dedup, and cannot race the
  purge. The report stays `pending` or `failed` with a durable fault until declared surfaces
  prove removal; a failed purge can be retried. Release of a shared-host reference is reported
  separately from physical removal. `peer-released` and `bytes-removed` re-entry gates give
  different outcomes while another peer retains the bytes.
- An id permanently refused after erasure is rejected by both local append and foreign transfer,
  even when the erasure record has been negated.
- A candidate grant G and an act A arrive together. A guard checking A's authority uses the
  pre-transfer set, so A cannot borrow authority from G if G is later rejected.
- A live grant D, its revocation N, and an act A under D arrive in one transfer. The portable
  snapshot profile admits A under pre-transfer authority and records N and A in one transfer with
  separate sequences; a declared candidate-set conflict rule may reject A when N is eligible after
  the ordinary verification and guard steps.
- A quota receives the same candidates in two wire orders. It selects the same ids by canonical
  rank and charges only the ids that finally land. A bundle too large for remaining quota is
  skipped while a later fitting loose candidate may land. A low-ranked bundle containing an
  erasure and its target is rejected **before** quota and cannot consume capacity that would
  admit a fitting honest bundle.
- A foreign delta with a future `validFrom` is admitted at T and remains invisible to validity
  reads until its signed start. Arrival testimony says T throughout.
- A duplicate delivery does not change first arrival or charge quota; a rejected delta has no
  arrival. A local append has an arrival record. Two accepted ids in one transfer have equal
  arrival time and distinct sequences in ascending id order.
- A signed manifest and unsigned covered members are admitted atomically, with no partial arrival
  records on rejection. A member with its own signature can still land loose when a third-party
  bundle naming it fails. Two verified bundles covering the same unsigned member are considered
  independently; a failing or oversized attacker bundle cannot veto a fitting honest bundle.
  When both land, the shared id creates one arrival record and one quota charge.
- A loose effective erasure E targets D in a separate bundle {D, unsigned M}. E lands, that
  bundle is rejected without splitting it, and M needs another valid cover or a later bundle.
  The private report names `bundle-excluded-by-erasure`; an unrelated loose bystander lands.
- A lower-posture peer erases and fully purges an id, then re-admits it. The new arrival sequence
  is greater than every earlier sequence, even when old arrival metadata was purged; it is a new
  admission epoch for that id, not an earlier event in the peer's history. A persisted purged-epoch
  marker forces `unproven` for a comparison needing the erased testimony; if the marker itself was
  erased, whole-history incompleteness forces the same result.
- An act A and revocation N in one transfer share an ordinal, so no within-transfer arrival
  order is asserted. If N is erased and later re-admitted, an act admitted between those events
  is judged from the retained transfer history; when that history was erased, the answer is
  `unproven`.
- Two logical peers viewing one backend have different governing keys and refusal sets. Erasing
  D from one peer does not remove the other peer's held D or rewrite its arrival testimony.
- Two stores' `person:myk` deltas merge by entity string. A governed read with one governing key
  selects only that key's declarations on a shared rules anchor.

The publish contract, closure audit, set digest, and signed wire envelope are plan step 7. The
current HTTP binding is a v0 helper and does not yet satisfy SPEC-6 §4's signed-message rule.
