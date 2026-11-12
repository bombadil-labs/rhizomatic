//! The existing read families a second time, through a store (SPEC-18 proposal §4.12 reading 29;
//! slice 2 plan §5, O2). Each family's deltas load into a memory store peer, and each case must
//! answer the family's own bytes:
//!
//! - every evaluation case of `vectors/l1-eval`: an anchored term through `read_anchored`, from
//!   the case's root or else its first static anchor; an unanchored one through
//!   `read_full_surface`;
//! - the SPEC-17 read cases of `eval-anchored.json` through `read_anchored`, with their scope and
//!   members, and its scope cases through `fetch_scope`, with the exclusions as a pushdown;
//! - the negation-witness cases of `vectors/l2-reactor/governed.json` over the fetched scope of
//!   the entities the target points at.
//!
//! The principal cases run over a fetched scope in `principal_store.rs`. Not run again here, as
//! reading 29 says: the rejects, the parse and strict-key files, the schema loads
//! (`schema-deltas.json`), and the whole-set `governed` and `latestByKey` cases. A store adds
//! nothing to a refusal, and a whole-set load is a full-surface read. Ingest, dispatch and journal
//! families move in slices 3 and 4.
//!
//! The routing counts per family are pinned as a literal, so a family that stops running, or a
//! case that changes route, goes red.

use std::collections::{BTreeMap, BTreeSet};

use rhizomatic::anchored::{anchor_analysis, AnchorAnalysis};
use rhizomatic::eval::{result_canonical_hex, Term};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::memory_store::MemoryStore;
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, negation_witnesses, DeltaSource};
use rhizomatic::store::{
    target_entities, Admission, AppendResult, ArrivalRecord, ErasurePosture, PeerStore, Pushdown,
    Store, VerifiedDelta,
};
use rhizomatic::store_read::{
    fetch_scope, read_anchored, read_full_surface, FullSurfaceRequest, ReadRequest, Selection,
};
use rhizomatic::term_json::{parse_schema, parse_term};
use rhizomatic::types::Delta;
use serde_json::Value;

const PEER: &str = "peer:families";

/// `eval-time.json` names no root, and its `resolve` cases group at the root with no static
/// anchor, so reading 29's rule ("from the case's root or else its first static anchor") gives
/// none. Every fixture delta of the family points at `entity:time`, and each witness's own time
/// test evaluates at that root, so the family's bytes are the bytes at that root.
const TIME_ROOT: &str = "entity:time";

/// The evaluation families of `vectors/l1-eval` that carry `cases`. `eval-parse-errors.json` and
/// `eval-strict-keys.json` hold refusals only, and `eval-anchored.json` and `schema-deltas.json`
/// have no `cases` list.
const EVAL_FAMILIES: [&str; 12] = [
    "eval-aliased",
    "eval-basic",
    "eval-bytes",
    "eval-distinct",
    "eval-expand",
    "eval-holes",
    "eval-hview",
    "eval-reflective",
    "eval-relational",
    "eval-resolve",
    "eval-setalgebra",
    "eval-time",
];

/// A case with no `now` was written for the evaluator with no validity slice. A store-backed read
/// always reads at an instant, so it reads at one later than every fixture's `validFrom`. No such
/// fixture has a `validUntil`, which `load_family` checks, so every delta is valid then and the
/// slice keeps them all.
const LATER_THAN_EVERY_FIXTURE: f64 = 1.0e12;

