//! `vectors/store/freshness.json` (SPEC-18 proposal §4.6; `vectors/store/README.md` §9). The
//! Rust witness has no captures, `touching` or `check_fresh` until slice 3 step 6 builds them.
//! Until then it reads the document, checks the parts every runner reads first, and reports
//! every case skipped, as the feed scripts were skipped before step 2.

use serde_json::Value;

fn document() -> Value {
    let path = format!(
        "{}/../../vectors/store/freshness.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read freshness.json")).unwrap()
}

#[test]
fn the_freshness_vectors_are_skipped_until_the_witness_has_freshness() {
    let doc = document();
    assert_eq!(doc["format"], "rhizomatic-store-freshness/1");
    let cases = doc["cases"].as_array().expect("cases");
    let touching = doc["touching"].as_array().expect("touching");
    for case in cases {
        let requires = case["requires"].as_array().expect("requires");
        assert!(
            requires.iter().any(|r| r == "changes"),
            "{} requires changes",
            case["name"]
        );
        let ops: Vec<&str> = case["steps"]
            .as_array()
            .expect("steps")
            .iter()
            .map(|s| s["op"].as_str().unwrap())
            .collect();
        assert!(ops.contains(&"capture") && ops.contains(&"check"));
    }
    eprintln!(
        "skipped {} freshness cases and {} touching cases: the Rust witness builds freshness in slice 3 step 6",
        cases.len(),
        touching.len()
    );
}
