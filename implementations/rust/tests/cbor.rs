//! CBOR encoder vs. external ground truth (vectors/l0-delta/cbor-primitives.json) + composites.
//! Mirrors ../ts/test/cbor.test.ts.

use rhizomatic::cbor::{encode, CborValue};
use serde_json::Value;

fn vector(name: &str) -> String {
    let path = format!(
        "{}/../../vectors/l0-delta/{}",
        env!("CARGO_MANIFEST_DIR"),
        name
    );
    std::fs::read_to_string(path).expect("read vector file")
}

#[test]
fn cbor_primitive_ground_truth() {
    let arr: Vec<Value> = serde_json::from_str(&vector("cbor-primitives.json")).unwrap();
    for c in arr {
        let name = c["name"].as_str().unwrap();
        let kind = c["kind"].as_str().unwrap();
        let expected = c["hex"].as_str().unwrap();
        let val = match kind {
            "tstr" => CborValue::Tstr(c["value"].as_str().unwrap().to_string()),
            // bstr ground-truth value is the raw payload as a hex string (vectors/README convention)
            "bstr" => CborValue::Bstr(hex::decode(c["value"].as_str().unwrap()).unwrap()),
            "float" => CborValue::Float(c["value"].as_f64().unwrap()),
            "bool" => CborValue::Bool(c["value"].as_bool().unwrap()),
            other => panic!("unknown kind {other}"),
        };
        assert_eq!(hex::encode(encode(&val)), expected, "case {name}");
    }
}

#[test]
fn sorts_map_keys_by_encoded_key() {
    let v = CborValue::Map(vec![
        ("b".to_string(), CborValue::Bool(true)),
        ("a".to_string(), CborValue::Bool(false)),
    ]);
    assert_eq!(hex::encode(encode(&v)), "a26161f46162f5");
}

#[test]
fn preserves_array_order() {
    let v = CborValue::Array(vec![
        CborValue::Tstr("a".to_string()),
        CborValue::Tstr("b".to_string()),
    ]);
    assert_eq!(hex::encode(encode(&v)), "8261616162");
}

#[test]
fn nfc_normalizes_text() {
    let decomposed = CborValue::Tstr("e\u{0301}".to_string()); // e + combining acute
    let composed = CborValue::Tstr("\u{e9}".to_string()); // é
    assert_eq!(hex::encode(encode(&decomposed)), "62c3a9");
    assert_eq!(
        hex::encode(encode(&composed)),
        hex::encode(encode(&decomposed))
    );
}

#[test]
fn normalizes_negative_zero() {
    assert_eq!(hex::encode(encode(&CborValue::Float(-0.0))), "f90000");
}