fn load(path: &str) -> Value {
    let path = format!("{}/../../vectors/{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .unwrap()
}

fn delta_of(entry: &Value) -> Delta {
    let delta = make_delta(parse_claims(&entry["claims"]).unwrap(), None).unwrap();
    if let Some(id) = entry.get("id") {
        assert_eq!(
            delta.id,
            id.as_str().unwrap(),
            "{} recomputes",
            entry["name"]
        );
    }
    delta
}

/// A new memory store with one peer, filled by one admission: arrival sequences 1..n in ascending
/// id order, so the load does not depend on the order given. Test fixtures only.
fn loaded(deltas: &[Delta]) -> (MemoryStore, Box<dyn PeerStore>) {
    let store = MemoryStore::new();
    let peer = store.create_peer(PEER, ErasurePosture::Unproven).unwrap();
    let mut sorted: Vec<&Delta> = deltas.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    sorted.dedup_by(|a, b| a.id == b.id);
    if !sorted.is_empty() {
        let added: Vec<VerifiedDelta> = sorted
            .iter()
            .zip(1u64..)
            .map(|(delta, sequence)| VerifiedDelta {
                delta: (*delta).clone(),
                arrival: ArrivalRecord {
                    id: delta.id.clone(),
                    at: 0.0,
                    sequence,
                    transfer: 1,
                    sender: "fixture".into(),
                },
            })
            .collect();
        let count = added.len();
        let result = peer
            .append(&Admission {
                expected_head: None,
                next_head: "families-head".into(),
                frame: None,
                added,
            })
            .unwrap();
        assert!(matches!(result, AppendResult::Committed { added, .. } if added.len() == count));
    }
    (store, peer)
}

fn registry_of(doc: &Value) -> Option<SchemaRegistry> {
    let schemas = doc.get("schemas")?.as_array().unwrap();
    Some(
        SchemaRegistry::build(
            schemas
                .iter()
                .map(|s| HyperSchema {
                    name: s["name"].as_str().unwrap().to_string(),
                    alg: s["alg"].as_u64().unwrap() as u32,
                    body: parse_term(&s["body"]).unwrap(),
                })
                .collect(),
            doc.get("readings")
                .and_then(Value::as_array)
                .map(|rs| rs.iter().map(|r| parse_schema(r).unwrap()).collect())
                .unwrap_or_default(),
        )
        .unwrap(),
    )
}

/// One evaluation case, with the deltas its family loads.
struct EvalCase {
    family: &'static str,
    name: String,
    term: Term,
    root: Option<String>,
    /// The root a family's own test reads at when its cases name none.
    family_root: Option<String>,
    now: f64,
    deltas: Vec<Delta>,
    expected: String,
}

fn eval_cases(family: &'static str) -> (Vec<EvalCase>, Option<SchemaRegistry>) {
    let doc = load(&format!("l1-eval/{family}.json"));
    let registry = registry_of(&doc);
    let fixture = &doc["fixture"];
    // `eval-time.json` names a fixture per case; every other family has one list for all.
    let shared: Vec<Delta> = fixture
        .get("deltas")
        .map(|ds| ds.as_array().unwrap().iter().map(delta_of).collect())
        .unwrap_or_default();
    let named: BTreeMap<String, Delta> = if shared.is_empty() {
        fixture
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, entry)| (name.clone(), delta_of(entry)))
            .collect()
    } else {
        BTreeMap::new()
    };
    let cases = doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let name = c["name"].as_str().unwrap().to_string();
            let deltas = match c.get("input") {
                Some(input) => input
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| named[n.as_str().unwrap()].clone())
                    .collect(),
                None => shared.clone(),
            };
            let now = match c.get("now") {
                Some(now) => now.as_f64().unwrap(),
                None => {
                    for d in &deltas {
                        assert!(
                            d.claims.valid_until.is_none()
                                && d.claims.valid_from <= LATER_THAN_EVERY_FIXTURE,
                            "{family}/{name}: a fixture with no `now` is valid at every later instant"
                        );
                    }
                    LATER_THAN_EVERY_FIXTURE
                }
            };
            EvalCase {
                family,
                family_root: (family == "eval-time").then(|| TIME_ROOT.to_string()),
                term: parse_term(&c["term"]).unwrap_or_else(|e| panic!("{family}/{name}: {e}")),
                root: c.get("root").map(|r| r.as_str().unwrap().to_string()),
                now,
                deltas,
                expected: c["expectedCanonicalHex"].as_str().unwrap().to_string(),
                name,
            }
        })
        .collect();
    (cases, registry)
}

