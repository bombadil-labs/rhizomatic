//! `with_snapshot` (SPEC-18 §4.13 readings 127 to 129) over the memory store. Real movement is a
//! purge through the same peer between two calls of the body (`move_by_purge`). Refusals that a
//! store cannot be made to give on demand come from a peer whose `read` the test wraps; the
//! function has no hook. The clock is a closure over a value the test sets: no test sleeps. The
//! cases are the contract tests of the TypeScript `test/store-with-snapshot.test.ts` that apply
//! to a memory store and to Rust's types.

use std::cell::{Cell, RefCell};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

use crate::refused::as_refusal;
use rhizomatic::memory_store::MemoryStore;
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    AppendResult, ArrivalRecord, ChangePage, CreatePeerOptions, ErasurePosture, IntegrityFault,
    IntegrityFaultKind, PeerErasure, PeerStore, PurgeReport, Revision, ScopeRequest, ScopeResult,
    Snapshot, Store, StoreError, StoreErrorCode, StoreFailure, MAX_REVISION,
};
use rhizomatic::store_admission::{admission_of, AdmissionOptions};
use rhizomatic::store_fresh::{FeedError, StoreFault};
use rhizomatic::store_read::{fetch_scope, read_anchored, ReadRequest, Selection, StoreReadError};
use rhizomatic::store_with_snapshot::{with_snapshot, OnSnapshot, SnapshotRetry, SNAPSHOT_RETRIES};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Target};

use crate::move_snapshot::move_by_purge;

const X: &str = "entity:x";
const Y: &str = "entity:y";

thread_local! {
    static STAMP: Cell<u64> = const { Cell::new(0) };
}

fn fact(entity: &str) -> Delta {
    let timestamp = STAMP.with(|s| {
        s.set(s.get() + 1);
        s.get() as f64
    });
    let claims = Claims {
        timestamp,
        valid_from: 0.0,
        valid_until: None,
        author: "did:key:zWithSnapshot".into(),
        pointers: vec![Pointer {
            role: "about".into(),
            target: Target::Entity(EntityRef {
                id: entity.into(),
                context: None,
            }),
        }],
    };
    make_delta(claims, None).unwrap()
}

/// Appends one new delta at each entity, numbered from the peer's own last sequence.
fn write(peer: &dyn PeerStore, entities: &[&str]) {
    let deltas: Vec<Delta> = entities.iter().map(|e| fact(e)).collect();
    let snapshot = peer.read().unwrap();
    let head = format!("head-{}", snapshot.last_sequence() + 1);
    let options = AdmissionOptions {
        at: 1.0,
        sender: "test".into(),
        next_head: head,
    };
    let batch = admission_of(snapshot.as_ref(), &deltas, options).unwrap();
    let result = peer.append(&batch).unwrap();
    assert!(
        matches!(result, AppendResult::Committed { .. }),
        "{result:?}"
    );
}

/// A store with one peer that holds one delta at X and one at Y.
fn seeded() -> (MemoryStore, Box<dyn PeerStore>) {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:p", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap();
    write(peer.as_ref(), &[X, Y]);
    (store, peer)
}

fn entities(of: &[&str]) -> Vec<String> {
    of.iter().map(|e| e.to_string()).collect()
}

/// The peer, with its `read` watched: each call is counted, the first refusals come from a list,
/// a snapshot can report another revision, and each snapshot counts its releases.
struct Watched<'a> {
    inner: &'a dyn PeerStore,
    refusals: RefCell<Vec<StoreError>>,
    revision: Option<Revision>,
    reads: Cell<usize>,
    taken: RefCell<Vec<Rc<Cell<usize>>>>,
}

fn watched(inner: &dyn PeerStore) -> Watched<'_> {
    Watched {
        inner,
        refusals: RefCell::new(Vec::new()),
        revision: None,
        reads: Cell::new(0),
        taken: RefCell::new(Vec::new()),
    }
}

impl Watched<'_> {
    /// How many times each snapshot taken was released.
    fn releases(&self) -> Vec<usize> {
        self.taken.borrow().iter().map(|r| r.get()).collect()
    }
}

struct Tracked {
    inner: Box<dyn Snapshot>,
    revision: Option<Revision>,
    released: Rc<Cell<usize>>,
}

