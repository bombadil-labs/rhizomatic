//! The host side of the store (SPEC-18 proposal §4.8–§4.11), which the shared vectors do not
//! cover: opening by URL scheme, scheme registration, requirements, close, and a synchronous
//! delta source over a fetched scope.

use std::collections::BTreeMap;

use rhizomatic::anchored::{eval_anchored, scope_ids, DeltaSource};
use rhizomatic::eval::result_canonical_hex;
use rhizomatic::json_profile::parse_claims;
use rhizomatic::memory_store::{memory_store_profile, MemoryStore, MEMORY_STORE_FORMAT};
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::make_delta;
use rhizomatic::store::{
    missing_requirements, scope_source, Admission, Anchor, AppendResult, ArrivalRecord, AtRest,
    ChangeRetention, ErasureClass, ErasurePosture, PushdownFields, Revision, ScopeRequest, Store,
    StoreCapabilities, StoreError, StoreErrorCode, StoreProfile, StoreRequirement, StoreWriters,
    VerifiedDelta,
};
use rhizomatic::store_open::{open_store, OpenOptions, StoreSchemes};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::Delta;
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

#[test]
fn memory_opens_a_new_empty_store_with_the_slice_1_profile() {
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
            change_retention: ChangeRetention::None,
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
    let schemes = StoreSchemes::new();
    let options = OpenOptions::default();
    let unknown = schemes.open(SECRET_URL, &options).err().unwrap();
    assert_eq!(unknown.code, StoreErrorCode::UnknownScheme);
    assert!(unknown.message.contains("vault"));
    for refusal in [
        unknown,
        schemes
            .open("no scheme here hunter2", &options)
            .err()
            .unwrap(),
        schemes.open("memory:hunter2", &options).err().unwrap(),
        schemes.open("9x:hunter2", &options).err().unwrap(),
    ] {
        assert!(!refusal.to_string().contains("hunter2"), "{refusal}");
    }
    assert_eq!(
        code(schemes.open("no-colon", &options)),
        StoreErrorCode::InvalidUrl
    );
    assert_eq!(
        code(schemes.open(":x", &options)),
        StoreErrorCode::InvalidUrl
    );
    assert_eq!(
        code(schemes.open("memory:addr", &options)),
        StoreErrorCode::InvalidUrl
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
    assert_eq!(missing_requirements(&profile, &[Arrival, Purge]), []);
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
        Changes,
        ErasureProven,
    ];
    assert_eq!(missing_requirements(&profile, &all), missing);
    assert_eq!(
        missing_requirements(&profile, &[Changes, Changes]),
        [Changes]
    );
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
        "changes",
        "erasure-proven",
    ] {
        assert!(refusal.message.contains(name), "{refusal} lacks {name}");
    }
    assert!(!refusal.message.contains("arrival") && !refusal.message.contains("purge"));

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
        requires: vec![Changes],
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
