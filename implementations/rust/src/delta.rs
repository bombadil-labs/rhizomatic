//! Canonical bytes, id computation, validation (SPEC-1). Mirrors ../ts/src/delta.ts.

use crate::cbor::{encode, CborValue};
use crate::hash::content_address;
use crate::types::{Claims, Pointer, Primitive, Target};

fn target_to_cbor(t: &Target) -> CborValue {
    match t {
        Target::Primitive(Primitive::Str(s)) => CborValue::Tstr(s.clone()),
        Target::Primitive(Primitive::Bool(b)) => CborValue::Bool(*b),
        Target::Primitive(Primitive::Num(n)) => CborValue::Float(*n),
        Target::Entity(e) => {
            let mut m = vec![("id".to_string(), CborValue::Tstr(e.id.clone()))];
            if let Some(c) = &e.context {
                m.push(("context".to_string(), CborValue::Tstr(c.clone())));
            }
            CborValue::Map(m)
        }
        Target::Delta(d) => {
            let mut m = vec![("delta".to_string(), CborValue::Tstr(d.delta.clone()))];
            if let Some(c) = &d.context {
                m.push(("context".to_string(), CborValue::Tstr(c.clone())));
            }
            CborValue::Map(m)
        }
    }
}

fn pointer_to_cbor(p: &Pointer) -> CborValue {
    CborValue::Map(vec![
        ("role".to_string(), CborValue::Tstr(p.role.clone())),
        ("target".to_string(), target_to_cbor(&p.target)),
    ])
}

pub fn claims_to_cbor(claims: &Claims) -> CborValue {
    CborValue::Map(vec![
        ("author".to_string(), CborValue::Tstr(claims.author.clone())),
        (
            "pointers".to_string(),
            CborValue::Array(claims.pointers.iter().map(pointer_to_cbor).collect()),
        ),
        ("timestamp".to_string(), CborValue::Float(claims.timestamp)),
    ])
}

fn check_nfc(s: &str, what: &str) -> Result<(), String> {
    if unicode_normalization::is_nfc(s) {
        Ok(())
    } else {
        Err(format!("{what} must be NFC-normalized (ERRATA D11): {s:?}"))
    }
}

/// Reject malformed claims at the boundary; never repair (SPEC-4 §2).
pub fn validate(claims: &Claims) -> Result<(), String> {
    if claims.author.is_empty() {
        return Err("author must be non-empty".into());
    }
    check_nfc(&claims.author, "author")?;
    if !claims.timestamp.is_finite() {
        return Err("timestamp must be finite".into());
    }
    if claims.pointers.is_empty() {
        return Err("a delta MUST contain at least one pointer".into());
    }
    for p in &claims.pointers {
        if p.role.is_empty() {
            return Err("role must be non-empty".into());
        }
        check_nfc(&p.role, "role")?;
        match &p.target {
            Target::Primitive(Primitive::Num(n)) => {
                if !n.is_finite() {
                    return Err("numeric primitive must be finite".into());
                }
            }
            Target::Primitive(Primitive::Str(s)) => check_nfc(s, "string primitive")?,
            Target::Primitive(Primitive::Bool(_)) => {}
            Target::Entity(e) => check_nfc(&e.id, "entity id")?,
            Target::Delta(d) => check_nfc(&d.delta, "delta ref")?,
        }
        let ctx = match &p.target {
            Target::Entity(e) => e.context.as_ref(),
            Target::Delta(d) => d.context.as_ref(),
            Target::Primitive(_) => None,
        };
        if let Some(c) = ctx {
            if c.is_empty() {
                return Err("context, when present, must be non-empty".into());
            }
            check_nfc(c, "context")?;
        }
    }
    Ok(())
}

pub fn canonical_bytes(claims: &Claims) -> Result<Vec<u8>, String> {
    validate(claims)?;
    Ok(encode(&claims_to_cbor(claims)))
}

pub fn canonical_hex(claims: &Claims) -> Result<String, String> {
    Ok(hex::encode(canonical_bytes(claims)?))
}

pub fn compute_id(claims: &Claims) -> Result<String, String> {
    Ok(content_address(&canonical_bytes(claims)?))
}
