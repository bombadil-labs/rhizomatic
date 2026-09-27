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
two logical peers need different governing keys; reusing one key identifies one peer, not two.
When one peer erases an id, a shared backend MUST preserve bytes still held by another peer. The
physical storage layout and garbage collection are implementation choices.

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
rejects that candidate. It MUST NOT use another candidate in the transfer as authority: a grant
or roster change first affects the next transfer. An erasure in the same transfer is considered
only at the final peer-local erasure step below. This prevents provisional evidence from
authorizing a delta that survives after the evidence is rejected. The receiving
peer MAY use a different guard list for a local append and a foreign transfer, but both pass
through verification and the peer's admission boundary.

The pipeline is:

1. Verify canonical bytes, ids, and signatures or signed-manifest coverage for the complete
   proposed transfer. Deduplicate ids already held and repeated ids in the transfer before
   applying any guard or quota. Invalid candidates cannot serve as evidence for others.
2. Apply the subscribed lens, when present, and its **declared** closure rule. That rule may add
   related candidates from the verified offer (for example, negations or manifest members), but
   never fabricate a delta or bypass mandatory admission guards. It states which selected ids
   require which related ids. There is no implicit closure.
3. Apply candidate-local guards in declared order, each against the same pre-transfer admitted
   set. A set-level quota MAY select a subset, but its choice MUST use canonical ascending delta
   ids (a bundle is ranked by manifest id), not wire order. Quota counters commit only for the
   final accepted set.
4. Remove a candidate whose declared required ids did not survive step 3. Repeat until no such
   candidate remains. A peer-local erasure effect then removes the erasure's target only if the
   erasure itself survived every prior gate. An erasure of another erasure is invalid. A later
   guard cannot turn away an erasure after it has affected a target.
5. Atomically add the final accepted ids to the receiving peer's delta set and write their local
   arrival records. Rejected and duplicate ids create no new arrival event. A quota may leave
   unused capacity when dependency pruning removes a candidate; it must not count that candidate.

A signed bundle is one indivisible candidate through every gate: failure of any member rejects
the whole bundle. Loose deltas are independent candidates. If the same id is offered both loose
and in a bundle, the receiver verifies both forms and handles it once, as part of the bundle;
the loose copy adds no arrival event or quota charge. The candidate set is unordered; every
set-level selection uses the canonical order above. Separate transfers in different orders may
still produce different admitted sets because their pre-transfer states differ.

A guard may depend on the receiver's already admitted set. Thus accepting A, changing the roster,
then receiving B can differ from receiving B first. This is a fact about that peer's admission
history. Evaluation over either resulting admitted set remains independent of ingest order.
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
its declared erasure posture (plan step 9); an old arrival event MUST NOT be misreported as a new
admission if a lower posture permits re-entry. Under permanent refusal, that id never re-enters.

## 4. Conformance cases to freeze

- Two peers view one host storage. Each admits one id at a different time and each reports its own
  arrival. The second peer never inherits the first peer's arrival.
- One peer admits A, changes a roster guard, then receives B; another receives B before A. Their
  admitted sets may differ, while evaluation over either fixed set is order-independent. A and B
  in one transfer see the same pre-transfer roster.
- An earlier guard turns away an otherwise valid erasure T. A later erasure guard cannot use T to
  refuse its target D in that transfer; D and a bystander can land.
- A candidate grant G and an act A arrive together. A guard checking A's authority uses the
  pre-transfer set, so A cannot borrow authority from G if G is later rejected.
- A quota receives the same candidates in two wire orders. It selects the same ids by canonical
  rank and charges only the ids that finally land.
- A foreign delta with a future `validFrom` is admitted at T and remains invisible to validity
  reads until its signed start. Arrival testimony says T throughout.
- A duplicate delivery does not change first arrival or charge quota; a rejected delta has no
  arrival. A local append has an arrival record. Two accepted ids in one transfer have equal
  arrival time and distinct sequences in ascending id order.
- A signed manifest and unsigned covered members are admitted atomically, with no partial arrival
  records on rejection. A member offered both loose and bundled creates one arrival record.
- Two logical peers viewing one backend have different governing keys and refusal sets. Erasing
  D from one peer does not remove the other peer's held D or rewrite its arrival testimony.
- Two stores' `person:myk` deltas merge by entity string. A governed read with one governing key
  selects only that key's declarations on a shared rules anchor.

The publish contract, closure audit, set digest, and signed wire envelope are plan step 7. The
current HTTP binding is a v0 helper and does not yet satisfy SPEC-6 §4's signed-message rule.
