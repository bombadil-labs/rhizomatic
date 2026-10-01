use rhizomatic::json_profile::parse_delta;
use rhizomatic::sign::{verify_canonical_delta, verify_delta, Verification};
use serde_json::Value;
#[test]
fn canonical_signed_description_rejects_uppercase_without_changing_legacy_verification() {
    let vectors: Value = serde_json::from_slice(
        &std::fs::read(format!(
            "{}/../../vectors/command/execution.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    let mut delta = parse_delta(&vectors["fixtures"]["first"]).unwrap();
    assert_eq!(verify_canonical_delta(&delta), Verification::Verified);
    delta.sig = delta.sig.map(|s| s.to_uppercase());
    assert_eq!(verify_delta(&delta), Verification::Verified);
    assert_eq!(verify_canonical_delta(&delta), Verification::Invalid);
}
