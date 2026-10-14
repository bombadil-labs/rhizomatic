//! Scoped source snapshots (SPEC-17 §7): the shared corpus both witnesses must decode alike.
//! Mirrors ../ts/test/materialization-scoped-source.test.ts.
use rhizomatic::{
    cbor::encode,
    materialization_source::{
        decode_materialization_binding_spec, decode_materialization_capture_basis,
        decode_materialization_snapshot, materialization_binding_scoped,
        materialization_capture_basis, MaterializationSourceLimits,
    },
};

fn strings(v: &serde_json::Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn shared_scoped_sources() {
    let v: serde_json::Value = serde_json::from_str(include_str!(
        "../../../vectors/materialization/scoped-source.json"
    ))
    .unwrap();
    let bytes = |s: &serde_json::Value| hex::decode(s.as_str().unwrap()).unwrap();
    let limits = MaterializationSourceLimits::default();
    for b in v["bindings"].as_array().unwrap() {
        let spec = decode_materialization_binding_spec(&bytes(&b["specHex"]), 16777216).unwrap();
        assert_eq!(
            materialization_binding_scoped(&spec),
            b["expected"]["scoped"].as_bool().unwrap(),
            "binding {}",
            b["id"]
        );
    }
    for f in v["positives"].as_array().unwrap() {
        let id = f["id"].as_str().unwrap();
        let snapshot = bytes(&f["snapshotHex"]);
        let s = decode_materialization_snapshot(&snapshot, limits).unwrap();
        assert_eq!(hex::encode(encode(&s.value)), f["snapshotHex"], "{id}");
        assert_eq!(s.revision, f["expected"]["revision"], "{id}");
        assert_eq!(s.scope, Some(strings(&f["expected"]["scope"])), "{id}");
        assert_eq!(
            s.deltas.iter().map(|d| d.id.clone()).collect::<Vec<_>>(),
            strings(&f["expected"]["operandIds"]),
            "{id}"
        );
        assert_eq!(
            hex::encode(materialization_capture_basis(&snapshot, limits).unwrap()),
            f["basisHex"],
            "{id}"
        );
        let basis = decode_materialization_capture_basis(&bytes(&f["basisHex"]), limits).unwrap();
        assert_eq!(basis.scope, Some(strings(&f["expected"]["scope"])), "{id}");
        assert_eq!(basis.revision, f["expected"]["revision"], "{id}");
    }
    for f in v["negatives"].as_array().unwrap() {
        let id = f["id"].as_str().unwrap();
        let err = decode_materialization_snapshot(&bytes(&f["snapshotHex"]), limits).unwrap_err();
        assert_eq!(err.to_string(), f["expected"].as_str().unwrap(), "{id}");
    }
}

// The producer reproduces every shared fixture byte for byte from its parts.
use rhizomatic::cbor::CborValue;
use rhizomatic::materialization_source::{
    produce_materialization_snapshot, MaterializationSourceComponentInput,
    MaterializationSourceInput,
};

fn fields(v: &CborValue) -> std::collections::BTreeMap<String, CborValue> {
    match v {
        CborValue::Map(fs) => fs.iter().cloned().collect(),
        _ => panic!("expected a map"),
    }
}
fn text(v: &CborValue) -> String {
    match v {
        CborValue::Tstr(s) => s.clone(),
        _ => panic!("expected text"),
    }
}
fn texts(v: &CborValue) -> Vec<String> {
    match v {
        CborValue::Array(xs) => xs.iter().map(text).collect(),
        _ => panic!("expected an array"),
    }
}

fn reproduce(snapshot_hex: &str, profile: &str) -> (Vec<u8>, Vec<u8>) {
    reproduce_with(snapshot_hex, profile, |scope| scope)
}

fn reproduce_with(
    snapshot_hex: &str,
    profile: &str,
    scope_of: impl Fn(Vec<String>) -> Vec<String>,
) -> (Vec<u8>, Vec<u8>) {
    let limits = MaterializationSourceLimits::default();
    let s = decode_materialization_snapshot(&hex::decode(snapshot_hex).unwrap(), limits).unwrap();
    let top = fields(&s.value);
    let CborValue::Array(exclusions) = &top["exclusions"] else {
        panic!()
    };
    let exclusions: Vec<(String, Vec<String>, String)> = exclusions
        .iter()
        .map(|e| {
            let f = fields(e);
            (text(&f["id"]), texts(&f["peers"]), text(&f["reason"]))
        })
        .collect();
    let CborValue::Array(operands) = &top["operands"] else {
        panic!()
    };
    let operand_peers: std::collections::BTreeMap<String, Vec<String>> = operands
        .iter()
        .map(|o| {
            let f = fields(o);
            (text(&f["id"]), texts(&f["peers"]))
        })
        .collect();
    let components = s
        .components
        .iter()
        .map(|c| {
            let f = fields(c);
            let peer = text(&f["peer"]);
            let ops = texts(&f["operandIds"]);
            MaterializationSourceComponentInput {
                revision: text(&f["revision"]),
                captured_at: match f["capturedAt"] {
                    CborValue::Float(x) => x,
                    _ => panic!(),
                },
                operands: s
                    .deltas
                    .iter()
                    .filter(|d| operand_peers[&d.id].contains(&peer))
                    .cloned()
                    .collect(),
                held_ids: texts(&f["rawIds"])
                    .into_iter()
                    .filter(|x| !ops.contains(x))
                    .collect(),
                peer,
            }
        })
        .collect();
    let produced = produce_materialization_snapshot(
        &MaterializationSourceInput {
            binding: s.binding.clone(),
            authority: s.authority.clone(),
            selection: CborValue::Map(vec![
                ("profile".into(), CborValue::Tstr(profile.into())),
                (
                    "parameters".into(),
                    CborValue::Bstr(encode(&CborValue::Map(vec![]))),
                ),
            ]),
            serving_at: s.serving_at,
            historical_cutoff: s.historical_cutoff,
            scope: s.scope.clone().map(scope_of),
            components,
            exclusions: exclusions
                .into_iter()
                .map(|(id, _, reason)| (id, reason))
                .collect(),
        },
        limits,
    )
    .unwrap();
    (produced.snapshot_bytes, produced.basis_bytes)
}

#[test]
fn the_producer_reproduces_every_shared_fixture() {
    for (corpus, profile) in [
        (
            include_str!("../../../vectors/materialization/scoped-source.json"),
            "scoped-snapshot/1",
        ),
        (
            include_str!("../../../vectors/materialization/source-snapshot.json"),
            "host-authorized-snapshot/1",
        ),
    ] {
        let v: serde_json::Value = serde_json::from_str(corpus).unwrap();
        for f in v["positives"].as_array().unwrap() {
            let (snapshot, basis) = reproduce(f["snapshotHex"].as_str().unwrap(), profile);
            assert_eq!(hex::encode(snapshot), f["snapshotHex"], "{}", f["id"]);
            assert_eq!(hex::encode(basis), f["basisHex"], "{}", f["id"]);
        }
    }
}

#[test]
fn the_producer_writes_a_scope_as_a_set_in_utf8_byte_order() {
    let v: serde_json::Value = serde_json::from_str(include_str!(
        "../../../vectors/materialization/scoped-source.json"
    ))
    .unwrap();
    let f = v["positives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "scoped_supplementary_order")
        .unwrap();
    let (snapshot, _) = reproduce_with(
        f["snapshotHex"].as_str().unwrap(),
        "scoped-snapshot/1",
        |s| {
            let mut shuffled: Vec<String> = s.iter().rev().cloned().collect();
            shuffled.push(s[0].clone());
            shuffled
        },
    );
    assert_eq!(hex::encode(snapshot), f["snapshotHex"]);
}
