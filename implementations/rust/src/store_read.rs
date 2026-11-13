//! The store-backed read (SPEC-18 proposal §4.4, §4.12; slice 2): an anchored read (SPEC-17 §5,
//! §6) that fetches its scope from one snapshot, one round at a time, and evaluates in memory
//! between rounds. It never scans and never falls back to a whole-set read.
//!
//! One round: one `scope` call for the anchors no round has asked for, with `exclude` naming
//! every id the read holds; the answer joins the fetch cache, which keeps members that fail the
//! residual selection so that `exclude` names them; the exact members are S(every anchor asked
//! for) over the cache under the residual; the gather is evaluated over exactly those members;
//! the next anchors are the anchors the result shows that no round has asked for.
//!
//! A term with no anchor is read only by `read_full_surface`, which needs the peer's exporter and
//! lists the whole surface (§6.6, §4.12 reading 28).
//!
//! The evaluation memo (§4.12 readings 21 to 26) keeps, for one attempt of one read, each child
//! evaluation that is final: every anchor its HView shows has been asked for. A later round, and
//! the final `resolve` evaluation, use it and do not evaluate that child again.
//!
//! Every read carries the validity window of its operand (`since`, `expires_at`), and a capture
//! for the freshness check when asked (SPEC-18 §4.6; §4.13 readings 26 to 29). A capture's
//! members are the raw scope: a read that pushed nothing down holds it in its fetch cache, and a
//! read that pushed a selection down reads it with id-only calls on the same snapshot after its
//! last round.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::anchored::{
    anchor_analysis, hview_anchors, scope_ids, AnchorAnalysis, UnanchoredReason,
};
use crate::eval::{
    eval_term_at, eval_term_at_with_memo, ChildKey, ChildMemo, ChildValue, EvalResult, SchemaRef,
    Term,
};
use crate::pred::Bindings;
use crate::schema::SchemaRegistry;
use crate::set::{fork, DeltaSource};
use crate::store::{
    collect_delta_set, Anchor, ArrivalRecord, ChangeRecord, PeerExporter, PeerStore, Pushdown,
    PushdownFields, Revision, ScopeRequest, ScopeSource, Snapshot, StoreError, StoreErrorCode,
};
use crate::store_conformance::FreshnessReader;
use crate::store_fresh::{
    check_fresh, make_capture, raw_scope, touching, validity_boundaries, validity_window,
    window_at, Capture, Freshness, Touch, ValidityWindow,
};
use crate::types::{Delta, Primitive};

/// How many times `StoreReactor` starts a read again after `snapshot-moved`. A read therefore
/// uses at most `SNAPSHOT_RETRIES + 1` snapshots.
pub const SNAPSHOT_RETRIES: usize = 3;

/// A host predicate over a delta and its arrival record at this peer. The store never sees it.
/// It must be pointwise (SPEC-17 §3).
pub type Admits<'a> = &'a dyn Fn(&Delta, &ArrivalRecord) -> bool;

/// The selection of a read (SPEC-18 §4.12 reading 1): a pushdown the store may apply, and a host
/// predicate it never sees. A delta is selected when it passes both.
#[derive(Clone, Copy, Default)]
pub struct Selection<'a> {
    pub pushdown: Option<&'a Pushdown>,
    pub admits: Option<Admits<'a>>,
}

impl fmt::Debug for Selection<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Selection")
            .field("pushdown", &self.pushdown)
            .field("admits", &self.admits.map(|_| "<fn>"))
            .finish()
    }
}

/// Whether the read keeps what earlier rounds fetched (SPEC-18 §4.12 reading 14).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchCache {
    /// Each round asks only for its new anchors and excludes every id held.
    On,
    /// Each round asks for every anchor so far and sends no `exclude`, so each answer alone
    /// carries the whole scope so far. It exists to show that the cache changes no answer.
    Off,
}

/// Whether the read keeps an evaluation memo (SPEC-18 §4.12 reading 21). The memo changes no
/// answer, scope, member or round; it saves child evaluations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalMemo {
    /// A new `FinalChildMemo` for each attempt.
    On,
    /// Every round evaluates every child it reaches.
    Off,
}

