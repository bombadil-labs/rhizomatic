//! The negation reader over any delta source (SPEC-18 slice 2), and the reactor's membership
//! counter.
//!
//! The property: for generated delta sets and an entity set E, the reader over a `ScopeSource`
//! that holds only S(E) answers, for every member of S(E), what `Reactor::negation_reader`
//! answers over the whole set. Both are also compared with a list-scanning model in this file,
//! so a fault shared by the two readers does not pass.
//!
//! Not covered here: a suppression callback that reads other deltas, and the principal
//! functions over a fetched scope.

use proptest::prelude::*;
use rhizomatic::anchored::scope_ids;
use rhizomatic::reactor::{make_manifest_claims, IngestResult, Reactor};
use rhizomatic::set::{
    make_delta, make_negation_claims, negation_predicate, negation_reader, negation_witnesses,
    DeltaSource,
};
use rhizomatic::store::{scope_source, ArrivalRecord, ScopeSource, VerifiedDelta};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Target};
use serde_json::json;

const ENTITIES: [&str; 4] = ["e0", "e1", "e2", "e3"];
const AUTHORS: [&str; 3] = ["root", "ann", "bob"];
const ROOT: &str = "root";

type Suppression = fn(&Delta, &Delta) -> bool;

fn any_author(_: &Delta, _: &Delta) -> bool {
    true
}
fn same_author(negation: &Delta, target: &Delta) -> bool {
    negation.claims.author == target.claims.author
}
fn root_or_same_author(negation: &Delta, target: &Delta) -> bool {
    negation.claims.author == ROOT || same_author(negation, target)
}
fn nobody(_: &Delta, _: &Delta) -> bool {
    false
}

const MODES: [(&str, Suppression); 4] = [
    ("any", any_author),
    ("same-author", same_author),
    ("root-or-same-author", root_or_same_author),
    ("nobody", nobody),
];

#[derive(Debug, Clone)]
struct Raw {
    /// `Some(k)`: a negation of the delta built `k + 1` places earlier (or a plain delta when
    /// there is none).
    negates: Option<usize>,
    entities: Vec<usize>,
    author: usize,
    from: u8,
    until: Option<u8>,
    held: bool,
    /// Arrival position; a negation can arrive before its target.
    arrival: u16,
}

fn raw() -> impl Strategy<Value = Raw> {
    (
        prop::option::weighted(0.5, 0usize..6),
        prop::collection::vec(0..ENTITIES.len(), 1..3),
        0..AUTHORS.len(),
        0u8..30,
        prop::option::weighted(0.5, 0u8..30),
        prop::bool::weighted(0.9),
        any::<u16>(),
    )
        .prop_map(
            |(negates, entities, author, from, until, held, arrival)| Raw {
                negates,
                entities,
                author,
                from,
                until,
                held,
                arrival,
            },
        )
}

/// Every delta in build order, with whether the reactor holds it and its arrival position.
fn build(raws: &[Raw]) -> Vec<(Delta, bool, u16)> {
    let mut out: Vec<(Delta, bool, u16)> = Vec::new();
    for (index, r) in raws.iter().enumerate() {
        let author = AUTHORS[r.author];
        let from = f64::from(r.from);
        let until = r.until.map(|u| from + 1.0 + f64::from(u));
        let claims = match r.negates.filter(|k| *k < index) {
            Some(k) => {
                let mut claims = make_negation_claims(author, from, &out[index - 1 - k].0.id, None);
                claims.valid_until = until;
                claims
            }
            None => Claims {
                timestamp: from,
                valid_from: from,
                valid_until: until,
                author: author.to_string(),
                pointers: r
                    .entities
                    .iter()
                    .map(|&e| Pointer {
                        role: "about".to_string(),
                        target: Target::Entity(EntityRef {
                            id: ENTITIES[e].to_string(),
                            context: None,
                        }),
                    })
                    .collect(),
            },
        };
        out.push((make_delta(claims, None).unwrap(), r.held, r.arrival));
    }
    out
}

