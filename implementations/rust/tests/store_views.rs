//! `vectors/store/views.json` (SPEC-18 proposal §4.6, "Held views"; `vectors/store/README.md`
//! §11) and the rails each witness adds (README §11.6).

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::hint::black_box;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rhizomatic::anchored::{anchor_analysis, hview_anchors, scope_ids, AnchorAnalysis};
use rhizomatic::eval::{eval_term_at, result_canonical_hex, EvalResult, Term};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::memory_store::{MemoryStore, MemoryStoreOptions};
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, make_negation_claims, DeltaSource};
use rhizomatic::store::{
    scope_source, target_entities, Admission, AppendResult, ArrivalRecord, ChangePage,
    ChangeRetention, ErasurePosture, PeerErasure, PeerStore, PurgeReport, Pushdown, Revision,
    ScopeRequest, ScopeResult, Snapshot, Store, StoreError, StoreErrorCode, VerifiedDelta,
};
use rhizomatic::store_conformance::{
    run_views_conformance, FollowCaseStore, RegisterRefusal, StoreConformanceError,
    StoreConformanceReport, ViewsReader,
};
use rhizomatic::store_fresh::{check_fresh, validity_window, FeedError, Freshness};
use rhizomatic::store_held::{ViewChange, ViewFrom, ViewKey};
use rhizomatic::store_read::{read_anchored, ReadRequest};
use rhizomatic::store_views::{
    StoreViews, StoreViewsOptions, StoreViewsReader, ViewProgram, ViewQuirk, ViewSizes,
    DEFAULT_MAX_VIEWS,
};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};
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
    assert_eq!(names.len(), 30, "{names:?}");
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

// ---------------------------------------------------------------------------------------------
// Wrong holders (README §11.6)
// ---------------------------------------------------------------------------------------------

fn holder(quirk: ViewQuirk) -> StoreViewsReader {
    StoreViewsReader { quirk: Some(quirk) }
}

/// One row: the holder with one rule broken, the case it fails, how its message starts, and,
/// when the table names them, the only cases that catch it.
struct Row {
    quirk: ViewQuirk,
    case: &'static str,
    message: &'static str,
    only: &'static [&'static str],
}

const fn row(quirk: ViewQuirk, case: &'static str, message: &'static str) -> Row {
    Row {
        quirk,
        case,
        message,
        only: &[],
    }
}

const TABLE: &[Row] = &[
    row(
        ViewQuirk::NeverRereads,
        "an-append-at-an-anchor-of-one-view",
        "refresh re-read [], expected [leaf@garden:1]",
    ),
    row(
        ViewQuirk::RereadsEverything,
        "an-unrelated-append",
        "refresh re-read [leaf@garden:1 tree@garden:1], expected []",
    ),
    row(
        ViewQuirk::IgnoresRemoved,
        "a-purge-of-a-member",
        "refresh re-read [], expected [leaf@plant:s]",
    ),
    row(
        ViewQuirk::IgnoresNegators,
        "a-negator-of-a-member",
        "refresh re-read [], expected [leaf@plant:2]",
    ),
    row(
        ViewQuirk::KeepsFirstIndex,
        "a-view-gains-a-dynamic-anchor",
        "refresh re-read [], expected [tree1@plant:2]",
    ),
    row(
        ViewQuirk::KeepsForgottenIndex,
        "drop",
        "refresh re-read [leaf@garden:1], expected []",
    ),
    row(
        ViewQuirk::IgnoresSince,
        "time-moves-past-the-window-and-back",
        "refresh re-read [], expected [leaf@plant:2 leaf@plant:s]",
    ),
    row(
        ViewQuirk::IgnoresExpiry,
        "time-moves-past-the-window-and-back",
        "refresh re-read [], expected [leaf@plant:s]",
    ),
    row(
        ViewQuirk::IgnoresEpoch,
        "set-epoch",
        "refresh re-read [], expected [leaf@bed:1 leaf@garden:1]",
    ),
    row(
        ViewQuirk::ReadsOnNewerSnapshot,
        "an-append-at-an-anchor-of-one-view",
        "refresh made the call read where the contract asks for scope",
    ),
    row(
        ViewQuirk::MergesOnResync,
        "retention-too-short",
        "refresh re-read [], expected [leaf@garden:1 leaf@plant:2]",
    ),
    row(
        ViewQuirk::FeedPerView,
        "an-unrelated-append",
        "refresh made the call changes(2, 3) where the contract asks for release",
    ),
    row(
        ViewQuirk::StaticBoundary,
        "time-moves-past-the-window-and-back",
        "the next boundary is 60, expected null",
    ),
    row(
        ViewQuirk::KeepsPurgedBaseline,
        "a-purge-read-by-a-hold-releases-the-baseline",
        "refresh reports the change of leaf at plant:s with other bytes",
    ),
    Row {
        quirk: ViewQuirk::ServesEvictedBytes,
        case: "an-evicted-view-is-read-again",
        message: "hold of leaf at garden:1 answered other bytes",
        only: &[
            "an-evicted-view-is-read-again",
            "an-evicted-view-held-again-answers-new",
        ],
    },
    row(
        ViewQuirk::AnswersReadForNew,
        "an-evicted-view-held-again-answers-new",
        "hold of leaf at garden:1 answered from read, expected new",
    ),
    row(
        ViewQuirk::AnswersReadForNew,
        "a-program-with-a-selection",
        "hold of before-60 at plant:s answered from read, expected new",
    ),
    row(
        ViewQuirk::EvictedEmpty,
        "an-evicted-view-not-held-again",
        "refresh evicted [], expected [leaf@garden:1]",
    ),
    Row {
        quirk: ViewQuirk::EvictedKeepsDropped,
        case: "an-evicted-view-not-held-again",
        message: "refresh evicted [leaf@bed:1 leaf@garden:1], expected [leaf@garden:1]",
        only: &["an-evicted-view-not-held-again"],
    },
    row(
        ViewQuirk::EvictedKeepsReheld,
        "an-evicted-view-held-again-answers-new",
        "refresh evicted [leaf@bed:1 leaf@garden:1], expected [leaf@bed:1]",
    ),
    Row {
        quirk: ViewQuirk::ReadsEvicted,
        case: "an-evicted-view-not-held-again",
        message: "hold read leaf@garden:1, the view it evicts",
        only: &["an-evicted-view-not-held-again"],
    },
    // The rows of the runner's own checks (README §11.6, "Every check has a row").
    row(
        ViewQuirk::UnorderedReread,
        "two-views-share-an-anchor",
        "refresh's re-read list is not ascending",
    ),
    row(
        ViewQuirk::ReadsOnSetEpoch,
        "set-epoch",
        "setEpoch made the call read; it makes no store call",
    ),
    row(
        ViewQuirk::OtherHistory,
        "no-change",
        "hold answered another history",
    ),
    row(
        ViewQuirk::AnswersNewAlways,
        "a-program-with-a-selection",
        "hold of before-60 at plant:s answered from new, expected held or read",
    ),
];

/// The other cases some holders fail besides their row's (README §11.6).
#[test]
fn some_wrong_holders_fail_more_cases_as_the_table_says() {
    let doc = document();
    let failed = |quirk| -> BTreeSet<String> {
        run(DEFAULT, &doc, &holder(quirk))
            .unwrap_err()
            .failures
            .into_iter()
            .map(|f| f.name.trim_start_matches("views/").to_string())
            .collect()
    };
    let every: BTreeSet<String> = case_names(&doc)
        .iter()
        .map(|n| n.trim_start_matches("views/").to_string())
        .collect();
    let read_for_new = failed(ViewQuirk::AnswersReadForNew);
    assert!(read_for_new.is_superset(&every), "{read_for_new:?}");
    let empty = failed(ViewQuirk::EvictedEmpty);
    for case in [
        "max-views-evicts-the-least-recently-held",
        "an-evicted-view-held-again-answers-new",
    ] {
        assert!(empty.contains(case), "{case}: {empty:?}");
    }
    let reheld = failed(ViewQuirk::EvictedKeepsReheld);
    assert!(
        reheld.contains("max-views-evicts-the-least-recently-held"),
        "{reheld:?}"
    );
}

/// What is wrong with one row's run, or nothing.
fn judge(doc: &Value, row: &Row) -> Option<String> {
    let error = match run(DEFAULT, doc, &holder(row.quirk)) {
        Ok(_) => return Some("passed every case".into()),
        Err(error) => error,
    };
    let name = format!("views/{}", row.case);
    let Some(found) = error.failures.iter().find(|f| f.name == name) else {
        return Some(format!("{} did not fail: {error}", row.case));
    };
    if !found.message.starts_with(row.message) {
        return Some(format!(
            "{} failed for another reason: {}",
            row.case, found.message
        ));
    }
    let failed: BTreeSet<&str> = error
        .failures
        .iter()
        .map(|f| f.name.trim_start_matches("views/"))
        .collect();
    let only: BTreeSet<&str> = row.only.iter().copied().collect();
    if !only.is_empty() && failed != only {
        return Some(format!("failed {failed:?}, the table names only {only:?}"));
    }
    None
}

#[test]
fn every_wrong_holder_fails_its_case_with_its_message() {
    let doc = document();
    let red: Vec<String> = TABLE
        .iter()
        .filter_map(|row| judge(&doc, row).map(|p| format!("{:?}: {p}", row.quirk)))
        .collect();
    assert!(
        red.is_empty(),
        "{} rows did not hold:\n  {}",
        red.len(),
        red.join("\n  ")
    );
}

