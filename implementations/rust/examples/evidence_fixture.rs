//! Fresh-process codec-only transport host. Does not attest execution or authorization.
#[path = "../tests/support/evidence_fixture.rs"]
mod support;
use rhizomatic::hview_envelope::{decode_hview_envelope, encode_hview_envelope};
use serde_json::{json, Value};
use std::io::{self, Read};
fn run(v: &Value) -> Result<Value, String> {
    let limits = support::limits(&v["limits"]);
    let native = match v["mode"].as_str() {
        Some("encode") => support::fixture_view(&v["native"]),
        Some("decode") => decode_hview_envelope(
            &hex::decode(v["envelopeHex"].as_str().ok_or("hex")?).map_err(|e| e.to_string())?,
            limits,
        )
        .map_err(|e| e.to_string()),
        _ => Err("mode".into()),
    }?;
    let bytes = encode_hview_envelope(&native, limits).map_err(|e| e.to_string())?;
    let schema = rhizomatic::term_json::parse_schema(
        &json!({"props":{},"default":{"pick":{"order":"lexById"}}}),
    )?;
    let resolution = match rhizomatic::resolution::resolve_view(&schema, &native) {
        Ok(view) => {
            json!({"status":"resolved","viewHex":rhizomatic::resolution::view_canonical_hex(&view)})
        }
        Err(e) => {
            if e.contains("reading") {
                json!({"status":"missing-reading"})
            } else {
                json!({"status":"native-refusal"})
            }
        }
    };
    Ok(
        json!({"envelopeHex":hex::encode(&bytes),"transportId":rhizomatic::hash::content_address(&bytes),"existingHViewHex":rhizomatic::hview::hview_canonical_hex(&native),"native":support::inspect_view(&native),"resolution":resolution}),
    )
}
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let v: Value = serde_json::from_str(&input).unwrap();
    let out = run(&v).unwrap_or_else(|e| json!({"error":e}));
    println!("{}", out);
}
