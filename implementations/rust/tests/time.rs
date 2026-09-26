//! Shared vNext time vectors: signed validity, bounded negation, and two Schema orders.

use rhizomatic::eval::{eval_term_at, result_canonical_hex, EvalResult};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::Delta;
use serde_json::Value;
use std::collections::BTreeMap;

#[test]
fn time_vectors() {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-time.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut fixture: BTreeMap<String, Delta> = BTreeMap::new();
    for (name, item) in doc["fixture"].as_object().unwrap() {
        let delta = make_delta(parse_claims(&item["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, item["id"].as_str().unwrap(), "fixture {name}");
        fixture.insert(name.clone(), delta);
    }
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap();
        let names: Vec<&str> = c["input"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        for order in [names.clone(), names.iter().rev().copied().collect()] {
            let input = DeltaSet::from_deltas(order.iter().map(|n| fixture[*n].clone())).unwrap();
            let result = eval_term_at(
                &term,
                &input,
                c["now"].as_f64().unwrap(),
                Some("entity:time"),
                None,
                None,
            )
            .unwrap();
            assert_eq!(
                result_canonical_hex(&result),
                c["expectedCanonicalHex"].as_str().unwrap(),
                "{name}"
            );
            if let Some(ids) = c.get("expectedIds") {
                let EvalResult::DSet { set, .. } = result else {
                    panic!("{name}: expected DSet")
                };
                let expected: Vec<&str> = ids
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect();
                assert_eq!(set.ids(), expected, "{name}");
            }
        }
    }
}

#[test]
fn materialization_refreshes_without_ingest() {
    use rhizomatic::reactor::{IngestResult, Reactor};
    use serde_json::json;
    let path = format!(
        "{}/../../vectors/l1-eval/eval-time.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let fact = make_delta(
        parse_claims(&doc["fixture"]["fact-later"]["claims"]).unwrap(),
        None,
    )
    .unwrap();
    let negation = make_delta(
        parse_claims(&doc["fixture"]["bounded-negation"]["claims"]).unwrap(),
        None,
    )
    .unwrap();
    let mut reactor = Reactor::new();
    assert_eq!(reactor.ingest(fact.clone()), IngestResult::Accepted);
    assert_eq!(reactor.ingest(negation), IngestResult::Accepted);
    let body = parse_term(&json!({
        "op":"group", "key":"byTargetContext",
        "in":{"op":"mask", "policy":"drop", "in":"input"}
    }))
    .unwrap();
    reactor
        .register_at("time", body, &["entity:time".to_string()], 279.0, None)
        .unwrap();
    assert!(!reactor
        .materialized_view("time", "entity:time")
        .unwrap()
        .props
        .contains_key("value"));
    assert_eq!(reactor.next_validity_boundary(279.0).unwrap(), Some(280.0));
    let evals = reactor.eval_count_of("time");
    assert!(reactor.advance_time(279.5).unwrap().is_empty());
    assert_eq!(reactor.eval_count_of("time"), evals);
    let changes = reactor.advance_time(280.0).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(reactor.eval_count_of("time"), evals + 1);
    assert!(changes[0].responsible_delta_ids.is_empty());
    assert_eq!(
        reactor
            .materialized_view("time", "entity:time")
            .unwrap()
            .props["value"][0]
            .delta
            .id,
        fact.id
    );
    assert!(reactor.advance_time(280.5).unwrap().is_empty());
    assert_eq!(reactor.eval_count_of("time"), evals + 1);
    let reversed = reactor.advance_time(279.5).unwrap();
    assert_eq!(reversed.len(), 1);
    assert_eq!(reactor.eval_count_of("time"), evals + 2);
    assert!(!reactor
        .materialized_view("time", "entity:time")
        .unwrap()
        .props
        .contains_key("value"));
    assert!(reactor.advance_time(279.0).unwrap().is_empty());
    assert_eq!(reactor.eval_count_of("time"), evals + 2);
}

#[test]
fn published_definitions_obey_validity() {
    use rhizomatic::schema_deltas::{load_hyper_schema, load_schema};
    let path = format!(
        "{}/../../vectors/l1-eval/eval-time.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for c in doc["expiringDefinitions"].as_array().unwrap() {
        let delta = make_delta(parse_claims(&c["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, c["id"].as_str().unwrap());
        let set = DeltaSet::from_deltas([delta]).unwrap();
        let entity = c["entity"].as_str().unwrap();
        let valid_at = c["validAt"].as_f64().unwrap();
        let expired_at = c["expiredAt"].as_f64().unwrap();
        let expected = c["expectedName"].as_str().unwrap();
        match c["kind"].as_str().unwrap() {
            "hyperschema" => {
                assert_eq!(
                    load_hyper_schema(&set, entity, valid_at).unwrap().name,
                    expected
                );
                assert!(load_hyper_schema(&set, entity, expired_at)
                    .unwrap_err()
                    .contains("no surviving schema definition"));
            }
            "schema" => {
                assert_eq!(
                    load_schema(&set, entity, valid_at).unwrap().name.as_deref(),
                    Some(expected)
                );
                assert!(load_schema(&set, entity, expired_at)
                    .unwrap_err()
                    .contains("no surviving schema definition"));
            }
            other => panic!("unknown definition kind {other}"),
        }
    }
}

#[test]
fn reactor_boundary_index_is_order_independent() {
    use rhizomatic::reactor::{IngestResult, Reactor};
    use serde_json::json;
    let starts = [90.0, 10.0, 50.0, 30.0, 70.0, 20.0, 60.0, 80.0, 40.0, 100.0];
    for order in [starts.to_vec(), starts.iter().rev().copied().collect()] {
        let mut reactor = Reactor::new();
        for start in order {
            let claims = parse_claims(&json!({
                "timestamp": 0,
                "validFrom": start,
                "validUntil": start + 5.0,
                "author": "author:index",
                "pointers": [{"role":"value", "target": start}]
            }))
            .unwrap();
            assert_eq!(
                reactor.ingest(make_delta(claims, None).unwrap()),
                IngestResult::Accepted
            );
        }
        for (now, expected) in [
            (0.0, Some(10.0)),
            (10.0, Some(15.0)),
            (49.0, Some(50.0)),
            (50.0, Some(55.0)),
            (94.0, Some(95.0)),
            (100.0, Some(105.0)),
            (105.0, None),
        ] {
            assert_eq!(reactor.next_validity_boundary(now).unwrap(), expected);
        }
    }
}
