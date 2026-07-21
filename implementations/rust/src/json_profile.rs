//! Parse the JSON debug profile used by the vectors into the logical model (ERRATA "JSON debug
//! profile"). Mirrors ../ts/src/json-profile.ts. The CBOR form is normative; this is for vectors.

use crate::b64u;
use crate::strict::as_object;
use crate::types::{Claims, DeltaRef, EntityRef, Pointer, Primitive, Target};
use serde_json::Value;

const TARGET_SHAPES: &str =
    "target must be a primitive, {id, context?}, {delta, context?}, or {mime, value}";

fn parse_primitive(v: &Value) -> Result<Primitive, String> {
    match v {
        Value::String(s) => Ok(Primitive::Str(s.clone())),
        Value::Bool(b) => Ok(Primitive::Bool(*b)),
        Value::Number(_) => {
            let n = v.as_f64().ok_or("number not representable as f64")?;
            if !n.is_finite() {
                return Err("numeric primitive must be finite".into());
            }
            Ok(Primitive::Num(n))
        }
        _ => Err("primitive must be string | number | boolean".into()),
    }
}

// The profile mirrors the canonical CBOR exactly: a primitive target is the bare value; an
// entity ref is {id, context?}; a delta ref is {delta, context?}. Discrimination is structural
// (SPEC-1 §2.1) — primitives are never objects, and the id/delta key names the ref kind.
fn parse_context(o: &serde_json::Map<String, Value>) -> Result<Option<String>, String> {
    match o.get("context") {
        None => Ok(None),
        // An explicit null (or any non-string) is present-but-malformed: reject, never drop.
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err("context, when present, must be a string".into()),
    }
}

/// The discriminator keys of the three object target shapes. Exactly one may be present: the
/// former first-match-wins reading silently picked an arm and dropped the rest, which is repair
/// (SPEC-4 §2) and is now rejected as ambiguous (issue #25).
const TARGET_DISCRIMINATORS: [&str; 3] = ["id", "delta", "mime"];

fn parse_target(v: &Value) -> Result<Target, String> {
    if matches!(v, Value::String(_) | Value::Number(_) | Value::Bool(_)) {
        return Ok(Target::Primitive(parse_primitive(v)?));
    }
    let o = v.as_object().ok_or(TARGET_SHAPES)?;
    let present: Vec<&str> = TARGET_DISCRIMINATORS
        .iter()
        .filter(|k| o.contains_key(**k))
        .copied()
        .collect();
    if present.is_empty() {
        return Err(TARGET_SHAPES.into());
    }
    if present.len() > 1 {
        return Err(format!(
            "target is ambiguous — {} are both present, but exactly one names the target kind",
            present
                .iter()
                .map(|p| format!("\"{p}\""))
                .collect::<Vec<_>>()
                .join(" and ")
        ));
    }
    if present[0] == "id" {
        let o = as_object(v, "entity ref target", &["id", "context"])?;
        let id = o
            .get("id")
            .and_then(Value::as_str)
            .ok_or("entity ref id must be a string")?
            .to_string();
        return Ok(Target::Entity(EntityRef {
            id,
            context: parse_context(o)?,
        }));
    }
    if present[0] == "delta" {
        let o = as_object(v, "delta ref target", &["delta", "context"])?;
        let delta = o
            .get("delta")
            .and_then(Value::as_str)
            .ok_or("delta ref delta must be a string")?
            .to_string();
        return Ok(Target::Delta(DeltaRef {
            delta,
            context: parse_context(o)?,
        }));
    }
    // A bytes literal has no context (D12). `value` is canonical unpadded base64url — malformed
    // encodings are rejected, never repaired.
    let o = as_object(v, "bytes target", &["mime", "value"])?;
    let mime = o
        .get("mime")
        .and_then(Value::as_str)
        .ok_or("bytes target mime must be a string")?
        .to_string();
    let value_s = o
        .get("value")
        .and_then(Value::as_str)
        .ok_or("bytes target value must be a base64url string")?;
    Ok(Target::Bytes {
        mime,
        value: b64u::decode(value_s)?,
    })
}

fn parse_pointer(v: &Value) -> Result<Pointer, String> {
    let o = as_object(v, "pointer", &["role", "target"])?;
    let role = o
        .get("role")
        .and_then(Value::as_str)
        .ok_or("pointer.role must be a string")?
        .to_string();
    let target = parse_target(o.get("target").ok_or("pointer.target is required")?)?;
    Ok(Pointer { role, target })
}

pub fn parse_claims(v: &Value) -> Result<Claims, String> {
    let o = as_object(v, "claims", &["timestamp", "author", "pointers"])?;
    let timestamp = o
        .get("timestamp")
        .and_then(Value::as_f64)
        .ok_or("claims.timestamp must be a number")?;
    let author = o
        .get("author")
        .and_then(Value::as_str)
        .ok_or("claims.author must be a string")?
        .to_string();
    let pointers_v = o
        .get("pointers")
        .and_then(Value::as_array)
        .ok_or("claims.pointers must be an array")?;
    let pointers = pointers_v
        .iter()
        .map(parse_pointer)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Claims {
        timestamp,
        author,
        pointers,
    })
}

/// Serialize claims back to the JSON debug profile (the inverse of parse_claims).
pub fn claims_to_json(claims: &Claims) -> Value {
    use serde_json::json;
    let pointers: Vec<Value> = claims
        .pointers
        .iter()
        .map(|p| {
            let target = match &p.target {
                Target::Primitive(Primitive::Str(s)) => json!(s),
                Target::Primitive(Primitive::Num(n)) => json!(n),
                Target::Primitive(Primitive::Bool(b)) => json!(b),
                Target::Entity(e) => match &e.context {
                    Some(c) => json!({ "id": e.id, "context": c }),
                    None => json!({ "id": e.id }),
                },
                Target::Delta(d) => match &d.context {
                    Some(c) => json!({ "delta": d.delta, "context": c }),
                    None => json!({ "delta": d.delta }),
                },
                Target::Bytes { mime, value } => {
                    json!({ "mime": mime, "value": b64u::encode(value) })
                }
            };
            json!({ "role": p.role, "target": target })
        })
        .collect();
    json!({ "timestamp": claims.timestamp, "author": claims.author, "pointers": pointers })
}
