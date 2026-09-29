//! SPEC-6 §2 step 5 after erasure and dependency pre-pruning. Internal staging result only.

use std::collections::{BTreeMap, BTreeSet};

fn valid_delta_id(id: &str) -> bool {
    id.len() == 68
        && id.starts_with("1e20")
        && id.as_bytes()[4..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

/// Stable tie-breaker for verified loose and bundle appearances.
pub fn ordinary_unit_key(
    delta_id: &str,
    supplied_member_ids: Option<&[String]>,
) -> Result<String, String> {
    if !valid_delta_id(delta_id)
        || supplied_member_ids
            .iter()
            .flat_map(|ids| ids.iter())
            .any(|id| !valid_delta_id(id))
    {
        return Err("ordinary quota: invalid unit id".into());
    }
    match supplied_member_ids {
        None => Ok(delta_id.to_string()),
        Some(ids) => {
            let mut sorted = ids.to_vec();
            sorted.sort();
            Ok(format!("{delta_id}:{}", sorted.join(":")))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrdinaryQuotaUnit {
    /// Stable identity for this offered appearance, including its full supplied member set.
    pub key: String,
    /// Receiver-declared rank; the portable default is the loose or manifest delta id.
    pub rank: String,
    /// Ids this unit would newly add. Overlap between units is charged once.
    pub fresh_ids: Vec<String>,
    /// Post-commit dependencies, including eligible co-offered negations.
    pub requires: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrdinaryQuotaPlan {
    pub selected_keys: Vec<String>,
    pub skipped_keys: Vec<String>,
    pub pruned_keys: Vec<String>,
    pub admitted_ids: Vec<String>,
    pub charged: usize,
}

fn same_ids(a: &[String], b: &[String]) -> bool {
    a.iter().collect::<BTreeSet<_>>() == b.iter().collect::<BTreeSet<_>>()
}

/// Select by stable rank, skip oversized units, then prune requirements to a fixed point.
pub fn plan_ordinary_quota(
    units: &[OrdinaryQuotaUnit],
    existing_ids: &BTreeSet<String>,
    excluded_ids: &BTreeSet<String>,
    fixed_landing_ids: &BTreeSet<String>,
    capacity: usize,
) -> Result<OrdinaryQuotaPlan, String> {
    if !fixed_landing_ids.is_disjoint(excluded_ids) {
        return Err("ordinary quota: fixed landing id cannot be excluded".into());
    }
    let mut by_key: BTreeMap<&str, &OrdinaryQuotaUnit> = BTreeMap::new();
    for unit in units {
        if unit.key.is_empty() || unit.rank.is_empty() {
            return Err("ordinary quota: unit keys and ranks must be nonempty".into());
        }
        if unit
            .fresh_ids
            .iter()
            .any(|id| excluded_ids.contains(id) || fixed_landing_ids.contains(id))
        {
            return Err("ordinary quota: fixed or excluded id reached ordinary selection".into());
        }
        if let Some(previous) = by_key.get(unit.key.as_str()) {
            if previous.rank != unit.rank
                || !same_ids(&previous.fresh_ids, &unit.fresh_ids)
                || !same_ids(&previous.requires, &unit.requires)
            {
                return Err("ordinary quota: conflicting appearances share a unit key".into());
            }
        } else {
            by_key.insert(unit.key.as_str(), unit);
        }
    }
    let mut ordered: Vec<&OrdinaryQuotaUnit> = by_key.into_values().collect();
    ordered.sort_by(|a, b| a.rank.cmp(&b.rank).then(a.key.cmp(&b.key)));
    let mut charged = BTreeSet::new();
    let mut selected: BTreeSet<String> = BTreeSet::new();
    let mut skipped: BTreeSet<String> = BTreeSet::new();
    for unit in &ordered {
        let needed: BTreeSet<&String> = unit
            .fresh_ids
            .iter()
            .filter(|id| !existing_ids.contains(*id) && !charged.contains(*id))
            .collect();
        if needed.len() > capacity.saturating_sub(charged.len()) {
            skipped.insert(unit.key.clone());
            continue;
        }
        selected.insert(unit.key.clone());
        charged.extend(needed.into_iter().cloned());
    }
    let mut pruned: BTreeSet<String> = BTreeSet::new();
    loop {
        let mut available: BTreeSet<String> =
            existing_ids.difference(excluded_ids).cloned().collect();
        available.extend(fixed_landing_ids.iter().cloned());
        for unit in &ordered {
            if selected.contains(&unit.key) {
                available.extend(unit.fresh_ids.iter().cloned());
            }
        }
        let failing: Vec<String> = ordered
            .iter()
            .filter(|unit| {
                selected.contains(&unit.key)
                    && unit.requires.iter().any(|id| !available.contains(id))
            })
            .map(|unit| unit.key.clone())
            .collect();
        if failing.is_empty() {
            break;
        }
        for key in failing {
            selected.remove(&key);
            pruned.insert(key);
        }
    }
    let mut admitted = BTreeSet::new();
    for unit in &ordered {
        if selected.contains(&unit.key) {
            admitted.extend(
                unit.fresh_ids
                    .iter()
                    .filter(|id| !existing_ids.contains(*id))
                    .cloned(),
            );
        }
    }
    let final_charge = admitted.len();
    Ok(OrdinaryQuotaPlan {
        selected_keys: ordered
            .iter()
            .filter(|u| selected.contains(&u.key))
            .map(|u| u.key.clone())
            .collect(),
        skipped_keys: ordered
            .iter()
            .filter(|u| skipped.contains(&u.key))
            .map(|u| u.key.clone())
            .collect(),
        pruned_keys: ordered
            .iter()
            .filter(|u| pruned.contains(&u.key))
            .map(|u| u.key.clone())
            .collect(),
        admitted_ids: admitted.into_iter().collect(),
        charged: final_charge,
    })
}
