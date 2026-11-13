//! The shared store vectors (SPEC-18 proposal §8) against the memory reference store: every
//! script of `vectors/store/scripts.json` and every case of `vectors/store/scope.json`, in every
//! run README §3.9.7 names: as built by default, keeping two records and one, with pages of one
//! record, and keeping two records with pages of one. Every run passes and skips nothing.

use rhizomatic::memory_store::{MemoryStore, MemoryStoreOptions};
use rhizomatic::store::{ChangeRetention, PushdownFields, Store};
use rhizomatic::store_conformance::{run_store_conformance, StoreVectors};
use serde_json::Value;

fn load(file: &str) -> Value {
    let path = format!("{}/../../vectors/store/{file}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("read store vectors")).unwrap()
}

fn vectors() -> StoreVectors {
    StoreVectors {
        scripts: load("scripts.json"),
        scope: load("scope.json"),
    }
}

fn names(doc: &Value, list: &str, prefix: &str) -> Vec<String> {
    doc[list]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| format!("{prefix}/{}", entry["name"].as_str().unwrap()))
        .collect()
}

/// Every script and every case passes on a store built with these options, and nothing is
/// skipped: the memory store purges, has no journal, and serves a change feed.
fn passes_everything(options: MemoryStoreOptions) {
    let vectors = vectors();
    let report = run_store_conformance(
        &|| Ok(Box::new(MemoryStore::with_options(options)?) as Box<dyn Store>),
        &vectors,
    )
    .unwrap_or_else(|failures| panic!("{options:?}: {failures}"));
    assert_eq!(report.skipped, vec![], "{options:?}");
    let mut expected = names(&vectors.scripts, "scripts", "scripts");
    expected.extend(names(&vectors.scope, "cases", "scope"));
    assert_eq!(report.passed, expected, "{options:?}");
    assert_eq!(report.passed.len(), 25 + 15);
}

#[test]
fn the_memory_store_passes_every_store_vector() {
    passes_everything(MemoryStoreOptions::default());
}

/// README §3.9.7 run 2: a store that keeps only the latest n records answers `resync-required`
/// below its floor, and the runner predicts exactly where.
#[test]
fn the_memory_store_passes_keeping_two_records_and_keeping_one() {
    for n in [2, 1] {
        passes_everything(MemoryStoreOptions {
            change_retention: ChangeRetention::Revisions(n),
            ..MemoryStoreOptions::default()
        });
    }
}

/// README §3.9.7 runs 3 and 4: with pages of one record, every range of two or more records
/// takes more than one page.
#[test]
fn the_memory_store_passes_with_pages_of_one_record() {
    for retention in [ChangeRetention::Unbounded, ChangeRetention::Revisions(2)] {
        passes_everything(MemoryStoreOptions {
            change_retention: retention,
            change_page_size: Some(1),
            ..MemoryStoreOptions::default()
        });
    }
}

/// A memory store that applies only some pushdown fields is still a reference store. It must
/// report exactly the fields it applied, and the host must reach the exact scope by applying
/// the rest (the trim lemma, with a residual selection that is not empty).
#[test]
fn the_memory_store_passes_with_every_subset_of_pushdown_fields() {
    for bits in 0..8 {
        passes_everything(MemoryStoreOptions {
            pushdown: PushdownFields {
                timestamp_at_most: bits & 1 != 0,
                arrival_at_most: bits & 2 != 0,
                exclude_ids: bits & 4 != 0,
            },
            ..MemoryStoreOptions::default()
        });
    }
}
