//! `vectors/store/freshness.json` (SPEC-18 proposal §4.6; `vectors/store/README.md` §9) and the
//! rails each witness adds (README §9.7).
//!
//! **Built captures only, by construction.** `Capture` has private fields and exactly two
//! constructors, `make_capture` and `parse_capture`, and both check every rule of §4.6. So
//! `touching` and `check_fresh`, which take `&Capture`, can only ever receive a checked capture:
//! a spread copy, a reversed member list, a parsed value that skipped `parse_capture` or a cast
//! object cannot be written in Rust. The rows of README §9.7 "Built captures only" are met by the
//! type; the tests below hold the two constructors to the rules instead.

use std::collections::{BTreeMap, BTreeSet};
use std::hint::black_box;
use std::time::{Duration, Instant};

use rhizomatic::memory_store::{HistoryMint, MemoryStore, MemoryStoreOptions};
use rhizomatic::set::{make_delta, make_negation_claims, DeltaSource};
use rhizomatic::store::{
    negated_ids, target_entities, Admission, Anchor, AppendResult, ArrivalRecord, ChangePage,
    ChangeRecord, ChangeRetention, ErasurePosture, PeerStore, Pushdown, PushdownFields, Revision,
    ScopeRequest, Snapshot, Store, StoreError, StoreErrorCode, VerifiedDelta, LOCAL_HISTORY_PREFIX,
    MAX_REVISION,
};
use rhizomatic::store_conformance::{
    run_freshness_conformance, FreshnessReader, StoreConformanceError, StoreConformanceReport,
};
use rhizomatic::store_fresh::{
    check_fresh, make_capture, parse_capture, touching, validity_window, Capture, Freshness, Touch,
    TouchReason,
};
use rhizomatic::store_read::{capture_scope, fetch_scope, Selection, StoreFreshness};
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};
use serde_json::Value;

#[path = "support/freshness_doubles.rs"]
mod doubles;
use doubles::{DeclaresNoFeed, ReportsNothingApplied, Scaled};

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

// ---------------------------------------------------------------------------------------------
// Wrong readers (README §9.7)
// ---------------------------------------------------------------------------------------------

/// The one thing a wrong reader gets wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wrong {
    Nothing,
    // `touching`, inside `check_fresh` too.
    IgnoresRemoved,
    IgnoresNegators,
    EveryAddTouches,
    IgnoresReAdd,
    AddedBeforeRemoved,
    /// The standalone `touching` only.
    DropsLastRecord,
    // The capture.
    FetchedMembers,
    FetchAsMembersWhenNothingApplied,
    NoSince,
    OtherHistory,
    OtherRevision,
    AnchorsAsGiven,
    FirstAnchorOnly,
    WindowOverRaw,
    WindowIgnoresExcludeIds,
    WindowIgnoresArrival,
    ExpiresLeavesOutNegators,
    DropsExcluded,
    DropsLateArrivals,
    OneNegationLayer,
    // `check_fresh`.
    ChecksAtSince,
    IgnoresSince,
    NotYetAtSince,
    NotYetWithNow,
    ExpiredWithNow,
    IgnoresHistory,
    FeedAtEqualRevisions,
    CallAfterAnswer,
    ResyncWithCaptureRevision,
    ResyncAsCurrent,
    GetsOutOfOrder,
    NoGet,
    NoRelease,
    NoTo,
}

struct Mutant(Wrong);

/// `touching`, wrong in the way `wrong` says.
fn wrong_touching(
    wrong: Wrong,
    capture: &Capture,
    records: &[ChangeRecord],
    added: &BTreeMap<String, Delta>,
) -> Option<Touch> {
    let holds = |id: &str| capture.members().iter().any(|m| m == id);
    let anchored = |e: &str| {
        capture
            .anchors()
            .iter()
            .any(|Anchor::Entity { entity }| entity == e)
    };
    let touch = |r: &ChangeRecord, id: &str, reason| Touch {
        revision: r.revision,
        id: id.to_string(),
        reason,
    };
    let records = match wrong {
        Wrong::DropsLastRecord => &records[..records.len().saturating_sub(1)],
        _ => records,
    };
    let removal = |r: &ChangeRecord| {
        if wrong == Wrong::IgnoresRemoved {
            return None;
        }
        r.removed
            .iter()
            .filter(|id| !(wrong == Wrong::IgnoresReAdd && added.contains_key(*id)))
            .find(|id| holds(id))
            .map(|id| touch(r, id, TouchReason::RemovedMember))
    };
    let addition = |r: &ChangeRecord| {
        for id in &r.added {
            let Some(delta) = added.get(id) else { continue };
            if wrong == Wrong::EveryAddTouches
                || target_entities(&delta.claims).into_iter().any(anchored)
            {
                return Some(touch(r, id, TouchReason::TargetsAnchor));
            }
            if wrong != Wrong::IgnoresNegators && negated_ids(&delta.claims).into_iter().any(holds)
            {
                return Some(touch(r, id, TouchReason::NegatesMember));
            }
        }
        None
    };
    if wrong == Wrong::AddedBeforeRemoved {
        return records
            .iter()
            .find_map(addition)
            .or_else(|| records.iter().find_map(removal));
    }
    records
        .iter()
        .find_map(|r| removal(r).or_else(|| addition(r)))
}

impl Mutant {
    fn inner_touching(&self) -> Wrong {
        match self.0 {
            Wrong::DropsLastRecord => Wrong::Nothing,
            w => w,
        }
    }

    /// `check_fresh` written out, wrong in the way the row says.
    fn checked(&self, peer: &dyn PeerStore, capture: &Capture, now: f64) -> Freshness {
        let w = self.0;
        let mut snapshot = peer.read().unwrap();
        let at_read = snapshot.revision();
        let answer = (|| {
            if w != Wrong::IgnoresHistory && snapshot.history() != capture.history() {
                return Freshness::ResyncRequired { current: at_read };
            }
            if at_read < capture.revision() {
                return Freshness::ResyncRequired { current: at_read };
            }
            let mut at = capture.revision();
            let mut first = true;
            while at < at_read || (w == Wrong::FeedAtEqualRevisions && first) {
                first = false;
                let to = (w != Wrong::NoTo).then_some(at_read);
                let (records, through) = match peer.changes(at, to).unwrap() {
                    ChangePage::ResyncRequired { current } => match w {
                        Wrong::ResyncWithCaptureRevision => {
                            return Freshness::ResyncRequired {
                                current: capture.revision(),
                            }
                        }
                        Wrong::ResyncAsCurrent => break,
                        _ => return Freshness::ResyncRequired { current },
                    },
                    ChangePage::Ok { records, through } => (records, through),
                };
                let mut ids: Vec<String> = records
                    .iter()
                    .flat_map(|r| r.added.iter().cloned())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                if w == Wrong::GetsOutOfOrder {
                    ids.reverse();
                }
                let added: BTreeMap<String, Delta> = match (ids.is_empty(), w) {
                    (true, _) => BTreeMap::new(),
                    (false, Wrong::NoGet) => BTreeMap::new(),
                    (false, _) => snapshot
                        .get(&ids)
                        .unwrap()
                        .into_iter()
                        .map(|d| (d.id.clone(), d))
                        .collect(),
                };
                if let Some(t) = wrong_touching(self.inner_touching(), capture, &records, &added) {
                    return Freshness::Stale(t);
                }
                if through <= at {
                    break;
                }
                at = through;
            }
            let at_time = match w {
                Wrong::ChecksAtSince => capture.since().unwrap_or(now),
                _ => now,
            };
            match (capture.since(), capture.expires_at()) {
                (Some(since), _)
                    if w != Wrong::IgnoresSince
                        && (at_time < since || (w == Wrong::NotYetAtSince && at_time <= since)) =>
                {
                    Freshness::NotYet {
                        since: if w == Wrong::NotYetWithNow {
                            now
                        } else {
                            since
                        },
                    }
                }
                (_, Some(expires_at)) if at_time >= expires_at => Freshness::Expired {
                    expires_at: if w == Wrong::ExpiredWithNow {
                        now
                    } else {
                        expires_at
                    },
                },
                _ => Freshness::Current,
            }
        })();
        if w != Wrong::NoRelease {
            snapshot.release();
        }
        if w == Wrong::CallAfterAnswer {
            peer.read().unwrap().release();
        }
        answer
    }

