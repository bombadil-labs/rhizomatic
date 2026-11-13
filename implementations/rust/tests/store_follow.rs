//! `vectors/store/follow.json` (SPEC-18 proposal §4.6, "Following the feed"; `vectors/store/
//! README.md` §10) and the rails each witness adds (README §10.6).
//!
//! Named gaps, each for a reason the type system gives:
//! - "Two pulls started together run one after the other" (§4.13 reading 64): `FeedCursor::pull`
//!   takes the cursor mutably, so two pulls on one cursor cannot overlap; no test can start them
//!   together, and none is written.
//! - Check 14 of §10.3 (the guarantee) has no wrong-follower row: checks 1 to 10 imply it. It is
//!   shown live by breaking the runner's apply rule, by mutation. The bound on pulls has no row:
//!   a follower that passes check 3 cannot reach it.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::hint::black_box;
use std::rc::Rc;
use std::time::{Duration, Instant};

use rhizomatic::memory_store::{MemoryStore, MemoryStoreOptions};
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    Admission, AppendResult, ArrivalRecord, ChangePage, ChangeRecord, ChangeRetention,
    ErasurePosture, PeerErasure, PeerStore, PurgeReport, Revision, ScopeRequest, ScopeResult,
    Snapshot, Store, StoreError, StoreErrorCode, VerifiedDelta, MAX_REVISION,
};
use rhizomatic::store_conformance::{
    run_follow_conformance, FollowCaseStore, FollowReader, Follower, StoreConformanceError,
    StoreConformanceReport,
};
use rhizomatic::store_follow::{
    follow_feed, parse_position, position_of, FeedCursor, Position, Pull, StoreFollow,
};
use rhizomatic::store_read::{ReadRequest, Selection, StoreReactor};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};
use serde_json::Value;

#[path = "support/freshness_doubles.rs"]
#[allow(dead_code)]
mod doubles;
use doubles::Scaled;

fn document() -> Value {
    let path = format!(
        "{}/../../vectors/store/follow.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read follow.json")).unwrap()
}

/// How one run of README §10.4 builds its stores.
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

const KEEP_TWO: RunStore = RunStore {
    scale: 1,
    keep: Some(2),
    page: None,
};

/// README §10.4 runs 1 to 5, and revisions times 2 keeping two records.
fn runs() -> Vec<(&'static str, RunStore)> {
    let run = |scale, keep, page| RunStore { scale, keep, page };
    vec![
        ("1 default", DEFAULT),
        ("2 pages of one", run(1, None, Some(1))),
        ("3 two kept", KEEP_TWO),
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
    reader: &dyn FollowReader,
) -> Result<StoreConformanceReport, StoreConformanceError> {
    run_follow_conformance(&|case| open(store, case), doc, reader)
}

/// Every run of README §10.4 passes every case and skips nothing.
#[test]
fn every_follow_case_passes_every_run() {
    let doc = document();
    assert_eq!(doc["format"], "rhizomatic-store-follow/1");
    let cases = doc["cases"].as_array().unwrap().len();
    assert!(cases >= 16, "{cases} cases");
    for (label, store) in runs() {
        let report = run(store, &doc, &StoreFollow).unwrap_or_else(|e| panic!("run {label}: {e}"));
        assert_eq!(report.passed.len(), cases, "run {label}");
        assert!(
            report.skipped.is_empty(),
            "run {label}: {:?}",
            report.skipped
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Wrong followers (README §10.6)
// ---------------------------------------------------------------------------------------------

/// The one rule a follower written for the rails breaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wrong {
    Nothing,
    DropsRemoved,
    ArrivalOrder,
    OncePerRecord,
    TwoPages,
    MovesOnResync,
    PastThrough,
    PastSnapshot,
    SkipsHistory,
    HistoryAfterFeed,
    NoTo,
    GetForNothing,
    NoRelease,
    AsksAgain,
    MissingIsError,
    FeedPastSnapshot,
    FeedAtEqual,
    ResyncAtCursor,
    KeepsFirstArrival,
    ChangedClaims,
    OtherHistory,
    OkWithoutReading,
    Lags,
    NoBytes,
    OkForResync,
    // The follow step (§10.2).
    PositionOfOtherHistory,
    PositionOfOtherRevision,
    IgnoresPosition,
    ReadsOnFollow,
}

struct Mutant(Wrong);

/// The second cursor, written for the rails: the rule of SPEC-18 §4.6 with `wrong` broken.
struct Rail<'a> {
    peer: Box<dyn PeerStore + 'a>,
    position: Position,
    resync: Option<Position>,
    wrong: Wrong,
    /// What it delivered before, by id: `KeepsFirstArrival` serves these again.
    seen: BTreeMap<String, ArrivalRecord>,
}

fn nothing_new(position: &Position) -> Pull {
    Pull::Ok {
        position: position.clone(),
        records: Vec::new(),
        deltas: Vec::new(),
    }
}

impl Rail<'_> {
    fn one(&mut self, snapshot: &dyn Snapshot) -> Result<Pull, StoreError> {
        let w = self.wrong;
        let at = position_of(snapshot);
        let resync = Pull::ResyncRequired {
            current: match w {
                Wrong::ResyncAtCursor => self.position.clone(),
                _ => at.clone(),
            },
        };
        let from = self.position.revision;
        let other = at.history != self.position.history;
        if other && !matches!(w, Wrong::SkipsHistory | Wrong::HistoryAfterFeed) {
            return Ok(resync);
        }
        if at.revision < from && w != Wrong::FeedPastSnapshot {
            return Ok(resync);
        }
        if at.revision == from && w != Wrong::FeedAtEqual {
            return Ok(nothing_new(&self.position));
        }
        let to = (w != Wrong::NoTo).then_some(at.revision);
        let page = self.peer.changes(from, to)?;
        if other && w == Wrong::HistoryAfterFeed {
            return Ok(resync);
        }
        let (mut records, mut through) = match page {
            ChangePage::ResyncRequired { .. } if w == Wrong::OkForResync => {
                return Ok(nothing_new(&self.position))
            }
            ChangePage::ResyncRequired { .. } => return Ok(resync),
            ChangePage::Ok { records, through } => (records, through),
        };
        while w == Wrong::TwoPages && through < at.revision {
            match self.peer.changes(through, Some(at.revision))? {
                ChangePage::Ok {
                    records: more,
                    through: next,
                } => {
                    records.extend(more);
                    through = next;
                }
                ChangePage::ResyncRequired { .. } => break,
            }
        }
        let ids: Vec<String> = records
            .iter()
            .flat_map(|r| &r.added)
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut deltas: Vec<VerifiedDelta> = Vec::new();
        if !ids.is_empty() || w == Wrong::GetForNothing {
            let got = snapshot.get(&ids)?;
            let arrivals = snapshot.arrivals(&ids)?;
            if w == Wrong::MissingIsError && got.len() != ids.len() {
                panic!("the rail follower found a delta of the page missing");
            }
            deltas = got
                .into_iter()
                .zip(arrivals)
                .map(|(delta, arrival)| VerifiedDelta { delta, arrival })
                .collect();
        }
        if w == Wrong::OncePerRecord {
            let by_id: BTreeMap<String, VerifiedDelta> = deltas
                .iter()
                .map(|d| (d.delta.id.clone(), d.clone()))
                .collect();
            deltas = records
                .iter()
                .flat_map(|r| &r.added)
                .filter_map(|id| by_id.get(id).cloned())
                .collect();
        }
        if w == Wrong::ArrivalOrder {
            deltas.sort_by_key(|d| d.arrival.sequence);
        }
        if w == Wrong::KeepsFirstArrival {
            for d in &mut deltas {
                let first = self
                    .seen
                    .entry(d.delta.id.clone())
                    .or_insert(d.arrival.clone());
                d.arrival = first.clone();
            }
        }
        if w == Wrong::ChangedClaims {
            for d in &mut deltas {
                d.delta.claims.timestamp += 1.0;
            }
        }
        if w == Wrong::NoBytes {
            deltas.clear();
        }
        if w == Wrong::DropsRemoved {
            for r in &mut records {
                r.removed.clear();
            }
        }
        let revision = match w {
            Wrong::PastThrough => Revision(through.0 + 1),
            Wrong::PastSnapshot => Revision(at.revision.0 + 1),
            _ => through,
        };
        let history = match w {
            Wrong::OtherHistory => "elsewhere".to_string(),
            _ => at.history,
        };
        Ok(Pull::Ok {
            position: Position { history, revision },
            records,
            deltas,
        })
    }
}

impl Follower for Rail<'_> {
    fn position(&self) -> Position {
        self.position.clone()
    }

    fn pull(&mut self) -> Result<Pull, StoreError> {
        let w = self.wrong;
        if let Some(current) = &self.resync {
            if w != Wrong::AsksAgain {
                return Ok(Pull::ResyncRequired {
                    current: current.clone(),
                });
            }
        }
        if w == Wrong::OkWithoutReading {
            return Ok(nothing_new(&self.position));
        }
        let mut snapshot = self.peer.read()?;
        let answer = self.one(snapshot.as_ref());
        if w != Wrong::NoRelease {
            snapshot.release();
        }
        let answer = answer?;
        match &answer {
            Pull::Ok { position, .. } if w != Wrong::Lags => self.position = position.clone(),
            Pull::Ok { .. } => {}
            Pull::ResyncRequired { current } => {
                if w == Wrong::MovesOnResync {
                    self.position = current.clone();
                }
                self.resync = Some(current.clone());
            }
        }
        Ok(answer)
    }
}

