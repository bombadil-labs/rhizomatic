//! The SPEC-14 principal reads over a fetched scope (SPEC-18 slice 2 plan §4, §5). Each shared
//! principal case and history case loads into a memory store peer; the test fetches the scope of
//! one entity, the principal root, and runs the read over that synchronous source. The answer
//! must equal the vector's expectation and the Reactor's full result.
//!
//! Not covered here: the `actsFor` predicate cases. Their resolver takes a whole input set, and
//! its store form belongs to a later slice. The Reactor run of every family stays in
//! `principal_vectors.rs`.

use std::collections::BTreeMap;

use rhizomatic::json_profile::parse_claims;
use rhizomatic::memory_store::{MemoryStore, StoreMeter};
use rhizomatic::principal::{
    associated_keys, authors_for_principal, resolve_principal, AssociatedKey, PrincipalReadOptions,
    PrincipalSuppression, ScopePolicy,
};
use rhizomatic::reactor::{IngestResult, Reactor};
use rhizomatic::set::{make_delta, make_negation_claims, DeltaSource};
use rhizomatic::store::{
    scope_source, Admission, Anchor, AppendResult, ArrivalRecord, ErasurePosture, PeerStore,
    ScopeRequest, ScopeSource, Store, VerifiedDelta,
};
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};
use serde_json::Value;

fn vector() -> Value {
    let path = format!(
        "{}/../../vectors/principal/evidence.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vector")).unwrap()
}

fn fixtures(v: &Value) -> BTreeMap<String, Delta> {
    v["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let name = entry["name"].as_str().unwrap().to_string();
            let delta = Delta {
                id: entry["id"].as_str().unwrap().to_string(),
                claims: parse_claims(&entry["claims"]).unwrap(),
                sig: entry["sig"].as_str().map(str::to_string),
            };
            (name, delta)
        })
        .collect()
}