    fn captured(
        &self,
        snapshot: &dyn Snapshot,
        entities: &[String],
        now: f64,
        pushdown: Option<&Pushdown>,
    ) -> Result<Capture, StoreError> {
        let w = self.0;

        let standard = capture_scope(snapshot, entities, now, select(pushdown))?.1;
        let mut anchors: Vec<Anchor> = standard.anchors().to_vec();
        let mut members: Vec<String> = standard.members().to_vec();
        let (mut since, mut expires_at) = (standard.since(), standard.expires_at());
        let mut history = standard.history().to_string();
        let mut revision = standard.revision();
        let sorted: Vec<String> = entities
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let fetch = |p: Option<&Pushdown>| {
            snapshot
                .scope(&ScopeRequest {
                    anchors: sorted
                        .iter()
                        .map(|e| Anchor::Entity { entity: e.clone() })
                        .collect(),
                    pushdown: p.cloned(),
                    exclude: Vec::new(),
                })
                .unwrap()
        };
        let window_without = |strip: fn(&mut Pushdown)| {
            let mut p = pushdown.cloned().unwrap_or_default();
            strip(&mut p);
            let c = capture_scope(snapshot, entities, now, select(Some(&p)))
                .unwrap()
                .1;
            (c.since(), c.expires_at())
        };
        match w {
            Wrong::FetchedMembers => {
                members = fetch(pushdown)
                    .deltas
                    .into_iter()
                    .map(|m| m.delta.id)
                    .collect()
            }
            Wrong::FetchAsMembersWhenNothingApplied => {
                let answer = fetch(pushdown);
                if answer.applied == PushdownFields::default() {
                    members = answer.deltas.into_iter().map(|m| m.delta.id).collect();
                }
            }
            Wrong::NoSince => since = None,
            Wrong::OtherHistory => history = "another-history".into(),
            Wrong::OtherRevision => revision = Revision(revision.0 + 1),
            Wrong::AnchorsAsGiven => {
                anchors = entities
                    .iter()
                    .map(|e| Anchor::Entity { entity: e.clone() })
                    .collect()
            }
            Wrong::FirstAnchorOnly => anchors.truncate(1),
            Wrong::WindowOverRaw => {
                (since, expires_at) = window_without(|p| *p = Pushdown::default())
            }
            Wrong::WindowIgnoresExcludeIds => {
                (since, expires_at) = window_without(|p| p.exclude_ids = None)
            }
            Wrong::WindowIgnoresArrival => {
                (since, expires_at) = window_without(|p| p.arrival_at_most = None)
            }
            Wrong::ExpiresLeavesOutNegators => {
                let operand = fetch_scope(snapshot, entities, select(pushdown))?;
                let ids: Vec<String> = operand
                    .source
                    .ids()
                    .into_iter()
                    .map(str::to_string)
                    .collect();
                let plain = operand
                    .source
                    .subset(&ids)
                    .iter()
                    .filter(|d| negated_ids(&d.claims).is_empty())
                    .cloned()
                    .collect::<Vec<_>>();
                expires_at = validity_window(&plain, now).expires_at;
            }
            Wrong::DropsExcluded => {
                let dropped = pushdown
                    .and_then(|p| p.exclude_ids.clone())
                    .unwrap_or_default();
                members.retain(|id| !dropped.contains(id));
            }
            Wrong::DropsLateArrivals => {
                if let Some(n) = pushdown.and_then(|p| p.arrival_at_most) {
                    let late: BTreeSet<String> = snapshot
                        .arrivals(&members)?
                        .into_iter()
                        .filter(|a| a.sequence > n)
                        .map(|a| a.id)
                        .collect();
                    members.retain(|id| !late.contains(id));
                }
            }
            Wrong::OneNegationLayer => {
                let first = snapshot.targets(&sorted)?;
                let mut all: BTreeSet<String> = first.iter().cloned().collect();
                all.extend(snapshot.negators(&first)?);
                members = all.into_iter().collect();
            }
            _ => {}
        }
        make_capture(&history, revision, anchors, members, since, expires_at)
    }
}

impl FreshnessReader for Mutant {
    fn capture(
        &self,
        snapshot: &dyn Snapshot,
        entities: &[String],
        now: f64,
        pushdown: Option<&Pushdown>,
    ) -> Result<Capture, StoreError> {
        self.captured(snapshot, entities, now, pushdown)
    }

    fn touching(
        &self,
        capture: &Capture,
        records: &[ChangeRecord],
        added: &BTreeMap<String, Delta>,
    ) -> Option<Touch> {
        wrong_touching(self.0, capture, records, added)
    }

    fn check_fresh(
        &self,
        peer: &dyn PeerStore,
        capture: &Capture,
        now: f64,
    ) -> Result<Freshness, StoreError> {
        Ok(self.checked(peer, capture, now))
    }
}

/// The cases added with the window, the history, the selections and the chain (README §9.7).
const NEW_CASES: [&str; 11] = [
    "the-window",
    "a-fact-that-starts-at-now",
    "a-negator-sets-the-window",
    "a-chain-of-four",
    "a-capture-checked-on-another-peer",
    "a-selection-rejects-the-toucher",
    "a-selection-and-a-purged-raw-id",
    "a-selection-and-a-negator-of-a-raw-id",
    "a-selection-admits-the-toucher",
    "a-selection-excludes-members",
    "a-selection-by-arrival",
];

fn without_new_cases(doc: &Value) -> Value {
    let mut doc = doc.clone();
    doc["cases"]
        .as_array_mut()
        .unwrap()
        .retain(|c| !NEW_CASES.contains(&c["name"].as_str().unwrap()));
    doc
}

/// One row: the reader, the run, the case it fails and how its message starts.
struct Row {
    wrong: Wrong,
    store: RunStore,
    case: &'static str,
    message: &'static str,
}

const fn row(wrong: Wrong, case: &'static str, message: &'static str) -> Row {
    Row {
        wrong,
        store: DEFAULT,
        case,
        message,
    }
}

