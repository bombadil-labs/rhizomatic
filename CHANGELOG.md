# Changelog

All notable changes to **`@bombadil/rhizomatic`**. This project is pre-1.0, so breaking changes may
land in **minor** bumps (see [CLAUDE.md → Releasing](CLAUDE.md#releasing-bombadilrhizomatic-to-npm)).
Format follows [Keep a Changelog](https://keepachangelog.com/); newest first.

## 0.8.0 — 2026-07-19

**`expand` names the child's reading** ([#23](https://github.com/bombadil-labs/rhizomatic/issues/23),
SPEC-2 §4.5/E18, SPEC-5 §4/R8): an expand term now states **both halves of the child's lens** —
`schema` (how the child gathers) and `reading` (the resolution Schema the child resolves through
when the expansion crosses the `resolve` boundary). Before this, an expanded child was silently
resolved with the **parent's** Schema — a child's intended reading was unstatable, and two parents
embedding the same child under different Schemas produced different child views with nothing in
the program identifying either. Surfaced by Loam's multi-lens coexistence work (Loam T25).

### ⚠️ Breaking

- **Resolving an expansion under a legacy body (no `reading`) is now a loud error** — there is no
  fallback to the parent's Schema. Gather is unchanged: legacy bodies still parse, evaluate, and
  hash byte-identically; only `resolve` over their expansions refuses. **Migration — this is not
  optional and there is no compatibility path:** every expand-carrying hyperschema body in every
  store MUST be re-published with `"reading": <its Schema's name or pinned hash>` before anything
  resolves through it. Every pre-#23 hyperschema had exactly one Schema (coexistence postdates
  them), so the choice is mechanical. Bodies gaining `reading` mint new termHashes — **and every
  `{pinned: <old hash>}` reference elsewhere keeps pointing at the legacy body, which will refuse
  to resolve forever. Walk pinned refs too and re-pin them to the migrated hashes.** Regenerate
  any deltas that would hit either path; do not ship a store that mixes migrated and unmigrated
  expand bodies.
- `SchemaRegistry.build` gains a second argument: `readings` (named resolution Schemas), indexed
  by name and content address (`schemaHash`, newly exported); reading refs validate at build.
  Existing single-argument calls compile unchanged (defaults to none).

### Added (readings)

- `expand.reading` in the term grammar (SPEC-2 §9) — present-iff-authored, so legacy hashes are
  untouched; `schemaHash(schema)` — a resolution Schema's content address, the referent of
  `reading: {pinned: …}`; registry `resolveReading`/`getReading`; `collectReadingRefs`.
- **Serialized HyperViews stay self-describing** (SPEC-3 §4): an expanded target's canonical form
  carries the reading's content address (`{"id", "props", "reading"}`, key present iff the expand
  named one) — a rehydrated hview can name its readings and be resolved through a registry. Legacy
  hview bytes are untouched.
- `vectors/l1-eval/eval-resolve.json` regenerated: a `readings` registry section, the
  `resolve-nested-expansion` case now observably resolved through the child's own reading, and a
  `legacy-expand-resolve-rejected` reject (verified to reject at generation time).
  `eval-expand.json` gains `fix-expand-with-reading`, pinning the reading hash in canonical bytes.

### Integrating (consumers)

**1. Author the expand with both halves of the child's lens.**

```jsonc
// before — the child was silently resolved with the PARENT's Schema
{ "op": "expand", "role": { "exact": "post" }, "schema": "PachyPost", "in": <Term> }

// after — the child's gather AND its reading are named in the term
{ "op": "expand", "role": { "exact": "post" }, "schema": "PachyPost",
  "reading": "Post", "in": <Term> }

// or pin the reading by content address (immutable; survives a rename)
{ "op": "expand", "role": { "exact": "post" }, "schema": "PachyPost",
  "reading": { "pinned": "1e20…" }, "in": <Term> }
```

**2. Register readings alongside hyperschemas.** `SchemaRegistry.build` takes a second argument;
a registered reading MUST carry a `name` (an inline, anonymous Schema cannot be referenced).

```ts
import { SchemaRegistry, parseSchema, parseTerm, schemaHash, loadSchema } from "@bombadil/rhizomatic";

const readings = [
  parseSchema({
    name: "Post",                       // required to be registerable
    alg: 1,
    props: { title: { pick: { order: { byTimestamp: "desc" } } } },
    default: { pick: { order: "lexById" } },
  }),
];
const registry = SchemaRegistry.build(hyperSchemas, readings);

// Schemas published as deltas (0.5.0) load straight back into this slot — loadSchema
// reattaches name/alg, which is exactly what registration requires:
const fromStore = loadSchema(dset, "schema:Post");
const registry2 = SchemaRegistry.build(hyperSchemas, [fromStore]);

// The referent of `reading: {pinned: …}`:
schemaHash(readings[0]); // => "1e20…"
```

