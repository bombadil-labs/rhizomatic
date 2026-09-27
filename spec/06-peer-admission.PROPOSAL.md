# SPEC-6 vNext proposal: peers, admission, and arrival

**Status:** Proposed contract for plan step 6. Shared vectors and witness parity are required
before this becomes normative. Plan step 7 adds publish/subscribe contracts and signed protocol
messages.

## 1. Peer boundary

A peer has a governing key, an admitted delta set, an admission policy, a sharing policy, and an
erasure posture. Its delta set may be backed by its own storage or by a view over a host's storage.
A shared backend does not collapse two peers into one: each peer keeps its own admission
decisions, arrival records, governing key, sharing policy, refusal set, and erasure reports. A
hosted container is a separate peer only when it has its own governing key and all those states.
Since `PeerId` is the peer's public key, two logical peers MUST have different governing keys;
reusing one key identifies one peer, not two. A shared-key container is a surface of that peer
until it is given a distinct key and peer state; it cannot claim separate arrival or erasure
testimony. Assigning a new key alone does not create a working peer: the container remains a
surface of the original peer and MUST NOT serve or report as a separate peer until a durable
state handoff completes. Every refusal in the old peer's set applied to every entry path into
that surface, even for an id the surface never held. The handoff MUST therefore copy the entire
refusal set and every active byte-removal obligation for bytes on that surface into the new
peer's own state before it can admit or serve deltas. The new peer MUST NOT enumerate carried
refusals for ids it never held or reveal their provenance in a public report; an attempted entry
gets only a generic refusal. An immutable, pinned snapshot of the old refusal set with an
exclusive new-peer reference satisfies the copy requirement; a live host view does not.
Carried refusal-event and admission-epoch references retain their source `PeerId` and source
identifier. The new peer uses those qualified references for re-entry acts, exclusions, and
obligations, and starts a distinct local sequence for later admissions and refusal events. An
imported host sequence is not a new-peer arrival claim. Cross-peer sequence numbers MUST NOT be
compared as bare integers; the handoff itself establishes that imported history precedes new
peer-local admissions, and an unproved comparison remains `unproven`.

A handoff establishes one linearization point. The old peer MUST drain every accepted order for
the surface before that point, including orders queued during the handoff; each commits and is
copied, or fails explicitly. New arrivals held behind the cutover barrier are routed to the new
peer's own pipeline or fail with a peer-changed outcome; an old-peer order cannot silently lose
its effect on the surface. Admissions and purge work for the surface are stopped or fenced while
state is copied. The durable new-peer import, worker-ownership transfer, acknowledgement, and
old peer's release of responsibility commit as one effect. The old peer owns the authoritative
handoff record. On separate backends, both peers MUST recover against one durable commit record
and its attempt id; the new peer MUST possess durable proof of that record's committed state
before it serves, even if the old backend later becomes unreachable. A backend unable to make
ownership transfer atomic or provide that shared durable commit proof MUST keep the surface
under the old peer. A purge obligation keeps its stable identity and storage generation through
the transfer. The storage fence MUST reject an old worker after ownership moves. Only the new
peer may resume the obligation. The handoff attempt binds the new `PeerId`, old peer state
version, and copied-state digest; its acknowledgement is one-shot and cannot complete a later
attempt. If any part cannot commit or be fenced, the surface remains under the old peer. It
retains reporting and purge responsibility, and the new peer MUST NOT serve. The new peer starts
its own arrival
history when it admits inherited holdings; it MUST NOT present copied host arrival testimony as
its own. A host MAY offer a combined view or coordinated operations across peers for convenience,
but that composition does not merge their PeerIds, keys, admission decisions, arrival histories,
refusal sets, or erasure obligations and reports. When one peer erases an id, a shared backend
MUST preserve bytes still held by another peer.
An erasing peer may report that it released its own holding, but it MUST NOT report physical byte
removal until removal is confirmed on its declared storage surfaces. A host-level report may say
that bytes remain for another tenant, without naming that tenant; a peer MUST NOT reveal another
peer's holdings through its public report. The physical layout and garbage collection are
implementation choices, subject to that reporting distinction.

