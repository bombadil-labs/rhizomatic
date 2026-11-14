//! Held views (SPEC-18 proposal §4.6, "Held views"; §4.13 readings 75 to 90): the results of
//! anchored reads `(program, root)` with their captures, held in memory for one peer and kept
//! current through the change feed in one pass for the whole set.
//!
//! A pass takes one snapshot, reads the feed since the processed position, finds the touched
//! views through an inverted index (anchor entity → views, member id → views), finds the views
//! whose window no longer holds `now` through two ordered sets, and the views whose program's
//! epoch moved through a per-program index; it reads those views again on the same snapshot,
//! releases the snapshot, and only then applies. It never walks the held views per record, and
//! never the holdings.
//!
//! A held view lies outside erasure (§4.6; §4.7.2): its bytes and its baseline keep a purged
//! delta's payload until the first pass that reads the record removing it. That pass reads the
//! view again and releases every baseline read from a raw scope that held the delta.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::Arc;

use serde_json::Value;

use crate::anchored::{anchor_analysis, AnchorAnalysis};
use crate::eval::{result_canonical_hex, Term};
use crate::schema::{HyperSchema, SchemaRegistry};
use crate::store::{
    negated_ids, target_entities, ArrivalRecord, ChangePage, ChangeRecord, PeerStore, Pushdown,
    Revision, Snapshot, StoreError, StoreErrorCode,
};
use crate::store_conformance::{RegisterRefusal, ViewHolder, ViewsReader};
use crate::store_follow::{position_of, Position};
use crate::store_fresh::{
    advance_capture, answered_only, checked_through, on_snapshots, touching, Capture, FeedError,
};
use crate::store_held::{Refresh, ViewChange, ViewFrom, ViewKey, ViewRead};
use crate::store_read::{read_anchored, EvalMemo, FetchCache, ReadRequest, Selection};
use crate::term_json::parse_term;
use crate::types::Delta;

/// How many views a holder keeps when its options do not say.
pub const DEFAULT_MAX_VIEWS: usize = 1024;

/// How many snapshots one pass takes at most: it starts again on `snapshot-moved` three times,
/// as `check_fresh` does.
pub const VIEW_SNAPSHOTS: usize = 4;

/// A host predicate over a delta and its arrival record, owned by a program. It must be
/// pointwise (SPEC-17 §3). The store never sees it.
pub type HostAdmits = Arc<dyn Fn(&Delta, &ArrivalRecord) -> bool>;

/// One program a holder can hold at many roots: a read's term, its registry, its selection, and
/// the epoch of the host state its selection or authority reads outside the store.
#[derive(Clone)]
pub struct ViewProgram {
    pub term: Term,
    pub registry: Option<Arc<SchemaRegistry>>,
    pub pushdown: Option<Pushdown>,
    pub admits: Option<HostAdmits>,
    /// Default `""`. Compared by value (§4.13 reading 79).
    pub epoch: String,
}

impl ViewProgram {
    /// A program with no registry, no selection and the epoch `""`.
    pub fn new(term: Term) -> Self {
        Self {
            term,
            registry: None,
            pushdown: None,
            admits: None,
            epoch: String::new(),
        }
    }
}

impl fmt::Debug for ViewProgram {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ViewProgram")
            .field("term", &self.term)
            .field("registry", &self.registry.as_ref().map(|_| "<registry>"))
            .field("pushdown", &self.pushdown)
            .field("admits", &self.admits.as_ref().map(|_| "<fn>"))
            .field("epoch", &self.epoch)
            .finish()
    }
}

/// How a holder is made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreViewsOptions {
    /// An integer of 1 or more; 0 is refused when the holder is made.
    pub max_views: usize,
    /// The round policy of every read.
    pub cache: FetchCache,
    pub memo: EvalMemo,
}

impl Default for StoreViewsOptions {
    fn default() -> Self {
        Self {
            max_views: DEFAULT_MAX_VIEWS,
            cache: FetchCache::On,
            memo: EvalMemo::On,
        }
    }
}

