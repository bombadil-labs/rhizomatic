# Rust Implementation — Working Notes

One of two parallel witnesses to the Rhizomatic spec (the other is [`../ts`](../ts)).
Read the root [../../CLAUDE.md](../../CLAUDE.md) first — the workflow loop and parity contract
govern here. This file is only the Rust-specific usage patterns.

## Stack

- **Rust, edition 2021.** On this machine the toolchain is the **GNU** target
  (`stable-x86_64-pc-windows-gnu`, installed via scoop with gcc as the linker) — no MSVC dependency.
- **blake3** crate for hashing; later **ed25519-dalek** for signatures. Crypto we *consume*.
- **serde / serde_json + hex** only for loading the shared JSON vectors in tests.
- The canonical CBOR encoder is **hand-rolled** (`src/cbor.rs`), not `ciborium`/`serde_cbor` — it must
  reproduce the TypeScript encoder byte-for-byte, and the only way to guarantee that is to own both.

## Commands

cargo is installed under scoop's rustup persist dir and is **not on the default PATH** in fresh
shells. Prefix cargo invocations with this env setup (PowerShell):

```powershell
$env:RUSTUP_HOME = "$env:USERPROFILE\scoop\persist\rustup\.rustup"
$env:CARGO_HOME  = "$env:USERPROFILE\scoop\persist\rustup\.cargo"
$env:PATH = "$env:CARGO_HOME\bin;$env:USERPROFILE\scoop\apps\gcc\current\bin;$env:PATH"
cargo fmt           # format; `cargo fmt --check` to verify (run before every commit)
cargo clippy --all-targets -- -D warnings
cargo test          # conformance + property + unit tests
cargo build
```

The green-gate before committing a slice: `cargo fmt --check` + `cargo clippy -- -D warnings` + `cargo test` all clean.

The gcc bin dir on PATH is required — the GNU toolchain links via `gcc`/`ld`, and scoop registered
it as a PATH entry rather than a shim.

## Conventions

- **Bytes are `Vec<u8>`/`&[u8]` internally; hex `String` only at boundaries** (vectors, ids, sigs).
- **No `unsafe`. Pure functions, no I/O in the core** (L0–L2). Tests may read `../../vectors`.
- Reject illegal input at construction (return `Result`, never panic on bad data): NaN/±Infinity,
  empty pointer lists, empty role/context (SPEC-4 §2: reject, never repair).
- Boring over clever at L0–L2. This code should be re-readable by a TypeScript author — mirror the
  module names and function names of `../ts` where it aids cross-reading.

## Layout

```
src/
  lib.rs      public surface
  types.rs    Delta, Claims, Pointer, EntityRef, DeltaRef, Primitive
  cbor.rs     deterministic CBOR encoder (must match ../ts/src/cbor.ts)
  hash.rs     BLAKE3-256 + multihash wrapping
  delta.rs    canonical bytes, id computation, delta-set ops
tests/
  cbor.rs       encoder vs. external ground-truth (RFC 8949 Appendix A)
  vectors.rs    loads ../../vectors/l0-delta and asserts byte-exact parity
```
