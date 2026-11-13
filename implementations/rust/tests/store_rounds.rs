//! The read in rounds over a store (SPEC-18 proposal §4.4, §4.12; `vectors/store/README.md` §5).
//! Every case of `vectors/store/rounds.json` is read five ways on the memory store under every
//! subset of pushdown fields: over the whole surface, and in rounds with each pair of the fetch
//! cache and the evaluation memo, on or off (README §5.4 modes 1 to 5). All five must give the
//! expected bytes, scope and members; the rounds with the cache must make exactly the expected
//! `scope` calls, and the memo must change no round report.
//!
//! Interleaved cases move the peer between two rounds, by an append or a purge (README §5.5).
//!
//! The rails of README §5.8: five wrong readers that must each fail a case, a store that returns
//! an unclosed extra, a sticky residual in both parities, the hook, refusals, a store that lies
//! about `applied`, the fetch cache's index and arrival rules, call traces and meter deltas beside
//! 0 and 4400 unrelated deltas, and an open that reads nothing. For the memo: five wrong memos
//! that must each fail the case README §5.8 names, and the count of what the memo saves. The
//! budget rail is in `src/eval.rs`, because a budget is not reachable through a store read.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use rhizomatic::anchored::{anchor_analysis, hview_anchors, scope_ids, AnchorAnalysis};
use rhizomatic::eval::{
    eval_term_at, result_canonical_hex, ChildKey, ChildMemo, ChildValue, EvalResult, SchemaRef,
    Term,
};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::memory_store::{MemoryStore, StoreMeter};
use rhizomatic::pred::Bindings;
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, make_negation_claims, DeltaSet, DeltaSource};
use rhizomatic::store::{
    collect_delta_set, negated_ids, scope_source, target_entities, Admission, Anchor, AppendResult,
    ArrivalRecord, ChangePage, ErasurePosture, PeerErasure, PeerExporter, PeerStore, PurgeOutcome,
    PurgeReport, Pushdown, PushdownFields, Revision, ScopeRequest, ScopeResult, ScopeSource,
    Snapshot, Store, StoreError, StoreErrorCode, VerifiedDelta,
};
use rhizomatic::store_read::{
    fetch_scope, read_anchored, read_anchored_with_memo, read_full_surface, EvalMemo, FetchCache,
    FinalChildMemo, FullSurfaceRequest, FullSurfaceRoute, ReadRequest, RoundMemo, RoundReport,
    Selection, StoreReactor, StoreRead, StoreReadError, SNAPSHOT_RETRIES,
};
use rhizomatic::term_json::parse_term;
use rhizomatic::types::{Claims, Delta, EntityRef, Pointer, Primitive, Target};
use serde_json::Value;

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

struct Fixture {
    doc: Value,
    by_name: BTreeMap<String, Delta>,
    name_of: BTreeMap<String, String>,
    registry: SchemaRegistry,
    /// The arrival record the load gives each delta, by id.
    arrivals: BTreeMap<String, ArrivalRecord>,
}

fn fixture() -> Fixture {
    let path = format!(
        "{}/../../vectors/store/rounds.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read rounds.json")).unwrap();
    assert_eq!(doc["format"], "rhizomatic-store-rounds/1");
    let mut by_name = BTreeMap::new();
    let mut name_of = BTreeMap::new();
    for entry in doc["deltas"].as_array().unwrap() {
        let name = entry["name"].as_str().unwrap().to_string();
        let delta = make_delta(parse_claims(&entry["claims"]).unwrap(), None).unwrap();
        assert_eq!(delta.id, entry["id"].as_str().unwrap(), "{name} recomputes");
        name_of.insert(delta.id.clone(), name.clone());
        by_name.insert(name, delta);
    }
    let registry = SchemaRegistry::build(
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
    let mut fx = Fixture {
        doc,
        by_name,
        name_of,
        registry,
        arrivals: BTreeMap::new(),
    };
    let mut arrivals = BTreeMap::new();
    for entry in fx.doc["load"]["admissions"].as_array().unwrap() {
        for added in fx.admission(entry).added {
            arrivals.insert(added.delta.id.clone(), added.arrival);
        }
    }
    fx.arrivals = arrivals;
    fx
}

impl Fixture {
    fn id(&self, name: &str) -> String {
        self.by_name[name].id.clone()
    }

    fn ids(&self, names: &Value) -> Vec<String> {
        let mut ids: Vec<String> = names
            .as_array()
            .unwrap()
            .iter()
            .map(|n| self.id(n.as_str().unwrap()))
            .collect();
        ids.sort();
        ids
    }

    fn names(&self, ids: &[String]) -> Vec<String> {
        ids.iter()
            .map(|id| self.name_of.get(id).cloned().unwrap_or_else(|| id.clone()))
            .collect()
    }

    /// One admission entry of the load rule (README §5.2).
    fn admission(&self, entry: &Value) -> Admission {
        Admission {
            expected_head: entry["expectedHead"].as_str().map(str::to_string),
            next_head: entry["nextHead"].as_str().unwrap().to_string(),
            frame: None,
            added: entry["added"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| {
                    let delta = self.by_name[a["delta"].as_str().unwrap()].clone();
                    let r = &a["arrival"];
                    VerifiedDelta {
                        arrival: ArrivalRecord {
                            id: delta.id.clone(),
                            at: r["at"].as_f64().unwrap(),
                            sequence: r["sequence"].as_u64().unwrap(),
                            transfer: r["transfer"].as_u64().unwrap(),
                            sender: r["sender"].as_str().unwrap().to_string(),
                        },
                        delta,
                    }
                })
                .collect(),
        }
    }

    fn peer_id(&self) -> &str {
        self.doc["load"]["peer"].as_str().unwrap()
    }

    /// How many deltas the load gives the peer.
    fn loaded(&self) -> usize {
        self.arrivals.len()
    }

    /// Every loaded delta with its arrival record, ascending by id.
    fn loaded_members(&self) -> Vec<VerifiedDelta> {
        self.arrivals
            .iter()
            .map(|(id, arrival)| VerifiedDelta {
                delta: self.by_name[&self.name_of[id]].clone(),
                arrival: arrival.clone(),
            })
            .collect()
    }

    /// The change of an interleaved case: exactly one of `append` and `purge` (README §5.5).
    fn change(&self, raw: &Value) -> Change {
        match (raw.get("append"), raw.get("purge")) {
            (Some(append), None) => Change::Append(self.admission(append)),
            (None, Some(purge)) => {
                let ids: Vec<String> = purge
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| self.id(n.as_str().unwrap()))
                    .collect();
                assert!(
                    ids.windows(2).all(|w| w[0] < w[1]),
                    "{}: purge is ascending by id",
                    raw["name"]
                );
                Change::Purge(ids)
            }
            _ => panic!("{}: exactly one of append and purge", raw["name"]),
        }
    }

    /// A new peer on `store`, loaded by README §5.2. Every append commits.
    fn load(&self, store: &MemoryStore) -> Box<dyn PeerStore> {
        assert_eq!(self.doc["load"]["erasure"], "unproven");
        let peer = store
            .create_peer(self.peer_id(), ErasurePosture::Unproven)
            .unwrap();
        for entry in self.doc["load"]["admissions"].as_array().unwrap() {
            commit(peer.as_ref(), &self.admission(entry));
        }
        peer
    }

    fn cases(&self, list: &str) -> Vec<Case> {
        self.doc[list]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| self.case(c))
            .collect()
    }

    fn case(&self, c: &Value) -> Case {
        let pushdown = c.get("selection").map(|s| Pushdown {
            timestamp_at_most: s.get("timestampAtMost").map(|t| t.as_f64().unwrap()),
            arrival_at_most: s.get("arrivalAtMost").map(|n| n.as_u64().unwrap()),
            exclude_ids: s.get("excludeIds").map(|names| self.ids(names)),
        });
        let bindings = c.get("bindings").map(|b| {
            b.as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| {
                    let p = match v {
                        Value::String(s) => Primitive::Str(s.clone()),
                        Value::Bool(b) => Primitive::Bool(*b),
                        Value::Number(n) => Primitive::Num(n.as_f64().unwrap()),
                        other => panic!("binding {k}: {other}"),
                    };
                    (k.clone(), p)
                })
                .collect::<Bindings>()
        });
        Case {
            name: c["name"].as_str().unwrap().to_string(),
            term: parse_term(&c["term"]).unwrap(),
            root: c["root"].as_str().unwrap().to_string(),
            now: c["now"].as_f64().unwrap(),
            bindings,
            pushdown: pushdown.unwrap_or_default(),
            expect: c.get("expect").map(|e| self.expect(e)),
            raw: c.clone(),
        }
    }

    fn expect(&self, e: &Value) -> Expect {
        Expect {
            hex: e["canonicalHex"].as_str().unwrap_or_default().to_string(),
            scope: strings(&e["scope"]),
            members: if e["members"].is_array() {
                self.ids(&e["members"])
            } else {
                Vec::new()
            },
            rounds: e["rounds"]
                .as_array()
                .map(|rs| rs.iter().map(|r| strings(&r["anchors"])).collect())
                .unwrap_or_default(),
        }
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect())
        .unwrap_or_default()
}

fn commit(peer: &dyn PeerStore, admission: &Admission) -> Revision {
    match peer.append(admission).unwrap() {
        AppendResult::Committed { revision, .. } => revision,
        other => panic!("the load must commit: {other:?}"),
    }
}

/// How an interleaved case moves the peer between two rounds.
#[derive(Clone)]
enum Change {
    /// Applied by the load rule; it must commit.
    Append(Admission),
    /// Every target must report `removed`.
    Purge(Vec<String>),
}

impl Change {
    fn apply(&self, peer: &dyn PeerStore) {
        match self {
            Change::Append(admission) => {
                commit(peer, admission);
            }
            Change::Purge(ids) => {
                let report = peer.purge(ids).expect("the purge answers");
                let removed: Vec<(String, PurgeOutcome)> = ids
                    .iter()
                    .map(|id| (id.clone(), PurgeOutcome::Removed))
                    .collect();
                let got: Vec<(String, PurgeOutcome)> = report
                    .targets
                    .into_iter()
                    .map(|t| (t.id, t.outcome))
                    .collect();
                assert_eq!(got, removed, "every purge target is removed");
            }
        }
    }

    fn is_purge(&self) -> bool {
        matches!(self, Change::Purge(_))
    }
}

/// One interleaved case, read from the document.
#[derive(Clone)]
struct Interleaved {
    case: Case,
    after_round: usize,
    change: Change,
    before: Expect,
    after: Expect,
}

fn interleaved(fx: &Fixture) -> Vec<Interleaved> {
    fx.doc["interleaved"]
        .as_array()
        .unwrap()
        .iter()
        .map(|raw| Interleaved {
            case: fx.case(raw),
            after_round: raw["afterRound"].as_u64().unwrap() as usize,
            change: fx.change(raw),
            before: fx.expect(&raw["expect"]["before"]),
            after: fx.expect(&raw["expect"]["after"]),
        })
        .collect()
}

/// The rule for a wrapper that starts again (README §5.5): `before` at the first revision or
/// `after` at a later one. `before` at a later revision is what a wrapper answers when it keeps
/// its old cache, and it fails.
fn wrapper_verdict(
    got: &Answer,
    revision: Revision,
    start: Revision,
    before: &Expect,
    after: &Expect,
) -> Result<(), String> {
    let is = |e: &Expect| got.same_read(e) && got.rounds == e.rounds;
    match (revision == start, revision > start) {
        (true, _) if is(before) => Ok(()),
        (_, true) if is(after) => Ok(()),
        (_, true) if is(before) => Err("`before` at a later revision".into()),
        _ => Err("neither `before` at the first revision nor `after` at a later one".into()),
    }
}

