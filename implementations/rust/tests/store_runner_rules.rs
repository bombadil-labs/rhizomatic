//! The runner-rules table (`vectors/store/README.md` §7, SPEC-18 §4.11 reading 39). A runner that
//! stops checking a rule still passes the memory store, so each rule of README §3 and §4 has one
//! wrong store here: the memory store behind a thin wrapper (`Rig`) that breaks that rule and
//! nothing a script meets before it. Each row asserts that the conformance run fails, in the
//! expected documents, and that every failure carries the message of that rule. A run that
//! fails for another reason does not count: a script stops at its first failing step, and when a
//! rule's own check is gone a later, unrelated check often catches the same store.
//!
//! The reference rules have a control beside them: the same wrong answer under another
//! `formatVersion` conforms.
//!
//! A store of class `none` is not a runner rule (README §3.4, SPEC-18 §4.11 reading 43): the
//! runner skips every script that purges for it. `a_class_none_store_skips_the_purge_scripts`
//! holds that skip, and that such a store fails a purge step it reaches anyway.
//!
//! Named gaps — rules a wrapped store cannot reach:
//!
//! - **A surface state outside the three.** `SurfaceState` is an enum of three values, so no
//!   store can report a fourth.
//! - **The trim comparison against a wrong store.** The runner takes the held deltas of a scope
//!   case from its own bookkeeping, not from `get`. With held deltas fixed, the case's lower and
//!   upper bounds imply the trim lemma for any answer, so no store can fail the trim comparison
//!   alone. The row reaches it through a wrong document instead: a store that applies no field
//!   (legal), and a case whose exact scope names one id too many.
//! - **An unknown anchor kind, a missing posture, a non-finite number.** `Anchor` has one kind,
//!   `ErasurePosture` two values, and JSON carries no NaN; the runner answers a vector's missing
//!   posture at its own boundary, so no store sees it.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use rhizomatic::memory_store::{MemoryStore, MEMORY_STORE_FORMAT};
use rhizomatic::store::{
    target_entities, Admission, Anchor, AppendResult, ArrivalRecord, ErasureClaim, ErasureClass,
    ErasurePosture, Exporter, Listing, PeerErasure, PeerExporter, PeerStore, PurgeOutcome,
    PurgeReport, PushdownFields, Revision, ScopeRequest, ScopeResult, Snapshot, Store, StoreError,
    StoreErrorCode, StoreProfile, SurfaceState, VerifiedDelta, MAX_ARRIVAL_COUNTER,
};
use rhizomatic::store_conformance::{
    run_store_conformance, SkippedScript, StoreConformanceError, StoreConformanceReport,
    StoreVectors,
};
use rhizomatic::types::Delta;
use serde_json::Value;

/// The one rule a wrapped store breaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wrong {
    Nothing,
    // Refusals.
    CreatePeerCode,
    OpenPeerCode,
    AppendCode,
    QueryCode,
    ExportCode,
    AnswersWhenReleased,
    TargetsRefuse,
    MovedCode,
    // Peers.
    CreatedPosture,
    CreatedClass,
    OpenedPosture,
    CreatesPromisedProof,
    RefusesPromisedProof,
    // Append.
    AppendUncertain,
    AppendConflictsInstead,
    IgnoresHead,
    AppendDropsAdded,
    AppendReversesAdded,
    AppendResultRevision,
    AppendMovesOnRefusal,
    AppendMovesDownOnRefusal,
    AppendMovesOnConflict,
    AppendStaysOnCommit,
    AppendMovesOnNoop,
    // Purge.
    PurgeRefuses,
    PurgeOutcome,
    PurgeOrder,
    PurgeRepeat,
    PurgeRevision,
    PurgeStays,
    PurgeMovesOnNoop,
    PurgeBoundary,
    PurgeClaimsProven,
    PurgeClaimsNothing,
    UnprovenForNothing,
    ProvenWithoutSurface,
    ProvenNotAbsent,
    ReferenceSurfaces,
    // The bookkeeping.
    HoldsLastOfBatch,
    ServesPurged,
    StaleAfterRemoved,
    StaleAfterOtherHolds,
    // Point reads.
    Head,
    HeadEmpty,
    Count,
    GetDrops,
    GetReverses,
    GetSig,
    GetClaims,
    ArrivalsDrop,
    ArrivalsReverse,
    ArrivalAt,
    ArrivalSequence,
    ArrivalTransfer,
    ArrivalSender,
    TargetsDrop,
    TargetsReverse,
    NegatorsDrop,
    NegatorsReverse,
    // Scope members.
    ScopeReverse,
    ScopeRepeat,
    ScopeClaims,
    ScopeSig,
    ScopeArrivalId,
    ScopeArrivalAt,
    ScopeArrivalSequence,
    ScopeArrivalTransfer,
    ScopeArrivalSender,
    ScopeNotHeld,
    // Scope bounds.
    AppliedUnrequested,
    DropsNegators,
    DropsFirst,
    OutsideScope,
    ClaimsPushdown,
    AppliesNothing,
    BoundReachesStore,
    // Reference rules.
    ReferenceAppliesLess,
    ReferenceIgnoresExclude,
    ReferenceIgnoresExcludeUnpushed,
    // Export.
    ExportIdsOther,
    ExportIdsReverse,
    ExportDeltasDrop,
    ExportDeltasReverse,
    ExportDeltasExtra,
    ExportSig,
    ExportClaims,
    StoredDrop,
    PeersReverse,
}

/// What the wrapped store declares about itself.
#[derive(Debug, Clone, Copy)]
struct Setup {
    class: ErasureClass,
    reference: bool,
    journal: bool,
}

const PLAIN: Setup = Setup {
    class: ErasureClass::Unprovable,
    reference: false,
    journal: false,
};
const REFERENCE: Setup = Setup {
    reference: true,
    ..PLAIN
};
const PROVEN: Setup = Setup {
    class: ErasureClass::Proven,
    ..PLAIN
};

/// The rig's own records, shared by every handle of one store.
#[derive(Default)]
struct Books {
    postures: BTreeMap<String, ErasurePosture>,
    /// How far each peer's reported revision runs from the memory store's.
    offsets: BTreeMap<String, i64>,
    /// What each peer purged, as it held it.
    purged: BTreeMap<String, BTreeMap<String, VerifiedDelta>>,
    /// Every entry each peer committed.
    committed: BTreeMap<String, Vec<VerifiedDelta>>,
    /// The last entry of its batch for each id a peer committed.
    last_of_batch: BTreeMap<(String, String), ArrivalRecord>,
    /// The arrival record each peer held an id under when a purge ended that holding, and the
    /// outcome that ended it.
    stale: BTreeMap<(String, String), (PurgeOutcome, ArrivalRecord)>,
}

type Shared = Rc<RefCell<Books>>;

fn refusal(code: StoreErrorCode) -> StoreError {
    StoreError::new(code, "a wrong store refused")
}

fn recode(mut e: StoreError, from: StoreErrorCode, to: StoreErrorCode) -> StoreError {
    if e.code == from {
        e.code = to;
    }
    e
}

fn toggle_sig(delta: &mut Delta) {
    delta.sig = match delta.sig {
        Some(_) => None,
        None => Some("ab".repeat(64)),
    };
}

fn listing<'a, T: 'a>(items: Result<Vec<T>, StoreError>) -> Listing<'a, T> {
    match items {
        Ok(items) => Box::new(items.into_iter().map(Ok)),
        Err(e) => Box::new(std::iter::once(Err(e))),
    }
}

