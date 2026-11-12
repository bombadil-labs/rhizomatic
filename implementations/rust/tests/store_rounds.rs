//! The read in rounds over a store (SPEC-18 proposal §4.4, §4.12; `vectors/store/README.md` §5).
//! Every case of `vectors/store/rounds.json` is read three ways on the memory store under every
//! subset of pushdown fields: over the whole surface, in rounds with no fetch cache, and in rounds
//! with the fetch cache. All three must give the expected bytes, scope and members; the rounds
//! with the cache must make exactly the expected `scope` calls.
//!
//! The rails of README §5.8: four wrong readers that must each fail a case, a store that returns
//! an unclosed extra, call traces and meter deltas beside 0 and 4400 unrelated deltas, and an open
//! that reads nothing. The evaluation memo (modes 4 and 5) is not built, so it is not tested here.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use rhizomatic::anchored::{anchor_analysis, hview_anchors, scope_ids, AnchorAnalysis};
use rhizomatic::eval::{eval_term_at, result_canonical_hex, EvalResult, Term};
use rhizomatic::json_profile::parse_claims;
use rhizomatic::memory_store::{MemoryStore, StoreMeter};
use rhizomatic::pred::Bindings;
use rhizomatic::schema::{HyperSchema, SchemaRegistry};
use rhizomatic::set::{make_delta, make_negation_claims, DeltaSet, DeltaSource};
use rhizomatic::store::{
    scope_source, Admission, Anchor, AppendResult, ArrivalRecord, ErasurePosture, PeerErasure,
    PeerStore, PurgeReport, Pushdown, PushdownFields, Revision, ScopeRequest, ScopeResult,
    ScopeSource, Snapshot, Store, StoreError, StoreErrorCode, VerifiedDelta,
};
use rhizomatic::store_read::{
    fetch_scope, read_anchored, FetchCache, ReadRequest, RoundReport, Selection, StoreReactor,
    StoreRead, StoreReadError, SNAPSHOT_RETRIES,
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

fn request<'a>(fx: &'a Fixture, case: &'a Case, cache: FetchCache) -> ReadRequest<'a> {
    ReadRequest {
        registry: Some(&fx.registry),
        bindings: case.bindings.as_ref(),
        selection: Selection {
            pushdown: Some(&case.pushdown),
            admits: None,
        },
        cache,
        ..ReadRequest::new(&case.term, &case.root, case.now)
    }
}

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
        ts |= p.timestamp_at_most.is_some() && !answer.applied.timestamp_at_most;
        arr |= p.arrival_at_most.is_some() && !answer.applied.arrival_at_most;
        if pushdown.exclude_ids.is_some() && !answer.applied.exclude_ids {
            ex = true;
            dropped.extend(pushdown.exclude_ids.clone().unwrap_or_default());
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
fn every_round_case_reads_the_same_three_ways_under_every_pushdown_profile() {
    let fx = fixture();
    let cases = fx.cases("cases");
    assert_eq!(cases.len(), 17, "the vector lost cases");
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
            for (mode, cache, rule) in [
                ("no-cache", FetchCache::Off, Rounds::Cumulative),
                ("cache", FetchCache::On, Rounds::Exact),
            ] {
                let mut snapshot = peer.read().unwrap();
                let read = read_anchored(snapshot.as_ref(), request(&fx, case, cache))
                    .unwrap_or_else(|err| panic!("{}: {err}", label(mode)));
                assert_eq!(read.revision, snapshot.revision());
                assert_eq!(read.snapshots, 1);
                check(&fx, &label(mode), &Answer::of(&read), e, rule);
                snapshot.release();
            }
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

#[test]
fn a_store_whose_applied_report_changes_between_rounds_reads_the_same() {
    let fx = fixture();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    // Odd calls applied and even calls not, then the other way round: the last round of a case
    // may report a field applied that an earlier round left to the host.
    for (case, parity) in fx.cases("cases").iter().flat_map(|c| [(c, 0), (c, 1)]) {
        let case = case.clone();
        let e = case.expect.as_ref().unwrap();
        let calls = Rc::new(Cell::new(0usize));
        let counter = calls.clone();
        let snapshot = snapshot_double(peer.read().unwrap(), move |inner, r| {
            counter.set(counter.get() + 1);
            if counter.get() % 2 == parity {
                inner.scope(&ScopeRequest {
                    pushdown: None,
                    ..r.clone()
                })
            } else {
                inner.scope(r)
            }
        });
        let read = read_anchored(snapshot.as_ref(), request(&fx, &case, FetchCache::On)).unwrap();
        check(
            &fx,
            &format!("{}/fickle-{parity}", case.name),
            &Answer::of(&read),
            e,
            Rounds::Exact,
        );
    }
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
    assert_eq!(refusals.len(), 5);
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
// Interleaved appends
// ---------------------------------------------------------------------------------------------

#[test]
fn an_append_between_rounds_answers_snapshot_moved_or_the_old_answer() {
    let fx = fixture();
    let interleaved = fx.cases("interleaved");
    assert_eq!(interleaved.len(), 3);
    for case in &interleaved {
        let raw = &case.raw;
        let after_round = raw["afterRound"].as_u64().unwrap() as usize;
        let append = fx.admission(&raw["append"]);
        let before = fx.expect(&raw["expect"]["before"]);
        let after = fx.expect(&raw["expect"]["after"]);
        assert_ne!(
            before.hex, after.hex,
            "{}: the append changes the answer",
            case.name
        );

        // One snapshot: snapshot-moved, or `before` at the snapshot's revision.
        let store = MemoryStore::new();
        let peer = fx.load(&store);
        let writer = store.peer(fx.peer_id()).unwrap();
        let mut snapshot = peer.read().unwrap();
        let start = snapshot.revision();
        let mut hook = |r: &RoundReport| {
            if r.round == after_round {
                commit(writer.as_ref(), &append);
            }
        };
        let outcome = read_anchored(
            snapshot.as_ref(),
            ReadRequest {
                on_round: Some(&mut hook),
                ..request(&fx, case, FetchCache::On)
            },
        );
        let last = after_round == before.rounds.len();
        match outcome {
            Ok(read) => {
                assert!(
                    last,
                    "{}: the memory store refuses a call after the append",
                    case.name
                );
                assert_eq!(read.revision, start);
                check(
                    &fx,
                    &format!("{}/before", case.name),
                    &Answer::of(&read),
                    &before,
                    Rounds::Exact,
                );
            }
            Err(err) => {
                assert!(!last, "{}: {err}", case.name);
                assert_eq!(
                    err.store_code(),
                    Some(StoreErrorCode::SnapshotMoved),
                    "{}",
                    case.name
                );
            }
        }
        snapshot.release();
        assert!(
            peer.read().unwrap().revision() > start,
            "{}: the hook ran after round {after_round}",
            case.name
        );

        // The reactor: `before` at the first revision, or `after` at a later one. Never a mix.
        let store = MemoryStore::new();
        let peer = fx.load(&store);
        let start = peer.read().unwrap().revision();
        let writer = store.peer(fx.peer_id()).unwrap();
        let (traced, reads, trace) = tracing_peer(peer);
        let reactor = StoreReactor::open(Box::new(traced));
        let mut appended = false;
        let mut hook = |r: &RoundReport| {
            if r.round == after_round && !appended {
                appended = true;
                commit(writer.as_ref(), &append);
            }
        };
        let read = reactor
            .read(ReadRequest {
                on_round: Some(&mut hook),
                ..request(&fx, case, FetchCache::On)
            })
            .unwrap();
        if read.snapshots == 1 {
            assert_eq!(read.revision, start);
            check(
                &fx,
                &format!("{}/reactor-before", case.name),
                &Answer::of(&read),
                &before,
                Rounds::Exact,
            );
        } else {
            assert!(read.revision > start);
            assert_eq!(read.snapshots, 2);
            check(
                &fx,
                &format!("{}/reactor-after", case.name),
                &Answer::of(&read),
                &after,
                Rounds::Exact,
            );
        }
        assert_eq!(read.snapshots, if last { 1 } else { 2 }, "{}", case.name);
        let releases = trace.borrow().iter().filter(|c| c.op == "release").count();
        assert_eq!(
            (reads.get(), releases),
            (read.snapshots, read.snapshots),
            "{}: every snapshot is released",
            case.name
        );
    }
}

#[test]
fn the_reactor_gives_up_after_three_retries_and_releases_every_snapshot() {
    let fx = fixture();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    struct Moving {
        inner: Box<dyn PeerStore>,
        reads: Rc<Cell<usize>>,
        releases: Rc<Cell<usize>>,
    }
    impl PeerStore for Moving {
        fn id(&self) -> &str {
            self.inner.id()
        }
        fn erasure(&self) -> PeerErasure {
            self.inner.erasure()
        }
        fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
            self.reads.set(self.reads.get() + 1);
            let releases = self.releases.clone();
            let inner = self.inner.read()?;
            Ok(Box::new(Released {
                inner: snapshot_double(inner, |_, _| {
                    Err(StoreError::new(StoreErrorCode::SnapshotMoved, "moved"))
                }),
                releases,
            }))
        }
        fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
            self.inner.append(batch)
        }
        fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
            self.inner.purge(ids)
        }
    }
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
    let reads = Rc::new(Cell::new(0));
    let releases = Rc::new(Cell::new(0));
    let reactor = StoreReactor::open(Box::new(Moving {
        inner: peer,
        reads: reads.clone(),
        releases: releases.clone(),
    }));
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

#[test]
fn a_reader_that_keeps_its_cache_across_snapshots_answers_neither() {
    let fx = fixture();
    let mut neither = Vec::new();
    for case in fx.cases("interleaved") {
        let raw = &case.raw;
        let after_round = raw["afterRound"].as_u64().unwrap() as usize;
        let append = fx.admission(&raw["append"]);
        let before = fx.expect(&raw["expect"]["before"]);
        let after = fx.expect(&raw["expect"]["after"]);
        let store = MemoryStore::new();
        let peer = fx.load(&store);
        let writer = store.peer(fx.peer_id()).unwrap();
        let snapshot = peer.read().unwrap();
        let mut hook = |round: usize| {
            if round == after_round {
                commit(writer.as_ref(), &append);
            }
        };
        // On `snapshot-moved` it takes a new snapshot and goes on with what it holds.
        let got = model_read(
            &fx,
            snapshot.as_ref(),
            &case,
            Faults::default(),
            &mut ScopeSource::default(),
            &mut hook,
            Some(peer.as_ref()),
        )
        .unwrap();
        if !got.same_read(&before) && !got.same_read(&after) {
            neither.push(case.name.clone());
        }
    }
    assert!(
        !neither.is_empty(),
        "a reader that mixed two snapshots went unnoticed"
    );
}

/// Under appends alone, a read that starts again from its first round with a cache kept from an
/// older snapshot still answers the later state: the holdings only grew, and the store returns
/// whatever the cache lacks. A purge between the two snapshots shows the fault: the stale cache
/// still holds the purged delta. This is why `StoreReactor` starts each attempt with a new cache.
#[test]
fn a_cache_kept_across_a_purge_shows_the_purged_delta() {
    let fx = fixture();
    let case = fx
        .cases("cases")
        .into_iter()
        .find(|c| c.name == "the-whole-garden")
        .unwrap();
    let store = MemoryStore::new();
    let peer = fx.load(&store);
    let mut cache = ScopeSource::default();
    let first = peer.read().unwrap();
    model_read(
        &fx,
        first.as_ref(),
        &case,
        Faults::default(),
        &mut cache,
        &mut |_| {},
        None,
    )
    .unwrap();
    let purged = fx.id("g-name");
    assert!(cache.get(&purged).is_some());
    peer.purge(std::slice::from_ref(&purged)).unwrap();
    let later = peer.read().unwrap();
    let stale = model_read(
        &fx,
        later.as_ref(),
        &case,
        Faults::default(),
        &mut cache,
        &mut |_| {},
        None,
    )
    .unwrap();
    assert!(
        stale.members.contains(&purged),
        "the stale cache keeps the purged delta"
    );
    let right = read_anchored(later.as_ref(), request(&fx, &case, FetchCache::On)).unwrap();
    assert!(!right.members.contains(&purged));
    assert_ne!(stale.hex, result_canonical_hex(&right.result));
    assert_eq!(
        Answer::of(&right).hex,
        whole_surface_after_purge(&fx, &store, &case)
    );
}

fn whole_surface_after_purge(fx: &Fixture, store: &MemoryStore, case: &Case) -> String {
    whole_surface(fx, store, case).hex
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
            42 + 4400
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
