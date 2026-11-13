//! The runner-rules table for the change feed (`vectors/store/README.md` §3.9 and §8, SPEC-18
//! §4.13 reading 17). Each row is the memory store behind a thin wrapper (`Feedy`) that breaks
//! one feed rule, and nothing a script meets before it. The row asserts that the conformance run
//! fails, in the expected documents, and that every failure carries that rule's message.
//!
//! Most wrong feeds break only when two or more records are pending. The check of each commit
//! reads one record, so it still passes, and the rule's own message is the one that fails.
//!
//! Two messages are shared by the check after every step and the `changes` step ("every record
//! after … is retained", "below the retention floor"). Each has two rows: a store that is wrong
//! in every read, which the check after every step catches, and a store that is wrong only when a
//! `to` is given, which only a `changes` step gives.
//!
//! Named gaps — rules a wrapped store cannot reach:
//!
//! - **A page that is neither `ok` nor `resync-required`** (§3.9.5 check 3). `ChangePage` is an
//!   enum of those two answers, so no store can give a third.
//! - **Exact keys** (§3.9.3: a record with an extra key that carries bytes, an `ok` page or a
//!   `resync-required` answer with an extra key, a value that is not an object, `records` that
//!   is not a list), and its counterpart on the asking again of check 14 (the TypeScript row "an
//!   extra key only on the answer asked again"). `ChangeRecord` and `ChangePage` have exactly
//!   the contract's fields.
//! - **Ownership through shared values** (§3.9.5 check 14: a store that hands out the same
//!   record objects, or the same id lists, on every answer). A page is owned by the caller, so
//!   changing it cannot reach the store. The runner still asks again; the row
//!   `AnswersTwoWays` holds that re-ask to its message.
//! - **`changes answered ok from <from>, and the step expects resync-required`** against a wrong
//!   store. A store that answers `ok` from the future fails check 8 of §3.9.5 first, because no
//!   `through` lies in `[from, current]`. The row reaches the message through a wrong document.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use rhizomatic::memory_store::{MemoryStore, MemoryStoreOptions};
use rhizomatic::store::{
    Admission, AppendResult, ArrivalRecord, ChangePage, ChangeRecord, ChangeRetention,
    ErasurePosture, Exporter, PeerErasure, PeerStore, PurgeOutcome, PurgeReport, Revision,
    ScopeRequest, ScopeResult, Snapshot, Store, StoreError, StoreErrorCode, StoreProfile,
    MAX_REVISION,
};
use rhizomatic::store_conformance::{
    run_store_conformance, SkippedScript, StoreConformanceError, StoreConformanceReport,
    StoreVectors,
};
use rhizomatic::types::Delta;
use serde_json::Value;

/// The one feed rule a wrapped store breaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wrong {
    Nothing,
    // The check of each commit (§3.9.3).
    NoHeadOnlyRecord,
    NoAddingRecord,
    TwoRecords,
    RecordWithoutAdvance,
    OtherHead,
    AddsNothing,
    SettledDebtInRemoved,
    IdsOutOfOrder,
    CommitCheckNotOk,
    Refuses,
    MixesPeers,
    // Reading pages (§3.9.5).
    SilentGap,
    ResyncInWindow,
    ResyncWithTo,
    ResyncOnLaterPage,
    ResyncCurrent,
    Overstated,
    OutOfOrder,
    OutsideRange,
    ThroughPastRange,
    NoProgress,
    ThroughShort,
    ResyncAboveFloor,
    AnswersTwoWays,
    ReadsOnPastFloor,
    CurrentOffBelowFloor,
    RefusesBelowFloor,
    IdsOutOfOrderInRange,
    /// A right store: pages of at most 1, 2, 1, 2 records, call by call.
    AlternatesPageCap,
    ChangedAfterWritten,
    DiffersFirstSeen,
    // Retention (§3.9.4, §3.9.6).
    OkBelowFloorWithTo,
}

/// How the wrapped store is built and what it declares.
#[derive(Debug, Clone, Copy)]
struct Setup {
    /// The memory store inside.
    inner: MemoryStoreOptions,
    /// The retention the profile declares, when it is not the inner store's.
    declared: Option<ChangeRetention>,
    /// Every revision the store reports is this many times the inner one. Above 1, its
    /// revisions skip values.
    scale: u64,
}

const PLAIN: Setup = Setup {
    inner: MemoryStoreOptions {
        pushdown: rhizomatic::store::PushdownFields {
            timestamp_at_most: true,
            arrival_at_most: true,
            exclude_ids: true,
        },
        change_retention: ChangeRetention::Unbounded,
        change_page_size: None,
    },
    declared: None,
    scale: 1,
};
const DOUBLED: Setup = Setup { scale: 2, ..PLAIN };

