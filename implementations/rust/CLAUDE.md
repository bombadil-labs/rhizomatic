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
  store.rs    the SPEC-18 store interface: synchronous traits, profile, errors, `scope_source`
  memory_store.rs       the memory reference store; every map sits behind one counting door
  store_open.rs         `StoreSchemes` and `open_store` (errors name the scheme, never the URL)
  store_conformance.rs  `run_store_conformance`: the shared store vectors against any store
  store_read.rs         the store-backed read (reactor boundary): rounds over one snapshot with a
                        fetch cache and an evaluation memo, `fetch_scope`, `StoreReactor`, and
                        the explicit `read_full_surface` through a peer exporter
tests/          each file is a module of a test program, almost always witness.rs (AGENTS.md, "Build size");
                run one with `cargo test cbor::`
  witness.rs    the test program: one `mod` line per file
  private_source.rs  the second program, for tests that compile private src/ files as modules
  cbor.rs       encoder vs. external ground-truth (RFC 8949 Appendix A)
  vectors.rs    loads ../../vectors/l0-delta and asserts byte-exact parity
  store_vectors.rs  every script and scope case of ../../vectors/store on the memory store
  store_broken.rs   stores with one fault each; the conformance runner must fail each one
  store_runner.rs   the conformance runner's own rules, against a class-proven stand-in store
  store_runner_rules.rs  the runner-rules table: one wrong store per runner rule (README §8)
  store_feed_rules.rs    the change-feed rules table (README §3.9, §8), broken feeds, controls
  store_feed.rs     the memory store's feed where the vectors cannot reach: bounds, options, purged ids
  store_cost.rs     the cost rail: index work does not grow with unrelated deltas; nothing scans;
                    building a scope source, a feed window read and appends under bounded
                    retention scale linearly, timed at N and 8N
  store_open.rs     schemes, requirements, close, and an anchored read over a fetched scope
  store_rounds.rs   every case of ../../vectors/store/rounds.json read five ways, wrong readers,
                    wrong memos, what the memo saves, cost
                    the memo count a read reports, the full-surface read
  store_read_families.rs  the existing read families a second time through a memory store
  reactor_deprecations.rs  the whole-set Reactor methods are deprecated; the crate forbids their use
```