/// One rule a holder written for the rails breaks (`vectors/store/README.md` §11.6). The right
/// holder has none. It exists so that the rails can prove each rule is load-bearing.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewQuirk {
    NeverRereads,
    RereadsEverything,
    IgnoresRemoved,
    IgnoresNegators,
    KeepsFirstIndex,
    KeepsForgottenIndex,
    IgnoresSince,
    IgnoresExpiry,
    IgnoresEpoch,
    ReadsOnNewerSnapshot,
    MergesOnResync,
    FeedPerView,
    StaticBoundary,
    KeepsPurgedBaseline,
    ServesEvictedBytes,
    MovesOnFailure,
    TouchingPerView,
    UnorderedReread,
    ReadsOnSetEpoch,
    OtherHistory,
}

/// The sizes of a holder's indexes and orderings, for the rails of forgetting.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ViewSizes {
    pub views: usize,
    pub anchor_entries: usize,
    pub member_entries: usize,
    pub baseline_entries: usize,
    pub by_since: usize,
    pub by_expiry: usize,
    pub by_use: usize,
    pub by_epoch: usize,
    pub unsettled: usize,
}

/// A finite bound, ordered totally.
#[derive(Debug, Clone, Copy)]
struct Bound(f64);

impl PartialEq for Bound {
    fn eq(&self, other: &Self) -> bool {
        self.0.total_cmp(&other.0).is_eq()
    }
}

impl Eq for Bound {}

impl PartialOrd for Bound {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Bound {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

/// What a view's bytes are compared against at the next refresh.
#[derive(Debug, Clone, PartialEq)]
enum Baseline {
    /// The view's bytes now, read from its current capture: nothing read it since the baseline.
    Current,
    /// Bytes read earlier, with the raw scope they were read from. Its members are in the
    /// baseline index.
    Older { bytes: String, members: Vec<String> },
    /// Released: the holder keeps none of its bytes.
    Released,
}

#[derive(Debug)]
struct Held {
    bytes: String,
    capture: Capture,
    epoch: String,
    used: u64,
    baseline: Baseline,
}

#[derive(Debug)]
struct Program {
    spec: ViewProgram,
    reads: u64,
    /// The roots held, by the epoch each was read under.
    held: BTreeMap<String, BTreeSet<String>>,
}

type Index = BTreeMap<String, BTreeSet<ViewKey>>;

fn index_add(index: &mut Index, keys: impl IntoIterator<Item = String>, view: &ViewKey) {
    for key in keys {
        index.entry(key).or_default().insert(view.clone());
    }
}

fn index_remove<'k>(index: &mut Index, keys: impl IntoIterator<Item = &'k String>, view: &ViewKey) {
    for key in keys {
        if let Some(views) = index.get_mut(key) {
            views.remove(view);
            if views.is_empty() {
                index.remove(key);
            }
        }
    }
}

fn entities(capture: &Capture) -> Vec<String> {
    capture
        .anchors()
        .iter()
        .map(|crate::store::Anchor::Entity { entity }| entity.clone())
        .collect()
}

/// One read of a pass, kept until the pass applies.
struct Fresh {
    bytes: String,
    capture: Capture,
    epoch: String,
}

/// What one pass decided and read on its snapshot. Nothing is applied until the pass ends.
struct Plan {
    position: Position,
    resynced: bool,
    reads: BTreeMap<ViewKey, Fresh>,
    released: BTreeSet<ViewKey>,
    evict: Option<ViewKey>,
}

/// What a pass found in the feed.
enum Feed {
    Read,
    Resync,
}

/// Held views over one peer (SPEC-18 §4.6, "Held views"). Every call takes the holder mutably,
/// so calls run one at a time, in call order (§4.13 reading 81). A call that fails changes
/// nothing: no view, no index entry and not the processed position (reading 84).
pub struct StoreViews<'a> {
    peer: Box<dyn PeerStore + 'a>,
    options: StoreViewsOptions,
    quirk: Option<ViewQuirk>,
    programs: BTreeMap<String, Program>,
    views: BTreeMap<ViewKey, Held>,
    processed: Option<Position>,
    by_anchor: Index,
    by_member: Index,
    by_baseline: Index,
    by_since: BTreeSet<(Bound, ViewKey)>,
    by_expiry: BTreeSet<(Bound, ViewKey)>,
    by_use: BTreeMap<u64, ViewKey>,
    tick: u64,
    /// The views whose baseline is not `Current`: the only ones a refresh can report.
    unsettled: BTreeSet<ViewKey>,
    /// `ServesEvictedBytes` only: the bytes of evicted views.
    graveyard: BTreeMap<ViewKey, String>,
}

