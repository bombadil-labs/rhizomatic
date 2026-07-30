# Rhizomatic — Haskell witness (Level 0)

The fourth witness (issue #29). Built from `spec/` + `vectors/` — but **not** a clean-room
sufficiency experiment like the Elixir bring-up (#19): the agent that wrote it had read the
Elixir witness's FINDINGS and gotchas first. It is a full conformance witness; it just cannot
testify about whether the suite alone would have sufficed. See [FINDINGS.md](FINDINGS.md).

Conformance level: **0** (SPEC-0 §5.1, Format) — parse, canonically serialize, content-address,
sign/verify, pack. See [witness.json](witness.json). L1+ only when a consumer needs it.

## Commands

```
node check.mjs    # the whole green-gate: ghc -Wall -Werror compile + run (loads ../../vectors/)
```

Requires GHC ≥ 9.4 on PATH (boot packages only: base, bytestring, containers, text) and Node
(launcher only, for cross-platform paths). No cabal, no deps, no network.

## Layout

```
src/Rhizomatic/
  Json.hs           hand-rolled JSON parser for vectors + the SPEC-1 §4.2 debug profile;
                    correctly-rounded doubles (exact Rational -> fromRational), duplicate
                    keys rejected
  Cbor.hs           canonical deterministic CBOR: tagged AST (TStr|BStr|Num|Bool'|Arr|Map),
                    shortest-float ladder incl. f16 subnormals, -0.0 -> +0.0; decoder
                    enforces canonicality by re-encode byte-compare
  Blake3.hs         hand-rolled BLAKE3-256 (chunk tree + parents), reference-cross-checked
  Sha512.hs         FIPS 180-4, for Ed25519
  Ed25519.hs        Integer-field Edwards arithmetic; RFC 8032 deterministic signing; the
                    SPEC-1 §5.1 five-check STRICT verifier transcribed from the spec text
                    (D13) — never a library default
  Base64Url.hs      canonical unpadded base64url (reject, never repair)
  Hex.hs            lowercase hex at boundaries
  Nfc.hs            NFC validation by full normalize-and-compare (UAX #15)
  UnicodeTables.hs  GENERATED — ccc / decompositions / primary composites (see gen/)
  Delta.hs          typed Claims/Pointer/Target AST, boundary validation, canonical bytes, id
  Profile.hs        JSON debug profile -> Claims; closed profile (issue #25), the ONE blessed
                    int-token -> float point (D14)
  Signer.hs         author↔key match on sign; verify = id recomputes, then strict Ed25519
  SetDigest.hs      provisional D10 membership digest
  Pack.hs           SPEC-8 L0 pack: byte-deterministic build + fsck-on-unpack
test/Main.hs        one suite per vector family + boundary tests; Harness.hs is the runner
gen/                gen_unicode_tables.py — regenerates UnicodeTables.hs (committed output)
```

## Conventions (this witness)

- **Reject, never repair** at every boundary; errors are `Either String`, never coerced values.
- **The type system carries the boundary where it can.** D14's native-integer hazard is
  unrepresentable: a claims number is only ever a `Double` — there is no constructor accepting
  `Integer`, so no native integer term can reach claim construction. Likewise `TStr` vs `BStr`
  makes the text/bytes distinction explicit in the CBOR AST.
- Zero dependencies beyond GHC boot packages, and **all crypto hand-rolled** (BLAKE3, SHA-512,
  Ed25519 sign *and* verify) — GHC has no bundled crypto, so unlike the Elixir witness there is
  no library-signing/hand-verify split; both directions are transcriptions of their specs.
  Correctness over speed everywhere; the whole suite runs in well under a second compiled.
- Pure functions, no I/O in `src/`; only the test harness touches the filesystem.
- NFC tables are generated from the build host's Python `unicodedata` (UCD version pinned in
  the generated header — ERRATA D15). Regenerate only deliberately: `cd gen && python3
  gen_unicode_tables.py ../src/Rhizomatic/UnicodeTables.hs`, then rerun the green-gate.

## Gotchas learned during bring-up

- `fromRational :: Rational -> Double` in GHC is correctly rounded, which makes exact-decimal →
  Rational → Double a sound (if slow) correctly-rounded JSON number parse. The
  `float-f16-min-subnormal` vector and a direct 2^-24 assertion guard it.
- The CBOR decoder's canonicality enforcement is one line — decode structurally, re-encode,
  compare bytes — but the **duplicate-map-key check must still be explicit**: a map whose
  duplicate keys arrive already sorted re-encodes to the same bytes and would slip through.
- BLAKE3's unbalanced tree rule (left subtree = largest power of two < total chunks) is easy to
  get right and easy to *believe* you've gotten wrong: cross-check against the reference
  implementation's digests, not remembered ones.
