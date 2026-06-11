//! Parse the JSON debug profile used by the vectors into the logical model (ERRATA "JSON debug
//! profile"). Mirrors ../ts/src/json-profile.ts. The CBOR form is normative; this is for vectors.

use crate::types::{Claims, DeltaRef, EntityRef, Pointer, Primitive, Target};
use serde_json::Value;

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

fn parse_target(v: &Value) -> Result<Target, String> {
    let o = v.as_object().ok_or("target must be an object")?;
    if let Some(val) = o.get("value") {
        return Ok(Target::Primitive(parse_primitive(val)?));
    }
    if let Some(e) = o.get("entityRef") {
        let eo = e.as_object().ok_or("entityRef must be an object")?;
        let id = eo
            .get("id")
            .and_then(Value::as_str)
            .ok_or("entityRef.id must be a string")?
            .to_string();
        let context = eo
            .get("context")
            .and_then(Value::as_str)
            .map(str::to_string);
        return Ok(Target::Entity(EntityRef { id, context }));
    }
    if let Some(d) = o.get("deltaRef") {
        let dobj = d.as_object().ok_or("deltaRef must be an object")?;
        let delta = dobj
            .get("delta")
            .and_then(Value::as_str)
            .ok_or("deltaRef.delta must be a string")?
            .to_string();
        let context = dobj
            .get("context")
            .and_then(Value::as_str)
            .map(str::to_string);
        return Ok(Target::Delta(DeltaRef { delta, context }));
    }
    Err("target must be one of value | entityRef | deltaRef".into())
}

fn parse_pointer(v: &Value) -> Result<Pointer, String> {
    let o = v.as_object().ok_or("pointer must be an object")?;
    let role = o
        .get("role")
        .and_then(Value::as_str)
        .ok_or("pointer.role must be a string")?
        .to_string();
    let target = parse_target(o.get("target").ok_or("pointer.target is required")?)?;
    Ok(Pointer { role, target })
}

pub fn parse_claims(v: &Value) -> Result<Claims, String> {
    let o = v.as_object().ok_or("claims must be an object")?;
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
                Target::Primitive(Primitive::Str(s)) => json!({ "value": s }),
                Target::Primitive(Primitive::Num(n)) => json!({ "value": n }),
                Target::Primitive(Primitive::Bool(b)) => json!({ "value": b }),
                Target::Entity(e) => match &e.context {
                    Some(c) => json!({ "entityRef": { "id": e.id, "context": c } }),
                    None => json!({ "entityRef": { "id": e.id } }),
                },
                Target::Delta(d) => match &d.context {
                    Some(c) => json!({ "deltaRef": { "delta": d.delta, "context": c } }),
                    None => json!({ "deltaRef": { "delta": d.delta } }),
                },
            };
            json!({ "role": p.role, "target": target })
        })
        .collect();
    json!({ "timestamp": claims.timestamp, "author": claims.author, "pointers": pointers })
}
