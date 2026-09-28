//! Shared SPEC-6 vNext candidate-local guard vectors.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use rhizomatic::preflight::{
    preflight_transfer, CandidateGuard, GuardedUnitStatus, PreflightContext, TransferUnit,
};
use rhizomatic::reactor::make_manifest_claims;
use rhizomatic::set::DeltaSet;
use rhizomatic::sign::{author_for_seed, sign_claims};
use rhizomatic::types::{Claims, Delta, Pointer, Primitive, Target};
use serde_json::Value;

fn label_delta(label: &str, author: &str, seed: &str) -> Delta {
    sign_claims(
        &Claims {
            timestamp: 1.0,
            valid_from: 1.0,
            valid_until: None,
            author: author.to_string(),
            pointers: vec![Pointer {
                role: "note".into(),
                target: Target::Primitive(Primitive::Str(label.into())),
            }],
        },
        seed,
    )
    .unwrap()
}

fn status_name(status: GuardedUnitStatus) -> &'static str {
    match status {
        GuardedUnitStatus::Invalid => "invalid",
        GuardedUnitStatus::Refused => "refused",
        GuardedUnitStatus::Duplicate => "duplicate",
        GuardedUnitStatus::GuardRejected => "guard-rejected",
        GuardedUnitStatus::Eligible => "eligible",
    }
}

#[test]
fn candidate_guards_use_pre_transfer_state() {
    let path = format!(
        "{}/../../vectors/peer/guarded-transfer.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let vector: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let seed = "01".repeat(32);
    let author = author_for_seed(&seed).unwrap();
    let named: BTreeMap<String, Delta> = ["grant", "act", "revoke", "deny"]
        .into_iter()
        .map(|label| (label.to_string(), label_delta(label, &author, &seed)))
        .collect();
    let by_id: Rc<BTreeMap<String, String>> = Rc::new(
        named
            .iter()
            .map(|(label, delta)| (delta.id.clone(), label.clone()))
            .collect(),
    );
    for case in vector["cases"].as_array().unwrap() {
        let mut units = Vec::new();
        for description in case["units"].as_array().unwrap() {
            if let Some(label) = description["loose"].as_str() {
                let mut delta = named[label].clone();
                if description["mutation"] == "forgeSignature" {
                    delta.sig = Some("00".repeat(64));
                }
                units.push(TransferUnit::Loose(delta));
            } else {
                let members: Vec<Delta> = description["bundle"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|label| named[label.as_str().unwrap()].clone())
                    .collect();
                let manifest = sign_claims(
                    &make_manifest_claims(
                        &author,
                        2.0,
                        &members
                            .iter()
                            .map(|delta| delta.id.clone())
                            .collect::<Vec<_>>(),
                        None,
                        None,
                    ),
                    &seed,
                )
                .unwrap();
                units.push(TransferUnit::Bundle { manifest, members });
            }
        }
        let prior = DeltaSet::from_deltas(
            case["prior"]
                .as_array()
                .unwrap()
                .iter()
                .map(|label| named[label.as_str().unwrap()].clone()),
        )
        .unwrap();
        let refused: BTreeSet<String> = case["refused"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|label| named[label.as_str().unwrap()].id.clone())
            .collect();
        let seen = Rc::new(RefCell::new(Vec::<String>::new()));
        let seen_order = Rc::new(RefCell::new(Vec::<String>::new()));
        let guards: Vec<Box<CandidateGuard<String>>> = case["guards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|rule| {
                let rule = rule.as_str().unwrap().to_string();
                let seen = Rc::clone(&seen);
                let seen_order = Rc::clone(&seen_order);
                let by_id = Rc::clone(&by_id);
                Box::new(
                    move |candidate: &Delta,
                          sender: &str,
                          receiver: &str,
                          before: &DeltaSet,
                          _at: f64,
                          grant_id: &String| {
                        let label = by_id
                            .get(&candidate.id)
                            .map(String::as_str)
                            .unwrap_or("manifest");
                        seen.borrow_mut().push(label.to_string());
                        seen_order.borrow_mut().push(format!("{rule}:{label}"));
                        match rule.as_str() {
                            "requiresGrant" => label != "act" || before.contains(grant_id),
                            "denyValue" => label != "deny",
                            "expectedPeer" => sender == "sender-A" && receiver == "receiver-B",
                            _ => panic!("unknown guard"),
                        }
                    },
                ) as Box<CandidateGuard<String>>
            })
            .collect();
        let guard_refs: Vec<&CandidateGuard<String>> =
            guards.iter().map(|guard| guard.as_ref()).collect();
        let result = preflight_transfer(
            &units,
            &PreflightContext {
                admitted_before: &prior,
                refused_ids: &refused,
                sending_peer_id: case["sender"].as_str().unwrap_or("sender-A"),
                receiving_peer_id: "receiver-B",
                arrived_at: 100.0,
                policy_state: &named["grant"].id,
                guards: &guard_refs,
            },
        )
        .unwrap();
        let actual: Vec<&str> = result.iter().map(|unit| status_name(unit.status)).collect();
        let expected: Vec<&str> = case["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(actual, expected, "{}", case["name"]);
        let fresh: Vec<Vec<&str>> = result
            .iter()
            .map(|unit| {
                unit.fresh_ids
                    .iter()
                    .map(|id| by_id.get(id).map(String::as_str).unwrap_or("manifest"))
                    .collect()
            })
            .collect();
        let expected_fresh: Vec<Vec<&str>> = case["fresh"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                row.as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap())
                    .collect()
            })
            .collect();
        assert_eq!(fresh, expected_fresh, "{}", case["name"]);
        let checked: Vec<String> = case["checked"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        assert_eq!(*seen.borrow(), checked, "{}", case["name"]);
        if let Some(expected_order) = case["checkedOrder"].as_array() {
            let expected: Vec<String> = expected_order
                .iter()
                .map(|value| value.as_str().unwrap().to_string())
                .collect();
            assert_eq!(*seen_order.borrow(), expected, "{}", case["name"]);
        }
        for item in &result {
            if item.status != GuardedUnitStatus::Eligible {
                assert!(item.fresh_ids.is_empty());
            } else {
                assert!(item.fresh_ids.iter().all(|id| !prior.contains(id)));
            }
        }
        assert_eq!(
            prior.contains(&named["grant"].id),
            case["prior"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == "grant")
        );
    }
}
