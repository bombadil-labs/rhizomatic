//! The store fault `malformed-member` on its way through every reader (SPEC-18 §4.13 reading 21).
//! A hand-made peer answers each `scope` member under another id, or with the arrival record of
//! another id. The memory store never answers such a member, so only a wrong store shows the
//! rule. Each reader answers the fault after one read and one `scope` call, releases its
//! snapshot, does not run again, and moves no state. A follower makes no `scope` call, so it
//! never meets this fault.

use std::cell::Cell;
use std::rc::Rc;

use rhizomatic::memory_store::MemoryStore;
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    Admission, AppendResult, ArrivalRecord, ChangePage, CreatePeerOptions, ErasurePosture,
    IntegrityFault, IntegrityFaultKind, PeerErasure, PeerStore, PurgeReport, Pushdown, Revision,
    ScopeRequest, ScopeResult, Snapshot, Store, StoreError, StoreErrorCode, StoreFailure,
    MAX_REVISION,
};
use rhizomatic::store_admission::{admission_of, AdmissionOptions};
use rhizomatic::store_fresh::{FeedError, StoreFault};
use rhizomatic::store_read::{
    capture_scope, fetch_scope, read_anchored, ReadRequest, Selection, StoreReactor, StoreReadError,
};
use rhizomatic::store_views::{StoreViews, StoreViewsOptions, ViewProgram, ViewSizes};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Target};

const X: &str = "entity:x";

thread_local! {
    static STAMP: Cell<u64> = const { Cell::new(2000) };
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
        author: "did:key:zMalformed".into(),
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

/// How the wrong peer's `scope` answers each member.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Forge {
    /// As the store answered.
    Nothing,
    /// Under the id of another delta: the id does not recompute from the claims.
    OtherId,
    /// With an arrival record that names another delta.
    OtherArrival,
    /// Each member twice; the second appearance carries another delta's arrival record.
    MalformedRepeat,
}

/// What the wrong peer forges, and what the readers did: reads, `scope` calls, releases.
#[derive(Clone)]
struct Control {
    forge: Rc<Cell<Forge>>,
    revision: Rc<Cell<Option<u64>>>,
    reads: Rc<Cell<usize>>,
    scopes: Rc<Cell<usize>>,
    releases: Rc<Cell<usize>>,
}

impl Control {
    fn new() -> Self {
        Control {
            forge: Rc::new(Cell::new(Forge::Nothing)),
            revision: Rc::new(Cell::new(None)),
            reads: Rc::new(Cell::new(0)),
            scopes: Rc::new(Cell::new(0)),
            releases: Rc::new(Cell::new(0)),
        }
    }

    fn forge(&self, forge: Forge) {
        self.forge.set(forge);
        self.reads.set(0);
        self.scopes.set(0);
        self.releases.set(0);
    }

    /// (reads, `scope` calls, releases).
    fn counts(&self) -> (usize, usize, usize) {
        (self.reads.get(), self.scopes.get(), self.releases.get())
    }
}

struct Forging {
    inner: Box<dyn PeerStore>,
    control: Control,
    other: String,
}

struct ForgingSnapshot {
    inner: Box<dyn Snapshot>,
    control: Control,
    other: String,
}