fn members_of(case: &Value, named: &BTreeMap<String, Delta>) -> Vec<Delta> {
    case["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| named[name.as_str().unwrap()].clone())
        .collect()
}

fn reactor_of(deltas: &[Delta]) -> Reactor {
    let mut reactor = Reactor::new();
    for delta in deltas {
        assert_eq!(reactor.ingest(delta.clone()), IngestResult::Accepted);
    }
    reactor
}

/// A memory store with one peer, filled by one admission on the empty peer: no expected head, a
/// fixed next head, no frame. Arrival sequences run 1..n in ascending id order, so the load does
/// not depend on the order given. Test fixtures only; nothing else writes a store this way.
struct Loaded {
    store: MemoryStore,
    peer: Box<dyn PeerStore>,
}

fn load_peer(deltas: &[Delta]) -> Loaded {
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:fixture", ErasurePosture::Unproven)
        .unwrap();
    let mut sorted: Vec<&Delta> = deltas.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    if !sorted.is_empty() {
        let added: Vec<VerifiedDelta> = sorted
            .iter()
            .zip(1u64..)
            .map(|(delta, sequence)| VerifiedDelta {
                delta: (*delta).clone(),
                arrival: ArrivalRecord {
                    id: delta.id.clone(),
                    at: 0.0,
                    sequence,
                    transfer: 1,
                    sender: "fixture".into(),
                },
            })
            .collect();
        let result = peer
            .append(&Admission {
                expected_head: None,
                next_head: "fixture-head".into(),
                frame: None,
                added,
            })
            .unwrap();
        assert!(
            matches!(result, AppendResult::Committed { added, .. } if added.len() == deltas.len())
        );
    }
    store.reset_meter();
    Loaded { store, peer }
}

/// One snapshot, one `scope` call for these entity anchors, then the synchronous source. `calls`
/// receives the name of every snapshot read the fetch makes.
fn fetch_entities(peer: &dyn PeerStore, entities: &[&str], calls: &mut Vec<String>) -> ScopeSource {
    let mut snapshot = peer.read().unwrap();
    calls.push("read".into());
    let fetched = snapshot
        .scope(&ScopeRequest {
            anchors: entities
                .iter()
                .map(|entity| Anchor::Entity {
                    entity: entity.to_string(),
                })
                .collect(),
            ..ScopeRequest::default()
        })
        .unwrap();
    calls.push(format!("scope({})", entities.join(",")));
    snapshot.release();
    scope_source(&fetched.deltas).unwrap()
}

fn fetch(peer: &dyn PeerStore, entities: &[&str]) -> ScopeSource {
    fetch_entities(peer, entities, &mut Vec::new())
}

fn options_of(v: &Value, case: &Value) -> PrincipalReadOptions {
    let name = case["name"].as_str().unwrap();
    let policy_name = case["scopePolicy"]
        .as_str()
        .unwrap_or(v["defaults"]["scopePolicy"].as_str().unwrap());
    let suppression_name = case["suppression"]
        .as_str()
        .unwrap_or(v["defaults"]["suppression"].as_str().unwrap());
    PrincipalReadOptions {
        at: case["at"].as_f64().unwrap(),
        now: case["now"]
            .as_f64()
            .unwrap_or(v["defaults"]["now"].as_f64().unwrap()),
        scope: case["scope"].as_str().unwrap().to_string(),
        scope_policy: match policy_name {
            "exact" => ScopePolicy::Exact,
            "prefix" => ScopePolicy::Prefix,
            _ => panic!("unknown scope policy in {name}"),
        },
        suppression: match suppression_name {
            "sameAuthor" => PrincipalSuppression::SameAuthor,
            "rootOrSameAuthor" => PrincipalSuppression::RootOrSameAuthor,
            _ => panic!("unknown suppression in {name}"),
        },
    }
}

fn root_of<'a>(v: &'a Value, case: &'a Value) -> &'a str {
    let alias = case["root"]
        .as_str()
        .unwrap_or(v["defaults"]["root"].as_str().unwrap());
    v["keys"][alias].as_str().unwrap()
}

fn default_root(v: &Value) -> &str {
    v["keys"][v["defaults"]["root"].as_str().unwrap()]
        .as_str()
        .unwrap()
}

fn pick<'a>(v: &'a Value, name: &str) -> &'a Value {
    v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("principal vector lost the case {name}"))
}

/// Deltas that point at no principal root: facts on other entities and strikes on some.
fn unrelated(count: usize) -> Vec<Delta> {
    let facts: Vec<Delta> = (0..count)
        .map(|i| {
            let claims = Claims {
                timestamp: i as f64,
                valid_from: 0.0,
                valid_until: None,
                author: "did:key:zBystander".into(),
                pointers: vec![
                    Pointer {
                        role: "subject".into(),
                        target: Target::Entity(EntityRef {
                            id: format!("other:{}", i % 11),
                            context: Some("v".into()),
                        }),
                    },
                    Pointer {
                        role: "value".into(),
                        target: Target::Primitive(Primitive::Num(i as f64)),
                    },
                ],
            };
            make_delta(claims, None).unwrap()
        })
        .collect();
    let strikes: Vec<Delta> = facts
        .iter()
        .take(count / 10)
        .enumerate()
        .map(|(i, fact)| {
            let claims =
                make_negation_claims("did:key:zStriker", 5000.0 + i as f64, &fact.id, None);
            make_delta(claims, None).unwrap()
        })
        .collect();
    facts.into_iter().chain(strikes).collect()
}