/// A memo that a read in rounds can carry: a `ChildMemo` that also learns, before each round's
/// evaluation, every anchor asked for so far in the read.
pub trait RoundMemo: ChildMemo {
    fn round(&mut self, asked: &BTreeSet<String>);
    /// How many child evaluations the memo holds now. The read reports it when it ends.
    fn stored(&self) -> usize;
}

/// A primitive as a memo key: a number by its bits, so that two keys are equal only when the
/// values are the same value.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum KeyPrimitive {
    Str(String),
    Num(u64),
    Bool(bool),
}

type MemoKey = (bool, String, Option<Vec<(String, KeyPrimitive)>>, String);

fn memo_key(key: &ChildKey<'_>) -> MemoKey {
    let (pinned, schema) = match key.schema {
        SchemaRef::Name(name) => (false, name.clone()),
        SchemaRef::Pinned(hash) => (true, hash.clone()),
    };
    let bindings = key.bindings.map(|b: &Bindings| {
        b.iter()
            .map(|(hole, value)| {
                let value = match value {
                    Primitive::Str(s) => KeyPrimitive::Str(s.clone()),
                    Primitive::Num(n) => KeyPrimitive::Num(n.to_bits()),
                    Primitive::Bool(b) => KeyPrimitive::Bool(*b),
                };
                (hole.clone(), value)
            })
            .collect()
    });
    (pinned, schema, bindings, key.root.to_string())
}

/// The evaluation memo of one attempt of one read (SPEC-18 §4.12 reading 21). The key is the
/// schema reference as the term writes it, the bindings in effect and the root. Bindings are
/// compared by their entries: the evaluator reads bindings only as values, so two binding objects
/// with the same entries give the same child, and sharing their key cannot change an answer.
///
/// It stores a child only when the child is final: every anchor its HView shows has been asked
/// for. It stores each key at most once. It must not outlive its attempt: a new snapshot, a new
/// selection or a new request can change what a stored child reads.
#[derive(Debug, Default)]
pub struct FinalChildMemo {
    asked: BTreeSet<String>,
    entries: BTreeMap<MemoKey, ChildValue>,
}

impl FinalChildMemo {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ChildMemo for FinalChildMemo {
    fn get(&mut self, key: &ChildKey<'_>) -> Option<ChildValue> {
        self.entries.get(&memo_key(key)).cloned()
    }

    fn put(&mut self, key: &ChildKey<'_>, value: &ChildValue) {
        if hview_anchors(value.view())
            .iter()
            .all(|anchor| self.asked.contains(anchor))
        {
            self.entries
                .entry(memo_key(key))
                .or_insert_with(|| value.clone());
        }
    }
}

impl RoundMemo for FinalChildMemo {
    fn round(&mut self, asked: &BTreeSet<String>) {
        self.asked.clone_from(asked);
    }

    fn stored(&self) -> usize {
        self.entries.len()
    }
}

/// What one round did (SPEC-18 §4.12 reading 9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundReport {
    /// Counted from 1 on each snapshot.
    pub round: usize,
    /// 1 for the first snapshot of a read; `StoreReactor` counts up when it starts again.
    pub attempt: usize,
    /// The revision of the snapshot this round ran on.
    pub revision: Revision,
    /// The entities of this round's one `scope` call, ascending.
    pub anchors: Vec<String>,
    /// How many deltas the store returned.
    pub returned: usize,
    /// How many deltas the read holds after this round.
    pub held: usize,
    /// How many exact members this round evaluated over.
    pub members: usize,
    /// What the store reported applied.
    pub applied: PushdownFields,
}

/// A callback that runs after each round's evaluation and before the next `scope` call, also
/// after the last round (SPEC-18 §4.12 reading 10). The read waits for it.
pub type RoundHook<'a> = &'a mut dyn FnMut(&RoundReport);