/// A setup whose revisions are `scale` times the reference's, keeping `keep` records (or every
/// record), with pages of `page` records (or no limit).
const fn scaled(scale: u64, keep: Option<u64>, page: Option<u64>) -> Setup {
    Setup {
        inner: MemoryStoreOptions {
            change_retention: match keep {
                Some(n) => ChangeRetention::Revisions(n),
                None => ChangeRetention::Unbounded,
            },
            change_page_size: page,
            ..PLAIN.inner
        },
        scale,
        ..PLAIN
    }
}
/// Declares `{revisions: 2}` and keeps every record.
const KEEPS_MORE: Setup = Setup {
    declared: Some(ChangeRetention::Revisions(2)),
    ..PLAIN
};
/// Keeps two records, as it declares.
const KEEPS_TWO: Setup = scaled(1, Some(2), None);
const MALFORMED: Setup = Setup {
    declared: Some(ChangeRetention::Revisions(0)),
    ..PLAIN
};
const NO_FEED: Setup = Setup {
    declared: Some(ChangeRetention::None),
    ..PLAIN
};

/// What every handle of one wrapped store shares.
#[derive(Default)]
struct Books {
    /// Every peer created, in order.
    peers: Vec<String>,
    /// How many times each record was served, by peer and inner revision.
    served: BTreeMap<(String, u64), usize>,
    /// A peer whose last append or purge has not yet been read through `changes`.
    committed: BTreeSet<String>,
    /// The page a truncated read ended at, for each peer.
    pending: BTreeMap<String, Revision>,
    /// How many `changes` calls each peer has answered.
    calls: BTreeMap<String, usize>,
    /// The bounds of each peer's last `changes` call, and how many calls in a row asked them.
    last: BTreeMap<String, (Revision, Option<Revision>, usize)>,
    /// For each purge that advanced: every target that is not `not-held`, a settled debt too.
    settled: BTreeMap<(String, u64), Vec<String>>,
}

type Shared = Rc<RefCell<Books>>;

fn refusal(code: StoreErrorCode) -> StoreError {
    StoreError::new(code, "a wrong store refused")
}

struct Feedy {
    inner: Rc<MemoryStore>,
    wrong: Wrong,
    setup: Setup,
    profile: StoreProfile,
    books: Shared,
}

impl Feedy {
    fn new(wrong: Wrong, setup: Setup) -> Self {
        let inner = MemoryStore::with_options(setup.inner).unwrap();
        let mut profile = inner.profile().clone();
        profile.format_version = "rhizomatic.test.feed/1".into();
        if let Some(declared) = setup.declared {
            profile.change_retention = declared;
        }
        Self {
            inner: Rc::new(inner),
            wrong,
            setup,
            profile,
            books: Shared::default(),
        }
    }

    fn handle(&self, id: &str, inner: Box<dyn PeerStore>) -> Box<dyn PeerStore> {
        Box::new(FeedyPeer {
            inner,
            store: self.inner.clone(),
            id: id.to_string(),
            wrong: self.wrong,
            setup: self.setup,
            books: self.books.clone(),
        })
    }
}

impl Store for Feedy {
    fn profile(&self) -> &StoreProfile {
        &self.profile
    }
    fn create_peer(&self, id: &str, e: ErasurePosture) -> Result<Box<dyn PeerStore>, StoreError> {
        let inner = self.inner.create_peer(id, e)?;
        self.books.borrow_mut().peers.push(id.to_string());
        Ok(self.handle(id, inner))
    }
    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        Ok(self.handle(id, self.inner.peer(id)?))
    }
    fn open_admin(&self) -> Box<dyn Exporter> {
        self.inner.open_admin()
    }
    fn close(&self) {
        self.inner.close()
    }
}

struct FeedyPeer {
    inner: Box<dyn PeerStore>,
    store: Rc<MemoryStore>,
    id: String,
    wrong: Wrong,
    setup: Setup,
    books: Shared,
}

impl FeedyPeer {
    fn scale(&self) -> u64 {
        self.setup.scale
    }

    fn out(&self, revision: Revision) -> Revision {
        Revision(revision.0 * self.scale())
    }

    fn current(&self) -> Result<Revision, StoreError> {
        let mut snapshot = self.inner.read()?;
        let revision = snapshot.revision();
        snapshot.release();
        Ok(revision)
    }

