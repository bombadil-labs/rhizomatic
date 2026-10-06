//! Shared pure command values. No host observation or source grant.
use crate::cbor::{encode, CborValue};
use crate::evidence_codec::{canonical, fields, get, EvidenceCodecError};
use crate::materialization_data::MaterializationLimits;
use crate::materialization_source::MaterializationSourceLimits;
use std::collections::BTreeMap;
pub(crate) type Result<T> = std::result::Result<T, String>;
pub(crate) fn require(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(code.into())
    }
}
pub(crate) fn limit(n: usize, max: usize) -> Result<()> {
    require(n <= max, "resource-limit")
}
pub(crate) fn object<'a>(
    v: &'a CborValue,
    required: &[&str],
    optional: &[&str],
) -> Result<BTreeMap<&'a str, &'a CborValue>> {
    let fs = fields(v, &[required, optional].concat()).map_err(|_| "invalid-evidence")?;
    require(
        required.iter().all(|k| fs.contains_key(k)),
        "invalid-evidence",
    )?;
    Ok(fs)
}
pub(crate) fn field<'a>(fs: &BTreeMap<&str, &'a CborValue>, k: &str) -> Result<&'a CborValue> {
    get(fs, k).map_err(|_| "invalid-evidence".into())
}
pub(crate) fn text(v: &CborValue) -> Result<&str> {
    if let CborValue::Tstr(s) = v {
        Ok(s)
    } else {
        Err("invalid-evidence".into())
    }
}
pub(crate) fn bytes(v: &CborValue) -> Result<&[u8]> {
    if let CborValue::Bstr(s) = v {
        Ok(s)
    } else {
        Err("invalid-evidence".into())
    }
}
pub(crate) fn number(v: &CborValue) -> Result<f64> {
    if let CborValue::Float(n) = v {
        require(n.is_finite(), "invalid-evidence")?;
        Ok(*n)
    } else {
        Err("invalid-evidence".into())
    }
}
pub(crate) fn list(v: &CborValue) -> Result<&[CborValue]> {
    if let CborValue::Array(xs) = v {
        Ok(xs)
    } else {
        Err("invalid-evidence".into())
    }
}
pub(crate) fn id(v: &CborValue) -> Result<String> {
    let s = text(v)?;
    require(crate::command_data::is_content_id(s), "invalid-evidence")?;
    Ok(s.into())
}
pub(crate) fn peer(v: &CborValue) -> Result<String> {
    let s = text(v)?;
    require(crate::command_data::is_author(s), "invalid-evidence")?;
    Ok(s.into())
}
pub(crate) fn ordered(xs: &[String]) -> Result<()> {
    require(xs.windows(2).all(|w| w[0] < w[1]), "invalid-evidence")
}
pub(crate) fn s(v: &str) -> CborValue {
    CborValue::Tstr(v.into())
}
pub(crate) fn map(fs: Vec<(&str, CborValue)>) -> CborValue {
    CborValue::Map(fs.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
pub(crate) fn cbor(input: &[u8], max: usize, code: &str) -> Result<CborValue> {
    canonical(input, max).map_err(|e| {
        if e == EvidenceCodecError::ResourceLimit {
            "resource-limit".into()
        } else {
            code.into()
        }
    })
}
pub(crate) fn same(a: &CborValue, b: &CborValue) -> bool {
    encode(a) == encode(b)
}
pub(crate) fn source_limits(limits: &MaterializationLimits) -> MaterializationSourceLimits {
    MaterializationSourceLimits {
        artifact_bytes: limits["artifactBytes"],
        appearances: limits["appearances"],
        pointers: limits["pointers"],
        components: limits["components"],
        inventory_ids: limits["inventoryIds"],
    }
}
pub(crate) fn envelope_limits(
    limits: &MaterializationLimits,
) -> crate::resolve_evidence::HViewEnvelopeLimits {
    crate::resolve_evidence::HViewEnvelopeLimits {
        artifact_bytes: limits["artifactBytes"],
        appearances: limits["appearances"],
        pointers: limits["pointers"],
        entries: limits["entries"],
        nodes: limits["nodes"],
        depth: limits["depth"],
        buckets: limits["buckets"],
        readings: limits["readings"],
        syntax_depth: limits["syntaxDepth"],
        syntax_nodes: limits["syntaxNodes"],
    }
}
