//! The memory store's change feed (SPEC-18 §4.6, §4.13) where the shared vectors cannot reach:
//! bounds a JSON document cannot carry to a typed store, the store's own options, and the ids a
//! record keeps after a purge. The vectors and `store_feed_rules.rs` hold the rest.

use rhizomatic::memory_store::{MemoryStore, MemoryStoreOptions};
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    Admission, AppendResult, ArrivalRecord, ChangePage, ChangeRecord, ChangeRetention,
    ErasurePosture, PeerStore, Revision, Store, StoreErrorCode, VerifiedDelta, MAX_REVISION,
};
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};

fn fact(entity: &str, value: f64) -> Delta {
    let claims = Claims {
        timestamp: 1.0,
        valid_from: 1.0,
        valid_until: None,
        author: "did:key:zFeed".into(),
        pointers: vec![
            Pointer {
                role: "subject".into(),
                target: Target::Entity(EntityRef {
                    id: entity.into(),
                    context: Some("value".into()),
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

fn held(delta: &Delta, sequence: u64) -> VerifiedDelta {
    VerifiedDelta {
        delta: delta.clone(),
        arrival: ArrivalRecord {
            id: delta.id.clone(),
            at: 1000.0,
            sequence,
            transfer: sequence,
            sender: "local".into(),
        },
    }
}

fn append(peer: &dyn PeerStore, expected: Option<&str>, next: &str, added: Vec<VerifiedDelta>) {
    let result = peer
        .append(&Admission {
            expected_head: expected.map(str::to_string),
            next_head: next.into(),
            frame: None,
            added,
        })
        .unwrap();
    assert!(
        matches!(result, AppendResult::Committed { .. }),
        "{result:?}"
    );
}

fn code(answer: Result<ChangePage, rhizomatic::store::StoreError>) -> StoreErrorCode {
    answer.expect_err("the store must refuse").code
}

fn records(page: ChangePage) -> (Vec<ChangeRecord>, Revision) {
    match page {
        ChangePage::Ok { records, through } => (records, through),
        other => panic!("expected a page, the store answered {other:?}"),
    }
}

fn resync(page: ChangePage) -> Revision {
    match page {
        ChangePage::ResyncRequired { current } => current,
        other => panic!("expected resync-required, the store answered {other:?}"),
    }
}

/// A peer with three head-only commits, on a store built with these options.
fn three_commits(options: MemoryStoreOptions) -> (MemoryStore, Box<dyn PeerStore>) {
    let store = MemoryStore::with_options(options).unwrap();
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    append(peer.as_ref(), None, "h1", vec![]);
    append(peer.as_ref(), Some("h1"), "h2", vec![]);
    append(peer.as_ref(), Some("h2"), "h3", vec![]);
    (store, peer)
}

/// SPEC-18 §4.13 readings 1 to 4: a bound is an integer from 0 to 2^53 − 1; the shape of the
/// bounds comes first, then `to` below `from`, then a `from` from the future, then a `from`
/// below the floor; a defaulted `to` is never compared.
#[test]
fn the_answers_come_in_their_order() {
    let (_store, peer) = three_commits(MemoryStoreOptions {
        change_retention: ChangeRetention::Revisions(1),
        ..MemoryStoreOptions::default()
    });
    let past = Revision(MAX_REVISION + 1);
    // A bound past 2^53 − 1 is refused, also beside every later cause.
    assert_eq!(
        code(peer.changes(past, None)),
        StoreErrorCode::InvalidRequest
    );
    assert_eq!(
        code(peer.changes(Revision(0), Some(past))),
        StoreErrorCode::InvalidRequest
    );
    assert_eq!(
        code(peer.changes(past, Some(Revision(0)))),
        StoreErrorCode::InvalidRequest
    );
    // The largest legal bound is a cursor from the future, not a refusal.
    assert_eq!(
        resync(peer.changes(Revision(MAX_REVISION), None).unwrap()),
        Revision(3)
    );
    // `to` below `from` before the future: both bounds are past the current revision 3.
    assert_eq!(
        code(peer.changes(Revision(9), Some(Revision(8)))),
        StoreErrorCode::InvalidRequest
    );
    // `to` below `from` before the floor: both are below the floor 2.
    assert_eq!(
        code(peer.changes(Revision(1), Some(Revision(0)))),
        StoreErrorCode::InvalidRequest
    );
    // A cursor from the future, with and without `to`.
    assert_eq!(
        resync(peer.changes(Revision(4), None).unwrap()),
        Revision(3)
    );
    assert_eq!(
        resync(peer.changes(Revision(4), Some(Revision(9))).unwrap()),
        Revision(3)
    );
    // Below the floor, also for an empty range (reading 6).
    assert_eq!(
        resync(peer.changes(Revision(1), None).unwrap()),
        Revision(3)
    );
    assert_eq!(
        resync(peer.changes(Revision(1), Some(Revision(1))).unwrap()),
        Revision(3)
    );
    // At the floor the one kept record answers.
    let (kept, through) = records(peer.changes(Revision(2), None).unwrap());
    assert_eq!(kept.len(), 1);
    assert_eq!((kept[0].revision, through), (Revision(3), Revision(3)));
}

/// §4.6: `to` is clamped to the current revision; a complete page ends at the clamped `to`; a
/// page with a record pending makes progress and ends at its last record.
#[test]
fn a_page_ends_where_it_is_complete() {
    let (_store, peer) = three_commits(MemoryStoreOptions::default());
    let (all, through) = records(peer.changes(Revision(0), Some(Revision(50))).unwrap());
    assert_eq!(all.len(), 3);
    assert_eq!(through, Revision(3));
    let heads: Vec<_> = all.iter().map(|r| r.head.as_deref()).collect();
    assert_eq!(heads, [Some("h1"), Some("h2"), Some("h3")]);
    assert!(all
        .iter()
        .all(|r| r.added.is_empty() && r.removed.is_empty()));
    assert_eq!(
        records(peer.changes(Revision(3), None).unwrap()),
        (vec![], Revision(3))
    );
    assert_eq!(
        records(peer.changes(Revision(1), Some(Revision(1))).unwrap()),
        (vec![], Revision(1))
    );

    let (_store, paged) = three_commits(MemoryStoreOptions {
        change_page_size: Some(2),
        ..MemoryStoreOptions::default()
    });
    let (first, through) = records(paged.changes(Revision(0), None).unwrap());
    assert_eq!(revisions(&first), [1, 2]);
    assert_eq!(through, Revision(2));
    let (rest, through) = records(paged.changes(through, None).unwrap());
    assert_eq!(revisions(&rest), [3]);
    assert_eq!(through, Revision(3));
}

fn revisions(records: &[ChangeRecord]) -> Vec<u64> {
    records.iter().map(|r| r.revision.0).collect()
}

/// §4.13 reading 15: the memory store takes `Unbounded` or `Revisions(n)` with n of 1 or more,
/// and a page size of 1 or more. It serves a feed, so `None` is refused too.
#[test]
fn the_memory_store_refuses_options_it_cannot_honor() {
    let refused = |options: MemoryStoreOptions| {
        MemoryStore::with_options(options)
            .expect_err("the options must be refused")
            .code
    };
    for retention in [ChangeRetention::None, ChangeRetention::Revisions(0)] {
        let options = MemoryStoreOptions {
            change_retention: retention,
            ..MemoryStoreOptions::default()
        };
        assert_eq!(refused(options), StoreErrorCode::InvalidRequest);
    }
    let options = MemoryStoreOptions {
        change_page_size: Some(0),
        ..MemoryStoreOptions::default()
    };
    assert_eq!(refused(options), StoreErrorCode::InvalidRequest);
    let bounded = MemoryStore::with_options(MemoryStoreOptions {
        change_retention: ChangeRetention::Revisions(7),
        ..MemoryStoreOptions::default()
    })
    .unwrap();
    assert_eq!(
        bounded.profile().change_retention,
        ChangeRetention::Revisions(7)
    );
    assert_eq!(
        MemoryStore::new().profile().change_retention,
        ChangeRetention::Unbounded
    );
}

/// §4.7.2 (decision O4): a record names ids and never changes, so after a purge kept records
/// still name the purged id; a bounded store drops them with the record. A refused append, a
/// `conflict` and a purge that releases nothing write no record. Each peer has its own feed.
#[test]
fn records_keep_the_ids_of_purged_deltas_until_they_are_dropped() {
    let x = fact("plant:x", 1.0);
    let y = fact("plant:y", 2.0);
    for retention in [ChangeRetention::Unbounded, ChangeRetention::Revisions(1)] {
        let store = MemoryStore::with_options(MemoryStoreOptions {
            change_retention: retention,
            ..MemoryStoreOptions::default()
        })
        .unwrap();
        let a = store
            .create_peer("peer:a", ErasurePosture::Unproven)
            .unwrap();
        let b = store
            .create_peer("peer:b", ErasurePosture::Unproven)
            .unwrap();
        append(a.as_ref(), None, "a1", vec![held(&x, 1), held(&y, 2)]);
        let conflict = a
            .append(&Admission {
                expected_head: Some("stale".into()),
                next_head: "a2".into(),
                frame: None,
                added: vec![],
            })
            .unwrap();
        assert_eq!(conflict, AppendResult::Conflict);
        let mut forged = held(&x, 3);
        forged.delta.id = y.id.clone();
        assert!(a
            .append(&Admission {
                expected_head: Some("a1".into()),
                next_head: "a2".into(),
                frame: None,
                added: vec![forged],
            })
            .is_err());
        a.purge(&["nothing-held".into()]).unwrap();
        a.purge(std::slice::from_ref(&x.id)).unwrap();

        let (feed, _) = records(a.changes(Revision(1), None).unwrap());
        assert_eq!(revisions(&feed), [2]);
        assert_eq!(feed[0].removed, std::slice::from_ref(&x.id));
        assert_eq!(feed[0].head.as_deref(), Some("a1"));
        match retention {
            ChangeRetention::Unbounded => {
                let (first, _) = records(a.changes(Revision(0), Some(Revision(1))).unwrap());
                let mut both = vec![x.id.clone(), y.id.clone()];
                both.sort();
                assert_eq!(first[0].added, both, "the purged id stays in its record");
            }
            _ => assert_eq!(
                resync(a.changes(Revision(0), None).unwrap()),
                Revision(2),
                "the bounded store dropped the record that named the purged id"
            ),
        }
        assert_eq!(
            records(b.changes(Revision(0), None).unwrap()),
            (vec![], Revision(0))
        );
    }
}

/// §4.13 reading 13: `changes` reads the peer's current feed, through any handle, after the
/// store closes it refuses.
#[test]
fn changes_reads_the_current_feed_through_any_handle() {
    let (store, peer) = three_commits(MemoryStoreOptions::default());
    let again = store.peer("peer:a").unwrap();
    append(again.as_ref(), Some("h3"), "h4", vec![]);
    let (feed, through) = records(peer.changes(Revision(3), None).unwrap());
    assert_eq!((revisions(&feed), through), (vec![4], Revision(4)));
    store.close();
    assert_eq!(
        code(peer.changes(Revision(0), None)),
        StoreErrorCode::StoreClosed
    );
}
