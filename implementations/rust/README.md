# rhizomatic

The Rust reference implementation of **Rhizomatic** — a portable format for arbitrarily relational
data: composable, forkable, mergeable, and federatable by default.

- Every fact is a **signed, content-addressed delta** (an author's claim at a time).
- **Merge is union** — a grow-only set CRDT; any interleaving of the same deltas converges.
- **Truth is not stored; it is resolved per-reader** under a trust policy. Provenance and
  time-travel are intrinsic.

This is **one of two parallel witnesses** to the [specification](https://github.com/mbilokonsky/rhizomatic/tree/main/spec)
(the other is the npm package [`@rhizomatic/core`](https://www.npmjs.com/package/@rhizomatic/core)).
Both pass the same [conformance vectors](https://github.com/mbilokonsky/rhizomatic/tree/main/vectors)
byte-for-byte — the canonical CBOR encoder, content addresses, and signatures reproduce across both,
exactly. The crate also builds to `wasm32-unknown-unknown`, which is how the
[interactive tour](https://mbilokonsky.github.io/rhizomatic/) runs the Rust witness in your browser
next to the TypeScript one.

## Install

```sh
cargo add rhizomatic
```

## API

The Rust surface mirrors the TypeScript witness module-for-module (canonical bytes, content
addressing, delta-set algebra, the operator evaluator, resolution policies, packs, the reactor,
federation, and derivation). See the [spec](https://github.com/mbilokonsky/rhizomatic/tree/main/spec)
for what each layer means, and the crate's tests for worked usage against the shared vectors.

## License

Dual-licensed under either of [MIT](https://github.com/mbilokonsky/rhizomatic/blob/main/LICENSE-MIT)
or [Apache-2.0](https://github.com/mbilokonsky/rhizomatic/blob/main/LICENSE-APACHE), at your option.
