//! Staged transfer entry and candidate-local guards (SPEC-6 vNext §2 steps 1 and 3).

use std::collections::BTreeSet;

use crate::entry::{bundle_entry_status, loose_entry_status, LooseEntryStatus};
use crate::set::DeltaSet;
use crate::types::Delta;

#[derive(Debug, Clone, PartialEq)]
pub enum TransferUnit {
    Loose(Delta),
    Bundle {
        manifest: Delta,
        members: Vec<Delta>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardedUnitStatus {
    Invalid,
    Refused,
    Duplicate,
    GuardRejected,
    Eligible,
}

impl From<LooseEntryStatus> for GuardedUnitStatus {
    fn from(status: LooseEntryStatus) -> Self {
        match status {
            LooseEntryStatus::Invalid => Self::Invalid,
            LooseEntryStatus::Refused => Self::Refused,
            LooseEntryStatus::Duplicate => Self::Duplicate,
            LooseEntryStatus::Eligible => Self::Eligible,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GuardedUnit {
    pub unit: TransferUnit,
    pub status: GuardedUnitStatus,
    pub fresh_ids: Vec<String>,
}

pub type CandidateGuard<S> = dyn Fn(&Delta, &str, &str, &DeltaSet, f64, &S) -> bool;

pub struct PreflightContext<'a, S> {
    pub admitted_before: &'a DeltaSet,
    pub refused_ids: &'a BTreeSet<String>,
    pub sending_peer_id: &'a str,
    pub receiving_peer_id: &'a str,
    pub arrived_at: f64,
    pub policy_state: &'a S,
    pub guards: &'a [&'a CandidateGuard<S>],
}

/// Stage steps 1 and 3 for a transfer without a subscribed lens. The result is not an admission
/// receipt; conflicts, erasure, quota and durable commit still decide what lands.
pub fn preflight_transfer<S>(
    units: &[TransferUnit],
    context: &PreflightContext<'_, S>,
) -> Result<Vec<GuardedUnit>, String> {
    let PreflightContext {
        admitted_before,
        refused_ids,
        sending_peer_id,
        receiving_peer_id,
        arrived_at,
        policy_state,
        guards,
    } = context;
    if sending_peer_id.is_empty() || receiving_peer_id.is_empty() {
        return Err("peer ids must not be empty".into());
    }
    if !arrived_at.is_finite() {
        return Err("arrival time must be finite".into());
    }
    let active_ids: BTreeSet<String> = admitted_before
        .iter()
        .map(|delta| delta.id.clone())
        .collect();
    let verified: Vec<(TransferUnit, GuardedUnitStatus, Vec<Delta>)> = units
        .iter()
        .map(|unit| {
            let (status, candidates) = match unit {
                TransferUnit::Loose(delta) => (
                    loose_entry_status(delta, &active_ids, refused_ids),
                    vec![delta.clone()],
                ),
                TransferUnit::Bundle { manifest, members } => (
                    bundle_entry_status(manifest, members, &active_ids, refused_ids),
                    std::iter::once(manifest)
                        .chain(members.iter())
                        .cloned()
                        .collect(),
                ),
            };
            let mut seen = BTreeSet::new();
            let fresh = if status == LooseEntryStatus::Eligible {
                candidates
                    .into_iter()
                    .filter(|delta| {
                        !active_ids.contains(&delta.id) && seen.insert(delta.id.clone())
                    })
                    .collect()
            } else {
                Vec::new()
            };
            (unit.clone(), status.into(), fresh)
        })
        .collect();
    Ok(verified
        .into_iter()
        .map(|(unit, status, fresh)| {
            if status != GuardedUnitStatus::Eligible {
                return GuardedUnit {
                    unit,
                    status,
                    fresh_ids: Vec::new(),
                };
            }
            for candidate in &fresh {
                for guard in guards.iter() {
                    if !guard(
                        candidate,
                        sending_peer_id,
                        receiving_peer_id,
                        admitted_before,
                        *arrived_at,
                        policy_state,
                    ) {
                        return GuardedUnit {
                            unit,
                            status: GuardedUnitStatus::GuardRejected,
                            fresh_ids: Vec::new(),
                        };
                    }
                }
            }
            GuardedUnit {
                unit,
                status,
                fresh_ids: fresh.into_iter().map(|delta| delta.id).collect(),
            }
        })
        .collect())
}
