//! expand/fix vectors + schema-registry tests. Mirrors ../ts/test/expand.test.ts.

use rhizomatic::eval::{eval_term, result_canonical_hex, EvalResult};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::schema::{collect_refs, HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::term_json::parse_term;
use serde_json::{json, Value};

fn load() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-expand.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-expand.json")).unwrap()
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
fn expand_vectors() {
    let doc = load();
    let input = fixture_set(&doc);
    let reg = registry(&doc);
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap_or_else(|e| panic!("parse {name}: {e}"));
        let result = eval_term(&term, &input, None, Some(&reg)).unwrap();
        assert_eq!(
            result_canonical_hex(&result),
            c["expectedCanonicalHex"].as_str().unwrap(),
            "canonical mismatch for {name}"
        );
    }
}

#[test]
fn data_cycle_nests_three_levels_then_bottoms_out() {
    let doc = load();
    let input = fixture_set(&doc);
    let reg = registry(&doc);
    let term = parse_term(&json!({ "op": "fix", "schema": "MovieDeep", "entity": "movie:matrix" }))
        .unwrap();
    let EvalResult::HView(h) = eval_term(&term, &input, None, Some(&reg)).unwrap() else {
        panic!("expected hview");
    };
    let cast = &h.props["cast"];
    assert_eq!(cast.len(), 1);
    let c1 = &cast[0];
    let actor_idx = c1
        .delta
        .claims
        .pointers
        .iter()
        .position(|p| p.role == "actor")
        .unwrap();
    let keanu = &c1.expanded[&actor_idx];
    assert_eq!(keanu.id, "actor:keanu");
    let c2 = &keanu.props["createdWorks"][0];
    let work_idx = c2
        .delta
        .claims
        .pointers
        .iter()
        .position(|p| p.role == "work")
        .unwrap();
    let brzrkr = &c2.expanded[&work_idx];
    assert_eq!(brzrkr.id, "movie:brzrkr");
    // brzrkr.createdBy -> c2 again, UNexpanded (MovieBasic is terminal): the cycle bottoms out
    let created_by = &brzrkr.props["createdBy"][0];
    assert_eq!(created_by.delta.id, c2.delta.id);
    assert!(created_by.expanded.is_empty());
}

#[test]
fn registry_guards() {
    let group_input = json!({ "op": "group", "key": "byRole", "in": "input" });
    let body = |t: &Value| parse_term(t).unwrap();

    // collect refs
    let term = parse_term(&json!({
        "op": "expand", "role": { "exact": "x" }, "schema": "Child", "in": group_input
    }))
    .unwrap();
    assert_eq!(collect_refs(&term), vec!["Child".to_string()]);

    // cycle rejection
    let a = HyperSchema {
        name: "A".to_string(),
        alg: 1,
        body: body(
            &json!({ "op": "expand", "role": { "exact": "x" }, "schema": "B", "in": group_input }),
        ),
    };
    let b = HyperSchema {
        name: "B".to_string(),
        alg: 1,
        body: body(
            &json!({ "op": "expand", "role": { "exact": "y" }, "schema": "A", "in": group_input }),
        ),
    };
    let err = SchemaRegistry::build(vec![a.clone(), b]).unwrap_err();
    assert!(err.contains("cycle"), "got: {err}");

    // unresolved reference
    let ghost = HyperSchema {
        name: "G".to_string(),
        alg: 1,
        body: body(
            &json!({ "op": "expand", "role": { "exact": "x" }, "schema": "Ghost", "in": group_input }),
        ),
    };
    let err = SchemaRegistry::build(vec![ghost]).unwrap_err();
    assert!(err.contains("unknown schema"), "got: {err}");

    // duplicate names
    let dup = HyperSchema {
        name: "D".to_string(),
        alg: 1,
        body: body(&group_input),
    };
    let err = SchemaRegistry::build(vec![dup.clone(), dup]).unwrap_err();
    assert!(err.contains("duplicate"), "got: {err}");

    // missing registry at eval time
    let doc = load();
    let input = fixture_set(&doc);
    let term = parse_term(&json!({ "op": "fix", "schema": "A", "entity": "e" })).unwrap();
    let err = eval_term(&term, &input, None, None).unwrap_err();
    assert!(err.contains("no registry"), "got: {err}");
}
