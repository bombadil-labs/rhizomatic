# The store's threat model

This document says who the store defends against, and who it does not. It applies to the store
contract of `spec/18-store.PROPOSAL.md` and to the stores in this repository.

A hardening change to a store names one line of this document. A change that names no line is
not built. A change that needs a new line changes this document first, in its own pull request.

## What the store protects

1. **The delta set of each peer.** A peer reads what it holds, and nothing else.
2. **The content address.** A delta that a read returns has the id that its claims hash to.
3. **The erasure report.** A report that says `proven` is true inside its stated boundary.
4. **The refusal.** A store that sees damage refuses. It does not answer from damaged state.

## Who can do what

| Party | What it can do | The store's position |
| --- | --- | --- |
| A caller of the public interface | Any call, with any argument, in any order, from many threads or processes | Defended. No call sequence breaks a line of the list above. |
| A sender of deltas | Supply any bytes as a delta, a bundle or a signature | Defended at the core and at admission. The store keeps only a delta whose id matches its claims. |
| A reader of one peer | Read that peer's deltas, change feed, digests and reports | Defended in part. See "What a reader of one peer learns". |
| The medium | Lose power, lose a file, cut a write short, flip bits in a row | Detected, not repaired. See "Damage". |
| The operator | Read and write every file, the process memory and the configuration | Trusted. The operator is the trust root. |
| A second writer of the medium | Write the files outside this host's admission | Out of scope for trust `trusted`. A store of trust `untrusted` verifies ids and signatures on read (§4.9). |

## What a reader of one peer learns

Peers share bytes. The store keeps one copy of a delta that two peers hold.

- A reader of one peer never receives the bytes, the ids or the count of another peer's deltas.
- A purge report says that bytes remain when another peer holds them. It does not name that peer.
  This is a stated signal: a reader learns that some other peer holds the same delta.
- The change feed keeps the id of a purged delta (decision O4). A reader who holds an id can
  confirm a guess of the claims. A host that needs ids to leave sets a bounded retention.
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
- This document states no rule for a crash. The proposal gives the state after each cut write
  (§4.13).

## The boundary of the erasure report

A `proven` report speaks for the files and objects that the store controls, and for nothing
else. The proposal lists the boundary in §4.7.2. In short, these lie outside it:

- remanence in a filesystem or a drive after a file is unlinked;
- backups, replicas and copies that the host or a follower made;
- the process memory of a durable store, and swap, hibernation and crash dumps;
- a view that a holder still keeps in memory;
- the id of a purged delta in the change feed;
- a log beside a second name of the database file (a hard link, a rename, a bind mount).

The last line is an operator action. The store does not detect it today. Cheap checks are
agreed and not built: a mount point, a link count above 1 and an orphan log, at open and at each
proof. A store that sees one lowers its claim. The check is not complete, and its message says
so.

## Out of scope

- A party with operator access that acts against the store.
- A side channel through timing, cache state or resource use.
- Denial of service by a caller that the host admitted. The host limits its callers.
- Confidentiality at rest. The store does not encrypt. A host that needs it encrypts the volume.
- Proof of erasure to a third party. A report is the store's statement to its host.

## How to use this document

- A reviewer who charges a defect near erasure or isolation names the party and the line.
- A builder who proposes a new check names the party that the check stops.
- When the party is the operator, or the line is in "Out of scope", the change is not built.
