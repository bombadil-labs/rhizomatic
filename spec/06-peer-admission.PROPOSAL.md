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
   repeated ids in the transfer before any guard or quota. Invalid or refused candidates cannot
   serve as evidence for others.
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
4. Compute a **proposed** final set without changing holdings. A declared requirement is met by
   a final candidate or an id still held in the proposed post-commit set. Remove candidates with
   unmet requirements; repeat until stable. A surviving peer-local erasure may
   propose excluding its target, including a target already held. An erasure of another erasure is
   invalid. If an erasure would remove a member of a signed bundle in this transfer, reject that
   erasure and bundle as one conflicting component; unrelated loose candidates may proceed.
   Recheck closure requirements against the proposed post-commit holdings after exclusions, and
   prune again until stable. A
   provisional candidate cannot confer authority or an erasure effect unless it remains in this
   final set; the conflicting-component rule above may reject both sides.
5. Commit the final additions, logical exclusions, permanent refusals, quota counters, and
   arrival records in **one atomic transaction**. If the backend cannot commit that logical state
   together, reject the affected component without changing holdings. Physical byte removal may
   follow the commit; until it succeeds, the peer reports the bytes as still held and keeps them
   out of serving reads (plan step 9). A rejected or duplicate id creates no arrival event.
   Quota capacity may remain unused after dependency pruning, but an id that did not land is
   never charged.

A signed bundle is one indivisible candidate through every gate: failure of any member rejects
the whole bundle. Loose deltas are independent candidates. A delta with its own verifying
signature remains independently eligible when a third party also names it in a bundle. Failure
of that bundle cannot reject the valid loose copy. An unsigned delta needs a verified covering
bundle; if multiple valid bundles cover it, the lowest manifest id supplies its atomic unit.
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
one authority snapshot. A receiver that wants N to bar A within that transfer MUST declare an
additional final-set guard and pin its precedence; federation assigns no universal meaning to
that application-specific revocation.
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
increasing peer-local arrival sequence, a receiver-assigned transfer id unique within that peer,
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
a lower posture permits re-entry after erasure, it creates a new admission epoch with a new
sequence. If the earlier arrival metadata was purged, the new record is described as the first
arrival **in that epoch**, never the first arrival in the peer's lifetime.

## 4. Conformance cases to freeze

- Two peers view one host storage. Each admits one id at a different time and each reports its own
  arrival. The second peer never inherits the first peer's arrival.
- One peer admits A, changes a roster guard, then receives B; another receives B before A. Their
  admitted sets may differ, while evaluation over either fixed set is order-independent. A and B
  in one transfer see the same pre-transfer roster.
- An earlier guard turns away an otherwise valid erasure T. A later erasure guard cannot use T to
  refuse its target D in that transfer; D and a bystander can land.
- An erasure E targets held D but the logical commit fails. D remains admitted and no new
  refusal or arrival is recorded. A retry can commit the whole logical change. If E excludes a
  negation N required by selected T, T is pruned before commit. If E targets a member of a bundle
  in the same transfer, the conflicting component is rejected and a bystander still lands.
- An id permanently refused after erasure is rejected by both local append and foreign transfer,
  even when the erasure record has been negated.
- A candidate grant G and an act A arrive together. A guard checking A's authority uses the
  pre-transfer set, so A cannot borrow authority from G if G is later rejected.
- A live grant D, its revocation N, and an act A under D arrive in one transfer. The portable
  snapshot profile admits A under pre-transfer authority and records N and A in one transfer with
  separate sequences; a declared final-set guard can choose the stricter result.
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
  bundle naming it fails; an unsigned member cannot. A repeated id creates one arrival record.
- Two logical peers viewing one backend have different governing keys and refusal sets. Erasing
  D from one peer does not remove the other peer's held D or rewrite its arrival testimony.
- Two stores' `person:myk` deltas merge by entity string. A governed read with one governing key
  selects only that key's declarations on a shared rules anchor.

The publish contract, closure audit, set digest, and signed wire envelope are plan step 7. The
current HTTP binding is a v0 helper and does not yet satisfy SPEC-6 §4's signed-message rule.