/// One anchored read.
pub struct ReadRequest<'a> {
    pub term: &'a Term,
    pub root: &'a str,
    pub now: f64,
    pub registry: Option<&'a SchemaRegistry>,
    pub bindings: Option<&'a Bindings>,
    pub selection: Selection<'a>,
    pub cache: FetchCache,
    pub memo: EvalMemo,
    pub on_round: Option<RoundHook<'a>>,
    /// Whether the read returns a capture of its raw scope (SPEC-18 §4.13 reading 28). With a
    /// pushdown, the capture costs the id-only calls of the raw scope after the last round.
    pub capture: bool,
}

impl<'a> ReadRequest<'a> {
    /// A read of `term` at `root` and `now`, with no registry, bindings, selection or hook.
    pub fn new(term: &'a Term, root: &'a str, now: f64) -> Self {
        Self {
            term,
            root,
            now,
            registry: None,
            bindings: None,
            selection: Selection::default(),
            cache: FetchCache::On,
            memo: EvalMemo::On,
            on_round: None,
            capture: false,
        }
    }
}

/// The answer of a store-backed read.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreRead {
    /// The term over the last round's members: the HView, or the View of a `resolve` term.
    pub result: EvalResult,
    /// Every anchor asked for, ascending.
    pub scope: Vec<String>,
    /// The exact members of the last round, ascending.
    pub members: Vec<String>,
    /// The revision of the snapshot the answer was read on.
    pub revision: Revision,
    pub rounds: Vec<RoundReport>,
    /// How many snapshots the read took: 1 for `read_anchored`, up to `SNAPSHOT_RETRIES + 1`
    /// for `StoreReactor::read`.
    pub snapshots: usize,
    /// How many child evaluations the read's memo held when the read ended: 0 with the memo
    /// off, and the number of keys stored with it on (SPEC-18 §4.12 reading 27). The memo
    /// changes no answer, so this count is how a caller sees whether a read used it. It counts
    /// the last attempt only; each attempt starts a new memo.
    pub memo_stored: usize,
    /// The window of the read's operand, its exact members, at its `now` (SPEC-18 §4.6). The
    /// answer is the same at every time in `[since, expires_at)` while nothing touches the read.
    pub since: Option<f64>,
    pub expires_at: Option<f64>,
    /// The capture, when the request asked for one.
    pub capture: Option<Capture>,
}

/// Why a store-backed read failed.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreReadError {
    /// The term is not anchored (SPEC-17 §5). No store call was made.
    Unanchored(UnanchoredReason),
    /// A store refusal, passed up as it came.
    Store(StoreError),
    /// The evaluator refused the term.
    Eval(String),
}

impl StoreReadError {
    /// The store refusal code, when this is one.
    pub fn store_code(&self) -> Option<StoreErrorCode> {
        match self {
            Self::Store(e) => Some(e.code),
            _ => None,
        }
    }
}

