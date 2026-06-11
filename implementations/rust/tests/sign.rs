//! Signed-delta vectors: Rust must derive the same public keys from the shared seeds and
//! reproduce the same deterministic Ed25519 signatures the TS pipeline pinned (ERRATA D8-D9).
//! Mirrors ../ts/test/sign.test.ts.

use rhizomatic::delta::{canonical_hex, compute_id};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::sign::{public_key_from_seed, sign_claims, verify_delta, Verification};
use rhizomatic::types::Delta;
use serde_json::Value;

fn read_vector(rel: &str) -> Vec<Value> {
    let path = format!("{}/../../vectors/{}", env!("CARGO_MANIFEST_DIR"), rel);
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vector file")).unwrap()
}

#[test]
fn key_vectors_derive_from_seeds() {
    for k in read_vector("keys/keys.json") {
        let seed = k["seedHex"].as_str().unwrap();
        let expected_pub = k["publicKeyHex"].as_str().unwrap();
        assert_eq!(
            public_key_from_seed(seed).unwrap(),
            expected_pub,
            "key {}",
            k["keyId"]
        );
        assert_eq!(
            k["author"].as_str().unwrap(),
            format!("ed25519:{expected_pub}")
        );
    }
}

#[test]
fn signed_delta_vectors() {
    let keys = read_vector("keys/keys.json");
    for v in read_vector("l0-delta/deltas-signed.json") {
        let name = v["name"].as_str().unwrap();
        let key = keys
            .iter()
            .find(|k| k["keyId"] == v["keyId"])
            .expect("vector references a known key");
        let claims = parse_claims(&v["claims"]).unwrap();
        assert_eq!(
            canonical_hex(&claims).unwrap(),
            v["canonicalCborHex"].as_str().unwrap(),
            "canonical bytes mismatch for {name}"
        );
        let id = v["id"].as_str().unwrap();
        assert_eq!(compute_id(&claims).unwrap(), id, "id mismatch for {name}");
        // RFC 8032 determinism: re-signing reproduces the pinned signature bytes.
        let resigned = sign_claims(&claims, key["seedHex"].as_str().unwrap()).unwrap();
        let sig = v["sig"].as_str().unwrap();
        assert_eq!(
            resigned.sig.as_deref(),
            Some(sig),
            "signature bytes mismatch for {name}"
        );
        let delta = Delta {
            id: id.to_string(),
            claims: claims.clone(),
            sig: Some(sig.to_string()),
        };
        assert_eq!(verify_delta(&delta), Verification::Verified, "{name}");

        // Tampered claims: content addressing fails -> invalid.
        let mut tampered = delta.clone();
        tampered.claims.timestamp += 1.0;
        assert_eq!(verify_delta(&tampered), Verification::Invalid);

        // Flipped signature byte -> invalid.
        let mut flipped = delta.clone();
        let mut sig_owned = sig.to_string();
        let first = if &sig_owned[0..1] == "0" { "1" } else { "0" };
        sig_owned.replace_range(0..1, first);
        flipped.sig = Some(sig_owned);
        assert_eq!(verify_delta(&flipped), Verification::Invalid);

        // Missing sig -> unsigned, not invalid.
        let mut unsigned = delta.clone();
        unsigned.sig = None;
        assert_eq!(verify_delta(&unsigned), Verification::Unsigned);
    }
}

#[test]
fn refuses_author_mismatch() {
    let keys = read_vector("keys/keys.json");
    let claims = parse_claims(&serde_json::json!({
        "timestamp": 0,
        "author": "ed25519:0000000000000000000000000000000000000000000000000000000000000000",
        "pointers": [{ "role": "x", "target": "y" }]
    }))
    .unwrap();
    let err = sign_claims(&claims, keys[0]["seedHex"].as_str().unwrap()).unwrap_err();
    assert!(err.contains("author must be"), "got: {err}");
}