impl FollowReader for Mutant {
    fn position_of(&self, snapshot: &dyn Snapshot) -> Position {
        let mut position = position_of(snapshot);
        match self.0 {
            Wrong::PositionOfOtherHistory => position.history.push_str(":other"),
            Wrong::PositionOfOtherRevision => position.revision.0 += 1,
            _ => {}
        }
        position
    }

    fn follow<'a>(
        &self,
        peer: Box<dyn PeerStore + 'a>,
        from: Position,
    ) -> Result<Box<dyn Follower + 'a>, StoreError> {
        let mut position = from;
        if matches!(self.0, Wrong::IgnoresPosition | Wrong::ReadsOnFollow) {
            let mut snapshot = peer.read()?;
            if self.0 == Wrong::IgnoresPosition {
                position = position_of(snapshot.as_ref());
            }
            snapshot.release();
        }
        Ok(Box::new(Rail {
            peer,
            position,
            resync: None,
            wrong: self.0,
            seen: BTreeMap::new(),
        }))
    }
}

/// One row: the follower, the run, the case it fails, how its message starts, and, when the
/// table names them, the only cases that catch it.
struct Row {
    wrong: Wrong,
    store: RunStore,
    case: &'static str,
    message: &'static str,
    only: &'static [&'static str],
}

const fn row(wrong: Wrong, case: &'static str, message: &'static str) -> Row {
    Row {
        wrong,
        store: DEFAULT,
        case,
        message,
        only: &[],
    }
}

const fn only(
    wrong: Wrong,
    case: &'static str,
    message: &'static str,
    only: &'static [&'static str],
) -> Row {
    Row {
        wrong,
        store: DEFAULT,
        case,
        message,
        only,
    }
}

