//! The store interface (SPEC-18 proposal §4, slice 1): one logical contract that every store
//! implements, with declared capabilities. The traits are synchronous. Handles own what they
//! need, so a snapshot outlives later appends and answers `snapshot-moved` or the old revision.
//! Every list a store returns is ascending by the bytes of the id, with no id twice.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::set::{DeltaSet, DeltaSource};
use crate::types::{Claims, Delta, Target};

/// Receiver-local arrival testimony for one held delta (SPEC-6 vNext §3). The store keeps it
/// beside the holding, so it is defined here; `arrival` plans it.
#[derive(Debug, Clone, PartialEq)]
pub struct ArrivalRecord {
    pub id: String,
    pub at: f64,
    pub sequence: u64,
    pub transfer: u64,
    pub sender: String,
}

/// Why a store refused (SPEC-18 §4.11 reading 2). The strings are shared vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum StoreErrorCode {
    StoreClosed,
    UnknownScheme,
    InvalidUrl,
    SchemeExists,
    OpenFailed,
    CapabilityAbsent,
    PeerAbsent,
    PeerExists,
    PostureRefused,
    InvalidAdmission,
    InvalidRequest,
    SnapshotMoved,
    SnapshotReleased,
}

impl StoreErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StoreClosed => "store-closed",
            Self::UnknownScheme => "unknown-scheme",
            Self::InvalidUrl => "invalid-url",
            Self::SchemeExists => "scheme-exists",
            Self::OpenFailed => "open-failed",
            Self::CapabilityAbsent => "capability-absent",
            Self::PeerAbsent => "peer-absent",
            Self::PeerExists => "peer-exists",
            Self::PostureRefused => "posture-refused",
            Self::InvalidAdmission => "invalid-admission",
            Self::InvalidRequest => "invalid-request",
            Self::SnapshotMoved => "snapshot-moved",
            Self::SnapshotReleased => "snapshot-released",
        }
    }
}

/// A refusal: a code from the shared vocabulary and a message for a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub code: StoreErrorCode,
    pub message: String,
}

impl StoreError {
    pub fn new(code: StoreErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&format!("{}: {}", self.code.as_str(), self.message))
    }
}

impl std::error::Error for StoreError {}

/// What a peer promises about erasure. Fixed when the peer is created (SPEC-18 §4.7.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErasurePosture {
    Proven,
    Unproven,
}

impl ErasurePosture {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Proven => "proven",
            Self::Unproven => "unproven",
        }
    }
}

/// What a store can prove about physical absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErasureClass {
    Proven,
    Unprovable,
    None,
}

impl ErasureClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Proven => "proven",
            Self::Unprovable => "unprovable",
            Self::None => "none",
        }
    }
}

/// The posture a peer declared and the store's class, both recorded at creation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerErasure {
    pub posture: ErasurePosture,
    pub store_class: ErasureClass,
}

/// One boolean per pushdown field: what a profile offers, or what one scope answer applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PushdownFields {
    pub timestamp_at_most: bool,
    pub arrival_at_most: bool,
    pub exclude_ids: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreCapabilities {
    pub values: bool,
    pub arrival: bool,
    pub journal: bool,
    pub views: bool,
    pub derived_indexes: bool,
    pub digest: bool,
    pub erasure: ErasureClass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreWriters {
    OneProcess,
    ManyProcesses,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtRest {
    Trusted,
    Untrusted,
}

/// How long the change feed keeps records. `None` means the store serves no change feed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeRetention {
    None,
    Unbounded,
    Revisions(u64),
}

/// What a store declares about itself (SPEC-18 §4.8). A store never claims a capability it
/// would implement by scanning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreProfile {
    pub capabilities: StoreCapabilities,
    pub indexed_value_roles: Vec<String>,
    pub pushdown: PushdownFields,
    pub writers: StoreWriters,
    pub at_rest: AtRest,
    pub change_retention: ChangeRetention,
    pub format_version: String,
}

/// A capability a host can require at open (SPEC-18 §4.11 reading 11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum StoreRequirement {
    Values,
    Arrival,
    Journal,
    Views,
    DerivedIndexes,
    Digest,
    Changes,
    Purge,
    ErasureProven,
}

impl StoreRequirement {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Values => "values",
            Self::Arrival => "arrival",
            Self::Journal => "journal",
            Self::Views => "views",
            Self::DerivedIndexes => "derivedIndexes",
            Self::Digest => "digest",
            Self::Changes => "changes",
            Self::Purge => "purge",
            Self::ErasureProven => "erasure-proven",
        }
    }

    pub fn holds(self, profile: &StoreProfile) -> bool {
        let c = &profile.capabilities;
        match self {
            Self::Values => c.values,
            Self::Arrival => c.arrival,
            Self::Journal => c.journal,
            Self::Views => c.views,
            Self::DerivedIndexes => c.derived_indexes,
            Self::Digest => c.digest,
            Self::Changes => profile.change_retention != ChangeRetention::None,
            Self::Purge => c.erasure != ErasureClass::None,
            Self::ErasureProven => c.erasure == ErasureClass::Proven,
        }
    }
}

