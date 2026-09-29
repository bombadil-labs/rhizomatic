//! Typed signed-loose ordinary and effective-erasure admission over an atomic append journal.

use std::collections::{BTreeMap, BTreeSet};

use crate::arrival::ArrivalRecord;
use crate::delta::compute_id;
use crate::durable_state::{
    empty_durable_peer_state, encode_durable_peer_state, plan_permanent_commit_from_verified,
    validate_transition, DurablePeerState, PermanentCommitInput, PermanentErasure,
};
use crate::erasure_filter::{plan_erasure_filter, ErasureAuthority, ErasureOrderCandidate};
use crate::hash::content_address;
use crate::ordinary_journal::{
    encode_ordinary_journal_checkpoint, encode_ordinary_peer_frame, OrdinaryJournalCheckpoint,
    OrdinaryPeerFrame,
};
use crate::ordinary_quota::{plan_ordinary_quota, OrdinaryQuotaUnit};
use crate::peer_identity::is_canonical_peer_id;
use crate::permanent_journal::{
    apply_permanent_peer_frame, decode_permanent_journal_rebase, encode_permanent_journal_rebase,
    encode_permanent_peer_frame, replay_permanent_peer_frames, PermanentJournalRebase,
    PermanentPeerFrame,
};
use crate::preflight::{
    preflight_transfer, CandidateGuard, GuardedUnitStatus, PreflightContext, TransferUnit,
};
use crate::set::DeltaSet;
use crate::signed_loose_admission::{
    plan_signed_loose_ordinary_transfer_from_verified, SignedLooseOutcome,
    SignedLooseOutcomeStatus, SignedLooseTransferInput,
};
use crate::single_peer::{ArrivalOrigin, PeerImageWrite, SinglePeerTransferInput, TransferMode};
use crate::types::{Delta, Target};