const TABLE: &[Row] = &[
    row(
        Wrong::DropsRemoved,
        "a-purge-of-a-held-id",
        "the pull's record at revision 2 differs from its commit",
    ),
    only(
        Wrong::ArrivalOrder,
        "several-records-in-one-page",
        "the pull's deltas are not ascending by id and distinct",
        &[
            "several-records-in-one-page",
            "pages-of-one",
            "a-follower-started-mid-history",
        ],
    ),
    only(
        Wrong::OncePerRecord,
        "add-purge-add-in-one-page",
        "the pull's deltas are not ascending by id and distinct",
        &[
            "add-purge-add-in-one-page",
            "a-follower-started-mid-history",
        ],
    ),
    only(
        Wrong::TwoPages,
        "pages-of-one",
        "pull made the call changes(2, 4) where the contract asks for get [",
        &["pages-of-one"],
    ),
    only(
        Wrong::MovesOnResync,
        "retention-too-short",
        "the cursor moved after resync-required",
        &[
            "retention-too-short",
            "a-position-from-the-future",
            "another-peers-history",
            "pull-after-resync",
        ],
    ),
    row(
        Wrong::PastThrough,
        "pages-of-one",
        "the pull's records are at [2], expected [2 3]",
    ),
    row(
        Wrong::PastSnapshot,
        "one-append",
        "the pull's position 3 lies outside [1, 2]",
    ),
    only(
        Wrong::SkipsHistory,
        "another-peers-history",
        "pull answered ok, expected resync-required",
        &["another-peers-history"],
    ),
    only(
        Wrong::HistoryAfterFeed,
        "another-peers-history",
        "pull made the call changes(1, 2) where the contract asks for release",
        &["another-peers-history"],
    ),
    row(
        Wrong::NoTo,
        "one-append",
        "pull made the call changes(1, none) where the contract asks for changes(1, 2)",
    ),
    row(
        Wrong::GetForNothing,
        "a-head-only-commit",
        "pull made the call get [] where the contract asks for release",
    ),
    row(
        Wrong::NoRelease,
        "nothing-new",
        "pull made no call where the contract asks for release",
    ),
    only(
        Wrong::AsksAgain,
        "pull-after-resync",
        "pull answered ok, expected resync-required",
        &["pull-after-resync", "retention-too-short"],
    ),
    row(
        Wrong::MissingIsError,
        "add-then-purge-in-one-page",
        "the rail follower found a delta of the page missing",
    ),
    row(
        Wrong::FeedPastSnapshot,
        "a-position-from-the-future",
        "pull refused with invalid-request",
    ),
    row(
        Wrong::FeedAtEqual,
        "nothing-new",
        "pull made the call changes(1, 1) where the contract asks for release",
    ),
    row(
        Wrong::ResyncAtCursor,
        "a-position-from-the-future",
        "pull reports resync-required with current 3, expected 1",
    ),
    only(
        Wrong::KeepsFirstArrival,
        "add-purge-add-across-pulls",
        "the pull delivered ",
        &["add-purge-add-across-pulls"],
    ),
    row(Wrong::ChangedClaims, "one-append", "the pull delivered "),
    row(
        Wrong::OtherHistory,
        "one-append",
        "the pull moved the cursor to another history",
    ),
    row(
        Wrong::OkWithoutReading,
        "one-append",
        "the pull from 1 made no progress toward 2",
    ),
    row(
        Wrong::Lags,
        "one-append",
        "the cursor stands at 1, not at the pull's position 2",
    ),
    row(
        Wrong::NoBytes,
        "one-append",
        "the pull delivered [], expected [",
    ),
    row(
        Wrong::OkForResync,
        "retention-too-short",
        "pull answered ok, expected resync-required",
    ),
    Row {
        wrong: Wrong::OkForResync,
        store: KEEP_TWO,
        case: "several-records-in-one-page",
        message: "pull answered ok for a position below the retention floor 2",
        only: &[],
    },
    // The follow step (README §10.6, "The follow step and the document").
    row(
        Wrong::PositionOfOtherHistory,
        "nothing-new",
        "the position's history is not its snapshot's",
    ),
    row(
        Wrong::PositionOfOtherRevision,
        "nothing-new",
        "the position is of revision 2, expected 1",
    ),
    row(
        Wrong::IgnoresPosition,
        "a-position-from-the-future",
        "a new cursor stands at 1, not at the position it was given",
    ),
    row(
        Wrong::ReadsOnFollow,
        "nothing-new",
        "following made the call read; it makes no store call",
    ),
];

/// The tail some rows check beyond the start of the message.
fn tail(wrong: Wrong) -> Option<&'static str> {
    match wrong {
        Wrong::KeepsFirstArrival => Some(" with another arrival record"),
        Wrong::ChangedClaims => Some(" as another appearance"),
        _ => None,
    }
}

/// What is wrong with one row's run, or nothing.
fn judge(doc: &Value, row: &Row) -> Option<String> {
    let error = match run(row.store, doc, &Mutant(row.wrong)) {
        Ok(_) => return Some("passed every case".into()),
        Err(error) => error,
    };
    let name = format!("follow/{}", row.case);
    let Some(found) = error.failures.iter().find(|f| f.name == name) else {
        return Some(format!("{} did not fail: {error}", row.case));
    };
    let right = found.message.starts_with(row.message)
        && tail(row.wrong).is_none_or(|t| found.message.contains(t));
    if !right {
        return Some(format!(
            "{} failed for another reason: {}",
            row.case, found.message
        ));
    }
    let failed: BTreeSet<&str> = error
        .failures
        .iter()
        .map(|f| f.name.trim_start_matches("follow/"))
        .collect();
    let only: BTreeSet<&str> = row.only.iter().copied().collect();
    if !only.is_empty() && failed != only {
        return Some(format!("failed {failed:?}, the table names only {only:?}"));
    }
    None
}

#[test]
fn the_rail_follower_with_no_rule_broken_passes_every_run() {
    let doc = document();
    for (label, store) in runs() {
        run(store, &doc, &Mutant(Wrong::Nothing)).unwrap_or_else(|e| panic!("run {label}: {e}"));
    }
}

#[test]
fn every_wrong_follower_fails_its_case_with_its_message() {
    let doc = document();
    let red: Vec<String> = TABLE
        .iter()
        .filter_map(|row| judge(&doc, row).map(|p| format!("{:?}: {p}", row.wrong)))
        .collect();
    assert!(
        red.is_empty(),
        "{} rows did not hold:\n  {}",
        red.len(),
        red.join("\n  ")
    );
}

