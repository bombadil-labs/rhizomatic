//! Receiver-local arrival testimony, assigned after final admission (SPEC-6 vNext §3).

use std::collections::BTreeSet;

// Portable JSON testimony uses exact integer numbers in both witnesses.
const MAX_SEQUENCE: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArrivalCursor {
    pub last_sequence: u64,
    pub last_transfer: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArrivalRecord {
    pub id: String,
    pub at: f64,
    pub sequence: u64,
    pub transfer: u64,
    pub sender: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArrivalPlan {
    pub last_sequence: u64,
    pub last_transfer: u64,
    pub arrivals: Vec<ArrivalRecord>,
}

/// Plan testimony without changing the peer. The caller commits this plan with the accepted ids
/// and persists its counters. `active_ids` names current admissions, not historical arrivals.
pub fn plan_arrivals(
    cursor: ArrivalCursor,
    active_ids: &BTreeSet<String>,
    accepted_ids: &[String],
    at: f64,
    sender: &str,
) -> Result<ArrivalPlan, String> {
    if cursor.last_sequence > MAX_SEQUENCE || cursor.last_transfer > MAX_SEQUENCE {
        return Err("arrival cursor must contain nonnegative safe integers".into());
    }
    if !at.is_finite() {
        return Err("arrival time must be finite".into());
    }
    if sender.is_empty() {
        return Err("arrival sender must not be empty".into());
    }

    let fresh: BTreeSet<&str> = accepted_ids
        .iter()
        .map(String::as_str)
        .filter(|id| !active_ids.contains(*id))
        .collect();
    if fresh.contains("") {
        return Err("arrival id must not be empty".into());
    }
    if fresh.is_empty() {
        return Ok(ArrivalPlan {
            last_sequence: cursor.last_sequence,
            last_transfer: cursor.last_transfer,
            arrivals: Vec::new(),
        });
    }
    let count = u64::try_from(fresh.len()).map_err(|_| "arrival counter exhausted")?;
    let last_sequence = cursor
        .last_sequence
        .checked_add(count)
        .filter(|value| *value <= MAX_SEQUENCE)
        .ok_or("arrival counter exhausted")?;
    let transfer = cursor
        .last_transfer
        .checked_add(1)
        .filter(|value| *value <= MAX_SEQUENCE)
        .ok_or("arrival counter exhausted")?;
    let arrivals = fresh
        .into_iter()
        .enumerate()
        .map(|(i, id)| ArrivalRecord {
            id: id.to_string(),
            at,
            sequence: cursor.last_sequence + u64::try_from(i).expect("bounded by count") + 1,
            transfer,
            sender: sender.to_string(),
        })
        .collect();
    Ok(ArrivalPlan {
        last_sequence,
        last_transfer: transfer,
        arrivals,
    })
}
