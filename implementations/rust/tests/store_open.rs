//! The host side of the store (SPEC-18 proposal §4.8–§4.11), which the shared vectors do not
//! cover: opening by URL scheme, scheme registration, requirements, close, and a synchronous
//! delta source over a fetched scope.
//!
//! Ownership (`vectors/store/README.md` §7). The eight tests a store runs for itself, and how
//! this witness holds each. Where a test cannot fail by construction, this file says so instead
//! of running it:
//!
//! 1. After append; 2. after a read; 3. payload memory. Every value crosses the trait by shared
//!    reference in and by owned value out (`&Admission` in; `Vec<Delta>`, `ScopeResult` and the
//!    listings out), and no store type holds a `Cell`, an `Rc` or a borrow of what it was given.
//!    A bytes payload is an owned `Vec<u8>`. Safe Rust cannot keep or return a view of the
//!    caller's memory through these signatures, so a store without `unsafe` cannot alias. The
//!    memory store has no `unsafe` (implementations/rust/CLAUDE.md). A store that takes shared or
//!    borrowed bytes must test this itself. `a_caller_cannot_reach_into_what_the_store_holds`
//!    still changes every value it was given and every value it read; it shows the per-peer
//!    signature stays apart, which is not ownership.
//! 4. No conversion. A test for a dynamically typed witness: a Rust value has one type.
//! 5. One read of each field. Every field the test names holds by construction, because each is
//!    a plain field of a concrete type (`String`, `f64`, `u64`, `Vec`, `Option`, or a struct or
//!    enum of these) with no interior mutability, reached through a shared reference. Rust
//!    forbids a change behind a `&T` while the borrow lives, so a store reads the value it
//!    checked on every later read of that call. Field by field:
//!    - the claims (`Claims`: timestamp, validFrom, validUntil, author, each pointer's role and
//!      target), the signature (`Delta::sig`) and the id (`Delta::id`), in `&Admission`;
//!    - the five arrival fields (`ArrivalRecord`: id, at, sequence, transfer, sender), in
//!      `&Admission`;
//!    - the ids of `get`, `arrivals`, `negators` and `purge`, and the entities of `targets`
//!      (`&[String]`);
//!    - the anchors, the bounds (`timestamp_at_most`, `arrival_at_most`), `exclude_ids` and
//!      `exclude` of `scope` (`&ScopeRequest`).
//!
//!    No field needs a test; a type with a getter that answers differently cannot be passed.
//! 6. The profile. `Store::profile` returns a shared reference to a struct with no interior
//!    mutability; a caller can change only its own clone. A handle exposes trait methods only.
//! 7. `scopeSource`. Its one input is `&[VerifiedDelta]`, which `scope_source` copies; the
//!    source answers with shared references and owned lists. Tests 1 to 3 hold by the argument of
//!    1 to 3, tests 4 and 5 by the argument of 4 and 5 (the member's delta and id are plain
//!    fields behind a shared reference). `a_refused_scope_source_call_adds_nothing` and the
//!    recompute refusal test that it files no member under an id its claims do not recompute to.
//! 8. A store of class `none`. Rust has no such store (`MemoryStore` is `unprovable`), so this
//!    test has nothing to test here.

use std::collections::BTreeMap;

use rhizomatic::anchored::{eval_anchored, scope_ids, DeltaSource};
use rhizomatic::eval::result_canonical_hex;
use rhizomatic::json_profile::parse_claims;
use rhizomatic::memory_store::{memory_store_profile, MemoryStore, MEMORY_STORE_FORMAT};
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    missing_requirements, scope_source, Admission, Anchor, AppendResult, ArrivalRecord, AtRest,
    ChangeRetention, ErasureClaim, ErasureClass, ErasurePosture, PurgeOutcome, Pushdown,
    PushdownFields, Revision, ScopeRequest, Store, StoreCapabilities, StoreError, StoreErrorCode,
    StoreProfile, StoreRequirement, StoreWriters, VerifiedDelta, MAX_ARRIVAL_COUNTER,
};
use rhizomatic::store_open::{open_store, OpenOptions, StoreSchemes, UNKNOWN_SCHEME_MESSAGE};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Target};
use serde_json::Value;

const SECRET_URL: &str = "vault://admin:hunter2@db.example/prod";

fn code<T>(result: Result<T, StoreError>) -> StoreErrorCode {
    result.err().expect("the store must refuse").code
}

fn held(deltas: &[Delta]) -> Vec<VerifiedDelta> {
    deltas
        .iter()
        .zip(1..)
        .map(|(delta, sequence)| VerifiedDelta {
            delta: delta.clone(),
            arrival: ArrivalRecord {
                id: delta.id.clone(),
                at: 1000.0 + sequence as f64,
                sequence,
                transfer: 1,
                sender: "local".into(),
            },
        })
        .collect()
}

