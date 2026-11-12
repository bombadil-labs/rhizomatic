//! The cost rail (SPEC-18 proposal §8, §4.11 reading 17). The memory store counts its index work
//! through one door. The same operations over the same footprint make the same counts beside 0
//! and beside N unrelated deltas, and no core operation walks a whole map. Only the exporter
//! scans. Those rails count; the scope-source rail at the end times its build from outside
//! instead, because the code under test could do work it does not count.

use std::hint::black_box;
use std::time::{Duration, Instant};

use rhizomatic::memory_store::{MemoryStore, StoreMeter};
use rhizomatic::set::{make_delta, make_negation_claims, DeltaSource};
use rhizomatic::store::{
    scope_source, Admission, Anchor, AppendResult, ArrivalRecord, ErasurePosture, PeerStore,
    Pushdown, ScopeRequest, Store, VerifiedDelta,
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

fn member(delta: Delta, sequence: u64) -> VerifiedDelta {
    VerifiedDelta {
        arrival: ArrivalRecord {
            id: delta.id.clone(),
            at: 1000.0,
            sequence,
            transfer: 1,
            sender: "local".into(),
        },
        delta,
    }
}

/// N facts about one entity, and N negations of one delta: every member lands in one index
/// entry.
fn crowded(n: usize) -> (Vec<VerifiedDelta>, Vec<VerifiedDelta>, String) {
    let facts = (0..n).map(|i| fact("plant:a", "height", i as f64, 1.0));
    let target = fact("plant:b", "height", 0.0, 1.0);
    let strikes = (0..n).map(|i| negation(&target, 2.0 + i as f64));
    let members = |deltas: Vec<Delta>| {
        deltas
            .into_iter()
            .zip(1..)
            .map(|(d, s)| member(d, s))
            .collect()
    };
    (
        members(facts.collect()),
        members(strikes.collect()),
        target.id,
    )
}

/// The fastest of three builds of a scope source over `members`, timed from outside.
fn fastest_build(members: &[VerifiedDelta]) -> Duration {
    (0..3)
        .map(|_| {
            let start = Instant::now();
            let source = scope_source(members).unwrap();
            let took = start.elapsed();
            black_box(source);
            took
        })
        .min()
        .unwrap()
}

/// The members of one crowded shape: N facts about one entity, or N negations of one delta.
type Shape = fn(usize) -> Vec<VerifiedDelta>;

fn at_one_entity(n: usize) -> Vec<VerifiedDelta> {
    crowded(n).0
}

fn negating_one_delta(n: usize) -> Vec<VerifiedDelta> {
    crowded(n).1
}

/// The smallest power-of-two N whose build of this shape takes at least 50 ms here.
fn calibrated_n(shape: Shape) -> usize {
    let mut n = 256;
    while n < 1 << 20 && fastest_build(&shape(n)) < Duration::from_millis(50) {
        n *= 2;
    }
    n
}

/// Building a scope source costs the size of its members (README §1.2 item 5 and §5 "Cost",
/// SPEC-18 §4.11 reading 36): N members at one entity, or N negations of one delta, cost N steps
/// and not N². This times the build from outside with a monotonic clock, at N and at 8N, the
/// fastest of three builds each. Linear work gives a ratio near 8 and quadratic work near 64;
/// the rail holds the ratio below 24. Each shape calibrates its own N, the smallest power of two
/// whose build takes 50 ms or more on this host and in this profile (debug under `cargo test`),
/// so a quadratic build also stays short enough to fail rather than hang. It is a coarse scaling
/// check, not a count: a quadratic term too small to show at that N passes.
#[test]
fn a_scope_source_builds_in_the_size_of_its_members() {
    let (facts, strikes, target) = crowded(300);
    assert_eq!(scope_source(&facts).unwrap().targets("plant:a").len(), 300);
    assert_eq!(scope_source(&strikes).unwrap().negators(&target).len(), 300);

    let shapes: [(&str, Shape); 2] = [
        ("members at one entity", at_one_entity),
        ("negations of one delta", negating_one_delta),
    ];
    let slow: Vec<String> = shapes
        .into_iter()
        .filter_map(|(shape, members)| {
            let n = calibrated_n(members);
            let (at_n, at_8n) = (fastest_build(&members(n)), fastest_build(&members(8 * n)));
            let ratio = at_8n.as_secs_f64() / at_n.as_secs_f64();
            println!("scope source, {shape}: N = {n}, {at_n:?} and {at_8n:?}, ratio {ratio:.2}");
            (ratio >= 24.0).then(|| {
                format!(
                    "{shape}: building from {} members took {ratio:.1} times as long as from \
                     {n} ({at_8n:?} against {at_n:?}); linear work gives about 8",
                    8 * n
                )
            })
        })
        .collect();
    assert!(slow.is_empty(), "{}", slow.join("\n"));
}