impl PeerStore for Forging {
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
        Ok(Box::new(ForgingSnapshot {
            inner: self.inner.read()?,
            control: self.control.clone(),
            other: self.other.clone(),
        }))
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.inner.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreFailure> {
        self.inner.purge(ids)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreFailure> {
        self.inner.changes(from, to)
    }
}

impl Snapshot for ForgingSnapshot {
    fn revision(&self) -> Revision {
        self.control
            .revision
            .get()
            .map_or_else(|| self.inner.revision(), Revision)
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
        self.control.scopes.set(self.control.scopes.get() + 1);
        let mut answer = self.inner.scope(request)?;
        match self.control.forge.get() {
            Forge::Nothing => {}
            Forge::OtherId => {
                for member in &mut answer.deltas {
                    member.delta.id = self.other.clone();
                    member.arrival.id = self.other.clone();
                }
            }
            Forge::OtherArrival => {
                for member in &mut answer.deltas {
                    member.arrival.id = self.other.clone();
                }
            }
            Forge::MalformedRepeat => {
                let mut repeats = answer.deltas.clone();
                for member in &mut repeats {
                    member.arrival.id = self.other.clone();
                }
                answer.deltas.extend(repeats);
            }
        }
        Ok(answer)
    }
    fn release(&mut self) {
        self.control.releases.set(self.control.releases.get() + 1);
        self.inner.release();
    }
}

/// A memory store whose peer `peer:p` holds two facts at X, and the wrong handle of that peer.
fn forging() -> (MemoryStore, Forging, Control) {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:p", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap();
    write(peer.as_ref(), &[X, X]);
    let control = Control::new();
    let handle = Forging {
        inner: store.peer("peer:p").unwrap(),
        control: control.clone(),
        other: fact("entity:other").id,
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

/// The fault's revision, when the error is the store fault `malformed-member`.
fn malformed(fault: &StoreFault) -> Option<Revision> {
    match fault {
        StoreFault::MalformedMember { revision, .. } => Some(*revision),
        _ => None,
    }
}

fn read_fault(error: Result<impl std::fmt::Debug, StoreReadError>) -> Option<Revision> {
    match error {
        Err(StoreReadError::Fault(fault)) => malformed(&fault),
        other => panic!("the read answered {other:?}"),
    }
}

fn feed_fault(error: Result<impl std::fmt::Debug, FeedError>) -> Option<Revision> {
    match error {
        Err(FeedError::Fault(fault)) => malformed(&fault),
        other => panic!("the call answered {other:?}"),
    }
}

const FORGERIES: [Forge; 2] = [Forge::OtherId, Forge::OtherArrival];

#[test]
fn the_six_store_fault_rules_have_the_names_of_the_typescript_union() {
    let revision = Revision(0);
    let faults = [
        StoreFault::NoProgress {
            from: revision,
            to: revision,
            through: revision,
        },
        StoreFault::PastTheBound {
            from: revision,
            to: revision,
            through: revision,
        },
        StoreFault::MismatchedAnswers {
            get: Vec::new(),
            arrivals: Vec::new(),
        },
        StoreFault::UnaskedIds {
            call: "get",
            asked: Vec::new(),
            answered: Vec::new(),
        },
        StoreFault::RevisionOutOfRange { revision },
        StoreFault::MalformedMember {
            revision,
            detail: String::new(),
        },
    ];
    // A new rule fails to compile here until it is in the list above.
    for fault in &faults {
        match fault {
            StoreFault::NoProgress { .. }
            | StoreFault::PastTheBound { .. }
            | StoreFault::MismatchedAnswers { .. }
            | StoreFault::UnaskedIds { .. }
            | StoreFault::RevisionOutOfRange { .. }
            | StoreFault::MalformedMember { .. } => {}
        }
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../ts/src/storage/store.ts");
    let source = std::fs::read_to_string(path).unwrap();
    let start = source.find("export type StoreFaultRule =").unwrap();
    let union = &source[start..start + source[start..].find(';').unwrap()];
    let names: Vec<&str> = union.split('"').skip(1).step_by(2).collect();
    let ours: Vec<&str> = faults.iter().map(StoreFault::rule).collect();
    assert_eq!(ours, names);
}

#[test]
fn the_fault_names_its_rule_its_revision_and_the_member_and_carries_no_refusal_code() {
    let (_store, peer, control) = forging();
    control.forge(Forge::OtherArrival);
    let snapshot = peer.read().unwrap();
    let error = fetch_scope(snapshot.as_ref(), &xs(), Selection::default()).unwrap_err();
    assert_eq!(error.code(), None);
    let FeedError::Fault(fault) = &error else {
        panic!("fetch_scope answered {error:?}");
    };
    assert_eq!(fault.rule(), "malformed-member");
    let text = error.to_string();
    assert!(
        text.starts_with("the store broke malformed-member: the store answered a scope member at revision 1 that is malformed or whose id does not recompute (scope member "),
        "{text}"
    );
    assert!(
        text.contains(&format!("carries the arrival record of {}", peer.other)),
        "{text}"
    );
}

#[test]
fn read_anchored_fetch_scope_and_capture_scope_answer_the_fault_on_one_snapshot_after_one_scope_call(
) {
    let term = leaf();
    let push = pushdown();
    let pushed = Selection {
        pushdown: Some(&push),
        admits: None,
    };
    let (_store, peer, control) = forging();
    for forge in FORGERIES {
        control.forge(forge);
        let snapshot = peer.read().unwrap();
        let at = Some(snapshot.revision());
        assert_eq!(
            read_fault(read_anchored(
                snapshot.as_ref(),
                ReadRequest::new(&term, X, 10.0)
            )),
            at,
            "read_anchored {forge:?}"
        );
        assert_eq!(control.counts(), (1, 1, 0), "read_anchored {forge:?}");
        assert_eq!(
            feed_fault(fetch_scope(snapshot.as_ref(), &xs(), Selection::default())),
            at,
            "fetch_scope {forge:?}"
        );
        assert_eq!(
            feed_fault(fetch_scope(snapshot.as_ref(), &xs(), pushed)),
            at,
            "fetch_scope with a pushdown {forge:?}"
        );
        assert_eq!(
            feed_fault(capture_scope(
                snapshot.as_ref(),
                &xs(),
                10.0,
                Selection::default()
            )),
            at,
            "capture_scope {forge:?}"
        );
        assert_eq!(
            feed_fault(capture_scope(snapshot.as_ref(), &xs(), 10.0, pushed)),
            at,
            "capture_scope with a pushdown {forge:?}"
        );
        assert_eq!(control.counts(), (1, 5, 0), "{forge:?}");
    }
}

#[test]
fn a_repeated_id_keeps_its_first_appearance_and_the_malformed_repeat_is_not_examined() {
    let term = leaf();
    let (_store, peer, control) = forging();
    let snapshot = peer.read().unwrap();
    let want = read_anchored(snapshot.as_ref(), ReadRequest::new(&term, X, 10.0)).unwrap();
    control.forge(Forge::MalformedRepeat);
    let got = read_anchored(snapshot.as_ref(), ReadRequest::new(&term, X, 10.0)).unwrap();
    assert_eq!((got.result, got.members), (want.result, want.members));
    let fetched = fetch_scope(snapshot.as_ref(), &xs(), Selection::default()).unwrap();
    assert_eq!(fetched.source.ids().len(), 2);
}

#[test]
fn a_store_reactor_read_and_fetch_answer_the_fault_after_one_read_release_it_and_do_not_start_again(
) {
    let (_store, peer, control) = forging();
    let reactor = StoreReactor::open(Box::new(peer));
    let term = leaf();
    for forge in FORGERIES {
        control.forge(forge);
        assert_eq!(
            read_fault(reactor.read(ReadRequest::new(&term, X, 10.0))),
            Some(Revision(1)),
            "read {forge:?}"
        );
        assert_eq!(control.counts(), (1, 1, 1), "read {forge:?}");
        control.forge(forge);
        let mut request = ReadRequest::new(&term, X, 10.0);
        request.capture = true;
        assert_eq!(
            read_fault(reactor.read(request)),
            Some(Revision(1)),
            "read with a capture {forge:?}"
        );
        assert_eq!(control.counts(), (1, 1, 1), "read with a capture {forge:?}");
        control.forge(forge);
        assert_eq!(
            feed_fault(reactor.fetch(&xs(), Selection::default())),
            Some(Revision(1)),
            "fetch {forge:?}"
        );
        assert_eq!(control.counts(), (1, 1, 1), "fetch {forge:?}");
    }
}

#[test]
fn a_revision_out_of_range_is_found_before_a_malformed_member() {
    let (_store, peer, control) = forging();
    let reactor = StoreReactor::open(Box::new(peer));
    let term = leaf();
    control.forge(Forge::OtherArrival);
    control.revision.set(Some(MAX_REVISION + 1));
    let rule = |fault: StoreFault| fault.rule();
    match reactor.read(ReadRequest::new(&term, X, 10.0)) {
        Err(StoreReadError::Fault(fault)) => assert_eq!(rule(fault), "revision-out-of-range"),
        other => panic!("read answered {other:?}"),
    }
    assert_eq!(control.counts(), (1, 0, 1), "read");
    control.forge(Forge::OtherArrival);
    match reactor.fetch(&xs(), Selection::default()) {
        Err(FeedError::Fault(fault)) => assert_eq!(rule(fault), "revision-out-of-range"),
        other => panic!("fetch answered {other:?}"),
    }
    assert_eq!(control.counts(), (1, 0, 1), "fetch");
}

#[test]
fn held_views_answer_the_fault_after_one_read_release_it_and_keep_what_they_hold() {
    let (store, peer, control) = forging();
    let writer = store.peer("peer:p").unwrap();
    let mut views = StoreViews::new(Box::new(peer), StoreViewsOptions::default()).unwrap();
    views.register("leaf", ViewProgram::new(leaf())).unwrap();
    for forge in FORGERIES {
        control.forge(forge);
        assert_eq!(
            feed_fault(views.hold("leaf", X, 10.0)),
            Some(Revision(1)),
            "hold {forge:?}"
        );
        assert_eq!(control.counts(), (1, 1, 1), "hold {forge:?}");
        assert_eq!(
            views.sizes(),
            ViewSizes::default(),
            "a failed hold kept a view"
        );
    }

    control.forge(Forge::Nothing);
    views.hold("leaf", X, 10.0).unwrap();
    write(writer.as_ref(), &[X]);
    let held = views.sizes();
    for forge in FORGERIES {
        control.forge(forge);
        assert_eq!(
            feed_fault(views.refresh(10.0)),
            Some(Revision(2)),
            "refresh {forge:?}"
        );
        assert_eq!(control.counts(), (1, 1, 1), "refresh {forge:?}");
        assert_eq!(
            views.sizes(),
            held,
            "refresh {forge:?} moved the held views"
        );
    }
    control.forge(Forge::Nothing);
    let refresh = views.refresh(10.0).unwrap();
    assert_eq!(
        (refresh.position.revision, refresh.reread.len()),
        (Revision(2), 1),
        "a failed refresh moved the processed position past the append"
    );
}

#[test]
fn a_feed_error_becomes_the_read_error_of_its_kind_a_refusal_a_store_fault_an_integrity_fault_or_an_evaluator_message(
) {
    let refusal = StoreError::new(StoreErrorCode::SnapshotMoved, "moved");
    let fault = StoreFault::MalformedMember {
        revision: Revision(3),
        detail: "a detail".into(),
    };
    let damage = IntegrityFault {
        kind: IntegrityFaultKind::ClaimsUnreadable,
        peer: Some("peer:p".into()),
        id: Some("1e20aa".into()),
        key: None,
        detail: "damage".into(),
    };
    let converted: Vec<StoreReadError> = vec![
        FeedError::Refused(refusal.clone()).into(),
        FeedError::Fault(fault.clone()).into(),
        FeedError::Integrity(damage.clone()).into(),
        FeedError::Read("the evaluator refused".into()).into(),
    ];
    assert_eq!(
        converted,
        vec![
            StoreReadError::Store(refusal),
            StoreReadError::Fault(fault),
            StoreReadError::Integrity(damage),
            StoreReadError::Eval("the evaluator refused".into()),
        ]
    );
    assert_eq!(
        converted[0].store_code(),
        Some(StoreErrorCode::SnapshotMoved)
    );
}
