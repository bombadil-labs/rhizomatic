//! Shared SPEC-6 vNext ordinary quota vectors.

use std::collections::BTreeSet;

use rhizomatic::ordinary_quota::{ordinary_unit_key, plan_ordinary_quota, OrdinaryQuotaUnit};
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
fn ordinary_quota_matches_shared_vectors_in_both_wire_orders() {
    let path = format!(
        "{}/../../vectors/peer/ordinary-quota.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let vector: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in vector["keyCases"].as_array().unwrap() {
        let members = case.get("members").map(strings);
        let result =
            ordinary_unit_key(case["deltaId"].as_str().unwrap(), members.as_deref()).unwrap();
        assert_eq!(
            result,
            case["expected"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        if let Some(mut reversed) = members {
            reversed.reverse();
            assert_eq!(
                ordinary_unit_key(case["deltaId"].as_str().unwrap(), Some(&reversed)).unwrap(),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
    for case in vector["cases"].as_array().unwrap() {
        let units: Vec<OrdinaryQuotaUnit> = case["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| OrdinaryQuotaUnit {
                key: u["key"].as_str().unwrap().into(),
                rank: u["rank"].as_str().unwrap().into(),
                fresh_ids: strings(&u["fresh"]),
                requires: strings(&u["requires"]),
            })
            .collect();
        let existing: BTreeSet<String> = strings(&case["existing"]).into_iter().collect();
        let excluded: BTreeSet<String> = strings(&case["excluded"]).into_iter().collect();
        let fixed: BTreeSet<String> = case
            .get("fixed")
            .map(strings)
            .unwrap_or_default()
            .into_iter()
            .collect();
        for order in [units.clone(), units.into_iter().rev().collect()] {
            let result = plan_ordinary_quota(
                &order,
                &existing,
                &excluded,
                &fixed,
                case["capacity"].as_u64().unwrap() as usize,
            )
            .unwrap();
            assert_eq!(
                result.selected_keys,
                strings(&case["selected"]),
                "{}",
                case["name"]
            );
            assert_eq!(
                result.skipped_keys,
                strings(&case["skipped"]),
                "{}",
                case["name"]
            );
            assert_eq!(
                result.pruned_keys,
                strings(&case["pruned"]),
                "{}",
                case["name"]
            );
            assert_eq!(
                result.admitted_ids,
                strings(&case["admitted"]),
                "{}",
                case["name"]
            );
            assert_eq!(
                result.charged,
                case["charged"].as_u64().unwrap() as usize,
                "{}",
                case["name"]
            );
        }
    }
}