/// Inserts a member where the ascending order puts it, unless the answer has it.
fn insert_sorted(answer: &mut ScopeResult, member: VerifiedDelta) {
    let ids: Vec<&str> = answer.deltas.iter().map(|m| m.delta.id.as_str()).collect();
    if let Err(at) = ids.binary_search(&member.delta.id.as_str()) {
        answer.deltas.insert(at, member);
    }
}

struct Rig {
    inner: Rc<MemoryStore>,
    wrong: Wrong,
    setup: Setup,
    profile: StoreProfile,
    books: Shared,
}

impl Rig {
    fn new(wrong: Wrong, setup: Setup) -> Self {
        let inner = match wrong {
            Wrong::ReferenceAppliesLess => MemoryStore::with_pushdown(PushdownFields::default()),
            _ => MemoryStore::new(),
        };
        let mut profile = inner.profile().clone();
        profile.capabilities.erasure = setup.class;
        profile.capabilities.journal = setup.journal;
        profile.pushdown = MemoryStore::new().profile().pushdown;
        if !setup.reference {
            profile.format_version = "rhizomatic.test.wrong/1".into();
        }
        assert_eq!(
            profile.format_version == MEMORY_STORE_FORMAT,
            setup.reference
        );
        Self {
            inner: Rc::new(inner),
            wrong,
            setup,
            profile,
            books: Shared::default(),
        }
    }

    fn handle(&self, id: &str, inner: Box<dyn PeerStore>, opened: bool) -> Box<dyn PeerStore> {
        Box::new(RigPeer {
            inner,
            id: id.to_string(),
            wrong: self.wrong,
            setup: self.setup,
            opened,
            books: self.books.clone(),
        })
    }
}

impl Store for Rig {
    fn profile(&self) -> &StoreProfile {
        &self.profile
    }

    fn create_peer(&self, id: &str, e: ErasurePosture) -> Result<Box<dyn PeerStore>, StoreError> {
        if self.wrong == Wrong::RefusesPromisedProof && e == ErasurePosture::Proven {
            return Err(refusal(StoreErrorCode::PostureRefused));
        }
        // The memory store takes no peer that promises proof. A proven rig records the promise.
        let promised =
            self.setup.class == ErasureClass::Proven || self.wrong == Wrong::CreatesPromisedProof;
        let asked = if promised {
            ErasurePosture::Unproven
        } else {
            e
        };
        let inner = self
            .inner
            .create_peer(id, asked)
            .map_err(|e| match self.wrong {
                Wrong::CreatePeerCode => recode(e.clone(), e.code, StoreErrorCode::PeerAbsent),
                _ => e,
            })?;
        self.books.borrow_mut().postures.insert(id.to_string(), e);
        Ok(self.handle(id, inner, false))
    }

    fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
        let inner = self.inner.peer(id).map_err(|e| match self.wrong {
            Wrong::OpenPeerCode => {
                recode(e, StoreErrorCode::PeerAbsent, StoreErrorCode::PeerExists)
            }
            _ => e,
        })?;
        Ok(self.handle(id, inner, true))
    }

    fn open_admin(&self) -> Box<dyn Exporter> {
        Box::new(RigExporter {
            inner: self.inner.clone(),
            wrong: self.wrong,
        })
    }

    fn close(&self) {
        self.inner.close()
    }
}

struct RigPeer {
    inner: Box<dyn PeerStore>,
    id: String,
    wrong: Wrong,
    setup: Setup,
    opened: bool,
    books: Shared,
}

impl RigPeer {
    fn inner_revision(&self) -> Result<Revision, StoreError> {
        let mut snapshot = self.inner.read()?;
        let revision = snapshot.revision();
        snapshot.release();
        Ok(revision)
    }

    fn revision(&self, inner: Revision) -> Revision {
        let offset = self.books.borrow().offsets.get(&self.id).copied();
        Revision((inner.0 as i64 + offset.unwrap_or(0)) as u64)
    }

    fn shift(&self, by: i64) {
        *self
            .books
            .borrow_mut()
            .offsets
            .entry(self.id.clone())
            .or_default() += by;
    }

    /// Moves the reported revision when the rule says so, given the memory store's move.
    fn moved(&self, stays: Wrong, moves: Wrong, before: Revision, after: Revision) {
        if self.wrong == stays && after > before {
            self.shift(before.0 as i64 - after.0 as i64);
        }
        if self.wrong == moves && after == before {
            self.shift(1);
        }
    }
}

impl PeerStore for RigPeer {
    fn id(&self) -> &str {
        &self.id
    }

    fn erasure(&self) -> PeerErasure {
        let mut posture = self.books.borrow().postures[&self.id];
        let flip = self.wrong == Wrong::CreatedPosture
            || (self.wrong == Wrong::OpenedPosture && self.opened);
        if flip {
            posture = match posture {
                ErasurePosture::Proven => ErasurePosture::Unproven,
                ErasurePosture::Unproven => ErasurePosture::Proven,
            };
        }
        let store_class = match (self.wrong, self.setup.class) {
            (Wrong::CreatedClass, ErasureClass::None) => ErasureClass::Unprovable,
            (Wrong::CreatedClass, _) => ErasureClass::None,
            (_, class) => class,
        };
        PeerErasure {
            posture,
            store_class,
        }
    }

    fn read(&self) -> Result<Box<dyn Snapshot>, StoreError> {
        let inner = self.inner.read()?;
        let books = self.books.borrow();
        let others = books
            .committed
            .iter()
            .filter(|(peer, _)| **peer != self.id)
            .flat_map(|(_, entries)| entries.iter().cloned())
            .collect();
        let last = books
            .last_of_batch
            .iter()
            .filter(|((peer, _), _)| *peer == self.id)
            .map(|((_, id), arrival)| (id.clone(), arrival.clone()))
            .collect();
        let purged = books
            .purged
            .get(&self.id)
            .map(|ghosts| ghosts.values().cloned().collect())
            .unwrap_or_default();
        let ended = match self.wrong {
            Wrong::StaleAfterRemoved => Some(PurgeOutcome::Removed),
            Wrong::StaleAfterOtherHolds => Some(PurgeOutcome::HeldByOtherPeer),
            _ => None,
        };
        let stale = books
            .stale
            .iter()
            .filter(|((peer, _), (outcome, _))| *peer == self.id && Some(*outcome) == ended)
            .map(|((_, id), (_, arrival))| (id.clone(), arrival.clone()))
            .collect();
        drop(books);
        Ok(Box::new(RigSnapshot {
            revision: self.revision(inner.revision()),
            inner,
            wrong: self.wrong,
            others,
            last,
            purged,
            stale,
        }))
    }