/// Where the table names the only cases that catch a follower, the document without them passes
/// it.
#[test]
fn without_their_only_cases_the_named_followers_pass() {
    let doc = document();
    for row in TABLE.iter().filter(|row| !row.only.is_empty()) {
        let mut without = doc.clone();
        without["cases"]
            .as_array_mut()
            .unwrap()
            .retain(|c| !row.only.contains(&c["name"].as_str().unwrap()));
        if let Err(e) = run(row.store, &without, &Mutant(row.wrong)) {
            panic!("{:?} fails without its cases: {e}", row.wrong);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Defective documents (README §10.6)
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
    let error = run(DEFAULT, doc, &StoreFollow).expect_err("a defective document fails");
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
fn a_defective_document_fails_with_its_message() {
    let doc = document();
    let edit = |f: &dyn Fn(&mut Value)| {
        let mut d = doc.clone();
        f(&mut d);
        d
    };
    // Records the pulls do not read.
    fails_with(
        &edit(&|d| nth(d, "one-append", "pull", 0)["expect"]["records"] = serde_json::json!([])),
        "follow/one-append",
        "the pulls read the records at [2], expected []",
    );
    // Deltas they do not deliver.
    fails_with(
        &edit(&|d| nth(d, "one-append", "pull", 0)["expect"]["delivered"] = serde_json::json!([])),
        "follow/one-append",
        "the pulls delivered [",
    );
    // Another count of pulls.
    fails_with(
        &edit(&|d| nth(d, "pages-of-one", "pull", 0)["expect"]["pulls"] = 2.into()),
        "follow/pages-of-one",
        "the follower took 3 pulls, expected 2",
    );
    // A position the peer is not at.
    fails_with(
        &edit(&|d| nth(d, "one-append", "pull", 0)["expect"]["position"] = "A.1".into()),
        "follow/one-append",
        "the vector pulls to A.1, and the peer is at 2",
    );
    // A resync `current` the peer is not at.
    fails_with(
        &edit(&|d| nth(d, "retention-too-short", "pull", 0)["expect"]["current"] = "A.2".into()),
        "follow/retention-too-short",
        "the vector expects current A.2, and the peer is at 3",
    );
    // A follower named twice.
    fails_with(
        &edit(&|d| {
            let follow = nth(d, "one-append", "follow", 0).clone();
            steps_of(d, "one-append").insert(4, follow);
        }),
        "follow/one-append",
        "the vector names follower f twice",
    );
    // A follower used before it follows.
    fails_with(
        &edit(&|d| nth(d, "one-append", "pull", 0)["follower"] = "g".into()),
        "follow/one-append",
        "the vector uses follower g before following",
    );
    // A negative `ahead`.
    fails_with(
        &edit(&|d| nth(d, "a-position-from-the-future", "follow", 0)["ahead"] = (-1).into()),
        "follow/a-position-from-the-future",
        "the vector's ahead is not a whole number",
    );
    // Another format.
    fails_with(
        &edit(&|d| d["format"] = "rhizomatic-store-follow/2".into()),
        "follow",
        "unknown store follow format",
    );
}

// ---------------------------------------------------------------------------------------------
// The cursor's own rules (README §10.6)
// ---------------------------------------------------------------------------------------------

fn fact(entity: &str, context: &str, value: f64) -> Delta {
    make_delta(
        Claims {
            timestamp: value,
            valid_from: value,
            valid_until: None,
            author: "did:key:zFollow".into(),
            pointers: vec![
                Pointer {
                    role: "subject".into(),
                    target: Target::Entity(EntityRef {
                        id: entity.into(),
                        context: Some(context.into()),
                    }),
                },
                Pointer {
                    role: "value".into(),
                    target: Target::Primitive(Primitive::Num(value)),
                },
            ],
        },
        None,
    )
    .unwrap()
}

/// Appends batches to one peer, moving its head on each time; sequences continue from the last.
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

fn here(peer: &dyn PeerStore) -> Position {
    let mut snapshot = peer.read().unwrap();
    let position = position_of(snapshot.as_ref());
    snapshot.release();
    position
}

fn new_peer(store: &MemoryStore, name: &str) -> Box<dyn PeerStore> {
    store.create_peer(name, ErasurePosture::Unproven).unwrap()
}

/// A peer handle that names every call through it and its snapshots. It can commit during
/// `changes`, answer `changes` itself, drop an arrival record, or close the store.
struct Probe<'a> {
    inner: &'a dyn PeerStore,
    calls: Rc<RefCell<Vec<String>>>,
    /// Commits during `changes`, one batch per call, while any remain.
    moves: RefCell<Vec<Vec<Delta>>>,
    writer: RefCell<Writer>,
    /// Answers `changes` with this instead of asking the store.
    page: Option<fn(Revision, Option<Revision>) -> ChangePage>,
    /// Drops the first record from `arrivals`.
    short_arrivals: bool,
    /// Closes this store when `changes` is called.
    closes: Option<&'a MemoryStore>,
}

impl<'a> Probe<'a> {
    fn new(inner: &'a dyn PeerStore) -> Self {
        Self {
            inner,
            calls: Rc::default(),
            moves: RefCell::default(),
            writer: RefCell::default(),
            page: None,
            short_arrivals: false,
            closes: None,
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }

    fn log(&self, call: &str) {
        self.calls.borrow_mut().push(call.to_string());
    }
}

impl PeerStore for Probe<'_> {
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
        Ok(Box::new(ProbeSnapshot {
            inner: self.inner.read()?,
            calls: self.calls.clone(),
            short_arrivals: self.short_arrivals,
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
        if let Some(store) = self.closes {
            store.close();
        }
        let page = match self.page {
            Some(page) => Ok(page(from, to)),
            None => self.inner.changes(from, to),
        };
        let next = self.moves.borrow_mut().pop();
        if let Some(deltas) = next {
            self.writer.borrow_mut().append(self.inner, &deltas);
        }
        page
    }
}

struct ProbeSnapshot {
    inner: Box<dyn Snapshot>,
    calls: Rc<RefCell<Vec<String>>>,
    short_arrivals: bool,
}

impl ProbeSnapshot {
    fn log(&self, call: &str) {
        self.calls.borrow_mut().push(call.to_string());
    }
}

impl Snapshot for ProbeSnapshot {
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
        self.inner.get(ids)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        self.log("arrivals");
        let mut records = self.inner.arrivals(ids)?;
        if self.short_arrivals && !records.is_empty() {
            records.remove(0);
        }
        Ok(records)
    }
    fn targets(&self, e: &[String]) -> Result<Vec<String>, StoreError> {
        self.log("targets");
        self.inner.targets(e)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.log("negators");
        self.inner.negators(ids)
    }
    fn scope(&self, r: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        self.log("scope");
        self.inner.scope(r)
    }
    fn release(&mut self) {
        self.log("release");
        self.inner.release()
    }
}

#[test]
fn a_malformed_position_is_refused_with_no_store_call() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:p");
    let probe = Probe::new(peer.as_ref());
    for bad in [
        Position {
            history: String::new(),
            revision: Revision(0),
        },
        Position {
            history: peer.history().to_string(),
            revision: Revision(MAX_REVISION + 1),
        },
    ] {
        let refused = follow_feed(&probe, bad.clone()).unwrap_err();
        assert_eq!(refused.code, StoreErrorCode::InvalidRequest, "{bad:?}");
    }
    // A good position, a local history included, makes a cursor with no store call.
    let start = here(peer.as_ref());
    assert!(start.history.starts_with("memory:local:"));
    let cursor = follow_feed(&probe, start.clone()).unwrap();
    assert_eq!(cursor.position(), &start);
    assert_eq!(probe.calls(), Vec::<String>::new());
}

#[test]
fn parse_position_checks_its_shape_and_refuses_a_local_history() {
    let good = serde_json::json!({"history": "host:7", "revision": 3});
    let parsed = parse_position(&good).unwrap();
    assert_eq!(
        parsed,
        Position {
            history: "host:7".into(),
            revision: Revision(3)
        }
    );
    assert_eq!(parse_position(&parsed.to_json()).unwrap(), parsed);
    let whole: Value = serde_json::from_str(r#"{"history": "host:7", "revision": 3.0}"#).unwrap();
    assert_eq!(parse_position(&whole).unwrap().revision, Revision(3));
    let refused = |value: Value| parse_position(&value).unwrap_err();
    let local = refused(serde_json::json!({"history": "memory:local:4", "revision": 3}));
    assert_eq!(local.code, StoreErrorCode::InvalidRequest);
    assert!(local.message.contains("mintHistory"), "{}", local.message);
    for value in [
        serde_json::json!({"history": "host:7", "revision": 1.5}),
        serde_json::json!({"history": "", "revision": 3}),
        serde_json::json!({"history": "host:7", "revision": 3, "extra": 1}),
        serde_json::json!({"history": "host:7"}),
        serde_json::json!({"revision": 3}),
        serde_json::json!({"history": 7, "revision": 3}),
        serde_json::json!({"history": "host:7", "revision": -1}),
        serde_json::json!({"history": "host:7", "revision": "3"}),
        serde_json::json!({"history": "host:7", "revision": 9007199254740992u64}),
        serde_json::json!(["host:7", 3]),
        Value::Null,
    ] {
        assert_eq!(
            parse_position(&value).unwrap_err().code,
            StoreErrorCode::InvalidRequest,
            "{value}"
        );
    }
    // The first defect in the order keys, history, revision decides the reason.
    let two = refused(serde_json::json!({"history": "", "revision": 1.5}));
    assert!(two.message.contains("history is empty"), "{}", two.message);
    let two = refused(serde_json::json!({"history": "memory:local:1", "revision": 1.5}));
    assert!(two.message.contains("local"), "{}", two.message);
    let two = refused(serde_json::json!({"history": "", "revision": 1, "x": 0}));
    assert!(two.message.contains("exactly"), "{}", two.message);
}

#[test]
fn resync_required_is_final_with_no_store_call_also_after_commits() {
    let store = MemoryStore::with_options(MemoryStoreOptions {
        change_retention: ChangeRetention::Revisions(1),
        ..MemoryStoreOptions::default()
    })
    .unwrap();
    let peer = new_peer(&store, "peer:r");
    let mut writer = Writer::default();
    writer.append(peer.as_ref(), &[fact("plant:a", "n", 1.0)]);
    let start = here(peer.as_ref());
    writer.append(peer.as_ref(), &[fact("plant:a", "n", 2.0)]);
    writer.append(peer.as_ref(), &[fact("plant:a", "n", 3.0)]);
    let probe = Probe::new(peer.as_ref());
    let mut cursor = follow_feed(&probe, start.clone()).unwrap();
    let first = cursor.pull().unwrap();
    assert_eq!(
        first,
        Pull::ResyncRequired {
            current: here(peer.as_ref())
        }
    );
    assert_eq!(cursor.position(), &start);
    let before = probe.calls().len();
    writer.append(peer.as_ref(), &[fact("plant:a", "n", 4.0)]);
    writer.append(peer.as_ref(), &[fact("plant:a", "n", 5.0)]);
    assert_eq!(cursor.pull().unwrap(), first);
    assert_eq!(probe.calls().len(), before, "a store call after resync");
    assert_eq!(cursor.position(), &start);
}

#[test]
fn resync_current_is_the_snapshots_position_whatever_the_store_names() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:c");
    let mut writer = Writer::default();
    let start = here(peer.as_ref());
    writer.append(peer.as_ref(), &[fact("plant:a", "n", 1.0)]);
    let mut probe = Probe::new(peer.as_ref());
    probe.page = Some(|_, _| ChangePage::ResyncRequired {
        current: Revision(99),
    });
    let mut cursor = follow_feed(&probe, start).unwrap();
    assert_eq!(
        cursor.pull().unwrap(),
        Pull::ResyncRequired {
            current: here(peer.as_ref())
        }
    );
}

#[test]
fn a_moved_snapshot_starts_the_pull_again_at_most_four_times() {
    let pull = |moves: usize| {
        let store = MemoryStore::new();
        let peer = new_peer(&store, "peer:m");
        let mut writer = Writer::default();
        writer.append(peer.as_ref(), &[fact("plant:a", "n", 1.0)]);
        let start = here(peer.as_ref());
        writer.append(peer.as_ref(), &[fact("plant:b", "n", 2.0)]);
        let probe = Probe::new(peer.as_ref());
        *probe.writer.borrow_mut() = writer;
        *probe.moves.borrow_mut() = (0..moves)
            .map(|k| vec![fact("plant:z", "n", 10.0 + k as f64)])
            .collect();
        let mut cursor = follow_feed(&probe, start.clone()).unwrap();
        let answer = cursor.pull();
        let stands = cursor.position().clone();
        drop(cursor);
        (answer, probe.calls(), start, stands, here(peer.as_ref()))
    };
    // One move: read, changes, get (moved), release; then the whole pull again.
    let (answer, calls, _, stands, end) = pull(1);
    let Pull::Ok {
        position, deltas, ..
    } = answer.unwrap()
    else {
        panic!("a moved pull answers on its next snapshot");
    };
    assert_eq!((&position, &stands), (&end, &end));
    assert_eq!(deltas.len(), 2);
    assert_eq!(
        calls,
        ["read", "changes", "get", "release", "read", "changes", "get", "arrivals", "release"]
    );
    // Four moves: the fourth snapshot moves too; snapshot-moved passes up, every snapshot is
    // released, and the cursor stays.
    let (answer, calls, start, stands, _) = pull(4);
    assert_eq!(answer.unwrap_err().code, StoreErrorCode::SnapshotMoved);
    let count = |name: &str| calls.iter().filter(|c| *c == name).count();
    assert_eq!((count("read"), count("release")), (4, 4));
    assert_eq!(stands, start);
    // Three moves: the fourth snapshot answers.
    let (answer, calls, _, _, _) = pull(3);
    assert!(matches!(answer.unwrap(), Pull::Ok { .. }));
    assert_eq!(calls.iter().filter(|c| *c == "read").count(), 4);
}

/// A pull that panics with this store fault, its snapshot released and its cursor unmoved.
fn faults(probe: &Probe<'_>, start: Position, words: &str) {
    let mut cursor = follow_feed(probe, start.clone()).unwrap();
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cursor.pull()));
    let message = match failed {
        Ok(answer) => panic!("a store fault answered {answer:?}"),
        Err(payload) => payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default(),
    };
    assert!(message.contains(words), "{message}");
    assert_eq!(cursor.position(), &start);
    let calls = probe.calls();
    let count = |name: &str| calls.iter().filter(|c| *c == name).count();
    assert_eq!((count("read"), count("release")), (1, 1), "{calls:?}");
}

