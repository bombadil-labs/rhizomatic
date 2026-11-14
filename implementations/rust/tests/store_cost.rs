//! The cost rail (SPEC-18 proposal §8, §4.11 reading 17). The memory store counts its index work
//! through one door. The same operations over the same footprint make the same counts beside 0
//! and beside N unrelated deltas, and no core operation walks a whole map. Only the exporter
//! scans. Those rails count; the scope-source rail and the two change-feed rails at the end
//! time their work from outside instead, because the code under test could do work it does not
//! count. `Instant` is monotonic, so a step of the wall clock cannot move a timing.

use std::collections::BTreeMap;
use std::hint::black_box;
use std::time::{Duration, Instant};

use rhizomatic::memory_store::{MemoryStore, MemoryStoreOptions, StoreMeter};
use rhizomatic::set::{make_delta, make_negation_claims, DeltaSource};
use rhizomatic::store::{
    scope_source, Admission, Anchor, AppendResult, ArrivalRecord, ChangePage, ChangeRetention,
    ErasurePosture, PeerStore, Pushdown, Revision, ScopeRequest, Store, VerifiedDelta,
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

/// One member with `n` pointers, each to its own entity.
fn wide(n: usize) -> Vec<VerifiedDelta> {
    let pointers = (0..n)
        .map(|i| Pointer {
            role: "subject".into(),
            target: Target::Entity(EntityRef {
                id: format!("wide:{i}"),
                context: Some("v".into()),
            }),
        })
        .collect();
    let claims = Claims {
        timestamp: 1.0,
        valid_from: 1.0,
        valid_until: None,
        author: "did:key:zCost".into(),
        pointers,
    };
    vec![member(make_delta(claims, None).unwrap(), 1)]
}

/// `n` appearances of four ids, in turn: every appearance after the fourth is a repeat. Each
/// delta has one primitive pointer, so that 8N appearances stay small in memory.
fn four_ids(n: usize) -> Vec<VerifiedDelta> {
    let four: Vec<VerifiedDelta> = (1..=4u64)
        .map(|i| {
            let claims = Claims {
                timestamp: i as f64,
                valid_from: i as f64,
                valid_until: None,
                author: "did:key:zCost".into(),
                pointers: vec![Pointer {
                    role: "value".into(),
                    target: Target::Primitive(Primitive::Num(i as f64)),
                }],
            };
            member(make_delta(claims, None).unwrap(), i)
        })
        .collect();
    (0..n).map(|i| four[i % 4].clone()).collect()
}

/// The fastest of up to `runs` builds of a scope source over `members`, timed from outside. It
/// stops at the first build faster than `enough`: the fastest is under a bound exactly when one
/// build is.
fn fastest_build(members: &[VerifiedDelta], runs: usize, enough: Duration) -> Duration {
    let mut best = Duration::MAX;
    for _ in 0..runs {
        if best < enough {
            break;
        }
        let start = Instant::now();
        let source = scope_source(members).unwrap();
        best = best.min(start.elapsed());
        black_box(source);
    }
    best
}

/// One shape: its name, its members at a size, and the largest N it calibrates to. The cap
/// keeps 8N members in memory; the repeats are cheap to build and costly to hold.
type Shape = (&'static str, fn(usize) -> Vec<VerifiedDelta>, usize);

fn at_one_entity(n: usize) -> Vec<VerifiedDelta> {
    crowded(n).0
}

fn negating_one_delta(n: usize) -> Vec<VerifiedDelta> {
    crowded(n).1
}

/// The smallest power-of-two N from 256 whose build takes 50 ms or more here, or the cap, and
/// the fastest of five builds at that N.
fn calibrated(members: fn(usize) -> Vec<VerifiedDelta>, cap: usize) -> (usize, Duration) {
    let mut n = 256;
    loop {
        let at_n = fastest_build(&members(n), 5, Duration::ZERO);
        if at_n >= Duration::from_millis(50) || n >= cap {
            return (n, at_n);
        }
        n *= 2;
    }
}

/// Building a scope source costs the size of its members (README §1.2 item 5 and §6 "Cost",
/// SPEC-18 §4.11 reading 36). Four shapes cost N steps and not N²: N members at one entity, N
/// negations of one delta, one member with N entity pointers, and N appearances of four ids.
/// This times each build from outside with a monotonic clock, at N and at 8N. Linear work gives
/// a ratio near 8 and quadratic work near 64; the rail holds the ratio below 24.
///
/// Each shape calibrates its own N: the smallest power of two whose build takes 50 ms or more on
/// this host and in this profile (debug under `cargo test`), so a quadratic build reaches 50 ms
/// at a small N and fails rather than hangs. The appearances of four ids stop at a cap of 2^17,
/// where 8N clones of a member still fit in memory; there the build at N takes less than 50 ms.
/// The build at N is the fastest of five. The build at 8N is the fastest of three, stopped at
/// the first under the bound.
///
/// It is a coarse scaling check, not a count, and coarse in one direction. A stall must slow
/// all three builds at 8N to fail correct code. A stall during every build at N lowers the
/// ratio, so a loaded machine can let a quadratic build pass. A quadratic term too small to show
/// at that N passes.
#[test]
fn a_scope_source_builds_in_the_size_of_its_members() {
    let (facts, strikes, target) = crowded(300);
    assert_eq!(scope_source(&facts).unwrap().targets("plant:a").len(), 300);
    assert_eq!(scope_source(&strikes).unwrap().negators(&target).len(), 300);
    let one = scope_source(&wide(300)).unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one.targets("wide:0").len(), 1);
    assert_eq!(one.targets("wide:299").len(), 1);
    assert_eq!(scope_source(&four_ids(300)).unwrap().len(), 4);

    let shapes: [Shape; 4] = [
        ("members at one entity", at_one_entity, 1 << 20),
        ("negations of one delta", negating_one_delta, 1 << 20),
        ("entity pointers of one member", wide, 1 << 20),
        ("appearances of four ids", four_ids, 1 << 17),
    ];
    let _timed = crate::timed::exclusive();
    let slow: Vec<String> = shapes
        .into_iter()
        .filter_map(|(shape, members, cap)| {
            crate::timed::remeasured(|| {
                let (n, at_n) = calibrated(members, cap);
                let at_8n = fastest_build(&members(8 * n), 3, at_n.mul_f64(BOUND));
                let ratio = at_8n.as_secs_f64() / at_n.as_secs_f64();
                println!(
                    "scope source, {shape}: N = {n}, {at_n:?} and {at_8n:?}, ratio {ratio:.2}"
                );
                (ratio >= BOUND).then(|| {
                    format!(
                        "{shape}: building at 8N = {} took {ratio:.1} times as long as at N = {n} \
                     ({at_8n:?} against {at_n:?}); linear work gives about 8",
                        8 * n
                    )
                })
            })
        })
        .collect();
    assert!(slow.is_empty(), "{}", slow.join("\n"));
}

/// The ratio a timed rail holds below: linear work gives about 8, quadratic work about 64.
const BOUND: f64 = 24.0;

/// One head-only commit: the head moves from `head-k` to `head-(k + 1)`, and nothing is added.
fn head_only(peer: &dyn PeerStore, k: usize) {
    let result = peer
        .append(&Admission {
            expected_head: (k > 0).then(|| format!("head-{k}")),
            next_head: format!("head-{}", k + 1),
            frame: None,
            added: Vec::new(),
        })
        .unwrap();
    assert!(matches!(result, AppendResult::Committed { .. }));
}

/// A peer on a new store built with these options, with `commits` head-only commits.
fn feed_peer(options: MemoryStoreOptions, commits: usize) -> (MemoryStore, Box<dyn PeerStore>) {
    let store = MemoryStore::with_options(options).unwrap();
    let peer = store
        .create_peer("peer:feed", ErasurePosture::Unproven)
        .unwrap();
    for k in 0..commits {
        head_only(peer.as_ref(), k);
    }
    (store, peer)
}

/// The fastest of up to `runs` runs, timed from outside, stopping at the first faster than
/// `enough`.
fn fastest(runs: usize, enough: Duration, mut run: impl FnMut() -> Duration) -> Duration {
    let mut best = Duration::MAX;
    for _ in 0..runs {
        if best < enough {
            break;
        }
        best = best.min(run());
    }
    best
}

/// README §3.9.9: N from 256, doubling until the run at N takes 50 ms; the run at N the fastest
/// of five, the run at 8N the fastest of three, stopped at the first under the bound. Answers
/// the ratio, or a message when it is not below the bound.
fn scales_linearly(what: &str, run: impl Fn(usize) -> Duration) -> Option<String> {
    let mut n = 256;
    let at_n = loop {
        let at_n = fastest(5, Duration::ZERO, || run(n));
        if at_n >= Duration::from_millis(50) {
            break at_n;
        }
        n *= 2;
    };
    let at_8n = fastest(3, at_n.mul_f64(BOUND), || run(8 * n));
    let ratio = at_8n.as_secs_f64() / at_n.as_secs_f64();
    println!("change feed, {what}: N = {n}, {at_n:?} and {at_8n:?}, ratio {ratio:.2}");
    (ratio >= BOUND).then(|| {
        format!(
            "{what}: the run at 8N = {} took {ratio:.1} times as long as at N = {n} \
             ({at_8n:?} against {at_n:?}); linear work gives about 8",
            8 * n
        )
    })
}

/// The window a reader asks for after each record (README §3.9.9 rail 1).
const WINDOW: usize = 64;

/// `changes` costs the records it returns, never the records before `from` (SPEC-18 §4.6). A
/// peer has N + W head-only commits, and call r reads `changes(r, r + W)`: N windows of W
/// records each. A store that walks its feed from the start to find `from` does quadratic work
/// in total. Timed from outside, at N and 8N; the peer is built before the clock starts.
#[test]
fn a_window_read_costs_its_window_not_the_feed_before_it() {
    let reads = |n: usize| -> Box<dyn Fn() -> Duration> {
        let (store, peer) = feed_peer(MemoryStoreOptions::default(), n + WINDOW);
        Box::new(move || {
            let start = Instant::now();
            for r in 0..n as u64 {
                let page = peer
                    .changes(Revision(r), Some(Revision(r + WINDOW as u64)))
                    .unwrap();
                black_box(page);
            }
            let took = start.elapsed();
            black_box(&store);
            took
        })
    };
    let (_store, peer) = feed_peer(MemoryStoreOptions::default(), 10 + WINDOW);
    match peer
        .changes(Revision(3), Some(Revision(3 + WINDOW as u64)))
        .unwrap()
    {
        ChangePage::Ok { records, through } => {
            assert_eq!(records.len(), WINDOW);
            assert_eq!(records[0].revision, Revision(4));
            assert_eq!(through, Revision(3 + WINDOW as u64));
        }
        other => panic!("{other:?}"),
    }

    // One build per size: the reads do not change the peer, so every run reads the same feed.
    let built: std::cell::RefCell<BTreeMap<usize, Box<dyn Fn() -> Duration>>> = Default::default();
    let run = |n: usize| {
        let mut built = built.borrow_mut();
        built.entry(n).or_insert_with(|| reads(n))()
    };
    let _timed = crate::timed::exclusive();
    let slow = crate::timed::remeasured(|| scales_linearly("a window read after each record", run));
    assert!(slow.is_none(), "{}", slow.unwrap());
}

/// An append under bounded retention costs the same with 0 or N kept records (SPEC-18 §4.6).
/// On a store that keeps N / 4 records, N head-only appends: once N / 4 are kept, each append
/// drops one. A store whose drop copies or shifts what it keeps does quadratic work in total.
/// Timed from outside, at N and 8N, each run on a new store.
#[test]
fn an_append_under_bounded_retention_costs_the_same_with_any_number_kept() {
    let keep = |n: usize| MemoryStoreOptions {
        change_retention: ChangeRetention::Revisions((n / 4) as u64),
        ..MemoryStoreOptions::default()
    };
    let (_store, peer) = feed_peer(keep(40), 40);
    match peer.changes(Revision(29), None).unwrap() {
        ChangePage::ResyncRequired { current } => assert_eq!(current, Revision(40)),
        other => panic!("{other:?}"),
    }
    match peer.changes(Revision(30), None).unwrap() {
        ChangePage::Ok { records, .. } => assert_eq!(records.len(), 10),
        other => panic!("{other:?}"),
    }

    let run = |n: usize| {
        let (store, peer) = feed_peer(keep(n), 0);
        let start = Instant::now();
        for k in 0..n {
            head_only(peer.as_ref(), k);
        }
        let took = start.elapsed();
        black_box(&store);
        took
    };
    let _timed = crate::timed::exclusive();
    let slow =
        crate::timed::remeasured(|| scales_linearly("an append under bounded retention", run));
    assert!(slow.is_none(), "{}", slow.unwrap());
}