    fn append(&self, batch: &Admission) -> Result<AppendResult, StoreError> {
        let mut batch = batch.clone();
        if self.wrong == Wrong::IgnoresHead {
            batch.expected_head = self.inner.read()?.head().map(str::to_string);
        }
        let before = self.inner_revision()?;
        let result = self.inner.append(&batch);
        let after = self.inner_revision()?;
        match result {
            Err(e) => {
                if self.wrong == Wrong::AppendMovesOnRefusal {
                    self.shift(1);
                }
                if self.wrong == Wrong::AppendMovesDownOnRefusal && self.revision(after).0 > 0 {
                    self.shift(-1);
                }
                Err(match (self.wrong, e.code) {
                    (Wrong::AppendCode, StoreErrorCode::InvalidAdmission) => recode(
                        e,
                        StoreErrorCode::InvalidAdmission,
                        StoreErrorCode::InvalidRequest,
                    ),
                    (Wrong::AppendCode, code) => recode(e, code, StoreErrorCode::InvalidAdmission),
                    _ => e,
                })
            }
            Ok(AppendResult::Conflict) => {
                if self.wrong == Wrong::AppendMovesOnConflict {
                    self.shift(1);
                }
                Ok(AppendResult::Conflict)
            }
            Ok(AppendResult::Committed {
                revision,
                mut added,
            }) => {
                let mut books = self.books.borrow_mut();
                for id in &added {
                    if let Some(ghosts) = books.purged.get_mut(&self.id) {
                        ghosts.remove(id);
                    }
                    let mut entries = batch.added.iter().filter(|e| e.delta.id == *id);
                    let first = entries.next().expect("an added id is in the batch").clone();
                    let last = entries.next_back().unwrap_or(&first).arrival.clone();
                    books
                        .committed
                        .entry(self.id.clone())
                        .or_default()
                        .push(first);
                    books
                        .last_of_batch
                        .insert((self.id.clone(), id.clone()), last);
                }
                drop(books);
                self.moved(
                    Wrong::AppendStaysOnCommit,
                    Wrong::AppendMovesOnNoop,
                    before,
                    after,
                );
                let mut revision = self.revision(revision);
                match self.wrong {
                    Wrong::AppendResultRevision => revision.0 += 1,
                    Wrong::AppendUncertain => {
                        return Ok(AppendResult::Uncertain {
                            fault: "a wrong store does not know".into(),
                        })
                    }
                    Wrong::AppendConflictsInstead => return Ok(AppendResult::Conflict),
                    Wrong::AppendDropsAdded => {
                        added.pop();
                    }
                    Wrong::AppendReversesAdded => added.reverse(),
                    _ => {}
                }
                Ok(AppendResult::Committed { revision, added })
            }
            uncertain => uncertain,
        }
    }

    fn purge(&self, ids: &[String]) -> Result<PurgeReport, StoreError> {
        if self.setup.class == ErasureClass::None {
            return Err(refusal(StoreErrorCode::CapabilityAbsent));
        }
        if self.wrong == Wrong::PurgeRefuses {
            return Err(refusal(StoreErrorCode::InvalidRequest));
        }
        let mut snapshot = self.inner.read()?;
        let deltas = snapshot.get(ids)?;
        let arrivals = snapshot.arrivals(ids)?;
        snapshot.release();
        let before = self.inner_revision()?;
        let mut report = self.inner.purge(ids)?;
        let after = self.inner_revision()?;

        let mut books = self.books.borrow_mut();
        for target in &report.targets {
            let ended = matches!(
                target.outcome,
                PurgeOutcome::Removed | PurgeOutcome::HeldByOtherPeer
            );
            if let Some(arrival) = arrivals
                .iter()
                .find(|a| a.id == target.id)
                .filter(|_| ended)
            {
                books.stale.insert(
                    (self.id.clone(), target.id.clone()),
                    (target.outcome, arrival.clone()),
                );
            }
        }
        let ghosts = books.purged.entry(self.id.clone()).or_default();
        for (delta, arrival) in deltas.into_iter().zip(arrivals) {
            ghosts.insert(delta.id.clone(), VerifiedDelta { delta, arrival });
        }
        drop(books);
        self.moved(Wrong::PurgeStays, Wrong::PurgeMovesOnNoop, before, after);
        report.revision = self.revision(report.revision);

        let removed = report
            .targets
            .iter()
            .any(|t| t.outcome == PurgeOutcome::Removed);
        if self.setup.class == ErasureClass::Proven {
            for surface in &mut report.surfaces {
                surface.state = SurfaceState::Absent;
            }
            report.claim = match removed {
                true => ErasureClaim::Proven,
                false => ErasureClaim::NothingRemoved,
            };
        }
        match self.wrong {
            Wrong::PurgeOutcome => {
                for target in &mut report.targets {
                    target.outcome = match target.outcome {
                        PurgeOutcome::HeldByOtherPeer => PurgeOutcome::NotHeld,
                        PurgeOutcome::NotHeld => PurgeOutcome::HeldByOtherPeer,
                        removed => removed,
                    };
                }
            }
            Wrong::PurgeOrder => report.targets.reverse(),
            Wrong::PurgeRepeat => {
                if let Some(first) = report.targets.first().cloned() {
                    report.targets.push(first);
                }
            }
            Wrong::PurgeRevision => report.revision.0 += 1,
            Wrong::PurgeBoundary => report.boundary = "store-controlled".into(),
            Wrong::PurgeClaimsProven => report.claim = ErasureClaim::Proven,
            Wrong::PurgeClaimsNothing if report.claim == ErasureClaim::Unproven => {
                report.claim = ErasureClaim::NothingRemoved
            }
            Wrong::UnprovenForNothing if report.claim == ErasureClaim::NothingRemoved => {
                report.claim = ErasureClaim::Unproven
            }
            Wrong::ProvenWithoutSurface if removed => report.surfaces.clear(),
            Wrong::ProvenNotAbsent if removed => {
                if let Some(last) = report.surfaces.last_mut() {
                    last.state = SurfaceState::Unprovable;
                }
            }
            Wrong::ReferenceSurfaces => {
                report.surfaces.pop();
            }
            _ => {}
        }
        Ok(report)
    }
}

struct RigSnapshot {
    inner: Box<dyn Snapshot>,
    revision: Revision,
    wrong: Wrong,
    /// Entries other peers committed.
    others: Vec<VerifiedDelta>,
    last: BTreeMap<String, ArrivalRecord>,
    purged: Vec<VerifiedDelta>,
    /// For the stale rules: the record a purge ended, for each id held again since.
    stale: BTreeMap<String, ArrivalRecord>,
}

impl RigSnapshot {
    fn answer<T>(
        &self,
        result: Result<T, StoreError>,
        empty: impl FnOnce() -> T,
    ) -> Result<T, StoreError> {
        let e = match result {
            Ok(answer) => return Ok(answer),
            Err(e) => e,
        };
        Err(match (self.wrong, e.code) {
            (Wrong::AnswersWhenReleased, StoreErrorCode::SnapshotReleased) => return Ok(empty()),
            (Wrong::QueryCode, StoreErrorCode::SnapshotReleased) => recode(
                e,
                StoreErrorCode::SnapshotReleased,
                StoreErrorCode::PeerAbsent,
            ),
            (Wrong::MovedCode, StoreErrorCode::SnapshotMoved) => {
                recode(e, StoreErrorCode::SnapshotMoved, StoreErrorCode::PeerAbsent)
            }
            _ => e,
        })
    }

    /// Whether this peer holds an id at the snapshot.
    fn holds(&self, id: &str) -> bool {
        self.inner
            .get(&[id.to_string()])
            .map(|held| !held.is_empty())
            .unwrap_or(true)
    }

    /// Changes one field of a record `arrivals` returns (`scope` false) or a scope member's.
    fn change_arrival(&self, scope: bool, arrival: &mut ArrivalRecord) {
        match (scope, self.wrong) {
            (false, Wrong::ArrivalAt) | (true, Wrong::ScopeArrivalAt) => arrival.at += 0.5,
            (false, Wrong::ArrivalSequence) | (true, Wrong::ScopeArrivalSequence) => {
                arrival.sequence += 1000
            }
            (false, Wrong::ArrivalTransfer) | (true, Wrong::ScopeArrivalTransfer) => {
                arrival.transfer += 1000
            }
            (false, Wrong::ArrivalSender) | (true, Wrong::ScopeArrivalSender) => {
                arrival.sender.push('!')
            }
            (true, Wrong::ScopeArrivalId) => arrival.id = "1e20".into(),
            _ => {}
        }
    }

