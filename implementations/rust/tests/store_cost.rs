//! The cost rail (SPEC-18 proposal §8, §4.11 reading 17). The memory store counts its index work
//! through one door. The same operations over the same footprint make the same counts beside 0
//! and beside N unrelated deltas, and no core operation walks a whole map. Only the exporter
//! scans. This file does not measure time.

use rhizomatic::memory_store::{MemoryStore, StoreMeter};
use rhizomatic::set::{make_delta, make_negation_claims};
use rhizomatic::store::{
    Admission, Anchor, AppendResult, ArrivalRecord, ErasurePosture, PeerStore, Pushdown,
    ScopeRequest, Store, VerifiedDelta,
};
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};

fn fact(entity: &str, context: &str, value: f64, timestamp: f64) -> Delta {
    let claims = Claims {
        timestamp,
        valid_from: timestamp,
        valid_until: None,
        author: "did:key:zCost".into(),
        pointers: vec![
            Pointer {
                role: "subject".into(),
                target: Target::Entity(EntityRef {
                    id: entity.into(),
                    context: Some(context.into()),
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

fn negation(of: &Delta, timestamp: f64) -> Delta {
    make_delta(
        make_negation_claims("did:key:zCost", timestamp, &of.id, None),
        None,
    )
    .unwrap()
}

/// Appends deltas as one batch, with arrival sequences after `last`.
fn append(peer: &dyn PeerStore, head: (Option<&str>, &str), last: u64, deltas: &[Delta]) {
    let added = deltas
        .iter()
        .zip(last + 1..)
        .map(|(delta, sequence)| VerifiedDelta {
            delta: delta.clone(),
            arrival: ArrivalRecord {
                id: delta.id.clone(),
                at: 1000.0,
                sequence,
                transfer: 1,
                sender: "local".into(),
            },
        })
        .collect();
    let result = peer
        .append(&Admission {
            expected_head: head.0.map(str::to_string),
            next_head: head.1.into(),
            frame: None,
            added,
        })
        .unwrap();
    assert!(matches!(result, AppendResult::Committed { added, .. } if added.len() == deltas.len()));
}

/// Unrelated deltas: facts about other entities, and negations of half of them.
fn noise(n: usize) -> Vec<Delta> {
    let facts: Vec<Delta> = (0..n)
        .map(|i| fact(&format!("noise:{i}"), "height", i as f64, 1.0))
        .collect();
    let strikes: Vec<Delta> = facts.iter().step_by(2).map(|f| negation(f, 2.0)).collect();
    facts.into_iter().chain(strikes).collect()
}

/// Runs every core operation over one fixed footprint beside `n` unrelated facts, and reports
/// the index work of each.
fn measure(n: usize) -> Vec<(&'static str, StoreMeter)> {
    let store = MemoryStore::new();
    let mut work = Vec::new();
    let mut measured = |name: &'static str, store: &MemoryStore, op: &mut dyn FnMut()| {
        store.reset_meter();
        op();
        work.push((name, store.meter()));
    };

    let unrelated = noise(n);
    let other = store
        .create_peer("peer:other", ErasurePosture::Unproven)
        .unwrap();
    append(other.as_ref(), (None, "o-1"), 0, &unrelated);

    let mut peer = None;
    measured("createPeer", &store, &mut || {
        peer = Some(
            store
                .create_peer("peer:a", ErasurePosture::Unproven)
                .unwrap(),
        );
    });
    let peer = peer.unwrap();
    append(peer.as_ref(), (None, "a-1"), 0, &unrelated);
    let last = unrelated.len() as u64;

    let height = fact("plant:a", "height", 10.0, 10.0);
    let struck = negation(&height, 20.0);
    let restored = negation(&struck, 30.0);
    let name = fact("plant:a", "name", 1.0, 40.0);
    let shared = fact("plant:b", "height", 3.0, 50.0);
    append(
        other.as_ref(),
        (Some("o-1"), "o-2"),
        last,
        std::slice::from_ref(&shared),
    );
    let footprint = [
        height.clone(),
        struck.clone(),
        restored.clone(),
        name.clone(),
        shared.clone(),
    ];
    let ids: Vec<String> = footprint.iter().map(|d| d.id.clone()).collect();

    measured("append", &store, &mut || {
        append(peer.as_ref(), (Some("a-1"), "a-2"), last, &footprint)
    });
    measured("append of held ids", &store, &mut || {
        append(peer.as_ref(), (Some("a-2"), "a-2"), last + 10, &[]);
        let result = peer.append(&Admission {
            expected_head: Some("a-2".into()),
            next_head: "a-2".into(),
            frame: None,
            added: vec![VerifiedDelta {
                delta: name.clone(),
                arrival: ArrivalRecord {
                    id: name.id.clone(),
                    at: 1.0,
                    sequence: last + 20,
                    transfer: 2,
                    sender: "local".into(),
                },
            }],
        });
        assert!(matches!(result, Ok(AppendResult::Committed { added, .. }) if added.is_empty()));
    });
    measured("peer", &store, &mut || {
        store.peer("peer:a").unwrap();
    });
    let mut snapshot = None;
    measured("read", &store, &mut || {
        snapshot = Some(peer.read().unwrap())
    });
    let snapshot = snapshot.unwrap();
    assert_eq!(snapshot.count(), last + 5);

    let entities = vec!["plant:a".to_string(), "plant:b".to_string()];
    let anchors: Vec<Anchor> = entities
        .iter()
        .map(|entity| Anchor::Entity {
            entity: entity.clone(),
        })
        .collect();
    measured("get", &store, &mut || {
        assert_eq!(snapshot.get(&ids).unwrap().len(), 5);
    });
    measured("arrivals", &store, &mut || {
        assert_eq!(snapshot.arrivals(&ids).unwrap().len(), 5);
    });
    measured("targets", &store, &mut || {
        assert_eq!(snapshot.targets(&entities).unwrap().len(), 3);
    });
    measured("negators", &store, &mut || {
        assert_eq!(snapshot.negators(&ids).unwrap().len(), 2);
    });
    measured("scope", &store, &mut || {
        let request = ScopeRequest {
            anchors: anchors.clone(),
            ..ScopeRequest::default()
        };
        assert_eq!(snapshot.scope(&request).unwrap().deltas.len(), 5);
    });
    measured("scope with pushdown and exclude", &store, &mut || {
        let request = ScopeRequest {
            anchors: anchors.clone(),
            pushdown: Some(Pushdown {
                timestamp_at_most: Some(45.0),
                arrival_at_most: Some(last + 4),
                exclude_ids: Some(vec![restored.id.clone()]),
            }),
            exclude: vec![height.id.clone()],
        };
        assert_eq!(snapshot.scope(&request).unwrap().deltas.len(), 2);
    });
    measured("purge", &store, &mut || {
        // One id only this peer holds, one another peer holds too, one nobody holds.
        let report = peer
            .purge(&[struck.id.clone(), shared.id.clone(), "1e20".into()])
            .unwrap();
        assert_eq!(report.targets.len(), 3);
    });
    measured("purge of a debt", &store, &mut || {
        peer.purge(std::slice::from_ref(&shared.id)).unwrap();
    });
    work
}

#[test]
fn core_operations_cost_their_footprint_not_the_store() {
    let empty = measure(0);
    let full = measure(4000);
    for ((name, beside_none), (_, beside_many)) in empty.iter().zip(&full) {
        assert_eq!(
            beside_none, beside_many,
            "{name}: index work grew with unrelated deltas"
        );
        assert_eq!(
            beside_many.scans, 0,
            "{name}: a core operation walked a whole map"
        );
    }
    // The meter is live: each operation that reads an index counted something.
    for (name, meter) in &full {
        assert!(meter.lookups > 0, "{name}: the meter counted no lookup");
    }
    let names: Vec<&str> = full.iter().map(|(name, _)| *name).collect();
    assert_eq!(
        names,
        [
            "createPeer",
            "append",
            "append of held ids",
            "peer",
            "read",
            "get",
            "arrivals",
            "targets",
            "negators",
            "scope",
            "scope with pushdown and exclude",
            "purge",
            "purge of a debt",
        ]
    );
}

#[test]
fn only_the_exporter_scans() {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    let deltas = noise(100);
    append(peer.as_ref(), (None, "a-1"), 0, &deltas);
    let admin = store.open_admin();

    store.reset_meter();
    assert_eq!(admin.stored_ids().count(), 150);
    assert_eq!((store.meter().scans, store.meter().visited), (1, 150));

    store.reset_meter();
    assert_eq!(admin.peer("peer:a").unwrap().ids().count(), 150);
    assert_eq!(store.meter().scans, 1);

    store.reset_meter();
    assert_eq!(admin.peers().count(), 1);
    assert_eq!(store.meter().scans, 1);
}