#[test]
fn every_authority_case_resolves_from_the_scope_of_the_root_alone() {
    let v = vector();
    let named = fixtures(&v);
    let keys = v["keys"].as_object().unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 43, "the vector lost cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let members = members_of(case, &named);
        let root = root_of(&v, case);
        let key = keys[case["key"].as_str().unwrap()].as_str().unwrap();
        let options = options_of(&v, case);
        let loaded = load_peer(&members);
        let mut calls = Vec::new();
        let source = fetch_entities(loaded.peer.as_ref(), &[root], &mut calls);
        assert_eq!(calls, ["read".to_string(), format!("scope({root})")]);

        let result = resolve_principal(&source, root, key, &options).unwrap();
        let expected = &case["expected"];
        let mut expected_authors: Vec<String> = expected["authors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|alias| keys[alias.as_str().unwrap()].as_str().unwrap().to_string())
            .collect();
        expected_authors.sort();
        assert_eq!(
            result.grade.as_str(),
            expected["grade"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(
            result.authorized,
            expected["authorized"].as_bool().unwrap(),
            "{name}"
        );
        assert_eq!(
            result.delegable,
            expected["delegable"].as_bool().unwrap(),
            "{name}"
        );
        assert_eq!(result.authors, expected_authors, "{name}");
        assert_eq!(
            authors_for_principal(&source, root, &options).unwrap(),
            expected_authors,
            "{name}"
        );
        // The paths are not in the vector; the Reactor run over the whole set pins them.
        let whole = reactor_of(&members);
        assert_eq!(
            result,
            resolve_principal(&whole, root, key, &options).unwrap(),
            "{name}"
        );
        // The reads take a trait object as well as a concrete source.
        let object: &dyn DeltaSource = &source;
        assert_eq!(
            resolve_principal(object, root, key, &options).unwrap(),
            result,
            "{name}"
        );
    }
}

#[test]
fn history_reads_from_the_scope_of_the_root_alone() {
    let v = vector();
    let named = fixtures(&v);
    let keys = v["keys"].as_object().unwrap();
    let root = default_root(&v);
    let history = v["history"].as_array().unwrap();
    assert!(history.len() >= 2, "the vector lost history cases");
    for case in history {
        let name = case["name"].as_str().unwrap();
        let members = members_of(case, &named);
        let now = case["now"].as_f64().unwrap();
        let loaded = load_peer(&members);
        let source = fetch(loaded.peer.as_ref(), &[root]);
        let rows = associated_keys(&source, root, now, PrincipalSuppression::SameAuthor).unwrap();
        let expected: Vec<(String, Vec<String>, bool)> = case["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    keys[row["key"].as_str().unwrap()]
                        .as_str()
                        .unwrap()
                        .to_string(),
                    row["via"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|alias| named[alias.as_str().unwrap()].id.clone())
                        .collect(),
                    row["negated"].as_bool().unwrap(),
                )
            })
            .collect();
        let actual: Vec<(String, Vec<String>, bool)> = rows
            .iter()
            .map(|row| (row.key.clone(), row.via.clone(), row.negated))
            .collect();
        assert_eq!(actual, expected, "{name}");
        let whole = reactor_of(&members);
        assert_eq!(
            rows,
            associated_keys(&whole, root, now, PrincipalSuppression::SameAuthor).unwrap(),
            "{name}"
        );
    }
}

/// One peer holds the whole fixture set, so every case reads its own root among the evidence of
/// the other root. The Reactor over the same whole set is the oracle.
#[test]
fn every_case_answers_the_same_with_the_whole_vector_loaded_beside_it() {
    let v = vector();
    let named = fixtures(&v);
    let keys = v["keys"].as_object().unwrap();
    let all: Vec<Delta> = named.values().cloned().collect();
    let loaded = load_peer(&all);
    let whole = reactor_of(&all);
    for case in v["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = root_of(&v, case);
        let key = keys[case["key"].as_str().unwrap()].as_str().unwrap();
        let options = options_of(&v, case);
        let source = fetch(loaded.peer.as_ref(), &[root]);
        assert_eq!(
            resolve_principal(&source, root, key, &options).unwrap(),
            resolve_principal(&whole, root, key, &options).unwrap(),
            "{name}"
        );
    }
    let root = default_root(&v);
    let source = fetch(loaded.peer.as_ref(), &[root]);
    for case in v["history"].as_array().unwrap() {
        let now = case["now"].as_f64().unwrap();
        assert_eq!(
            associated_keys(&source, root, now, PrincipalSuppression::SameAuthor).unwrap(),
            associated_keys(&whole, root, now, PrincipalSuppression::SameAuthor).unwrap(),
            "{}",
            case["name"]
        );
    }
}

