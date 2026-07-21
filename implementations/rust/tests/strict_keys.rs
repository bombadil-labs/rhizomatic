//! Fail-closed KEY parsing (SPEC-2 §8, ERRATA-2 E19, issue #25). Mirrors
//! ../../ts/test/strict-keys.test.ts. The shared vectors pin the contract every witness owes —
//! rejection — while the suggestion quality below is witness-local ergonomics: error TEXT is
//! deliberately not normative, so witnesses may word it differently.

use rhizomatic::json_profile::parse_claims;
use rhizomatic::term_json::parse_term;
use serde_json::{json, Value};

fn strict_key_vectors() -> Vec<Value> {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-strict-keys.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let raw = std::fs::read_to_string(path).expect("read eval-strict-keys.json");
    let doc: Value = serde_json::from_str(&raw).unwrap();
    doc["rejects"].as_array().expect("rejects array").clone()
}

#[test]
fn l1_eval_strict_key_rejects() {
    let rejects = strict_key_vectors();
    assert!(
        !rejects.is_empty(),
        "eval-strict-keys.json must not be empty"
    );
    for r in rejects {
        let name = r["name"].as_str().unwrap();
        let reason = r["reason"].as_str().unwrap();
        let result = parse_term(&r["term"]);
        assert!(
            result.is_err(),
            "{name} must be rejected ({reason}), but parsed as {result:?}"
        );
    }
}

#[test]
fn rejection_messages_name_the_offending_key() {
    // SHOULD, SPEC-2 §8: name the key and point at the likely cause.
    let e = parse_term(&json!({
        "op": "expand",
        "role": { "exact": "a" },
        "schema": "S",
        "readng": "R",
        "in": { "op": "group", "key": "byRole", "in": "input" }
    }))
    .unwrap_err();
    assert!(e.contains("unknown key \"readng\""), "{e}");
    assert!(e.contains("did you mean \"reading\""), "{e}");

    let e = parse_term(&json!({ "op": "select", "pred": "true", "in": "input", "quantumFlux": 1 }))
        .unwrap_err();
    assert!(e.contains("unknown key \"quantumFlux\""), "{e}");
    assert!(e.contains("newer rhizomatic"), "{e}");

    let e = parse_term(&json!({
        "op": "select",
        "pred": { "hasPointer": { "role": { "exact": "a", "prefix": "b" } } },
        "in": "input"
    }))
    .unwrap_err();
    assert!(e.contains("ambiguous"), "{e}");
    assert!(e.contains("\"exact\" and \"prefix\""), "{e}");
}

#[test]
fn ambiguous_target_discriminators_are_named_at_l0() {
    let e = parse_claims(&json!({
        "timestamp": 0,
        "author": "did:key:zA",
        "pointers": [{ "role": "r", "target": { "id": "e", "delta": "1e2000" } }]
    }))
    .unwrap_err();
    assert!(e.contains("ambiguous"), "{e}");
    assert!(e.contains("\"id\" and \"delta\""), "{e}");
}

// These two are author-keyed data, not grammar: strictness here would be a bug (issue #25).
#[test]
fn genuinely_open_nodes_stay_open() {
    parse_term(&json!({
        "op": "fix",
        "schema": "S",
        "entity": "e",
        "bindings": { "anyHoleName": 1, "another": "x" }
    }))
    .expect("fix.bindings accepts arbitrary hole names");

    parse_term(&json!({
        "op": "resolve",
        "schema": {
            "props": { "anyPropertyName": { "pick": { "order": "lexById" } } },
            "default": { "pick": { "order": "lexById" } }
        },
        "in": "input"
    }))
    .expect("schema.props accepts arbitrary property names");
}
