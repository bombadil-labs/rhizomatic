//! Supporting pure syntax evidence primitives (SPEC-16 MR-04).
use crate::cbor::{decode_with_guard, encode, CborPathPart, CborValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceCodecError {
    InvalidEvidence,
    ResourceLimit,
}
impl std::fmt::Display for EvidenceCodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidEvidence => "invalid-evidence",
            Self::ResourceLimit => "resource-limit",
        })
    }
}
impl std::error::Error for EvidenceCodecError {}
pub(crate) type Result<T> = std::result::Result<T, EvidenceCodecError>;
pub(crate) const INVALID: EvidenceCodecError = EvidenceCodecError::InvalidEvidence;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadingAppearanceLimits {
    pub artifact_bytes: usize,
    pub syntax_depth: usize,
    pub syntax_nodes: usize,
}
pub const DEFAULT_READING_APPEARANCE_LIMITS: ReadingAppearanceLimits = ReadingAppearanceLimits {
    artifact_bytes: 16_777_216,
    syntax_depth: 64,
    syntax_nodes: 16_384,
};
impl Default for ReadingAppearanceLimits {
    fn default() -> Self {
        DEFAULT_READING_APPEARANCE_LIMITS
    }
}
impl ReadingAppearanceLimits {
    pub(crate) fn validate(self) -> Result<Self> {
        for (v, max) in [
            (self.artifact_bytes, 16_777_216),
            (self.syntax_depth, 64),
            (self.syntax_nodes, 16_384),
        ] {
            if v == 0 {
                return Err(INVALID);
            }
            limit(v, max)?;
        }
        Ok(self)
    }
}
pub(crate) fn limit(value: usize, maximum: usize) -> Result<()> {
    if value > maximum {
        Err(EvidenceCodecError::ResourceLimit)
    } else {
        Ok(())
    }
}
pub(crate) fn canonical(bytes: &[u8], maximum: usize) -> Result<CborValue> {
    canonical_guard(bytes, maximum, &mut |_, _, _| Ok(()))
}
pub(crate) fn canonical_guard(
    bytes: &[u8],
    maximum: usize,
    guard: &mut impl FnMut(&[CborPathPart], bool, usize) -> Result<()>,
) -> Result<CborValue> {
    limit(bytes.len(), maximum)?;
    let mut guard_error = None;
    let mut adapter = |p: &[CborPathPart], m, l| {
        guard(p, m, l).map_err(|e| {
            guard_error = Some(e);
            e.to_string()
        })
    };
    let value =
        decode_with_guard(bytes, &mut adapter).map_err(|_| guard_error.unwrap_or(INVALID))?;
    unique_keys(&value)?;
    if encode(&value) != bytes {
        return Err(INVALID);
    }
    Ok(value)
}
pub(crate) fn fields<'a>(
    value: &'a CborValue,
    allowed: &[&str],
) -> Result<std::collections::BTreeMap<&'a str, &'a CborValue>> {
    let CborValue::Map(values) = value else {
        return Err(INVALID);
    };
    let mut result = std::collections::BTreeMap::new();
    for (key, v) in values {
        if (!allowed.is_empty() && !allowed.contains(&key.as_str()))
            || result.insert(key.as_str(), v).is_some()
        {
            return Err(INVALID);
        }
    }
    Ok(result)
}
pub(crate) fn get<'a>(
    fields: &std::collections::BTreeMap<&str, &'a CborValue>,
    key: &str,
) -> Result<&'a CborValue> {
    fields.get(key).copied().ok_or(INVALID)
}
pub(crate) fn text(value: &CborValue) -> Result<&str> {
    if let CborValue::Tstr(v) = value {
        Ok(v)
    } else {
        Err(INVALID)
    }
}
pub(crate) fn bytes(value: &CborValue) -> Result<&[u8]> {
    if let CborValue::Bstr(v) = value {
        Ok(v)
    } else {
        Err(INVALID)
    }
}
pub(crate) fn array(value: &CborValue) -> Result<&[CborValue]> {
    if let CborValue::Array(v) = value {
        Ok(v)
    } else {
        Err(INVALID)
    }
}
pub(crate) fn content_id(value: &str) -> Result<&str> {
    if value.len() == 68
        && value.starts_with("1e20")
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(value)
    } else {
        Err(INVALID)
    }
}
pub(crate) fn string(s: impl Into<String>) -> CborValue {
    CborValue::Tstr(s.into())
}
pub(crate) fn map(values: Vec<(&str, CborValue)>) -> CborValue {
    CborValue::Map(values.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

fn unique_keys(value: &CborValue) -> Result<()> {
    match value {
        CborValue::Map(fs) => {
            let mut seen = std::collections::BTreeSet::new();
            for (k, v) in fs {
                if !seen.insert(k) {
                    return Err(INVALID);
                }
                unique_keys(v)?;
            }
        }
        CborValue::Array(vs) => {
            for v in vs {
                unique_keys(v)?;
            }
        }
        _ => {}
    }
    Ok(())
}
