//! Complete supplied evidence, never execution proof or present source permission.
use crate::cbor::{encode, CborValue};
use crate::hash::content_address;
use crate::materialization_basis::{basis_program, validate_basis};
use crate::materialization_data::MaterializationLimits;
use crate::materialization_values::{
    bytes, envelope_limits, field, id, limit, object, require, text, Result,
};
use crate::resolve_evidence::{decode_hview_envelope, hview_canonical_hex, HView};
use crate::schema::inspect_program_reading;
pub(crate) struct GatherEvidence {
    pub hview: HView,
}
pub(crate) fn validate_gather_evidence(
    body: &CborValue,
    limits: &MaterializationLimits,
) -> Result<GatherEvidence> {
    let fs = object(
        body,
        &["kind", "root", "basis", "envelope", "transport", "hview"],
        &[],
    )?;
    require(
        text(field(&fs, "kind")?)? == "gather" && !text(field(&fs, "root")?)?.is_empty(),
        "invalid-evidence",
    )?;
    let hview = validate_envelope(
        bytes(field(&fs, "envelope")?)?,
        &id(field(&fs, "transport")?)?,
        &id(field(&fs, "hview")?)?,
        limits,
    )?;
    basis_program(field(&fs, "basis")?, limits)?;
    validate_basis(field(&fs, "basis")?, limits, None)?;
    limit(encode(body).len(), limits["artifactBytes"])?;
    Ok(GatherEvidence { hview })
}
/// Strict HView envelope readback (MR-20): decode under the limits, recompute transport and hview
/// digests from the bytes, and refuse any reading the materialization grammar cannot run.
pub(crate) fn validate_envelope(
    envelope: &[u8],
    transport: &str,
    hview_id: &str,
    limits: &MaterializationLimits,
) -> Result<HView> {
    let hview =
        decode_hview_envelope(envelope, envelope_limits(limits)).map_err(|e| e.to_string())?;
    let hview_bytes = hex::decode(hview_canonical_hex(&hview)).map_err(|_| "invalid-evidence")?;
    require(
        content_address(envelope) == transport && content_address(&hview_bytes) == hview_id,
        "invalid-evidence",
    )?;
    fn check(node: &HView) -> Result<()> {
        for entry in node.props.values().flatten() {
            for reading in entry.readings.values() {
                let inspected = inspect_program_reading(reading, &crate::pred::Bindings::new());
                require(
                    !inspected.acts_for && !inspected.invalid && !inspected.contextual_reading,
                    "invalid-program",
                )?;
            }
            for child in entry.expanded.values() {
                check(child)?;
            }
        }
        Ok(())
    }
    check(&hview)?;
    Ok(hview)
}
pub(crate) fn missing_reading(hview: &HView) -> bool {
    hview.props.values().flatten().any(|entry| {
        entry
            .expanded
            .iter()
            .any(|(i, c)| !entry.readings.contains_key(i) || missing_reading(c))
    })
}
