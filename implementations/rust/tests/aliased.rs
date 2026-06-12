//! Aliased-closure vectors (SPEC-9). Mirrors ../ts/test/aliased.test.ts.

use rhizomatic::alias::{relation_signature, relation_signature_canonical_hex};
use rhizomatic::eval::{alias_closure, eval_term, result_canonical_hex, EvalResult};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::pred::Pred;
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::term_io::{term_hash, term_to_json};
use rhizomatic::term_json::{parse_pred, parse_term};
use serde_json::{json, Value};

fn load() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-aliased.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-aliased.json")).unwrap()
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

/// Pull the (single) aliased node out of a case's term JSON, wherever it sits.
fn find_aliased(v: &Value) -> Option<(String, Option<String>, Option<Pred>)> {
    match v {
        Value::Array(xs) => xs.iter().find_map(find_aliased),
        Value::Object(o) => {
            if let Some(a) = o.get("aliased").and_then(Value::as_object) {
                return Some((
                    a["name"].as_str().unwrap().to_string(),
                    a.get("via").and_then(Value::as_str).map(str::to_string),
                    a.get("trust").map(|t| parse_pred(t).unwrap()),
                ));
            }
            o.values().find_map(find_aliased)
        }
        _ => None,
    }
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
fn aliased_vectors_reproduce_hashes_closures_and_canonical_bytes() {
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
        if let Some(ids) = c["expected"]["ids"].as_array() {
            let want: Vec<&str> = ids.iter().map(|i| i.as_str().unwrap()).collect();
            let EvalResult::DSet { set: got, .. } = &result else {
                panic!("{name}: expected a DSet result");
            };
            assert_eq!(got.ids(), want, "{name}: ids");
        }
        if let Some(expected) = c["expectedClosure"].as_array() {
            let want: Vec<&str> = expected.iter().map(|s| s.as_str().unwrap()).collect();
            let (al_name, via, trust) = find_aliased(&c["term"]).expect("aliased node");
            let got = alias_closure(&set, &al_name, via.as_deref(), trust.as_ref(), None);
            assert_eq!(got, want, "{name}: closure");
        }
    }
}

#[test]
fn relation_signatures_reproduce() {
    let doc = load();
    let deltas = doc["fixture"]["deltas"].as_array().unwrap();
    for s in doc["signatures"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        let fixture = deltas
            .iter()
            .find(|d| d["name"] == s["delta"])
            .expect("fixture delta");
        let delta = make_delta(parse_claims(&fixture["claims"]).unwrap(), None).unwrap();
        let want: Vec<Vec<String>> = s["signature"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| {
                pair.as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_str().unwrap().to_string())
                    .collect()
            })
            .collect();
        assert_eq!(relation_signature(&delta), want, "{name}: signature");
        assert_eq!(
            relation_signature_canonical_hex(&delta),
            s["canonicalHex"].as_str().unwrap(),
            "{name}: canonical hex"
        );
    }
}

#[test]
fn parse_serialize_is_identity_on_aliased() {
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

#[test]
fn rejects_holes_inside_an_aliased_trust_predicate() {
    let err = parse_term(&json!({
        "op": "select",
        "pred": { "hasPointer": { "context": { "aliased": {
            "name": "employer",
            "trust": { "match": { "field": "author", "cmp": "eq", "const": { "hole": "who" } } }
        } } } },
        "in": "input"
    }))
    .unwrap_err();
    assert!(err.contains("holes are not allowed"), "got: {err}");
}

#[test]
fn rejects_nested_aliased_inside_an_aliased_trust_predicate() {
    let err = parse_term(&json!({
        "op": "select",
        "pred": { "hasPointer": { "context": { "aliased": {
            "name": "employer",
            "trust": { "hasPointer": { "context": { "aliased": { "name": "job" } } } }
        } } } },
        "in": "input"
    }))
    .unwrap_err();
    assert!(err.contains("nested aliased"), "got: {err}");
}

#[test]
fn aliased_with_empty_input_degrades_to_exact_name() {
    let set = DeltaSet::from_deltas(std::iter::empty()).unwrap();
    assert_eq!(
        alias_closure(&set, "anything", None, None, None),
        vec!["anything".to_string()]
    );
}
