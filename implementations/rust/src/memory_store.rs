//! The memory reference store (SPEC-18 proposal §5.1, slice 1). Claims are kept once per id and
//! counted by holdings; membership, signatures, arrival records and both indexes are per peer.
//! Every map is read through one counting door (`Index`), so a test can show that no core
//! operation walks a whole map (SPEC-18 §4.11 reading 17). Only the exporter scans.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use crate::delta::compute_id;
use crate::store::{
    negated_ids, signature_form, target_entities, Admission, Anchor, AppendResult, ArrivalRecord,
    AtRest, ChangeRetention, ErasureClaim, ErasureClass, ErasurePosture, Exporter, Listing,
    PeerErasure, PeerExporter, PeerStore, PurgeOutcome, PurgeReport, PurgeSurface, PurgeTarget,
    Pushdown, PushdownFields, Revision, ScopeRequest, ScopeResult, Snapshot, Store,
    StoreCapabilities, StoreError, StoreErrorCode, StoreProfile, StoreWriters, SurfaceState,
    VerifiedDelta, MAX_ARRIVAL_COUNTER, PURGE_BOUNDARY,
};
use crate::types::{Claims, Delta};

/// The format version that names a memory reference store to the conformance runner.
pub const MEMORY_STORE_FORMAT: &str = "rhizomatic.store.memory/1";

/// Index work since the last reset. `lookups` are keyed reads and writes of one map entry,
/// `visited` are members read out of an index entry or a scan, `scans` are whole-map walks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StoreMeter {
    pub lookups: u64,
    pub visited: u64,
    pub scans: u64,
}

/// The counting door. Nothing in this module touches a map except through these methods.
#[derive(Debug)]
struct Index<V> {
    map: BTreeMap<String, V>,
}

impl<V> Index<V> {
    fn new() -> Self {
        Self {
            map: BTreeMap::new(),
        }
    }

    fn get(&self, meter: &mut StoreMeter, key: &str) -> Option<&V> {
        meter.lookups += 1;
        self.map.get(key)
    }

    fn get_mut(&mut self, meter: &mut StoreMeter, key: &str) -> Option<&mut V> {
        meter.lookups += 1;
        self.map.get_mut(key)
    }

    fn contains(&self, meter: &mut StoreMeter, key: &str) -> bool {
        meter.lookups += 1;
        self.map.contains_key(key)
    }

    fn insert(&mut self, meter: &mut StoreMeter, key: String, value: V) {
        meter.lookups += 1;
        self.map.insert(key, value);
    }

    fn remove(&mut self, meter: &mut StoreMeter, key: &str) -> Option<V> {
        meter.lookups += 1;
        self.map.remove(key)
    }

    /// The entry count. Maps keep it, so it is not index work.
    fn len(&self) -> usize {
        self.map.len()
    }

    /// A whole-map walk. Only the exporter may call this.
    fn scan(&self, meter: &mut StoreMeter) -> impl Iterator<Item = (&String, &V)> {
        meter.scans += 1;
        meter.visited += self.map.len() as u64;
        self.map.iter()
    }
}

impl Index<BTreeSet<String>> {
    fn add_member(&mut self, meter: &mut StoreMeter, key: &str, member: &str) {
        meter.lookups += 1;
        self.map
            .entry(key.to_string())
            .or_default()
            .insert(member.to_string());
    }

    /// Removes one member, and the entry with it when the entry becomes empty.
    fn remove_member(&mut self, meter: &mut StoreMeter, key: &str, member: &str) {
        meter.lookups += 1;
        if let Some(members) = self.map.get_mut(key) {
            members.remove(member);
            if members.is_empty() {
                self.map.remove(key);
            }
        }
    }

    fn members(&self, meter: &mut StoreMeter, key: &str) -> Vec<String> {
        meter.lookups += 1;
        let members: Vec<String> = self
            .map
            .get(key)
            .map(|ids| ids.iter().cloned().collect())
            .unwrap_or_default();
        meter.visited += members.len() as u64;
        members
    }
}

/// The claims of one id, stored once, and how many peers hold it.
#[derive(Debug)]
struct Stored {
    claims: Claims,
    holders: usize,
}

/// One peer's holding of an id: the signature it admitted and its arrival record.
#[derive(Debug)]
struct Holding {
    sig: Option<String>,
    arrival: ArrivalRecord,
}

