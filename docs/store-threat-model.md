# The store's threat model

This document says who the store defends against, and who it does not. It applies to the store
contract of `spec/18-store.PROPOSAL.md` and to the stores in this repository. The proposal owns
the behavior. This document points to it, and adds no promise.

A hardening change to a store names one line of this document. A change that names no line is
not built. A change that needs a new line changes this document first, in its own pull request.
This rule does not stop a fix of a wrong answer.

## What the store protects

1. **Peer holdings.** A peer reads its own holdings. Purge reports reveal shared holdings as
   described below.
2. **The content address.** A delta that a read returns has the id that its claims hash to.
3. **The erasure report.** A report that says `proven` is true inside its stated boundary.
4. **Damage detection.** Some calls detect damage and refuse. Other damage requires `fsck` or
   remains undetected.

## Who can do what

| Party | What it can do | The store's position |
| --- | --- | --- |
| A caller of the public interface | Call the interface with arbitrary arguments and sequences | The contract defines accepted calls and refusals. Damage detection has limits below. |
| A sender of deltas | Supply delta claims, ids and signatures | Admission checks the id. The store checks signature form; admission owns signature verification. |
| A reader of one peer | Read that peer's deltas, change feed, digests and reports | Defended in part. See "What a reader of one peer learns". |
| The medium | Lose power, lose a file, cut a write short, flip bits in a row | Some damage is detected. The store does not repair it. See "Damage". |
| The operator | Read and write every file, the process memory and the configuration | Trusted. The operator is the trust root. |
| A second writer of the medium | Write outside this host's admission | The proposal specifies `untrusted` reads in §4.9. The built-in stores declare `trusted`. |

## What a reader of one peer learns

Peers share bytes. The store keeps one copy of a delta that two peers hold.

- A peer's reads and feed expose only its own holdings and history.
- A purge report says that bytes remain when another peer holds them. It does not name that peer.
  This is a stated signal: a reader learns that some other peer holds the same delta.
- A peer can repeat a purge and learn when another holder releases that delta (§4.7.2).
- The change feed keeps the id of a purged delta (decision O4). A reader who holds an id can
  confirm a guess of the claims.
- A host can select bounded retention. An id leaves the feed when every record naming it expires.
- Timing is not defended. A reader can measure how long a call takes.

## Damage

Damage means state that no sequence of public calls can produce. Its causes are a fault of the
medium, a bug, or a write by the operator.

- A store refuses where it can see the damage at the cost of the call it already makes.
- `fsck` on the `Exporter` finds more. It costs O(store). It is not complete: it cannot run on a
  file that does not open, and it can miss a fault that a write makes during the scan.
- A store does not repair. Repair is the host's decision, because the host knows where a second
  copy is.
- A store does not defend against damage that an adversary shapes. A party that can write the
  files is the operator, and the operator is trusted.

## The boundary of the erasure report

A `proven` report covers targets marked `removed`, within the boundary in §4.7.2. In short,
these lie outside it:

- remanence in a filesystem or a drive after a file is unlinked;
- backups, replicas and copies that the host or a follower made;
- the process memory of a durable store, and swap, hibernation and crash dumps;
- a view that a holder still keeps in memory;
- the id of a purged delta in the change feed;
- a log beside a second name of the database file (a hard link, a rename, a bind mount).

The last line is an operator action. The store cannot establish that another name has no
separate log. See §4.7.2 and reading 119.

## Out of scope

- A party with operator access that acts against the store.
- Access control. The host must authorize access to peer handles and administrative operations.
- A side channel through timing, cache state or resource use.
- Denial of service by a caller that the host admitted. The host limits its callers.
- Confidentiality at rest. The store does not encrypt. A host that needs it encrypts the volume.
- Proof of erasure to a third party. A report is the store's statement to its host.
