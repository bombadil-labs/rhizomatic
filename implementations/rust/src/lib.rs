//! Rhizomatic reference implementation (Rust) — one of two parallel witnesses to the spec.
//! Module names mirror `../ts/src` to aid cross-reading. See the root CLAUDE.md.

pub mod cbor;
pub mod delta;
pub mod hash;
pub mod json_profile;
pub mod sign;
pub mod types;

pub use delta::{canonical_bytes, canonical_hex, compute_id};
pub use sign::{sign_claims, verify_delta, Verification};
pub use types::{Claims, Delta, DeltaRef, EntityRef, Pointer, Primitive, Target};
