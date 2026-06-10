# ERRATA & Decisions — SPEC-7 (Derivation)

## G1 — v0 derived authors are native functions

SPEC-7 §7 already concedes that host-language-native functions are "conformant locally but not
portable claims-of-identity". v0 implements exactly that tier: a derived function is a host
closure `(HView, root) -> [substantive pointer lists]`, identified by a declared `fnId` entity
(the content-addressed WASM artifact replaces the declared id when the ABI lands). Everything
else in the lifecycle is implemented for real: binding installation, provenance emission,
emission policies, budgets, the loop guard, and pure-replay verification.

## G2 — The derivation host wraps the reactor (the write-back loop)

`DerivationHost.ingest(delta)` runs the reactor ingest, then drains a trigger queue: each change
event on a bound materialization triggers its binding; emissions re-enter through the ordinary
ingest path and their change events join the queue. The loop terminates because (a) a binding
whose trigger's responsible deltas are **all its own emissions** is skipped (the default
non-reentrancy guard of §6), and (b) each binding carries a **budget** — a lifetime emission cap;
exceeding it suspends the binding and emits a signed `rdb.derived.suspended` annotation, making
divergence an observable event, not a melted reactor.

## G3 — Provenance pointers and deterministic timestamps

Every emission carries `rdb.derived.by` (fn entity), `rdb.derived.from` (the input HView's
canonical hex as a primitive — the exact input snapshot), and `rdb.derived.under` (binding
entity), plus the substantive pointers, signed by the derived author's key. **All derived
emissions (including supersede negations) use timestamp 0**: a pure function's output must be a
function of (fn, input hash) only (§4), and a wall-clock timestamp would break replayability. The
claimed-time ordering of derived claims is therefore meaningless by design — policies rank them
by author (`byAuthorRank`) or input freshness, exactly as SPEC-5 §3 prescribes.

## G4 — Emission policies

`append` accumulates. `supersede` negates the binding's prior live emissions (negations authored
and signed by the derived author, timestamp 0 — re-negating an already-negated prior dedupes to
the same delta id, harmlessly) before emitting anew. `keyed` is deferred until a consumer needs
per-subject supersession.

## G5 — Pure-replay verification (conformance Level 4's seed)

`verifyPureDerivation(emitted, fn, view, root)`: check the emission's `rdb.derived.from` equals
the view's canonical hex, re-run the function, rebuild the full claims (same provenance recipe),
recompute the id — it must equal the emitted delta's id, and the signature must verify. Replay
across *implementations* is exactly what native functions cannot promise (G1); replay within a
host is tested in both witnesses.