/// The memory profile: slice 1's, and from slice 3 a change feed that keeps every record.
#[test]
fn memory_opens_a_new_empty_store_with_its_profile() {
    let store = open_store("memory:", &OpenOptions::default()).unwrap();
    assert_eq!(
        *store.profile(),
        StoreProfile {
            capabilities: StoreCapabilities {
                values: false,
                arrival: true,
                journal: false,
                views: false,
                derived_indexes: false,
                digest: false,
                erasure: ErasureClass::Unprovable,
            },
            indexed_value_roles: vec![],
            pushdown: PushdownFields {
                timestamp_at_most: true,
                arrival_at_most: true,
                exclude_ids: true,
            },
            writers: StoreWriters::OneProcess,
            at_rest: AtRest::Trusted,
            change_retention: ChangeRetention::Unbounded,
            format_version: "rhizomatic.store.memory/1".into(),
        }
    );
    assert_eq!(MEMORY_STORE_FORMAT, "rhizomatic.store.memory/1");
    assert_eq!(*store.profile(), memory_store_profile());

    store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    let second = open_store("MEMORY:", &OpenOptions::default()).unwrap();
    assert_eq!(code(second.peer("peer:a")), StoreErrorCode::PeerAbsent);
}

#[test]
fn open_refuses_by_scheme_and_never_echoes_the_url() {
    let mut schemes = StoreSchemes::new();
    let options = OpenOptions::default();
    // A missing scheme and an unregistered one get the same code and one fixed message. The
    // text before the first colon can be a credential, so nothing of the input comes back.
    let fixed = StoreError::new(StoreErrorCode::UnknownScheme, UNKNOWN_SCHEME_MESSAGE);
    for url in [
        SECRET_URL,
        "hunter2:rest",
        "no scheme here hunter2",
        "no-colon",
        ":x",
        "9x:hunter2",
        "hunter 2:x",
        "",
    ] {
        assert_eq!(
            schemes.open(url, &options).err(),
            Some(fixed.clone()),
            "{url}"
        );
    }
    assert!(!UNKNOWN_SCHEME_MESSAGE.contains("vault"));

    // A registered scheme may be named. Its address is still never echoed.
    let addressed = schemes.open("memory:hunter2", &options).err().unwrap();
    assert_eq!(addressed.code, StoreErrorCode::InvalidUrl);
    assert!(addressed.message.contains("memory") && !addressed.to_string().contains("hunter2"));

    // Schemes compare without regard to case, on both sides.
    assert!(schemes.open("MEMORY:", &options).is_ok());
    assert!(schemes.open("Memory:", &options).is_ok());
    let factory = || {
        Box::new(|_: &str, _: &OpenOptions| Ok(Box::new(MemoryStore::new()) as Box<dyn Store>)) as _
    };
    schemes.register("Vault", factory()).unwrap();
    assert!(schemes.open("VAULT://x", &options).is_ok());
    assert!(schemes.open("vault://x", &options).is_ok());
    assert_eq!(
        code(schemes.register("vAULT", factory())),
        StoreErrorCode::SchemeExists
    );
}

#[test]
fn a_host_registers_and_removes_its_own_schemes() {
    let mut schemes = StoreSchemes::new();
    let factory = || {
        Box::new(|_: &str, _: &OpenOptions| Ok(Box::new(MemoryStore::new()) as Box<dyn Store>)) as _
    };
    schemes.register("vault", factory()).unwrap();
    assert_eq!(
        code(schemes.register("VAULT", factory())),
        StoreErrorCode::SchemeExists
    );
    assert_eq!(
        code(schemes.register("memory", factory())),
        StoreErrorCode::SchemeExists
    );
    assert_eq!(
        code(schemes.register("not a scheme", factory())),
        StoreErrorCode::InvalidUrl
    );
    assert!(schemes.open(SECRET_URL, &OpenOptions::default()).is_ok());

    assert!(schemes.unregister("vault"));
    assert!(!schemes.unregister("vault"));
    assert!(!schemes.unregister("memory"));
    assert!(schemes.open("memory:", &OpenOptions::default()).is_ok());
    assert_eq!(
        code(schemes.open(SECRET_URL, &OpenOptions::default())),
        StoreErrorCode::UnknownScheme
    );
}

#[test]
fn a_factory_failure_names_the_scheme_only() {
    let mut schemes = StoreSchemes::new();
    schemes
        .register(
            "vault",
            Box::new(|url: &str, _: &OpenOptions| Err(format!("cannot connect to {url}").into())),
        )
        .unwrap();
    schemes
        .register(
            "strict",
            Box::new(|_: &str, _: &OpenOptions| {
                Err(Box::new(StoreError::new(
                    StoreErrorCode::InvalidUrl,
                    "the address has no file",
                )) as _)
            }),
        )
        .unwrap();
    let failed = schemes
        .open(SECRET_URL, &OpenOptions::default())
        .err()
        .unwrap();
    assert_eq!(failed.code, StoreErrorCode::OpenFailed);
    assert!(failed.message.contains("vault"));
    assert!(!failed.to_string().contains("hunter2"));
    // A store's own refusal is passed on as it is.
    let refused = schemes
        .open("strict:x", &OpenOptions::default())
        .err()
        .unwrap();
    assert_eq!(
        refused,
        StoreError::new(StoreErrorCode::InvalidUrl, "the address has no file")
    );
}

