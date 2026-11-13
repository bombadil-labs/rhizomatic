//! `vectors/store/follow.json` (SPEC-18 proposal §4.6, "Following the feed";
//! `vectors/store/README.md` §10). The Rust witness has no feed cursor until slice 3 step 8
//! builds it. Until then it reads the document, checks the parts every runner reads first, and
//! reports every case skipped, as `freshness.json` was skipped before step 6.

use serde_json::Value;

fn document() -> Value {
    let path = format!(
        "{}/../../vectors/store/follow.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read follow.json")).unwrap()
}

#[test]
fn the_follow_vectors_are_skipped_until_the_witness_has_a_cursor() {
    let doc = document();
    assert_eq!(doc["format"], "rhizomatic-store-follow/1");
    let cases = doc["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let requires = case["requires"].as_array().expect("requires");
        assert!(
            requires.iter().any(|r| r == "changes"),
            "{} requires changes",
            case["name"]
        );
        let steps = case["steps"].as_array().expect("steps");
        let ops: Vec<&str> = steps.iter().map(|s| s["op"].as_str().unwrap()).collect();
        assert!(ops.contains(&"follow") && ops.contains(&"pull"));
        for step in steps.iter().filter(|s| s["op"] == "pull") {
            let status = step["expect"]["status"].as_str().expect("status");
            assert!(status == "ok" || status == "resync-required", "{status}");
        }
    }
    eprintln!(
        "skipped {} follow cases: the Rust witness builds the feed cursor in slice 3 step 8",
        cases.len()
    );
}
