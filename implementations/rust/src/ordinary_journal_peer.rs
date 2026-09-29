//! Typed signed-loose ordinary admission over an atomic append journal.

use crate::arrival::ArrivalRecord;
use crate::durable_state::{empty_durable_peer_state, DurablePeerState};
use crate::hash::content_address;
use crate::ordinary_journal::{
    encode_ordinary_peer_frame, replay_ordinary_peer_frames, OrdinaryPeerFrame,
};
use crate::peer_identity::is_canonical_peer_id;
use crate::signed_loose_admission::{
    plan_signed_loose_ordinary_transfer_from_verified, SignedLooseOutcome, SignedLooseTransferInput,
};
use crate::single_peer::{ArrivalOrigin, PeerImageWrite, SinglePeerTransferInput, TransferMode};
use crate::types::Delta;

#[derive(Debug, Clone, PartialEq)]
pub enum OrdinaryJournalRead {
    Empty,
    RowsWithoutJournal,
    Journal { head: String, frames: Vec<Vec<u8>> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrdinaryJournalHead {
    Head(String),
    Missing,
}

/// Consistent open, immutable committed frames, cheap head read, atomic head/frame/row CAS.
pub trait DurableOrdinaryJournalStore {
    fn read_journal(&self, peer_id: &str) -> Result<OrdinaryJournalRead, String>;
    fn read_head(&self, peer_id: &str) -> Result<OrdinaryJournalHead, String>;
    fn compare_and_append(
        &mut self,
        peer_id: &str,
        expected_head: Option<&str>,
        next_head: &str,
        frame: Option<&[u8]>,
        newly_admitted: &[Delta],
    ) -> Result<PeerImageWrite, String>;
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
pub struct OrdinaryJournalPeer {
    pub peer_id: String,
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
        OrdinaryJournalRead::Journal { head, frames } => {
            (replay_ordinary_peer_frames(peer_id, &frames, &head)?, head)
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
        let arrivals = plan.state.base.arrivals[self.state.base.arrivals.len()..].to_vec();
        self.state = plan.state;
        self.head = next_head.clone();
        Ok(OrdinaryJournalAdmissionResult::Committed {
            outcomes: plan.outcomes,
            arrivals,
            head: next_head,
        })
    }
}