#[test]
fn open_refuses_a_store_that_lacks_a_requirement_and_closes_it() {
    use StoreRequirement::*;
    let profile = memory_store_profile();
    assert_eq!(
        missing_requirements(&profile, &[Arrival, Purge, Changes]),
        []
    );
    let all = [
        Values,
        Arrival,
        Journal,
        Views,
        DerivedIndexes,
        Digest,
        Changes,
        Purge,
        ErasureProven,
    ];
    let missing = [
        Values,
        Journal,
        Views,
        DerivedIndexes,
        Digest,
        ErasureProven,
    ];
    assert_eq!(missing_requirements(&profile, &all), missing);
    assert_eq!(missing_requirements(&profile, &[Digest, Digest]), [Digest]);
    assert!(open_store(
        "memory:",
        &OpenOptions {
            requires: vec![Arrival, Purge]
        }
    )
    .is_ok());

    let refusal = open_store(
        "memory:",
        &OpenOptions {
            requires: all.to_vec(),
        },
    )
    .err()
    .unwrap();
    assert_eq!(refusal.code, StoreErrorCode::CapabilityAbsent);
    for name in [
        "values",
        "journal",
        "views",
        "derivedIndexes",
        "digest",
        "erasure-proven",
    ] {
        assert!(refusal.message.contains(name), "{refusal} lacks {name}");
    }
    for held in ["arrival", "purge", "changes"] {
        assert!(!refusal.message.contains(held), "{refusal} names {held}");
    }

    // The refused store is closed, not leaked open.
    let kept = MemoryStore::new();
    let handed = kept.clone();
    let mut schemes = StoreSchemes::new();
    schemes
        .register(
            "kept",
            Box::new(
                move |_: &str, _: &OpenOptions| Ok(Box::new(handed.clone()) as Box<dyn Store>),
            ),
        )
        .unwrap();
    let options = OpenOptions {
        requires: vec![Digest],
    };
    assert_eq!(
        code(schemes.open("kept:x", &options)),
        StoreErrorCode::CapabilityAbsent
    );
    assert_eq!(code(kept.peer("peer:a")), StoreErrorCode::StoreClosed);
}

#[test]
fn a_closed_store_refuses_everything_but_what_a_snapshot_fixed() {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    let snapshot = peer.read().unwrap();
    let admin = store.open_admin();
    store.close();

    assert_eq!(
        code(store.create_peer("peer:b", ErasurePosture::Unproven)),
        StoreErrorCode::StoreClosed
    );
    assert_eq!(code(store.peer("peer:a")), StoreErrorCode::StoreClosed);
    assert_eq!(code(peer.read()), StoreErrorCode::StoreClosed);
    assert_eq!(code(peer.purge(&[])), StoreErrorCode::StoreClosed);
    let batch = Admission {
        expected_head: None,
        next_head: "h".into(),
        frame: None,
        added: vec![],
    };
    assert_eq!(code(peer.append(&batch)), StoreErrorCode::StoreClosed);
    assert_eq!(code(snapshot.get(&[])), StoreErrorCode::StoreClosed);
    assert_eq!(
        code(snapshot.scope(&ScopeRequest::default())),
        StoreErrorCode::StoreClosed
    );
    assert_eq!(
        code(admin.peers().collect::<Result<Vec<_>, _>>()),
        StoreErrorCode::StoreClosed
    );
    assert_eq!(
        code(admin.stored_ids().collect::<Result<Vec<_>, _>>()),
        StoreErrorCode::StoreClosed
    );
    assert_eq!(code(admin.peer("peer:a")), StoreErrorCode::StoreClosed);
    assert_eq!(
        (snapshot.revision(), snapshot.head(), snapshot.count()),
        (Revision(0), None, 0)
    );
    assert_eq!(store.profile().format_version, MEMORY_STORE_FORMAT);
}

#[test]
fn peer_creation_refusals() {
    let store = MemoryStore::new();
    assert_eq!(
        code(store.create_peer("peer:p", ErasurePosture::Proven)),
        StoreErrorCode::PostureRefused
    );
    assert_eq!(code(store.peer("peer:p")), StoreErrorCode::PeerAbsent);
    assert_eq!(
        code(store.create_peer("", ErasurePosture::Unproven)),
        StoreErrorCode::InvalidRequest
    );
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    assert_eq!(peer.erasure().posture, ErasurePosture::Unproven);
    assert_eq!(peer.erasure().store_class, ErasureClass::Unprovable);
}

fn anchored_vectors() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-anchored.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-anchored.json")).unwrap()
}

