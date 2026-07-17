# Rhizomatic Specification — SPEC-8: Storage Profile (L0)

**Status:** Draft
**Layer:** L0 — physical representation
**Depends on:** SPEC-1 (canonical form, content addressing, `rhizomatic.txn` manifests)

---

## 1. Purpose

L0 defines the **pack**: a physical container format for delta sets, exploiting transaction manifests to factor shared envelope metadata out of members at rest and rehydrate it on extraction. L0 exists because P2 (append-only forever) makes storage a compounding liability unless the format has a compression story that is *provably semantics-free*.

The governing fact that makes L0 safe is content addressing (P6): a delta's identity is the hash of its canonical hydrated bytes (SPEC-1 §4.1), so any physical representation that can reproduce those bytes exactly is a conformant storage of that delta. The hash is the contract; layout is freedom. This is git's loose-objects/packfiles split, adopted wholesale.

**L0 is invisible to L1 and everything above it.** No layer above L0 may behave differently based on whether a delta is currently loose or packed. There is exactly one logical form.

## 2. The Two Invariants

These are absolute; everything else in this document is implementation latitude.

1. **Never hash the dehydrated form.** Identity, signatures, set membership, dedup, reconciliation digests — all are computed over canonical hydrated bytes, always. If a packed copy and a loose copy of the same delta could disagree about their own id, the CRDT element type fractures and union stops meaning union.
2. **Compression never dictates semantics.** Dehydration exploits the *common case* (member author equals manifest author; member timestamp near manifest timestamp; member covered by manifest signature) without ever mandating it. A delta whose fields diverge from its envelope is stored with explicit fields — less compactly, identically legally. Any pack format that cannot represent divergent members is non-conformant. (This is the guard against re-smuggling the container model: members are sovereign at L1; L0 merely bets that they usually travel in families.)

Operationally: unpacking rebuilds full claims and recomputes every id through the standard delta-construction path — a record that does not rehydrate to its canonical bytes fails the content-address check and the unpack MUST error. Divergent members carry explicit fields; the format cannot *not* represent them. Round-trip vectors include a divergent-author member and a multiply-claimed member.

## 3. Pack Format

A pack is **one canonical CBOR item in the Rhizomatic profile** (SPEC-1 §4.1): both witnesses
share the codec, identical delta sets produce identical pack bytes, and
`packId = contentAddress(pack bytes)` follows for free.

```
Pack = map {
  "version":   1,                  // the profile has no integer encoding: encodes as float (f9 3c00)
  "strings":   [tstr...],          // sorted unique string table — see below for order and contents
  "envelopes": [Record...],        // hydrated rhizomatic.txn manifests, sorted by manifest id
  "members":   [MemberRecord...],  // dehydrated members, sorted by member id
  "loose":     [Record...],        // hydrated deltas claimed by no stored manifest, sorted by id
}

Record       = map { "a": authorIdx, "i": idIdx, "t": timestamp, "p": [Ptr...], "s"?: sigIdx }
MemberRecord = map { "m": envelopeIdx, "i": idIdx, "p": [Ptr...],
                     "a"?: authorIdx,   // only when it differs from the manifest's (invariant 2)
                     "dt"?: number,     // timestamp minus manifest timestamp; omitted when 0
                     "s"?: sigIdx }     // stored whenever present (sigs are kept verbatim)
Ptr = map { "r": roleIdx, "e"|"d"|"s": idx | "n": number | "b": bool | ("m": mimeIdx, "y": bstr), "c"?: ctxIdx }
      // e=EntityRef id, d=DeltaRef hex, s=string primitive, n=number, b=bool;
      // m=mime string-table idx + y=raw bytes payload (a bytes target); c=context
```