/// The requirements this profile does not meet, in the order asked, each once.
pub fn missing_requirements(
    profile: &StoreProfile,
    requires: &[StoreRequirement],
) -> Vec<StoreRequirement> {
    let mut missing = Vec::new();
    for r in requires {
        if !r.holds(profile) && !missing.contains(r) {
            missing.push(*r);
        }
    }
    missing
}

/// A peer-local value that increases with each commit that changes the holdings or the head.
/// Only its order inside one peer is contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Revision(pub u64);

/// Anything a store can turn into delta ids from an index (SPEC-18 §4.7.1). Slice 1 has entity
/// anchors only, so no store can meet a kind it has no index for. When a kind is added, a store
/// without its index refuses it with `capability-absent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Anchor {
    Entity { entity: String },
}

/// A selection the store may apply itself (SPEC-18 §4.3). An absent field does not select.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Pushdown {
    /// Signed creation time at most this.
    pub timestamp_at_most: Option<f64>,
    /// Arrival sequence at this peer at most this.
    pub arrival_at_most: Option<u64>,
    /// Ids the selection drops. A negation chain stops at a dropped id.
    pub exclude_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ScopeRequest {
    pub anchors: Vec<Anchor>,
    pub pushdown: Option<Pushdown>,
    /// Ids the read already holds. The store may leave them out of the answer; negation chains
    /// still run through them.
    pub exclude: Vec<String>,
}

/// A delta with the arrival record of the peer that holds it.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedDelta {
    pub delta: Delta,
    pub arrival: ArrivalRecord,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScopeResult {
    pub deltas: Vec<VerifiedDelta>,
    /// The requested pushdown fields the store applied. The host applies the rest.
    pub applied: PushdownFields,
}

