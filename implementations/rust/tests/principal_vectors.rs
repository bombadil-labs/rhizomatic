//! Fixture gate for frozen SPEC-14 vectors. Semantic authority assertions join this file
//! with the principal reader; this already pins signed bytes and every case reference.

use std::collections::{BTreeMap, BTreeSet};

use rhizomatic::delta::compute_id;
use rhizomatic::eval::{eval_term_at, result_canonical_hex, EvalResult, GroupKey, Term};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::principal::{
    associated_keys, authors_for_principal, eval_principal_term, principal_resolver,
    register_principal_materialization, resolve_principal, PrincipalReadOptions,
    PrincipalSuppression, ScopePolicy,
};
use rhizomatic::reactor::{IngestResult, Reactor};
use rhizomatic::sign::{verify_delta, Verification};
use rhizomatic::term_io::term_to_json;
use rhizomatic::term_json::parse_term;
use rhizomatic::types::Delta;
use serde_json::Value;

fn vector() -> Value {
    let path = format!(
        "{}/../../vectors/principal/evidence.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vector")).unwrap()
}

fn fixtures(v: &Value) -> BTreeMap<String, Delta> {
    v["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let name = entry["name"].as_str().unwrap().to_string();
            let delta = Delta {
                id: entry["id"].as_str().unwrap().to_string(),
                claims: parse_claims(&entry["claims"]).unwrap(),
                sig: entry["sig"].as_str().map(str::to_string),
            };
            (name, delta)
        })
        .collect()
}

fn case_reactor(case: &Value, named: &BTreeMap<String, Delta>, reverse: bool) -> Reactor {
    let members = case["members"].as_array().unwrap();
    let mut reactor = Reactor::new();
    let mut names: Vec<&str> = members
        .iter()
        .map(|member| member.as_str().unwrap())
        .collect();
    if reverse {
        names.reverse();
    }
    for name in names {
        assert_eq!(
            reactor.ingest(named.get(name).expect("known fixture").clone()),
            IngestResult::Accepted,
            "case {}",
            case["name"]
        );
    }
    reactor
}

#[test]
fn principal_authority_decisions_are_order_independent() {
    let v = vector();
    let named = fixtures(&v);
    let keys = v["keys"].as_object().unwrap();
    for case in v["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root_alias = case["root"]
            .as_str()
            .unwrap_or(v["defaults"]["root"].as_str().unwrap());
        let root = keys[root_alias].as_str().unwrap();
        let key = keys[case["key"].as_str().unwrap()].as_str().unwrap();
        let policy_name = case["scopePolicy"]
            .as_str()
            .unwrap_or(v["defaults"]["scopePolicy"].as_str().unwrap());
        let suppression_name = case["suppression"]
            .as_str()
            .unwrap_or(v["defaults"]["suppression"].as_str().unwrap());
        let options = PrincipalReadOptions {
            at: case["at"].as_f64().unwrap(),
            now: case["now"]
                .as_f64()
                .unwrap_or(v["defaults"]["now"].as_f64().unwrap()),
            scope: case["scope"].as_str().unwrap().to_string(),
            scope_policy: match policy_name {
                "exact" => ScopePolicy::Exact,
                "prefix" => ScopePolicy::Prefix,
                _ => panic!("unknown scope policy in {name}"),
            },
            suppression: match suppression_name {
                "sameAuthor" => PrincipalSuppression::SameAuthor,
                "rootOrSameAuthor" => PrincipalSuppression::RootOrSameAuthor,
                _ => panic!("unknown suppression in {name}"),
            },
        };
        let expected = &case["expected"];
        let mut expected_authors: Vec<String> = expected["authors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|alias| keys[alias.as_str().unwrap()].as_str().unwrap().to_string())
            .collect();
        expected_authors.sort();
        for reverse in [false, true] {
            let reactor = case_reactor(case, &named, reverse);
            let result = resolve_principal(&reactor, root, key, &options).unwrap();
            assert_eq!(
                result.grade.as_str(),
                expected["grade"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                result.authorized,
                expected["authorized"].as_bool().unwrap(),
                "{name}"
            );
            assert_eq!(
                result.delegable,
                expected["delegable"].as_bool().unwrap(),
                "{name}"
            );
            assert_eq!(result.authors, expected_authors, "{name}");
            assert_eq!(
                authors_for_principal(&reactor, root, &options).unwrap(),
                expected_authors,
                "{name}"
            );
        }
    }
}

#[test]
fn principal_history_keeps_negated_associations() {
    let v = vector();
    let named = fixtures(&v);
    let keys = v["keys"].as_object().unwrap();
    let root = keys[v["defaults"]["root"].as_str().unwrap()]
        .as_str()
        .unwrap();
    for case in v["history"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let expected: Vec<(String, Vec<String>, bool)> = case["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    keys[row["key"].as_str().unwrap()]
                        .as_str()
                        .unwrap()
                        .to_string(),
                    row["via"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|alias| named[alias.as_str().unwrap()].id.clone())
                        .collect(),
                    row["negated"].as_bool().unwrap(),
                )
            })
            .collect();
        for reverse in [false, true] {
            let reactor = case_reactor(case, &named, reverse);
            let rows = associated_keys(
                &reactor,
                root,
                case["now"].as_f64().unwrap(),
                PrincipalSuppression::SameAuthor,
            )
            .unwrap();
            let actual: Vec<(String, Vec<String>, bool)> = rows
                .iter()
                .map(|row| (row.key.clone(), row.via.clone(), row.negated))
                .collect();
            assert_eq!(actual, expected, "{name}");
            for row in rows {
                assert_eq!(row.intervals.len(), row.via.len(), "{name}");
                for (interval, id) in row.intervals.iter().zip(&row.via) {
                    let claims = &reactor.get(id).unwrap().claims;
                    assert_eq!(interval.valid_from, claims.valid_from, "{name}");
                    assert_eq!(interval.valid_until, claims.valid_until, "{name}");
                }
            }
        }
    }
}

