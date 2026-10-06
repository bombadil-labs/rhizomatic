use rhizomatic::{
    b64u,
    cbor::{encode, float_byte_length, head_byte_length, text_byte_length, CborValue},
    delta::canonical_bytes,
    json_profile::{delta_debug_delivery_size, parse_delta},
};
use serde_json::{json, Value};
#[test]
fn preferred_width_counting() {
    for (n, len) in [(0., 3), (-0., 3), (1.5, 3), (100000., 5), (1.1, 9)] {
        assert_eq!(float_byte_length(n).unwrap(), len);
        assert_eq!(
            float_byte_length(n).unwrap(),
            encode(&CborValue::Float(n)).len()
        );
    }
    for (n, len) in [(23, 1), (24, 2), (255, 2), (256, 3), (65535, 3), (65536, 5)] {
        assert_eq!(head_byte_length(n), len);
    }
    for s in ["", "é", "🐛", "abcdefghijklmnopqrstuvwx"] {
        assert_eq!(
            text_byte_length(s),
            encode(&CborValue::Tstr(s.into())).len()
        );
    }
    assert_eq!(text_byte_length("é"), 3);
    assert_eq!(text_byte_length("🐛"), 5);
    for s in ["", "AA", "AAA", "AAAA", "SGVsbG8", "__8"] {
        assert_eq!(
            b64u::decoded_length(s).unwrap(),
            b64u::decode(s).unwrap().len()
        );
    }
    for s in ["A", "AB", "AAB", "AA=", "é"] {
        assert!(b64u::decoded_length(s).is_err());
    }
}
#[test]
fn exact_size_and_saturation_do_not_mask_malformed_siblings() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../vectors/materialization/commands.json"
    ))
    .unwrap();
    let raw = corpus["positives"][0]["delivery"].as_array().unwrap();
    let size = raw
        .iter()
        .map(|v| {
            let d = parse_delta(v).unwrap();
            canonical_bytes(&d.claims).unwrap().len() + d.sig.unwrap().len() / 2
        })
        .sum::<usize>();
    assert_eq!(delta_debug_delivery_size(raw, size).unwrap(), size);
    assert_eq!(delta_debug_delivery_size(raw, size - 1).unwrap(), size);
    let mut malformed = raw.clone();
    malformed.push(json!({"id":"x","claims":{"pointers":[]},"sig":"gg"}));
    assert!(delta_debug_delivery_size(&malformed, 1).is_err());
    malformed.reverse();
    assert!(delta_debug_delivery_size(&malformed, 1).is_err());
    for v in corpus["negatives"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["id"].as_str().unwrap().starts_with("delivery_scan_"))
    {
        let result = delta_debug_delivery_size(v["delivery"].as_array().unwrap(), 1);
        if v["id"] == "delivery_scan_oversized_carrier" {
            assert_eq!(result.unwrap(), 2);
        } else {
            assert!(result.is_err());
        }
    }
}

#[test]
fn every_target_arm_context_unicode_and_validity_count_exactly() {
    let raw = json!({"id":"x","sig":"Aa00","claims":{"timestamp":-0.,"validFrom":1.5,"validUntil":100000.,"author":"é","pointers":[{"role":"r","target":true},{"role":"r","target":1.1},{"role":"r","target":"🐛"},{"role":"r","target":{"id":"","context":"ctx"}},{"role":"r","target":{"delta":"ref","context":"🐛"}},{"role":"r","target":{"mime":"text/é","value":"AAA"}}]}});
    let d = parse_delta(&raw).unwrap();
    let size = canonical_bytes(&d.claims).unwrap().len() + 2;
    assert_eq!(
        delta_debug_delivery_size(std::slice::from_ref(&raw), size).unwrap(),
        size
    );
    assert_eq!(delta_debug_delivery_size(&[raw], size - 1).unwrap(), size);
}