A combined operation's effect is exactly the set of member peers whose own admission pipeline
committed it. Its report MUST name each member result or assert a conjunction proved by all
member reports; it cannot say an id was erased across the group while one member rejected or
failed the order. The operation MUST fix its member PeerIds at commit against the current peer
roster version; if a handoff changes that roster before commit, it fails or retries with the new
member set. A combined view is a union of each member's serving read under that member's
audience rules. It MUST NOT read raw shared storage or expose a member's result to an audience
that member would refuse.

The same canonical delta has the same id and bytes in every peer. String-equal entity ids refer to
the same entity after union. The peer boundary does not qualify or rewrite entity ids. A peer
decides which claims travel through its sharing policy; a governed read decides which authors'
claims bind through an explicit author selection. Instance-local ids that must remain distinct
need distinct strings at creation.

For erasure authorization, a peer MAY pin additional governor keys in its own configuration,
including a host operator key. Such a key can authorize orders under that peer's declared policy
without becoming its `PeerId` or sharing its admission state. An order relying on an additional
governor key MUST sign the receiving `PeerId` in its canonical claims. Any order that names a
receiving `PeerId` has erasure effect only at that peer, regardless of its signer or delivery
route. A different receiver may retain it as testimony but MUST NOT classify it as an order,
even if that signer is its own governing key or an additional governor. At a peer that pins an
additional governor, an order by that key with no receiving `PeerId` is testimony only; it cannot
acquire an erasure effect from the pin. A peer's own governing key MAY issue an order without a
receiving `PeerId`; that order can take effect only at the peer identified by that key. A
handoff may copy the resulting peer-local refusal into the new peer's state; this is a transfer
of state, not a new erasure effect of the original order at the new peer. A
**non-governor** order is one authorized by neither the peer's governing key nor a configured
additional governor key; the advance-refusal cap below applies to those orders.

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
   before any guard or quota. A duplicate erasure id gets an outcome saying whether this peer
   holds it as testimony, as an order effective for the current refusal event, or as an order
   effective only for an earlier refusal event or admission epoch; dedup never silently upgrades
   testimony or re-applies an
   old exclusion. A permanent-posture peer reports its refusal for an erased id even while a
   purge is active; `purge-pending` is an internal storage outcome, never a replacement for that refusal.
   An erased id outside the permanent refusal posture is also refused on every entry
   path until step 6's explicit local re-entry act commits, even if its purge obligation is
   terminal or it was never held. While an obligation is **active**, a re-offer gets `purge-pending`;
   after the gate completes but before that act commits, it gets `reentry-required`. Neither is a
   silent duplicate. The gate and terminal transition in step 6 decide when a lower-posture peer
   may re-admit it. Preserve each verified bundle's coverage and any self-signed loose copy as
   separate candidate units until bundle selection; coalesce an id only when it lands. Invalid or refused
   candidates cannot serve as evidence for others. In a bundle covering any unsigned member,
   **every** member's claimed author MUST equal the verified manifest signer. Reject a bundle
   that mixes authors during verification, even when the foreign member was already admitted.
   Its self-signed members remain independently eligible as loose candidates.
2. Apply the subscribed lens, when present, and its **declared** closure rule. That rule may add
   related candidates from the verified offer (for example, negations or manifest members), but
   never fabricate a delta or bypass **any** candidate-local guard. It states which selected ids
   require which related ids. There is no implicit lens closure. Independently of a lens, a
   ordinary target selected for admission requires every co-offered, eligible negation of it to
   land too. Effective erasure orders are exempt: their refusal and durable obligation commit
   whether a co-offered negation of the erasure lands or ordinary quota skips it. Negating the
   erasure can withdraw its standing testimony but cannot undo that peer's refusal event. For an
   ordinary target, if quota or another later gate skips such a negation, the target is pruned rather than admitted
   live. This dependency applies recursively to negations of negations and never overrides an
   earlier rejection of a negation. Here eligible means verified and passed the lens, every
   candidate-local guard, conflict rule, and erasure resolution before ordinary quota. A host can
   write a guard that admits
   an otherwise unrostered negation of a pre-transfer id; closure does not silently override its
   roster rule. A closure rule MUST NOT assign a post-commit requirement to an erasure delta or
   an erasure-bearing bundle. The receiver rejects a configuration that does so; it does not
   silently turn an erasure order into a non-erasure candidate. The target reference and claimed
   author are checked for shape at verification. If the target is held or co-offered, compare its
   actual author too. An absent target cannot supply that comparison: an order whose authority
   depends on **any unverified property of the target**, including its author or tenant, is
   `erasure-ineligible` until the target is available. A policy that authorizes independently of
   those unverified properties, such as a pinned-governor rule, may
   install a refusal for the id in advance. A later offer of that target
   is refused on the receiving peer before candidate guards. The peer checks its author then and
   reports any mismatch as a binding discrepancy; under permanent refusal, that discrepancy does
   not silently remove the refusal. Target-author binding is not a closure requirement.