/// The holder that keeps an evicted view passes the document without its one case (README
/// §11.6); the holder that keeps a purged baseline also fails the other purge cases.
#[test]
fn without_their_only_cases_the_named_holders_pass() {
    let doc = document();
    for row in TABLE.iter().filter(|row| !row.only.is_empty()) {
        let mut without = doc.clone();
        without["cases"]
            .as_array_mut()
            .unwrap()
            .retain(|c| !row.only.contains(&c["name"].as_str().unwrap()));
        for (label, store) in runs() {
            if let Err(e) = run(store, &without, &holder(row.quirk)) {
                panic!("{:?} fails without its cases, run {label}: {e}", row.quirk);
            }
        }
    }
    let error = run(DEFAULT, &doc, &holder(ViewQuirk::KeepsPurgedBaseline)).unwrap_err();
    let failed: BTreeSet<&str> = error.failures.iter().map(|f| f.name.as_str()).collect();
    for case in [
        "views/a-purge-of-a-member",
        "views/a-purge-and-a-re-add-between-refreshes",
        "views/a-baseline-keeps-a-member-the-view-lost",
    ] {
        assert!(failed.contains(case), "{case}: {failed:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// Defective documents (README §11.6, "Every check has a row")
// ---------------------------------------------------------------------------------------------

fn steps_of<'a>(doc: &'a mut Value, case: &str) -> &'a mut Vec<Value> {
    doc["cases"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["name"] == case)
        .unwrap()["steps"]
        .as_array_mut()
        .unwrap()
}

/// The `n`th step with this op in a case.
fn nth<'a>(doc: &'a mut Value, case: &str, op: &str, n: usize) -> &'a mut Value {
    steps_of(doc, case)
        .iter_mut()
        .filter(|s| s["op"] == op)
        .nth(n)
        .unwrap()
}

fn fails_with(doc: &Value, name: &str, message: &str) {
    let error = run(DEFAULT, doc, &StoreViewsReader::default()).expect_err(message);
    let failure = error
        .failures
        .iter()
        .find(|f| f.name == name)
        .unwrap_or_else(|| panic!("{name} did not fail: {error}"));
    assert!(
        failure.message.starts_with(message),
        "{name}: {} does not start {message:?}",
        failure.message
    );
}

#[test]
fn a_changed_expectation_fails_with_its_message() {
    let doc = document();
    let edit = |f: &dyn Fn(&mut Value)| {
        let mut d = doc.clone();
        f(&mut d);
        d
    };
    // Other bytes.
    fails_with(
        &edit(&|d| nth(d, "no-change", "hold", 0)["expect"]["bytes"] = "a0".into()),
        "views/no-change",
        "hold of leaf at garden:1 answered other bytes",
    );
    // Another `from`: a held view expected read.
    fails_with(
        &edit(&|d| nth(d, "no-change", "hold", 2)["expect"]["from"] = "read".into()),
        "views/no-change",
        "hold of leaf at garden:1 answered from held, expected read",
    );
    // A new view expected held.
    fails_with(
        &edit(&|d| nth(d, "no-change", "hold", 0)["expect"]["from"] = "held".into()),
        "views/no-change",
        "hold of leaf at garden:1 answered from new, expected held",
    );
    // Another `evicted`.
    fails_with(
        &edit(&|d| {
            nth(d, "no-change", "refresh", 0)["expect"]["evicted"] =
                serde_json::json!([{ "program": "leaf", "root": "garden:1" }])
        }),
        "views/no-change",
        "refresh evicted [], expected [leaf@garden:1]",
    );
    // Another hold position.
    fails_with(
        &edit(&|d| nth(d, "no-change", "hold", 0)["expect"]["position"] = "A.0".into()),
        "views/no-change",
        "hold stands at 2, expected 0",
    );
    // Another `expiresAt`.
    fails_with(
        &edit(&|d| nth(d, "no-change", "hold", 0)["expect"]["expiresAt"] = 7.into()),
        "views/no-change",
        "hold of leaf at garden:1 reports expiresAt null, expected 7",
    );
    // Another next boundary.
    fails_with(
        &edit(&|d| nth(d, "no-change", "hold", 0)["expect"]["nextBoundary"] = 7.into()),
        "views/no-change",
        "the next boundary is null, expected 7",
    );
    // Another refresh position.
    fails_with(
        &edit(&|d| nth(d, "no-change", "refresh", 0)["expect"]["position"] = "A.0".into()),
        "views/no-change",
        "refresh stands at 2, expected 0",
    );
    // Another `resynced`.
    fails_with(
        &edit(&|d| nth(d, "no-change", "refresh", 0)["expect"]["resynced"] = true.into()),
        "views/no-change",
        "refresh resynced false, expected true",
    );
    // Another `reread`.
    fails_with(
        &edit(&|d| {
            nth(d, "no-change", "refresh", 0)["expect"]["reread"] =
                serde_json::json!([{ "program": "leaf", "root": "garden:1" }])
        }),
        "views/no-change",
        "refresh re-read [], expected [leaf@garden:1]",
    );
    // Another `changed`.
    fails_with(
        &edit(&|d| {
            nth(d, "an-append-at-an-anchor-of-one-view", "refresh", 0)["expect"]["changed"] =
                serde_json::json!([])
        }),
        "views/an-append-at-an-anchor-of-one-view",
        "refresh changed [leaf@garden:1], expected []",
    );
    // Another change's bytes.
    fails_with(
        &edit(&|d| {
            nth(d, "an-append-at-an-anchor-of-one-view", "refresh", 0)["expect"]["changed"][0]
                ["after"] = "a0".into()
        }),
        "views/an-append-at-an-anchor-of-one-view",
        "refresh reports the change of leaf at garden:1 with other bytes",
    );
    // A refusal with another reason.
    fails_with(
        &edit(&|d| {
            nth(d, "an-unanchored-program-is-refused", "register", 0)["expect"]["reason"] =
                "reflection".into()
        }),
        "views/an-unanchored-program-is-refused",
        "register refused aliased, expected reflection",
    );
    // A refusal expected of an anchored program.
    fails_with(
        &edit(&|d| {
            nth(d, "an-unanchored-program-is-refused", "register", 1)["expect"] =
                serde_json::json!({ "reason": "aliased" })
        }),
        "views/an-unanchored-program-is-refused",
        "register of leaf answered, expected the refusal aliased",
    );
    // A refusal not expected.
    fails_with(
        &edit(&|d| {
            nth(d, "an-unanchored-program-is-refused", "register", 0)
                .as_object_mut()
                .unwrap()
                .remove("expect");
        }),
        "views/an-unanchored-program-is-refused",
        "register of aliased was refused: aliased",
    );
    // A hold before registering.
    fails_with(
        &edit(&|d| {
            steps_of(d, "no-change").retain(|s| !(s["op"] == "register" && s["program"] == "leaf"))
        }),
        "views/no-change",
        "the vector holds leaf before registering it",
    );
    // An unknown program.
    fails_with(
        &edit(&|d| nth(d, "no-change", "hold", 0)["program"] = "nowhere".into()),
        "views/no-change",
        "the vector names an unknown program nowhere",
    );
    // A program named twice.
    fails_with(
        &edit(&|d| {
            let again = d["programs"][0].clone();
            d["programs"].as_array_mut().unwrap().push(again);
        }),
        "views",
        "the vector names program leaf twice",
    );
    // A hold whose `reread` misses a read.
    fails_with(
        &edit(&|d| {
            nth(d, "a-hold-passes-for-the-whole-set", "hold", 2)["expect"]["reread"] =
                serde_json::json!([])
        }),
        "views/a-hold-passes-for-the-whole-set",
        "hold made the call scope where the contract asks for release",
    );
    // A document of another format.
    fails_with(
        &edit(&|d| d["format"] = "rhizomatic-store-views/2".into()),
        "views",
        "unknown store views format",
    );
}

// ---------------------------------------------------------------------------------------------
// The holder's own rules (README §11.6)
// ---------------------------------------------------------------------------------------------

const AUTHOR: &str = "did:key:zViews";

fn delta(pointers: Vec<Pointer>, at: f64, until: Option<f64>) -> Delta {
    make_delta(
        Claims {
            timestamp: at,
            valid_from: at,
            valid_until: until,
            author: AUTHOR.into(),
            pointers,
        },
        None,
    )
    .unwrap()
}

fn entity(id: &str, context: &str) -> Target {
    Target::Entity(EntityRef {
        id: id.into(),
        context: Some(context.into()),
    })
}

/// A fact about `root` in `context`, valid over `[at, until)`.
fn fact_until(root: &str, context: &str, value: &str, at: f64, until: Option<f64>) -> Delta {
    delta(
        vec![
            Pointer {
                role: "subject".into(),
                target: entity(root, context),
            },
            Pointer {
                role: "value".into(),
                target: Target::Primitive(Primitive::Str(value.into())),
            },
        ],
        at,
        until,
    )
}

fn fact(root: &str, context: &str, value: &str) -> Delta {
    fact_until(root, context, value, 1.0, None)
}

fn negation(of: &Delta, at: f64) -> Delta {
    make_delta(make_negation_claims(AUTHOR, at, &of.id, None), None).unwrap()
}

/// Appends batches to one peer, moving its head each time.
#[derive(Debug, Default)]
struct Writer {
    head: usize,
    last: u64,
}

impl Writer {
    fn append(&mut self, peer: &dyn PeerStore, deltas: &[Delta]) -> Revision {
        let added = deltas
            .iter()
            .map(|delta| {
                self.last += 1;
                VerifiedDelta {
                    delta: delta.clone(),
                    arrival: ArrivalRecord {
                        id: delta.id.clone(),
                        at: self.last as f64,
                        sequence: self.last,
                        transfer: 1,
                        sender: "local".into(),
                    },
                }
            })
            .collect();
        let result = peer
            .append(&Admission {
                expected_head: (self.head > 0).then(|| format!("head-{}", self.head)),
                next_head: format!("head-{}", self.head + 1),
                frame: None,
                added,
            })
            .unwrap();
        self.head += 1;
        match result {
            AppendResult::Committed { revision, .. } => revision,
            other => panic!("{other:?}"),
        }
    }
}

/// The term of a program of `views.json`.
fn term(name: &str) -> Term {
    let doc = document();
    let program = doc["programs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == name)
        .unwrap();
    parse_term(&program["term"]).unwrap()
}

/// What a store fault double does to the next pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    /// One page with no progress; the next answers soundly.
    NoProgress,
    PastTheBound,
    UnaskedIds,
    /// `scope` refuses: a read in the pass fails with a store refusal.
    RefusesScope,
}

