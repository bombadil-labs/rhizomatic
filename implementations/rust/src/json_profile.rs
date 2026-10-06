//! Parse the JSON debug profile used by the vectors into the logical model (ERRATA "JSON debug
//! profile"). Mirrors ../ts/src/json-profile.ts. The CBOR form is normative; this is for vectors.

use crate::b64u;
use crate::strict::as_object;
use crate::types::{Claims, Delta, DeltaRef, EntityRef, Pointer, Primitive, Target};
use serde_json::Value;

const TARGET_SHAPES: &str =
    "target must be a primitive, {id, context?}, {delta, context?}, or {mime, value}";

fn debug_object<'a>(
    v: &'a Value,
    what: &str,
    keys: &[&str],
    bounded: bool,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    if !bounded {
        return as_object(v, what, keys);
    }
    let o = v.as_object().ok_or("invalid debug object")?;
    if o.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err("unknown debug field".into());
    }
    Ok(o)
}
// A borrowed grammar traversal shared by allocating parse and bounded size validation.
// It never clones an input string or decodes a bytes literal.
enum DebugTarget<'a> {
    Text(&'a str),
    Number(f64),
    Bool(bool),
    Entity(&'a str, Option<&'a str>),
    Delta(&'a str, Option<&'a str>),
    Bytes(&'a str, &'a str),
}
fn context(o: &serde_json::Map<String, Value>) -> Result<Option<&str>, String> {
    match o.get("context") {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err("context, when present, must be a string".into()),
    }
}
fn debug_target(v: &Value, bounded: bool) -> Result<DebugTarget<'_>, String> {
    match v {
        Value::String(s) => return Ok(DebugTarget::Text(s)),
        Value::Bool(b) => return Ok(DebugTarget::Bool(*b)),
        Value::Number(_) => {
            let n = v.as_f64().ok_or("number not representable as f64")?;
            if !n.is_finite() {
                return Err("numeric primitive must be finite".into());
            }
            return Ok(DebugTarget::Number(n));
        }
        _ => (),
    }
    let o = v.as_object().ok_or(TARGET_SHAPES)?;
    let present: Vec<&str> = ["id", "delta", "mime"]
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
    match present[0] {
        "id" => {
            let o = debug_object(v, "entity ref target", &["id", "context"], bounded)?;
            Ok(DebugTarget::Entity(
                o.get("id")
                    .and_then(Value::as_str)
                    .ok_or("entity ref id must be a string")?,
                context(o)?,
            ))
        }
        "delta" => {
            let o = debug_object(v, "delta ref target", &["delta", "context"], bounded)?;
            Ok(DebugTarget::Delta(
                o.get("delta")
                    .and_then(Value::as_str)
                    .ok_or("delta ref delta must be a string")?,
                context(o)?,
            ))
        }
        _ => {
            let o = debug_object(v, "bytes target", &["mime", "value"], bounded)?;
            Ok(DebugTarget::Bytes(
                o.get("mime")
                    .and_then(Value::as_str)
                    .ok_or("bytes target mime must be a string")?,
                o.get("value")
                    .and_then(Value::as_str)
                    .ok_or("bytes target value must be a base64url string")?,
            ))
        }
    }
}
fn debug_pointer(v: &Value, bounded: bool) -> Result<(&str, DebugTarget<'_>), String> {
    let o = debug_object(v, "pointer", &["role", "target"], bounded)?;
    Ok((
        o.get("role")
            .and_then(Value::as_str)
            .ok_or("pointer.role must be a string")?,
        debug_target(
            o.get("target").ok_or("pointer.target is required")?,
            bounded,
        )?,
    ))
}
struct DebugClaims<'a> {
    timestamp: f64,
    valid_from: f64,
    valid_until: Option<f64>,
    author: &'a str,
    pointers: &'a [Value],
}
fn debug_claims(v: &Value, bounded: bool) -> Result<DebugClaims<'_>, String> {
    let o = debug_object(
        v,
        "claims",
        &["timestamp", "validFrom", "validUntil", "author", "pointers"],
        bounded,
    )?;
    Ok(DebugClaims {
        timestamp: o
            .get("timestamp")
            .and_then(Value::as_f64)
            .ok_or("claims.timestamp must be a number")?,
        valid_from: o
            .get("validFrom")
            .and_then(Value::as_f64)
            .ok_or("claims.validFrom must be a number")?,
        valid_until: o
            .get("validUntil")
            .map(|v| v.as_f64().ok_or("claims.validUntil must be a number"))
            .transpose()?,
        author: o
            .get("author")
            .and_then(Value::as_str)
            .ok_or("claims.author must be a string")?,
        pointers: o
            .get("pointers")
            .and_then(Value::as_array)
            .ok_or("claims.pointers must be an array")?,
    })
}
fn allocate_target(t: DebugTarget<'_>) -> Result<Target, String> {
    Ok(match t {
        DebugTarget::Text(s) => Target::Primitive(Primitive::Str(s.into())),
        DebugTarget::Number(n) => Target::Primitive(Primitive::Num(n)),
        DebugTarget::Bool(b) => Target::Primitive(Primitive::Bool(b)),
        DebugTarget::Entity(id, c) => Target::Entity(EntityRef {
            id: id.into(),
            context: c.map(str::to_string),
        }),
        DebugTarget::Delta(id, c) => Target::Delta(DeltaRef {
            delta: id.into(),
            context: c.map(str::to_string),
        }),
        DebugTarget::Bytes(mime, v) => Target::Bytes {
            mime: mime.into(),
            value: b64u::decode(v)?,
        },
    })
}
pub fn parse_claims(v: &Value) -> Result<Claims, String> {
    let c = debug_claims(v, false)?;
    let pointers = c
        .pointers
        .iter()
        .map(|v| {
            let (role, t) = debug_pointer(v, false)?;
            Ok(Pointer {
                role: role.into(),
                target: allocate_target(t)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Claims {
        timestamp: c.timestamp,
        valid_from: c.valid_from,
        valid_until: c.valid_until,
        author: c.author.into(),
        pointers,
    })
}
// Checked/saturating arithmetic counts every shape, even after the cap is exceeded.
struct DebugSize {
    size: usize,
    cap: usize,
}
impl DebugSize {
    fn add(&mut self, n: usize) {
        self.size = self.size.saturating_add(n).min(self.cap.saturating_add(1));
    }
    fn text(&mut self, s: &str) {
        self.add(crate::cbor::text_byte_length(s));
    }
    fn number(&mut self, n: f64) -> Result<(), String> {
        self.add(crate::cbor::float_byte_length(n)?);
        Ok(())
    }
    fn target(&mut self, t: DebugTarget<'_>) -> Result<(), String> {
        match t {
            DebugTarget::Text(s) => self.text(s),
            DebugTarget::Number(n) => self.number(n)?,
            DebugTarget::Bool(_) => self.add(1),
            DebugTarget::Entity(id, c) | DebugTarget::Delta(id, c) => {
                // Determine key before moving the borrowed target (entity and delta differ).
                self.add(crate::cbor::head_byte_length(if c.is_some() {
                    2
                } else {
                    1
                }));
                self.text(if matches!(t, DebugTarget::Entity(..)) {
                    "id"
                } else {
                    "delta"
                });
                self.text(id);
                if let Some(c) = c {
                    if c.is_empty() {
                        return Err("empty context".into());
                    }
                    self.text("context");
                    self.text(c);
                }
            }
            DebugTarget::Bytes(mime, v) => {
                if mime.is_empty() {
                    return Err("empty mime".into());
                }
                let n = b64u::decoded_length(v)?;
                self.add(crate::cbor::head_byte_length(2));
                self.text("mime");
                self.text(mime);
                self.text("value");
                self.add(crate::cbor::head_byte_length(n));
                self.add(n);
            }
        }
        Ok(())
    }
}
/// Validate debug framing/claims and count canonical claims + signature bytes without payload
/// decoding, input clones, or a canonical claims buffer. Invalid shape always beats saturation.
pub fn delta_debug_delivery_size(raw: &[Value], cap: usize) -> Result<usize, String> {
    let mut size = DebugSize { size: 0, cap };
    for v in raw {
        let o = debug_object(v, "delta", &["id", "claims", "sig"], true)?;
        o.get("id")
            .and_then(Value::as_str)
            .ok_or("delta.id must be text")?;
        let sig = o
            .get("sig")
            .map(|v| v.as_str().ok_or("delta.sig must be text"))
            .transpose()?
            .unwrap_or("");
        if sig.len() % 2 != 0 || !sig.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid signature spelling".into());
        }
        let c = debug_claims(o.get("claims").ok_or("delta.claims is required")?, true)?;
        if c.author.is_empty()
            || !c.timestamp.is_finite()
            || !c.valid_from.is_finite()
            || c.valid_until
                .is_some_and(|n| !n.is_finite() || n <= c.valid_from)
            || c.pointers.is_empty()
        {
            return Err("invalid claims".into());
        }
        size.add(sig.len() / 2);
        size.add(crate::cbor::head_byte_length(if c.valid_until.is_some() {
            5
        } else {
            4
        }));
        size.text("author");
        size.text(c.author);
        size.text("timestamp");
        size.number(c.timestamp)?;
        size.text("validFrom");
        size.number(c.valid_from)?;
        if let Some(n) = c.valid_until {
            size.text("validUntil");
            size.number(n)?;
        }
        size.text("pointers");
        size.add(crate::cbor::head_byte_length(c.pointers.len()));
        for v in c.pointers {
            let (role, t) = debug_pointer(v, true)?;
            if role.is_empty() {
                return Err("empty role".into());
            }
            size.add(crate::cbor::head_byte_length(2));
            size.text("role");
            size.text(role);
            size.text("target");
            size.target(t)?;
        }
    }
    Ok(size.size)
}

/// Strict existing Delta JSON debug framing. Authentication remains a separate delta operation.
pub fn parse_delta(v: &Value) -> Result<Delta, String> {
    let o = as_object(v, "delta", &["id", "claims", "sig"])?;
    Ok(Delta {
        id: o
            .get("id")
            .and_then(Value::as_str)
            .ok_or("delta.id must be text")?
            .into(),
        claims: parse_claims(o.get("claims").ok_or("delta.claims is required")?)?,
        sig: o
            .get("sig")
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .ok_or("delta.sig must be text")
            })
            .transpose()?,
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
    let mut out = json!({ "timestamp": claims.timestamp, "validFrom": claims.valid_from, "author": claims.author, "pointers": pointers });
    if let Some(until) = claims.valid_until {
        out["validUntil"] = json!(until);
    }
    out
}