3. Apply candidate-local guards in declared order, each against the same pre-transfer admitted
   set. No quota is charged at this stage; a candidate rejected later cannot consume capacity.
4. Compute a **proposed** final set without changing holdings. Apply any declared, deterministic
   candidate-set conflict rule to candidates that passed steps 1–3, using the pre-transfer
   admitted set. First classify every erasure remaining after steps 1–3 by the receiver's declared
   policy over its claim as either an order candidate for this peer or testimony only. This
   classification does not depend on the sending route or on whether the candidate currently has
   authority. An order candidate lacking authority is rejected with `erasure-ineligible`; it never
   falls back to testimony. Next form **provisional erasure orders**: order candidates that passed
   every prior gate, whose signature and target reference verify (including author binding when
   the target is available), and which the receiver's erasure policy
   authorizes from the pre-transfer admitted set. A candidate may inspect a verified co-offered
   target's claims to check its author, but cannot borrow authority from that target. A bundle
   containing both an erasure and its target is rejected based on its verified member list,
   even if the target was already admitted. An erasure-bearing bundle may contain only its
   manifest and erasure members; mixing ordinary members into an effective erasure unit is
   rejected so they cannot bypass the ordinary quota. An erasure targeting an erasure is invalid.
   An origin's assertion does not force a local effect.
   Conservatively filter local orders: for each E, remove the targets of
   **other** provisional orders from a copy of the pre-transfer admitted set, but retain E's own
   target even if another order names that same id. Recheck E's authorization against that
   reduced set. Each round tests every remaining order against the same round-start set and
   removes **all** failing orders together; repeat without re-admission until stable. Apply any
   erasure-specific budget only to these survivors, using a receiver-declared rank independent
   of wire order. The budget charges once per distinct target id, ranking a target by its
   lowest-id surviving order; skipping a target skips all its orders with an `erasure-limit`
   outcome. Run the same simultaneous-round filter again on the budget-selected orders, without
   refilling budget after a failure. Only its survivors are effective. Different orders for one
   target create at most one active purge obligation for that id. The obligation has a stable
   identity and storage generation separate from the current refusal event; it names a prior
   admission epoch only when one exists. A later order updates the refusal event on that same
   obligation without invalidating its in-flight purge worker or starting a second physical purge
   of the same bytes. An obligation
   is needed only when this peer's declared
   surfaces hold the target's bytes. Another peer's holding alone creates no obligation here;
   an advance order MUST NOT probe a co-tenant's holdings to decide this peer's report. Thus an
   order may verify its own target's tenant or
   author while a second order cannot preserve authority that its peer erases. An authorized order
   for a target neither held nor co-offered also creates the refusal event at commit; it creates
   no byte-removal obligation unless this peer's declared surface actually holds bytes. One atomic commit
   creates one durable, peer-local refusal event per newly refused target, even if several
   effective orders name it. A later effective order for that id advances the event once more. A
   peer admitting non-governor orders for absent targets MUST declare and enforce a finite cap on
   outstanding advance refusals; reaching the cap rejects the new order as `erasure-limit` and
   never evicts an existing refusal.
   A rejected order
   gets an `erasure-ineligible` outcome and reason in the receiver's private report. Every
   order candidate that is not effective, including one rejected for shape, authority, or
   budget, is rejected from this transfer: it does not land as an ordinary held delta and cannot
   later be silently deduplicated. An erasure classified as testimony before provisional
   selection may land as ordinary data, with no exclusion effect. That admission-time
   classification is fixed; a later policy change or a direct redelivery does not turn held
   testimony into an erasure order without a new, distinctly identified order candidate authorized
   under the receiver's policy. That candidate passes steps 1–6, including authorization, budget,
   exclusion, and durable purge obligation; merely pointing to the held testimony does not bypass
   any gate. The duplicate outcome says `held-as-testimony` and makes no erasure promise. Only
   effective orders exclude and refuse their targets. They may target a separate co-offered candidate: that
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
   requirements, including the mandatory eligible-negation dependency, were skipped by quota,
   repeating until stable. Freed capacity need not be
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
   absent) or `bytes-removed` (physical absence is proved on its declared surfaces). An obligation
   for bytes this peer held cannot pass the latter gate while the same physical bytes remain
   shared-held by another peer. An advance refusal for an id this peer never held has no purge
   obligation: its gate is satisfied without probing a co-tenant, and its report says no peer
   holding was removed rather than claiming physical byte removal. Every active pending or
   failed obligation remains visible across restart and is retryable through an explicit
   operation; failure never silently counts as byte removal. **Gate completion alone never
   re-admits an id.** A lower-posture peer additionally requires an explicit, receiver-authorized
   local re-entry act naming the receiving `PeerId`, the id, and its **current** refusal event,
   plus the prior admission epoch when one exists. The act MUST be signed by the peer's pinned
   governing key, or by a key that root delegated in a locally admitted SPEC-14 record with exact
   scope `rhizomatic.peer.reentry:<PeerId>` and `delegable: false`. The peer checks that authority
   at commit, including every retry after `reentry-blocked`; a same-transfer delegation cannot
   authorize the act. A transferred copy of another peer's act is testimony only and cannot
   execute here. Routine gossip, a duplicate offer, or a negation of the held erasure record
   cannot supply that act. The act and its outcome are durable peer testimony. A co-offered id
   the peer never held also remains refused until this
   explicit act, even when its byte-removal gate is already satisfied. A `reentry-blocked` fault
   leaves the same act retryable after repair while its named refusal event remains current. A
   successful commit compares the named refusal event to the peer's current event atomically and
   consumes the act: replaying or redelivering it cannot create another epoch, and a
   later refusal event requires a new act. If a newly effective erasure E2 names an id already
   refused while re-entry is blocked, E2 creates the new current refusal event; the prior act no
   longer authorizes re-entry and the peer reports that change. E2 cannot be erased by retrying
   the earlier act.

   Under `bytes-removed`, re-entry waits for the obligation's terminal `removed` state. Under
   `peer-released`, it waits for release and for every in-flight physical purge of the old
  obligation to finish or be fenced out. The storage layer MUST reject a stale obligation
   generation or admission epoch at the **byte mutation itself**, under the same lock or
   transaction that removes bytes. A refusal-event update alone leaves that obligation generation
   unchanged; a terminal supersession changes it atomically so an old worker cannot touch new
   bytes. A prior
   worker check alone does not fence a stalled or replayed worker. Before the re-entry commit,
   the peer MUST stage and verify or rewrite the delta's bytes on every declared serving surface,
   including after a partial prior purge. If staging fails, or a worker cannot be proved finished
   or fenced, the peer records a durable `reentry-blocked` fault and keeps the id unadmitted;
   a timeout does not make it safe. The peer may retry the explicit act after repair. The commit
   atomically promotes verified staged bytes, makes any old obligation terminal as `superseded`
   (with a byte report of `not removed` unless absence was independently proved), creates the
   new admission epoch, and forbids any retry of that old obligation. A backend that cannot
   publish bytes and epoch state together MUST refuse re-entry. An old worker cannot remove a
   newly admitted holding.
   The old erasure's exclusion is keyed to its refusal event and the targeted admission epoch when
   one existed; after re-entry, the old event is no longer current. A peer serving read takes the
   admitted delta set **and** the peer's explicit epoch/exclusion state as inputs, and filters out
   only occurrences excluded in their own epoch. A held erasure delta remains testimony, but its
   old storage effect does not suppress the new occurrence of its target id. A duplicate delivery
   of E reports `held-effective-for-refusal` with its old refusal event (and prior admission epoch
   when one exists) and explicitly says its exclusion is
   not current; it does not claim the newly admitted D is erased. Pure substrate
   evaluation then runs over that filtered set at explicit `now`. Before re-entry the id is
   outside serving reads; after re-entry it is eligible under the ordinary validity and read
   policies. A permanent refusal never permits re-entry. A rejected or duplicate id creates no
   arrival event.
   Quota capacity may remain unused after dependency pruning, but an id that did not land is
   never charged. An internal `purge-pending` outcome reveals that the peer held and erased this
   id; a public endpoint MAY map it to a generic refusal, while preserving the private reason.
   Later acceptance can still reveal when a re-entry gate completed. A host that keeps
   co-tenant holdings confidential MUST restrict that retry visibility or choose a gate whose
   completion does not depend on another peer's holdings.

