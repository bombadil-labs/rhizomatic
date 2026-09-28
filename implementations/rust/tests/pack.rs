//! Pack round-trip + the cross-impl pack vector. Mirrors ../ts/test/pack.test.ts.

use rhizomatic::cbor::{decode, encode, CborValue};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::pack::{pack_id, pack_set, unpack_set};
use rhizomatic::set::{make_delta, DeltaSet};
use serde_json::Value;

fn read(rel: &str) -> Value {
    let path = format!("{}/../../vectors/{rel}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vector file")).unwrap()
}

fn vector_set_from(rel: &str) -> (DeltaSet, Value) {
    let vec = read(rel);
    let set = DeltaSet::from_deltas(vec["deltas"].as_array().unwrap().iter().map(|d| {
        let sig = d.get("sig").and_then(Value::as_str).map(str::to_string);
        make_delta(parse_claims(&d["claims"]).unwrap(), sig).unwrap()
    }))
    .unwrap();
    (set, vec)
}

fn vector_set() -> (DeltaSet, Value) {
    vector_set_from("l0-pack/pack.json")
}

#[test]
fn reproduces_the_cross_impl_pack_vector_byte_for_byte() {
    for rel in ["l0-pack/pack.json", "l0-pack/pack-bytes.json"] {
        let (set, vec) = vector_set_from(rel);
        let bytes = pack_set(&set);
        assert_eq!(
            hex::encode(&bytes),
            vec["packHex"].as_str().unwrap(),
            "{rel}"
        );
        assert_eq!(pack_id(&bytes), vec["packId"].as_str().unwrap(), "{rel}");
    }
}

#[test]
fn round_trips_byte_exactly() {
    let (set, _) = vector_set();
    let bytes = pack_set(&set);
    let back = unpack_set(&bytes).unwrap();
    assert_eq!(back.digest(), set.digest());
    // sigs survive the trip
    for d in set.iter() {
        assert_eq!(back.get(&d.id).unwrap().sig, d.sig);
    }
    // repacking the unpacked set reproduces identical bytes (logical form is sacred)
    assert_eq!(pack_set(&back), bytes);
}

#[test]
fn corruption_fails_the_stored_id_check() {
    let (set, _) = vector_set();
    let hexstr = hex::encode(pack_set(&set));
    let target = hex::encode("did:key:zAlice");
    let corrupted = hexstr.replacen(&target, &hex::encode("did:key:zEvils"), 1);
    assert_ne!(corrupted, hexstr);
    let err = unpack_set(&hex::decode(corrupted).unwrap()).unwrap_err();
    assert!(err.contains("does not match stored id"), "got: {err}");
}

#[test]
fn rejects_out_of_range_indices_from_shared_vectors() {
    let vector = read("l0-pack/invalid-index.json");
    let principal = read("principal/evidence.json");
    for case in vector["cases"].as_array().unwrap() {
        let bytes = if case["source"] == "pack.json" {
            hex::decode(read("l0-pack/pack.json")["packHex"].as_str().unwrap()).unwrap()
        } else {
            let row = principal["deltas"]
                .as_array()
                .unwrap()
                .iter()
                .find(|d| d["name"] == "userRootDeclaration")
                .unwrap();
            let delta = rhizomatic::Delta {
                id: row["id"].as_str().unwrap().into(),
                claims: parse_claims(&row["claims"]).unwrap(),
                sig: Some(row["sig"].as_str().unwrap().into()),
            };
            pack_set(&DeltaSet::from_deltas([delta]).unwrap())
        };
        let mut top = decode(&bytes).unwrap();
        let CborValue::Map(fields) = &mut top else {
            panic!("expected pack map")
        };
        let section = fields
            .iter_mut()
            .find(|(key, _)| key == case["section"].as_str().unwrap())
            .unwrap();
        let CborValue::Array(records) = &mut section.1 else {
            panic!("expected records")
        };
        let field_name = case["field"].as_str().unwrap();
        let CborValue::Map(record) = records
            .iter_mut()
            .find(|record| match record {
                CborValue::Map(fields) => fields.iter().any(|(key, _)| key == field_name),
                _ => false,
            })
            .unwrap()
        else {
            panic!("expected signed record")
        };
        record
            .iter_mut()
            .find(|(key, _)| key == field_name)
            .unwrap()
            .1 = CborValue::Float(case["index"].as_f64().unwrap());
        let error = unpack_set(&encode(&top)).unwrap_err();
        assert_eq!(error, case["error"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn huge_malformed_container_lengths_fail_before_unpacking() {
    for case in read("l0-delta/cbor-invalid-length.json")
        .as_array()
        .unwrap()
    {
        let bytes = hex::decode(case["hex"].as_str().unwrap()).unwrap();
        assert_eq!(
            unpack_set(&bytes).unwrap_err(),
            case["error"].as_str().unwrap()
        );
    }
}

#[test]
fn excessive_nesting_fails_before_unpacking() {
    for case in read("l0-delta/cbor-nesting.json").as_array().unwrap() {
        if case["expected"] == "valid" {
            continue;
        }
        let hex = format!(
            "{}{}",
            case["prefixHex"]
                .as_str()
                .unwrap()
                .repeat(case["repeat"].as_u64().unwrap() as usize),
            case["suffixHex"].as_str().unwrap()
        );
        assert_eq!(
            unpack_set(&hex::decode(hex).unwrap()).unwrap_err(),
            case["expected"].as_str().unwrap()
        );
    }
}