#[derive(Debug)]
struct PeerState {
    posture: ErasurePosture,
    head: Option<String>,
    revision: u64,
    /// The largest arrival sequence this peer ever committed. A purge does not lower it.
    last_sequence: u64,
    holdings: Index<Holding>,
    targets: Index<BTreeSet<String>>,
    negators: Index<BTreeSet<String>>,
    /// Ids this peer purged while another peer still held the bytes.
    debts: Index<()>,
}

#[derive(Debug)]
struct State {
    closed: bool,
    /// The pushdown fields this store applies. It ignores the others and reports so.
    pushdown: PushdownFields,
    meter: StoreMeter,
    stored: Index<Stored>,
    peers: Index<PeerState>,
}

fn refuse<T>(code: StoreErrorCode, message: impl Into<String>) -> Result<T, StoreError> {
    Err(StoreError::new(code, message))
}

fn distinct(keys: &[String]) -> BTreeSet<&str> {
    keys.iter().map(String::as_str).collect()
}

impl State {
    fn open(&self) -> Result<(), StoreError> {
        if self.closed {
            return refuse(StoreErrorCode::StoreClosed, "the store is closed");
        }
        Ok(())
    }

    fn append(&mut self, peer_id: &str, batch: &Admission) -> Result<AppendResult, StoreError> {
        self.open()?;
        if batch.next_head.is_empty() {
            return refuse(
                StoreErrorCode::InvalidAdmission,
                "the next head must not be empty",
            );
        }
        if batch.frame.is_some() {
            return refuse(
                StoreErrorCode::CapabilityAbsent,
                "this store has no journal, so it takes no frame",
            );
        }
        let State {
            meter,
            stored,
            peers,
            ..
        } = self;
        let Some(peer) = peers.get_mut(meter, peer_id) else {
            return refuse(StoreErrorCode::PeerAbsent, "no such peer");
        };
        if peer.head != batch.expected_head {
            return Ok(AppendResult::Conflict);
        }

        // Plan the whole batch before anything changes: a refusal commits nothing.
        let mut fresh: BTreeMap<&str, &VerifiedDelta> = BTreeMap::new();
        let mut sequences = BTreeSet::new();
        for entry in &batch.added {
            let VerifiedDelta { delta, arrival } = entry;
            if compute_id(&delta.claims).ok().as_deref() != Some(delta.id.as_str()) {
                return refuse(
                    StoreErrorCode::InvalidAdmission,
                    format!("delta id {} does not recompute from its claims", delta.id),
                );
            }
            if arrival.id != delta.id {
                return refuse(
                    StoreErrorCode::InvalidAdmission,
                    format!("an arrival record does not name its delta {}", delta.id),
                );
            }
            if delta.sig.as_deref().is_some_and(|sig| !signature_form(sig)) {
                return refuse(
                    StoreErrorCode::InvalidAdmission,
                    format!(
                        "the signature of {} is not 128 lowercase hex characters",
                        delta.id
                    ),
                );
            }
            let counters = [arrival.sequence, arrival.transfer];
            if counters
                .iter()
                .any(|n| !(1..=MAX_ARRIVAL_COUNTER).contains(n))
                || !arrival.at.is_finite()
                || arrival.sender.is_empty()
            {
                return refuse(
                    StoreErrorCode::InvalidAdmission,
                    format!("the arrival record of {} is malformed", delta.id),
                );
            }
            if fresh.contains_key(delta.id.as_str()) || peer.holdings.contains(meter, &delta.id) {
                continue;
            }
            if arrival.sequence <= peer.last_sequence || !sequences.insert(arrival.sequence) {
                return refuse(
                    StoreErrorCode::InvalidAdmission,
                    format!(
                        "arrival sequence {} of {} is not new for this peer",
                        arrival.sequence, delta.id
                    ),
                );
            }
            fresh.insert(delta.id.as_str(), entry);
        }

        for (id, entry) in &fresh {
            let delta = &entry.delta;
            match stored.get_mut(meter, id) {
                Some(kept) => kept.holders += 1,
                None => stored.insert(
                    meter,
                    delta.id.clone(),
                    Stored {
                        claims: delta.claims.clone(),
                        holders: 1,
                    },
                ),
            }
            peer.holdings.insert(
                meter,
                delta.id.clone(),
                Holding {
                    sig: delta.sig.clone(),
                    arrival: entry.arrival.clone(),
                },
            );
            for entity in target_entities(&delta.claims) {
                peer.targets.add_member(meter, entity, id);
            }
            for negated in negated_ids(&delta.claims) {
                peer.negators.add_member(meter, negated, id);
            }
            peer.debts.remove(meter, id);
        }
        if let Some(last) = sequences.last() {
            peer.last_sequence = *last;
        }
        let head_moved = peer.head.as_deref() != Some(batch.next_head.as_str());
        if head_moved {
            peer.head = Some(batch.next_head.clone());
        }
        if head_moved || !fresh.is_empty() {
            peer.revision += 1;
        }
        Ok(AppendResult::Committed {
            revision: Revision(peer.revision),
            added: fresh.keys().map(|id| id.to_string()).collect(),
        })
    }