Every record carries `"i"`, the delta's own id hex as a `strings` index — it is what the §4
rehydrate-and-verify fsck checks the recomputed multihash against. *(The grammar originally
omitted it while §4 presupposed it; found by the Elixir witness bring-up, issue #19 F2.)*

**The `strings` table** is sorted by the **bytewise lexicographic order of the raw UTF-8 string
bytes** — NOT by the encoded-CBOR-key order of SPEC-1 §4.1 D4, whose length head dominates; the
two orders differ whenever lengths differ (#19 F3). Its contents are exactly the strings the
records reference (#19 F4): every delta's own id hex (`"i"`), authors, roles, contexts,
EntityRef ids, DeltaRef hexes, string primitives, sig hexes, and mimes.

All indices are positions in `strings` (numbers in the profile's float encoding — small ints are
f16, so the cost is modest). Determinism is total: same delta set ⇒ same pack bytes ⇒ same packId.

A `Ptr` is a **bytes target** iff it carries `y` (with `m` required alongside it). The `mime`
interns into `strings` like every other string (mimes repeat and pack well); the payload `y`
rides as a raw `bstr`, **not** interned — payloads rarely repeat across pointers, and identical
payloads already dedup at the delta level. A bytes pointer carries no `c` (a literal is not a
vertex). The §4 rehydrate-and-verify fsck covers the new kind automatically: a record that does
not rebuild to its canonical delta bytes fails the content-address check.

### 3.1 Dehydration rules (MemberRecord)

Relative to the referencing manifest's envelope:

- `author` — omitted when equal to the manifest's author; else stored explicitly.
- `dt` — the member's timestamp minus the manifest's; omitted when 0.
- `sig` — stored verbatim whenever present (manifest coverage governs *transport* requirements,
  SPEC-1 §5, not storage).
- A member claimed by several manifests is stored once, dehydrated against the
  **lexicographically first** claiming manifest in the pack. Deltas whose claiming manifest is
  absent from the set are stored loose, fully hydrated.
- **Envelopes win** (#19 F6): a delta qualifies as a manifest for this section's partition iff it
  carries at least one pointer with role `rhizomatic.txn.member` **and** a DeltaRef target (the
  SPEC-1 §9 shape; a `rhizomatic.txn.member` pointer with a primitive target does not qualify).
  Every manifest in the set is stored hydrated in `envelopes`, never dehydrated — even when
  another manifest claims it as a member. (Member records point *at* envelope indices; a
  dehydrated envelope would make rehydration order-dependent.)
- *(Open, #19 F5: `dt` is f64 arithmetic and lossy for pathologically distant timestamps — a
  packer could emit a pack failing its own §4 fsck. See ERRATA-8.)*

### 3.2 Deferred physical conveniences

The random-access index (`deltaId → (section, offset)`), shared trained dictionaries
(`dictRef`, themselves content-addressed and federable like any blob), and ranged/partial reads
are deferred: packs currently decode wholesale in memory, so an index buys nothing. They return
when packs become reactor checkpoints over real I/O; nothing in the §2 invariants constrains
those additions.

## 4. The Rehydration Contract

For every delta in a pack:

```
hydrate(packRecord) → canonical CBOR bytes → multihash → MUST equal the stored deltaId
```

- Rehydration MUST be byte-exact. Verification on rehydrate is therefore free integrity checking (`fsck` for the rhizome); reactors SHOULD verify on extraction and MUST verify on federation receipt.
- Extraction of a single delta yields its full hydrated, self-contained form. If the extraction crosses a trust boundary and the delta is sig-less, the extractor attaches the covering manifest (or, in a future revision, a succinct Merkle path) — the delta travels with its proof (SPEC-1 §5).
- Conformance (Level 0 extension): implementations that read or write packs MUST pass round-trip vectors — `(delta set) → pack → (delta set)` with byte-identical canonical members and matching ids, including vectors with divergent-field members, multiply-claimed members, and dictionary-compressed primitives.

## 5. Repacking

Because the logical form is invariant, **repacking is a semantics-free operation**, performable at leisure, in the background, forever:

- **Write-optimized layout:** pack by transaction (arrival order) — the natural product of the ingest path.
- **Read-optimized layouts:** repack cold segments by entity (locality for `select(targetEntity)`), by schema relevance closure (one-pack index rebuilds), or by time (retention horizons, time-travel scans).
- Repacking MUST NOT alter, add, or drop any delta; the before/after delta sets MUST be equal. The pack id changes (it's a different physical object); the set digest (SPEC-6 §4) does not — which is precisely the distinction between physical and logical identity, made operational.

## 6. Roles a Pack Plays

One container, four duties (cf. HyperView's four duties, SPEC-3 §4 — the system likes this pattern):

1. **Cold archive** — the answer to SPEC-4 §8's compaction question: the log's old segments live as packs; "compaction" is repacking plus dictionary training, never deletion (P2 intact).
2. **Checkpoint freight** — reactor checkpoints (SPEC-4 §4.4) reference pack ids; restart is fetch-and-verify.
3. **Federation bundle at rest** — a BUNDLE (SPEC-6 §4) serializes naturally as a single-transaction pack; large syncs ship multi-transaction packs.
4. **Sneakernet** — a directory of packs plus dictionaries is a complete, verifiable, offline-transferable instance. Burying a USB stick is a valid backup strategy and, eventually, a valid federation event.

## 7. Interaction with Erasure (Flagged)

Packs complicate the already-hard erasure problem (SPEC-6 §7) in one way and help in another: content addressing pins bytes (harder), but the blob-indirection pattern composes cleanly with packs — encrypted payload blobs live in their own sections or files, and key destruction renders them noise *without* breaking any pack's structural rehydration (the deltas, hashes, and Merkle structure survive; the content does not). This remains the leading candidate for GDPR-class compliance and remains unproven.

## 8. Open Questions (L0)

- **Dictionary governance:** who trains shared dictionaries, how are they versioned, and is there a blessed bootstrap dictionary for the `rhizomatic.*` vocabularies shipped with the conformance suite?
- **Pack sizing & partial reads:** target sizes, index granularity for ranged/HTTP reads, and whether the index supports per-entity bloom filters for scan-skipping.
- **Succinct coverage proofs:** Merkle-path attachment for extracting one covered delta from a large transaction without shipping the whole manifest.
- **Encryption at rest:** whole-pack encryption vs. per-section, and interaction with `dictRef` (dictionaries leak vocabulary statistics).
- **Repacking + partitioned logs:** confirm set-digest invariance composes across partitions (relates to SPEC-4 §8).