#[derive(Clone)]
struct Case {
    name: String,
    term: Term,
    root: String,
    now: f64,
    bindings: Option<Bindings>,
    pushdown: Pushdown,
    expect: Option<Expect>,
    raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
struct Expect {
    hex: String,
    scope: Vec<String>,
    members: Vec<String>,
    rounds: Vec<Vec<String>>,
}

/// What a reader answered, in the vector's terms.
#[derive(Debug, Clone, PartialEq)]
struct Answer {
    hex: String,
    scope: Vec<String>,
    members: Vec<String>,
    rounds: Vec<Vec<String>>,
}

impl Answer {
    fn of(read: &StoreRead) -> Self {
        Self {
            hex: result_canonical_hex(&read.result),
            scope: read.scope.clone(),
            members: read.members.clone(),
            rounds: read.rounds.iter().map(|r| r.anchors.clone()).collect(),
        }
    }

    /// Bytes, scope and members match. Rounds are checked apart.
    fn same_read(&self, e: &Expect) -> bool {
        self.hex == e.hex && self.scope == e.scope && self.members == e.members
    }
}

/// How a mode's rounds relate to `expect.rounds` (README §5.4).
#[derive(Clone, Copy)]
enum Rounds {
    /// Modes 3 and 5: exactly the expected anchors per call.
    Exact,
    /// Modes 2 and 4: round i asks for the union of rounds 0..=i.
    Cumulative,
    /// Mode 1 has no rounds.
    None,
}

fn cumulative(rounds: &[Vec<String>]) -> Vec<Vec<String>> {
    let mut so_far = BTreeSet::new();
    rounds
        .iter()
        .map(|r| {
            so_far.extend(r.iter().cloned());
            so_far.iter().cloned().collect()
        })
        .collect()
}

fn check(fx: &Fixture, label: &str, got: &Answer, e: &Expect, rounds: Rounds) {
    assert_eq!(got.hex, e.hex, "{label}: bytes");
    assert_eq!(got.scope, e.scope, "{label}: scope");
    assert_eq!(
        fx.names(&got.members),
        fx.names(&e.members),
        "{label}: members"
    );
    match rounds {
        Rounds::Exact => assert_eq!(got.rounds, e.rounds, "{label}: rounds"),
        Rounds::Cumulative => assert_eq!(got.rounds, cumulative(&e.rounds), "{label}: rounds"),
        Rounds::None => {}
    }
}

fn profiles() -> Vec<PushdownFields> {
    (0..8)
        .map(|bits| PushdownFields {
            timestamp_at_most: bits & 1 != 0,
            arrival_at_most: bits & 2 != 0,
            exclude_ids: bits & 4 != 0,
        })
        .collect()
}

/// A read of a case with the memo off (modes 2 and 3).
fn request<'a>(fx: &'a Fixture, case: &'a Case, cache: FetchCache) -> ReadRequest<'a> {
    request_with(fx, case, cache, EvalMemo::Off)
}

fn request_with<'a>(
    fx: &'a Fixture,
    case: &'a Case,
    cache: FetchCache,
    memo: EvalMemo,
) -> ReadRequest<'a> {
    ReadRequest {
        registry: Some(&fx.registry),
        bindings: case.bindings.as_ref(),
        selection: Selection {
            pushdown: Some(&case.pushdown),
            admits: None,
        },
        cache,
        memo,
        ..ReadRequest::new(&case.term, &case.root, case.now)
    }
}

/// The four modes in rounds (README §5.4): the fetch cache and the memo, each on or off.
const ROUND_MODES: [(&str, FetchCache, EvalMemo, Rounds); 4] = [
    (
        "no-cache",
        FetchCache::Off,
        EvalMemo::Off,
        Rounds::Cumulative,
    ),
    ("cache", FetchCache::On, EvalMemo::Off, Rounds::Exact),
    (
        "memo-no-cache",
        FetchCache::Off,
        EvalMemo::On,
        Rounds::Cumulative,
    ),
    ("memo-cache", FetchCache::On, EvalMemo::On, Rounds::Exact),
];

fn passes_all(p: &Pushdown, delta: &Delta, arrival: &ArrivalRecord) -> bool {
    p.timestamp_at_most
        .is_none_or(|t| delta.claims.timestamp <= t)
        && p.arrival_at_most.is_none_or(|n| arrival.sequence <= n)
        && p.exclude_ids
            .as_ref()
            .is_none_or(|ids| !ids.contains(&delta.id))
}

// ---------------------------------------------------------------------------------------------
// Mode 1: the whole surface, through the exporter
// ---------------------------------------------------------------------------------------------

fn whole_surface(fx: &Fixture, store: &MemoryStore, case: &Case) -> Answer {
    let exporter = store.open_admin();
    let listed: Vec<Delta> = exporter
        .peer(fx.peer_id())
        .unwrap()
        .deltas()
        .map(Result::unwrap)
        .collect();
    let kept: Vec<VerifiedDelta> = listed
        .into_iter()
        .filter_map(|delta| {
            let arrival = fx.arrivals[&delta.id].clone();
            passes_all(&case.pushdown, &delta, &arrival).then_some(VerifiedDelta { delta, arrival })
        })
        .collect();
    let source = scope_source(&kept).unwrap();
    let all = source.subset(
        &source
            .ids()
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>(),
    );
    let (gather, resolves) = match &case.term {
        Term::Resolve { of, .. } => (of.as_ref(), true),
        t => (t, false),
    };
    let eval = |t: &Term, set: &DeltaSet| {
        eval_term_at(
            t,
            set,
            case.now,
            Some(&case.root),
            Some(&fx.registry),
            case.bindings.as_ref(),
        )
        .unwrap()
    };
    let gathered = eval(gather, &all);
    let EvalResult::HView(view) = &gathered else {
        panic!("{}: the gather is not an HView", case.name)
    };
    let AnchorAnalysis::Anchored { anchors } =
        anchor_analysis(&case.term, Some(&fx.registry), case.bindings.as_ref())
    else {
        panic!("{}: unanchored", case.name)
    };
    let mut scope: BTreeSet<String> = anchors.into_iter().collect();
    scope.insert(case.root.clone());
    scope.extend(hview_anchors(view));
    let members = scope_ids(&source, scope.iter().map(String::as_str), None);
    let result = if resolves {
        eval(&case.term, &all)
    } else {
        gathered
    };
    Answer {
        hex: result_canonical_hex(&result),
        scope: scope.into_iter().collect(),
        members,
        rounds: Vec::new(),
    }
}

// ---------------------------------------------------------------------------------------------
// Snapshot and peer doubles
// ---------------------------------------------------------------------------------------------

/// One recorded snapshot call (README §5.8).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Call {
    op: &'static str,
    keys: usize,
    exclude: usize,
}

type Trace = Rc<RefCell<Vec<Call>>>;

/// A snapshot that records every call it forwards.
struct Tracing {
    inner: Box<dyn Snapshot>,
    trace: Trace,
}

impl Tracing {
    fn note(&self, op: &'static str, keys: usize, exclude: usize) {
        self.trace.borrow_mut().push(Call { op, keys, exclude });
    }
}

impl Snapshot for Tracing {
    fn revision(&self) -> Revision {
        self.inner.revision()
    }
    fn head(&self) -> Option<&str> {
        self.inner.head()
    }
    fn count(&self) -> u64 {
        self.inner.count()
    }
    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreError> {
        self.note("get", ids.len(), 0);
        self.inner.get(ids)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        self.note("arrivals", ids.len(), 0);
        self.inner.arrivals(ids)
    }
    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreError> {
        self.note("targets", entities.len(), 0);
        self.inner.targets(entities)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.note("negators", ids.len(), 0);
        self.inner.negators(ids)
    }
    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        self.note("scope", request.anchors.len(), request.exclude.len());
        self.inner.scope(request)
    }
    fn release(&mut self) {
        self.note("release", 0, 0);
        self.inner.release();
    }
}

/// A peer handle that counts snapshots and traces every call on them.
struct TracingPeer {
    inner: Box<dyn PeerStore>,
    reads: Rc<Cell<usize>>,
    trace: Trace,
}

impl PeerStore for TracingPeer {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn erasure(&self) -> PeerErasure {
        self.inner.erasure()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        self.reads.set(self.reads.get() + 1);
        Ok(Box::new(Tracing {
            inner: self.inner.read()?,
            trace: self.trace.clone(),
        }))
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.inner.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        self.inner.purge(ids)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreError> {
        self.inner.changes(from, to)
    }
}

fn tracing_peer(inner: Box<dyn PeerStore>) -> (TracingPeer, Rc<Cell<usize>>, Trace) {
    let reads = Rc::new(Cell::new(0));
    let trace: Trace = Rc::default();
    (
        TracingPeer {
            inner,
            reads: reads.clone(),
            trace: trace.clone(),
        },
        reads,
        trace,
    )
}

fn snapshot_double(
    inner: Box<dyn Snapshot>,
    scope: impl Fn(&dyn Snapshot, &ScopeRequest) -> Result<ScopeResult, StoreError> + 'static,
) -> Box<dyn Snapshot> {
    Box::new(Double {
        inner,
        scope: Box::new(scope),
    })
}

type ScopeFn = Box<dyn Fn(&dyn Snapshot, &ScopeRequest) -> Result<ScopeResult, StoreError>>;

/// A snapshot whose `scope` answer is computed by a closure over the real snapshot.
struct Double {
    inner: Box<dyn Snapshot>,
    scope: ScopeFn,
}

impl Snapshot for Double {
    fn revision(&self) -> Revision {
        self.inner.revision()
    }
    fn head(&self) -> Option<&str> {
        self.inner.head()
    }
    fn count(&self) -> u64 {
        self.inner.count()
    }
    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreError> {
        self.inner.get(ids)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        self.inner.arrivals(ids)
    }
    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.targets(entities)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.negators(ids)
    }
    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        (self.scope)(self.inner.as_ref(), request)
    }
    fn release(&mut self) {
        self.inner.release();
    }
}

/// A store answer that §4.3 allows and an exactly closed store never gives: it leaves
/// `timestampAtMost` to the host, and besides the exact scope it returns each direct negator of
/// a target-matched delta that fails that field, without the negator's own negators (SPEC-18
/// §4.12 reading 5). Over a memory snapshot that applies every field.
fn unclosed(inner: &dyn Snapshot, request: &ScopeRequest) -> Result<ScopeResult, StoreError> {
    let mut answer = inner.scope(request)?;
    let Some(p) = request.pushdown.as_ref() else {
        return Ok(answer);
    };
    let Some(t) = p.timestamp_at_most else {
        return Ok(answer);
    };
    let entities: Vec<String> = request
        .anchors
        .iter()
        .map(|Anchor::Entity { entity }| entity.clone())
        .collect();
    let others = Pushdown {
        timestamp_at_most: None,
        ..p.clone()
    };
    let held = |ids: &[String]| -> Result<Vec<VerifiedDelta>, StoreError> {
        let deltas = inner.get(ids)?;
        let arrivals: BTreeMap<String, ArrivalRecord> = inner
            .arrivals(ids)?
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect();
        Ok(deltas
            .into_iter()
            .map(|delta| VerifiedDelta {
                arrival: arrivals[&delta.id].clone(),
                delta,
            })
            .collect())
    };
    let failing: Vec<String> = held(&inner.targets(&entities)?)?
        .into_iter()
        .filter(|m| m.delta.claims.timestamp > t && passes_all(&others, &m.delta, &m.arrival))
        .map(|m| m.delta.id)
        .collect();
    let mut have: BTreeSet<String> = answer.deltas.iter().map(|m| m.delta.id.clone()).collect();
    have.extend(request.exclude.iter().cloned());
    for extra in held(&inner.negators(&failing)?)? {
        if !have.contains(&extra.delta.id) && passes_all(p, &extra.delta, &extra.arrival) {
            have.insert(extra.delta.id.clone());
            answer.deltas.push(extra);
        }
    }
    answer.deltas.sort_by(|a, b| a.delta.id.cmp(&b.delta.id));
    answer.applied.timestamp_at_most = false;
    Ok(answer)
}