impl fmt::Display for StoreReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unanchored(reason) => {
                f.write_str(&format!("term is not anchored: {}", reason.as_str()))
            }
            Self::Store(e) => f.write_str(&e.to_string()),
            Self::Eval(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for StoreReadError {}

impl From<StoreError> for StoreReadError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

/// The pushdown fields that stay residual for the rest of a read: each requested field that the
/// answer of some round did not report applied (SPEC-18 §4.12 reading 2).
#[derive(Debug, Clone, Copy, Default)]
struct Residual {
    timestamp_at_most: bool,
    arrival_at_most: bool,
    exclude_ids: bool,
}

impl Residual {
    fn record(&mut self, asked: Option<&Pushdown>, applied: PushdownFields) {
        let Some(asked) = asked else { return };
        self.timestamp_at_most |= asked.timestamp_at_most.is_some() && !applied.timestamp_at_most;
        self.arrival_at_most |= asked.arrival_at_most.is_some() && !applied.arrival_at_most;
        self.exclude_ids |= asked.exclude_ids.is_some() && !applied.exclude_ids;
    }
}

/// Whether a fetched member passes the residual selection: the host predicate, and every
/// pushdown field that is residual.
fn passes(
    delta: &Delta,
    arrival: &ArrivalRecord,
    selection: &Selection<'_>,
    residual: Residual,
) -> bool {
    if let Some(p) = selection.pushdown {
        if residual.timestamp_at_most
            && p.timestamp_at_most
                .is_some_and(|t| delta.claims.timestamp > t)
        {
            return false;
        }
        if residual.arrival_at_most && p.arrival_at_most.is_some_and(|n| arrival.sequence > n) {
            return false;
        }
        if residual.exclude_ids
            && p.exclude_ids
                .as_ref()
                .is_some_and(|ids| ids.contains(&delta.id))
        {
            return false;
        }
    }
    selection.admits.is_none_or(|admits| admits(delta, arrival))
}

/// S(anchors) over the members of `cache` that pass the residual selection, ascending (SPEC-18
/// §4.3 trim lemma, §4.12 reading 3).
fn exact_members(
    cache: &ScopeSource,
    anchors: &BTreeSet<String>,
    selection: &Selection<'_>,
    residual: Residual,
) -> Vec<String> {
    let admits = |delta: &Delta| {
        cache
            .arrival(&delta.id)
            .is_some_and(|arrival| passes(delta, arrival, selection, residual))
    };
    scope_ids(cache, anchors.iter().map(String::as_str), Some(&admits))
}

fn scope_request(
    anchors: &[String],
    pushdown: Option<&Pushdown>,
    exclude: Vec<String>,
) -> ScopeRequest {
    ScopeRequest {
        anchors: anchors
            .iter()
            .map(|entity| Anchor::Entity {
                entity: entity.clone(),
            })
            .collect(),
        pushdown: pushdown.cloned(),
        exclude,
    }
}

/// Whether a selection pushes any field down. A pushdown with no field selects nothing, so the
/// store's answer is the raw scope.
fn pushes(pushdown: Option<&Pushdown>) -> bool {
    pushdown.is_some_and(|p| {
        p.timestamp_at_most.is_some() || p.arrival_at_most.is_some() || p.exclude_ids.is_some()
    })
}

/// The capture of a read or a fetch on `snapshot` (SPEC-18 §4.6). With nothing pushed down, the
/// fetch cache is the raw scope and the capture makes no store call; with a pushdown, the raw
/// scope comes from id-only calls on the same snapshot, never from the pushed-down fetch.
fn capture_of(
    snapshot: &dyn Snapshot,
    asked: &BTreeSet<String>,
    pushdown: Option<&Pushdown>,
    cache: &ScopeSource,
    window: ValidityWindow,
) -> Result<Capture, StoreError> {
    let entities: Vec<String> = asked.iter().cloned().collect();
    let members = match pushes(pushdown) {
        true => raw_scope(snapshot, &entities)?,
        false => cache.ids().into_iter().map(str::to_string).collect(),
    };
    make_capture(
        snapshot,
        entities
            .into_iter()
            .map(|entity| Anchor::Entity { entity })
            .collect(),
        members,
        window,
    )
}

/// The window of a read's operand: the exact members, each from the cache.
fn operand_window(cache: &ScopeSource, members: &[String], now: f64) -> ValidityWindow {
    validity_window(members.iter().filter_map(|id| cache.get(id)), now)
}

/// The static anchors of an anchored term, or the reason it is not anchored (SPEC-17 §5).
fn classify(request: &ReadRequest<'_>) -> Result<Vec<String>, StoreReadError> {
    match anchor_analysis(request.term, request.registry, request.bindings) {
        AnchorAnalysis::Anchored { anchors } => Ok(anchors),
        AnchorAnalysis::Unanchored(reason) => Err(StoreReadError::Unanchored(reason)),
    }
}

/// An anchored read in rounds on one snapshot (SPEC-18 §4.4). It answers the same bytes as the
/// term evaluated over everything the snapshot holds that the selection admits.
///
/// An unanchored term is refused with `StoreReadError::Unanchored` before any store call. A
/// store refusal, `snapshot-moved` included, passes up and the read keeps nothing. The caller
/// owns the snapshot and releases it.
pub fn read_anchored(
    snapshot: &dyn Snapshot,
    request: ReadRequest<'_>,
) -> Result<StoreRead, StoreReadError> {
    let mut memo = FinalChildMemo::new();
    let memo = (request.memo == EvalMemo::On).then_some(&mut memo as &mut dyn RoundMemo);
    read_rounds(snapshot, request, 1, &mut ScopeSource::default(), memo)
}

/// `read_anchored` with a memo the caller owns, whatever `request.memo` says. The read tells the
/// memo every anchor asked for before each round's evaluation and never resets it. A memo that
/// serves more than one attempt of one read can give a wrong answer (SPEC-18 §4.12 reading 25).
pub fn read_anchored_with_memo(
    snapshot: &dyn Snapshot,
    request: ReadRequest<'_>,
    memo: &mut dyn RoundMemo,
) -> Result<StoreRead, StoreReadError> {
    read_rounds(
        snapshot,
        request,
        1,
        &mut ScopeSource::default(),
        Some(memo),
    )
}

/// The rounds of one attempt. `cache` must be empty: a cache never outlives its snapshot
/// (SPEC-18 §4.12 reading 11), and one kept from an earlier snapshot can show a purged delta.
fn read_rounds(
    snapshot: &dyn Snapshot,
    mut request: ReadRequest<'_>,
    attempt: usize,
    cache: &mut ScopeSource,
    mut memo: Option<&mut dyn RoundMemo>,
) -> Result<StoreRead, StoreReadError> {
    let static_anchors = classify(&request)?;
    let (gather, resolves) = match request.term {
        Term::Resolve { of, .. } => (of.as_ref(), true),
        t => (t, false),
    };
    let selection = request.selection;
    let pushdown = selection.pushdown;
    let mut asked: BTreeSet<String> = BTreeSet::new();
    let mut next: BTreeSet<String> = static_anchors.into_iter().collect();
    next.insert(request.root.to_string());
    let mut residual = Residual::default();
    let mut rounds = Vec::new();
    loop {
        asked.extend(next.iter().cloned());
        let call = match request.cache {
            FetchCache::On => scope_request(
                &next.iter().cloned().collect::<Vec<_>>(),
                pushdown,
                cache.ids().into_iter().map(str::to_string).collect(),
            ),
            FetchCache::Off => {
                *cache = ScopeSource::default();
                scope_request(
                    &asked.iter().cloned().collect::<Vec<_>>(),
                    pushdown,
                    Vec::new(),
                )
            }
        };
        let answer = snapshot.scope(&call)?;
        cache.extend(&answer.deltas)?;
        residual.record(pushdown, answer.applied);
        let members = exact_members(cache, &asked, &selection, residual);
        let set = cache.subset(&members);
        if let Some(m) = memo.as_deref_mut() {
            m.round(&asked);
        }
        let mut evaluate = |term: &Term| {
            eval_term_at_with_memo(
                term,
                &set,
                request.now,
                Some(request.root),
                request.registry,
                request.bindings,
                memo.as_deref_mut().map(|m| m as &mut dyn ChildMemo),
            )
            .map_err(StoreReadError::Eval)
        };
        let gathered = evaluate(gather)?;
        let EvalResult::HView(view) = &gathered else {
            return Err(StoreReadError::Unanchored(UnanchoredReason::ResultSort));
        };
        let shown: BTreeSet<String> = hview_anchors(view)
            .into_iter()
            .filter(|anchor| !asked.contains(anchor))
            .collect();
        let report = RoundReport {
            round: rounds.len() + 1,
            attempt,
            revision: snapshot.revision(),
            anchors: call
                .anchors
                .iter()
                .map(|Anchor::Entity { entity }| entity.clone())
                .collect(),
            returned: answer.deltas.len(),
            held: cache.len(),
            members: members.len(),
            applied: answer.applied,
        };
        if let Some(hook) = request.on_round.as_mut() {
            hook(&report);
        }
        rounds.push(report);
        if shown.is_empty() {
            // The final `resolve` evaluation uses the memo of the read (reading 21).
            let result = if resolves {
                evaluate(request.term)?
            } else {
                gathered
            };
            let window = operand_window(cache, &members, request.now);
            let capture = match request.capture {
                true => Some(capture_of(snapshot, &asked, pushdown, cache, window)?),
                false => None,
            };
            return Ok(StoreRead {
                result,
                scope: asked.into_iter().collect(),
                members,
                revision: snapshot.revision(),
                rounds,
                snapshots: 1,
                memo_stored: memo.as_deref().map_or(0, |m| m.stored()),
                since: window.since,
                expires_at: window.expires_at,
                capture,
            });
        }
        next = shown;
    }
}

/// One fetch (SPEC-18 §4.12 reading 12): a synchronous source over exactly S(entities) under the
/// selection, and the revision it was read at.
#[derive(Debug, Clone)]
pub struct FetchedScope {
    pub source: ScopeSource,
    pub revision: Revision,
    /// Every validity boundary of the members, ascending and distinct.
    boundaries: Vec<f64>,
}

impl FetchedScope {
    /// The window of the members at `now` (SPEC-18 §4.13 reading 27). A law reader asks a fetched
    /// scope at its own times, so the scope carries no `now`. O(log members).
    pub fn validity_at(&self, now: f64) -> ValidityWindow {
        window_at(&self.boundaries, now)
    }
}

/// One `scope` call for `entities` (each once, ascending), then a source that knows exactly
/// S(entities) under the selection. A delta the store returned beyond that is not in the source.
pub fn fetch_scope(
    snapshot: &dyn Snapshot,
    entities: &[String],
    selection: Selection<'_>,
) -> Result<FetchedScope, StoreError> {
    fetched(snapshot, entities, selection).map(|(fetched, _, _)| fetched)
}

/// `fetch_scope` and a capture beside it (SPEC-18 §4.13 reading 28), with the window at `now`.
/// With nothing pushed down the capture's members are what the one `scope` call returned; with a
/// pushdown they come from `targets` and `negators` on the same snapshot. Refuses
/// `invalid-request` for a `now` that is not finite, before any store call.
pub fn capture_scope(
    snapshot: &dyn Snapshot,
    entities: &[String],
    now: f64,
    selection: Selection<'_>,
) -> Result<(FetchedScope, Capture), StoreError> {
    if !now.is_finite() {
        return Err(StoreError::new(
            StoreErrorCode::InvalidRequest,
            "captureScope needs a now that is a finite number",
        ));
    }
    let (fetched, anchors, cache) = fetched(snapshot, entities, selection)?;
    let window = fetched.validity_at(now);
    let capture = capture_of(snapshot, &anchors, selection.pushdown, &cache, window)?;
    Ok((fetched, capture))
}

/// The fetch, with the anchors it asked for and everything the store returned.
fn fetched(
    snapshot: &dyn Snapshot,
    entities: &[String],
    selection: Selection<'_>,
) -> Result<(FetchedScope, BTreeSet<String>, ScopeSource), StoreError> {
    let anchors: BTreeSet<String> = entities.iter().cloned().collect();
    let call = scope_request(
        &anchors.iter().cloned().collect::<Vec<_>>(),
        selection.pushdown,
        Vec::new(),
    );
    let answer = snapshot.scope(&call)?;
    let mut cache = ScopeSource::default();
    cache.extend(&answer.deltas)?;
    let mut residual = Residual::default();
    residual.record(selection.pushdown, answer.applied);
    let members = exact_members(&cache, &anchors, &selection, residual);
    let source = cache.restrict(&members);
    let boundaries = validity_boundaries(members.iter().filter_map(|id| cache.get(id)));
    let fetched = FetchedScope {
        source,
        revision: snapshot.revision(),
        boundaries,
    };
    Ok((fetched, anchors, cache))
}

/// One explicit full-surface read (SPEC-18 §6.6, §4.12 reading 28). The term may be anchored or
/// not, and the root is optional because an unanchored term need not read one.
pub struct FullSurfaceRequest<'a> {
    pub term: &'a Term,
    pub root: Option<&'a str>,
    pub now: f64,
    pub registry: Option<&'a SchemaRegistry>,
    pub bindings: Option<&'a Bindings>,
    /// Only `timestamp_at_most` and `exclude_ids` are taken. A listing carries no arrival
    /// record, so `arrival_at_most` and a host predicate are refused.
    pub selection: Selection<'a>,
}