const TABLE: &[Row] = &[
    row(
        Wrong::IgnoresRemoved,
        "a-purge-of-a-member",
        "checkFresh answered current, expected stale",
    ),
    row(
        Wrong::IgnoresNegators,
        "an-added-negator-of-a-member",
        "checkFresh answered current, expected stale",
    ),
    row(
        Wrong::EveryAddTouches,
        "unrelated-appends",
        "checkFresh answered stale, expected current",
    ),
    row(
        Wrong::NoTo,
        "a-head-only-commit",
        "checkFresh made the call changes(1, none) where the contract asks for changes(1, 2)",
    ),
    row(
        Wrong::IgnoresReAdd,
        "a-member-purged-and-added-again",
        "checkFresh reports the touch 3 ",
    ),
    row(
        Wrong::AddedBeforeRemoved,
        "the-first-of-several-touches",
        "checkFresh reports the touch 4 ",
    ),
    row(
        Wrong::FetchedMembers,
        "a-selection-rejects-the-toucher",
        "the capture's members are",
    ),
    row(
        Wrong::ChecksAtSince,
        "the-window",
        "checkFresh answered current, expected not-yet",
    ),
    row(
        Wrong::IgnoresSince,
        "a-fact-that-starts-at-now",
        "checkFresh answered current, expected not-yet",
    ),
    row(
        Wrong::NotYetAtSince,
        "the-window",
        "checkFresh answered not-yet, expected current",
    ),
    row(
        Wrong::NotYetWithNow,
        "the-window",
        "checkFresh reports not-yet since 99, expected 100",
    ),
    row(
        Wrong::NoSince,
        "the-window",
        "the capture's since is null, expected 100",
    ),
    row(
        Wrong::WindowOverRaw,
        "a-selection-rejects-the-toucher",
        "the capture's since is 70, expected 20",
    ),
    row(
        Wrong::WindowIgnoresExcludeIds,
        "a-selection-excludes-members",
        "the capture's since is 22, expected 20",
    ),
    row(
        Wrong::WindowIgnoresArrival,
        "a-selection-by-arrival",
        "the capture's since is 23, expected 20",
    ),
    row(
        Wrong::ExpiresLeavesOutNegators,
        "a-negator-sets-the-window",
        "the capture expires at null, expected 130",
    ),
    row(
        Wrong::DropsExcluded,
        "a-selection-excludes-members",
        "the capture's members are",
    ),
    row(
        Wrong::DropsLateArrivals,
        "a-selection-by-arrival",
        "the capture's members are",
    ),
    row(
        Wrong::OneNegationLayer,
        "a-chain-of-four",
        "the capture's members are",
    ),
    row(
        Wrong::IgnoresHistory,
        "a-capture-checked-on-another-peer",
        "checkFresh answered current, expected resync-required",
    ),
    row(
        Wrong::OtherHistory,
        "no-change",
        "the capture's history is not its snapshot's",
    ),
    row(
        Wrong::FeedAtEqualRevisions,
        "no-change",
        "checkFresh made the call changes(1, 1) where the contract asks for release",
    ),
    row(
        Wrong::CallAfterAnswer,
        "an-added-delta-targets-an-anchor",
        "checkFresh made the call read after its last call",
    ),
    row(
        Wrong::OtherRevision,
        "no-change",
        "the capture is of revision 2, expected 1",
    ),
    row(
        Wrong::AnchorsAsGiven,
        "two-anchors",
        "the capture is malformed: capture: anchors is not strictly ascending by UTF-8 bytes",
    ),
    row(
        Wrong::ResyncAsCurrent,
        "retention-too-short",
        "checkFresh answered current for a capture below the retention floor 2",
    ),
    row(
        Wrong::ResyncWithCaptureRevision,
        "retention-too-short",
        "checkFresh reports resync-required with current 1, not the peer's revision 3",
    ),
    row(
        Wrong::ExpiredWithNow,
        "the-window",
        "checkFresh reports expiry at 200, expected 120",
    ),
    row(
        Wrong::GetsOutOfOrder,
        "two-touchers-in-one-record",
        "checkFresh made the call get [",
    ),
    row(
        Wrong::NoGet,
        "unrelated-appends",
        "checkFresh made the call release where the contract asks for get [",
    ),
    row(
        Wrong::NoRelease,
        "no-change",
        "checkFresh made no call where the contract asks for release",
    ),
    Row {
        wrong: Wrong::FetchAsMembersWhenNothingApplied,
        store: RunStore::ReportsNothing,
        case: "a-selection-rejects-the-toucher",
        message: "the capture's members are",
    },
    row(
        Wrong::DropsLastRecord,
        "an-added-delta-targets-an-anchor",
        "touching answered none, expected 2 ",
    ),
    // Rust only: check 2 of §9.2. A capture whose anchors are out of order is refused by its
    // constructor (check 0), so a row with sorted anchors and one missing reaches the check.
    row(
        Wrong::FirstAnchorOnly,
        "two-anchors",
        "the capture's anchors are [entity:plant:a], expected [entity:plant:a entity:plant:b]",
    ),
];

/// What is wrong with one row's run, or nothing.
fn judge(doc: &Value, row: &Row) -> Option<String> {
    let error = match run(row.store, doc, &Mutant(row.wrong)) {
        Ok(_) => return Some("passed every case".into()),
        Err(error) => error,
    };
    let name = format!("freshness/{}", row.case);
    let touching = format!("touching/{}", row.case);
    match error
        .failures
        .iter()
        .find(|f| f.name == name || f.name == touching)
    {
        None => Some(format!(
            "{} did not fail; failed: {:?}",
            row.case,
            error.failures.iter().map(|f| &f.name).collect::<Vec<_>>()
        )),
        Some(f) if !f.message.starts_with(row.message) => Some(format!(
            "{} failed for another reason: {}",
            row.case, f.message
        )),
        Some(_) => None,
    }
}

#[test]
fn every_wrong_reader_fails_its_case_with_its_message() {
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

/// The rows whose case is one of the cases added with the window, the history, the selections
/// and the chain pass the document without those cases, and fail with them (README §9.7).
#[test]
fn the_rows_of_the_new_cases_pass_without_them() {
    let doc = document();
    let without = without_new_cases(&doc);
    // A capture with no `since` checks a field the runner did not read before; every case with
    // a window fails it. Its toggle is the runner's check, removed by mutation.
    let new_case_rows = TABLE
        .iter()
        .filter(|row| NEW_CASES.contains(&row.case) && row.wrong != Wrong::NoSince);
    for row in new_case_rows {
        if let Err(e) = run(row.store, &without, &Mutant(row.wrong)) {
            panic!("{:?} fails without the new cases: {e}", row.wrong);
        }
        assert!(judge(&doc, row).is_none(), "{:?}", row.wrong);
    }
}

#[test]
fn the_faithful_mutant_passes_every_run() {
    let doc = document();
    for (label, store) in runs() {
        run(store, &doc, &Mutant(Wrong::Nothing)).unwrap_or_else(|e| panic!("run {label}: {e}"));
    }
}

/// The run-6 reader passes runs 1 to 5: only a store that trims and reports nothing shows it.
#[test]
fn the_fetch_as_members_reader_passes_runs_one_to_five() {
    let doc = document();
    for (label, store) in runs().into_iter().take(5) {
        run(
            store,
            &doc,
            &Mutant(Wrong::FetchAsMembersWhenNothingApplied),
        )
        .unwrap_or_else(|e| panic!("run {label}: {e}"));
    }
}

fn select(p: Option<&Pushdown>) -> Selection<'_> {
    Selection {
        pushdown: p,
        admits: None,
    }
}

// ---------------------------------------------------------------------------------------------
// Document defects (README §9.2, §9.3)
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

fn first_op<'a>(doc: &'a mut Value, case: &str, op: &str) -> &'a mut Value {
    steps_of(doc, case)
        .iter_mut()
        .find(|s| s["op"] == op)
        .unwrap()
}