A signed bundle is one indivisible candidate unit through every gate: failure of any member
rejects that bundle, not another bundle that covers some of the same ids. Loose self-signed
deltas are independent units even when a third party names them in a bundle. An unsigned delta
can land only through a selected verified bundle that covers it. Each bundle is checked and
ranked independently; if one fails verification, guard, closure, or quota, another covering
bundle remains eligible. When two bundles land with a shared member, that id lands once, has one
arrival event, and costs quota once. No bundle borrows a member from a bundle that failed.
The same-author rule for bundles with unsigned members prevents a third-party author from
permanently vetoing their admission by erasing its own member, signed or unsigned.
Repeated appearances of one id create at most one arrival event and quota charge. The candidate
set is unordered; every set-level selection uses the declared rank. Separate transfers in
different orders may still produce different admitted sets because their pre-transfer states
differ.

A guard may depend on the receiver's already admitted set. Thus accepting A, changing the roster,
then receiving B can differ from receiving B first. This is a fact about that peer's admission
history. Substrate evaluation over a fixed admitted delta set remains independent of ingest
order. A peer serving read also takes its explicit epoch/exclusion state; two peers with equal
delta ids but different erasure histories may serve different sets under their declared postures.
Under this portable snapshot rule, if a revocation N and an act A by the revoked key arrive in
one transfer, A's candidate-local guard sees the pre-transfer authority and may admit A. N and A
receive distinct arrival sequences, but their shared transfer ordinal says they were admitted under
one authority snapshot. A receiver that wants N to bar A within that transfer can declare a
**candidate-set conflict rule** that rejects A when N is an eligible verified candidate after
steps 1–3, whether or not N later lands. That conservative application choice gives no
provisional N authority; federation
assigns no universal meaning to that application-specific revocation.
The portable admission dependency requires every eligible co-offered negation of a selected
**ordinary** target; effective erasure orders remain exempt. An offered lens MAY declare stronger requirements, including what happens when a related
negation was not offered; a privacy-preserving rule may refuse the target. The closure rule MUST
NOT silently add an unoffered delta. Plan step 7 defines the publish-side closure audit and checks
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
append). An epoch reference is (`PeerId`, arrival sequence); sequences from different peers are
not one numeric order. The arrival time comes from the receiver's
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
three independent axes. Validity is evaluated at the caller's explicit read time. A separate local
claim may reference a foreign delta and use its own validity interval; receiving the foreign
delta never rewrites its interval.

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
- A testimony-classified erasure and an unauthorized order candidate co-offered with D have no
  exclusion effect; D and a bystander can land. An effective erasure E of held N makes N
  unavailable as a post-commit requirement for candidate T; T is pruned, while E and an
  unrelated candidate land. E1, authorized by the pinned root, erases grant G, which is E2's sole
  authority: both are provisionally eligible, but the reduced-snapshot recheck rejects E2.
  Sending E1 first in a separate transfer also rejects E2. An E whose policy derives tenant
  authority from its **own** target remains eligible in the reduced-set recheck. A closure
  configuration that assigns post-commit requirements to erasures is rejected at setup.
