//! Shared source-qualified refusal image bytes, validation, and recovery copy.

use std::collections::BTreeSet;

use rhizomatic::durable_state::decode_durable_peer_state;
use rhizomatic::hash::content_address;
use rhizomatic::refusal_snapshot::{
    decode_refusal_snapshot, encode_refusal_snapshot, local_refusal_snapshot,
    recover_refusal_snapshot, refusal_snapshot_digest, verify_refusal_snapshot_copy,
    CurrentRefusal, QualifiedRefusalEvent, RefusalSnapshot,
};
use serde_json::Value;

fn vectors() -> Value {
    let path = format!(
        "{}/../../vectors/peer/refusal-snapshot.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn from_case(case: &Value) -> RefusalSnapshot {
    RefusalSnapshot {
        events: case["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| QualifiedRefusalEvent {
                source_peer_id: row["sourcePeerId"].as_str().unwrap().into(),
                sequence: row["sequence"].as_u64().unwrap(),
                target_id: row["targetId"].as_str().unwrap().into(),
                order_ids: row["orderIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap().into())
                    .collect(),
                prior_epoch: row["priorEpoch"].as_u64(),
            })
            .collect(),
        current: case["current"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| CurrentRefusal {
                source_peer_id: row["sourcePeerId"].as_str().unwrap().into(),
                sequence: row["sequence"].as_u64().unwrap(),
                target_id: row["targetId"].as_str().unwrap().into(),
            })
            .collect(),
    }
}

#[test]
fn shared_canonical_bytes_and_digests() {
    for case in vectors()["cases"].as_array().unwrap() {
        let snapshot = from_case(case);
        let bytes = encode_refusal_snapshot(&snapshot).unwrap();
        assert_eq!(hex::encode(&bytes), case["expectedHex"], "{}", case["name"]);
        assert_eq!(
            refusal_snapshot_digest(&snapshot).unwrap(),
            case["digest"],
            "{}",
            case["name"]
        );
        let decoded = decode_refusal_snapshot(&bytes).unwrap();
        assert_eq!(encode_refusal_snapshot(&decoded).unwrap(), bytes);
        let mut reordered = snapshot;
        reordered.events.reverse();
        reordered.current.reverse();
        assert_eq!(encode_refusal_snapshot(&reordered).unwrap(), bytes);
    }
}

#[test]
fn shared_invalid_cases_and_verified_recovery() {
    let vectors = vectors();
    for case in vectors["invalidCases"].as_array().unwrap() {
        let mut snapshot =
            from_case(&vectors["cases"][case["baseCase"].as_u64().unwrap() as usize]);
        match case["mutation"].as_str().unwrap() {
            "drop-current" => {
                snapshot.current.remove(0);
            }
            "wrong-source" => snapshot.current[0].source_peer_id = "another-peer".into(),
            "duplicate-source-sequence" => snapshot.events.push(snapshot.events[0].clone()),
            "duplicate-order" => {
                snapshot.events[1].order_ids = snapshot.events[0].order_ids.clone()
            }
            "zero-epoch" => snapshot.events[0].prior_epoch = Some(0),
            "stale-current-same-source" => snapshot.current[0].sequence = 3,
            "target-is-order" => {
                let target_id = snapshot.events[0].order_ids[0].clone();
                snapshot.events.push(QualifiedRefusalEvent {
                    source_peer_id: "peer-C".into(),
                    sequence: 1,
                    target_id: target_id.clone(),
                    order_ids: vec![format!("1e20{}", "f".repeat(64))],
                    prior_epoch: None,
                });
                snapshot.current.push(CurrentRefusal {
                    source_peer_id: "peer-C".into(),
                    sequence: 1,
                    target_id,
                });
            }
            "conflicting-prior-epoch" => snapshot.events[1].prior_epoch = Some(8),
            "order-reused-different-target" => {
                snapshot.events[2].order_ids = snapshot.events[0].order_ids.clone()
            }
            other => panic!("unknown mutation {other}"),
        }
        assert!(
            encode_refusal_snapshot(&snapshot).is_err(),
            "{}",
            case["name"]
        );
    }

    for case in vectors["recoveryCases"].as_array().unwrap() {
        let source = case["sourceCase"].as_u64().unwrap() as usize;
        let digest_case = case["digestCase"].as_u64().unwrap() as usize;
        let bytes = hex::decode(vectors["cases"][source]["expectedHex"].as_str().unwrap()).unwrap();
        let digest = vectors["cases"][digest_case]["digest"].as_str().unwrap();
        let mut damaged = bytes.clone();
        *damaged.last_mut().unwrap() ^= 1;
        let copy = |kind: &str| match kind {
            "valid" => Some(bytes.as_slice()),
            "corrupt" => Some(damaged.as_slice()),
            "missing" => None,
            other => panic!("unknown copy kind {other}"),
        };
        let result = recover_refusal_snapshot(
            digest,
            copy(case["primary"].as_str().unwrap()),
            copy(case["recovery"].as_str().unwrap()),
        );
        if case["usedRecovery"].is_null() {
            assert!(result.is_err(), "{}", case["name"]);
        } else {
            let restored = result.unwrap();
            assert_eq!(
                restored.used_recovery,
                case["usedRecovery"].as_bool().unwrap()
            );
            assert_eq!(restored.bytes, bytes);
            assert_eq!(
                restored.snapshot.current,
                decode_refusal_snapshot(&bytes).unwrap().current
            );
            assert_eq!(
                verify_refusal_snapshot_copy(&content_address(&bytes), &bytes).unwrap(),
                restored.snapshot
            );
        }
    }

    let mut malformed = hex::decode(vectors["cases"][2]["expectedHex"].as_str().unwrap()).unwrap();
    malformed[0] = 0;
    assert!(
        recover_refusal_snapshot(&content_address(&malformed), Some(&malformed), None).is_err()
    );
}

#[test]
fn local_durable_refusals_produce_a_complete_snapshot() {
    let path = format!(
        "{}/../../vectors/peer/durable-state.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let durable: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for index in [2, 4] {
        let bytes = hex::decode(durable["cases"][index]["expectedHex"].as_str().unwrap()).unwrap();
        let state = decode_durable_peer_state(&bytes, "peer-A").unwrap();
        let snapshot = local_refusal_snapshot(&state).unwrap();
        let targets: BTreeSet<String> = snapshot
            .current
            .iter()
            .map(|row| row.target_id.clone())
            .collect();
        assert_eq!(targets, state.base.refused_ids);
        assert_eq!(snapshot.events.len(), state.events.len());
        decode_refusal_snapshot(&encode_refusal_snapshot(&snapshot).unwrap()).unwrap();
    }
}
