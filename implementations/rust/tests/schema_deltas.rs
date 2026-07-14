//! Schemas-as-deltas + the bootstrap vectors. Mirrors ../ts/test/schema-deltas.test.ts.
//! Rust must reproduce the bootstrap constant, every term hash, the published delta id, and the
//! pinned-ref evaluation byte-for-byte.

use rhizomatic::cbor::{decode, encode};
use rhizomatic::eval::{eval_term, result_canonical_hex};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::schema_deltas::{
    hyper_schema_schema, load_hyper_schema, publish_hyper_schema_claims,
};
use rhizomatic::set::{make_delta, merge, DeltaSet};
use rhizomatic::term_io::{term_canonical_hex, term_hash, term_to_json};
use rhizomatic::term_json::parse_term;
use serde_json::{json, Value};

fn read(rel: &str) -> Value {
    let path = format!("{}/../../vectors/l1-eval/{rel}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vector file")).unwrap()
}

fn expand_world() -> (DeltaSet, SchemaRegistry) {
    let doc = read("eval-expand.json");
    let set = DeltaSet::from_deltas(
        doc["fixture"]["deltas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap()),
    )
    .unwrap();
    let reg = SchemaRegistry::build(
        doc["schemas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| HyperSchema {
                name: s["name"].as_str().unwrap().to_string(),
                alg: s["alg"].as_u64().unwrap() as u32,
                body: parse_term(&s["body"]).unwrap(),
            })
            .collect(),
    )
    .unwrap();
    (set, reg)
}

#[test]
fn bootstrap_constant_reproduces() {
    let doc = read("schema-deltas.json");
    let boot = hyper_schema_schema();
    assert_eq!(boot.name, doc["bootstrap"]["name"].as_str().unwrap());
    assert_eq!(term_to_json(&boot.body), doc["bootstrap"]["termJson"]);
    assert_eq!(
        term_canonical_hex(&boot.body).unwrap(),
        doc["bootstrap"]["canonicalCborHex"].as_str().unwrap()
    );
    assert_eq!(
        term_hash(&boot.body).unwrap(),
        doc["bootstrap"]["termHash"].as_str().unwrap()
    );
}

#[test]
fn term_hashes_pin() {
    let doc = read("schema-deltas.json");
    for h in doc["termHashes"].as_array().unwrap() {
        let name = h["name"].as_str().unwrap();
        let term = parse_term(&h["termJson"]).unwrap();
        assert_eq!(
            term_to_json(&term),
            h["termJson"],
            "{name}: parse∘serialize"
        );
        assert_eq!(
            term_canonical_hex(&term).unwrap(),
            h["canonicalCborHex"].as_str().unwrap(),
            "{name}: canonical bytes"
        );
        assert_eq!(
            term_hash(&term).unwrap(),
            h["termHash"].as_str().unwrap(),
            "{name}: hash"
        );
    }
}

#[test]
fn decoder_inverts_encoder_and_rejects_foreign_items() {
    let doc = read("schema-deltas.json");
    let bytes = hex::decode(doc["bootstrap"]["canonicalCborHex"].as_str().unwrap()).unwrap();
    assert_eq!(encode(&decode(&bytes).unwrap()), bytes);
    assert!(decode(&[0x01]).unwrap_err().contains("major type")); // integer
    assert!(decode(&[0x9f, 0xff]).unwrap_err().contains("length")); // indefinite array
    assert!(decode(&[0xf4, 0xf4]).unwrap_err().contains("trailing"));
    assert!(decode(&[0xf6]).unwrap_err().contains("simple")); // null
}

#[test]
fn publish_load_round_trip() {
    let doc = read("schema-deltas.json");
    let (expand_set, reg) = expand_world();
    let claims = parse_claims(&doc["published"]["claims"]).unwrap();
    let delta = make_delta(claims, None).unwrap();
    assert_eq!(delta.id, doc["published"]["deltaId"].as_str().unwrap());
    let dset = merge(&expand_set, &DeltaSet::from_deltas([delta]).unwrap());
    let entity = doc["published"]["schemaEntity"].as_str().unwrap();
    let loaded = load_hyper_schema(&dset, entity).unwrap();
    assert_eq!(loaded.name, "MovieWithCast");
    assert_eq!(
        term_hash(&loaded.body).unwrap(),
        doc["published"]["expectedTermHash"].as_str().unwrap()
    );
    // and the loaded schema evaluates identically to the registry's original
    let via_loaded = eval_term(
        &loaded.body,
        &expand_set,
        Some("movie:matrix"),
        Some(&reg),
        None,
    )
    .unwrap();
    let original = reg.get("MovieWithCast").unwrap();
    let via_original = eval_term(
        &original.body,
        &expand_set,
        Some("movie:matrix"),
        Some(&reg),
        None,
    )
    .unwrap();
    assert_eq!(
        result_canonical_hex(&via_loaded),
        result_canonical_hex(&via_original)
    );
}

#[test]
fn evolution_is_append_and_deprecation_is_negation() {
    let (_, reg) = expand_world();
    let v1 = make_delta(
        publish_hyper_schema_claims(
            reg.get("MovieBasic").unwrap(),
            "schema:Evolving",
            "a",
            1000.0,
        )
        .unwrap(),
        None,
    )
    .unwrap();
    let v2 = make_delta(
        publish_hyper_schema_claims(
            &HyperSchema {
                name: "MovieBasicV2".to_string(),
                alg: 1,
                body: reg.get("MovieWithCast").unwrap().body.clone(),
            },
            "schema:Evolving",
            "a",
            2000.0,
        )
        .unwrap(),
        None,
    )
    .unwrap();
    let dset = DeltaSet::from_deltas([v1.clone(), v2]).unwrap();
    let loaded = load_hyper_schema(&dset, "schema:Evolving").unwrap();
    assert_eq!(loaded.name, "MovieBasicV2");

    // deprecation: negate the only definition -> nothing survives the bootstrap's mask
    let negation = make_delta(
        rhizomatic::set::make_negation_claims("a", 1100.0, &v1.id, None),
        None,
    )
    .unwrap();
    let dead = DeltaSet::from_deltas([v1, negation]).unwrap();
    let err = load_hyper_schema(&dead, "schema:Evolving").unwrap_err();
    assert!(err.contains("no surviving schema definition"), "got: {err}");
}

#[test]
fn pinned_ref_resolves_by_hash() {
    let doc = read("schema-deltas.json");
    let (expand_set, reg) = expand_world();
    let term = parse_term(&doc["pinnedRef"]["term"]).unwrap();
    let result = eval_term(&term, &expand_set, None, Some(&reg), None).unwrap();
    assert_eq!(
        result_canonical_hex(&result),
        doc["pinnedRef"]["expectedCanonicalHex"].as_str().unwrap()
    );
    // unknown pinned hash is rejected
    let bogus = parse_term(&json!({
        "op": "fix",
        "schema": { "pinned": format!("1e20{}", "00".repeat(32)) },
        "entity": "movie:matrix"
    }))
    .unwrap();
    let err = eval_term(&bogus, &expand_set, None, Some(&reg), None).unwrap_err();
    assert!(err.contains("unknown schema"), "got: {err}");
}
