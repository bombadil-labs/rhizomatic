//! Shared canonical peer-state images and host restart behavior (SPEC-6 §§2–3).

use std::collections::{BTreeMap, BTreeSet};

use rhizomatic::arrival::{ArrivalCursor, ArrivalRecord};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::peer_state::{
    decode_peer_state, encode_peer_state, read_peer_state, write_peer_state, PeerState,
    PeerStateWriteOutcome,
};
use rhizomatic::{Delta, DeltaSet};
use serde_json::Value;

fn fixtures() -> (Value, BTreeMap<String, Delta>) {
    let root = format!("{}/../../vectors", env!("CARGO_MANIFEST_DIR"));
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{root}/principal/evidence.json")).unwrap(),
    )
    .unwrap();
    let vector: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{root}/peer/state.json")).unwrap())
            .unwrap();
    let named = fixture["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["name"].as_str().unwrap().to_string(),
                Delta {
                    id: row["id"].as_str().unwrap().to_string(),
                    claims: parse_claims(&row["claims"]).unwrap(),
                    sig: row["sig"].as_str().map(str::to_string),
                },
            )
        })
        .collect();
    (vector, named)
}

#[test]
fn malformed_image_bytes_match_shared_vectors() {
    let path = format!(
        "{}/../../vectors/peer/state-invalid.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let vector: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in vector["cases"].as_array().unwrap() {
        let bytes = hex::decode(case["hex"].as_str().unwrap()).unwrap();
        let error =
            decode_peer_state(&bytes, case["expectedPeerId"].as_str().unwrap()).unwrap_err();
        assert!(
            error.contains(case["error"].as_str().unwrap()),
            "{}: {error}",
            case["name"]
        );
    }
}

fn from_case(case: &Value, named: &BTreeMap<String, Delta>) -> PeerState {
    let id = |name: &Value| named[name.as_str().unwrap()].id.clone();
    PeerState {
        peer_id: case["peerId"].as_str().unwrap().to_string(),
        admitted: DeltaSet::from_deltas(
            case["admitted"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| named[name.as_str().unwrap()].clone()),
        )
        .unwrap(),
        cursor: ArrivalCursor {
            last_sequence: case["cursor"]["lastSequence"].as_u64().unwrap(),
            last_transfer: case["cursor"]["lastTransfer"].as_u64().unwrap(),
        },
        arrivals: case["arrivals"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| ArrivalRecord {
                id: id(&row["id"]),
                at: row["at"].as_f64().unwrap(),
                sequence: row["sequence"].as_u64().unwrap(),
                transfer: row["transfer"].as_u64().unwrap(),
                sender: row["sender"].as_str().unwrap().to_string(),
            })
            .collect(),
        refused_ids: case["refused"]
            .as_array()
            .unwrap()
            .iter()
            .map(id)
            .collect::<BTreeSet<_>>(),
    }
}

#[test]
fn canonical_images_match_shared_vectors() {
    let (vector, named) = fixtures();
    for case in vector["cases"].as_array().unwrap() {
        let state = from_case(case, &named);
        let bytes = encode_peer_state(&state).unwrap();
        assert_eq!(hex::encode(&bytes), case["expectedHex"].as_str().unwrap());
        let restored = decode_peer_state(&bytes, &state.peer_id).unwrap();
        assert_eq!(restored, state);
        assert!(decode_peer_state(&bytes, "another-peer")
            .unwrap_err()
            .contains("wrong peer id"));
    }
}

#[test]
fn huge_malformed_container_lengths_fail_before_loading_peer_state() {
    let path = format!(
        "{}/../../vectors/l0-delta/cbor-invalid-length.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
        let bytes = hex::decode(case["hex"].as_str().unwrap()).unwrap();
        assert_eq!(
            decode_peer_state(&bytes, "peer-A").unwrap_err(),
            case["error"].as_str().unwrap()
        );
    }
}

#[test]
fn excessive_nesting_fails_before_loading_peer_state() {
    let path = format!(
        "{}/../../vectors/l0-delta/cbor-nesting.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
        if case["expected"] == "valid" {
            continue;
        }
        let hex = format!(
            "{}{}",
            case["prefixHex"]
                .as_str()
                .unwrap()
                .repeat(case["repeat"].as_u64().unwrap() as usize),
            case["suffixHex"].as_str().unwrap()
        );
        assert_eq!(
            decode_peer_state(&hex::decode(hex).unwrap(), "peer-A").unwrap_err(),
            case["expected"].as_str().unwrap()
        );
    }
}