/// SPEC-18 §4.4 in small: fetch the scope of a read's anchors from a store in one call, then
/// evaluate synchronously over the fetched members. Every SPEC-17 read vector answers the same
/// bytes through a store as it does over a whole delta set.
#[test]
fn an_anchored_read_evaluates_over_a_fetched_scope() {
    let doc = anchored_vectors();
    let fixture: Vec<Delta> = doc["fixture"]["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap())
        .collect();
    let name_of: BTreeMap<&str, &str> = fixture
        .iter()
        .zip(doc["fixture"]["deltas"].as_array().unwrap())
        .map(|(delta, d)| (delta.id.as_str(), d["name"].as_str().unwrap()))
        .collect();
    let registry = SchemaRegistry::build(
        doc["schemas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| HyperSchema {
                name: s["name"].as_str().unwrap().to_string(),
                alg: s["alg"].as_u64().unwrap() as u32,
                body: parse_term(&s["body"]).unwrap(),
            })
            .collect(),
        vec![],
    )
    .unwrap();

    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    let batch = Admission {
        expected_head: None,
        next_head: "h-1".into(),
        frame: None,
        added: held(&fixture),
    };
    assert!(matches!(
        peer.append(&batch),
        Ok(AppendResult::Committed { .. })
    ));
    let snapshot = peer.read().unwrap();

    let cases = doc["readCases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let anchors = case["expectedScope"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| Anchor::Entity {
                entity: e.as_str().unwrap().to_string(),
            })
            .collect();
        store.reset_meter();
        let fetched = snapshot
            .scope(&ScopeRequest {
                anchors,
                ..ScopeRequest::default()
            })
            .unwrap();
        assert_eq!(store.meter().scans, 0, "{name}");
        let source = scope_source(&fetched.deltas).unwrap();

        let term = parse_term(&case["term"]).unwrap();
        let root = case["root"].as_str().unwrap();
        let now = case["now"].as_f64().unwrap();
        let read = eval_anchored(&term, &source, now, root, Some(&registry), None, None)
            .unwrap_or_else(|e| panic!("read {name}: {e}"));
        assert_eq!(
            result_canonical_hex(&read.result),
            case["expectedCanonicalHex"].as_str().unwrap(),
            "{name}"
        );
        let members: Vec<&str> = read.members.iter().map(|id| name_of[id.as_str()]).collect();
        let expected: Vec<&str> = case["expectedMembers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m.as_str().unwrap())
            .collect();
        assert_eq!(members, expected, "{name}");
    }
}