/// Each defect of a document, and the message it fails with in the case it changes.
#[test]
fn a_defective_document_fails_with_its_message() {
    type Edit = fn(&mut Value);
    let rows: [(&str, Edit, &str); 7] = [
        (
            "no-change",
            |d| {
                first_op(d, "no-change", "check")
                    .as_object_mut()
                    .unwrap()
                    .remove("now");
            },
            "the vector's check has no now",
        ),
        (
            "no-change",
            |d| first_op(d, "no-change", "check")["capture"] = "unknown".into(),
            "the vector uses capture unknown before taking it",
        ),
        (
            "a-capture-checked-on-another-peer",
            |d| {
                first_op(d, "a-capture-checked-on-another-peer", "check")
                    .as_object_mut()
                    .unwrap()
                    .remove("anotherPeer");
            },
            "the vector checks capture c on another peer",
        ),
        (
            "no-change",
            |d| first_op(d, "no-change", "check")["anotherPeer"] = true.into(),
            "the vector says capture c is checked on another peer, and it is not",
        ),
        (
            "a-touch-through-a-dynamic-anchor",
            |d| {
                first_op(d, "a-touch-through-a-dynamic-anchor", "capture")["as"] =
                    "root-only".into()
            },
            "the vector names capture root-only twice",
        ),
        (
            "a-head-only-commit",
            |d| first_op(d, "a-head-only-commit", "check")["expect"]["revision"] = "A.1".into(),
            "the vector checks at A.1, and the peer is at 2",
        ),
        (
            "an-added-delta-targets-an-anchor",
            |d| {
                first_op(d, "an-added-delta-targets-an-anchor", "check")["expect"]["touching"] =
                    Value::Null
            },
            "touching answered 2 ",
        ),
    ];
    for (case, edit, message) in rows {
        let mut doc = document();
        edit(&mut doc);
        let error = run(DEFAULT, &doc, &StoreFreshness).expect_err(message);
        assert_eq!(error.failures.len(), 1, "{message}: {error}");
        let failure = &error.failures[0];
        assert_eq!(failure.name, format!("freshness/{case}"), "{message}");
        assert!(
            failure.message.starts_with(message),
            "{message}: {failure:?}"
        );
    }

    // A check on a store that serves no feed, in a case that does not require one.
    let mut doc = document();
    doc["cases"]
        .as_array_mut()
        .unwrap()
        .retain(|c| c["name"] == "no-change");
    doc["cases"][0].as_object_mut().unwrap().remove("requires");
    let error = run_freshness_conformance(
        &|_| Ok(Box::new(DeclaresNoFeed::new(MemoryStore::new())) as Box<dyn Store>),
        &doc,
        &StoreFreshness,
    )
    .expect_err("a check needs a feed");
    assert_eq!(
        error.failures[0].message,
        "a check step on a store that serves no feed"
    );
    // With its requirement, the case is skipped and reported.
    let report = run_freshness_conformance(
        &|_| Ok(Box::new(DeclaresNoFeed::new(MemoryStore::new())) as Box<dyn Store>),
        &document(),
        &StoreFreshness,
    )
    .unwrap();
    assert_eq!(report.skipped.len(), counts(&document()).0);
}

// ---------------------------------------------------------------------------------------------
// Histories (README §1.3, §9.7 "Histories", "Captures across processes")
// ---------------------------------------------------------------------------------------------