    /// The inner feed in this store's own revisions (README §8, "Stores that must pass"). A
    /// scaled store asks the reference for `floor(from / k)` to `floor(to / k)`, and a complete
    /// page ends at the clamped `to` (SPEC-18 §4.13 reading 5), which need not be a multiple of
    /// k. It refuses `to < from` itself, and answers `resync-required` itself for a `from` above
    /// k times the reference's revision.
    fn feed(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreError> {
        let k = self.scale();
        if k == 1 {
            return self.inner.changes(from, to);
        }
        if to.is_some_and(|to| to < from) {
            return Err(refusal(StoreErrorCode::InvalidRequest));
        }
        let current = self.out(self.current()?);
        if from > current {
            return Ok(ChangePage::ResyncRequired { current });
        }
        let down = |r: Revision| Revision(r.0 / k);
        let mut answer = self.inner.changes(down(from), to.map(down))?;
        if self.wrong == Wrong::ReadsOnPastFloor
            && !from.0.is_multiple_of(k)
            && matches!(answer, ChangePage::ResyncRequired { .. })
        {
            // Reads on past the newest dropped record, which goes missing silently.
            answer = self
                .inner
                .changes(Revision(down(from).0 + 1), to.map(down))?;
        }
        match answer {
            ChangePage::Ok { records, through } => {
                let end = to.map_or(current, |to| to.min(current));
                // The reference's page is complete when it reaches its own clamped `to`.
                let inner_current = down(current);
                let complete =
                    through == to.map_or(inner_current, |to| down(to).min(inner_current));
                let records: Vec<ChangeRecord> = records
                    .into_iter()
                    .map(|record| ChangeRecord {
                        revision: self.out(record.revision),
                        ..record
                    })
                    .collect();
                let through = match (complete, records.last()) {
                    (false, Some(last)) => last.revision,
                    _ => end,
                };
                Ok(ChangePage::Ok { records, through })
            }
            ChangePage::ResyncRequired { current } => Ok(ChangePage::ResyncRequired {
                current: self.out(current),
            }),
        }
    }

    /// Each record's ids together with the ids other peers' records name at the same revision.
    fn mixed(&self, records: &mut [ChangeRecord]) -> Result<(), StoreError> {
        let others: Vec<String> = self
            .books
            .borrow()
            .peers
            .iter()
            .filter(|peer| **peer != self.id)
            .cloned()
            .collect();
        for other in others {
            let peer = self.store.peer(&other)?;
            for record in records.iter_mut() {
                let r = record.revision.0;
                let below = Revision(r.saturating_sub(1));
                if let Ok(ChangePage::Ok {
                    records: theirs, ..
                }) = peer.changes(below, Some(Revision(r)))
                {
                    for theirs in theirs.into_iter().filter(|t| t.revision.0 == r) {
                        record.added.extend(theirs.added);
                    }
                }
                record.added.sort();
                record.added.dedup();
            }
        }
        Ok(())
    }

    fn served(&self, record: &ChangeRecord) -> usize {
        let mut books = self.books.borrow_mut();
        let count = books
            .served
            .entry((self.id.clone(), record.revision.0))
            .or_default();
        *count += 1;
        *count
    }
}

impl PeerStore for FeedyPeer {
    fn history(&self) -> &str {
        self.inner.history()
    }
    fn id(&self) -> &str {
        &self.id
    }
    fn erasure(&self) -> PeerErasure {
        self.inner.erasure()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        Ok(Box::new(FeedySnapshot {
            revision: self.out(self.inner.read()?.revision()),
            inner: self.inner.read()?,
        }))
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.books.borrow_mut().committed.insert(self.id.clone());
        match self.inner.append(batch)? {
            AppendResult::Committed { revision, added } => Ok(AppendResult::Committed {
                revision: self.out(revision),
                added,
            }),
            other => Ok(other),
        }
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        self.books.borrow_mut().committed.insert(self.id.clone());
        let before = self.current()?;
        let mut report = self.inner.purge(ids)?;
        if report.revision > before {
            let ended: Vec<String> = report
                .targets
                .iter()
                .filter(|t| t.outcome != PurgeOutcome::NotHeld)
                .map(|t| t.id.clone())
                .collect();
            let key = (self.id.clone(), report.revision.0);
            self.books.borrow_mut().settled.insert(key, ended);
        }
        report.revision = self.out(report.revision);
        Ok(report)
    }

    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreError> {
        let w = self.wrong;
        let just_committed = self.books.borrow_mut().committed.remove(&self.id);
        let pending = self.books.borrow_mut().pending.remove(&self.id);
        let current = self.out(self.current()?);
        match w {
            Wrong::Refuses => return Err(refusal(StoreErrorCode::InvalidRequest)),
            Wrong::ResyncWithTo if to.is_some() => {
                return Ok(ChangePage::ResyncRequired { current })
            }
            Wrong::CommitCheckNotOk if just_committed => {
                return Ok(ChangePage::ResyncRequired { current })
            }
            Wrong::ResyncOnLaterPage if pending == Some(from) => {
                return Ok(ChangePage::ResyncRequired { current })
            }
            Wrong::OkBelowFloorWithTo if to.is_none() && from.0 < current.0.saturating_sub(2) => {
                return Ok(ChangePage::ResyncRequired { current })
            }
            Wrong::ResyncAboveFloor => {
                // The inner store keeps two records, so its floor is two below its revision.
                let k = self.scale();
                let floor = (current.0 / k).saturating_sub(2) * k;
                if floor > 0 && from.0 > floor && from.0 < floor + k {
                    return Ok(ChangePage::ResyncRequired { current });
                }
            }
            _ => {}
        }
        let (mut records, mut through) = match self.feed(from, to)? {
            ChangePage::Ok { records, through } => (records, through),
            ChangePage::ResyncRequired { current } => {
                let below_floor = from <= current;
                let current = match w {
                    Wrong::ResyncCurrent => Revision(current.0 + 1),
                    Wrong::CurrentOffBelowFloor if below_floor => Revision(current.0 + 1),
                    Wrong::RefusesBelowFloor if below_floor => {
                        return Err(refusal(StoreErrorCode::InvalidRequest))
                    }
                    _ => current,
                };
                return Ok(ChangePage::ResyncRequired { current });
            }
        };
        let several = records.len() >= 2;
        let end = to.map_or(current, |to| to.min(current));
        // After a first commit, the commit check, the check after the step and its re-ask
        // (check 14) make the same call three times in a row. The third answers differently.
        let again = {
            let mut books = self.books.borrow_mut();
            let run = books.last.entry(self.id.clone()).or_insert((from, to, 0));
            if (run.0, run.1) == (from, to) && !records.is_empty() {
                run.2 += 1;
            } else {
                *run = (from, to, usize::from(!records.is_empty()));
            }
            run.2 == 3
        };
        match w {
            Wrong::NoHeadOnlyRecord => {
                records.retain(|r| !(r.added.is_empty() && r.removed.is_empty()))
            }
            Wrong::NoAddingRecord => records.retain(|r| r.added.is_empty()),
            Wrong::TwoRecords => {
                records = records.into_iter().flat_map(|r| [r.clone(), r]).collect()
            }
            Wrong::RecordWithoutAdvance if just_committed && records.is_empty() => {
                records.push(ChangeRecord {
                    revision: from,
                    head: self.inner.read()?.head().map(str::to_string),
                    added: Vec::new(),
                    removed: Vec::new(),
                })
            }
            Wrong::OtherHead => {
                for r in &mut records {
                    r.head = Some("a-head-nobody-wrote".into());
                }
            }
            Wrong::AddsNothing => records.iter_mut().for_each(|r| r.added.clear()),
            Wrong::SettledDebtInRemoved => {
                let books = self.books.borrow();
                for r in &mut records {
                    if let Some(ended) = books.settled.get(&(self.id.clone(), r.revision.0)) {
                        r.removed = ended.clone();
                    }
                }
            }
            Wrong::IdsOutOfOrder => records.iter_mut().for_each(|r| r.added.reverse()),
            Wrong::IdsOutOfOrderInRange if several => {
                records.iter_mut().for_each(|r| r.added.reverse())
            }
            Wrong::AlternatesPageCap => {
                let cap = {
                    let mut books = self.books.borrow_mut();
                    let calls = books.calls.entry(self.id.clone()).or_default();
                    *calls += 1;
                    if *calls % 2 == 1 {
                        1
                    } else {
                        2
                    }
                };
                if records.len() > cap {
                    records.truncate(cap);
                    through = records[cap - 1].revision;
                }
            }
            Wrong::MixesPeers => self.mixed(&mut records)?,
            Wrong::SilentGap if several => {
                records.remove(0);
            }
            Wrong::ResyncInWindow if several => return Ok(ChangePage::ResyncRequired { current }),
            Wrong::ResyncOnLaterPage if several => {
                records.truncate(1);
                through = records[0].revision;
                self.books
                    .borrow_mut()
                    .pending
                    .insert(self.id.clone(), through);
            }
            Wrong::Overstated if several => {
                records.pop();
            }
            Wrong::OutOfOrder if several => records.reverse(),
            Wrong::OutsideRange if several => {
                let last = records.last().unwrap().clone();
                records.push(ChangeRecord {
                    revision: Revision(last.revision.0 + 1),
                    ..last
                });
            }
            Wrong::ThroughPastRange if several => through.0 += 1,
            Wrong::NoProgress if several => {
                records.clear();
                through = from;
            }
            Wrong::ThroughShort if through < end && !records.is_empty() => {
                through = Revision(records.last().unwrap().revision.0 + 1);
            }
            Wrong::AnswersTwoWays if again => {
                for r in &mut records {
                    r.head = Some("a-head-for-the-second-asker".into());
                }
            }
            Wrong::ChangedAfterWritten | Wrong::DiffersFirstSeen => {
                // The first serve of a record is the check of its commit, the second the check
                // after that step, the third that check asking again (check 14).
                let from_serve = if w == Wrong::ChangedAfterWritten {
                    4
                } else {
                    2
                };
                for r in &mut records {
                    if self.served(r) >= from_serve {
                        r.head = Some("a-head-rewritten-later".into());
                    }
                }
            }
            _ => {}
        }
        Ok(ChangePage::Ok { records, through })
    }
}

struct FeedySnapshot {
    inner: Box<dyn Snapshot>,
    revision: Revision,
}

impl Snapshot for FeedySnapshot {
    fn history(&self) -> &str {
        self.inner.history()
    }
    fn revision(&self) -> Revision {
        self.revision
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
    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.targets(entities)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.negators(ids)
    }
    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        self.inner.scope(request)
    }
    fn release(&mut self) {
        self.inner.release()
    }
}

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

