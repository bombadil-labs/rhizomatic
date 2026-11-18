//! A snapshot after appends on the memory store (SPEC-18 §4.13 readings 130 and 131). A snapshot
//! keeps its last sequence. A later append gives every new holding a sequence past it, so each
//! call keeps the holdings at or below it and answers as at the snapshot's revision. A purge that
//! releases a holding moves every older snapshot. The scenarios are those of the TypeScript
//! `test/store-tolerant-snapshot.test.ts` that apply to a memory store, scenario 14 included.

use std::cell::Cell;

use crate::refused::as_refusal;
use rhizomatic::eval::result_canonical_hex;
use rhizomatic::memory_store::{MemoryStore, MemoryStoreOptions};
use rhizomatic::set::{make_delta, make_negation_claims};
use rhizomatic::store::{
    Admission, Anchor, AppendResult, ArrivalRecord, ChangePage, ChangeRetention, CreatePeerOptions,
    ErasureClaim, ErasurePosture, PeerErasure, PeerStore, PurgeOutcome, PurgeReport, Pushdown,
    Revision, ScopeRequest, Snapshot, Store, StoreError, StoreFailure, VerifiedDelta,
    MAX_ARRIVAL_COUNTER,
};
use rhizomatic::store_follow::{follow_feed, position_of, Position, Pull};
use rhizomatic::store_fresh::{check_fresh, FeedError, Freshness};
use rhizomatic::store_read::{capture_scope, read_anchored, ReadRequest, Selection};
use rhizomatic::store_with_snapshot::{with_snapshot, OnSnapshot, SnapshotRetry};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Target};

const AUTHOR: &str = "did:key:zTolerant";
const X: &str = "entity:x";
const Y: &str = "entity:y";

thread_local! {
    static STAMP: Cell<u64> = const { Cell::new(0) };
}

fn stamp() -> f64 {
    STAMP.with(|s| {
        s.set(s.get() + 1);
        s.get() as f64
    })
}