    fn purge(&mut self, peer_id: &str, ids: &[String]) -> Result<PurgeReport, StoreError> {
        self.open()?;
        let State {
            meter,
            stored,
            peers,
            ..
        } = self;
        let Some(peer) = peers.get_mut(meter, peer_id) else {
            return refuse(StoreErrorCode::PeerAbsent, "no such peer");
        };
        let mut targets = Vec::new();
        let mut released = false;
        for id in distinct(ids) {
            let outcome = if peer.holdings.remove(meter, id).is_some() {
                released = true;
                // The stored claims name the index entries this delta made for the peer.
                let last_holder = match stored.get_mut(meter, id) {
                    Some(kept) => {
                        for entity in target_entities(&kept.claims) {
                            peer.targets.remove_member(meter, entity, id);
                        }
                        for negated in negated_ids(&kept.claims) {
                            peer.negators.remove_member(meter, negated, id);
                        }
                        kept.holders -= 1;
                        kept.holders == 0
                    }
                    None => true,
                };
                if last_holder {
                    stored.remove(meter, id);
                    PurgeOutcome::Removed
                } else {
                    peer.debts.insert(meter, id.to_string(), ());
                    PurgeOutcome::HeldByOtherPeer
                }
            } else if !peer.debts.contains(meter, id) {
                PurgeOutcome::NotHeld
            } else if stored.contains(meter, id) {
                PurgeOutcome::HeldByOtherPeer
            } else {
                peer.debts.remove(meter, id);
                PurgeOutcome::Removed
            };
            targets.push(PurgeTarget {
                id: id.to_string(),
                outcome,
            });
        }
        if released {
            peer.revision += 1;
        }
        let removed = targets.iter().any(|t| t.outcome == PurgeOutcome::Removed);
        let surface = |surface: &str, state| PurgeSurface {
            surface: surface.to_string(),
            state,
        };
        Ok(PurgeReport {
            // The claim covers only removed targets. Process memory cannot prove absence, so
            // this store never says `proven`.
            claim: if removed {
                ErasureClaim::Unproven
            } else {
                ErasureClaim::NothingRemoved
            },
            boundary: PURGE_BOUNDARY.to_string(),
            revision: Revision(peer.revision),
            targets,
            // A target another peer still holds is told by its outcome, not by a surface.
            surfaces: vec![
                surface("rows", SurfaceState::Absent),
                surface("index-entries", SurfaceState::Absent),
                surface("process-memory", SurfaceState::Unprovable),
            ],
        })
    }

    /// One held delta as this peer admitted it, with its arrival record.
    fn held(
        meter: &mut StoreMeter,
        stored: &Index<Stored>,
        peer: &PeerState,
        id: &str,
    ) -> Option<VerifiedDelta> {
        let holding = peer.holdings.get(meter, id)?;
        let kept = stored.get(meter, id)?;
        Some(VerifiedDelta {
            delta: Delta {
                id: id.to_string(),
                claims: kept.claims.clone(),
                sig: holding.sig.clone(),
            },
            arrival: holding.arrival.clone(),
        })
    }

