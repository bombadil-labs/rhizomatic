//! Shared permanent-posture durable peer image bytes and restart behavior (SPEC-6 §2 step 6).

use std::collections::{BTreeMap, BTreeSet};

use rhizomatic::arrival::{plan_arrivals, ArrivalCursor, ArrivalRecord};
use rhizomatic::durable_state::{
    decode_durable_peer_state, encode_durable_peer_state, plan_permanent_commit,
    read_durable_peer_state, write_durable_peer_state, DurablePeerState, ErasureExclusion,
    PermanentCommitInput, PermanentErasure, PurgeObligation, RefusalEvent,
};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::peer_state::{PeerState, PeerStateWriteOutcome};
use rhizomatic::{Delta, DeltaSet};
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
                row["name"].as_str().unwrap().to_string(),
                Delta {
                    id: row["id"].as_str().unwrap().to_string(),
                    claims: parse_claims(&row["claims"]).unwrap(),
                    sig: row["sig"].as_str().map(str::to_string),
                },
            )
        })
        .collect()
}

fn base_from_case(case: &Value, named: &BTreeMap<String, Delta>) -> PeerState {
    let id = |value: &Value| named[value.as_str().unwrap()].id.clone();
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
        refused_ids: case["refused"].as_array().unwrap().iter().map(id).collect(),
    }
}

fn from_case(case: &Value, bases: &Value, named: &BTreeMap<String, Delta>) -> DurablePeerState {
    let id = |value: &Value| named[value.as_str().unwrap()].id.clone();
    let mut base = base_from_case(
        &bases["cases"][case["baseCase"].as_u64().unwrap() as usize],
        named,
    );
    let extras: Vec<Delta> = case["extraAdmitted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| named[name.as_str().unwrap()].clone())
        .collect();
    if !extras.is_empty() {
        let active: BTreeSet<String> = base.admitted.iter().map(|d| d.id.clone()).collect();
        let accepted: Vec<String> = extras.iter().map(|d| d.id.clone()).collect();
        let planned = plan_arrivals(
            base.cursor,
            &active,
            &accepted,
            case["extraArrivalAt"].as_f64().unwrap(),
            case["extraSender"].as_str().unwrap(),
        )
        .unwrap();
        base.admitted = DeltaSet::from_deltas(base.admitted.iter().cloned().chain(extras)).unwrap();
        base.cursor = ArrivalCursor {
            last_sequence: planned.last_sequence,
            last_transfer: planned.last_transfer,
        };
        base.arrivals.extend(planned.arrivals);
    }
    if let Some(refused) = case["extraRefused"].as_array() {
        base.refused_ids.extend(refused.iter().map(&id));
    }
    DurablePeerState {
        base,
        refusal_counter: case["refusalCounter"].as_u64().unwrap(),
        obligation_counter: case["obligationCounter"].as_u64().unwrap(),
        quota_used: case["quotaUsed"].as_u64().unwrap(),
        events: case["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                let mut order_ids: Vec<String> =
                    row["orders"].as_array().unwrap().iter().map(&id).collect();
                order_ids.sort();
                RefusalEvent {
                    sequence: row["sequence"].as_u64().unwrap(),
                    target_id: id(&row["target"]),
                    order_ids,
                    prior_epoch: row["priorEpoch"].as_u64(),
                }
            })
            .collect(),
        exclusions: case["exclusions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| ErasureExclusion {
                order_id: id(&row["order"]),
                target_id: id(&row["target"]),
                event_sequence: row["event"].as_u64().unwrap(),
                prior_epoch: row["priorEpoch"].as_u64(),
            })
            .collect(),
        obligations: case["obligations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| PurgeObligation {
                sequence: row["sequence"].as_u64().unwrap(),
                target_id: id(&row["target"]),
                generation: row["generation"].as_u64().unwrap(),
                event_sequence: row["event"].as_u64().unwrap(),
                prior_epoch: row["priorEpoch"].as_u64(),
                status: row["status"].as_str().unwrap().into(),
                fault: row["fault"].as_str().map(str::to_string),
            })
            .collect(),
    }
}

