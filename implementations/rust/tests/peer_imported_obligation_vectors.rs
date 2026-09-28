//! Shared source-qualified active purge debt bytes and validation.

use rhizomatic::imported_obligations::{
    decode_imported_obligations, encode_imported_obligations, imported_obligations_digest,
    ImportedObligation, ImportedObligationCarry,
};
use rhizomatic::refusal_snapshot::{decode_refusal_snapshot, QualifiedEventRef, RefusalSnapshot};
use serde_json::Value;

fn read(name: &str) -> Value {
    let path = format!("{}/../../vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn snapshot(index: usize, snapshots: &Value) -> RefusalSnapshot {
    let bytes = hex::decode(snapshots["cases"][index]["expectedHex"].as_str().unwrap()).unwrap();
    decode_refusal_snapshot(&bytes).unwrap()
}

fn reference(value: &Value) -> QualifiedEventRef {
    QualifiedEventRef {
        source_peer_id: value["sourcePeerId"].as_str().unwrap().into(),
        sequence: value["sequence"].as_u64().unwrap(),
    }
}

fn carry(case: &Value) -> ImportedObligationCarry {
    ImportedObligationCarry {
        obligations: case["obligations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| ImportedObligation {
                source_peer_id: row["sourcePeerId"].as_str().unwrap().into(),
                sequence: row["sequence"].as_u64().unwrap(),
                target_id: row["targetId"].as_str().unwrap().into(),
                surface_id: row["surfaceId"].as_str().unwrap().into(),
                generation: row["generation"].as_u64().unwrap(),
                event: reference(&row["event"]),
                prior_epoch: if row.get("priorEpoch").is_some() {
                    Some(reference(&row["priorEpoch"]))
                } else {
                    None
                },
                status: row["status"].as_str().unwrap().into(),
                fault: row["fault"].as_str().map(str::to_string),
            })
            .collect(),
    }
}

#[test]
fn shared_bytes_and_digests_match() {
    let vector = read("peer/imported-obligations.json");
    let snapshots = read("peer/refusal-snapshot.json");
    for case in vector["cases"].as_array().unwrap() {
        let refusal = snapshot(case["snapshotCase"].as_u64().unwrap() as usize, &snapshots);
        let carry = carry(case);
        let image = encode_imported_obligations(&refusal, &carry).unwrap();
        assert_eq!(hex::encode(&image), case["expectedHex"], "{}", case["name"]);
        assert_eq!(
            imported_obligations_digest(&refusal, &carry).unwrap(),
            case["digest"],
            "{}",
            case["name"]
        );
        let restored = decode_imported_obligations(&image, &refusal).unwrap();
        assert_eq!(
            encode_imported_obligations(&refusal, &restored).unwrap(),
            image
        );
        let mut reordered = carry;
        reordered.obligations.reverse();
        assert_eq!(
            encode_imported_obligations(&refusal, &reordered).unwrap(),
            image
        );
        let mut damaged = image.clone();
        *damaged.last_mut().unwrap() ^= 1;
        assert!(decode_imported_obligations(&damaged, &refusal).is_err());
        if case["snapshotCase"].as_u64().unwrap() != 0 {
            assert!(decode_imported_obligations(&image, &snapshot(0, &snapshots)).is_err());
        }
    }
}

#[test]
fn shared_invalid_obligations_fail() {
    let vector = read("peer/imported-obligations.json");
    let snapshots = read("peer/refusal-snapshot.json");
    for invalid in vector["invalidCases"].as_array().unwrap() {
        let base = &vector["cases"][invalid["baseCase"].as_u64().unwrap() as usize];
        let refusal = snapshot(base["snapshotCase"].as_u64().unwrap() as usize, &snapshots);
        let mut carry = carry(base);
        match invalid["mutation"].as_str().unwrap() {
            "duplicate-identity" => {
                let mut duplicate = carry.obligations[0].clone();
                duplicate.surface_id = "another-surface".into();
                carry.obligations.push(duplicate);
            }
            "unrefused-target" => {
                carry.obligations[0].target_id = format!("1e20{}", "c".repeat(64))
            }
            "stale-event" => carry.obligations[0].event.sequence = 3,
            "outdated-event" => {
                carry.obligations[0].event.source_peer_id = "peer-A".into();
                carry.obligations[0].event.sequence = 1;
            }
            "duplicate-target-surface" => {
                let mut duplicate = carry.obligations[0].clone();
                duplicate.sequence += 1;
                carry.obligations.push(duplicate);
            }
            "wrong-prior-epoch" => {
                carry.obligations[0].prior_epoch = Some(QualifiedEventRef {
                    source_peer_id: "peer-A".into(),
                    sequence: 99,
                })
            }
            "orphan-prior-source" => {
                carry.obligations[0].prior_epoch = Some(QualifiedEventRef {
                    source_peer_id: "peer-Z".into(),
                    sequence: 7,
                })
            }
            "prior-epoch-without-event" => {
                carry.obligations[0].prior_epoch = Some(QualifiedEventRef {
                    source_peer_id: "peer-A".into(),
                    sequence: 1,
                });
            }
            "zero-generation" => carry.obligations[0].generation = 0,
            "missing-fault" => carry.obligations[0].fault = None,
            "pending-fault" => carry.obligations[0].fault = Some("unexpected".into()),
            other => panic!("unknown mutation {other}"),
        }
        assert!(
            encode_imported_obligations(&refusal, &carry)
                .unwrap_err()
                .contains("invalid active obligation"),
            "{}",
            invalid["name"]
        );
    }
}
