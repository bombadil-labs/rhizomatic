# Findings — bringing up the Elixir witness from `spec/` + `vectors/` only

Issue #19's experiment: is the conformance suite sufficient to conform to? This file records
every place the suite underspecified the next line of code, the reading taken, and the proposed
fix — plus the places peeking was most tempting, which mark exactly where the suite is thinnest.

Rules honored: no file under `implementations/ts`, `implementations/rust`, `docs/`, `PROGRESS.md`,
or `CHANGELOG.md` was read. Sources: `spec/**`, `vectors/**`, and this directory.

## F1 — `vectors/l0-pack/pack-bytes.json` does not exist

`vectors/README.md` documents it twice (the layout table and the bytes-target section:
"`l0-pack/pack-bytes.json` pins the pack round-trip (two bytes deltas sharing one mime → the `m`
intern + raw `y`, SPEC-8)"), and issue #19's definition of done names it — but the file is absent
from the repo. The bytes-target pack path (`Ptr = { "m": mimeIdx, "y": bstr }`) is therefore
specified in SPEC-8 §3 prose but pinned by **no vector**.

**Reading taken:** implemented `m`/`y` exactly per SPEC-8 §3 (mime interned into `strings`,
payload as a raw un-interned `bstr`, no `c`), exercised only by this witness's own unpack path.
**Fix:** generate and commit the promised vector (or drop the README references).

## F2 — SPEC-8 §3's record grammar omits the stored delta id (`"i"`)

The spec's grammar reads:

> `Record = map { "a": authorIdx, "t": timestamp, "p": [Ptr...], "s"?: sigIdx }`
> `MemberRecord = map { "m": envelopeIdx, "p": [Ptr...], "a"?: authorIdx, "dt"?: number, "s"?: sigIdx }`

but the pinned `pack.json` bytes carry an additional `"i"` field in **every** record (envelope,
member, loose): the delta's own id hex as a `strings` index. §4's rehydration contract already
presupposes it ("multihash → MUST equal **the stored deltaId**" — nothing else in the §3 grammar
stores one). Without `"i"`, the §4 fsck would have nothing to check against and unpack could not
detect corruption. The grammar and the vector disagree; the vector (and §4) are clearly right.

**Reading taken:** reverse-engineered from `pack.json`:
`Record = { "a", "i", "t", "p", "s"? }`, `MemberRecord = { "m", "i", "p", "a"?, "dt"?, "s"? }`.
**Fix:** add `"i": idIdx` to both record grammars in SPEC-8 §3.

This is also where peeking was most tempting: the first attempt at reproducing `packHex` from the
§3 grammar alone could never have succeeded, and the only non-peek disambiguator was hand-decoding
the vector's CBOR. The pack layout is the thinnest part of the suite.

## F3 — the `strings` table's sort order is unstated (two plausible orders exist in-repo)

SPEC-8 §3 says "sorted unique string table" without naming the order. The repo contains **two**
different canonical orders: raw bytewise-lexicographic and the CBOR map-key order of SPEC-1 §4.1
D4 (bytewise over *encoded* keys, where the length head dominates, so `"loose"` < `"members"` <
`"envelopes"`). They disagree whenever lengths differ.

**Reading taken:** raw bytewise order of the UTF-8 string bytes, confirmed against `pack.json`
(all `1e20…` ids sort before the `6adb…` sig, `"John Wick"` before lowercase entries, etc.).
**Fix:** one clause in SPEC-8 §3: "sorted by the bytewise lexicographic order of the UTF-8
string bytes."

Same gap, smaller: §3's `"version": 1` reads like an integer, but the profile has no integer
encoding — the vector encodes it `f93c00` (float 1.0). Worth a parenthetical, since a fresh
reader's first guess for a version field is a uint head (`0x01`).

## F4 — which strings intern is a comment, and it is incomplete

The §3 comment lists "roles, ids, authors, contexts, delta-ref hexes, string primitives, sig
hexes" — "ids" is doing double duty (entity ids? delta ids?). From the vector: **every** delta's
own id hex interns (the `"i"` fields), plus entity-ref ids, delta-ref hexes, authors, roles,
contexts, string primitives, sig hexes, and (per §3 prose) mimes. **Fix:** enumerate the
interned string sources normatively once `"i"` lands in the grammar (F2).

## F5 — MemberRecord has no absolute-timestamp escape hatch (`dt` can be lossy in principle)

Dehydration stores `dt = member.timestamp − manifest.timestamp` and rehydrates
`manifest.timestamp + dt`. Both are f64 operations; for pathologically distant timestamps the
subtraction is inexact and `manifest.t + dt` need not bit-equal `member.t` — at which point the
§4 fsck fails **on a pack the packer itself produced**, with no way to represent the member
except outside its manifest. Invariant 2 says "a delta whose fields diverge from its envelope is
stored with explicit fields", but the MemberRecord grammar has no explicit absolute `t`
alternative to `dt`.

**Reading taken:** not exercised by any vector, and unreachable for realistic
milliseconds-since-epoch values; implemented plain f64 arithmetic. **Fix:** either add an
optional absolute `"t"` to MemberRecord (mirroring the optional `"a"`), or state normatively
that a packer MUST verify `manifest.t + (member.t − manifest.t) == member.t` and store the
member loose otherwise.

