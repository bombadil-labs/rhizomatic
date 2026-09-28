//! Shared SPEC-6 vNext signed-bundle entry vectors.

use std::collections::BTreeSet;

use rhizomatic::delta::compute_id;
use rhizomatic::entry::{bundle_entry_status, LooseEntryStatus};
use rhizomatic::reactor::make_manifest_claims;
use rhizomatic::sign::{author_for_seed, sign_claims};
use rhizomatic::types::{Claims, Delta, Pointer, Primitive, Target};
use serde_json::Value;

fn member(label: &str, author: &str, seed: Option<&str>) -> Delta {
    let claims = Claims {
        timestamp: 1.0,
        valid_from: 1.0,
        valid_until: None,
        author: author.to_string(),
        pointers: vec![Pointer {
            role: "note".into(),
            target: Target::Primitive(Primitive::Str(label.into())),
        }],
    };
    match seed {
        Some(seed) => sign_claims(&claims, seed).unwrap(),
        None => Delta {
            id: compute_id(&claims).unwrap(),
            claims,
            sig: None,
        },
    }
}

#[test]
fn signed_bundle_entry_matches_shared_vectors() {
    let path = format!(
        "{}/../../vectors/peer/bundle-entry.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let vector: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let own_seed = "01".repeat(32);
    let other_seed = "02".repeat(32);
    let own_author = author_for_seed(&own_seed).unwrap();
    for case in vector["cases"].as_array().unwrap() {
        let first = member(
            "first",
            &own_author,
            if case["firstUnsigned"] == true {
                None
            } else {
                Some(&own_seed)
            },
        );
        let second_seed = if case["secondAuthor"] == "other" {
            &other_seed
        } else {
            &own_seed
        };
        let second = member(
            "second",
            &author_for_seed(second_seed).unwrap(),
            if case["secondSigned"] == true {
                Some(second_seed)
            } else {
                None
            },
        );
        let mut manifest = sign_claims(
            &make_manifest_claims(
                &own_author,
                2.0,
                &[first.id.clone(), second.id.clone()],
                None,
                None,
            ),
            &own_seed,
        )
        .unwrap();
        let mut members = vec![first.clone(), second.clone()];
        match case["mutation"].as_str() {
            Some("missingSecond") => members = vec![first.clone()],
            Some("duplicateFirst") => members = vec![first.clone(), first.clone()],
            Some("forgeManifest") => manifest.sig = Some("00".repeat(64)),
            Some("forgeSecondId") => members[1].id = format!("1e20{}", "00".repeat(32)),
            None => {}
            other => panic!("unknown mutation {other:?}"),
        }
        let active: BTreeSet<String> = match case["active"].as_str() {
            Some("all") => [manifest.id.clone(), first.id.clone(), second.id.clone()].into(),
            Some("first") => [first.id.clone()].into(),
            None => BTreeSet::new(),
            other => panic!("unknown active {other:?}"),
        };
        let refused: BTreeSet<String> = if case["refused"] == "second" {
            [second.id].into()
        } else {
            BTreeSet::new()
        };
        let actual = match bundle_entry_status(&manifest, &members, &active, &refused) {
            LooseEntryStatus::Invalid => "invalid",
            LooseEntryStatus::Refused => "refused",
            LooseEntryStatus::Duplicate => "duplicate",
            LooseEntryStatus::Eligible => "eligible",
        };
        assert_eq!(
            actual,
            case["expected"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}