fn fact(entity: &str, context: &str, value: f64, valid: (f64, Option<f64>)) -> Delta {
    make_delta(
        Claims {
            timestamp: valid.0,
            valid_from: valid.0,
            valid_until: valid.1,
            author: "did:key:zFresh".into(),
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

/// Appends deltas as one batch with sequences after `last`, moving the head from `head` to
/// `head + 1`. Answers the revision.
fn commit(peer: &dyn PeerStore, head: usize, last: u64, deltas: &[Delta]) -> Revision {
    let added = deltas
        .iter()
        .zip(last + 1..)
        .map(|(delta, sequence)| VerifiedDelta {
            delta: delta.clone(),
            arrival: ArrivalRecord {
                id: delta.id.clone(),
                at: 1000.0,
                sequence,
                transfer: 1,
                sender: "local".into(),
            },
        })
        .collect();
    match peer
        .append(&Admission {
            expected_head: (head > 0).then(|| format!("head-{head}")),
            next_head: format!("head-{}", head + 1),
            frame: None,
            added,
        })
        .unwrap()
    {
        AppendResult::Committed { revision, .. } => revision,
        other => panic!("{other:?}"),
    }
}

fn capture_now(peer: &dyn PeerStore, entities: &[&str], now: f64) -> Capture {
    let mut snapshot = peer.read().unwrap();
    let entities: Vec<String> = entities.iter().map(|e| e.to_string()).collect();
    let (_, capture) =
        capture_scope(snapshot.as_ref(), &entities, now, Selection::default()).unwrap();
    snapshot.release();
    capture
}

#[test]
fn one_name_created_in_two_stores_has_two_histories() {
    let (a, b) = (MemoryStore::new(), MemoryStore::new());
    let first = a.create_peer("peer:one", ErasurePosture::Unproven).unwrap();
    let second = b.create_peer("peer:one", ErasurePosture::Unproven).unwrap();
    assert!(!first.history().is_empty());
    assert_ne!(first.history(), second.history());
    assert!(first.history().starts_with(LOCAL_HISTORY_PREFIX));
    // Every handle and every snapshot of one peer report its value.
    let again = a.peer("peer:one").unwrap();
    assert_eq!(again.history(), first.history());
    let mut snapshot = again.read().unwrap();
    assert_eq!(snapshot.history(), first.history());
    snapshot.release();
    // Another peer of the same store has another value.
    let other = a.create_peer("peer:two", ErasurePosture::Unproven).unwrap();
    assert_ne!(other.history(), first.history());

    // A capture of the first is checked on the second: another history, so resync-required,
    // with no feed call; the walk of README §9.3 holds the calls in the vector run.
    let fern = fact("plant:a", "name", 1.0, (10.0, None));
    commit(first.as_ref(), 0, 0, std::slice::from_ref(&fern));
    let capture = capture_now(first.as_ref(), &["plant:a"], 100.0);
    commit(second.as_ref(), 0, 0, &[fern]);
    commit(second.as_ref(), 1, 1, &[]);
    assert_eq!(
        check_fresh(second.as_ref(), &capture, 100.0).unwrap(),
        Freshness::ResyncRequired {
            current: Revision(2)
        }
    );
    assert_eq!(
        check_fresh(first.as_ref(), &capture, 100.0).unwrap(),
        Freshness::Current
    );
}

#[test]
fn a_hosts_mint_is_used_and_the_local_prefix_is_refused() {
    let minted = std::sync::Arc::new(std::sync::Mutex::new(0));
    let counter = minted.clone();
    let store = MemoryStore::new().with_history_mint(HistoryMint::new(move || {
        let mut n = counter.lock().unwrap();
        *n += 1;
        format!("host:7f3a:{n}")
    }));
    let peer = store
        .create_peer("peer:m", ErasurePosture::Unproven)
        .unwrap();
    assert_eq!(peer.history(), "host:7f3a:1");
    assert_eq!(*minted.lock().unwrap(), 1);

    for bad in ["", "memory:local:9"] {
        let store = MemoryStore::new().with_history_mint(HistoryMint::new(move || bad.to_string()));
        let refused = store
            .create_peer("peer:m", ErasurePosture::Unproven)
            .err()
            .expect("a mint that answers the local prefix or nothing is refused");
        assert_eq!(refused.code, StoreErrorCode::InvalidRequest, "{bad:?}");
        // Nothing was created.
        assert_eq!(
            store.peer("peer:m").err().map(|e| e.code),
            Some(StoreErrorCode::PeerAbsent)
        );
    }

    // A capture with a minted history survives a JSON round trip.
    commit(
        peer.as_ref(),
        0,
        0,
        &[fact("plant:a", "name", 1.0, (10.0, None))],
    );
    let capture = capture_now(peer.as_ref(), &["plant:a"], 100.0);
    let text = serde_json::to_string(&capture.to_json()).unwrap();
    let back = parse_capture(&serde_json::from_str(&text).unwrap()).unwrap();
    assert_eq!(back, capture);
    assert_eq!(
        check_fresh(peer.as_ref(), &back, 100.0).unwrap(),
        Freshness::Current
    );
}

#[test]
fn a_process_local_capture_does_not_cross_a_process() {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:l", ErasurePosture::Unproven)
        .unwrap();
    commit(
        peer.as_ref(),
        0,
        0,
        &[fact("plant:a", "name", 1.0, (10.0, None))],
    );
    let capture = capture_now(peer.as_ref(), &["plant:a"], 100.0);
    let text = serde_json::to_string(&capture.to_json()).unwrap();
    let refused = parse_capture(&serde_json::from_str(&text).unwrap()).unwrap_err();
    assert_eq!(refused.code, StoreErrorCode::InvalidRequest);
    assert!(
        refused.message.contains("mintHistory"),
        "{}",
        refused.message
    );
}

// ---------------------------------------------------------------------------------------------
// The checking constructor (README §9.7)
// ---------------------------------------------------------------------------------------------

fn shape(history: &str, members: &[&str], anchors: &[&str]) -> Value {
    serde_json::json!({
        "history": history,
        "revision": 4,
        "anchors": anchors.iter().map(|e| serde_json::json!({"kind": "entity", "entity": e})).collect::<Vec<_>>(),
        "members": members,
        "since": null,
        "expiresAt": null,
    })
}

#[test]
fn the_constructors_check_utf8_order_and_never_sort() {
    // U+FF61 sorts before U+1F600 by UTF-8 bytes and after it by UTF-16 code units.
    let (halfwidth, smile) = ("id-\u{FF61}", "id-\u{1F600}");
    let utf8 = [halfwidth, smile];
    let capture = parse_capture(&shape("host:1", &utf8, &utf8)).unwrap();
    assert_eq!(capture.members(), utf8);
    // `touching` finds both, by binary search in that order.
    for id in utf8 {
        let record = ChangeRecord {
            revision: Revision(5),
            head: None,
            added: Vec::new(),
            removed: vec![id.to_string()],
        };
        let touch = touching(&capture, &[record], &BTreeMap::new()).expect(id);
        assert_eq!(
            (touch.id.as_str(), touch.reason),
            (id, TouchReason::RemovedMember)
        );
        let anchored = fact(id, "x", 1.0, (1.0, None));
        let record = ChangeRecord {
            revision: Revision(5),
            head: None,
            added: vec![anchored.id.clone()],
            removed: Vec::new(),
        };
        let added = BTreeMap::from([(anchored.id.clone(), anchored)]);
        assert_eq!(
            touching(&capture, &[record], &added).map(|t| t.reason),
            Some(TouchReason::TargetsAnchor)
        );
    }
    let utf16 = [smile, halfwidth];
    for (members, anchors, reason) in [
        (
            &utf16[..],
            &utf8[..],
            "members is not strictly ascending by UTF-8 bytes",
        ),
        (
            &utf8[..],
            &utf16[..],
            "anchors is not strictly ascending by UTF-8 bytes",
        ),
        (
            &["b", "a", "c"][..],
            &utf8[..],
            "members is not strictly ascending",
        ),
        (
            &["a", "a"][..],
            &utf8[..],
            "members is not strictly ascending",
        ),
        (
            &utf8[..],
            &["x", "x"][..],
            "anchors is not strictly ascending",
        ),
    ] {
        let refused = parse_capture(&shape("host:1", members, anchors)).unwrap_err();
        assert!(
            refused.message.starts_with(&format!("capture: {reason}")),
            "{refused}"
        );
        let made = make_capture(
            "host:1",
            Revision(4),
            anchors
                .iter()
                .map(|e| Anchor::Entity {
                    entity: e.to_string(),
                })
                .collect(),
            members.iter().map(|m| m.to_string()).collect(),
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(
            made, refused,
            "makeCapture refuses what parseCapture refuses"
        );
    }
}

#[test]
fn the_constructors_refuse_every_malformed_field() {
    let anchors = || {
        vec![Anchor::Entity {
            entity: "plant:a".into(),
        }]
    };
    let made = |history: &str, revision: u64, since: Option<f64>, expires: Option<f64>| {
        make_capture(
            history,
            Revision(revision),
            anchors(),
            vec!["a".into()],
            since,
            expires,
        )
        .err()
        .map(|e| e.message)
    };
    assert_eq!(made("h", 4, Some(1.0), Some(2.0)), None);
    assert_eq!(
        made("memory:local:1", 4, None, None),
        None,
        "the maker allows a local history"
    );
    for (got, reason) in [
        (made("", 4, None, None), "capture: history is empty"),
        (
            made("h", MAX_REVISION + 1, None, None),
            "capture: revision is not an integer",
        ),
        (
            made("h", 4, Some(f64::NAN), None),
            "capture: since is not null or a finite number",
        ),
        (
            made("h", 4, Some(f64::INFINITY), None),
            "capture: since is not null or a finite number",
        ),
        (
            made("h", 4, None, Some(f64::NEG_INFINITY)),
            "capture: expiresAt is not null",
        ),
        (
            made("h", 4, Some(2.0), Some(2.0)),
            "capture: since is not below expiresAt",
        ),
        (
            made("h", 4, Some(3.0), Some(2.0)),
            "capture: since is not below expiresAt",
        ),
    ] {
        let got = got.unwrap_or_default();
        assert!(got.starts_with(reason), "{got:?} for {reason}");
    }
    // The parser also refuses another shape.
    let good = shape("host:1", &["a"], &["plant:a"]);
    assert!(parse_capture(&good).is_ok());
    let mut extra = good.clone();
    extra["bytes"] = "00".into();
    let mut missing = good.clone();
    missing.as_object_mut().unwrap().remove("since");
    let mut fractional = good.clone();
    fractional["revision"] = serde_json::json!(4.5);
    let mut bad_anchor = good.clone();
    bad_anchor["anchors"][0]["extra"] = true.into();
    for value in [
        extra,
        missing,
        fractional,
        bad_anchor,
        Value::Null,
        serde_json::json!([]),
    ] {
        let refused = parse_capture(&value).unwrap_err();
        assert_eq!(refused.code, StoreErrorCode::InvalidRequest, "{value}");
    }
    let mut other_kind = good;
    other_kind["anchors"][0]["kind"] = "value".into();
    assert_eq!(
        parse_capture(&other_kind).unwrap_err().code,
        StoreErrorCode::CapabilityAbsent
    );
}

// ---------------------------------------------------------------------------------------------
// Moved snapshots (SPEC-18 §4.13 reading 35)
// ---------------------------------------------------------------------------------------------

/// A peer handle that commits through `writer` during each `changes` call, `moves` times: the
/// check's snapshot has moved when it asks `get`.
struct Moving<'a> {
    inner: &'a dyn PeerStore,
    writer: &'a dyn PeerStore,
    commits: std::cell::RefCell<Vec<Vec<Delta>>>,
    head: std::cell::Cell<usize>,
    reads: std::cell::Cell<usize>,
    releases: std::rc::Rc<std::cell::Cell<usize>>,
}

impl PeerStore for Moving<'_> {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn erasure(&self) -> rhizomatic::store::PeerErasure {
        self.inner.erasure()
    }
    fn history(&self) -> &str {
        self.inner.history()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        self.reads.set(self.reads.get() + 1);
        Ok(Box::new(Counted {
            inner: self.inner.read()?,
            releases: self.releases.clone(),
        }))
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.inner.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<rhizomatic::store::PurgeReport, StoreError> {
        self.inner.purge(ids)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreError> {
        let page = self.inner.changes(from, to);
        let next = self.commits.borrow_mut().pop();
        if let Some(deltas) = next {
            let head = self.head.get();
            commit(self.writer, head, 100 + head as u64 * 10, &deltas);
            self.head.set(head + 1);
        }
        page
    }
}

struct Counted {
    inner: Box<dyn Snapshot>,
    releases: std::rc::Rc<std::cell::Cell<usize>>,
}

impl Snapshot for Counted {
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
        self.inner.get(ids)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        self.inner.arrivals(ids)
    }
    fn targets(&self, e: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.targets(e)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.negators(ids)
    }
    fn scope(&self, r: &ScopeRequest) -> Result<rhizomatic::store::ScopeResult, StoreError> {
        self.inner.scope(r)
    }
    fn release(&mut self) {
        self.releases.set(self.releases.get() + 1);
        self.inner.release()
    }
}

#[test]
fn a_commit_during_a_check_starts_it_again_on_a_new_snapshot() {
    let setup = |moves: Vec<Vec<Delta>>| {
        let store = MemoryStore::new();
        let peer = store
            .create_peer("peer:moving", ErasurePosture::Unproven)
            .unwrap();
        let fern = fact("plant:a", "name", 1.0, (10.0, None));
        commit(peer.as_ref(), 0, 0, &[fern]);
        let capture = capture_now(peer.as_ref(), &["plant:a"], 100.0);
        // An unrelated append, so the first page names an added id and the check asks `get`.
        commit(
            peer.as_ref(),
            1,
            1,
            &[fact("plant:z", "name", 2.0, (11.0, None))],
        );
        (store, peer, capture, moves)
    };
    let check = |peer: &dyn PeerStore, capture: &Capture, moves: Vec<Vec<Delta>>| {
        let writer = peer;
        let moving = Moving {
            inner: peer,
            writer,
            commits: std::cell::RefCell::new(moves.into_iter().rev().collect()),
            head: std::cell::Cell::new(2),
            reads: std::cell::Cell::new(0),
            releases: Default::default(),
        };
        let answer = check_fresh(&moving, capture, 100.0);
        (answer, moving.reads.get(), moving.releases.get())
    };

    // One move: the commit is a toucher, so the second snapshot answers for the later revision.
    let toucher = fact("plant:a", "note", 3.0, (12.0, None));
    let (_store, peer, capture, moves) = setup(vec![vec![toucher.clone()]]);
    let (answer, reads, releases) = check(peer.as_ref(), &capture, moves);
    assert_eq!(
        answer.unwrap(),
        Freshness::Stale(Touch {
            revision: Revision(3),
            id: toucher.id.clone(),
            reason: TouchReason::TargetsAnchor,
        })
    );
    assert_eq!((reads, releases), (2, 2));

    // Four moves: the fourth snapshot moves too, and snapshot-moved passes up.
    let unrelated = |k: f64| vec![fact("plant:z", "n", k, (20.0 + k, None))];
    let moves = (0..4).map(|k| unrelated(k as f64)).collect();
    let (_store, peer, capture, _) = setup(Vec::new());
    let (answer, reads, releases) = check(peer.as_ref(), &capture, moves);
    assert_eq!(answer.unwrap_err().code, StoreErrorCode::SnapshotMoved);
    assert_eq!((reads, releases), (4, 4));

    // Three moves: the fourth snapshot answers.
    let moves = (0..3).map(|k| unrelated(k as f64)).collect();
    let (_store, peer, capture, _) = setup(Vec::new());
    let (answer, reads, releases) = check(peer.as_ref(), &capture, moves);
    assert_eq!(answer.unwrap(), Freshness::Current);
    assert_eq!((reads, releases), (4, 4));
}

#[test]
fn check_fresh_refuses_a_now_that_is_not_a_number() {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:n", ErasurePosture::Unproven)
        .unwrap();
    let capture = capture_now(peer.as_ref(), &["plant:a"], 100.0);
    assert_eq!(
        check_fresh(peer.as_ref(), &capture, f64::NAN)
            .unwrap_err()
            .code,
        StoreErrorCode::InvalidRequest
    );
}

// ---------------------------------------------------------------------------------------------
// A fuzz against brute force (README §9.7)
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
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

const ENTITIES: [&str; 4] = ["e:0", "e:1", "e:2", "e:3"];

/// A random corpus: facts at the entities (some at two), and negations, a quarter of the corpus
/// in chains of three or four, some with their own windows.
fn corpus(rng: &mut Rng) -> Vec<Delta> {
    let window = |rng: &mut Rng| {
        let from = rng.below(150) as f64;
        let until = rng.chance(50).then(|| from + 1.0 + rng.below(100) as f64);
        (from, until)
    };
    let mut deltas = Vec::new();
    for k in 0..10 {
        let mut claims = fact(rng.pick(&ENTITIES), "c", k as f64, window(rng)).claims;
        claims.timestamp = 10.0 + rng.below(90) as f64;
        if rng.chance(20) {
            claims.pointers.push(Pointer {
                role: "also".into(),
                target: Target::Entity(EntityRef {
                    id: rng.pick(&ENTITIES).to_string(),
                    context: None,
                }),
            });
        }
        deltas.push(make_delta(claims, None).unwrap());
    }
    let negate = |rng: &mut Rng, of: &Delta| {
        let mut claims =
            make_negation_claims("did:key:zFuzz", 10.0 + rng.below(90) as f64, &of.id, None);
        if rng.chance(30) {
            (claims.valid_from, claims.valid_until) = window(rng);
        }
        make_delta(claims, None).unwrap()
    };
    // Chains of three or four negations.
    for _ in 0..2 {
        let mut target = rng.pick(&deltas[..10]).clone();
        for _ in 0..3 + rng.below(2) {
            let next = negate(rng, &target);
            deltas.push(next.clone());
            target = next;
        }
    }
    // Negations at any depth.
    for _ in 0..6 {
        let target = rng.pick(&deltas).clone();
        let next = negate(rng, &target);
        deltas.push(next);
    }
    deltas
}

/// The brute model of one peer: what it holds with arrival sequences, and every record.
#[derive(Default)]
struct Model {
    held: BTreeMap<String, (Delta, u64)>,
    records: Vec<ChangeRecord>,
    revision: u64,
    head: usize,
    sequence: u64,
}

/// S(entities) over a plain list, by scanning (README §1.4.1's two steps).
fn brute_scope<'a>(entities: &BTreeSet<String>, set: &[&'a Delta]) -> BTreeMap<String, &'a Delta> {
    let mut scope: BTreeMap<String, &Delta> = set
        .iter()
        .filter(|d| {
            target_entities(&d.claims)
                .into_iter()
                .any(|e| entities.contains(e))
        })
        .map(|d| (d.id.clone(), *d))
        .collect();
    loop {
        let more: Vec<&Delta> = set
            .iter()
            .filter(|d| !scope.contains_key(&d.id))
            .filter(|d| {
                negated_ids(&d.claims)
                    .into_iter()
                    .any(|n| scope.contains_key(n))
            })
            .copied()
            .collect();
        if more.is_empty() {
            return scope;
        }
        scope.extend(more.into_iter().map(|d| (d.id.clone(), d)));
    }
}

