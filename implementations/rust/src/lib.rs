//! Rhizomatic reference implementation (Rust) — one of two parallel witnesses to the spec.
//! Module names mirror `../ts/src` to aid cross-reading. See the root CLAUDE.md.

pub mod cbor;
pub mod delta;
pub mod eval;
pub mod hash;
pub mod json_profile;
pub mod pred;
pub mod set;
pub mod sign;
pub mod term_json;
pub mod types;

pub use delta::{canonical_bytes, canonical_hex, compute_id};
pub use eval::{eval_term, result_canonical_hex, EvalResult, MaskPolicy, Term};
pub use pred::{compare_primitives, eval_pred, Pred};
pub use set::{federate, fork, make_delta, make_negation_claims, merge, DeltaSet};
pub use sign::{sign_claims, verify_delta, Verification};
pub use term_json::{parse_pred, parse_term};
pub use types::{Claims, Delta, DeltaRef, EntityRef, Pointer, Primitive, Target};
