//! Rhizomatic reference implementation (Rust) — one of two parallel witnesses to the spec.
//! Module names mirror `../ts/src` to aid cross-reading. See the root CLAUDE.md.

pub mod cbor;
pub mod delta;
pub mod derivation;
pub mod eval;
pub mod hash;
pub mod http;
pub mod hview;
pub mod json_profile;
pub mod materialize;
pub mod pack;
pub mod peer;
pub mod policy;
pub mod pred;
pub mod reactor;
pub mod schema;
pub mod schema_deltas;
pub mod set;
pub mod sign;
pub mod term_io;
pub mod term_json;
pub mod types;

pub use delta::{canonical_bytes, canonical_hex, compute_id};
pub use derivation::{verify_pure_derivation, BindingSpec, DerivationHost};
pub use eval::{
    eval_term, result_canonical_hex, EvalResult, GroupKey, MaskPolicy, PruneKeep, Term,
};
pub use http::{offer_for, pull_from_url, serve_peer};
pub use hview::{hview_canonical_hex, HVEntry, HView};
pub use materialize::{is_root_anchored, MaterializationChange};
pub use pack::{pack_id, pack_set, unpack_set};
pub use peer::{sync_both, Peer, SyncReport};
pub use policy::{resolve_view, view_canonical_hex, MergeFn, Order, Policy, PropPolicy, View};
pub use pred::{compare_primitives, eval_pred, Pred};
pub use reactor::{make_manifest_claims, manifest_member_ids, IngestResult, Reactor};
pub use schema::{collect_refs, HyperSchema, SchemaRegistry};
pub use schema_deltas::{load_schema, publish_schema_claims, schema_schema, VOCAB_PREFIX};
pub use set::{federate, fork, make_delta, make_negation_claims, merge, DeltaSet};
pub use sign::{sign_claims, verify_delta, Verification};
pub use term_io::{cbor_to_json, json_to_cbor, term_canonical_hex, term_hash, term_to_json};
pub use term_json::{parse_pred, parse_term};
pub use types::{Claims, Delta, DeltaRef, EntityRef, Pointer, Primitive, Target};
