//! Shared ordinary-only signed loose admission outcomes and durable bytes.

use std::collections::{BTreeMap, BTreeSet};

use rhizomatic::durable_state::{
    decode_durable_peer_state, encode_durable_peer_state, write_durable_peer_state,
};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::preflight::{CandidateGuard, GuardDecision};
use rhizomatic::signed_loose_admission::{
    admit_signed_loose_ordinary_transfer, plan_signed_loose_ordinary_transfer,
    SignedLooseTransferInput,
};
use rhizomatic::Delta;
use serde_json::Value;

fn read(name: &str) -> Value {
    let path = format!("{}/../../vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn fixtures() -> BTreeMap<String, Delta> {
    read("principal/evidence.json")["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["name"].as_str().unwrap().into(),
                Delta {
                    id: row["id"].as_str().unwrap().into(),
                    claims: parse_claims(&row["claims"]).unwrap(),
                    sig: row["sig"].as_str().map(str::to_string),
                },
            )
        })
        .collect()
}

fn bytes(images: &Value, index: usize) -> Vec<u8> {
    hex::decode(images["cases"][index]["expectedHex"].as_str().unwrap()).unwrap()
}

#[test]
fn ordinary_admission_matches_shared_outcomes_and_image_bytes() {
    let cases = read("peer/signed-loose-admission.json");
    let images = read("peer/durable-state.json");
    let named = fixtures();
    for case in cases["cases"].as_array().unwrap() {
        let before = decode_durable_peer_state(
            &bytes(&images, case["beforeCase"].as_u64().unwrap() as usize),
            "peer-A",
        )
        .unwrap();
        let mut offered: Vec<Delta> = case["offered"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| named[name.as_str().unwrap()].clone())
            .collect();
        let corrupt: BTreeSet<String> = case["corruptSignature"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|name| named[name.as_str().unwrap()].id.clone())
            .collect();
        for delta in &mut offered {
            if corrupt.contains(&delta.id) {
                delta.sig = Some("00".into());
            }
        }
        let rejected: BTreeSet<String> = case["guardReject"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|name| named[name.as_str().unwrap()].id.clone())
            .collect();
        let erasure: BTreeSet<String> = case["erasure"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|name| named[name.as_str().unwrap()].id.clone())
            .collect();
        let first_only: BTreeSet<String> = case["erasureFirstOnly"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|name| named[name.as_str().unwrap()].id.clone())
            .collect();
        let guard = |candidate: &Delta,
                     _: &str,
                     _: &str,
                     _: &rhizomatic::DeltaSet,
                     _: f64,
                     rejected: &BTreeSet<String>| {
            if rejected.contains(&candidate.id) {
                GuardDecision::Reject {
                    reason: String::new(),
                }
            } else {
                GuardDecision::Allow
            }
        };
        let guards: [&CandidateGuard<BTreeSet<String>>; 1] = [&guard];
        let seen = std::cell::RefCell::new(BTreeSet::new());
        let classifier = |candidate: &Delta| {
            if first_only.contains(&candidate.id) {
                seen.borrow_mut().insert(candidate.id.clone())
            } else {
                erasure.contains(&candidate.id)
            }
        };
        let input = SignedLooseTransferInput {
            offered: &offered,
            sending_peer_id: case["sender"].as_str().unwrap(),
            arrived_at: case["at"].as_f64().unwrap(),
            capacity: case["capacity"].as_u64().unwrap() as usize,
            policy_state: &rejected,
            guards: &guards,
            is_erasure_candidate: &classifier,
        };
        let plan = plan_signed_loose_ordinary_transfer(&before, &input).unwrap();
        let actual: Vec<&str> = plan.outcomes.iter().map(|o| o.status.as_str()).collect();
        let expected: Vec<&str> = case["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(actual, expected, "{}", case["name"]);
        assert_eq!(
            hex::encode(encode_durable_peer_state(&plan.state).unwrap()),
            images["cases"][case["afterCase"].as_u64().unwrap() as usize]["expectedHex"]
                .as_str()
                .unwrap(),
            "{}",
            case["name"]
        );
        let reversed_offered: Vec<Delta> = offered.iter().cloned().rev().collect();
        let reverse_seen = std::cell::RefCell::new(BTreeSet::new());
        let reverse_classifier = |candidate: &Delta| {
            if first_only.contains(&candidate.id) {
                reverse_seen.borrow_mut().insert(candidate.id.clone())
            } else {
                erasure.contains(&candidate.id)
            }
        };
        let reverse = SignedLooseTransferInput {
            offered: &reversed_offered,
            is_erasure_candidate: &reverse_classifier,
            ..input
        };
        let reversed = plan_signed_loose_ordinary_transfer(&before, &reverse).unwrap();
        assert_eq!(
            encode_durable_peer_state(&reversed.state).unwrap(),
            encode_durable_peer_state(&plan.state).unwrap()
        );
    }
}

#[test]
fn ordinary_admission_commits_against_its_planning_image() {
    let cases = read("peer/signed-loose-admission.json");
    let images = read("peer/durable-state.json");
    let named = fixtures();
    let case = &cases["cases"][0];
    let empty = bytes(&images, 0);
    let before = decode_durable_peer_state(&empty, "peer-A").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("peer.bin");
    write_durable_peer_state(&path, &before, None).unwrap();
    let offered = vec![named[case["offered"][0].as_str().unwrap()].clone()];
    let guard = |_: &Delta, _: &str, _: &str, _: &rhizomatic::DeltaSet, _: f64, _: &()| {
        GuardDecision::Allow
    };
    let guards: [&CandidateGuard<()>; 1] = [&guard];
    let classifier = |_: &Delta| false;
    let input = SignedLooseTransferInput {
        offered: &offered,
        sending_peer_id: "peer-B",
        arrived_at: 100.0,
        capacity: 1,
        policy_state: &(),
        guards: &guards,
        is_erasure_candidate: &classifier,
    };
    let (_, write) = admit_signed_loose_ordinary_transfer(&path, &empty, "peer-A", &input).unwrap();
    assert_eq!(
        write,
        rhizomatic::peer_state::PeerStateWriteOutcome::Durable
    );
    assert_eq!(
        hex::encode(std::fs::read(&path).unwrap()),
        images["cases"][1]["expectedHex"].as_str().unwrap()
    );
    assert!(
        admit_signed_loose_ordinary_transfer(&path, &empty, "peer-A", &input)
            .unwrap_err()
            .contains("expected prior image changed")
    );
}