## F6 — a manifest claimed by another manifest: envelope or member?

SPEC-8 §3 partitions deltas into envelopes (manifests), members (claimed), and loose (claimed by
no stored manifest) — but a manifest can itself be claimed by another manifest's
`rhizomatic.txn.member` pointer (SPEC-1 §9 allows it: members are sovereign deltas). The
partition is then ambiguous: dehydrate the claimed manifest as a member, or keep it hydrated in
`envelopes`? `pack.json` does not exercise the case (its second manifest references the first
via `rhizomatic.txn.prior`, which is not membership).

**Reading taken:** envelopes win — every manifest in the set is stored hydrated in `envelopes`,
never dehydrated, because member records point *at* envelope indices and a dehydrated envelope
would make rehydration order-dependent. **Fix:** one sentence in §3.1, plus a vector with a
manifest-claiming-a-manifest.

Related edge, also unpinned: what makes a delta a "manifest" for §3's purposes. Reading taken:
at least one pointer with role `rhizomatic.txn.member` **and** a DeltaRef target (per the SPEC-1
§9 shape); a `rhizomatic.txn.member` pointer with a primitive target does not qualify.

## F7 — README drift: the "one signed case" of the bytes vectors

`vectors/README.md`'s bytes-target section says the `deltas-bytes.json` envelope includes "a
`keyId`+`sig` on the one signed case" and lists "one signed case" under coverage — but no entry
in `deltas-bytes.json` carries a signature; the signed bytes case (`signed-bytes-icon`) lives in
`deltas-signed.json`. Harmless, but a fresh witness goes looking for a field that isn't there.
**Fix:** point the README at `deltas-signed.json` for the signed bytes case.

## F8 — JSON number parsing: the suite checks the guarantee only implicitly

SPEC-1 §4.2 requires correctly-rounded JSON number parsing and the README warns a 1-ULP-off fast
path "is caught in practice by the `float-f16-min-subnormal` vector". True — but only if the
witness compares the *parsed* value against an independently constructed one. This witness
trusts Elixir's built-in `JSON` (OTP's parser) and added an explicit test that the parsed
`5.960464477539063e-8` equals `:math.pow(2, -24)` exactly. Not a spec gap so much as a note:
the vector catches the error via downstream byte mismatch, which is a confusing first failure
mode; a witness bring-up note suggesting the direct check would save the next implementer an
hour of staring at CBOR hex.

## F9 — D15 (Unicode version behind NFC) — nothing new, one data point

SPEC-1 ERRATA D15 is already open on whose Unicode tables answer "is this NFC?". This witness
uses OTP 29's `:unicode` tables. No divergence observed on any vector (the vectors stick to
well-assigned code points), so the seam stays theoretical here; recorded only so the D15 table
census is complete.

## Where peeking was tempting (the thinness map)

1. **The pack record layout** (F2/F3/F4) — by far. The §3 grammar alone cannot reproduce
   `packHex`; the vector's bytes are the real spec. Everything else at L0 was implementable
   from the spec text with the vectors as confirmation rather than as source.
2. **The five-check verifier's point-decompression details** — SPEC-1 §5.1 says
   "decompress → recompress reproduces the bytes" but not which decompression (RFC 8032
   §5.1.3's or a lenient one); the two agree everywhere except error paths, and the vectors
   (`noncanonical-pubkey-y-geq-p`, `signbit-pubkey`) pinned the answer well. Adequate, but only
   because the edge vectors exist.
3. **Expected envelope/member/loose counts** in `pack.json` — the file pins bytes, not the
   intermediate partition; a `packJson`-style debug rendering next to `packHex` would let a
   witness localize a mismatch without decoding CBOR by hand.

## F10 — This witness was already fail-closed on keys; the two older witnesses were not (issue #25)

Added 2026-07-19, after the fact — the finding was produced by this witness's *existence* rather
than by its bring-up.

When issue #25 tightened parsing across the repo (unknown object keys and ambiguous target
discriminators become rejections, SPEC-2 §8 / SPEC-1 §4.2, ERRATA-2 E19), all eight new L0 vectors
passed here **before this witness was touched**. It had been closed by construction since day one:
arity guards on `claims` and `pointer`, explicit key-set subtraction on each target arm. Reading
the spec cold, leniency never suggested itself.

TS and Rust — both written by the hand that wrote the spec — silently dropped unknown keys and
resolved multi-discriminator targets by declaration order, because SPEC-1 §4.2 said "first match
wins" and SPEC-2 §8 enumerated only *tags*. The laxity was in the spec, and the two witnesses that
grew up alongside it inherited it invisibly.

This is the #19 experiment paying out in the direction nobody planned for. The thesis was "a third
witness will expose places the conformance suite is insufficient to conform to." What it actually
exposed was a place the suite was *permissive enough to encode a bad habit* — and the outsider,
having no habit, was stricter and right. Worth remembering that the value of an independent
witness is not only the failures it reports.

(One real defect did surface here under review: the ambiguity *diagnosis* still reflected
first-match-wins — `{"id": …, "delta": …}` was reported as an entity ref carrying a stray key
rather than as a target with no kind. Rejected either way, so the accept/reject boundary never
moved, but the error named the wrong finding. Fixed in the same change.)
