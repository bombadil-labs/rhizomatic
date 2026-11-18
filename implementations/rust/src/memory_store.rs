//! The memory reference store (SPEC-18 proposal §5.1, slice 1). Claims are kept once per id, with
//! the peers that hold them; membership, signatures, arrival records and both indexes are per
//! peer.
//! Every map is read through one counting door (`Index`), so a test can show that no core
//! operation walks a whole map (SPEC-18 §4.11 reading 17). Only the exporter scans.
//!
//! Each peer also keeps its change feed (SPEC-18 §4.6, §4.13): one record per revision advance,
//! written inside the commit. Revisions advance by one and each advance writes one record, so the
//! record after `from` sits at a fixed offset from the oldest kept record. A bounded retention
//! drops the oldest record from the front in O(1).
//!
//! Each peer has a history (SPEC-18 §4.6, "History"), minted when it is created. The default is
//! `memory:local:<n>` from one counter for the module: unique within the process and marked as
//! local to it. A host that keeps captures across processes passes a mint of its own.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};

use crate::delta::compute_id;
use crate::store::{
    negated_ids, signature_form, target_entities, Admission, Anchor, AppendResult, ArrivalRecord,
    AtRest, ChangePage, ChangeRecord, ChangeRetention, CreatePeerOptions, ErasureClaim,
    ErasureClass, ErasurePosture, Exporter, FsckChecked, FsckReport, IntegrityFault,
    IntegrityFaultKind, Listing, PeerErasure, PeerExporter, PeerStore, PurgeOutcome, PurgeReport,
    PurgeSurface, PurgeTarget, Pushdown, PushdownFields, Retained, RetainedSurface, Revision,
    ScopeRequest, ScopeResult, Snapshot, Store, StoreCapabilities, StoreError, StoreErrorCode,
    StoreFailure, StoreProfile, StoreWriters, SurfaceState, VerifiedDelta, APP_FORMAT_MAX_BYTES,
    LOCAL_HISTORY_PREFIX, MAX_ARRIVAL_COUNTER, MAX_REVISION, PURGE_BOUNDARY,
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

/// The claims of one id, stored once, and the peers the row counts as its holders, each with how
/// many times it counts them. On an undamaged store these are the peers that hold the id, each
/// counted once. A purge reads from them whether another peer still holds the id, as the SQLite
/// store reads its `holding` table (§4.13 reading 136).
#[derive(Debug)]
struct Stored {
    claims: Claims,
    holders: BTreeMap<String, usize>,
}

/// One peer's holding of an id: the signature it admitted and its arrival record.
#[derive(Debug)]
struct Holding {
    sig: Option<String>,
    arrival: ArrivalRecord,
}

/// One peer's change feed. The record at index i has revision `floor + 1 + i`: every revision
/// advance writes one record and revisions advance by one, so `from` is found by arithmetic and
/// never by walking the feed.
#[derive(Debug, Default)]
struct Feed {
    records: VecDeque<ChangeRecord>,
    /// The revision just before the oldest kept record: the peer's first revision until a record
    /// is dropped, then the revision of the newest dropped record.
    floor: u64,
}

impl Feed {
    /// Writes one record and drops the oldest past `keep`. Each drop is one pop from the front.
    fn write(&mut self, record: ChangeRecord, keep: ChangeRetention) {
        self.records.push_back(record);
        if let ChangeRetention::Revisions(n) = keep {
            while self.records.len() as u64 > n {
                if let Some(dropped) = self.records.pop_front() {
                    self.floor = dropped.revision.0;
                }
            }
        }
    }
}

#[derive(Debug)]
struct PeerState {
    posture: ErasurePosture,
    /// Minted at creation and never changed: this store neither deletes nor restores a peer.
    history: String,
    /// Given at creation and never changed (§4.13 reading 134).
    app_format: Option<String>,
    head: Option<String>,
    revision: u64,
    /// The largest arrival sequence this peer ever committed. A purge does not lower it.
    last_sequence: u64,
    /// The highest transfer ordinal of a committed new holding, 0 before the first. A head-only
    /// append and a purge keep it (§4.13 reading 135).
    last_transfer: u64,
    /// The revision of the last purge that released a holding of this peer, 0 before one. A
    /// snapshot read before it refuses every call (§4.13 reading 130).
    removed_at: u64,
    holdings: Index<Holding>,
    targets: Index<BTreeSet<String>>,
    negators: Index<BTreeSet<String>>,
    /// Ids this peer purged while another peer still held the bytes.
    debts: Index<()>,
    feed: Feed,
}

#[derive(Debug)]
struct State {
    closed: bool,
    /// The pushdown fields this store applies. It ignores the others and reports so.
    pushdown: PushdownFields,
    /// How many change records each peer keeps, and how many records one page may hold.
    retention: ChangeRetention,
    page_size: Option<u64>,
    meter: StoreMeter,
    stored: Index<Stored>,
    peers: Index<PeerState>,
    /// How many peers owe each id: a purge report names `purge-debt` from it (§4.13 reading
    /// 108), without a walk of the peers.
    debtors: Index<u64>,
    mint: Option<HistoryMint>,
    /// Every history this store has issued, kept after its peer is gone: none is issued twice.
    issued: BTreeSet<String>,
}

/// A host's mint of histories unique across processes (SPEC-18 §4.13 reading 38). It takes the
/// peer's id and runs when the peer is created, after every other check of `create_peer`, with
/// the store's lock held, so it must not call the store.
#[derive(Clone)]
pub struct HistoryMint(Arc<dyn Fn(&str) -> String + Send + Sync>);

impl HistoryMint {
    pub fn new(mint: impl Fn(&str) -> String + Send + Sync + 'static) -> Self {
        Self(Arc::new(mint))
    }
}

impl fmt::Debug for HistoryMint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HistoryMint")
    }
}

/// The one counter of process-local histories. Two peers, two stores, or one name created twice
/// never share a value in this process.
static LOCAL_HISTORIES: Mutex<u64> = Mutex::new(0);

fn local_history() -> String {
    let mut next = match LOCAL_HISTORIES.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    *next += 1;
    format!("{LOCAL_HISTORY_PREFIX}{}", *next)
}

/// One peer fewer owes `id`.
fn settle(debtors: &mut Index<u64>, meter: &mut StoreMeter, id: &str) {
    match debtors.get(meter, id).copied() {
        Some(owing) if owing > 1 => debtors.insert(meter, id.to_string(), owing - 1),
        _ => {
            debtors.remove(meter, id);
        }
    }
}

fn refuse<T>(code: StoreErrorCode, message: impl Into<String>) -> Result<T, StoreError> {
    Err(StoreError::new(code, message))
}

/// A held id whose stored claims are gone (§4.13 reading 136). A read that meets it answers
/// nothing, so the lost row is not hidden.
fn lost(peer: &str, id: &str) -> IntegrityFault {
    IntegrityFault {
        kind: IntegrityFaultKind::ClaimsUnreadable,
        peer: Some(peer.to_string()),
        id: Some(id.to_string()),
        key: None,
        detail: "memory store: a held delta has no stored claims".to_string(),
    }
}

/// A held row that does not count this peer exactly once as a holder (§4.13 reading 136). The
/// row is not the peers that hold the id, so the purge refuses before it removes anything. `fsck`
/// reports the same row with no peer.
fn uncounted(peer: &str, id: &str, counted: usize) -> IntegrityFault {
    IntegrityFault {
        kind: IntegrityFaultKind::CountMismatch,
        peer: Some(peer.to_string()),
        id: Some(id.to_string()),
        key: Some("holders".to_string()),
        detail: format!(
            "memory store: the row counts this peer {counted} times as a holder and this peer holds it"
        ),
    }
}

