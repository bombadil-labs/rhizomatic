//! Typed permanent-posture single-peer admission over a host-supplied atomic image store.

use crate::durable_state::{
    decode_durable_peer_state, empty_durable_peer_state, encode_durable_peer_state,
};
use crate::peer_identity::is_canonical_peer_id;
use crate::preflight::CandidateGuard;
use crate::signed_loose_admission::{
    plan_signed_loose_ordinary_transfer_from_verified, SignedLooseTransferInput,
};
use crate::types::Delta;

pub use crate::durable_state::DurablePeerState;
pub use crate::signed_loose_admission::SignedLooseOutcome;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArrivalOrigin {
    Local,
    AuthenticatedPeer(String),
    Unattributed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerImageWrite {
    Durable,
    CommittedUnconfirmed { fault: String },
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerImageRead {
    Empty,
    Image(Vec<u8>),
    RowsWithoutImage,
}

/// Report rows without an image instead of treating them as an empty peer. Atomically compare
/// the exact prior bytes and persist the next image with newly admitted rows. Empty-peer creation
/// also verifies that no rows already exist. `Durable` promises all of that survives restart.
/// `Conflict` has no effect; an uncertain commit requires recovery before retrying.
pub trait DurablePeerStore {
    fn read_image(&self, peer_id: &str) -> Result<PeerImageRead, String>;
    fn compare_and_set(
        &mut self,
        peer_id: &str,
        expected_prior: Option<&[u8]>,
        next_image: &[u8],
        newly_admitted: &[Delta],
    ) -> Result<PeerImageWrite, String>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum OpenSinglePeerResult {
    Open {
        state: Box<DurablePeerState>,
        image: Vec<u8>,
    },
    Conflict,
    RowsWithoutImage,
    CommittedUnconfirmed {
        fault: String,
    },
}

fn canonical_peer_id(peer_id: &str) -> Result<(), String> {
    if !is_canonical_peer_id(peer_id) {
        return Err("single peer: invalid canonical peer id".into());
    }
    Ok(())
}

/// Open an existing image, or CAS one empty image into a fresh store.
pub fn open_single_peer<S: DurablePeerStore>(
    store: &mut S,
    peer_id: &str,
) -> Result<OpenSinglePeerResult, String> {
    canonical_peer_id(peer_id)?;
    match store.read_image(peer_id)? {
        PeerImageRead::Image(image) => {
            let state = decode_durable_peer_state(&image, peer_id)?;
            return Ok(OpenSinglePeerResult::Open {
                state: Box::new(state),
                image,
            });
        }
        PeerImageRead::RowsWithoutImage => return Ok(OpenSinglePeerResult::RowsWithoutImage),
        PeerImageRead::Empty => {}
    }
    let state = empty_durable_peer_state(peer_id)?;
    let image = encode_durable_peer_state(&state)?;
    Ok(match store.compare_and_set(peer_id, None, &image, &[])? {
        PeerImageWrite::Durable => OpenSinglePeerResult::Open {
            state: Box::new(state),
            image,
        },
        PeerImageWrite::Conflict => OpenSinglePeerResult::Conflict,
        PeerImageWrite::CommittedUnconfirmed { fault } => {
            OpenSinglePeerResult::CommittedUnconfirmed { fault }
        }
    })
}

pub struct SinglePeerTransferInput<'a, S> {
    pub offered: &'a [Delta],
    pub origin: &'a ArrivalOrigin,
    pub arrived_at: f64,
    pub policy_state: &'a S,
    pub guards: &'a [&'a CandidateGuard<S>],
    pub is_erasure_candidate: &'a dyn Fn(&Delta) -> bool,
    pub mode: TransferMode,
    /// Ordinary new-id count capacity; use None for an application-owned quota.
    pub capacity: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferMode {
    Atomic,
    Individual,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SinglePeerTransferResult {
    Committed {
        outcomes: Vec<SignedLooseOutcome>,
        state: Box<DurablePeerState>,
        image: Vec<u8>,
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

fn sender(origin: &ArrivalOrigin, receiving_peer_id: &str) -> Result<String, String> {
    match origin {
        ArrivalOrigin::Local => Ok("local".into()),
        ArrivalOrigin::Unattributed => Ok("unattributed".into()),
        ArrivalOrigin::AuthenticatedPeer(peer_id) => {
            canonical_peer_id(peer_id)?;
            if peer_id == receiving_peer_id {
                return Err("single peer: authenticated sender is receiving peer".into());
            }
            Ok(peer_id.clone())
        }
    }
}

/// Plan against exact prior bytes; CAS image and admitted rows as one backend transaction.
pub fn admit_single_peer_transfer<S: DurablePeerStore, P>(
    store: &mut S,
    peer_id: &str,
    input: &SinglePeerTransferInput<'_, P>,
) -> Result<SinglePeerTransferResult, String> {
    canonical_peer_id(peer_id)?;
    let prior = match store.read_image(peer_id)? {
        PeerImageRead::Image(image) => image,
        _ => return Err("single peer: peer is not open".into()),
    };
    let before = decode_durable_peer_state(&prior, peer_id)?;
    let sender = sender(input.origin, peer_id)?;
    let plan = plan_signed_loose_ordinary_transfer_from_verified(
        &before,
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
            return Ok(SinglePeerTransferResult::Rejected {
                reason: failed
                    .reason
                    .clone()
                    .unwrap_or_else(|| failed.status.as_str().into()),
                outcomes: plan.outcomes,
            });
        }
    }
    if plan.admitted_ids.is_empty() {
        return Ok(SinglePeerTransferResult::Committed {
            outcomes: plan.outcomes,
            state: Box::new(before),
            image: prior,
        });
    }
    let next = encode_durable_peer_state(&plan.state)?;
    let admitted: Vec<Delta> = plan
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
    Ok(
        match store.compare_and_set(peer_id, Some(&prior), &next, &admitted)? {
            PeerImageWrite::Durable => SinglePeerTransferResult::Committed {
                outcomes: plan.outcomes,
                state: Box::new(plan.state),
                image: next,
            },
            PeerImageWrite::Conflict => SinglePeerTransferResult::Conflict,
            PeerImageWrite::CommittedUnconfirmed { fault } => {
                SinglePeerTransferResult::CommittedUnconfirmed { fault }
            }
        },
    )
}

/// Single-writer file adapter. Multi-writer stores must supply an atomic backend CAS.
#[cfg(not(target_arch = "wasm32"))]
pub struct FileDurablePeerStore {
    pub path: std::path::PathBuf,
    pub peer_id: String,
}

#[cfg(not(target_arch = "wasm32"))]
impl FileDurablePeerStore {
    pub fn new(path: std::path::PathBuf, peer_id: String) -> Result<Self, String> {
        canonical_peer_id(&peer_id)?;
        Ok(Self { path, peer_id })
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl DurablePeerStore for FileDurablePeerStore {
    fn read_image(&self, peer_id: &str) -> Result<PeerImageRead, String> {
        if peer_id != self.peer_id {
            return Err("single peer: wrong file peer id".into());
        }
        match std::fs::read(&self.path) {
            Ok(image) => Ok(PeerImageRead::Image(image)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PeerImageRead::Empty),
            Err(e) => Err(e.to_string()),
        }
    }

    fn compare_and_set(
        &mut self,
        peer_id: &str,
        expected_prior: Option<&[u8]>,
        next_image: &[u8],
        _newly_admitted: &[Delta],
    ) -> Result<PeerImageWrite, String> {
        use crate::durable_state::write_durable_peer_state;
        use crate::peer_state::PeerStateWriteOutcome;

        if peer_id != self.peer_id {
            return Err("single peer: wrong file peer id".into());
        }
        let state = decode_durable_peer_state(next_image, peer_id)?;
        match write_durable_peer_state(&self.path, &state, expected_prior) {
            Ok(PeerStateWriteOutcome::Durable) => Ok(PeerImageWrite::Durable),
            Ok(PeerStateWriteOutcome::CommittedUnconfirmed { fault }) => {
                Ok(PeerImageWrite::CommittedUnconfirmed { fault })
            }
            Err(error) if error == "durable peer state: expected prior image changed" => {
                Ok(PeerImageWrite::Conflict)
            }
            Err(error) => Err(error),
        }
    }
}
