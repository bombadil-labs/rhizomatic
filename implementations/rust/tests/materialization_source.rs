#[path = "support/materialization_assertions.rs"]
mod assertion_evidence;
use rhizomatic::{
    cbor::encode,
    materialization_source::{
        decode_materialization_snapshot, materialization_capture_basis,
        materialization_component_commitments, validate_materialization_capture_basis,
        MaterializationSourceLimits,
    },
};
#[test]
fn shared_source_snapshots() {
    let mut assertions = 0;
    macro_rules! checked_eq {($($args:tt)*)=>{{assert_eq!($($args)*);assertions+=1;}};}
    macro_rules! checked {($($args:tt)*)=>{{assert!($($args)*);assertions+=1;}};}
    macro_rules! checked_ne {($($args:tt)*)=>{{assert_ne!($($args)*);assertions+=1;}};}

    let v: serde_json::Value = serde_json::from_str(include_str!(
        "../../../vectors/materialization/source-snapshot.json"
    ))
    .unwrap();
    for f in v["positives"].as_array().unwrap() {
        let before = assertions;
        let bytes = hex::decode(f["snapshotHex"].as_str().unwrap()).unwrap();
        let s = decode_materialization_snapshot(&bytes, MaterializationSourceLimits::default())
            .unwrap();
        checked_eq!(
            hex::encode(encode(&s.value)),
            f["snapshotHex"].as_str().unwrap()
        );
        checked_eq!(s.revision, f["expected"]["revision"].as_str().unwrap());
        checked_eq!(s.membership, f["expected"]["membership"].as_str().unwrap());
        checked_eq!(
            s.appearance_digest,
            f["expected"]["appearanceDigest"].as_str().unwrap()
        );
        checked_eq!(
            s.deltas.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            f["expected"]["operandIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap())
                .collect::<Vec<_>>()
        );
        checked_eq!(
            s.components.len(),
            f["expected"]["components"].as_u64().unwrap() as usize
        );
        let basis =
            materialization_capture_basis(&bytes, MaterializationSourceLimits::default()).unwrap();
        checked_eq!(hex::encode(&basis), f["basisHex"].as_str().unwrap());
        validate_materialization_capture_basis(
            &basis,
            &bytes,
            MaterializationSourceLimits::default(),
        )
        .unwrap();
        if let Some(id) = f["expected"]["excludedId"].as_str() {
            checked!(
                !hex::encode(encode(&materialization_component_commitments(&s).unwrap()))
                    .contains(&hex::encode(id))
            );
        }
        assertion_evidence::record(
            "source-snapshot",
            include_bytes!("../../../vectors/materialization/source-snapshot.json"),
            "positives",
            f,
            assertions - before,
        );
    }
    for f in v["negatives"].as_array().unwrap() {
        let before = assertions;
        let mut limits = MaterializationSourceLimits::default();
        if f["limits"].is_object() {
            limits.artifact_bytes = f["limits"]["artifactBytes"].as_u64().unwrap() as usize;
        }
        let err = decode_materialization_snapshot(
            &hex::decode(f["snapshotHex"].as_str().unwrap()).unwrap(),
            limits,
        )
        .unwrap_err();
        checked_eq!(err.to_string(), f["expected"].as_str().unwrap());
        assertion_evidence::record(
            "source-snapshot",
            include_bytes!("../../../vectors/materialization/source-snapshot.json"),
            "negatives",
            f,
            assertions - before,
        );
    }
    let revision = |name: &str| {
        v["positives"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == name)
            .unwrap()["expected"]["revision"]
            .clone()
    };
    checked_eq!(revision("one"), revision("fresh_observation"));
    checked_ne!(revision("one"), revision("authority_change"));
    let _ = assertions;
}
