//! Fixed conformance transport. All semantic ports exchange signed Delta debug descriptions.
use rhizomatic::command_data::{
    read_common_request, read_operation, read_request, request_pointers,
};
use rhizomatic::json_profile::{claims_to_json, parse_claims};
use rhizomatic::sign::{sign_claims, verify_delta, Verification};
use rhizomatic::types::Delta;
use serde_json::{json, Value};
use std::io::{self, Read};
fn delta(v: &Value) -> Result<Delta, String> {
    let o = v.as_object().ok_or("delta object required")?;
    if o.len() != 3 || !o.contains_key("id") || !o.contains_key("claims") || !o.contains_key("sig")
    {
        return Err("strict debug delta shape".into());
    }
    Ok(Delta {
        id: v["id"].as_str().ok_or("delta id required")?.into(),
        claims: parse_claims(&v["claims"])?,
        sig: Some(v["sig"].as_str().ok_or("signature required")?.into()),
    })
}
fn debug(d: &Delta) -> Value {
    json!({"id":d.id,"claims":claims_to_json(&d.claims),"sig":d.sig})
}
fn sign_description(v: &Value) -> Result<Delta, String> {
    sign_claims(
        &parse_claims(&v["claims"])?,
        v["seed"].as_str().ok_or("fixture seed required")?,
    )
}
fn operation(context: &Value, id: &str) -> Result<rhizomatic::command_data::OperationKind, String> {
    for v in context["boot"]["declarations"]
        .as_array()
        .ok_or("boot declarations required")?
    {
        let d = delta(v)?;
        if d.id == id {
            return read_operation(&d);
        }
    }
    Err("fixture operation absent".into())
}
fn validate(artifact: &Value, context: &Value) -> Result<(), String> {
    if artifact["format"] != "rhizomatic-command-artifact/1" {
        return Err("artifact version".into());
    }
    let id = artifact["entryId"].as_str().ok_or("entryId required")?;
    if !rhizomatic::command_data::is_content_id(id) {
        return Err("canonical entryId required".into());
    }
    let deltas = artifact["deltas"]
        .as_array()
        .ok_or("deltas required")?
        .iter()
        .map(delta)
        .collect::<Result<Vec<_>, _>>()?;
    if deltas
        .iter()
        .any(|d| verify_delta(d) != Verification::Verified)
    {
        return Err("invalid signed appearance".into());
    }
    let entry = deltas.iter().find(|d| d.id == id).ok_or("entry missing")?;
    let common = read_common_request(entry)?;
    read_request(entry, operation(context, &common.operation)?)?;
    Ok(())
}
fn run(input: &Value) -> Result<Value, String> {
    let context = &input["context"];
    match input["mode"].as_str().ok_or("mode required")? {
        "construct" => {
            let construction = &context["construction"];
            let mut request = sign_description(&construction["request"])?;
            let common = read_common_request(&request)?;
            let parsed = read_request(&request, operation(context, &common.operation)?)?;
            request.claims.pointers = request_pointers(&parsed)?;
            request = sign_claims(
                &request.claims,
                construction["request"]["seed"]
                    .as_str()
                    .ok_or("request seed")?,
            )?;
            let mut deltas = vec![debug(&request)];
            for support in construction["support"]
                .as_array()
                .ok_or("support array required")?
            {
                deltas.push(debug(&sign_description(support)?));
            }
            Ok(
                json!({"artifact":{"format":"rhizomatic-command-artifact/1","entryId":request.id,"deltas":deltas}}),
            )
        }
        "validate" => {
            let verdict = match validate(&input["artifact"], context) {
                Ok(()) => json!({"valid":true}),
                Err(error) => json!({"valid":false,"diagnostic":error}),
            };
            Ok(json!({"artifact":input["artifact"],"verdict":verdict}))
        }
        "read-result" => {
            let outcome = delta(&input["outcome"])?;
            let request = input["artifact"]["deltas"]
                .as_array()
                .and_then(|xs| xs.iter().find(|v| v["id"] == input["artifact"]["entryId"]))
                .map(delta)
                .transpose()?;
            let result = rhizomatic::command::read_result(&outcome, request.as_ref())?;
            let body = rhizomatic::command_data::write_outcome_body(&result.outcome.body)?;
            let mut out =
                json!({"status":result.outcome.body.status(),"bodyHex":hex::encode(body)});
            if let Some(value) = result.value {
                out["valueHex"] = json!(rhizomatic::view_canonical_hex(&value));
            }
            Ok(out)
        }
        "execute" => Err("command profile execution unavailable before M2".into()),
        _ => Err("unknown mode".into()),
    }
}
fn main() {
    let mut bytes = String::new();
    let result = io::stdin()
        .read_to_string(&mut bytes)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str(&bytes).map_err(|e| e.to_string()))
        .and_then(|v| run(&v));
    match result {
        Ok(out) => println!("{out}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