/// Where a moved snapshot shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Moves {
    AtRead,
    AtScope,
}

/// A handle that names every call through it and its snapshots, and can break the store's
/// contract or move the snapshot on demand.
struct Spy<'a> {
    inner: &'a dyn PeerStore,
    calls: Rc<RefCell<Vec<String>>>,
    fault: Rc<Cell<Option<Fault>>>,
    moves: Rc<Cell<(usize, Moves)>>,
}

impl<'a> Spy<'a> {
    fn new(inner: &'a dyn PeerStore) -> Self {
        Self {
            inner,
            calls: Rc::default(),
            fault: Rc::default(),
            moves: Rc::new(Cell::new((0, Moves::AtRead))),
        }
    }

    fn handle(&self) -> Box<dyn PeerStore + 'a> {
        Box::new(Spy {
            inner: self.inner,
            calls: self.calls.clone(),
            fault: self.fault.clone(),
            moves: self.moves.clone(),
        })
    }

    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.borrow_mut())
    }

    fn log(&self, call: &str) {
        self.calls.borrow_mut().push(call.into());
    }
}

fn moved() -> StoreError {
    StoreError::new(StoreErrorCode::SnapshotMoved, "moved")
}

impl PeerStore for Spy<'_> {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn erasure(&self) -> PeerErasure {
        self.inner.erasure()
    }
    fn history(&self) -> &str {
        self.inner.history()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        self.log("read");
        let (left, at) = self.moves.get();
        if left > 0 && at == Moves::AtRead {
            self.moves.set((left - 1, at));
            return Err(moved());
        }
        Ok(Box::new(SpySnapshot {
            inner: self.inner.read()?,
            calls: self.calls.clone(),
            fault: self.fault.clone(),
            moves: self.moves.clone(),
        }))
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.log("append");
        self.inner.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        self.log("purge");
        self.inner.purge(ids)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreError> {
        self.log("changes");
        let page = self.inner.changes(from, to)?;
        Ok(match (self.fault.get(), page) {
            (Some(Fault::NoProgress), ChangePage::Ok { records, .. }) => {
                self.fault.set(None);
                ChangePage::Ok {
                    records,
                    through: from,
                }
            }
            (Some(Fault::PastTheBound), ChangePage::Ok { records, through }) => ChangePage::Ok {
                records,
                through: Revision(through.0 + 1),
            },
            (_, page) => page,
        })
    }
}

struct SpySnapshot {
    inner: Box<dyn Snapshot>,
    calls: Rc<RefCell<Vec<String>>>,
    fault: Rc<Cell<Option<Fault>>>,
    moves: Rc<Cell<(usize, Moves)>>,
}

impl SpySnapshot {
    fn log(&self, call: &str) {
        self.calls.borrow_mut().push(call.into());
    }
}

impl Snapshot for SpySnapshot {
    fn revision(&self) -> Revision {
        self.inner.revision()
    }
    fn history(&self) -> &str {
        self.inner.history()
    }
    fn head(&self) -> Option<&str> {
        self.inner.head()
    }
    fn count(&self) -> u64 {
        self.inner.count()
    }
    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreError> {
        self.log("get");
        let mut got = self.inner.get(ids)?;
        if self.fault.get() == Some(Fault::UnaskedIds) {
            if let Some(first) = got.first().cloned() {
                got.push(first);
            }
        }
        Ok(got)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        self.log("arrivals");
        self.inner.arrivals(ids)
    }
    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreError> {
        self.log("targets");
        self.inner.targets(entities)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.log("negators");
        self.inner.negators(ids)
    }
    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        self.log("scope");
        if self.fault.get() == Some(Fault::RefusesScope) {
            return Err(StoreError::new(StoreErrorCode::StoreClosed, "refused"));
        }
        let (left, at) = self.moves.get();
        if left > 0 && at == Moves::AtScope {
            self.moves.set((left - 1, at));
            return Err(moved());
        }
        self.inner.scope(request)
    }
    fn release(&mut self) {
        self.log("release");
        self.inner.release()
    }
}

fn new_peer(store: &MemoryStore, name: &str) -> Box<dyn PeerStore> {
    store.create_peer(name, ErasurePosture::Unproven).unwrap()
}

fn holder_over<'a>(spy: &Spy<'a>, max_views: usize) -> StoreViews<'a> {
    StoreViews::new(
        spy.handle(),
        StoreViewsOptions {
            max_views,
            ..StoreViewsOptions::default()
        },
    )
    .unwrap()
}

fn register_leaf(views: &mut StoreViews<'_>, name: &str) {
    views
        .register(name, ViewProgram::new(term("leaf")))
        .unwrap();
}

fn refused<T: std::fmt::Debug>(answer: Result<T, StoreError>) -> StoreErrorCode {
    answer.unwrap_err().code
}

fn feed_refused<T: std::fmt::Debug>(answer: Result<T, FeedError>) -> Option<StoreErrorCode> {
    answer.unwrap_err().code()
}

#[test]
fn register_refuses_an_unanchored_term_and_a_name_twice_and_a_holder_needs_one_view() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:r");
    let spy = Spy::new(peer.as_ref());
    let mut views = holder_over(&spy, 4);
    assert_eq!(
        views.register("aliased", ViewProgram::new(term("aliased"))),
        Err(RegisterRefusal::Unanchored("aliased".into()))
    );
    register_leaf(&mut views, "leaf");
    match views.register("leaf", ViewProgram::new(term("leaf"))) {
        Err(RegisterRefusal::Refused(e)) => assert_eq!(e.code, StoreErrorCode::InvalidRequest),
        other => panic!("{other:?}"),
    }
    assert!(spy.take().is_empty(), "register makes no store call");
    let zero = StoreViews::new(
        spy.handle(),
        StoreViewsOptions {
            max_views: 0,
            ..StoreViewsOptions::default()
        },
    );
    assert_eq!(
        zero.err().map(|e| e.code),
        Some(StoreErrorCode::InvalidRequest)
    );
    assert_eq!(StoreViewsOptions::default().max_views, 1024);
    assert!(spy.take().is_empty(), "making a holder makes no store call");
}

#[test]
fn a_name_not_registered_and_a_now_not_finite_are_refused_with_no_store_call() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:n");
    let spy = Spy::new(peer.as_ref());
    let mut views = holder_over(&spy, 4);
    register_leaf(&mut views, "leaf");
    let invalid = Some(StoreErrorCode::InvalidRequest);
    assert_eq!(feed_refused(views.hold("nowhere", "e:1", 1.0)), invalid);
    assert_eq!(
        refused(views.set_epoch("nowhere", "e2")),
        StoreErrorCode::InvalidRequest
    );
    assert_eq!(
        refused(views.drop_view("nowhere", "e:1")),
        StoreErrorCode::InvalidRequest
    );
    for now in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(feed_refused(views.hold("leaf", "e:1", now)), invalid);
        assert_eq!(feed_refused(views.refresh(now)), invalid);
    }
    assert!(spy.take().is_empty(), "no refusal made a store call");
    views.drop_view("leaf", "e:never-held").unwrap();
    views.set_epoch("leaf", "e2").unwrap();
    assert!(
        spy.take().is_empty(),
        "drop and setEpoch make no store call"
    );
    assert_eq!(views.sizes(), ViewSizes::default());
}

#[test]
fn only_hold_is_a_use_and_the_view_a_hold_evicts_is_not_read() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:u");
    let mut writer = Writer::default();
    writer.append(
        peer.as_ref(),
        &[fact("e:a", "name", "a"), fact("e:b", "name", "b")],
    );
    let spy = Spy::new(peer.as_ref());
    let mut views = holder_over(&spy, 2);
    for name in ["pa", "pb", "pc"] {
        register_leaf(&mut views, name);
    }
    views.hold("pa", "e:a", 5.0).unwrap();
    views.hold("pb", "e:b", 5.0).unwrap();
    writer.append(peer.as_ref(), &[fact("e:a", "note", "a2")]);
    let refreshed = views.refresh(5.0).unwrap();
    assert_eq!(refreshed.reread, [ViewKey::new("pa", "e:a")]);
    assert_eq!(views.eval_count_of("pa"), 2);
    writer.append(peer.as_ref(), &[fact("e:a", "note", "a3")]);
    // `pa` was read by the refresh, and is still the least recently held: the hold of a third
    // view evicts it, and its pass does not read it though a commit touched it.
    let held = views.hold("pc", "e:c", 5.0).unwrap();
    assert_eq!(held.from, ViewFrom::New);
    assert_eq!(views.eval_count_of("pa"), 2, "the evicted view was read");
    assert_eq!(views.eval_count_of("pc"), 1);
    assert_eq!(views.sizes().views, 2);
    assert_eq!(
        views.hold("pb", "e:b", 5.0).unwrap().from,
        ViewFrom::Held,
        "pb is still held"
    );
    let back = views.hold("pa", "e:a", 5.0).unwrap();
    assert_eq!(back.from, ViewFrom::New, "an evicted view is read again");
    assert_eq!(views.eval_count_of("pa"), 3);
}

#[test]
fn forgetting_returns_every_index_to_its_size() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:f");
    let mut writer = Writer::default();
    writer.append(
        peer.as_ref(),
        &[
            fact_until("e:a", "name", "a", 1.0, Some(50.0)),
            fact("e:b", "name", "b"),
            fact_until("e:c", "name", "c", 20.0, Some(40.0)),
        ],
    );
    let spy = Spy::new(peer.as_ref());
    let mut views = holder_over(&spy, 2);
    register_leaf(&mut views, "leaf");
    views.set_epoch("leaf", "e1").unwrap();
    assert_eq!(views.sizes(), ViewSizes::default());
    views.hold("leaf", "e:a", 5.0).unwrap();
    let one = views.sizes();
    assert_eq!(views.next_boundary(), Some(50.0));
    views.hold("leaf", "e:b", 5.0).unwrap();
    // A re-read with a baseline: the baseline index and the unsettled set hold `e:b` too.
    writer.append(peer.as_ref(), &[fact("e:b", "note", "b2")]);
    views.hold("leaf", "e:b", 5.0).unwrap();
    assert!(views.sizes().baseline_entries > 0);
    assert!(views.sizes().unsettled > 0);
    views.drop_view("leaf", "e:b").unwrap();
    assert_eq!(
        views.sizes(),
        one,
        "drop leaves no entry of the dropped view"
    );
    // Eviction forgets as drop does: e:b in, e:a out (the least recently held).
    views.hold("leaf", "e:b", 5.0).unwrap();
    views.hold("leaf", "e:c", 25.0).unwrap();
    assert_eq!(views.sizes().views, 2);
    assert_eq!(
        views.next_boundary(),
        Some(40.0),
        "e:a's boundary left with it"
    );
    views.drop_view("leaf", "e:c").unwrap();
    assert_eq!(views.next_boundary(), None);
    views.drop_view("leaf", "e:b").unwrap();
    assert_eq!(
        views.sizes(),
        ViewSizes::default(),
        "nothing held, every index empty"
    );
}

