#[path = "support/evidence_fixture.rs"]
mod support;
use crate::{envelope, evidence_codec, hview, json_profile, sign, types};
#[test]
fn verification_scales_with_full_appearances_not_entries() {
    use hview::{HVEntry, HView};
    use std::collections::BTreeMap;
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../vectors/materialization/evidence-envelope.json"
    ))
    .unwrap();
    let original = vectors["positives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["variant"] == "original")
        .unwrap();
    let repeated = vectors["positives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["variant"] == "repeats")
        .unwrap();
    let base = support::fixture_view(&original["native"]).unwrap().props["child"][0]
        .delta
        .clone();
    let second = support::fixture_view(&repeated["native"]).unwrap().props["child"][0]
        .delta
        .clone();
    let sigs: serde_json::Value =
        serde_json::from_str(include_str!("../../../vectors/command/execution.json")).unwrap();
    let parse = |v: &serde_json::Value| types::Delta {
        id: v["id"].as_str().unwrap().into(),
        claims: json_profile::parse_claims(&v["claims"]).unwrap(),
        sig: Some(v["sig"].as_str().unwrap().into()),
    };
    let entry = |d| HVEntry {
        delta: d,
        negated: false,
        expanded: BTreeMap::new(),
        readings: BTreeMap::new(),
    };
    let make = |entries| HView {
        id: "item:fern".into(),
        props: BTreeMap::from([("value".into(), entries)]),
    };
    for repeats in [1, 32, 1000] {
        let mut es = vec![entry(base.clone()); repeats];
        es.push(entry(second.clone()));
        es.push(entry(parse(
            &sigs["fixtures"]["signatureVariants"]["original"],
        )));
        es.push(entry(parse(
            &sigs["fixtures"]["signatureVariants"]["alternate"],
        )));
        let mut unsigned = base.clone();
        unsigned.sig = None;
        es.push(entry(unsigned));
        let view = make(es);
        sign::reset();
        let bytes = envelope::encode_hview_envelope(&view, Default::default()).unwrap();
        assert_eq!(sign::count(), 4, "encode repeats={repeats}");
        assert_eq!(
            bytes,
            rhizomatic::encode_hview_envelope(&view, support::limits(&serde_json::Value::Null))
                .unwrap()
        );
        sign::reset();
        let decoded = envelope::decode_hview_envelope(&bytes, Default::default()).unwrap();
        assert_eq!(
            support::inspect_view(&view),
            support::inspect_view(&decoded)
        );
        assert_eq!(
            sign::count(),
            4,
            "decode including final re-encode repeats={repeats}"
        );
        sign::reset();
        envelope::encode_hview_envelope(&view, Default::default()).unwrap();
        assert_eq!(sign::count(), 4, "no cross-call cache");
    }
    let mut bad = base.clone();
    bad.sig = Some("00".repeat(64));
    sign::reset();
    assert_eq!(
        envelope::encode_hview_envelope(
            &make(vec![entry(base.clone()), entry(bad.clone())]),
            Default::default()
        ),
        Err(evidence_codec::EvidenceCodecError::InvalidEvidence)
    );
    assert_eq!(sign::count(), 2);
    assert!(envelope::encode_hview_envelope(&make(vec![entry(bad)]), Default::default()).is_err());
    assert_eq!(sign::count(), 3);
    let mut upper = base.clone();
    upper.sig = upper.sig.map(|s| s.to_uppercase());
    assert!(envelope::encode_hview_envelope(
        &make(vec![entry(base), entry(upper)]),
        Default::default()
    )
    .is_err());
}