    fn scope(view: SnapshotView<'_>, request: &ScopeRequest) -> ScopeResult {
        let SnapshotView {
            meter,
            stored,
            peer,
            offers,
        } = view;
        // Keep only the requested fields this store applies. The host applies the rest.
        let asked = request.pushdown.clone().unwrap_or_default();
        let pushdown = Pushdown {
            timestamp_at_most: asked.timestamp_at_most.filter(|_| offers.timestamp_at_most),
            arrival_at_most: asked.arrival_at_most.filter(|_| offers.arrival_at_most),
            exclude_ids: asked.exclude_ids.filter(|_| offers.exclude_ids),
        };
        let dropped: BTreeSet<&str> = pushdown
            .exclude_ids
            .iter()
            .flatten()
            .map(String::as_str)
            .collect();
        let mut members: BTreeMap<String, VerifiedDelta> = BTreeMap::new();
        let mut pending: Vec<String> = Vec::new();
        let mut consider = |meter: &mut StoreMeter, id: String, pending: &mut Vec<String>| {
            if members.contains_key(&id) || dropped.contains(id.as_str()) {
                return;
            }
            let Some(member) = Self::held(meter, stored, peer, &id) else {
                return;
            };
            if pushdown
                .arrival_at_most
                .is_some_and(|n| member.arrival.sequence > n)
                || pushdown
                    .timestamp_at_most
                    .is_some_and(|t| member.delta.claims.timestamp > t)
            {
                return;
            }
            members.insert(id.clone(), member);
            pending.push(id);
        };
        let entities: BTreeSet<&str> = request
            .anchors
            .iter()
            .map(|anchor| match anchor {
                Anchor::Entity { entity } => entity.as_str(),
            })
            .collect();
        for entity in entities {
            for id in peer.targets.members(meter, entity) {
                consider(meter, id, &mut pending);
            }
        }
        while let Some(id) = pending.pop() {
            for negator in peer.negators.members(meter, &id) {
                consider(meter, negator, &mut pending);
            }
        }
        // `exclude` only leaves ids out of the answer; the chains above ran through them.
        for id in &request.exclude {
            members.remove(id);
        }
        ScopeResult {
            deltas: members.into_values().collect(),
            applied: PushdownFields {
                timestamp_at_most: pushdown.timestamp_at_most.is_some(),
                arrival_at_most: pushdown.arrival_at_most.is_some(),
                exclude_ids: pushdown.exclude_ids.is_some(),
            },
        }
    }
}

/// What a snapshot query may read: the shared claims and one peer.
struct SnapshotView<'a> {
    meter: &'a mut StoreMeter,
    stored: &'a Index<Stored>,
    peer: &'a PeerState,
    offers: PushdownFields,
}

type Shared = Arc<Mutex<State>>;

fn with<R>(state: &Shared, f: impl FnOnce(&mut State) -> R) -> R {
    // Every mutation plans first and then commits without a fallible step, so a poisoned lock
    // still guards a consistent state.
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    f(&mut guard)
}

/// The memory reference store. Handles share one state; each open store is its own state.
#[derive(Debug, Clone)]
pub struct MemoryStore {
    state: Shared,
    profile: StoreProfile,
}

/// The profile slice 1 implements: entity anchors, arrival records, every pushdown field, and
/// erasure class `unprovable`. Nothing it would have to scan for.
pub fn memory_store_profile() -> StoreProfile {
    StoreProfile {
        capabilities: StoreCapabilities {
            values: false,
            arrival: true,
            journal: false,
            views: false,
            derived_indexes: false,
            digest: false,
            erasure: ErasureClass::Unprovable,
        },
        indexed_value_roles: Vec::new(),
        pushdown: PushdownFields {
            timestamp_at_most: true,
            arrival_at_most: true,
            exclude_ids: true,
        },
        writers: StoreWriters::OneProcess,
        at_rest: AtRest::Trusted,
        change_retention: ChangeRetention::None,
        format_version: MEMORY_STORE_FORMAT.to_string(),
    }
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStore {
    /// A new, empty store that applies every pushdown field.
    pub fn new() -> Self {
        Self::with_pushdown(memory_store_profile().pushdown)
    }

    /// A new, empty store that applies only these pushdown fields. It ignores the others and
    /// reports so, as a store without the matching index would.
    pub fn with_pushdown(pushdown: PushdownFields) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                closed: false,
                pushdown,
                meter: StoreMeter::default(),
                stored: Index::new(),
                peers: Index::new(),
            })),
            profile: StoreProfile {
                pushdown,
                ..memory_store_profile()
            },
        }
    }

    /// The index work done since the last reset.
    pub fn meter(&self) -> StoreMeter {
        with(&self.state, |state| state.meter)
    }

    pub fn reset_meter(&self) {
        with(&self.state, |state| state.meter = StoreMeter::default());
    }

    fn handle(&self, id: &str, posture: ErasurePosture) -> Box<dyn PeerStore> {
        Box::new(MemoryPeer {
            state: self.state.clone(),
            id: id.to_string(),
            erasure: PeerErasure {
                posture,
                store_class: self.profile.capabilities.erasure,
            },
        })
    }
}

