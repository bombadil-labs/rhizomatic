//! Internal ordinary-only admission path. A classifier keeps erasure candidates out of this path.

use std::collections::{BTreeMap, BTreeSet};

use crate::durable_state::{plan_permanent_commit, DurablePeerState, PermanentCommitInput};
use crate::ordinary_quota::{plan_ordinary_quota, OrdinaryQuotaUnit};
use crate::preflight::{
    preflight_transfer, CandidateGuard, GuardedUnitStatus, PreflightContext, TransferUnit,
};
use crate::types::{Delta, Target};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignedLooseOutcomeStatus {
    Invalid,
    Refused,
    Duplicate,
    GuardRejected,
    UnsupportedErasure,
    Admitted,
    QuotaSkipped,
    DependencyPruned,
}

impl SignedLooseOutcomeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::Refused => "refused",
            Self::Duplicate => "duplicate",
            Self::GuardRejected => "guard-rejected",
            Self::UnsupportedErasure => "unsupported-erasure",
            Self::Admitted => "admitted",
            Self::QuotaSkipped => "quota-skipped",
            Self::DependencyPruned => "dependency-pruned",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedLooseOutcome {
    pub id: String,
    pub status: SignedLooseOutcomeStatus,
    pub reason: Option<String>,
}

pub struct SignedLooseTransferInput<'a, S> {
    pub offered: &'a [Delta],
    pub sending_peer_id: &'a str,
    pub arrived_at: f64,
    pub capacity: usize,
    pub policy_state: &'a S,
    pub guards: &'a [&'a CandidateGuard<S>],
    /// Receiver classification, evaluated only for verified, guard-passing candidates.
    pub is_erasure_candidate: &'a dyn Fn(&Delta) -> bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SignedLooseTransferPlan {
    pub state: DurablePeerState,
    pub outcomes: Vec<SignedLooseOutcome>,
    pub admitted_ids: Vec<String>,
}

fn negates(delta: &Delta, id: &str) -> bool {
    delta.claims.pointers.iter().any(|pointer| {
        pointer.role == "negates"
            && matches!(&pointer.target, Target::Delta(reference) if reference.delta == id)
    })
}

/// Steps 1, 3, 5, and 6 for signed loose ordinary candidates, with no lens or conflict rule.
pub fn plan_signed_loose_ordinary_transfer<S>(
    before: &DurablePeerState,
    input: &SignedLooseTransferInput<'_, S>,
) -> Result<SignedLooseTransferPlan, String> {
    let active: BTreeSet<String> = before.base.admitted.iter().map(|d| d.id.clone()).collect();
    let units: Vec<TransferUnit> = input
        .offered
        .iter()
        .cloned()
        .map(TransferUnit::Loose)
        .collect();
    let guarded = preflight_transfer(
        &units,
        &PreflightContext {
            admitted_before: &before.base.admitted,
            refused_ids: &before.base.refused_ids,
            sending_peer_id: input.sending_peer_id,
            receiving_peer_id: &before.base.peer_id,
            arrived_at: input.arrived_at,
            policy_state: input.policy_state,
            guards: input.guards,
        },
    )?;
    let stable_offered: Vec<Delta> = guarded
        .iter()
        .map(|unit| match &unit.unit {
            TransferUnit::Loose(delta) => delta.clone(),
            TransferUnit::Bundle { .. } => {
                unreachable!("signed loose admission supplied only loose units")
            }
        })
        .collect();
    let mut candidates = BTreeMap::new();
    let mut classified = BTreeMap::new();
    let statuses: Vec<SignedLooseOutcomeStatus> = guarded
        .iter()
        .zip(&stable_offered)
        .map(|(unit, delta)| match unit.status {
            GuardedUnitStatus::Invalid => SignedLooseOutcomeStatus::Invalid,
            GuardedUnitStatus::Refused => SignedLooseOutcomeStatus::Refused,
            GuardedUnitStatus::Duplicate => SignedLooseOutcomeStatus::Duplicate,
            GuardedUnitStatus::GuardRejected => SignedLooseOutcomeStatus::GuardRejected,
            GuardedUnitStatus::Eligible => {
                let erasure = *classified
                    .entry(delta.id.clone())
                    .or_insert_with(|| (input.is_erasure_candidate)(delta));
                if erasure {
                    SignedLooseOutcomeStatus::UnsupportedErasure
                } else {
                    candidates.insert(delta.id.clone(), delta.clone());
                    SignedLooseOutcomeStatus::Admitted
                }
            }
        })
        .collect();
    let ordinary: Vec<OrdinaryQuotaUnit> = candidates
        .values()
        .map(|delta| OrdinaryQuotaUnit {
            key: delta.id.clone(),
            rank: delta.id.clone(),
            fresh_ids: vec![delta.id.clone()],
            requires: candidates
                .values()
                .filter(|other| negates(other, &delta.id))
                .map(|other| other.id.clone())
                .collect(),
        })
        .collect();
    let quota = plan_ordinary_quota(
        &ordinary,
        &active,
        &BTreeSet::new(),
        &BTreeSet::new(),
        input.capacity,
    )?;
    let admitted: BTreeSet<&str> = quota.admitted_ids.iter().map(String::as_str).collect();
    let skipped: BTreeSet<&str> = quota.skipped_keys.iter().map(String::as_str).collect();
    let pruned: BTreeSet<&str> = quota.pruned_keys.iter().map(String::as_str).collect();
    let outcomes = stable_offered
        .iter()
        .zip(statuses)
        .zip(&guarded)
        .map(|((delta, status), guarded)| {
            let status = if status == SignedLooseOutcomeStatus::Admitted {
                if admitted.contains(delta.id.as_str()) {
                    SignedLooseOutcomeStatus::Admitted
                } else if skipped.contains(delta.id.as_str()) {
                    SignedLooseOutcomeStatus::QuotaSkipped
                } else if pruned.contains(delta.id.as_str()) {
                    SignedLooseOutcomeStatus::DependencyPruned
                } else {
                    return Err("signed loose admission: eligible id has no quota outcome".into());
                }
            } else {
                status
            };
            Ok(SignedLooseOutcome {
                id: delta.id.clone(),
                status,
                reason: guarded.reason.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let additions = quota
        .admitted_ids
        .iter()
        .map(|id| candidates[id].clone())
        .collect();
    let state = plan_permanent_commit(
        before,
        &PermanentCommitInput {
            additions,
            erasures: Vec::new(),
            quota_charge: quota.charged as u64,
            at: input.arrived_at,
            sender: input.sending_peer_id.into(),
        },
    )?;
    Ok(SignedLooseTransferPlan {
        state,
        outcomes,
        admitted_ids: quota.admitted_ids,
    })
}

/// Single-writer file operation. The expected bytes are also the planning snapshot.
#[cfg(not(target_arch = "wasm32"))]
pub fn admit_signed_loose_ordinary_transfer<S>(
    path: &std::path::Path,
    expected_prior: &[u8],
    peer_id: &str,
    input: &SignedLooseTransferInput<'_, S>,
) -> Result<
    (
        SignedLooseTransferPlan,
        crate::peer_state::PeerStateWriteOutcome,
    ),
    String,
> {
    use crate::durable_state::{decode_durable_peer_state, write_durable_peer_state};
    let before = decode_durable_peer_state(expected_prior, peer_id)?;
    let plan = plan_signed_loose_ordinary_transfer(&before, input)?;
    let write = write_durable_peer_state(path, &plan.state, Some(expected_prior))?;
    Ok((plan, write))
}
