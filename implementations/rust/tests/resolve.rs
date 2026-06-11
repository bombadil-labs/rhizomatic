//! resolve vectors (SPEC-5) + pluralism/determinism checks. Mirrors ../ts/test/resolve.test.ts.
//! Rust must reproduce the canonical View bytes the TS pipeline pinned — including float sums.

use rhizomatic::eval::{eval_term, result_canonical_hex, EvalResult};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::policy::View;
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::term_json::parse_term;
use serde_json::{json, Value};

fn load() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-resolve.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-resolve.json")).unwrap()
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
fn resolve_vectors() {
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

fn title_of(result: EvalResult) -> String {
    let EvalResult::View(View::Obj(obj)) = result else {
        panic!("expected an object view");
    };
    match obj.get("title") {
        Some(View::Prim(rhizomatic::types::Primitive::Str(s))) => s.clone(),
        other => panic!("unexpected title: {other:?}"),
    }
}

#[test]
fn pluralism_is_parameterized() {
    let doc = load();
    let input = fixture_set(&doc);
    let reg = registry(&doc);
    let latest = parse_term(&json!({
        "op": "resolve",
        "policy": { "default": { "pick": { "order": { "byTimestamp": "desc" } } } },
        "in": { "op": "fix", "schema": "MovieRaw", "entity": "movie:matrix" }
    }))
    .unwrap();
    let trust_alice = parse_term(&json!({
        "op": "resolve",
        "policy": { "default": { "pick": { "order": { "byAuthorRank": ["did:key:zAlice"] } } } },
        "in": { "op": "fix", "schema": "MovieRaw", "entity": "movie:matrix" }
    }))
    .unwrap();
    assert_eq!(
        title_of(eval_term(&latest, &input, None, Some(&reg), None).unwrap()),
        "Matrix Reloaded"
    );
    assert_eq!(
        title_of(eval_term(&trust_alice, &input, None, Some(&reg), None).unwrap()),
        "The Matrix"
    );
}

#[test]
fn resolve_demands_hview_operand() {
    let doc = load();
    let input = fixture_set(&doc);
    let term = parse_term(&json!({
        "op": "resolve",
        "policy": { "default": { "pick": { "order": "lexById" } } },
        "in": "input"
    }))
    .unwrap();
    let err = eval_term(&term, &input, None, None, None).unwrap_err();
    assert!(err.contains("HView operand"), "got: {err}");
}