#[test]
fn a_scope_source_answers_only_from_what_was_fetched() {
    let doc = anchored_vectors();
    let fixture: Vec<Delta> = doc["fixture"]["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap())
        .collect();
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    let members = held(&fixture);
    let batch = Admission {
        expected_head: None,
        next_head: "h-1".into(),
        frame: None,
        added: members.clone(),
    };
    peer.append(&batch).unwrap();
    let snapshot = peer.read().unwrap();
    let anchor = |entity: &str| Anchor::Entity {
        entity: entity.to_string(),
    };

    let first = snapshot
        .scope(&ScopeRequest {
            anchors: vec![anchor("plant:a")],
            ..ScopeRequest::default()
        })
        .unwrap();
    assert!(!first.deltas.is_empty() && first.deltas.len() < fixture.len());
    let mut source = scope_source(&first.deltas).unwrap();
    let fetched: Vec<String> = first.deltas.iter().map(|m| m.delta.id.clone()).collect();
    assert_eq!(source.len(), fetched.len());
    assert_eq!(scope_ids(&source, ["plant:a"], None), fetched);
    assert_eq!(
        source.targets("plant:a"),
        snapshot.targets(&["plant:a".to_string()]).unwrap()
    );
    for member in &first.deltas {
        assert_eq!(source.get(&member.delta.id), Some(&member.delta));
        assert_eq!(source.arrival(&member.delta.id), Some(&member.arrival));
        assert_eq!(
            source.negators(&member.delta.id),
            snapshot
                .negators(std::slice::from_ref(&member.delta.id))
                .unwrap()
        );
    }
    let outside = members
        .iter()
        .find(|m| !fetched.contains(&m.delta.id))
        .unwrap();
    assert_eq!(source.get(&outside.delta.id), None);
    assert_eq!(source.arrival(&outside.delta.id), None);

    // A later round only grows the source; `exclude` keeps the store from sending members again.
    let second = snapshot
        .scope(&ScopeRequest {
            anchors: vec![anchor("plant:a"), anchor("plant:b")],
            exclude: fetched.clone(),
            ..ScopeRequest::default()
        })
        .unwrap();
    assert!(second.deltas.iter().all(|m| !fetched.contains(&m.delta.id)));
    source.extend(&second.deltas).unwrap();
    let both = snapshot
        .scope(&ScopeRequest {
            anchors: vec![anchor("plant:a"), anchor("plant:b")],
            ..ScopeRequest::default()
        })
        .unwrap();
    let both: Vec<String> = both.deltas.iter().map(|m| m.delta.id.clone()).collect();
    assert_eq!(scope_ids(&source, ["plant:a", "plant:b"], None), both);

    // A member whose id does not recompute is refused, never repaired.
    let mut forged = first.deltas[0].clone();
    forged.delta.id = outside.delta.id.clone();
    assert_eq!(
        code(scope_source(&[forged])),
        StoreErrorCode::InvalidRequest
    );
}

/// `vectors/store/README.md` §1.3 states these refusals, and no shared script reaches them.
#[test]
fn append_refusals_the_shared_scripts_do_not_reach() {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    assert_eq!(peer.id(), "peer:a");
    let delta = make_delta(
        rhizomatic::set::make_negation_claims("did:key:zA", 1.0, "1e20", None),
        None,
    )
    .unwrap();
    let batch = |next_head: &str, change: &dyn Fn(&mut ArrivalRecord)| {
        let mut added = held(std::slice::from_ref(&delta));
        change(&mut added[0].arrival);
        Admission {
            expected_head: None,
            next_head: next_head.into(),
            frame: None,
            added,
        }
    };
    let refusals: [Admission; 6] = [
        batch("", &|_| {}),
        batch("h-1", &|a| a.sequence = 0),
        batch("h-1", &|a| a.transfer = 0),
        batch("h-1", &|a| a.at = f64::NAN),
        batch("h-1", &|a| a.at = f64::INFINITY),
        batch("h-1", &|a| a.sender.clear()),
    ];
    for refused in &refusals {
        assert_eq!(code(peer.append(refused)), StoreErrorCode::InvalidAdmission);
    }
    // A refusal commits nothing: the head, the revision and the holdings stand.
    let snapshot = peer.read().unwrap();
    assert_eq!(
        (snapshot.revision(), snapshot.head(), snapshot.count()),
        (Revision(0), None, 0)
    );
    // A wrong head answers `conflict` before any entry is checked.
    let mut stale = batch("h-1", &|a| a.sequence = 0);
    stale.expected_head = Some("h-0".into());
    assert_eq!(peer.append(&stale), Ok(AppendResult::Conflict));
    assert!(matches!(
        peer.append(&batch("h-1", &|_| {})),
        Ok(AppendResult::Committed { .. })
    ));
}

/// Requirement names are an allow-list (SPEC-18 §4.11 reading 22). A name outside it is refused
/// and named; it is never looked up on the profile.
#[test]
fn requirement_names_are_an_allow_list() {
    let names: Vec<&str> = StoreRequirement::ALL.iter().map(|r| r.as_str()).collect();
    assert_eq!(
        names,
        [
            "values",
            "arrival",
            "journal",
            "views",
            "derivedIndexes",
            "digest",
            "changes",
            "purge",
            "erasure-proven"
        ]
    );
    for requirement in StoreRequirement::ALL {
        assert_eq!(
            StoreRequirement::parse(requirement.as_str()),
            Ok(requirement)
        );
    }
    for unknown in [
        "",
        "Values",
        "erasure",
        "derived_indexes",
        "formatVersion",
        "capabilities",
        "toString",
    ] {
        let refusal = StoreRequirement::parse(unknown).err().unwrap();
        assert_eq!(refusal.code, StoreErrorCode::InvalidRequest, "{unknown}");
        assert!(
            refusal.message.ends_with(&format!(": {unknown}")),
            "{refusal}"
        );
    }
}

fn entry(delta: &Delta, sequence: u64) -> VerifiedDelta {
    VerifiedDelta {
        delta: delta.clone(),
        arrival: ArrivalRecord {
            id: delta.id.clone(),
            at: 1000.5,
            sequence,
            transfer: 1,
            sender: "local".into(),
        },
    }
}

fn batch(head: (Option<&str>, &str), added: Vec<VerifiedDelta>) -> Admission {
    Admission {
        expected_head: head.0.map(str::to_string),
        next_head: head.1.into(),
        frame: None,
        added,
    }
}

fn plant(context: &str, mime: &str, payload: &[u8]) -> Delta {
    let claims = Claims {
        timestamp: 10.0,
        valid_from: 10.0,
        valid_until: None,
        author: "did:key:zA".into(),
        pointers: vec![
            Pointer {
                role: "subject".into(),
                target: Target::Entity(EntityRef {
                    id: "plant:a".into(),
                    context: Some(context.into()),
                }),
            },
            Pointer {
                role: "photo".into(),
                target: Target::Bytes {
                    mime: mime.into(),
                    value: payload.to_vec(),
                },
            },
        ],
    };
    make_delta(claims, None).unwrap()
}

/// The numbers JSON cannot carry, and the bounds at their edges (README §1.2, reading 20–21).
#[test]
fn non_finite_and_out_of_range_numbers_are_refused() {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    let delta = plant("photo", "image/png", &[1, 2, 3]);
    let other = plant("thumb", "image/png", &[4]);

    for at in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut bad = entry(&delta, 1);
        bad.arrival.at = at;
        assert_eq!(
            code(peer.append(&batch((None, "h-1"), vec![bad]))),
            StoreErrorCode::InvalidAdmission
        );
    }
    for (sequence, transfer) in [
        (MAX_ARRIVAL_COUNTER + 1, 1),
        (1, MAX_ARRIVAL_COUNTER + 1),
        (u64::MAX, 1),
        (0, 1),
        (1, 0),
    ] {
        let mut bad = entry(&delta, sequence);
        bad.arrival.transfer = transfer;
        assert_eq!(
            code(peer.append(&batch((None, "h-1"), vec![bad]))),
            StoreErrorCode::InvalidAdmission
        );
    }
    assert_eq!(peer.read().unwrap().count(), 0);

    // The largest legal counters commit, and a fractional `at` is kept as it is.
    let mut edge = entry(&delta, MAX_ARRIVAL_COUNTER);
    edge.arrival.transfer = MAX_ARRIVAL_COUNTER;
    assert!(matches!(
        peer.append(&batch((None, "h-1"), vec![edge.clone()])),
        Ok(AppendResult::Committed { .. })
    ));
    let snapshot = peer.read().unwrap();
    assert_eq!(
        snapshot.arrivals(std::slice::from_ref(&delta.id)).unwrap(),
        [edge.arrival]
    );
    // The largest sequence is spent, so no later delta can arrive at this peer.
    let late = batch(
        (Some("h-1"), "h-2"),
        vec![entry(&other, MAX_ARRIVAL_COUNTER)],
    );
    assert_eq!(code(peer.append(&late)), StoreErrorCode::InvalidAdmission);

    let scope = |pushdown: Pushdown| {
        snapshot.scope(&ScopeRequest {
            anchors: vec![Anchor::Entity {
                entity: "plant:a".into(),
            }],
            pushdown: Some(pushdown),
            exclude: vec![],
        })
    };
    for t in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let refused = scope(Pushdown {
            timestamp_at_most: Some(t),
            ..Pushdown::default()
        });
        assert_eq!(code(refused), StoreErrorCode::InvalidRequest);
    }
    for n in [MAX_ARRIVAL_COUNTER + 1, u64::MAX] {
        let refused = scope(Pushdown {
            arrival_at_most: Some(n),
            ..Pushdown::default()
        });
        assert_eq!(code(refused), StoreErrorCode::InvalidRequest);
    }
    let none = scope(Pushdown {
        arrival_at_most: Some(0),
        ..Pushdown::default()
    })
    .unwrap();
    assert!(none.deltas.is_empty() && none.applied.arrival_at_most);
    let all = scope(Pushdown {
        arrival_at_most: Some(MAX_ARRIVAL_COUNTER),
        ..Pushdown::default()
    })
    .unwrap();
    assert_eq!(all.deltas.len(), 1);
    let early = scope(Pushdown {
        timestamp_at_most: Some(-1.5),
        ..Pushdown::default()
    })
    .unwrap();
    assert!(early.deltas.is_empty());
}