impl<'a> FullSurfaceRequest<'a> {
    /// A read of `term` at `now`, with no root, registry, bindings or selection.
    pub fn new(term: &'a Term, now: f64) -> Self {
        Self {
            term,
            root: None,
            now,
            registry: None,
            bindings: None,
            selection: Selection::default(),
        }
    }
}

/// How a full-surface read went. It is never optimized: it listed the whole peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FullSurfaceRoute {
    /// Always `false`.
    pub optimized: bool,
    /// How many deltas the listing gave.
    pub listed: usize,
    /// How many of them the selection admitted.
    pub admitted: usize,
}

/// The answer of a full-surface read.
#[derive(Debug, Clone, PartialEq)]
pub struct FullSurfaceRead {
    pub result: EvalResult,
    pub route: FullSurfaceRoute,
}

/// The explicit full-surface read (SPEC-18 §6.6, §4.12 reading 28): list the peer through its
/// exporter, keep what the selection admits, and evaluate the term over that with the ordinary
/// evaluator. It costs the peer's whole surface and keeps nothing. Only a caller that holds an
/// exporter can call it; `StoreReactor` and a snapshot hold none.
///
/// A selection with `arrival_at_most` or a host predicate is refused `invalid-request` before
/// anything is listed. A listed delta whose id does not recompute is refused, not repaired.
pub fn read_full_surface(
    exporter: &dyn PeerExporter,
    request: FullSurfaceRequest<'_>,
) -> Result<FullSurfaceRead, StoreReadError> {
    let pushdown = request.selection.pushdown;
    let refuse = |field: &str| {
        StoreReadError::Store(StoreError::new(
            StoreErrorCode::InvalidRequest,
            format!(
                "a full-surface read cannot select by {field}: a listing carries no arrival record"
            ),
        ))
    };
    if pushdown.is_some_and(|p| p.arrival_at_most.is_some()) {
        return Err(refuse("arrivalAtMost"));
    }
    if request.selection.admits.is_some() {
        return Err(refuse("a host predicate"));
    }
    let listed = collect_delta_set(exporter)?;
    let kept = fork(&listed, |delta| {
        pushdown.is_none_or(|p| {
            p.timestamp_at_most
                .is_none_or(|t| delta.claims.timestamp <= t)
                && p.exclude_ids
                    .as_ref()
                    .is_none_or(|ids| !ids.contains(&delta.id))
        })
    });
    let result = eval_term_at(
        request.term,
        &kept,
        request.now,
        request.root,
        request.registry,
        request.bindings,
    )
    .map_err(StoreReadError::Eval)?;
    Ok(FullSurfaceRead {
        result,
        route: FullSurfaceRoute {
            optimized: false,
            listed: listed.len(),
            admitted: kept.len(),
        },
    })
}

