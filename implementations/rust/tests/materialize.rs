//! Incremental equivalence (SPEC-4 §1) — the reactor's defining contract.
//! Mirrors ../ts/test/materialize.test.ts.

use proptest::prelude::*;
use rhizomatic::eval::{eval_term, result_canonical_hex, Term};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::reactor::{IngestResult, Reactor};
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, make_negation_claims, DeltaSet};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::Delta;
use serde_json::{json, Value};

fn world() -> (Vec<Delta>, SchemaRegistry, Term) {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-expand.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-expand.json"))
            .unwrap();
    let mut deltas: Vec<Delta> = doc["fixture"]["deltas"]
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
    )
    .unwrap();
    let body = reg.get("MovieDeep").unwrap().body.clone();
    // Extend with a negation chain over the cast edge (index 3 = c1-cast).
    let c1_id = deltas[3].id.clone();
    let n1 = make_delta(
        make_negation_claims("did:key:zNeg", 900.0, &c1_id, None),
        None,
    )
    .unwrap();
    let n2 = make_delta(
        make_negation_claims("did:key:zNeg", 950.0, &n1.id, None),
        None,
    )
    .unwrap();
    deltas.push(n1);
    deltas.push(n2);
    (deltas, reg, body)
}

fn batch_hex(term: &Term, set: &DeltaSet, root: &str, reg: &SchemaRegistry) -> String {
    result_canonical_hex(&eval_term(term, set, Some(root), Some(reg)).unwrap())
}

proptest! {
    #[test]
    fn incremental_equals_batch_after_every_ingest(seed in any::<u64>()) {
        let (deltas, reg, body) = world();
        let bag = parse_term(&json!({ "op": "group", "key": { "const": "all" }, "in": "input" })).unwrap();

        let mut perm = deltas.clone();
        let mut s = seed;
        for i in (1..perm.len()).rev() {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let j = (s >> 33) as usize % (i + 1);
            perm.swap(i, j);
        }

        let roots = ["movie:matrix".to_string(), "movie:brzrkr".to_string()];
        let mut r = Reactor::new();
        r.register("deep", body.clone(), &roots, Some(reg.clone())).unwrap();
        r.register("bag", bag.clone(), &roots[..1], Some(reg.clone())).unwrap();
        let mut grow = DeltaSet::new();
        for d in perm {
            prop_assert_eq!(r.ingest(d.clone()), IngestResult::Accepted);
            grow.add(d).unwrap();
            for root in &roots {
                prop_assert_eq!(
                    r.materialized_hex("deep", root).unwrap(),
                    batch_hex(&body, &grow, root, &reg)
                );
            }
            prop_assert_eq!(
                r.materialized_hex("bag", "movie:matrix").unwrap(),
                batch_hex(&bag, &grow, "movie:matrix", &reg)
            );
        }
    }
}

#[test]
fn negation_chain_suppresses_then_reinstates() {
    let (deltas, reg, body) = world();
    let (base, chain) = deltas.split_at(deltas.len() - 2);
    let mut r = Reactor::new();
    let roots = ["movie:matrix".to_string()];
    r.register("deep", body, &roots, Some(reg)).unwrap();
    for d in base {
        r.ingest(d.clone());
    }
    let with_cast = r
        .materialized_hex("deep", "movie:matrix")
        .unwrap()
        .to_string();

    r.ingest(chain[0].clone()); // n1 suppresses c1
    let suppressed = r
        .materialized_hex("deep", "movie:matrix")
        .unwrap()
        .to_string();
    assert_ne!(suppressed, with_cast);

    r.ingest(chain[1].clone()); // n2 reinstates c1
    assert_eq!(
        r.materialized_hex("deep", "movie:matrix").unwrap(),
        with_cast
    );
}

#[test]
fn dispatch_skips_irrelevant_deltas_for_anchored_terms() {
    let (deltas, reg, body) = world();
    let mut r = Reactor::new();
    let roots = ["movie:matrix".to_string()];
    r.register("deep", body, &roots, Some(reg)).unwrap();
    for d in &deltas[..deltas.len() - 2] {
        r.ingest(d.clone());
    }
    let before = r.eval_count_of("deep");
    let stranger = make_delta(
        parse_claims(&json!({
            "timestamp": 9999,
            "author": "did:key:zStranger",
            "pointers": [
                { "role": "subject", "target": { "id": "movie:unrelated", "context": "title" } },
                { "role": "value", "target": "Speed" }
            ]
        }))
        .unwrap(),
        None,
    )
    .unwrap();
    r.ingest(stranger);
    assert_eq!(r.eval_count_of("deep"), before); // not even re-evaluated
    assert!(r.changes_from_last_ingest().is_empty());
}

#[test]
fn expanded_entity_deltas_rematerialize_the_parent() {
    let (deltas, reg, body) = world();
    let base = &deltas[..deltas.len() - 2];
    let mut r = Reactor::new();
    let roots = ["movie:matrix".to_string()];
    r.register("deep", body.clone(), &roots, Some(reg.clone()))
        .unwrap();
    for d in base {
        r.ingest(d.clone());
    }
    let before = r
        .materialized_hex("deep", "movie:matrix")
        .unwrap()
        .to_string();
    let award = make_delta(
        parse_claims(&json!({
            "timestamp": 1500,
            "author": "did:key:zCritic",
            "pointers": [
                { "role": "subject", "target": { "id": "actor:keanu", "context": "award" } },
                { "role": "value", "target": "Best Stoic" }
            ]
        }))
        .unwrap(),
        None,
    )
    .unwrap();
    r.ingest(award.clone());
    let after = r
        .materialized_hex("deep", "movie:matrix")
        .unwrap()
        .to_string();
    assert_ne!(after, before);
    let mut grow = DeltaSet::from_deltas(base.to_vec()).unwrap();
    grow.add(award).unwrap();
    assert_eq!(after, batch_hex(&body, &grow, "movie:matrix", &reg));
}