#[test]
fn a_store_fault_fails_the_pull_and_is_no_answer() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:f");
    let mut writer = Writer::default();
    let start = here(peer.as_ref());
    writer.append(peer.as_ref(), &[fact("plant:a", "n", 1.0)]);
    writer.append(peer.as_ref(), &[fact("plant:b", "n", 2.0)]);

    let mut stuck = Probe::new(peer.as_ref());
    stuck.page = Some(|from, _| ChangePage::Ok {
        records: Vec::new(),
        through: from,
    });
    faults(&stuck, start.clone(), "made no progress");

    let mut past = Probe::new(peer.as_ref());
    past.page = Some(|_, to| ChangePage::Ok {
        records: Vec::new(),
        through: Revision(to.unwrap().0 + 5),
    });
    faults(&past, start.clone(), "past the snapshot");

    let mut short = Probe::new(peer.as_ref());
    short.short_arrivals = true;
    faults(&short, start, "get and arrivals");
}

#[test]
fn a_refusal_after_the_read_releases_the_snapshot_and_leaves_the_cursor() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:x");
    let mut writer = Writer::default();
    let start = here(peer.as_ref());
    writer.append(peer.as_ref(), &[fact("plant:a", "n", 1.0)]);
    let mut probe = Probe::new(peer.as_ref());
    probe.closes = Some(&store);
    let mut cursor = follow_feed(&probe, start.clone()).unwrap();
    assert_eq!(cursor.pull().unwrap_err().code, StoreErrorCode::StoreClosed);
    assert_eq!(cursor.position(), &start);
    assert_eq!(probe.calls(), ["read", "changes", "release"]);
}

