//! Easter egg (issue #7): a real image lives in the rhizome as a `bytes` delta.
//!
//! A dedicated round-trip test — deliberately NOT one of the minimal parity vectors — that loads a
//! real (downscaled) PNG, wraps it in a bytes target, and asserts it round-trips the JSON debug
//! profile (base64url) *and* canonical CBOR to a single stable content address. The TS witness runs
//! the mirror of this test against the SAME pinned id, so the easter egg is itself a parity check.

use rhizomatic::json_profile::{claims_to_json, parse_claims};
use rhizomatic::{canonical_bytes, compute_id, Claims, Pointer, Target};

/// The fixture is shared with the TS witness under vectors/assets/ (a non-normative binary fixture).
const BONZO: &[u8] = include_bytes!("../../../vectors/assets/bonzo.png");

fn bonzo_claims() -> Claims {
    Claims {
        timestamp: 0.0,
        author: "bonzo".to_string(),
        pointers: vec![Pointer {
            role: "avatar".to_string(),
            target: Target::Bytes {
                mime: "image/png".to_string(),
                value: BONZO.to_vec(),
            },
        }],
    }
}

#[test]
fn bonzo_round_trips_to_one_content_address() {
    let claims = bonzo_claims();
    let id = compute_id(&claims).expect("a real PNG is a valid bytes payload");
    let cbor_len = canonical_bytes(&claims).unwrap().len();

    // JSON debug profile: base64url out and back recovers the identical claims (reject-never-repair
    // means the canonical encoding is the only accepted one), and the id is unchanged.
    let reparsed = parse_claims(&claims_to_json(&claims)).expect("bonzo survives the JSON profile");
    assert_eq!(
        reparsed, claims,
        "JSON(base64url) round-trip must be lossless"
    );
    assert_eq!(
        compute_id(&reparsed).unwrap(),
        id,
        "the content address is stable across the round-trip"
    );

    eprintln!(
        "bonzo lives at {id}  ({} payload bytes, {cbor_len} canonical CBOR bytes)",
        BONZO.len()
    );

    // Cross-witness pin: the TS witness asserts this exact id. Filled from the first green run.
    assert_eq!(
        id, BONZO_ID,
        "bonzo's content address must match the pinned cross-witness value"
    );
}

/// bonzo's canonical content address — pinned here and asserted identically by the TS witness.
const BONZO_ID: &str = "1e20d1a6dc435727435c822a76c5d23ae8235e5aa6c2bf3100b7b5a9434e362601d3";
