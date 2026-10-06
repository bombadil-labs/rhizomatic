//! MR-20 contextual readback: recomputed evidence bytes vs attested source commitments.
use crate::cbor::CborValue;
use crate::hash::content_address;
use crate::materialization_basis::{basis_program, validate_basis, BASIS_FIELDS};
use crate::materialization_data::{
    encode_materialization_limits, materialization_bytes, materialization_entity,
    materialization_number, materialization_ref, materialization_text,
    read_materialization_description, MaterializationLimits, MaterializationVerb,
};
use crate::materialization_evidence::validate_gather_evidence;
use crate::materialization_source::decode_materialization_snapshot_evidence;
use crate::materialization_values::{
    bytes, cbor, field, id, number, object, require, same, source_limits, text, Result,
};
use crate::resolution::{decode_view, view_canonical_hex, View};
use crate::sign::{verify_canonical_delta, Verification};
use crate::types::Delta;
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
    pub value: Option<View>,
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
        require(
            [
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
            ]
            .contains(&code),
            "invalid-evidence",
        )?;
        return Ok(MaterializationResult {
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
        });
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
    )?;
    let verb = match kind {
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
    require(
        context.capture.is_some() == context.snapshot.is_some(),
        "invalid-evidence",
    )?;
    let mut source_commitments = MaterializationSourceCommitments::Attested;
    if let (Some(capture), Some(snapshot)) = (&context.capture, &context.snapshot) {
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
        let (snap, checker) =
            decode_materialization_snapshot_evidence(&payload, source_limits(limits))
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
        source_commitments = MaterializationSourceCommitments::CommitmentsVerified;
    }
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
    })
}