/// Releases a snapshot when it goes out of scope, on every path.
struct Held(Box<dyn Snapshot>);

impl Drop for Held {
    fn drop(&mut self) {
        self.0.release();
    }
}

/// A reader over one peer's store (SPEC-18 §4.12 reading 15). It holds the peer handle and
/// nothing else: opening it reads nothing, and it has no whole-set method.
pub struct StoreReactor {
    peer: Box<dyn PeerStore>,
}

impl StoreReactor {
    /// O(1). Makes no store call.
    pub fn open(peer: Box<dyn PeerStore>) -> Self {
        Self { peer }
    }

    pub fn peer(&self) -> &dyn PeerStore {
        self.peer.as_ref()
    }

    /// Runs `body` on a new snapshot, released on every path. On `snapshot-moved` it starts
    /// again on a new snapshot, at most `SNAPSHOT_RETRIES` more times; any other refusal passes
    /// up at once. `body` receives the attempt, counted from 1. Returns the answer and how many
    /// snapshots it took.
    fn on_snapshots<T, E: From<StoreError>>(
        &self,
        mut body: impl FnMut(&dyn Snapshot, usize) -> Result<T, E>,
        moved: impl Fn(&E) -> bool,
    ) -> Result<(T, usize), E> {
        let mut taken = 0;
        loop {
            let snapshot = Held(self.peer.read()?);
            taken += 1;
            match body(snapshot.0.as_ref(), taken) {
                Err(e) if moved(&e) && taken <= SNAPSHOT_RETRIES => continue,
                other => return other.map(|answer| (answer, taken)),
            }
        }
    }