fn fetched(reactor: &Reactor, ids: &[String]) -> ScopeSource {
    let members: Vec<VerifiedDelta> = ids
        .iter()
        .enumerate()
        .map(|(n, id)| VerifiedDelta {
            delta: reactor.get(id).unwrap().clone(),
            arrival: ArrivalRecord {
                id: id.clone(),
                at: 0.0,
                sequence: n as u64,
                transfer: 0,
                sender: "peer:test".to_string(),
            },
        })
        .collect();
    scope_source(&members).unwrap()
}

/// The model: scan the whole list for negations of `id`. No index, no memo.
fn model_witnesses(held: &[Delta], id: &str, now: f64, suppression: Suppression) -> Vec<String> {
    let Some(target) = held.iter().find(|d| d.id == id) else {
        return Vec::new();
    };
    let mut out: Vec<String> = held
        .iter()
        .filter(|d| {
            d.claims.pointers.iter().any(|p| {
                p.role == "negates" && matches!(&p.target, Target::Delta(r) if r.delta == id)
            })
        })
        .filter(|d| d.claims.valid_from <= now && d.claims.valid_until.is_none_or(|end| now < end))
        .filter(|d| suppression(d, target))
        .filter(|d| model_witnesses(held, &d.id, now, suppression).is_empty())
        .map(|d| d.id.clone())
        .collect();
    out.sort();
    out.dedup();
    out
}

fn ids(deltas: &[Delta]) -> Vec<String> {
    deltas.iter().map(|d| d.id.clone()).collect()
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 200, ..ProptestConfig::default() })]

    #[test]
    fn a_fetched_scope_answers_negation_as_the_whole_set_does(
        raws in prop::collection::vec(raw(), 1..50),
        entity_mask in 1usize..(1 << ENTITIES.len()),
        now in 0u8..=62,
    ) {
        let mut arriving: Vec<(Delta, bool, u16)> = build(&raws);
        arriving.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.0.id.cmp(&b.0.id)));
        let mut reactor = Reactor::new();
        let mut held: Vec<Delta> = Vec::new();
        for (delta, is_held, _) in arriving {
            if is_held && reactor.ingest(delta.clone()) == IngestResult::Accepted {
                held.push(delta);
            }
        }
        let entities: Vec<&str> = ENTITIES
            .iter()
            .enumerate()
            .filter(|(i, _)| entity_mask & (1 << i) != 0)
            .map(|(_, e)| *e)
            .collect();
        let members = scope_ids(&reactor, entities.iter().copied(), None);
        let scope = fetched(&reactor, &members);
        let now = f64::from(now);

        for (mode, suppression) in MODES {
            let mut whole = reactor.negation_reader(now, suppression).unwrap();
            let mut scoped = negation_reader(&scope, now, suppression).unwrap();
            let mut predicate = negation_predicate(&scope, now, suppression).unwrap();
            for id in &members {
                let expected = model_witnesses(&held, id, now, suppression);
                let over_whole = whole.witnesses(id);
                let over_scope = scoped.witnesses(id);
                prop_assert_eq!(&ids(&over_whole), &expected, "{}: reactor against the model", mode);
                prop_assert_eq!(&over_scope, &over_whole, "{}: scope against reactor", mode);
                prop_assert_eq!(
                    &negation_witnesses(&scope, id, now, suppression).unwrap(),
                    &over_whole,
                    "{}: one-shot witnesses", mode
                );
                prop_assert_eq!(scoped.is_negated(id), !expected.is_empty(), "{}: is_negated", mode);
                prop_assert_eq!(whole.is_negated(id), !expected.is_empty(), "{}: reactor is_negated", mode);
                prop_assert_eq!(predicate(id), !expected.is_empty(), "{}: predicate", mode);
            }
        }
    }

    // The order contract of a delta source (SPEC-18 §4.2): each id once, ascending.
    #[test]
    fn both_sources_list_each_id_once_ascending(raws in prop::collection::vec(raw(), 1..50)) {
        let mut reactor = Reactor::new();
        for (delta, _, _) in build(&raws).into_iter().rev() {
            reactor.ingest(delta);
        }
        let all: Vec<String> = reactor.arrival_log().iter().map(|d| d.id.clone()).collect();
        let scope = fetched(&reactor, &all);
        let strictly_ascending = |list: &[String]| list.windows(2).all(|w| w[0].as_bytes() < w[1].as_bytes());
        for entity in ENTITIES {
            prop_assert!(strictly_ascending(&DeltaSource::targets(&reactor, entity)));
            prop_assert!(strictly_ascending(&scope.targets(entity)));
            prop_assert_eq!(scope.targets(entity), DeltaSource::targets(&reactor, entity));
        }
        for id in &all {
            prop_assert!(strictly_ascending(&DeltaSource::negators(&reactor, id)));
            prop_assert!(strictly_ascending(&scope.negators(id)));
            prop_assert_eq!(scope.negators(id), DeltaSource::negators(&reactor, id));
        }
    }
}

