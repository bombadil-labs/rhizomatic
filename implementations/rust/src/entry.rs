//! First entry gate for a self-signed loose candidate (SPEC-6 vNext §2 step 1).

use std::collections::BTreeSet;

use crate::set::DeltaSet;
use crate::sign::{verify_delta, Verification};
use crate::types::Delta;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LooseEntryStatus {
    Invalid,
    Refused,
    Duplicate,
    Eligible,
}

/// An eligible delta still passes the lens, guards, conflicts and quota. Unsigned members need
/// verified signed-bundle coverage and never use this gate.
pub fn loose_entry_status(
    delta: &Delta,
    active_ids: &BTreeSet<String>,
    refused_ids: &BTreeSet<String>,
) -> LooseEntryStatus {
    if verify_delta(delta) != Verification::Verified {
        return LooseEntryStatus::Invalid;
    }
    let mut probe = DeltaSet::new();
    if probe.add(delta.clone()).is_err() {
        return LooseEntryStatus::Invalid;
    }
    if refused_ids.contains(&delta.id) {
        return LooseEntryStatus::Refused;
    }
    if active_ids.contains(&delta.id) {
        return LooseEntryStatus::Duplicate;
    }
    LooseEntryStatus::Eligible
}
