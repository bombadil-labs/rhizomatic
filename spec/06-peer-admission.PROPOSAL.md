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
The erasing peer's report MUST disclose that the shared host still holds those bytes for a
co-tenant; it cannot report host-wide byte removal. The physical storage layout and garbage
collection are implementation choices.

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
   set cannot re-enter even when its erasure record is negated. Deduplicate ids already held and
   repeated ids in the transfer before any guard or quota. A self-signed loose copy remains
   independently eligible even when a bundle names its id. Invalid or refused candidates cannot
   serve as evidence for others. An id with a pending physical purge still counts as held and
   excluded from serving; it cannot re-enter until the purge finishes.
2. Apply the subscribed lens, when present, and its **declared** closure rule. That rule may add
   related candidates from the verified offer (for example, negations or manifest members), but
   never fabricate a delta or bypass **any** candidate-local guard. It states which selected ids
   require which related ids. There is no implicit closure. A host can write a guard that admits
   an otherwise unrostered negation of a pre-transfer id; closure does not silently override its
   roster rule.
3. Apply candidate-local guards in declared order, each against the same pre-transfer admitted
   set. A set-level quota MUST use a receiver-declared rank independent of wire order. The
   portable default is ascending delta id, with a bundle ranked by manifest id; a receiver MAY
   use a private, stable rank to make low-id grinding ineffective. A unit too large for the
   remaining quota is skipped, and later units are considered. Quota counters commit only for
   the final accepted set.
4. Compute a **proposed** final set without changing holdings. Apply any declared, deterministic
   candidate-set conflict rule to candidates that passed steps 1–3, using the pre-transfer
   admitted set. Then reject any connected
   conflict component in which a candidate erasure targets another erasure, a candidate in this
   transfer, or an id required by a candidate in this transfer. A component contains the
   conflicting erasure, the affected candidates, and candidates linked to either by a declared
   requirement or signed-bundle membership; unrelated loose candidates may proceed. This
   conservative rule also covers two erasures that remove one another's requirements. Once
   these components are removed, surviving peer-local erasures may exclude already held ids.
   A foreign erasure is testimony unless the receiving peer's declared policy adopts it as its
   own erasure order. Prune candidates whose declared requirements are not met by another final
   candidate or a still-held post-commit id; repeat until stable. Exclusions now remain fixed,
   and pruning can only remove candidates. A provisional candidate cannot confer authority or
   an erasure effect unless it remains in this final set.
5. Commit the final additions, logical exclusions, permanent refusals, quota counters, arrival
   records, and **durable pending-purge obligations** in one atomic transaction. If the backend
   cannot commit that logical state together, reject the affected component without changing
   holdings. Physical byte removal follows the commit. Until it succeeds, the peer reports the
   bytes as still held, records the outstanding obligation across restart, and keeps the id out
   of serving reads (plan step 9). A lower erasure posture may permit re-entry only after the
   pending purge completes; a permanent refusal never does. A rejected or duplicate id creates
   no arrival event.
   Quota capacity may remain unused after dependency pruning, but an id that did not land is
   never charged.

A signed bundle is one indivisible candidate through every gate: failure of any member rejects
the whole bundle. Loose self-signed deltas are independent candidates, even when a third party
also names them in a bundle; failure of that bundle cannot reject the loose copy. An unsigned
delta needs verified bundle coverage. Verified bundles that overlap through an unsigned member
form one indivisible component, regardless of manifest rank. Failure of any bundle in that
component rejects the component; there is no fallback to a second covering bundle. A bundle
that fails initial verification supplies no coverage and is absent from component formation.
Repeated appearances of one id create at most one arrival event and quota charge. The candidate
set is unordered; every set-level selection uses the declared rank. Separate transfers in
different orders may still produce different admitted sets because their pre-transfer states
differ.

A guard may depend on the receiver's already admitted set. Thus accepting A, changing the roster,
then receiving B can differ from receiving B first. This is a fact about that peer's admission
history. Evaluation over either resulting admitted set remains independent of ingest order.
Under this portable snapshot rule, if a revocation N and an act A by the revoked key arrive in
one transfer, A's candidate-local guard sees the pre-transfer authority and may admit A. N and A
receive distinct arrival sequences, but their shared transfer id says they were admitted under
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
receiver-assigned transfer id unique within that peer,
and the sending peer id (or `local` for an append). The arrival time comes from the receiver's
trusted clock, never from an author-signed field. This is local testimony by the receiver,
outside the delta's canonical bytes and
content id. A relay records its own arrival when it admits a delta; it never copies the upstream
peer's arrival as its own. A duplicate delivery while the id is held creates no new arrival.
Local appends also record arrival. All records for one atomic transfer become visible with that
transfer. Within it, sequence positions follow ascending delta id; this order is deterministic
admission bookkeeping, not a claim about which author acted first. Authority decisions for every
member of the transfer use the same pre-transfer state.

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
a lower posture permits re-entry after physical purge, the peer assigns a later lifetime sequence
and a new admission epoch for that id. The peer MUST persist the sequence counter even if it
purges earlier arrival metadata. If the earlier metadata was purged, the new record is described
as the first arrival **in that epoch**, never the first arrival in the peer's lifetime.

## 4. Conformance cases to freeze

- Two peers view one host storage. Each admits one id at a different time and each reports its own
  arrival. The second peer never inherits the first peer's arrival.
- One peer admits A, changes a roster guard, then receives B; another receives B before A. Their
  admitted sets may differ, while evaluation over either fixed set is order-independent. A and B
  in one transfer see the same pre-transfer roster.
- An earlier guard turns away an otherwise valid erasure T. A later erasure guard cannot use T to
  refuse its target D in that transfer; D and a bystander can land.
- An erasure E targets held D but the logical commit fails. D remains admitted and no new
  refusal, purge obligation, or arrival is recorded. A retry can commit the whole logical change.
  If E would exclude a held N required by selected T, their conflict component is rejected. The
  same holds when E targets a candidate, including a bundle member; a bystander still lands.
- E1 requires held X and erases held Y; E2 requires Y and erases X. Their conflict component is
  rejected once, without oscillation or a partial erasure effect. A committed erasure with a
  pending purge stays excluded from serving after restart; a re-offer cannot race the purge.
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
  skipped while a later fitting loose candidate may land.
- A foreign delta with a future `validFrom` is admitted at T and remains invisible to validity
  reads until its signed start. Arrival testimony says T throughout.
- A duplicate delivery does not change first arrival or charge quota; a rejected delta has no
  arrival. A local append has an arrival record. Two accepted ids in one transfer have equal
  arrival time and distinct sequences in ascending id order.
- A signed manifest and unsigned covered members are admitted atomically, with no partial arrival
  records on rejection. A member with its own signature can still land loose when a third-party
  bundle naming it fails; an unsigned member cannot. Two verified bundles covering the same
  unsigned member form one unit, so a rejection of either rejects both. A repeated id creates one
  arrival record.
- A lower-posture peer erases and fully purges an id, then re-admits it. The new arrival sequence
  is greater than every earlier sequence, even when old arrival metadata was purged; it is a new
  admission epoch for that id, not an earlier event in the peer's history.
- Two logical peers viewing one backend have different governing keys and refusal sets. Erasing
  D from one peer does not remove the other peer's held D or rewrite its arrival testimony.
- Two stores' `person:myk` deltas merge by entity string. A governed read with one governing key
  selects only that key's declarations on a shared rules anchor.

The publish contract, closure audit, set digest, and signed wire envelope are plan step 7. The
current HTTP binding is a v0 helper and does not yet satisfy SPEC-6 §4's signed-message rule.
