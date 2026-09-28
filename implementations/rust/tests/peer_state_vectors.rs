//! Shared canonical peer-state images and host restart behavior (SPEC-6 §§2–3).

use std::collections::{BTreeMap, BTreeSet};

use rhizomatic::arrival::{ArrivalCursor, ArrivalRecord};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::peer_state::{
    decode_peer_state, encode_peer_state, read_peer_state, write_peer_state, PeerState,
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
            write_peer_state(&path, &state).unwrap();
            assert_eq!(
                hex::encode(std::fs::read(&path).unwrap()),
                case["expectedHex"]
            );
            assert_eq!(read_peer_state(&path, "peer-A").unwrap().unwrap(), state);
        }
        let before = std::fs::read(&path).unwrap();
        let mut invalid = from_case(&vector["cases"][2], &named);
        invalid.cursor.last_sequence = 1;
        assert!(write_peer_state(&path, &invalid).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::write(&path, [0xff]).unwrap();
        assert!(read_peer_state(&path, "peer-A").is_err());
    }
    std::fs::remove_dir_all(dir).unwrap();
}
