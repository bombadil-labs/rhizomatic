//! Shared key spelling and identity comparisons for peer guards.

use rhizomatic::peer_identity::{is_canonical_peer_id, same_peer_id};
use serde_json::Value;

#[test]
fn peer_id_spelling_and_key_aliases_match_shared_vectors() {
    let path = format!(
        "{}/../../vectors/peer/peer-identity.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let vector: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in vector["canonicalCases"].as_array().unwrap() {
        assert_eq!(
            is_canonical_peer_id(case["id"].as_str().unwrap()),
            case["valid"].as_bool().unwrap()
        );
    }
    for case in vector["sameCases"].as_array().unwrap() {
        let a = case["a"].as_str().unwrap();
        let b = case["b"].as_str().unwrap();
        let expected = case["same"].as_bool().unwrap();
        assert_eq!(same_peer_id(a, b), expected);
        assert_eq!(same_peer_id(b, a), expected);
    }
}