    fn last_of_batch(&self, arrival: &mut ArrivalRecord) {
        if self.wrong == Wrong::HoldsLastOfBatch {
            if let Some(last) = self.last.get(&arrival.id) {
                *arrival = last.clone();
            }
        }
        if let Some(old) = self.stale.get(&arrival.id) {
            *arrival = old.clone();
        }
    }
}

fn reorder<T>(wrong: Wrong, drop: Wrong, reverse: Wrong, items: &mut Vec<T>) {
    if wrong == drop {
        items.pop();
    }
    if wrong == reverse {
        items.reverse();
    }
}

impl Snapshot for RigSnapshot {
    fn revision(&self) -> Revision {
        self.revision
    }

    fn head(&self) -> Option<&str> {
        match self.wrong {
            Wrong::Head => Some("a-head-nobody-wrote"),
            Wrong::HeadEmpty => self.inner.head().or(Some("")),
            _ => self.inner.head(),
        }
    }

    fn count(&self) -> u64 {
        self.inner.count() + u64::from(self.wrong == Wrong::Count)
    }

    fn get(&self, ids: &[String]) -> Result<Vec<Delta>, StoreError> {
        let mut deltas = self.answer(self.inner.get(ids), Vec::new)?;
        reorder(self.wrong, Wrong::GetDrops, Wrong::GetReverses, &mut deltas);
        if let Some(first) = deltas.first_mut() {
            match self.wrong {
                Wrong::GetSig => toggle_sig(first),
                Wrong::GetClaims => first.claims.timestamp += 1.0,
                _ => {}
            }
        }
        Ok(deltas)
    }

    fn arrivals(&self, ids: &[String]) -> Result<Vec<ArrivalRecord>, StoreError> {
        let mut records = self.answer(self.inner.arrivals(ids), Vec::new)?;
        records.iter_mut().for_each(|r| self.last_of_batch(r));
        reorder(
            self.wrong,
            Wrong::ArrivalsDrop,
            Wrong::ArrivalsReverse,
            &mut records,
        );
        if let Some(first) = records.first_mut() {
            self.change_arrival(false, first);
        }
        Ok(records)
    }

    fn targets(&self, entities: &[String]) -> Result<Vec<String>, StoreError> {
        if self.wrong == Wrong::TargetsRefuse {
            return Err(refusal(StoreErrorCode::InvalidRequest));
        }
        let mut ids = self.answer(self.inner.targets(entities), Vec::new)?;
        reorder(
            self.wrong,
            Wrong::TargetsDrop,
            Wrong::TargetsReverse,
            &mut ids,
        );
        Ok(ids)
    }

    fn negators(&self, ids: &[String]) -> Result<Vec<String>, StoreError> {
        let mut found = self.answer(self.inner.negators(ids), Vec::new)?;
        reorder(
            self.wrong,
            Wrong::NegatorsDrop,
            Wrong::NegatorsReverse,
            &mut found,
        );
        Ok(found)
    }

    fn scope(&self, request: &ScopeRequest) -> Result<ScopeResult, StoreError> {
        let mut asked = request.clone();
        match self.wrong {
            Wrong::OutsideScope => asked.anchors.push(Anchor::Entity {
                entity: "elsewhere".into(),
            }),
            Wrong::ClaimsPushdown | Wrong::AppliesNothing => {
                // An illegal bound is still refused; a legal one is dropped.
                self.inner.scope(request)?;
                asked.pushdown = None;
            }
            Wrong::ReferenceIgnoresExclude => asked.exclude.clear(),
            Wrong::ReferenceIgnoresExcludeUnpushed if asked.pushdown.is_none() => {
                asked.exclude.clear()
            }
            Wrong::BoundReachesStore => {
                if let Some(pushdown) = &mut asked.pushdown {
                    pushdown.arrival_at_most =
                        pushdown.arrival_at_most.map(|n| n.min(MAX_ARRIVAL_COUNTER));
                }
            }
            _ => {}
        }
        let empty = || ScopeResult {
            deltas: Vec::new(),
            applied: PushdownFields::default(),
        };
        let mut answer = self.answer(self.inner.scope(&asked), empty)?;
        let requested = request.pushdown.clone().unwrap_or_default();
        let entities: BTreeSet<&str> = request
            .anchors
            .iter()
            .map(|Anchor::Entity { entity }| entity.as_str())
            .collect();
        match self.wrong {
            Wrong::DropsNegators => answer.deltas.retain(|member| {
                let mut pointers = member.delta.claims.pointers.iter();
                !pointers.any(|p| p.role == "negates")
            }),
            Wrong::ClaimsPushdown => {
                answer.applied = PushdownFields {
                    timestamp_at_most: requested.timestamp_at_most.is_some(),
                    arrival_at_most: requested.arrival_at_most.is_some(),
                    exclude_ids: requested.exclude_ids.is_some(),
                }
            }
            Wrong::AppliesNothing => answer.applied = PushdownFields::default(),
            Wrong::AppliedUnrequested => {
                answer.applied = PushdownFields {
                    timestamp_at_most: true,
                    arrival_at_most: true,
                    exclude_ids: true,
                }
            }
            Wrong::DropsFirst if !answer.deltas.is_empty() => {
                answer.deltas.remove(0);
            }
            Wrong::ScopeReverse => answer.deltas.reverse(),
            Wrong::ScopeRepeat => {
                if let Some(first) = answer.deltas.first().cloned() {
                    answer.deltas.insert(0, first);
                }
            }
            Wrong::ScopeNotHeld => {
                let stranger = self.others.iter().find(|m| {
                    !target_entities(&m.delta.claims).is_disjoint(&entities)
                        && !self.holds(&m.delta.id)
                });
                if let Some(stranger) = stranger {
                    insert_sorted(&mut answer, stranger.clone());
                }
            }
            Wrong::ServesPurged => {
                for ghost in &self.purged {
                    let anchored = !target_entities(&ghost.delta.claims).is_disjoint(&entities);
                    if anchored && !self.holds(&ghost.delta.id) {
                        insert_sorted(&mut answer, ghost.clone());
                    }
                }
            }
            _ => {}
        }
        for member in &mut answer.deltas {
            self.last_of_batch(&mut member.arrival);
        }
        if let Some(first) = answer.deltas.first_mut() {
            match self.wrong {
                Wrong::ScopeClaims => first.delta.claims.timestamp += 1.0,
                Wrong::ScopeSig => toggle_sig(&mut first.delta),
                _ => self.change_arrival(true, &mut first.arrival),
            }
        }
        Ok(answer)
    }

    fn release(&mut self) {
        self.inner.release()
    }
}

struct RigExporter {
    inner: Rc<MemoryStore>,
    wrong: Wrong,
}

