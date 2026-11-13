//! `vectors/store/views.json` (SPEC-18 proposal §4.6, "Held views"; `vectors/store/README.md`
//! §11). The Rust witness has no view holder until slice 3 step 10 builds it. Until then it reads
//! the document, checks its format and the shape of every step a runner reads first, and reports
//! every case skipped, as `follow.json` was skipped before step 8.

use serde_json::Value;

fn document() -> Value {
    let path = format!(
        "{}/../../vectors/store/views.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read views.json")).unwrap()
}

fn is_key(v: &Value) -> bool {
    v["program"].is_string() && v["root"].is_string()
}

#[test]
fn the_views_vectors_are_skipped_until_the_witness_holds_views() {
    let doc = document();
    assert_eq!(doc["format"], "rhizomatic-store-views/1");
    let programs: Vec<&str> = doc["programs"]
        .as_array()
        .expect("programs")
        .iter()
        .map(|p| p["name"].as_str().expect("a program's name"))
        .collect();
    assert!(!programs.is_empty());
    assert!(doc["schemas"].as_array().is_some_and(|s| !s.is_empty()));
    assert!(doc["setup"].as_array().is_some_and(|s| !s.is_empty()));
    let cases = doc["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().expect("a case's name");
        let requires = case["requires"].as_array().expect("requires");
        assert!(
            requires.iter().any(|r| r == "changes"),
            "{name} requires changes"
        );
        assert!(
            case["views"]["peer"].is_string(),
            "{name}: the holder's peer"
        );
        for step in case["steps"].as_array().expect("steps") {
            let op = step["op"].as_str().expect("op");
            let expect = &step["expect"];
            match op {
                "register" | "setEpoch" | "drop" => {
                    let program = step["program"].as_str().expect("program");
                    assert!(programs.contains(&program), "{name}: {program}");
                }
                "hold" => {
                    assert!(step["now"].is_number() && step["root"].is_string());
                    assert!(expect["bytes"].as_str().is_some_and(|b| !b.is_empty()));
                    assert!(expect["position"].is_string());
                    assert!(expect["reread"].as_array().unwrap().iter().all(is_key));
                    if let Some(from) = expect.get("from") {
                        assert!(from == "held" || from == "read", "{name}: {from}");
                    }
                }
                "refresh" => {
                    assert!(step["now"].is_number());
                    assert!(expect["resynced"].is_boolean());
                    assert!(expect["reread"].as_array().unwrap().iter().all(is_key));
                    for change in expect["changed"].as_array().expect("changed") {
                        assert!(is_key(change));
                        assert!(change["before"].is_string() || change["before"].is_null());
                        assert!(change["after"].is_string());
                    }
                }
                _ => {}
            }
            if matches!(op, "hold" | "refresh" | "drop") {
                let boundary = &expect["nextBoundary"];
                assert!(boundary.is_null() || boundary.is_number(), "{name}");
            }
        }
    }
    eprintln!(
        "skipped {} views cases: the Rust witness builds held views in slice 3 step 10",
        cases.len()
    );
}
