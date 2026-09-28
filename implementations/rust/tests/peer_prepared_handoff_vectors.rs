//! Shared canonical prepared descriptor and old-peer Ed25519 signature.

use rhizomatic::closed_import::{decode_closed_import_state, ClosedImportState};
use rhizomatic::prepared_handoff::{
    decode_prepared_handoff, encode_prepared_handoff_claim, prepared_descriptor_from_stage,
    sign_prepared_handoff, verify_prepared_matches_stage, PreparedHandoffDescriptor,
};
use rhizomatic::sign::author_for_seed;
use serde_json::Value;

fn read(name: &str) -> Value {
    let path = format!("{}/../../vectors/peer/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn stage(base_case: usize, closed: &Value, vector: &Value) -> ClosedImportState {
    let image = hex::decode(closed["cases"][base_case]["expectedHex"].as_str().unwrap()).unwrap();
    let mut state = decode_closed_import_state(&image, "peer-new").unwrap();
    state.old_peer_id = author_for_seed(vector["oldSeedHex"].as_str().unwrap()).unwrap();
    state.closed.local.base.peer_id =
        author_for_seed(vector["newSeedHex"].as_str().unwrap()).unwrap();
    state
}

fn descriptor(value: &Value) -> PreparedHandoffDescriptor {
    PreparedHandoffDescriptor {
        attempt_id: value["attemptId"].as_str().unwrap().into(),
        surface_id: value["surfaceId"].as_str().unwrap().into(),
        old_peer_id: value["oldPeerId"].as_str().unwrap().into(),
        new_peer_id: value["newPeerId"].as_str().unwrap().into(),
        old_state_version: value["oldStateVersion"].as_u64().unwrap(),
        deadline: value["deadline"].as_f64().unwrap(),
        refusal_digest: value["refusalDigest"].as_str().unwrap().into(),
        carried_digest: value["carriedDigest"].as_str().unwrap().into(),
        policy_digest: value["policyDigest"].as_str().unwrap().into(),
    }
}

fn changed(descriptor: &PreparedHandoffDescriptor, mutation: &str) -> PreparedHandoffDescriptor {
    let mut next = descriptor.clone();
    match mutation {
        "attempt" => next.attempt_id = "different-attempt".into(),
        "surface" => next.surface_id = "other-pool".into(),
        "old-version" => next.old_state_version += 1,
        "deadline" => next.deadline += 1.0,
        "new-peer" => next.new_peer_id = author_for_seed(&"03".repeat(32)).unwrap(),
        "refusal-digest" => next.refusal_digest = descriptor.policy_digest.clone(),
        "carried-digest" => next.carried_digest = descriptor.refusal_digest.clone(),
        "policy-digest" => next.policy_digest = descriptor.carried_digest.clone(),
        "old-peer" => next.old_peer_id = author_for_seed(&"03".repeat(32)).unwrap(),
        other => panic!("unknown mutation {other}"),
    }
    next
}

#[test]
fn prepared_claims_and_signatures_match_shared_bytes() {
    let vector = read("prepared-handoff.json");
    let closed = read("closed-import.json");
    let old_seed = vector["oldSeedHex"].as_str().unwrap();
    for case in vector["cases"].as_array().unwrap() {
        let base_case = case["baseCase"].as_u64().unwrap() as usize;
        let surface = case["surfaceId"].as_str().unwrap();
        let state = stage(base_case, &closed, &vector);
        let actual = prepared_descriptor_from_stage(&state, surface).unwrap();
        assert_eq!(actual, descriptor(&case["descriptor"]), "{}", case["name"]);
        let claim = encode_prepared_handoff_claim(&actual).unwrap();
        assert_eq!(hex::encode(claim), case["expectedClaimHex"]);
        let signed = sign_prepared_handoff(&actual, old_seed).unwrap();
        assert_eq!(hex::encode(&signed), case["expectedSignedHex"]);
        assert_eq!(decode_prepared_handoff(&signed).unwrap(), actual);
        assert_eq!(
            verify_prepared_matches_stage(&signed, &state, surface).unwrap(),
            actual
        );
    }
}

#[test]
fn valid_but_substituted_descriptors_and_invalid_signatures_fail() {
    let vector = read("prepared-handoff.json");
    let closed = read("closed-import.json");
    let base = &vector["cases"][1];
    let surface = base["surfaceId"].as_str().unwrap();
    let state = stage(
        base["baseCase"].as_u64().unwrap() as usize,
        &closed,
        &vector,
    );
    let descriptor = prepared_descriptor_from_stage(&state, surface).unwrap();
    let old_seed = vector["oldSeedHex"].as_str().unwrap();
    for invalid in vector["invalidCases"].as_array().unwrap() {
        let mutation = invalid["mutation"].as_str().unwrap();
        match mutation {
            "wrong-seed" => {
                assert!(
                    sign_prepared_handoff(&descriptor, vector["newSeedHex"].as_str().unwrap())
                        .unwrap_err()
                        .contains("wrong old peer signing key")
                );
            }
            "signature" => {
                let mut image = sign_prepared_handoff(&descriptor, old_seed).unwrap();
                *image.last_mut().unwrap() ^= 1;
                assert!(decode_prepared_handoff(&image)
                    .unwrap_err()
                    .contains("invalid old peer signature"));
            }
            "stage-policy" => {
                let signed = sign_prepared_handoff(&descriptor, old_seed).unwrap();
                let mut altered_stage = state.clone();
                altered_stage.policy_bytes = b"changed-policy".to_vec();
                assert!(
                    verify_prepared_matches_stage(&signed, &altered_stage, surface)
                        .unwrap_err()
                        .contains("descriptor does not match closed stage")
                );
            }
            _ => {
                let altered = changed(&descriptor, mutation);
                let signing_seed = if mutation == "old-peer" {
                    "03".repeat(32)
                } else {
                    old_seed.to_string()
                };
                let signed = sign_prepared_handoff(&altered, &signing_seed).unwrap();
                assert_eq!(decode_prepared_handoff(&signed).unwrap(), altered);
                assert!(verify_prepared_matches_stage(&signed, &state, surface)
                    .unwrap_err()
                    .contains("descriptor does not match closed stage"));
            }
        }
    }
    for invalid in vector["invalidImages"].as_array().unwrap() {
        let image = hex::decode(invalid["expectedHex"].as_str().unwrap()).unwrap();
        let error = decode_prepared_handoff(&image).unwrap_err();
        assert!(
            error.contains(invalid["expected"].as_str().unwrap()),
            "{}: {error}",
            invalid["name"]
        );
    }
}
