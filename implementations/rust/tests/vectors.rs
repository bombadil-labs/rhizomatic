//! Shared l0-delta vectors: Rust must reproduce every canonicalCborHex and id that the TS pipeline
//! generated. This is the cross-implementation parity check. Mirrors ../ts/test/vectors.test.ts.

use rhizomatic::delta::{canonical_hex, compute_id};
use rhizomatic::json_profile::parse_claims;
use serde_json::Value;

#[test]
fn l0_delta_vectors() {
    let path = format!(
        "{}/../../vectors/l0-delta/deltas.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let raw = std::fs::read_to_string(path).expect("read deltas.json");
    let arr: Vec<Value> = serde_json::from_str(&raw).unwrap();
    assert!(!arr.is_empty(), "deltas.json must not be empty");
    for v in arr {
        let name = v["name"].as_str().unwrap();
        let claims = parse_claims(&v["claims"]).unwrap_or_else(|e| panic!("parse {name}: {e}"));
        assert_eq!(
            canonical_hex(&claims).unwrap(),
            v["canonicalCborHex"].as_str().unwrap(),
            "canonical bytes mismatch for {name}"
        );
        assert_eq!(
            compute_id(&claims).unwrap(),
            v["id"].as_str().unwrap(),
            "id mismatch for {name}"
        );
    }
}

#[test]
fn pointer_order_is_significant() {
    let a = parse_claims(&serde_json::json!({
        "timestamp": 0, "author": "did:key:zA",
        "pointers": [
            { "role": "x", "target": "1" },
            { "role": "y", "target": "2" }
        ]
    }))
    .unwrap();
    let b = parse_claims(&serde_json::json!({
        "timestamp": 0, "author": "did:key:zA",
        "pointers": [
            { "role": "y", "target": "2" },
            { "role": "x", "target": "1" }
        ]
    }))
    .unwrap();
    assert_ne!(compute_id(&a).unwrap(), compute_id(&b).unwrap());
}
