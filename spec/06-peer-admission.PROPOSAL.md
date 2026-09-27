# SPEC-6 vNext proposal: peers, admission, and arrival

**Status:** Proposed contract for plan step 6. Shared vectors and witness parity are required
before this becomes normative. Plan step 7 adds publish/subscribe contracts and signed protocol
messages.

## 1. Peer boundary

A peer has a governing key, an admitted delta set, an admission policy, and a sharing policy. Its
delta set may be backed by its own storage or by a view over a host's storage. A shared storage
backend does not collapse two peers into one: each peer keeps its own admission decisions, arrival
records, governing key, and sharing policy. A container hosted inside another peer is still a peer.

The same canonical delta has the same id and bytes in every peer. String-equal entity ids refer to
the same entity after union. The peer boundary does not qualify or rewrite entity ids. A peer
decides which claims travel through its sharing policy; a governed read decides which authors'
claims bind through an explicit author selection. Instance-local ids that must remain distinct
need distinct strings at creation.

## 2. Admission

Admission is a local, ordered pipeline over a proposed transfer. The implementation supplies the
guards; federation does not import an application's rules. Each guard receives explicit inputs:
the surviving, verified candidates from the previous gate; the sending and receiving peer ids;
the receiver's admitted delta set before this transfer; the receiver's arrival time; and any
application policy state. It returns the candidates it accepts. Portable guard profiles depend
only on those explicit inputs; a host supplies policy state, including quota counters. The
receiving peer MAY select a different pipeline for a local append and a foreign transfer, but
both pass through verification and the peer's admission boundary.

The pipeline is:

1. Verify every candidate's canonical bytes, id, and signature or signed-manifest coverage.
   An unverified candidate is removed before any guard sees the transfer.
2. Check the subscribed lens, when a subscription is present.
3. Apply the receiver's guards in declared order. Each guard sees only candidates that survived
   all previous gates. A guard can evaluate a declared closure over those candidates and the
   pre-transfer admitted set, including related negations or manifest members. The closure is
   an input to the guard, not an automatic expansion of the received set.
4. Add the final accepted candidates to the receiver's delta set and record local arrival
   testimony in the same transaction. A rejected or duplicate delta creates no new arrival.

A signed bundle is one indivisible candidate: if a member fails verification, lens selection, or
any guard, the whole bundle is rejected. Loose deltas are independent candidates, but the guards
see the eligible loose set as a batch. A guard that rejects an erasure removes it before a later
guard can use that erasure to reject its target. The admitted set supplied to every guard is the
pre-transfer set; newly accepted deltas affect the next transfer. This makes one transfer
order-independent while preserving the possibility that separate transfers in different orders
produce different admitted sets.

A guard may depend on the receiver's already admitted set. Thus accepting A, changing the roster,
then receiving B can differ from receiving B first. This is a fact about that peer's admission
history. Evaluation over either resulting admitted set remains independent of ingest order.
Implementations MUST make the processing order of candidates within one transfer explicit;
shared vectors will pin that order for the portable pipeline.

An admission decision never edits a delta. The author-signed `timestamp`, `validFrom`, and
`validUntil` remain the author's claims. A receiver MAY enforce a local time-skew guard by comparing
them with its arrival time. There is no universal skew limit. An offered lens selects candidates;
it does not confer authority to bypass admission.

## 3. Arrival testimony

For each accepted id, a peer records when it first admitted that id and from which peer, if any.
This is local testimony by the receiver, outside the delta's canonical bytes and content id. A
relay records its own arrival when it admits a delta; it never copies the upstream peer's arrival
as its own. A second delivery of the same id does not rewrite the first arrival. Arrival records
for an atomic bundle become visible with the accepted bundle, never before it.

The signed creation time, the claimed validity interval, and the receiver's arrival time are
three independent axes. Validity is evaluated at the caller's explicit read time. A later local
adoption MAY name a foreign delta and choose a local effective time, but receipt never rewrites
the foreign claim's validity interval.

An arrival record can be persisted as private peer metadata or expressed as a receiver-signed
annotation delta. The portable contract is the receiver's observable testimony, not one storage
layout. A shared host MUST keep one arrival history per peer, even when their delta sets view the
same underlying bytes.

## 4. Conformance cases to freeze

- Two peers view one host storage. Each admits one id at a different time and each reports its own
  arrival. The second peer never inherits the first peer's arrival.
- One peer admits A, changes a roster guard, then receives B; another receives B before A. Their
  admitted sets may differ, while evaluation over either fixed set is order-independent. A and B
  in one transfer see the same pre-transfer roster.
- An earlier guard turns away an otherwise valid erasure T. A later erasure guard cannot use T to
  refuse its target D in that transfer; D and a bystander can land.
- A foreign delta with a future `validFrom` is admitted at T and remains invisible to validity
  reads until its signed start. Arrival testimony says T throughout.
- A duplicate delivery does not change first arrival; a rejected delta has no arrival.
- A signed manifest and unsigned covered members are admitted atomically, with no partial arrival
  records on rejection.
- Two stores' `person:myk` deltas merge by entity string. A governed read with one governing key
  selects only that key's declarations on a shared rules anchor.

The publish contract, closure audit, set digest, and signed wire envelope are plan step 7. The
current HTTP binding is a v0 helper and does not yet satisfy SPEC-6 §4's signed-message rule.