/// The route a case took.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Route {
    Anchored,
    FullSurface,
}

fn run_eval_case(case: &EvalCase, registry: Option<&SchemaRegistry>) -> Route {
    let label = format!("{}/{}", case.family, case.name);
    let (store, peer) = loaded(&case.deltas);
    match anchor_analysis(&case.term, registry, None) {
        AnchorAnalysis::Anchored { anchors } => {
            let root = case
                .root
                .clone()
                .or_else(|| anchors.first().cloned())
                .or_else(|| case.family_root.clone())
                .unwrap_or_else(|| panic!("{label}: anchored with no root and no static anchor"));
            let snapshot = peer.read().unwrap();
            let read = read_anchored(
                snapshot.as_ref(),
                ReadRequest {
                    registry,
                    ..ReadRequest::new(&case.term, &root, case.now)
                },
            )
            .unwrap_or_else(|e| panic!("{label}: {e}"));
            assert_eq!(result_canonical_hex(&read.result), case.expected, "{label}");
            Route::Anchored
        }
        AnchorAnalysis::Unanchored(_) => {
            let exporter = store.open_admin().peer(PEER).unwrap();
            let read = read_full_surface(
                exporter.as_ref(),
                FullSurfaceRequest {
                    root: case.root.as_deref().or(case.family_root.as_deref()),
                    registry,
                    ..FullSurfaceRequest::new(&case.term, case.now)
                },
            )
            .unwrap_or_else(|e| panic!("{label}: {e}"));
            assert_eq!(result_canonical_hex(&read.result), case.expected, "{label}");
            assert!(!read.route.optimized, "{label}");
            Route::FullSurface
        }
    }
}

/// How many cases of each family take each route: (anchored, full surface).
const ROUTING: [(&str, usize, usize); 12] = [
    ("eval-aliased", 0, 9),
    ("eval-basic", 0, 15),
    ("eval-bytes", 6, 0),
    ("eval-distinct", 7, 0),
    ("eval-expand", 8, 0),
    ("eval-holes", 6, 0),
    ("eval-hview", 10, 1),
    ("eval-reflective", 0, 5),
    ("eval-relational", 0, 9),
    ("eval-resolve", 15, 0),
    ("eval-setalgebra", 0, 8),
    ("eval-time", 4, 9),
];