impl fmt::Debug for StoreViews<'_> {
    /// Every value the holder keeps, but the store handle: the erasure rails search this text
    /// for a purged payload.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoreViews")
            .field("peer", &self.peer.id())
            .field("options", &self.options)
            .field("quirk", &self.quirk)
            .field("programs", &self.programs)
            .field("views", &self.views)
            .field("processed", &self.processed)
            .field("by_anchor", &self.by_anchor)
            .field("by_member", &self.by_member)
            .field("by_baseline", &self.by_baseline)
            .field("by_since", &self.by_since)
            .field("by_expiry", &self.by_expiry)
            .field("by_use", &self.by_use)
            .field("unsettled", &self.unsettled)
            .field("graveyard", &self.graveyard)
            .finish()
    }
}

fn invalid(message: String) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidRequest, message)
}

impl<'a> StoreViews<'a> {
    /// A holder over `peer`. It makes no store call. Refuses `invalid-request` for a `max_views`
    /// of 0.
    pub fn new(
        peer: Box<dyn PeerStore + 'a>,
        options: StoreViewsOptions,
    ) -> Result<Self, StoreError> {
        Self::made(peer, options, None)
    }

    /// The holder with one rule broken, for the rails (README §11.6).
    #[doc(hidden)]
    pub fn with_quirk(
        peer: Box<dyn PeerStore + 'a>,
        options: StoreViewsOptions,
        quirk: Option<ViewQuirk>,
    ) -> Result<Self, StoreError> {
        Self::made(peer, options, quirk)
    }

    fn made(
        peer: Box<dyn PeerStore + 'a>,
        options: StoreViewsOptions,
        quirk: Option<ViewQuirk>,
    ) -> Result<Self, StoreError> {
        if options.max_views == 0 {
            return Err(invalid(
                "StoreViews: maxViews is an integer of 1 or more".into(),
            ));
        }
        Ok(Self {
            peer,
            options,
            quirk,
            programs: BTreeMap::new(),
            views: BTreeMap::new(),
            processed: None,
            by_anchor: Index::new(),
            by_member: Index::new(),
            by_baseline: Index::new(),
            by_since: BTreeSet::new(),
            by_expiry: BTreeSet::new(),
            by_use: BTreeMap::new(),
            tick: 0,
            unsettled: BTreeSet::new(),
            graveyard: BTreeMap::new(),
        })
    }

    fn quirk(&self, quirk: ViewQuirk) -> bool {
        self.quirk == Some(quirk)
    }

    /// Registers a program under `name`. An unanchored term is refused with the SPEC-17 §5
    /// reason of an anchored read; a name given twice is refused `invalid-request`. No store
    /// call.
    pub fn register(&mut self, name: &str, program: ViewProgram) -> Result<(), RegisterRefusal> {
        if self.programs.contains_key(name) {
            return Err(RegisterRefusal::Refused(invalid(format!(
                "StoreViews: the program {name} is registered already"
            ))));
        }
        if let AnchorAnalysis::Unanchored(reason) =
            anchor_analysis(&program.term, program.registry.as_deref(), None)
        {
            return Err(RegisterRefusal::Unanchored(reason.as_str().to_string()));
        }
        self.programs.insert(
            name.to_string(),
            Program {
                spec: program,
                reads: 0,
                held: BTreeMap::new(),
            },
        );
        Ok(())
    }

    fn registered(&self, name: &str) -> Result<&Program, StoreError> {
        self.programs
            .get(name)
            .ok_or_else(|| invalid(format!("StoreViews: the program {name} is not registered")))
    }

    /// Gives a program a new epoch. A view read under another epoch is read again by the next
    /// pass. Refuses `invalid-request` for a program not registered. No store call.
    pub fn set_epoch(&mut self, name: &str, epoch: &str) -> Result<(), StoreError> {
        self.registered(name)?;
        if self.quirk(ViewQuirk::ReadsOnSetEpoch) {
            let mut snapshot = self.peer.read()?;
            snapshot.release();
        }
        if let Some(program) = self.programs.get_mut(name) {
            program.spec.epoch = epoch.to_string();
        }
        Ok(())
    }

    /// Forgets one view and every index entry it had. A view not held is no error; a program
    /// not registered is refused `invalid-request`. No store call.
    pub fn drop_view(&mut self, name: &str, root: &str) -> Result<(), StoreError> {
        self.registered(name)?;
        self.forget(&ViewKey::new(name, root));
        Ok(())
    }

