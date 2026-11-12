//! The shared store vectors (SPEC-18 proposal §8) against the memory reference store: every
//! script of `vectors/store/scripts.json` and every case of `vectors/store/scope.json`.

use rhizomatic::memory_store::MemoryStore;
use rhizomatic::store::{PushdownFields, Store};
use rhizomatic::store_conformance::{run_store_conformance, StoreVectors};
use serde_json::Value;

fn load(file: &str) -> Value {
    let path = format!("{}/../../vectors/store/{file}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("read store vectors")).unwrap()
}

fn names(doc: &Value, list: &str, prefix: &str) -> Vec<String> {
    doc[list]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| format!("{prefix}/{}", entry["name"].as_str().unwrap()))
        .collect()
}

#[test]
fn the_memory_store_passes_every_store_vector() {
    let vectors = StoreVectors {
        scripts: load("scripts.json"),
        scope: load("scope.json"),
    };
    let report = run_store_conformance(
        &|| Ok(Box::new(MemoryStore::new()) as Box<dyn Store>),
        &vectors,
    )
    .unwrap_or_else(|failures| panic!("{failures}"));

    // Nothing is skipped on the memory store: it purges, and it has no journal.
    assert_eq!(report.skipped, vec![]);
    let mut expected = names(&vectors.scripts, "scripts", "scripts");
    expected.extend(names(&vectors.scope, "cases", "scope"));
    assert_eq!(report.passed, expected);
    assert_eq!(report.passed.len(), 21 + 15);
}

/// A memory store that applies only some pushdown fields is still a reference store. It must
/// report exactly the fields it applied, and the host must reach the exact scope by applying
/// the rest (the trim lemma, with a residual selection that is not empty).
#[test]
fn the_memory_store_passes_with_every_subset_of_pushdown_fields() {
    let vectors = StoreVectors {
        scripts: load("scripts.json"),
        scope: load("scope.json"),
    };
    for bits in 0..8 {
        let pushdown = PushdownFields {
            timestamp_at_most: bits & 1 != 0,
            arrival_at_most: bits & 2 != 0,
            exclude_ids: bits & 4 != 0,
        };
        let report = run_store_conformance(
            &|| Ok(Box::new(MemoryStore::with_pushdown(pushdown)) as Box<dyn Store>),
            &vectors,
        )
        .unwrap_or_else(|failures| panic!("{pushdown:?}: {failures}"));
        assert_eq!((report.passed.len(), report.skipped.len()), (36, 0));
    }
}
