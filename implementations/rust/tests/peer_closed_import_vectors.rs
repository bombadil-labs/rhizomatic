//! Shared v4 closed import bytes, two digests, and one-shot staging.

use rhizomatic::closed_import::{
    closed_import_carried_digest, closed_import_policy_digest, decode_closed_import_state,
    encode_closed_import_state, read_closed_import_state, stage_closed_import_state,
    ClosedImportState,
};
use rhizomatic::delta::compute_id;
use rhizomatic::durable_state::{decode_durable_peer_state, DurablePeerState};
use rhizomatic::imported_holdings::ImportedHoldings;
use rhizomatic::imported_obligations::{ImportedObligation, ImportedObligationCarry};
use rhizomatic::inherited_state::ClosedPeerState;
use rhizomatic::peer_state::PeerStateWriteOutcome;
use rhizomatic::reactor::make_manifest_claims;
use rhizomatic::refusal_snapshot::{
    decode_refusal_snapshot, encode_refusal_snapshot, QualifiedEventRef, RefusalSnapshot,
};
use rhizomatic::sign::{author_for_seed, sign_claims};
use rhizomatic::types::{Claims, Delta, Pointer, Primitive, Target};
use serde_json::Value;

fn read(name: &str) -> Value {
    let path = format!("{}/../../vectors/peer/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn local(index: usize, durable: &Value) -> DurablePeerState {
    let bytes = hex::decode(durable["cases"][index]["expectedHex"].as_str().unwrap()).unwrap();
    let mut state = decode_durable_peer_state(&bytes, "peer-A").unwrap();
    state.base.peer_id = "peer-new".into();
    state
}

fn snapshot(index: usize, refusals: &Value) -> RefusalSnapshot {
    let bytes = hex::decode(refusals["cases"][index]["expectedHex"].as_str().unwrap()).unwrap();
    decode_refusal_snapshot(&bytes).unwrap()
}

fn reference(value: &Value) -> QualifiedEventRef {
    QualifiedEventRef {
        source_peer_id: value["sourcePeerId"].as_str().unwrap().into(),
        sequence: value["sequence"].as_u64().unwrap(),
    }
}

fn obligations(index: Option<usize>, vectors: &Value) -> ImportedObligationCarry {
    ImportedObligationCarry {
        obligations: index.map_or_else(Vec::new, |index| {
            vectors["cases"][index]["obligations"]
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
                    prior_epoch: row.get("priorEpoch").map(reference),
                    status: row["status"].as_str().unwrap().into(),
                    fault: row["fault"].as_str().map(str::to_string),
                })
                .collect()
        }),
    }
}

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

fn holding_fixture() -> (Delta, Delta, Delta) {
    let seed = "01".repeat(32);
    let author = author_for_seed(&seed).unwrap();
    let signed = sign_claims(&claims("signed", 1.0, 100.0, &author), &seed).unwrap();
    let unsigned_claims = claims("unsigned", 2.0, 2.0, &author);
    let unsigned = Delta {
        id: compute_id(&unsigned_claims).unwrap(),
        claims: unsigned_claims,
        sig: None,
    };
    let manifest = sign_claims(
        &make_manifest_claims(&author, 3.0, std::slice::from_ref(&unsigned.id), None, None),
        &seed,
    )
    .unwrap();
    (signed, unsigned, manifest)
}

fn from_case(
    case: &Value,
    durable: &Value,
    refusals: &Value,
    carry_vectors: &Value,
) -> ClosedImportState {
    let (signed, unsigned, manifest) = holding_fixture();
    let holdings = case["holdings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| match name.as_str().unwrap() {
            "signed" => signed.clone(),
            "unsigned" => unsigned.clone(),
            "manifest" => manifest.clone(),
            other => panic!("unknown holding {other}"),
        })
        .collect();
    ClosedImportState {
        attempt_id: "attempt-1".into(),
        old_peer_id: "peer-A".into(),
        old_state_version: 9,
        deadline: 5000.0,
        closed: ClosedPeerState {
            local: local(0, durable),
            inherited: snapshot(case["snapshotCase"].as_u64().unwrap() as usize, refusals),
        },
        obligations: obligations(
            case["obligationCase"].as_u64().map(|n| n as usize),
            carry_vectors,
        ),
        holdings: ImportedHoldings {
            holdings,
            covers: if case["cover"] == true {
                vec![manifest]
            } else {
                vec![]
            },
        },
        policy_format: "rhizomatic.peer.policy.test.v1".into(),
        policy_bytes: b"host-law:peer-A".to_vec(),
    }
}

