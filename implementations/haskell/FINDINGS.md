# Findings — Haskell witness bring-up (issue #29)

The Elixir bring-up (#19) was a controlled experiment: build from `spec/` + `vectors/` alone and
record every place the suite failed to specify the next line of code. **This bring-up was not
that**, and says so up front: the agent had already read `implementations/elixir/CLAUDE.md` and
FINDINGS before writing a line, so it cannot testify about suite sufficiency from ignorance.
What it *can* testify to is the next-best thing, recorded here.

## H1 — The folded #19 lore was sufficient for first-try byte parity

Every #19 finding that was folded into normative text (F2 the `"i"` field, F3 the raw-UTF-8
strings-table order, F4 the table's exact contents, F6 envelopes-win, D13's five checks, D14's
blessed coercion point) was consumed **from the spec text only** — and the pack builder
reproduced `packHex` byte-for-byte on its first run, as did the CBOR encoder for all 56
primitive vectors and the Ed25519 signer for every pinned signature. Four witnesses in, the
spec + vectors are carrying new implementations to byte parity with no cross-reading of code.
The lockstep bet ("when they disagree, the spec was underspecified — fix the pin") appears to
have converged: this bring-up surfaced **no new underspecification** at L0.

## H2 — D15's divergence window is real and this witness sits at its far edge (RESOLVED by D16 — dissolved)

NFC validation here runs against tables generated from the build host's Python `unicodedata`
(UCD **14.0.0** — provenance pinned in the generated header). TS validates per Node's ICU
(Unicode 15.1), Rust per `unicode-normalization`'s tables, Elixir per OTP's. Per D15, a string
containing a code point **assigned after Unicode 14** that composes/reorders under newer tables
could be admitted here and refused by a newer-tabled witness. Unicode's stability policy keeps
every *assigned-in-14.0* code point convergent, so the practical surface is narrow, but this
witness widens the repo's table spread and is a concrete argument for D15 option (a) or (b)
over (c). **Postscript (2026-07-30, issue #36):** D15 resolved by *dissolution* — D16 demoted NFC to
authoring hygiene, and this witness deleted its tables entirely. The widest-spread datapoint H2
recorded became part of the argument for removing the question rather than answering it.

## H3 — A type system converts two of the repo's boundary tests into non-tests

Recorded as a data point for future strongly-typed witnesses: D14's native-term half ("reject
native integer terms at claim construction") and the text/bytes distinction both vanish as
runtime concerns — the claims AST has no `Integer` constructor and the CBOR AST separates
`TStr`/`BStr`, so the rejections are unrepresentable rather than tested-for. The per-witness
boundary test for D14 is therefore a one-line comment pointing at the type, plus the
vector-pinned profile half (`number-integer-spelling`). Nothing to fix; worth knowing when the
conformance docs say "add a boundary test" — in some hosts the honest answer is "the compiler
is the test".

## H4 — GHC's `fromRational` discharges the correctly-rounded-parse requirement

SPEC-1 §4.2 requires correctly-rounded JSON number parsing and the README warns most fast float
paths are 1 ULP off. In GHC, reading the token exactly into a `Rational` and converting via
`fromRational` (whose `fromRat` performs correctly-rounded scaling) passes every float vector
including `float-f16-min-subnormal`. Slow, and irrelevant at vector scale. A future
performance-minded Haskell consumer swapping in a fast parser must re-run the float vectors —
they exist precisely to catch that swap.

## H5 — Primary composites are derivable without CompositionExclusions.txt

Generator note, useful to any witness hand-rolling NFC from a host that exposes normalization
but not the exclusion list: a code point X with a 2-char canonical decomposition is a primary
composite **iff** `NFC(NFD(X)) == X`. The four exclusion classes (script-specific,
post-composition, singletons, non-starter decompositions) are exactly the X that fail that
round-trip, so the composition table falls out of `unicodedata` alone (941 pairs under UCD
14.0.0, matching the spec'd exclusion counts). *(Historical as of D16 — the kernel no longer
performs NFC — but the derivation trick stands for any consumer-layer normalizer.)*