// ---------------------------------------------------------------------------------------------
// A model reader with switchable faults: the wrong readers of README §5.8
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default)]
struct Faults {
    /// Sends the held ids as `pushdown.excludeIds` and treats them as part of the selection.
    exclude_as_selection: bool,
    /// Evaluates over S(anchors) of the whole cache, without the residual selection.
    skip_residual: bool,
    /// Asks for every anchor so far in every round, with the cache on.
    all_anchors: bool,
    /// Keeps only the last round's residual fields: the residual is not sticky.
    residual_last_only: bool,
    /// Keeps only the first round's residual fields.
    residual_first_only: bool,
}

/// The reader of README §5.3, written apart from the witness, with a fault switched on. `cache`
/// is passed in so that a caller can keep it across snapshots, which is another fault.
fn model_read(
    fx: &Fixture,
    snapshot: &dyn Snapshot,
    case: &Case,
    faults: Faults,
    cache: &mut ScopeSource,
    hook: &mut dyn FnMut(usize),
    resume: Option<&dyn PeerStore>,
) -> Result<Answer, StoreError> {
    // With `resume`, a call refused `snapshot-moved` is made again on a new snapshot of that
    // peer, and the read goes on with its cache and its anchors: a fault.
    let mut fresh: Option<Box<dyn Snapshot>> = None;
    let AnchorAnalysis::Anchored { anchors } =
        anchor_analysis(&case.term, Some(&fx.registry), case.bindings.as_ref())
    else {
        panic!("{}: unanchored", case.name)
    };
    let (gather, resolves) = match &case.term {
        Term::Resolve { of, .. } => (of.as_ref(), true),
        t => (t, false),
    };
    let p = &case.pushdown;
    let mut asked: BTreeSet<String> = BTreeSet::new();
    let mut next: BTreeSet<String> = anchors.into_iter().collect();
    next.insert(case.root.clone());
    let (mut ts, mut arr, mut ex) = (false, false, false);
    let mut dropped: BTreeSet<String> = BTreeSet::new();
    let mut rounds = Vec::new();
    loop {
        asked.extend(next.iter().cloned());
        let ask: Vec<String> = if faults.all_anchors {
            asked.iter().cloned().collect()
        } else {
            next.iter().cloned().collect()
        };
        let held: Vec<String> = cache.ids().into_iter().map(str::to_string).collect();
        let mut pushdown = p.clone();
        let exclude = if faults.exclude_as_selection {
            let mut ids: BTreeSet<String> = p
                .exclude_ids
                .clone()
                .unwrap_or_default()
                .into_iter()
                .collect();
            ids.extend(held);
            pushdown.exclude_ids = Some(ids.into_iter().collect());
            Vec::new()
        } else {
            held
        };
        let call = ScopeRequest {
            anchors: ask
                .iter()
                .map(|e| Anchor::Entity { entity: e.clone() })
                .collect(),
            pushdown: Some(pushdown.clone()),
            exclude,
        };
        let first = fresh.as_deref().unwrap_or(snapshot).scope(&call);
        let answer = match (first, resume) {
            (Err(e), Some(peer)) if e.code == StoreErrorCode::SnapshotMoved => {
                fresh = Some(peer.read()?);
                fresh.as_deref().unwrap().scope(&call)?
            }
            (first, _) => first?,
        };
        cache.extend(&answer.deltas)?;
        let this = (
            p.timestamp_at_most.is_some() && !answer.applied.timestamp_at_most,
            p.arrival_at_most.is_some() && !answer.applied.arrival_at_most,
            pushdown.exclude_ids.is_some() && !answer.applied.exclude_ids,
        );
        if this.2 {
            dropped.extend(pushdown.exclude_ids.clone().unwrap_or_default());
        }
        if faults.residual_last_only || (faults.residual_first_only && rounds.is_empty()) {
            (ts, arr, ex) = this;
        } else if !faults.residual_first_only {
            (ts, arr, ex) = (ts || this.0, arr || this.1, ex || this.2);
        }
        let residual = |delta: &Delta| {
            if faults.skip_residual {
                return true;
            }
            let arrival = cache.arrival(&delta.id).unwrap();
            !(ts && p
                .timestamp_at_most
                .is_some_and(|t| delta.claims.timestamp > t)
                || arr && p.arrival_at_most.is_some_and(|n| arrival.sequence > n)
                || ex && dropped.contains(&delta.id))
        };
        let members = scope_ids(&*cache, asked.iter().map(String::as_str), Some(&residual));
        let set = cache.subset(&members);
        let eval = |t: &Term| {
            eval_term_at(
                t,
                &set,
                case.now,
                Some(&case.root),
                Some(&fx.registry),
                case.bindings.as_ref(),
            )
            .unwrap()
        };
        let gathered = eval(gather);
        let EvalResult::HView(view) = &gathered else {
            panic!("not an HView")
        };
        rounds.push(ask);
        hook(rounds.len());
        let shown: BTreeSet<String> = hview_anchors(view)
            .into_iter()
            .filter(|a| !asked.contains(a))
            .collect();
        if shown.is_empty() {
            let result = if resolves { eval(&case.term) } else { gathered };
            return Ok(Answer {
                hex: result_canonical_hex(&result),
                scope: asked.into_iter().collect(),
                members,
                rounds,
            });
        }
        next = shown;
    }
}

/// Opens a new loaded store and one snapshot of its peer.
type Opener = Box<dyn Fn() -> (MemoryStore, Box<dyn Snapshot>)>;

/// Does this reader answer every case right, under every profile? Returns the first failure.
fn first_failure(
    fx: &Fixture,
    cases: &[Case],
    stores: &[(String, Opener)],
    faults: Faults,
) -> Option<String> {
    for (label, open) in stores {
        for case in cases {
            let e = case.expect.as_ref().unwrap();
            let (_store, snapshot) = open();
            let got = model_read(
                fx,
                snapshot.as_ref(),
                case,
                faults,
                &mut ScopeSource::default(),
                &mut |_| {},
                None,
            );
            match got {
                Ok(got) if got.same_read(e) && got.rounds == e.rounds => {}
                Ok(_) => return Some(format!("{label}/{}", case.name)),
                Err(err) => return Some(format!("{label}/{}: {err}", case.name)),
            }
        }
    }
    None
}