- An operator-authorized erasure E names absent D. E lands, installs a refusal for D, and creates
  no byte-removal obligation while no declared surface holds D. A later verified offer of D is
  refused before caller guards, with a binding discrepancy reported if D's author differs from
  E's claim; permanent refusal still prevents D from landing.
- A non-governor order E claims authority because it names itself as absent D's author. With D
  unavailable, the receiver rejects E as `erasure-ineligible`; the claimed author cannot install
  a permanent veto. A peer that allows other non-governor advance orders has a finite outstanding
  refusal cap: at the cap, another order gets `erasure-limit`, while earlier refusals stay intact.
- An order whose only claimed authority is D's tenant is equally ineligible while D is absent;
  the signed tenant label on E is not evidence of D's tenant. A pool may separately pin its host
  operator key as an additional governor without sharing that host's `PeerId`. Pools A and B pin
  the same host key. An order signed by that key names A's `PeerId`: A may apply it through its own
  pipeline, while B's receipt through gossip is testimony and never refuses or erases D at B.
  Receipt at the host is likewise testimony, although the signer is the host's own governing key.
  A host-key order without a receiving `PeerId` can act at the host but is testimony at A and B.
- E is an effective erasure order, and its eligible negation N is co-offered. Ordinary quota skips
  N. E still commits its refusal and any byte-removal obligation; N's absence never prunes E.
  If N later lands and negates E's standing testimony, the committed refusal remains.