#[derive(Debug, Clone, PartialEq)]
pub enum OrdinaryJournalRead {
    Empty,
    RowsWithoutJournal,
    Journal {
        head: String,
        frames: Vec<Vec<u8>>,
        checkpoint: Option<Vec<u8>>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrdinaryJournalHead {
    Head(String),
    Missing,
}

#[derive(Debug, Clone)]
pub struct AdmittedRowRead {
    pub id: String,
    pub row: Option<Delta>,
    pub fault: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnavailableAdmittedRow {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErasureJournalWrite {
    Durable,
    Conflict,
    CommittedUnconfirmed { fault: String },
    AbsenceRefuted { target_id: String },
}

impl From<PeerImageWrite> for ErasureJournalWrite {
    fn from(value: PeerImageWrite) -> Self {
        match value {
            PeerImageWrite::Durable => Self::Durable,
            PeerImageWrite::Conflict => Self::Conflict,
            PeerImageWrite::CommittedUnconfirmed { fault } => Self::CommittedUnconfirmed { fault },
        }
    }
}

/// Consistent open, immutable committed frames, cheap head read, atomic head/frame/row CAS.
pub trait DurableOrdinaryJournalStore {
    fn read_journal(&self, peer_id: &str) -> Result<OrdinaryJournalRead, String>;
    /// Return exactly the stored rows for these admitted ids; extras outside the list stay external.
    fn read_admitted_rows(&self, peer_id: &str, ids: &[String]) -> Result<Vec<Delta>, String>;
    /// Isolate per-row faults for a writable degraded open; return one result per requested id.
    fn read_admitted_rows_degraded(
        &self,
        _peer_id: &str,
        _ids: &[String],
    ) -> Result<Vec<AdmittedRowRead>, String> {
        Err("ordinary journal: degraded row read unsupported by store".into())
    }
    fn read_head(&self, peer_id: &str) -> Result<OrdinaryJournalHead, String>;
    /// On empty create (expected_head = None), compare both absent head and absence of rows.
    fn compare_and_append(
        &mut self,
        peer_id: &str,
        expected_head: Option<&str>,
        next_head: &str,
        frame: Option<&[u8]>,
        newly_admitted: &[Delta],
    ) -> Result<PeerImageWrite, String>;
    /// Atomically append erasure orders while proving every asserted-absent target is absent
    /// from this peer's complete storage surface. A conservative true creates purge debt.
    fn compare_and_append_erasure(
        &mut self,
        _peer_id: &str,
        _expected_head: &str,
        _next_head: &str,
        _frame: &[u8],
        _newly_admitted: &[Delta],
        _asserted_absent_target_ids: &[String],
    ) -> Result<ErasureJournalWrite, String> {
        Err("permanent journal: erasure CAS unsupported by store".into())
    }
    /// Atomically replace a verified frame prefix at expected_head; keep rows and head.
    fn compare_and_checkpoint(
        &mut self,
        _peer_id: &str,
        _expected_head: &str,
        _checkpoint: &[u8],
    ) -> Result<PeerImageWrite, String> {
        Err("ordinary journal: checkpoint unsupported by store".into())
    }
    /// Replace payload-bearing history with a canonical current-state anchor under head CAS.
    fn compare_and_rebase(
        &mut self,
        _peer_id: &str,
        _expected_head: &str,
        _next_head: &str,
        _checkpoint: &[u8],
    ) -> Result<PeerImageWrite, String> {
        Err("permanent journal: rebase unsupported by store".into())
    }
    /// Atomically prove absence on this peer's declared surface and append the purge report.
    fn compare_and_settle_purge(
        &mut self,
        _peer_id: &str,
        _expected_head: &str,
        _next_head: &str,
        _frame: &[u8],
        _target_id: &str,
        _generation: u64,
    ) -> Result<ErasureJournalWrite, String> {
        Err("permanent journal: physical absence proof unsupported by store".into())
    }
}

#[derive(Debug, Clone)]
pub struct EffectiveErasureOrder {
    pub delta: Delta,
    pub target_id: String,
    pub surface_holds_bytes: bool,
}

pub struct EffectiveErasureTransferInput<'a, S> {
    pub orders: &'a [EffectiveErasureOrder],
    /// Loose ordinary appearances in this transfer, considered after the order appearances.
    pub ordinary: &'a [Delta],
    pub capacity: Option<usize>,
    pub origin: &'a ArrivalOrigin,
    pub arrived_at: f64,
    pub policy_state: &'a S,
    pub guards: &'a [&'a CandidateGuard<S>],
    pub mode: TransferMode,
    pub target_budget: usize,
    pub advance_refusal_cap: usize,
    pub authorize: &'a ErasureAuthority<'a>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OrdinaryJournalOpenResult {
    Open(Box<OrdinaryJournalPeer>),
    Degraded {
        peer: Box<OrdinaryJournalPeer>,
        unavailable: Vec<UnavailableAdmittedRow>,
    },
    RowsWithoutJournal,
    Conflict,
    CommittedUnconfirmed {
        fault: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum OrdinaryJournalAdmissionResult {
    Committed {
        outcomes: Vec<SignedLooseOutcome>,
        arrivals: Vec<ArrivalRecord>,
        head: String,
    },
    Rejected {
        reason: String,
        outcomes: Vec<SignedLooseOutcome>,
    },
    Conflict,
    AbsenceRefuted {
        target_id: String,
    },
    CommittedUnconfirmed {
        fault: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum OrdinaryJournalPurgeResult {
    Committed { head: String },
    Conflict,
    AbsenceRefuted { target_id: String },
    CommittedUnconfirmed { fault: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrdinaryJournalPeer {
    peer_id: String,
    state: DurablePeerState,
    head: String,
    live: bool,
    unavailable_ids: BTreeSet<String>,
    rebased_through: u64,
    rebased_refused_ids: BTreeSet<String>,
}

fn sender(origin: &ArrivalOrigin, receiving_peer_id: &str) -> Result<String, String> {
    match origin {
        ArrivalOrigin::Local => Ok("local".into()),
        ArrivalOrigin::Unattributed => Ok("unattributed".into()),
        ArrivalOrigin::AuthenticatedPeer(peer_id) => {
            if !is_canonical_peer_id(peer_id) {
                return Err("ordinary journal: invalid sender".into());
            }
            if peer_id == receiving_peer_id {
                return Err("ordinary journal: authenticated sender is receiving peer".into());
            }
            Ok(peer_id.clone())
        }
    }
}

fn assert_admitted_rows(state: &DurablePeerState, rows: &[Delta]) -> Result<(), String> {
    if rows.len() != state.base.admitted.len() {
        return Err("ordinary journal: admitted row mismatch".into());
    }
    let mut seen = BTreeSet::new();
    for row in rows {
        let expected = state.base.admitted.get(&row.id);
        if !seen.insert(&row.id)
            || !expected.is_some_and(|expected| expected.sig == row.sig)
            || compute_id(&row.claims).ok().as_deref() != Some(row.id.as_str())
        {
            return Err("ordinary journal: admitted row mismatch".into());
        }
    }
    Ok(())
}

fn classify_admitted_rows(
    state: &DurablePeerState,
    reads: &[AdmittedRowRead],
) -> Result<Vec<UnavailableAdmittedRow>, String> {
    let ids = state.base.admitted.ids();
    if reads.len() != ids.len() {
        return Err("ordinary journal: incomplete degraded row read".into());
    }
    let mut by_id: BTreeMap<&str, &AdmittedRowRead> = BTreeMap::new();
    for read in reads {
        if !state.base.admitted.contains(&read.id) || by_id.insert(read.id.as_str(), read).is_some()
        {
            return Err("ordinary journal: invalid degraded row read".into());
        }
    }
    let mut unavailable = Vec::new();
    for id in ids {
        let read = by_id
            .get(id)
            .ok_or("ordinary journal: incomplete degraded row read")?;
        let sound = read.fault.is_none()
            && read.row.as_ref().is_some_and(|row| {
                row.id == id
                    && state
                        .base
                        .admitted
                        .get(id)
                        .is_some_and(|expected| expected.sig == row.sig)
                    && compute_id(&row.claims).ok().as_deref() == Some(id)
            });
        if !sound {
            unavailable.push(UnavailableAdmittedRow {
                id: id.to_string(),
                reason: read.fault.clone().unwrap_or_else(|| {
                    if read.row.is_none() {
                        "missing row".into()
                    } else {
                        "admitted row mismatch".into()
                    }
                }),
            });
        }
    }
    Ok(unavailable)
}

pub fn open_ordinary_journal_peer<S: DurableOrdinaryJournalStore>(
    store: &mut S,
    peer_id: &str,
) -> Result<OrdinaryJournalOpenResult, String> {
    open_ordinary_journal_peer_inner(store, peer_id, false)
}

pub fn open_ordinary_journal_peer_degraded<S: DurableOrdinaryJournalStore>(
    store: &mut S,
    peer_id: &str,
) -> Result<OrdinaryJournalOpenResult, String> {
    open_ordinary_journal_peer_inner(store, peer_id, true)
}

fn open_ordinary_journal_peer_inner<S: DurableOrdinaryJournalStore>(
    store: &mut S,
    peer_id: &str,
    allow_degraded: bool,
) -> Result<OrdinaryJournalOpenResult, String> {
    if !is_canonical_peer_id(peer_id) {
        return Err("ordinary journal: invalid peer id".into());
    }
    let (state, head, unavailable, rebased_through, rebased_refused_ids) = match store
        .read_journal(peer_id)?
    {
        OrdinaryJournalRead::RowsWithoutJournal => {
            return Ok(OrdinaryJournalOpenResult::RowsWithoutJournal)
        }
        OrdinaryJournalRead::Journal {
            head,
            frames,
            checkpoint,
        } => {
            let state =
                replay_permanent_peer_frames(peer_id, &frames, &head, checkpoint.as_deref())?;
            let rebase = checkpoint
                .as_deref()
                .and_then(|bytes| decode_permanent_journal_rebase(bytes).ok());
            let rebased_through = rebase
                .as_ref()
                .map_or(0, |anchor| anchor.state.base.cursor.last_sequence);
            let rebased_refused_ids =
                rebase.map_or_else(BTreeSet::new, |anchor| anchor.state.base.refused_ids);
            let ids = state
                .base
                .admitted
                .ids()
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            let unavailable = if allow_degraded {
                classify_admitted_rows(&state, &store.read_admitted_rows_degraded(peer_id, &ids)?)?
            } else {
                let rows = store.read_admitted_rows(peer_id, &ids)?;
                if store.read_head(peer_id)? != OrdinaryJournalHead::Head(head.clone()) {
                    return Ok(OrdinaryJournalOpenResult::Conflict);
                }
                assert_admitted_rows(&state, &rows)?;
                Vec::new()
            };
            if allow_degraded
                && store.read_head(peer_id)? != OrdinaryJournalHead::Head(head.clone())
            {
                return Ok(OrdinaryJournalOpenResult::Conflict);
            }
            (
                state,
                head,
                unavailable,
                rebased_through,
                rebased_refused_ids,
            )
        }
        OrdinaryJournalRead::Empty => {
            match store.compare_and_append(peer_id, None, "", None, &[])? {
                PeerImageWrite::Durable => {}
                PeerImageWrite::Conflict => return Ok(OrdinaryJournalOpenResult::Conflict),
                PeerImageWrite::CommittedUnconfirmed { fault } => {
                    return Ok(OrdinaryJournalOpenResult::CommittedUnconfirmed { fault });
                }
            }
            (
                empty_durable_peer_state(peer_id)?,
                String::new(),
                Vec::new(),
                0,
                BTreeSet::new(),
            )
        }
    };
    let peer = Box::new(OrdinaryJournalPeer {
        peer_id: peer_id.into(),
        state,
        head,
        live: true,
        unavailable_ids: unavailable.iter().map(|row| row.id.clone()).collect(),
        rebased_through,
        rebased_refused_ids,
    });
    if unavailable.is_empty() {
        Ok(OrdinaryJournalOpenResult::Open(peer))
    } else {
        Ok(OrdinaryJournalOpenResult::Degraded { peer, unavailable })
    }
}

impl OrdinaryJournalPeer {
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// Copy the verified projection for a reader; append receipts avoid this O(history) copy.
    pub fn snapshot(&self) -> Result<DurablePeerState, String> {
        if !self.live {
            return Err("ordinary journal: reopen required".into());
        }
        Ok(self.state.clone())
    }

    /// Signed rows safe to serve; damaged physical rows remain outside product views.
    pub fn available_deltas(&self) -> Result<DeltaSet, String> {
        if !self.live {
            return Err("ordinary journal: reopen required".into());
        }
        DeltaSet::from_deltas(
            self.state
                .base
                .admitted
                .iter()
                .filter(|row| !self.unavailable_ids.contains(&row.id))
                .cloned(),
        )
    }

    pub fn current_head(&self) -> Result<&str, String> {
        if !self.live {
            return Err("ordinary journal: reopen required".into());
        }
        Ok(&self.head)
    }

    /// Compact a verified prefix; conflict or uncertain durability requires reopen.
    pub fn checkpoint<S: DurableOrdinaryJournalStore>(
        &mut self,
        store: &mut S,
    ) -> Result<PeerImageWrite, String> {
        if !self.live {
            return Err("ordinary journal: reopen required".into());
        }
        let bytes = encode_ordinary_journal_checkpoint(&OrdinaryJournalCheckpoint {
            peer_id: self.peer_id.clone(),
            head: self.head.clone(),
            state: self.state.clone(),
        })?;
        let result = store.compare_and_checkpoint(&self.peer_id, &self.head, &bytes)?;
        if result != PeerImageWrite::Durable {
            self.live = false;
        }
        Ok(result)
    }

    /// Replace payload-bearing history with a current-state anchor after erasure.
    pub fn rebase<S: DurableOrdinaryJournalStore>(
        &mut self,
        store: &mut S,
    ) -> Result<PeerImageWrite, String> {
        if !self.live {
            return Err("ordinary journal: reopen required".into());
        }
        if self.state.events.is_empty() {
            return Err("permanent journal: rebase requires refusal history".into());
        }
        if self.head.is_empty() {
            return Err("permanent journal: rebase unsupported by store".into());
        }
        let checkpoint = encode_permanent_journal_rebase(&PermanentJournalRebase {
            peer_id: self.peer_id.clone(),
            prior: self.head.clone(),
            state: self.state.clone(),
        })?;
        let next_head = content_address(&checkpoint);
        let result =
            store.compare_and_rebase(&self.peer_id, &self.head, &next_head, &checkpoint)?;
        if result == PeerImageWrite::Durable {
            self.head = next_head;
            self.rebased_through = self.state.base.cursor.last_sequence;
            self.rebased_refused_ids = self.state.base.refused_ids.clone();
        } else {
            self.live = false;
        }
        Ok(result)
    }

    /// Caller serializes writers for this peer. Conflicts and uncertain commits require reopen.
    pub fn admit<S: DurableOrdinaryJournalStore, P>(
        &mut self,
        store: &mut S,
        input: &SinglePeerTransferInput<'_, P>,
    ) -> Result<OrdinaryJournalAdmissionResult, String> {
        if !self.live {
            return Err("ordinary journal: reopen required".into());
        }
        if store.read_head(&self.peer_id)? != OrdinaryJournalHead::Head(self.head.clone()) {
            self.live = false;
            return Ok(OrdinaryJournalAdmissionResult::Conflict);
        }
        let sender = sender(input.origin, &self.peer_id)?;
        let plan = plan_signed_loose_ordinary_transfer_from_verified(
            &self.state,
            &SignedLooseTransferInput {
                offered: input.offered,
                sending_peer_id: &sender,
                arrived_at: input.arrived_at,
                capacity: input.capacity.unwrap_or(usize::MAX),
                policy_state: input.policy_state,
                guards: input.guards,
                is_erasure_candidate: input.is_erasure_candidate,
            },
        )?;
        if input.mode == TransferMode::Atomic {
            if let Some(failed) = plan.outcomes.iter().find(|outcome| {
                !matches!(
                    outcome.status,
                    crate::signed_loose_admission::SignedLooseOutcomeStatus::Admitted
                        | crate::signed_loose_admission::SignedLooseOutcomeStatus::Duplicate
                )
            }) {
                return Ok(OrdinaryJournalAdmissionResult::Rejected {
                    reason: failed
                        .reason
                        .clone()
                        .unwrap_or_else(|| failed.status.as_str().into()),
                    outcomes: plan.outcomes,
                });
            }
        }
        if plan.admitted_ids.is_empty() {
            return Ok(OrdinaryJournalAdmissionResult::Committed {
                outcomes: plan.outcomes,
                arrivals: Vec::new(),
                head: self.head.clone(),
            });
        }
        let arrivals = plan
            .state
            .base
            .arrivals
            .get(self.state.base.arrivals.len()..)
            .ok_or("ordinary journal: planned transition cannot be replayed")?
            .to_vec();
        let mut ids = plan.admitted_ids.clone();
        ids.sort();
        if arrivals.len() != ids.len()
            || arrivals.iter().enumerate().any(|(i, row)| {
                row.id != ids[i]
                    || self
                        .state
                        .base
                        .cursor
                        .last_sequence
                        .checked_add(i as u64 + 1)
                        != Some(row.sequence)
                    || self.state.base.cursor.last_transfer.checked_add(1) != Some(row.transfer)
                    || row.sender != sender
                    || row.at != input.arrived_at
            })
            || self.state.quota_used.checked_add(ids.len() as u64) != Some(plan.state.quota_used)
        {
            return Err("ordinary journal: planned transition cannot be replayed".into());
        }
        let additions: Vec<Delta> = plan
            .admitted_ids
            .iter()
            .map(|id| {
                plan.state
                    .base
                    .admitted
                    .get(id)
                    .expect("plan admitted id exists in state")
                    .clone()
            })
            .collect();
        let frame = encode_ordinary_peer_frame(&OrdinaryPeerFrame {
            peer_id: self.peer_id.clone(),
            prior: self.head.clone(),
            at: input.arrived_at,
            sender,
            additions: additions.clone(),
        })?;
        let next_head = content_address(&frame);
        let write = store.compare_and_append(
            &self.peer_id,
            Some(&self.head),
            &next_head,
            Some(&frame),
            &additions,
        )?;
        if write != PeerImageWrite::Durable {
            self.live = false;
            return Ok(match write {
                PeerImageWrite::Conflict => OrdinaryJournalAdmissionResult::Conflict,
                PeerImageWrite::CommittedUnconfirmed { fault } => {
                    OrdinaryJournalAdmissionResult::CommittedUnconfirmed { fault }
                }
                PeerImageWrite::Durable => unreachable!(),
            });
        }
        self.state = plan.state;
        self.head = next_head.clone();
        Ok(OrdinaryJournalAdmissionResult::Committed {
            outcomes: plan.outcomes,
            arrivals,
            head: next_head,
        })
    }

    /// Signed loose erasure orders only. The host supplies policy authorization and surface facts.
    pub fn admit_erasures<S: DurableOrdinaryJournalStore, P>(
        &mut self,
        store: &mut S,
        input: &EffectiveErasureTransferInput<'_, P>,
    ) -> Result<OrdinaryJournalAdmissionResult, String> {
        if !self.live {
            return Err("ordinary journal: reopen required".into());
        }
        if store.read_head(&self.peer_id)? != OrdinaryJournalHead::Head(self.head.clone()) {
            self.live = false;
            return Ok(OrdinaryJournalAdmissionResult::Conflict);
        }
        let origin = sender(input.origin, &self.peer_id)?;
        let mut units: Vec<TransferUnit> = input
            .orders
            .iter()
            .map(|row| TransferUnit::Loose(row.delta.clone()))
            .collect();
        units.extend(input.ordinary.iter().cloned().map(TransferUnit::Loose));
        let guarded = preflight_transfer(
            &units,
            &PreflightContext {
                admitted_before: &self.state.base.admitted,
                refused_ids: &self.state.base.refused_ids,
                sending_peer_id: &origin,
                receiving_peer_id: &self.peer_id,
                arrived_at: input.arrived_at,
                policy_state: input.policy_state,
                guards: input.guards,
            },
        )?;
        let offered_order_ids: BTreeSet<String> = guarded
            .iter()
            .take(input.orders.len())
            .filter(|row| row.status != GuardedUnitStatus::Invalid)
            .filter_map(|row| match &row.unit {
                TransferUnit::Loose(delta)
                    if delta
                        .claims
                        .pointers
                        .iter()
                        .any(|pointer| pointer.role == "erases") =>
                {
                    Some(delta.id.clone())
                }
                TransferUnit::Loose(_) => None,
                TransferUnit::Bundle { .. } => None,
            })
            .collect();
        let mut by_id: BTreeMap<String, EffectiveErasureOrder> = BTreeMap::new();
        let mut outcomes = Vec::new();
        for (row, original) in guarded.iter().take(input.orders.len()).zip(input.orders) {
            let delta = match &row.unit {
                TransferUnit::Loose(delta) => delta,
                TransferUnit::Bundle { .. } => unreachable!(),
            };
            let id = delta.id.clone();
            let (status, reason) = match row.status {
                GuardedUnitStatus::Invalid => (SignedLooseOutcomeStatus::Invalid, None),
                GuardedUnitStatus::Refused => (SignedLooseOutcomeStatus::Refused, None),
                GuardedUnitStatus::Duplicate => (SignedLooseOutcomeStatus::Duplicate, None),
                GuardedUnitStatus::GuardRejected => {
                    (SignedLooseOutcomeStatus::GuardRejected, row.reason.clone())
                }
                GuardedUnitStatus::Eligible => {
                    let signed_targets: Vec<&str> = delta
                        .claims
                        .pointers
                        .iter()
                        .filter_map(|pointer| match &pointer.target {
                            Target::Delta(reference) if pointer.role == "erases" => {
                                Some(reference.delta.as_str())
                            }
                            _ => None,
                        })
                        .collect();
                    if signed_targets.as_slice() != [original.target_id.as_str()] {
                        (
                            SignedLooseOutcomeStatus::ErasureIneligible,
                            Some("signed target mismatch".into()),
                        )
                    } else {
                        if let Some(previous) = by_id.get(&id) {
                            if previous.target_id != original.target_id
                                || previous.surface_holds_bytes != original.surface_holds_bytes
                            {
                                return Err(
                                    "permanent journal: conflicting order appearances".into()
                                );
                            }
                        }
                        by_id.insert(id.clone(), original.clone());
                        (SignedLooseOutcomeStatus::EffectiveErasure, None)
                    }
                }
            };
            outcomes.push(SignedLooseOutcome { id, status, reason });
        }
        let mut surface_by_target: BTreeMap<String, bool> = BTreeMap::new();
        for order in by_id.values() {
            if let Some(prior) =
                surface_by_target.insert(order.target_id.clone(), order.surface_holds_bytes)
            {
                if prior != order.surface_holds_bytes {
                    return Err("permanent journal: inconsistent surface fact".into());
                }
            }
        }
        let prior_effective_orders: BTreeSet<&str> = self
            .state
            .exclusions
            .iter()
            .map(|row| row.order_id.as_str())
            .collect();
        for (id, order) in by_id.clone() {
            let reason = if prior_effective_orders.contains(order.target_id.as_str()) {
                Some("erasure targets an effective order")
            } else if !order.surface_holds_bytes
                && self.state.base.admitted.contains(&order.target_id)
            {
                Some("held target has bytes")
            } else {
                None
            };
            if let Some(reason) = reason {
                by_id.remove(&id);
                for outcome in &mut outcomes {
                    if outcome.id == id
                        && outcome.status == SignedLooseOutcomeStatus::EffectiveErasure
                    {
                        outcome.status = SignedLooseOutcomeStatus::ErasureIneligible;
                        outcome.reason = Some(reason.into());
                    }
                }
            }
        }
        for (id, row) in by_id.clone() {
            if offered_order_ids.contains(&row.target_id) {
                by_id.remove(&id);
                for outcome in &mut outcomes {
                    if outcome.id == id
                        && outcome.status == SignedLooseOutcomeStatus::EffectiveErasure
                    {
                        outcome.status = SignedLooseOutcomeStatus::ErasureIneligible;
                        outcome.reason = Some("erasure targets an order".into());
                    }
                }
            }
        }
        let candidates: Vec<ErasureOrderCandidate> = by_id
            .values()
            .map(|row| ErasureOrderCandidate {
                id: row.delta.id.clone(),
                target_id: row.target_id.clone(),
            })
            .collect();
        let admitted_before: BTreeSet<String> = self
            .state
            .base
            .admitted
            .ids()
            .into_iter()
            .map(str::to_string)
            .collect();
        let filtered = plan_erasure_filter(
            &candidates,
            &admitted_before,
            input.target_budget,
            input.authorize,
        )?;
        let mut effective: BTreeSet<String> =
            filtered.effective_order_ids.iter().cloned().collect();
        let mut limited: BTreeSet<String> = filtered.limited_order_ids.iter().cloned().collect();
        let existing_advance: BTreeSet<&str> = self
            .state
            .events
            .iter()
            .filter(|event| {
                event.prior_epoch.is_none()
                    && !self
                        .state
                        .obligations
                        .iter()
                        .any(|job| job.target_id == event.target_id)
            })
            .map(|event| event.target_id.as_str())
            .collect();
        let cooffered_ordinary_ids: BTreeSet<String> = guarded
            .iter()
            .skip(input.orders.len())
            .filter_map(|row| match (&row.status, &row.unit) {
                (GuardedUnitStatus::Eligible, TransferUnit::Loose(delta)) => Some(delta.id.clone()),
                _ => None,
            })
            .collect();
        let mut new_advance = 0_usize;
        for target_id in &filtered.selected_targets {
            if !by_id
                .values()
                .any(|row| &row.target_id == target_id && effective.contains(&row.delta.id))
            {
                continue;
            }
            let row = by_id
                .values()
                .find(|row| &row.target_id == target_id)
                .unwrap();
            let is_advance = !self.state.base.admitted.contains(target_id)
                && !cooffered_ordinary_ids.contains(target_id)
                && !self.state.base.refused_ids.contains(target_id)
                && !row.surface_holds_bytes;
            if is_advance && existing_advance.len() + new_advance >= input.advance_refusal_cap {
                for row in by_id.values().filter(|row| &row.target_id == target_id) {
                    effective.remove(&row.delta.id);
                    limited.insert(row.delta.id.clone());
                }
            } else if is_advance {
                new_advance += 1;
            }
        }
        // A cap may remove an order another survivor needed for authority. Eliminate again
        // over only the survivors; no target that was skipped may be refilled.
        let after_cap: Vec<ErasureOrderCandidate> = effective
            .iter()
            .map(|id| ErasureOrderCandidate {
                id: id.clone(),
                target_id: by_id[id].target_id.clone(),
            })
            .collect();
        effective = plan_erasure_filter(
            &after_cap,
            &admitted_before,
            after_cap.len(),
            input.authorize,
        )?
        .effective_order_ids
        .into_iter()
        .collect();
        for outcome in &mut outcomes {
            if outcome.status != SignedLooseOutcomeStatus::EffectiveErasure {
                continue;
            }
            outcome.status = if effective.contains(&outcome.id) {
                SignedLooseOutcomeStatus::EffectiveErasure
            } else if limited.contains(&outcome.id) {
                SignedLooseOutcomeStatus::ErasureLimit
            } else {
                SignedLooseOutcomeStatus::ErasureIneligible
            };
        }
        let excluded_targets: BTreeSet<String> = effective
            .iter()
            .map(|id| by_id[id].target_id.clone())
            .collect();
        let mut ordinary_candidates: BTreeMap<String, Delta> = BTreeMap::new();
        let mut ordinary_outcomes = Vec::new();
        for (row, delta) in guarded.iter().skip(input.orders.len()).zip(input.ordinary) {
            let id = delta.id.clone();
            let (status, reason) = match row.status {
                GuardedUnitStatus::Invalid => (SignedLooseOutcomeStatus::Invalid, None),
                GuardedUnitStatus::Refused => (SignedLooseOutcomeStatus::Refused, None),
                GuardedUnitStatus::Duplicate => (SignedLooseOutcomeStatus::Duplicate, None),
                GuardedUnitStatus::GuardRejected => {
                    (SignedLooseOutcomeStatus::GuardRejected, row.reason.clone())
                }
                GuardedUnitStatus::Eligible if by_id.contains_key(&id) => (
                    SignedLooseOutcomeStatus::Invalid,
                    Some("order also offered as ordinary".into()),
                ),
                GuardedUnitStatus::Eligible if excluded_targets.contains(&id) => (
                    SignedLooseOutcomeStatus::Refused,
                    Some("erased in transfer".into()),
                ),
                GuardedUnitStatus::Eligible => {
                    ordinary_candidates.insert(id.clone(), delta.clone());
                    (SignedLooseOutcomeStatus::Admitted, None)
                }
            };
            ordinary_outcomes.push(SignedLooseOutcome { id, status, reason });
        }
        let ordinary_units: Vec<OrdinaryQuotaUnit> = ordinary_candidates
            .values()
            .map(|delta| {
                let requires = ordinary_candidates
                    .values()
                    .filter(|other| {
                        other
                            .claims
                            .pointers
                            .iter()
                            .any(|pointer| match &pointer.target {
                                Target::Delta(reference) => {
                                    pointer.role == "negates" && reference.delta == delta.id
                                }
                                _ => false,
                            })
                    })
                    .map(|other| other.id.clone())
                    .collect();
                OrdinaryQuotaUnit {
                    key: delta.id.clone(),
                    rank: delta.id.clone(),
                    fresh_ids: vec![delta.id.clone()],
                    requires,
                }
            })
            .collect();
        let quota = plan_ordinary_quota(
            &ordinary_units,
            &admitted_before,
            &excluded_targets,
            &effective,
            input.capacity.unwrap_or(usize::MAX),
        )?;
        let admitted_ordinary: BTreeSet<&String> = quota.admitted_ids.iter().collect();
        let skipped_ordinary: BTreeSet<&String> = quota.skipped_keys.iter().collect();
        let pruned_ordinary: BTreeSet<&String> = quota.pruned_keys.iter().collect();
        for outcome in &mut ordinary_outcomes {
            if outcome.status != SignedLooseOutcomeStatus::Admitted {
                continue;
            }
            outcome.status = if admitted_ordinary.contains(&outcome.id) {
                SignedLooseOutcomeStatus::Admitted
            } else if skipped_ordinary.contains(&outcome.id) {
                SignedLooseOutcomeStatus::QuotaSkipped
            } else if pruned_ordinary.contains(&outcome.id) {
                SignedLooseOutcomeStatus::DependencyPruned
            } else {
                SignedLooseOutcomeStatus::Invalid
            };
        }
        outcomes.extend(ordinary_outcomes);
        if input.mode == TransferMode::Atomic {
            if let Some(failed) = outcomes.iter().find(|row| {
                row.status != SignedLooseOutcomeStatus::EffectiveErasure
                    && row.status != SignedLooseOutcomeStatus::Admitted
                    && row.status != SignedLooseOutcomeStatus::Duplicate
            }) {
                return Ok(OrdinaryJournalAdmissionResult::Rejected {
                    reason: failed
                        .reason
                        .clone()
                        .unwrap_or_else(|| failed.status.as_str().into()),
                    outcomes,
                });
            }
        }
        if effective.is_empty() && quota.admitted_ids.is_empty() {
            return Ok(OrdinaryJournalAdmissionResult::Committed {
                outcomes,
                arrivals: Vec::new(),
                head: self.head.clone(),
            });
        }
        let mut groups: BTreeMap<String, PermanentErasure> = BTreeMap::new();
        for id in &effective {
            let row = &by_id[id];
            if let Some(group) = groups.get_mut(&row.target_id) {
                if group.surface_holds_bytes != row.surface_holds_bytes {
                    return Err("permanent journal: inconsistent surface fact".into());
                }
                group.order_ids.push(id.clone());
            } else {
                groups.insert(
                    row.target_id.clone(),
                    PermanentErasure {
                        target_id: row.target_id.clone(),
                        order_ids: vec![id.clone()],
                        surface_holds_bytes: row.surface_holds_bytes,
                    },
                );
            }
        }
        let additions: Vec<Delta> = effective
            .iter()
            .map(|id| by_id[id].delta.clone())
            .chain(
                quota
                    .admitted_ids
                    .iter()
                    .map(|id| ordinary_candidates[id].clone()),
            )
            .collect();
        let commit = PermanentCommitInput {
            additions: additions.clone(),
            erasures: groups.into_values().collect(),
            quota_charge: quota.charged as u64,
            at: input.arrived_at,
            sender: origin,
        };
        let asserted_absent_target_ids: Vec<String> = commit
            .erasures
            .iter()
            .filter(|group| !group.surface_holds_bytes)
            .map(|group| group.target_id.clone())
            .collect();
        let state = plan_permanent_commit_from_verified(&self.state, &commit)?;
        encode_durable_peer_state(&state)?;
        validate_transition(&self.state, &state)?;
        let frame = if effective.is_empty() {
            encode_ordinary_peer_frame(&OrdinaryPeerFrame {
                peer_id: self.peer_id.clone(),
                prior: self.head.clone(),
                at: input.arrived_at,
                sender: commit.sender.clone(),
                additions: additions.clone(),
            })?
        } else {
            encode_permanent_peer_frame(&PermanentPeerFrame::Admission {
                peer_id: self.peer_id.clone(),
                prior: self.head.clone(),
                input: commit,
            })?
        };
        let next_head = content_address(&frame);
        let write = if effective.is_empty() {
            store
                .compare_and_append(
                    &self.peer_id,
                    Some(&self.head),
                    &next_head,
                    Some(&frame),
                    &additions,
                )?
                .into()
        } else {
            store.compare_and_append_erasure(
                &self.peer_id,
                &self.head,
                &next_head,
                &frame,
                &additions,
                &asserted_absent_target_ids,
            )?
        };
        if let ErasureJournalWrite::AbsenceRefuted { target_id } = write {
            if !asserted_absent_target_ids.contains(&target_id) {
                self.live = false;
                return Err("permanent journal: invalid absence refutation".into());
            }
            return Ok(OrdinaryJournalAdmissionResult::AbsenceRefuted { target_id });
        }
        if write != ErasureJournalWrite::Durable {
            self.live = false;
            return Ok(match write {
                ErasureJournalWrite::Conflict => OrdinaryJournalAdmissionResult::Conflict,
                ErasureJournalWrite::CommittedUnconfirmed { fault } => {
                    OrdinaryJournalAdmissionResult::CommittedUnconfirmed { fault }
                }
                _ => unreachable!(),
            });
        }
        let arrivals = state.base.arrivals[self.state.base.arrivals.len()..].to_vec();
        self.state = state;
        self.head = next_head.clone();
        for target_id in &excluded_targets {
            self.unavailable_ids.remove(target_id);
        }
        Ok(OrdinaryJournalAdmissionResult::Committed {
            outcomes,
            arrivals,
            head: next_head,
        })
    }

    /// Record a purge failure, or settle after the store atomically proves physical absence.
    pub fn report_purge<S: DurableOrdinaryJournalStore>(
        &mut self,
        store: &mut S,
        target_id: &str,
        generation: u64,
        status: &str,
        fault: Option<&str>,
    ) -> Result<OrdinaryJournalPurgeResult, String> {
        if !self.live {
            return Err("ordinary journal: reopen required".into());
        }
        if store.read_head(&self.peer_id)? != OrdinaryJournalHead::Head(self.head.clone()) {
            self.live = false;
            return Ok(OrdinaryJournalPurgeResult::Conflict);
        }
        let frame = PermanentPeerFrame::Purge {
            peer_id: self.peer_id.clone(),
            prior: self.head.clone(),
            target_id: target_id.into(),
            generation,
            status: status.into(),
            fault: fault.map(str::to_string),
        };
        let state = apply_permanent_peer_frame(&self.state, &frame)?;
        if status == "removed"
            && self.state.base.arrivals.iter().any(|row| {
                row.id == target_id
                    && (row.sequence > self.rebased_through
                        || !self.rebased_refused_ids.contains(target_id))
            })
        {
            return Ok(OrdinaryJournalPurgeResult::AbsenceRefuted {
                target_id: target_id.into(),
            });
        }
        let bytes = encode_permanent_peer_frame(&frame)?;
        let next_head = content_address(&bytes);
        let write = if status == "removed" {
            store.compare_and_settle_purge(
                &self.peer_id,
                &self.head,
                &next_head,
                &bytes,
                target_id,
                generation,
            )?
        } else {
            store
                .compare_and_append(
                    &self.peer_id,
                    Some(&self.head),
                    &next_head,
                    Some(&bytes),
                    &[],
                )?
                .into()
        };
        if let ErasureJournalWrite::AbsenceRefuted {
            target_id: refuted_target_id,
        } = write
        {
            if status != "removed" || refuted_target_id != target_id {
                self.live = false;
                return Err("permanent journal: invalid absence refutation".into());
            }
            return Ok(OrdinaryJournalPurgeResult::AbsenceRefuted {
                target_id: refuted_target_id,
            });
        }
        if write != ErasureJournalWrite::Durable {
            self.live = false;
            return Ok(match write {
                ErasureJournalWrite::Conflict => OrdinaryJournalPurgeResult::Conflict,
                ErasureJournalWrite::CommittedUnconfirmed { fault } => {
                    OrdinaryJournalPurgeResult::CommittedUnconfirmed { fault }
                }
                _ => unreachable!(),
            });
        }
        self.state = state;
        self.head = next_head.clone();
        Ok(OrdinaryJournalPurgeResult::Committed { head: next_head })
    }
}
