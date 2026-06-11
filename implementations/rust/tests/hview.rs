//! HView vectors (group/prune) + sort-error and filing-invariant tests.
//! Mirrors ../ts/test/hview.test.ts.

use rhizomatic::eval::{eval_term, result_canonical_hex, EvalResult};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::Target;
use serde_json::{json, Value};

fn load() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-hview.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-hview.json")).unwrap()
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

#[test]
fn hview_vectors() {
    let doc = load();
    let input = fixture_set(&doc);
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let root = c["root"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap_or_else(|e| panic!("parse {name}: {e}"));
        let result = eval_term(&term, &input, Some(root), None, None).unwrap();
        let hex = result_canonical_hex(&result);
        let EvalResult::HView(h) = result else {
            panic!("{name}: expected an HView result");
        };
        assert_eq!(h.id, c["expected"]["id"].as_str().unwrap(), "{name}");
        let expected_props = c["expected"]["props"].as_object().unwrap();
        assert_eq!(
            h.props.len(),
            expected_props.len(),
            "prop count mismatch for {name}"
        );
        for (prop, entries) in &h.props {
            let expected = expected_props
                .get(prop)
                .unwrap_or_else(|| panic!("{name}: unexpected property {prop}"))
                .as_array()
                .unwrap();
            assert_eq!(entries.len(), expected.len(), "{name}.{prop} entry count");
            for (e, exp) in entries.iter().zip(expected) {
                assert_eq!(e.delta.id, exp["id"].as_str().unwrap(), "{name}.{prop}");
                let expected_negated = exp.get("negated").and_then(Value::as_bool).unwrap_or(false);
                assert_eq!(e.negated, expected_negated, "{name}.{prop} negated tag");
            }
        }
        assert_eq!(
            hex,
            c["expectedCanonicalHex"].as_str().unwrap(),
            "canonical hview mismatch for {name}"
        );
    }
}

#[test]
fn prune_all_is_identity_with_unpruned() {
    let doc = load();
    let cases = doc["cases"].as_array().unwrap();
    let find = |name: &str| {
        cases
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("missing case {name}"))
    };
    assert_eq!(
        find("prune-all-is-identity")["expectedCanonicalHex"],
        find("group-by-target-context-canonical-idiom")["expectedCanonicalHex"]
    );
}

#[test]
fn sort_errors() {
    let doc = load();
    let input = fixture_set(&doc);
    // prune over a DSet operand
    let term = parse_term(&json!({ "op": "prune", "keep": "all", "in": "input" })).unwrap();
    let err = eval_term(&term, &input, Some("movie:matrix"), None, None).unwrap_err();
    assert!(err.contains("HView operand"), "got: {err}");
    // select over an HView operand
    let term = parse_term(&json!({
        "op": "select", "pred": "true",
        "in": { "op": "group", "key": "byRole", "in": "input" }
    }))
    .unwrap();
    let err = eval_term(&term, &input, Some("movie:matrix"), None, None).unwrap_err();
    assert!(err.contains("DSet operand"), "got: {err}");
    // group without an ambient root
    let term = parse_term(&json!({ "op": "group", "key": "byRole", "in": "input" })).unwrap();
    let err = eval_term(&term, &input, None, None, None).unwrap_err();
    assert!(err.contains("ambient root"), "got: {err}");
}

#[test]
fn group_filing_invariants() {
    let doc = load();
    let input = fixture_set(&doc);
    let term = parse_term(&json!({ "op": "group", "key": "byRole", "in": "input" })).unwrap();
    let EvalResult::HView(h) = eval_term(&term, &input, Some("movie:matrix"), None, None).unwrap()
    else {
        panic!("expected hview");
    };
    for entries in h.props.values() {
        // every entry's delta has a filing pointer targeting the root (E6)
        for e in entries {
            assert!(e.delta.claims.pointers.iter().any(|p| matches!(
                &p.target, Target::Entity(er) if er.id == "movie:matrix"
            )));
        }
        // unique by id and sorted (E7)
        let ids: Vec<&str> = entries.iter().map(|e| e.delta.id.as_str()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(ids, sorted);
    }
}