- An order candidate E is rejected by the erasure budget or reduced-set authority check. It does not
  land as ordinary data; a later re-offer is judged again. An erasure classified as
  testimony may land, but has no exclusion effect.
- The receiver classifies E the same way whether the owner sends it directly or a relay forwards
  it. If E first lands as testimony, a direct duplicate reports `held-as-testimony` and does not
  erase D; changing the receiver's policy requires a new order candidate that passes every
  erasure gate. If E is an order candidate but lacks authority from the pre-transfer set, it is
  rejected as `erasure-ineligible`, not admitted as testimony; G and E co-offered cannot change
  that classification or borrow G's authority.
- Two valid erasure orders target admitted D. The erasure budget charges one target, both records
  may land, and the commit creates one stable purge obligation linked to D's current refusal event
  and prior admission epoch. A third order targeting X is not displaced merely because D had two
  orders.
- A committed erasure with an unfinished purge keeps its id outside the admitted and serving
  sets after restart. A re-offer gets `purge-pending`, not silent dedup, and cannot race the
  purge. The report stays `pending` or `failed` with a durable fault until declared surfaces
  prove removal or a weaker `peer-released` re-entry supersedes the obligation. A failed purge
  can be retried while active. Even after a `bytes-removed` gate passes, routine gossip gets
  `reentry-required` and does not re-admit D. An explicit receiver-authorized local act names D,
  the current refusal event, and the prior epoch when one exists. The same requirement holds when E refused a
  co-offered D that the peer never held. Under `peer-released`,
  re-entry waits for old purge workers to be fenced out. A worker that checked its fence before a
  stall is rejected by storage at mutation time. If that worker cannot be fenced, or staging and
  verifying the new bytes fails, the durable outcome is `reentry-blocked`: D is not admitted and
  the prior obligation is not superseded. A repaired retry with the same act stages verified bytes,
  then atomically publishes them, marks the old obligation `superseded`, and admits a new epoch.
  The act is consumed; its replay creates no further epoch, and a synced copy cannot execute at
  another peer. An old retry cannot delete the new holding; a partial old purge cannot yield
  damaged admitted bytes. The held erasure still names its old refusal event and any prior epoch;
  it does not suppress the new one. The new epoch serves under
  normal validity and read rules.
  `peer-released` and `bytes-removed` gates give different outcomes while another peer retains
  the bytes.
- After `reentry-blocked`, an authorized re-entry act may be retried only while its named refusal
  event is current and its signer is still authorized at commit under the receiving PeerId's exact
  delegation scope. A synced copy executes nowhere else. A new effective E2 for D during the
  block creates a new refusal event, so retrying the old act cannot re-admit D. After successful
  re-entry, a duplicate E reports `held-effective-for-refusal` for the old event (with an old epoch
  only when one existed) while D serves.