impl Store for MemoryStore {
    fn profile(&self) -> &StoreProfile {
        &self.profile
    }

    fn create_peer(
        &self,
        id: &str,
        erasure: ErasurePosture,
    ) -> Result<Box<dyn PeerStore>, StoreError> {
        with(&self.state, |state| {
            state.open()?;
            if id.is_empty() {
                return refuse(
                    StoreErrorCode::InvalidRequest,
                    "a peer id must not be empty",
                );
            }
            if erasure == ErasurePosture::Proven
                && self.profile.capabilities.erasure != ErasureClass::Proven
            {
                return refuse(
                    StoreErrorCode::PostureRefused,
                    "this store cannot prove erasure, so it takes no peer that promises it",
                );
            }
            if state.peers.contains(&mut state.meter, id) {
                return refuse(StoreErrorCode::PeerExists, "the peer id is taken");
            }
            state.peers.insert(
                &mut state.meter,
                id.to_string(),
                PeerState {
                    posture: erasure,
                    head: None,
                    revision: 0,
                    last_sequence: 0,
                    holdings: Index::new(),
                    targets: Index::new(),
                    negators: Index::new(),
                    debts: Index::new(),
                },
            );
            Ok(())
        })?;
        Ok(self.handle(id, erasure))
    }

    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        let posture = with(&self.state, |state| {
            state.open()?;
            match state.peers.get(&mut state.meter, id) {
                Some(peer) => Ok(peer.posture),
                None => refuse(StoreErrorCode::PeerAbsent, "no such peer"),
            }
        })?;
        Ok(self.handle(id, posture))
    }

    fn open_admin(&self) -> Box<dyn Exporter> {
        Box::new(MemoryExporter {
            state: self.state.clone(),
        })
    }

    fn close(&self) {
        with(&self.state, |state| state.closed = true);
    }
}

struct MemoryPeer {
    state: Shared,
    id: String,
    erasure: PeerErasure,
}

impl PeerStore for MemoryPeer {
    fn id(&self) -> &str {
        &self.id
    }

    fn erasure(&self) -> PeerErasure {
        self.erasure
    }

    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        with(&self.state, |state| {
            state.open()?;
            let Some(peer) = state.peers.get(&mut state.meter, &self.id) else {
                return refuse(StoreErrorCode::PeerAbsent, "no such peer");
            };
            Ok(Box::new(MemorySnapshot {
                state: self.state.clone(),
                peer: self.id.clone(),
                revision: peer.revision,
                head: peer.head.clone(),
                count: peer.holdings.len() as u64,
                released: false,
            }) as Box<dyn Snapshot>)
        })
    }

    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        with(&self.state, |state| state.append(&self.id, batch))
    }

    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        with(&self.state, |state| state.purge(&self.id, ids))
    }
}

struct MemorySnapshot {
    state: Shared,
    peer: String,
    revision: u64,
    head: Option<String>,
    count: u64,
    released: bool,
}

impl MemorySnapshot {
    /// Runs one query against the peer, unless the snapshot is released or the peer has moved.
    /// This store keeps no old revisions, so a moved snapshot refuses.
    fn query<R>(&self, f: impl FnOnce(SnapshotView<'_>) -> R) -> Result<R, StoreError> {
        if self.released {
            return refuse(
                StoreErrorCode::SnapshotReleased,
                "the snapshot was released",
            );
        }
        with(&self.state, |state| {
            state.open()?;
            let State {
                meter,
                stored,
                peers,
                pushdown,
                ..
            } = state;
            let Some(peer) = peers.get(meter, &self.peer) else {
                return refuse(StoreErrorCode::PeerAbsent, "no such peer");
            };
            if peer.revision != self.revision {
                return refuse(
                    StoreErrorCode::SnapshotMoved,
                    "the peer has moved past this snapshot; read a new one",
                );
            }
            Ok(f(SnapshotView {
                meter,
                stored,
                peer,
                offers: *pushdown,
            }))
        })
    }
}

impl Snapshot for MemorySnapshot {
    fn revision(&self) -> Revision {
        Revision(self.revision)
    }

