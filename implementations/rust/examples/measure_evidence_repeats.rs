//! Measurement host; no timing assertion or changed semantic goldens.
use rhizomatic::hview::{HVEntry, HView};
use rhizomatic::hview_envelope::{
    decode_hview_envelope, encode_hview_envelope, HViewEnvelopeLimits,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::time::Instant;
fn main() {
    let seed = "00".repeat(32);
    let author = rhizomatic::sign::author_for_seed(&seed).unwrap();
    let claims = rhizomatic::json_profile::parse_claims(&json!({
        "author":author,"timestamp":10,"validFrom":0,
        "pointers":[{"role":"subject","target":{"id":"item:fern","context":"height"}},{"role":"value","target":42}]
    })).unwrap();
    let delta = rhizomatic::sign::sign_claims(&claims, &seed).unwrap();
    let args: Vec<_> = std::env::args().skip(1).collect();
    let counts: Vec<usize> = if args.is_empty() {
        vec![1000, 16384]
    } else {
        args.iter().map(|s| s.parse().unwrap()).collect()
    };
    for count in counts {
        assert!((1..=16384).contains(&count));
        let view = HView {
            id: "item:fern".into(),
            props: BTreeMap::from([(
                "height".into(),
                vec![
                    HVEntry {
                        delta: delta.clone(),
                        negated: false,
                        expanded: BTreeMap::new(),
                        readings: BTreeMap::new()
                    };
                    count
                ],
            )]),
        };
        let before = Instant::now();
        let bytes = encode_hview_envelope(&view, HViewEnvelopeLimits::default()).unwrap();
        let encode_ms = before.elapsed().as_secs_f64() * 1000.0;
        let before = Instant::now();
        let decoded = decode_hview_envelope(&bytes, HViewEnvelopeLimits::default()).unwrap();
        let decode_ms = before.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(decoded.props["height"].len(), count);
        println!(
            "{}",
            json!({"witness":"rust-release","entries":count,"distinctSignedAppearances":1,"artifactBytes":bytes.len(),"transportId":rhizomatic::hash::content_address(&bytes),"encodeMs":encode_ms,"decodeMs":decode_ms})
        );
    }
}
