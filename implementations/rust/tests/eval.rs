//! Evaluator vectors + law-level property tests. Mirrors ../ts/test/eval.test.ts.

use std::collections::BTreeSet;

use proptest::prelude::*;
use rhizomatic::eval::{eval_term, result_canonical_hex, EvalResult, MaskPolicy, Term};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::pred::{eval_pred, Pred};
use rhizomatic::set::{fork, make_delta, merge, DeltaSet};
use rhizomatic::term_json::{parse_pred, parse_term};
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};
use serde_json::{json, Value};

fn load_eval_basic() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-basic.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-basic.json")).unwrap()
}

fn fixture_set(doc: &Value) -> DeltaSet {
    DeltaSet::from_deltas(
        doc["fixture"]["deltas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap()),
    )
    .unwrap()
}

fn as_dset(r: EvalResult) -> (DeltaSet, BTreeSet<String>) {
    match r {
        EvalResult::DSet { set, negated, .. } => (set, negated),
        _ => panic!("expected a DSet result"),
    }
}

#[test]
fn fixture_ids_match() {
    let doc = load_eval_basic();
    for d in doc["fixture"]["deltas"].as_array().unwrap() {
        let delta = make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, d["id"].as_str().unwrap(), "{}", d["name"]);
    }
}

#[test]
fn eval_vectors() {
    let doc = load_eval_basic();
    let input = fixture_set(&doc);
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap_or_else(|e| panic!("parse {name}: {e}"));
        let result = eval_term(&term, &input, None, None, None).unwrap();
        let hex = result_canonical_hex(&result);
        let (set, negated) = as_dset(result);
        let expected_ids: Vec<&str> = c["expected"]["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert_eq!(set.ids(), expected_ids, "ids mismatch for {name}");
        if let Some(neg) = c["expected"].get("negated") {
            let expected_neg: Vec<&str> = neg
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap())
                .collect();
            let actual_neg: Vec<&str> = negated.iter().map(String::as_str).collect();
            assert_eq!(actual_neg, expected_neg, "negated mismatch for {name}");
        }
        assert_eq!(
            hex,
            c["expectedCanonicalHex"].as_str().unwrap(),
            "canonical result mismatch for {name}"
        );
    }
}

// --- set algebra vectors: difference/intersect (SPEC-2 §4.9, ERRATA-2 E17) -------------------------

fn load_eval_set_algebra() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-setalgebra.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-setalgebra.json"))
        .unwrap()
}

#[test]
fn set_algebra_fixture_ids_match() {
    let doc = load_eval_set_algebra();
    for d in doc["fixture"]["deltas"].as_array().unwrap() {
        let delta = make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, d["id"].as_str().unwrap(), "{}", d["name"]);
    }
}

#[test]
fn set_algebra_vectors() {
    let doc = load_eval_set_algebra();
    let input = fixture_set(&doc);
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap_or_else(|e| panic!("parse {name}: {e}"));
        let result = eval_term(&term, &input, None, None, None).unwrap();
        let hex = result_canonical_hex(&result);
        let (set, _) = as_dset(result);
        let expected_ids: Vec<&str> = c["expected"]["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert_eq!(set.ids(), expected_ids, "ids mismatch for {name}");
        assert_eq!(
            hex,
            c["expectedCanonicalHex"].as_str().unwrap(),
            "canonical result mismatch for {name}"
        );
    }
}

/// The §8 fail-closed guards: rejection is either parse-time (unknown op, wrong operand keys) or
/// eval-time (HView operand, E9) — so drive parse ∘ eval and assert the term is rejected somewhere,
/// never partially evaluated.
#[test]
fn set_algebra_rejects() {
    let doc = load_eval_set_algebra();
    let input = fixture_set(&doc);
    for r in doc["rejects"].as_array().unwrap() {
        let name = r["name"].as_str().unwrap();
        let rejected = match parse_term(&r["term"]) {
            Err(_) => true,
            Ok(t) => eval_term(&t, &input, None, None, None).is_err(),
        };
        assert!(rejected, "expected rejection for {name}");
    }
}

// --- property tests --------------------------------------------------------------------------------

fn pointer() -> impl Strategy<Value = Pointer> {
    (
        prop_oneof![Just("r1"), Just("r2"), Just("negates")],
        prop_oneof![
            prop_oneof![Just("x"), Just("y")]
                .prop_map(|v| Target::Primitive(Primitive::Str(v.to_string()))),
            prop_oneof![Just("e1"), Just("e2")].prop_map(|id| Target::Entity(EntityRef {
                id: id.to_string(),
                context: Some("c1".to_string()),
            })),
        ],
    )
        .prop_map(|(role, target)| Pointer {
            role: role.to_string(),
            target,
        })
}

