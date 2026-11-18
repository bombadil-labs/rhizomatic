//! `retains` on the memory store (SPEC-18 §4.13 reading 108, decision S4-5): the feed always; a
//! purge debt of any peer while one names a target this peer released or owes; never a target
//! the peer did not hold. The shared scripts pin the same lists; these cases name each rule.

use rhizomatic::memory_store::MemoryStore;
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    Admission, AppendResult, ArrivalRecord, ErasurePosture, PeerStore, PurgeOutcome, PurgeReport,
    Retained, RetainedSurface, Store, VerifiedDelta,
};
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};

fn fact(entity: &str, value: f64) -> Delta {
    let claims = Claims {
        timestamp: 1.0,
        valid_from: 1.0,
        valid_until: None,
        author: "did:key:zRetains".into(),
        pointers: vec![
            Pointer {
                role: "subject".into(),
                target: Target::Entity(EntityRef {
                    id: entity.into(),
                    context: Some("height".into()),
                }),
            },
            Pointer {
                role: "value".into(),
                target: Target::Primitive(Primitive::Num(value)),
            },
        ],
    };
    make_delta(claims, None).unwrap()
}

/// Appends `deltas` in one batch after the peer's head and its last sequence.
fn append(peer: &dyn PeerStore, deltas: &[&Delta]) {
    let snapshot = peer.read().unwrap();
    let head = snapshot.head().map(str::to_string);
    let next = snapshot.revision().0 + 1;
    let added = deltas
        .iter()
        .enumerate()
        .map(|(i, delta)| VerifiedDelta {
            delta: (*delta).clone(),
            arrival: ArrivalRecord {
                id: delta.id.clone(),
                at: 1.0,
                sequence: next * 100 + i as u64,
                transfer: next * 100 + i as u64,
                sender: "local".into(),
            },
        })
        .collect();
    let result = peer
        .append(&Admission {
            expected_head: head,
            next_head: format!("head-{next}"),
            frame: None,
            added,
        })
        .unwrap();
    assert!(matches!(result, AppendResult::Committed { .. }));
}

fn purge(peer: &dyn PeerStore, delta: &Delta) -> PurgeReport {
    peer.purge(std::slice::from_ref(&delta.id)).unwrap()
}

/// The outcome and the names of `retains`.
fn told(report: &PurgeReport) -> (PurgeOutcome, Vec<&'static str>) {
    assert!(report.retains.iter().all(|r| r.holds() == "id"));
    (
        report.targets[0].outcome,
        report.retains.iter().map(|r| r.surface.as_str()).collect(),
    )
}

const FEED: &[&str] = &["change-feed"];
const BOTH: &[&str] = &["change-feed", "purge-debt"];

fn peer(store: &MemoryStore, id: &str) -> Box<dyn PeerStore> {
    store.create_peer(id, ErasurePosture::Unproven).unwrap()
}

#[test]
fn the_feed_always_a_debt_while_one_names_the_target_and_never_a_target_not_held() {
    use PurgeOutcome::{HeldByOtherPeer, NotHeld, Removed};
    let store = MemoryStore::new();
    let (a, b, c) = (
        peer(&store, "peer:a"),
        peer(&store, "peer:b"),
        peer(&store, "peer:c"),
    );
    let (x, other) = (fact("plant:x", 1.0), fact("plant:o", 2.0));
    append(a.as_ref(), &[&x]);
    append(b.as_ref(), &[&x, &other]);

    assert_eq!(
        told(&purge(a.as_ref(), &x)),
        (HeldByOtherPeer, BOTH.to_vec())
    );
    // A peer that never held the id learns nothing of the debt that names it.
    assert_eq!(told(&purge(c.as_ref(), &x)), (NotHeld, FEED.to_vec()));
    // The other holder's purge removes the bytes; A's debt still names the id.
    assert_eq!(told(&purge(b.as_ref(), &x)), (Removed, BOTH.to_vec()));
    // A's later ask settles its debt; no debt is left.
    assert_eq!(told(&purge(a.as_ref(), &x)), (Removed, FEED.to_vec()));
    assert_eq!(told(&purge(a.as_ref(), &x)), (NotHeld, FEED.to_vec()));
    assert_eq!(told(&purge(b.as_ref(), &other)), (Removed, FEED.to_vec()));
}

/// An append ends a debt, and the count of peers that owe the id with it.
#[test]
fn an_append_that_ends_a_debt_takes_it_out_of_retains() {
    use PurgeOutcome::{HeldByOtherPeer, Removed};
    let store = MemoryStore::new();
    let (a, b) = (peer(&store, "peer:a"), peer(&store, "peer:b"));
    let x = fact("plant:x", 1.0);
    append(a.as_ref(), &[&x]);
    append(b.as_ref(), &[&x]);
    assert_eq!(
        told(&purge(a.as_ref(), &x)),
        (HeldByOtherPeer, BOTH.to_vec())
    );
    append(a.as_ref(), &[&x]);
    assert_eq!(
        told(&purge(b.as_ref(), &x)),
        (HeldByOtherPeer, BOTH.to_vec())
    );
    assert_eq!(told(&purge(a.as_ref(), &x)), (Removed, BOTH.to_vec()));
    assert_eq!(told(&purge(b.as_ref(), &x)), (Removed, FEED.to_vec()));
}

#[test]
fn the_three_surfaces_have_their_names_and_their_order() {
    let all = [
        RetainedSurface::SurfaceDebt,
        RetainedSurface::ChangeFeed,
        RetainedSurface::PurgeDebt,
    ];
    let mut sorted = all;
    sorted.sort();
    let names: Vec<&str> = sorted.iter().map(|s| s.as_str()).collect();
    assert_eq!(names, ["change-feed", "purge-debt", "surface-debt"]);
    let entry = Retained {
        surface: RetainedSurface::SurfaceDebt,
    };
    assert_eq!(entry.holds(), "id");
}