    /// `read_anchored` on a new snapshot, started again with a new cache on `snapshot-moved`.
    /// An unanchored term is refused before any store call, the snapshot included. The hook, when
    /// given, sees the rounds of every attempt, each report with its attempt and revision.
    pub fn read(&self, mut request: ReadRequest<'_>) -> Result<StoreRead, StoreReadError> {
        classify(&request)?;
        let mut hook = request.on_round.take();
        let (mut read, taken) = self.on_snapshots(
            |snapshot, attempt| {
                let one = ReadRequest {
                    term: request.term,
                    root: request.root,
                    now: request.now,
                    registry: request.registry,
                    bindings: request.bindings,
                    selection: request.selection,
                    cache: request.cache,
                    memo: request.memo,
                    on_round: hook
                        .as_mut()
                        .map(|h| &mut **h as &mut dyn FnMut(&RoundReport)),
                    capture: request.capture,
                };
                // A new cache and a new memo for every attempt: what an older snapshot held may be
                // purged now, and a child stored on it may read differently on this one.
                let mut memo = FinalChildMemo::new();
                let memo = (one.memo == EvalMemo::On).then_some(&mut memo as &mut dyn RoundMemo);
                read_rounds(snapshot, one, attempt, &mut ScopeSource::default(), memo)
            },
            |e| e.store_code() == Some(StoreErrorCode::SnapshotMoved),
        )?;
        read.snapshots = taken;
        Ok(read)
    }

