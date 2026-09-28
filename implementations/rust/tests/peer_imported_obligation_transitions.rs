//! Shared active purge carry succession across a later peer.

use rhizomatic::imported_obligations::{
    validate_imported_obligation_transition, ImportedObligation, ImportedObligationCarry,
};
use rhizomatic::refusal_snapshot::{
    decode_refusal_snapshot, QualifiedEventRef, QualifiedRefusalEvent, RefusalSnapshot,
};
use serde_json::Value;

fn read(name: &str) -> Value {
    let path = format!("{}/../../vectors/peer/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn snapshot(index: usize, vector: &Value) -> RefusalSnapshot {
    let bytes = hex::decode(vector["cases"][index]["expectedHex"].as_str().unwrap()).unwrap();
    decode_refusal_snapshot(&bytes).unwrap()
}

fn reference(value: &Value) -> QualifiedEventRef {
    QualifiedEventRef {
        source_peer_id: value["sourcePeerId"].as_str().unwrap().into(),
        sequence: value["sequence"].as_u64().unwrap(),
    }
}

fn obligation(value: &Value) -> ImportedObligation {
    ImportedObligation {
        source_peer_id: value["sourcePeerId"].as_str().unwrap().into(),
        sequence: value["sequence"].as_u64().unwrap(),
        target_id: value["targetId"].as_str().unwrap().into(),
        surface_id: value["surfaceId"].as_str().unwrap().into(),
        generation: value["generation"].as_u64().unwrap(),
        event: reference(&value["event"]),
        prior_epoch: value.get("priorEpoch").map(reference),
        status: value["status"].as_str().unwrap().into(),
        fault: value["fault"].as_str().map(str::to_string),
    }
}

fn successor(
    mutation: &str,
    original: &ImportedObligation,
    mut after_snapshot: RefusalSnapshot,
) -> (RefusalSnapshot, ImportedObligationCarry) {
    let mut advanced = original.clone();
    advanced.event = QualifiedEventRef {
        source_peer_id: "peer-B".into(),
        sequence: 3,
    };
    let new_local = ImportedObligation {
        source_peer_id: "peer-B".into(),
        sequence: 1,
        target_id: format!("1e20{}", "b".repeat(64)),
        surface_id: "pool-z".into(),
        generation: 1,
        event: QualifiedEventRef {
            source_peer_id: "peer-ancestor".into(),
            sequence: 5,
        },
        prior_epoch: Some(QualifiedEventRef {
            source_peer_id: "peer-ancestor".into(),
            sequence: 3,
        }),
        status: "pending".into(),
        fault: None,
    };
    let obligations = match mutation {
        "retry-failed" => {
            let mut retry = original.clone();
            retry.status = "failed".into();
            retry.fault = Some("retryable-io".into());
            vec![retry]
        }
        "advance-event" => vec![advanced],
        "add-local" => vec![advanced, new_local],
        "drop-active" => vec![],
        "renumber" => {
            let mut row = original.clone();
            row.sequence = 2;
            vec![row]
        }
        "surface-drift" => {
            let mut row = original.clone();
            row.surface_id = "pool-y".into();
            vec![row]
        }
        "generation-drift" => {
            let mut row = original.clone();
            row.generation = 5;
            vec![row]
        }
        "epoch-drift" => {
            let mut row = original.clone();
            row.prior_epoch = None;
            vec![row]
        }
        "foreign-obligation" => {
            let mut foreign = new_local;
            foreign.source_peer_id = "peer-Z".into();
            vec![advanced, foreign]
        }
        "changed-prior-event" => {
            after_snapshot
                .events
                .iter_mut()
                .find(|event| event.source_peer_id == "peer-A" && event.sequence == 3)
                .unwrap()
                .order_ids = vec![format!("1e20{}", "f".repeat(64))];
            vec![advanced]
        }
        "foreign-event" => {
            after_snapshot.events.push(QualifiedRefusalEvent {
                source_peer_id: "peer-Z".into(),
                sequence: 1,
                target_id: original.target_id.clone(),
                order_ids: vec![format!("1e20{}", "f".repeat(64))],
                prior_epoch: None,
            });
            vec![advanced]
        }
        "stale-current-event" => vec![original.clone()],
        "local-event-not-current" => {
            after_snapshot
                .current
                .iter_mut()
                .find(|row| row.target_id == original.target_id)
                .unwrap()
                .source_peer_id = "peer-A".into();
            after_snapshot
                .current
                .iter_mut()
                .find(|row| row.target_id == original.target_id)
                .unwrap()
                .sequence = 5;
            vec![original.clone()]
        }
        other => panic!("unknown mutation {other}"),
    };
    (after_snapshot, ImportedObligationCarry { obligations })
}

#[test]
fn shared_active_carry_transitions() {
    let vector = read("imported-obligation-transitions.json");
    let snapshots = read("refusal-snapshot.json");
    let carries = read("imported-obligations.json");
    let before_snapshot = snapshot(
        vector["beforeSnapshotCase"].as_u64().unwrap() as usize,
        &snapshots,
    );
    let original = obligation(
        &carries["cases"][vector["beforeCarryCase"].as_u64().unwrap() as usize]["obligations"][0],
    );
    let before = ImportedObligationCarry {
        obligations: vec![original.clone()],
    };
    for case in vector["cases"].as_array().unwrap() {
        let (after_snapshot, after) = successor(
            case["mutation"].as_str().unwrap(),
            &original,
            snapshot(
                case["afterSnapshotCase"].as_u64().unwrap() as usize,
                &snapshots,
            ),
        );
        validate_imported_obligation_transition(
            &before_snapshot,
            &before,
            &after_snapshot,
            &after,
            "peer-B",
        )
        .unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
    }
    for case in vector["invalidCases"].as_array().unwrap() {
        let previous_index = case["beforeCarryCase"]
            .as_u64()
            .unwrap_or(vector["beforeCarryCase"].as_u64().unwrap())
            as usize;
        let previous = ImportedObligationCarry {
            obligations: carries["cases"][previous_index]["obligations"]
                .as_array()
                .unwrap()
                .iter()
                .map(obligation)
                .collect(),
        };
        let after_snapshot = snapshot(
            case["afterSnapshotCase"].as_u64().unwrap() as usize,
            &snapshots,
        );
        let (after_snapshot, after) = if case["mutation"] == "identity-reuse" {
            (after_snapshot, previous.clone())
        } else {
            successor(
                case["mutation"].as_str().unwrap(),
                &original,
                after_snapshot,
            )
        };
        let error = validate_imported_obligation_transition(
            &before_snapshot,
            &previous,
            &after_snapshot,
            &after,
            case["interveningPeerId"].as_str().unwrap_or("peer-B"),
        )
        .unwrap_err();
        assert!(
            error.contains(case["expected"].as_str().unwrap()),
            "{}: {error}",
            case["name"]
        );
    }
}
