//! The second integration test program. Its modules compile private source files of the crate
//! (`#[path = "../src/..."]`), and those files name their siblings as `crate::...`, so they need a
//! crate root of their own. Every other test is a module of `witness.rs` (AGENTS.md, "Build size").
// Compile the exact private semantic walkers in this test crate; no production I/O.
// F1 instrumentation compiles the exact core source with a counting wrapper that
// delegates to the real verifier. No production test hooks or alternate verifier.
use rhizomatic::{
    cbor, delta, eval, hash, hview, json_profile, pred, resolution, term_io, term_json, types,
};
#[path = "support/evidence_assertions.rs"]
mod assertion_evidence;
#[path = "../src/hview_envelope.rs"]
mod envelope;
#[allow(dead_code)]
#[path = "../src/evidence_codec.rs"]
mod evidence_codec;
#[path = "../src/reading_appearance.rs"]
mod reading_appearance;
#[path = "../src/reading_budget.rs"]
mod reading_budget;
#[path = "../src/reading_wire_budget.rs"]
mod reading_wire_budget;
mod sign {
    pub use rhizomatic::sign::Verification;
    use std::cell::Cell;
    thread_local! { static CALLS: Cell<usize> = const { Cell::new(0) }; }
    pub fn verify_canonical_delta(d: &crate::types::Delta) -> Verification {
        CALLS.with(|c| c.set(c.get() + 1));
        rhizomatic::sign::verify_canonical_delta(d)
    }
    pub fn reset() {
        CALLS.with(|c| c.set(0));
    }
    pub fn count() -> usize {
        CALLS.with(Cell::get)
    }
}

mod evidence_budget;
mod evidence_verification;
