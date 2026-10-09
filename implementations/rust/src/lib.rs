//! Rhizomatic reference implementation (Rust) — one of two parallel witnesses to the spec.
//! Module names mirror `../ts/src` to aid cross-reading. See the root CLAUDE.md.

pub mod alias;
pub mod arrival;
pub mod b64u;
pub mod cbor;
pub mod command;
pub mod command_data;
#[doc(hidden)]
pub mod delta;
pub mod derivation;
#[doc(hidden)]
pub mod durable_state;
pub mod entry;
#[doc(hidden)]
pub mod erasure_filter;
pub mod eval;
pub mod hash;
#[doc(hidden)]
#[doc(hidden)]
#[doc(hidden)]
#[doc(hidden)]
pub mod ordinary_journal;
pub mod ordinary_journal_peer;
#[doc(hidden)]
pub mod signed_loose_admission;
// The HTTP binding is host-only (tiny_http/ureq do not build on wasm32).
#[cfg(not(target_arch = "wasm32"))]
pub mod http;
pub mod hview;
pub mod json_profile;
pub mod lens_binding;
pub mod materialize;
#[doc(hidden)]
pub mod ordinary_quota;
pub mod pack;
pub mod parse_error;
pub mod peer;
#[doc(hidden)]
pub mod peer_identity;
#[doc(hidden)]
pub mod peer_state;
pub mod permanent_journal;
pub mod pred;
pub mod preflight;
#[doc(hidden)]
pub mod principal;
pub mod reactor;
#[doc(hidden)]
pub mod resolution;
pub mod schema;
pub mod schema_deltas;
pub mod set;
pub mod sign;
pub mod single_peer;
pub mod strict;
pub mod term_io;
pub mod term_json;
pub mod types;
#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use alias::{relation_signature, relation_signature_canonical_hex};
pub use arrival::{plan_arrivals, ArrivalCursor, ArrivalPlan, ArrivalRecord};
pub use delta::{canonical_bytes, canonical_hex, compute_id};
pub use derivation::{verify_pure_derivation, BindingSpec, DerivationHost};
pub use entry::{bundle_entry_status, loose_entry_status, LooseEntryStatus};
pub use eval::{
    alias_closure, eval_term, expand_aliased, governed_deltas, latest_by_key, result_canonical_hex,
    EvalResult, GroupKey, MaskPolicy, PruneKeep, Term,
};
#[cfg(not(target_arch = "wasm32"))]
pub use http::{offer_for, pull_from_url, serve_peer};
pub use hview::{hview_canonical_hex, HVEntry, HView};
pub use lens_binding::{load_lens_binding, publish_lens_binding_claims, LensBinding};
pub use materialize::{is_root_anchored, MaterializationChange};
pub use pack::{pack_id, pack_set, unpack_set};
pub use parse_error::{ParseError, ParseErrorKind};
pub use peer::{sync_both, Peer, SyncReport};
pub use pred::{compare_primitives, eval_pred, Pred};
pub use preflight::{
    preflight_transfer, CandidateGuard, GuardDecision, GuardedUnit, GuardedUnitStatus,
    PreflightContext, TransferUnit,
};
pub use principal::{
    associated_keys, authors_for_principal, eval_principal_term, lower_principal_registry,
    lower_principal_term, principal_resolver, principal_resolver_for_reactor,
    register_principal_materialization, resolve_principal, AssociatedKey, AssociationGrade,
    PrincipalReadOptions, PrincipalResolver, PrincipalResult, PrincipalSuppression, ScopePolicy,
    ValidityInterval,
};
pub use reactor::{
    make_manifest_claims, manifest_member_ids, IngestResult, NegationReader, Reactor,
};
pub use resolution::{
    apply_policy, decode_view, first_by_order, resolve_view, view_canonical_hex, MergeFn, Order,
    Policy, Schema, View,
};
pub use schema::{collect_reading_refs, collect_refs, HyperSchema, SchemaRegistry};
pub use schema_deltas::{
    hyper_schema_schema, load_governed_hyper_schema, load_governed_schema, load_hyper_schema,
    load_schema, publish_hyper_schema_claims, publish_schema_claims, schema_schema, VOCAB_PREFIX,
};
pub use set::{federate, fork, make_delta, make_negation_claims, merge, DeltaSet};
pub use sign::{sign_claims, verify_delta, Verification};
pub use term_io::{
    cbor_to_json, json_to_cbor, schema_canonical_hex, schema_hash, term_canonical_hex, term_hash,
    term_to_json,
};
pub use term_json::{parse_pred, parse_pred_diagnostic, parse_term, parse_term_diagnostic};
pub use types::{Claims, Delta, DeltaRef, EntityRef, Pointer, Primitive, Target};

pub mod evidence_codec;
pub mod hview_envelope;
pub mod reading_appearance;
mod reading_budget;
mod reading_wire_budget;
pub use evidence_codec::{
    EvidenceCodecError, ReadingAppearanceLimits, DEFAULT_READING_APPEARANCE_LIMITS,
};
pub use hview_envelope::{
    decode_hview_envelope, encode_hview_envelope, HViewEnvelopeLimits,
    DEFAULT_HVIEW_ENVELOPE_LIMITS,
};
pub use reading_appearance::{decode_reading_appearance, encode_reading_appearance};

pub mod materialization_data;

pub mod materialization_source;

mod materialization_basis;
mod materialization_values;
pub mod resolve_evidence;

pub mod materialization_input;

pub mod materialization_command;
mod materialization_evidence;

pub mod materialization_result;

pub mod materialization_control;
pub mod materialization_peer;
pub mod materialization_store;
pub use materialization_command::{
    preflight_materialization_input, MaterializationDiagnostic, MaterializationEndpoint,
    MaterializationInputPreflight, MaterializationSigner,
};
pub use materialization_data::{
    encode_materialization_limits, materialization_description_claims, materialization_max_limits,
    read_materialization_description, read_materialization_limits, MaterializationLimits,
    MaterializationVerb,
};
pub use materialization_input::MaterializationInputBoot;
pub use materialization_result::{
    read_materialization_result, MaterializationResult, MaterializationResultClassification,
    MaterializationResultContext, MaterializationSourceCommitments,
};
pub use materialization_source::{
    decode_materialization_appearance, decode_materialization_authority_spec,
    decode_materialization_binding_spec, decode_materialization_snapshot,
    encode_materialization_appearance, materialization_capture_basis,
    materialization_component_commitments, validate_materialization_capture_basis,
    MaterializationAuthoritySpec, MaterializationBindingSpec, MaterializationCapture,
    MaterializationSourceCapability, MaterializationSourceError, MaterializationSourceFailure,
    MaterializationSourceLimits, MaterializationSourceSnapshot,
};

pub mod evaluation_budget;
