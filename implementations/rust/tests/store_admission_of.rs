//! `admission_of` on the memory store (SPEC-18 §4.13 reading 133): it builds an append from a
//! snapshot for a host with no journal. The cases are those of the TypeScript
//! `test/store-admission-of.test.ts` that apply to a memory store and to Rust's types. The
//! application format and transfer cases of that file are in `store_app_format.rs` and
//! `store_transfer.rs`.

use std::cell::Cell;

use rhizomatic::memory_store::MemoryStore;
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    Admission, AppendResult, ArrivalRecord, CreatePeerOptions, ErasurePosture, PeerStore,
    PushdownFields, Revision, ScopeRequest, ScopeResult, Snapshot, Store, StoreError,
    StoreErrorCode, MAX_ARRIVAL_COUNTER,
};
use rhizomatic::store_admission::{admission_of, AdmissionOptions};
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Target};

use crate::move_snapshot::move_by_purge;

thread_local! {
    static STAMP: Cell<u64> = const { Cell::new(0) };
    static HEADS: Cell<u64> = const { Cell::new(0) };
}

fn next(counter: &'static std::thread::LocalKey<Cell<u64>>) -> u64 {
    counter.with(|c| {
        c.set(c.get() + 1);
        c.get()
    })
}

fn fact(entity: &str) -> Delta {
    let claims = Claims {
        timestamp: next(&STAMP) as f64,
        valid_from: 0.0,
        valid_until: None,
        author: "did:key:zAdmissionOf".into(),
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

fn options() -> AdmissionOptions {
    AdmissionOptions {
        at: 10.0,
        sender: "local".into(),
        next_head: format!("head-{}", next(&HEADS)),
    }
}

fn new_peer(store: &MemoryStore) -> Box<dyn PeerStore> {
    store
        .create_peer("peer:p", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap()
}

fn build(peer: &dyn PeerStore, deltas: &[Delta]) -> Admission {
    admission_of(peer.read().unwrap().as_ref(), deltas, options()).unwrap()
}

fn committed(peer: &dyn PeerStore, batch: &Admission) -> (Revision, Vec<String>) {
    match peer.append(batch).unwrap() {
        AppendResult::Committed { revision, added } => (revision, added),
        other => panic!("{other:?}"),
    }
}

fn ids(deltas: &[Delta]) -> Vec<String> {
    deltas.iter().map(|d| d.id.clone()).collect()
}

#[test]
fn after_a_purge_an_admission_built_by_the_helper_commits_at_last_sequence_plus_1_and_the_count_plus_1_guess_is_refused_invalid_admission(
) {
    let store = MemoryStore::new();
    let peer = new_peer(&store);
    let kept = fact("x");
    committed(peer.as_ref(), &build(peer.as_ref(), &[kept]));
    move_by_purge(peer.as_ref());
    let after = peer.read().unwrap();
    assert_eq!((after.count(), after.last_sequence()), (1, 2));
    let next = fact("x");
    let built = admission_of(after.as_ref(), std::slice::from_ref(&next), options()).unwrap();
    let mut guess = built.clone();
    for member in &mut guess.added {
        member.arrival.sequence = after.count() + 1;
    }
    assert_eq!(
        peer.append(&guess).unwrap_err().code,
        StoreErrorCode::InvalidAdmission
    );
    assert_eq!(
        committed(peer.as_ref(), &built),
        (Revision(after.revision().0 + 1), vec![next.id.clone()])
    );
    let now = peer.read().unwrap();
    assert_eq!(
        now.get(std::slice::from_ref(&next.id)).unwrap(),
        vec![next.clone()]
    );
    let sequences: Vec<u64> = now
        .arrivals(std::slice::from_ref(&next.id))
        .unwrap()
        .iter()
        .map(|a| a.sequence)
        .collect();
    assert_eq!(sequences, vec![3]);
    assert_eq!(
        (now.count(), now.last_sequence(), now.head()),
        (2, 3, Some(built.next_head.as_str()))
    );
}

#[test]
fn gives_two_ids_their_sequences_in_ascending_id_order_whatever_the_order_given_with_one_record_per_id(
) {
    let store = MemoryStore::new();
    let peer = new_peer(&store);
    let mut pair = [fact("a"), fact("b")];
    pair.sort_by(|p, q| p.id.cmp(&q.id));
    let [low, high] = pair;
    let built = build(peer.as_ref(), &[high.clone(), low.clone(), high.clone()]);
    assert_eq!(
        (built.expected_head.clone(), built.frame.clone()),
        (None, None)
    );
    let numbered: Vec<(String, u64)> = built
        .added
        .iter()
        .map(|m| (m.delta.id.clone(), m.arrival.sequence))
        .collect();
    assert_eq!(numbered, vec![(low.id.clone(), 1), (high.id.clone(), 2)]);
    committed(peer.as_ref(), &built);
    let records = peer
        .read()
        .unwrap()
        .arrivals(&[low.id.clone(), high.id.clone()])
        .unwrap();
    let expected: Vec<ArrivalRecord> = [&low, &high]
        .iter()
        .zip(1..)
        .map(|(d, sequence)| ArrivalRecord {
            id: d.id.clone(),
            at: 10.0,
            sequence,
            transfer: 1,
            sender: "local".into(),
        })
        .collect();
    assert_eq!(records, expected);
}

#[test]
fn an_admission_built_on_a_snapshot_whose_head_another_append_replaced_answers_conflict_and_changes_nothing(
) {
    let store = MemoryStore::new();
    let peer = new_peer(&store);
    committed(peer.as_ref(), &build(peer.as_ref(), &[fact("x")]));
    let stale = peer.read().unwrap();
    let replaced = admission_of(stale.as_ref(), &[fact("x")], options()).unwrap();
    committed(peer.as_ref(), &replaced);
    let before = peer.read().unwrap();
    let late = fact("y");
    let asked = admission_of(stale.as_ref(), std::slice::from_ref(&late), options()).unwrap();
    assert_eq!(peer.append(&asked).unwrap(), AppendResult::Conflict);
    let now = peer.read().unwrap();
    assert_eq!(
        (now.revision(), now.count(), now.last_sequence(), now.head()),
        (
            before.revision(),
            before.count(),
            before.last_sequence(),
            before.head()
        )
    );
    assert_eq!(now.get(std::slice::from_ref(&late.id)).unwrap(), vec![]);
}

#[test]
fn an_empty_list_builds_a_head_only_append_an_id_the_peer_holds_is_skipped_at_append_and_its_sequence_is_not_used(
) {
    let store = MemoryStore::new();
    let peer = new_peer(&store);
    let held = fact("x");
    committed(
        peer.as_ref(),
        &build(peer.as_ref(), std::slice::from_ref(&held)),
    );
    let empty = build(peer.as_ref(), &[]);
    assert_eq!(empty.added, vec![]);
    assert_eq!(committed(peer.as_ref(), &empty).1, Vec::<String>::new());
    assert_eq!(peer.read().unwrap().head(), Some(empty.next_head.as_str()));
    let fresh = fact("y");
    let both = build(peer.as_ref(), &[held.clone(), fresh.clone()]);
    assert_eq!(committed(peer.as_ref(), &both).1, vec![fresh.id.clone()]);
    let now = peer.read().unwrap();
    assert_eq!(
        now.arrivals(std::slice::from_ref(&held.id)).unwrap()[0].sequence,
        1
    );
    let fresh_sequence = both
        .added
        .iter()
        .find(|m| m.delta.id == fresh.id)
        .unwrap()
        .arrival
        .sequence;
    assert_eq!(now.last_sequence(), fresh_sequence);
}

/// A snapshot with fixed point reads. Each query counts a touch and answers nothing.
struct Fixed {
    head: Option<String>,
    last_sequence: u64,
    last_transfer: u64,
    touched: Cell<usize>,
}

fn at(head: Option<&str>, last_sequence: u64, last_transfer: u64) -> Fixed {
    Fixed {
        head: head.map(str::to_string),
        last_sequence,
        last_transfer,
        touched: Cell::new(0),
    }
}

impl Fixed {
    fn touch<T>(&self, answer: T) -> Result<T, StoreError> {
        self.touched.set(self.touched.get() + 1);
        Ok(answer)
    }
}

impl Snapshot for Fixed {
    fn revision(&self) -> Revision {
        Revision(1)
    }
    fn history(&self) -> &str {
        "fixed"
    }
    fn head(&self) -> Option<&str> {
        self.head.as_deref()
    }
    fn count(&self) -> u64 {
        0
    }
    fn last_sequence(&self) -> u64 {
        self.last_sequence
    }
    fn last_transfer(&self) -> u64 {
        self.last_transfer
    }
    fn get(&self, _: &[String]) -> Result<Vec<Delta>, StoreError> {
        self.touch(Vec::new())
    }
    fn arrivals(&self, _: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        self.touch(Vec::new())
    }
    fn targets(&self, _: &[String]) -> Result<Vec<String>, StoreError> {
        self.touch(Vec::new())
    }
    fn negators(&self, _: &[String]) -> Result<Vec<String>, StoreError> {
        self.touch(Vec::new())
    }
    fn scope(&self, _: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        self.touch(ScopeResult {
            deltas: Vec::new(),
            applied: PushdownFields::default(),
        })
    }
    fn release(&mut self) {
        self.touched.set(self.touched.get() + 1);
    }
}

fn code(result: Result<Admission, StoreError>) -> String {
    match result {
        Ok(_) => "built".into(),
        Err(e) => e.code.as_str().into(),
    }
}

#[test]
fn refuses_each_bad_option_a_bad_snapshot_and_a_bad_delta_invalid_request_and_calls_no_snapshot_query(
) {
    let snapshot = at(Some("h"), 4, 0);
    let x = fact("x");
    let mut forged = x.clone();
    forged.claims.timestamp += 1.0;
    let mut unsigned = x.clone();
    unsigned.sig = Some("AB".into());
    let mut no_id = x.clone();
    no_id.id = String::new();
    let with = |change: fn(&mut AdmissionOptions)| {
        let mut asked = options();
        change(&mut asked);
        asked
    };
    let max = MAX_ARRIVAL_COUNTER;
    let one = std::slice::from_ref(&x);
    let cases: Vec<(&str, Result<Admission, StoreError>)> = vec![
        (
            "next_head empty",
            admission_of(&snapshot, one, with(|o| o.next_head.clear())),
        ),
        (
            "at not finite",
            admission_of(&snapshot, one, with(|o| o.at = f64::NAN)),
        ),
        (
            "at infinite",
            admission_of(&snapshot, one, with(|o| o.at = f64::INFINITY)),
        ),
        (
            "sender empty",
            admission_of(&snapshot, one, with(|o| o.sender.clear())),
        ),
        (
            "a forged delta",
            admission_of(&snapshot, std::slice::from_ref(&forged), options()),
        ),
        (
            "a forged repeat of a delta",
            admission_of(&snapshot, &[x.clone(), forged.clone()], options()),
        ),
        (
            "a malformed signature",
            admission_of(&snapshot, std::slice::from_ref(&unsigned), options()),
        ),
        (
            "a repeat of a delta with a malformed signature",
            admission_of(&snapshot, &[x.clone(), unsigned.clone()], options()),
        ),
        (
            "a delta with an empty id",
            admission_of(&snapshot, &[no_id], options()),
        ),
        (
            "last_sequence past 2^53 - 1",
            admission_of(&at(None, max + 1, 0), &[], options()),
        ),
        (
            "last_transfer past 2^53 - 1",
            admission_of(&at(None, 0, max + 1), &[], options()),
        ),
        (
            "a head that is empty",
            admission_of(&at(Some(""), 0, 0), one, options()),
        ),
        (
            "sequences past 2^53 - 1",
            admission_of(&at(None, max, 0), one, options()),
        ),
        (
            "a transfer past 2^53 - 1",
            admission_of(&at(None, 0, max), one, options()),
        ),
    ];
    for (name, result) in cases {
        assert_eq!((name, code(result)), (name, "invalid-request".to_string()));
    }
    assert_eq!(snapshot.touched.get(), 0);
    assert_eq!(code(admission_of(&snapshot, one, options())), "built");
    assert_eq!(
        code(admission_of(&at(None, 0, max), &[], options())),
        "built"
    );
    assert_eq!(
        code(admission_of(&at(None, max, 0), &[], options())),
        "built"
    );
    assert_eq!(snapshot.touched.get(), 0);
}

#[test]
fn numbers_the_transfer_last_transfer_plus_1_for_every_entry_and_passes_sender_and_at_through() {
    let snapshot = at(Some("h"), 4, 9);
    let built = admission_of(
        &snapshot,
        &[fact("a"), fact("b")],
        AdmissionOptions {
            at: 33.5,
            sender: "peer:sender".into(),
            next_head: "head-n".into(),
        },
    )
    .unwrap();
    let seen: Vec<(u64, &str, f64)> = built
        .added
        .iter()
        .map(|m| (m.arrival.transfer, m.arrival.sender.as_str(), m.arrival.at))
        .collect();
    assert_eq!(
        seen,
        vec![(10, "peer:sender", 33.5), (10, "peer:sender", 33.5)]
    );
    let sequences: Vec<u64> = built.added.iter().map(|m| m.arrival.sequence).collect();
    assert_eq!(sequences, vec![5, 6]);
    assert_eq!(
        (built.expected_head.as_deref(), built.next_head.as_str()),
        (Some("h"), "head-n")
    );
}

#[test]
fn an_at_of_minus_0_is_plus_0_in_every_arrival_record() {
    let mut asked = options();
    asked.at = -0.0;
    let built = admission_of(&at(Some("h"), 4, 9), &[fact("a")], asked).unwrap();
    let got = built.added[0].arrival.at;
    assert_eq!((got, got.is_sign_positive()), (0.0, true));
}

#[test]
fn of_a_repeated_id_it_keeps_the_first_entry_also_when_the_repeat_carries_another_signature() {
    let x = fact("x");
    let mut first = x.clone();
    first.sig = Some("a".repeat(128));
    let mut second = x.clone();
    second.sig = Some("b".repeat(128));
    let built = admission_of(&at(Some("h"), 4, 9), &[first.clone(), second], options()).unwrap();
    let kept: Vec<Delta> = built.added.iter().map(|m| m.delta.clone()).collect();
    assert_eq!(ids(&kept), ids(std::slice::from_ref(&first)));
    assert_eq!(kept, vec![first]);
}

#[test]
fn a_last_sequence_of_2_pow_53_minus_2_with_one_id_given_twice_builds_one_entry_at_2_pow_53_minus_1(
) {
    let x = fact("x");
    let built = admission_of(
        &at(Some("h"), MAX_ARRIVAL_COUNTER - 1, 0),
        &[x.clone(), x.clone()],
        options(),
    )
    .unwrap();
    let numbered: Vec<(String, u64)> = built
        .added
        .iter()
        .map(|m| (m.delta.id.clone(), m.arrival.sequence))
        .collect();
    assert_eq!(numbered, vec![(x.id.clone(), MAX_ARRIVAL_COUNTER)]);
}