    /// The least `expires_at` over the held views.
    pub fn next_boundary(&self) -> Option<f64> {
        self.by_expiry.first().map(|(bound, _)| bound.0)
    }

    /// How many reads of this program the holder applied.
    pub fn eval_count_of(&self, name: &str) -> u64 {
        self.programs.get(name).map_or(0, |p| p.reads)
    }

    /// The sizes of the holder's indexes and orderings.
    #[doc(hidden)]
    pub fn sizes(&self) -> ViewSizes {
        let entries = |index: &Index| index.values().map(BTreeSet::len).sum();
        ViewSizes {
            views: self.views.len(),
            anchor_entries: entries(&self.by_anchor),
            member_entries: entries(&self.by_member),
            baseline_entries: entries(&self.by_baseline),
            by_since: self.by_since.len(),
            by_expiry: self.by_expiry.len(),
            by_use: self.by_use.len(),
            by_epoch: self
                .programs
                .values()
                .flat_map(|p| p.held.values())
                .map(BTreeSet::len)
                .sum(),
            unsettled: self.unsettled.len(),
        }
    }

    /// Holds the view `(name, root)` and answers it at the pass's position (§4.6). The pass is
    /// the pass of `refresh`, over every held view, then reads this view when it is not held.
    /// When the view is new and `max_views` views are held, the least recently held view is
    /// forgotten, and the pass does not read it. Only `hold` makes a view recent.
    pub fn hold(&mut self, name: &str, root: &str, now: f64) -> Result<ViewRead, FeedError> {
        Self::finite(now, "hold")?;
        self.registered(name)?;
        let key = ViewKey::new(name, root);
        let plan = self.pass(now, Some(&key))?;
        let read_now = plan.reads.contains_key(&key);
        let held_before = self.views.contains_key(&key);
        let position = plan.position.clone();
        self.apply(plan, Some(&key));
        let view = self
            .views
            .get(&key)
            .ok_or_else(|| invalid(format!("StoreViews: the view {name} at {root} is not held")))?;
        let capture = advance_capture(&view.capture, &position.history, position.revision)?;
        let position = match self.quirk(ViewQuirk::OtherHistory) {
            true => Position {
                history: format!("{}:another", position.history),
                revision: position.revision,
            },
            false => position,
        };
        Ok(ViewRead {
            name: name.to_string(),
            root: root.to_string(),
            bytes: view.bytes.clone(),
            position,
            expires_at: view.capture.expires_at(),
            from: match held_before && !read_now {
                true => ViewFrom::Held,
                false => ViewFrom::Read,
            },
            capture,
        })
    }

    /// One pass (§4.6), then `changed` against each view's baseline; every held view's bytes
    /// then become its baseline.
    pub fn refresh(&mut self, now: f64) -> Result<Refresh, FeedError> {
        Self::finite(now, "refresh")?;
        let plan = self.pass(now, None)?;
        let mut reread: Vec<ViewKey> = plan.reads.keys().cloned().collect();
        let (position, resynced) = (plan.position.clone(), plan.resynced);
        self.apply(plan, None);
        let mut changed = Vec::new();
        for key in std::mem::take(&mut self.unsettled) {
            let Some(view) = self.views.get_mut(&key) else {
                continue;
            };
            let before = match std::mem::replace(&mut view.baseline, Baseline::Current) {
                Baseline::Current => continue,
                Baseline::Released => None,
                Baseline::Older { bytes, members } => {
                    index_remove(&mut self.by_baseline, &members, &key);
                    if bytes == view.bytes {
                        continue;
                    }
                    Some(bytes)
                }
            };
            changed.push(ViewChange {
                name: key.name.clone(),
                root: key.root.clone(),
                before,
                after: view.bytes.clone(),
            });
        }
        if self.quirk(ViewQuirk::UnorderedReread) {
            reread.reverse();
        }
        Ok(Refresh {
            position,
            changed,
            reread,
            resynced,
        })
    }

    fn finite(now: f64, call: &str) -> Result<(), StoreError> {
        match now.is_finite() {
            true => Ok(()),
            false => Err(invalid(format!(
                "StoreViews: {call} needs a now that is a finite number"
            ))),
        }
    }