**3. Errors you will see, and what each means.** All three are loud and none fall back:

| Message | Cause | Fix |
|---|---|---|
| `schema <X> references unknown reading <Y> (issue #23)` | thrown at **`SchemaRegistry.build`** | register `Y` (or correct the ref) — this is the good failure: it fires before any evaluation |
| `unknown reading: <Y> (issue #23)` | thrown at **eval**, registry built without the reading | same, for registries assembled dynamically |
| `expansion at pointer <i> of delta <id> carries no reading — legacy expand bodies must name the child's resolution Schema` | thrown at **resolve**, body predates `reading` | migrate that body (below) — gather succeeded, so this surfaces late |

**4. Migration checklist.**

1. Find every hyperschema body containing an `expand` (`collectRefs`/`collectReadingRefs` over
   parsed bodies makes this mechanical).
2. For each, add `"reading": <the one Schema that hyperschema was used with>` — pre-0.8 stores
   have exactly one candidate per hyperschema, since multi-lens coexistence postdates them.
3. Re-publish the body. It mints a **new termHash**.
4. **Walk every `{"pinned": <hash>}` schema reference and re-pin it** to the migrated hash —
   pinned refs to pre-migration bodies keep resolving to the legacy body and refuse forever.
5. Regenerate any stored deltas carrying old bodies or old pinned refs. Do not ship a store
   mixing migrated and unmigrated expand bodies.

**5. What does not change.** Gather semantics, canonical delta bytes, ids, signatures, and the
`resolve` API surface are all untouched; a body with no `expand` is entirely unaffected. Terms
without `reading` still parse and hash identically, so migration is detectable but not forced at
parse time. No `alg` bump.

**6. One mixed-version hazard, worth knowing before you federate.** A **pre-0.8 witness** handed a
`reading`-carrying body does **not** fail closed — it silently ignores the unknown key and
evaluates the body as a legacy expand, resolving children under the parent's Schema. Two peers on
different versions therefore produce *different views from the same term* without either erroring.
This is a gap in the fail-closed doctrine (which covers unknown **tags** but not unknown **keys**)
and is tracked in [#25](https://github.com/bombadil-labs/rhizomatic/issues/25). Adopting 0.8.0 does
**not** require #25 — but until it lands, upgrade all peers that share bodies together, and treat
"peer resolves this expansion differently" as a version-skew symptom rather than a logic bug.

---

**A third witness** ([#19](https://github.com/bombadil-labs/rhizomatic/issues/19)):
`implementations/elixir`, at conformance Level 0, written from `spec/` + `vectors/` **alone** —
the first real test of SPEC-0 §5's claim that the conformance suite is sufficient to conform to.
Zero dependencies (pure-Elixir BLAKE3 and Edwards arithmetic; OTP `:crypto` for signing only).
Its findings drove the rest of this release.

### Added

- **`implementations/elixir`** — the L0 witness (106 tests), plus `FINDINGS.md`: the full record
  of where spec/vectors underspecified the work (the experiment's actual deliverable).
- **`vectors/l0-pack/pack-bytes.json`** — the bytes-target pack vector promised by D12 and the
  vectors README since 0.4 but never generated (finding F1); all three witnesses now consume it.
- **N-witness parity runner** — `tools/check-all.mjs` discovers `implementations/*/witness.json`
  manifests (machine-readable conformance level + checks); CI gains an Elixir job.
- **The L0 bring-up path** in `vectors/README.md` — attack order, gate, and the no-peeking rule,
  for the next citizen.
- **SPEC-1 §4.1 + ERRATA D14 — host-boundary numeric policy**: hosts distinguishing integer from
  float terms MUST reject native integer terms at claim construction; the JSON-profile parser is
  the single blessed coercion point (an integer token is a float spelling). Pinned by the new
  `number-integer-spelling` vector.

### Changed

- **SPEC-8 §3 reconciled with its own vector** (findings F2–F4, ERRATA-8 P4): the record grammar
  gains the `"i"` stored-id field it always needed (§4's fsck presupposed it), the `strings`
  table's raw-bytewise sort order is stated, interned string sources are enumerated, and
  `"version": 1` is noted to encode as a float. **No byte changes** — the spec text now describes
  what every witness already emits.
- SPEC-8 §3.1: **envelopes win** (F6, ERRATA-8 P5) — a manifest claimed by another manifest stays
  hydrated in `envelopes`; manifest-ness = a `rhizomatic.txn.member` pointer with a DeltaRef
  target. Open questions recorded: MemberRecord `dt` lossiness (F5, P6) and the Unicode version
  behind NFC validation (ERRATA D15).
- CLAUDE.md: lockstep binds per conformance level, not per repo.
  - **For consumers:** nothing — no wire bytes, ids, or evaluation semantics change. New vectors
    are additive (`deltas.json` +1 case regenerates the provisional D10 set digest).

## 0.7.0 — 2026-07-16

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
