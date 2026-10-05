#[path = "support/evidence_fixture.rs"]
mod support;
use rhizomatic::evidence_codec::ReadingAppearanceLimits;
use rhizomatic::hash::content_address;
use rhizomatic::hview::hview_canonical_hex;
use rhizomatic::hview_envelope::{
    decode_hview_envelope, encode_hview_envelope, HViewEnvelopeLimits,
};
use rhizomatic::reading_appearance::{decode_reading_appearance, encode_reading_appearance};
use rhizomatic::resolution::resolve_view;
use rhizomatic::sign::{verify_delta, Verification};
use rhizomatic::term_io::{schema_hash, schema_to_json};
use rhizomatic::term_json::parse_schema;
use serde_json::{json, Value};
fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../vectors/materialization/evidence-envelope.json"
    ))
    .unwrap()
}
#[test]
fn shared_evidence_vectors() {
    let vs = vectors();
    let reading =
        parse_schema(&json!({"props":{},"default":{"pick":{"order":"lexById"}}})).unwrap();
    for v in vs["positives"].as_array().unwrap() {
        let label = format!("{}/{}", v["id"], v["variant"]);
        let native = support::fixture_view(&v["native"]).unwrap();
        let limits = support::limits(&v["limits"]);
        let expected = hex::decode(v["envelopeHex"].as_str().unwrap()).unwrap();
        let encoded = encode_hview_envelope(&native, limits).unwrap();
        assert_eq!(encoded, expected, "{label}");
        assert_eq!(
            content_address(&encoded),
            v["transportId"].as_str().unwrap(),
            "{label}"
        );
        let decoded = decode_hview_envelope(&expected, limits).unwrap();
        assert_eq!(
            encode_hview_envelope(&decoded, limits).unwrap(),
            expected,
            "{label}"
        );
        assert_eq!(
            support::inspect_view(&native),
            support::inspect_view(&decoded),
            "{label}"
        );
        assert_eq!(
            hview_canonical_hex(&native),
            v["existingHViewHex"].as_str().unwrap(),
            "{label}"
        );
        assert_eq!(
            hview_canonical_hex(&decoded),
            v["existingHViewHex"].as_str().unwrap(),
            "{label}"
        );
        if v["variant"] == "legacy" {
            assert!(resolve_view(&reading, &decoded)
                .unwrap_err()
                .contains("reading"));
        }
        if v["variant"] == "annotations" {
            assert_eq!(
                resolve_view(&reading, &native),
                resolve_view(&reading, &decoded)
            );
        }
        if v["variant"] == "bound" {
            assert_ne!(
                schema_hash(decoded.props["child"][0].readings.get(&1).unwrap()).unwrap(),
                schema_hash(&parse_schema(&v["originalReading"]).unwrap()).unwrap()
            );
        }
        println!("materialization-case:{label}");
    }
    for v in vs["negative"].as_array().unwrap() {
        let expected = v["error"].as_str().unwrap();
        if !v["native"].is_null() {
            let native = support::fixture_view(&v["native"]).unwrap();
            assert_eq!(
                encode_hview_envelope(&native, support::limits(&v["limits"]))
                    .unwrap_err()
                    .to_string(),
                expected
            );
        }
        let result = decode_hview_envelope(
            &hex::decode(v["envelopeHex"].as_str().unwrap()).unwrap(),
            support::limits(&v["limits"]),
        );
        assert_eq!(
            result.unwrap_err().to_string(),
            expected,
            "{}/{}",
            v["id"],
            v["variant"]
        );
        println!("materialization-case:{}/{}", v["id"], v["variant"]);
    }
    for v in vs["nativeReject"].as_array().unwrap() {
        let native = support::fixture_view(&v["native"]).unwrap();
        assert_eq!(
            verify_delta(&native.props["child"][0].delta),
            Verification::Verified
        );
        assert_eq!(
            encode_hview_envelope(&native, HViewEnvelopeLimits::default())
                .unwrap_err()
                .to_string(),
            "invalid-evidence"
        );
        println!("materialization-case:{}/{}", v["id"], v["variant"]);
    }
    for v in vs["readingFixtures"].as_array().unwrap() {
        let native = parse_schema(&v["native"]).unwrap();
        let expected = hex::decode(v["appearanceHex"].as_str().unwrap()).unwrap();
        assert_eq!(
            encode_reading_appearance(&native, ReadingAppearanceLimits::default()).unwrap(),
            expected
        );
        let decoded =
            decode_reading_appearance(&expected, ReadingAppearanceLimits::default()).unwrap();
        assert_eq!(schema_to_json(&decoded), schema_to_json(&native));
        assert_eq!(
            schema_hash(&decoded).unwrap(),
            v["semanticPin"].as_str().unwrap()
        );
    }
}
#[test]
fn actual_fix_root() {
    use rhizomatic::eval::{eval_term, EvalResult, SchemaRef, Term};
    use rhizomatic::schema::{HyperSchema, SchemaRegistry};
    let registry = SchemaRegistry::build(
        vec![HyperSchema {
            name: "Fixed".into(),
            alg: 1,
            body: rhizomatic::term_json::parse_term(
                &json!({"op":"group","key":{"const":"value"},"in":"input"}),
            )
            .unwrap(),
        }],
        vec![],
    )
    .unwrap();
    let fixed = eval_term(
        &Term::Fix {
            schema: SchemaRef::Name("Fixed".into()),
            entity: "fix:selected".into(),
            bindings: None,
        },
        &rhizomatic::set::DeltaSet::new(),
        None,
        Some(&registry),
        None,
    )
    .unwrap();
    let EvalResult::HView(child) = fixed else {
        panic!("fix sort");
    };
    let mut native = support::fixture_view(&vectors()["positives"][0]["native"]).unwrap();
    native.props.get_mut("child").unwrap()[0]
        .expanded
        .insert(1, child);
    let bytes = encode_hview_envelope(&native, HViewEnvelopeLimits::default()).unwrap();
    let decoded = decode_hview_envelope(&bytes, HViewEnvelopeLimits::default()).unwrap();
    assert_eq!(decoded.props["child"][0].expanded[&1].id, "fix:selected");
}
#[test]
fn independent_empty_oracles() {
    let vs: Value = serde_json::from_str(include_str!(
        "../../../vectors/materialization/independent-empty-oracles.json"
    ))
    .unwrap();
    for v in vs["cases"].as_array().unwrap() {
        let native = rhizomatic::hview::HView {
            id: v["input"]["root"]["id"].as_str().unwrap().into(),
            props: v["input"]["root"]["props"]
                .as_object()
                .unwrap()
                .keys()
                .map(|k| (k.clone(), vec![]))
                .collect(),
        };
        let bytes = encode_hview_envelope(&native, HViewEnvelopeLimits::default()).unwrap();
        assert_eq!(
            hex::encode(&bytes),
            v["expectedEnvelopeHex"].as_str().unwrap()
        );
        assert_eq!(
            hview_canonical_hex(&native),
            v["expectedExistingHViewHex"].as_str().unwrap()
        );
        assert_eq!(
            bytes.len(),
            v["expectedEnvelopeBytes"].as_u64().unwrap() as usize
        );
    }
}