    /// The pass on a new snapshot, started again on `snapshot-moved` at most `VIEW_SNAPSHOTS`
    /// times in all. It applies nothing.
    fn pass(&mut self, now: f64, hold: Option<&ViewKey>) -> Result<Plan, FeedError> {
        let planned = on_snapshots(self.peer.as_ref(), VIEW_SNAPSHOTS, |snapshot| {
            self.plan(snapshot, now, hold)
        });
        if planned.is_err() && self.quirk(ViewQuirk::MovesOnFailure) {
            if let Ok(mut snapshot) = self.peer.read() {
                self.processed = Some(position_of(snapshot.as_ref()));
                snapshot.release();
            }
        }
        planned
    }

    fn plan(
        &self,
        snapshot: &dyn Snapshot,
        now: f64,
        hold: Option<&ViewKey>,
    ) -> Result<Plan, FeedError> {
        let position = position_of(snapshot);
        let mut touched = BTreeSet::new();
        let mut released = BTreeSet::new();
        let mut resynced = false;
        if let (false, Some(processed)) = (self.views.is_empty(), &self.processed) {
            let behind =
                position.history != processed.history || position.revision < processed.revision;
            resynced = behind
                || (position.revision > processed.revision
                    && matches!(
                        self.feed(
                            snapshot,
                            processed.revision,
                            position.revision,
                            &mut touched,
                            &mut released
                        )?,
                        Feed::Resync
                    ));
        }
        let mut due: BTreeSet<ViewKey> = BTreeSet::new();
        if resynced {
            if !self.quirk(ViewQuirk::MergesOnResync) {
                due.extend(self.views.keys().cloned());
                released = self.views.keys().cloned().collect();
            }
        } else {
            due.extend(touched);
            self.timed_out(now, &mut due);
            if !self.quirk(ViewQuirk::IgnoresEpoch) {
                for (name, program) in &self.programs {
                    for (epoch, roots) in &program.held {
                        if *epoch != program.spec.epoch {
                            due.extend(roots.iter().map(|root| ViewKey::new(name, root)));
                        }
                    }
                }
            }
        }
        if self.quirk(ViewQuirk::NeverRereads) {
            due.clear();
        }
        if self.quirk(ViewQuirk::RereadsEverything) {
            due.extend(self.views.keys().cloned());
        }
        let mut evict = None;
        if let Some(key) = hold {
            if !self.views.contains_key(key) {
                if self.views.len() >= self.options.max_views {
                    evict = self.by_use.first_key_value().map(|(_, k)| k.clone());
                    if let Some(gone) = &evict {
                        due.remove(gone);
                        released.remove(gone);
                    }
                }
                due.insert(key.clone());
            }
        }
        let mut reads = BTreeMap::new();
        match self.quirk(ViewQuirk::ReadsOnNewerSnapshot) && !due.is_empty() {
            true => {
                let mut newer = self.peer.read()?;
                let read = self.read_all(newer.as_ref(), &due, now);
                newer.release();
                reads = read?;
            }
            false => reads.extend(self.read_all(snapshot, &due, now)?),
        }
        Ok(Plan {
            position,
            resynced,
            reads,
            released,
            evict,
        })
    }

    /// The views whose window `[since, expires_at)` does not hold `now`: O(log + views found).
    fn timed_out(&self, now: f64, due: &mut BTreeSet<ViewKey>) {
        let below = |set: &BTreeSet<(Bound, ViewKey)>| -> Vec<ViewKey> {
            set.iter()
                .take_while(|(bound, _)| bound.0 <= now)
                .map(|(_, key)| key.clone())
                .collect()
        };
        if !self.quirk(ViewQuirk::IgnoresExpiry) {
            due.extend(below(&self.by_expiry));
        }
        if !self.quirk(ViewQuirk::IgnoresSince) {
            due.extend(
                self.by_since
                    .iter()
                    .rev()
                    .take_while(|(bound, _)| bound.0 > now)
                    .map(|(_, key)| key.clone()),
            );
        }
    }

