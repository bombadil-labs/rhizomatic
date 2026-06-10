//! Derivation tests. Mirrors ../ts/test/derivation.test.ts.

use rhizomatic::derivation::{verify_pure_derivation, BindingSpec, DerivationHost, DerivedFn};
use rhizomatic::hview::HView;
use rhizomatic::reactor::Reactor;
use rhizomatic::set::make_delta;
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, EntityRef, Pointer, Primitive, Target};
use serde_json::json;

const DERIVED_SEED: &str = "0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d";
const MOVIE: &str = "movie:matrix";

fn movie_body() -> rhizomatic::eval::Term {
    parse_term(&json!({
        "op": "group",
        "key": "byTargetContext",
        "in": {
            "op": "select",
            "pred": { "hasPointer": { "targetEntity": { "var": "root" } } },
            "in": { "op": "mask", "policy": "drop", "in": "input" }
        }
    }))
    .unwrap()
}

fn avg_rating() -> DerivedFn {
    Box::new(|view: &HView, root: &str| {
        let empty = Vec::new();
        let ratings: Vec<f64> = view
            .props
            .get("rating")
            .unwrap_or(&empty)
            .iter()
            .flat_map(|e| e.delta.claims.pointers.iter())
            .filter(|p| p.role == "value")
            .filter_map(|p| match &p.target {
                Target::Primitive(Primitive::Num(n)) => Some(*n),
                _ => None,
            })
            .collect();
        if ratings.is_empty() {
            return Vec::new();
        }
        let avg = ratings.iter().sum::<f64>() / ratings.len() as f64;
        vec![vec![
            Pointer {
                role: "subject".to_string(),
                target: Target::Entity(EntityRef {
                    id: root.to_string(),
                    context: Some("derived:avgRating".to_string()),
                }),
            },
            Pointer {
                role: "value".to_string(),
                target: Target::Primitive(Primitive::Num(avg)),
            },
        ]]
    })
}

fn spec(name: &str, budget: u32) -> BindingSpec {
    BindingSpec {
        name: name.to_string(),
        fn_id: "fn:avgRating".to_string(),
        materialization: "movie".to_string(),
        pure: true,
        budget,
        supersede: true,
    }
}

fn rating_claim(ts: f64, author: &str, value: f64) -> Claims {
    Claims {
        timestamp: ts,
        author: author.to_string(),
        pointers: vec![
            Pointer {
                role: "subject".to_string(),
                target: Target::Entity(EntityRef {
                    id: MOVIE.to_string(),
                    context: Some("rating".to_string()),
                }),
            },
            Pointer {
                role: "value".to_string(),
                target: Target::Primitive(Primitive::Num(value)),
            },
        ],
    }
}

fn world(budget: u32) -> (DerivationHost, String) {
    let mut reactor = Reactor::new();
    reactor
        .register("movie", movie_body(), &[MOVIE.to_string()], None)
        .unwrap();
    let mut host = DerivationHost::new(reactor);
    let author = host.install(
        spec("binding:avgRating", budget),
        avg_rating(),
        DERIVED_SEED,
    );
    (host, author)
}

#[test]
fn pure_derived_author_writes_back_with_provenance() {
    let (mut host, author) = world(10);
    host.ingest(make_delta(rating_claim(1.0, "did:key:zA", 8.0), None).unwrap());
    host.ingest(make_delta(rating_claim(2.0, "did:key:zB", 9.0), None).unwrap());
    let view = host.reactor.materialized_view("movie", MOVIE).unwrap();
    let entries = &view.props["derived:avgRating"];
    assert_eq!(entries.len(), 1);
    let emitted = &entries[0].delta;
    assert_eq!(emitted.claims.author, author);
    let value = emitted
        .claims
        .pointers
        .iter()
        .find(|p| p.role == "value")
        .unwrap();
    assert!(matches!(&value.target, Target::Primitive(Primitive::Num(n)) if *n == 8.5));
    for suffix in ["by", "from", "under"] {
        let r = format!("rdb.derived.{suffix}");
        assert!(emitted.claims.pointers.iter().any(|p| p.role == r), "{r}");
    }
}