    fn head(&self) -> Option<&str> {
        self.head.as_deref()
    }

    fn count(&self) -> u64 {
        self.count
    }

    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreError> {
        self.query(|view| {
            distinct(ids)
                .into_iter()
                .filter_map(|id| State::held(view.meter, view.stored, view.peer, id))
                .map(|member| member.delta)
                .collect()
        })
    }

    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        self.query(|view| {
            distinct(ids)
                .into_iter()
                .filter_map(|id| view.peer.holdings.get(view.meter, id))
                .map(|holding| holding.arrival.clone())
                .collect()
        })
    }

    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreError> {
        self.query(|view| {
            let mut ids = BTreeSet::new();
            for entity in distinct(entities) {
                ids.extend(view.peer.targets.members(view.meter, entity));
            }
            ids.into_iter().collect()
        })
    }

    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        self.query(|view| {
            let mut negators = BTreeSet::new();
            for id in distinct(ids) {
                negators.extend(view.peer.negators.members(view.meter, id));
            }
            negators.into_iter().collect()
        })
    }

    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        let pushdown = request.pushdown.as_ref();
        if pushdown
            .and_then(|p| p.timestamp_at_most)
            .is_some_and(|t| !t.is_finite())
        {
            return refuse(
                StoreErrorCode::InvalidRequest,
                "timestampAtMost must be a finite number",
            );
        }
        if pushdown
            .and_then(|p| p.arrival_at_most)
            .is_some_and(|n| n > MAX_ARRIVAL_COUNTER)
        {
            return refuse(
                StoreErrorCode::InvalidRequest,
                "arrivalAtMost must be an integer from 0 to 2^53 - 1",
            );
        }
        self.query(|view| State::scope(view, request))
    }

    fn release(&mut self) {
        self.released = true;
    }
}

struct MemoryExporter {
    state: Shared,
}

fn listing<'a, T: 'a>(items: Result<Vec<T>, StoreError>) -> Listing<'a, T> {
    match items {
        Ok(items) => Box::new(items.into_iter().map(Ok)),
        Err(refusal) => Box::new(std::iter::once(Err(refusal))),
    }
}

impl Exporter for MemoryExporter {
    fn peers(&self) -> Listing<'_, String> {
        listing(with(&self.state, |state| {
            state.open()?;
            Ok(state
                .peers
                .scan(&mut state.meter)
                .map(|(id, _)| id.clone())
                .collect())
        }))
    }

    fn peer(&self, id: &str) -> Result<Box<dyn PeerExporter>, StoreError> {
        with(&self.state, |state| {
            state.open()?;
            if !state.peers.contains(&mut state.meter, id) {
                return refuse(StoreErrorCode::PeerAbsent, "no such peer");
            }
            Ok(Box::new(MemoryPeerExporter {
                state: self.state.clone(),
                peer: id.to_string(),
            }) as Box<dyn PeerExporter>)
        })
    }

    fn stored_ids(&self) -> Listing<'_, String> {
        listing(with(&self.state, |state| {
            state.open()?;
            Ok(state
                .stored
                .scan(&mut state.meter)
                .map(|(id, _)| id.clone())
                .collect())
        }))
    }
}

struct MemoryPeerExporter {
    state: Shared,
    peer: String,
}

impl MemoryPeerExporter {
    fn members(&self) -> Result<Vec<Delta>, StoreError> {
        with(&self.state, |state| {
            state.open()?;
            let State {
                meter,
                stored,
                peers,
                ..
            } = state;
            let Some(peer) = peers.get(meter, &self.peer) else {
                return refuse(StoreErrorCode::PeerAbsent, "no such peer");
            };
            let held: Vec<(String, Option<String>)> = peer
                .holdings
                .scan(meter)
                .map(|(id, holding)| (id.clone(), holding.sig.clone()))
                .collect();
            Ok(held
                .into_iter()
                .filter_map(|(id, sig)| {
                    let claims = stored.get(meter, &id)?.claims.clone();
                    Some(Delta { id, claims, sig })
                })
                .collect())
        })
    }
}

impl PeerExporter for MemoryPeerExporter {
    fn ids(&self) -> Listing<'_, String> {
        listing(
            self.members()
                .map(|deltas| deltas.into_iter().map(|delta| delta.id).collect()),
        )
    }

    fn deltas(&self) -> Listing<'_, Delta> {
        listing(self.members())
    }
}