    /// The feed over `(from, to]`, page by page, with one `get` per page that adds ids. Each
    /// page's records touch views through the indexes; each removed id releases baselines.
    fn feed(
        &self,
        snapshot: &dyn Snapshot,
        from: Revision,
        to: Revision,
        touched: &mut BTreeSet<ViewKey>,
        released: &mut BTreeSet<ViewKey>,
    ) -> Result<Feed, FeedError> {
        let mut at = from;
        while at < to {
            let (records, through) = match self.peer.changes(at, Some(to))? {
                ChangePage::ResyncRequired { .. } => return Ok(Feed::Resync),
                ChangePage::Ok { records, through } => (records, through),
            };
            // A store fault, found before the page's ids are fetched or judged.
            checked_through(at, to, through)?;
            let ids: Vec<String> = records
                .iter()
                .flat_map(|r| &r.added)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .cloned()
                .collect();
            let added: BTreeMap<String, Delta> = match ids.is_empty() {
                true => BTreeMap::new(),
                false => {
                    let held = snapshot.get(&ids)?;
                    answered_only("get", &ids, held.iter().map(|d| d.id.clone()).collect())?;
                    held.into_iter().map(|d| (d.id.clone(), d)).collect()
                }
            };
            self.judge(&records, &added, touched, released);
            at = through;
        }
        if self.quirk(ViewQuirk::FeedPerView) {
            for _ in 1..self.views.len() {
                self.peer.changes(from, Some(to))?;
            }
        }
        Ok(Feed::Read)
    }

    /// The views one page touches and the baselines it releases, through the indexes.
    fn judge(
        &self,
        records: &[ChangeRecord],
        added: &BTreeMap<String, Delta>,
        touched: &mut BTreeSet<ViewKey>,
        released: &mut BTreeSet<ViewKey>,
    ) {
        let lookup = |index: &Index, key: &str| -> Vec<ViewKey> {
            index
                .get(key)
                .map(|views| views.iter().cloned().collect())
                .unwrap_or_default()
        };
        if self.quirk(ViewQuirk::TouchingPerView) {
            for (key, view) in &self.views {
                if touching(&view.capture, records, added).is_some() {
                    touched.insert(key.clone());
                }
            }
        }
        for record in records {
            if !self.quirk(ViewQuirk::IgnoresRemoved) {
                for id in &record.removed {
                    let holding = lookup(&self.by_member, id);
                    if !self.quirk(ViewQuirk::KeepsPurgedBaseline) {
                        released.extend(
                            holding
                                .iter()
                                .filter(|key| {
                                    self.views
                                        .get(*key)
                                        .is_some_and(|v| v.baseline == Baseline::Current)
                                })
                                .cloned(),
                        );
                        released.extend(lookup(&self.by_baseline, id));
                    }
                    if !self.quirk(ViewQuirk::TouchingPerView) {
                        touched.extend(holding);
                    }
                }
            }
            if self.quirk(ViewQuirk::TouchingPerView) {
                continue;
            }
            for id in &record.added {
                let Some(delta) = added.get(id) else { continue };
                for entity in target_entities(&delta.claims) {
                    touched.extend(lookup(&self.by_anchor, entity));
                }
                if !self.quirk(ViewQuirk::IgnoresNegators) {
                    for negated in negated_ids(&delta.claims) {
                        touched.extend(lookup(&self.by_member, negated));
                    }
                }
            }
        }
    }

    /// Reads every due view on one snapshot, each with its capture.
    fn read_all(
        &self,
        snapshot: &dyn Snapshot,
        due: &BTreeSet<ViewKey>,
        now: f64,
    ) -> Result<BTreeMap<ViewKey, Fresh>, FeedError> {
        let mut reads = BTreeMap::new();
        for key in due {
            let Some(program) = self.programs.get(&key.name) else {
                continue;
            };
            let spec = &program.spec;
            let mut request = ReadRequest::new(&spec.term, &key.root, now);
            request.registry = spec.registry.as_deref();
            request.selection = Selection {
                pushdown: spec.pushdown.as_ref(),
                admits: spec.admits.as_deref().map(|f| f as _),
            };
            request.cache = self.options.cache;
            request.memo = self.options.memo;
            request.capture = true;
            let read = read_anchored(snapshot, request).map_err(|e| match e {
                crate::store_read::StoreReadError::Store(e) => FeedError::Refused(e),
                other => FeedError::Refused(invalid(format!(
                    "StoreViews: the read of {} at {} failed: {other}",
                    key.name, key.root
                ))),
            })?;
            let capture = read.capture.ok_or_else(|| {
                invalid(format!(
                    "StoreViews: the read of {} at {} carries no capture",
                    key.name, key.root
                ))
            })?;
            reads.insert(
                key.clone(),
                Fresh {
                    bytes: result_canonical_hex(&read.result),
                    capture,
                    epoch: spec.epoch.clone(),
                },
            );
        }
        Ok(reads)
    }

