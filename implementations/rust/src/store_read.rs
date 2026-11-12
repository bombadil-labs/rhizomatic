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
//! The evaluation memo (§4.12 readings 21 to 26) keeps, for one attempt of one read, each child
//! evaluation that is final: every anchor its HView shows has been asked for. A later round, and
//! the final `resolve` evaluation, use it and do not evaluate that child again.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::anchored::{
    anchor_analysis, hview_anchors, scope_ids, AnchorAnalysis, UnanchoredReason,
};
use crate::eval::{
    eval_term_at_with_memo, ChildKey, ChildMemo, ChildValue, EvalResult, SchemaRef, Term,
};
use crate::pred::Bindings;
use crate::schema::SchemaRegistry;
use crate::set::DeltaSource;
use crate::store::{
    Anchor, ArrivalRecord, PeerStore, Pushdown, PushdownFields, Revision, ScopeRequest,
    ScopeSource, Snapshot, StoreError, StoreErrorCode,
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

    /// How many children the memo holds.
    pub fn stored(&self) -> usize {
        self.entries.len()
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
            return Ok(StoreRead {
                result,
                scope: asked.into_iter().collect(),
                members,
                revision: snapshot.revision(),
                rounds,
                snapshots: 1,
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
}

/// One `scope` call for `entities` (each once, ascending), then a source that knows exactly
/// S(entities) under the selection. A delta the store returned beyond that is not in the source.
pub fn fetch_scope(
    snapshot: &dyn Snapshot,
    entities: &[String],
    selection: Selection<'_>,
) -> Result<FetchedScope, StoreError> {
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
    Ok(FetchedScope {
        source: cache.restrict(&members),
        revision: snapshot.revision(),
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
