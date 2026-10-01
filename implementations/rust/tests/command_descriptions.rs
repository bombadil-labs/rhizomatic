use rhizomatic::cbor::{encode, CborValue};
use rhizomatic::command_data::*;
use rhizomatic::json_profile::parse_claims;
use rhizomatic::resolution::{decode_view, view_to_cbor};
use rhizomatic::{verify_delta, Delta, Verification};
use serde_json::Value;
use std::{fs, path::PathBuf};

fn input_delta(v: &Value) -> Result<Delta, String> {
    let o = v.as_object().ok_or("delta must be object")?;
    if o.len() != 3 || !o.contains_key("id") || !o.contains_key("claims") || !o.contains_key("sig")
    {
        return Err("strict debug delta shape".into());
    }
    let d = Delta {
        id: v["id"].as_str().ok_or("id string")?.into(),
        claims: parse_claims(&v["claims"])?,
        sig: Some(v["sig"].as_str().ok_or("signature string")?.into()),
    };
    if verify_delta(&d) != Verification::Verified {
        return Err("invalid signed appearance".into());
    }
    Ok(d)
}
#[test]
fn shared_command_description_vectors() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/command/descriptions.json");
    let fixtures: Value =
        serde_json::from_str(&fs::read_to_string(path).expect("shared command fixtures required"))
            .unwrap();
    assert_eq!(fixtures["format"], "rhizomatic-command-vectors/1");
    let cases = fixtures["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let input = &case["input"];
        let result: Result<String, String> = (|| {
            let kind = case["kind"].as_str().unwrap();
            if matches!(kind, "view" | "bindings") {
                let bytes = hex::decode(input.as_str().ok_or("hex required")?)
                    .map_err(|e| e.to_string())?;
                return match kind {
                    "view" => Ok(hex::encode(encode(&view_to_cbor(&decode_view(&bytes)?)))),
                    _ => Ok(hex::encode(write_bindings(&read_bindings(&bytes)?)?)),
                };
            }
            let d = input_delta(input)?;
            match kind {
                "configuration" => {
                    read_configuration(&d)?;
                }
                "operation" => {
                    read_operation(&d)?;
                }
                "request" => {
                    let kind = if case["operationKind"] == "evaluate" {
                        OperationKind::Evaluate
                    } else {
                        OperationKind::Retain
                    };
                    read_request(&d, kind)?;
                }
                "outcome" => {
                    let o = rhizomatic::command::read_result(&d, None)?.outcome;
                    if let OutcomeBody::Evaluate { value, .. } = &o.body {
                        decode_view(value)?;
                    }
                }
                _ => return Err("unknown fixture kind".into()),
            };
            rhizomatic::canonical_hex(&d.claims)
        })();
        assert_eq!(
            result.is_ok(),
            case["expected"]["valid"].as_bool().unwrap(),
            "{id}: {result:?}"
        );
        if let (Ok(actual), Some(expected)) = (result, case["expected"]["canonicalHex"].as_str()) {
            assert_eq!(actual, expected, "{id}");
        }
        if case["expected"]["valid"] == true
            && !matches!(case["kind"].as_str(), Some("view" | "bindings"))
        {
            let delta = input_delta(input).unwrap();
            let pointers = match case["kind"].as_str().unwrap() {
                "configuration" => {
                    configuration_pointers(&read_configuration(&delta).unwrap()).unwrap()
                }
                "operation" => operation_pointers(read_operation(&delta).unwrap()),
                "request" => request_pointers(
                    &read_request(
                        &delta,
                        if case["operationKind"] == "evaluate" {
                            OperationKind::Evaluate
                        } else {
                            OperationKind::Retain
                        },
                    )
                    .unwrap(),
                )
                .unwrap(),
                "outcome" => outcome_pointers(&read_outcome(&delta).unwrap()).unwrap(),
                _ => unreachable!(),
            };
            let mut claims = delta.claims.clone();
            claims.pointers = pointers;
            let written =
                rhizomatic::sign::sign_claims(&claims, fixtures["seed"].as_str().unwrap()).unwrap();
            assert_eq!(
                written, delta,
                "{id}: full writer claims/id/signature roundtrip"
            );
        }
        println!("command-case:{}:{}", case["scenario"].as_str().unwrap(), id);
    }
}
#[test]
fn strict_view_duplicate_keys_and_byte_object() {
    assert!(decode_view(&hex::decode("a26161f46161f5").unwrap()).is_err());
    let object = CborValue::Map(vec![
        ("mime".into(), CborValue::Tstr("x".into())),
        ("value".into(), CborValue::Tstr("data".into())),
    ]);
    let bytes = encode(&object);
    assert_eq!(encode(&view_to_cbor(&decode_view(&bytes).unwrap())), bytes);
    assert!(decode_view(&hex::decode("f98000").unwrap()).is_err());
}