#[test]
fn supersede_negates_prior_verdict() {
    let (mut host, _) = world(10);
    host.ingest(make_delta(rating_claim(1.0, "did:key:zA", 8.0), None).unwrap());
    let first_id = host
        .reactor
        .materialized_view("movie", MOVIE)
        .unwrap()
        .props["derived:avgRating"][0]
        .delta
        .id
        .clone();
    host.ingest(make_delta(rating_claim(2.0, "did:key:zB", 9.0), None).unwrap());
    let view = host.reactor.materialized_view("movie", MOVIE).unwrap();
    let entries = &view.props["derived:avgRating"];
    assert_eq!(entries.len(), 1); // superseded claim suppressed by mask(drop)
    assert_ne!(entries[0].delta.id, first_id);
    assert_eq!(host.reactor.negations_of(&first_id).len(), 1);
}

#[test]
fn pure_replay_reproduces_the_emitted_id() {
    let (mut host, _) = world(10);
    host.ingest(make_delta(rating_claim(1.0, "did:key:zA", 8.0), None).unwrap());
    let emitted = host
        .reactor
        .materialized_view("movie", MOVIE)
        .unwrap()
        .props["derived:avgRating"][0]
        .delta
        .clone();
    let from_hex = emitted
        .claims
        .pointers
        .iter()
        .find_map(|p| {
            if p.role != "rdb.derived.from" {
                return None;
            }
            match &p.target {
                Target::Primitive(Primitive::Str(s)) => Some(s.clone()),
                _ => None,
            }
        })
        .unwrap();
    // Rebuild the pre-emission view: a fresh reactor with only the base claim.
    let mut probe = Reactor::new();
    probe
        .register("movie", movie_body(), &[MOVIE.to_string()], None)
        .unwrap();
    probe.ingest(make_delta(rating_claim(1.0, "did:key:zA", 8.0), None).unwrap());
    assert_eq!(probe.materialized_hex("movie", MOVIE).unwrap(), from_hex);
    let view = probe.materialized_view("movie", MOVIE).unwrap().clone();
    let s = spec("binding:avgRating", 10);
    let good = avg_rating();
    assert!(verify_pure_derivation(
        &emitted, &s, &good, &view, MOVIE, &from_hex
    ));
    // a tampered function (off-by-one average) fails replay
    let wrong: DerivedFn = Box::new(move |v, r| {
        avg_rating()(v, r)
            .into_iter()
            .map(|ptrs| {
                ptrs.into_iter()
                    .map(|mut p| {
                        if p.role == "value" {
                            if let Target::Primitive(Primitive::Num(n)) = p.target {
                                p.target = Target::Primitive(Primitive::Num(n + 1.0));
                            }
                        }
                        p
                    })
                    .collect()
            })
            .collect()
    });
    assert!(!verify_pure_derivation(
        &emitted, &s, &wrong, &view, MOVIE, &from_hex
    ));
}

#[test]
fn budget_suspends_observably_and_guard_prevents_self_trigger() {
    let mut reactor = Reactor::new();
    reactor
        .register("movie", movie_body(), &[MOVIE.to_string()], None)
        .unwrap();
    let mut host = DerivationHost::new(reactor);
    host.install(spec("binding:tight", 2), avg_rating(), DERIVED_SEED);
    host.ingest(make_delta(rating_claim(1.0, "did:key:zA", 8.0), None).unwrap());
    host.ingest(make_delta(rating_claim(2.0, "did:key:zB", 9.0), None).unwrap());
    assert!(!host.is_suspended("binding:tight"));
    host.ingest(make_delta(rating_claim(3.0, "did:key:zC", 7.0), None).unwrap());
    assert!(host.is_suspended("binding:tight"));
    // the suspension is an observable, signed annotation in the rhizome
    let suspended = host.reactor.snapshot().iter().any(|d| {
        d.claims
            .pointers
            .iter()
            .any(|p| p.role == "rdb.derived.suspended")
    });
    assert!(suspended);
    // and after suspension, no further emissions occur
    let before = host.reactor.len();
    host.ingest(make_delta(rating_claim(4.0, "did:key:zD", 6.0), None).unwrap());
    assert_eq!(host.reactor.len(), before + 1);
}