fn passes(p: &Pushdown, delta: &Delta, sequence: u64) -> bool {
    p.timestamp_at_most
        .is_none_or(|t| delta.claims.timestamp <= t)
        && p.arrival_at_most.is_none_or(|n| sequence <= n)
        && p.exclude_ids
            .as_ref()
            .is_none_or(|ids| !ids.contains(&delta.id))
}

impl Model {
    /// The raw scope with arrival sequences.
    fn raw(&self, entities: &BTreeSet<String>) -> BTreeMap<String, u64> {
        let all: Vec<&Delta> = self.held.values().map(|(d, _)| d).collect();
        brute_scope(entities, &all)
            .into_keys()
            .map(|id| {
                let sequence = self.held[&id].1;
                (id, sequence)
            })
            .collect()
    }

    /// The selected scope: its deltas.
    fn selected(&self, entities: &BTreeSet<String>, p: &Pushdown) -> Vec<Delta> {
        let kept: Vec<&Delta> = self
            .held
            .values()
            .filter(|(d, s)| passes(p, d, *s))
            .map(|(d, _)| d)
            .collect();
        brute_scope(entities, &kept)
            .into_values()
            .cloned()
            .collect()
    }

    /// The first touch since `after`, by a plain scan of the records.
    fn first_touch(
        &self,
        after: u64,
        members: &BTreeSet<String>,
        anchors: &BTreeSet<String>,
    ) -> Option<Touch> {
        for r in self.records.iter().filter(|r| r.revision.0 > after) {
            for id in &r.removed {
                if members.contains(id) {
                    return Some(Touch {
                        revision: r.revision,
                        id: id.clone(),
                        reason: TouchReason::RemovedMember,
                    });
                }
            }
            for id in &r.added {
                let Some((d, _)) = self.held.get(id) else {
                    continue;
                };
                if target_entities(&d.claims)
                    .into_iter()
                    .any(|e| anchors.contains(e))
                {
                    return Some(Touch {
                        revision: r.revision,
                        id: id.clone(),
                        reason: TouchReason::TargetsAnchor,
                    });
                }
                if negated_ids(&d.claims)
                    .into_iter()
                    .any(|n| members.contains(n))
                {
                    return Some(Touch {
                        revision: r.revision,
                        id: id.clone(),
                        reason: TouchReason::NegatesMember,
                    });
                }
            }
        }
        None
    }