/// One append (SPEC-18 §4.5): a head compare-and-set and the deltas admission verified.
#[derive(Debug, Clone, PartialEq)]
pub struct Admission {
    pub expected_head: Option<String>,
    pub next_head: String,
    pub frame: Option<Vec<u8>>,
    pub added: Vec<VerifiedDelta>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppendResult {
    /// `added` names the ids the peer newly holds.
    Committed {
        revision: Revision,
        added: Vec<String>,
    },
    /// The peer's head was not the expected head. Nothing changed.
    Conflict,
    /// The commit may or may not have happened. The caller reopens and replans.
    Uncertain { fault: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErasureClaim {
    Proven,
    Unproven,
}

impl ErasureClaim {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Proven => "proven",
            Self::Unproven => "unproven",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurgeOutcome {
    Removed,
    HeldByOtherPeer,
    NotHeld,
}

impl PurgeOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Removed => "removed",
            Self::HeldByOtherPeer => "held-by-other-peer",
            Self::NotHeld => "not-held",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceState {
    Absent,
    Owed,
    Unprovable,
}

impl SurfaceState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Owed => "owed",
            Self::Unprovable => "unprovable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurgeTarget {
    pub id: String,
    pub outcome: PurgeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurgeSurface {
    pub surface: String,
    pub state: SurfaceState,
}

/// The only boundary a purge report states: the files and objects the store controls.
pub const PURGE_BOUNDARY: &str = "store-controlled-surfaces";

/// What one purge did (SPEC-18 §4.7.2). `proven` needs a proven store and every surface absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurgeReport {
    pub claim: ErasureClaim,
    pub boundary: String,
    pub revision: Revision,
    pub targets: Vec<PurgeTarget>,
    pub surfaces: Vec<PurgeSurface>,
}

/// A whole-store or whole-peer listing. Reading it costs the surface it lists.
pub type Listing<'a, T> = Box<dyn Iterator<Item = Result<T, StoreError>> + 'a>;

/// One store: shared delta bytes, and one logical store per peer (SPEC-18 §4.1).
pub trait Store {
    fn profile(&self) -> &StoreProfile;
    /// Makes a peer with no holdings. Refuses `posture-refused` and `peer-exists`.
    fn create_peer(
        &self,
        id: &str,
        erasure: ErasurePosture,
    ) -> Result<Box<dyn PeerStore>, StoreError>;
    /// Opens an existing peer. Refuses `peer-absent`; never creates.
    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError>;
    /// Whole-store operations. The serving path never receives one.
    fn open_admin(&self) -> Box<dyn Exporter>;
    /// Every later operation on the store and its handles refuses `store-closed`.
    fn close(&self);
}

/// One peer's logical store. Its operations never return another peer's ids.
pub trait PeerStore {
    fn id(&self) -> &str;
    fn erasure(&self) -> PeerErasure;
    /// A repeatable view at the peer's current revision.
    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError>;
    /// Atomic and idempotent by id. A refusal commits nothing.
    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError>;
    /// The only operation that removes a delta from a peer.
    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError>;
}

/// A view of one peer at one revision (SPEC-18 §4.2). `revision`, `head` and `count` are fixed
/// at read and never refuse. Once the peer has moved, every other operation refuses
/// `snapshot-moved` or answers as of the snapshot's revision, never from the later state.
pub trait Snapshot {
    fn revision(&self) -> Revision;
    fn head(&self) -> Option<&str>;
    fn count(&self) -> u64;
    /// The held deltas among `ids`, each with the signature this peer admitted.
    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreError>;
    /// This peer's arrival record for each held id among `ids`.
    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError>;
    /// Ids of held deltas with a pointer at one of these entities, any role or context.
    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreError>;
    /// Ids of held deltas that directly negate one of `ids`, held or not.
    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError>;
    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreError>;
    /// Ends the snapshot. Every later query refuses `snapshot-released`.
    fn release(&mut self);
}

/// Whole-store operations (SPEC-18 §4.7.6). O(surface) by definition.
pub trait Exporter {
    fn peers(&self) -> Listing<'_, String>;
    /// One peer's holdings. Refuses `peer-absent` here or when the listing is read.
    fn peer(&self, id: &str) -> Result<Box<dyn PeerExporter>, StoreError>;
    /// Every id the store keeps bytes for, once each. It names other peers' deltas, so nothing
    /// may use it to choose what one peer purges or serves.
    fn stored_ids(&self) -> Listing<'_, String>;
}

pub trait PeerExporter {
    fn ids(&self) -> Listing<'_, String>;
    /// Each member as this peer admitted it.
    fn deltas(&self) -> Listing<'_, Delta>;
}

/// The entities these claims point at, each once.
pub fn target_entities(claims: &Claims) -> BTreeSet<&str> {
    claims
        .pointers
        .iter()
        .filter_map(|p| match &p.target {
            Target::Entity(e) => Some(e.id.as_str()),
            _ => None,
        })
        .collect()
}

/// The delta ids these claims directly negate, each once (SPEC-1 §7).
pub fn negated_ids(claims: &Claims) -> BTreeSet<&str> {
    claims
        .pointers
        .iter()
        .filter_map(|p| match &p.target {
            Target::Delta(d) if p.role == "negates" => Some(d.delta.as_str()),
            _ => None,
        })
        .collect()
}

/// A synchronous delta source over the members one read has fetched (SPEC-18 §4.2). It answers
/// `get`, `targets` and `negators` restricted to the fetched set, and each member's arrival
/// record. Code that must evaluate synchronously fetches once, then reads this.
#[derive(Debug, Clone, Default)]
pub struct ScopeSource {
    set: DeltaSet,
    arrivals: BTreeMap<String, ArrivalRecord>,
    targets: BTreeMap<String, BTreeSet<String>>,
    negators: BTreeMap<String, BTreeSet<String>>,
}

impl ScopeSource {
    /// Adds members from another round. A member already present keeps its first appearance.
    /// Refuses a member whose id does not recompute from its claims.
    pub fn extend(&mut self, members: &[VerifiedDelta]) -> Result<(), StoreError> {
        for member in members {
            let added = self.set.add(member.delta.clone()).map_err(|reason| {
                StoreError::new(
                    StoreErrorCode::InvalidRequest,
                    format!("a scope member is not content-addressed: {reason}"),
                )
            })?;
            if !added {
                continue;
            }
            let id = &member.delta.id;
            self.arrivals.insert(id.clone(), member.arrival.clone());
            for entity in target_entities(&member.delta.claims) {
                self.targets
                    .entry(entity.to_string())
                    .or_default()
                    .insert(id.clone());
            }
            for negated in negated_ids(&member.delta.claims) {
                self.negators
                    .entry(negated.to_string())
                    .or_default()
                    .insert(id.clone());
            }
        }
        Ok(())
    }

    pub fn arrival(&self, id: &str) -> Option<&ArrivalRecord> {
        self.arrivals.get(id)
    }

    /// Every fetched id, ascending.
    pub fn ids(&self) -> Vec<&str> {
        self.set.ids()
    }

    pub fn len(&self) -> usize {
        self.set.len()
    }

    pub fn is_empty(&self) -> bool {
        self.set.is_empty()
    }
}

/// Builds a [`ScopeSource`] over fetched members (`ScopeResult::deltas`, one or several rounds).
pub fn scope_source(members: &[VerifiedDelta]) -> Result<ScopeSource, StoreError> {
    let mut source = ScopeSource::default();
    source.extend(members)?;
    Ok(source)
}

fn sorted(index: &BTreeMap<String, BTreeSet<String>>, key: &str) -> Vec<String> {
    index
        .get(key)
        .map(|ids| ids.iter().cloned().collect())
        .unwrap_or_default()
}

impl DeltaSource for ScopeSource {
    fn get(&self, id: &str) -> Option<&Delta> {
        self.set.get(id)
    }

    fn targets(&self, entity: &str) -> Vec<String> {
        sorted(&self.targets, entity)
    }

    fn negators(&self, id: &str) -> Vec<String> {
        sorted(&self.negators, id)
    }

    fn subset(&self, ids: &[String]) -> DeltaSet {
        self.set.subset(ids)
    }
}