    /// Applies a pass: the eviction, the released baselines, the reads with their index entries,
    /// the processed position, and the use of the view a `hold` asked for.
    fn apply(&mut self, plan: Plan, hold: Option<&ViewKey>) {
        if let Some(gone) = &plan.evict {
            if self.quirk(ViewQuirk::ServesEvictedBytes) {
                if let Some(view) = self.views.get(gone) {
                    self.graveyard.insert(gone.clone(), view.bytes.clone());
                }
            }
            self.forget(gone);
        }
        for key in &plan.released {
            self.release(key);
        }
        for (key, fresh) in plan.reads {
            if let Some(program) = self.programs.get_mut(&key.name) {
                program.reads += 1;
            }
            match self.views.contains_key(&key) {
                true => self.reread(&key, fresh),
                false if Some(&key) == hold => self.insert(&key, fresh),
                false => {}
            }
        }
        self.processed = Some(plan.position);
        if let Some(key) = hold {
            self.tick += 1;
            if let Some(view) = self.views.get_mut(key) {
                self.by_use.remove(&view.used);
                view.used = self.tick;
                self.by_use.insert(self.tick, key.clone());
            }
        }
    }

    /// Releases a view's baseline: the holder keeps none of its bytes.
    fn release(&mut self, key: &ViewKey) {
        let Some(view) = self.views.get_mut(key) else {
            return;
        };
        if let Baseline::Older { members, .. } =
            std::mem::replace(&mut view.baseline, Baseline::Released)
        {
            index_remove(&mut self.by_baseline, &members, key);
        }
        self.unsettled.insert(key.clone());
    }

    fn index(&mut self, key: &ViewKey, capture: &Capture) {
        index_add(&mut self.by_anchor, entities(capture), key);
        index_add(&mut self.by_member, capture.members().to_vec(), key);
    }

    fn unindex(&mut self, key: &ViewKey, capture: &Capture) {
        index_remove(&mut self.by_anchor, &entities(capture), key);
        index_remove(&mut self.by_member, capture.members(), key);
    }

    fn time(&mut self, key: &ViewKey, capture: &Capture, add: bool) {
        let entries = [
            (&mut self.by_since, capture.since()),
            (&mut self.by_expiry, capture.expires_at()),
        ];
        for (set, bound) in entries {
            if let Some(bound) = bound {
                match add {
                    true => set.insert((Bound(bound), key.clone())),
                    false => set.remove(&(Bound(bound), key.clone())),
                };
            }
        }
    }

    fn epoch(&mut self, key: &ViewKey, epoch: &str, add: bool) {
        let Some(program) = self.programs.get_mut(&key.name) else {
            return;
        };
        match add {
            true => {
                program
                    .held
                    .entry(epoch.to_string())
                    .or_default()
                    .insert(key.root.clone());
            }
            false => {
                if let Some(roots) = program.held.get_mut(epoch) {
                    roots.remove(&key.root);
                    if roots.is_empty() {
                        program.held.remove(epoch);
                    }
                }
            }
        }
    }

    fn insert(&mut self, key: &ViewKey, fresh: Fresh) {
        let bytes = match self.graveyard.remove(key) {
            Some(old) => old,
            None => fresh.bytes,
        };
        self.index(key, &fresh.capture);
        self.time(key, &fresh.capture, true);
        self.epoch(key, &fresh.epoch, true);
        self.views.insert(
            key.clone(),
            Held {
                bytes,
                capture: fresh.capture,
                epoch: fresh.epoch,
                used: 0,
                baseline: Baseline::Current,
            },
        );
    }