fn run_with(
    wrong: Wrong,
    setup: Setup,
    vectors: &StoreVectors,
) -> Result<StoreConformanceReport, StoreConformanceError> {
    run_store_conformance(
        &|| Ok(Box::new(Feedy::new(wrong, setup)) as Box<dyn Store>),
        vectors,
    )
}

const FEED_SCRIPTS: [&str; 4] = [
    "feed-appends-and-head-only-commits",
    "feed-purge-and-debts",
    "feed-a-debt-ends-on-append",
    "feed-two-peers-interleaved",
];

/// The steps of one script, by name.
fn steps<'a>(vectors: &'a mut StoreVectors, script: &str) -> &'a mut Vec<Value> {
    vectors.scripts["scripts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["name"] == script)
        .unwrap()["steps"]
        .as_array_mut()
        .unwrap()
}

/// The first `changes` step of a script with this `from` name and no `to`.
fn changes_from<'a>(vectors: &'a mut StoreVectors, script: &str, from: &str) -> &'a mut Value {
    steps(vectors, script)
        .iter_mut()
        .find(|s| s["op"] == "changes" && s["from"]["revision"] == from && s.get("to").is_none())
        .unwrap()
}

fn an_unknown_revision_name(vectors: &mut StoreVectors) {
    changes_from(vectors, FEED_SCRIPTS[0], "A.1")["from"]["revision"] = "A.99".into();
}

