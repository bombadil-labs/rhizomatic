//! Moves a peer's snapshots with a purge, as the TypeScript `test/support/move-snapshot.ts`
//! does. A test that needs an older snapshot to move uses this, not an append alone: a purge that
//! releases a holding moves every older snapshot on every store (SPEC-18 §4.13 reading 130), and
//! an append need not. The delta it admits and purges has one pointer, at `SACRIFICIAL`, so no
//! read under test meets it.
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    Admission, AppendResult, ArrivalRecord, PeerStore, PurgeOutcome, VerifiedDelta,
};
use rhizomatic::types::{Claims, EntityRef, Pointer, Target};

/// The entity of every sacrificial delta. No test reads it.
pub const SACRIFICIAL: &str = "entity:sacrificial";

/// Admits one sacrificial delta at the peer's head and past its last sequence, then purges it.
/// The head does not change. The peer's revision moves twice.
pub fn move_by_purge(peer: &dyn PeerStore) {
    let mut now = peer.read().unwrap();
    let head = now.head().expect("a peer with a head").to_string();
    let next = now.last_sequence() + 1;
    now.release();
    let claims = Claims {
        timestamp: next as f64,
        valid_from: 0.0,
        valid_until: None,
        author: "did:key:zSacrificial".into(),
        pointers: vec![Pointer {
            role: "sacrificial".into(),
            target: Target::Entity(EntityRef {
                id: SACRIFICIAL.into(),
                context: None,
            }),
        }],
    };
    let delta = make_delta(claims, None).unwrap();
    let id = delta.id.clone();
    let result = peer
        .append(&Admission {
            expected_head: Some(head.clone()),
            next_head: head,
            frame: None,
            added: vec![VerifiedDelta {
                arrival: ArrivalRecord {
                    id: id.clone(),
                    at: 0.0,
                    sequence: next,
                    transfer: next,
                    sender: "sacrificial".into(),
                },
                delta,
            }],
        })
        .unwrap();
    assert!(
        matches!(&result, AppendResult::Committed { added, .. } if added == std::slice::from_ref(&id)),
        "{result:?}"
    );
    let report = peer.purge(std::slice::from_ref(&id)).unwrap();
    assert_eq!(report.targets[0].outcome, PurgeOutcome::Removed);
}
