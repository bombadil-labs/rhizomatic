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
use crate::peer_identity::is_canonical_peer_id;
use crate::permanent_journal::{
    apply_permanent_peer_frame, encode_permanent_peer_frame, replay_permanent_peer_frames,
    PermanentPeerFrame,
};
use crate::preflight::{
    preflight_transfer, CandidateGuard, GuardedUnitStatus, PreflightContext, TransferUnit,
};
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

/// Consistent open, immutable committed frames, cheap head read, atomic head/frame/row CAS.
pub trait DurableOrdinaryJournalStore {
    fn read_journal(&self, peer_id: &str) -> Result<OrdinaryJournalRead, String>;
    /// Return exactly the stored rows for these admitted ids; extras outside the list stay external.
    fn read_admitted_rows(&self, peer_id: &str, ids: &[String]) -> Result<Vec<Delta>, String>;
    fn read_head(&self, peer_id: &str) -> Result<OrdinaryJournalHead, String>;
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
    ) -> Result<PeerImageWrite, String> {
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
    /// Atomically prove absence on this peer's declared surface and append the purge report.
    fn compare_and_settle_purge(
        &mut self,
        _peer_id: &str,
        _expected_head: &str,
        _next_head: &str,
        _frame: &[u8],
        _target_id: &str,
        _generation: u64,
    ) -> Result<PeerImageWrite, String> {
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
    RowsWithoutJournal,
    Conflict,
    CommittedUnconfirmed { fault: String },
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
    CommittedUnconfirmed {
        fault: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum OrdinaryJournalPurgeResult {
    Committed { head: String },
    Conflict,
    CommittedUnconfirmed { fault: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrdinaryJournalPeer {
    peer_id: String,
    state: DurablePeerState,
    head: String,
    live: bool,
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

pub fn open_ordinary_journal_peer<S: DurableOrdinaryJournalStore>(
    store: &mut S,
    peer_id: &str,
) -> Result<OrdinaryJournalOpenResult, String> {
    if !is_canonical_peer_id(peer_id) {
        return Err("ordinary journal: invalid peer id".into());
    }
    let (state, head) = match store.read_journal(peer_id)? {
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
            let ids = state
                .base
                .admitted
                .ids()
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            assert_admitted_rows(&state, &store.read_admitted_rows(peer_id, &ids)?)?;
            (state, head)
        }
        OrdinaryJournalRead::Empty => {
            match store.compare_and_append(peer_id, None, "", None, &[])? {
                PeerImageWrite::Durable => {}
                PeerImageWrite::Conflict => return Ok(OrdinaryJournalOpenResult::Conflict),
                PeerImageWrite::CommittedUnconfirmed { fault } => {
                    return Ok(OrdinaryJournalOpenResult::CommittedUnconfirmed { fault });
                }
            }
            (empty_durable_peer_state(peer_id)?, String::new())
        }
    };
    Ok(OrdinaryJournalOpenResult::Open(Box::new(
        OrdinaryJournalPeer {
            peer_id: peer_id.into(),
            state,
            head,
            live: true,
        },
    )))
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
        let units: Vec<TransferUnit> = input
            .orders
            .iter()
            .map(|row| TransferUnit::Loose(row.delta.clone()))
            .collect();
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
        let mut by_id: BTreeMap<String, EffectiveErasureOrder> = BTreeMap::new();
        let mut outcomes = Vec::new();
        for (row, original) in guarded.iter().zip(input.orders) {
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
        let offered_order_ids: BTreeSet<String> = by_id.keys().cloned().collect();
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
        if input.mode == TransferMode::Atomic {
            if let Some(failed) = outcomes.iter().find(|row| {
                row.status != SignedLooseOutcomeStatus::EffectiveErasure
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
        if effective.is_empty() {
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
        let additions: Vec<Delta> = effective.iter().map(|id| by_id[id].delta.clone()).collect();
        let commit = PermanentCommitInput {
            additions: additions.clone(),
            erasures: groups.into_values().collect(),
            quota_charge: 0,
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
        let frame = encode_permanent_peer_frame(&PermanentPeerFrame::Admission {
            peer_id: self.peer_id.clone(),
            prior: self.head.clone(),
            input: commit,
        })?;
        let next_head = content_address(&frame);
        let write = store.compare_and_append_erasure(
            &self.peer_id,
            &self.head,
            &next_head,
            &frame,
            &additions,
            &asserted_absent_target_ids,
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
        let arrivals = state.base.arrivals[self.state.base.arrivals.len()..].to_vec();
        self.state = state;
        self.head = next_head.clone();
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
            store.compare_and_append(
                &self.peer_id,
                Some(&self.head),
                &next_head,
                Some(&bytes),
                &[],
            )?
        };
        if write != PeerImageWrite::Durable {
            self.live = false;
            return Ok(match write {
                PeerImageWrite::Conflict => OrdinaryJournalPurgeResult::Conflict,
                PeerImageWrite::CommittedUnconfirmed { fault } => {
                    OrdinaryJournalPurgeResult::CommittedUnconfirmed { fault }
                }
                PeerImageWrite::Durable => unreachable!(),
            });
        }
        self.state = state;
        self.head = next_head.clone();
        Ok(OrdinaryJournalPurgeResult::Committed { head: next_head })
    }
}
