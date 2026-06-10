# Rhizomatic Specification — SPEC-8: Storage Profile (L0)

**Status:** Draft
**Layer:** L0 — physical representation
**Depends on:** SPEC-1 (canonical form, content addressing, `rdb.txn` manifests)

---

## 1. Purpose

L0 defines the **pack**: a physical container format for delta sets, exploiting transaction manifests to factor shared envelope metadata out of members at rest and rehydrate it on extraction. L0 exists because P2 (append-only forever) makes storage a compounding liability unless the format has a compression story that is *provably semantics-free*.

The governing fact that makes L0 safe is content addressing (P6): a delta's identity is the hash of its canonical hydrated bytes (SPEC-1 §4.1), so any physical representation that can reproduce those bytes exactly is a conformant storage of that delta. The hash is the contract; layout is freedom. This is git's loose-objects/packfiles split, adopted wholesale.

**L0 is invisible to L1 and everything above it.** No layer above L0 may behave differently based on whether a delta is currently loose or packed. There is exactly one logical form.

## 2. The Two Invariants

These are absolute; everything else in this document is implementation latitude.

1. **Never hash the dehydrated form.** Identity, signatures, set membership, dedup, reconciliation digests — all are computed over canonical hydrated bytes, always. If a packed copy and a loose copy of the same delta could disagree about their own id, the CRDT element type fractures and union stops meaning union.
2. **Compression never dictates semantics.** Dehydration exploits the *common case* (member author equals manifest author; member timestamp near manifest timestamp; member covered by manifest signature) without ever mandating it. A delta whose fields diverge from its envelope is stored with explicit fields — less compactly, identically legally. Any pack format that cannot represent divergent members is non-conformant. (This is the guard against re-smuggling the container model: members are sovereign at L1; L0 merely bets that they usually travel in families.)

## 3. Pack Format

A pack is a content-addressed file:

```
Pack {
  header:     { version, dictRef?: Hash }       // optional shared-dictionary reference
  strings:    StringTable                        // interned entity ids, roles, contexts
  envelopes:  ManifestRecord[]                   // hydrated rdb.txn manifests (these ARE deltas)
  members:    MemberRecord[]                     // dehydrated member deltas
  loose:      DeltaRecord[]                      // hydrated deltas claimed by no stored manifest
  index:      { deltaId → (section, offset) }   // random access without full scan
}
packId = multihash(canonical pack bytes)
```

### 3.1 Dehydration rules (MemberRecord)

Relative to the referencing manifest's envelope:

- `author` — omitted when equal to the manifest's author; else stored explicitly. (Presence bitmap per record.)
- `timestamp` — stored as a zigzag varint offset from the manifest timestamp; offset 0 is one byte.
- `sig` — omitted when the member is manifest-covered (SPEC-1 §5); else stored.
- `pointers` — roles, contexts, and entity ids replaced by string-table indices; primitive values stored canonically (or dictionary-compressed in bulk sections).
- A member claimed by multiple manifests is stored once, dehydrated against one (implementation's choice); the others reference it through the index.

### 3.2 Dictionaries

- The string table is per-pack and mandatory.
- `dictRef` MAY name a shared trained dictionary (e.g., zstd) for primitive-value sections — vocabulary strings and common values repeat across years of log; cross-pack dictionaries are where the long-term compression lives. Dictionaries are themselves content-addressed artifacts and MAY be federated like any blob (SPEC-6 §6). A pack MUST be decodable by a party holding the pack and its named dictionary, and nothing else.

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

- **Dictionary governance:** who trains shared dictionaries, how are they versioned, and is there a blessed bootstrap dictionary for the `rdb.*` vocabularies shipped with the conformance suite?
- **Pack sizing & partial reads:** target sizes, index granularity for ranged/HTTP reads, and whether the index supports per-entity bloom filters for scan-skipping.
- **Succinct coverage proofs:** Merkle-path attachment for extracting one covered delta from a large transaction without shipping the whole manifest.
- **Encryption at rest:** whole-pack encryption vs. per-section, and interaction with `dictRef` (dictionaries leak vocabulary statistics).
- **Repacking + partitioned logs:** confirm set-digest invariance composes across partitions (relates to SPEC-4 §8).
