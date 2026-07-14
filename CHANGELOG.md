# Changelog

All notable changes to **`@bombadil/rhizomatic`**. This project is pre-1.0, so breaking changes may
land in **minor** bumps (see [CLAUDE.md → Releasing](CLAUDE.md#releasing-bombadilrhizomatic-to-npm)).
Format follows [Keep a Changelog](https://keepachangelog.com/); newest first.

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
