//! The integrity fault on its way through every reader (SPEC-18 §4.13 readings 136 and 137). A
//! hand-made peer answers `StoreFailure::Integrity` from one call it is told to fail. Each reader
//! answers that fault unchanged after one read and one run, releases its snapshot, does not run
//! again, and moves no state. The memory store's own producers and `fsck` are tested inside
//! `src/memory_store.rs`, where a test can damage the store's private state.

use std::cell::Cell;
use std::rc::Rc;

use rhizomatic::memory_store::MemoryStore;
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    collect_delta_set, Admission, AppendResult, ArrivalRecord, ChangePage, CreatePeerOptions,
    ErasurePosture, IntegrityFault, IntegrityFaultKind, Listing, PeerErasure, PeerExporter,
    PeerStore, PurgeReport, Pushdown, Revision, ScopeRequest, ScopeResult, Snapshot, Store,
    StoreError, StoreFailure,
};
use rhizomatic::store_admission::{admission_of, AdmissionOptions};
use rhizomatic::store_follow::{follow_feed, Position};
use rhizomatic::store_fresh::{check_fresh, raw_scope, FeedError};
use rhizomatic::store_read::{
    capture_scope, fetch_scope, read_full_surface, FullSurfaceRequest, ReadRequest, Selection,
    StoreReactor, StoreReadError,
};
use rhizomatic::store_views::{StoreViews, StoreViewsOptions, ViewProgram, ViewSizes};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Target};

const X: &str = "entity:x";