#[test]
fn metadata_and_actual_bound_reading() {
    let vs = vectors();
    let v = vs["positives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["variant"] == "metadata")
        .unwrap();
    let native = support::fixture_view(&v["native"]).unwrap();
    let mut changed = native.clone();
    for r in changed.props.get_mut("child").unwrap()[0]
        .readings
        .values_mut()
    {
        r.name = Some("Another".into());
        r.alg = Some(9.0);
    }
    assert_eq!(hview_canonical_hex(&native), hview_canonical_hex(&changed));
    assert_ne!(
        encode_hview_envelope(&native, HViewEnvelopeLimits::default()),
        encode_hview_envelope(&changed, HViewEnvelopeLimits::default())
    );
    let v = vs["positives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["variant"] == "bound")
        .unwrap();
    let native = support::fixture_view(&v["native"]).unwrap();
    let e = &native.props["child"][0];
    let bindings = std::collections::BTreeMap::from([(
        "owner".into(),
        rhizomatic::types::Primitive::Str(e.delta.claims.author.clone()),
    )]);
    let bound = rhizomatic::eval::bind_program_reading(
        &parse_schema(&v["originalReading"]).unwrap(),
        Some(&bindings),
    )
    .unwrap();
    assert_eq!(schema_to_json(&bound), schema_to_json(&e.readings[&1]));
}

#[test]
fn native_negative_zero() {
    let vs = vectors();
    let v = vs["positives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["variant"] == "all-targets")
        .unwrap();
    let mut native = support::fixture_view(&v["native"]).unwrap();
    native.props.get_mut("child").unwrap()[0]
        .delta
        .claims
        .pointers[3]
        .target = rhizomatic::types::Target::Primitive(rhizomatic::types::Primitive::Num(-0.0));
    assert_eq!(
        hex::encode(encode_hview_envelope(&native, HViewEnvelopeLimits::default()).unwrap()),
        v["envelopeHex"].as_str().unwrap()
    );
}
