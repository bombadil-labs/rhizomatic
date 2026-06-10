//! Evaluator vectors + law-level property tests. Mirrors ../ts/test/eval.test.ts.

use proptest::prelude::*;
use rhizomatic::eval::{eval_term, result_canonical_hex, MaskPolicy, Term};
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
        let result = eval_term(&term, &input);
        let expected_ids: Vec<&str> = c["expected"]["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert_eq!(result.set.ids(), expected_ids, "ids mismatch for {name}");
        if let Some(neg) = c["expected"].get("negated") {
            let expected_neg: Vec<&str> = neg
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap())
                .collect();
            let actual_neg: Vec<&str> = result.negated.iter().map(String::as_str).collect();
            assert_eq!(actual_neg, expected_neg, "negated mismatch for {name}");
        }
        assert_eq!(
            result_canonical_hex(&result),
            c["expectedCanonicalHex"].as_str().unwrap(),
            "canonical result mismatch for {name}"
        );
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

proptest! {
    #[test]
    fn select_composes_by_conjunction(d in delta_set(), p in pred(), q in pred()) {
        let nested = eval_term(&select(p.clone(), select(q.clone(), Term::Input)), &d);
        let conj = eval_term(&select(Pred::And(Box::new(p), Box::new(q)), Term::Input), &d);
        prop_assert_eq!(nested.set.digest(), conj.set.digest());
    }

    #[test]
    fn select_is_monotone(a in delta_set(), b in delta_set(), p in pred()) {
        let small = eval_term(&select(p.clone(), Term::Input), &a);
        let big = eval_term(&select(p, Term::Input), &merge(&a, &b));
        for d in small.set.iter() {
            prop_assert!(big.set.contains(&d.id));
        }
    }

    #[test]
    fn mask_drop_is_subset(d in delta_set()) {
        let masked = eval_term(&Term::Mask { policy: MaskPolicy::Drop, of: Box::new(Term::Input) }, &d);
        for x in masked.set.iter() {
            prop_assert!(d.contains(&x.id));
        }
    }

    #[test]
    fn union_of_selects_is_select_of_or(d in delta_set(), p in pred(), q in pred()) {
        let via_union = eval_term(&Term::Union {
            left: Box::new(select(p.clone(), Term::Input)),
            right: Box::new(select(q.clone(), Term::Input)),
        }, &d);
        let via_or = eval_term(&select(Pred::Or(Box::new(p), Box::new(q)), Term::Input), &d);
        prop_assert_eq!(via_union.set.digest(), via_or.set.digest());
    }

    #[test]
    fn select_agrees_with_fork(d in delta_set(), p in pred()) {
        let via_term = eval_term(&select(p.clone(), Term::Input), &d);
        let via_fork = fork(&d, |x: &Delta| eval_pred(&p, x));
        prop_assert_eq!(via_term.set.digest(), via_fork.digest());
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