fn claims() -> impl Strategy<Value = Claims> {
    (
        0..1000i64,
        prop_oneof![Just("did:key:zA"), Just("did:key:zB")],
        proptest::collection::vec(pointer(), 1..=2),
    )
        .prop_map(|(ts, author, pointers)| Claims {
            timestamp: ts as f64,
            author: author.to_string(),
            pointers,
        })
}

fn delta_set() -> impl Strategy<Value = DeltaSet> {
    proptest::collection::vec(claims().prop_map(|c| make_delta(c, None).unwrap()), 0..=15)
        .prop_map(|ds| DeltaSet::from_deltas(ds).unwrap())
}

fn pred_pool() -> Vec<Pred> {
    [
        json!({ "match": { "field": "author", "cmp": "eq", "const": "did:key:zA" } }),
        json!({ "match": { "field": "timestamp", "cmp": "lte", "const": 500 } }),
        json!({ "hasPointer": { "role": { "exact": "r1" } } }),
        json!({ "hasPointer": { "targetEntity": "e1" } }),
        json!("true"),
        json!({ "not": { "match": { "field": "author", "cmp": "eq", "const": "did:key:zA" } } }),
    ]
    .iter()
    .map(|v| parse_pred(v).unwrap())
    .collect()
}

fn pred() -> impl Strategy<Value = Pred> {
    (0..6usize).prop_map(|i| pred_pool()[i].clone())
}

fn select(p: Pred, of: Term) -> Term {
    Term::Select {
        pred: p,
        of: Box::new(of),
    }
}

fn eval_dset(term: &Term, input: &DeltaSet) -> DeltaSet {
    as_dset(eval_term(term, input, None, None, None).unwrap()).0
}

proptest! {
    #[test]
    fn select_composes_by_conjunction(d in delta_set(), p in pred(), q in pred()) {
        let nested = eval_dset(&select(p.clone(), select(q.clone(), Term::Input)), &d);
        let conj = eval_dset(&select(Pred::And(Box::new(p), Box::new(q)), Term::Input), &d);
        prop_assert_eq!(nested.digest(), conj.digest());
    }

    #[test]
    fn select_is_monotone(a in delta_set(), b in delta_set(), p in pred()) {
        let small = eval_dset(&select(p.clone(), Term::Input), &a);
        let big = eval_dset(&select(p, Term::Input), &merge(&a, &b));
        for d in small.iter() {
            prop_assert!(big.contains(&d.id));
        }
    }

    #[test]
    fn mask_drop_is_subset(d in delta_set()) {
        let masked = eval_dset(&Term::Mask { policy: MaskPolicy::Drop, of: Box::new(Term::Input) }, &d);
        for x in masked.iter() {
            prop_assert!(d.contains(&x.id));
        }
    }

    #[test]
    fn union_of_selects_is_select_of_or(d in delta_set(), p in pred(), q in pred()) {
        let via_union = eval_dset(&Term::Union {
            left: Box::new(select(p.clone(), Term::Input)),
            right: Box::new(select(q.clone(), Term::Input)),
        }, &d);
        let via_or = eval_dset(&select(Pred::Or(Box::new(p), Box::new(q)), Term::Input), &d);
        prop_assert_eq!(via_union.digest(), via_or.digest());
    }

    #[test]
    fn select_agrees_with_fork(d in delta_set(), p in pred()) {
        let via_term = eval_dset(&select(p.clone(), Term::Input), &d);
        let via_fork = fork(&d, |x: &Delta| eval_pred(&p, x, None));
        prop_assert_eq!(via_term.digest(), via_fork.digest());
    }
}

// --- NFC boundary (ERRATA D11) -----------------------------------------------------------------------

#[test]
fn rejects_decomposed_role() {
    let decomposed = "cafe\u{0301}"; // NFD form of café
    let claims = Claims {
        timestamp: 0.0,
        author: "a".to_string(),
        pointers: vec![Pointer {
            role: decomposed.to_string(),
            target: Target::Primitive(Primitive::Num(1.0)),
        }],
    };
    let err = make_delta(claims, None).unwrap_err();
    assert!(err.contains("NFC"), "got: {err}");
}

#[test]
fn accepts_composed_role() {
    let composed = "caf\u{e9}"; // NFC form of café
    let claims = Claims {
        timestamp: 0.0,
        author: "a".to_string(),
        pointers: vec![Pointer {
            role: composed.to_string(),
            target: Target::Primitive(Primitive::Num(1.0)),
        }],
    };
    assert!(make_delta(claims, None).unwrap().id.starts_with("1e20"));
}