/// A signature is 128 lowercase hex characters or the entry is refused, also when the peer
/// already holds the id (README §1.3 (c), steps 1–3 run before step 4).
#[test]
fn a_malformed_signature_is_refused_even_for_a_held_id() {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    let delta = plant("photo", "image/png", &[1]);
    let good = "0123456789abcdef".repeat(8);
    let mut signed = entry(&delta, 1);
    signed.delta.sig = Some(good.clone());
    assert!(matches!(
        peer.append(&batch((None, "h-1"), vec![signed])),
        Ok(AppendResult::Committed { .. })
    ));

    let bad_forms = [
        String::new(),
        "abc".into(),
        good.to_uppercase(),
        format!("{}g", &good[..127]),
        format!("{good}0"),
        good[..127].to_string(),
        format!("{}é", &good[..126]),
    ];
    for sig in bad_forms {
        let mut again = entry(&delta, 2);
        again.delta.sig = Some(sig.clone());
        let refused = peer.append(&batch((Some("h-1"), "h-2"), vec![again]));
        assert_eq!(code(refused), StoreErrorCode::InvalidAdmission, "{sig:?}");
    }
    let snapshot = peer.read().unwrap();
    assert_eq!(snapshot.head(), Some("h-1"));
    assert_eq!(
        snapshot.get(std::slice::from_ref(&delta.id)).unwrap()[0].sig,
        Some(good)
    );
}

