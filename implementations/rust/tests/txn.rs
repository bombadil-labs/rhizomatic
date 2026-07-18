//! Transaction manifests + atomic bundles (SPEC-1 §9 / SPEC-4 §6). Mirrors ../ts/test/txn.test.ts.

use rhizomatic::json_profile::parse_claims;
use rhizomatic::reactor::{make_manifest_claims, manifest_member_ids, IngestResult, Reactor};
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::make_delta;
use rhizomatic::term_json::parse_term;
use rhizomatic::types::Delta;
use serde_json::Value;

fn world() -> (Vec<Delta>, SchemaRegistry) {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-expand.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-expand.json"))
            .unwrap();
    let deltas = doc["fixture"]["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap())
        .collect();
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
        vec![],
    )
    .unwrap();
    (deltas, reg)
}

fn manifest_for(members: &[Delta], intent: Option<&str>) -> Delta {
    let ids: Vec<String> = members.iter().map(|m| m.id.clone()).collect();
    make_delta(
        make_manifest_claims("did:key:zBundler", 5000.0, &ids, None, intent),
        None,
    )
    .unwrap()
}

#[test]
fn manifests_are_ordinary_deltas() {
    let (deltas, _) = world();
    let manifest = manifest_for(&deltas[..3], Some("test bundle"));
    assert!(manifest.id.starts_with("1e20"));
    assert_eq!(
        manifest_member_ids(&manifest),
        deltas[..3].iter().map(|d| d.id.clone()).collect::<Vec<_>>()
    );
}

#[test]
fn atomic_bundle_dispatches_in_one_step() {
    let (deltas, reg) = world();
    let mut r = Reactor::new();
    let body = reg.get("MovieDeep").unwrap().body.clone();
    r.register("deep", body, &["movie:matrix".to_string()], Some(reg))
        .unwrap();
    let manifest = manifest_for(&deltas, None);
    assert_eq!(
        r.ingest_bundle(manifest.clone(), &deltas),
        IngestResult::Accepted
    );
    // one refresh produced exactly one change event for the whole bundle
    assert_eq!(r.changes_from_last_ingest().len(), 1);
    let change = &r.changes_from_last_ingest()[0];
    assert!(change.responsible_delta_ids.contains(&deltas[0].id));
    assert!(r.holds_all_members(&manifest.id));
}

#[test]
fn invalid_member_rejects_the_whole_bundle() {
    let (deltas, _) = world();
    let mut r = Reactor::new();
    let mut bad = deltas[1].clone();
    bad.id = format!("1e20{}", "00".repeat(32));
    let members = vec![deltas[0].clone(), bad];
    let manifest = manifest_for(&members, None);
    assert!(matches!(
        r.ingest_bundle(manifest, &members),
        IngestResult::Rejected(_)
    ));
    assert_eq!(r.len(), 0);
}

#[test]
fn unclaimed_member_rejects_the_bundle() {
    let (deltas, _) = world();
    let mut r = Reactor::new();
    let manifest = manifest_for(&deltas[..1], None);
    let members = vec![deltas[0].clone(), deltas[1].clone()];
    assert!(matches!(
        r.ingest_bundle(manifest, &members),
        IngestResult::Rejected(_)
    ));
    assert_eq!(r.len(), 0);
}

#[test]
fn completeness_is_a_hash_check() {
    let (deltas, _) = world();
    let mut r = Reactor::new();
    let manifest = manifest_for(&deltas[..2], None);
    r.ingest(deltas[0].clone());
    r.ingest(manifest.clone());
    assert!(!r.holds_all_members(&manifest.id));
    r.ingest(deltas[1].clone());
    assert!(r.holds_all_members(&manifest.id));
}