impl Exporter for RigExporter {
    fn peers(&self) -> Listing<'_, String> {
        let mut peers: Result<Vec<String>, _> = self.inner.open_admin().peers().collect();
        if let (Ok(peers), Wrong::PeersReverse) = (&mut peers, self.wrong) {
            peers.reverse();
        }
        listing(peers)
    }

    fn peer(&self, id: &str) -> Result<Box<dyn PeerExporter>, StoreError> {
        let inner = self
            .inner
            .open_admin()
            .peer(id)
            .map_err(|e| match self.wrong {
                Wrong::ExportCode => {
                    recode(e, StoreErrorCode::PeerAbsent, StoreErrorCode::PeerExists)
                }
                _ => e,
            })?;
        Ok(Box::new(RigPeerExporter {
            inner,
            store: self.inner.clone(),
            wrong: self.wrong,
        }))
    }

    fn stored_ids(&self) -> Listing<'_, String> {
        let mut ids: Result<Vec<String>, _> = self.inner.open_admin().stored_ids().collect();
        if let (Ok(ids), Wrong::StoredDrop) = (&mut ids, self.wrong) {
            ids.pop();
        }
        listing(ids)
    }
}

struct RigPeerExporter {
    inner: Box<dyn PeerExporter>,
    store: Rc<MemoryStore>,
    wrong: Wrong,
}

impl PeerExporter for RigPeerExporter {
    fn ids(&self) -> Listing<'_, String> {
        let mut ids: Result<Vec<String>, _> = match self.wrong {
            Wrong::ExportIdsOther => self.store.open_admin().stored_ids().collect(),
            _ => self.inner.ids().collect(),
        };
        if let (Ok(ids), Wrong::ExportIdsReverse) = (&mut ids, self.wrong) {
            ids.reverse();
        }
        listing(ids)
    }

    fn deltas(&self) -> Listing<'_, Delta> {
        let mut deltas: Result<Vec<Delta>, _> = self.inner.deltas().collect();
        if let Ok(deltas) = &mut deltas {
            reorder(
                self.wrong,
                Wrong::ExportDeltasDrop,
                Wrong::ExportDeltasReverse,
                deltas,
            );
            if let (Some(first), Wrong::ExportDeltasExtra) = (deltas.first().cloned(), self.wrong) {
                deltas.push(first);
            }
            if let Some(first) = deltas.first_mut() {
                match self.wrong {
                    Wrong::ExportSig => toggle_sig(first),
                    Wrong::ExportClaims => first.claims.timestamp += 1.0,
                    _ => {}
                }
            }
        }
        listing(deltas)
    }
}

fn load(file: &str) -> Value {
    let path = format!("{}/../../vectors/store/{file}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("read store vectors")).unwrap()
}

fn vectors() -> StoreVectors {
    StoreVectors {
        scripts: load("scripts.json"),
        scope: load("scope.json"),
    }
}

fn run_with(
    wrong: Wrong,
    setup: Setup,
    vectors: &StoreVectors,
) -> Result<StoreConformanceReport, StoreConformanceError> {
    run_store_conformance(
        &|| Ok(Box::new(Rig::new(wrong, setup)) as Box<dyn Store>),
        vectors,
    )
}

/// A scope case whose exact scope names one id the selection drops: an id of the scope with no
/// field pushed down that is neither in the exact scope nor held.
fn one_id_too_many(vectors: &mut StoreVectors) {
    for case in vectors.scope["cases"].as_array_mut().unwrap() {
        let held: Vec<Value> = case["held"].as_array().unwrap().clone();
        let scopes = case["scopes"].as_array().unwrap();
        let all = scopes
            .iter()
            .map(|s| s["fields"].as_array().unwrap().len())
            .max()
            .unwrap();
        let none = scopes
            .iter()
            .find(|s| s["fields"].as_array().unwrap().is_empty());
        let exact = scopes
            .iter()
            .position(|s| s["fields"].as_array().unwrap().len() == all && all > 0);
        let (Some(none), Some(exact)) = (none, exact) else {
            continue;
        };
        let exact_ids = scopes[exact]["ids"].as_array().unwrap();
        let extra = none["ids"]
            .as_array()
            .unwrap()
            .iter()
            .find(|id| !exact_ids.contains(id) && !held.contains(id))
            .cloned();
        if let Some(extra) = extra {
            case["scopes"][exact]["ids"]
                .as_array_mut()
                .unwrap()
                .push(extra);
            return;
        }
    }
    panic!("no scope case has an id the selection drops");
}

fn unknown_scripts_format(vectors: &mut StoreVectors) {
    vectors.scripts["format"] = "rhizomatic-store-scripts/0".into();
}

fn unknown_scope_format(vectors: &mut StoreVectors) {
    vectors.scope["format"] = "rhizomatic-store-scope/0".into();
}

/// A corpus id that does not recompute, on an entry not marked `forged`.
fn an_id_that_does_not_recompute(vectors: &mut StoreVectors) {
    for entry in vectors.scripts["deltas"].as_array_mut().unwrap() {
        if entry.get("forged").is_none() {
            let id = entry["id"].as_str().unwrap().to_string();
            entry["id"] = format!("{id}00").into();
            return;
        }
    }
}

/// The first purge step of every script, for the claim rows.
fn first_claims(vectors: &mut StoreVectors) -> Vec<&mut serde_json::Map<String, Value>> {
    vectors.scripts["scripts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .filter_map(|script| {
            let steps = script["steps"].as_array_mut().unwrap();
            let purge = steps.iter_mut().find(|step| step["op"] == "purge")?;
            purge["expect"]["claim"].as_object_mut()
        })
        .collect()
}

/// A `claim` that also names class `none`.
fn a_claim_with_another_key(vectors: &mut StoreVectors) {
    for claim in first_claims(vectors) {
        claim.insert("none".into(), "nothing-removed".into());
    }
}

/// A `claim` without its `proven` key; the runner of an unprovable store never reads that key.
fn a_claim_without_a_key(vectors: &mut StoreVectors) {
    for claim in first_claims(vectors) {
        claim.remove("proven");
    }
}

/// A script that requires a name outside the allow-list.
fn an_unknown_requirement(vectors: &mut StoreVectors) {
    vectors.scripts["scripts"][0]["requires"] = serde_json::json!(["values"]);
}

struct Row {
    rule: &'static str,
    wrong: Wrong,
    setup: Setup,
    /// A wrong document, for the rules no wrong store reaches.
    doc: Option<fn(&mut StoreVectors)>,
    /// Every failure carries one of these, and each appears at least once.
    messages: &'static [&'static str],
    /// The documents that fail: `scripts`, `scope`, or both.
    docs: &'static [&'static str],
}

const S: &[&str] = &["scripts"];
const C: &[&str] = &["scope"];
const SC: &[&str] = &["scripts", "scope"];

const fn row(
    rule: &'static str,
    wrong: Wrong,
    setup: Setup,
    messages: &'static [&'static str],
    docs: &'static [&'static str],
) -> Row {
    Row {
        rule,
        wrong,
        setup,
        doc: None,
        messages,
        docs,
    }
}

const fn doc_row(
    rule: &'static str,
    wrong: Wrong,
    doc: fn(&mut StoreVectors),
    messages: &'static [&'static str],
    docs: &'static [&'static str],
) -> Row {
    Row {
        rule,
        wrong,
        setup: PLAIN,
        doc: Some(doc),
        messages,
        docs,
    }
}

use Wrong as W;