#[test]
fn principal_predicates_lower_through_an_explicit_resolver() {
    let v = vector();
    let named = fixtures(&v);
    for case in v["predicates"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let term = parse_term(&case["term"]).unwrap();
        assert_eq!(term_to_json(&term), case["term"], "{name}");
        for reverse in [false, true] {
            let reactor = case_reactor(case, &named, reverse);
            let input = reactor.snapshot();
            let now = case["now"].as_f64().unwrap();
            if case["missingResolverMustThrow"].as_bool().unwrap() {
                let error = eval_term_at(&term, &input, now, None, None, None).unwrap_err();
                assert!(error.contains("principal resolver"), "{name}: {error}");
            }
            let result = eval_principal_term(
                &term,
                &input,
                now,
                &principal_resolver(PrincipalSuppression::SameAuthor),
                None,
                None,
                None,
            )
            .unwrap();
            let EvalResult::DSet { set, .. } = result else {
                panic!("{name}: principal predicate must select a delta set");
            };
            let mut expected: Vec<&str> = case["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|alias| named[alias.as_str().unwrap()].id.as_str())
                .collect();
            expected.sort();
            assert_eq!(set.ids(), expected, "{name}");
        }
    }
}

#[test]
fn principal_fixture_ids_signatures_and_references() {
    let v = vector();
    let mut named = BTreeMap::<String, Delta>::new();
    for entry in v["deltas"].as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        let claims = parse_claims(&entry["claims"]).unwrap();
        let id = entry["id"].as_str().unwrap();
        assert_eq!(compute_id(&claims).unwrap(), id, "fixture {name}");
        let sig = entry["sig"].as_str().map(str::to_string);
        let delta = Delta {
            id: id.to_string(),
            claims,
            sig: sig.clone(),
        };
        assert_eq!(
            verify_delta(&delta),
            if sig.is_some() {
                Verification::Verified
            } else {
                Verification::Unsigned
            },
            "fixture {name}"
        );
        assert!(named.insert(name.to_string(), delta).is_none());
    }

    let keys = v["keys"].as_object().unwrap();
    let mut case_names = BTreeSet::new();
    for group in ["cases", "history", "predicates"] {
        for case in v[group].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert!(case_names.insert(name), "duplicate case {name}");
            let members = case["members"].as_array().unwrap();
            let mut member_names = BTreeSet::new();
            let mut ordered = Vec::new();
            for member in members {
                let member_name = member.as_str().unwrap();
                assert!(
                    member_names.insert(member_name),
                    "duplicate member in {name}"
                );
                ordered.push(named.get(member_name).expect("known member").clone());
            }
            for reverse in [false, true] {
                let mut reactor = Reactor::new();
                let source: Vec<Delta> = if reverse {
                    ordered.iter().rev().cloned().collect()
                } else {
                    ordered.clone()
                };
                for delta in source {
                    assert_eq!(reactor.ingest(delta), IngestResult::Accepted, "case {name}");
                }
                assert_eq!(reactor.len(), members.len(), "case {name}");
            }
            if group == "cases" {
                assert!(case["at"].as_f64().unwrap().is_finite());
                if let Some(now) = case["now"].as_f64() {
                    assert!(now.is_finite());
                }
                assert!(keys.contains_key(case["key"].as_str().unwrap()));
                if let Some(root) = case["root"].as_str() {
                    assert!(keys.contains_key(root));
                }
                for alias in case["expected"]["authors"].as_array().unwrap() {
                    assert!(keys.contains_key(alias.as_str().unwrap()));
                }
            }
            if group == "history" {
                for row in case["expected"].as_array().unwrap() {
                    assert!(keys.contains_key(row["key"].as_str().unwrap()));
                    for edge in row["via"].as_array().unwrap() {
                        assert!(named.contains_key(edge.as_str().unwrap()));
                    }
                }
            }
            if group == "predicates" {
                assert!(case["term"].is_object());
                for expected in case["expected"].as_array().unwrap() {
                    assert!(named.contains_key(expected.as_str().unwrap()));
                }
            }
        }
    }
}

