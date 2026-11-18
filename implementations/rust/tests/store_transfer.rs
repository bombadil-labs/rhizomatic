//! The transfer ordinal on the memory store (SPEC-18 §4.13 reading 135). A new holding's
//! transfer must pass the peer's last one, else the append is refused `invalid-admission` and
//! nothing changes. A skipped entry, held or repeated in the batch, is not compared and does not
//! raise it. The commit sets it to the largest transfer of the new entries. A head-only append
//! keeps it, and a purge keeps it also when it removes the holding with the largest transfer. The
//! cases follow the transfer tests of the TypeScript `test/store-admission-of.test.ts` that need
//! no `admission_of`, and add the repeat inside a batch.

use rhizomatic::memory_store::MemoryStore;
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    Admission, AppendResult, ArrivalRecord, ErasurePosture, PeerStore, PurgeOutcome, Revision,
    Store, StoreErrorCode, VerifiedDelta,
};
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Target};

fn fact(entity: &str) -> Delta {
    let claims = Claims {
        timestamp: 1.0,
        valid_from: 0.0,
        valid_until: None,
        author: "did:key:zTransfer".into(),
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

fn entry(delta: &Delta, sequence: u64, transfer: u64) -> VerifiedDelta {
    VerifiedDelta {
        delta: delta.clone(),
        arrival: ArrivalRecord {
            id: delta.id.clone(),
            at: 1.0,
            sequence,
            transfer,
            sender: "local".into(),
        },
    }
}

fn admission(from: Option<&str>, to: &str, added: Vec<VerifiedDelta>) -> Admission {
    Admission {
        expected_head: from.map(str::to_string),
        next_head: to.into(),
        frame: None,
        added,
    }
}

fn added(peer: &dyn PeerStore, batch: &Admission) -> Vec<String> {
    match peer.append(batch).unwrap() {
        AppendResult::Committed { added, .. } => added,
        other => panic!("{other:?}"),
    }
}

fn new_peer(store: &MemoryStore) -> Box<dyn PeerStore> {
    store
        .create_peer("peer:p", ErasurePosture::Unproven)
        .unwrap()
}

#[test]
fn last_transfer_is_0_on_a_new_peer_is_the_committed_transfer_after_each_append_is_fixed_on_a_snapshot_and_stays_after_a_head_only_append_and_a_purge(
) {
    let store = MemoryStore::new();
    let peer = new_peer(&store);
    let (x, y, gone) = (fact("x"), fact("y"), fact("gone"));
    let first = peer.read().unwrap();
    assert_eq!(first.last_transfer(), 0);
    added(peer.as_ref(), &admission(None, "h1", vec![entry(&x, 1, 1)]));
    let second = peer.read().unwrap();
    assert_eq!(second.last_transfer(), 1);
    added(
        peer.as_ref(),
        &admission(Some("h1"), "h2", vec![entry(&y, 2, 2), entry(&gone, 3, 3)]),
    );
    assert_eq!((first.last_transfer(), second.last_transfer()), (0, 1));
    let third = peer.read().unwrap();
    assert_eq!(third.last_transfer(), 3);
    added(peer.as_ref(), &admission(Some("h2"), "h3", vec![]));
    let report = peer.purge(std::slice::from_ref(&gone.id)).unwrap();
    assert_eq!(report.targets[0].outcome, PurgeOutcome::Removed);
    let last = peer.read().unwrap();
    assert_eq!((last.last_transfer(), last.head()), (3, Some("h3")));
    let mut transfers: Vec<u64> = last
        .arrivals(&[x.id.clone(), y.id.clone()])
        .unwrap()
        .iter()
        .map(|a| a.transfer)
        .collect();
    transfers.sort();
    assert_eq!(transfers, [1, 2]);
}

#[test]
fn a_held_entry_with_a_higher_transfer_is_skipped_and_does_not_raise_the_last_transfer() {
    let store = MemoryStore::new();
    let peer = new_peer(&store);
    let (x, y) = (fact("x"), fact("y"));
    added(peer.as_ref(), &admission(None, "h1", vec![entry(&x, 1, 1)]));
    let got = added(
        peer.as_ref(),
        &admission(Some("h1"), "h2", vec![entry(&x, 2, 50), entry(&y, 3, 2)]),
    );
    assert_eq!(got, std::slice::from_ref(&y.id));
    let now = peer.read().unwrap();
    let held = now.arrivals(std::slice::from_ref(&x.id)).unwrap();
    assert_eq!((now.last_transfer(), held[0].transfer), (2, 1));
}

#[test]
fn a_repeat_inside_the_batch_whose_transfer_does_not_pass_the_last_is_skipped_and_the_append_commits(
) {
    let store = MemoryStore::new();
    let peer = new_peer(&store);
    let (x, y) = (fact("x"), fact("y"));
    added(peer.as_ref(), &admission(None, "h1", vec![entry(&x, 1, 5)]));
    let got = added(
        peer.as_ref(),
        &admission(Some("h1"), "h2", vec![entry(&y, 2, 6), entry(&y, 3, 5)]),
    );
    assert_eq!(got, std::slice::from_ref(&y.id));
    let now = peer.read().unwrap();
    let held = now.arrivals(std::slice::from_ref(&y.id)).unwrap();
    assert_eq!((now.last_transfer(), held[0].transfer), (6, 6));
}

#[test]
fn a_new_entry_whose_transfer_does_not_pass_the_peers_last_is_refused_and_changes_nothing_and_the_last_is_the_largest_of_an_append(
) {
    let store = MemoryStore::new();
    let peer = new_peer(&store);
    let (x, y, z) = (fact("x"), fact("y"), fact("z"));
    added(
        peer.as_ref(),
        &admission(None, "h1", vec![entry(&x, 1, 7), entry(&y, 2, 3)]),
    );
    let before = peer.read().unwrap();
    assert_eq!(before.last_transfer(), 7);
    for transfer in [3, 7] {
        let refused = peer
            .append(&admission(Some("h1"), "h2", vec![entry(&z, 3, transfer)]))
            .unwrap_err();
        assert_eq!(
            (transfer, refused.code),
            (transfer, StoreErrorCode::InvalidAdmission)
        );
    }
    let now = peer.read().unwrap();
    assert_eq!(
        (
            now.revision(),
            now.head(),
            now.last_transfer(),
            now.last_sequence()
        ),
        (before.revision(), Some("h1"), 7, 2)
    );
    assert!(now.get(std::slice::from_ref(&z.id)).unwrap().is_empty());
    let got = added(
        peer.as_ref(),
        &admission(Some("h1"), "h2", vec![entry(&x, 3, 1), entry(&z, 4, 8)]),
    );
    assert_eq!(got, std::slice::from_ref(&z.id));
    assert_eq!(peer.read().unwrap().last_transfer(), 8);
    assert_eq!(peer.read().unwrap().revision(), Revision(2));
}