const TABLE: &[Row] = &[
    // Refusals (README §3 "Refusals", §3.7).
    row(
        "createPeer: a refusal code outside the list",
        W::CreatePeerCode,
        PLAIN,
        &["createPeer: expected a refusal"],
        S,
    ),
    row(
        "openPeer: a refusal code outside the list",
        W::OpenPeerCode,
        PLAIN,
        &["openPeer: expected a refusal"],
        S,
    ),
    row(
        "append: a refusal code outside the list",
        W::AppendCode,
        PLAIN,
        &["append: expected a refusal"],
        S,
    ),
    row(
        "query: a refusal code outside the list",
        W::QueryCode,
        PLAIN,
        &["expected a refusal `snapshot-released`"],
        S,
    ),
    row(
        "export: a refusal code outside the list",
        W::ExportCode,
        PLAIN,
        &["export: expected a refusal"],
        S,
    ),
    row(
        "query: an answer where a refusal is expected",
        W::AnswersWhenReleased,
        PLAIN,
        &["expected a refusal `snapshot-released`, the store answered"],
        S,
    ),
    row(
        "query: a refusal where an answer is expected",
        W::TargetsRefuse,
        PLAIN,
        &["targets: the store refused `invalid-request`"],
        S,
    ),
    row(
        "query: a moved snapshot refuses with another code",
        W::MovedCode,
        PLAIN,
        &["the store refused `peer-absent`"],
        S,
    ),
    row(
        "scope: a bound the type holds reaches the store",
        W::BoundReachesStore,
        PLAIN,
        &[
            "scope: expected a refusal `invalid-request`, the store answered",
            "scope: expected a refusal `invalid-request`, the store refused `snapshot-moved`",
        ],
        S,
    ),
    // Peers (§3.1, §3.2).
    row(
        "createPeer: another posture",
        W::CreatedPosture,
        PLAIN,
        &["createPeer: the new peer reports posture"],
        SC,
    ),
    row(
        "createPeer: another erasure class",
        W::CreatedClass,
        PLAIN,
        &["createPeer: the new peer reports erasure class"],
        SC,
    ),
    row(
        "openPeer: another posture",
        W::OpenedPosture,
        PLAIN,
        &["openPeer: the opened peer does not report the posture"],
        SC,
    ),
    row(
        "unlessStoreErasure: an unprovable store creates the peer",
        W::CreatesPromisedProof,
        PLAIN,
        &["createPeer: expected a refusal `posture-refused`, the store answered"],
        S,
    ),
    row(
        "unlessStoreErasure: a proven store refuses the peer",
        W::RefusesPromisedProof,
        PROVEN,
        &["createPeer refused `posture-refused`"],
        S,
    ),
    // Append (§3.3).
    row(
        "append: uncertain",
        W::AppendUncertain,
        PLAIN,
        &["append: expected status `committed`, the store answered Uncertain"],
        SC,
    ),
    row(
        "append: conflict where committed",
        W::AppendConflictsInstead,
        PLAIN,
        &["append: expected status `committed`, the store answered Conflict"],
        SC,
    ),
    row(
        "append: committed where conflict",
        W::IgnoresHead,
        PLAIN,
        &[
            "append: expected status `conflict`, the store answered Committed",
            "append refused `invalid-admission`",
        ],
        S,
    ),
    row(
        "append: the added ids",
        W::AppendDropsAdded,
        PLAIN,
        &["append added: expected ids"],
        SC,
    ),
    row(
        "append: the order of the added ids",
        W::AppendReversesAdded,
        PLAIN,
        &["append added: expected ids"],
        SC,
    ),
    row(
        "append: the result's revision",
        W::AppendResultRevision,
        PLAIN,
        &["the append result's revision"],
        SC,
    ),
    row(
        "append: a refusal moves the revision",
        W::AppendMovesOnRefusal,
        PLAIN,
        &["append: the revision changed"],
        S,
    ),
    row(
        "append: a refusal moves the revision down",
        W::AppendMovesDownOnRefusal,
        PLAIN,
        &["append: the revision changed"],
        S,
    ),
    row(
        "append: a conflict moves the revision",
        W::AppendMovesOnConflict,
        PLAIN,
        &["append: the revision changed"],
        S,
    ),
    row(
        "append: revisionAdvanced true without an advance",
        W::AppendStaysOnCommit,
        PLAIN,
        &["append: the revision did not advance"],
        SC,
    ),
    row(
        "append: revisionAdvanced false with an advance",
        W::AppendMovesOnNoop,
        PLAIN,
        &["append: the revision changed"],
        S,
    ),
    // Purge (§3.4).
    row(
        "purge: a refusal",
        W::PurgeRefuses,
        PLAIN,
        &["purge refused `invalid-request`"],
        S,
    ),
    row(
        "purge: the outcomes",
        W::PurgeOutcome,
        PLAIN,
        &["purge targets: expected"],
        S,
    ),
    row(
        "purge: the order of the targets",
        W::PurgeOrder,
        PLAIN,
        &["purge targets: expected"],
        S,
    ),
    row(
        "purge: a repeated target",
        W::PurgeRepeat,
        PLAIN,
        &["purge targets: expected"],
        S,
    ),
    row(
        "purge: the report's revision",
        W::PurgeRevision,
        PLAIN,
        &["the purge report's revision"],
        S,
    ),
    row(
        "purge: revisionAdvanced true without an advance",
        W::PurgeStays,
        PLAIN,
        &["purge: the revision did not advance"],
        S,
    ),
    row(
        "purge: revisionAdvanced false with an advance",
        W::PurgeMovesOnNoop,
        PLAIN,
        &["purge: the revision changed"],
        S,
    ),
    row(
        "purge: the boundary text",
        W::PurgeBoundary,
        PLAIN,
        &["the purge report's boundary is `store-controlled`"],
        S,
    ),
    row(
        "purge: proven from an unprovable store",
        W::PurgeClaimsProven,
        PLAIN,
        &["the store claimed `proven`"],
        S,
    ),
    row(
        "purge: nothing-removed where unproven",
        W::PurgeClaimsNothing,
        PLAIN,
        &["expected claim `unproven`, the store claimed `nothing-removed`"],
        S,
    ),
    row(
        "purge: unproven where nothing-removed",
        W::UnprovenForNothing,
        PLAIN,
        &["expected claim `nothing-removed`, the store claimed `unproven`"],
        S,
    ),
    row(
        "purge: proven with no surface",
        W::ProvenWithoutSurface,
        PROVEN,
        &["claims `proven` without a surface"],
        S,
    ),
    row(
        "purge: proven with a surface not absent",
        W::ProvenNotAbsent,
        PROVEN,
        &["claims `proven` without a surface, or with one that is not absent"],
        S,
    ),
    row(
        "purge: the reference surfaces",
        W::ReferenceSurfaces,
        REFERENCE,
        &["reference surfaces: expected"],
        S,
    ),
    // The bookkeeping (§3.3).
    row(
        "bookkeeping: the first entry of a batch is held",
        W::HoldsLastOfBatch,
        PLAIN,
        &["first admitted (field `"],
        S,
    ),
    row(
        "bookkeeping: a purge forgets the id",
        W::ServesPurged,
        PLAIN,
        &["scope: the store answered"],
        S,
    ),
    row(
        "bookkeeping: an id appended again after `removed` has its new record",
        W::StaleAfterRemoved,
        PLAIN,
        &["first admitted (field `"],
        S,
    ),
    row(
        "bookkeeping: an id appended again after `held-by-other-peer` has its new record",
        W::StaleAfterOtherHolds,
        PLAIN,
        &["first admitted (field `"],
        S,
    ),
    // Point reads (§3.6, §3.7).
    row(
        "head",
        W::Head,
        PLAIN,
        &[
            "expected head",
            "append: expected a refusal `invalid-admission`, the store answered",
        ],
        S,
    ),
    row(
        "head: a new peer's head is null, not the empty string",
        W::HeadEmpty,
        PLAIN,
        &[
            "expected head None",
            "append: expected a refusal `invalid-admission`, the store answered",
        ],
        S,
    ),
    row("count", W::Count, PLAIN, &["expected count"], S),
    row(
        "get: the ids",
        W::GetDrops,
        PLAIN,
        &["get: expected ids"],
        S,
    ),
    row(
        "get: the order",
        W::GetReverses,
        PLAIN,
        &["get: expected ids"],
        S,
    ),
    row("get: the signature", W::GetSig, PLAIN, &["get: delta"], S),
    row(
        "get: the claims",
        W::GetClaims,
        PLAIN,
        &["get: the claims of delta"],
        S,
    ),
    row(
        "arrivals: the ids",
        W::ArrivalsDrop,
        PLAIN,
        &["arrivals: expected ids"],
        S,
    ),
    row(
        "arrivals: the order",
        W::ArrivalsReverse,
        PLAIN,
        &["arrivals: expected ids"],
        S,
    ),
    row(
        "arrivals: the field at",
        W::ArrivalAt,
        PLAIN,
        &["arrivals: the arrival record of", "(field `at`)"],
        S,
    ),
    row(
        "arrivals: the field sequence",
        W::ArrivalSequence,
        PLAIN,
        &["(field `sequence`)"],
        S,
    ),
    row(
        "arrivals: the field transfer",
        W::ArrivalTransfer,
        PLAIN,
        &["(field `transfer`)"],
        S,
    ),
    row(
        "arrivals: the field sender",
        W::ArrivalSender,
        PLAIN,
        &["(field `sender`)"],
        S,
    ),
    row(
        "targets: the ids",
        W::TargetsDrop,
        PLAIN,
        &["targets: expected ids"],
        S,
    ),
    row(
        "targets: the order",
        W::TargetsReverse,
        PLAIN,
        &["targets: expected ids"],
        S,
    ),
    row(
        "negators: the ids",
        W::NegatorsDrop,
        PLAIN,
        &["negators: expected ids"],
        S,
    ),
    row(
        "negators: the order",
        W::NegatorsReverse,
        PLAIN,
        &["negators: expected ids"],
        S,
    ),
    // Scope members (§3.7, §4).
    row(
        "scope: the order",
        W::ScopeReverse,
        PLAIN,
        &["scope: the answer is not ascending by id"],
        SC,
    ),
    row("scope: a repeat", W::ScopeRepeat, PLAIN, &["twice"], SC),
    row(
        "scope: the claims",
        W::ScopeClaims,
        PLAIN,
        &["scope: the claims of delta"],
        SC,
    ),
    row(
        "scope: the signature",
        W::ScopeSig,
        PLAIN,
        &["scope: delta"],
        SC,
    ),
    row(
        "scope: the arrival record's id",
        W::ScopeArrivalId,
        PLAIN,
        &["(field `id`)"],
        SC,
    ),
    row(
        "scope: the arrival field at",
        W::ScopeArrivalAt,
        PLAIN,
        &["scope: member", "(field `at`)"],
        SC,
    ),
    row(
        "scope: the arrival field sequence",
        W::ScopeArrivalSequence,
        PLAIN,
        &["(field `sequence`)"],
        SC,
    ),
    row(
        "scope: the arrival field transfer",
        W::ScopeArrivalTransfer,
        PLAIN,
        &["(field `transfer`)"],
        SC,
    ),
    row(
        "scope: the arrival field sender",
        W::ScopeArrivalSender,
        PLAIN,
        &["(field `sender`)"],
        SC,
    ),
    row(
        "scope: a member the peer does not hold",
        W::ScopeNotHeld,
        PLAIN,
        &["scope: the store answered"],
        SC,
    ),
    // Scope bounds (§3.7, §4).
    row(
        "scope: applied is a subset of requested",
        W::AppliedUnrequested,
        PLAIN,
        &["applied that was not requested"],
        SC,
    ),
    row(
        "scope: the lower bound",
        W::DropsNegators,
        PLAIN,
        &["script lower bound", "case lower bound"],
        SC,
    ),
    row(
        "scope: the lower bound, its first id",
        W::DropsFirst,
        PLAIN,
        &["script lower bound", "case lower bound"],
        SC,
    ),
    row(
        "scope: the upper bound",
        W::OutsideScope,
        PLAIN,
        &["script upper bound", "case upper bound"],
        SC,
    ),
    row(
        "scope case: the exact upper bound",
        W::ClaimsPushdown,
        PLAIN,
        &["fails a field reported applied"],
        C,
    ),
    doc_row(
        "scope case: the trim comparison",
        W::AppliesNothing,
        one_id_too_many,
        &["trim lemma"],
        C,
    ),
    // Reference rules (§3.4, §3.7, §4).
    row(
        "reference: the applied fields",
        W::ReferenceAppliesLess,
        REFERENCE,
        &[
            "reference (script): the applied fields",
            "reference (case): the applied fields",
        ],
        SC,
    ),
    row(
        "reference: the exact ids",
        W::ReferenceIgnoresExclude,
        REFERENCE,
        &["reference (script) scope", "reference (case) scope"],
        SC,
    ),
    row(
        "reference: the exact ids of a step with no pushdown",
        W::ReferenceIgnoresExcludeUnpushed,
        REFERENCE,
        &["reference (script) scope", "reference (case) scope"],
        SC,
    ),
    // Export (§3.8).
    row(
        "export: the ids",
        W::ExportIdsOther,
        PLAIN,
        &["export ids: expected ids"],
        S,
    ),
    row(
        "export: the order of the ids",
        W::ExportIdsReverse,
        PLAIN,
        &["export ids: expected ids"],
        S,
    ),
    row(
        "export: the count of deltas",
        W::ExportDeltasDrop,
        PLAIN,
        &["export: ids lists"],
        S,
    ),
    row(
        "export: more deltas than ids",
        W::ExportDeltasExtra,
        PLAIN,
        &["export: ids lists"],
        S,
    ),
    row(
        "export: each delta is the named appearance",
        W::ExportDeltasReverse,
        PLAIN,
        &["export: expected delta"],
        S,
    ),
    row(
        "export: a delta's signature",
        W::ExportSig,
        PLAIN,
        &["export: delta"],
        S,
    ),
    row(
        "export: a delta's claims",
        W::ExportClaims,
        PLAIN,
        &["export: the claims of delta"],
        S,
    ),
    row(
        "exportStored: the ids",
        W::StoredDrop,
        PLAIN,
        &["storedIds: expected ids"],
        S,
    ),
    row(
        "exportPeers: the peers",
        W::PeersReverse,
        PLAIN,
        &["peers: expected ids"],
        S,
    ),
    // Documents (§2).
    doc_row(
        "documents: an unknown scripts format",
        W::Nothing,
        unknown_scripts_format,
        &["the file is not rhizomatic-store-scripts/1"],
        &["scripts"],
    ),
    doc_row(
        "documents: an unknown scope format",
        W::Nothing,
        unknown_scope_format,
        &["the file is not rhizomatic-store-scope/1"],
        &["scope"],
    ),
    doc_row(
        "documents: a corpus id that does not recompute",
        W::Nothing,
        an_id_that_does_not_recompute,
        &["the id does not recompute"],
        &["scripts"],
    ),
    doc_row(
        "documents: a purge claim with another key",
        W::Nothing,
        a_claim_with_another_key,
        &["purge: the document's `claim` has the keys"],
        &["scripts"],
    ),
    doc_row(
        "documents: a purge claim without one of its keys",
        W::Nothing,
        a_claim_without_a_key,
        &["purge: the document's `claim` has the keys"],
        &["scripts"],
    ),
    doc_row(
        "documents: an unknown script requirement",
        W::Nothing,
        an_unknown_requirement,
        &["unknown script requirement `values`"],
        &["scripts"],
    ),
];

