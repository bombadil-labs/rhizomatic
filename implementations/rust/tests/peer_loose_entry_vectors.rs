//! Shared SPEC-6 vNext loose-entry vectors.

use std::collections::{BTreeMap, BTreeSet};

use rhizomatic::entry::{loose_entry_status, LooseEntryStatus};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::types::Delta;
use serde_json::Value;

#[test]
fn signed_loose_entry_verifies_before_refusal_and_duplicate() {
    let fixture_path = format!(
        "{}/../../vectors/principal/evidence.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let vector_path = format!(
        "{}/../../vectors/peer/loose-entry.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture_path).unwrap()).unwrap();
    let vector: Value =
        serde_json::from_str(&std::fs::read_to_string(vector_path).unwrap()).unwrap();
    let named: BTreeMap<String, Delta> = fixture["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["name"].as_str().unwrap().to_string(),
                Delta {
                    id: row["id"].as_str().unwrap().to_string(),
                    claims: parse_claims(&row["claims"]).unwrap(),
                    sig: row["sig"].as_str().map(str::to_string),
                },
            )
        })
        .collect();
    for case in vector["cases"].as_array().unwrap() {
        let mut delta = named[case["candidate"].as_str().unwrap()].clone();
        match case["mutation"].as_str() {
            Some("dropSignature") => delta.sig = None,
            Some("changeSignature") => delta.sig = Some("00".repeat(64)),
            Some("changeId") => delta.id = format!("1e20{}", "00".repeat(32)),
            Some("malformedValidity") => delta.claims.valid_until = Some(delta.claims.valid_from),
            None => {}
            other => panic!("unknown mutation {other:?}"),
        }
        let active: BTreeSet<String> = case["active"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| named[name.as_str().unwrap()].id.clone())
            .collect();
        let refused: BTreeSet<String> = case["refused"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| named[name.as_str().unwrap()].id.clone())
            .collect();
        let actual = match loose_entry_status(&delta, &active, &refused) {
            LooseEntryStatus::Invalid => "invalid",
            LooseEntryStatus::Refused => "refused",
            LooseEntryStatus::Duplicate => "duplicate",
            LooseEntryStatus::Eligible => "eligible",
        };
        assert_eq!(
            actual,
            case["expected"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}