impl PeerStore for Watched<'_> {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn erasure(&self) -> PeerErasure {
        self.inner.erasure()
    }
    fn history(&self) -> Result<&str, StoreError> {
        self.inner.history()
    }
    fn app_format(&self) -> Result<Option<&str>, StoreError> {
        self.inner.app_format()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        self.reads.set(self.reads.get() + 1);
        let mut refusals = self.refusals.borrow_mut();
        if !refusals.is_empty() {
            return Err(refusals.remove(0));
        }
        let released = Rc::new(Cell::new(0));
        self.taken.borrow_mut().push(released.clone());
        Ok(Box::new(Tracked {
            inner: self.inner.read()?,
            revision: self.revision,
            released,
        }))
    }
    fn append(&self, batch: &rhizomatic::store::Admission) -> Result<AppendResult, StoreError> {
        self.inner.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreFailure> {
        self.inner.purge(ids)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreFailure> {
        self.inner.changes(from, to)
    }
}

impl Snapshot for Tracked {
    fn revision(&self) -> Revision {
        self.revision.unwrap_or_else(|| self.inner.revision())
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
    fn last_sequence(&self) -> u64 {
        self.inner.last_sequence()
    }
    fn last_transfer(&self) -> u64 {
        self.inner.last_transfer()
    }
    fn root(&self) -> Option<&str> {
        self.inner.root()
    }
    fn digest(&self, prefix: &str) -> Result<rhizomatic::store_digest::DigestNode, StoreFailure> {
        self.inner.digest(prefix)
    }
    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreFailure> {
        self.inner.get(ids)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreFailure> {
        self.inner.arrivals(ids)
    }
    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreFailure> {
        self.inner.targets(entities)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreFailure> {
        self.inner.negators(ids)
    }
    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreFailure> {
        self.inner.scope(request)
    }
    fn release(&mut self) {
        self.released.set(self.released.get() + 1);
        self.inner.release();
    }
}

fn moved(why: &str) -> StoreError {
    StoreError::new(StoreErrorCode::SnapshotMoved, why)
}

fn code<T>(result: &Result<T, FeedError>) -> String {
    match result {
        Ok(_) => "answered".into(),
        Err(FeedError::Refused(e)) => e.code.as_str().into(),
        Err(other) => format!("not a refusal: {other}"),
    }
}

/// A body that reads X, moves the peer by a purge, and reads Y on the moved snapshot.
fn always_moved(
    peer: &dyn PeerStore,
) -> impl FnMut(&dyn Snapshot, usize) -> Result<(), FeedError> + '_ {
    move |snapshot, _| {
        snapshot.targets(&entities(&[X]))?;
        move_by_purge(peer);
        snapshot.targets(&entities(&[Y]))?;
        Ok(())
    }
}

#[test]
fn runs_targets_get_fetch_scope_and_read_anchored_on_one_snapshot_one_read_one_revision_one_release(
) {
    let (_store, peer) = seeded();
    write(peer.as_ref(), &[X]);
    let leaf = parse_term(&serde_json::json!({
        "op": "group",
        "key": "byTargetContext",
        "in": {
            "op": "select",
            "pred": { "hasPointer": { "targetEntity": { "var": "root" } } },
            "in": { "op": "mask", "policy": "drop", "in": "input" }
        }
    }))
    .unwrap();
    let watch = watched(peer.as_ref());
    let OnSnapshot { value, attempts } = with_snapshot(
        &watch,
        |snapshot, _| {
            let ids = snapshot.targets(&entities(&[X]))?;
            let got = snapshot.get(&ids)?;
            let fetched = fetch_scope(snapshot, &entities(&[X]), Selection::default())?;
            let read = read_anchored(snapshot, ReadRequest::new(&leaf, X, 10.0))?;
            Ok::<_, StoreReadError>((snapshot.revision(), ids, got, fetched, read))
        },
        &SnapshotRetry::default(),
    )
    .unwrap();
    let (at, ids, got, fetched, read) = value;
    assert_eq!((attempts, watch.reads.get()), (1, 1));
    assert_eq!((fetched.revision, read.revision), (at, at));
    assert_eq!(ids.len(), 2);
    assert_eq!(got.iter().map(|d| d.id.clone()).collect::<Vec<_>>(), ids);
    let mut members: Vec<String> = fetched.source.ids().into_iter().map(String::from).collect();
    members.sort();
    assert_eq!(members, ids);
    assert_eq!(watch.releases(), vec![1]);
}

#[test]
fn an_append_at_x_and_a_purge_between_two_calls_of_the_body_start_it_again_attempts_2_and_every_part_of_the_answer_is_at_the_new_revision_with_both_deltas_at_x(
) {
    let (_store, peer) = seeded();
    let before = with_snapshot(
        peer.as_ref(),
        |s, _| Ok::<_, FeedError>(s.revision()),
        &SnapshotRetry::default(),
    )
    .unwrap()
    .value;
    let OnSnapshot { value, attempts } = with_snapshot(
        peer.as_ref(),
        |snapshot, attempt| {
            let first = snapshot.targets(&entities(&[X]))?;
            if attempt == 1 {
                write(peer.as_ref(), &[X]);
                move_by_purge(peer.as_ref());
            }
            let fetched = fetch_scope(snapshot, &entities(&[X]), Selection::default())?;
            let mut ids: Vec<String> = fetched.source.ids().into_iter().map(String::from).collect();
            ids.sort();
            Ok::<_, FeedError>((snapshot.revision(), first, ids))
        },
        &SnapshotRetry::default(),
    )
    .unwrap();
    let (at, first, fetched) = value;
    assert_eq!(attempts, 2);
    assert_eq!(at, Revision(before.0 + 3));
    assert_eq!(first.len(), 2);
    assert_eq!(fetched, first);
}

#[test]
fn a_body_that_the_peer_always_moves_takes_exactly_the_bound_4_by_default_1_and_16_when_asked_then_the_last_snapshot_moved_passes_up_unchanged(
) {
    let (_store, peer) = seeded();
    assert_eq!(SnapshotRetry::default().snapshots, SNAPSHOT_RETRIES + 1);
    for (snapshots, expected) in [(None, 4), (Some(1), 1), (Some(16), 16)] {
        let watch = watched(peer.as_ref());
        let runs = Cell::new(0);
        let met: RefCell<Vec<StoreError>> = RefCell::new(Vec::new());
        let retry = SnapshotRetry {
            snapshots: snapshots.unwrap_or(SnapshotRetry::default().snapshots),
            ..SnapshotRetry::default()
        };
        let failure = with_snapshot(
            &watch,
            |snapshot, attempt| {
                runs.set(runs.get() + 1);
                snapshot.targets(&entities(&[X]))?;
                move_by_purge(peer.as_ref());
                snapshot
                    .targets(&entities(&[Y]))
                    .map_err(as_refusal)
                    .map_err(|e| {
                        let e =
                            StoreError::new(e.code, format!("{} (attempt {attempt})", e.message));
                        met.borrow_mut().push(e.clone());
                        FeedError::Refused(e)
                    })
            },
            &retry,
        );
        assert_eq!(
            (code(&failure), watch.reads.get(), runs.get()),
            ("snapshot-moved".to_string(), expected, expected)
        );
        assert_eq!(met.borrow().len(), expected);
        assert_eq!(
            failure.unwrap_err(),
            FeedError::Refused(met.borrow().last().unwrap().clone())
        );
    }
}

#[test]
fn a_read_that_refuses_snapshot_moved_counts_as_an_attempt_and_the_bodys_attempt_counts_it_too_three_such_and_the_body_runs_once_with_attempt_4_four_and_the_fourth_refusal_passes_up_unchanged(
) {
    let (_store, peer) = seeded();
    for (refusals, answers) in [(3, true), (4, false)] {
        let watch = watched(peer.as_ref());
        *watch.refusals.borrow_mut() = (1..=refusals)
            .map(|n| moved(&format!("moved before the snapshot, refusal {n}")))
            .collect();
        let given = RefCell::new(Vec::new());
        let answer = with_snapshot(
            &watch,
            |snapshot, attempt| {
                given.borrow_mut().push(attempt);
                Ok::<_, FeedError>(snapshot.revision())
            },
            &SnapshotRetry::default(),
        );
        assert_eq!(watch.reads.get(), 4);
        if answers {
            assert_eq!((answer.unwrap().attempts, given.into_inner()), (4, vec![4]));
        } else {
            assert_eq!(given.into_inner(), Vec::<usize>::new());
            assert_eq!(
                answer.unwrap_err(),
                FeedError::Refused(moved("moved before the snapshot, refusal 4"))
            );
        }
    }
    let once = watched(peer.as_ref());
    once.refusals
        .borrow_mut()
        .push(moved("moved before the snapshot"));
    let given = RefCell::new(Vec::new());
    with_snapshot(
        &once,
        |_, attempt| {
            given.borrow_mut().push(attempt);
            Ok::<_, FeedError>(())
        },
        &SnapshotRetry::default(),
    )
    .unwrap();
    assert_eq!(given.into_inner(), vec![2]);
}

#[test]
fn any_other_error_of_read_or_of_the_body_passes_up_at_once_unchanged_after_one_read_and_an_error_that_only_names_snapshot_moved_is_such_an_error(
) {
    let (_store, peer) = seeded();
    let refusals = [
        StoreError::new(
            StoreErrorCode::StoreUnavailable,
            "the engine is busy; ask again",
        ),
        StoreError::new(StoreErrorCode::SnapshotReleased, "released"),
        StoreError::new(StoreErrorCode::CapabilityAbsent, "absent"),
        StoreError::new(StoreErrorCode::StoreClosed, "closed"),
        StoreError::new(StoreErrorCode::InvalidRequest, "bad"),
    ];
    let mut errors: Vec<FeedError> = refusals.iter().cloned().map(FeedError::Refused).collect();
    errors.push(FeedError::Fault(StoreFault::RevisionOutOfRange {
        revision: Revision(1),
    }));
    errors.push(FeedError::Read("plain".into()));
    errors.push(FeedError::Read("snapshot-moved".into()));
    for error in &errors {
        let watch = watched(peer.as_ref());
        let answer: Result<OnSnapshot<()>, FeedError> =
            with_snapshot(&watch, |_, _| Err(error.clone()), &SnapshotRetry::default());
        assert_eq!(answer.unwrap_err(), *error);
        assert_eq!((watch.reads.get(), watch.releases()), (1, vec![1]));
    }
    for refusal in refusals {
        let watch = watched(peer.as_ref());
        watch.refusals.borrow_mut().push(refusal.clone());
        let runs = Cell::new(0);
        let answer = with_snapshot(
            &watch,
            |_, _| {
                runs.set(runs.get() + 1);
                Ok::<_, FeedError>(())
            },
            &SnapshotRetry::default(),
        );
        assert_eq!(answer.unwrap_err(), FeedError::Refused(refusal));
        assert_eq!((watch.reads.get(), runs.get()), (1, 0));
    }
}

#[test]
fn a_snapshot_moved_of_another_peers_snapshot_that_the_body_reads_starts_it_again() {
    let (store, peer) = seeded();
    let other = store
        .create_peer("peer:q", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap();
    write(other.as_ref(), &[X]);
    let old = other.read().unwrap();
    move_by_purge(other.as_ref());
    let OnSnapshot { value, attempts } = with_snapshot(
        peer.as_ref(),
        |snapshot, attempt| {
            let mine = snapshot.targets(&entities(&[X]))?;
            let theirs = match attempt {
                1 => old.targets(&entities(&[X]))?,
                _ => other.read()?.targets(&entities(&[X]))?,
            };
            Ok::<_, FeedError>((mine.len(), theirs.len()))
        },
        &SnapshotRetry::default(),
    )
    .unwrap();
    assert_eq!((attempts, value), (2, (1, 1)));
}

#[test]
fn releases_the_snapshot_of_every_attempt_on_an_answer_on_an_error_and_on_a_move() {
    let (_store, peer) = seeded();
    let watch = watched(peer.as_ref());
    with_snapshot(
        &watch,
        |s, _| s.targets(&entities(&[X])).map_err(FeedError::from),
        &SnapshotRetry::default(),
    )
    .unwrap();
    let failed: Result<OnSnapshot<()>, FeedError> = with_snapshot(
        &watch,
        |_, _| Err(FeedError::Read("the body failed".into())),
        &SnapshotRetry::default(),
    );
    assert!(failed.is_err());
    with_snapshot(
        &watch,
        |snapshot, attempt| {
            snapshot.targets(&entities(&[X]))?;
            if attempt == 1 {
                move_by_purge(peer.as_ref());
            }
            snapshot.targets(&entities(&[X])).map_err(FeedError::from)
        },
        &SnapshotRetry::default(),
    )
    .unwrap();
    assert_eq!(watch.releases(), vec![1, 1, 1, 1]);
}

#[test]
fn at_each_start_of_the_body_every_earlier_snapshot_is_already_released_0_then_1_0_then_1_1_0_then_1_1_1_0(
) {
    let (_store, peer) = seeded();
    let watch = watched(peer.as_ref());
    let starts = RefCell::new(Vec::new());
    let mut moving = always_moved(peer.as_ref());
    let failure = with_snapshot(
        &watch,
        |snapshot, attempt| {
            starts.borrow_mut().push(watch.releases());
            moving(snapshot, attempt)
        },
        &SnapshotRetry::default(),
    );
    assert_eq!(code(&failure), "snapshot-moved");
    assert_eq!(
        starts.into_inner(),
        vec![vec![0], vec![1, 0], vec![1, 1, 0], vec![1, 1, 1, 0]]
    );
    assert_eq!(watch.releases(), vec![1, 1, 1, 1]);
}

#[test]
fn a_clock_with_no_within_ms_is_never_read_0_readings_on_an_answer_and_on_4_moved_snapshots() {
    let (_store, peer) = seeded();
    let readings = Cell::new(0);
    let clock = || {
        readings.set(readings.get() + 1);
        1_000.0
    };
    let retry = SnapshotRetry {
        clock: Some(&clock),
        ..SnapshotRetry::default()
    };
    let answer = with_snapshot(
        peer.as_ref(),
        |s, _| Ok::<_, FeedError>(s.revision()),
        &retry,
    )
    .unwrap();
    let watch = watched(peer.as_ref());
    let failure = with_snapshot(&watch, always_moved(peer.as_ref()), &retry);
    assert_eq!(
        (answer.attempts, code(&failure), watch.reads.get()),
        (1, "snapshot-moved".to_string(), 4)
    );
    assert_eq!(readings.get(), 0);
}

#[test]
fn within_ms_also_ends_the_call_on_a_refused_read_10_ms_and_30_ms_per_reading_pass_the_first_refusal_up_after_1_read_and_2_readings(
) {
    let (_store, peer) = seeded();
    let watch = watched(peer.as_ref());
    *watch.refusals.borrow_mut() = (1..=16)
        .map(|n| moved(&format!("moved before the snapshot, refusal {n}")))
        .collect();
    let readings = Cell::new(0);
    let clock = || {
        readings.set(readings.get() + 1);
        1_000.0 + 30.0 * readings.get() as f64
    };
    let runs = Cell::new(0);
    let failure = with_snapshot(
        &watch,
        |_, _| {
            runs.set(runs.get() + 1);
            Ok::<_, FeedError>(())
        },
        &SnapshotRetry {
            within_ms: Some(10),
            clock: Some(&clock),
            ..SnapshotRetry::default()
        },
    );
    assert_eq!(
        failure.unwrap_err(),
        FeedError::Refused(moved("moved before the snapshot, refusal 1"))
    );
    assert_eq!((watch.reads.get(), readings.get(), runs.get()), (1, 2, 0));
}

#[test]
fn within_ms_bounds_the_snapshots_after_the_first_by_the_hosts_clock_0_still_runs_the_first_a_body_that_passes_the_bound_gets_no_second_a_bound_not_passed_reaches_the_count(
) {
    let (_store, peer) = seeded();
    let now = Cell::new(1_000.0);
    let readings = Cell::new(0);
    let clock = || {
        readings.set(readings.get() + 1);
        now.get()
    };
    let still = with_snapshot(
        peer.as_ref(),
        |s, _| s.targets(&entities(&[X])).map_err(FeedError::from),
        &SnapshotRetry {
            within_ms: Some(0),
            clock: Some(&clock),
            ..SnapshotRetry::default()
        },
    )
    .unwrap();
    assert_eq!((still.attempts, readings.get()), (1, 1));
    for (within_ms, step, snapshots, expected) in [
        (0, 0.0, None, 1),
        (10, 30.0, None, 1),
        (10, 9.0, None, 2),
        (10, 3.0, None, 4),
        (100, 0.0, Some(2), 2),
    ] {
        let watch = watched(peer.as_ref());
        let retry = SnapshotRetry {
            snapshots: snapshots.unwrap_or(SnapshotRetry::default().snapshots),
            within_ms: Some(within_ms),
            clock: Some(&clock),
        };
        let failure = with_snapshot(
            &watch,
            |snapshot, _| {
                snapshot.targets(&entities(&[X]))?;
                now.set(now.get() + step);
                move_by_purge(peer.as_ref());
                snapshot.targets(&entities(&[Y])).map_err(FeedError::from)
            },
            &retry,
        );
        assert_eq!(
            (within_ms, step, code(&failure), watch.reads.get()),
            (within_ms, step, "snapshot-moved".to_string(), expected)
        );
    }
    let watch = watched(peer.as_ref());
    let unbounded = with_snapshot(
        &watch,
        |snapshot, _| {
            now.set(now.get() + 1_000_000.0);
            always_moved(peer.as_ref())(snapshot, 1)
        },
        &SnapshotRetry {
            clock: Some(&clock),
            ..SnapshotRetry::default()
        },
    );
    assert_eq!(
        (code(&unbounded), watch.reads.get()),
        ("snapshot-moved".to_string(), 4)
    );
}

#[test]
fn a_clock_reading_below_the_first_or_not_finite_refuses_invalid_request_after_the_move_and_a_clock_that_panics_passes_its_panic_up_one_snapshot_was_taken_and_released_in_each_case(
) {
    let (_store, peer) = seeded();
    for later in [999.0, f64::NAN, f64::INFINITY, -1.0] {
        let readings = Cell::new(0);
        let clock = || {
            readings.set(readings.get() + 1);
            if readings.get() == 1 {
                1_000.0
            } else {
                later
            }
        };
        let watch = watched(peer.as_ref());
        let failure = with_snapshot(
            &watch,
            always_moved(peer.as_ref()),
            &SnapshotRetry {
                within_ms: Some(1_000_000),
                clock: Some(&clock),
                ..SnapshotRetry::default()
            },
        );
        assert_eq!(
            (later.to_string(), code(&failure)),
            (later.to_string(), "invalid-request".to_string())
        );
        assert_eq!((watch.reads.get(), readings.get()), (1, 2));
        assert_eq!(watch.releases(), vec![1]);
    }
    let readings = Cell::new(0);
    let clock = || {
        readings.set(readings.get() + 1);
        if readings.get() == 1 {
            1_000.0
        } else {
            panic!("the clock failed")
        }
    };
    let watch = watched(peer.as_ref());
    let panicked = catch_unwind(AssertUnwindSafe(|| {
        with_snapshot(
            &watch,
            always_moved(peer.as_ref()),
            &SnapshotRetry {
                within_ms: Some(1_000_000),
                clock: Some(&clock),
                ..SnapshotRetry::default()
            },
        )
    }))
    .unwrap_err();
    assert_eq!(panicked.downcast_ref::<&str>(), Some(&"the clock failed"));
    assert_eq!((watch.reads.get(), readings.get()), (1, 2));
    assert_eq!(watch.releases(), vec![1]);
    let seven = || 7.0;
    let equal = with_snapshot(
        peer.as_ref(),
        |s, _| Ok::<_, FeedError>(s.revision()),
        &SnapshotRetry {
            within_ms: Some(0),
            clock: Some(&seven),
            ..SnapshotRetry::default()
        },
    )
    .unwrap();
    assert_eq!(equal.attempts, 1);
}

#[test]
fn the_clock_is_not_read_once_the_count_ends_the_call_snapshots_1_reads_it_once_at_the_start() {
    let (_store, peer) = seeded();
    let readings = Cell::new(0);
    let clock = || {
        readings.set(readings.get() + 1);
        0.0
    };
    let failure = with_snapshot(
        peer.as_ref(),
        always_moved(peer.as_ref()),
        &SnapshotRetry {
            snapshots: 1,
            within_ms: Some(100),
            clock: Some(&clock),
        },
    );
    assert_eq!(
        (code(&failure), readings.get()),
        ("snapshot-moved".to_string(), 1)
    );
}

#[test]
fn refuses_a_bad_policy_invalid_request_before_any_store_call() {
    let (_store, peer) = seeded();
    let zero = || 0.0;
    let nan = || f64::NAN;
    let most = (1u64 << 53) - 1;
    let bad = [
        SnapshotRetry {
            snapshots: 0,
            ..SnapshotRetry::default()
        },
        SnapshotRetry {
            snapshots: 17,
            ..SnapshotRetry::default()
        },
        SnapshotRetry {
            within_ms: Some(most + 1),
            clock: Some(&zero),
            ..SnapshotRetry::default()
        },
        SnapshotRetry {
            within_ms: Some(u64::MAX),
            clock: Some(&zero),
            ..SnapshotRetry::default()
        },
        SnapshotRetry {
            within_ms: Some(10),
            ..SnapshotRetry::default()
        },
        SnapshotRetry {
            within_ms: Some(10),
            clock: Some(&nan),
            ..SnapshotRetry::default()
        },
    ];
    for (i, retry) in bad.iter().enumerate() {
        let watch = watched(peer.as_ref());
        let failure = with_snapshot(&watch, |s, _| Ok::<_, FeedError>(s.revision()), retry);
        assert_eq!(
            (i, code(&failure), watch.reads.get()),
            (i, "invalid-request".to_string(), 0)
        );
    }
    for good in [
        SnapshotRetry {
            snapshots: 1,
            ..SnapshotRetry::default()
        },
        SnapshotRetry {
            snapshots: 16,
            within_ms: Some(most),
            clock: Some(&zero),
        },
        SnapshotRetry {
            clock: Some(&nan),
            ..SnapshotRetry::default()
        },
    ] {
        let answer = with_snapshot(
            peer.as_ref(),
            |s, _| Ok::<_, FeedError>(s.revision()),
            &good,
        );
        assert_eq!(answer.unwrap().attempts, 1);
    }
}

#[test]
fn a_snapshot_at_revision_2_53_is_the_fault_revision_out_of_range_before_the_body_runs_and_is_released_2_53_minus_1_runs(
) {
    let (_store, peer) = seeded();
    for (revision, refused) in [(MAX_REVISION + 1, true), (MAX_REVISION, false)] {
        let mut watch = watched(peer.as_ref());
        watch.revision = Some(Revision(revision));
        let runs = Cell::new(0);
        let answer = with_snapshot(
            &watch,
            |s, _| {
                runs.set(runs.get() + 1);
                Ok::<_, FeedError>(s.revision())
            },
            &SnapshotRetry::default(),
        );
        if refused {
            assert_eq!(
                answer.unwrap_err(),
                FeedError::Fault(StoreFault::RevisionOutOfRange {
                    revision: Revision(revision)
                })
            );
            assert_eq!(runs.get(), 0);
        } else {
            assert_eq!(answer.unwrap().value, Revision(revision));
        }
        assert_eq!(watch.releases(), vec![1]);
    }
}

#[test]
fn after_close_the_read_refuses_store_closed_and_the_body_never_runs_a_close_inside_the_body_gives_store_closed_after_one_attempt(
) {
    let (store, peer) = seeded();
    let watch = watched(peer.as_ref());
    let failure = with_snapshot(
        &watch,
        |snapshot, _| {
            snapshot.targets(&entities(&[X]))?;
            store.close();
            snapshot.targets(&entities(&[X])).map_err(FeedError::from)
        },
        &SnapshotRetry::default(),
    );
    assert_eq!(
        (code(&failure), watch.reads.get()),
        ("store-closed".to_string(), 1)
    );
    assert_eq!(watch.releases(), vec![1]);
    let (after, peer) = seeded();
    after.close();
    let runs = Cell::new(0);
    let closed = with_snapshot(
        peer.as_ref(),
        |_, _| {
            runs.set(runs.get() + 1);
            Ok::<_, FeedError>(())
        },
        &SnapshotRetry::default(),
    );
    assert_eq!((code(&closed), runs.get()), ("store-closed".to_string(), 0));
}

/// A peer whose snapshots meet damage: `targets` and `scope` answer one integrity fault. Each
/// other call passes to the peer it wraps (§4.13 reading 136).
struct Damaged<'a> {
    inner: &'a dyn PeerStore,
    fault: IntegrityFault,
}

struct DamagedSnapshot {
    inner: Box<dyn Snapshot>,
    fault: IntegrityFault,
}

impl PeerStore for Damaged<'_> {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn erasure(&self) -> PeerErasure {
        self.inner.erasure()
    }
    fn history(&self) -> Result<&str, StoreError> {
        self.inner.history()
    }
    fn app_format(&self) -> Result<Option<&str>, StoreError> {
        self.inner.app_format()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        Ok(Box::new(DamagedSnapshot {
            inner: self.inner.read()?,
            fault: self.fault.clone(),
        }))
    }
    fn append(&self, batch: &rhizomatic::store::Admission) -> Result<AppendResult, StoreError> {
        self.inner.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreFailure> {
        self.inner.purge(ids)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreFailure> {
        self.inner.changes(from, to)
    }
}

impl Snapshot for DamagedSnapshot {
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
    fn last_sequence(&self) -> u64 {
        self.inner.last_sequence()
    }
    fn last_transfer(&self) -> u64 {
        self.inner.last_transfer()
    }
    fn root(&self) -> Option<&str> {
        self.inner.root()
    }
    fn digest(&self, prefix: &str) -> Result<rhizomatic::store_digest::DigestNode, StoreFailure> {
        self.inner.digest(prefix)
    }
    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreFailure> {
        self.inner.get(ids)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreFailure> {
        self.inner.arrivals(ids)
    }
    fn targets(&self, _: &[String]) -> Result<Vec<String>, StoreFailure> {
        Err(StoreFailure::Integrity(self.fault.clone()))
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreFailure> {
        self.inner.negators(ids)
    }
    fn scope(&self, _: &ScopeRequest) -> Result<ScopeResult, StoreFailure> {
        Err(StoreFailure::Integrity(self.fault.clone()))
    }
    fn release(&mut self) {
        self.inner.release();
    }
}

#[test]
fn an_integrity_fault_passes_up_unchanged_after_one_read_and_one_run_in_feed_error_and_in_store_read_error_and_the_snapshot_is_released(
) {
    let (_store, peer) = seeded();
    let fault = IntegrityFault {
        kind: IntegrityFaultKind::ClaimsUnreadable,
        peer: Some("peer:p".into()),
        id: Some("an-id".into()),
        key: None,
        detail: "a held delta has no stored claims".into(),
    };
    let watch = watched(peer.as_ref());
    let damaged = Damaged {
        inner: &watch,
        fault: fault.clone(),
    };
    let runs = Cell::new(0);
    let feed = with_snapshot(
        &damaged,
        |snapshot, _| {
            runs.set(runs.get() + 1);
            snapshot.targets(&entities(&[X]))?;
            Ok::<_, FeedError>(())
        },
        &SnapshotRetry::default(),
    );
    assert_eq!(feed.unwrap_err(), FeedError::Integrity(fault.clone()));
    assert_eq!(
        (watch.reads.get(), runs.get(), watch.releases()),
        (1, 1, vec![1])
    );
    let watch = watched(peer.as_ref());
    let damaged = Damaged {
        inner: &watch,
        fault: fault.clone(),
    };
    let runs = Cell::new(0);
    let read = with_snapshot(
        &damaged,
        |snapshot, _| {
            runs.set(runs.get() + 1);
            Ok::<_, StoreReadError>(fetch_scope(
                snapshot,
                &entities(&[X]),
                Selection::default(),
            )?)
        },
        &SnapshotRetry::default(),
    );
    assert_eq!(read.unwrap_err(), StoreReadError::Integrity(fault));
    assert_eq!(
        (watch.reads.get(), runs.get(), watch.releases()),
        (1, 1, vec![1])
    );
}