- E1 starts a purge of admitted D under obligation O. E2 names D before that worker finishes and
  advances D's refusal event. O keeps its stable storage generation, so the E1 worker may finish
  removing the same old bytes. Re-entry supersedes O atomically and advances its generation;
  a stalled old worker then cannot remove newly admitted bytes.
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
  admit a fitting honest bundle. A low-id unauthorized order candidate or one that fails the conservative
  authority recheck cannot consume an erasure-specific budget ahead of a valid order.
- Without an offered lens, eligible T and its co-offered negation N reach ordinary quota. If quota
  skips N, final dependency pruning removes T too; T never lands as a live claim merely because
  quota cut N. If a candidate-local guard rejects N, N is not eligible and this mandatory
  dependency does not bypass that guard. The same rule applies when N itself has an eligible
  co-offered negation.
- A non-monotone policy authorizes E when held A and B have the same presence. Both are held
  before transfer; provisional H_A and H_B erase A and B, so E survives the first reduced-set
  check. A later budget keeps H_A but skips H_B, leaving A absent and B present; the second
  filter removes E and may leave capacity unused. Each round removes all failures together and
  never re-admits E by choosing an order-dependent fixed point. This is a declared liveness cost,
  not a purge.
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
- A loose effective erasure E targets D in a separate same-signer bundle {D, unsigned M}. E
  lands, that bundle is rejected without splitting it, and M needs another valid cover or a
  later bundle. The private report names `bundle-excluded-by-erasure`; an unrelated loose
  bystander lands. If Alice's bundle covers unsigned M and a Mallory-authored D, signed or
  unsigned, the bundle is invalid at verification, so Mallory cannot permanently veto M by
  erasing D.
- A lower-posture peer erases and fully purges an id, then explicitly re-admits it. The new arrival sequence
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
- A shared-key container with no distinct peer state is a surface of the host peer, so its bytes
  belong in that peer's erasure report. Once it has its own key and state it is a separate peer.
  The host refused D held by that surface and X that the surface never held; both refusals applied
  there. A new key alone leaves both under the host. The handoff copies both refusals and D's
  active purge obligation before the new peer serves. Neither id can enter by gossip afterward;
  an offer of X gets a generic refusal and its provenance is not publicly listed. A failed handoff
  keeps the host responsible and does not create a separate serving peer. If an effective host
  order for Y was accepted for the surface before the cutover, it commits and Y's refusal is
  carried or it explicitly fails; it cannot commit for the host only afterward. A new arrival
  behind the cutover barrier is routed to the new peer or gets `peer-changed`. A stale
  acknowledgement for an earlier attempt cannot close this handoff, and a purge worker from the
  host cannot run after transfer. A new-peer re-entry act names D's qualified host refusal
  event; a new-peer arrival sequence equal to a numeric host sequence cannot collide with it.
  A combined erase whose member set was fixed before the cutover fails or retries against the
  new peer roster; it cannot report complete while omitting the new peer.
  A combined erase reports each member result; if B rejects while A commits, the combined report
  cannot say both erased D. A combined read unions only A's and B's serving reads that its audience
  may access, never raw backend bytes.
- A installs an advance refusal for D while A has no D bytes and co-tenant B does. A creates no
  byte-removal obligation and reports no information about B's holding. If A's own declared
  surface independently holds unadmitted D bytes, A records a stable obligation linked to its
  current refusal event even though D has no prior admission epoch.
- At a lower-posture peer A that never held D, an advance refusal has no purge obligation. Its
  `bytes-removed` gate is satisfied without testing B's shared holding, but routine gossip still
  gets `reentry-required` until A commits a local re-entry act.
- Two stores' `person:myk` deltas merge by entity string. A governed read with one governing key
  selects only that key's declarations on a shared rules anchor.

The publish contract, closure audit, set digest, and signed wire envelope are plan step 7. The
current HTTP binding is a v0 helper and does not yet satisfy SPEC-6 §4's signed-message rule.
