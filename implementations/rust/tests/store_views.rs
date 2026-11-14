//! `vectors/store/views.json` (SPEC-18 proposal §4.6, "Held views"; `vectors/store/README.md`
//! §11) and the rails each witness adds (README §11.6).

use rhizomatic::memory_store::{MemoryStore, MemoryStoreOptions};
use rhizomatic::store::{ChangeRetention, Store, StoreError};
use rhizomatic::store_conformance::{
    run_views_conformance, FollowCaseStore, StoreConformanceError, StoreConformanceReport,
    ViewsReader,
};
use rhizomatic::store_views::StoreViewsReader;
use serde_json::Value;

use crate::freshness_doubles::Scaled;

fn document() -> Value {
    let path = format!(
        "{}/../../vectors/store/views.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read views.json")).unwrap()
}

/// How one run of README §11.5 builds its stores.
#[derive(Debug, Clone, Copy)]
struct RunStore {
    scale: u64,
    keep: Option<u64>,
    page: Option<u64>,
}

const DEFAULT: RunStore = RunStore {
    scale: 1,
    keep: None,
    page: None,
};

/// README §11.5 runs 1 to 5, and revisions times 2 keeping two records.
fn runs() -> Vec<(&'static str, RunStore)> {
    let run = |scale, keep, page| RunStore { scale, keep, page };
    vec![
        ("1 default", DEFAULT),
        ("2 pages of one", run(1, None, Some(1))),
        ("3 two kept", run(1, Some(2), None)),
        ("4 two kept, pages of one", run(1, Some(2), Some(1))),
        ("5 times 3, pages of one", run(3, None, Some(1))),
        ("times 2, two kept", run(2, Some(2), None)),
    ]
}

fn open(run: RunStore, case: FollowCaseStore) -> Result<Box<dyn Store>, StoreError> {
    let options = MemoryStoreOptions {
        change_retention: case.change_retention.unwrap_or(
            run.keep
                .map_or(ChangeRetention::Unbounded, ChangeRetention::Revisions),
        ),
        change_page_size: case.change_page_size.or(run.page),
        ..MemoryStoreOptions::default()
    };
    let store = MemoryStore::with_options(options)?;
    Ok(match run.scale {
        1 => Box::new(store),
        k => Box::new(Scaled::new(store, k)),
    })
}

fn run(
    store: RunStore,
    doc: &Value,
    reader: &dyn ViewsReader,
) -> Result<StoreConformanceReport, StoreConformanceError> {
    run_views_conformance(&|case| open(store, case), doc, reader)
}

fn case_names(doc: &Value) -> Vec<String> {
    doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| format!("views/{}", c["name"].as_str().unwrap()))
        .collect()
}

/// Every run of README §11.5 passes every case of the file and skips nothing.
#[test]
fn every_views_case_passes_every_run() {
    let doc = document();
    assert_eq!(doc["format"], "rhizomatic-store-views/1");
    let names = case_names(&doc);
    assert_eq!(names.len(), 28, "{names:?}");
    for (label, store) in runs() {
        let report = run(store, &doc, &StoreViewsReader::default())
            .unwrap_or_else(|e| panic!("run {label}: {e}"));
        assert_eq!(report.passed, names, "run {label}");
        assert!(
            report.skipped.is_empty(),
            "run {label}: {:?}",
            report.skipped
        );
    }
}