    fn append(&mut self, peer: &dyn PeerStore, batch: &[Delta]) {
        let mut added = BTreeSet::new();
        let entries: Vec<VerifiedDelta> = batch
            .iter()
            .map(|d| {
                self.sequence += 1;
                if !self.held.contains_key(&d.id) && added.insert(d.id.clone()) {
                    self.held.insert(d.id.clone(), (d.clone(), self.sequence));
                }
                VerifiedDelta {
                    delta: d.clone(),
                    arrival: ArrivalRecord {
                        id: d.id.clone(),
                        at: 1.0,
                        sequence: self.sequence,
                        transfer: 1,
                        sender: "fuzz".into(),
                    },
                }
            })
            .collect();
        let result = peer
            .append(&Admission {
                expected_head: (self.head > 0).then(|| format!("h{}", self.head)),
                next_head: format!("h{}", self.head + 1),
                frame: None,
                added: entries,
            })
            .unwrap();
        self.head += 1;
        self.revision += 1;
        assert_eq!(
            result,
            AppendResult::Committed {
                revision: Revision(self.revision),
                added: added.iter().cloned().collect()
            }
        );
        self.records.push(ChangeRecord {
            revision: Revision(self.revision),
            head: Some(format!("h{}", self.head)),
            added: added.into_iter().collect(),
            removed: Vec::new(),
        });
    }

    fn purge(&mut self, peer: &dyn PeerStore, ids: &[String]) {
        let removed: BTreeSet<String> = ids
            .iter()
            .filter(|id| self.held.remove(*id).is_some())
            .cloned()
            .collect();
        let report = peer.purge(ids).unwrap();
        if !removed.is_empty() {
            self.revision += 1;
            self.records.push(ChangeRecord {
                revision: Revision(self.revision),
                head: Some(format!("h{}", self.head)),
                added: Vec::new(),
                removed: removed.into_iter().collect(),
            });
        }
        assert_eq!(report.revision, Revision(self.revision));
    }
}

fn valid_at(deltas: &[Delta], t: f64) -> BTreeSet<String> {
    deltas
        .iter()
        .filter(|d| d.claims.valid_from <= t && d.claims.valid_until.is_none_or(|u| t < u))
        .map(|d| d.id.clone())
        .collect()
}

