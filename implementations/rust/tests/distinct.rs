//! all(order, distinct: true) vectors (SPEC-5 §3/§7, ERRATA-5 R9, issue #33). Mirrors
//! ../ts/test/distinct.test.ts: Rust must reproduce the canonical View bytes the TS pipeline
//! pinned — the byte-normative check; the JSON expectedView is for inspection.

use rhizomatic::eval::{eval_term, result_canonical_hex, EvalResult};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::term_json::parse_term;
use serde_json::Value;

fn load() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-distinct.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-distinct.json")).unwrap()
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
        Vec::new(),
    )
    .unwrap()
}

#[test]
fn distinct_fixture_ids_match() {
    let doc = load();
    for d in doc["fixture"]["deltas"].as_array().unwrap() {
        let delta = make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, d["id"].as_str().unwrap(), "{}", d["name"]);
    }
}

#[test]
fn distinct_vectors() {
    let doc = load();
    let input = fixture_set(&doc);
    let reg = registry(&doc);
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap_or_else(|e| panic!("parse {name}: {e}"));
        let result = eval_term(&term, &input, None, Some(&reg), None).unwrap();
        assert!(
            matches!(result, EvalResult::View(_)),
            "{name}: expected a View result"
        );
        assert_eq!(
            result_canonical_hex(&result),
            c["expectedCanonicalHex"].as_str().unwrap(),
            "canonical view mismatch for {name}"
        );
    }
}

/// R9's boundary discipline: `distinct: false`, a non-boolean, and `distinct` on `pick` are all
/// rejections — at parse time, before any evaluation.
#[test]
fn distinct_rejects() {
    let doc = load();
    let input = fixture_set(&doc);
    let reg = registry(&doc);
    for r in doc["rejects"].as_array().unwrap() {
        let name = r["name"].as_str().unwrap();
        let rejected = match parse_term(&r["term"]) {
            Err(_) => true,
            Ok(t) => eval_term(&t, &input, None, Some(&reg), None).is_err(),
        };
        assert!(rejected, "expected rejection for {name}");
    }
}
