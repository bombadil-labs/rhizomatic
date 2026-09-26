//! Shared governed-slice and timed-negation vectors, in both ingest orders.

use std::collections::BTreeSet;

use rhizomatic::eval::{governed_deltas, latest_by_key};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::reactor::{IngestResult, Reactor};
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::types::Delta;
use serde_json::Value;

fn vector() -> Value {
    let path = format!(
        "{}/../../vectors/l2-reactor/governed.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vector")).unwrap()
}

#[test]
fn governed_vectors_match_in_both_orders() {
    let v = vector();
    let entries = v["deltas"].as_array().unwrap();
    let mut named = std::collections::BTreeMap::<String, Delta>::new();
    let mut deltas = Vec::new();
    for entry in entries {
        let delta = make_delta(parse_claims(&entry["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, entry["id"].as_str().unwrap());
        named.insert(entry["name"].as_str().unwrap().to_string(), delta.clone());
        deltas.push(delta);
    }
    for reverse in [false, true] {
        let mut ordered = deltas.clone();
        if reverse {
            ordered.reverse();
        }
        let set = DeltaSet::from_deltas(ordered.clone()).unwrap();
        let mut reactor = Reactor::new();
        for delta in ordered {
            assert_eq!(reactor.ingest(delta), IngestResult::Accepted);
        }
        for case in v["governed"].as_array().unwrap() {
            let authors: BTreeSet<&str> = case["authors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap())
                .collect();
            let slice = governed_deltas(&set, case["now"].as_f64().unwrap(), |author| {
                authors.contains(author)
            })
            .unwrap();
            let expected: Vec<&str> = case["expectedIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap())
                .collect();
            let mut actual: Vec<String> = slice.iter().map(|d| d.id.clone()).collect();
            actual.sort();
            assert_eq!(actual, expected, "governed case: {case}");
        }
        for case in v["latestByKey"].as_array().unwrap() {
            let authors: BTreeSet<&str> = case["authors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap())
                .collect();
            let winners = latest_by_key(
                &set,
                case["now"].as_f64().unwrap(),
                |author| authors.contains(author),
                |delta| {
                    delta.claims.pointers.iter().find_map(|pointer| {
                        if pointer.role != "subject" {
                            return None;
                        }
                        match &pointer.target {
                            rhizomatic::Target::Entity(entity) => Some(entity.id.clone()),
                            _ => None,
                        }
                    })
                },
            )
            .unwrap();
            let actual = winners.get("person:myk").map(|delta| delta.id.as_str());
            let expected = case["expected"]
                .as_str()
                .map(|name| named.get(name).unwrap().id.as_str());
            assert_eq!(actual, expected, "latest-by-key case: {case}");
        }
        for case in v["witnesses"].as_array().unwrap() {
            let permitted: BTreeSet<&str> = case["permittedAuthors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap())
                .collect();
            let mut reader = reactor
                .negation_reader(case["now"].as_f64().unwrap(), |negation, _target| {
                    permitted.contains(negation.claims.author.as_str())
                })
                .unwrap();
            let target = named
                .get(case["target"].as_str().unwrap())
                .map(|d| d.id.as_str())
                .unwrap_or("1e200000000000000000000000000000000000000000000000000000000000000000");
            let actual: Vec<String> = reader
                .witnesses(target)
                .iter()
                .map(|d| d.id.clone())
                .collect();
            let expected: Vec<&str> = case["expectedIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap())
                .collect();
            assert_eq!(actual, expected, "witness case: {case}");
            assert_eq!(reader.is_negated(target), !expected.is_empty());
        }
    }
}