/// Change records that do not run from the floor to the revision (§4.13 readings 136, 137).
fn gap(peer: &str, feed: &Feed, revision: u64) -> IntegrityFault {
    IntegrityFault {
        kind: IntegrityFaultKind::FeedGap,
        peer: Some(peer.to_string()),
        id: None,
        key: None,
        detail: format!(
            "memory store: the peer keeps {} change records at floor {} and revision {revision}",
            feed.records.len(),
            feed.floor
        ),
    }
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
            debtors,
            retention,
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
            if arrival.transfer <= peer.last_transfer {
                return refuse(
                    StoreErrorCode::InvalidAdmission,
                    format!(
                        "transfer ordinal {} of {} does not pass the peer's last transfer",
                        arrival.transfer, delta.id
                    ),
                );
            }
            fresh.insert(delta.id.as_str(), entry);
        }

        for (id, entry) in &fresh {
            let delta = &entry.delta;
            match stored.get_mut(meter, id) {
                Some(kept) => *kept.holders.entry(peer_id.to_string()).or_default() += 1,
                None => stored.insert(
                    meter,
                    delta.id.clone(),
                    Stored {
                        claims: delta.claims.clone(),
                        holders: BTreeMap::from([(peer_id.to_string(), 1)]),
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
            if peer.debts.remove(meter, id).is_some() {
                settle(debtors, meter, id);
            }
        }
        if let Some(last) = sequences.last() {
            peer.last_sequence = *last;
        }
        if let Some(last) = fresh.values().map(|entry| entry.arrival.transfer).max() {
            peer.last_transfer = last;
        }
        let head_moved = peer.head.as_deref() != Some(batch.next_head.as_str());
        if head_moved {
            peer.head = Some(batch.next_head.clone());
        }
        if head_moved || !fresh.is_empty() {
            peer.revision += 1;
            // The record is part of the commit: it is written with the holdings and the head.
            peer.feed.write(
                ChangeRecord {
                    revision: Revision(peer.revision),
                    head: peer.head.clone(),
                    added: fresh.keys().map(|id| id.to_string()).collect(),
                    removed: Vec::new(),
                },
                *retention,
            );
        }
        Ok(AppendResult::Committed {
            revision: Revision(peer.revision),
            added: fresh.keys().map(|id| id.to_string()).collect(),
        })
    }

    fn purge(&mut self, peer_id: &str, ids: &[String]) -> Result<PurgeReport, StoreFailure> {
        self.open().map_err(StoreFailure::Refused)?;
        let State {
            meter,
            stored,
            peers,
            debtors,
            retention,
            ..
        } = self;
        let Some(peer) = peers.get_mut(meter, peer_id) else {
            return refuse(StoreErrorCode::PeerAbsent, "no such peer")
                .map_err(StoreFailure::Refused);
        };
        // A held id without its stored claims, or whose row does not count this peer exactly
        // once as a holder, fails the whole purge before it removes anything (§4.13 reading 136).
        for id in distinct(ids) {
            if !peer.holdings.contains(meter, id) {
                continue;
            }
            let Some(kept) = stored.get(meter, id) else {
                return Err(StoreFailure::Integrity(lost(peer_id, id)));
            };
            let counted = kept.holders.get(peer_id).copied().unwrap_or(0);
            if counted != 1 {
                return Err(StoreFailure::Integrity(uncounted(peer_id, id, counted)));
            }
        }
        let mut targets = Vec::new();
        // The ids that leave this peer's holdings, ascending. A settled debt is not one of them.
        let mut released = Vec::new();
        for id in distinct(ids) {
            let outcome = if peer.holdings.remove(meter, id).is_some() {
                released.push(id.to_string());
                // The stored claims name the index entries this delta made for the peer. The
                // check above found the row counting this peer once, and this loop changes no
                // other id's row.
                let last_holder = match stored.get_mut(meter, id) {
                    Some(kept) => {
                        for entity in target_entities(&kept.claims) {
                            peer.targets.remove_member(meter, entity, id);
                        }
                        for negated in negated_ids(&kept.claims) {
                            peer.negators.remove_member(meter, negated, id);
                        }
                        kept.holders.remove(peer_id);
                        kept.holders.is_empty()
                    }
                    None => true,
                };
                if last_holder {
                    stored.remove(meter, id);
                    PurgeOutcome::Removed
                } else {
                    peer.debts.insert(meter, id.to_string(), ());
                    let owing = debtors.get(meter, id).copied().unwrap_or(0);
                    debtors.insert(meter, id.to_string(), owing + 1);
                    PurgeOutcome::HeldByOtherPeer
                }
            } else if !peer.debts.contains(meter, id) {
                PurgeOutcome::NotHeld
            } else if stored.contains(meter, id) {
                PurgeOutcome::HeldByOtherPeer
            } else {
                peer.debts.remove(meter, id);
                settle(debtors, meter, id);
                PurgeOutcome::Removed
            };
            targets.push(PurgeTarget {
                id: id.to_string(),
                outcome,
            });
        }
        if !released.is_empty() {
            peer.revision += 1;
            peer.removed_at = peer.revision;
            // A purge does not move the head; its record carries the peer's head.
            peer.feed.write(
                ChangeRecord {
                    revision: Revision(peer.revision),
                    head: peer.head.clone(),
                    added: Vec::new(),
                    removed: released,
                },
                *retention,
            );
        }
        let removed = targets.iter().any(|t| t.outcome == PurgeOutcome::Removed);
        let owed = targets
            .iter()
            .any(|t| t.outcome != PurgeOutcome::NotHeld && debtors.contains(meter, &t.id));
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
            // This store always keeps a feed. A target the peer did not hold adds nothing.
            retains: std::iter::once(RetainedSurface::ChangeFeed)
                .chain(owed.then_some(RetainedSurface::PurgeDebt))
                .map(|surface| Retained { surface })
                .collect(),
        })
    }

    /// The records with `from < revision ≤ to` (SPEC-18 §4.6). The answers come in the order of
    /// §4.6: `store-closed`, `capability-absent`, the shape of the bounds, `to` below `from`,
    /// then `resync-required` for a `from` above the current revision or below the floor, else
    /// `ok`. Kept records that are not the revisions of the page answer `feed-gap` (§4.13
    /// reading 136). Its cost is the records it returns and their ids.
    fn changes(
        &mut self,
        peer_id: &str,
        from: Revision,
        to: Option<Revision>,
    ) -> Result<ChangePage, StoreFailure> {
        self.open().map_err(StoreFailure::Refused)?;
        if self.retention == ChangeRetention::None {
            return refuse(
                StoreErrorCode::CapabilityAbsent,
                "this store keeps no change feed",
            )
            .map_err(StoreFailure::Refused);
        }
        if from.0 > MAX_REVISION || to.is_some_and(|to| to.0 > MAX_REVISION) {
            return refuse(
                StoreErrorCode::InvalidRequest,
                "a revision is an integer from 0 to 2^53 - 1",
            )
            .map_err(StoreFailure::Refused);
        }
        // A defaulted `to` is never compared (reading 4).
        if to.is_some_and(|to| to < from) {
            return refuse(
                StoreErrorCode::InvalidRequest,
                "changes: `to` is below `from`",
            )
            .map_err(StoreFailure::Refused);
        }
        let State {
            meter,
            peers,
            page_size,
            ..
        } = self;
        let Some(peer) = peers.get(meter, peer_id) else {
            return refuse(StoreErrorCode::PeerAbsent, "no such peer")
                .map_err(StoreFailure::Refused);
        };
        let current = peer.revision;
        let feed = &peer.feed;
        if from.0 > current || from.0 < feed.floor {
            return Ok(ChangePage::ResyncRequired {
                current: Revision(current),
            });
        }
        let end = to.map_or(current, |to| to.0.min(current));
        let pending = end - from.0;
        let take = page_size.map_or(pending, |size| pending.min(size));
        // The record of revision `from + 1` sits `from - floor` places after the oldest kept.
        let start = (from.0 - feed.floor) as usize;
        let records: Vec<ChangeRecord> = feed
            .records
            .range(start.min(feed.records.len())..)
            .take(take as usize)
            .cloned()
            .collect();
        // Each answered record is the revision it stands for, and none is missing. The check
        // reads only the records the page answers.
        let runs = records.len() as u64 == take
            && records
                .iter()
                .zip(from.0 + 1..)
                .all(|(record, revision)| record.revision.0 == revision);
        if !runs {
            return Err(StoreFailure::Integrity(gap(peer_id, feed, current)));
        }
        let through = if take == pending { end } else { from.0 + take };
        Ok(ChangePage::Ok {
            records,
            through: Revision(through),
        })
    }

    /// One held delta as this peer admitted it, with its arrival record. A holding whose stored
    /// claims are gone is a fault: serving nothing would hide it (§4.13 reading 136).
    fn held(
        view: &mut SnapshotView<'_>,
        id: &str,
    ) -> Result<Option<VerifiedDelta>, IntegrityFault> {
        let Some(holding) = view.peer.holdings.get(view.meter, id) else {
            return Ok(None);
        };
        let Some(kept) = view.stored.get(view.meter, id) else {
            return Err(lost(view.peer_id, id));
        };
        Ok(Some(VerifiedDelta {
            delta: Delta {
                id: id.to_string(),
                claims: kept.claims.clone(),
                sig: holding.sig.clone(),
            },
            arrival: holding.arrival.clone(),
        }))
    }

    fn scope(
        mut view: SnapshotView<'_>,
        request: &ScopeRequest,
    ) -> Result<ScopeResult, IntegrityFault> {
        let offers = view.offers;
        let bound = view.bound;
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
        // The row of a held id is read before any filter, so a lost row fails the walk also when
        // the bound, `arrivalAtMost` or `excludeIds` would drop it (§4.13 reading 136).
        let mut consider = |view: &mut SnapshotView<'_>,
                            id: String,
                            pending: &mut Vec<String>|
         -> Result<(), IntegrityFault> {
            if members.contains_key(&id) {
                return Ok(());
            }
            let Some(member) = Self::held(view, &id)? else {
                return Ok(());
            };
            if member.arrival.sequence > bound
                || dropped.contains(id.as_str())
                || pushdown
                    .arrival_at_most
                    .is_some_and(|n| member.arrival.sequence > n)
                || pushdown
                    .timestamp_at_most
                    .is_some_and(|t| member.delta.claims.timestamp > t)
            {
                return Ok(());
            }
            members.insert(id.clone(), member);
            pending.push(id);
            Ok(())
        };
        let entities: BTreeSet<&str> = request
            .anchors
            .iter()
            .map(|anchor| match anchor {
                Anchor::Entity { entity } => entity.as_str(),
            })
            .collect();
        for entity in entities {
            for id in view.peer.targets.members(view.meter, entity) {
                consider(&mut view, id, &mut pending)?;
            }
        }
        while let Some(id) = pending.pop() {
            for negator in view.peer.negators.members(view.meter, &id) {
                consider(&mut view, negator, &mut pending)?;
            }
        }
        // `exclude` only leaves ids out of the answer; the chains above ran through them.
        for id in &request.exclude {
            members.remove(id);
        }
        Ok(ScopeResult {
            deltas: members.into_values().collect(),
            applied: PushdownFields {
                timestamp_at_most: pushdown.timestamp_at_most.is_some(),
                arrival_at_most: pushdown.arrival_at_most.is_some(),
                exclude_ids: pushdown.exclude_ids.is_some(),
            },
        })
    }
}