fn commit_input(case: &Value, named: &BTreeMap<String, Delta>) -> PermanentCommitInput {
    let id = |value: &Value| named[value.as_str().unwrap()].id.clone();
    PermanentCommitInput {
        additions: case["additions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| named[name.as_str().unwrap()].clone())
            .collect(),
        erasures: case["erasures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|group| PermanentErasure {
                target_id: id(&group["target"]),
                order_ids: group["orders"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(&id)
                    .collect(),
                surface_holds_bytes: group["surfaceHoldsBytes"].as_bool().unwrap(),
            })
            .collect(),
        quota_charge: case["quotaCharge"].as_u64().unwrap(),
        at: case["at"].as_f64().unwrap(),
        sender: case["sender"].as_str().unwrap().into(),
    }
}

#[test]
fn permanent_commit_transitions_match_shared_images() {
    let vector = read("peer/durable-state.json");
    let commits = read("peer/permanent-commit.json");
    let bases = read("peer/state.json");
    let named = fixtures();
    for case in commits["cases"].as_array().unwrap() {
        let before = from_case(
            &vector["cases"][case["beforeCase"].as_u64().unwrap() as usize],
            &bases,
            &named,
        );
        let input = commit_input(case, &named);
        let after = plan_permanent_commit(&before, &input).unwrap();
        assert_eq!(
            hex::encode(encode_durable_peer_state(&after).unwrap()),
            vector["cases"][case["afterCase"].as_u64().unwrap() as usize]["expectedHex"]
                .as_str()
                .unwrap(),
            "{}",
            case["name"]
        );
        let mut reversed = input;
        reversed.additions.reverse();
        reversed.erasures.reverse();
        assert_eq!(
            encode_durable_peer_state(&after).unwrap(),
            encode_durable_peer_state(&plan_permanent_commit(&before, &reversed).unwrap()).unwrap()
        );
    }
    for case in commits["invalidCases"].as_array().unwrap() {
        let before = from_case(
            &vector["cases"][case["beforeCase"].as_u64().unwrap() as usize],
            &bases,
            &named,
        );
        let err = plan_permanent_commit(&before, &commit_input(case, &named)).unwrap_err();
        assert!(err.contains(case["expected"].as_str().unwrap()), "{err}");
    }
}

#[test]
fn canonical_durable_images_match_both_witnesses() {
    let vector = read("peer/durable-state.json");
    let bases = read("peer/state.json");
    let named = fixtures();
    for case in vector["cases"].as_array().unwrap() {
        let state = from_case(case, &bases, &named);
        let bytes = encode_durable_peer_state(&state).unwrap();
        assert_eq!(
            hex::encode(&bytes),
            case["expectedHex"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        let restored = decode_durable_peer_state(&bytes, &state.base.peer_id).unwrap();
        assert_eq!(encode_durable_peer_state(&restored).unwrap(), bytes);
        assert_eq!(restored.base, state.base);
        assert_eq!(restored.events, state.events);
        assert_eq!(restored.obligations, state.obligations);
        let mut exclusions = state.exclusions;
        exclusions.sort_by(|a, b| a.order_id.cmp(&b.order_id));
        assert_eq!(restored.exclusions, exclusions);
        assert!(decode_durable_peer_state(&bytes, "another-peer")
            .unwrap_err()
            .contains("wrong peer id"));
    }
}

#[test]
fn invalid_erasure_ledger_cannot_encode() {
    let vector = read("peer/durable-state.json");
    let bases = read("peer/state.json");
    let named = fixtures();
    let mut state = from_case(&vector["cases"][2], &bases, &named);
    state.obligation_counter = 0;
    state.obligations.clear();
    assert!(encode_durable_peer_state(&state)
        .unwrap_err()
        .contains("held refusal lacks purge obligation"));
    let mut state = from_case(&vector["cases"][2], &bases, &named);
    state.events[0].prior_epoch = Some(2);
    assert!(encode_durable_peer_state(&state)
        .unwrap_err()
        .contains("wrong admission epoch"));
    let mut state = from_case(&vector["cases"][2], &bases, &named);
    state.exclusions.clear();
    assert!(encode_durable_peer_state(&state)
        .unwrap_err()
        .contains("lacks exclusion"));
}

#[test]
fn single_writer_replaces_entire_image_and_reopens_it() {
    let vector = read("peer/durable-state.json");
    let bases = read("peer/state.json");
    let named = fixtures();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("peer.bin");
    assert!(read_durable_peer_state(&path, "peer-A").unwrap().is_none());
    let mut expected: Option<Vec<u8>> = None;
    for case in vector["cases"].as_array().unwrap().iter().take(4) {
        let state = from_case(case, &bases, &named);
        assert_eq!(
            write_durable_peer_state(&path, &state, expected.as_deref()).unwrap(),
            PeerStateWriteOutcome::Durable
        );
        assert_eq!(
            hex::encode(std::fs::read(&path).unwrap()),
            case["expectedHex"].as_str().unwrap()
        );
        expected = Some(std::fs::read(&path).unwrap());
        assert_eq!(
            read_durable_peer_state(&path, "peer-A")
                .unwrap()
                .unwrap()
                .refusal_counter,
            case["refusalCounter"].as_u64().unwrap()
        );
    }
    let before = std::fs::read(&path).unwrap();
    let mut rollback = from_case(&vector["cases"][3], &bases, &named);
    rollback.quota_used = 0;
    assert!(write_durable_peer_state(&path, &rollback, Some(&before))
        .unwrap_err()
        .contains("quota counter cannot shrink"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(write_durable_peer_state(
        &path,
        &from_case(&vector["cases"][2], &bases, &named),
        Some(&before)
    )
    .unwrap_err()
    .contains("arrival history cannot shrink"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::write(&path, [0xff]).unwrap();
    assert!(read_durable_peer_state(&path, "peer-A").is_err());
    assert!(write_durable_peer_state(&path, &rollback, Some(&before)).is_err());
}

#[test]
fn failed_purge_fault_survives_restart() {
    let vector = read("peer/durable-state.json");
    let bases = read("peer/state.json");
    let named = fixtures();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("peer.bin");
    write_durable_peer_state(&path, &from_case(&vector["cases"][2], &bases, &named), None).unwrap();
    let expected = std::fs::read(&path).unwrap();
    write_durable_peer_state(
        &path,
        &from_case(&vector["cases"][5], &bases, &named),
        Some(&expected),
    )
    .unwrap();
    let restored = read_durable_peer_state(&path, "peer-A").unwrap().unwrap();
    assert_eq!(restored.obligations[0].status, "failed");
    assert_eq!(
        restored.obligations[0].fault.as_deref(),
        Some("disk offline")
    );
    assert!(restored
        .base
        .refused_ids
        .contains(&named["userRootDeclaration"].id));
    assert_eq!(
        hex::encode(std::fs::read(path).unwrap()),
        vector["cases"][5]["expectedHex"].as_str().unwrap()
    );
}

#[test]
fn durable_writer_transitions_match_shared_vectors() {
    let vector = read("peer/durable-state.json");
    let writer = read("peer/durable-writer.json");
    let bases = read("peer/state.json");
    let named = fixtures();
    for case in writer["cases"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("peer.bin");
        let actual_index = case["actualCase"]
            .as_u64()
            .or(case["beforeCase"].as_u64())
            .unwrap() as usize;
        let actual = from_case(&vector["cases"][actual_index], &bases, &named);
        write_durable_peer_state(&path, &actual, None).unwrap();
        let on_disk = std::fs::read(&path).unwrap();
        if case["outcome"] == "durable" {
            let after = from_case(
                &vector["cases"][case["afterCase"].as_u64().unwrap() as usize],
                &bases,
                &named,
            );
            assert_eq!(
                write_durable_peer_state(&path, &after, Some(&on_disk)).unwrap(),
                PeerStateWriteOutcome::Durable
            );
            assert_eq!(
                hex::encode(std::fs::read(&path).unwrap()),
                case["afterCase"]
                    .as_u64()
                    .map(|i| vector["cases"][i as usize]["expectedHex"].as_str().unwrap())
                    .unwrap()
            );
            continue;
        }
        let mut proposed = if let Some(index) = case["proposedCase"].as_u64() {
            from_case(&vector["cases"][index as usize], &bases, &named)
        } else {
            actual.clone()
        };
        match case["mutation"].as_str() {
            Some("quotaJump") => proposed.quota_used = 5000,
            Some("heldOrderErasesUserRoot") => {
                let target_id = named["userRootDeclaration"].id.clone();
                let order_id = named["operatorRootDeclaration"].id.clone();
                proposed.base.admitted = DeltaSet::from_deltas(
                    actual
                        .base
                        .admitted
                        .iter()
                        .filter(|d| d.id != target_id)
                        .cloned(),
                )
                .unwrap();
                proposed.base.refused_ids.insert(target_id.clone());
                proposed.refusal_counter = 1;
                proposed.obligation_counter = 1;
                proposed.events = vec![RefusalEvent {
                    sequence: 1,
                    target_id: target_id.clone(),
                    order_ids: vec![order_id.clone()],
                    prior_epoch: Some(1),
                }];
                proposed.exclusions = vec![ErasureExclusion {
                    order_id,
                    target_id: target_id.clone(),
                    event_sequence: 1,
                    prior_epoch: Some(1),
                }];
                proposed.obligations = vec![PurgeObligation {
                    sequence: 1,
                    target_id,
                    generation: 1,
                    event_sequence: 1,
                    prior_epoch: Some(1),
                    status: "pending".into(),
                    fault: None,
                }];
            }
            _ => {}
        }
        let expected_bytes = case["expectedCase"].as_u64().map(|index| {
            encode_durable_peer_state(&from_case(&vector["cases"][index as usize], &bases, &named))
                .unwrap()
        });
        let expected_prior = if case["expectedCase"].as_u64().is_some() {
            expected_bytes.as_deref()
        } else if case["actualCase"] == 0 && case["beforeCase"].is_null() {
            None
        } else {
            Some(on_disk.as_slice())
        };
        let error = write_durable_peer_state(&path, &proposed, expected_prior).unwrap_err();
        assert!(
            error.contains(case["expected"].as_str().unwrap()),
            "{}: {error}",
            case["name"]
        );
        assert_eq!(std::fs::read(path).unwrap(), on_disk);
    }
}
