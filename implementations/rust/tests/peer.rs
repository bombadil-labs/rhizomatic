//! Federation tests. Mirrors ../ts/test/peer.test.ts.

use proptest::prelude::*;
use rhizomatic::peer::{sync_both, Peer};
use rhizomatic::reactor::make_manifest_claims;
use rhizomatic::set::make_delta;
use rhizomatic::term_json::{parse_pred, parse_term};
use rhizomatic::types::{Claims, EntityRef, Pointer, Primitive, Target};
use serde_json::json;

const SEED_A: &str = "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a";
const SEED_B: &str = "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b";
const SEED_C: &str = "0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c";

fn ptrs(entity: &str, context: &str, value: &str) -> Vec<Pointer> {
    vec![
        Pointer {
            role: "subject".to_string(),
            target: Target::Entity(EntityRef {
                id: entity.to_string(),
                context: Some(context.to_string()),
            }),
        },
        Pointer {
            role: "value".to_string(),
            target: Target::Primitive(Primitive::Str(value.to_string())),
        },
    ]
}

proptest! {
    #[test]
    fn random_fork_pairs_converge_to_union(
        avs in proptest::collection::vec((0..1000i64, "[a-z]{0,5}"), 0..6),
        bvs in proptest::collection::vec((1000..2000i64, "[a-z]{0,5}"), 0..6),
    ) {
        let mut a = Peer::new(SEED_A);
        let mut b = Peer::new(SEED_B);
        for (i, (ts, v)) in avs.iter().enumerate() {
            a.author_claims(*ts as f64, ptrs(&format!("e{i}"), "ca", v));
        }
        for (i, (ts, v)) in bvs.iter().enumerate() {
            b.author_claims(*ts as f64, ptrs(&format!("e{i}"), "cb", v));
        }
        sync_both(&mut a, &mut b);
        prop_assert_eq!(a.reactor.digest(), b.reactor.digest());
        prop_assert_eq!(a.reactor.len(), avs.len() + bvs.len());
    }
}

#[test]
fn lens_fidelity_selective_sharing() {
    let mut a = Peer::new(SEED_A);
    a.offered_lens = Some(
        parse_term(&json!({
            "op": "select",
            "pred": { "hasPointer": { "targetEntity": "public:doc" } },
            "in": "input"
        }))
        .unwrap(),
    );
    a.author_claims(1.0, ptrs("public:doc", "title", "shared"));
    a.author_claims(2.0, ptrs("secret:doc", "title", "private"));
    let mut b = Peer::new(SEED_B);
    b.pull_from(&a);
    assert_eq!(b.reactor.len(), 1);
    assert_eq!(b.reactor.by_target("public:doc").len(), 1);
    assert!(b.reactor.by_target("secret:doc").is_empty());
}

#[test]
fn unsigned_uncovered_deltas_are_withheld() {
    let mut a = Peer::new(SEED_A);
    let unsigned = make_delta(
        Claims {
            timestamp: 5.0,
            author: "did:key:zLocalOnly".to_string(),
            pointers: vec![Pointer {
                role: "note".to_string(),
                target: Target::Primitive(Primitive::Str("stays home".to_string())),
            }],
        },
        None,
    )
    .unwrap();
    let unsigned_id = unsigned.id.clone();
    a.reactor.ingest(unsigned); // legal locally
    a.author_claims(6.0, ptrs("e", "c", "travels"));
    let mut b = Peer::new(SEED_B);
    let report = b.pull_from(&a);
    assert_eq!(report.withheld, 1);
    assert!(!b.reactor.contains(&unsigned_id));
    assert_eq!(b.reactor.len(), 1);
}

#[test]
fn signed_manifest_carries_unsigned_members_as_bundle() {
    let mut a = Peer::new(SEED_A);
    let member = make_delta(
        Claims {
            timestamp: 7.0,
            author: "did:key:zUnsignedAuthor".to_string(),
            pointers: vec![Pointer {
                role: "note".to_string(),
                target: Target::Primitive(Primitive::Str("covered".to_string())),
            }],
        },
        None,
    )
    .unwrap();
    let member_id = member.id.clone();
    a.reactor.ingest(member);
    let manifest_claims = make_manifest_claims(
        &a.author,
        8.0,
        std::slice::from_ref(&member_id),
        None,
        Some("cover"),
    );
    let manifest = a.author_claims(8.0, manifest_claims.pointers);
    let mut b = Peer::new(SEED_B);
    let report = b.pull_from(&a);
    assert_eq!(report.bundles, 1);
    assert!(b.reactor.contains(&member_id)); // the unsigned member crossed, covered
    assert!(b.reactor.holds_all_members(&manifest.id));
}

#[test]
fn admission_policy_declines_unwanted_authors() {
    let mut a = Peer::new(SEED_A);
    a.author_claims(1.0, ptrs("e", "c", "from A"));
    let mut b = Peer::new(SEED_B);
    b.admission = Some(
        parse_pred(&json!({
            "not": { "match": { "field": "author", "cmp": "eq", "const": a.author } }
        }))
        .unwrap(),
    );
    let report = b.pull_from(&a);
    assert_eq!(report.rejected, 1);
    assert_eq!(b.reactor.len(), 0);
    assert_eq!(a.reactor.len(), 1); // rejection is local; A unaffected
}

#[test]
fn partition_and_heal_through_a_relay() {
    let mut a = Peer::new(SEED_A);
    let mut b = Peer::new(SEED_B);
    let mut relay = Peer::new(SEED_C);
    a.author_claims(1.0, ptrs("ea", "c", "alpha"));
    b.author_claims(2.0, ptrs("eb", "c", "beta"));
    sync_both(&mut a, &mut relay);
    sync_both(&mut b, &mut relay);
    sync_both(&mut a, &mut relay);
    assert_eq!(a.reactor.digest(), relay.reactor.digest());
    assert_eq!(a.reactor.len(), 2);
    assert_eq!(b.reactor.len(), 2);
}
