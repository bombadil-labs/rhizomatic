# TypeScript Implementation — Working Notes

One of two parallel witnesses to the Rhizomatic spec (the other is [`../rust`](../rust)).
Read the root [../../CLAUDE.md](../../CLAUDE.md) first — the workflow loop and parity contract
govern here. This file is only the TS-specific usage patterns.

## Stack

- **Node 22**, TypeScript, **ESM** (`"type": "module"`).
- **vitest** as the test runner (handles TS via esbuild — no separate build step for tests).
- **@noble/hashes** for BLAKE3 (pure JS, audited, zero native deps) and, later, Ed25519 via
  `@noble/curves`. Crypto primitives we *consume*; everything else we write ourselves.
- The canonical CBOR encoder is **hand-rolled** (`src/cbor.ts`), not a library — total control over
  determinism is the whole point, and it must match Rust byte-for-byte.

## Commands

```
npm install          # once
npm run check        # format:check + lint + typecheck + test (run this before every commit)
npm test             # vitest run — conformance + property + unit tests
npm run typecheck    # tsc --noEmit, strict
npm run lint         # eslint (correctness); lint:fix to autofix
npm run format       # prettier --write; format:check to verify
```

`npm run check` is the green-gate: it must pass before a slice is committed.

## Conventions

- **Bytes are `Uint8Array` internally; hex strings only at boundaries** (vectors, ids, signatures).
- **Pure functions, no I/O in the core.** The L0–L2 modules never touch the filesystem, clock, or
  network. Tests may read `../../vectors`.
- Strict TypeScript. No `any` in committed code. Named exports only.
- Boring over clever at L0–L2 (SPEC layers). This code should be re-readable by a Rust author.
- Reject illegal input at construction (NaN/±Infinity numbers, empty pointer lists, empty role/context
  strings) — fail loud, never repair (SPEC-4 §2: "Invalid deltas MUST be rejected, never repaired.").

## Layout

```
src/
  types.ts    Delta, Claims, Pointer, EntityRef, DeltaRef, Primitive
  cbor.ts     deterministic CBOR encoder (RFC 8949 §4.2.1 profile — see spec/01-delta.ERRATA.md)
  hash.ts     BLAKE3-256 + multihash wrapping
  delta.ts    canonical bytes, id computation, delta-set ops
  index.ts    public surface
test/
  cbor.test.ts       encoder vs. external ground-truth (RFC 8949 Appendix A)
  vectors.test.ts    loads ../../vectors/l0-delta and asserts byte-exact parity
```
