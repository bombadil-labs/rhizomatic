//! Shared closed inventory bytes and invalid evidence cases.

use rhizomatic::delta::compute_id;
use rhizomatic::imported_holdings::{
    decode_imported_holdings, encode_imported_holdings, imported_holdings_digest, ImportedHoldings,
};
use rhizomatic::reactor::make_manifest_claims;
use rhizomatic::refusal_snapshot::{CurrentRefusal, QualifiedRefusalEvent, RefusalSnapshot};
use rhizomatic::sign::{author_for_seed, sign_claims};
use rhizomatic::types::{Claims, Delta, Pointer, Primitive, Target};
use serde_json::Value;

fn claims(label: &str, timestamp: f64, valid_from: f64, author: &str) -> Claims {
    Claims {
        timestamp,
        valid_from,
        valid_until: None,
        author: author.into(),
        pointers: vec![Pointer {
            role: "note".into(),
            target: Target::Primitive(Primitive::Str(label.into())),
        }],
    }
}

fn fixture() -> (
    Delta,
    Delta,
    Delta,
    RefusalSnapshot,
    RefusalSnapshot,
    RefusalSnapshot,
) {
    let seed = "01".repeat(32);
    let author = author_for_seed(&seed).unwrap();
    let signed = sign_claims(&claims("signed", 1.0, 100.0, &author), &seed).unwrap();
    let unsigned_claims = claims("unsigned", 2.0, 2.0, &author);
    let unsigned = Delta {
        id: compute_id(&unsigned_claims).unwrap(),
        claims: unsigned_claims,
        sig: None,
    };
    let cover = sign_claims(
        &make_manifest_claims(&author, 3.0, std::slice::from_ref(&unsigned.id), None, None),
        &seed,
    )
    .unwrap();
    let empty = RefusalSnapshot {
        events: vec![],
        current: vec![],
    };
    let refused = RefusalSnapshot {
        events: vec![QualifiedRefusalEvent {
            source_peer_id: "peer-old".into(),
            sequence: 1,
            target_id: signed.id.clone(),
            order_ids: vec![format!("1e20{}", "c".repeat(64))],
            prior_epoch: None,
        }],
        current: vec![CurrentRefusal {
            source_peer_id: "peer-old".into(),
            sequence: 1,
            target_id: signed.id.clone(),
        }],
    };
    let refused_cover = RefusalSnapshot {
        events: vec![QualifiedRefusalEvent {
            source_peer_id: "peer-old".into(),
            sequence: 1,
            target_id: cover.id.clone(),
            order_ids: vec![format!("1e20{}", "c".repeat(64))],
            prior_epoch: None,
        }],
        current: vec![CurrentRefusal {
            source_peer_id: "peer-old".into(),
            sequence: 1,
            target_id: cover.id.clone(),
        }],
    };
    (signed, unsigned, cover, empty, refused, refused_cover)
}

fn vector() -> Value {
    let path = format!(
        "{}/../../vectors/peer/imported-holdings.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn shared_images_and_digests_match() {
    let vector = vector();
    let (signed, unsigned, cover, empty, refused, _) = fixture();
    for case in vector["cases"].as_array().unwrap() {
        let imported = ImportedHoldings {
            holdings: case["holdings"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| match name.as_str().unwrap() {
                    "signed" => signed.clone(),
                    "unsigned" => unsigned.clone(),
                    "manifest" => cover.clone(),
                    other => panic!("unknown holding {other}"),
                })
                .collect(),
            covers: if case["cover"] == true {
                vec![cover.clone()]
            } else {
                vec![]
            },
        };
        let image = encode_imported_holdings(&empty, &imported).unwrap();
        assert_eq!(hex::encode(&image), case["expectedHex"], "{}", case["name"]);
        assert_eq!(
            imported_holdings_digest(&empty, &imported).unwrap(),
            case["digest"]
        );
        let reopened = decode_imported_holdings(&image, &empty).unwrap();
        assert_eq!(encode_imported_holdings(&empty, &reopened).unwrap(), image);
        let mut reversed = imported;
        reversed.holdings.reverse();
        assert_eq!(encode_imported_holdings(&empty, &reversed).unwrap(), image);
        assert!(decode_imported_holdings(&image, &refused).is_err());
        let mut damaged = image;
        *damaged.last_mut().unwrap() ^= 1;
        assert!(decode_imported_holdings(&damaged, &empty).is_err());
    }
}

#[test]
fn invalid_inventory_or_evidence_fails() {
    let vector = vector();
    let (signed, unsigned, cover, empty, refused, refused_cover) = fixture();
    for case in vector["invalidCases"].as_array().unwrap() {
        let mut imported = ImportedHoldings {
            holdings: vec![signed.clone()],
            covers: vec![],
        };
        let snapshot = match case["mutation"].as_str() {
            Some("refused-holding") => &refused,
            Some("refused-cover") => &refused_cover,
            _ => &empty,
        };
        match case["mutation"].as_str().unwrap() {
            "duplicate-holding" => imported.holdings.push(signed.clone()),
            "forged-signature" => imported.holdings[0].sig = Some("00".repeat(64)),
            "forged-id" => imported.holdings[0].id = format!("1e20{}", "0".repeat(64)),
            "unsigned-uncovered" => imported.holdings = vec![unsigned.clone()],
            "forged-cover" => {
                imported.holdings = vec![unsigned.clone()];
                let mut forged = cover.clone();
                forged.sig = Some("00".repeat(64));
                imported.covers = vec![forged];
            }
            "wrong-cover-author" => {
                imported.holdings = vec![unsigned.clone()];
                let other_seed = "02".repeat(32);
                imported.covers = vec![sign_claims(
                    &make_manifest_claims(
                        &author_for_seed(&other_seed).unwrap(),
                        3.0,
                        std::slice::from_ref(&unsigned.id),
                        None,
                        None,
                    ),
                    &other_seed,
                )
                .unwrap()];
            }
            "refused-holding" => {}
            "refused-cover" => {
                imported.holdings = vec![unsigned.clone()];
                imported.covers = vec![cover.clone()];
            }
            "orphan-cover" => imported.covers = vec![cover.clone()],
            "duplicate-cover-evidence" => {
                imported.holdings = vec![cover.clone(), unsigned.clone()];
                imported.covers = vec![cover.clone()];
            }
            other => panic!("unknown mutation {other}"),
        }
        let error = encode_imported_holdings(snapshot, &imported).unwrap_err();
        assert!(
            error.contains(case["expected"].as_str().unwrap()),
            "{}: {error}",
            case["name"]
        );
    }
}
