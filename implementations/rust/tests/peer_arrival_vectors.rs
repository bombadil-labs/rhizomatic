//! Shared SPEC-6 vNext arrival assignment vectors.

use std::collections::BTreeSet;

use rhizomatic::arrival::{plan_arrivals, ArrivalCursor};
use serde_json::{json, Value};

#[test]
fn receiver_local_arrival_testimony_matches_shared_vectors() {
    let path = format!(
        "{}/../../vectors/peer/arrival.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let vector: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut cursor = ArrivalCursor {
        last_sequence: vector["initial"]["lastSequence"].as_u64().unwrap(),
        last_transfer: vector["initial"]["lastTransfer"].as_u64().unwrap(),
    };
    for step in vector["steps"].as_array().unwrap() {
        let active: BTreeSet<String> = step["active"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let accepted: Vec<String> = step["accepted"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let plan = plan_arrivals(
            cursor,
            &active,
            &accepted,
            step["at"].as_f64().unwrap(),
            step["sender"].as_str().unwrap(),
        )
        .unwrap();
        let actual = json!({
            "lastSequence": plan.last_sequence,
            "lastTransfer": plan.last_transfer,
            "arrivals": plan.arrivals.iter().map(|row| json!({
                "id": row.id,
                "at": row.at,
                "sequence": row.sequence,
                "transfer": row.transfer,
                "sender": row.sender,
            })).collect::<Vec<_>>()
        });
        assert_eq!(actual, step["expected"], "{}", step["name"]);
        cursor = ArrivalCursor {
            last_sequence: plan.last_sequence,
            last_transfer: plan.last_transfer,
        };
    }
}

#[test]
fn exhausted_counter_cannot_repeat_testimony() {
    let result = plan_arrivals(
        ArrivalCursor {
            last_sequence: (1_u64 << 53) - 1,
            last_transfer: 0,
        },
        &BTreeSet::new(),
        &["a".into()],
        1.0,
        "local",
    );
    assert_eq!(result.unwrap_err(), "arrival counter exhausted");
}
