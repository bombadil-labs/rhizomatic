//! Shared SPEC-6 vNext erasure authority filter vectors.

use std::collections::{BTreeMap, BTreeSet};

use rhizomatic::erasure_filter::{plan_erasure_filter, ErasureOrderCandidate};
use serde_json::Value;

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn erasure_filter_matches_shared_vectors_in_both_wire_orders() {
    let path = format!(
        "{}/../../vectors/peer/erasure-filter.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let vector: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in vector["cases"].as_array().unwrap() {
        let rules: BTreeMap<String, String> = case["orders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| {
                (
                    o["id"].as_str().unwrap().into(),
                    o["rule"].as_str().unwrap().into(),
                )
            })
            .collect();
        let authorize = |order: &ErasureOrderCandidate, visible: &BTreeSet<String>| {
            let rule = &rules[&order.id];
            if rule == "always" {
                true
            } else if rule == "own-target" {
                visible.contains(&order.target_id)
            } else if let Some(id) = rule.strip_prefix("requires:") {
                visible.contains(id)
            } else if let Some(pair) = rule.strip_prefix("same-presence:") {
                let (a, b) = pair.split_once(':').unwrap();
                visible.contains(a) == visible.contains(b)
            } else {
                panic!("unknown test rule {rule}")
            }
        };
        let orders: Vec<ErasureOrderCandidate> = case["orders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| ErasureOrderCandidate {
                id: o["id"].as_str().unwrap().into(),
                target_id: o["target"].as_str().unwrap().into(),
            })
            .collect();
        let prior: BTreeSet<String> = strings(&case["prior"]).into_iter().collect();
        for input in [orders.clone(), orders.into_iter().rev().collect()] {
            let result = plan_erasure_filter(
                &input,
                &prior,
                case["budget"].as_u64().unwrap() as usize,
                &authorize,
            )
            .unwrap();
            assert_eq!(
                result.effective_order_ids,
                strings(&case["effective"]),
                "{}",
                case["name"]
            );
            assert_eq!(
                result.ineligible_order_ids,
                strings(&case["ineligible"]),
                "{}",
                case["name"]
            );
            assert_eq!(
                result.limited_order_ids,
                strings(&case["limited"]),
                "{}",
                case["name"]
            );
            assert_eq!(
                result.selected_targets,
                strings(&case["selectedTargets"]),
                "{}",
                case["name"]
            );
        }
    }
}