    fn reread(&mut self, key: &ViewKey, fresh: Fresh) {
        let Some(view) = self.views.remove(key) else {
            return;
        };
        if !self.quirk(ViewQuirk::KeepsFirstIndex) {
            self.unindex(key, &view.capture);
            self.index(key, &fresh.capture);
        }
        if !self.quirk(ViewQuirk::StaticBoundary) {
            self.time(key, &view.capture, false);
            self.time(key, &fresh.capture, true);
        }
        self.epoch(key, &view.epoch, false);
        self.epoch(key, &fresh.epoch, true);
        let baseline = match view.baseline {
            Baseline::Current => {
                let members = view.capture.members().to_vec();
                index_add(&mut self.by_baseline, members.clone(), key);
                self.unsettled.insert(key.clone());
                Baseline::Older {
                    bytes: view.bytes,
                    members,
                }
            }
            other => other,
        };
        self.views.insert(
            key.clone(),
            Held {
                bytes: fresh.bytes,
                capture: fresh.capture,
                epoch: fresh.epoch,
                used: view.used,
                baseline,
            },
        );
    }

    /// Forgets a view and every index entry it had.
    fn forget(&mut self, key: &ViewKey) {
        let Some(view) = self.views.remove(key) else {
            return;
        };
        if !self.quirk(ViewQuirk::KeepsForgottenIndex) {
            self.unindex(key, &view.capture);
        }
        self.time(key, &view.capture, false);
        self.epoch(key, &view.epoch, false);
        self.by_use.remove(&view.used);
        if let Baseline::Older { members, .. } = &view.baseline {
            index_remove(&mut self.by_baseline, members, key);
        }
        self.unsettled.remove(key);
    }
}

/// `StoreViews` as the conformance runner drives it: terms as term JSON, one registry for every
/// program.
struct Conforming {
    views: StoreViews<'static>,
    registry: Arc<SchemaRegistry>,
}

impl ViewHolder for Conforming {
    fn register(
        &mut self,
        name: &str,
        term: &Value,
        pushdown: Option<Pushdown>,
        epoch: Option<&str>,
    ) -> Result<(), RegisterRefusal> {
        let term = parse_term(term).map_err(|e| {
            RegisterRefusal::Refused(invalid(format!("StoreViews: the term of {name}: {e}")))
        })?;
        self.views.register(
            name,
            ViewProgram {
                term,
                registry: Some(self.registry.clone()),
                pushdown,
                admits: None,
                epoch: epoch.unwrap_or_default().to_string(),
            },
        )
    }

    fn set_epoch(&mut self, name: &str, epoch: &str) -> Result<(), StoreError> {
        self.views.set_epoch(name, epoch)
    }

    fn hold(&mut self, name: &str, root: &str, now: f64) -> Result<ViewRead, FeedError> {
        self.views.hold(name, root, now)
    }

    fn refresh(&mut self, now: f64) -> Result<Refresh, FeedError> {
        self.views.refresh(now)
    }

    fn drop_view(&mut self, name: &str, root: &str) -> Result<(), StoreError> {
        self.views.drop_view(name, root)
    }

    fn next_boundary(&self) -> Option<f64> {
        self.views.next_boundary()
    }
}
/// This witness's holder, as the conformance runner makes it (`vectors/store/README.md` §11):
/// `StoreViews` over the runner's logged handle, with one registry built from the document's
/// `schemas`.
#[derive(Debug, Clone, Copy, Default)]
pub struct StoreViewsReader {
    /// `None` for the right holder; a rule broken for the rails.
    #[doc(hidden)]
    pub quirk: Option<ViewQuirk>,
}

impl ViewsReader for StoreViewsReader {
    fn holder(
        &self,
        peer: Box<dyn PeerStore>,
        max_views: Option<u64>,
        schemas: &Value,
    ) -> Result<Box<dyn ViewHolder>, String> {
        let schemas = schemas
            .as_array()
            .ok_or("the document's schemas is not a list")?
            .iter()
            .map(|s| {
                Ok(HyperSchema {
                    name: s["name"]
                        .as_str()
                        .ok_or("a schema has no name")?
                        .to_string(),
                    alg: s["alg"].as_u64().ok_or("a schema has no alg")? as u32,
                    body: parse_term(&s["body"])?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let registry = Arc::new(SchemaRegistry::build(schemas, vec![])?);
        let max_views = match max_views {
            None => DEFAULT_MAX_VIEWS,
            Some(n) => usize::try_from(n).map_err(|_| "maxViews does not fit".to_string())?,
        };
        let options = StoreViewsOptions {
            max_views,
            ..StoreViewsOptions::default()
        };
        let views = StoreViews::with_quirk(peer, options, self.quirk)
            .map_err(|e| format!("the holder was refused: {e}"))?;
        Ok(Box::new(Conforming { views, registry }))
    }
}
