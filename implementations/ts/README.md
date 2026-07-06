# @bombadil/rhizomatic

The TypeScript reference implementation of **Rhizomatic** — a portable format for arbitrarily
relational data: composable, forkable, mergeable, and federatable by default.

- Every fact is a **signed, content-addressed delta** (an author's claim at a time).
- **Merge is union** — a grow-only set CRDT; any interleaving of the same deltas converges.
- **Truth is not stored; it is resolved per-reader** under a trust policy. Disagreement lives in
  superposition until a policy picks. Provenance and time-travel are intrinsic.

This is **one of two parallel witnesses** to the [specification](https://github.com/mbilokonsky/rhizomatic/tree/main/spec)
(the other is a [Rust witness](https://github.com/mbilokonsky/rhizomatic/tree/main/implementations/rust)
in the same repo). Both pass the same
[conformance vectors](https://github.com/mbilokonsky/rhizomatic/tree/main/vectors), byte-for-byte —
determinism is the contract. See it run in the [interactive tour](https://mbilokonsky.github.io/rhizomatic/).

## Install

```sh
npm install @bombadil/rhizomatic
```

## Quick taste

```ts
import { authorForSeed, signClaims, verifyDelta, DeltaSet } from "@bombadil/rhizomatic";

const seed = "00".repeat(32); // 32-byte hex seed — use real randomness in practice
const author = authorForSeed(seed);

// A delta is a signed set of pointers: an author's claim, content-addressed by its canonical bytes.
const delta = signClaims(
  {
    timestamp: 0,
    author,
    pointers: [{ role: "name", target: { kind: "primitive", value: "Ada" } }],
  },
  seed,
);

verifyDelta(delta); // "verified" (content address holds + signature checks out)

const world = new DeltaSet();
world.add(delta); // deduped by id; merge two DeltaSets and you get their union
```

The public surface also covers the operator algebra (`evalTerm`), schemas, resolution policies
(`resolveView`), packs (`packSet`/`unpackSet`), the reactor, federation (`Peer`), and derivation.
See the [spec](https://github.com/mbilokonsky/rhizomatic/tree/main/spec) for what each layer means.

## License

Dual-licensed under either of [MIT](https://github.com/mbilokonsky/rhizomatic/blob/main/LICENSE-MIT)
or [Apache-2.0](https://github.com/mbilokonsky/rhizomatic/blob/main/LICENSE-APACHE), at your option.
