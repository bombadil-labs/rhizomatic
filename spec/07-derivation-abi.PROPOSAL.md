# PROPOSAL — The WASM Host ABI for Derived Authors (SPEC-7 §10)

**Status:** Proposal — NOT adopted. Drafted from the working v0 native-function lifecycle
(ERRATA-7), which implements everything in SPEC-7 *except* portable function identity. This
document proposes the portability layer. It changes no current vector; adopting it would add a
new conformance surface (Level 4 portable).

---

## 1. What the ABI must deliver

SPEC-7's design hinges on one substitution: replace the v0 *declared* `fnId` with a
**content-addressed artifact**, so that "same function" becomes a checkable claim rather than a
naming convention. Everything else in the lifecycle — bindings, provenance emission, budgets, the
loop guard, supersede, replay — already works (ERRATA-7) and is **unchanged** by this proposal.
The ABI's job is exactly three things:

1. deliver the input HView to the guest,
2. receive the guest's substantive claims,
3. make the `pure` declaration *checkable, not honor-system* (SPEC-7 §7).

## 2. Artifact and identity

- The artifact is a **WebAssembly module** (binary format, core spec).
- `fnHash = contentAddress(wasm bytes)` — the same multihash used everywhere else (ERRATA-1 D7).
- The artifact federates as a blob referenced by deltas (SPEC-6 §6); receiving ≠ installing.
- The v0 `fnId` entity remains as the *name*; an `rdb.derived.artifact` pointer on the binds
  delta carries the fnHash, upgrading declared identity to checkable identity without breaking
  the existing vocabulary.

## 3. The interface (ABI version 1)

The guest module MUST export:

| Export | Signature | Meaning |
|---|---|---|
| `memory` | linear memory | shared with the host |
| `rhz_abi_version` | `() -> i32` | MUST return `1`; mismatch rejects at install |
| `rhz_alloc` | `(len: i32) -> i32` | guest allocator: host requests a buffer for input |
| `rhz_derive` | `(ptr: i32, len: i32) -> i64` | the function itself |

**Input.** The host writes the **canonical CBOR of the input HView** (ERRATA-2 E7/E11 — the same
bytes whose hash becomes `rdb.derived.from`) into a buffer obtained from `rhz_alloc`, then calls
`rhz_derive(ptr, len)`. One encoding for storage, transport, hashing, AND function input: the
guest can verify what it was given against the from-hash by construction. The ambient root is
prepended as a single CBOR text-string item before the HView (two items, concatenated — the
decoder's strictness makes the boundary unambiguous given known lengths; alternatively a 2-array
wrapper `[root, hview]`, which this proposal prefers for self-delimiting simplicity).

**Output.** `rhz_derive` returns a packed `i64` (`ptr << 32 | len`) naming a guest-memory region
containing the canonical CBOR of an **array of pointer-lists** — exactly the v0 `DerivedFn`
return shape (ERRATA-7 G1), in the pointer encoding of the pack format (ERRATA-8 P1 `Ptr`,
without string interning: roles/ids inline as text). An empty array means "no emission".

**What the guest never does:** sign, timestamp, or attach provenance. The host builds the full
claims exactly as v0 does (ERRATA-7 G3: substantive pointers + by/from/under, timestamp 0) and
signs with the derived author's key, **which never enters guest memory**. A compromised or
malicious function can lie about content but cannot impersonate, exfiltrate keys, or forge
provenance — its lies are signed, attributed, input-pinned, and negatable, which is the SPEC-7 §4
testimony model working as designed.

## 4. Purity is the absence of imports

A binding declared `pure` MUST be backed by a module with **zero imports**. Not wasi-minimal:
*nothing* — no clock, no random, no host functions, no WASI. The host verifies this statically at
install time (one pass over the import section) and rejects otherwise. Determinism then follows
from WASM's own semantics (modulo NaN-bit nondeterminism, which our float validation already
excludes from claims; implementations SHOULD additionally canonicalize NaNs at the boundary or
reject them). This makes SPEC-7 §7's "the purity claim is checkable" literally true: purity is a
syntactic property of the artifact, verifiable by anyone holding the bytes.

`effectful` bindings declare **capabilities** at registration; each maps to one host import in a
`rhz` namespace, absent unless granted:

| Capability | Import | Notes |
|---|---|---|
| `clock` | `rhz.now_ms() -> f64` | wall time — using it forfeits replayability, by definition |
| `random` | `rhz.random_u64() -> i64` | likewise |
| `http` | `rhz.fetch(req_ptr, req_len) -> i64` | request/response as canonical CBOR; host-mediated, allowlist-able |
| `log` | `rhz.log(ptr, len)` | observability only; MUST NOT feed back into the reactor |

## 5. Budgets, replay, conformance

- **Budgets** (SPEC-7 §6) gain a second dimension: per-trigger **fuel** (instruction metering, as
  provided by major WASM runtimes) alongside the existing emission-count budget. Exhausting either
  suspends the binding with the existing `rdb.derived.suspended` annotation.
- **Replay** (Level 4): for a pure module, any party holding (wasm bytes, input HView bytes) MUST
  be able to reproduce the emitted claims byte-for-byte — this is the cross-*implementation*
  replay that native functions cannot offer (ERRATA-7 G5). Conformance vectors would ship: a tiny
  pure module (e.g. the avgRating function compiled from Rust or AssemblyScript), an input HView,
  and the expected emission bytes.
- **Install pipeline:** verify abi version → verify import section against declared class/
  capabilities → record fnHash → emit the binds delta (now artifact-pinned). All existing v0
  lifecycle machinery applies unchanged downstream.

## 6. What this deliberately leaves out

- **Streaming/incremental input** — v1 delivers the whole HView; differential inputs are an
  optimization for after the contract exists.
- **Guest-side queries** — the function sees its input, period. Letting guests query the reactor
  would reopen the cross-delta-logic hole that SPEC-2 §3 closed; anything needing more context
  should be expressed as a larger input materialization.
- **Component Model / interface types** — attractive later; the raw linear-memory ABI above is
  implementable today in every runtime and every guest language with a C ABI.

## 7. Open questions for adoption

- NaN canonicalization at the WASM boundary: canonicalize vs reject (lean: reject in `pure`).
- Should the input include the binding spec (so one artifact can serve several bindings with
  different parameters), or is parameterization a separate `rhz.params` CBOR item? (Lean: a third
  item in the input array — `[root, hview, params]` — params being an arbitrary CBOR value pinned
  in the binds delta and covered by replay.)
- Fuel accounting units and their portability across runtimes (likely host policy, not spec).
