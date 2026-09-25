//! Shared SPEC-2 §8 diagnostic vectors. Message text is intentionally not compared.

use rhizomatic::{parse_pred_diagnostic, parse_term_diagnostic};
use serde_json::Value;

#[test]
fn structured_parse_errors_match_shared_vectors() {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-parse-errors.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = doc["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let result = match case["parse"].as_str().unwrap() {
            "term" => parse_term_diagnostic(&case["input"]).map(|_| ()),
            "pred" => parse_pred_diagnostic(&case["input"]).map(|_| ()),
            other => panic!("{name}: unknown parser {other}"),
        };
        let error = result.expect_err(name);
        assert_eq!(
            error.kind.as_str(),
            case["error"]["kind"].as_str().unwrap(),
            "{name}"
        );
        if let Some(path) = case["error"]["path"].as_str() {
            assert_eq!(error.path, path, "{name}");
        } else {
            let paths = case["error"]["paths"].as_array().unwrap();
            assert!(
                paths.iter().any(|p| p.as_str() == Some(error.path.as_str())),
                "{name}: {} not in {paths:?}",
                error.path
            );
        }
        assert!(!error.message.is_empty(), "{name}: missing human message");
    }
}