#[test]
fn a_purge_whose_bytes_another_peer_holds_delivers_no_bytes() {
    let store = MemoryStore::new();
    let (a, b) = (new_peer(&store, "peer:a"), new_peer(&store, "peer:b"));
    let shared = fact("plant:a", "n", 1.0);
    let (mut wa, mut wb) = (Writer::default(), Writer::default());
    let start = here(a.as_ref());
    wa.append(a.as_ref(), std::slice::from_ref(&shared));
    wb.append(b.as_ref(), std::slice::from_ref(&shared));
    a.purge(std::slice::from_ref(&shared.id)).unwrap();
    let mut cursor = follow_feed(a.as_ref(), start).unwrap();
    let Pull::Ok {
        records, deltas, ..
    } = cursor.pull().unwrap()
    else {
        panic!("ok");
    };
    assert_eq!(records.len(), 2);
    assert_eq!(records[1].removed, std::slice::from_ref(&shared.id));
    assert!(deltas.is_empty(), "{deltas:?}");
}

#[test]
fn a_read_and_a_fetched_scope_carry_their_position_and_a_reactor_follows_from_it() {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:r");
    let mut writer = Writer::default();
    writer.append(peer.as_ref(), &[fact("plant:a", "name", 1.0)]);
    let reactor = StoreReactor::open(store.peer("peer:r").unwrap());
    let fetched = reactor
        .fetch(&["plant:a".to_string()], Selection::default())
        .unwrap();
    assert_eq!(fetched.position, here(peer.as_ref()));
    let term = parse_term(&serde_json::json!({
        "op": "group", "key": "byTargetContext",
        "in": {"op": "select", "pred": {"hasPointer": {"targetEntity": {"var": "root"}}},
               "in": {"op": "mask", "policy": "drop", "in": "input"}}
    }))
    .unwrap();
    let read = reactor
        .read(ReadRequest::new(&term, "plant:a", 100.0))
        .unwrap();
    assert_eq!(read.position, here(peer.as_ref()));
    assert_eq!(read.position.revision, read.revision);

    let mut cursor = reactor.follow(read.position.clone()).unwrap();
    let later = fact("plant:a", "name", 2.0);
    writer.append(peer.as_ref(), std::slice::from_ref(&later));
    let Pull::Ok {
        position, deltas, ..
    } = cursor.pull().unwrap()
    else {
        panic!("ok");
    };
    assert_eq!(position, here(peer.as_ref()));
    assert_eq!(deltas.len(), 1);
    assert_eq!(deltas[0].delta.id, later.id);
    let refused = reactor
        .follow(Position {
            history: String::new(),
            revision: Revision(0),
        })
        .unwrap_err();
    assert_eq!(refused.code, StoreErrorCode::InvalidRequest);
}

// ---------------------------------------------------------------------------------------------
// A fuzz against brute force (README §10.6)
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
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

type Holdings = BTreeMap<String, VerifiedDelta>;

/// The brute model of one peer: the holdings after every revision, and every record, also the
/// ones a bounded store dropped. Revisions advance by one (SPEC-18 §4.13 reading 16).
struct PeerModel {
    history: String,
    revisions: Vec<Revision>,
    holdings: Vec<Holdings>,
    records: Vec<ChangeRecord>,
    head: Option<String>,
    writer: Writer,
}

impl PeerModel {
    fn current(&self) -> Revision {
        *self.revisions.last().unwrap()
    }
    fn held(&self) -> &Holdings {
        self.holdings.last().unwrap()
    }
    fn at(&self, revision: Revision) -> &Holdings {
        &self.holdings[self.revisions.binary_search(&revision).unwrap()]
    }
    /// The revision of the newest dropped record, or the first revision.
    fn floor(&self, keep: Option<u64>) -> Revision {
        let dropped = keep.map_or(0, |n| self.records.len().saturating_sub(n as usize));
        self.revisions[dropped]
    }
    fn commit(&mut self, revision: Revision, held: Holdings, record: ChangeRecord) {
        assert_eq!(
            revision,
            Revision(self.current().0 + 1),
            "the store's revision"
        );
        self.revisions.push(revision);
        self.holdings.push(held);
        self.records.push(record);
    }
}

/// A follower the fuzz drives, its mirror, and two other mirrors beside it.
struct Fuzzer<'a> {
    cursor: FeedCursor<'a>,
    mirror: Holdings,
    /// Ignores `removed`.
    ignores_removed: Holdings,
    /// Applies all removals of a page before all its deltas.
    removals_first: Holdings,
    resyncs: usize,
}

#[derive(Default, Debug)]
struct Tally {
    pulls: usize,
    resyncs: usize,
    quiet: usize,
    delivered: usize,
    absent: usize,
    ignores_removed_missed: usize,
    removals_first_missed: usize,
}

/// A follower that starts from a full read: the model's holdings at the snapshot's position.
fn start<'a>(peer: &'a dyn PeerStore, model: &PeerModel) -> Fuzzer<'a> {
    let position = here(peer);
    assert_eq!(position.revision, model.current());
    let mirror = model.held().clone();
    Fuzzer {
        cursor: follow_feed(peer, position).unwrap(),
        ignores_removed: mirror.clone(),
        removals_first: mirror.clone(),
        mirror,
        resyncs: 0,
    }
}

fn same_holdings(a: &Holdings, b: &Holdings) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|((i, x), (j, y))| i == j && x.arrival == y.arrival && x.delta == y.delta)
}

