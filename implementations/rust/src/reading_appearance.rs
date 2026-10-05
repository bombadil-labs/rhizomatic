//! Full reading appearances; semantic schema_hash continues excluding name/alg.
use crate::cbor::{encode, CborValue};
use crate::evidence_codec::{
    bytes, canonical, fields, get, limit, map, string, text, ReadingAppearanceLimits, Result,
    INVALID,
};
use crate::resolution::Schema;
use crate::term_io::{cbor_to_json, json_to_cbor, schema_to_json};
use crate::term_json::parse_schema;

pub fn encode_reading_appearance(
    schema: &Schema,
    limits: ReadingAppearanceLimits,
) -> Result<Vec<u8>> {
    let limits = limits.validate()?;
    crate::reading_budget::check(schema, limits)?;
    if schema.alg.is_some_and(|n| !n.is_finite()) {
        return Err(INVALID);
    }
    let mut body = schema_to_json(schema);
    body.as_object_mut().ok_or(INVALID)?.remove("name");
    body.as_object_mut().ok_or(INVALID)?.remove("alg");
    parse_schema(&body).map_err(|_| INVALID)?;
    let body = encode(&json_to_cbor(&body).map_err(|_| INVALID)?);
    let mut items = vec![("body", CborValue::Bstr(body))];
    if let Some(name) = &schema.name {
        items.push(("name", string(name)));
    }
    if let Some(alg) = schema.alg {
        items.push(("alg", CborValue::Float(alg)));
    }
    let result = encode(&map(items));
    limit(result.len(), limits.artifact_bytes)?;
    Ok(result)
}
pub fn decode_reading_appearance(input: &[u8], limits: ReadingAppearanceLimits) -> Result<Schema> {
    let limits = limits.validate()?;
    let raw = canonical(input, limits.artifact_bytes)?;
    let fs = fields(&raw, &["body", "name", "alg"])?;
    let body = canonical(bytes(get(&fs, "body")?)?, limits.artifact_bytes)?;
    fields(&body, &["props", "default"])?;
    crate::reading_wire_budget::check(&body, limits)?;
    let mut result = parse_schema(&cbor_to_json(&body)).map_err(|_| INVALID)?;
    if let Some(name) = fs.get("name") {
        result.name = Some(text(name)?.into());
    }
    if let Some(alg) = fs.get("alg") {
        let CborValue::Float(v) = alg else {
            return Err(INVALID);
        };
        result.alg = Some(*v);
    }
    if encode_reading_appearance(&result, limits)? != input {
        return Err(INVALID);
    }
    Ok(result)
}