/// The bytes and window of a fresh read, for comparing a held view.
fn fresh(peer: &dyn PeerStore, name: &str, root: &str, now: f64) -> String {
    let mut snapshot = peer.read().unwrap();
    let program = term(name);
    let read = read_anchored(snapshot.as_ref(), ReadRequest::new(&program, root, now)).unwrap();
    snapshot.release();
    result_canonical_hex(&read.result)
}

#[test]
fn a_store_fault_fails_the_pass_and_applies_nothing() {
    for (fault, rule) in [
        (Fault::NoProgress, "no-progress"),
        (Fault::PastTheBound, "past-the-bound"),
        (Fault::UnaskedIds, "unasked-ids"),
    ] {
        let store = MemoryStore::new();
        let peer = new_peer(&store, "peer:x");
        let mut writer = Writer::default();
        writer.append(peer.as_ref(), &[fact("e:a", "name", "a")]);
        let spy = Spy::new(peer.as_ref());
        let mut views = holder_over(&spy, 4);
        register_leaf(&mut views, "leaf");
        let before = views.hold("leaf", "e:a", 5.0).unwrap();
        views.refresh(5.0).unwrap();
        // A commit that touches the view, read by a pass over a faulty store.
        writer.append(peer.as_ref(), &[fact("e:a", "note", "touch")]);
        let sizes = views.sizes();
        spy.fault.set(Some(fault));
        spy.take();
        match views.refresh(5.0) {
            Err(FeedError::Fault(found)) => assert_eq!(found.rule(), rule),
            other => panic!("{rule}: {other:?}"),
        }
        let calls = spy.take();
        assert_eq!(
            calls.iter().filter(|c| *c == "read").count(),
            calls.iter().filter(|c| *c == "release").count(),
            "{rule}: every snapshot is released: {calls:?}"
        );
        assert!(!calls.contains(&"scope".to_string()), "{rule}: {calls:?}");
        assert_eq!(views.sizes(), sizes, "{rule}: nothing applied");
        // The next refresh over a sound store reads the touched view and reports it.
        spy.fault.set(None);
        let after = views.refresh(5.0).unwrap();
        assert_eq!(after.reread, [ViewKey::new("leaf", "e:a")], "{rule}");
        let now = fresh(peer.as_ref(), "leaf", "e:a", 5.0);
        assert_eq!(
            after.changed,
            [ViewChange {
                name: "leaf".into(),
                root: "e:a".into(),
                before: Some(before.bytes.clone()),
                after: now,
            }],
            "{rule}"
        );
    }
}

#[test]
fn a_moved_snapshot_starts_the_pass_again_at_most_four_times() {
    for at in [Moves::AtRead, Moves::AtScope] {
        let store = MemoryStore::new();
        let peer = new_peer(&store, "peer:m");
        let mut writer = Writer::default();
        writer.append(peer.as_ref(), &[fact("e:a", "name", "a")]);
        let spy = Spy::new(peer.as_ref());
        let mut views = holder_over(&spy, 4);
        register_leaf(&mut views, "leaf");
        spy.moves.set((3, at));
        let held = views.hold("leaf", "e:a", 5.0).unwrap();
        assert_eq!(held.bytes, fresh(peer.as_ref(), "leaf", "e:a", 5.0));
        let calls = spy.take();
        assert_eq!(calls.iter().filter(|c| *c == "read").count(), 4, "{at:?}");
        let counted = match at {
            Moves::AtRead => 1,
            Moves::AtScope => 4,
        };
        assert_eq!(
            views.eval_count_of("leaf"),
            counted,
            "{at:?}: the count of reads includes the reads of restarted passes"
        );
        let opened = match at {
            Moves::AtRead => 1,
            Moves::AtScope => 4,
        };
        assert_eq!(
            calls.iter().filter(|c| *c == "release").count(),
            opened,
            "{at:?}: each snapshot released: {calls:?}"
        );
        // Four moves pass `snapshot-moved` up, and nothing is applied.
        writer.append(peer.as_ref(), &[fact("e:a", "note", "a2")]);
        let sizes = views.sizes();
        spy.moves.set((4, at));
        assert_eq!(
            feed_refused(views.refresh(5.0)),
            Some(StoreErrorCode::SnapshotMoved),
            "{at:?}"
        );
        assert_eq!(views.sizes(), sizes);
        let calls = spy.take();
        assert_eq!(calls.iter().filter(|c| *c == "read").count(), 4, "{at:?}");
        assert_eq!(views.refresh(5.0).unwrap().reread.len(), 1, "{at:?}");
    }
}

#[test]
fn a_held_views_capture_stands_at_the_answers_position_and_checks_current() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:c");
    let mut writer = Writer::default();
    writer.append(peer.as_ref(), &[fact("e:a", "name", "a")]);
    let spy = Spy::new(peer.as_ref());
    let mut views = holder_over(&spy, 4);
    register_leaf(&mut views, "leaf");
    let held = views.hold("leaf", "e:a", 5.0).unwrap();
    assert_eq!(held.capture.revision(), held.position.revision);
    assert_eq!(held.capture.history(), held.position.history);
    assert_eq!(
        check_fresh(peer.as_ref(), &held.capture, 5.0).unwrap(),
        Freshness::Current
    );
    // An unrelated commit: the view is held, its capture moves to the new position.
    writer.append(peer.as_ref(), &[fact("e:z", "name", "z")]);
    let again = views.hold("leaf", "e:a", 5.0).unwrap();
    assert_eq!(again.from, ViewFrom::Held);
    assert!(again.capture.revision() > held.capture.revision());
    assert_eq!(again.capture.revision(), again.position.revision);
    assert_eq!(again.capture.members(), held.capture.members());
    assert_eq!(
        check_fresh(peer.as_ref(), &again.capture, 5.0).unwrap(),
        Freshness::Current
    );
}

/// Every place a payload could hide in the holder: its state as `Debug` writes it, which is
/// every value it keeps but the store handle. A purged delta is found by its payload, by its id
/// as a whole string, or by its own CBOR entry (`id` and the id) inside any hex it keeps.
fn keeps(views: &StoreViews<'_>, needles: &[String]) -> Vec<String> {
    let state = format!("{views:?}");
    needles
        .iter()
        .filter(|needle| state.contains(needle.as_str()))
        .cloned()
        .collect()
}

fn cbor_text(text: &str) -> String {
    let n = text.len();
    let head = match n {
        0..=23 => vec![0x60 | n as u8],
        24..=255 => vec![0x78, n as u8],
        _ => vec![0x79, (n >> 8) as u8, n as u8],
    };
    hex::encode([head, text.as_bytes().to_vec()].concat())
}

/// What a purged delta leaves behind if a holder keeps it.
fn traces(purged: &Delta, payload: Option<&str>) -> Vec<String> {
    let mut needles = vec![
        format!("{:?}", purged.id),
        format!("{}{}", cbor_text("id"), cbor_text(&purged.id)),
    ];
    if let Some(payload) = payload {
        needles.push(payload.to_string());
        needles.push(cbor_text(payload));
    }
    needles
}

#[test]
fn a_purge_leaves_the_target_and_not_the_bystander() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:e");
    let mut writer = Writer::default();
    let payload = "payload-two-sided-7f3a";
    let secret = fact("e:t", "secret", payload);
    let kept = fact("e:t", "name", "t");
    writer.append(
        peer.as_ref(),
        &[secret.clone(), kept, fact("e:b", "name", "b")],
    );
    let spy = Spy::new(peer.as_ref());
    let mut views = holder_over(&spy, 8);
    register_leaf(&mut views, "target");
    register_leaf(&mut views, "bystander");
    let first = views.hold("target", "e:t", 5.0).unwrap();
    assert!(first.bytes.contains(&cbor_text(payload)));
    let bystander = views.hold("bystander", "e:b", 5.0).unwrap();
    views.refresh(5.0).unwrap();
    peer.purge(std::slice::from_ref(&secret.id)).unwrap();
    let refreshed = views.refresh(5.0).unwrap();
    assert_eq!(refreshed.reread, [ViewKey::new("target", "e:t")]);
    let target = &refreshed.changed[0];
    assert_eq!(target.before, None, "a purge releases the baseline");
    assert_eq!(target.after, fresh(peer.as_ref(), "leaf", "e:t", 5.0));
    assert!(!target.after.contains(&cbor_text(payload)));
    assert_eq!(
        views.eval_count_of("bystander"),
        1,
        "the bystander was read"
    );
    let again = views.hold("bystander", "e:b", 5.0).unwrap();
    assert_eq!(again.from, ViewFrom::Held);
    assert_eq!(again.bytes, bystander.bytes);
    assert_eq!(
        keeps(&views, &traces(&secret, Some(payload))),
        Vec::<String>::new()
    );
}

