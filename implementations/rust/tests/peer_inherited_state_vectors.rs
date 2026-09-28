//! Shared closed imported-refusal bytes, restart, and second-handoff continuity.

use rhizomatic::durable_state::{decode_durable_peer_state, DurablePeerState};
use rhizomatic::hash::content_address;
use rhizomatic::inherited_state::{
    complete_refusal_snapshot, decode_closed_peer_state, encode_closed_peer_state,
    read_closed_peer_state, stage_closed_peer_state, ClosedPeerState,
};
use rhizomatic::peer_state::PeerStateWriteOutcome;
use rhizomatic::refusal_snapshot::{
    decode_refusal_snapshot, encode_refusal_snapshot, local_refusal_snapshot, RefusalSnapshot,
};
use serde_json::Value;

fn read(name: &str) -> Value {
    let path = format!("{}/../../vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn local(case: usize, peer_id: &str, durable: &Value) -> DurablePeerState {
    let bytes = hex::decode(durable["cases"][case]["expectedHex"].as_str().unwrap()).unwrap();
    let mut state = decode_durable_peer_state(&bytes, "peer-A").unwrap();
    state.base.peer_id = peer_id.into();
    for row in &mut state.base.arrivals {
        row.at = 999.0 + row.transfer as f64;
        row.sender = if row.transfer == 1 { "peer-A" } else { peer_id }.into();
    }
    state
}

fn from_case(case: &Value, durable: &Value, refusal: &Value) -> ClosedPeerState {
    let inherited: RefusalSnapshot = if let Some(index) = case["inheritedCase"].as_u64() {
        let bytes = hex::decode(
            refusal["cases"][index as usize]["expectedHex"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        decode_refusal_snapshot(&bytes).unwrap()
    } else {
        let index = case["inheritedDurableCase"].as_u64().unwrap() as usize;
        local_refusal_snapshot(&local(index, "peer-A", durable)).unwrap()
    };
    ClosedPeerState {
        local: local(
            case["localCase"].as_u64().unwrap() as usize,
            case["newPeerId"].as_str().unwrap(),
            durable,
        ),
        inherited,
    }
}

#[test]
fn shared_images_and_second_handoff_preserve_all_sources() {
    let vector = read("peer/inherited-state.json");
    let durable = read("peer/durable-state.json");
    let refusal = read("peer/refusal-snapshot.json");
    for case in vector["cases"].as_array().unwrap() {
        let state = from_case(case, &durable, &refusal);
        let image = encode_closed_peer_state(&state).unwrap();
        let expected_image = hex::decode(case["expectedHex"].as_str().unwrap()).unwrap();
        let expected_state =
            decode_closed_peer_state(&expected_image, case["newPeerId"].as_str().unwrap()).unwrap();
        assert_eq!(
            state.local.base.arrivals, expected_state.local.base.arrivals,
            "{}",
            case["name"]
        );
        assert_eq!(hex::encode(&image), case["expectedHex"], "{}", case["name"]);
        let full = complete_refusal_snapshot(&state).unwrap();
        assert_eq!(
            content_address(&encode_refusal_snapshot(&full).unwrap()),
            case["fullDigest"],
            "{}",
            case["name"]
        );
        let restored =
            decode_closed_peer_state(&image, case["newPeerId"].as_str().unwrap()).unwrap();
        assert_eq!(encode_closed_peer_state(&restored).unwrap(), image);
        assert_eq!(restored.inherited, state.inherited);
        assert!(decode_closed_peer_state(&image, "wrong-peer").is_err());
        if let Some(second_digest) = case["secondHopDigest"].as_str() {
            let second = ClosedPeerState {
                local: local(0, "peer-final", &durable),
                inherited: complete_refusal_snapshot(&restored).unwrap(),
            };
            let reopened =
                decode_closed_peer_state(&encode_closed_peer_state(&second).unwrap(), "peer-final")
                    .unwrap();
            assert_eq!(
                content_address(
                    &encode_refusal_snapshot(&complete_refusal_snapshot(&reopened).unwrap())
                        .unwrap()
                ),
                second_digest
            );
            assert_eq!(
                reopened.inherited.events.len(),
                state.inherited.events.len() + state.local.events.len()
            );
        }
    }
}

#[test]
fn invalid_closed_images_and_recovery_staging_fail_before_write() {
    let vector = read("peer/inherited-state.json");
    let durable = read("peer/durable-state.json");
    let refusal = read("peer/refusal-snapshot.json");
    for case in vector["invalidCases"].as_array().unwrap() {
        let error = encode_closed_peer_state(&from_case(case, &durable, &refusal)).unwrap_err();
        assert!(
            error.contains(case["expected"].as_str().unwrap()),
            "{}: {error}",
            case["name"]
        );
    }
    for stage in vector["stageCases"].as_array().unwrap() {
        let case = &vector["cases"][stage["case"].as_u64().unwrap() as usize];
        let state = from_case(case, &durable, &refusal);
        let dir = tempfile::tempdir().unwrap();
        let primary = dir.path().join("primary");
        let backup = dir.path().join("backup");
        match stage["backup"].as_str().unwrap() {
            "missing" => {}
            "corrupt" => std::fs::write(&backup, [0]).unwrap(),
            "valid" => {
                std::fs::write(&backup, encode_refusal_snapshot(&state.inherited).unwrap()).unwrap()
            }
            other => panic!("unknown backup kind {other}"),
        }
        let recovery_path = if stage["samePath"].as_bool().unwrap_or(false) {
            &primary
        } else {
            &backup
        };
        let result = stage_closed_peer_state(&primary, recovery_path, &state);
        if stage["expected"] == "durable" {
            assert_eq!(result.unwrap(), PeerStateWriteOutcome::Durable);
            assert_eq!(
                hex::encode(std::fs::read(&primary).unwrap()),
                case["expectedHex"]
            );
            assert_eq!(
                read_closed_peer_state(&primary, "peer-new")
                    .unwrap()
                    .unwrap()
                    .inherited,
                state.inherited
            );
            assert!(stage_closed_peer_state(&primary, &backup, &state)
                .unwrap_err()
                .contains("stage already exists"));
        } else {
            let error = result.unwrap_err();
            if stage["expected"] != "error" {
                assert!(
                    error.contains(stage["expected"].as_str().unwrap()),
                    "{}: {error}",
                    stage["name"]
                );
            }
            assert!(!primary.exists(), "{}", stage["name"]);
        }
    }
}