fn a_revision_of_another_peer(vectors: &mut StoreVectors) {
    changes_from(vectors, FEED_SCRIPTS[3], "A.0")["from"]["revision"] = "B.0".into();
}

fn a_revision_named_twice(vectors: &mut StoreVectors) {
    let append = steps(vectors, FEED_SCRIPTS[0])
        .iter_mut()
        .find(|s| s["op"] == "append")
        .unwrap();
    append["revisionAs"] = "A.0".into();
}

fn a_mark_before_its_peer(vectors: &mut StoreVectors) {
    let steps = steps(vectors, FEED_SCRIPTS[0]);
    let mark = steps.iter().position(|s| s["op"] == "mark").unwrap();
    let step = steps.remove(mark);
    steps.insert(0, step);
}

fn a_record_too_few(vectors: &mut StoreVectors) {
    let step = changes_from(vectors, FEED_SCRIPTS[0], "middle");
    step["expect"]["records"].as_array_mut().unwrap().pop();
}

fn a_resync_where_the_feed_is_kept(vectors: &mut StoreVectors) {
    let step = changes_from(vectors, FEED_SCRIPTS[0], "A.1");
    step["expect"] = serde_json::json!({ "status": "resync-required" });
}

/// Only the scripts with no `changes` step: the check after every step alone sees the store.
fn without_feed_scripts(vectors: &mut StoreVectors) {
    vectors.scripts["scripts"]
        .as_array_mut()
        .unwrap()
        .retain(|s| !FEED_SCRIPTS.contains(&s["name"].as_str().unwrap()));
}

fn an_ahead(vectors: &mut StoreVectors, ahead: Value) {
    let step = steps(vectors, FEED_SCRIPTS[0])
        .iter_mut()
        .find(|s| s["op"] == "changes" && s["from"].get("ahead").is_some())
        .unwrap();
    step["from"]["ahead"] = ahead;
}

fn a_negative_ahead(vectors: &mut StoreVectors) {
    an_ahead(vectors, serde_json::json!(-1));
}

fn a_fractional_ahead(vectors: &mut StoreVectors) {
    an_ahead(vectors, serde_json::json!(1.5));
}

fn feed_scripts_without_requires(vectors: &mut StoreVectors) {
    for script in FEED_SCRIPTS {
        vectors.scripts["scripts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["name"] == script)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("requires");
    }
}

struct Row {
    rule: &'static str,
    wrong: Wrong,
    setup: Setup,
    /// A wrong document, for the rules no wrong store reaches.
    doc: Option<fn(&mut StoreVectors)>,
    /// Every failure carries one of these, and each appears at least once.
    messages: &'static [&'static str],
    /// The documents that fail: `scripts`, `scope`, or both.
    docs: &'static [&'static str],
}

const S: &[&str] = &["scripts"];
const SC: &[&str] = &["scripts", "scope"];

const fn row(
    rule: &'static str,
    wrong: Wrong,
    messages: &'static [&'static str],
    docs: &'static [&'static str],
) -> Row {
    Row {
        rule,
        wrong,
        setup: PLAIN,
        doc: None,
        messages,
        docs,
    }
}

const fn doc_row(
    rule: &'static str,
    setup: Setup,
    doc: fn(&mut StoreVectors),
    messages: &'static [&'static str],
) -> Row {
    Row {
        rule,
        wrong: Wrong::Nothing,
        setup,
        doc: Some(doc),
        messages,
        docs: S,
    }
}

use Wrong as W;

