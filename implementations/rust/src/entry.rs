//! First entry gate for a self-signed loose candidate (SPEC-6 vNext §2 step 1).

use std::collections::BTreeSet;

use crate::reactor::manifest_member_ids;
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

/// Verify one signed-bundle candidate before lens, guards, or quota.
pub fn bundle_entry_status(
    manifest: &Delta,
    members: &[Delta],
    active_ids: &BTreeSet<String>,
    refused_ids: &BTreeSet<String>,
) -> LooseEntryStatus {
    if verify_delta(manifest) != Verification::Verified {
        return LooseEntryStatus::Invalid;
    }
    let committed = manifest_member_ids(manifest);
    if committed.is_empty()
        || members.is_empty()
        || !members.iter().all(|member| committed.contains(&member.id))
    {
        return LooseEntryStatus::Invalid;
    }
    let has_unsigned = members.iter().any(|member| member.sig.is_none());
    let mut probe = DeltaSet::new();
    for delta in std::iter::once(manifest).chain(members.iter()) {
        if verify_delta(delta) == Verification::Invalid
            || (has_unsigned && delta.claims.author != manifest.claims.author)
            || probe.add(delta.clone()).is_err()
        {
            return LooseEntryStatus::Invalid;
        }
    }
    if std::iter::once(manifest)
        .chain(members.iter())
        .any(|d| refused_ids.contains(&d.id))
    {
        return LooseEntryStatus::Refused;
    }
    if std::iter::once(manifest)
        .chain(members.iter())
        .all(|d| active_ids.contains(&d.id))
    {
        return LooseEntryStatus::Duplicate;
    }
    LooseEntryStatus::Eligible
}