/// The review of step 9 (SPEC-18 §4.13 reading 88): a target's baseline still carries the
/// payload when a hold of a bystander reads the purge. After that pass the holder keeps none
/// of it; the bystander is not read and keeps its bytes; the next refresh reports the target
/// with `before: None`.
#[test]
fn a_purge_read_by_a_hold_releases_the_baseline_and_keeps_no_payload() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:v");
    let mut writer = Writer::default();
    let payload = "payload-review-c41d";
    let secret = fact("e:t", "secret", payload);
    writer.append(
        peer.as_ref(),
        &[
            secret.clone(),
            fact("e:t", "name", "t"),
            fact("e:b", "name", "b"),
        ],
    );
    let spy = Spy::new(peer.as_ref());
    let mut views = holder_over(&spy, 8);
    register_leaf(&mut views, "target");
    register_leaf(&mut views, "bystander");
    views.hold("target", "e:t", 5.0).unwrap();
    let bystander = views.hold("bystander", "e:b", 5.0).unwrap();
    writer.append(peer.as_ref(), &[fact("e:t", "note", "n")]);
    let reheld = views.hold("target", "e:t", 5.0).unwrap();
    assert_eq!(reheld.from, ViewFrom::Read);
    assert!(
        !keeps(&views, &[cbor_text(payload)]).is_empty(),
        "the baseline carries the payload before the purge is read"
    );
    peer.purge(std::slice::from_ref(&secret.id)).unwrap();
    let held = views.hold("bystander", "e:b", 5.0).unwrap();
    assert_eq!(held.from, ViewFrom::Held);
    assert_eq!(held.bytes, bystander.bytes);
    assert_eq!(views.eval_count_of("bystander"), 1);
    assert_eq!(
        keeps(&views, &traces(&secret, Some(payload))),
        Vec::<String>::new()
    );
    let refreshed = views.refresh(5.0).unwrap();
    assert_eq!(
        refreshed.changed,
        [ViewChange {
            name: "target".into(),
            root: "e:t".into(),
            before: None,
            after: fresh(peer.as_ref(), "leaf", "e:t", 5.0),
        }]
    );
}

/// A failed pass after a purge (README §11.6, "Erasure"; SPEC-18 §4.13 reading 93): a refresh
/// whose pass reads the purge record and then fails in a read applies nothing, so the holder
/// still keeps the payload and every index its size. The next refresh that succeeds releases the
/// baseline and reports `before: None`. A holder that moves its position on a failed pass never
/// releases it.
#[test]
fn a_failed_pass_after_a_purge_erases_nothing_and_the_next_one_erases() {
    for quirk in [None, Some(ViewQuirk::MovesOnFailure)] {
        let store = MemoryStore::new();
        let peer = new_peer(&store, "peer:fp");
        let mut writer = Writer::default();
        let payload = "payload-failed-pass-9b1e";
        let secret = fact("e:t", "secret", payload);
        writer.append(
            peer.as_ref(),
            &[
                secret.clone(),
                fact("e:t", "name", "t"),
                fact("e:b", "name", "b"),
            ],
        );
        let spy = Spy::new(peer.as_ref());
        let mut views =
            StoreViews::with_quirk(spy.handle(), StoreViewsOptions::default(), quirk).unwrap();
        register_leaf(&mut views, "target");
        register_leaf(&mut views, "bystander");
        views.hold("target", "e:t", 5.0).unwrap();
        let bystander = views.hold("bystander", "e:b", 5.0).unwrap();
        writer.append(peer.as_ref(), &[fact("e:t", "note", "n")]);
        views.hold("target", "e:t", 5.0).unwrap();
        peer.purge(std::slice::from_ref(&secret.id)).unwrap();
        let sizes = views.sizes();
        spy.fault.set(Some(Fault::RefusesScope));
        assert_eq!(
            feed_refused(views.refresh(5.0)),
            Some(StoreErrorCode::StoreClosed)
        );
        spy.fault.set(None);
        assert!(
            !keeps(&views, &[cbor_text(payload)]).is_empty(),
            "a failed pass applies nothing"
        );
        assert_eq!(views.sizes(), sizes);
        let refreshed = views.refresh(5.0).unwrap();
        let erased = refreshed.changed
            == [ViewChange {
                name: "target".into(),
                root: "e:t".into(),
                before: None,
                after: fresh(peer.as_ref(), "leaf", "e:t", 5.0),
            }]
            && keeps(&views, &traces(&secret, Some(payload))).is_empty();
        assert_eq!(erased, quirk.is_none(), "{quirk:?}: {refreshed:?}");
        let held = views.hold("bystander", "e:b", 5.0).unwrap();
        assert_eq!((held.from, held.bytes), (ViewFrom::Held, bystander.bytes));
    }
}

/// A wrong holder that only a rail catches (README §11.6): it moves its processed position on a
/// failed pass, so the next refresh misses the touched view. It passes the document.
#[test]
fn a_holder_that_moves_on_a_failed_pass_passes_the_document_and_fails_this_rail() {
    let doc = document();
    for (label, store) in runs() {
        run(store, &doc, &holder(ViewQuirk::MovesOnFailure))
            .unwrap_or_else(|e| panic!("run {label}: {e}"));
    }
    for quirk in [None, Some(ViewQuirk::MovesOnFailure)] {
        let store = MemoryStore::new();
        let peer = new_peer(&store, "peer:w");
        let mut writer = Writer::default();
        writer.append(peer.as_ref(), &[fact("e:a", "name", "a")]);
        let spy = Spy::new(peer.as_ref());
        let mut views =
            StoreViews::with_quirk(spy.handle(), StoreViewsOptions::default(), quirk).unwrap();
        register_leaf(&mut views, "leaf");
        views.hold("leaf", "e:a", 5.0).unwrap();
        views.refresh(5.0).unwrap();
        writer.append(peer.as_ref(), &[fact("e:a", "note", "touch")]);
        spy.fault.set(Some(Fault::NoProgress));
        assert!(views.refresh(5.0).is_err());
        spy.fault.set(None);
        let after = views.refresh(5.0).unwrap();
        let now = fresh(peer.as_ref(), "leaf", "e:a", 5.0);
        let reported: Vec<&str> = after.changed.iter().map(|c| c.after.as_str()).collect();
        match quirk {
            None => assert_eq!(reported, [now.as_str()]),
            Some(_) => assert!(reported.is_empty(), "{reported:?}"),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// A fuzz against brute force (README §11.6)
// ---------------------------------------------------------------------------------------------

/// splitmix64 with a fixed seed: the same sequences on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
    fn pick<'v, T>(&mut self, items: &'v [T]) -> &'v T {
        &items[self.below(items.len())]
    }
}

/// One program of the document, as the fuzz holds it.
struct FuzzProgram {
    name: String,
    term: Term,
    pushdown: Option<Pushdown>,
}

/// The document's corpus, setup, schemas and programs, loaded once.
struct Fixture {
    by_name: BTreeMap<String, Delta>,
    /// The setup's admissions, in order: each delta with its arrival record.
    setup: Vec<Vec<VerifiedDelta>>,
    registry: Arc<SchemaRegistry>,
    programs: Vec<FuzzProgram>,
    roots: Vec<String>,
    times: Vec<f64>,
}

