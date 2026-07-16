# ERRATA & Decisions — SPEC-1 (Delta Layer)

Per the README "Rules of engagement" and [CLAUDE.md](../CLAUDE.md): where implementation meets a gap
or contradiction in the spec, we record it here, resolve it explicitly, and let the conformance
vectors pin it. Nothing here is silently encoded into one implementation.

SPEC-1 specifies the *abstract* delta structure and mandates "deterministic CBOR (RFC 8949 §4.2.1)"
but does not give the *concrete* CBOR layout of pointers/targets or the number-encoding rule. The
decisions below fill that gap for **v0**. They are pinned by `vectors/l0-delta/` and are revisitable
(a change is a vector regen, cheap while pre-conformance).

## D1 — Number encoding (numbers are floats only)

Folded into SPEC-1 §4.1 (2026-06-11); history in git.


## D2 — String encoding

Folded into SPEC-1 §4.1 (2026-06-11); history in git.


## D3 — Boolean encoding

Folded into SPEC-1 §4.1 (2026-06-11); history in git.


## D4 — Map key ordering

Folded into SPEC-1 §4.1 (2026-06-11); history in git.


## D5 — Pointer & target layout

Folded into SPEC-1 §4.1 (2026-06-11); history in git.


## D6 — `claims` layout

Folded into SPEC-1 §4.1 (2026-06-11); history in git.


## D7 — Content address (`id`)

Folded into SPEC-1 §4.1 (2026-06-11); history in git.


## D8 — Author encoding for signed deltas

Folded into SPEC-1 §5 (2026-06-11); history in git.


## D9 — Signature definition

Folded into SPEC-1 §5 (2026-06-11); history in git.


## D10 — Set digest (PROVISIONAL helper — confirmed 2026-06-11: stays provisional until sublinear reconciliation exists)

`digest(S)` = `contentAddress( canonical CBOR array of S's id strings, sorted lexicographically )`.
A cheap canonical fingerprint of set membership, used by the implementations to compare delta sets
(CRDT property tests, parity checks). It is **NOT** the SPEC-6 §4 reconciliation digest — that
Merkle/IBLT construction is still an open question there. Pinned by
`vectors/l0-delta/set-digest.json` only so both implementations agree while it remains a helper;
promotion to normative status is a SPEC-6 decision.

## D11 — NFC is validated at the boundary, not repaired at encode time

Folded into SPEC-1 §4.1 (2026-06-11); history in git.


## D12 — The `bytes` target kind (2026-07, issue #7, 0.4)

Resolves SPEC-1 §10's binary-primitives open question. A **fourth `Target` kind** for raw byte
payloads with a required, in-kind `mime` — **not** a fourth `Primitive`. Normative text folded
into SPEC-1 §2 / §2.1 / §4.1 / §4.2; recorded here for the decisions and their rationale, pinned
by `vectors/l0-delta/deltas-bytes.json` (+ appended `cbor-primitives.json` / `deltas-invalid.json`,
and downstream `l0-pack/pack-bytes.json`, `l1-eval/eval-bytes.json`). Strictly additive: no
existing vector entry changes, no content address moves.

- **Bytes, not a primitive.** `Primitive = string | number | boolean` is untouched on purpose:
  bytes enter no order, predicate, merge-fold, term constant, or hole binding (SPEC-2 §3,
  SPEC-5 §3), so keeping them out of `Primitive` means L2 grammar grows by zero. A bytes target
  is a literal — no `context`.
- **`mime` REQUIRED, no default.** A default (`application/octet-stream`) would invite silently
  untyped blobs; an author who doesn't know the type says so out loud and signs it. Non-empty,
  NFC (D11), case-sensitive and otherwise opaque — never lowercased, because lowercasing is repair
  and `image/PNG` ≠ `image/png` is the same honesty as two MIME types being two claims. Informative
  SHOULD: the lowercase IANA form.
- **Identity = hash of the raw bytes.** The payload enters the preimage only as a definite-length
  CBOR byte string (major type 2, shortest head) inside `{ "mime": tstr, "value": bstr }` (keys
  sorted per D4). No payload-level content address at L1 — that is the next rung of the storage
  ladder (§10). Zero-length is legal (`0x40`). The codecs' prior "major type 2 is outside the
  profile" rejection now becomes an accepted case — the very branch that makes pre-0.4 peers fail
  closed on bytes (SPEC-6).
- **JSON transport = canonical base64url** (RFC 4648 §5, unpadded): no `=`, alphabet
  `A–Z a–z 0–9 - _`, length ≢ 1 (mod 4), trailing unused bits zero. Reject-never-repair on every
  violation (SPEC-4 §2), even though identity is over the raw bytes — laxity is how witnesses
  drift. Encoding is canonical by construction; decoding validates it.


## D13 — Ed25519 verification pinned to the strict criterion (2026-07-16, issue #20)

Normative text folded into SPEC-1 §5.1; recorded here for the decision and its rationale, pinned
by `vectors/l0-delta/deltas-sig-edge.json`.

The two witnesses verified under different acceptance criteria — TS on `@noble/curves`' default
(ZIP215: cofactored, permissive about non-canonical encodings), Rust on `ed25519-dalek`'s
`verify_strict` (cofactorless, rejecting non-canonical encodings and small-order components).
Honest signatures verify identically under both, so every prior vector passed in both witnesses;
the divergence was confined to adversarial edge cases (ed25519-speccheck territory) — and a
delta one conformant witness admits and the other refuses is a federation split.

**Decision (Myk, issue #20): strict.** Rationale: matches the house aesthetic — the boundary
refuses weirdness rather than normalizing it (NFC validated never repaired, ids must recompute,
b64u canonical or rejected). ZIP215's distinguishing virtue is that it names an unambiguous
criterion all verifiers can share; *any* pin achieves that, and this repo's criterion is the
SPEC-1 §5.1 text itself, not a library default. Both witnesses now implement the five checks
explicitly (canonical `S`, canonical `A`/`R` encodings, no small-order `A`/`R`, cofactorless
equation) rather than calling a library's opinion of "strict", because strictness varies subtly
between libraries. Small-order components are rejected; a large-order point carrying torsion is
decided by the cofactorless equation alone — `deltas-sig-edge.json` pins both sides of that
boundary, including the case a cofactored (ZIP215-style) verifier would accept and a strict
verifier refuses.

## JSON debug profile (for vectors)

Folded into SPEC-1 §4.2 (2026-06-11); history in git.
