//! Parameterized-term vectors (SPEC-2 §6, ERRATA-2 E15). Mirrors ../ts/test/holes.test.ts.

use rhizomatic::eval::{eval_term, result_canonical_hex};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::term_io::{term_hash, term_to_json};
use rhizomatic::term_json::parse_term;
use serde_json::{json, Value};

fn load() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-holes.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-holes.json")).unwrap()
}

fn fixture_set(doc: &Value) -> DeltaSet {
    DeltaSet::from_deltas(
        doc["fixture"]["deltas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap()),
    )
    .unwrap()
}

fn registry(doc: &Value) -> SchemaRegistry {
    SchemaRegistry::build(
        doc["schemas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| HyperSchema {
                name: s["name"].as_str().unwrap().to_string(),
                alg: s["alg"].as_u64().unwrap() as u32,
                body: parse_term(&s["body"]).unwrap(),
            })
            .collect(),
    )
    .unwrap()
}

#[test]
fn fixture_ids_are_pinned() {
    let doc = load();
    for d in doc["fixture"]["deltas"].as_array().unwrap() {
        let delta = make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, d["id"].as_str().unwrap(), "{}", d["name"]);
    }
}

#[test]
fn hole_vectors_reproduce_term_hashes_and_canonical_bytes() {
    let doc = load();
    let set = fixture_set(&doc);
    let reg = registry(&doc);
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap();
        assert_eq!(
            term_hash(&term).unwrap(),
            c["termHash"].as_str().unwrap(),
            "{name}: term hash"
        );
        let result = eval_term(&term, &set, None, Some(&reg), None).unwrap();
        assert_eq!(
            result_canonical_hex(&result),
            c["expectedCanonicalHex"].as_str().unwrap(),
            "{name}: canonical bytes"
        );
    }
}

#[test]
fn same_body_different_bindings_hash_differently() {
    let doc = load();
    let cases = doc["cases"].as_array().unwrap();
    assert_ne!(
        cases[0]["termHash"].as_str().unwrap(),
        cases[1]["termHash"].as_str().unwrap()
    );
}

#[test]
fn unbound_hole_fails_loudly_at_evaluation() {
    let doc = load();
    let set = fixture_set(&doc);
    let reg = registry(&doc);
    let term = parse_term(&json!({ "op": "fix", "schema": "ViewAsOf", "entity": "movie:matrix" }))
        .unwrap();
    let err = eval_term(&term, &set, None, Some(&reg), None).unwrap_err();
    assert!(err.contains("unbound hole"), "got: {err}");
}

#[test]
fn parse_serialize_is_identity_on_holes_and_bindings() {
    let doc = load();
    for raw in doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| &c["term"])
        .chain(
            doc["schemas"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| &s["body"]),
        )
    {
        let term = parse_term(raw).unwrap();
        let round = parse_term(&term_to_json(&term)).unwrap();
        assert_eq!(term_hash(&round).unwrap(), term_hash(&term).unwrap());
    }
}
