//! Fixture gate for frozen SPEC-14 vectors. Semantic authority assertions join this file
//! with the principal reader; this already pins signed bytes and every case reference.

use std::collections::{BTreeMap, BTreeSet};

use rhizomatic::delta::compute_id;
use rhizomatic::json_profile::parse_claims;
use rhizomatic::reactor::{IngestResult, Reactor};
use rhizomatic::sign::{verify_delta, Verification};
use rhizomatic::types::Delta;
use serde_json::Value;

fn vector() -> Value {
    let path = format!(
        "{}/../../vectors/principal/evidence.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vector")).unwrap()
}

#[test]
fn principal_fixture_ids_signatures_and_references() {
    let v = vector();
    let mut named = BTreeMap::<String, Delta>::new();
    for entry in v["deltas"].as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        let claims = parse_claims(&entry["claims"]).unwrap();
        let id = entry["id"].as_str().unwrap();
        assert_eq!(compute_id(&claims).unwrap(), id, "fixture {name}");
        let sig = entry["sig"].as_str().map(str::to_string);
        let delta = Delta {
            id: id.to_string(),
            claims,
            sig: sig.clone(),
        };
        assert_eq!(
            verify_delta(&delta),
            if sig.is_some() {
                Verification::Verified
            } else {
                Verification::Unsigned
            },
            "fixture {name}"
        );
        assert!(named.insert(name.to_string(), delta).is_none());
    }

    let keys = v["keys"].as_object().unwrap();
    let mut case_names = BTreeSet::new();
    for group in ["cases", "history", "predicates"] {
        for case in v[group].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert!(case_names.insert(name), "duplicate case {name}");
            let members = case["members"].as_array().unwrap();
            let mut member_names = BTreeSet::new();
            let mut ordered = Vec::new();
            for member in members {
                let member_name = member.as_str().unwrap();
                assert!(
                    member_names.insert(member_name),
                    "duplicate member in {name}"
                );
                ordered.push(named.get(member_name).expect("known member").clone());
            }
            for reverse in [false, true] {
                let mut reactor = Reactor::new();
                let source: Vec<Delta> = if reverse {
                    ordered.iter().rev().cloned().collect()
                } else {
                    ordered.clone()
                };
                for delta in source {
                    assert_eq!(reactor.ingest(delta), IngestResult::Accepted, "case {name}");
                }
                assert_eq!(reactor.len(), members.len(), "case {name}");
            }
            if group == "cases" {
                assert!(case["at"].as_f64().unwrap().is_finite());
                if let Some(now) = case["now"].as_f64() {
                    assert!(now.is_finite());
                }
                assert!(keys.contains_key(case["key"].as_str().unwrap()));
                if let Some(root) = case["root"].as_str() {
                    assert!(keys.contains_key(root));
                }
                for alias in case["expected"]["authors"].as_array().unwrap() {
                    assert!(keys.contains_key(alias.as_str().unwrap()));
                }
            }
            if group == "history" {
                for row in case["expected"].as_array().unwrap() {
                    assert!(keys.contains_key(row["key"].as_str().unwrap()));
                    for edge in row["via"].as_array().unwrap() {
                        assert!(named.contains_key(edge.as_str().unwrap()));
                    }
                }
            }
            if group == "predicates" {
                assert!(case["term"].is_object());
                for expected in case["expected"].as_array().unwrap() {
                    assert!(named.contains_key(expected.as_str().unwrap()));
                }
            }
        }
    }
}
