//! `vectors/store/digest.json` (SPEC-18 proposal §4.7.6; `vectors/store/README.md` §12). The Rust
//! stores take the holdings digest in step 4e of slice 4. Until then this witness checks the hash
//! construction alone against every tree of the file, byte for byte with the TypeScript witness,
//! and checks that every store case requires `digest`, which the Rust stores do not declare. So a
//! runner skips each store case, as README §3 says.

use rhizomatic::cbor::{encode, CborValue};
use rhizomatic::hash::content_address;
use rhizomatic::memory_store::memory_store_profile;
use serde_json::Value;

fn document() -> Value {
    let path = format!(
        "{}/../../vectors/store/digest.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read digest.json")).unwrap()
}

fn leaf(ids: &[&str]) -> String {
    let ids = ids.iter().map(|id| CborValue::Tstr((*id).into())).collect();
    content_address(&encode(&CborValue::Array(vec![
        CborValue::Tstr("rhizomatic.digest.leaf".into()),
        CborValue::Array(ids),
    ])))
}

/// The node of `prefix` over `ids`, ascending: (count, hash). README §12.1.
fn node(ids: &[&str], prefix: &str) -> (usize, String) {
    let under: Vec<&str> = ids
        .iter()
        .copied()
        .filter(|id| id.starts_with(prefix))
        .collect();
    if under.len() <= 16 {
        return (under.len(), leaf(&under));
    }
    let children = "0123456789abcdef"
        .chars()
        .map(|digit| {
            let (count, hash) = node(&under, &format!("{prefix}{digit}"));
            CborValue::Array(vec![CborValue::Float(count as f64), CborValue::Tstr(hash)])
        })
        .collect();
    let hash = content_address(&encode(&CborValue::Array(vec![
        CborValue::Tstr("rhizomatic.digest.node".into()),
        CborValue::Array(children),
    ])));
    (under.len(), hash)
}

#[test]
fn every_tree_of_digest_json_has_the_nodes_this_witness_hashes() {
    let doc = document();
    assert_eq!(doc["format"], "rhizomatic-store-digest/1");
    assert_eq!(doc["hash"]["empty"].as_str().unwrap(), leaf(&[]));
    let trees = doc["trees"].as_array().unwrap();
    assert!(trees.len() >= 10);
    let mut checked = 0;
    for tree in trees {
        let mut ids: Vec<&str> = tree["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect();
        ids.sort_unstable();
        for list in ["nodes", "probes"] {
            for expected in tree[list].as_array().unwrap() {
                let prefix = expected["prefix"].as_str().unwrap();
                let (count, hash) = node(&ids, prefix);
                assert_eq!(
                    (count as u64, hash.as_str()),
                    (
                        expected["count"].as_u64().unwrap(),
                        expected["hash"].as_str().unwrap()
                    ),
                    "tree {}, prefix {prefix:?}",
                    tree["name"]
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 500, "checked {checked} nodes");
}

#[test]
fn every_store_case_of_digest_json_requires_digest_which_the_rust_stores_do_not_declare_until_step_4e(
) {
    let doc = document();
    let cases = doc["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        assert_eq!(
            case["requires"],
            serde_json::json!(["digest"]),
            "{}",
            case["name"]
        );
    }
    assert!(!memory_store_profile().capabilities.digest);
}
