//! Anchored reads (SPEC-17 proposal): the shared vectors, and a property test that an anchored
//! read answers exactly what a whole-set evaluation answers. Mirrors ../ts/test/anchored.test.ts.

use std::collections::{BTreeMap, BTreeSet};

use proptest::prelude::*;
use rhizomatic::anchored::{anchor_analysis, scope_ids, AnchorAnalysis};
use rhizomatic::eval::{eval_term_at, result_canonical_hex};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::reactor::{IngestResult, Reactor};
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, make_negation_claims};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};
use serde_json::{json, Value};

fn load() -> Value {
    let path = format!(
        "{}/../../vectors/l1-eval/eval-anchored.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read eval-anchored.json")).unwrap()
}

fn registry_of(schemas: &[Value]) -> SchemaRegistry {
    SchemaRegistry::build(
        schemas
            .iter()
            .map(|s| HyperSchema {
                name: s["name"].as_str().unwrap().to_string(),
                alg: s["alg"].as_u64().unwrap() as u32,
                body: parse_term(&s["body"]).unwrap(),
            })
            .collect(),
        vec![],
    )
    .unwrap()
}

fn analysis_json(a: &AnchorAnalysis) -> Value {
    match a {
        AnchorAnalysis::Anchored { anchors } => json!({ "anchored": true, "anchors": anchors }),
        AnchorAnalysis::Unanchored(r) => json!({ "anchored": false, "reason": r.as_str() }),
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn anchored_vectors() {
    let doc = load();
    let mut fixture = Reactor::new();
    let mut name_of = BTreeMap::new();
    let mut id_of = BTreeMap::new();
    for d in doc["fixture"]["deltas"].as_array().unwrap() {
        let delta = make_delta(parse_claims(&d["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, d["id"].as_str().unwrap());
        let name = d["name"].as_str().unwrap().to_string();
        name_of.insert(delta.id.clone(), name.clone());
        id_of.insert(name, delta.id.clone());
        assert_eq!(fixture.ingest(delta), IngestResult::Accepted);
    }
    let names = |ids: &[String]| -> Vec<String> {
        ids.iter()
            .map(|id| name_of.get(id).cloned().unwrap_or_else(|| id.clone()))
            .collect()
    };
    let registry = registry_of(doc["schemas"].as_array().unwrap());

    for c in doc["scopeCases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let excluded: BTreeSet<String> = c
            .get("excluded")
            .map(|v| strings(v).iter().map(|n| id_of[n].clone()).collect())
            .unwrap_or_default();
        let admits = |d: &Delta| !excluded.contains(&d.id);
        let entities = strings(&c["entities"]);
        let members = scope_ids(&fixture, entities.iter().map(String::as_str), Some(&admits));
        assert_eq!(
            names(&members),
            strings(&c["expectedMembers"]),
            "scope: {name}"
        );
    }

    for c in doc["analysisCases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap_or_else(|e| panic!("parse {name}: {e}"));
        let got = analysis_json(&anchor_analysis(&term, Some(&registry), None));
        assert_eq!(got, c["expected"], "analysis: {name}");
    }

    for c in doc["readCases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap();
        let root = c["root"].as_str().unwrap();
        let now = c["now"].as_f64().unwrap();
        let read = fixture
            .eval_anchored(&term, now, root, Some(&registry), None, None)
            .unwrap_or_else(|e| panic!("read {name}: {e}"));
        assert_eq!(
            read.scope,
            strings(&c["expectedScope"]),
            "read scope: {name}"
        );
        assert_eq!(
            names(&read.members),
            strings(&c["expectedMembers"]),
            "read members: {name}"
        );
        let expected = c["expectedCanonicalHex"].as_str().unwrap();
        assert_eq!(result_canonical_hex(&read.result), expected, "read: {name}");
        let whole = eval_term_at(
            &term,
            &fixture.snapshot(),
            now,
            Some(root),
            Some(&registry),
            None,
        )
        .unwrap();
        assert_eq!(result_canonical_hex(&whole), expected, "whole: {name}");
    }
}

// --- the property: anchored equals whole, on random stores ---------------------------------------

const ENTITIES: [&str; 8] = ["e0", "e1", "e2", "e3", "e4", "e5", "e6", "grants"];
const AUTHORS: [&str; 3] = ["did:key:zA", "did:key:zB", "did:key:zC"];
const ROLES: [&str; 4] = ["subject", "child", "value", "other"];
const CONTEXTS: [&str; 3] = ["name", "height", "parts"];

fn leaf() -> Value {
    json!({
        "op": "group", "key": "byTargetContext",
        "in": { "op": "select", "pred": { "hasPointer": { "targetEntity": { "var": "root" } } },
                "in": { "op": "mask", "policy": "drop", "in": "input" } }
    })
}

fn property_registry() -> SchemaRegistry {
    registry_of(&[
        json!({ "name": "Leaf", "alg": 1, "body": leaf() }),
        json!({ "name": "Mid", "alg": 1,
                "body": { "op": "expand", "role": { "exact": "child" }, "schema": "Leaf", "in": leaf() } }),
        json!({ "name": "Tree", "alg": 1,
                "body": { "op": "expand", "role": { "exact": "child" }, "schema": "Mid", "in": leaf() } }),
    ])
}

fn property_terms() -> Vec<(&'static str, Value)> {
    vec![
        ("leaf", leaf()),
        (
            "tree",
            json!({ "op": "fix", "schema": "Tree", "entity": "e0" }),
        ),
        (
            "rootTree",
            json!({ "op": "expand", "role": { "exact": "child" }, "schema": "Mid", "in": leaf() }),
        ),
        (
            "trust",
            json!({
                "op": "group", "key": "byTargetContext",
                "in": { "op": "select", "pred": { "hasPointer": { "targetEntity": { "var": "root" } } },
                  "in": { "op": "mask", "policy": { "trust": { "or": [
                      { "match": { "field": "author", "cmp": "eq", "const": AUTHORS[0] } },
                      { "inView": {
                          "term": { "op": "select", "pred": { "hasPointer": { "targetEntity": "grants" } },
                                    "in": { "op": "mask", "policy": "drop", "in": "input" } },
                          "field": "author", "extract": { "role": "grantee" } } }
                  ] } }, "in": "input" } }
            }),
        ),
    ]
}

#[derive(Debug, Clone)]
struct Raw {
    author: usize,
    at: u8,
    until: Option<u8>,
    pointers: Vec<(usize, usize, usize)>,
    negates: Option<usize>,
    grantee: Option<usize>,
}

fn sometimes<T: std::fmt::Debug + Clone + 'static>(
    s: impl Strategy<Value = T> + 'static,
    tenths: u32,
) -> BoxedStrategy<Option<T>> {
    prop_oneof![10 - tenths => Just(None), tenths => s.prop_map(Some)].boxed()
}

fn raw() -> impl Strategy<Value = Raw> {
    (
        0..AUTHORS.len(),
        1u8..=40,
        sometimes(41u8..=80, 3),
        prop::collection::vec(
            (0..ROLES.len(), 0..ENTITIES.len(), 0..CONTEXTS.len()),
            1..=3,
        ),
        sometimes(0usize..=200, 2),
        sometimes(0..AUTHORS.len(), 2),
    )
        .prop_map(|(author, at, until, pointers, negates, grantee)| Raw {
            author,
            at,
            until,
            pointers,
            negates,
            grantee,
        })
}

fn build(raws: &[Raw]) -> Vec<Delta> {
    let mut out: Vec<Delta> = Vec::new();
    for r in raws {
        let author = AUTHORS[r.author];
        if let (Some(n), false) = (r.negates, out.is_empty()) {
            let target = out[n % out.len()].id.clone();
            out.push(
                make_delta(
                    make_negation_claims(author, f64::from(r.at), &target, None),
                    None,
                )
                .unwrap(),
            );
            continue;
        }
        let mut pointers: Vec<Pointer> = r
            .pointers
            .iter()
            .map(|&(role, entity, context)| Pointer {
                role: ROLES[role].to_string(),
                target: Target::Entity(EntityRef {
                    id: ENTITIES[entity].to_string(),
                    context: Some(CONTEXTS[context].to_string()),
                }),
            })
            .collect();
        if let Some(g) = r.grantee {
            pointers.push(Pointer {
                role: "grantee".to_string(),
                target: Target::Primitive(Primitive::Str(AUTHORS[g].to_string())),
            });
        }
        out.push(
            make_delta(
                Claims {
                    timestamp: f64::from(r.at),
                    valid_from: f64::from(r.at),
                    valid_until: r.until.map(f64::from),
                    author: author.to_string(),
                    pointers,
                },
                None,
            )
            .unwrap(),
        );
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 200, ..ProptestConfig::default() })]

    #[test]
    fn anchored_equals_whole(
        raws in prop::collection::vec(raw(), 1..60),
        root_index in 0..ENTITIES.len() - 1,
        now in 0u8..=90,
    ) {
        let registry = property_registry();
        let mut reactor = Reactor::new();
        for d in build(&raws) {
            reactor.ingest(d);
        }
        let root = ENTITIES[root_index];
        for (name, json) in property_terms() {
            let term = parse_term(&json).unwrap();
            let anchored = reactor
                .eval_anchored(&term, f64::from(now), root, Some(&registry), None, None)
                .unwrap();
            let whole = eval_term_at(&term, &reactor.snapshot(), f64::from(now), Some(root), Some(&registry), None)
                .unwrap();
            prop_assert_eq!(
                result_canonical_hex(&anchored.result),
                result_canonical_hex(&whole),
                "{}", name
            );
        }
    }
}

// Incremental equivalence under scope dispatch (SPEC-4 §1, SPEC-17 §6): after every single
// ingest, each warm view equals a batch evaluation.
proptest! {
    #![proptest_config(ProptestConfig { cases: 120, ..ProptestConfig::default() })]

    #[test]
    fn warm_views_stay_equal_to_batch(raws in prop::collection::vec(raw(), 1..40)) {
        let registry = property_registry();
        let roots: Vec<String> = ["e0", "e1", "e2"].iter().map(|s| s.to_string()).collect();
        let mut reactor = Reactor::new();
        let terms = property_terms();
        for (name, json) in &terms {
            reactor
                .register_at(name, parse_term(json).unwrap(), &roots, 50.0, Some(registry.clone()))
                .unwrap();
        }
        for d in build(&raws) {
            reactor.ingest(d);
            for (name, json) in &terms {
                let term = parse_term(json).unwrap();
                for root in &roots {
                    let batch = eval_term_at(&term, &reactor.snapshot(), 50.0, Some(root), Some(&registry), None)
                        .unwrap();
                    let expected = result_canonical_hex(&batch);
                    prop_assert_eq!(
                        reactor.materialized_hex(name, root).unwrap(),
                        expected.as_str(),
                        "{} at {}", name, root
                    );
                }
            }
        }
    }
}

#[test]
fn a_grant_after_a_strike_refreshes_the_trust_view() {
    let registry = property_registry();
    let (_, json) = property_terms()
        .into_iter()
        .find(|(n, _)| *n == "trust")
        .unwrap();
    let term = parse_term(&json).unwrap();
    let mut reactor = Reactor::new();
    reactor
        .register_at(
            "trust",
            term.clone(),
            &["e0".to_string()],
            50.0,
            Some(registry.clone()),
        )
        .unwrap();
    let entity = |id: &str, context: &str| Pointer {
        role: "subject".to_string(),
        target: Target::Entity(EntityRef {
            id: id.to_string(),
            context: Some(context.to_string()),
        }),
    };
    let claims = |author: &str, t: f64, pointers: Vec<Pointer>| Claims {
        timestamp: t,
        valid_from: t,
        valid_until: None,
        author: author.to_string(),
        pointers,
    };
    let fact = make_delta(claims(AUTHORS[0], 1.0, vec![entity("e0", "name")]), None).unwrap();
    reactor.ingest(fact.clone());
    reactor
        .ingest(make_delta(make_negation_claims(AUTHORS[1], 2.0, &fact.id, None), None).unwrap());
    let ungranted = reactor.materialized_hex("trust", "e0").unwrap().to_string();
    let grant = Pointer {
        role: "grantee".to_string(),
        target: Target::Primitive(Primitive::Str(AUTHORS[1].to_string())),
    };
    reactor.ingest(
        make_delta(
            claims(AUTHORS[0], 3.0, vec![entity("grants", "grant"), grant]),
            None,
        )
        .unwrap(),
    );
    let granted = reactor.materialized_hex("trust", "e0").unwrap().to_string();
    assert_ne!(granted, ungranted);
    let batch = eval_term_at(
        &term,
        &reactor.snapshot(),
        50.0,
        Some("e0"),
        Some(&registry),
        None,
    )
    .unwrap();
    assert_eq!(granted, result_canonical_hex(&batch));
}

fn lowered_refreshes(deps: Option<Vec<String>>, at: &str) -> u64 {
    let registry = property_registry();
    let mut reactor = Reactor::new();
    reactor
        .register_at_lowered_with_deps(
            "lowered",
            parse_term(&leaf()).unwrap(),
            &["e0".to_string()],
            50.0,
            Some(registry),
            move |t, _input, _now, r| Ok((t.clone(), r.cloned(), deps.clone())),
        )
        .unwrap();
    let before = reactor.eval_count_of("lowered");
    let delta = make_delta(
        Claims {
            timestamp: 1.0,
            valid_from: 1.0,
            valid_until: None,
            author: AUTHORS[0].to_string(),
            pointers: vec![Pointer {
                role: "subject".to_string(),
                target: Target::Entity(EntityRef {
                    id: at.to_string(),
                    context: Some("name".to_string()),
                }),
            }],
        },
        None,
    )
    .unwrap();
    reactor.ingest(delta);
    reactor.eval_count_of("lowered") - before
}

#[test]
fn a_lowered_program_dispatches_by_scope_only_with_deps() {
    assert_eq!(lowered_refreshes(None, "e5"), 1, "no deps: broad");
    assert_eq!(
        lowered_refreshes(Some(vec!["grants".into()]), "e5"),
        0,
        "deps: unrelated"
    );
    assert_eq!(
        lowered_refreshes(Some(vec!["grants".into()]), "grants"),
        1,
        "deps: dependency"
    );
}