impl State {
    /// `fsck` over this store's own structures (§4.13 reading 137), in TypeScript's order: per
    /// peer, each holding against the peer's counters and its stored claims, each index entry
    /// against the claims, and the change records; then each stored row's holders against the
    /// peers that hold it. A
    /// check that meets damage reports it and goes on. It reads only. O(store).
    fn fsck(&mut self) -> FsckReport {
        let State {
            meter,
            stored,
            peers,
            ..
        } = self;
        let mut faults = Vec::new();
        let mut checked = FsckChecked::default();
        let mut holders: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (peer_id, peer) in peers.scan(meter) {
            checked.peers += 1;
            let mut fault = |kind, id: Option<&str>, key: Option<&str>, detail: String| {
                faults.push(IntegrityFault {
                    kind,
                    peer: Some(peer_id.clone()),
                    id: id.map(str::to_string),
                    key: key.map(str::to_string),
                    detail,
                })
            };
            let mut expected: [BTreeMap<&str, BTreeSet<&str>>; 2] = Default::default();
            for (id, holding) in peer.holdings.scan(meter) {
                checked.holdings += 1;
                holders.entry(id).or_default().push(peer_id);
                let here = Some(id.as_str());
                if holding.arrival.sequence > peer.last_sequence {
                    let detail = "memory store: a sequence passes the peer's last";
                    fault(
                        IntegrityFaultKind::SequenceMismatch,
                        here,
                        Some("seq"),
                        detail.into(),
                    );
                }
                if holding.arrival.transfer > peer.last_transfer {
                    let detail = "memory store: a transfer passes the peer's last";
                    let key = Some("transfer");
                    fault(
                        IntegrityFaultKind::SequenceMismatch,
                        here,
                        key,
                        detail.into(),
                    );
                }
                if holding.arrival.id != *id {
                    let detail = "memory store: the arrival record names another id";
                    let key = Some("holding.arrival");
                    fault(IntegrityFaultKind::ColumnMismatch, here, key, detail.into());
                }
                let Some(kept) = stored.get(meter, id) else {
                    let detail = "memory store: a held delta has no stored claims";
                    fault(
                        IntegrityFaultKind::ClaimsUnreadable,
                        here,
                        None,
                        detail.into(),
                    );
                    continue;
                };
                if compute_id(&kept.claims).ok().as_deref() != Some(id.as_str()) {
                    let detail = "memory store: stored claims do not hash to their id";
                    fault(
                        IntegrityFaultKind::ClaimsMismatch,
                        here,
                        None,
                        detail.into(),
                    );
                }
                for entity in target_entities(&kept.claims) {
                    expected[0].entry(entity).or_default().insert(id);
                }
                for negated in negated_ids(&kept.claims) {
                    expected[1].entry(negated).or_default().insert(id);
                }
            }
            let indexes = [(&peer.targets, "target"), (&peer.negators, "negation")];
            for ((index, what), want) in indexes.into_iter().zip(&mut expected) {
                for (key, bucket) in index.scan(meter) {
                    for id in bucket {
                        let named = want
                            .get_mut(key.as_str())
                            .is_some_and(|ids| ids.remove(id.as_str()));
                        if !named {
                            let detail =
                                format!("memory store: a {what} entry that no held claims name");
                            fault(IntegrityFaultKind::IndexStray, Some(id), Some(key), detail);
                        }
                    }
                }
                for (key, left) in want.iter() {
                    for id in left {
                        let detail = format!(
                            "memory store: held claims name a {what} entry that is missing"
                        );
                        fault(
                            IntegrityFaultKind::IndexMissing,
                            Some(id),
                            Some(key),
                            detail,
                        );
                    }
                }
            }
            let feed = &peer.feed;
            let kept = feed.records.len() as u64;
            let runs = (1..)
                .zip(&feed.records)
                .all(|(after, record)| feed.floor.checked_add(after) == Some(record.revision.0));
            if feed.floor.checked_add(kept) != Some(peer.revision) || !runs {
                faults.push(gap(peer_id, feed, peer.revision));
            }
        }
        for (id, row) in stored.scan(meter) {
            checked.deltas += 1;
            let held = holders
                .get(id.as_str())
                .map(Vec::as_slice)
                .unwrap_or_default();
            let (kind, key, detail) = if held.is_empty() {
                (
                    IntegrityFaultKind::OrphanBytes,
                    None,
                    "memory store: no peer holds these bytes".to_string(),
                )
            } else if row.holders.len() != held.len()
                || held.iter().any(|p| row.holders.get(*p) != Some(&1))
            {
                let named: Vec<String> = row
                    .holders
                    .iter()
                    .map(|(p, n)| match n {
                        1 => p.clone(),
                        n => format!("{p} ({n})"),
                    })
                    .collect();
                (
                    IntegrityFaultKind::CountMismatch,
                    Some("holders".to_string()),
                    format!(
                        "memory store: the row names the holders [{}] and the peers [{}] hold it",
                        named.join(", "),
                        held.join(", ")
                    ),
                )
            } else {
                continue;
            };
            faults.push(IntegrityFault {
                kind,
                peer: None,
                id: Some(id.clone()),
                key,
                detail,
            });
        }
        FsckReport { checked, faults }
    }
}

/// What a snapshot query may read: the shared claims and one peer.
struct SnapshotView<'a> {
    meter: &'a mut StoreMeter,
    stored: &'a Index<Stored>,
    peer_id: &'a str,
    peer: &'a PeerState,
    offers: PushdownFields,
    /// The snapshot's last sequence: a holding with a later sequence arrived after the read.
    bound: u64,
}

impl SnapshotView<'_> {
    /// Whether the snapshot holds `id`: the peer holds it at a sequence within the bound. An id
    /// it holds must have its stored claims, as in `get` (§4.13 reading 136).
    fn within(&mut self, id: &str) -> Result<bool, IntegrityFault> {
        let held = self
            .peer
            .holdings
            .get(self.meter, id)
            .is_some_and(|holding| holding.arrival.sequence <= self.bound);
        if held && !self.stored.contains(self.meter, id) {
            return Err(lost(self.peer_id, id));
        }
        Ok(held)
    }
}

type Shared = Arc<Mutex<State>>;

fn with<R>(state: &Shared, f: impl FnOnce(&mut State) -> R) -> R {
    // `append` plans its whole batch and then commits. Its commit writes one id at a time and
    // adds 1 to the row's count of the peer for each id that a row already stores. A damaged
    // count at `usize::MAX` panics there in a debug build, part-way through the batch: the ids
    // before it are held, that id and the ids after it are not, the revision does not move and
    // no change record is written. A release build wraps that count to 0 instead; 0 is not 1, so
    // a later purge of the id by the peer refuses. After the last holding is written, the commit
    // adds 1 to the revision; a damaged revision at `u64::MAX` panics there in a debug build.
    // `purge` has no plan: it removes one id at a time, and each id's removal is complete
    // before the next starts. Before its first write, `purge` checks every named held id: its
    // row exists and counts this peer exactly once as a holder (§4.13 reading 136). Its loop
    // removes the peer from the row and subtracts nothing. Its loop adds 1 to a debt count, and
    // after the loop it adds 1 to the revision; a damaged value at `u64::MAX` panics there in a
    // debug build. With an undamaged state no step can panic between two writes of one id, so a
    // poisoned lock still guards a state whose indexes agree with its holdings.
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    f(&mut guard)
}

/// How a memory store is built. The default applies every pushdown field, keeps every change
/// record and has no page limit (SPEC-18 §4.13 reading 15).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryStoreOptions {
    /// The pushdown fields it applies. It ignores the others and reports so.
    pub pushdown: PushdownFields,
    /// `Unbounded` or `Revisions(n)` with n from 1 to 2^53 − 1. `None` is refused: this store
    /// serves a change feed.
    pub change_retention: ChangeRetention,
    /// At most this many records in one page, 1 or more. It exists so tests exercise paging.
    pub change_page_size: Option<u64>,
}

impl Default for MemoryStoreOptions {
    fn default() -> Self {
        Self {
            pushdown: memory_store_profile().pushdown,
            change_retention: ChangeRetention::Unbounded,
            change_page_size: None,
        }
    }
}

/// The memory reference store. Handles share one state; each open store is its own state.
#[derive(Debug, Clone)]
pub struct MemoryStore {
    state: Shared,
    profile: StoreProfile,
}

