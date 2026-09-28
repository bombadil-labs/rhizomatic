# Rust Implementation — Working Notes

One of two parallel witnesses to the Rhizomatic spec (the other is [`../ts`](../ts)).
Read the root [../../CLAUDE.md](../../CLAUDE.md) first — the workflow loop and parity contract
govern here. This file is only the Rust-specific usage patterns.

## Stack

- **Rust, edition 2021.** Use the host's stable rustup toolchain. CI checks the Linux host build
  and the browser WASM target; the Windows GNU setup below is for Windows workstations only.
- **blake3** for hashing and **ed25519-dalek** for signatures. Crypto primitives we *consume*.
- **serde / serde_json + hex** only for loading the shared JSON vectors in tests.
- The canonical CBOR encoder is **hand-rolled** (`src/cbor.rs`), not `ciborium`/`serde_cbor` — it must
  reproduce the TypeScript encoder byte-for-byte, and the only way to guarantee that is to own both.

## Commands

Run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` before
committing. On Linux, install through rustup if needed and put `~/.cargo/bin` on `PATH`.
On the Windows workstation where rustup lives under scoop, use this setup (PowerShell):

```powershell
$env:RUSTUP_HOME = "$env:USERPROFILE\scoop\persist\rustup\.rustup"
$env:CARGO_HOME  = "$env:USERPROFILE\scoop\persist\rustup\.cargo"
$env:PATH = "$env:CARGO_HOME\bin;$env:USERPROFILE\scoop\apps\gcc\current\bin;$env:PATH"
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The Windows GNU target also needs gcc on `PATH`; scoop registered it as a PATH entry rather than
a shim.

### The WASM witness

The crate also builds for `wasm32-unknown-unknown` (cdylib) so the interactive tour
(`docs/`) can run the Rust witness in the browser next to the TypeScript one:

```powershell
rustup target add wasm32-unknown-unknown   # once
cargo build --release --target wasm32-unknown-unknown
Copy-Item target\wasm32-unknown-unknown\release\rhizomatic.wasm ..\..\docs\rust-witness.wasm
```

The ABI lives in `src/wasm.rs` (JSON request/response over a hand-rolled (ptr, len)
interface — no wasm-bindgen). `src/http.rs` is host-only (`#[cfg]`-gated); CI builds and
clippy-checks the wasm target on every push.

## Conventions

- **Bytes are `Vec<u8>`/`&[u8]` internally; hex `String` only at boundaries** (vectors, ids, sigs).
- **No `unsafe`. Pure functions, no I/O in the core** (L0–L2). Tests may read `../../vectors`.
  The single exception: `src/wasm.rs` may use `unsafe` for raw-pointer marshaling at the WASM
  boundary — and nowhere else.
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