const TABLE: &[Row] = &[
    // The check of each commit (§3.9.3).
    row(
        "no record for a head-only commit",
        W::NoHeadOnlyRecord,
        &["the head-only commit to revision"],
        S,
    ),
    row(
        "no record for a commit that adds",
        W::NoAddingRecord,
        &["wrote no record"],
        SC,
    ),
    row(
        "two records for one commit",
        W::TwoRecords,
        &["wrote records at"],
        SC,
    ),
    row(
        "a record for a step that did not advance",
        W::RecordWithoutAdvance,
        &["a step that did not advance the revision wrote a record"],
        S,
    ),
    row(
        "a record with another head",
        W::OtherHead,
        &["has head Some(\"a-head-nobody-wrote\")"],
        SC,
    ),
    row(
        "a record that adds nothing",
        W::AddsNothing,
        &["adds [], expected"],
        SC,
    ),
    row(
        "a settled debt in removed",
        W::SettledDebtInRemoved,
        &["removes ["],
        S,
    ),
    row(
        "ids out of order inside a record",
        W::IdsOutOfOrder,
        &["a record's ids are not ascending and distinct"],
        SC,
    ),
    row(
        "a commit check that is not ok",
        W::CommitCheckNotOk,
        &["changes from the revision before a commit is not ok"],
        SC,
    ),
    row(
        "changes that refuses",
        W::Refuses,
        &["changes refused with invalid-request"],
        SC,
    ),
    row(
        "two peers mixed in one feed",
        W::MixesPeers,
        &["never held"],
        SC,
    ),
    // Reading pages (§3.9.5).
    row(
        "a silent gap",
        W::SilentGap,
        &["the feed has no record for revision"],
        SC,
    ),
    row(
        "a resync inside the window, after a step",
        W::ResyncInWindow,
        &["changes answered resync-required from 0, and every record after 0 is retained"],
        SC,
    ),
    row(
        "a resync inside the window, in a changes step with a to",
        W::ResyncWithTo,
        &["and every record after", "is retained"],
        S,
    ),
    row(
        "a resync on a later page",
        W::ResyncOnLaterPage,
        &["changes answered resync-required in the middle of a range"],
        SC,
    ),
    row(
        "a resync with another current",
        W::ResyncCurrent,
        &["a resync answer carries current"],
        S,
    ),
    row(
        "an overstated page",
        W::Overstated,
        &["the page claims through"],
        SC,
    ),
    row(
        "records out of order",
        W::OutOfOrder,
        &["the page's records are not ascending by revision"],
        SC,
    ),
    row(
        "a record outside the range",
        W::OutsideRange,
        &["a record lies outside the range"],
        SC,
    ),
    row(
        "a through past the range",
        W::ThroughPastRange,
        &["lies outside ["],
        SC,
    ),
    row(
        "no progress on a range with records",
        W::NoProgress,
        &["made no progress toward"],
        SC,
    ),
    Row {
        rule: "a through past its last record and short of the range",
        wrong: W::ThroughShort,
        setup: scaled(2, None, Some(1)),
        doc: None,
        messages: &["is past its last record and short of"],
        docs: SC,
    },
    Row {
        rule: "resync-required between the newest dropped and the oldest kept revision",
        wrong: W::ResyncAboveFloor,
        setup: scaled(3, Some(2), None),
        doc: None,
        messages: &["above the retention floor"],
        docs: SC,
    },
    row(
        "a page that answers differently when asked again",
        W::AnswersTwoWays,
        &["changes answered differently after the caller changed what it returned"],
        SC,
    ),
    Row {
        rule:
            "ok just below the floor, revisions times 3, reading on past the newest dropped record",
        wrong: W::ReadsOnPastFloor,
        setup: scaled(3, Some(2), None),
        doc: None,
        messages: &["below the retention floor"],
        docs: SC,
    },
    Row {
        rule:
            "ok just below the floor, revisions times 2, reading on past the newest dropped record",
        wrong: W::ReadsOnPastFloor,
        setup: scaled(2, Some(2), None),
        doc: None,
        messages: &["below the retention floor"],
        docs: SC,
    },
    Row {
        rule: "a wrong current on the call below the floor only, with no changes step",
        wrong: W::CurrentOffBelowFloor,
        setup: KEEPS_TWO,
        doc: Some(without_feed_scripts),
        messages: &["a resync answer carries current"],
        docs: SC,
    },
    Row {
        rule: "changes refuses where it must answer resync-required",
        wrong: W::RefusesBelowFloor,
        setup: KEEPS_TWO,
        doc: Some(without_feed_scripts),
        messages: &["changes refused with invalid-request"],
        docs: SC,
    },
    row(
        "ids out of order inside a record, in a range of two or more",
        W::IdsOutOfOrderInRange,
        &["a record's ids are not ascending and distinct"],
        SC,
    ),
    row(
        "a record changed after it was written",
        W::ChangedAfterWritten,
        &["changed after it was written"],
        SC,
    ),
    row(
        "a record that differs from its commit the first time it is seen",
        W::DiffersFirstSeen,
        &["differs from its commit"],
        SC,
    ),
    // Retention (§3.9.4, §3.9.6).
    Row {
        rule: "{revisions: 2} and ok below the floor, after a step",
        wrong: W::Nothing,
        setup: KEEPS_MORE,
        doc: None,
        messages: &["changes answered ok from 0, below the retention floor 1"],
        docs: SC,
    },
    Row {
        rule: "{revisions: 2} and ok below the floor, in a changes step with a to",
        wrong: W::OkBelowFloorWithTo,
        setup: KEEPS_MORE,
        doc: None,
        messages: &["below the retention floor"],
        docs: S,
    },
    Row {
        rule: "a profile that keeps more records than 2^53 - 1",
        wrong: W::Nothing,
        setup: Setup {
            declared: Some(ChangeRetention::Revisions(MAX_REVISION + 1)),
            ..PLAIN
        },
        doc: None,
        messages: &["the profile's changeRetention is not none, unbounded or {revisions: n}"],
        docs: SC,
    },
    Row {
        rule: "a profile whose changeRetention is malformed",
        wrong: W::Nothing,
        setup: MALFORMED,
        doc: None,
        messages: &["the profile's changeRetention is not none, unbounded or {revisions: n}"],
        docs: SC,
    },
    // Documents (§3.9.6).
    doc_row(
        "documents: an unknown revision name",
        PLAIN,
        an_unknown_revision_name,
        &["the vector names an unknown revision A.99"],
    ),
    doc_row(
        "documents: a revision name of another peer",
        PLAIN,
        a_revision_of_another_peer,
        &["the vector names revision B.0 of another peer"],
    ),
    doc_row(
        "documents: a revision name given twice",
        PLAIN,
        a_revision_named_twice,
        &["the vector names revision A.0 twice"],
    ),
    doc_row(
        "documents: a mark before its peer",
        PLAIN,
        a_mark_before_its_peer,
        &["the vector uses peer A before creating it"],
    ),
    doc_row(
        "documents: changes records that are wrong",
        PLAIN,
        a_record_too_few,
        &["changes answered the records of"],
    ),
    doc_row(
        "documents: a changes status that is wrong",
        PLAIN,
        a_resync_where_the_feed_is_kept,
        &["changes answered ok from 1, and the step expects resync-required"],
    ),
    doc_row(
        "documents: a negative ahead",
        PLAIN,
        a_negative_ahead,
        &["the vector's ahead is not a whole number"],
    ),
    doc_row(
        "documents: a fractional ahead",
        PLAIN,
        a_fractional_ahead,
        &["the vector's ahead is not a whole number"],
    ),
    doc_row(
        "documents: a changes step on a store without a feed",
        NO_FEED,
        feed_scripts_without_requires,
        &["a changes step on a store that serves no feed"],
    ),
];