/// A store owns what it holds (SPEC-18 §4.1). A caller that changes a value after appending it,
/// or a value any read returned, changes nothing in the store, for this peer or another. This
/// fails if any answer aliased stored state: every read is compared with the first one after
/// the caller has overwritten everything it was given, the bytes payload included.
#[test]
fn a_caller_cannot_reach_into_what_the_store_holds() {
    let store = MemoryStore::new();
    let a = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    let b = store
        .create_peer("peer:b", ErasurePosture::Unproven)
        .unwrap();
    let delta = plant("photo", "image/png", &[1, 2, 3]);
    let ids = vec![delta.id.clone()];
    let sig = "ab".repeat(64);

    let mut given = entry(&delta, 1);
    given.delta.sig = Some(sig.clone());
    let mut admission = batch((None, "h-1"), vec![given.clone()]);
    a.append(&admission).unwrap();
    b.append(&batch((None, "h-1"), vec![entry(&delta, 1)]))
        .unwrap();

    fn scribble(delta: &mut Delta) {
        delta.sig = Some("ff".repeat(64));
        delta.claims.author = "did:key:zMallory".into();
        delta.claims.timestamp = 99.0;
        for pointer in &mut delta.claims.pointers {
            pointer.role.push('!');
            if let Target::Bytes { mime, value } = &mut pointer.target {
                mime.push('!');
                value.iter_mut().for_each(|byte| *byte = 0xff);
                value.push(0xff);
            }
        }
    }
    fn scribble_arrival(arrival: &mut ArrivalRecord) {
        arrival.at = -1.0;
        arrival.sequence = 77;
        arrival.sender = "mallory".into();
    }

    // The value that was appended.
    scribble(&mut admission.added[0].delta);
    scribble_arrival(&mut admission.added[0].arrival);
    admission.next_head.push('!');

    let anchors = vec![Anchor::Entity {
        entity: "plant:a".into(),
    }];
    let request = ScopeRequest {
        anchors,
        ..ScopeRequest::default()
    };
    let admin = store.open_admin();
    let exported = |peer: &str| -> Vec<Delta> {
        admin
            .peer(peer)
            .unwrap()
            .deltas()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    for round in 0..2 {
        let snapshot = a.read().unwrap();
        assert_eq!(snapshot.head(), Some("h-1"), "round {round}");
        let mut got = snapshot.get(&ids).unwrap();
        let mut arrivals = snapshot.arrivals(&ids).unwrap();
        let mut scoped = snapshot.scope(&request).unwrap();
        let mut listed = exported("peer:a");
        for answer in [&got[0], &scoped.deltas[0].delta, &listed[0]] {
            assert_eq!(answer, &given.delta, "round {round}");
        }
        assert_eq!(arrivals[0], given.arrival, "round {round}");
        assert_eq!(scoped.deltas[0].arrival, given.arrival, "round {round}");
        // The other peer holds the same claims without the signature.
        let other = b.read().unwrap().get(&ids).unwrap();
        assert_eq!(other, std::slice::from_ref(&delta), "round {round}");
        assert_eq!(
            exported("peer:b"),
            std::slice::from_ref(&delta),
            "round {round}"
        );

        // Every value a read returned.
        scribble(&mut got[0]);
        scribble(&mut scoped.deltas[0].delta);
        scribble(&mut listed[0]);
        scribble_arrival(&mut arrivals[0]);
        scribble_arrival(&mut scoped.deltas[0].arrival);
        // A source over a fetched scope keeps its own copy as well.
        let mut members = snapshot.scope(&request).unwrap().deltas;
        let source = scope_source(&members).unwrap();
        scribble(&mut members[0].delta);
        scribble_arrival(&mut members[0].arrival);
        assert_eq!(source.get(&ids[0]), Some(&given.delta), "round {round}");
        assert_eq!(
            source.arrival(&ids[0]),
            Some(&given.arrival),
            "round {round}"
        );
    }

    // A purge report is the caller's too.
    let mut report = a.purge(&ids).unwrap();
    assert_eq!(
        (report.claim, report.targets[0].outcome),
        (ErasureClaim::NothingRemoved, PurgeOutcome::HeldByOtherPeer)
    );
    report.targets[0].id.push('!');
    assert_eq!(
        b.read().unwrap().get(&ids).unwrap(),
        std::slice::from_ref(&delta)
    );
    let last = b.purge(&ids).unwrap();
    assert_eq!(
        (last.claim, last.targets[0].outcome),
        (ErasureClaim::Unproven, PurgeOutcome::Removed)
    );
    assert_eq!(admin.stored_ids().count(), 0);
}

/// A refused `extend` adds nothing, and a repeated id is not examined (README §1.2 item 5).
#[test]
fn a_refused_scope_source_call_adds_nothing() {
    let first = entry(&plant("photo", "image/png", &[1]), 1);
    let second = entry(&plant("thumb", "image/png", &[2]), 2);
    let third = entry(&plant("scan", "image/png", &[3]), 3);
    let mut forged = entry(&plant("x-ray", "image/png", &[4]), 4);
    forged.delta.claims.timestamp += 1.0;

    let mut source = scope_source(std::slice::from_ref(&first)).unwrap();
    let before = (source.ids().len(), source.targets("plant:a"));

    // Good members before and after the forged one: none of them may enter.
    let round = [second.clone(), forged.clone(), third.clone()];
    assert_eq!(code(source.extend(&round)), StoreErrorCode::InvalidRequest);
    assert_eq!((source.ids().len(), source.targets("plant:a")), before);
    assert_eq!(source.get(&second.delta.id), None);
    assert_eq!(source.arrival(&third.delta.id), None);
    assert_eq!(source.len(), 1);
    // A source is not built at all from a refused first call.
    assert_eq!(code(scope_source(&round)), StoreErrorCode::InvalidRequest);

    // A repeated id is not examined: the first appearance is kept, whatever the repeat holds.
    let mut repeat_of_held = first.clone();
    repeat_of_held.delta.claims.timestamp += 1.0;
    repeat_of_held.arrival.sequence = 99;
    let mut repeat_in_call = second.clone();
    repeat_in_call.delta.claims.timestamp += 1.0;
    source
        .extend(&[repeat_of_held, second.clone(), repeat_in_call])
        .unwrap();
    assert_eq!(source.len(), 2);
    assert_eq!(source.get(&first.delta.id), Some(&first.delta));
    assert_eq!(source.arrival(&first.delta.id), Some(&first.arrival));
    assert_eq!(source.get(&second.delta.id), Some(&second.delta));
    // A forged first appearance is refused even when a good repeat follows it.
    let mut forged_third = third.clone();
    forged_third.delta.claims.timestamp += 1.0;
    assert_eq!(
        code(source.extend(&[forged_third, third])),
        StoreErrorCode::InvalidRequest
    );
    assert_eq!(source.len(), 2);
}

/// The shape of a request comes before the snapshot's state (README §1.4, reading 27): a bound
/// outside its legal values is `invalid-request` on a moved snapshot and on a released one.
#[test]
fn an_invalid_scope_bound_is_refused_before_snapshot_state() {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    let delta = plant("photo", "image/png", &[1]);
    peer.append(&batch((None, "h-1"), vec![entry(&delta, 1)]))
        .unwrap();
    let mut snapshot = peer.read().unwrap();
    let scope = |snapshot: &dyn rhizomatic::store::Snapshot, pushdown: Option<Pushdown>| {
        snapshot.scope(&ScopeRequest {
            anchors: vec![Anchor::Entity {
                entity: "plant:a".into(),
            }],
            pushdown,
            exclude: vec![],
        })
    };
    let bad_bounds = [
        Pushdown {
            arrival_at_most: Some(MAX_ARRIVAL_COUNTER + 1),
            ..Pushdown::default()
        },
        Pushdown {
            timestamp_at_most: Some(f64::NAN),
            ..Pushdown::default()
        },
        Pushdown {
            timestamp_at_most: Some(f64::INFINITY),
            ..Pushdown::default()
        },
    ];

    peer.append(&batch((Some("h-1"), "h-2"), vec![])).unwrap();
    assert_eq!(
        code(scope(snapshot.as_ref(), None)),
        StoreErrorCode::SnapshotMoved
    );
    for bound in &bad_bounds {
        assert_eq!(
            code(scope(snapshot.as_ref(), Some(bound.clone()))),
            StoreErrorCode::InvalidRequest
        );
    }
    snapshot.release();
    assert_eq!(
        code(scope(snapshot.as_ref(), None)),
        StoreErrorCode::SnapshotReleased
    );
    for bound in &bad_bounds {
        assert_eq!(
            code(scope(snapshot.as_ref(), Some(bound.clone()))),
            StoreErrorCode::InvalidRequest
        );
    }
}

/// Reading 32 in one place: heads compare byte for byte and `""` is not null; a skipped entry
/// spends no sequence; the largest sequence survives a peer that holds nothing; a forged entry
/// is refused also when its arrival record names the id its claims really have.
#[test]
fn heads_sequences_and_forged_entries() {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    let one = plant("photo", "image/png", &[1]);
    let two = plant("thumb", "image/png", &[2]);
    let three = plant("scan", "image/png", &[3]);

    // A new peer's head is null, and the empty string is not null.
    let empty_head = batch((Some(""), "h-1"), vec![entry(&one, 5)]);
    assert_eq!(peer.append(&empty_head), Ok(AppendResult::Conflict));
    peer.append(&batch((None, "h-1"), vec![entry(&one, 5)]))
        .unwrap();
    for stale in ["", "H-1", " h-1", "h-1 ", "h-1\0"] {
        let attempt = batch((Some(stale), "h-2"), vec![entry(&two, 6)]);
        assert_eq!(
            peer.append(&attempt),
            Ok(AppendResult::Conflict),
            "{stale:?}"
        );
    }

    // A skipped entry's sequence is compared with nothing and raises nothing: 900 is not spent,
    // and a new entry of the same batch may carry the skipped entry's number.
    let skipped = batch(
        (Some("h-1"), "h-2"),
        vec![entry(&one, 900), entry(&two, 900)],
    );
    assert!(
        matches!(&peer.append(&skipped), Ok(AppendResult::Committed { added, .. }) if *added == [two.id.clone()])
    );
    let held_only = batch((Some("h-2"), "h-3"), vec![entry(&one, 5000)]);
    assert!(
        matches!(&peer.append(&held_only), Ok(AppendResult::Committed { added, .. }) if added.is_empty())
    );
    let ids = vec![one.id.clone(), two.id.clone()];
    let sequences: Vec<u64> = peer
        .read()
        .unwrap()
        .arrivals(&ids)
        .unwrap()
        .iter()
        .map(|a| a.sequence)
        .collect();
    let mut sorted = sequences.clone();
    sorted.sort();
    assert_eq!(sorted, [5, 900]);

    // The largest sequence, 900, survives a purge that empties the peer.
    peer.purge(&ids).unwrap();
    assert_eq!(peer.read().unwrap().count(), 0);
    for spent in [5, 900] {
        let late = batch((Some("h-3"), "h-4"), vec![entry(&three, spent)]);
        assert_eq!(code(peer.append(&late)), StoreErrorCode::InvalidAdmission);
    }

    // A store never repairs: these claims recompute to `three`'s id, the delta says `one`'s,
    // and the arrival record names the real id. Nothing is filed under either id.
    let mut forged = entry(&three, 901);
    forged.delta.id = one.id.clone();
    assert_eq!(forged.arrival.id, three.id);
    assert_eq!(
        code(peer.append(&batch((Some("h-3"), "h-4"), vec![forged]))),
        StoreErrorCode::InvalidAdmission
    );
    let all = vec![one.id.clone(), three.id.clone()];
    assert_eq!(peer.read().unwrap().get(&all).unwrap(), []);
    assert_eq!(store.open_admin().stored_ids().count(), 0);
    assert!(matches!(
        peer.append(&batch((Some("h-3"), "h-4"), vec![entry(&three, 901)])),
        Ok(AppendResult::Committed { .. })
    ));
}
