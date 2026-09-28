//! SPEC-6 §2 step 4 authority and budget filter for verified order candidates.

use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErasureOrderCandidate {
    pub id: String,
    pub target_id: String,
}

/// Must be deterministic and side-effect-free over the supplied pre-transfer view.
pub type ErasureAuthority<'a> = dyn Fn(&ErasureOrderCandidate, &BTreeSet<String>) -> bool + 'a;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErasureFilterPlan {
    pub effective_order_ids: Vec<String>,
    pub ineligible_order_ids: Vec<String>,
    pub limited_order_ids: Vec<String>,
    /// Targets reserved by the budget before the second authority filter. No refill follows.
    pub selected_targets: Vec<String>,
}

fn authority_fixed_point<'a>(
    orders: &[&'a ErasureOrderCandidate],
    admitted_before: &BTreeSet<String>,
    authorize: &ErasureAuthority<'_>,
    ineligible: &mut BTreeSet<String>,
) -> Vec<&'a ErasureOrderCandidate> {
    let mut remaining = orders.to_vec();
    loop {
        let failing: BTreeSet<String> = remaining
            .iter()
            .filter(|order| {
                let hidden: BTreeSet<&String> = remaining
                    .iter()
                    .filter(|other| other.id != order.id && other.target_id != order.target_id)
                    .map(|other| &other.target_id)
                    .collect();
                let visible: BTreeSet<String> = admitted_before
                    .iter()
                    .filter(|id| !hidden.contains(id))
                    .cloned()
                    .collect();
                !authorize(order, &visible)
            })
            .map(|order| order.id.clone())
            .collect();
        if failing.is_empty() {
            return remaining;
        }
        ineligible.extend(failing.iter().cloned());
        remaining.retain(|order| !failing.contains(&order.id));
    }
}

/// Pure staging result. No erasure or admission is committed by this function.
pub fn plan_erasure_filter(
    orders: &[ErasureOrderCandidate],
    admitted_before_ids: &BTreeSet<String>,
    target_budget: usize,
    authorize: &ErasureAuthority<'_>,
) -> Result<ErasureFilterPlan, String> {
    let mut ids = BTreeSet::new();
    for order in orders {
        if order.id.is_empty() || order.target_id.is_empty() || !ids.insert(&order.id) {
            return Err("erasure filter: order ids must be unique and targets nonempty".into());
        }
    }
    let mut ordered: Vec<&ErasureOrderCandidate> = orders.iter().collect();
    ordered.sort_by(|a, b| a.id.cmp(&b.id));
    let mut ineligible = BTreeSet::new();
    let provisional: Vec<&ErasureOrderCandidate> = ordered
        .iter()
        .copied()
        .filter(|order| {
            if authorize(order, admitted_before_ids) {
                true
            } else {
                ineligible.insert(order.id.clone());
                false
            }
        })
        .collect();
    let stable = authority_fixed_point(
        &provisional,
        admitted_before_ids,
        authorize,
        &mut ineligible,
    );
    let mut lowest_by_target: BTreeMap<&str, &str> = BTreeMap::new();
    for order in &stable {
        lowest_by_target
            .entry(&order.target_id)
            .and_modify(|current| {
                if order.id.as_str() < *current {
                    *current = &order.id;
                }
            })
            .or_insert(&order.id);
    }
    let mut ranked_targets: Vec<(&str, &str)> = lowest_by_target.into_iter().collect();
    ranked_targets.sort_by(|a, b| a.1.cmp(b.1).then(a.0.cmp(b.0)));
    let selected_targets: Vec<String> = ranked_targets
        .into_iter()
        .take(target_budget)
        .map(|(target, _)| target.to_string())
        .collect();
    let selected_set: BTreeSet<&str> = selected_targets.iter().map(String::as_str).collect();
    let limited_order_ids: Vec<String> = stable
        .iter()
        .filter(|order| !selected_set.contains(order.target_id.as_str()))
        .map(|order| order.id.clone())
        .collect();
    let selected: Vec<&ErasureOrderCandidate> = stable
        .into_iter()
        .filter(|order| selected_set.contains(order.target_id.as_str()))
        .collect();
    let effective =
        authority_fixed_point(&selected, admitted_before_ids, authorize, &mut ineligible);
    Ok(ErasureFilterPlan {
        effective_order_ids: effective
            .into_iter()
            .map(|order| order.id.clone())
            .collect(),
        ineligible_order_ids: ineligible.into_iter().collect(),
        limited_order_ids,
        selected_targets,
    })
}