fn about(entity: &str, author: &str, at: f64) -> Delta {
    make_delta(
        Claims {
            timestamp: at,
            valid_from: at,
            valid_until: None,
            author: author.to_string(),
            pointers: vec![Pointer {
                role: "about".to_string(),
                target: Target::Entity(EntityRef {
                    id: entity.to_string(),
                    context: None,
                }),
            }],
        },
        None,
    )
    .unwrap()
}

fn negation(author: &str, at: f64, target: &Delta) -> Delta {
    make_delta(make_negation_claims(author, at, &target.id, None), None).unwrap()
}

// A fixed chain, so the property above cannot pass on empty answers alone.
#[test]
fn a_chain_reads_the_same_over_a_fetched_scope() {
    let fact = about("e0", "ann", 1.0);
    let other = about("e1", "ann", 1.0);
    let strike = negation("bob", 2.0, &fact);
    let counter = negation("ann", 3.0, &strike);
    let recounter = negation("root", 4.0, &counter);
    let mut reactor = Reactor::new();
    // Each negation arrives before its target.
    for d in [&recounter, &counter, &strike, &other, &fact] {
        assert_eq!(reactor.ingest(d.clone()), IngestResult::Accepted);
    }
    let members = scope_ids(&reactor, ["e0"], None);
    assert_eq!(members.len(), 4, "the fact and its three negations");
    let scope = fetched(&reactor, &members);

    let mut reader = negation_reader(&scope, 10.0, any_author).unwrap();
    assert_eq!(ids(&reader.witnesses(&fact.id)), vec![strike.id.clone()]);
    assert!(!reader.is_negated(&strike.id));
    assert_eq!(
        ids(&reader.witnesses(&counter.id)),
        vec![recounter.id.clone()]
    );
    assert!(!reader.is_negated(&recounter.id));
    // Before the recounter is valid the counter stands, and the fact is not negated.
    assert!(!negation_predicate(&scope, 3.0, any_author).unwrap()(
        &fact.id
    ));
    // A validity window is half-open: the negation counts at its start and not at its end.
    let mut windowed = make_negation_claims("bob", 5.0, &other.id, None);
    windowed.valid_until = Some(8.0);
    let windowed = make_delta(windowed, None).unwrap();
    assert_eq!(reactor.ingest(windowed), IngestResult::Accepted);
    let e1 = fetched(&reactor, &scope_ids(&reactor, ["e1"], None));
    for (now, negated) in [(4.0, false), (5.0, true), (7.5, true), (8.0, false)] {
        assert_eq!(
            negation_predicate(&e1, now, any_author).unwrap()(&other.id),
            negated,
            "at {now}"
        );
    }
    // A delta outside the fetched scope is not held: no witnesses, whatever the store holds.
    assert!(reader.witnesses(&other.id).is_empty());
    assert!(negation_witnesses(&scope, "not-an-id", 10.0, any_author)
        .unwrap()
        .is_empty());
    assert!(negation_reader(&scope, f64::NAN, any_author).is_err());
    // A trait object is a source too.
    let object: &dyn DeltaSource = &scope;
    assert!(negation_reader(object, 10.0, any_author)
        .unwrap()
        .is_negated(&fact.id));
}