/// The profile the memory store implements: entity anchors, arrival records, every pushdown
/// field, erasure class `unprovable`, and a change feed that keeps every record. Nothing it would
/// have to scan for.
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
        change_retention: ChangeRetention::Unbounded,
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
        Self::with_options(MemoryStoreOptions {
            pushdown,
            ..MemoryStoreOptions::default()
        })
        .expect("the default retention and page size are legal")
    }

    /// A new, empty store built with these options. Refuses `invalid-request` for a retention of
    /// `None` or `Revisions(n)` outside 1 to 2^53 − 1, and for a page size of 0.
    pub fn with_options(options: MemoryStoreOptions) -> Result<Self, StoreError> {
        let kept = match options.change_retention {
            ChangeRetention::Unbounded => true,
            ChangeRetention::Revisions(n) => (1..=MAX_REVISION).contains(&n),
            ChangeRetention::None => false,
        };
        if !kept {
            return refuse(
                StoreErrorCode::InvalidRequest,
                "changeRetention is unbounded or {revisions: n} with n from 1 to 2^53 - 1",
            );
        }
        if options.change_page_size == Some(0) {
            return refuse(
                StoreErrorCode::InvalidRequest,
                "changePageSize is an integer of 1 or more",
            );
        }
        Ok(Self {
            state: Arc::new(Mutex::new(State {
                closed: false,
                pushdown: options.pushdown,
                retention: options.change_retention,
                page_size: options.change_page_size,
                meter: StoreMeter::default(),
                stored: Index::new(),
                peers: Index::new(),
                debtors: Index::new(),
                mint: None,
                issued: BTreeSet::new(),
            })),
            profile: StoreProfile {
                pushdown: options.pushdown,
                change_retention: options.change_retention,
                ..memory_store_profile()
            },
        })
    }

    /// This store with a host's mint of histories in place of the process-local default. A mint
    /// that answers an empty string, one that starts with `memory:local:`, or one this store has
    /// already issued to any peer makes `create_peer` refuse `invalid-request`.
    pub fn with_history_mint(self, mint: HistoryMint) -> Self {
        with(&self.state, |state| state.mint = Some(mint));
        self
    }

    /// The index work done since the last reset.
    pub fn meter(&self) -> StoreMeter {
        with(&self.state, |state| state.meter)
    }

    pub fn reset_meter(&self) {
        with(&self.state, |state| state.meter = StoreMeter::default());
    }

    fn handle(
        &self,
        id: &str,
        posture: ErasurePosture,
        history: String,
        app_format: Option<String>,
    ) -> Box<dyn PeerStore> {
        Box::new(MemoryPeer {
            state: self.state.clone(),
            id: id.to_string(),
            history,
            app_format,
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
        options: &CreatePeerOptions,
    ) -> Result<Box<dyn PeerStore>, StoreError> {
        let erasure = options.erasure;
        let app_format = options.app_format.clone();
        let history = with(&self.state, |state| {
            state.open()?;
            if id.is_empty() {
                return refuse(
                    StoreErrorCode::InvalidRequest,
                    "a peer id must not be empty",
                );
            }
            if let Some(format) = &app_format {
                if format.is_empty() || format.len() > APP_FORMAT_MAX_BYTES {
                    return refuse(
                        StoreErrorCode::InvalidRequest,
                        format!(
                            "app_format is a string of 1 to {APP_FORMAT_MAX_BYTES} UTF-8 bytes"
                        ),
                    );
                }
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
            let history = match &state.mint {
                None => local_history(),
                Some(HistoryMint(mint)) => {
                    let minted = mint(id);
                    if minted.is_empty() || minted.starts_with(LOCAL_HISTORY_PREFIX) {
                        return refuse(
                            StoreErrorCode::InvalidRequest,
                            "mintHistory must answer a non-empty string that does not start with memory:local:",
                        );
                    }
                    minted
                }
            };
            if !state.issued.insert(history.clone()) {
                return refuse(
                    StoreErrorCode::InvalidRequest,
                    format!("the mint answered {history}, a history this store already issued; a history is never reused"),
                );
            }
            state.peers.insert(
                &mut state.meter,
                id.to_string(),
                PeerState {
                    posture: erasure,
                    history: history.clone(),
                    app_format: app_format.clone(),
                    head: None,
                    revision: 0,
                    last_sequence: 0,
                    last_transfer: 0,
                    removed_at: 0,
                    holdings: Index::new(),
                    targets: Index::new(),
                    negators: Index::new(),
                    debts: Index::new(),
                    feed: Feed::default(),
                },
            );
            Ok(history)
        })?;
        Ok(self.handle(id, erasure, history, app_format))
    }

    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        let (posture, history, app_format) = with(&self.state, |state| {
            state.open()?;
            match state.peers.get(&mut state.meter, id) {
                Some(peer) => Ok((peer.posture, peer.history.clone(), peer.app_format.clone())),
                None => refuse(StoreErrorCode::PeerAbsent, "no such peer"),
            }
        })?;
        Ok(self.handle(id, posture, history, app_format))
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
    history: String,
    app_format: Option<String>,
    erasure: PeerErasure,
}

impl PeerStore for MemoryPeer {
    fn id(&self) -> &str {
        &self.id
    }

    fn erasure(&self) -> PeerErasure {
        self.erasure
    }

    fn history(&self) -> Result<&str, StoreError> {
        with(&self.state, |state| state.open())?;
        Ok(&self.history)
    }

    fn app_format(&self) -> Result<Option<&str>, StoreError> {
        with(&self.state, |state| state.open())?;
        Ok(self.app_format.as_deref())
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
                history: peer.history.clone(),
                head: peer.head.clone(),
                count: peer.holdings.len() as u64,
                last_sequence: peer.last_sequence,
                last_transfer: peer.last_transfer,
                released: false,
            }) as Box<dyn Snapshot>)
        })
    }

    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        with(&self.state, |state| state.append(&self.id, batch))
    }

    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreFailure> {
        with(&self.state, |state| state.purge(&self.id, ids))
    }

    fn changes(&self, from: Revision, to: Option<Revision>) -> Result<ChangePage, StoreFailure> {
        with(&self.state, |state| state.changes(&self.id, from, to))
    }
}

struct MemorySnapshot {
    state: Shared,
    peer: String,
    revision: u64,
    history: String,
    head: Option<String>,
    count: u64,
    last_sequence: u64,
    last_transfer: u64,
    released: bool,
}

impl MemorySnapshot {
    /// Runs one query against the peer, unless the snapshot is released or the peer released a
    /// holding after the read. An append gives each new holding a sequence past the snapshot's
    /// last one, so each query keeps the holdings at or below it and answers as at the
    /// snapshot's revision (§4.13 readings 130 and 131). This store neither deletes nor restores
    /// a peer, so its history and revision never go back.
    /// A refusal answers `StoreFailure::Refused`; damage that `f` meets answers
    /// `StoreFailure::Integrity`.
    fn query<R>(
        &self,
        f: impl FnOnce(SnapshotView<'_>) -> Result<R, IntegrityFault>,
    ) -> Result<R, StoreFailure> {
        if self.released {
            return refuse(
                StoreErrorCode::SnapshotReleased,
                "the snapshot was released",
            )
            .map_err(StoreFailure::Refused);
        }
        with(&self.state, |state| {
            state.open().map_err(StoreFailure::Refused)?;
            let State {
                meter,
                stored,
                peers,
                pushdown,
                ..
            } = state;
            let Some(peer) = peers.get(meter, &self.peer) else {
                return refuse(StoreErrorCode::PeerAbsent, "no such peer")
                    .map_err(StoreFailure::Refused);
            };
            if peer.removed_at > self.revision {
                return refuse(
                    StoreErrorCode::SnapshotMoved,
                    "the peer released a holding after this snapshot; read a new one",
                )
                .map_err(StoreFailure::Refused);
            }
            f(SnapshotView {
                meter,
                stored,
                peer_id: &self.peer,
                peer,
                offers: *pushdown,
                bound: self.last_sequence,
            })
            .map_err(StoreFailure::Integrity)
        })
    }
}

impl Snapshot for MemorySnapshot {
    fn revision(&self) -> Revision {
        Revision(self.revision)
    }

    fn history(&self) -> &str {
        &self.history
    }

    fn head(&self) -> Option<&str> {
        self.head.as_deref()
    }

    fn count(&self) -> u64 {
        self.count
    }

    fn last_sequence(&self) -> u64 {
        self.last_sequence
    }

