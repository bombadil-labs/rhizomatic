//! MR-20 contextual readback: recomputed evidence bytes vs attested source commitments.
use crate::cbor::CborValue;
use crate::hash::content_address;
use crate::materialization_basis::{basis_program, validate_basis, BasisProgram, BASIS_FIELDS};
use crate::materialization_data::{
    encode_materialization_limits, materialization_bytes, materialization_entity,
    materialization_number, materialization_ref, materialization_text,
    read_materialization_description, MaterializationLimits, MaterializationVerb,
};
use crate::materialization_evidence::{validate_envelope, validate_gather_evidence};
use crate::materialization_lifecycle::{classify_control, descriptor_closure};
use crate::materialization_peer::MaterializationControlStatus;
use crate::materialization_source::decode_materialization_snapshot_evidence;
use crate::materialization_values::{
    bytes, cbor, field, id, list, number, object, ordered, require, same, source_limits, text,
    Result,
};
use crate::resolution::{decode_view, view_canonical_hex, View};
use crate::sign::{verify_canonical_delta, Verification};
use crate::types::Delta;
use std::collections::BTreeMap;
#[derive(Debug, Clone)]
pub struct MaterializationResultContext {
    pub receiver: String,
    pub configuration: String,
    pub request: String,
    pub request_delta: Option<Delta>,
    pub evidence: Option<Delta>,
    pub binding: Option<String>,
    pub revision: Option<String>,
    pub authority: Option<String>,
    pub capture: Option<Delta>,
    pub snapshot: Option<Delta>,
    pub received_at: Option<f64>,
    /// The control image a maintained body names, as the store holds it after the CAS (MR-20).
    pub control: Option<Vec<u8>>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterializationResultClassification {
    VerifiedStructure,
    VerifiedContext,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterializationSourceCommitments {
    Attested,
    CommitmentsVerified,
}
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializationResult {
    pub classification: MaterializationResultClassification,
    pub source_commitments: MaterializationSourceCommitments,
    pub receiver_testimony: bool,
    pub execution_verified: bool,
    pub status: String,
    pub body: CborValue,
    /// The decoded View of a resolve body.
    pub value: Option<View>,
    /// The decoded View of every root result of a maintained body, keyed by root.
    pub values: BTreeMap<String, View>,
}
const REFUSALS: &[&str] = &[
    "invalid-appearance",
    "entry-missing",
    "invalid-request",
    "request-outside-validity",
    "configuration-mismatch",
    "unauthorized",
    "unsupported-operation",
    "invalid-arguments",
    "missing-support",
    "unexpected-support",
    "resource-limit",
    "resource-exhausted",
    "invalid-source",
    "source-changed",
    "source-unavailable",
    "invalid-definition",
    "pin-mismatch",
    "ambiguous-definition",
    "definition-closure",
    "definition-cycle",
    "invalid-program",
    "invalid-evidence",
    "missing-reading",
    "execution-failed",
    "already-installed",
    "precondition-failed",
    "time-regression",
    "registration-missing",
    "retired",
    "invalid-control",
    "control-unavailable",
    "write-conflict",
    "control-rejected",
];
const TRANSITION_BODY: &[&str] = &[
    "kind",
    "registration",
    "transition",
    "control",
    "generation",
    "basis",
    "results",
];
/// MR-19 maintained body shapes by kind; each lists its exact field set.
fn maintained_fields(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "install" | "replace-source" | "advance-time" => TRANSITION_BODY,
        "read" => &[
            "kind",
            "registration",
            "control",
            "generation",
            "basis",
            "results",
        ],
        "retire" => &[
            "kind",
            "registration",
            "transition",
            "control",
            "generation",
        ],
        "restore" => &["kind", "control", "generation", "selections"],
        _ => return None,
    })
}
pub fn read_materialization_result(
    outcome: &Delta,
    context: &MaterializationResultContext,
    limits: &MaterializationLimits,
) -> Result<MaterializationResult> {
    encode_materialization_limits(limits)?;
    require(
        verify_canonical_delta(outcome) == Verification::Verified,
        "invalid-evidence",
    )?;
    let outer = read_materialization_description(outcome, None)?;
    require(
        materialization_text(&outer, "kind")? == "outcome/1"
            && materialization_entity(&outer, "receiver")? == context.receiver
            && materialization_ref(&outer, "configuration")? == context.configuration
            && materialization_ref(&outer, "request")? == context.request
            && context
                .received_at
                .is_none_or(|t| t == outcome.claims.timestamp),
        "invalid-evidence",
    )?;
    if let Some(request) = &context.request_delta {
        require(
            verify_canonical_delta(request) == Verification::Verified
                && request.id == context.request,
            "invalid-evidence",
        )?;
        let common = read_materialization_description(request, None)?;
        require(
            materialization_text(&common, "kind")? == "request/1"
                && materialization_entity(&common, "receiver")? == context.receiver
                && materialization_ref(&common, "configuration")? == context.configuration,
            "invalid-evidence",
        )?;
    }
    let body = cbor(
        &materialization_bytes(&outer, "result")?,
        limits["artifactBytes"],
        "invalid-evidence",
    )?;
    let status = materialization_text(&outer, "status")?;
    if status == "refused" {
        let fs = object(&body, &["code"], &[])?;
        let code = text(field(&fs, "code")?)?;
        require(REFUSALS.contains(&code), "invalid-evidence")?;
        return Ok(attested_only(context, status, body));
    }
    if status == "indeterminate" {
        let fs = object(&body, &["code"], &["control"])?;
        let code = text(field(&fs, "code")?)?;
        if code == "result-unavailable" {
            id(field(&fs, "control")?)?;
        } else {
            require(
                code == "commit-unconfirmed" && !fs.contains_key("control"),
                "invalid-evidence",
            )?;
        }
        return Ok(attested_only(context, status, body));
    }
    require(status == "completed", "invalid-evidence")?;
    let CborValue::Map(raw) = &body else {
        return Err("invalid-evidence".into());
    };
    let kind = text(
        &raw.iter()
            .find(|(k, _)| k == "kind")
            .ok_or("invalid-evidence")?
            .1,
    )?
    .to_string();
    if maintained_fields(&kind).is_some() {
        return read_maintained_result(outcome, context, limits, body, &kind);
    }
    let verb = match kind.as_str() {
        "gather" => MaterializationVerb::Gather,
        "resolve" => MaterializationVerb::Resolve,
        _ => return Err("invalid-evidence".into()),
    };
    let fs = object(
        &body,
        if verb == MaterializationVerb::Gather {
            &["kind", "root", "basis", "envelope", "transport", "hview"]
        } else {
            &[
                "kind",
                "root",
                "basis",
                "transport",
                "hview",
                "value",
                "view",
            ]
        },
        &[],
    )?;
    require(!text(field(&fs, "root")?)?.is_empty(), "invalid-evidence")?;
    let basis = field(&fs, "basis")?;
    let program = basis_program(basis, limits)?;
    validate_basis(basis, limits, None)?;
    let b = basis_fields(context, basis)?;
    let source_commitments = verify_source_commitments(context, basis, limits)?;
    let value = if verb == MaterializationVerb::Gather {
        validate_gather_evidence(&body, limits)?;
        None
    } else {
        let payload = bytes(field(&fs, "value")?)?;
        let value = decode_view(payload)?;
        require(
            content_address(payload) == id(field(&fs, "view")?)?
                && hex::decode(view_canonical_hex(&value)).map_err(|_| "invalid-evidence")?
                    == payload,
            "invalid-evidence",
        )?;
        id(field(&fs, "transport")?)?;
        id(field(&fs, "hview")?)?;
        Some(value)
    };
    let mut complete = false;
    if let Some(request) = &context.request_delta {
        let f = read_materialization_description(request, Some(verb))?;
        if verb == MaterializationVerb::Gather {
            require(
                text(field(&fs, "root")?)? == materialization_entity(&f, "root")?
                    && number(field(&b, "servingAt")?)? == outcome.claims.timestamp,
                "invalid-evidence",
            )?;
            for (wire, key) in [
                ("at", "at"),
                ("serving-at", "servingAt"),
                ("definition-at", "definitionAt"),
            ] {
                require(
                    materialization_number(&f, wire)? == number(field(&b, key)?)?,
                    "invalid-evidence",
                )?;
            }
            for (wire, key) in [("hyperschema", "hyperschema"), ("schema", "schema")] {
                require(
                    materialization_ref(&f, wire)? == id(field(&b, key)?)?,
                    "invalid-evidence",
                )?;
            }
            for (wire, key) in [
                ("hyperschema-pin", "hyperschemaPin"),
                ("schema-pin", "schemaPin"),
                ("interpretation", "interpretation"),
            ] {
                require(
                    materialization_text(&f, wire)? == text(field(&b, key)?)?,
                    "invalid-evidence",
                )?;
            }
            require(
                materialization_bytes(&f, "bindings")? == bytes(field(&b, "bindings")?)?,
                "invalid-evidence",
            )?;
            let cutoff = if f.contains_key("historical-cutoff") {
                Some(materialization_number(&f, "historical-cutoff")?)
            } else {
                None
            };
            require(
                cutoff == b.get("historicalCutoff").map(|v| number(v)).transpose()?,
                "invalid-evidence",
            )?;
            let mut named = vec![
                materialization_ref(&f, "hyperschema")?,
                materialization_ref(&f, "schema")?,
            ];
            for t in f.get("definition").into_iter().flatten() {
                named.push(materialization_ref(
                    &std::collections::BTreeMap::from([("x".into(), vec![t.clone()])]),
                    "x",
                )?);
            }
            named.sort();
            require(
                named
                    == program
                        .deltas
                        .iter()
                        .map(|d| d.id.clone())
                        .collect::<Vec<_>>(),
                "invalid-evidence",
            )?;
            if let Some(capture) = &context.capture {
                require(
                    capture.id == materialization_ref(&f, "capture")?,
                    "invalid-evidence",
                )?;
            }
            if let Some(snapshot) = &context.snapshot {
                require(
                    snapshot.id == materialization_ref(&f, "snapshot")?,
                    "invalid-evidence",
                )?;
            }
            complete = true;
        } else if let Some(evidence) = &context.evidence {
            require(
                verify_canonical_delta(evidence) == Verification::Verified
                    && evidence.id == materialization_ref(&f, "evidence")?,
                "invalid-evidence",
            )?;
            let ef = read_materialization_description(evidence, None)?;
            require(
                materialization_text(&ef, "kind")? == "evidence/1",
                "invalid-evidence",
            )?;
            let gathered = cbor(
                &materialization_bytes(&ef, "result")?,
                limits["artifactBytes"],
                "invalid-evidence",
            )?;
            validate_gather_evidence(&gathered, limits)?;
            let gf = object(
                &gathered,
                &["kind", "root", "basis", "envelope", "transport", "hview"],
                &[],
            )?;
            for k in ["root", "basis", "transport", "hview"] {
                require(same(field(&gf, k)?, field(&fs, k)?), "invalid-evidence")?;
            }
            complete = true;
        }
    }
    Ok(MaterializationResult {
        classification: if complete {
            MaterializationResultClassification::VerifiedContext
        } else {
            MaterializationResultClassification::VerifiedStructure
        },
        source_commitments,
        receiver_testimony: true,
        execution_verified: false,
        status,
        body,
        value,
        values: BTreeMap::new(),
    })
}
/// A refused or indeterminate outcome: receiver testimony with nothing recomputable.
fn attested_only(
    context: &MaterializationResultContext,
    status: String,
    body: CborValue,
) -> MaterializationResult {
    MaterializationResult {
        classification: if context.request_delta.is_some() {
            MaterializationResultClassification::VerifiedContext
        } else {
            MaterializationResultClassification::VerifiedStructure
        },
        source_commitments: MaterializationSourceCommitments::Attested,
        receiver_testimony: true,
        execution_verified: false,
        status,
        body,
        value: None,
        values: BTreeMap::new(),
    }
}
/// The Basis field map, with every contextual expected binding/revision/authority compared.
fn basis_fields<'a>(
    context: &MaterializationResultContext,
    basis: &'a CborValue,
) -> Result<BTreeMap<&'a str, &'a CborValue>> {
    let b = object(basis, BASIS_FIELDS, &["historicalCutoff"])?;
    for (k, expected) in [
        ("binding", &context.binding),
        ("revision", &context.revision),
        ("authority", &context.authority),
    ] {
        if let Some(expected) = expected {
            require(id(field(&b, k)?)? == *expected, "invalid-evidence")?;
        }
    }
    Ok(b)
}
/// Recompute a supplied capture/snapshot pair's commitments and compare them to the Basis.
fn verify_source_commitments(
    context: &MaterializationResultContext,
    basis: &CborValue,
    limits: &MaterializationLimits,
) -> Result<MaterializationSourceCommitments> {
    require(
        context.capture.is_some() == context.snapshot.is_some(),
        "invalid-evidence",
    )?;
    let (Some(capture), Some(snapshot)) = (&context.capture, &context.snapshot) else {
        return Ok(MaterializationSourceCommitments::Attested);
    };
    require(
        verify_canonical_delta(capture) == Verification::Verified
            && verify_canonical_delta(snapshot) == Verification::Verified,
        "invalid-evidence",
    )?;
    let cf = read_materialization_description(capture, None)?;
    let sf = read_materialization_description(snapshot, None)?;
    require(
        materialization_text(&cf, "kind")? == "capture/1"
            && materialization_text(&sf, "kind")? == "snapshot/1",
        "invalid-evidence",
    )?;
    let payload = materialization_bytes(&sf, "data")?;
    let (snap, checker) = decode_materialization_snapshot_evidence(&payload, source_limits(limits))
        .map_err(|e| e.to_string())?;
    checker
        .validate(&materialization_bytes(&cf, "basis")?)
        .map_err(|e| e.to_string())?;
    require(
        materialization_ref(&cf, "source-binding")? == snap.binding
            && materialization_ref(&cf, "authority")? == snap.authority
            && capture.claims.timestamp == snap.serving_at
            && capture.claims.valid_from == snap.serving_at
            && capture
                .claims
                .valid_until
                .is_none_or(|end| snap.serving_at < end),
        "invalid-evidence",
    )?;
    validate_basis(basis, limits, Some(&snap))?;
    Ok(MaterializationSourceCommitments::CommitmentsVerified)
}
/// One MR-19 RootResult: strict envelope, recomputed digests, decoded View.
fn read_root_result(v: &CborValue, limits: &MaterializationLimits) -> Result<(String, View)> {
    let fs = object(
        v,
        &["root", "envelope", "transport", "hview", "value", "view"],
        &[],
    )?;
    let root = text(field(&fs, "root")?)?;
    require(!root.is_empty(), "invalid-evidence")?;
    validate_envelope(
        bytes(field(&fs, "envelope")?)?,
        &id(field(&fs, "transport")?)?,
        &id(field(&fs, "hview")?)?,
        limits,
    )?;
    let payload = bytes(field(&fs, "value")?)?;
    let value = decode_view(payload)?;
    require(
        content_address(payload) == id(field(&fs, "view")?)?
            && hex::decode(view_canonical_hex(&value)).map_err(|_| "invalid-evidence")? == payload,
        "invalid-evidence",
    )?;
    Ok((root.to_string(), value))
}
#[derive(Debug, PartialEq)]
struct Selection {
    registration: String,
    status: String,
    source_revision: String,
    authority: String,
    at: f64,
    definition_at: f64,
    hyperschema_pin: String,
    schema_pin: String,
}
/// One RestoreBody selection; availability is a function of status, never a claim of its own.
fn read_selection(v: &CborValue) -> Result<Selection> {
    let fs = object(
        v,
        &[
            "registration",
            "status",
            "sourceRevision",
            "authority",
            "at",
            "definitionAt",
            "hyperschemaPin",
            "schemaPin",
            "availability",
        ],
        &[],
    )?;
    let status = text(field(&fs, "status")?)?;
    require(
        (status == "active" || status == "retired")
            && text(field(&fs, "availability")?)?
                == if status == "active" {
                    "unchecked"
                } else {
                    "retired"
                },
        "invalid-evidence",
    )?;
    Ok(Selection {
        registration: id(field(&fs, "registration")?)?,
        status: status.to_string(),
        source_revision: id(field(&fs, "sourceRevision")?)?,
        authority: id(field(&fs, "authority")?)?,
        at: number(field(&fs, "at")?)?,
        definition_at: number(field(&fs, "definitionAt")?)?,
        hyperschema_pin: id(field(&fs, "hyperschemaPin")?)?,
        schema_pin: id(field(&fs, "schemaPin")?)?,
    })
}
/// MR-20 for the six maintained bodies. Structure is always verified; the answer is contextual
/// only when the request and the named control image both link to it, and a serving body also
/// covers its descriptor's complete root partition.
fn read_maintained_result(
    outcome: &Delta,
    context: &MaterializationResultContext,
    limits: &MaterializationLimits,
    body: CborValue,
    kind: &str,
) -> Result<MaterializationResult> {
    let fs = object(&body, maintained_fields(kind).unwrap(), &[])?;
    let serving = fs.contains_key("basis");
    let generation = number(field(&fs, "generation")?)?;
    require(
        generation.fract() == 0.0 && generation >= if kind == "restore" { 0.0 } else { 1.0 },
        "invalid-evidence",
    )?;
    let control = text(field(&fs, "control")?)?.to_string();
    require(
        if kind == "restore" {
            control.is_empty() == (generation == 0.0)
        } else {
            !control.is_empty()
        },
        "invalid-evidence",
    )?;
    if !control.is_empty() {
        id(field(&fs, "control")?)?;
    }
    let registration = if kind == "restore" {
        None
    } else {
        Some(id(field(&fs, "registration")?)?)
    };
    let transition = fs.get("transition").map(|v| id(v)).transpose()?;
    let selections = if kind == "restore" {
        list(field(&fs, "selections")?)?
            .iter()
            .map(read_selection)
            .collect::<Result<Vec<_>>>()?
    } else {
        vec![]
    };
    ordered(
        &selections
            .iter()
            .map(|x| x.registration.clone())
            .collect::<Vec<_>>(),
    )?;
    let mut program: Option<BasisProgram> = None;
    let mut b: Option<BTreeMap<&str, &CborValue>> = None;
    let mut source_commitments = MaterializationSourceCommitments::Attested;
    let mut values = BTreeMap::new();
    if serving {
        let basis = field(&fs, "basis")?;
        program = Some(basis_program(basis, limits)?);
        validate_basis(basis, limits, None)?;
        b = Some(basis_fields(context, basis)?);
        source_commitments = verify_source_commitments(context, basis, limits)?;
        let mut roots = vec![];
        let rows = list(field(&fs, "results")?)?;
        require(rows.len() <= limits["roots"], "resource-limit")?;
        for r in rows {
            let (root, view) = read_root_result(r, limits)?;
            require(
                values.insert(root.clone(), view).is_none(),
                "invalid-evidence",
            )?;
            roots.push(root);
        }
        ordered(&roots)?;
    } else {
        require(
            context.capture.is_none()
                && context.snapshot.is_none()
                && context.binding.is_none()
                && context.revision.is_none()
                && context.authority.is_none(),
            "invalid-evidence",
        )?;
    }
    let mut request_linked = false;
    let mut request_fields = None;
    if let Some(request) = &context.request_delta {
        let verb = MaterializationVerb::parse(kind).ok_or("invalid-evidence")?;
        let f = read_materialization_description(request, Some(verb))?;
        if let Some(registration) = &registration {
            require(
                materialization_ref(&f, "registration")? == *registration,
                "invalid-evidence",
            )?;
        }
        if kind == "read" || kind == "restore" {
            require(
                materialization_text(&f, "expected-control")? == control,
                "invalid-evidence",
            )?;
        }
        if serving {
            let b = b.as_ref().unwrap();
            require(
                number(field(b, "servingAt")?)? == outcome.claims.timestamp
                    && materialization_number(&f, "serving-at")? == outcome.claims.timestamp,
                "invalid-evidence",
            )?;
            if kind == "install" || kind == "advance-time" {
                require(
                    materialization_number(&f, "at")? == number(field(b, "at")?)?,
                    "invalid-evidence",
                )?;
            }
            if kind == "read" || kind == "advance-time" {
                require(
                    materialization_text(&f, "expected-source")? == id(field(b, "revision")?)?,
                    "invalid-evidence",
                )?;
            }
            if let (Some(capture), true) = (&context.capture, f.contains_key("capture")) {
                require(
                    capture.id == materialization_ref(&f, "capture")?,
                    "invalid-evidence",
                )?;
            }
            if let Some(snapshot) = &context.snapshot {
                require(
                    snapshot.id == materialization_ref(&f, "snapshot")?,
                    "invalid-evidence",
                )?;
            }
        }
        request_linked = true;
        request_fields = Some(f);
    }
    let mut control_linked = false;
    if let Some(image) = &context.control {
        let state = classify_control(image, &context.receiver, &context.configuration, limits)
            .map_err(|e| {
                if e == "resource-limit" {
                    e
                } else {
                    "invalid-evidence".to_string()
                }
            })?;
        require(
            state.revision == control && state.image.generation == generation,
            "invalid-evidence",
        )?;
        if kind == "restore" {
            let expected: Vec<Selection> = state
                .image
                .entries
                .iter()
                .map(|e| Selection {
                    registration: e.registration.clone(),
                    status: match e.status {
                        MaterializationControlStatus::Active => "active".into(),
                        MaterializationControlStatus::Retired => "retired".into(),
                    },
                    source_revision: e.source_revision.clone(),
                    authority: e.authority.clone(),
                    at: e.at,
                    definition_at: e.definition_at,
                    hyperschema_pin: e.hyperschema_pin.clone(),
                    schema_pin: e.schema_pin.clone(),
                })
                .collect();
            require(expected == selections, "invalid-evidence")?;
        } else {
            let stored = state
                .stored
                .get(registration.as_ref().unwrap())
                .ok_or("invalid-evidence")?;
            let e = &stored.entry;
            if let Some(t) = &transition {
                require(stored.transition.id == *t, "invalid-evidence")?;
            }
            require(
                (e.status == MaterializationControlStatus::Retired) == (kind == "retire"),
                "invalid-evidence",
            )?;
            if let (Some(_), Some(f)) = (&transition, &request_fields) {
                // The selected transition must answer this request: same verb, and its prior
                // control is the control the request expected.
                let tf = read_materialization_description(&stored.transition, None)?;
                require(
                    materialization_text(&tf, "verb")? == kind
                        && materialization_text(&tf, "prior-control")?
                            == materialization_text(f, "expected-control")?,
                    "invalid-evidence",
                )?;
            }
            if serving {
                let d = stored.descriptor.as_ref().ok_or("invalid-evidence")?;
                let b = b.as_ref().unwrap();
                let program = program.as_ref().unwrap();
                let mut roots = d.roots.clone();
                roots.sort();
                require(
                    e.source_revision == id(field(b, "revision")?)?
                        && e.authority == id(field(b, "authority")?)?
                        && e.at == number(field(b, "at")?)?
                        && e.definition_at == number(field(b, "definitionAt")?)?
                        && e.hyperschema_pin == text(field(b, "hyperschemaPin")?)?
                        && e.schema_pin == text(field(b, "schemaPin")?)?
                        && d.binding == id(field(b, "binding")?)?
                        && d.hyper == id(field(b, "hyperschema")?)?
                        && d.reading == id(field(b, "schema")?)?
                        && d.bindings.as_slice() == bytes(field(b, "bindings")?)?
                        && descriptor_closure(d)
                            == program
                                .deltas
                                .iter()
                                .map(|x| x.id.clone())
                                .collect::<Vec<_>>()
                        && roots == values.keys().cloned().collect::<Vec<_>>(),
                    "invalid-evidence",
                )?;
            }
        }
        control_linked = true;
    }
    Ok(MaterializationResult {
        classification: if request_linked && control_linked {
            MaterializationResultClassification::VerifiedContext
        } else {
            MaterializationResultClassification::VerifiedStructure
        },
        source_commitments,
        receiver_testimony: true,
        execution_verified: false,
        status: "completed".into(),
        body,
        value: None,
        values,
    })
}
