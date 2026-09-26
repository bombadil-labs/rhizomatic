//! Shared governed definition and named lens binding vectors (SPEC-3).

use std::collections::{BTreeMap, BTreeSet};

use rhizomatic::json_profile::parse_claims;
use rhizomatic::lens_binding::{load_lens_binding, publish_lens_binding_claims};
use rhizomatic::resolution::Order;
use rhizomatic::schema_deltas::{load_governed_hyper_schema, load_governed_schema};
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::term_io::{schema_hash, term_hash};
use rhizomatic::types::Delta;
use serde_json::Value;

fn vector() -> Value {
    let path = format!(
        "{}/../../vectors/l3-schema/governed-bindings.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vector")).unwrap()
}

fn order(name: &str) -> Order {
    match name {
        "byTimestamp" => Order::ByTimestamp { desc: true },
        "byValidFrom" => Order::ByValidFrom { desc: true },
        _ => panic!("unknown order"),
    }
}

fn authors(case: &Value) -> BTreeSet<&str> {
    case["authors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect()
}

#[test]
fn shared_governed_bindings_match_in_both_orders() {
    let v = vector();
    let mut named = BTreeMap::<String, Delta>::new();
    let mut deltas = Vec::new();
    for entry in v["deltas"].as_array().unwrap() {
        let delta = make_delta(parse_claims(&entry["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, entry["id"].as_str().unwrap());
        named.insert(entry["name"].as_str().unwrap().to_string(), delta.clone());
        deltas.push(delta);
    }
    for reverse in [false, true] {
        let mut ordered = deltas.clone();
        if reverse {
            ordered.reverse();
        }
        let set = DeltaSet::from_deltas(ordered).unwrap();
        for case in v["hyperLoads"].as_array().unwrap() {
            let permitted = authors(case);
            let loaded = load_governed_hyper_schema(
                &set,
                "schema:governed",
                case["now"].as_f64().unwrap(),
                |author| permitted.contains(author),
                &order(case["order"].as_str().unwrap()),
            );
            if case["expected"].is_null() {
                assert!(loaded.unwrap_err().contains("no surviving schema definition"));
            } else {
                let loaded = loaded.unwrap();
                let expected = case["expected"].as_str().unwrap();
                assert_eq!(loaded.name, expected);
                let pin = if expected == "DefinitionA" { "hyperA" } else { "hyperB" };
                assert_eq!(term_hash(&loaded.body).unwrap(), v["pins"][pin].as_str().unwrap());
            }
        }
        for case in v["schemaLoads"].as_array().unwrap() {
            let permitted = authors(case);
            let loaded = load_governed_schema(
                &set,
                "schema:reading",
                case["now"].as_f64().unwrap(),
                |author| permitted.contains(author),
                &order(case["order"].as_str().unwrap()),
            );
            if case["expected"].is_null() {
                assert!(loaded.unwrap_err().contains("no surviving schema definition"));
            } else {
                let loaded = loaded.unwrap();
                let expected = case["expected"].as_str().unwrap();
                assert_eq!(loaded.name.as_deref(), Some(expected));
                let pin = if expected == "ReadingA" { "schemaA" } else { "schemaB" };
                assert_eq!(schema_hash(&loaded).unwrap(), v["pins"][pin].as_str().unwrap());
            }
        }
        for case in v["lensLoads"].as_array().unwrap() {
            let permitted = authors(case);
            let loaded = load_lens_binding(
                &set,
                "lens:shared",
                case["now"].as_f64().unwrap(),
                |author| permitted.contains(author),
                &order(case["order"].as_str().unwrap()),
            );
            if case["expected"].is_null() {
                assert!(loaded.unwrap_err().contains("no surviving lens binding"));
            } else {
                let loaded = loaded.unwrap();
                let expected = case["expected"].as_str().unwrap();
                let pin_set = if expected == "lensA" { "A" } else { "B" };
                let hyper_pin_name = format!("hyper{pin_set}");
                let schema_pin_name = format!("schema{pin_set}");
                assert_eq!(loaded.name, "lens:shared");
                assert_eq!(loaded.delta_id, named[expected].id);
                assert_eq!(
                    loaded.hyper_schema_pin,
                    v["pins"][hyper_pin_name.as_str()].as_str().unwrap()
                );
                assert_eq!(
                    loaded.schema_pin,
                    v["pins"][schema_pin_name.as_str()].as_str().unwrap()
                );
            }
        }
        let only_a = |author: &str| author == "A";
        let hyper = load_governed_hyper_schema(
            &set,
            "schema:governed",
            60.0,
            only_a,
            &Order::ByTimestamp { desc: true },
        )
        .unwrap();
        let schema = load_governed_schema(
            &set,
            "schema:reading",
            60.0,
            only_a,
            &Order::ByTimestamp { desc: true },
        )
        .unwrap();
        let mut claims =
            publish_lens_binding_claims("lens:shared", &hyper, &schema, "A", 100.0).unwrap();
        claims.valid_from = 50.0;
        assert_eq!(make_delta(claims, None).unwrap().id, named["lensA"].id);
    }
}