#[test]
fn shared_images_and_two_digests_survive_reopen() {
    let vector = read("closed-import.json");
    let durable = read("durable-state.json");
    let refusals = read("refusal-snapshot.json");
    let carries = read("imported-obligations.json");
    for case in vector["cases"].as_array().unwrap() {
        let state = from_case(case, &durable, &refusals, &carries);
        let image = encode_closed_import_state(&state).unwrap();
        assert_eq!(hex::encode(&image), case["expectedHex"], "{}", case["name"]);
        assert_eq!(
            closed_import_carried_digest(&state).unwrap(),
            case["carriedDigest"]
        );
        assert_eq!(
            closed_import_policy_digest(&state).unwrap(),
            case["policyDigest"]
        );
        let reopened = decode_closed_import_state(&image, "peer-new").unwrap();
        assert_eq!(encode_closed_import_state(&reopened).unwrap(), image);
        assert_eq!(reopened.closed.inherited, state.closed.inherited);
        assert_eq!(reopened.obligations, state.obligations);
        assert!(decode_closed_import_state(&image, "wrong-peer").is_err());
        let mut damaged = image;
        *damaged.last_mut().unwrap() ^= 1;
        assert!(decode_closed_import_state(&damaged, "peer-new").is_err());
    }
}

#[test]
fn invalid_components_fail_before_staging() {
    let vector = read("closed-import.json");
    let durable = read("durable-state.json");
    let refusals = read("refusal-snapshot.json");
    let carries = read("imported-obligations.json");
    for invalid in vector["invalidCases"].as_array().unwrap() {
        let base = &vector["cases"][invalid["baseCase"].as_u64().unwrap() as usize];
        let mut state = from_case(base, &durable, &refusals, &carries);
        match invalid["mutation"].as_str().unwrap() {
            "nonempty-local" => state.closed.local = local(1, &durable),
            "same-peer" => state.old_peer_id = "peer-new".into(),
            "missing-policy" => state.policy_bytes.clear(),
            "unsafe-version" => state.old_state_version = 1_u64 << 53,
            "stale-obligation" => state.obligations.obligations[0].event.sequence = 3,
            other => panic!("unknown mutation {other}"),
        }
        let error = encode_closed_import_state(&state).unwrap_err();
        assert!(
            error.contains(invalid["expected"].as_str().unwrap()),
            "{}: {error}",
            invalid["name"]
        );
    }
}

#[test]
fn stage_verifies_recovery_and_never_replaces_primary() {
    let vector = read("closed-import.json");
    let durable = read("durable-state.json");
    let refusals = read("refusal-snapshot.json");
    let carries = read("imported-obligations.json");
    for case in vector["stageCases"].as_array().unwrap() {
        let fixture = &vector["cases"][case["case"].as_u64().unwrap() as usize];
        let state = from_case(fixture, &durable, &refusals, &carries);
        let dir = tempfile::tempdir().unwrap();
        let primary = dir.path().join("primary");
        let recovery = dir.path().join("recovery");
        match case["backup"].as_str().unwrap() {
            "valid" => std::fs::write(
                &recovery,
                encode_refusal_snapshot(&state.closed.inherited).unwrap(),
            )
            .unwrap(),
            "corrupt" => std::fs::write(&recovery, [0]).unwrap(),
            "other-valid" => std::fs::write(
                &recovery,
                encode_refusal_snapshot(&RefusalSnapshot {
                    events: vec![],
                    current: vec![],
                })
                .unwrap(),
            )
            .unwrap(),
            "missing" => {}
            other => panic!("unknown backup {other}"),
        }
        let recovery_path = if case["samePath"] == true {
            &primary
        } else {
            &recovery
        };
        let result = stage_closed_import_state(&primary, recovery_path, &state);
        if case["expected"] == "durable" {
            assert_eq!(result.unwrap(), PeerStateWriteOutcome::Durable);
            assert_eq!(
                hex::encode(std::fs::read(&primary).unwrap()),
                fixture["expectedHex"]
            );
            assert_eq!(
                read_closed_import_state(&primary, "peer-new")
                    .unwrap()
                    .unwrap()
                    .attempt_id,
                "attempt-1"
            );
            assert!(stage_closed_import_state(&primary, &recovery, &state)
                .unwrap_err()
                .contains("stage already exists"));
        } else {
            let error = result.unwrap_err();
            if case["expected"] != "error" {
                assert!(
                    error.contains(case["expected"].as_str().unwrap()),
                    "{}: {error}",
                    case["name"]
                );
            }
            assert!(!primary.exists(), "{}", case["name"]);
        }
    }
}