thread_local! {
    static STAMP: Cell<u64> = const { Cell::new(1000) };
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
        author: "did:key:zIntegrity".into(),
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

fn write(peer: &dyn PeerStore, entities: &[&str]) {
    let deltas: Vec<Delta> = entities.iter().map(|e| fact(e)).collect();
    let snapshot = peer.read().unwrap();
    let options = AdmissionOptions {
        at: 1.0,
        sender: "test".into(),
        next_head: format!("head-{}", snapshot.last_sequence() + 1),
    };
    let batch = admission_of(snapshot.as_ref(), &deltas, options).unwrap();
    let result = peer.append(&batch).unwrap();
    assert!(matches!(result, AppendResult::Committed { .. }));
}

/// Which call fails, and what the readers did: reads of a snapshot, failed calls, releases.
#[derive(Clone)]
struct Control {
    failing: Rc<Cell<&'static str>>,
    reads: Rc<Cell<usize>>,
    failed: Rc<Cell<usize>>,
    releases: Rc<Cell<usize>>,
}

impl Control {
    fn new() -> Self {
        Control {
            failing: Rc::new(Cell::new("")),
            reads: Rc::new(Cell::new(0)),
            failed: Rc::new(Cell::new(0)),
            releases: Rc::new(Cell::new(0)),
        }
    }

    fn fail(&self, call: &'static str) {
        self.failing.set(call);
        self.reads.set(0);
        self.failed.set(0);
        self.releases.set(0);
    }

    fn call(&self, call: &'static str) -> Result<(), StoreFailure> {
        if self.failing.get() == call {
            self.failed.set(self.failed.get() + 1);
            return Err(StoreFailure::Integrity(fault()));
        }
        Ok(())
    }

    /// (reads, failed calls, releases).
    fn counts(&self) -> (usize, usize, usize) {
        (self.reads.get(), self.failed.get(), self.releases.get())
    }
}

fn fault() -> IntegrityFault {
    IntegrityFault {
        kind: IntegrityFaultKind::ClaimsMismatch,
        peer: Some("peer:p".into()),
        id: Some("an-id".into()),
        key: Some("a-key".into()),
        detail: "a detail".into(),
    }
}

struct Damaged {
    inner: Box<dyn PeerStore>,
    control: Control,
}

struct DamagedSnapshot {
    inner: Box<dyn Snapshot>,
    control: Control,
}

impl PeerStore for Damaged {
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
        self.control.reads.set(self.control.reads.get() + 1);
        Ok(Box::new(DamagedSnapshot {
            inner: self.inner.read()?,
            control: self.control.clone(),
        }))
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.inner.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreFailure> {
        self.control.call("purge")?;
        self.inner.purge(ids)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreFailure> {
        self.control.call("changes")?;
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
        self.control.call("get")?;
        self.inner.get(ids)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreFailure> {
        self.control.call("arrivals")?;
        self.inner.arrivals(ids)
    }
    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreFailure> {
        self.control.call("targets")?;
        self.inner.targets(entities)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreFailure> {
        self.control.call("negators")?;
        self.inner.negators(ids)
    }
    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreFailure> {
        self.control.call("scope")?;
        self.inner.scope(request)
    }
    fn release(&mut self) {
        self.control.releases.set(self.control.releases.get() + 1);
        self.inner.release();
    }
}

/// A listing whose `ids` fails at once and whose `deltas` fails after one member.
struct DamagedListing;

impl PeerExporter for DamagedListing {
    fn ids(&self) -> Listing<'_, String> {
        Box::new(std::iter::once(Err(StoreFailure::Integrity(fault()))))
    }
    fn deltas(&self) -> Listing<'_, Delta> {
        Box::new(vec![Ok(fact(X)), Err(StoreFailure::Integrity(fault()))].into_iter())
    }
}

/// A memory store whose peer `peer:p` holds two facts at X, and the damaged handle of that peer.
fn damaged() -> (MemoryStore, Damaged, Control) {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:p", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap();
    write(peer.as_ref(), &[X, X]);
    let control = Control::new();
    let handle = Damaged {
        inner: store.peer("peer:p").unwrap(),
        control: control.clone(),
    };
    (store, handle, control)
}

fn leaf() -> rhizomatic::eval::Term {
    parse_term(&serde_json::json!({
        "op": "group",
        "key": "byTargetContext",
        "in": {
            "op": "select",
            "pred": { "hasPointer": { "targetEntity": { "var": "root" } } },
            "in": { "op": "mask", "policy": "drop", "in": "input" }
        }
    }))
    .unwrap()
}

fn xs() -> Vec<String> {
    vec![X.to_string()]
}

fn pushdown() -> Pushdown {
    Pushdown {
        timestamp_at_most: Some(1e12),
        arrival_at_most: None,
        exclude_ids: None,
    }
}

#[test]
fn the_eleven_fault_kinds_have_the_names_of_the_typescript_union() {
    use IntegrityFaultKind::*;
    let kinds = [
        ClaimsMismatch,
        ClaimsUnreadable,
        IndexMissing,
        IndexStray,
        ColumnMismatch,
        CountMismatch,
        SequenceMismatch,
        FeedGap,
        OrphanBytes,
        Engine,
        DigestMismatch,
    ];
    // A new kind fails to compile here until it is in the list above.
    for kind in kinds {
        match kind {
            ClaimsMismatch | ClaimsUnreadable | IndexMissing | IndexStray | ColumnMismatch
            | CountMismatch | SequenceMismatch | FeedGap | OrphanBytes | Engine
            | DigestMismatch => {}
        }
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../ts/src/storage/store.ts");
    let source = std::fs::read_to_string(path).unwrap();
    let start = source.find("export type IntegrityFaultKind =").unwrap();
    let union = &source[start..start + source[start..].find(';').unwrap()];
    let names: Vec<&str> = union.split('"').skip(1).step_by(2).collect();
    let ours: Vec<&str> = kinds.iter().map(|kind| kind.as_str()).collect();
    assert_eq!(ours, names);
    assert_eq!(names.len(), 11);
}

#[test]
fn an_integrity_failure_reads_as_its_detail_and_carries_no_refusal_code() {
    let failure = StoreFailure::Integrity(fault());
    assert_eq!(failure.to_string(), "a detail");
    assert_eq!(FeedError::Integrity(fault()).code(), None);
}

#[test]
fn the_functions_on_one_snapshot_and_on_a_listing_answer_the_fault_unchanged() {
    let want = Some(StoreFailure::Integrity(fault()));
    let push = pushdown();
    let pushed = Selection {
        pushdown: Some(&push),
        admits: None,
    };
    let fed = Some(FeedError::Integrity(fault()));
    let (_store, peer, control) = damaged();
    control.fail("scope");
    let snapshot = peer.read().unwrap();
    let got = fetch_scope(snapshot.as_ref(), &xs(), Selection::default());
    assert_eq!(got.err(), fed, "fetch_scope");
    assert_eq!(control.counts(), (1, 1, 0), "fetch_scope");
    let got = capture_scope(snapshot.as_ref(), &xs(), 10.0, Selection::default());
    assert_eq!(got.err(), fed, "capture_scope");
    assert_eq!(control.counts(), (1, 2, 0), "capture_scope");
    for call in ["targets", "negators"] {
        control.fail(call);
        let snapshot = peer.read().unwrap();
        let got = raw_scope(snapshot.as_ref(), &xs());
        assert_eq!(got.err(), want, "raw_scope {call}");
        let got = capture_scope(snapshot.as_ref(), &xs(), 10.0, pushed);
        assert_eq!(got.err(), fed, "capture_scope with a pushdown {call}");
        assert_eq!(control.counts(), (1, 2, 0), "{call}");
    }

    assert_eq!(collect_delta_set(&DamagedListing).err(), want);
    let term = leaf();
    match read_full_surface(&DamagedListing, FullSurfaceRequest::new(&term, 10.0)) {
        Err(StoreReadError::Integrity(got)) => assert_eq!(got, fault()),
        Err(other) => panic!("read_full_surface answered {other:?}"),
        Ok(_) => panic!("read_full_surface answered"),
    }
}

#[test]
fn check_fresh_and_a_feed_pull_answer_the_fault_after_one_read_release_it_and_keep_the_cursor() {
    let want = FeedError::Integrity(fault());
    let (_store, peer, control) = damaged();
    let snapshot = peer.read().unwrap();
    let (_, capture) = capture_scope(snapshot.as_ref(), &xs(), 10.0, Selection::default()).unwrap();
    drop(snapshot);
    write(&peer, &[X]);
    for call in ["changes", "get"] {
        control.fail(call);
        let got = check_fresh(&peer, &capture, 10.0);
        assert_eq!(got.err(), Some(want.clone()), "check_fresh {call}");
        assert_eq!(control.counts(), (1, 1, 1), "check_fresh {call}");
    }

    let history = peer.history().unwrap().to_string();
    for call in ["changes", "get", "arrivals"] {
        control.fail("");
        let start = Position {
            history: history.clone(),
            revision: Revision(0),
        };
        let mut cursor = follow_feed(&peer, start).unwrap();
        let before = cursor.position().clone();
        control.fail(call);
        assert_eq!(cursor.pull().err(), Some(want.clone()), "pull {call}");
        assert_eq!(control.counts(), (1, 1, 1), "pull {call}");
        assert_eq!(cursor.position(), &before, "pull {call} moved the cursor");
    }
}

#[test]
fn a_store_reactor_read_and_fetch_answer_the_fault_after_one_read_and_release_it() {
    let (_store, peer, control) = damaged();
    let reactor = StoreReactor::open(Box::new(peer));
    let term = leaf();
    control.fail("scope");
    match reactor.read(ReadRequest::new(&term, X, 10.0)) {
        Err(StoreReadError::Integrity(got)) => assert_eq!(got, fault()),
        Err(other) => panic!("read answered {other:?}"),
        Ok(_) => panic!("read answered"),
    }
    assert_eq!(control.counts(), (1, 1, 1), "read");
    control.fail("scope");
    let got = reactor.fetch(&xs(), Selection::default());
    assert_eq!(got.err(), Some(FeedError::Integrity(fault())), "fetch");
    assert_eq!(control.counts(), (1, 1, 1), "fetch");
    let push = pushdown();
    for call in ["targets", "negators"] {
        control.fail(call);
        let mut request = ReadRequest::new(&term, X, 10.0);
        request.capture = true;
        request.selection = Selection {
            pushdown: Some(&push),
            admits: None,
        };
        match reactor.read(request) {
            Err(StoreReadError::Integrity(got)) => assert_eq!(got, fault()),
            Err(other) => panic!("read with a capture {call} answered {other:?}"),
            Ok(_) => panic!("read with a capture {call} answered"),
        }
        assert_eq!(control.counts(), (1, 1, 1), "read with a capture {call}");
    }
}

#[test]
fn held_views_answer_the_fault_after_one_read_release_it_and_keep_what_they_hold() {
    let want = FeedError::Integrity(fault());
    let (store, peer, control) = damaged();
    let writer = store.peer("peer:p").unwrap();
    let mut views = StoreViews::new(Box::new(peer), StoreViewsOptions::default()).unwrap();
    views.register("leaf", ViewProgram::new(leaf())).unwrap();
    control.fail("scope");
    assert_eq!(views.hold("leaf", X, 10.0).err(), Some(want.clone()));
    assert_eq!(control.counts(), (1, 1, 1), "hold");
    assert_eq!(
        views.sizes(),
        ViewSizes::default(),
        "a failed hold kept a view"
    );

    control.fail("");
    views.hold("leaf", X, 10.0).unwrap();
    write(writer.as_ref(), &[X]);
    let held = views.sizes();
    for call in ["changes", "get", "scope"] {
        control.fail(call);
        assert_eq!(
            views.refresh(10.0).err(),
            Some(want.clone()),
            "refresh {call}"
        );
        assert_eq!(control.counts(), (1, 1, 1), "refresh {call}");
        assert_eq!(views.sizes(), held, "refresh {call} moved the held views");
    }
    control.fail("");
    assert!(views.refresh(10.0).is_ok(), "a refresh after the faults");
}