fn fixture() -> Fixture {
    let doc = document();
    let mut by_name = BTreeMap::new();
    for entry in doc["deltas"].as_array().unwrap() {
        let delta = make_delta(parse_claims(&entry["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, entry["id"].as_str().unwrap());
        by_name.insert(entry["name"].as_str().unwrap().to_string(), delta);
    }
    let setup = doc["setup"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["op"] == "append")
        .map(|s| {
            s["added"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    let delta = by_name[entry["delta"].as_str().unwrap()].clone();
                    let a = &entry["arrival"];
                    VerifiedDelta {
                        arrival: ArrivalRecord {
                            id: delta.id.clone(),
                            at: a["at"].as_f64().unwrap(),
                            sequence: a["sequence"].as_u64().unwrap(),
                            transfer: a["transfer"].as_u64().unwrap(),
                            sender: a["sender"].as_str().unwrap().into(),
                        },
                        delta,
                    }
                })
                .collect()
        })
        .collect();
    let registry = Arc::new(
        SchemaRegistry::build(
            doc["schemas"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| HyperSchema {
                    name: s["name"].as_str().unwrap().into(),
                    alg: s["alg"].as_u64().unwrap() as u32,
                    body: parse_term(&s["body"]).unwrap(),
                })
                .collect(),
            vec![],
        )
        .unwrap(),
    );
    let programs = doc["programs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["name"] != "aliased")
        .map(|p| FuzzProgram {
            name: p["name"].as_str().unwrap().into(),
            term: parse_term(&p["term"]).unwrap(),
            pushdown: p.get("selection").map(|s| Pushdown {
                timestamp_at_most: s["timestampAtMost"].as_f64(),
                arrival_at_most: s["arrivalAtMost"].as_u64(),
                exclude_ids: s["excludeIds"].as_array().map(|names| {
                    names
                        .iter()
                        .map(|n| by_name[n.as_str().unwrap()].id.clone())
                        .collect()
                }),
            }),
        })
        .collect();
    let mut roots: BTreeSet<String> = BTreeSet::new();
    let mut times: BTreeSet<i64> = BTreeSet::from([0, 30, 100, 1000]);
    for delta in by_name.values() {
        roots.extend(
            target_entities(&delta.claims)
                .into_iter()
                .map(str::to_string),
        );
        for bound in std::iter::once(delta.claims.valid_from).chain(delta.claims.valid_until) {
            times.extend([bound as i64 - 1, bound as i64]);
        }
    }
    Fixture {
        by_name,
        setup,
        registry,
        programs,
        roots: roots.into_iter().collect(),
        times: times.into_iter().map(|t| t as f64).collect(),
    }
}

fn passes(pushdown: Option<&Pushdown>, held: &VerifiedDelta) -> bool {
    pushdown.is_none_or(|p| {
        p.timestamp_at_most
            .is_none_or(|t| held.delta.claims.timestamp <= t)
            && p.arrival_at_most.is_none_or(|n| held.arrival.sequence <= n)
            && p.exclude_ids
                .as_ref()
                .is_none_or(|ids| !ids.contains(&held.delta.id))
    })
}

/// A view as brute force reads it over the whole holdings (`views.json`, rule 1): the bytes of
/// the term over everything the selection admits, the scope found by evaluating, the raw scope
/// with each member's arrival record, and the window of the exact scope.
#[derive(Debug, Clone, PartialEq)]
struct Brute {
    bytes: String,
    scope: Vec<String>,
    raw: BTreeMap<String, (u64, u64, u64)>,
    since: Option<f64>,
    expires_at: Option<f64>,
}

type Holdings = BTreeMap<String, VerifiedDelta>;

fn brute(fx: &Fixture, program: &FuzzProgram, root: &str, holdings: &Holdings, now: f64) -> Brute {
    let selected: Vec<VerifiedDelta> = holdings
        .values()
        .filter(|held| passes(program.pushdown.as_ref(), held))
        .cloned()
        .collect();
    let source = scope_source(&selected).unwrap();
    let ids: Vec<String> = source.ids().into_iter().map(str::to_string).collect();
    let all = source.subset(&ids);
    let (gather, resolves) = match &program.term {
        Term::Resolve { of, .. } => (of.as_ref(), true),
        t => (t, false),
    };
    let eval = |t: &Term| eval_term_at(t, &all, now, Some(root), Some(&fx.registry), None).unwrap();
    let gathered = eval(gather);
    let EvalResult::HView(view) = &gathered else {
        panic!("{}: the gather is not an HView", program.name)
    };
    let AnchorAnalysis::Anchored { anchors } =
        anchor_analysis(&program.term, Some(&fx.registry), None)
    else {
        panic!("{} is not anchored", program.name)
    };
    let mut scope: BTreeSet<String> = anchors.into_iter().collect();
    scope.insert(root.to_string());
    scope.extend(hview_anchors(view));
    let members = scope_ids(&source, scope.iter().map(String::as_str), None);
    let result = if resolves {
        eval(&program.term)
    } else {
        gathered
    };
    let window = validity_window(members.iter().filter_map(|id| source.get(id)), now);
    let everything: Vec<VerifiedDelta> = holdings.values().cloned().collect();
    let everything = scope_source(&everything).unwrap();
    let raw = scope_ids(&everything, scope.iter().map(String::as_str), None)
        .into_iter()
        .map(|id| {
            let a = &holdings[&id].arrival;
            (id, (a.sequence, a.at.to_bits(), a.transfer))
        })
        .collect();
    Brute {
        bytes: result_canonical_hex(&result),
        scope: scope.into_iter().collect(),
        raw,
        since: window.since,
        expires_at: window.expires_at,
    }
}

/// What the brute model keeps for one held view.
struct ModelView {
    read: Brute,
    epoch: String,
}

/// What a sequence exercised.
#[derive(Debug, Default)]
struct Tally {
    sequences: u64,
    holds: u64,
    refreshes: u64,
    resyncs: u64,
    rereads: u64,
    from_held: u64,
    released: u64,
    evictions: u64,
    drops: u64,
    epochs: u64,
    appends: u64,
    head_only: u64,
    re_adds: u64,
    other_peer: u64,
    purges: u64,
    purges_read: u64,
    windows_left: u64,
    selection_extra: u64,
    new_answers: u64,
    evicted_reported: u64,
    dropped_evicted: u64,
}

/// The holder and the brute model of one sequence.
struct World<'f> {
    fx: &'f Fixture,
    rng: Rng,
    store: MemoryStore,
    a: Box<dyn PeerStore>,
    b: Box<dyn PeerStore>,
    views: StoreViews<'static>,
    keep: Option<u64>,
    max_views: Option<usize>,
    /// A's holdings, and B's ids.
    holdings: Holdings,
    held_by_b: BTreeSet<String>,
    /// A's revision at creation, then after each advance; each record's removed ids.
    revisions: Vec<u64>,
    removed: Vec<BTreeSet<String>>,
    head: [usize; 2],
    sequence: u64,
    /// Ids A purged and has not held since.
    purged: BTreeMap<String, Delta>,
    epochs: BTreeMap<String, String>,
    /// The held views, oldest hold first.
    order: Vec<ViewKey>,
    model: BTreeMap<ViewKey, ModelView>,
    processed: Option<u64>,
    /// What a host that keeps the host rule alone holds (SPEC-18 §4.6, "The host rule").
    host: BTreeMap<ViewKey, String>,
    /// The model's `evicted`: what evictions forgot since the last refresh, and no hold or drop
    /// named since (§4.13 reading 92).
    evicted: BTreeSet<ViewKey>,
    now: f64,
    pool: Vec<Delta>,
    /// Brute reads over the current holdings, by view and time; cleared by every commit.
    cache: RefCell<BTreeMap<(ViewKey, u64), Brute>>,
}

impl<'f> World<'f> {
    fn brute(&self, key: &ViewKey) -> Brute {
        let at = (key.clone(), self.now.to_bits());
        if let Some(read) = self.cache.borrow().get(&at) {
            return read.clone();
        }
        let read = brute(
            self.fx,
            self.program(&key.name),
            &key.root,
            &self.holdings,
            self.now,
        );
        self.cache.borrow_mut().insert(at, read.clone());
        read
    }

    fn new(fx: &'f Fixture, seed: u64) -> Self {
        let mut rng = Rng(seed);
        let keep = (rng.chance(40)).then(|| 1 + rng.below(4) as u64);
        let page = (rng.chance(50)).then(|| 1 + rng.below(3) as u64);
        let max_views = (rng.chance(70)).then(|| 2 + rng.below(4));
        let store = MemoryStore::with_options(MemoryStoreOptions {
            change_retention: keep.map_or(ChangeRetention::Unbounded, ChangeRetention::Revisions),
            change_page_size: page,
            ..MemoryStoreOptions::default()
        })
        .unwrap();
        let a = new_peer(&store, "peer:fuzz-a");
        let b = new_peer(&store, "peer:fuzz-b");
        let mut snapshot = a.read().unwrap();
        let first = snapshot.revision().0;
        snapshot.release();
        let mut views = StoreViews::new(
            store.peer("peer:fuzz-a").unwrap(),
            StoreViewsOptions {
                max_views: max_views.unwrap_or(DEFAULT_MAX_VIEWS),
                ..StoreViewsOptions::default()
            },
        )
        .unwrap();
        let mut epochs = BTreeMap::new();
        for program in &fx.programs {
            views
                .register(
                    &program.name,
                    ViewProgram {
                        term: program.term.clone(),
                        registry: Some(fx.registry.clone()),
                        pushdown: program.pushdown.clone(),
                        admits: None,
                        epoch: String::new(),
                    },
                )
                .unwrap();
            epochs.insert(program.name.clone(), String::new());
        }
        let mut pool: Vec<Delta> = fx.by_name.values().cloned().collect();
        for k in 0..6 {
            let root = rng.pick(&fx.roots).clone();
            let at = *rng.pick(&fx.times);
            let until = rng.chance(60).then(|| at + 1.0 + rng.below(40) as f64);
            pool.push(fact_until(
                &root,
                "fuzz",
                &format!("v{seed}-{k}"),
                at,
                until,
            ));
        }
        for _ in 0..3 {
            let target = rng.pick(&pool).clone();
            let at = *rng.pick(&fx.times);
            pool.push(negation(&target, at));
        }
        let mut world = Self {
            fx,
            rng,
            store,
            a,
            b,
            views,
            keep,
            max_views,
            holdings: Holdings::new(),
            held_by_b: BTreeSet::new(),
            revisions: vec![first],
            removed: Vec::new(),
            head: [0, 0],
            sequence: 0,
            purged: BTreeMap::new(),
            epochs,
            order: Vec::new(),
            model: BTreeMap::new(),
            processed: None,
            host: BTreeMap::new(),
            evicted: BTreeSet::new(),
            now: 100.0,
            pool,
            cache: RefCell::default(),
        };
        for batch in &fx.setup {
            let deltas: Vec<Delta> = batch.iter().map(|v| v.delta.clone()).collect();
            world.sequence = batch.iter().map(|v| v.arrival.sequence).max().unwrap();
            world.commit_a(&deltas, Some(batch.clone()));
        }
        world
    }

    fn program(&self, name: &str) -> &'f FuzzProgram {
        self.fx.programs.iter().find(|p| p.name == name).unwrap()
    }

    /// Appends to A, with the setup's arrival records or new ones.
    fn commit_a(&mut self, deltas: &[Delta], given: Option<Vec<VerifiedDelta>>) {
        let added: Vec<VerifiedDelta> = given.unwrap_or_else(|| {
            deltas
                .iter()
                .map(|delta| {
                    self.sequence += 1;
                    VerifiedDelta {
                        delta: delta.clone(),
                        arrival: ArrivalRecord {
                            id: delta.id.clone(),
                            at: 2000.0 + self.sequence as f64,
                            sequence: self.sequence,
                            transfer: 9,
                            sender: "local".into(),
                        },
                    }
                })
                .collect()
        });
        let result = self
            .a
            .append(&Admission {
                expected_head: (self.head[0] > 0).then(|| format!("A-head-{}", self.head[0])),
                next_head: format!("A-head-{}", self.head[0] + 1),
                frame: None,
                added: added.clone(),
            })
            .unwrap();
        self.head[0] += 1;
        let AppendResult::Committed { revision, .. } = result else {
            panic!("{result:?}")
        };
        for entry in added {
            self.purged.remove(&entry.delta.id);
            self.holdings.entry(entry.delta.id.clone()).or_insert(entry);
        }
        self.revisions.push(revision.0);
        self.removed.push(BTreeSet::new());
        self.cache.borrow_mut().clear();
    }

    fn commit_b(&mut self, delta: &Delta) {
        self.sequence += 1;
        let added = vec![VerifiedDelta {
            delta: delta.clone(),
            arrival: ArrivalRecord {
                id: delta.id.clone(),
                at: 3000.0,
                sequence: self.sequence,
                transfer: 1,
                sender: "local".into(),
            },
        }];
        self.b
            .append(&Admission {
                expected_head: (self.head[1] > 0).then(|| format!("B-head-{}", self.head[1])),
                next_head: format!("B-head-{}", self.head[1] + 1),
                frame: None,
                added,
            })
            .unwrap();
        self.head[1] += 1;
        self.held_by_b.insert(delta.id.clone());
    }

    fn purge_a(&mut self, ids: &[String]) {
        self.a.purge(ids).unwrap();
        let mut gone = BTreeSet::new();
        for id in ids {
            if let Some(held) = self.holdings.remove(id) {
                self.purged.insert(id.clone(), held.delta);
                gone.insert(id.clone());
            }
        }
        if !gone.is_empty() {
            let mut snapshot = self.a.read().unwrap();
            self.revisions.push(snapshot.revision().0);
            snapshot.release();
            self.removed.push(gone);
            self.cache.borrow_mut().clear();
        }
    }

    fn current(&self) -> u64 {
        *self.revisions.last().unwrap()
    }

    /// The retention floor: the revision of the newest dropped record, or the first revision.
    fn floor(&self) -> u64 {
        let records = self.removed.len() as u64;
        match self.keep {
            Some(n) if records > n => self.revisions[(records - n) as usize],
            _ => self.revisions[0],
        }
    }

    /// The brute pass: whether it resyncs, and the views it must read again, by the rules of
    /// `touching` taken as raw-scope change (rule 4), the window and the epoch.
    fn due(&self) -> (bool, BTreeSet<ViewKey>) {
        let Some(q) = self.processed.filter(|_| !self.model.is_empty()) else {
            return (false, BTreeSet::new());
        };
        if q < self.floor() {
            return (true, self.model.keys().cloned().collect());
        }
        let left: BTreeSet<&String> = self
            .revisions
            .iter()
            .skip(1)
            .zip(&self.removed)
            .filter(|(r, _)| **r > q)
            .flat_map(|(_, ids)| ids)
            .collect();
        let mut due = BTreeSet::new();
        for (key, view) in &self.model {
            let raw_now = self.brute(key).raw;
            let touched =
                raw_now != view.read.raw || view.read.raw.keys().any(|id| left.contains(id));
            let outside = view.read.since.is_some_and(|s| self.now < s)
                || view.read.expires_at.is_some_and(|e| self.now >= e);
            if touched || outside || view.epoch != self.epochs[&key.name] {
                due.insert(key.clone());
            }
        }
        (false, due)
    }

    fn read_again(&mut self, key: &ViewKey) {
        let read = self.brute(key);
        let epoch = self.epochs[&key.name].clone();
        self.model.insert(key.clone(), ModelView { read, epoch });
    }

    /// No id that A purged and does not hold is in the holder as a delta's own entry, or as a
    /// whole string.
    fn no_purged_payload(&self, label: &str) {
        let state = format!("{:?}", self.views);
        for (id, delta) in &self.purged {
            for needle in traces(delta, None) {
                assert!(
                    !state.contains(&needle),
                    "{label}: the holder keeps the purged {id}"
                );
            }
        }
    }

    fn boundary(&self, label: &str) {
        let want = self
            .model
            .values()
            .filter_map(|v| v.read.expires_at)
            .min_by(f64::total_cmp);
        assert_eq!(self.views.next_boundary(), want, "{label}: nextBoundary");
    }

    fn hold(&mut self, tally: &mut Tally, label: &str) {
        let name = self.rng.pick(&self.fx.programs).name.clone();
        let root = self.rng.pick(&self.fx.roots).clone();
        let key = ViewKey::new(&name, &root);
        let (resync, due) = self.due();
        let was_held = self.model.contains_key(&key);
        let evicted = match (was_held, self.max_views) {
            (false, Some(max)) if self.model.len() >= max => self.order.first().cloned(),
            _ => None,
        };
        let count = self.views.eval_count_of(&name);
        let answer = self.views.hold(&name, &root, self.now).unwrap();
        tally.holds += 1;
        tally.resyncs += u64::from(resync);
        let fresh = self.brute(&key);
        assert_eq!(
            answer.bytes, fresh.bytes,
            "{label}: hold of {name} at {root}"
        );
        assert_eq!(answer.position.revision.0, self.current(), "{label}");
        let selects = self.program(&name).pushdown.is_some();
        let want = match (was_held, resync || due.contains(&key)) {
            (false, _) => Some(ViewFrom::New),
            _ if selects => None,
            (true, true) => Some(ViewFrom::Read),
            (true, false) => Some(ViewFrom::Held),
        };
        match want {
            Some(want) => assert_eq!(answer.from, want, "{label}: hold of {name} at {root}"),
            None => assert_ne!(answer.from, ViewFrom::New, "{label}: {name} at {root}"),
        }
        if answer.from == ViewFrom::Held {
            tally.from_held += 1;
            if !selects
                && !due
                    .iter()
                    .any(|k| k.name == name && Some(k) != evicted.as_ref())
            {
                assert_eq!(self.views.eval_count_of(&name), count, "{label}");
            }
        }
        if let Some(gone) = &evicted {
            tally.evictions += 1;
            self.model.remove(gone);
            self.order.retain(|k| k != gone);
            self.evicted.insert(gone.clone());
        }
        for k in due.iter().filter(|k| Some(*k) != evicted.as_ref()) {
            self.read_again(k);
        }
        if !was_held || resync {
            self.read_again(&key);
        }
        // The host rule: copy a `new` answer.
        if answer.from == ViewFrom::New {
            tally.new_answers += 1;
            self.host.insert(key.clone(), answer.bytes.clone());
        }
        self.evicted.remove(&key);
        self.order.retain(|k| *k != key);
        self.order.push(key);
        self.processed = Some(self.current());
        self.check_pass(tally, label);
    }

    fn refresh(&mut self, tally: &mut Tally, label: &str) {
        let (resync, due) = self.due();
        let answer = self.views.refresh(self.now).unwrap();
        tally.refreshes += 1;
        assert_eq!(answer.resynced, resync, "{label}: resynced");
        tally.resyncs += u64::from(resync);
        assert_eq!(answer.position.revision.0, self.current(), "{label}");
        let pinned: Vec<&ViewKey> = answer
            .reread
            .iter()
            .filter(|k| self.program(&k.name).pushdown.is_none())
            .collect();
        let want: Vec<&ViewKey> = due
            .iter()
            .filter(|k| self.program(&k.name).pushdown.is_none())
            .collect();
        assert_eq!(pinned, want, "{label}: reread");
        for k in due
            .iter()
            .filter(|k| self.program(&k.name).pushdown.is_some())
        {
            assert!(answer.reread.contains(k), "{label}: a selection read less");
        }
        tally.selection_extra += (answer.reread.len() - due.len()) as u64;
        tally.rereads += answer.reread.len() as u64;
        let want_evicted: Vec<ViewKey> = std::mem::take(&mut self.evicted).into_iter().collect();
        assert_eq!(answer.evicted, want_evicted, "{label}: evicted");
        tally.evicted_reported += answer.evicted.len() as u64;
        // The host rule: only `changed[].after`, and stop at `evicted`.
        for change in &answer.changed {
            tally.released += u64::from(change.before.is_none());
            let key = ViewKey::new(&change.name, &change.root);
            assert!(
                self.model.contains_key(&key),
                "{label}: a change of a view not held"
            );
            self.host.insert(key, change.after.clone());
        }
        for key in &answer.evicted {
            self.host.remove(key);
        }
        for k in &due {
            self.read_again(k);
        }
        self.processed = Some(self.current());
        let hosted: Vec<&ViewKey> = self.host.keys().collect();
        let held: Vec<&ViewKey> = self.model.keys().collect();
        assert_eq!(
            hosted, held,
            "{label}: the host holds exactly the held views"
        );
        for (key, view) in &self.model {
            assert_eq!(
                self.host.get(key),
                Some(&view.read.bytes),
                "{label}: the host's copy of {}@{}",
                key.name,
                key.root
            );
        }
        self.check_pass(tally, label);
    }

    fn check_pass(&mut self, tally: &mut Tally, label: &str) {
        for (key, view) in &self.model {
            let fresh = self.brute(key);
            if fresh.bytes != view.read.bytes {
                panic!("{label}: the model of {}@{} is stale", key.name, key.root);
            }
        }
        if !self.purged.is_empty() {
            tally.purges_read += 1;
        }
        self.no_purged_payload(label);
        self.boundary(label);
    }

    fn step(&mut self, tally: &mut Tally, label: &str) {
        match self.rng.below(100) {
            0..=29 => self.hold(tally, label),
            30..=49 => self.refresh(tally, label),
            50..=62 => {
                let delta = self.rng.pick(&self.pool).clone();
                tally.appends += 1;
                tally.re_adds += u64::from(self.purged.contains_key(&delta.id));
                self.commit_a(&[delta], None);
            }
            63..=66 => {
                tally.head_only += 1;
                self.commit_a(&[], None);
            }
            67..=69 => {
                let delta = self.rng.pick(&self.pool).clone();
                tally.other_peer += 1;
                self.commit_b(&delta);
            }
            70..=77 => {
                let held: Vec<String> = self.holdings.keys().cloned().collect();
                if !held.is_empty() {
                    let id = self.rng.pick(&held).clone();
                    tally.purges += 1;
                    self.purge_a(&[id]);
                }
            }
            78..=83 => {
                let believed: Vec<ViewKey> = self.host.keys().cloned().collect();
                if !believed.is_empty() {
                    let key = self.rng.pick(&believed).clone();
                    self.views.drop_view(&key.name, &key.root).unwrap();
                    tally.drops += 1;
                    tally.dropped_evicted += u64::from(!self.model.contains_key(&key));
                    self.order.retain(|k| *k != key);
                    self.model.remove(&key);
                    self.host.remove(&key);
                    self.evicted.remove(&key);
                    self.boundary(label);
                }
            }
            84..=89 => {
                let name = self.rng.pick(&self.fx.programs).name.clone();
                let epoch = format!("e{}", self.rng.below(3));
                self.views.set_epoch(&name, &epoch).unwrap();
                self.epochs.insert(name, epoch);
                tally.epochs += 1;
            }
            _ => {
                let before = self.now;
                self.now = *self.rng.pick(&self.fx.times);
                if self
                    .model
                    .values()
                    .any(|v| v.read.since.is_some_and(|s| self.now < s && s <= before))
                {
                    tally.windows_left += 1;
                }
            }
        }
    }
}

fn fuzz_sequence(fx: &Fixture, seed: u64, tally: &mut Tally) {
    let mut world = World::new(fx, seed);
    for at in 0..24 {
        let label = format!("seed {seed} step {at}");
        world.step(tally, &label);
    }
    tally.sequences += 1;
    assert!(world.store.peer("peer:fuzz-b").is_ok());
}

fn fuzz(sequences: u64) -> Tally {
    let fx = fixture();
    let mut tally = Tally::default();
    for seed in 0..sequences {
        fuzz_sequence(&fx, 0x5EED_0010_0000 + seed, &mut tally);
    }
    tally
}

/// Every kind of event occurred.
fn fuzz_claims(tally: &Tally) {
    for (what, count) in [
        ("holds", tally.holds),
        ("refreshes", tally.refreshes),
        ("resyncs", tally.resyncs),
        ("rereads", tally.rereads),
        ("held answers", tally.from_held),
        ("released baselines", tally.released),
        ("evictions", tally.evictions),
        ("drops", tally.drops),
        ("epochs", tally.epochs),
        ("head-only commits", tally.head_only),
        ("re-adds", tally.re_adds),
        ("another peer's commits", tally.other_peer),
        ("purges", tally.purges),
        ("passes after a purge", tally.purges_read),
        ("times below a window", tally.windows_left),
        ("new answers", tally.new_answers),
        ("evictions reported", tally.evicted_reported),
        ("drops of an evicted view", tally.dropped_evicted),
    ] {
        assert!(count > 0, "no {what}: {tally:?}");
    }
}

#[test]
fn every_pass_agrees_with_brute_force_over_random_sequences() {
    let tally = fuzz(2_000);
    println!("views fuzz, 2000 sequences: {tally:?}");
    assert_eq!(tally.sequences, 2_000);
    fuzz_claims(&tally);
}

/// The long run, by hand: `cargo test --release --test witness store_views:: -- --ignored`.
#[test]
#[ignore]
fn twenty_thousand_sequences_agree_with_brute_force() {
    let tally = fuzz(20_000);
    println!("views fuzz, 20000 sequences: {tally:?}");
    fuzz_claims(&tally);
}

// ---------------------------------------------------------------------------------------------
// The cost rails (README §11.6, as §3.9.9)
// ---------------------------------------------------------------------------------------------

/// Linear work gives a ratio of about 8 between N and 8N, work in the held views, the holdings
/// or the earlier records about 64.
const BOUND: f64 = 24.0;

fn fastest(runs: usize, enough: Duration, mut run: impl FnMut() -> Duration) -> Duration {
    let mut best = Duration::MAX;
    for _ in 0..runs {
        if best < enough {
            break;
        }
        best = best.min(run());
    }
    best
}

/// N from 256, doubling until the run at N takes 50 ms; the run at N the fastest of five, the
/// run at 8N the fastest of three, stopped at the first under the bound. `Instant` is monotonic.
fn ratio(what: &str, run: &dyn Fn(usize) -> Duration) -> (usize, f64) {
    let mut n = 256;
    let at_n = loop {
        let at_n = fastest(5, Duration::ZERO, || run(n));
        if at_n >= Duration::from_millis(50) {
            break at_n;
        }
        n *= 2;
    };
    let at_8n = fastest(3, at_n.mul_f64(BOUND), || run(8 * n));
    let ratio = at_8n.as_secs_f64() / at_n.as_secs_f64();
    println!("views, {what}: N = {n}, {at_n:?} and {at_8n:?}, ratio {ratio:.2}");
    (n, ratio)
}

/// A run is N rounds of one commit and one refresh. The commits alternate: one appends a fact at
/// the anchor of the small view, the next purges it, and each refresh reads the small view again.
/// (An append and its purge between two refreshes touch nothing: the fact is not held at the
/// pass's snapshot and was never a member.)
///
/// One built holder for a cost run: the store, the writer's peer, the holder, the small view's
/// fact, and the writer.
struct Costed {
    _store: MemoryStore,
    peer: Box<dyn PeerStore>,
    views: StoreViews<'static>,
    writer: Writer,
    touch: Delta,
}

/// `held` untouched views, `holdings` other deltas and `earlier` head-only commits before the
/// first hold, and one small view at `small`.
fn costed(held: usize, holdings: usize, earlier: usize, quirk: Option<ViewQuirk>) -> Costed {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:cost");
    let mut writer = Writer::default();
    let mut batch: Vec<Delta> = (0..held.max(holdings))
        .map(|k| fact(&format!("other:{k}"), "x", &k.to_string()))
        .collect();
    batch.push(fact("small", "name", "s"));
    writer.append(peer.as_ref(), &batch);
    for _ in 0..earlier {
        writer.append(peer.as_ref(), &[]);
    }
    let mut views = StoreViews::with_quirk(
        store.peer("peer:cost").unwrap(),
        StoreViewsOptions {
            max_views: held + 8,
            ..StoreViewsOptions::default()
        },
        quirk,
    )
    .unwrap();
    register_leaf(&mut views, "leaf");
    views.hold("leaf", "small", 5.0).unwrap();
    let others = match held {
        0 => 4,
        n => n,
    };
    for k in 0..others {
        views.hold("leaf", &format!("other:{k}"), 5.0).unwrap();
    }
    Costed {
        _store: store,
        peer,
        views,
        writer,
        touch: fact("small", "note", "t"),
    }
}

fn cost_ratio(what: &str, build: &dyn Fn(usize) -> Costed) -> Option<String> {
    let built: RefCell<BTreeMap<usize, Costed>> = RefCell::default();
    let run = |n: usize| {
        let mut built = built.borrow_mut();
        let c = built.entry(n).or_insert_with(|| build(n));
        let start = Instant::now();
        for round in 0..n {
            match round % 2 {
                0 => {
                    c.writer
                        .append(c.peer.as_ref(), std::slice::from_ref(&c.touch));
                }
                _ => {
                    c.peer.purge(std::slice::from_ref(&c.touch.id)).unwrap();
                }
            }
            let refreshed = black_box(c.views.refresh(5.0).unwrap());
            assert_eq!(refreshed.reread, [ViewKey::new("leaf", "small")]);
        }
        start.elapsed()
    };
    let (n, ratio) = ratio(what, &run);
    (ratio >= BOUND).then(|| {
        format!(
            "{what}: the run at 8N = {} took {ratio:.1} times as long as at N = {n}; linear work gives about 8",
            8 * n
        )
    })
}

fn cost_rail(what: &str, build: fn(usize) -> Costed) {
    let _timed = crate::timed::exclusive();
    let slow = crate::timed::remeasured(|| cost_ratio(what, &build));
    assert!(slow.is_none(), "{}", slow.unwrap());
}

/// Rail 1: N refreshes beside N held views that no commit touches.
#[test]
fn a_pass_costs_its_records_not_the_held_views() {
    cost_rail("beside N held views", |n| costed(n, 0, 0, None));
}

/// Rail 2: N refreshes beside N holdings, with five views.
#[test]
fn a_pass_costs_its_records_not_the_holdings() {
    cost_rail("beside N holdings", |n| costed(0, n, 0, None));
}

/// Rail 3: N refreshes after N records before the processed position.
#[test]
fn a_pass_costs_its_records_not_the_records_before_it() {
    cost_rail("after N earlier records", |n| costed(0, 0, n, None));
}

/// A holder that asks `touching` of every held view per page is right and slow: rail 1 goes
/// red. By hand: `cargo test --release --test witness store_views:: -- --ignored`.
#[test]
#[ignore]
fn a_per_view_scan_turns_the_held_views_rail_red() {
    let _timed = crate::timed::exclusive();
    let slow = cost_ratio("beside N held views, touching per view", &|n| {
        costed(n, 0, 0, Some(ViewQuirk::TouchingPerView))
    });
    assert!(slow.is_some(), "the per-view scan stayed under the bound");
}

// ---------------------------------------------------------------------------------------------
// The runner's words for a store fault (README §11.3, §11.6)
// ---------------------------------------------------------------------------------------------

/// A store whose opened handles (the holder's) page the feed with no progress; the handles
/// `createPeer` gives the runner are sound.
struct StuckWhenOpened(MemoryStore);

struct Stuck(Box<dyn PeerStore>);

impl PeerStore for Stuck {
    fn id(&self) -> &str {
        self.0.id()
    }
    fn erasure(&self) -> PeerErasure {
        self.0.erasure()
    }
    fn history(&self) -> &str {
        self.0.history()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        self.0.read()
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.0.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        self.0.purge(ids)
    }
    fn changes(&self, from: Revision, _: Option<Revision>) -> Result<ChangePage, StoreError> {
        Ok(ChangePage::Ok {
            records: Vec::new(),
            through: from,
        })
    }
}

impl Store for StuckWhenOpened {
    fn profile(&self) -> &rhizomatic::store::StoreProfile {
        self.0.profile()
    }
    fn create_peer(&self, id: &str, e: ErasurePosture) -> Result<Box<dyn PeerStore>, StoreError> {
        self.0.create_peer(id, e)
    }
    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(Box::new(Stuck(self.0.peer(id)?)))
    }
    fn open_admin(&self) -> Box<dyn rhizomatic::store::Exporter> {
        self.0.open_admin()
    }
    fn close(&self) {
        self.0.close()
    }
}

#[test]
fn a_store_fault_fails_the_case_with_the_fixed_words() {
    let error = run_views_conformance(
        &|_| Ok(Box::new(StuckWhenOpened(MemoryStore::new())) as Box<dyn Store>),
        &document(),
        &StoreViewsReader::default(),
    )
    .unwrap_err();
    let failure = error
        .failures
        .iter()
        .find(|f| f.name == "views/an-unrelated-append")
        .unwrap_or_else(|| panic!("{error}"));
    assert!(
        failure.message.starts_with("the store broke no-progress: "),
        "{}",
        failure.message
    );
}