fn fact(entity: &str) -> Delta {
    let claims = Claims {
        timestamp: stamp(),
        valid_from: 0.0,
        valid_until: None,
        author: AUTHOR.into(),
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

fn negation(of: &Delta) -> Delta {
    make_delta(make_negation_claims(AUTHOR, stamp(), &of.id, None), None).unwrap()
}

/// A peer and a writer that numbers its own arrivals and heads.
struct Writer {
    store: MemoryStore,
    peer: Box<dyn PeerStore>,
    head: Cell<Option<String>>,
    sequence: Cell<u64>,
    heads: Cell<u64>,
}

impl Writer {
    fn new() -> Self {
        Self::with(MemoryStore::new())
    }

    fn with(store: MemoryStore) -> Self {
        let peer = store
            .create_peer("peer:p", &CreatePeerOptions::new(ErasurePosture::Unproven))
            .unwrap();
        Self {
            store,
            peer,
            head: Cell::new(None),
            sequence: Cell::new(0),
            heads: Cell::new(0),
        }
    }

    fn append(&self, deltas: &[&Delta]) {
        self.heads.set(self.heads.get() + 1);
        self.append_at(deltas, &format!("head-{}", self.heads.get()));
    }

    fn append_at(&self, deltas: &[&Delta], next: &str) {
        let added = deltas
            .iter()
            .map(|delta| {
                self.sequence.set(self.sequence.get() + 1);
                let sequence = self.sequence.get();
                VerifiedDelta {
                    delta: (*delta).clone(),
                    arrival: ArrivalRecord {
                        id: delta.id.clone(),
                        at: 1.0,
                        sequence,
                        transfer: sequence,
                        sender: "test".into(),
                    },
                }
            })
            .collect();
        let result = self
            .peer
            .append(&Admission {
                expected_head: self.head.take(),
                next_head: next.into(),
                frame: None,
                added,
            })
            .unwrap();
        assert!(
            matches!(result, AppendResult::Committed { .. }),
            "{result:?}"
        );
        self.head.set(Some(next.into()));
    }
}

fn code<T>(result: Result<T, StoreError>) -> String {
    match result {
        Ok(_) => "answered".into(),
        Err(e) => e.code.as_str().into(),
    }
}

fn ids(deltas: &[Delta]) -> Vec<String> {
    deltas.iter().map(|d| d.id.clone()).collect()
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

fn anchored(entity: &str) -> ScopeRequest {
    ScopeRequest {
        anchors: vec![Anchor::Entity {
            entity: entity.into(),
        }],
        pushdown: None,
        exclude: Vec::new(),
    }
}

fn scope_ids(s: &dyn Snapshot, entity: &str) -> Vec<String> {
    let result = s.scope(&anchored(entity)).unwrap();
    result.deltas.iter().map(|m| m.delta.id.clone()).collect()
}

/// Every call of a snapshot, the ones that would find no rows included, each with its code.
fn every_call(s: &dyn Snapshot, id: &str) -> Vec<String> {
    let id = vec![id.to_string()];
    let none: Vec<String> = Vec::new();
    let unanchored = ScopeRequest {
        anchors: Vec::new(),
        pushdown: None,
        exclude: Vec::new(),
    };
    vec![
        code(s.get(&id).map_err(as_refusal)),
        code(s.get(&none).map_err(as_refusal)),
        code(s.arrivals(&id).map_err(as_refusal)),
        code(s.targets(&[X.to_string()]).map_err(as_refusal)),
        code(s.targets(&none).map_err(as_refusal)),
        code(s.negators(&id).map_err(as_refusal)),
        code(s.scope(&anchored(X)).map_err(as_refusal)),
        code(s.scope(&unanchored).map_err(as_refusal)),
    ]
}

#[test]
fn a_delta_admitted_after_the_snapshot_at_an_anchored_entity_is_in_neither_targets_nor_scope() {
    let w = Writer::new();
    let held = fact(X);
    w.append(&[&held]);
    let s = w.peer.read().unwrap();
    w.append(&[&fact(X), &fact(X)]);
    assert_eq!(
        s.targets(&[X.into()]).unwrap(),
        std::slice::from_ref(&held.id)
    );
    assert_eq!(scope_ids(s.as_ref(), X), std::slice::from_ref(&held.id));
    let now = w.peer.read().unwrap();
    assert_eq!(now.targets(&[X.into()]).unwrap().len(), 3);
}

#[test]
fn a_negation_admitted_after_the_snapshot_is_in_neither_negators_nor_scope_and_the_evaluation_still_shows_the_claim(
) {
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
    let w = Writer::new();
    let claim = fact(X);
    w.append(&[&claim]);
    let s = w.peer.read().unwrap();
    let before = read_anchored(s.as_ref(), ReadRequest::new(&leaf, X, 10.0)).unwrap();
    let strike = negation(&claim);
    let unstrike = negation(&strike);
    w.append(&[&strike, &unstrike, &negation(&unstrike)]);
    assert!(s
        .negators(std::slice::from_ref(&claim.id))
        .unwrap()
        .is_empty());
    assert_eq!(scope_ids(s.as_ref(), X), std::slice::from_ref(&claim.id));
    let after = read_anchored(s.as_ref(), ReadRequest::new(&leaf, X, 10.0)).unwrap();
    assert_eq!(
        result_canonical_hex(&after.result),
        result_canonical_hex(&before.result)
    );
    assert_eq!(after.members, std::slice::from_ref(&claim.id));
    let now = w.peer.read().unwrap();
    assert_eq!(
        now.negators(std::slice::from_ref(&claim.id)).unwrap(),
        std::slice::from_ref(&strike.id)
    );
    assert_eq!(scope_ids(now.as_ref(), X).len(), 4);
}

#[test]
fn an_id_asked_by_name_that_arrived_after_the_snapshot_is_in_neither_get_nor_arrivals() {
    let w = Writer::new();
    let held = fact(X);
    w.append(&[&held]);
    let s = w.peer.read().unwrap();
    let late = fact(X);
    w.append(&[&late]);
    let both = [held.id.clone(), late.id.clone()];
    assert_eq!(ids(&s.get(&both).unwrap()), std::slice::from_ref(&held.id));
    let arrivals: Vec<String> = s
        .arrivals(&both)
        .unwrap()
        .into_iter()
        .map(|a| a.id)
        .collect();
    assert_eq!(arrivals, std::slice::from_ref(&held.id));
    assert!(s.get(std::slice::from_ref(&late.id)).unwrap().is_empty());
    assert!(s
        .arrivals(std::slice::from_ref(&late.id))
        .unwrap()
        .is_empty());
}

#[test]
fn revision_history_head_count_and_last_sequence_stay_fixed_after_appends_and_count_is_what_get_answers(
) {
    let w = Writer::new();
    let mut all = Vec::new();
    let add = |all: &mut Vec<String>, n: usize| {
        let deltas: Vec<Delta> = (0..n).map(|_| fact(X)).collect();
        all.extend(ids(&deltas));
        w.append(&deltas.iter().collect::<Vec<_>>());
    };
    add(&mut all, 3);
    let s = w.peer.read().unwrap();
    let fixed = |s: &dyn Snapshot| {
        (
            s.revision(),
            s.history().to_string(),
            s.head().map(str::to_string),
            s.count(),
            s.last_sequence(),
        )
    };
    let first = fixed(s.as_ref());
    assert_eq!(
        (first.2.as_deref(), first.3, first.4),
        (Some("head-1"), 3, 3)
    );
    for _ in 0..4 {
        add(&mut all, 2);
    }
    assert_eq!(fixed(s.as_ref()), first);
    assert_eq!(s.get(&all).unwrap().len() as u64, s.count());
    let now = w.peer.read().unwrap();
    assert_eq!(
        (now.revision(), now.count(), now.last_sequence()),
        (Revision(5), 11, 11)
    );
}

#[test]
fn a_head_only_append_refuses_nothing_and_the_answers_and_the_head_are_the_snapshots() {
    let w = Writer::new();
    let held = fact(X);
    w.append(&[&held]);
    let s = w.peer.read().unwrap();
    w.append_at(&[], "head-only");
    assert_eq!(w.peer.read().unwrap().revision().0, s.revision().0 + 1);
    assert_eq!(s.head(), Some("head-1"));
    assert_eq!(every_call(s.as_ref(), &held.id), vec!["answered"; 8]);
    assert_eq!(
        s.targets(&[X.into()]).unwrap(),
        std::slice::from_ref(&held.id)
    );
}

#[test]
fn after_a_purge_and_the_same_id_appended_again_the_old_snapshot_refuses_every_call_the_empty_ones_too(
) {
    let w = Writer::new();
    let again = fact(X);
    w.append(&[&again, &fact(X)]);
    let s = w.peer.read().unwrap();
    let report = w.peer.purge(std::slice::from_ref(&again.id)).unwrap();
    assert_eq!(report.targets[0].outcome, PurgeOutcome::Removed);
    w.append(&[&again]);
    w.append(&[&fact(X)]);
    assert_eq!(every_call(s.as_ref(), &again.id), vec!["snapshot-moved"; 8]);
    let now = w.peer.read().unwrap();
    assert_eq!(now.targets(&[X.into()]).unwrap().len(), 3);
}

#[test]
fn a_purge_that_releases_nothing_and_a_purge_of_another_peer_move_no_older_snapshot_of_this_peer() {
    let w = Writer::new();
    let held = fact(X);
    w.append(&[&held]);
    let s = w.peer.read().unwrap();
    w.append(&[&fact(Y)]);
    let other = w
        .store
        .create_peer("peer:q", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap();
    let shared = fact(X);
    other
        .append(&Admission {
            expected_head: None,
            next_head: "q".into(),
            frame: None,
            added: vec![VerifiedDelta {
                arrival: ArrivalRecord {
                    id: shared.id.clone(),
                    at: 1.0,
                    sequence: 1,
                    transfer: 1,
                    sender: "q".into(),
                },
                delta: shared.clone(),
            }],
        })
        .unwrap();
    let nothing = w.peer.purge(&[fact(X).id]).unwrap();
    assert_eq!(nothing.claim, ErasureClaim::NothingRemoved);
    let released = other.purge(std::slice::from_ref(&shared.id)).unwrap();
    assert_ne!(released.claim, ErasureClaim::NothingRemoved);
    assert_eq!(
        s.targets(&[X.into()]).unwrap(),
        std::slice::from_ref(&held.id)
    );
    assert_eq!(every_call(s.as_ref(), &held.id), vec!["answered"; 8]);
}

#[test]
fn two_peers_share_ids_across_a_snapshot_and_the_other_peers_holding_neither_adds_to_nor_removes_from_this_peers_answers(
) {
    let w = Writer::new();
    let held = fact(X);
    w.append(&[&held, &fact(Y)]);
    let s = w.peer.read().unwrap();
    let late = fact(X);
    let strike = negation(&held);
    let other = w
        .store
        .create_peer("peer:q", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap();
    let added = [(&late, 1), (&strike, 2), (&held, 100)]
        .into_iter()
        .map(|(delta, sequence)| VerifiedDelta {
            delta: delta.clone(),
            arrival: ArrivalRecord {
                id: delta.id.clone(),
                at: 1.0,
                sequence,
                transfer: 1,
                sender: "q".into(),
            },
        })
        .collect();
    let result = other
        .append(&Admission {
            expected_head: None,
            next_head: "q".into(),
            frame: None,
            added,
        })
        .unwrap();
    assert!(matches!(result, AppendResult::Committed { .. }));
    w.append(&[&late, &strike]);
    assert_eq!(
        s.targets(&[X.into()]).unwrap(),
        std::slice::from_ref(&held.id)
    );
    assert!(s
        .negators(std::slice::from_ref(&held.id))
        .unwrap()
        .is_empty());
    assert_eq!(scope_ids(s.as_ref(), X), std::slice::from_ref(&held.id));
    let now = w.peer.read().unwrap();
    assert_eq!(
        now.targets(&[X.into()]).unwrap(),
        sorted(vec![held.id.clone(), late.id.clone()])
    );
    assert_eq!(
        now.negators(std::slice::from_ref(&held.id)).unwrap(),
        std::slice::from_ref(&strike.id)
    );
}

#[test]
fn an_arrival_bound_above_the_snapshots_last_sequence_keeps_the_snapshots_set_and_is_reported_applied(
) {
    let w = Writer::new();
    let held = fact(X);
    w.append(&[&held]);
    let s = w.peer.read().unwrap();
    w.append(&[&fact(X), &fact(X)]);
    let bounded = |n: u64| ScopeRequest {
        pushdown: Some(Pushdown {
            arrival_at_most: Some(n),
            ..Pushdown::default()
        }),
        ..anchored(X)
    };
    let result = s.scope(&bounded(MAX_ARRIVAL_COUNTER)).unwrap();
    let got: Vec<String> = result.deltas.iter().map(|m| m.delta.id.clone()).collect();
    assert_eq!(got, std::slice::from_ref(&held.id));
    assert!(result.applied.arrival_at_most);
    assert!(s.scope(&bounded(0)).unwrap().deltas.is_empty());
}

#[test]
fn with_two_records_kept_five_appends_trim_what_a_snapshots_position_needs_and_get_still_answers_the_snapshots_state(
) {
    let store = MemoryStore::with_options(MemoryStoreOptions {
        change_retention: ChangeRetention::Revisions(2),
        ..MemoryStoreOptions::default()
    })
    .unwrap();
    let w = Writer::with(store);
    let held = fact(X);
    w.append(&[&held]);
    let s = w.peer.read().unwrap();
    let (_, capture) = capture_scope(s.as_ref(), &[X.into()], 0.0, Selection::default()).unwrap();
    let position = position_of(s.as_ref());
    for _ in 0..5 {
        w.append(&[&fact(X)]);
    }
    assert_eq!(
        check_fresh(w.peer.as_ref(), &capture, 0.0).unwrap(),
        Freshness::ResyncRequired {
            current: Revision(6)
        }
    );
    assert_eq!(
        follow_feed(w.peer.as_ref(), position)
            .unwrap()
            .pull()
            .unwrap(),
        Pull::ResyncRequired {
            current: Position {
                history: s.history().into(),
                revision: Revision(6),
            }
        }
    );
    assert_eq!(
        ids(&s.get(std::slice::from_ref(&held.id)).unwrap()),
        std::slice::from_ref(&held.id)
    );
    assert_eq!(
        s.targets(&[X.into()]).unwrap(),
        std::slice::from_ref(&held.id)
    );
}

/// A handle that counts snapshots and appends one fact during each of its first `appends`
/// `changes` calls.
struct Moving<'a> {
    writer: &'a Writer,
    reads: Cell<usize>,
    appends: Cell<usize>,
}

impl PeerStore for Moving<'_> {
    fn id(&self) -> &str {
        self.writer.peer.id()
    }
    fn erasure(&self) -> PeerErasure {
        self.writer.peer.erasure()
    }
    fn history(&self) -> Result<&str, StoreError> {
        self.writer.peer.history()
    }
    fn app_format(&self) -> Result<Option<&str>, StoreError> {
        self.writer.peer.app_format()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        self.reads.set(self.reads.get() + 1);
        self.writer.peer.read()
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.writer.peer.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreFailure> {
        self.writer.peer.purge(ids)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreFailure> {
        let page = self.writer.peer.changes(from, to);
        if self.appends.get() > 0 {
            self.appends.set(self.appends.get() - 1);
            self.writer.append(&[&fact(X)]);
        }
        page
    }
}

#[test]
fn a_pull_during_appends_answers_from_one_snapshot_at_that_snapshots_position_with_one_read() {
    let w = Writer::new();
    let start = position_of(w.peer.read().unwrap().as_ref());
    let first = fact(X);
    w.append(&[&first]);
    let moving = Moving {
        writer: &w,
        reads: Cell::new(0),
        appends: Cell::new(3),
    };
    let pull = follow_feed(&moving, start.clone()).unwrap().pull().unwrap();
    assert_eq!(moving.reads.get(), 1);
    let Pull::Ok {
        position, deltas, ..
    } = pull
    else {
        panic!("the pull answers: {pull:?}");
    };
    assert_eq!(
        position,
        Position {
            history: start.history,
            revision: Revision(1),
        }
    );
    let got: Vec<String> = deltas.iter().map(|d| d.delta.id.clone()).collect();
    assert_eq!(got, std::slice::from_ref(&first.id));
}

#[test]
fn a_body_that_appends_and_then_reads_does_not_see_its_own_write_and_runs_once() {
    let w = Writer::new();
    let held = fact(X);
    w.append(&[&held]);
    let OnSnapshot { value, attempts } = with_snapshot(
        w.peer.as_ref(),
        |s, _| {
            w.append(&[&fact(X)]);
            s.targets(&[X.to_string()]).map_err(FeedError::from)
        },
        &SnapshotRetry::default(),
    )
    .unwrap();
    assert_eq!((value, attempts), (vec![held.id.clone()], 1));
}