fn profile_stores(fx: &Rc<Fixture>) -> Vec<(String, Opener)> {
    profiles()
        .into_iter()
        .map(|profile| {
            let fx = fx.clone();
            let open: Opener = Box::new(move || {
                let store = MemoryStore::with_pushdown(profile);
                let snapshot = fx.load(&store).read().unwrap();
                (store, snapshot)
            });
            (format!("{profile:?}"), open)
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------------------------

#[test]
fn every_round_case_reads_the_same_five_ways_under_every_pushdown_profile() {
    let fx = fixture();
    let cases = fx.cases("cases");
    assert!(!cases.is_empty());
    for profile in profiles() {
        let store = MemoryStore::with_pushdown(profile);
        let peer = fx.load(&store);
        for case in &cases {
            let e = case.expect.as_ref().unwrap();
            let label = |mode: &str| format!("{}/{profile:?}/{mode}", case.name);
            check(
                &fx,
                &label("whole"),
                &whole_surface(&fx, &store, case),
                e,
                Rounds::None,
            );
            let mut reports: Vec<Vec<RoundReport>> = Vec::new();
            for (mode, cache, memo, rule) in ROUND_MODES {
                let mut snapshot = peer.read().unwrap();
                let mut seen = Vec::new();
                let mut hook = |r: &RoundReport| seen.push(r.clone());
                let read = read_anchored(
                    snapshot.as_ref(),
                    ReadRequest {
                        on_round: Some(&mut hook),
                        ..request_with(&fx, case, cache, memo)
                    },
                )
                .unwrap_or_else(|err| panic!("{}: {err}", label(mode)));
                assert_eq!(read.revision, snapshot.revision());
                assert_eq!(read.snapshots, 1);
                check(&fx, &label(mode), &Answer::of(&read), e, rule);
                assert_eq!(seen, read.rounds, "{}: the hook", label(mode));
                reports.push(read.rounds);
                snapshot.release();
            }
            // The memo changes no report (README §5.8): modes 2 and 4, and modes 3 and 5.
            assert_eq!(reports[0], reports[2], "{}", label("memo-no-cache reports"));
            assert_eq!(reports[1], reports[3], "{}", label("memo-cache reports"));
        }
    }
}

#[test]
fn the_selection_as_a_host_predicate_reads_the_same() {
    let fx = fixture();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    for case in fx.cases("cases") {
        let e = case.expect.as_ref().unwrap();
        let p = case.pushdown.clone();
        let admits = move |d: &Delta, a: &ArrivalRecord| passes_all(&p, d, a);
        let snapshot = peer.read().unwrap();
        let read = read_anchored(
            snapshot.as_ref(),
            ReadRequest {
                selection: Selection {
                    pushdown: None,
                    admits: Some(&admits),
                },
                ..request(&fx, &case, FetchCache::On)
            },
        )
        .unwrap();
        check(
            &fx,
            &format!("{}/admits", case.name),
            &Answer::of(&read),
            e,
            Rounds::Exact,
        );
        // The store saw no pushdown, so every round reported nothing applied.
        assert!(read
            .rounds
            .iter()
            .all(|r| r.applied == PushdownFields::default()));
    }
}

#[test]
fn every_round_is_one_scope_call_for_that_rounds_anchors_and_nothing_else() {
    let fx = fixture();
    for profile in profiles() {
        let store = MemoryStore::with_pushdown(profile);
        let peer = fx.load(&store);
        for case in fx.cases("cases") {
            let e = case.expect.as_ref().unwrap();
            let trace: Trace = Rc::default();
            let snapshot = Tracing {
                inner: peer.read().unwrap(),
                trace: trace.clone(),
            };
            let mut seen = Vec::new();
            let mut hook = |r: &RoundReport| seen.push(r.clone());
            let read = read_anchored(
                &snapshot,
                ReadRequest {
                    on_round: Some(&mut hook),
                    ..request(&fx, &case, FetchCache::On)
                },
            )
            .unwrap();
            // The hook runs once after every round, the last one included.
            assert_eq!(seen, read.rounds, "{}: the hook", case.name);
            assert!(
                read.rounds.iter().enumerate().all(|(i, r)| r.round == i + 1
                    && r.attempt == 1
                    && r.revision == snapshot.revision()),
                "{}: round, attempt and revision",
                case.name
            );
            let calls = trace.borrow().clone();
            assert_eq!(
                calls.len(),
                e.rounds.len(),
                "{}: one call per round",
                case.name
            );
            let mut held = 0;
            for (i, (call, round)) in calls.iter().zip(&read.rounds).enumerate() {
                assert_eq!(call.op, "scope", "{}: round {}", case.name, i + 1);
                assert_eq!(
                    call.keys,
                    e.rounds[i].len(),
                    "{}: round {} keys",
                    case.name,
                    i + 1
                );
                assert_eq!(
                    call.exclude,
                    held,
                    "{}: round {} excludes every id held",
                    case.name,
                    i + 1
                );
                held = round.held;
            }
        }
    }
}

/// A pushdown field a double can leave to the host.
#[derive(Debug, Clone, Copy)]
enum Field {
    Timestamp,
    Arrival,
    ExcludeIds,
}

const FIELDS: [Field; 3] = [Field::Timestamp, Field::Arrival, Field::ExcludeIds];

impl Field {
    fn strip(self, p: &mut Pushdown) {
        match self {
            Field::Timestamp => p.timestamp_at_most = None,
            Field::Arrival => p.arrival_at_most = None,
            Field::ExcludeIds => p.exclude_ids = None,
        }
    }

    fn report(self, applied: &mut PushdownFields, value: bool) {
        match self {
            Field::Timestamp => applied.timestamp_at_most = value,
            Field::Arrival => applied.arrival_at_most = value,
            Field::ExcludeIds => applied.exclude_ids = value,
        }
    }
}

/// On which `scope` calls a double leaves its field to the host.
#[derive(Debug, Clone, Copy)]
enum Leaves {
    Odd,
    Even,
    Always,
}

/// A snapshot over the memory store that leaves `field` to the host on the calls `leaves` names:
/// the store does not see the field there, and the answer reports it not applied.
fn leaving(inner: Box<dyn Snapshot>, field: Field, leaves: Leaves) -> Box<dyn Snapshot> {
    let calls = Cell::new(0usize);
    snapshot_double(inner, move |inner, r| {
        calls.set(calls.get() + 1);
        let odd = calls.get() % 2 == 1;
        let leave = match leaves {
            Leaves::Odd => odd,
            Leaves::Even => !odd,
            Leaves::Always => true,
        };
        if !leave {
            return inner.scope(r);
        }
        let mut stripped = r.clone();
        if let Some(p) = stripped.pushdown.as_mut() {
            field.strip(p);
        }
        let mut answer = inner.scope(&stripped)?;
        field.report(&mut answer.applied, false);
        Ok(answer)
    })
}

/// A sticky residual (SPEC-18 §4.12 readings 2 and 20; README §5.8). No vector pins it, because a
/// memory profile is the same in every round. A double leaves one field to the host in the odd
/// rounds only, then in the even rounds only, then in every round. The witness passes all three.
/// A control reader that never applies the residual fails, and so does a reader that keeps only
/// the last round's residual or only the first's.
#[test]
fn a_residual_field_stays_residual_for_the_rest_of_the_read() {
    let fx = Rc::new(fixture());
    let cases = fx.cases("cases");
    let all = [Leaves::Odd, Leaves::Even, Leaves::Always];
    for field in FIELDS {
        for leaves in all {
            let store = MemoryStore::new();
            let peer = fx.load(&store);
            for case in &cases {
                let snapshot = leaving(peer.read().unwrap(), field, leaves);
                let read =
                    read_anchored(snapshot.as_ref(), request(&fx, case, FetchCache::On)).unwrap();
                check(
                    &fx,
                    &format!("{}/{field:?}/{leaves:?}", case.name),
                    &Answer::of(&read),
                    case.expect.as_ref().unwrap(),
                    Rounds::Exact,
                );
            }
        }
    }
    let stores = |leaves: Leaves| -> Vec<(String, Opener)> {
        FIELDS
            .into_iter()
            .map(|field| {
                let fx = fx.clone();
                let open: Opener = Box::new(move || {
                    let store = MemoryStore::new();
                    let snapshot = leaving(fx.load(&store).read().unwrap(), field, leaves);
                    (store, snapshot)
                });
                (format!("{field:?}/{leaves:?}"), open)
            })
            .collect()
    };
    for leaves in all {
        assert_eq!(
            first_failure(&fx, &cases, &stores(leaves), Faults::default()),
            None,
            "the model reader, {leaves:?}"
        );
    }
    let never = Faults {
        skip_residual: true,
        ..Faults::default()
    };
    assert!(
        first_failure(&fx, &cases, &stores(Leaves::Always), never).is_some(),
        "the control that never applies the residual"
    );
    // Keeping only the first round's residual is right when round 1 left the field, so only the
    // even parity shows it. Keeping only the last round's is right when the last round left the
    // field; the cases end on odd and on even rounds, so the odd parity shows it here.
    let first_only = Faults {
        residual_first_only: true,
        ..Faults::default()
    };
    assert_eq!(
        first_failure(&fx, &cases, &stores(Leaves::Odd), first_only),
        None
    );
    assert!(first_failure(&fx, &cases, &stores(Leaves::Even), first_only).is_some());
    let last_only = Faults {
        residual_last_only: true,
        ..Faults::default()
    };
    assert!(first_failure(&fx, &cases, &stores(Leaves::Odd), last_only).is_some());
}

/// The read trusts `applied` (SPEC-18 §4.12 reading 18; README §5.8). A double drops
/// `timestampAtMost` and reports it applied, and the read answers wrong. The trust is a stated
/// assumption: the store vectors catch the lie, not the read.
#[test]
fn a_store_that_lies_about_applied_makes_the_read_wrong() {
    let fx = fixture();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    let cut: Vec<Case> = fx
        .cases("cases")
        .into_iter()
        .filter(|c| c.pushdown.timestamp_at_most.is_some())
        .collect();
    assert!(!cut.is_empty());
    let mut wrong = Vec::new();
    for case in &cut {
        let snapshot = snapshot_double(peer.read().unwrap(), |inner, r| {
            let mut stripped = r.clone();
            if let Some(p) = stripped.pushdown.as_mut() {
                Field::Timestamp.strip(p);
            }
            let mut answer = inner.scope(&stripped)?;
            Field::Timestamp.report(&mut answer.applied, true);
            Ok(answer)
        });
        let read = read_anchored(snapshot.as_ref(), request(&fx, case, FetchCache::On)).unwrap();
        if !Answer::of(&read).same_read(case.expect.as_ref().unwrap()) {
            wrong.push(case.name.clone());
        }
    }
    assert!(
        !wrong.is_empty(),
        "a store that lies about applied left every read right"
    );
}

#[test]
fn the_reader_passes_against_a_store_that_returns_an_unclosed_extra() {
    let fx = fixture();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    let mut extra_seen = false;
    let late = fx.id("b1-late-note-neg-at-c2");
    for case in fx.cases("cases") {
        let e = case.expect.as_ref().unwrap();
        let snapshot = snapshot_double(peer.read().unwrap(), unclosed);
        let read = read_anchored(snapshot.as_ref(), request(&fx, &case, FetchCache::On)).unwrap();
        check(
            &fx,
            &format!("{}/unclosed", case.name),
            &Answer::of(&read),
            e,
            Rounds::Exact,
        );
        // Does the double hand over the late note's negation in round 2, before its anchor?
        if case.pushdown.timestamp_at_most.is_some() && e.rounds.len() > 1 {
            let answer = snapshot
                .scope(&ScopeRequest {
                    anchors: e.rounds[1]
                        .iter()
                        .map(|x| Anchor::Entity { entity: x.clone() })
                        .collect(),
                    pushdown: Some(case.pushdown.clone()),
                    exclude: Vec::new(),
                })
                .unwrap();
            extra_seen |= answer.deltas.iter().any(|m| m.delta.id == late);
        }
    }
    assert!(
        extra_seen,
        "the double never returned the unclosed extra; it tests nothing"
    );
}

#[test]
fn a_member_whose_id_does_not_recompute_is_refused() {
    let fx = fixture();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    let case = &fx.cases("cases")[0];
    let snapshot = snapshot_double(peer.read().unwrap(), |inner, r| {
        let mut answer = inner.scope(r)?;
        if let Some(first) = answer.deltas.first_mut() {
            first.delta.claims.timestamp += 1.0;
        }
        Ok(answer)
    });
    let err = read_anchored(snapshot.as_ref(), request(&fx, case, FetchCache::On)).unwrap_err();
    assert_eq!(err.store_code(), Some(StoreErrorCode::InvalidRequest));
}

#[test]
fn each_refusal_carries_its_reason_and_makes_no_store_call() {
    let fx = fixture();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    let refusals = fx.cases("refusals");
    assert!(!refusals.is_empty());
    for case in &refusals {
        let reason = case.raw["expect"]["reason"].as_str().unwrap();
        let trace: Trace = Rc::default();
        let snapshot = Tracing {
            inner: peer.read().unwrap(),
            trace: trace.clone(),
        };
        let err = read_anchored(&snapshot, request(&fx, case, FetchCache::On)).unwrap_err();
        assert!(
            matches!(err, StoreReadError::Unanchored(r) if r.as_str() == reason),
            "{}: {err:?}",
            case.name
        );
        assert_eq!(err.to_string(), format!("term is not anchored: {reason}"));
        assert_eq!(*trace.borrow(), vec![], "{}: no store call", case.name);

        let (traced, reads, trace) = tracing_peer(store.peer(fx.peer_id()).unwrap());
        let reactor = StoreReactor::open(Box::new(traced));
        assert!(matches!(
            reactor.read(request(&fx, case, FetchCache::On)),
            Err(StoreReadError::Unanchored(_))
        ));
        assert_eq!(
            (reads.get(), trace.borrow().len()),
            (0, 0),
            "{}: the reactor takes no snapshot",
            case.name
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Interleaved changes
// ---------------------------------------------------------------------------------------------

#[test]
fn the_interleaved_vectors_hold_both_kinds_of_change() {
    let fx = fixture();
    let cases = interleaved(&fx);
    assert!(cases.iter().any(|c| c.change.is_purge()), "a purge case");
    assert!(cases.iter().any(|c| !c.change.is_purge()), "an append case");
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    for c in &cases {
        let name = &c.case.name;
        assert_ne!(
            c.before.hex, c.after.hex,
            "{name}: the change changes the answer"
        );
        assert!(
            (1..=c.before.rounds.len()).contains(&c.after_round),
            "{name}"
        );
        if let Change::Purge(ids) = &c.change {
            // The purged delta is one that round 1 fetches (README §5.5).
            let first = peer
                .read()
                .unwrap()
                .scope(&ScopeRequest {
                    anchors: c.before.rounds[0]
                        .iter()
                        .map(|entity| Anchor::Entity {
                            entity: entity.clone(),
                        })
                        .collect(),
                    pushdown: Some(c.case.pushdown.clone()),
                    exclude: Vec::new(),
                })
                .unwrap();
            for id in ids {
                assert!(
                    first.deltas.iter().any(|m| &m.delta.id == id),
                    "{name}: round 1 fetches {}",
                    fx.names(std::slice::from_ref(id))[0]
                );
            }
        }
    }
}

#[test]
fn a_change_between_rounds_answers_snapshot_moved_or_the_old_answer() {
    let fx = fixture();
    for (c, memo) in interleaved(&fx)
        .into_iter()
        .flat_map(|c| [(c.clone(), EvalMemo::Off), (c, EvalMemo::On)])
    {
        let name = &format!("{}/{memo:?}", c.case.name);
        let last = c.after_round == c.before.rounds.len();

        // One snapshot: snapshot-moved, or `before` at the snapshot's revision.
        let store = MemoryStore::new();
        let peer = fx.load(&store);
        let writer = store.peer(fx.peer_id()).unwrap();
        let mut snapshot = peer.read().unwrap();
        let start = snapshot.revision();
        let mut seen: Vec<RoundReport> = Vec::new();
        let mut hook = |r: &RoundReport| {
            seen.push(r.clone());
            if r.round == c.after_round {
                c.change.apply(writer.as_ref());
            }
        };
        let outcome = read_anchored(
            snapshot.as_ref(),
            ReadRequest {
                on_round: Some(&mut hook),
                ..request_with(&fx, &c.case, FetchCache::On, memo)
            },
        );
        match outcome {
            Ok(read) => {
                assert!(
                    last,
                    "{name}: the memory store refuses a call after the change"
                );
                assert_eq!(read.revision, start);
                check(
                    &fx,
                    &format!("{name}/before"),
                    &Answer::of(&read),
                    &c.before,
                    Rounds::Exact,
                );
                assert_eq!(seen, read.rounds, "{name}: the hook saw every round");
            }
            Err(err) => {
                assert!(!last, "{name}: {err}");
                assert_eq!(
                    err.store_code(),
                    Some(StoreErrorCode::SnapshotMoved),
                    "{name}"
                );
                assert_eq!(seen.len(), c.after_round, "{name}: the hook");
            }
        }
        snapshot.release();
        assert!(
            peer.read().unwrap().revision() > start,
            "{name}: the hook ran after round {}",
            c.after_round
        );

        // The reactor: `before` at the first revision, or `after` at a later one. Never a mix,
        // and never `before` at a later revision.
        let store = MemoryStore::new();
        let peer = fx.load(&store);
        let start = peer.read().unwrap().revision();
        let writer = store.peer(fx.peer_id()).unwrap();
        let (traced, reads, trace) = tracing_peer(peer);
        let reactor = StoreReactor::open(Box::new(traced));
        let mut changed = false;
        let mut seen: Vec<RoundReport> = Vec::new();
        let mut hook = |r: &RoundReport| {
            seen.push(r.clone());
            if r.round == c.after_round && !changed {
                changed = true;
                c.change.apply(writer.as_ref());
            }
        };
        let read = reactor
            .read(ReadRequest {
                on_round: Some(&mut hook),
                ..request_with(&fx, &c.case, FetchCache::On, memo)
            })
            .unwrap();
        wrapper_verdict(
            &Answer::of(&read),
            read.revision,
            start,
            &c.before,
            &c.after,
        )
        .unwrap_or_else(|why| panic!("{name}/reactor: {why}"));
        assert_eq!(read.snapshots, if last { 1 } else { 2 }, "{name}");
        let releases = trace.borrow().iter().filter(|c| c.op == "release").count();
        assert_eq!(
            (reads.get(), releases),
            (read.snapshots, read.snapshots),
            "{name}: every snapshot is released"
        );

        // The hook saw every attempt, each round numbered from 1 on its snapshot; the reports of
        // the last attempt are the read's own.
        for attempt in 1..=read.snapshots {
            let rounds: Vec<&RoundReport> = seen.iter().filter(|r| r.attempt == attempt).collect();
            assert!(!rounds.is_empty(), "{name}: attempt {attempt}");
            assert!(rounds.iter().enumerate().all(|(i, r)| r.round == i + 1));
        }
        assert_eq!(
            seen.len(),
            seen.iter().filter(|r| r.attempt <= read.snapshots).count()
        );
        let own: Vec<RoundReport> = seen
            .iter()
            .filter(|r| r.attempt == read.snapshots)
            .cloned()
            .collect();
        assert_eq!(
            own, read.rounds,
            "{name}: the hook's reports are the read's"
        );
        assert!(read.rounds.iter().all(|r| r.revision == read.revision));
        if read.snapshots == 2 {
            let first = seen.first().unwrap();
            assert_eq!(
                (first.attempt, first.revision),
                (1, start),
                "{name}: the first attempt"
            );
            assert_eq!(first.round, read.rounds[0].round);
            assert_ne!(first.attempt, read.rounds[0].attempt);
            assert_ne!(first.revision, read.rounds[0].revision);
        }
    }
}

/// A peer handle whose snapshots answer `scope` by a closure. It counts snapshots and releases.
struct ScriptedPeer {
    inner: Box<dyn PeerStore>,
    reads: Rc<Cell<usize>>,
    releases: Rc<Cell<usize>>,
    scope: SharedScope,
}

type SharedScope = Rc<dyn Fn(&dyn Snapshot, &ScopeRequest) -> Result<ScopeResult, StoreError>>;

impl PeerStore for ScriptedPeer {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn erasure(&self) -> PeerErasure {
        self.inner.erasure()
    }
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        self.reads.set(self.reads.get() + 1);
        let scope = self.scope.clone();
        Ok(Box::new(Released {
            inner: snapshot_double(self.inner.read()?, move |s, r| scope(s, r)),
            releases: self.releases.clone(),
        }))
    }
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.inner.append(batch)
    }
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        self.inner.purge(ids)
    }
    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreError> {
        self.inner.changes(from, to)
    }
}

/// A snapshot that counts its releases.
struct Released {
    inner: Box<dyn Snapshot>,
    releases: Rc<Cell<usize>>,
}

impl Snapshot for Released {
    fn revision(&self) -> Revision {
        self.inner.revision()
    }
    fn head(&self) -> Option<&str> {
        self.inner.head()
    }
    fn count(&self) -> u64 {
        self.inner.count()
    }
    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreError> {
        self.inner.get(ids)
    }
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        self.inner.arrivals(ids)
    }
    fn targets(&self, e: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.targets(e)
    }
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.inner.negators(ids)
    }
    fn scope(&self, r: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        self.inner.scope(r)
    }
    fn release(&mut self) {
        self.releases.set(self.releases.get() + 1);
        self.inner.release();
    }
}

/// A reactor over a loaded peer whose `scope` answers come from `scope`, with its snapshot and
/// release counters.
fn scripted(
    fx: &Fixture,
    store: &MemoryStore,
    scope: SharedScope,
) -> (StoreReactor, Rc<Cell<usize>>, Rc<Cell<usize>>) {
    let reads = Rc::new(Cell::new(0));
    let releases = Rc::new(Cell::new(0));
    let reactor = StoreReactor::open(Box::new(ScriptedPeer {
        inner: fx.load(store),
        reads: reads.clone(),
        releases: releases.clone(),
        scope,
    }));
    (reactor, reads, releases)
}

#[test]
fn the_reactor_gives_up_after_three_retries_and_releases_every_snapshot() {
    let fx = fixture();
    let store = MemoryStore::new();
    let (reactor, reads, releases) = scripted(
        &fx,
        &store,
        Rc::new(|_, _| Err(StoreError::new(StoreErrorCode::SnapshotMoved, "moved"))),
    );
    let case = &fx.cases("cases")[0];
    let err = reactor
        .read(request(&fx, case, FetchCache::On))
        .unwrap_err();
    assert_eq!(err.store_code(), Some(StoreErrorCode::SnapshotMoved));
    assert_eq!(
        (reads.get(), releases.get()),
        (SNAPSHOT_RETRIES + 1, SNAPSHOT_RETRIES + 1)
    );
    let err = reactor
        .fetch(&["garden:1".to_string()], Selection::default())
        .unwrap_err();
    assert_eq!(err.code, StoreErrorCode::SnapshotMoved);
    assert_eq!(
        (reads.get(), releases.get()),
        (2 * (SNAPSHOT_RETRIES + 1), 2 * (SNAPSHOT_RETRIES + 1))
    );
}

/// Any refusal but `snapshot-moved` passes up after one attempt, and the snapshot is released
/// (SPEC-18 §4.12 reading 11; README §5.8). The double refuses only the first `scope` call, so a
/// wrapper that started again would answer.
#[test]
fn another_refusal_passes_up_after_one_attempt_and_releases_the_snapshot() {
    let fx = fixture();
    let case = &fx.cases("cases")[0];
    for code in [
        StoreErrorCode::SnapshotReleased,
        StoreErrorCode::CapabilityAbsent,
    ] {
        for op in ["read", "fetch"] {
            let store = MemoryStore::new();
            let calls = Rc::new(Cell::new(0usize));
            let counter = calls.clone();
            let (reactor, reads, releases) = scripted(
                &fx,
                &store,
                Rc::new(move |inner, r| {
                    counter.set(counter.get() + 1);
                    if counter.get() == 1 {
                        Err(StoreError::new(code, "refused once"))
                    } else {
                        inner.scope(r)
                    }
                }),
            );
            let got = match op {
                "read" => reactor
                    .read(request(&fx, case, FetchCache::On))
                    .map(|_| ())
                    .map_err(|e| e.store_code()),
                _ => reactor
                    .fetch(&["garden:1".to_string()], Selection::default())
                    .map(|_| ())
                    .map_err(|e| Some(e.code)),
            };
            assert_eq!(got, Err(Some(code)), "{op}/{code:?}");
            assert_eq!(
                (reads.get(), releases.get(), calls.get()),
                (1, 1, 1),
                "{op}/{code:?}: one attempt, released"
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Wrong readers (README §5.8)
// ---------------------------------------------------------------------------------------------

#[test]
fn the_model_reader_with_no_fault_passes_every_case() {
    let fx = Rc::new(fixture());
    let cases = fx.cases("cases");
    let stores = profile_stores(&fx);
    assert_eq!(first_failure(&fx, &cases, &stores, Faults::default()), None);
    let unclosed_store: Vec<(String, Opener)> = {
        let fx = fx.clone();
        vec![(
            "unclosed".to_string(),
            Box::new(move || {
                let store = MemoryStore::new();
                let snapshot = snapshot_double(fx.load(&store).read().unwrap(), unclosed);
                (store, snapshot)
            }),
        )]
    };
    assert_eq!(
        first_failure(&fx, &cases, &unclosed_store, Faults::default()),
        None
    );
}

#[test]
fn a_reader_that_sends_held_ids_as_a_selection_fails_a_case() {
    let fx = Rc::new(fixture());
    let cases = fx.cases("cases");
    let faults = Faults {
        exclude_as_selection: true,
        ..Faults::default()
    };
    // Where the store leaves excludeIds to the host.
    let off = {
        let fx = fx.clone();
        let open: Opener = Box::new(move || {
            let store = MemoryStore::with_pushdown(PushdownFields {
                timestamp_at_most: true,
                arrival_at_most: true,
                exclude_ids: false,
            });
            let snapshot = fx.load(&store).read().unwrap();
            (store, snapshot)
        });
        vec![("excludeIds-off".to_string(), open)]
    };
    assert!(first_failure(&fx, &cases, &off, faults).is_some());
    // Against a store that applies every field but returns the unclosed extra of reading 5. On a
    // store that applies every field and returns closed scopes, the fault shows nothing.
    let full = {
        let fx = fx.clone();
        let open: Opener = Box::new(move || {
            let store = MemoryStore::new();
            let snapshot = fx.load(&store).read().unwrap();
            (store, snapshot)
        });
        vec![("full".to_string(), open)]
    };
    assert_eq!(first_failure(&fx, &cases, &full, faults), None);
    let double = {
        let fx = fx.clone();
        let open: Opener = Box::new(move || {
            let store = MemoryStore::new();
            let snapshot = snapshot_double(fx.load(&store).read().unwrap(), unclosed);
            (store, snapshot)
        });
        vec![("unclosed".to_string(), open)]
    };
    let failure = first_failure(&fx, &cases, &double, faults);
    assert!(failure.is_some());
}

#[test]
fn a_reader_that_skips_the_residual_selection_fails_a_case() {
    let fx = Rc::new(fixture());
    let cases = fx.cases("cases");
    let faults = Faults {
        skip_residual: true,
        ..Faults::default()
    };
    assert!(first_failure(&fx, &cases, &profile_stores(&fx), faults).is_some());
}

#[test]
fn a_reader_that_asks_for_every_anchor_every_round_fails_the_rounds() {
    let fx = Rc::new(fixture());
    let cases = fx.cases("cases");
    let faults = Faults {
        all_anchors: true,
        ..Faults::default()
    };
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    let mut wrong_rounds = 0;
    for case in &cases {
        let e = case.expect.as_ref().unwrap();
        let snapshot = peer.read().unwrap();
        let got = model_read(
            &fx,
            snapshot.as_ref(),
            case,
            faults,
            &mut ScopeSource::default(),
            &mut |_| {},
            None,
        )
        .unwrap();
        assert!(got.same_read(e), "{}: its answers are right", case.name);
        wrong_rounds += usize::from(got.rounds != e.rounds);
    }
    assert!(wrong_rounds > 0);
}

/// A reader that goes on in the middle of a read on a new snapshot, with its cache and its
/// anchors, answers neither on an append case (README §5.8).
#[test]
fn a_reader_that_goes_on_mid_read_on_a_new_snapshot_answers_neither() {
    let fx = fixture();
    let mut neither = Vec::new();
    for c in interleaved(&fx)
        .into_iter()
        .filter(|c| !c.change.is_purge())
    {
        let store = MemoryStore::new();
        let peer = fx.load(&store);
        let writer = store.peer(fx.peer_id()).unwrap();
        let snapshot = peer.read().unwrap();
        let mut hook = |round: usize| {
            if round == c.after_round {
                c.change.apply(writer.as_ref());
            }
        };
        // On `snapshot-moved` it takes a new snapshot and goes on with what it holds.
        let got = model_read(
            &fx,
            snapshot.as_ref(),
            &c.case,
            Faults::default(),
            &mut ScopeSource::default(),
            &mut hook,
            Some(peer.as_ref()),
        )
        .unwrap();
        if !got.same_read(&c.before) && !got.same_read(&c.after) {
            neither.push(c.case.name.clone());
        }
    }
    assert!(
        !neither.is_empty(),
        "a reader that mixed two snapshots went unnoticed"
    );
}

/// A wrapper that starts again on a new snapshot but keeps its old cache (README §5.8; SPEC-18
/// §4.12 reading 11). Under appends alone it answers `after`, because everything it kept is still
/// held. After the purge it answers `before` at the later revision, and the wrapper rule fails it.
#[test]
fn a_wrapper_that_keeps_its_cache_when_it_starts_again_fails_the_purge_case() {
    let fx = fixture();
    let mut failed = Vec::new();
    for c in interleaved(&fx) {
        let name = &c.case.name;
        let store = MemoryStore::new();
        let peer = fx.load(&store);
        let start = peer.read().unwrap().revision();
        let writer = store.peer(fx.peer_id()).unwrap();
        let mut changed = false;
        let mut hook = |round: usize| {
            if round == c.after_round && !changed {
                changed = true;
                c.change.apply(writer.as_ref());
            }
        };
        let mut cache = ScopeSource::default();
        let (got, revision) = loop {
            let snapshot = peer.read().unwrap();
            match model_read(
                &fx,
                snapshot.as_ref(),
                &c.case,
                Faults::default(),
                &mut cache,
                &mut hook,
                None,
            ) {
                Ok(got) => break (got, snapshot.revision()),
                Err(e) if e.code == StoreErrorCode::SnapshotMoved => continue,
                Err(e) => panic!("{name}: {e}"),
            }
        };
        match wrapper_verdict(&got, revision, start, &c.before, &c.after) {
            Ok(()) => assert!(!c.change.is_purge(), "{name}: the stale cache went unseen"),
            Err(why) => {
                assert!(c.change.is_purge(), "{name}: under appends alone: {why}");
                assert!(
                    got.same_read(&c.before) && revision > start,
                    "{name}: {why}"
                );
                failed.push(name.clone());
            }
        }
    }
    assert!(
        !failed.is_empty(),
        "no case caught a cache kept across snapshots"
    );
}

// ---------------------------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------------------------

/// Deltas that point at no entity of the fixture: facts on other entities and strikes on some.
fn unrelated(count: usize) -> Vec<Delta> {
    let facts: Vec<Delta> = (0..count)
        .map(|i| {
            let claims = Claims {
                timestamp: i as f64,
                valid_from: 0.0,
                valid_until: None,
                author: "did:key:zBystander".into(),
                pointers: vec![
                    Pointer {
                        role: "subject".into(),
                        target: Target::Entity(EntityRef {
                            id: format!("other:{}", i % 13),
                            context: Some("v".into()),
                        }),
                    },
                    Pointer {
                        role: "value".into(),
                        target: Target::Primitive(Primitive::Num(i as f64)),
                    },
                ],
            };
            make_delta(claims, None).unwrap()
        })
        .collect();
    let strikes: Vec<Delta> = facts
        .iter()
        .take(count / 10)
        .enumerate()
        .map(|(i, fact)| {
            make_delta(
                make_negation_claims("did:key:zStriker", 5000.0 + i as f64, &fact.id, None),
                None,
            )
            .unwrap()
        })
        .collect();
    facts.into_iter().chain(strikes).collect()
}

fn loaded_beside(fx: &Fixture, noise: usize) -> (MemoryStore, Box<dyn PeerStore>) {
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    let deltas = unrelated(noise);
    if !deltas.is_empty() {
        let head = peer.read().unwrap().head().map(str::to_string);
        commit(
            peer.as_ref(),
            &Admission {
                expected_head: head,
                next_head: "noise-head".into(),
                frame: None,
                added: deltas
                    .into_iter()
                    .zip(1000u64..)
                    .map(|(delta, sequence)| VerifiedDelta {
                        arrival: ArrivalRecord {
                            id: delta.id.clone(),
                            at: 9000.0,
                            sequence,
                            transfer: 9,
                            sender: "noise".into(),
                        },
                        delta,
                    })
                    .collect(),
            },
        );
    }
    store.reset_meter();
    (store, peer)
}

fn traced_read(
    fx: &Fixture,
    store: &MemoryStore,
    peer: Box<dyn PeerStore>,
    case: &Case,
) -> (Vec<Call>, StoreMeter, Answer) {
    let (traced, _, trace) = tracing_peer(peer);
    let reactor = StoreReactor::open(Box::new(traced));
    store.reset_meter();
    let read = reactor.read(request(fx, case, FetchCache::On)).unwrap();
    let calls = trace.borrow().clone();
    (calls, store.meter(), Answer::of(&read))
}

#[test]
fn a_read_costs_the_same_beside_zero_and_4400_unrelated_deltas() {
    let fx = fixture();
    for case in fx.cases("cases") {
        let (quiet, quiet_peer) = loaded_beside(&fx, 0);
        let (noisy, noisy_peer) = loaded_beside(&fx, 4000);
        assert_eq!(
            noisy.open_admin().peer(fx.peer_id()).unwrap().ids().count(),
            fx.loaded() + 4400
        );
        let (calls_q, meter_q, answer_q) = traced_read(&fx, &quiet, quiet_peer, &case);
        let (calls_n, meter_n, answer_n) = traced_read(&fx, &noisy, noisy_peer, &case);
        assert_eq!(answer_q, answer_n, "{}", case.name);
        assert_eq!(calls_q, calls_n, "{}: the same store calls", case.name);
        assert_eq!(meter_q, meter_n, "{}: the same index work", case.name);
        assert_eq!(meter_n.scans, 0, "{}: nothing scans", case.name);
        let e = case.expect.as_ref().unwrap();
        let ops: Vec<&str> = calls_n.iter().map(|c| c.op).collect();
        let mut expected = vec!["scope"; e.rounds.len()];
        expected.push("release");
        assert_eq!(ops, expected, "{}", case.name);
    }
}

#[test]
fn opening_a_store_reactor_reads_nothing() {
    let fx = fixture();
    let store = MemoryStore::new();
    let (traced, reads, trace) = tracing_peer(fx.load(&store));
    store.reset_meter();
    let reactor = StoreReactor::open(Box::new(traced));
    assert_eq!((reads.get(), trace.borrow().len()), (0, 0));
    assert_eq!(store.meter(), StoreMeter::default());
    assert_eq!(reactor.peer().id(), fx.peer_id());
}

// ---------------------------------------------------------------------------------------------
// fetch_scope
// ---------------------------------------------------------------------------------------------

#[test]
fn a_fetch_knows_exactly_the_scope_and_nothing_the_store_returned_beyond_it() {
    let fx = fixture();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    let selection = Pushdown {
        timestamp_at_most: Some(60.0),
        ..Pushdown::default()
    };
    let entities = vec![
        "bed:1".to_string(),
        "bed:1".to_string(),
        "bed:2".to_string(),
    ];
    let snapshot = snapshot_double(peer.read().unwrap(), unclosed);
    let raw = snapshot
        .scope(&ScopeRequest {
            anchors: vec![Anchor::Entity {
                entity: "bed:1".into(),
            }],
            pushdown: Some(selection.clone()),
            exclude: Vec::new(),
        })
        .unwrap();
    let late = fx.id("b1-late-note-neg-at-c2");
    assert!(
        raw.deltas.iter().any(|m| m.delta.id == late),
        "the double returns the extra"
    );
    let fetched = fetch_scope(
        snapshot.as_ref(),
        &entities,
        Selection {
            pushdown: Some(&selection),
            admits: None,
        },
    )
    .unwrap();
    assert!(fetched.source.get(&late).is_none());
    // The model: S(bed:1, bed:2) over the admitted holdings, by scanning.
    let kept: Vec<VerifiedDelta> = fx
        .arrivals
        .iter()
        .filter(|(id, a)| {
            let d = fx.by_name[&fx.name_of[*id]].clone();
            passes_all(&selection, &d, a)
        })
        .map(|(id, a)| VerifiedDelta {
            delta: fx.by_name[&fx.name_of[id]].clone(),
            arrival: a.clone(),
        })
        .collect();
    let model = scope_source(&kept).unwrap();
    let expected = scope_ids(&model, ["bed:1", "bed:2"], None);
    let got: Vec<String> = fetched
        .source
        .ids()
        .into_iter()
        .map(str::to_string)
        .collect();
    assert_eq!(fx.names(&got), fx.names(&expected));
    for id in &got {
        assert_eq!(fetched.source.arrival(id), fx.arrivals.get(id));
    }
    assert_eq!(fetched.revision, snapshot.revision());

    // Through the reactor: one snapshot, one scope call, one release.
    let (traced, reads, trace) = tracing_peer(store.peer(fx.peer_id()).unwrap());
    let reactor = StoreReactor::open(Box::new(traced));
    let fetched = reactor
        .fetch(
            &entities,
            Selection {
                pushdown: Some(&selection),
                admits: None,
            },
        )
        .unwrap();
    assert_eq!(fetched.source.ids().len(), expected.len());
    assert_eq!(reads.get(), 1);
    assert_eq!(
        *trace.borrow(),
        vec![
            Call {
                op: "scope",
                keys: 2,
                exclude: 0
            },
            Call {
                op: "release",
                keys: 0,
                exclude: 0
            },
        ]
    );
}

// ---------------------------------------------------------------------------------------------
// The fetch cache (SPEC-18 §4.12 reading 13; README §5.8)
// ---------------------------------------------------------------------------------------------

/// A delta with two pointers at one entity is listed there once, and a pointer at a delta makes a
/// negator only with the role `negates`. No vector reaches these: the reader computes members as
/// a set, and a correct store never returns the second shape where it could matter.
#[test]
fn the_fetch_cache_indexes_each_target_once_and_only_negates_as_a_negation() {
    let fx = fixture();
    let source = scope_source(&fx.loaded_members()).unwrap();

    let twice = fx.id("b2-name-twice");
    let at_bed2 = fx.by_name["b2-name-twice"]
        .claims
        .pointers
        .iter()
        .filter(|p| matches!(&p.target, Target::Entity(e) if e.id == "bed:2"))
        .count();
    assert_eq!(at_bed2, 2, "the fixture points at bed:2 twice");
    let listed = source.targets("bed:2");
    assert_eq!(listed.iter().filter(|id| **id == twice).count(), 1);
    assert!(
        listed.windows(2).all(|w| w[0] < w[1]),
        "ascending, no id twice"
    );

    let size = fx.id("c2-size");
    let remark = fx.id("c2-size-remark");
    assert!(
        fx.by_name["c2-size-remark"]
            .claims
            .pointers
            .iter()
            .any(|p| p.role == "annotates"
                && matches!(&p.target, Target::Delta(d) if d.delta == size)),
        "the fixture annotates c2-size"
    );
    assert!(!source.negators(&size).contains(&remark));
    // The remark is still indexed at the entity it names.
    assert!(source.targets("cutting:2").contains(&remark));
}

/// The fetch cache refuses a member whose arrival record names another id, and a refused call adds
/// nothing (SPEC-18 §4.12 reading 13). A Rust `VerifiedDelta` always carries an arrival record, so
/// a missing one cannot be expressed.
#[test]
fn a_member_whose_arrival_names_another_id_is_refused_and_adds_nothing() {
    let fx = fixture();
    let members = fx.loaded_members();
    let mut source = scope_source(&members[..1]).unwrap();
    let mut misfiled = members[2].clone();
    misfiled.arrival.id = members[3].delta.id.clone();
    // Every index entry the refused call could write: the entities its members point at, and
    // the ids they could negate.
    let keys: BTreeSet<String> = [&members[1], &misfiled]
        .iter()
        .flat_map(|m| {
            let entities = target_entities(&m.delta.claims)
                .into_iter()
                .map(str::to_string);
            let negated = negated_ids(&m.delta.claims).into_iter().map(str::to_string);
            entities.chain(negated).collect::<Vec<_>>()
        })
        .collect();
    let indexes = |source: &ScopeSource| -> Vec<(Vec<String>, Vec<String>)> {
        keys.iter()
            .map(|k| (source.targets(k), source.negators(k)))
            .collect()
    };
    let before = (
        source
            .ids()
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>(),
        indexes(&source),
    );
    let err = source
        .extend(&[members[1].clone(), misfiled.clone()])
        .unwrap_err();
    assert_eq!(err.code, StoreErrorCode::InvalidRequest);
    assert_eq!(
        (
            source
                .ids()
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>(),
            indexes(&source)
        ),
        before
    );
    assert!(source.get(&members[1].delta.id).is_none());
    assert_eq!(
        scope_source(&[misfiled]).unwrap_err().code,
        StoreErrorCode::InvalidRequest
    );

    // The read refuses such an answer too.
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    let case = &fx.cases("cases")[0];
    let snapshot = snapshot_double(peer.read().unwrap(), |inner, r| {
        let mut answer = inner.scope(r)?;
        if let [first, second, ..] = answer.deltas.as_mut_slice() {
            first.arrival.id = second.delta.id.clone();
        }
        Ok(answer)
    });
    let err = read_anchored(snapshot.as_ref(), request(&fx, case, FetchCache::On)).unwrap_err();
    assert_eq!(err.store_code(), Some(StoreErrorCode::InvalidRequest));
}

// ---------------------------------------------------------------------------------------------
// The evaluation memo (README §5.4 modes 4 and 5; §5.8 wrong memos and what the memo saves)
// ---------------------------------------------------------------------------------------------

/// A fault a model memo can carry (README §5.8, "Wrong evaluation memos").
#[derive(Debug, Clone, Copy, Default)]
struct MemoFaults {
    /// Stores every child, final or not.
    stores_every_child: bool,
    /// Its key leaves out the bindings.
    key_without_bindings: bool,
    /// Its key leaves out the root.
    key_without_root: bool,
}

/// A key written apart from the witness: the schema reference, the bindings by their entries, and
/// the root, less what a fault leaves out.
fn model_key(key: &ChildKey<'_>, faults: MemoFaults) -> String {
    let schema = match key.schema {
        SchemaRef::Name(name) => format!("name:{name}"),
        SchemaRef::Pinned(hash) => format!("pinned:{hash}"),
    };
    let bindings = if faults.key_without_bindings {
        String::new()
    } else {
        format!("{:?}", key.bindings)
    };
    let root = if faults.key_without_root {
        ""
    } else {
        key.root
    };
    format!("{schema}|{bindings}|{root}")
}

fn shows_only(value: &ChildValue, asked: &BTreeSet<String>) -> bool {
    hview_anchors(value.view())
        .iter()
        .all(|anchor| asked.contains(anchor))
}

/// The memo of README §5.4, written apart from the witness, with a fault switched on.
#[derive(Default)]
struct ModelMemo {
    faults: MemoFaults,
    asked: BTreeSet<String>,
    entries: BTreeMap<String, ChildValue>,
}

impl ChildMemo for ModelMemo {
    fn get(&mut self, key: &ChildKey<'_>) -> Option<ChildValue> {
        self.entries.get(&model_key(key, self.faults)).cloned()
    }
    fn put(&mut self, key: &ChildKey<'_>, value: &ChildValue) {
        if self.faults.stores_every_child || shows_only(value, &self.asked) {
            self.entries
                .entry(model_key(key, self.faults))
                .or_insert_with(|| value.clone());
        }
    }
}

impl RoundMemo for ModelMemo {
    fn round(&mut self, asked: &BTreeSet<String>) {
        self.asked.clone_from(asked);
    }
    fn stored(&self) -> usize {
        self.entries.len()
    }
}

/// Did this read answer the case? Bytes, scope, members, and the rounds of its mode.
fn answers(got: &Result<StoreRead, StoreReadError>, e: &Expect, cache: FetchCache) -> bool {
    let Ok(read) = got else { return false };
    let got = Answer::of(read);
    let rounds = match cache {
        FetchCache::On => e.rounds.clone(),
        FetchCache::Off => cumulative(&e.rounds),
    };
    got.same_read(e) && got.rounds == rounds
}

/// The cases a memo fails in modes 4 and 5 under every profile. `memo_for` gives the memo of
/// each read: a new one per read, or the same one each time.
fn memo_failures(
    fx: &Fixture,
    cases: &[Case],
    memo_for: &mut dyn FnMut() -> Rc<RefCell<dyn RoundMemo>>,
) -> BTreeSet<String> {
    let mut failed = BTreeSet::new();
    for profile in profiles() {
        let store = MemoryStore::with_pushdown(profile);
        let peer = fx.load(&store);
        for cache in [FetchCache::Off, FetchCache::On] {
            for case in cases {
                let memo = memo_for();
                let snapshot = peer.read().unwrap();
                let got = read_anchored_with_memo(
                    snapshot.as_ref(),
                    request_with(fx, case, cache, EvalMemo::Off),
                    &mut *memo.borrow_mut(),
                );
                if !answers(&got, case.expect.as_ref().unwrap(), cache) {
                    failed.insert(case.name.clone());
                }
            }
        }
    }
    failed
}

fn fresh(faults: MemoFaults) -> impl FnMut() -> Rc<RefCell<dyn RoundMemo>> {
    move || {
        Rc::new(RefCell::new(ModelMemo {
            faults,
            ..ModelMemo::default()
        }))
    }
}

#[test]
fn the_model_memo_with_no_fault_fails_no_case() {
    let fx = fixture();
    let cases = fx.cases("cases");
    assert_eq!(
        memo_failures(&fx, &cases, &mut fresh(MemoFaults::default())),
        BTreeSet::new()
    );
}

/// Round 1 evaluates the beds over the garden's scope alone; a memo that keeps that answer shows
/// empty beds (README §5.8).
#[test]
fn a_memo_that_stores_every_child_fails_the_whole_garden() {
    let fx = fixture();
    let cases = fx.cases("cases");
    let failed = memo_failures(
        &fx,
        &cases,
        &mut fresh(MemoFaults {
            stores_every_child: true,
            ..MemoFaults::default()
        }),
    );
    println!("wrong-memo:stores-every-child:{failed:?}");
    assert!(failed.contains("the-whole-garden"), "{failed:?}");
}

/// One child under two bindings in one round (README §5.4): only that case can tell.
#[test]
fn a_memo_whose_key_leaves_out_the_bindings_fails_only_the_two_bindings_case() {
    let fx = fixture();
    let cases = fx.cases("cases");
    let failed = memo_failures(
        &fx,
        &cases,
        &mut fresh(MemoFaults {
            key_without_bindings: true,
            ..MemoFaults::default()
        }),
    );
    assert_eq!(
        failed,
        BTreeSet::from(["one-child-under-two-bindings".to_string()])
    );
}

#[test]
fn a_memo_whose_key_leaves_out_the_root_fails_the_whole_garden() {
    let fx = fixture();
    let cases = fx.cases("cases");
    let failed = memo_failures(
        &fx,
        &cases,
        &mut fresh(MemoFaults {
            key_without_root: true,
            ..MemoFaults::default()
        }),
    );
    println!("wrong-memo:key-without-root:{failed:?}");
    assert!(failed.contains("the-whole-garden"), "{failed:?}");
}

/// The witness's own memo, kept across every read of a run: one memo for every case, in document
/// order, per profile and mode. A case whose selection differs from an earlier case's sees
/// children stored under the other selection (SPEC-18 §4.12 reading 25).
#[test]
fn a_memo_kept_across_two_reads_fails_a_case_with_another_selection() {
    let fx = fixture();
    let cases = fx.cases("cases");
    let mut failed = BTreeSet::new();
    for profile in profiles() {
        let store = MemoryStore::with_pushdown(profile);
        let peer = fx.load(&store);
        for cache in [FetchCache::Off, FetchCache::On] {
            let mut kept = FinalChildMemo::new();
            for case in &cases {
                let snapshot = peer.read().unwrap();
                let got = read_anchored_with_memo(
                    snapshot.as_ref(),
                    request_with(&fx, case, cache, EvalMemo::Off),
                    &mut kept,
                );
                if !answers(&got, case.expect.as_ref().unwrap(), cache) {
                    failed.insert(case.name.clone());
                }
            }
        }
    }
    println!("wrong-memo:kept-across-reads:{failed:?}");
    assert!(
        failed.contains("signed-time-cuts-a-link-and-a-strike"),
        "{failed:?}"
    );
    // The first case of a run reads on an empty memo.
    assert!(!failed.contains(&cases[0].name), "{failed:?}");
}

/// A wrapper that starts again on `snapshot-moved` with a new cache but keeps its memo (README
/// §5.8; SPEC-18 §4.12 reading 25). After round 3 the memo holds `Leaf` at `cutting:1`, and the
/// append strikes `c1-height` there, so the second attempt answers neither. Round 1 finishes no
/// child, so the cases that change the peer after round 1 answer right.
#[test]
fn a_wrapper_that_keeps_its_memo_when_it_starts_again_fails_the_third_round_append() {
    let fx = fixture();
    let mut verdicts = BTreeMap::new();
    for c in interleaved(&fx) {
        let store = MemoryStore::new();
        let peer = fx.load(&store);
        let start = peer.read().unwrap().revision();
        let writer = store.peer(fx.peer_id()).unwrap();
        let mut changed = false;
        let mut hook = |r: &RoundReport| {
            if r.round == c.after_round && !changed {
                changed = true;
                c.change.apply(writer.as_ref());
            }
        };
        let mut memo = FinalChildMemo::new();
        let mut attempts = 0;
        let read = loop {
            attempts += 1;
            let snapshot = peer.read().unwrap();
            match read_anchored_with_memo(
                snapshot.as_ref(),
                ReadRequest {
                    on_round: Some(&mut hook),
                    ..request_with(&fx, &c.case, FetchCache::On, EvalMemo::Off)
                },
                &mut memo,
            ) {
                Ok(read) => break read,
                Err(e) if e.store_code() == Some(StoreErrorCode::SnapshotMoved) => continue,
                Err(e) => panic!("{}: {e}", c.case.name),
            }
        };
        let verdict = wrapper_verdict(
            &Answer::of(&read),
            read.revision,
            start,
            &c.before,
            &c.after,
        );
        verdicts.insert(c.case.name.clone(), (verdict, attempts));
    }
    println!("wrong-memo:kept-across-snapshots:{verdicts:?}");
    let (third, attempts) = &verdicts["an-append-after-the-third-round"];
    assert_eq!(*attempts, 2);
    assert_eq!(
        third.as_ref().unwrap_err(),
        "neither `before` at the first revision nor `after` at a later one"
    );
    for name in [
        "an-append-after-the-first-round",
        "a-purge-after-the-first-round",
    ] {
        assert_eq!(verdicts[name], (Ok(()), 2), "{name}");
    }
}

/// Counts through the memo hook (README §5.8, "What the memo saves"): one evaluation per child
/// the evaluator evaluates (each `put`), one hit per lookup that finds its key, and whether each
/// evaluated child was stored. Finality is decided here apart from the memo, so a memo that
/// stores a child that is not final, or refuses one that is, fails the count.
#[derive(Default)]
struct Counting {
    /// The memo under count; none counts a memo that stores nothing.
    inner: Option<FinalChildMemo>,
    asked: BTreeSet<String>,
    keys: BTreeSet<String>,
    stored_keys: Vec<String>,
    evaluations: usize,
    hits: usize,
    not_final: usize,
}

impl ChildMemo for Counting {
    fn get(&mut self, key: &ChildKey<'_>) -> Option<ChildValue> {
        self.keys.insert(model_key(key, MemoFaults::default()));
        let found = self.inner.as_mut().and_then(|m| m.get(key));
        self.hits += usize::from(found.is_some());
        found
    }
    fn put(&mut self, key: &ChildKey<'_>, value: &ChildValue) {
        self.evaluations += 1;
        let is_final = shows_only(value, &self.asked);
        self.not_final += usize::from(!is_final);
        if let Some(m) = self.inner.as_mut() {
            let before = m.stored();
            m.put(key, value);
            let stored = m.stored() > before;
            assert_eq!(
                stored, is_final,
                "the memo stores exactly the final children"
            );
            if stored {
                self.stored_keys.push(model_key(key, MemoFaults::default()));
            }
        }
    }
}

impl RoundMemo for Counting {
    fn round(&mut self, asked: &BTreeSet<String>) {
        self.asked.clone_from(asked);
        if let Some(m) = self.inner.as_mut() {
            m.round(asked);
        }
    }
    fn stored(&self) -> usize {
        self.inner.as_ref().map_or(0, |m| m.stored())
    }
}

/// (evaluations without the memo, evaluations with it, keys, stored, not final, hits).
type Saved = (usize, usize, usize, usize, usize, usize);

fn count(fx: &Fixture, peer: &dyn PeerStore, case: &Case, cache: FetchCache) -> Saved {
    let run = |inner: Option<FinalChildMemo>| {
        let mut memo = Counting {
            inner,
            ..Counting::default()
        };
        let snapshot = peer.read().unwrap();
        let read = read_anchored_with_memo(
            snapshot.as_ref(),
            request_with(fx, case, cache, EvalMemo::Off),
            &mut memo,
        )
        .unwrap();
        assert!(answers(&Ok(read), case.expect.as_ref().unwrap(), cache));
        memo
    };
    let without = run(None);
    let with = run(Some(FinalChildMemo::new()));
    let unique: BTreeSet<&String> = with.stored_keys.iter().collect();
    assert_eq!(
        unique.len(),
        with.stored_keys.len(),
        "{}: a key stored twice",
        case.name
    );
    assert_eq!(
        with.evaluations,
        with.stored_keys.len() + with.not_final,
        "{}: evaluations are the stored ones plus the ones not final",
        case.name
    );
    assert_eq!(
        without.keys, with.keys,
        "{}: the memo reaches the same keys",
        case.name
    );
    (
        without.evaluations,
        with.evaluations,
        with.keys.len(),
        with.stored_keys.len(),
        with.not_final,
        with.hits,
    )
}

#[test]
fn the_memo_saves_child_evaluations() {
    let fx = fixture();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    for case in fx.cases("cases") {
        for cache in [FetchCache::Off, FetchCache::On] {
            let saved = count(&fx, peer.as_ref(), &case, cache);
            println!("memo-count:{}:{cache:?}:{saved:?}", case.name);
            assert!(saved.1 <= saved.0, "{}: {saved:?}", case.name);
            // Depth three: four rounds, so the memo makes strictly fewer evaluations.
            if case.expect.as_ref().unwrap().rounds.len() == 4 {
                assert!(saved.1 < saved.0, "{}: {saved:?}", case.name);
            }
            // The final `resolve` evaluation uses the memo of the read (README §5.4 step 5): its
            // children are final, so it evaluates none of them again.
            if matches!(case.term, Term::Resolve { .. }) && saved.0 > 0 {
                assert!(saved.1 < saved.0, "{}: {saved:?}", case.name);
            }
        }
    }
    // The reference numbers of README §5.8, measured in the TypeScript witness.
    for (name, reference) in [
        ("the-whole-garden", (159, 62, 18, 18, 44, 42)),
        ("one-child-under-two-bindings", (38, 24, 11, 11, 13, 12)),
    ] {
        let case = fx
            .cases("cases")
            .into_iter()
            .find(|c| c.name == name)
            .unwrap();
        for cache in [FetchCache::Off, FetchCache::On] {
            assert_eq!(
                count(&fx, peer.as_ref(), &case, cache),
                reference,
                "{name}/{cache:?}"
            );
        }
    }
}

/// The read reports what its memo stored (SPEC-18 §4.12 reading 27; README §5.8): 18 for the
/// standard read of `the-whole-garden` (mode 5), and 0 with the memo off (modes 2 and 3). The memo
/// changes no answer, so this count is the only way to see a read that ignores the memo switch.
#[test]
fn the_read_reports_how_many_children_its_memo_stored() {
    let fx = fixture();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    let case = fx
        .cases("cases")
        .into_iter()
        .find(|c| c.name == "the-whole-garden")
        .unwrap();
    let stored = |cache: FetchCache, memo: EvalMemo| {
        let snapshot = peer.read().unwrap();
        let read = read_anchored(snapshot.as_ref(), request_with(&fx, &case, cache, memo)).unwrap();
        assert!(answers(
            &Ok(read.clone()),
            case.expect.as_ref().unwrap(),
            cache
        ));
        read.memo_stored
    };
    assert_eq!(stored(FetchCache::On, EvalMemo::On), 18, "mode 5");
    assert_eq!(stored(FetchCache::Off, EvalMemo::On), 18, "mode 4");
    assert_eq!(stored(FetchCache::On, EvalMemo::Off), 0, "mode 3");
    assert_eq!(stored(FetchCache::Off, EvalMemo::Off), 0, "mode 2");
    // The wrapper reports the memo of its one attempt.
    let reactor = StoreReactor::open(store.peer(fx.peer_id()).unwrap());
    for (memo, expected) in [(EvalMemo::On, 18), (EvalMemo::Off, 0)] {
        let read = reactor
            .read(request_with(&fx, &case, FetchCache::On, memo))
            .unwrap();
        assert_eq!(read.memo_stored, expected, "StoreReactor::read, {memo:?}");
    }
    // A caller-owned memo is reported the same way.
    let snapshot = peer.read().unwrap();
    let mut memo = FinalChildMemo::new();
    let read = read_anchored_with_memo(
        snapshot.as_ref(),
        request_with(&fx, &case, FetchCache::On, EvalMemo::Off),
        &mut memo,
    )
    .unwrap();
    assert_eq!((read.memo_stored, memo.stored()), (18, 18));
}

// ---------------------------------------------------------------------------------------------
// The full-surface read (SPEC-18 §6.6, §4.12 reading 28)
// ---------------------------------------------------------------------------------------------

/// A peer exporter that counts how often its listing is opened, and can forge one listed delta.
struct CountingExporter {
    inner: Box<dyn PeerExporter>,
    listings: Rc<Cell<usize>>,
    forge: bool,
}

impl PeerExporter for CountingExporter {
    fn ids(&self) -> rhizomatic::store::Listing<'_, String> {
        self.listings.set(self.listings.get() + 1);
        self.inner.ids()
    }
    fn deltas(&self) -> rhizomatic::store::Listing<'_, Delta> {
        self.listings.set(self.listings.get() + 1);
        let forge = self.forge;
        Box::new(self.inner.deltas().enumerate().map(move |(i, listed)| {
            listed.map(|mut delta| {
                if forge && i == 0 {
                    delta.claims.timestamp += 1.0;
                }
                delta
            })
        }))
    }
}

fn counting_exporter(fx: &Fixture, store: &MemoryStore, forge: bool) -> CountingExporter {
    CountingExporter {
        inner: store.open_admin().peer(fx.peer_id()).unwrap(),
        listings: Rc::new(Cell::new(0)),
        forge,
    }
}

fn full_surface_request<'a>(
    fx: &'a Fixture,
    case: &'a Case,
    selection: Selection<'a>,
) -> FullSurfaceRequest<'a> {
    FullSurfaceRequest {
        root: Some(&case.root),
        registry: Some(&fx.registry),
        bindings: case.bindings.as_ref(),
        selection,
        ..FullSurfaceRequest::new(&case.term, case.now)
    }
}

/// Every round case through `read_full_surface` (README §5.4 mode 1 by the library's own route):
/// a case whose selection has no `arrivalAtMost` answers the expected bytes, with a route that is
/// not optimized and counts what it listed and admitted. A case with `arrivalAtMost` is refused
/// `invalid-request` before anything is listed: a listing carries no arrival record.
#[test]
fn the_full_surface_read_answers_every_round_case_it_can_take() {
    let fx = fixture();
    let store = MemoryStore::new();
    let _peer = fx.load(&store);
    let (mut answered, mut refused) = (0, 0);
    for case in fx.cases("cases") {
        let exporter = counting_exporter(&fx, &store, false);
        let got = read_full_surface(
            &exporter,
            full_surface_request(
                &fx,
                &case,
                Selection {
                    pushdown: Some(&case.pushdown),
                    admits: None,
                },
            ),
        );
        if case.pushdown.arrival_at_most.is_some() {
            let err = got.expect_err(&case.name);
            assert_eq!(err.store_code(), Some(StoreErrorCode::InvalidRequest));
            assert_eq!(exporter.listings.get(), 0, "{}: refused first", case.name);
            refused += 1;
            continue;
        }
        let read = got.unwrap_or_else(|e| panic!("{}: {e}", case.name));
        let e = case.expect.as_ref().unwrap();
        assert_eq!(result_canonical_hex(&read.result), e.hex, "{}", case.name);
        let admitted = fx
            .loaded_members()
            .iter()
            .filter(|m| passes_all(&case.pushdown, &m.delta, &m.arrival))
            .count();
        assert_eq!(
            read.route,
            FullSurfaceRoute {
                optimized: false,
                listed: fx.loaded(),
                admitted,
            },
            "{}",
            case.name
        );
        assert_eq!(exporter.listings.get(), 1, "{}", case.name);
        answered += 1;
    }
    assert_eq!((answered, refused), (21, 5));
}

/// A host predicate is refused before anything is listed, as `arrivalAtMost` is.
#[test]
fn the_full_surface_read_refuses_a_host_predicate_before_it_lists() {
    let fx = fixture();
    let store = MemoryStore::new();
    let _peer = fx.load(&store);
    let case = fx.cases("cases").remove(0);
    let exporter = counting_exporter(&fx, &store, false);
    let admits = |_: &Delta, _: &ArrivalRecord| true;
    let err = read_full_surface(
        &exporter,
        full_surface_request(
            &fx,
            &case,
            Selection {
                pushdown: None,
                admits: Some(&admits),
            },
        ),
    )
    .unwrap_err();
    assert_eq!(err.store_code(), Some(StoreErrorCode::InvalidRequest));
    assert_eq!(exporter.listings.get(), 0);
}

/// A listing whose id does not recompute is refused, not repaired: by `collect_delta_set` and by
/// the full-surface read over it.
#[test]
fn a_listed_delta_whose_id_does_not_recompute_is_refused() {
    let fx = fixture();
    let store = MemoryStore::new();
    let _peer = fx.load(&store);
    let honest = collect_delta_set(&counting_exporter(&fx, &store, false)).unwrap();
    assert_eq!(honest.len(), fx.loaded());
    let err = collect_delta_set(&counting_exporter(&fx, &store, true)).unwrap_err();
    assert_eq!(err.code, StoreErrorCode::InvalidRequest);
    let case = fx.cases("cases").remove(0);
    let err = read_full_surface(
        &counting_exporter(&fx, &store, true),
        full_surface_request(&fx, &case, Selection::default()),
    )
    .unwrap_err();
    assert_eq!(err.store_code(), Some(StoreErrorCode::InvalidRequest));
}