/// What is wrong with one row's run, or nothing.
fn judge(row: &Row) -> Option<String> {
    let mut vectors = vectors();
    if let Some(doc) = row.doc {
        doc(&mut vectors);
    }
    let error = match run_with(row.wrong, row.setup, &vectors) {
        Ok(report) => {
            return Some(format!(
                "passed {} with nothing failed",
                report.passed.len()
            ))
        }
        Err(error) => error,
    };
    let mut problems = Vec::new();
    for failure in &error.failures {
        if !row.messages.iter().any(|m| failure.message.contains(m)) {
            problems.push(format!(
                "{} failed for another reason: {}",
                failure.name, failure.message
            ));
        }
    }
    for message in row.messages {
        if !error.failures.iter().any(|f| f.message.contains(message)) {
            problems.push(format!("no failure carries {message:?}"));
        }
    }
    let docs: BTreeSet<&str> = error
        .failures
        .iter()
        .map(|f| f.name.split('/').next().unwrap())
        .collect();
    if docs != row.docs.iter().copied().collect() {
        problems.push(format!("failed in {docs:?}, expected {:?}", row.docs));
    }
    (!problems.is_empty()).then(|| problems.join("\n    "))
}

#[test]
fn every_runner_rule_fails_its_wrong_store() {
    let red: Vec<String> = TABLE
        .iter()
        .filter_map(|row| judge(row).map(|problem| format!("{}: {problem}", row.rule)))
        .collect();
    assert!(
        red.is_empty(),
        "{} of {} runner rules did not hold:\n  {}",
        red.len(),
        TABLE.len(),
        red.join("\n  ")
    );
}