#[test]
fn principal_materialization_refreshes_on_ingest_and_validity_boundary() {
    let v = vector();
    let named = fixtures(&v);
    let root = v["keys"][v["defaults"]["root"].as_str().unwrap()]
        .as_str()
        .unwrap()
        .to_string();
    let selected = parse_term(&v["predicates"][0]["term"]).unwrap();
    let term = Term::Group {
        key: GroupKey::ByRole,
        of: Box::new(selected),
    };
    let expected_hex = |reactor: &Reactor, now: f64| {
        result_canonical_hex(
            &eval_principal_term(
                &term,
                &reactor.snapshot(),
                now,
                &principal_resolver(PrincipalSuppression::SameAuthor),
                Some(&root),
                None,
                None,
            )
            .unwrap(),
        )
    };

    let mut timed = Reactor::new();
    for name in ["userDelegation", "connectionDelegation", "dataConnection"] {
        assert_eq!(timed.ingest(named[name].clone()), IngestResult::Accepted);
    }
    register_principal_materialization(
        &mut timed,
        "member",
        term.clone(),
        std::slice::from_ref(&root),
        4.0,
        principal_resolver(PrincipalSuppression::SameAuthor),
        None,
    )
    .unwrap();
    let before = timed.materialized_hex("member", &root).unwrap().to_string();
    assert_eq!(before, expected_hex(&timed, 4.0));
    timed.advance_time(5.0).unwrap();
    assert_eq!(
        timed.materialized_hex("member", &root).unwrap(),
        expected_hex(&timed, 5.0)
    );
    assert_ne!(timed.materialized_hex("member", &root).unwrap(), before);

    let mut arriving = Reactor::new();
    for name in ["userDelegation", "dataConnection"] {
        assert_eq!(arriving.ingest(named[name].clone()), IngestResult::Accepted);
    }
    register_principal_materialization(
        &mut arriving,
        "member",
        term.clone(),
        std::slice::from_ref(&root),
        6.0,
        principal_resolver(PrincipalSuppression::SameAuthor),
        None,
    )
    .unwrap();
    let before_arrival = arriving
        .materialized_hex("member", &root)
        .unwrap()
        .to_string();
    assert_eq!(before_arrival, expected_hex(&arriving, 6.0));
    assert_eq!(
        arriving.ingest(named["connectionDelegation"].clone()),
        IngestResult::Accepted
    );
    assert_eq!(
        arriving.materialized_hex("member", &root).unwrap(),
        expected_hex(&arriving, 6.0)
    );
    assert_ne!(
        arriving.materialized_hex("member", &root).unwrap(),
        before_arrival
    );
}
