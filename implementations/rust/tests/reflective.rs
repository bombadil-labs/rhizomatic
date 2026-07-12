//! Reflective predicates (SPEC-2 §3.1, ERRATA-2 E16): conformance vectors, parse-time
//! stratification, and the reactor's conservative dispatch for reflective terms.
//! Mirrors ../ts/test/reflective.test.ts.

use proptest::prelude::*;
use rhizomatic::eval::{eval_term, result_canonical_hex, EvalResult};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::reactor::{IngestResult, Reactor};
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::term_io::term_to_json;
use rhizomatic::term_json::{parse_pred, parse_term};
use rhizomatic::types::Delta;
use serde_json::{json, Value};

fn load() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-reflective.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-reflective.json"))
        .unwrap()
}

fn fixture_deltas(doc: &Value) -> Vec<Delta> {
    doc["fixture"]["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap())
        .collect()
}

#[test]
fn fixture_ids_match() {
    let doc = load();
    for d in doc["fixture"]["deltas"].as_array().unwrap() {
        let delta = make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, d["id"].as_str().unwrap(), "{}", d["name"]);
    }
}

#[test]
fn reflective_vectors() {
    let doc = load();
    let input = DeltaSet::from_deltas(fixture_deltas(&doc)).unwrap();
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap_or_else(|e| panic!("parse {name}: {e}"));
        let result = eval_term(&term, &input, None, None, None).unwrap();
        let hex = result_canonical_hex(&result);
        let EvalResult::DSet { set, .. } = result else {
            panic!("{name}: expected a DSet result");
        };
        let expected_ids: Vec<&str> = c["expected"]["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert_eq!(set.ids(), expected_ids, "ids mismatch for {name}");
        assert_eq!(
            hex,
            c["expectedCanonicalHex"].as_str().unwrap(),
            "canonical result mismatch for {name}"
        );
    }
}

#[test]
fn round_trips_through_the_json_profile() {
    // parse(term_to_json) is identity through an inView (E12 hashing round-trip).
    let doc = load();
    for c in doc["cases"].as_array().unwrap() {
        let term = parse_term(&c["term"]).unwrap();
        assert_eq!(parse_term(&term_to_json(&term)).unwrap(), term);
    }
}

// --- stratification and closure (parse-time rejection) ---------------------------------------------

fn inner_in_view() -> Value {
    json!({ "inView": { "term": "input", "field": "author", "extract": { "field": "author" } } })
}

#[test]
fn rejects_in_view_inside_in_view_term() {
    let err = parse_pred(&json!({
        "inView": {
            "term": { "op": "select", "pred": inner_in_view(), "in": "input" },
            "field": "author",
            "extract": { "field": "author" }
        }
    }))
    .unwrap_err();
    assert!(err.contains("stratified"), "got: {err}");
}

#[test]
fn rejects_non_dset_sub_term() {
    let err = parse_pred(&json!({
        "inView": {
            "term": { "op": "group", "key": "byRole", "in": "input" },
            "field": "author",
            "extract": { "field": "author" }
        }
    }))
    .unwrap_err();
    assert!(err.contains("DSet-sort"), "got: {err}");
}

#[test]
fn rejects_in_view_inside_policy_by_pred() {
    let err = parse_term(&json!({
        "op": "resolve",
        "schema": {
            "default": { "pick": { "order": { "byPred": { "pred": inner_in_view(), "then": "lexById" } } } }
        },
        "in": "input"
    }))
    .unwrap_err();
    assert!(err.contains("policy byPred"), "got: {err}");
}

#[test]
fn rejects_in_view_inside_aliased_trust() {
    let err = parse_pred(&json!({
        "hasPointer": { "role": { "aliased": { "name": "parent", "trust": inner_in_view() } } }
    }))
    .unwrap_err();
    assert!(err.contains("aliased trust predicate"), "got: {err}");
}

// --- reactor: reflective terms dispatch conservatively (SPEC-4 §4.1) --------------------------------

const ALICE: &str = "did:key:zAlice";

// mask BEFORE select (ERRATA-3 S5): the negations live outside the root's edge set, so the
// trust mask must run over the full input before the root selection narrows it.
fn reflective_term() -> Value {
    json!({
        "op": "group",
        "key": "byTargetContext",
        "in": {
            "op": "select",
            "pred": { "hasPointer": { "targetEntity": { "var": "root" } } },
            "in": {
                "op": "mask",
                "policy": {
                    "trust": {
                        "inView": {
                            "term": {
                                "op": "select",
                                "pred": { "hasPointer": { "role": { "exact": "grant" }, "targetEntity": "acl:village" } },
                                "in": {
                                    "op": "mask",
                                    "policy": "drop",
                                    "in": {
                                        "op": "select",
                                        "pred": { "match": { "field": "author", "cmp": "eq", "const": ALICE } },
                                        "in": "input"
                                    }
                                }
                            },
                            "field": "author",
                            "extract": { "role": "grantee" }
                        }
                    }
                },
                "in": "input"
            }
        }
    })
}

fn batch_hex(term_json: &Value, set: &DeltaSet, root: &str) -> String {
    let term = parse_term(term_json).unwrap();
    result_canonical_hex(&eval_term(&term, set, Some(root), None, None).unwrap())
}

#[test]
fn a_grant_landing_away_from_the_support_still_refreshes() {
    let doc = load();
    let deltas = fixture_deltas(&doc);
    let names: Vec<&str> = doc["fixture"]["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["name"].as_str().unwrap())
        .collect();
    let by_name = |n: &str| deltas[names.iter().position(|x| *x == n).unwrap()].clone();
    let term = parse_term(&reflective_term()).unwrap();
    let mut reactor = Reactor::new();
    reactor
        .register("sky", term, &["topic:sky".to_string()], None)
        .unwrap();
    // Claims and negations first: Bob has no grant yet, so his negation has no standing.
    for n in ["c1-color-blue", "n1-bob-negates-c1"] {
        assert_eq!(reactor.ingest(by_name(n)), IngestResult::Accepted);
    }
    let before = reactor
        .materialized_hex("sky", "topic:sky")
        .unwrap()
        .to_string();
    // The grant targets acl:village — nowhere near topic:sky's support — yet it flips
    // Bob's standing and must suppress c1.
    assert_eq!(
        reactor.ingest(by_name("g1-grant-bob")),
        IngestResult::Accepted
    );
    let after = reactor
        .materialized_hex("sky", "topic:sky")
        .unwrap()
        .to_string();
    assert_ne!(after, before);
    assert_eq!(
        after,
        batch_hex(&reflective_term(), &reactor.snapshot(), "topic:sky")
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(25))]

    // Incremental equals batch after EVERY ingest, in any order (the reflective oracle).
    #[test]
    fn incremental_equals_batch_any_order(seed in proptest::sample::Index::arbitrary()) {
        let doc = load();
        let mut deltas = fixture_deltas(&doc);
        // A deterministic permutation from the proptest index.
        let mut i = seed.index(1 << 30);
        let mut order = Vec::with_capacity(deltas.len());
        while !deltas.is_empty() {
            order.push(deltas.remove(i % deltas.len()));
            i = i.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        }
        let term = parse_term(&reflective_term()).unwrap();
        let mut reactor = Reactor::new();
        reactor.register("sky", term, &["topic:sky".to_string()], None).unwrap();
        for delta in order {
            prop_assert_eq!(reactor.ingest(delta), IngestResult::Accepted);
            let batch = batch_hex(&reflective_term(), &reactor.snapshot(), "topic:sky");
            prop_assert_eq!(reactor.materialized_hex("sky", "topic:sky").unwrap(), batch);
        }
    }
}
