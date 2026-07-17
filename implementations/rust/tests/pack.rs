//! Pack round-trip + the cross-impl pack vector. Mirrors ../ts/test/pack.test.ts.

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
