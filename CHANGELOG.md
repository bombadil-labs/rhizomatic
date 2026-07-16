# Changelog

All notable changes to **`@bombadil/rhizomatic`**. This project is pre-1.0, so breaking changes may
land in **minor** bumps (see [CLAUDE.md → Releasing](CLAUDE.md#releasing-bombadilrhizomatic-to-npm)).
Format follows [Keep a Changelog](https://keepachangelog.com/); newest first.

## 0.7.0 — unreleased

The Ed25519 signature-acceptance criterion is **pinned to strict** ([#20](https://github.com/bombadil-labs/rhizomatic/issues/20),
SPEC-1 §5.1, ERRATA D13). The two witnesses verified under different criteria — TS on `@noble/curves`'
permissive ZIP215 default, Rust on `ed25519-dalek`'s `verify_strict` — which agree on every honest
signature but split on adversarial edge cases (non-canonical encodings, small-order components).
Verification is admission, so a criterion split is a federation split; the spec now states one
criterion normatively, in its own words.

### Added

- **SPEC-1 §5.1 — the strict acceptance criterion**, five explicit checks: canonical scalar
  (`S < L`), canonical point encodings of `A` and `R` (decompress–recompress must reproduce the
  bytes), no small-order `A` or `R`, and the **cofactorless** verification equation, exactly.
  Mixed-order (torsion-carrying but large-order) points are deliberately *not* rejected by the
  small-order check; the equation decides them.
- **`vectors/l0-delta/deltas-sig-edge.json`** — ten speccheck-style vectors machine-checking every
  clause, six of which a ZIP215 verifier accepts and a conformant witness MUST refuse (each carries
  an informative `zip215Accepts` flag). Verdicts are re-verified at generation time.

### Changed

- **Both witnesses now implement the five checks explicitly** rather than delegating to a library's
  notion of "strict" (noble point/scalar primitives in TS, `curve25519-dalek` + `sha2` in Rust).
  - **For consumers:** signing is untouched (RFC 8032 signing is deterministic and identical under
    both criteria), and every honestly-generated signature verifies exactly as before. The only
    behavior change is that the TS witness now *refuses* edge-case signatures it previously
    admitted under ZIP215 — a tightening, and the point of the pin.

## 0.6.0 — 2026-07-15

First-class **set algebra over delta-sets**: the operator algebra had `union` but no difference or
intersection ([#16](https://github.com/bombadil-labs/rhizomatic/issues/16), SPEC-2 §4.9, ERRATA-2
E17). This is what Loam's container work (membership = a delta-query; excluded/"sandbox" containers)
needs: read scope = *the union of active containers **minus** the excluded ones*.

### Added

- **`difference` and `intersect` term operators** (SPEC-2 §4.9). Two new `dset`-sort ops, symmetric
  with `union`, whole-delta and keyed by content-addressed id, nestable to any depth:
  `{ "op": "difference", "of": Term, "without": Term }` (asymmetric — `of ∖ without`) and
  `{ "op": "intersect", "left": Term, "right": Term }`. Unlike the old `select(not(inView(…)))`
  workaround, a `difference` may difference against another `difference` (the reflective route is
  stratified at depth 1), so containers defined relative to other containers compose. The
  `mask(annotate)` tag channel does not survive either op, exactly as through `select`/`union`.

### Changed

- **No `alg` bump — the instruction set stays `alg: 1`.** Adding an operator to the **closed** §9
  Term profile is *parse-visible*: an implementation that predates it meets an unknown `op` and
  rejects at parse time, loudly, before evaluation — which is the safety an `alg` bump would have
  provided. SPEC-2 §8 is reconciled to say a bump is required **iff** a change is *not* parse-visible
  (altered semantics of an existing form), and to make the fail-closed parse rule normative (a
  conformant parser MUST reject any unrecognized `op`/`policy`/`cmp`/… tag). `difference`/`intersect`
  enter under this rule, exactly as `inView` and `chain` did.
  - **For consumers:** no migration, no data changes. A term using these ops is rejected — never
    silently mis-evaluated — by any older witness, and the rejection now SHOULD name the tag and
    point at version skew. Loam, the sole current consumer, is built in lockstep, so there is no
    older witness in the wild regardless.

## 0.5.0 — 2026-07-14

Schema/HyperSchema vocabulary reconciliation + self-hosting parity, landed as **one migration wave**
(issues [#10](https://github.com/bombadil-labs/rhizomatic/issues/10) +
[#11](https://github.com/bombadil-labs/rhizomatic/issues/11)) so consumers pull a single new version.

### ⚠️ Breaking

- **`loadSchema` / `publishSchemaClaims` → `loadHyperSchema` / `publishHyperSchemaClaims`** (#10).
  These always operated on **HyperSchemas** (the gather program), not resolution Schemas — the names
  predated the 0.3.0 L5 realignment. The old names are now **reused for resolution Schemas** (see
  Added), so this is *not* a silent no-op: `loadSchema` now returns a `Schema` (not a `HyperSchema`)
  and `publishSchemaClaims` now takes a `Schema` — TypeScript flags both at your call sites.
  - **Migrate:** rename every HyperSchema use — TS `loadSchema`→`loadHyperSchema`,
    `publishSchemaClaims`→`publishHyperSchemaClaims`; Rust `load_schema`→`load_hyper_schema`,
    `publish_schema_claims`→`publish_hyper_schema_claims`. `HYPER_SCHEMA_SCHEMA` and the
    `rhizomatic.hyperschema.*` roles are unchanged, so **no at-rest data migrates** — code only.

### Added

- **`SCHEMA_SCHEMA`** (`rhizomatic.SchemaSchema`) + **`publishSchemaClaims` / `loadSchema` for
  resolution Schemas** (#11, SPEC-3 ERRATA S6). A resolution `Schema` (`{ props, default }`) can now
  be a first-class, self-hosting, versionable entity — published as deltas over the new
  `rhizomatic.schema.*` vocabulary and read back through `SCHEMA_SCHEMA`, exactly as a HyperSchema
  is. This is what Loam §21's `name@hash` schema versioning builds on.
- **`Schema` gained optional `name` and `alg`.** Inline `resolve`-term schemas stay anonymous
  (byte-identical to 0.4.0); a *published* Schema must carry both. New export `schemaCanonicalHex`
  hashes the resolution content (props+default); `name`/`alg` are identity metadata (roles),
  excluded from the hash — mirroring a HyperSchema's body-only term hash.

## 0.4.0 — 2026-07-14

### Added

- **The `bytes` Target kind** ([#7](https://github.com/bombadil-labs/rhizomatic/issues/7),
  SPEC-1 §2/§4 + ERRATA D12) — `{ kind: "bytes", mime, value }`, a 4th `Target` for raw binary
  payloads with a **required in-kind MIME type**. Identity is the hash of the raw bytes (canonical
  CBOR byte string); JSON transport is canonical **unpadded base64url**, reject-never-repair. Fully
  **additive** — no existing content address moves, and a pre-0.4 peer fails closed on the unknown
  kind (version discipline, not breakage). New exports: `bstr`, `b64uEncode` / `b64uDecode`,
  `BytesView`. Both witnesses verified at byte parity.

---

Earlier releases (**0.1.0 – 0.3.0**) predate this changelog; see the git tags `rhizomatic-v*` and
[PROGRESS.md](PROGRESS.md) for the slice-by-slice history.