// The cost and control rails use one case with delegation and negation evidence.
const CASE: &str = "expired-self-revocation-revives";

#[test]
fn the_fetch_makes_the_same_store_calls_beside_0_and_1100_unrelated_deltas() {
    let v = vector();
    let named = fixtures(&v);
    let case = pick(&v, CASE);
    let root = default_root(&v);
    let key = v["keys"][case["key"].as_str().unwrap()].as_str().unwrap();
    let options = options_of(&v, case);
    let members = members_of(case, &named);

    type Measured = (Vec<String>, StoreMeter, String, Vec<AssociatedKey>, usize);
    let measure = |extra: &[Delta]| -> Measured {
        let held: Vec<Delta> = members.iter().chain(extra).cloned().collect();
        let loaded = load_peer(&held);
        let mut calls = Vec::new();
        let source = fetch_entities(loaded.peer.as_ref(), &[root], &mut calls);
        let after_fetch = loaded.store.meter();
        let result = resolve_principal(&source, root, key, &options).unwrap();
        let rows =
            associated_keys(&source, root, options.at, PrincipalSuppression::SameAuthor).unwrap();
        // The reads themselves touch the store zero times: the source is synchronous.
        assert_eq!(loaded.store.meter(), after_fetch);
        (
            calls,
            after_fetch,
            format!("{result:?}"),
            rows,
            source.ids().len(),
        )
    };
    let alone = measure(&[]);
    let crowd = unrelated(1000);
    assert_eq!(crowd.len(), 1100);
    let crowded = measure(&crowd);
    assert_eq!(crowded, alone);
    assert_eq!(alone.0, ["read".to_string(), format!("scope({root})")]);
    assert_eq!(alone.1.scans, 0);
    // The rail measures something: the fetch did index work and brought the evidence back.
    assert!(alone.1.lookups > 0);
    assert_eq!(alone.4, members.len());
    assert!(alone.2.contains("authorized: true"), "{}", alone.2);
}

#[test]
fn a_scope_fetched_at_the_wrong_entity_holds_no_evidence() {
    let v = vector();
    let named = fixtures(&v);
    let case = pick(&v, CASE);
    let root = default_root(&v);
    let key = v["keys"][case["key"].as_str().unwrap()].as_str().unwrap();
    let options = options_of(&v, case);
    let held: Vec<Delta> = members_of(case, &named)
        .into_iter()
        .chain(unrelated(20))
        .collect();
    let loaded = load_peer(&held);
    let peer = loaded.peer.as_ref();

    let nothing = resolve_principal(&ScopeSource::default(), root, key, &options).unwrap();
    assert_eq!(nothing.authors, [root.to_string()]);
    assert!(!nothing.authorized);

    // The peer holds the evidence, and the right fetch finds it.
    let right = fetch(peer, &[root]);
    assert!(
        resolve_principal(&right, root, key, &options)
            .unwrap()
            .authorized
    );
    // A key that the evidence names, an entity that holds bystander deltas, and no entity.
    let wrong_anchors: [&[&str]; 3] = [&[key], &["other:3"], &[]];
    for entities in wrong_anchors {
        let wrong = fetch(peer, entities);
        assert_eq!(
            resolve_principal(&wrong, root, key, &options).unwrap(),
            nothing,
            "{entities:?}"
        );
        assert_eq!(
            authors_for_principal(&wrong, root, &options).unwrap(),
            [root.to_string()]
        );
        let rows =
            associated_keys(&wrong, root, options.at, PrincipalSuppression::SameAuthor).unwrap();
        assert_eq!(rows.len(), 1, "{entities:?}");
        assert_eq!(
            (rows[0].key.as_str(), rows[0].via.len(), rows[0].negated),
            (root, 0, false)
        );
    }
    assert!(!fetch(peer, &["other:3"]).ids().is_empty());
}
