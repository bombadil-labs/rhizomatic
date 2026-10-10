//! SPEC-16 MR-14 control image codec and MR-16 planner against the shared independent oracles.
use rhizomatic::materialization_peer::{
    decode_materialization_control, empty_materialization_control, encode_materialization_control,
    materialization_appearance_key, materialization_control_image,
    materialization_control_revision, plan_materialization_control, MaterializationControlActive,
    MaterializationControlEntry, MaterializationControlError, MaterializationControlLimits,
    MaterializationControlPlan, MaterializationControlRefusal, MaterializationControlStatus,
    MaterializationControlTransition,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const CORPUS: &[u8] = include_bytes!("../../../vectors/materialization/control-image.json");
fn limits(v: &Value) -> MaterializationControlLimits {
    MaterializationControlLimits {
        artifact_bytes: v["artifactBytes"].as_u64().unwrap() as usize,
        registrations: v["registrations"].as_u64().unwrap() as usize,
        definitions: v["definitions"].as_u64().unwrap() as usize,
    }
}
fn entry(v: &Value) -> MaterializationControlEntry {
    let s = |k: &str| v[k].as_str().unwrap().to_string();
    MaterializationControlEntry {
        registration: s("registration"),
        status: if v["status"] == "active" {
            MaterializationControlStatus::Active
        } else {
            MaterializationControlStatus::Retired
        },
        transition: s("transition"),
        source_revision: s("sourceRevision"),
        authority: s("authority"),
        at: v["at"].as_f64().unwrap(),
        definition_at: v["definitionAt"].as_f64().unwrap(),
        hyperschema_pin: s("hyperschemaPin"),
        schema_pin: s("schemaPin"),
        capture: v.get("capture").and_then(Value::as_str).map(String::from),
    }
}
fn record(group: &str, id: &Value, assertions: usize) {
    println!(
        "materialization-m3-assertion:{}",
        json!({"corpus":"control-image","corpusId":hex::encode(Sha256::digest(CORPUS)),"group":group,"id":id,"assertions":assertions})
    );
}
#[test]
fn shared_control_images() {
    let v: Value = serde_json::from_slice(CORPUS).unwrap();
    let l = limits(&v["limits"]);
    for f in v["positives"].as_array().unwrap() {
        let mut assertions = 0;
        macro_rules! checked_eq {($($args:tt)*)=>{{assert_eq!($($args)*);assertions+=1;}};}
        let bytes = hex::decode(f["imageHex"].as_str().unwrap()).unwrap();
        let image = decode_materialization_control(&bytes, &l).unwrap();
        let e = &f["expected"];
        checked_eq!(image.receiver, e["receiver"].as_str().unwrap());
        checked_eq!(image.configuration, e["configuration"].as_str().unwrap());
        checked_eq!(image.generation, e["generation"].as_f64().unwrap());
        checked_eq!(
            image.entries,
            e["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(entry)
                .collect::<Vec<_>>()
        );
        checked_eq!(
            image.deltas.keys().cloned().collect::<Vec<_>>(),
            e["deltaKeys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| k.as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        );
        for (key, value) in &image.deltas {
            checked_eq!(&materialization_appearance_key(value), key);
        }
        checked_eq!(
            hex::encode(encode_materialization_control(&image, &l).unwrap()),
            f["imageHex"].as_str().unwrap()
        );
        checked_eq!(
            materialization_control_revision(&bytes, image.generation),
            f["revision"].as_str().unwrap()
        );
        record("positives", &f["id"], assertions);
    }
    for f in v["negatives"].as_array().unwrap() {
        let bytes = hex::decode(f["imageHex"].as_str().unwrap()).unwrap();
        let fl = f.get("limits").map(limits).unwrap_or(l);
        let err = decode_materialization_control(&bytes, &fl).unwrap_err();
        assert_eq!(err.to_string(), f["code"].as_str().unwrap(), "{}", f["id"]);
        assert!(matches!(
            err,
            MaterializationControlError::InvalidControl
                | MaterializationControlError::ResourceLimit
        ));
        record("negatives", &f["id"], 1);
    }
}
#[test]
fn planner_derives_shared_images_and_refuses_by_category() {
    use MaterializationControlPlan::{Planned, Refused};
    use MaterializationControlRefusal as R;
    use MaterializationControlTransition as T;
    let v: Value = serde_json::from_slice(CORPUS).unwrap();
    let l = limits(&v["limits"]);
    let positives = v["positives"].as_array().unwrap();
    let one = decode_materialization_control(
        &hex::decode(positives[1]["imageHex"].as_str().unwrap()).unwrap(),
        &l,
    )
    .unwrap();
    let two = decode_materialization_control(
        &hex::decode(positives[2]["imageHex"].as_str().unwrap()).unwrap(),
        &l,
    )
    .unwrap();
    let active = one.entries[0].clone();
    let as_active = |e: &MaterializationControlEntry| MaterializationControlActive {
        registration: e.registration.clone(),
        source_revision: e.source_revision.clone(),
        authority: e.authority.clone(),
        at: e.at,
        definition_at: e.definition_at,
        hyperschema_pin: e.hyperschema_pin.clone(),
        schema_pin: e.schema_pin.clone(),
        capture: active.capture.clone().unwrap(),
    };
    let empty = empty_materialization_control(
        v["keys"]["receiver"].as_str().unwrap(),
        v["configuration"].as_str().unwrap(),
    )
    .unwrap();
    let empty_bytes =
        encode_materialization_control(&materialization_control_image(&empty, &l).unwrap(), &l)
            .unwrap();
    assert_eq!(materialization_control_revision(&empty_bytes, 0.0), "");
    let install = T::Install {
        entry: as_active(&active),
        transition: active.transition.clone(),
        support: one.deltas.clone(),
    };
    let Planned(installed) = plan_materialization_control(&empty, &install, &l).unwrap() else {
        panic!("install refused")
    };
    assert_eq!(
        hex::encode(
            encode_materialization_control(
                &materialization_control_image(&installed, &l).unwrap(),
                &l
            )
            .unwrap()
        ),
        positives[1]["imageHex"].as_str().unwrap()
    );
    assert_eq!(
        plan_materialization_control(&installed, &install, &l).unwrap(),
        Refused(R::AlreadyInstalled)
    );
    let retired_entry = two
        .entries
        .iter()
        .find(|e| e.status == MaterializationControlStatus::Retired)
        .unwrap()
        .clone();
    assert_eq!(
        plan_materialization_control(
            &installed,
            &T::Retire {
                registration: retired_entry.registration.clone(),
                transition: retired_entry.transition.clone(),
                support: BTreeMap::new(),
            },
            &l
        )
        .unwrap(),
        Refused(R::RegistrationMissing)
    );
    assert_eq!(
        plan_materialization_control(
            &installed,
            &T::AdvanceTime {
                registration: active.registration.clone(),
                at: active.at - 1.0,
                transition: active.transition.clone(),
                support: BTreeMap::new(),
                superseded: vec![],
            },
            &l
        )
        .unwrap(),
        Refused(R::TimeRegression)
    );
    let retire_key = two
        .deltas
        .keys()
        .find(|k| !one.deltas.contains_key(*k))
        .unwrap()
        .clone();
    let retire_support: BTreeMap<String, Vec<u8>> =
        BTreeMap::from([(retire_key.clone(), two.deltas[&retire_key].clone())]);
    let second_install = T::Install {
        entry: as_active(&retired_entry),
        transition: active.transition.clone(),
        support: retire_support.clone(),
    };
    assert_eq!(
        plan_materialization_control(
            &installed,
            &second_install,
            &MaterializationControlLimits {
                registrations: 1,
                ..l
            }
        )
        .unwrap(),
        Refused(R::ResourceLimit)
    );
    let Planned(second) = plan_materialization_control(&installed, &second_install, &l).unwrap()
    else {
        panic!("second install refused")
    };
    let Planned(retired) = plan_materialization_control(
        &second,
        &T::Retire {
            registration: retired_entry.registration.clone(),
            transition: retired_entry.transition.clone(),
            support: retire_support,
        },
        &l,
    )
    .unwrap() else {
        panic!("retire refused")
    };
    let image = materialization_control_image(&retired, &l).unwrap();
    assert_eq!(image.generation, 3.0);
    assert_eq!(image.entries, two.entries);
    assert_eq!(
        hex::encode(encode_materialization_control(&image, &l).unwrap()),
        positives[2]["imageHex"].as_str().unwrap()
    );
    assert_eq!(
        plan_materialization_control(
            &retired,
            &T::Retire {
                registration: retired_entry.registration.clone(),
                transition: retired_entry.transition.clone(),
                support: BTreeMap::new(),
            },
            &l
        )
        .unwrap(),
        Refused(R::Retired)
    );
}
