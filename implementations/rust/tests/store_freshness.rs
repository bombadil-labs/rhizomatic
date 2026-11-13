//! `vectors/store/freshness.json` (SPEC-18 proposal §4.6; `vectors/store/README.md` §9) and the
//! rails each witness adds (README §9.7).
//!
//! **Built captures only, by construction.** `Capture` has private fields and exactly two
//! constructors, `make_capture` and `parse_capture`, and both check every rule of §4.6. So
//! `touching` and `check_fresh`, which take `&Capture`, can only ever receive a checked capture:
//! a spread copy, a reversed member list, a parsed value that skipped `parse_capture` or a cast
//! object cannot be written in Rust. The rows of README §9.7 "Built captures only" are met by the
//! type; the tests below hold the two constructors to the rules instead.

use rhizomatic::memory_store::{MemoryStore, MemoryStoreOptions};
use rhizomatic::store::{ChangeRetention, PushdownFields, Store, StoreError};
use rhizomatic::store_conformance::{
    run_freshness_conformance, FreshnessReader, StoreConformanceError, StoreConformanceReport,
};
use rhizomatic::store_read::StoreFreshness;
use serde_json::Value;

#[path = "support/freshness_doubles.rs"]
mod doubles;
use doubles::{ReportsNothingApplied, Scaled};

fn document() -> Value {
    let path = format!(
        "{}/../../vectors/store/freshness.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read freshness.json")).unwrap()
}

/// How one run of README §9.4 builds its stores.
#[derive(Debug, Clone, Copy)]
enum RunStore {
    /// The reference store with these options.
    Memory(MemoryStoreOptions),
    /// Run 6: applies the whole selection in `scope` and reports no field applied.
    ReportsNothing,
    /// Revisions `scale` times the reference's, keeping `keep` records, pages of `page`.
    Scaled {
        scale: u64,
        keep: Option<u64>,
        page: Option<u64>,
    },
}

fn options(keep: Option<u64>, page: Option<u64>) -> MemoryStoreOptions {
    MemoryStoreOptions {
        change_retention: keep.map_or(ChangeRetention::Unbounded, ChangeRetention::Revisions),
        change_page_size: page,
        ..MemoryStoreOptions::default()
    }
}

const DEFAULT: RunStore = RunStore::Memory(MemoryStoreOptions {
    pushdown: PushdownFields {
        timestamp_at_most: true,
        arrival_at_most: true,
        exclude_ids: true,
    },
    change_retention: ChangeRetention::Unbounded,
    change_page_size: None,
});

/// README §9.4 runs 1 to 6, and the scaled stores of README §8 ("Stores that must pass").
fn runs() -> Vec<(&'static str, RunStore)> {
    vec![
        ("1 default", DEFAULT),
        ("2 pages of one", RunStore::Memory(options(None, Some(1)))),
        ("3 two kept", RunStore::Memory(options(Some(2), None))),
        (
            "4 two kept, pages of one",
            RunStore::Memory(options(Some(2), Some(1))),
        ),
        (
            "5 no pushdown applied",
            RunStore::Memory(MemoryStoreOptions {
                pushdown: PushdownFields::default(),
                ..options(None, None)
            }),
        ),
        ("6 applies all, reports none", RunStore::ReportsNothing),
        (
            "times 3, pages of one",
            RunStore::Scaled {
                scale: 3,
                keep: None,
                page: Some(1),
            },
        ),
        (
            "times 2, two kept",
            RunStore::Scaled {
                scale: 2,
                keep: Some(2),
                page: None,
            },
        ),
    ]
}

fn open(run: RunStore, retention: Option<ChangeRetention>) -> Result<Box<dyn Store>, StoreError> {
    let with = |mut o: MemoryStoreOptions| {
        if let Some(retention) = retention {
            o.change_retention = retention;
        }
        o
    };
    Ok(match run {
        RunStore::Memory(o) => Box::new(MemoryStore::with_options(with(o))?),
        RunStore::ReportsNothing => Box::new(ReportsNothingApplied::new(
            MemoryStore::with_options(with(options(None, None)))?,
        )),
        RunStore::Scaled { scale, keep, page } => Box::new(Scaled::new(
            MemoryStore::with_options(with(options(keep, page)))?,
            scale,
        )),
    })
}

fn run(
    store: RunStore,
    doc: &Value,
    reader: &dyn FreshnessReader,
) -> Result<StoreConformanceReport, StoreConformanceError> {
    run_freshness_conformance(&|retention| open(store, retention), doc, reader)
}

fn counts(doc: &Value) -> (usize, usize) {
    (
        doc["cases"].as_array().unwrap().len(),
        doc["touching"].as_array().unwrap().len(),
    )
}

/// Every run of README §9.4 passes every case and every `touching` case, and skips nothing.
#[test]
fn every_freshness_case_passes_every_run() {
    let doc = document();
    let (cases, touching) = counts(&doc);
    assert!(cases >= 25 && touching >= 6, "{cases} cases, {touching}");
    for (label, store) in runs() {
        let report =
            run(store, &doc, &StoreFreshness).unwrap_or_else(|e| panic!("run {label}: {e}"));
        assert_eq!(report.passed.len(), cases + touching, "run {label}");
        assert!(
            report.skipped.is_empty(),
            "run {label}: {:?}",
            report.skipped
        );
    }
}