#[test]
fn every_evaluation_case_answers_its_bytes_through_the_store() {
    let mut routing: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for family in EVAL_FAMILIES {
        let (cases, registry) = eval_cases(family);
        let counts = routing.entry(family).or_default();
        for case in &cases {
            match run_eval_case(case, registry.as_ref()) {
                Route::Anchored => counts.0 += 1,
                Route::FullSurface => counts.1 += 1,
            }
        }
    }
    let got: Vec<(&str, usize, usize)> = routing.iter().map(|(f, (a, u))| (*f, *a, *u)).collect();
    println!("routing: {got:?}");
    assert_eq!(got, ROUTING.to_vec());
    let anchored: usize = got.iter().map(|r| r.1).sum();
    let unanchored: usize = got.iter().map(|r| r.2).sum();
    assert_eq!(
        (anchored, unanchored),
        (56, 56),
        "reading 29: 56 and 56 of 112"
    );
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

/// The SPEC-17 read cases through `read_anchored`, with their scope and members, and the scope
/// cases through `fetch_scope`, with the exclusions as a pushdown.
#[test]
fn the_anchored_read_and_scope_cases_answer_through_the_store() {
    let doc = load("l1-eval/eval-anchored.json");
    let deltas: Vec<Delta> = doc["fixture"]["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(delta_of)
        .collect();
    let mut id_of = BTreeMap::new();
    let mut name_of = BTreeMap::new();
    for (entry, delta) in doc["fixture"]["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .zip(&deltas)
    {
        let name = entry["name"].as_str().unwrap().to_string();
        id_of.insert(name.clone(), delta.id.clone());
        name_of.insert(delta.id.clone(), name);
    }
    let names =
        |ids: &[String]| -> Vec<String> { ids.iter().map(|id| name_of[id].clone()).collect() };
    let registry = registry_of(&doc).unwrap();
    let (_store, peer) = loaded(&deltas);

    let mut reads = 0;
    for c in doc["readCases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let term = parse_term(&c["term"]).unwrap();
        let root = c["root"].as_str().unwrap();
        let snapshot = peer.read().unwrap();
        let read = read_anchored(
            snapshot.as_ref(),
            ReadRequest {
                registry: Some(&registry),
                ..ReadRequest::new(&term, root, c["now"].as_f64().unwrap())
            },
        )
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
        assert_eq!(
            result_canonical_hex(&read.result),
            c["expectedCanonicalHex"].as_str().unwrap(),
            "read: {name}"
        );
        reads += 1;
    }

    let mut scopes = 0;
    for c in doc["scopeCases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let pushdown = Pushdown {
            exclude_ids: c.get("excluded").map(|v| {
                let mut ids: Vec<String> = strings(v).iter().map(|n| id_of[n].clone()).collect();
                ids.sort();
                ids
            }),
            ..Pushdown::default()
        };
        let snapshot = peer.read().unwrap();
        let fetched = fetch_scope(
            snapshot.as_ref(),
            &strings(&c["entities"]),
            Selection {
                pushdown: Some(&pushdown),
                admits: None,
            },
        )
        .unwrap();
        let members: Vec<String> = fetched
            .source
            .ids()
            .into_iter()
            .map(str::to_string)
            .collect();
        assert_eq!(
            names(&members),
            strings(&c["expectedMembers"]),
            "scope: {name}"
        );
        scopes += 1;
    }
    assert_eq!((reads, scopes), (8, 6));
}

/// The negation-witness cases of `governed.json`, each over the scope of the entities its target
/// points at, fetched from the store. A target the fixture does not hold points at nothing, so
/// its scope is empty.
#[test]
fn the_negation_witness_cases_answer_over_a_fetched_scope() {
    let doc = load("l2-reactor/governed.json");
    let deltas: Vec<Delta> = doc["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .map(delta_of)
        .collect();
    let named: BTreeMap<String, Delta> = doc["deltas"]
        .as_array()
        .unwrap()
        .iter()
        .zip(&deltas)
        .map(|(entry, d)| (entry["name"].as_str().unwrap().to_string(), d.clone()))
        .collect();
    let (_store, peer) = loaded(&deltas);
    let mut ran = 0;
    for case in doc["witnesses"].as_array().unwrap() {
        let target = named.get(case["target"].as_str().unwrap());
        let entities: Vec<String> = target
            .map(|d| {
                target_entities(&d.claims)
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let target_id = target.map_or(
            "1e200000000000000000000000000000000000000000000000000000000000000000",
            |d| d.id.as_str(),
        );
        let permitted: BTreeSet<&str> = case["permittedAuthors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        let snapshot = peer.read().unwrap();
        let fetched = fetch_scope(snapshot.as_ref(), &entities, Selection::default()).unwrap();
        if target.is_some() {
            assert!(
                fetched.source.get(target_id).is_some(),
                "{case}: the target is fetched"
            );
        }
        let witnesses = negation_witnesses(
            &fetched.source,
            target_id,
            case["now"].as_f64().unwrap(),
            |negation, _| permitted.contains(negation.claims.author.as_str()),
        )
        .unwrap();
        let got: Vec<String> = witnesses.into_iter().map(|d| d.id).collect();
        assert_eq!(got, strings(&case["expectedIds"]), "witness case: {case}");
        ran += 1;
    }
    assert_eq!(ran, 12);
}