#[test]
fn every_wrong_store_in_the_table_is_distinct() {
    let mut seen = BTreeSet::new();
    for row in TABLE {
        assert!(seen.insert(row.rule), "{} is listed twice", row.rule);
    }
}

/// The controls: a faithful rig passes in every setup the table uses, a store that applies no
/// field passes, and each reference rule's wrong answer conforms under another format version.
#[test]
fn the_same_answers_conform_where_no_rule_forbids_them() {
    let vectors = vectors();
    let controls = [
        (W::Nothing, PLAIN),
        (W::Nothing, REFERENCE),
        (W::Nothing, PROVEN),
        (W::AppliesNothing, PLAIN),
        (W::ReferenceAppliesLess, PLAIN),
        (W::ReferenceIgnoresExclude, PLAIN),
        (W::ReferenceIgnoresExcludeUnpushed, PLAIN),
        (W::ReferenceSurfaces, PLAIN),
    ];
    for (wrong, setup) in controls {
        let report = run_with(wrong, setup, &vectors)
            .unwrap_or_else(|failures| panic!("{wrong:?} {setup:?}: {failures}"));
        assert_eq!(
            (report.passed.len(), report.skipped.len()),
            (21 + 15, 0),
            "{wrong:?}"
        );
    }
}

const PURGE_SCRIPTS: [&str; 5] = [
    "scripts/purge",
    "scripts/purge-clears-a-debt-on-append",
    "scripts/a-snapshot-across-a-purge",
    "scripts/the-last-sequence-survives-a-purge",
    "scripts/the-last-sequence-survives-an-empty-peer",
];

fn skipped(names: &[&str], missing: &str) -> Vec<SkippedScript> {
    names
        .iter()
        .map(|name| SkippedScript {
            name: name.to_string(),
            missing: missing.to_string(),
        })
        .collect()
}

/// README §3 and §3.4: the runner skips exactly the scripts that require `purge` for a store of
/// class `none`, and reports them. A purge step that reaches such a store anyway, in a script
/// that does not require `purge`, fails: the claim has no expectation for class `none`.
///
/// The rig here is a stand-in, not a store of this crate: Rust has no store of class `none`, so
/// README §6 test 8 (such a store refuses every purge) has nothing to test. The stand-in's own
/// refusal is asserted only so the skip below is measured against a store that would refuse.
#[test]
fn a_class_none_store_skips_the_purge_scripts() {
    let none = Setup {
        class: ErasureClass::None,
        ..PLAIN
    };
    let store = Rig::new(W::Nothing, none);
    let peer = store
        .create_peer("peer:a", ErasurePosture::Unproven)
        .unwrap();
    assert_eq!(
        peer.purge(&["1e20".to_string()]).err().map(|e| e.code),
        Some(StoreErrorCode::CapabilityAbsent)
    );

    let report = run_with(W::Nothing, none, &vectors()).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(report.skipped, skipped(&PURGE_SCRIPTS, "purge"));
    assert_eq!(report.passed.len(), 21 + 15 - PURGE_SCRIPTS.len());
    assert!(report
        .passed
        .iter()
        .all(|name| !PURGE_SCRIPTS.contains(&name.as_str())));

    let mut unguarded = vectors();
    for script in unguarded.scripts["scripts"].as_array_mut().unwrap() {
        script.as_object_mut().unwrap().remove("requires");
    }
    let error = run_with(W::Nothing, none, &unguarded).expect_err("a purge step must fail");
    let failed: Vec<&str> = error.failures.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(failed, PURGE_SCRIPTS, "{error}");
    assert!(error
        .failures
        .iter()
        .all(|f| f.message.contains("purge refused `capability-absent`")));
}

/// README §3: a store with a journal skips the script that requires its absence, and only it.
#[test]
fn a_store_with_a_journal_skips_the_journal_absent_script() {
    let journal = Setup {
        journal: true,
        ..PLAIN
    };
    let report = run_with(W::Nothing, journal, &vectors()).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        report.skipped,
        skipped(&["scripts/a-frame-needs-the-journal"], "journal-absent")
    );
    assert_eq!(report.passed.len(), 21 + 15 - 1);
}

/// README §3: each script runs on a new, empty store. A factory that hands out one store again
/// fails at the first peer a second script creates.
#[test]
fn each_script_gets_a_new_store() {
    let one = Rc::new(Rig::new(W::Nothing, PLAIN));
    struct Again(Rc<Rig>);
    impl Store for Again {
        fn profile(&self) -> &StoreProfile {
            self.0.profile()
        }
        fn create_peer(
            &self,
            id: &str,
            e: ErasurePosture,
        ) -> Result<Box<dyn PeerStore>, StoreError> {
            self.0.create_peer(id, e)
        }
        fn peer(&self, id: &str) -> Result<Box<dyn PeerStore>, StoreError> {
            self.0.peer(id)
        }
        fn open_admin(&self) -> Box<dyn Exporter> {
            self.0.open_admin()
        }
        fn close(&self) {}
    }
    let error = run_store_conformance(
        &|| Ok(Box::new(Again(one.clone())) as Box<dyn Store>),
        &vectors(),
    )
    .expect_err("a reused store must fail");
    assert_eq!(
        error.report.passed.first().map(String::as_str),
        Some("scripts/peers-and-postures")
    );
    assert!(
        error
            .failures
            .iter()
            .any(|f| f.message.contains("createPeer refused `peer-exists`")),
        "{error}"
    );
}
