# ERRATA & Decisions — SPEC-8 (Storage Profile / Packs)

## P1 — v0 pack format: canonical CBOR, deterministic, content-addressed

SPEC-8 §3 sketches sections but no byte layout. v0 encodes the whole pack as **one canonical CBOR
item in the Rhizomatic profile** (ERRATA-1): both witnesses share the codec, identical delta sets
produce identical pack bytes, and `packId = contentAddress(pack bytes)` for free.

```
Pack = map {
  "version":   1,
  "strings":   [tstr...],          // sorted unique string table (roles, ids, authors, contexts,
                                   //  delta-ref hexes, string primitives, sig hexes)
  "envelopes": [Record...],        // hydrated rdb.txn manifests, sorted by manifest id
  "members":   [MemberRecord...],  // dehydrated members, sorted by member id
  "loose":     [Record...],        // hydrated deltas claimed by no stored manifest, sorted by id
}

Record       = map { "a": authorIdx, "t": timestamp, "p": [Ptr...], "s"?: sigIdx }
MemberRecord = map { "m": envelopeIdx, "p": [Ptr...],
                     "a"?: authorIdx,   // only when it differs from the manifest's (invariant 2)
                     "dt"?: number,     // timestamp minus manifest timestamp; omitted when 0
                     "s"?: sigIdx }     // stored whenever present (v0 stores sigs verbatim)
Ptr = map { "r": roleIdx, "e"|"d"|"s": idx | "n": number | "b": bool, "c"?: ctxIdx }
      // e=EntityRef id, d=DeltaRef hex, s=string primitive, n=number, b=bool; c=context
```

All indices are positions in `strings` (numbers in the profile's float encoding — small ints are
f16, so the cost is modest). A member claimed by several manifests is stored once, dehydrated
against the **lexicographically first** claiming manifest in the pack. Deltas whose claiming
manifest is absent from the set are stored loose.

## P2 — The two invariants, operationalized

- **Never hash the dehydrated form** (SPEC-8 §2.1): unpacking rebuilds full claims and recomputes
  every id through the standard `makeDelta` path — a record that does not rehydrate to its
  canonical bytes fails the content-address check and the unpack errors.
- **Compression never dictates semantics** (§2.2): divergent members carry explicit `a`/`dt`
  fields; the format cannot *not* represent them. Round-trip vectors include a divergent-author
  member and a multiply-claimed member.

## P3 — Deferred physical conveniences

The random-access index (`deltaId -> (section, offset)`), shared dictionaries (`dictRef`), and
ranged/partial reads are deferred: v0 packs decode wholesale in memory, so the index buys nothing
yet. They return when packs become reactor checkpoints over real I/O. Repacking is trivially
semantics-free in v0 because pack bytes are a pure function of the delta set (same set ⇒ same
bytes; the spec's repacking latitude becomes interesting only with physical layout choices).