/// One pull of a follower, judged against the brute model, then the mirror checks.
fn fuzz_pull<'a>(
    f: &mut Fuzzer<'a>,
    peer: &'a dyn PeerStore,
    model: &PeerModel,
    (keep, page): (Option<u64>, Option<u64>),
    tally: &mut Tally,
) {
    tally.pulls += 1;
    let before = f.cursor.position().clone();
    let now = model.current();
    let answer = f.cursor.pull().unwrap();
    let at = Position {
        history: model.history.clone(),
        revision: now,
    };
    let below = now > before.revision && before.revision < model.floor(keep);
    if f.resyncs > 0 || below {
        // `resync-required` exactly below the floor, and after it.
        let want = match f.resyncs {
            0 => at,
            _ => match &answer {
                Pull::ResyncRequired { current } => current.clone(),
                _ => panic!("ok after resync-required"),
            },
        };
        assert_eq!(
            answer,
            Pull::ResyncRequired { current: want },
            "from {before:?}"
        );
        assert_eq!(f.cursor.position(), &before);
        tally.resyncs += 1;
        f.resyncs += 1;
        if f.resyncs == 2 {
            *f = start(peer, model);
        }
        return;
    }
    let Pull::Ok {
        position,
        records,
        deltas,
    } = answer
    else {
        panic!("ok expected from {before:?} at {now:?}: {answer:?}");
    };
    // The records: the next page of the model's feed.
    let pending: Vec<&ChangeRecord> = model
        .records
        .iter()
        .filter(|r| r.revision > before.revision)
        .collect();
    let take = page.map_or(pending.len(), |n| (n as usize).min(pending.len()));
    let want: Vec<ChangeRecord> = pending[..take].iter().map(|r| (*r).clone()).collect();
    let through = match take == pending.len() {
        true => now,
        false => want.last().unwrap().revision,
    };
    assert_eq!(records, want);
    let p = through;
    assert_eq!(
        position,
        Position {
            history: model.history.clone(),
            revision: p
        }
    );
    assert_eq!(f.cursor.position(), &position);
    // The deltas: the added ids held now, ascending, with their arrival records now.
    let held = model.held();
    let added: BTreeSet<&String> = want.iter().flat_map(|r| &r.added).collect();
    let expected: Vec<&VerifiedDelta> = added.iter().filter_map(|id| held.get(*id)).collect();
    assert_eq!(deltas.iter().collect::<Vec<_>>(), expected);
    tally.delivered += deltas.len();
    tally.absent += added.len() - deltas.len();
    // Apply by the rule, and the two variants.
    let by_id: BTreeMap<&str, &VerifiedDelta> =
        deltas.iter().map(|d| (d.delta.id.as_str(), d)).collect();
    for r in &records {
        for id in &r.removed {
            f.mirror.remove(id);
            f.removals_first.remove(id);
        }
        for id in &r.added {
            if let Some(d) = by_id.get(id.as_str()) {
                f.mirror.insert(id.clone(), (*d).clone());
                f.ignores_removed.insert(id.clone(), (*d).clone());
            }
        }
    }
    for d in &deltas {
        f.removals_first.insert(d.delta.id.clone(), d.clone());
    }
    // After a pull to p, the mirror is the holdings at p for every id no later record names.
    let later: BTreeSet<&String> = model
        .records
        .iter()
        .filter(|r| r.revision > p)
        .flat_map(|r| r.added.iter().chain(&r.removed))
        .collect();
    let at_p = model.at(p);
    for id in at_p.keys().chain(f.mirror.keys()) {
        if later.contains(id) {
            continue;
        }
        let (m, h) = (f.mirror.get(id), at_p.get(id));
        assert_eq!(
            m, h,
            "the mirror and the holdings at {p:?} disagree on {id}"
        );
    }
    if p == now {
        tally.quiet += 1;
        assert!(
            same_holdings(&f.mirror, held),
            "the mirror at a quiet point"
        );
        tally.ignores_removed_missed += usize::from(!same_holdings(&f.ignores_removed, held));
        tally.removals_first_missed += usize::from(!same_holdings(&f.removals_first, held));
    }
}

fn arrival(delta: &Delta, sequence: u64) -> VerifiedDelta {
    VerifiedDelta {
        delta: delta.clone(),
        arrival: ArrivalRecord {
            id: delta.id.clone(),
            at: sequence as f64,
            sequence,
            transfer: 1,
            sender: "local".into(),
        },
    }
}