/// What is wrong with one row's run, or nothing.
fn judge(row: &Row) -> Option<String> {
    let mut vectors = vectors();
    if let Some(doc) = row.doc {
        doc(&mut vectors);
    }
    let error = match run_with(row.wrong, row.setup, &vectors) {
        Ok(report) => {
            return Some(format!(
                "passed {} with nothing failed",
                report.passed.len()
            ))
        }
        Err(error) => error,
    };
    let mut problems = Vec::new();
    for failure in &error.failures {
        if !row.messages.iter().any(|m| failure.message.contains(m)) {
            problems.push(format!(
                "{} failed for another reason: {}",
                failure.name, failure.message
            ));
        }
    }
    for message in row.messages {
        if !error.failures.iter().any(|f| f.message.contains(message)) {
            problems.push(format!("no failure carries {message:?}"));
        }
    }
    let docs: BTreeSet<&str> = error
        .failures
        .iter()
        .map(|f| f.name.split('/').next().unwrap())
        .collect();
    if docs != row.docs.iter().copied().collect() {
        problems.push(format!("failed in {docs:?}, expected {:?}", row.docs));
    }
    (!problems.is_empty()).then(|| problems.join("\n    "))
}

#[test]
fn every_feed_rule_fails_its_wrong_store() {
    let red: Vec<String> = TABLE
        .iter()
        .filter_map(|row| judge(row).map(|problem| format!("{}: {problem}", row.rule)))
        .collect();
    assert!(
        red.is_empty(),
        "{} of {} feed rules did not hold:\n  {}",
        red.len(),
        TABLE.len(),
        red.join("\n  ")
    );
}

#[test]
fn every_wrong_feed_in_the_table_is_distinct() {
    let mut seen = BTreeSet::new();
    for row in TABLE {
        assert!(seen.insert(row.rule), "{} is listed twice", row.rule);
    }
}

/// The controls: the faithful wrapper passes; so do stores whose revisions skip values, a store
/// whose pages hold one record, a store whose page cap alternates 1, 2, 1, 2, and stores that keep two records and one, with and without pages
/// of one record. None of them skips a script.
#[test]
fn the_same_feeds_conform_where_no_rule_forbids_them() {
    let paged = |retention, size| Setup {
        inner: MemoryStoreOptions {
            change_retention: retention,
            change_page_size: size,
            ..PLAIN.inner
        },
        ..PLAIN
    };
    let setups = [
        (W::Nothing, PLAIN),
        // README §8, "Stores that must pass": revisions that skip values (§4.13 reading 21).
        (W::Nothing, DOUBLED),
        (W::Nothing, scaled(3, None, Some(1))),
        (W::Nothing, scaled(2, Some(2), None)),
        (W::Nothing, scaled(3, Some(2), Some(1))),
        // The fifth: the same request gets another prefix (§4.13 reading 23).
        (W::AlternatesPageCap, PLAIN),
        (W::Nothing, paged(ChangeRetention::Unbounded, Some(1))),
        (W::Nothing, paged(ChangeRetention::Revisions(2), None)),
        (W::Nothing, paged(ChangeRetention::Revisions(1), None)),
        (W::Nothing, paged(ChangeRetention::Revisions(2), Some(1))),
    ];
    for (wrong, setup) in setups {
        let report = run_with(wrong, setup, &vectors())
            .unwrap_or_else(|failures| panic!("{wrong:?} {setup:?}: {failures}"));
        assert_eq!(
            (report.passed.len(), report.skipped.len()),
            (25 + 15, 0),
            "{wrong:?} {setup:?}"
        );
    }
}