    fn last_transfer(&self) -> u64 {
        self.last_transfer
    }

    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreFailure> {
        self.query(|mut view| {
            let mut found = Vec::new();
            // The row is read before the bound, as in TypeScript (§4.13 reading 136).
            for id in distinct(ids) {
                if let Some(member) = State::held(&mut view, id)? {
                    if member.arrival.sequence <= view.bound {
                        found.push(member.delta);
                    }
                }
            }
            Ok(found)
        })
    }

    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreFailure> {
        self.query(|view| {
            let mut found = Vec::new();
            for id in distinct(ids) {
                let Some(holding) = view.peer.holdings.get(view.meter, id) else {
                    continue;
                };
                if holding.arrival.sequence > view.bound {
                    continue;
                }
                if !view.stored.contains(view.meter, id) {
                    return Err(lost(view.peer_id, id));
                }
                found.push(holding.arrival.clone());
            }
            Ok(found)
        })
    }

    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreFailure> {
        self.query(|mut view| {
            let mut ids = BTreeSet::new();
            for entity in distinct(entities) {
                for id in view.peer.targets.members(view.meter, entity) {
                    if view.within(&id)? {
                        ids.insert(id);
                    }
                }
            }
            Ok(ids.into_iter().collect())
        })
    }

    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreFailure> {
        self.query(|mut view| {
            let mut negators = BTreeSet::new();
            for id in distinct(ids) {
                for negator in view.peer.negators.members(view.meter, id) {
                    if view.within(&negator)? {
                        negators.insert(negator);
                    }
                }
            }
            Ok(negators.into_iter().collect())
        })
    }

    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreFailure> {
        let pushdown = request.pushdown.as_ref();
        if pushdown
            .and_then(|p| p.timestamp_at_most)
            .is_some_and(|t| !t.is_finite())
        {
            return refuse(
                StoreErrorCode::InvalidRequest,
                "timestampAtMost must be a finite number",
            )
            .map_err(StoreFailure::Refused);
        }
        if pushdown
            .and_then(|p| p.arrival_at_most)
            .is_some_and(|n| n > MAX_ARRIVAL_COUNTER)
        {
            return refuse(
                StoreErrorCode::InvalidRequest,
                "arrivalAtMost must be an integer from 0 to 2^53 - 1",
            )
            .map_err(StoreFailure::Refused);
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

fn listing<'a, T: 'a>(items: Result<Vec<T>, StoreFailure>) -> Listing<'a, T> {
    match items {
        Ok(items) => Box::new(items.into_iter().map(Ok)),
        Err(failure) => Box::new(std::iter::once(Err(failure))),
    }
}

impl Exporter for MemoryExporter {
    fn peers(&self) -> Listing<'_, String> {
        listing(with(&self.state, |state| {
            state.open().map_err(StoreFailure::Refused)?;
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
            state.open().map_err(StoreFailure::Refused)?;
            Ok(state
                .stored
                .scan(&mut state.meter)
                .map(|(id, _)| id.clone())
                .collect())
        }))
    }

    fn fsck(&self) -> Result<FsckReport, StoreError> {
        with(&self.state, |state| {
            state.open()?;
            Ok(state.fsck())
        })
    }
}

struct MemoryPeerExporter {
    state: Shared,
    peer: String,
}

impl MemoryPeerExporter {
    /// Every holding of the peer. A holding whose stored claims are gone fails the listing, as a
    /// read does (§4.13 reading 136).
    fn members(&self) -> Result<Vec<Delta>, StoreFailure> {
        with(&self.state, |state| {
            state.open().map_err(StoreFailure::Refused)?;
            let State {
                meter,
                stored,
                peers,
                ..
            } = state;
            let Some(peer) = peers.get(meter, &self.peer) else {
                return refuse(StoreErrorCode::PeerAbsent, "no such peer")
                    .map_err(StoreFailure::Refused);
            };
            let held: Vec<(String, Option<String>)> = peer
                .holdings
                .scan(meter)
                .map(|(id, holding)| (id.clone(), holding.sig.clone()))
                .collect();
            held.into_iter()
                .map(|(id, sig)| match stored.get(meter, &id) {
                    Some(kept) => Ok(Delta {
                        claims: kept.claims.clone(),
                        id,
                        sig,
                    }),
                    None => Err(StoreFailure::Integrity(lost(&self.peer, &id))),
                })
                .collect()
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

#[cfg(test)]
use crate::set::{make_delta, make_negation_claims};
#[cfg(test)]
use crate::store_admission::{admission_of, AdmissionOptions};
#[cfg(test)]
use crate::types::{EntityRef, Pointer, Target};

#[cfg(test)]
const AUTHOR: &str = "ed25519:2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e";

#[cfg(test)]
static STAMP: Mutex<u64> = Mutex::new(0);

#[cfg(test)]
fn stamp() -> f64 {
    let mut next = STAMP.lock().unwrap();
    *next += 1;
    *next as f64
}

#[cfg(test)]
fn fact(entity: &str) -> Delta {
    let claims = Claims {
        timestamp: stamp(),
        valid_from: 0.0,
        valid_until: None,
        author: AUTHOR.into(),
        pointers: vec![Pointer {
            role: "about".into(),
            target: Target::Entity(EntityRef {
                id: entity.into(),
                context: None,
            }),
        }],
    };
    make_delta(claims, None).unwrap()
}

#[cfg(test)]
fn negation(of: &Delta) -> Delta {
    make_delta(make_negation_claims(AUTHOR, stamp(), &of.id, None), None).unwrap()
}

#[cfg(test)]
fn add(peer: &dyn PeerStore, deltas: &[&Delta]) {
    let deltas: Vec<Delta> = deltas.iter().map(|d| (*d).clone()).collect();
    let now = peer.read().unwrap();
    let next_head = format!("head-{}", now.revision().0 + 1);
    let options = AdmissionOptions {
        at: 1.0,
        sender: "local".into(),
        next_head,
    };
    let batch = admission_of(now.as_ref(), &deltas, options).unwrap();
    assert!(matches!(
        peer.append(&batch).unwrap(),
        AppendResult::Committed { .. }
    ));
}

#[cfg(test)]
fn ids(deltas: &[&Delta]) -> Vec<String> {
    deltas.iter().map(|d| d.id.clone()).collect()
}

#[cfg(test)]
type Place = (&'static str, Option<String>, Option<String>, Option<String>);

#[cfg(test)]
fn place(fault: &IntegrityFault) -> Place {
    let kind = fault.kind.as_str();
    (
        kind,
        fault.peer.clone(),
        fault.id.clone(),
        fault.key.clone(),
    )
}

#[cfg(test)]
fn at(kind: &'static str, peer: Option<&str>, id: &str, key: Option<&str>) -> Place {
    let owned = |s: Option<&str>| s.map(str::to_string);
    (kind, owned(peer), Some(id.to_string()), owned(key))
}

/// The place of the fault a call answers, or what it answered instead.
#[cfg(test)]
fn fault_of<T: fmt::Debug>(answer: Result<T, StoreFailure>) -> Result<Place, String> {
    match answer {
        Err(StoreFailure::Integrity(fault)) => Ok(place(&fault)),
        other => Err(format!("not an integrity fault: {other:?}")),
    }
}

#[cfg(test)]
fn places(store: &MemoryStore) -> Vec<Place> {
    store
        .open_admin()
        .fsck()
        .unwrap()
        .faults
        .iter()
        .map(place)
        .collect()
}

/// Changes the store's own state. Only a test inside this module can reach it.
#[cfg(test)]
fn damage(store: &MemoryStore, f: impl FnOnce(&mut State)) {
    with(&store.state, f);
}

#[cfg(test)]
fn holding<'a>(state: &'a mut State, peer: &str, id: &str) -> &'a mut Holding {
    let peer = state.peers.map.get_mut(peer).unwrap();
    peer.holdings.map.get_mut(id).unwrap()
}

/// Peer A holds a fact `t` at `e:t`, its negation `n` and a bystander `b` at `e:b`, over
/// three appends. `fsck` finds nothing.
#[cfg(test)]
fn filled() -> (MemoryStore, Box<dyn PeerStore>, Delta, Delta, Delta) {
    let store = MemoryStore::new();
    let a = store
        .create_peer("peer:a", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap();
    let t = fact("e:t");
    let n = negation(&t);
    let b = fact("e:b");
    add(a.as_ref(), &[&t]);
    add(a.as_ref(), &[&n]);
    add(a.as_ref(), &[&b]);
    assert_eq!(places(&store), []);
    (store, a, t, n, b)
}

#[cfg(test)]
fn entity(e: &str) -> ScopeRequest {
    ScopeRequest {
        anchors: vec![Anchor::Entity { entity: e.into() }],
        exclude: Vec::new(),
        pushdown: None,
    }
}

#[cfg(test)]
#[test]
fn a_held_id_whose_row_is_gone_fails_get_arrivals_targets_scope_and_the_export_with_claims_unreadable_and_fsck_reports_it_and_the_bystander_reads(
) {
    let (store, a, t, n, b) = filled();
    damage(&store, |state| {
        state.stored.map.remove(&t.id);
    });
    let fault = at("claims-unreadable", Some("peer:a"), &t.id, None);
    let snapshot = a.read().unwrap();
    assert_eq!(fault_of(snapshot.get(&ids(&[&t]))), Ok(fault.clone()));
    assert_eq!(fault_of(snapshot.arrivals(&ids(&[&t]))), Ok(fault.clone()));
    assert_eq!(
        fault_of(snapshot.targets(&["e:t".into()])),
        Ok(fault.clone())
    );
    assert_eq!(fault_of(snapshot.scope(&entity("e:t"))), Ok(fault.clone()));
    let admin = store.open_admin();
    let listed = admin.peer("peer:a").unwrap();
    assert_eq!(
        fault_of(listed.ids().collect::<Result<Vec<_>, _>>()),
        Ok(fault.clone())
    );
    assert_eq!(
        fault_of(listed.deltas().collect::<Result<Vec<_>, _>>()),
        Ok(fault.clone())
    );
    assert_eq!(snapshot.negators(&ids(&[&t])).unwrap(), ids(&[&n]));
    assert!(places(&store).contains(&fault));
    assert_eq!(snapshot.get(&ids(&[&b])).unwrap(), vec![b.clone()]);
    assert_eq!(snapshot.targets(&["e:b".into()]).unwrap(), ids(&[&b]));
    let detail = match snapshot.get(&ids(&[&t])) {
        Err(StoreFailure::Integrity(fault)) => fault.detail,
        other => panic!("{other:?}"),
    };
    assert_eq!(detail, "memory store: a held delta has no stored claims");
}

#[cfg(test)]
#[test]
fn a_lost_negation_fails_negators_with_claims_unreadable_and_its_id() {
    let (store, a, t, n, _) = filled();
    damage(&store, |state| {
        state.stored.map.remove(&n.id);
    });
    let snapshot = a.read().unwrap();
    assert_eq!(
        fault_of(snapshot.negators(&ids(&[&t]))),
        Ok(at("claims-unreadable", Some("peer:a"), &n.id, None))
    );
}

#[cfg(test)]
#[test]
fn scope_and_get_read_the_row_before_the_bound_and_the_pushdown_so_a_lost_row_fails_them_also_where_a_filter_drops_it(
) {
    let (store, a, t, _, _) = filled();
    let old = a.read().unwrap();
    let late = fact("e:t");
    add(a.as_ref(), &[&late]);
    damage(&store, |state| {
        state.stored.map.remove(&late.id);
    });
    let fault = at("claims-unreadable", Some("peer:a"), &late.id, None);
    assert_eq!(fault_of(old.get(&ids(&[&late]))), Ok(fault.clone()));
    assert_eq!(fault_of(old.scope(&entity("e:t"))), Ok(fault.clone()));
    assert_eq!(old.arrivals(&ids(&[&late])).unwrap(), []);
    assert_eq!(old.targets(&["e:t".into()]).unwrap(), ids(&[&t]));
    let now = a.read().unwrap();
    let mut excluded = entity("e:t");
    excluded.pushdown = Some(Pushdown {
        exclude_ids: Some(ids(&[&late])),
        ..Pushdown::default()
    });
    assert_eq!(fault_of(now.scope(&excluded)), Ok(fault.clone()));
    let mut early = entity("e:t");
    early.pushdown = Some(Pushdown {
        arrival_at_most: Some(1),
        ..Pushdown::default()
    });
    assert_eq!(fault_of(now.scope(&early)), Ok(fault));
}

#[cfg(test)]
#[test]
fn a_purge_that_names_a_held_id_whose_row_is_gone_fails_with_claims_unreadable_and_removes_nothing()
{
    let store = MemoryStore::new();
    let peer = store
        .create_peer("peer:a", &CreatePeerOptions::new(ErasurePosture::Unproven))
        .unwrap();
    let target = fact("e:target");
    let bystander = fact("e:bystander");
    let mut companion = fact("e:companion");
    while companion.id > target.id {
        companion = fact("e:companion");
    }
    add(peer.as_ref(), &[&target, &bystander, &companion]);
    let before = peer.read().unwrap();
    damage(&store, |state| {
        state.stored.map.remove(&target.id);
    });
    let fault = at("claims-unreadable", Some("peer:a"), &target.id, None);
    let feed = peer.changes(Revision(0), None).unwrap();
    let faults = places(&store);

    assert_eq!(
        fault_of(peer.purge(&ids(&[&target, &companion]))),
        Ok(fault.clone())
    );

    let now = peer.read().unwrap();
    assert_eq!((now.revision(), now.count()), (before.revision(), 3));
    assert_eq!(peer.changes(Revision(0), None).unwrap(), feed);
    assert_eq!(fault_of(now.arrivals(&ids(&[&target]))), Ok(fault));
    for kept in [&companion, &bystander] {
        assert_eq!(now.get(&ids(&[kept])).unwrap(), vec![kept.clone()]);
        let arrivals = now.arrivals(&ids(&[kept])).unwrap();
        assert_eq!(
            arrivals.iter().map(|r| &r.id).collect::<Vec<_>>(),
            [&kept.id]
        );
    }
    let mut both = ids(&[&companion, &bystander]);
    both.sort();
    let entities = ["e:companion".to_string(), "e:bystander".to_string()];
    assert_eq!(now.targets(&entities).unwrap(), both);
    assert_eq!(places(&store), faults);
}

#[cfg(test)]
#[test]
fn a_held_arrival_above_the_peers_last_sequence_or_transfer_is_reported_sequence_mismatch_by_fsck()
{
    for (key, set) in [
        (
            "seq",
            (|r: &mut ArrivalRecord| r.sequence = 999) as fn(&mut ArrivalRecord),
        ),
        ("transfer", |r: &mut ArrivalRecord| r.transfer = 999),
    ] {
        let (store, _, t, _, _) = filled();
        damage(&store, |state| {
            set(&mut holding(state, "peer:a", &t.id).arrival)
        });
        assert_eq!(
            places(&store),
            [at("sequence-mismatch", Some("peer:a"), &t.id, Some(key))],
            "{key}"
        );
    }
}

#[cfg(test)]
#[test]
fn a_held_arrival_that_names_another_id_is_reported_column_mismatch_holding_arrival_by_fsck() {
    let (store, _, t, _, b) = filled();
    damage(&store, |state| {
        holding(state, "peer:a", &t.id).arrival.id = b.id.clone();
    });
    assert_eq!(
        places(&store),
        [at(
            "column-mismatch",
            Some("peer:a"),
            &t.id,
            Some("holding.arrival")
        )]
    );
}

#[cfg(test)]
#[test]
fn stored_claims_that_do_not_hash_to_their_id_are_reported_claims_mismatch_by_fsck() {
    let (store, _, t, _, b) = filled();
    damage(&store, |state| {
        state.stored.map.get_mut(&t.id).unwrap().claims = b.claims.clone();
    });
    let found = places(&store);
    assert!(
        found.contains(&at("claims-mismatch", Some("peer:a"), &t.id, None)),
        "{found:?}"
    );
}

#[cfg(test)]
#[test]
fn a_lost_index_entry_is_reported_index_missing_and_an_entry_no_claims_name_index_stray_by_fsck() {
    let (store, _, t, _, b) = filled();
    damage(&store, |state| {
        let peer = state.peers.map.get_mut("peer:a").unwrap();
        peer.targets.map.remove("e:t");
        peer.negators
            .map
            .get_mut(&t.id)
            .unwrap()
            .insert(b.id.clone());
    });
    assert_eq!(
        places(&store),
        [
            at("index-missing", Some("peer:a"), &t.id, Some("e:t")),
            at("index-stray", Some("peer:a"), &b.id, Some(&t.id)),
        ]
    );
}

#[cfg(test)]
#[test]
fn change_records_that_do_not_run_from_the_floor_to_the_revision_are_reported_feed_gap_by_fsck() {
    for cut in [0, 1] {
        let (store, _, _, _, _) = filled();
        damage(&store, |state| {
            let feed = &mut state.peers.map.get_mut("peer:a").unwrap().feed;
            if cut == 0 {
                feed.records.pop_back();
            } else {
                feed.records[1].revision = Revision(7);
            }
        });
        let found = store.open_admin().fsck().unwrap().faults;
        assert_eq!(
            found.iter().map(place).collect::<Vec<_>>(),
            [("feed-gap", Some("peer:a".to_string()), None, None)],
            "{cut}"
        );
    }
}

#[cfg(test)]
#[test]
fn bytes_no_peer_holds_are_orphan_bytes_and_a_wrong_count_of_holders_is_count_mismatch_by_fsck() {
    let (store, _, _, _, b) = filled();
    let orphan = fact("e:orphan");
    damage(&store, |state| {
        state.stored.map.insert(
            orphan.id.clone(),
            Stored {
                claims: orphan.claims.clone(),
                holders: BTreeMap::from([("peer:a".to_string(), 1)]),
            },
        );
        let row = state.stored.map.get_mut(&b.id).unwrap();
        row.holders.insert("peer:a".to_string(), 2);
    });
    let mut want = vec![
        at("orphan-bytes", None, &orphan.id, None),
        at("count-mismatch", None, &b.id, Some("holders")),
    ];
    want.sort_by(|x, y| x.2.cmp(&y.2));
    assert_eq!(places(&store), want);
}

#[cfg(test)]
#[test]
fn fsck_answers_no_fault_over_shared_ids_negations_purges_and_a_trimmed_feed_and_counts_what_it_read(
) {
    let store = MemoryStore::with_options(MemoryStoreOptions {
        change_retention: ChangeRetention::Revisions(2),
        ..MemoryStoreOptions::default()
    })
    .unwrap();
    let posture = CreatePeerOptions::new(ErasurePosture::Unproven);
    let a = store.create_peer("peer:a", &posture).unwrap();
    let b = store.create_peer("peer:b", &posture).unwrap();
    let (x, y, z) = (fact("x"), fact("y"), fact("z"));
    let neg = negation(&x);
    add(a.as_ref(), &[&x, &y]);
    add(a.as_ref(), &[&neg]);
    add(a.as_ref(), &[&z]);
    add(b.as_ref(), &[&x, &z, &neg]);
    a.purge(&ids(&[&x, &y])).unwrap();
    b.purge(&ids(&[&z])).unwrap();
    assert_eq!(
        store.open_admin().fsck().unwrap(),
        FsckReport {
            checked: FsckChecked {
                peers: 2,
                holdings: 4,
                deltas: 3
            },
            faults: Vec::new(),
        }
    );
}

#[cfg(test)]
#[test]
fn fsck_refuses_store_closed_after_close() {
    let store = MemoryStore::new();
    let admin = store.open_admin();
    store.close();
    assert_eq!(
        admin.fsck().map_err(|e| e.code),
        Err(StoreErrorCode::StoreClosed)
    );
}

#[cfg(test)]
use crate::store_follow::{follow_feed, Position};
#[cfg(test)]
use crate::store_fresh::FeedError;

/// The stored rows, the peers and the debts, as text: the whole state but the meter.
#[cfg(test)]
fn dump(store: &MemoryStore) -> String {
    with(&store.state, |state| {
        format!("{:?}", (&state.stored, &state.peers, &state.debtors))
    })
}

#[cfg(test)]
#[test]
fn a_purge_that_names_a_held_id_whose_row_counts_no_holder_fails_with_count_mismatch_holders_and_removes_nothing(
) {
    let target = fact("e:target");
    let mut low = fact("e:good");
    while low.id > target.id {
        low = fact("e:good");
    }
    let mut high = fact("e:good");
    while high.id < target.id {
        high = fact("e:good");
    }
    for good in [&low, &high] {
        for order in [[good, &target], [&target, good]] {
            let case = format!("good {} first {}", good.id, order[0].id);
            let store = MemoryStore::new();
            let posture = CreatePeerOptions::new(ErasurePosture::Unproven);
            let a = store.create_peer("peer:a", &posture).unwrap();
            let b = store.create_peer("peer:b", &posture).unwrap();
            let bystander = fact("e:bystander");
            let other = fact("e:other");
            add(a.as_ref(), &[&target, good, &bystander]);
            add(b.as_ref(), &[&other]);
            damage(&store, |state| {
                state
                    .stored
                    .map
                    .get_mut(&target.id)
                    .unwrap()
                    .holders
                    .clear();
            });
            let feed = a.changes(Revision(0), None).unwrap();
            let revisions = (a.read().unwrap().revision(), b.read().unwrap().revision());
            let before = dump(&store);

            let fault = match a.purge(&ids(&order)) {
                Err(StoreFailure::Integrity(fault)) => fault,
                other => panic!("{case}: {other:?}"),
            };

            let want = at(
                "count-mismatch",
                Some("peer:a"),
                &target.id,
                Some("holders"),
            );
            assert_eq!(place(&fault), want, "{case}");
            let detail =
                "memory store: the row counts this peer 0 times as a holder and this peer holds it";
            assert_eq!(fault.detail, detail, "{case}");
            assert_eq!(dump(&store), before, "{case}");
            let now = a.read().unwrap();
            assert_eq!((now.revision(), now.count()), (revisions.0, 3), "{case}");
            assert_eq!(a.changes(Revision(0), None).unwrap(), feed, "{case}");
            let held = now.arrivals(&ids(&[&target])).unwrap();
            assert_eq!(held.len(), 1, "{case}");
            assert_eq!(
                now.targets(&["e:target".into()]).unwrap(),
                ids(&[&target]),
                "{case}"
            );
            for kept in [good, &bystander] {
                assert_eq!(
                    now.get(&ids(&[kept])).unwrap(),
                    vec![kept.clone()],
                    "{case}"
                );
            }
            let there = b.read().unwrap();
            assert_eq!(there.revision(), revisions.1, "{case}");
            assert_eq!(there.get(&ids(&[&other])).unwrap(), vec![other.clone()]);
        }
    }
}

#[cfg(test)]
#[test]
fn changes_over_a_lost_or_renumbered_change_record_fail_with_feed_gap_and_a_follower_answers_it_and_keeps_its_position(
) {
    for lost in [2, 1, 0] {
        let (store, a, _, _, _) = filled();
        damage(&store, |state| {
            let feed = &mut state.peers.map.get_mut("peer:a").unwrap().feed;
            if lost == 0 {
                feed.records[1].revision = Revision(7);
            } else {
                feed.records.remove(lost);
            }
        });
        let before = dump(&store);
        let kept = if lost == 0 { 3 } else { 2 };
        let detail =
            format!("memory store: the peer keeps {kept} change records at floor 0 and revision 3");
        let froms: &[u64] = if lost == 0 { &[0, 1] } else { &[0, 1, 2] };
        for &from in froms {
            let fault = match a.changes(Revision(from), None) {
                Err(StoreFailure::Integrity(fault)) => fault,
                other => panic!("lost {lost} from {from}: {other:?}"),
            };
            let want = ("feed-gap", Some("peer:a".to_string()), None, None);
            assert_eq!(place(&fault), want, "lost {lost} from {from}");
            assert_eq!(fault.detail, detail, "lost {lost} from {from}");
        }
        let empty = ChangePage::Ok {
            records: Vec::new(),
            through: Revision(3),
        };
        assert_eq!(a.changes(Revision(3), None).unwrap(), empty);
        let start = Position {
            history: a.history().unwrap().to_string(),
            revision: Revision(0),
        };
        let mut cursor = follow_feed(a.as_ref(), start.clone()).unwrap();
        match cursor.pull() {
            Err(FeedError::Integrity(fault)) => assert_eq!(fault.detail, detail, "lost {lost}"),
            other => panic!("lost {lost}: the pull answered {other:?}"),
        }
        assert_eq!(cursor.position(), &start);
        assert_eq!(dump(&store), before);
        let faults = store.open_admin().fsck().unwrap().faults;
        assert_eq!(faults.len(), 1);
        assert_eq!(faults[0].detail, detail);
    }
}

#[cfg(test)]
#[test]
fn fsck_reports_every_lost_row_of_one_peer_and_goes_on_to_the_next_holding() {
    let (store, _, t, _, b) = filled();
    damage(&store, |state| {
        state.stored.map.remove(&t.id);
        state.stored.map.remove(&b.id);
    });
    let mut lost = [&t, &b];
    lost.sort_by(|x, y| x.id.cmp(&y.id));
    let mut want: Vec<Place> = lost
        .iter()
        .map(|d| at("claims-unreadable", Some("peer:a"), &d.id, None))
        .collect();
    want.push(at("index-stray", Some("peer:a"), &b.id, Some("e:b")));
    want.push(at("index-stray", Some("peer:a"), &t.id, Some("e:t")));
    assert_eq!(places(&store), want);
}

#[cfg(test)]
#[test]
fn a_row_that_counts_fewer_holders_than_hold_it_is_count_mismatch_holders_by_fsck() {
    let (store, _, t, _, _) = filled();
    damage(&store, |state| {
        state.stored.map.get_mut(&t.id).unwrap().holders.clear();
    });
    let report = store.open_admin().fsck().unwrap();
    assert_eq!(
        report.faults.iter().map(place).collect::<Vec<_>>(),
        [at("count-mismatch", None, &t.id, Some("holders"))]
    );
    assert_eq!(
        report.faults[0].detail,
        "memory store: the row names the holders [] and the peers [peer:a] hold it"
    );
}

#[cfg(test)]
#[test]
fn a_feed_floor_at_the_largest_u64_is_feed_gap_by_fsck_with_records_and_with_none() {
    for clear in [false, true] {
        let (store, _, _, _, _) = filled();
        damage(&store, |state| {
            let feed = &mut state.peers.map.get_mut("peer:a").unwrap().feed;
            feed.floor = u64::MAX;
            if clear {
                feed.records.clear();
            }
        });
        assert_eq!(
            places(&store),
            [("feed-gap", Some("peer:a".to_string()), None, None)],
            "{clear}"
        );
    }
}

#[cfg(test)]
type SharedX = (
    MemoryStore,
    Box<dyn PeerStore>,
    Box<dyn PeerStore>,
    [Delta; 3],
);

/// Peers A and B both hold `x`. A also holds `a`, and B also holds `b`. `fsck` finds nothing.
#[cfg(test)]
fn shared_x() -> SharedX {
    let store = MemoryStore::new();
    let posture = CreatePeerOptions::new(ErasurePosture::Unproven);
    let a = store.create_peer("peer:a", &posture).unwrap();
    let b = store.create_peer("peer:b", &posture).unwrap();
    let (x, only_a, only_b) = (fact("e:x"), fact("e:a"), fact("e:b"));
    add(a.as_ref(), &[&x, &only_a]);
    add(b.as_ref(), &[&x, &only_b]);
    assert_eq!(places(&store), []);
    (store, a, b, [x, only_a, only_b])
}

#[cfg(test)]
fn sorted_deltas(deltas: &[&Delta]) -> Vec<Delta> {
    let mut all: Vec<Delta> = deltas.iter().map(|d| (*d).clone()).collect();
    all.sort_by(|p, q| p.id.cmp(&q.id));
    all
}

#[cfg(test)]
fn fsck_details(store: &MemoryStore) -> Vec<(Place, String)> {
    let report = store.open_admin().fsck().unwrap();
    report
        .faults
        .iter()
        .map(|f| (place(f), f.detail.clone()))
        .collect()
}

#[cfg(test)]
#[test]
fn peers_a_and_b_hold_x_and_the_row_does_not_name_a_so_a_purge_of_x_by_a_fails_with_count_mismatch_holders_and_removes_nothing(
) {
    let (store, a, b, [x, only_a, only_b]) = shared_x();
    damage(&store, |state| {
        state
            .stored
            .map
            .get_mut(&x.id)
            .unwrap()
            .holders
            .remove("peer:a");
    });
    let faults = fsck_details(&store);
    let row = at("count-mismatch", None, &x.id, Some("holders"));
    let detail =
        "memory store: the row names the holders [peer:b] and the peers [peer:a, peer:b] hold it";
    assert_eq!(faults, [(row, detail.to_string())]);
    let feeds = (
        a.changes(Revision(0), None).unwrap(),
        b.changes(Revision(0), None).unwrap(),
    );
    let revisions = (a.read().unwrap().revision(), b.read().unwrap().revision());
    let before = dump(&store);

    let fault = match a.purge(&ids(&[&x])) {
        Err(StoreFailure::Integrity(fault)) => fault,
        other => panic!("{other:?}"),
    };

    let want = at("count-mismatch", Some("peer:a"), &x.id, Some("holders"));
    assert_eq!(place(&fault), want);
    assert_eq!(
        fault.detail,
        "memory store: the row counts this peer 0 times as a holder and this peer holds it"
    );
    assert_eq!(dump(&store), before);
    let (now_a, now_b) = (a.read().unwrap(), b.read().unwrap());
    assert_eq!((now_a.revision(), now_a.count()), (revisions.0, 2));
    assert_eq!((now_b.revision(), now_b.count()), (revisions.1, 2));
    assert_eq!(a.changes(Revision(0), None).unwrap(), feeds.0);
    assert_eq!(b.changes(Revision(0), None).unwrap(), feeds.1);
    let wanted_b = sorted_deltas(&[&x, &only_b]);
    assert_eq!(now_b.get(&ids(&[&x, &only_b])).unwrap(), wanted_b);
    let wanted_a = sorted_deltas(&[&x, &only_a]);
    assert_eq!(now_a.get(&ids(&[&x, &only_a])).unwrap(), wanted_a);
    assert_eq!(now_b.targets(&["e:x".into()]).unwrap(), ids(&[&x]));
    assert_eq!(fsck_details(&store), faults);
}

#[cfg(test)]
#[test]
fn peer_a_alone_holds_x_and_the_row_counts_a_twice_so_a_purge_of_x_by_a_fails_with_count_mismatch_holders_and_removes_nothing(
) {
    let store = MemoryStore::new();
    let posture = CreatePeerOptions::new(ErasurePosture::Unproven);
    let a = store.create_peer("peer:a", &posture).unwrap();
    let b = store.create_peer("peer:b", &posture).unwrap();
    let (x, only_b) = (fact("e:x"), fact("e:b"));
    add(a.as_ref(), &[&x]);
    add(b.as_ref(), &[&only_b]);
    damage(&store, |state| {
        let row = state.stored.map.get_mut(&x.id).unwrap();
        row.holders.insert("peer:a".to_string(), 2);
    });
    let faults = fsck_details(&store);
    let row = at("count-mismatch", None, &x.id, Some("holders"));
    let detail =
        "memory store: the row names the holders [peer:a (2)] and the peers [peer:a] hold it";
    assert_eq!(faults, [(row, detail.to_string())]);
    let revision = a.read().unwrap().revision();
    let before = dump(&store);

    let fault = match a.purge(&ids(&[&x])) {
        Err(StoreFailure::Integrity(fault)) => fault,
        other => panic!("{other:?}"),
    };

    let want = at("count-mismatch", Some("peer:a"), &x.id, Some("holders"));
    assert_eq!(place(&fault), want);
    assert_eq!(
        fault.detail,
        "memory store: the row counts this peer 2 times as a holder and this peer holds it"
    );
    assert_eq!(dump(&store), before);
    let now = a.read().unwrap();
    assert_eq!((now.revision(), now.count()), (revision, 1));
    assert_eq!(now.get(&ids(&[&x])).unwrap(), vec![x.clone()]);
    let there = b.read().unwrap();
    assert_eq!(there.get(&ids(&[&only_b])).unwrap(), vec![only_b.clone()]);
    assert_eq!(fsck_details(&store), faults);
}

/// [gap: a row that does not name another holder is removed by the last named holder's purge; no
/// O(1) check sees it, and `fsck` names it before.]
#[cfg(test)]
#[test]
fn gap_peers_a_and_b_hold_x_and_the_row_does_not_name_b_so_a_purge_of_x_by_a_removes_it_and_b_then_fails_claims_unreadable(
) {
    let (store, a, b, [x, only_a, only_b]) = shared_x();
    damage(&store, |state| {
        state
            .stored
            .map
            .get_mut(&x.id)
            .unwrap()
            .holders
            .remove("peer:b");
    });
    let row = at("count-mismatch", None, &x.id, Some("holders"));
    let detail =
        "memory store: the row names the holders [peer:a] and the peers [peer:a, peer:b] hold it";
    assert_eq!(fsck_details(&store), [(row, detail.to_string())]);
    let revision_b = b.read().unwrap().revision();

    let report = a.purge(&ids(&[&x])).unwrap();

    let removed = PurgeTarget {
        id: x.id.clone(),
        outcome: PurgeOutcome::Removed,
    };
    assert_eq!(report.claim, ErasureClaim::Unproven);
    assert_eq!(report.targets, [removed]);
    let feed_only = [Retained {
        surface: RetainedSurface::ChangeFeed,
    }];
    assert_eq!(report.retains, feed_only);
    let now_b = b.read().unwrap();
    assert_eq!(now_b.revision(), revision_b);
    assert_eq!(
        fault_of(now_b.get(&ids(&[&x]))),
        Ok(at("claims-unreadable", Some("peer:b"), &x.id, None))
    );
    assert_eq!(now_b.get(&ids(&[&only_b])).unwrap(), vec![only_b.clone()]);
    let now_a = a.read().unwrap();
    assert_eq!(
        now_a.get(&ids(&[&x, &only_a])).unwrap(),
        vec![only_a.clone()]
    );
    assert_eq!(
        places(&store),
        [
            at("claims-unreadable", Some("peer:b"), &x.id, None),
            at("index-stray", Some("peer:b"), &x.id, Some("e:x")),
        ]
    );
}

/// [gap: a row that names a peer that does not hold the id makes the purge report
/// `held-by-other-peer`; the row stays.]
#[cfg(test)]
#[test]
fn gap_peer_a_alone_holds_x_and_the_row_also_names_b_so_a_purge_of_x_by_a_keeps_the_row_and_owes_it_and_fsck_names_the_row(
) {
    let store = MemoryStore::new();
    let posture = CreatePeerOptions::new(ErasurePosture::Unproven);
    let a = store.create_peer("peer:a", &posture).unwrap();
    let b = store.create_peer("peer:b", &posture).unwrap();
    let (x, only_b) = (fact("e:x"), fact("e:b"));
    add(a.as_ref(), &[&x]);
    add(b.as_ref(), &[&only_b]);
    damage(&store, |state| {
        let row = state.stored.map.get_mut(&x.id).unwrap();
        row.holders.insert("peer:b".to_string(), 1);
    });
    let row = at("count-mismatch", None, &x.id, Some("holders"));
    let detail =
        "memory store: the row names the holders [peer:a, peer:b] and the peers [peer:a] hold it";
    assert_eq!(fsck_details(&store), [(row, detail.to_string())]);

    let report = a.purge(&ids(&[&x])).unwrap();

    let kept = PurgeTarget {
        id: x.id.clone(),
        outcome: PurgeOutcome::HeldByOtherPeer,
    };
    assert_eq!(report.claim, ErasureClaim::NothingRemoved);
    assert_eq!(report.targets, [kept]);
    let surfaces: Vec<RetainedSurface> = report.retains.iter().map(|r| r.surface).collect();
    let owed = [RetainedSurface::ChangeFeed, RetainedSurface::PurgeDebt];
    assert_eq!(surfaces, owed);
    let stored: Vec<String> = store
        .open_admin()
        .stored_ids()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(stored.contains(&x.id));
    let now = a.read().unwrap();
    assert_eq!((now.count(), now.get(&ids(&[&x])).unwrap()), (0, vec![]));
    let there = b.read().unwrap();
    assert_eq!(
        there.get(&ids(&[&x, &only_b])).unwrap(),
        vec![only_b.clone()]
    );
    let orphan = at("orphan-bytes", None, &x.id, None);
    let detail = "memory store: no peer holds these bytes";
    assert_eq!(fsck_details(&store), [(orphan, detail.to_string())]);
}

/// A small deterministic generator (splitmix64).
#[cfg(test)]
fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

#[cfg(test)]
#[test]
fn over_300_seeded_random_sequences_of_append_head_only_append_and_purge_by_3_peers_with_shared_ids_fsck_is_clean_after_every_step_and_no_purge_fails(
) {
    let mut seen = BTreeSet::new();
    let mut steps = 0;
    for seed in 1..=300u64 {
        let mut rng = seed;
        let mut roll = |n: u64| splitmix(&mut rng) % n;
        let pool: Vec<Delta> = (0..6).map(|i| fact(&format!("e:{}", i % 3))).collect();
        let store = MemoryStore::new();
        let posture = CreatePeerOptions::new(ErasurePosture::Unproven);
        let peers: Vec<Box<dyn PeerStore>> = ["peer:a", "peer:b", "peer:c"]
            .iter()
            .map(|id| store.create_peer(id, &posture).unwrap())
            .collect();
        for step in 0..24 {
            let peer = peers[roll(3) as usize].as_ref();
            let kind = roll(100);
            let chosen: Vec<&Delta> = pool.iter().filter(|_| roll(100) < 40).collect();
            if kind < 55 {
                let deltas: Vec<Delta> = if kind < 45 {
                    chosen.iter().map(|d| (*d).clone()).collect()
                } else {
                    Vec::new()
                };
                let now = peer.read().unwrap();
                let next_head = match (deltas.is_empty(), now.head()) {
                    (true, Some(head)) => head.to_string(),
                    _ => format!("head-{step}"),
                };
                let options = AdmissionOptions {
                    at: 1.0,
                    sender: "local".into(),
                    next_head,
                };
                let batch = admission_of(now.as_ref(), &deltas, options).unwrap();
                let answer = peer.append(&batch).unwrap();
                assert!(matches!(answer, AppendResult::Committed { .. }));
            } else {
                let report = match peer.purge(&ids(&chosen)) {
                    Ok(report) => report,
                    Err(failure) => panic!("seed {seed} step {step}: {failure:?}"),
                };
                seen.extend(report.targets.iter().map(|t| format!("{:?}", t.outcome)));
                seen.extend(report.retains.iter().map(|r| format!("{:?}", r.surface)));
            }
            assert_eq!(places(&store), [], "seed {seed} step {step}");
            steps += 1;
        }
    }
    assert_eq!(steps, 300 * 24);
    let want = [
        "ChangeFeed",
        "HeldByOtherPeer",
        "NotHeld",
        "PurgeDebt",
        "Removed",
    ];
    assert_eq!(seen.iter().map(String::as_str).collect::<Vec<_>>(), want);
}

#[cfg(test)]
fn two_peers() -> (MemoryStore, Box<dyn PeerStore>, Box<dyn PeerStore>) {
    let store = MemoryStore::new();
    let posture = CreatePeerOptions::new(ErasurePosture::Unproven);
    let a = store.create_peer("peer:a", &posture).unwrap();
    let b = store.create_peer("peer:b", &posture).unwrap();
    (store, a, b)
}

#[cfg(test)]
#[test]
fn peer_b_holds_x_and_the_row_names_only_a_once_so_after_a_appends_x_a_purge_of_x_by_a_fails_with_count_mismatch_holders_2_times_and_b_still_reads_x(
) {
    let (store, a, b) = two_peers();
    let (x, only_a, only_b) = (fact("e:x"), fact("e:a"), fact("e:b"));
    add(a.as_ref(), &[&only_a]);
    add(b.as_ref(), &[&x, &only_b]);
    damage(&store, |state| {
        let row = state.stored.map.get_mut(&x.id).unwrap();
        row.holders = BTreeMap::from([("peer:a".to_string(), 1)]);
    });
    add(a.as_ref(), &[&x]);
    let feeds = (
        a.changes(Revision(0), None).unwrap(),
        b.changes(Revision(0), None).unwrap(),
    );
    let revisions = (a.read().unwrap().revision(), b.read().unwrap().revision());
    let before = dump(&store);

    let answer = a.purge(&ids(&[&x]));

    let now_b = b.read().unwrap();
    let read_x = now_b.get(&ids(&[&x]));
    assert!(
        matches!(&read_x, Ok(read) if *read == [x.clone()]),
        "B reads x after A's purge: {read_x:?}; the purge answered {answer:?}"
    );
    let fault = match answer {
        Err(StoreFailure::Integrity(fault)) => fault,
        other => panic!("{other:?}"),
    };
    let want = at("count-mismatch", Some("peer:a"), &x.id, Some("holders"));
    assert_eq!(place(&fault), want);
    assert_eq!(
        fault.detail,
        "memory store: the row counts this peer 2 times as a holder and this peer holds it"
    );
    assert_eq!(dump(&store), before);
    let stored: Vec<String> = store
        .open_admin()
        .stored_ids()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(stored.contains(&x.id));
    let now_a = a.read().unwrap();
    assert_eq!((now_a.revision(), now_a.count()), (revisions.0, 2));
    assert_eq!((now_b.revision(), now_b.count()), (revisions.1, 2));
    assert_eq!(a.changes(Revision(0), None).unwrap(), feeds.0);
    assert_eq!(b.changes(Revision(0), None).unwrap(), feeds.1);
    assert_eq!(now_a.get(&ids(&[&only_a])).unwrap(), vec![only_a.clone()]);
    assert_eq!(now_b.get(&ids(&[&only_b])).unwrap(), vec![only_b.clone()]);
    let row = at("count-mismatch", None, &x.id, Some("holders"));
    let detail =
        "memory store: the row names the holders [peer:a (2)] and the peers [peer:a, peer:b] hold it";
    assert_eq!(fsck_details(&store), [(row, detail.to_string())]);
}

/// [gap: a row that names a holder with a zero count is kept by the purge of its last other
/// holder, with `held-by-other-peer` and `purge-debt`; `fsck` names it before.]
#[cfg(test)]
#[test]
fn gap_peer_a_alone_holds_x_and_the_row_also_names_b_with_a_zero_count_so_a_purge_of_x_by_a_keeps_the_row_and_owes_it_and_fsck_names_the_row(
) {
    let (store, a, b) = two_peers();
    let (x, only_b) = (fact("e:x"), fact("e:b"));
    add(a.as_ref(), &[&x]);
    add(b.as_ref(), &[&only_b]);
    damage(&store, |state| {
        let row = state.stored.map.get_mut(&x.id).unwrap();
        row.holders.insert("peer:b".to_string(), 0);
    });
    let row = at("count-mismatch", None, &x.id, Some("holders"));
    let detail =
        "memory store: the row names the holders [peer:a, peer:b (0)] and the peers [peer:a] hold it";
    assert_eq!(fsck_details(&store), [(row, detail.to_string())]);

    let report = a.purge(&ids(&[&x])).unwrap();

    let kept = PurgeTarget {
        id: x.id.clone(),
        outcome: PurgeOutcome::HeldByOtherPeer,
    };
    assert_eq!(report.claim, ErasureClaim::NothingRemoved);
    assert_eq!(report.targets, [kept]);
    let surfaces: Vec<RetainedSurface> = report.retains.iter().map(|r| r.surface).collect();
    assert_eq!(
        surfaces,
        [RetainedSurface::ChangeFeed, RetainedSurface::PurgeDebt]
    );
    let stored: Vec<String> = store
        .open_admin()
        .stored_ids()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(stored.contains(&x.id));
    let now = a.read().unwrap();
    assert_eq!((now.count(), now.get(&ids(&[&x])).unwrap()), (0, vec![]));
    let there = b.read().unwrap();
    assert_eq!(
        there.get(&ids(&[&x, &only_b])).unwrap(),
        vec![only_b.clone()]
    );
    let orphan = at("orphan-bytes", None, &x.id, None);
    let detail = "memory store: no peer holds these bytes";
    assert_eq!(fsck_details(&store), [(orphan, detail.to_string())]);
}