    /// `fetch_scope` on a new snapshot, started again on `snapshot-moved`.
    pub fn fetch(
        &self,
        entities: &[String],
        selection: Selection<'_>,
    ) -> Result<FetchedScope, StoreError> {
        self.on_snapshots(
            |snapshot, _| fetch_scope(snapshot, entities, selection),
            |e: &StoreError| e.code == StoreErrorCode::SnapshotMoved,
        )
        .map(|(fetched, _)| fetched)
    }
}

/// This witness's freshness functions, as the conformance runner calls them (`vectors/store/
/// README.md` §9): `capture_scope`, `touching` and `check_fresh`.
#[derive(Debug, Clone, Copy, Default)]
pub struct StoreFreshness;

impl FreshnessReader for StoreFreshness {
    fn capture(
        &self,
        snapshot: &dyn Snapshot,
        entities: &[String],
        now: f64,
        pushdown: Option<&Pushdown>,
    ) -> Result<Capture, StoreError> {
        let selection = Selection {
            pushdown,
            admits: None,
        };
        capture_scope(snapshot, entities, now, selection).map(|(_, capture)| capture)
    }

    fn touching(
        &self,
        capture: &Capture,
        records: &[ChangeRecord],
        added: &BTreeMap<String, Delta>,
    ) -> Option<Touch> {
        touching(capture, records, added)
    }

    fn check_fresh(
        &self,
        peer: &dyn PeerStore,
        capture: &Capture,
        now: f64,
    ) -> Result<Freshness, StoreError> {
        check_fresh(peer, capture, now)
    }
}
