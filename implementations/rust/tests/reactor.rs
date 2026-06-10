//! Reactor core tests. Mirrors ../ts/test/reactor.test.ts.

use proptest::prelude::*;
use rhizomatic::eval::result_canonical_hex;
use rhizomatic::json_profile::parse_claims;
use rhizomatic::reactor::{IngestResult, Reactor};
use rhizomatic::set::{make_delta, DeltaSet};
use rhizomatic::sign::{author_for_seed, sign_claims};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Delta, Primitive, Target};
use serde_json::{json, Value};

fn read(rel: &str) -> Value {
    let path = format!("{}/../../vectors/{rel}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vector file")).unwrap()
}

fn fixture(rel: &str) -> Vec<Delta> {
    read(rel)["fixture"]["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap())
        .collect()
}

fn ingest_all(deltas: &[Delta]) -> Reactor {
    let mut r = Reactor::new();
    for d in deltas {
        assert_eq!(r.ingest(d.clone()), IngestResult::Accepted);
    }
    r
}

#[test]
fn ingest_accept_duplicate_reject() {
    let deltas = fixture("l1-eval/eval-basic.json");
    let mut r = Reactor::new();
    assert_eq!(r.ingest(deltas[0].clone()), IngestResult::Accepted);
    assert_eq!(r.ingest(deltas[0].clone()), IngestResult::Duplicate);
    assert_eq!(r.len(), 1);
    assert_eq!(r.arrival_log().len(), 1);

    // forged content address: rejected, no trace
    let mut forged = deltas[1].clone();
    forged.id = format!("1e20{}", "00".repeat(32));
    assert!(matches!(r.ingest(forged), IngestResult::Rejected(_)));
    assert_eq!(r.len(), 1);
}

#[test]
fn signed_accept_and_tamper_reject() {
    let keys = read("keys/keys.json");
    let seed = keys[0]["seedHex"].as_str().unwrap();
    let claims = parse_claims(&json!({
        "timestamp": 5,
        "author": author_for_seed(seed).unwrap(),
        "pointers": [{ "role": "x", "target": { "value": "y" } }]
    }))
    .unwrap();
    let signed = sign_claims(&claims, seed).unwrap();
    let mut r = Reactor::new();
    assert_eq!(r.ingest(signed.clone()), IngestResult::Accepted);

    let mut flipped = signed;
    let sig = flipped.sig.take().unwrap();
    let first = if &sig[0..1] == "0" { "1" } else { "0" };
    flipped.sig = Some(format!("{first}{}", &sig[1..]));
    let mut r2 = Reactor::new();
    assert_eq!(
        r2.ingest(flipped),
        IngestResult::Rejected("signature does not verify".to_string())
    );
}

#[test]
fn indexes_agree_with_full_scans() {
    let deltas = fixture("l1-eval/eval-basic.json");
    let r = ingest_all(&deltas);
    let brute = |pred: &dyn Fn(&Delta) -> bool| -> Vec<String> {
        let mut v: Vec<String> = deltas
            .iter()
            .filter(|d| pred(d))
            .map(|d| d.id.clone())
            .collect();
        v.sort();
        v
    };
    for entity in ["movie:matrix", "movie:johnwick", "nope"] {
        assert_eq!(
            r.by_target(entity),
            brute(&|d: &Delta| d
                .claims
                .pointers
                .iter()
                .any(|p| matches!(&p.target, Target::Entity(er) if er.id == entity)))
        );
    }
    for d in &deltas {
        assert_eq!(
            r.negations_of(&d.id),
            brute(&|n: &Delta| n.claims.pointers.iter().any(|p| {
                p.role == "negates" && matches!(&p.target, Target::Delta(dr) if dr.delta == d.id)
            }))
        );
    }
}

#[test]
fn value_index_agrees_with_evaluation() {
    let deltas = fixture("l1-eval/eval-resolve.json");
    let r = ingest_all(&deltas);
    let via_index = r.by_value_between("value", &Primitive::Num(5.0), &Primitive::Num(2000.0));
    let term = parse_term(&json!({
        "op": "select",
        "pred": { "hasPointer": { "role": { "exact": "value" }, "targetValue": { "between": [5, 2000] } } },
        "in": "input"
    }))
    .unwrap();
    let result = r.eval(&term, None, None).unwrap();
    let rhizomatic::eval::EvalResult::DSet { set, .. } = result else {
        panic!("expected dset");
    };
    let via_eval: Vec<String> = set.ids().iter().map(|s| s.to_string()).collect();
    assert_eq!(via_index, via_eval);
}

proptest! {
    #[test]
    fn any_ingestion_order_converges(seed in any::<u64>()) {
        let deltas = fixture("l1-eval/eval-basic.json");
        let reference = ingest_all(&deltas);
        let term = parse_term(&json!({ "op": "mask", "policy": "drop", "in": "input" })).unwrap();
        let ref_eval = result_canonical_hex(&reference.eval(&term, None, None).unwrap());

        // deterministic permutation from the seed
        let mut perm = deltas.clone();
        let mut s = seed;
        for i in (1..perm.len()).rev() {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let j = (s >> 33) as usize % (i + 1);
            perm.swap(i, j);
        }
        let r = ingest_all(&perm);
        prop_assert_eq!(r.digest(), reference.digest());
        for d in &deltas {
            prop_assert_eq!(r.negations_of(&d.id), reference.negations_of(&d.id));
        }
        prop_assert_eq!(r.by_target("movie:matrix"), reference.by_target("movie:matrix"));
        prop_assert_eq!(result_canonical_hex(&r.eval(&term, None, None).unwrap()), ref_eval.clone());
    }
}

#[test]
fn negation_before_target_converges() {
    let doc = read("l1-eval/eval-basic.json");
    let names: Vec<&str> = doc["fixture"]["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["name"].as_str().unwrap())
        .collect();
    let deltas = fixture("l1-eval/eval-basic.json");
    let idx = |n: &str| names.iter().position(|x| *x == n).unwrap();
    let d2 = deltas[idx("d2-title-reloaded")].clone();
    let d4 = deltas[idx("d4-negates-d2")].clone();
    let mut order = vec![d4.clone(), d2.clone()];
    order.extend(
        deltas
            .iter()
            .filter(|d| d.id != d2.id && d.id != d4.id)
            .cloned(),
    );
    let r = ingest_all(&order);
    assert_eq!(
        r.digest(),
        DeltaSet::from_deltas(deltas.clone()).unwrap().digest()
    );
    assert_eq!(r.negations_of(&d2.id), vec![d4.id.clone()]);
    // read-your-writes
    assert!(r.contains(&d2.id));
}