#[test]
fn invalid_state_cases_match_shared_vectors() {
    let (vector, named) = fixtures();
    for case in vector["invalidCases"].as_array().unwrap() {
        let mut state = from_case(
            &vector["cases"][case["base"].as_u64().unwrap() as usize],
            &named,
        );
        match case["mutation"].as_str().unwrap() {
            "cursorGap" => state.cursor.last_sequence = 1,
            "refuseActive" => {
                state.refused_ids = state
                    .admitted
                    .ids()
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            }
            "duplicateSequence" => state.arrivals[1].sequence = 1,
            "forgedSignature" => {
                let mut delta = state.admitted.iter().next().unwrap().clone();
                delta.sig = Some("00".repeat(64));
                state.admitted = DeltaSet::from_deltas([delta]).unwrap();
            }
            "junkArrivalId" => state.arrivals[0].id = "x".into(),
            "junkRefusedId" => {
                state.refused_ids.insert("x".into());
            }
            "repeatedEpoch" => state.arrivals[1].id = state.arrivals[0].id.clone(),
            "lostHoldingAndRefusal" => state.refused_ids.clear(),
            other => panic!("unknown mutation {other}"),
        }
        let error = encode_peer_state(&state).unwrap_err();
        assert!(
            error.contains(case["expected"].as_str().unwrap()),
            "{}: {error}",
            case["name"]
        );
    }
}

#[test]
fn file_replacement_restores_complete_state_and_failed_validation_preserves_old_image() {
    let (vector, named) = fixtures();
    let dir = std::env::temp_dir().join(format!(
        "rhizomatic-peer-state-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("peer.bin");
    {
        assert!(read_peer_state(&path, "peer-A").unwrap().is_none());
        for case in vector["cases"].as_array().unwrap() {
            let state = from_case(case, &named);
            assert_eq!(
                write_peer_state(&path, &state).unwrap(),
                PeerStateWriteOutcome::Durable
            );
            assert_eq!(
                hex::encode(std::fs::read(&path).unwrap()),
                case["expectedHex"]
            );
            assert_eq!(read_peer_state(&path, "peer-A").unwrap().unwrap(), state);
            if case["name"] == "first admission" {
                let before_signature_change = std::fs::read(&path).unwrap();
                let mut changed = from_case(case, &named);
                let mut delta = changed.admitted.iter().next().unwrap().clone();
                delta.sig = None;
                changed.admitted = DeltaSet::from_deltas([delta]).unwrap();
                assert!(write_peer_state(&path, &changed)
                    .unwrap_err()
                    .contains("admitted signature changed"));
                assert_eq!(std::fs::read(&path).unwrap(), before_signature_change);
            }
        }
        let before = std::fs::read(&path).unwrap();
        let mut invalid = from_case(&vector["cases"][2], &named);
        invalid.cursor.last_sequence = 1;
        assert!(write_peer_state(&path, &invalid).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(write_peer_state(&path, &from_case(&vector["cases"][1], &named)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let mut removed_refusal = from_case(&vector["cases"][2], &named);
        removed_refusal.refused_ids.clear();
        removed_refusal
            .admitted
            .add(named["userRootDeclaration"].clone())
            .unwrap();
        assert!(write_peer_state(&path, &removed_refusal)
            .unwrap_err()
            .contains("permanent refusal cannot be removed"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let mut wrong_peer = from_case(&vector["cases"][2], &named);
        wrong_peer.peer_id = "other-peer".into();
        assert!(write_peer_state(&path, &wrong_peer).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::write(&path, [0xff]).unwrap();
        assert!(read_peer_state(&path, "peer-A").is_err());
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn stale_file_from_old_pid_scheme_does_not_block_or_get_deleted() {
    let (vector, named) = fixtures();
    let dir = std::env::temp_dir().join(format!(
        "rhizomatic-stale-peer-state-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("peer.bin");
    let stale = path.with_extension(format!("{}.0.tmp", std::process::id()));
    std::fs::write(&stale, b"left by a crashed writer").unwrap();
    let state = from_case(&vector["cases"][0], &named);
    assert_eq!(
        write_peer_state(&path, &state).unwrap(),
        PeerStateWriteOutcome::Durable
    );
    assert_eq!(std::fs::read(&stale).unwrap(), b"left by a crashed writer");
    assert_eq!(read_peer_state(&path, "peer-A").unwrap().unwrap(), state);
    std::fs::remove_dir_all(dir).unwrap();
}