/// One sequence: a store kept whole or keeping one to four records, with whole pages or pages of
/// one to three records; two peers that share a corpus; random appends, head-only commits and
/// purges on both, interleaved with single pulls of several followers.
fn fuzz_sequence(seed: u64, tally: &mut Tally) {
    let mut rng = Rng(seed);
    let keep = match rng.below(5) {
        0 => None,
        n => Some(n),
    };
    let page = match rng.below(4) {
        0 => None,
        n => Some(n),
    };
    let store = MemoryStore::with_options(MemoryStoreOptions {
        change_retention: keep.map_or(ChangeRetention::Unbounded, ChangeRetention::Revisions),
        change_page_size: page,
        ..MemoryStoreOptions::default()
    })
    .unwrap();
    let corpus: Vec<Delta> = (0..8)
        .map(|k| fact(&format!("e:{}", k % 3), "c", k as f64))
        .collect();
    let peers: Vec<Box<dyn PeerStore>> =
        vec![new_peer(&store, "peer:A"), new_peer(&store, "peer:B")];
    let mut models: Vec<PeerModel> = peers
        .iter()
        .map(|peer| PeerModel {
            history: peer.history().to_string(),
            revisions: vec![here(peer.as_ref()).revision],
            holdings: vec![Holdings::new()],
            records: Vec::new(),
            head: None,
            writer: Writer::default(),
        })
        .collect();
    let mut followers: Vec<(usize, Fuzzer<'_>)> = vec![(0, start(peers[0].as_ref(), &models[0]))];
    let steps = 8 + rng.below(24);
    for _ in 0..steps {
        let p = rng.below(2) as usize;
        match rng.below(10) {
            // An append of up to three corpus deltas: a head-only commit when it adds nothing.
            0..=3 => {
                let n = rng.below(4);
                let batch: Vec<Delta> = (0..n)
                    .map(|_| corpus[rng.below(8) as usize].clone())
                    .collect();
                let model = &mut models[p];
                let first = model.writer.last + 1;
                let revision = model.writer.append(peers[p].as_ref(), &batch);
                let mut held = model.held().clone();
                let mut added = BTreeSet::new();
                for (k, delta) in batch.iter().enumerate() {
                    if !held.contains_key(&delta.id) {
                        held.insert(delta.id.clone(), arrival(delta, first + k as u64));
                        added.insert(delta.id.clone());
                    }
                }
                model.head = Some(format!("head-{}", model.writer.head));
                let record = ChangeRecord {
                    revision,
                    head: model.head.clone(),
                    added: added.into_iter().collect(),
                    removed: Vec::new(),
                };
                model.commit(revision, held, record);
            }
            // A purge of one or two corpus ids, held or not; a debt across peers included.
            4..=5 => {
                let ids: Vec<String> = (0..1 + rng.below(2))
                    .map(|_| corpus[rng.below(8) as usize].id.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                let report = peers[p].purge(&ids).unwrap();
                let model = &mut models[p];
                let removed: Vec<String> = ids
                    .into_iter()
                    .filter(|id| model.held().contains_key(id))
                    .collect();
                if removed.is_empty() {
                    assert_eq!(report.revision, model.current());
                    continue;
                }
                let mut held = model.held().clone();
                for id in &removed {
                    held.remove(id);
                }
                let record = ChangeRecord {
                    revision: report.revision,
                    head: model.head.clone(),
                    added: Vec::new(),
                    removed,
                };
                model.commit(report.revision, held, record);
            }
            // Another follower, from a full read.
            6 if followers.len() < 4 => {
                followers.push((p, start(peers[p].as_ref(), &models[p])));
            }
            // A single pull of one follower, between commits.
            _ => {
                let k = rng.below(followers.len() as u64) as usize;
                let (q, f) = &mut followers[k];
                fuzz_pull(f, peers[*q].as_ref(), &models[*q], (keep, page), tally);
            }
        }
    }
    // Every follower pulls until it stands at its peer's revision: a quiet point each.
    for (q, f) in &mut followers {
        let model = &models[*q];
        for _ in 0..model.records.len() + 4 {
            fuzz_pull(f, peers[*q].as_ref(), model, (keep, page), tally);
            if f.resyncs == 0 && f.cursor.position().revision == model.current() {
                break;
            }
        }
        assert_eq!(f.cursor.position().revision, model.current());
    }
}

fn fuzz(sequences: u64) -> Tally {
    let mut tally = Tally::default();
    for seed in 0..sequences {
        fuzz_sequence(0x5EED_F011_0000 + seed, &mut tally);
    }
    tally
}

#[test]
fn every_pull_agrees_with_brute_force_over_random_sequences() {
    let tally = fuzz(2_000);
    println!("follow fuzz, 2000 sequences: {tally:?}");
    assert!(tally.quiet >= 2_000 && tally.resyncs > 100, "{tally:?}");
    assert!(tally.delivered > 1_000 && tally.absent > 100, "{tally:?}");
    // A mirror that ignores `removed` misses the holdings; one that applies a page's removals
    // before its deltas does not (SPEC-18 §4.13 reading 58).
    assert!(tally.ignores_removed_missed > 0, "{tally:?}");
    assert_eq!(tally.removals_first_missed, 0, "{tally:?}");
}

/// The long run, by hand: `cargo test --release --test store_follow -- --ignored`.
#[test]
#[ignore]
fn twenty_thousand_sequences_agree_with_brute_force() {
    let tally = fuzz(20_000);
    println!("follow fuzz, 20000 sequences: {tally:?}");
    assert!(tally.ignores_removed_missed > 0, "{tally:?}");
    assert_eq!(tally.removals_first_missed, 0, "{tally:?}");
}

// ---------------------------------------------------------------------------------------------
// The cost rails (README §10.6, as §3.9.9)
// ---------------------------------------------------------------------------------------------

/// Linear work gives a ratio of about 8 between N and 8N, work in the holdings about 64.
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
fn scales_linearly(what: &str, run: &dyn Fn(usize) -> Duration) -> Option<String> {
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
    println!("pull, {what}: N = {n}, {at_n:?} and {at_8n:?}, ratio {ratio:.2}");
    (ratio >= BOUND).then(|| {
        format!(
            "{what}: the run at 8N = {} took {ratio:.1} times as long as at N = {n} \
             ({at_8n:?} against {at_n:?}); linear work gives about 8",
            8 * n
        )
    })
}

/// A store, its peer, and a position with 16 records after it.
type Built = (MemoryStore, Box<dyn PeerStore>, Position);

/// A peer with `held` deltas (one batch) and `earlier` head-only commits before the position,
/// and 16 records after it, each adding one delta.
fn costed(held: usize, earlier: usize) -> Built {
    let store = MemoryStore::new();
    let peer = new_peer(&store, "peer:cost");
    let mut writer = Writer::default();
    let batch: Vec<Delta> = (0..held)
        .map(|k| fact(&format!("other:{k}"), "x", k as f64))
        .collect();
    writer.append(peer.as_ref(), &batch);
    for _ in 0..earlier {
        writer.append(peer.as_ref(), &[]);
    }
    let position = here(peer.as_ref());
    for k in 0..16 {
        writer.append(peer.as_ref(), &[fact("after", "x", k as f64)]);
    }
    (store, peer, position)
}

fn cost_rail(what: &str, build: fn(usize) -> Built) {
    let built: RefCell<BTreeMap<usize, Built>> = RefCell::default();
    let counted = Cell::new(0usize);
    let run = |n: usize| {
        let mut built = built.borrow_mut();
        let (_, peer, position) = built.entry(n).or_insert_with(|| build(n));
        let start = Instant::now();
        for _ in 0..n {
            let mut cursor = follow_feed(peer.as_ref(), position.clone()).unwrap();
            black_box(cursor.pull().unwrap());
        }
        counted.set(counted.get() + n);
        start.elapsed()
    };
    let (_, peer, position) = build(10);
    let Pull::Ok {
        records, deltas, ..
    } = follow_feed(peer.as_ref(), position)
        .unwrap()
        .pull()
        .unwrap()
    else {
        panic!("the costed pull answers ok");
    };
    assert_eq!((records.len(), deltas.len()), (16, 16));
    // A run is measured again once before a slow ratio counts.
    let slow = scales_linearly(what, &run).and_then(|_| scales_linearly(what, &run));
    assert!(slow.is_none(), "{}", slow.unwrap());
    assert!(counted.get() > 0);
}

/// Rail 1: N pulls beside N held deltas, and 8N beside 8N.
#[test]
fn a_pull_costs_its_page_not_the_holdings() {
    cost_rail("beside N held deltas", |n| costed(n, 0));
}

/// Rail 2: N pulls after N records before the position, and 8N after 8N.
#[test]
fn a_pull_costs_its_page_not_the_records_before_it() {
    cost_rail("after N records before the position", |n| costed(0, n));
}
