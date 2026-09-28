//! Shared SPEC-6 internal transfer commit vectors.

use std::collections::BTreeMap;

use rhizomatic::json_profile::parse_claims;
use rhizomatic::reactor::{IngestResult, Reactor};
use rhizomatic::set::make_delta;
use rhizomatic::types::Delta;
use serde_json::Value;

#[test]
fn final_peer_additions_are_installed_atomically() {
    let path = format!(
        "{}/../../vectors/peer/atomic-transfer.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let vector: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut named: BTreeMap<String, Delta> = vector["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["name"].as_str().unwrap().to_string(),
                make_delta(parse_claims(&row["claims"]).unwrap(), None).unwrap(),
            )
        })
        .collect();
    let mut forged = named["two"].clone();
    forged.id = format!("1e20{}", "00".repeat(32));
    named.insert("forgedTwo".into(), forged);
    let mut forged_one = named["one"].clone();
    forged_one.claims = named["two"].claims.clone();
    named.insert("forgedOne".into(), forged_one);

    for case in vector["cases"].as_array().unwrap() {
        let mut reactor = Reactor::new();
        for name in case["before"].as_array().unwrap() {
            assert_eq!(
                reactor.ingest(named[name.as_str().unwrap()].clone()),
                IngestResult::Accepted
            );
        }
        let offer: Vec<Delta> = case["offer"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| named[name.as_str().unwrap()].clone())
            .collect();
        let result = reactor.ingest_batch(&offer);
        let status = match result {
            IngestResult::Accepted => "accepted",
            IngestResult::Duplicate => "duplicate",
            IngestResult::Rejected(_) => "rejected",
        };
        assert_eq!(status, case["status"].as_str().unwrap(), "{}", case["name"]);
        let mut actual: Vec<String> = reactor
            .arrival_log()
            .iter()
            .map(|delta| {
                named
                    .iter()
                    .find(|(name, value)| !name.starts_with("forged") && value.id == delta.id)
                    .unwrap()
                    .0
                    .clone()
            })
            .collect();
        actual.sort();
        let mut expected: Vec<String> = case["after"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap().to_string())
            .collect();
        expected.sort();
        assert_eq!(actual, expected, "{}", case["name"]);
    }
}