/// README §3 and §3.9: a store whose retention is `none` skips exactly the four feed scripts,
/// reports `changes` as what each lacks, and passes the rest with no feed check.
#[test]
fn a_store_without_a_feed_skips_the_feed_scripts() {
    let report = run_with(W::Nothing, NO_FEED, &vectors()).unwrap_or_else(|e| panic!("{e}"));
    let skipped: Vec<SkippedScript> = FEED_SCRIPTS
        .iter()
        .map(|name| SkippedScript {
            name: format!("scripts/{name}"),
            missing: "changes".into(),
        })
        .collect();
    assert_eq!(report.skipped, skipped);
    assert_eq!(report.passed.len(), 21 + 15);

    // A store without a feed whose `changes` would refuse every call still passes: the runner
    // makes no feed check on it.
    let refusing = run_with(W::Refuses, NO_FEED, &vectors()).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(refusing.passed.len(), 21 + 15);
}

/// Every script and the scope setup that commit twice to one peer: a wrong page that needs two
/// pending records shows in the check after their second commit.
const TWO_COMMITS: [&str; 21] = [
    "scripts/negation-chains",
    "scripts/negation-before-its-target",
    "scripts/duplicates-add-nothing",
    "scripts/head-compare-and-set",
    "scripts/a-refused-append-leaves-nothing",
    "scripts/two-peers-share-bytes",
    "scripts/purge",
    "scripts/purge-clears-a-debt-on-append",
    "scripts/snapshots",
    "scripts/a-snapshot-across-a-purge",
    "scripts/the-last-sequence-survives-a-purge",
    "scripts/the-last-sequence-survives-an-empty-peer",
    "scripts/a-skipped-entry-spends-no-sequence",
    "scripts/the-first-appearance-is-kept",
    "scripts/an-older-handle-stays-valid",
    "scripts/append-checks-before-and-after-the-head",
    "scripts/feed-appends-and-head-only-commits",
    "scripts/feed-purge-and-debts",
    "scripts/feed-a-debt-ends-on-append",
    "scripts/feed-two-peers-interleaved",
    "scope/setup",
];

/// The broken feeds of the slice 3 plan (§4), each in the documents it fails, for its reason.
#[test]
fn the_broken_feeds_fail_where_their_fault_first_shows() {
    let failed = |wrong: Wrong, reason: &str| -> Vec<String> {
        let error = run_with(wrong, PLAIN, &vectors()).expect_err("a broken feed must fail");
        for failure in &error.failures {
            assert!(
                failure.message.contains(reason),
                "{wrong:?} failed {} for another reason: {}",
                failure.name,
                failure.message
            );
        }
        error.failures.into_iter().map(|f| f.name).collect()
    };
    assert_eq!(
        failed(W::NoHeadOnlyRecord, "the head-only commit to revision"),
        [
            "scripts/duplicates-add-nothing",
            "scripts/a-skipped-entry-spends-no-sequence",
            "scripts/the-first-appearance-is-kept",
            "scripts/append-checks-before-and-after-the-head",
            "scripts/feed-appends-and-head-only-commits",
            "scripts/feed-two-peers-interleaved",
        ]
    );
    // Only one purge in the vectors settles a debt and releases another id at once.
    assert_eq!(
        failed(W::SettledDebtInRemoved, "the record of revision 3 removes"),
        ["scripts/feed-purge-and-debts"]
    );
    for (wrong, reason) in [
        (W::SilentGap, "the feed has no record for revision 1"),
        (
            W::ResyncInWindow,
            "changes answered resync-required from 0, and every record after 0 is retained",
        ),
        (
            W::Overstated,
            "the page claims through 2 and leaves out the record at 2",
        ),
        (
            W::OutOfOrder,
            "the page's records are not ascending by revision",
        ),
    ] {
        assert_eq!(failed(wrong, reason), TWO_COMMITS, "{wrong:?}");
    }
    assert_eq!(
        failed(W::MixesPeers, "never held"),
        [
            "scripts/two-peers-share-bytes",
            "scripts/purge",
            "scripts/feed-purge-and-debts",
            "scripts/feed-a-debt-ends-on-append",
            "scripts/feed-two-peers-interleaved",
            "scope/setup",
        ]
    );
}