#[test]
fn revision_rises_once_for_each_call_that_adds_a_member() {
    let a = about("e0", "ann", 1.0);
    let b = about("e1", "ann", 2.0);
    let c = about("e2", "ann", 3.0);
    let d = about("e3", "ann", 4.0);
    let mut broken = about("e0", "bob", 5.0);
    broken.id = "not-the-content-address".to_string();

    let mut reactor = Reactor::new();
    assert_eq!(reactor.revision(), 0);

    assert_eq!(reactor.ingest(a.clone()), IngestResult::Accepted);
    assert_eq!(reactor.revision(), 1);
    assert_eq!(reactor.ingest(a.clone()), IngestResult::Duplicate);
    assert_eq!(reactor.revision(), 1, "a duplicate adds no member");
    assert!(matches!(
        reactor.ingest(broken.clone()),
        IngestResult::Rejected(_)
    ));
    assert_eq!(reactor.revision(), 1, "a rejected delta adds no member");

    // Two new members and one duplicate: one rise, not two.
    assert_eq!(
        reactor.ingest_batch(&[a.clone(), b.clone(), c.clone()]),
        IngestResult::Accepted
    );
    assert_eq!(reactor.revision(), 2);
    assert_eq!(
        reactor.ingest_batch(&[a.clone(), b.clone()]),
        IngestResult::Duplicate
    );
    assert_eq!(reactor.revision(), 2, "a batch of duplicates");
    assert_eq!(reactor.ingest_batch(&[]), IngestResult::Duplicate);
    assert_eq!(reactor.revision(), 2, "an empty batch");
    assert!(matches!(
        reactor.ingest_batch(&[d.clone(), broken.clone()]),
        IngestResult::Rejected(_)
    ));
    assert_eq!(reactor.revision(), 2, "a rejected batch");
    assert!(!reactor.contains(&d.id), "a rejected batch adds no member");

    let manifest = make_delta(
        make_manifest_claims("ann", 6.0, std::slice::from_ref(&d.id), None, None),
        None,
    )
    .unwrap();
    assert!(matches!(
        reactor.ingest_bundle(manifest.clone(), &[d.clone(), about("e3", "bob", 7.0)]),
        IngestResult::Rejected(_)
    ));
    assert_eq!(reactor.revision(), 2, "a rejected bundle");
    assert_eq!(
        reactor.ingest_bundle(manifest.clone(), std::slice::from_ref(&d)),
        IngestResult::Accepted
    );
    assert_eq!(
        reactor.revision(),
        3,
        "a bundle adds two members and rises once"
    );
    assert_eq!(
        reactor.ingest_bundle(manifest, std::slice::from_ref(&d)),
        IngestResult::Duplicate
    );
    assert_eq!(reactor.revision(), 3, "a bundle of duplicates");

    // Reads, registration and the clock do not change membership.
    let term = parse_term(&json!({
        "op": "group", "key": "byTargetContext",
        "in": { "op": "mask", "policy": "drop", "in": "input" }
    }))
    .unwrap();
    reactor
        .register_at("all", term.clone(), &["e0".to_string()], 1.0, None)
        .unwrap();
    reactor.advance_time(100.0).unwrap();
    reactor.eval(&term, Some("e0"), None).unwrap();
    let _ = reactor.negation_reader(1.0, any_author).unwrap();
    let _ = reactor.snapshot();
    assert_eq!(reactor.revision(), 3);
    assert_eq!(
        Reactor::new().revision(),
        0,
        "the counter belongs to one reactor"
    );
}
