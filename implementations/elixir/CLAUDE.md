# Rhizomatic — Elixir witness (Level 0)

The third witness. Built **from `spec/` + `vectors/` only** (issue #19's experiment: is the
conformance suite sufficient to conform to?) — no file under `implementations/ts`,
`implementations/rust`, or `docs/` was consulted. What that surfaced lives in
[FINDINGS.md](FINDINGS.md); keep it current if you extend this witness.

Conformance level: **0** (SPEC-0 §5.1, Format) — parse, canonically serialize, content-address,
sign/verify, pack. See [witness.json](witness.json). L1+ only when a consumer needs it.

## Commands

```
mix test          # the whole conformance suite; loads ../../vectors/ directly
mix format        # standard formatter, config in .formatter.exs
```

Requires Elixir ≥ 1.18 (built-in `JSON`) on OTP ≥ 27. No deps — `mix test` needs no
`deps.get`, no network, no NIF toolchain.

## Layout

```
lib/rhizomatic/
  cbor.ex        canonical deterministic CBOR (RFC 8949 §4.2.1 profile): tagged AST
                 {:tstr,_}|{:bstr,_}|{:float,_}|{:bool,_}|{:arr,_}|{:map,_}, hand-rolled
                 f16/f32 shortest-float ladder (incl. subnormals), validating decoder
  blake3.ex      pure-Elixir BLAKE3-256 (external standard; boring transcription)
  hash.ex        multihash content address (0x1e 0x20 + digest; lowercase hex at boundaries)
  base64url.ex   canonical unpadded base64url decode/encode (reject, never repair)
  delta.ex       claims boundary validation + canonical bytes + id (SPEC-1 §2/§4.1)
  profile.ex     JSON debug profile parser (SPEC-1 §4.2) — the ONE blessed int→float point
  ed25519.ex     signing via :crypto; §5.1 five-check STRICT verification hand-rolled
                 (pure-Elixir Edwards arithmetic — never a library's default verifier)
  signer.ex      author↔key match on sign; verify = id recomputes, then strict Ed25519
  set_digest.ex  provisional D10 membership digest
  pack.ex        SPEC-8 L0 pack: build (byte-deterministic) + unpack (fsck on every record)
test/            one file per vector family + boundary_test.exs (D14 native-int, D11 NFC)
test/support/vectors.ex   loads ../../vectors/*.json via built-in JSON
```

## Conventions (this witness)

- **Reject, never repair** at every boundary; errors are tagged tuples, never coerced values.
- **Tagged CBOR AST**, not raw Elixir terms: on the BEAM a binary can't say whether it is text
  or bytes, and `42`/`42.0` are distinct terms — the AST makes both distinctions explicit.
  D14 is enforced twice: `Delta.validate` rejects native integer terms; `Cbor.encode` only
  accepts `{:float, f}` with an actual float.
- **NFC** via OTP's `:unicode` tables (see FINDINGS F9 / SPEC-1 ERRATA D15).
- Pure functions, no I/O in `lib/`; only tests touch the filesystem.
- Crypto split: OTP `:crypto` for Ed25519 *signing* + SHA-512 (deterministic, criterion-free);
  verification and BLAKE3 are hand-rolled from their specs. Correctness over speed everywhere.

## Gotchas learned during bring-up

- The pack record layout is pinned by `vectors/l0-pack/pack.json`'s bytes, which carry more
  than SPEC-8 §3's grammar says (the `"i"` id field; strings-table sort order; `version` as a
  float). Trust the vector; see FINDINGS F2–F4 before touching `pack.ex`.
- The strings table sorts by **raw** UTF-8 byte order; CBOR **map keys** sort by *encoded*
  bytes (length head first). Two different orders — don't unify them.
- ExUnit fixture strings that must be non-NFC are written as explicit UTF-8 byte literals
  (`<<?e, 0xCC, 0x81>>`) so no editor or tool can silently normalize them.
