# ERRATA & Decisions — SPEC-8 (Storage Profile / Packs)

## P1 — v0 pack format

Folded into SPEC-8 §3 (2026-06-11); history in git.

## P2 — The two invariants, operationalized

Folded into SPEC-8 §2 (2026-06-11); history in git.

## P3 — Deferred physical conveniences

The random-access index (`deltaId -> (section, offset)`), shared dictionaries (`dictRef`), and
ranged/partial reads are deferred: v0 packs decode wholesale in memory, so the index buys nothing
yet. They return when packs become reactor checkpoints over real I/O. Repacking is trivially
semantics-free in v0 because pack bytes are a pure function of the delta set (same set ⇒ same
bytes; the spec's repacking latitude becomes interesting only with physical layout choices).

## P4 — Grammar/vector reconciliation from the Elixir witness bring-up (2026-07-16, issue #19)

The first witness built from spec + vectors alone could not reproduce `packHex` from SPEC-8 §3's
grammar — the pinned vector's bytes were the real spec (issue #19, FINDINGS F2–F4, F7). Folded
into §3: the `"i"` stored-id field in both record shapes (the §4 fsck presupposed it; the grammar
omitted it), the `strings` table's raw-bytewise sort order (two plausible orders exist in-repo
and they diverge whenever lengths differ), the normative enumeration of interned string sources,
and a note that `"version": 1` encodes as a float (the profile has no integer encoding). The
missing `l0-pack/pack-bytes.json` promised by D12 and the vectors README since 0.4 (F1) is now
generated, and all three witnesses consume it. Verdict on the experiment: the pack layout was
the thinnest part of the suite; everything else at L0 was implementable from spec text.

## P5 — Envelopes win; what counts as a manifest (2026-07-16, issue #19 F6)

Folded into §3.1. A manifest claimed as a member of another manifest stays hydrated in
`envelopes` (both prior witnesses already behaved this way; now normative). Manifest-ness for
the partition = at least one `rhizomatic.txn.member` pointer with a DeltaRef target. A vector
exercising manifest-claiming-a-manifest is still owed — currently pinned only by per-witness
behavior.

## P6 — OPEN: MemberRecord `dt` is lossy in principle (issue #19 F5)

`dt = member.t − manifest.t` and `manifest.t + dt` are f64 operations; for pathologically
distant timestamps (constructible: `1e300` vs `1`) the round-trip is inexact and the §4 fsck
fails on a pack the packer itself produced, with no way to store the member dehydrated.
Candidate fixes: an optional absolute `"t"` in MemberRecord (mirroring optional `"a"`), or a
normative packer rule "verify `manifest.t + dt == member.t` bit-exactly, else store loose." No
witness implements either yet; unreachable for realistic milliseconds-since-epoch values.
Decide before packs carry adversarial input.