/// One sequence: a store, a capture, commits, checks. Counts each answer's status in `seen`.
fn fuzz_sequence(seed: u64, seen: &mut BTreeMap<&'static str, usize>) {
    let mut rng = Rng(seed);
    let corpus = corpus(&mut rng);
    let keep = rng.chance(25).then(|| 1 + rng.below(4));
    let page = rng.chance(60).then(|| 1 + rng.below(3));
    let pushdown = PushdownFields {
        timestamp_at_most: rng.chance(50),
        arrival_at_most: rng.chance(50),
        exclude_ids: rng.chance(50),
    };
    let store = MemoryStore::with_options(MemoryStoreOptions {
        pushdown,
        change_retention: keep.map_or(ChangeRetention::Unbounded, ChangeRetention::Revisions),
        change_page_size: page,
    })
    .unwrap();
    let peer = store
        .create_peer("peer:fuzz", ErasurePosture::Unproven)
        .unwrap();
    let mut model = Model::default();
    let initial: Vec<Delta> = corpus.iter().filter(|_| rng.chance(60)).cloned().collect();
    model.append(peer.as_ref(), &initial);

    let entities: Vec<String> = (0..1 + rng.below(2))
        .map(|_| rng.pick(&ENTITIES).to_string())
        .collect();
    let anchors: BTreeSet<String> = entities.iter().cloned().collect();
    let selection = match rng.below(4) {
        0 => None,
        _ => Some(Pushdown {
            timestamp_at_most: rng.chance(50).then(|| 10.0 + rng.below(100) as f64),
            arrival_at_most: rng.chance(40).then(|| rng.below(model.sequence + 2)),
            exclude_ids: rng
                .chance(40)
                .then(|| vec![rng.pick(&corpus).id.clone(), rng.pick(&corpus).id.clone()]),
        }),
    };
    let now = rng.below(200) as f64;
    let mut snapshot = peer.read().unwrap();
    let (_, capture) = capture_scope(
        snapshot.as_ref(),
        &entities,
        now,
        select(selection.as_ref()),
    )
    .unwrap();
    snapshot.release();

    // The capture is the raw scope, and its window is the selected scope's.
    let raw_then = model.raw(&anchors);
    let members: BTreeSet<String> = raw_then.keys().cloned().collect();
    assert_eq!(
        capture.members(),
        members.iter().cloned().collect::<Vec<_>>(),
        "seed {seed}"
    );
    let all = Pushdown::default();
    let operand = model.selected(&anchors, selection.as_ref().unwrap_or(&all));
    let window = validity_window(&operand, now);
    assert_eq!(
        (capture.since(), capture.expires_at()),
        (window.since, window.expires_at),
        "seed {seed}"
    );
    // The operand's valid set is the same at a random time inside the window.
    let low = window.since.unwrap_or(now - 100.0);
    let high = window.expires_at.unwrap_or(now + 100.0);
    let t = low + (high - low) * (rng.below(1000) as f64 / 1000.0);
    assert_eq!(
        valid_at(&operand, t),
        valid_at(&operand, now),
        "seed {seed} at {t}"
    );
    let selected_then: BTreeSet<String> = operand.iter().map(|d| d.id.clone()).collect();

    let captured_at = model.revision;
    for _ in 0..1 + rng.below(3) {
        for _ in 0..rng.below(5) {
            match rng.below(10) {
                0..=4 => {
                    let batch: Vec<Delta> = (0..1 + rng.below(3))
                        .map(|_| rng.pick(&corpus).clone())
                        .collect();
                    model.append(peer.as_ref(), &batch);
                }
                5 => model.append(peer.as_ref(), &[]),
                _ => {
                    let held: Vec<String> = model.held.keys().cloned().collect();
                    let mut ids: Vec<String> = Vec::new();
                    for _ in 0..1 + rng.below(2) {
                        ids.push(match held.is_empty() || rng.chance(20) {
                            true => rng.pick(&corpus).id.clone(),
                            false => rng.pick(&held).clone(),
                        });
                    }
                    model.purge(peer.as_ref(), &ids);
                }
            }
        }
        let at = rng.below(220) as f64;
        let answer = check_fresh(peer.as_ref(), &capture, at).unwrap();
        *seen.entry(answer.status()).or_default() += 1;

        let floor = keep.map_or(0, |n| model.revision.saturating_sub(n));
        if captured_at < floor {
            assert_eq!(
                answer,
                Freshness::ResyncRequired {
                    current: Revision(model.revision)
                },
                "seed {seed}"
            );
            continue;
        }
        let touch = model.first_touch(captured_at, &members, &anchors);
        // `touching` alone over the model's records agrees with the plain scan.
        let since: Vec<ChangeRecord> = model
            .records
            .iter()
            .filter(|r| r.revision.0 > captured_at)
            .cloned()
            .collect();
        let added: BTreeMap<String, Delta> = since
            .iter()
            .flat_map(|r| &r.added)
            .filter_map(|id| model.held.get(id).map(|(d, _)| (id.clone(), d.clone())))
            .collect();
        assert_eq!(touching(&capture, &since, &added), touch, "seed {seed}");

        let raw_now = model.raw(&anchors);
        let came_back = since
            .iter()
            .any(|r| r.removed.iter().any(|id| members.contains(id)));
        let changed = raw_now != raw_then || came_back;
        assert_eq!(
            touch.is_some(),
            changed,
            "seed {seed}: the check is exact on the raw scope"
        );
        match (&answer, &touch) {
            (Freshness::Stale(got), Some(want)) => assert_eq!(got, want, "seed {seed}"),
            (_, Some(want)) => panic!("seed {seed}: {answer:?}, expected stale {want:?}"),
            (_, None) => {
                let selected_now: BTreeSet<String> = model
                    .selected(&anchors, selection.as_ref().unwrap_or(&all))
                    .into_iter()
                    .map(|d| d.id)
                    .collect();
                assert_eq!(
                    selected_now, selected_then,
                    "seed {seed}: current keeps the selected scope"
                );
                let expected = match (window.since, window.expires_at) {
                    (Some(s), _) if at < s => Freshness::NotYet { since: s },
                    (_, Some(e)) if at >= e => Freshness::Expired { expires_at: e },
                    _ => Freshness::Current,
                };
                assert_eq!(answer, expected, "seed {seed} at {at}");
            }
        }
    }
}

/// At least 2,000 sequences in the suite. `RHIZOMATIC_FRESHNESS_FUZZ` sets another count.
#[test]
fn check_fresh_agrees_with_brute_force_over_random_sequences() {
    let count: u64 = std::env::var("RHIZOMATIC_FRESHNESS_FUZZ")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(2000);
    let mut seen = BTreeMap::new();
    for k in 0..count {
        fuzz_sequence(0x5EED_0000 + k, &mut seen);
    }
    println!("freshness fuzz: {count} sequences, answers {seen:?}");
    // Every answer occurs, so no branch of the check goes unexercised.
    for status in ["current", "stale", "not-yet", "expired", "resync-required"] {
        assert!(
            seen.get(status).is_some_and(|n| *n > 10),
            "{status}: {seen:?}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// The cost rails (README §9.7), timed from outside with the monotonic clock
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
/// run at 8N the fastest of three, stopped at the first under the bound.
fn scales_linearly(what: &str, run: impl Fn(usize) -> Duration) -> Option<String> {
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
    println!("checkFresh, {what}: N = {n}, {at_n:?} and {at_8n:?}, ratio {ratio:.2}");
    (ratio >= BOUND).then(|| {
        format!(
            "{what}: the run at 8N = {} took {ratio:.1} times as long as at N = {n} \
             ({at_8n:?} against {at_n:?}); linear work gives about 8",
            8 * n
        )
    })
}

/// A peer with `held` unrelated deltas and `earlier` head-only commits before one capture, and
/// 16 unrelated records after it.
fn costed(held: usize, earlier: usize) -> (MemoryStore, Box<dyn PeerStore>, Capture) {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:cost", ErasurePosture::Unproven)
        .unwrap();
    let mut head = 0;
    let mut last = 0;
    let mut batch = vec![fact("plant:a", "name", 0.0, (10.0, None))];
    batch.extend((0..held).map(|k| fact(&format!("other:{k}"), "x", k as f64, (10.0, None))));
    commit(peer.as_ref(), head, last, &batch);
    (head, last) = (head + 1, last + batch.len() as u64);
    for _ in 0..earlier {
        commit(peer.as_ref(), head, last, &[]);
        head += 1;
    }
    let capture = capture_now(peer.as_ref(), &["plant:a"], 100.0);
    for k in 0..16 {
        let unrelated = fact("after", "x", k as f64, (10.0, None));
        commit(peer.as_ref(), head, last, &[unrelated]);
        (head, last) = (head + 1, last + 1);
    }
    (store, peer, capture)
}

fn cost_rail(what: &str, build: fn(usize) -> (MemoryStore, Box<dyn PeerStore>, Capture)) {
    type Built = (MemoryStore, Box<dyn PeerStore>, Capture);
    let built: std::cell::RefCell<BTreeMap<usize, Built>> = Default::default();
    let run = |n: usize| {
        let mut built = built.borrow_mut();
        let (_, peer, capture) = built.entry(n).or_insert_with(|| build(n));
        let start = Instant::now();
        for _ in 0..n {
            black_box(check_fresh(peer.as_ref(), capture, 100.0).unwrap());
        }
        start.elapsed()
    };
    let (_, peer, capture) = build(10);
    assert_eq!(
        check_fresh(peer.as_ref(), &capture, 100.0).unwrap(),
        Freshness::Current
    );
    let slow = scales_linearly(what, run);
    assert!(slow.is_none(), "{}", slow.unwrap());
}

/// Rail 1: N calls beside N held deltas, and 8N beside 8N. A check that reads the holdings costs
/// N per call.
#[test]
fn a_check_costs_the_records_since_its_capture_not_the_holdings() {
    cost_rail("beside N held deltas", |n| costed(n, 0));
}

/// Rail 2: N calls after N records before the capture, and 8N after 8N. A check that reads the
/// feed before its capture costs N per call.
#[test]
fn a_check_costs_the_records_since_its_capture_not_the_records_before() {
    cost_rail("after N records before the capture", |n| costed(0, n));
}
