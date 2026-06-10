//! Delta-set algebra: CRDT property tests (proptest) + the cross-impl digest vector.
//! Mirrors ../ts/test/set.test.ts.

use proptest::prelude::*;
use rhizomatic::json_profile::parse_claims;
use rhizomatic::set::{federate, fork, make_delta, make_negation_claims, merge, DeltaSet};
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};
use serde_json::Value;

// --- generators -------------------------------------------------------------------------------

fn target() -> impl Strategy<Value = Target> {
    prop_oneof![
        prop_oneof![
            "[a-z]{0,6}".prop_map(Primitive::Str),
            (-1000..1000i32).prop_map(|n| Primitive::Num(f64::from(n))),
            any::<bool>().prop_map(Primitive::Bool),
        ]
        .prop_map(Target::Primitive),
        (
            prop_oneof![Just("e1"), Just("e2"), Just("e3")],
            proptest::option::of(prop_oneof![Just("c1"), Just("c2")])
        )
            .prop_map(|(id, context)| Target::Entity(EntityRef {
                id: id.to_string(),
                context: context.map(str::to_string),
            })),
    ]
}

fn pointer() -> impl Strategy<Value = Pointer> {
    (prop_oneof![Just("r1"), Just("r2"), Just("r3")], target()).prop_map(|(role, target)| Pointer {
        role: role.to_string(),
        target,
    })
}

fn claims() -> impl Strategy<Value = Claims> {
    (
        0..1_000_000i64,
        prop_oneof![Just("did:key:zA"), Just("did:key:zB"), Just("did:key:zC")],
        proptest::collection::vec(pointer(), 1..=3),
    )
        .prop_map(|(ts, author, pointers)| Claims {
            timestamp: ts as f64,
            author: author.to_string(),
            pointers,
        })
}

fn delta() -> impl Strategy<Value = Delta> {
    claims().prop_map(|c| make_delta(c, None).expect("generated claims are valid"))
}

fn delta_set() -> impl Strategy<Value = DeltaSet> {
    proptest::collection::vec(delta(), 0..=20)
        .prop_map(|ds| DeltaSet::from_deltas(ds).expect("generated deltas are valid"))
}

fn even(d: &Delta) -> bool {
    (d.claims.timestamp as i64) % 2 == 0
}

// --- CRDT laws (SPEC-1 §8) ----------------------------------------------------------------------

proptest! {
    #[test]
    fn merge_is_commutative(a in delta_set(), b in delta_set()) {
        prop_assert_eq!(merge(&a, &b).digest(), merge(&b, &a).digest());
    }

    #[test]
    fn merge_is_associative(a in delta_set(), b in delta_set(), c in delta_set()) {
        prop_assert_eq!(merge(&merge(&a, &b), &c).digest(), merge(&a, &merge(&b, &c)).digest());
    }

    #[test]
    fn merge_is_idempotent(a in delta_set()) {
        prop_assert_eq!(merge(&a, &a).digest(), a.digest());
    }

    #[test]
    fn fork_yields_matching_subset(a in delta_set()) {
        let f = fork(&a, even);
        for d in f.iter() {
            prop_assert!(a.contains(&d.id));
            prop_assert!(even(d));
        }
    }

    #[test]
    fn fork_partitions(a in delta_set()) {
        let left = fork(&a, even);
        let right = fork(&a, |d| !even(d));
        prop_assert_eq!(merge(&left, &right).digest(), a.digest());
    }

    #[test]
    fn federate_is_merge_of_filtered_fork(a in delta_set(), b in delta_set()) {
        prop_assert_eq!(federate(&a, &b, even).digest(), merge(&a, &fork(&b, even)).digest());
    }

    #[test]
    fn union_deduplicates_by_id(d in delta()) {
        let copy = make_delta(d.claims.clone(), None).unwrap();
        let s = DeltaSet::from_deltas([d.clone(), d, copy]).unwrap();
        prop_assert_eq!(s.len(), 1);
    }
}

// --- guards & helpers -----------------------------------------------------------------------------

#[test]
fn rejects_forged_id() {
    let claims = parse_claims(&serde_json::json!({
        "timestamp": 0, "author": "a",
        "pointers": [{ "role": "x", "target": { "value": 1 } }]
    }))
    .unwrap();
    let mut forged = make_delta(claims, None).unwrap();
    forged.id = format!("1e20{}", "00".repeat(32));
    let err = DeltaSet::new().add(forged).unwrap_err();
    assert!(err.contains("content addressing"), "got: {err}");
}

#[test]
fn negation_claims_shape() {
    let claims = make_negation_claims(
        "did:key:zA",
        5.0,
        &format!("1e20{}", "ab".repeat(32)),
        Some("superseded"),
    );
    assert_eq!(claims.pointers[0].role, "negates");
    assert!(matches!(claims.pointers[0].target, Target::Delta(_)));
    assert_eq!(claims.pointers[1].role, "reason");
    // and it is a perfectly ordinary delta:
    assert!(make_delta(claims, None).unwrap().id.starts_with("1e20"));
}

// --- cross-impl digest vector ---------------------------------------------------------------------

#[test]
fn set_digest_vector() {
    let base = env!("CARGO_MANIFEST_DIR");
    let vec: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{base}/../../vectors/l0-delta/set-digest.json")).unwrap(),
    )
    .unwrap();
    let deltas: Vec<Value> = serde_json::from_str(
        &std::fs::read_to_string(format!("{base}/../../vectors/l0-delta/deltas.json")).unwrap(),
    )
    .unwrap();
    let s = DeltaSet::from_deltas(
        deltas
            .iter()
            .map(|v| make_delta(parse_claims(&v["claims"]).unwrap(), None).unwrap()),
    )
    .unwrap();
    let expected_ids: Vec<&str> = vec["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap())
        .collect();
    assert_eq!(s.ids(), expected_ids);
    assert_eq!(s.digest(), vec["digest"].as_str().unwrap());
}
