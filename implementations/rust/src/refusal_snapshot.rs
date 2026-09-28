//! Internal inherited-refusal snapshot. Its digest binds bytes; a handoff commit must authenticate it.

use std::collections::{BTreeMap, BTreeSet};

use crate::cbor::{decode, encode, CborValue};
use crate::durable_state::{encode_durable_peer_state, DurablePeerState};
use crate::hash::content_address;

const VERSION: f64 = 1.0;
const MAX_COUNTER: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualifiedEventRef {
    pub source_peer_id: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualifiedRefusalEvent {
    pub source_peer_id: String,
    pub sequence: u64,
    pub target_id: String,
    pub order_ids: Vec<String>,
    pub prior_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentRefusal {
    pub source_peer_id: String,
    pub sequence: u64,
    pub target_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusalSnapshot {
    pub events: Vec<QualifiedRefusalEvent>,
    pub current: Vec<CurrentRefusal>,
}

/// Capture every local event, including superseded events, from a valid durable image.
pub fn local_refusal_snapshot(state: &DurablePeerState) -> Result<RefusalSnapshot, String> {
    encode_durable_peer_state(state)?;
    let mut latest = BTreeMap::new();
    let events = state
        .events
        .iter()
        .map(|event| {
            latest.insert(
                event.target_id.clone(),
                CurrentRefusal {
                    source_peer_id: state.base.peer_id.clone(),
                    sequence: event.sequence,
                    target_id: event.target_id.clone(),
                },
            );
            QualifiedRefusalEvent {
                source_peer_id: state.base.peer_id.clone(),
                sequence: event.sequence,
                target_id: event.target_id.clone(),
                order_ids: event.order_ids.clone(),
                prior_epoch: event.prior_epoch,
            }
        })
        .collect();
    Ok(RefusalSnapshot {
        events,
        current: latest.into_values().collect(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveredRefusalSnapshot {
    pub snapshot: RefusalSnapshot,
    pub bytes: Vec<u8>,
    pub used_recovery: bool,
}

fn valid_id(id: &str) -> bool {
    id.len() == 68
        && id.starts_with("1e20")
        && id.as_bytes()[4..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

fn positive(n: u64) -> bool {
    n > 0 && n <= MAX_COUNTER
}

fn validate(snapshot: &RefusalSnapshot) -> Result<(), String> {
    let mut events = BTreeMap::new();
    let mut targets = BTreeSet::new();
    let mut orders = BTreeSet::new();
    for event in &snapshot.events {
        if event.source_peer_id.is_empty()
            || !positive(event.sequence)
            || !valid_id(&event.target_id)
            || event.order_ids.is_empty()
            || event.prior_epoch.is_some_and(|n| !positive(n))
            || events
                .insert((&event.source_peer_id, event.sequence), &event.target_id)
                .is_some()
        {
            return Err("refusal snapshot: invalid event".into());
        }
        for order in &event.order_ids {
            if !valid_id(order) || order == &event.target_id || !orders.insert(order) {
                return Err("refusal snapshot: invalid order".into());
            }
        }
        targets.insert(&event.target_id);
    }
    let mut current = BTreeSet::new();
    for row in &snapshot.current {
        if !valid_id(&row.target_id)
            || !current.insert(&row.target_id)
            || events.get(&(&row.source_peer_id, row.sequence)) != Some(&&row.target_id)
            || snapshot.events.iter().any(|other| {
                other.target_id == row.target_id
                    && other.source_peer_id == row.source_peer_id
                    && other.sequence > row.sequence
            })
        {
            return Err("refusal snapshot: invalid current event".into());
        }
    }
    if current != targets {
        return Err("refusal snapshot: missing current event".into());
    }
    Ok(())
}

fn reference_fields(source: &str, sequence: u64) -> Vec<(String, CborValue)> {
    vec![
        ("source".into(), CborValue::Tstr(source.into())),
        ("sequence".into(), CborValue::Float(sequence as f64)),
    ]
}

/// Canonical private image, independent of input order.
pub fn encode_refusal_snapshot(snapshot: &RefusalSnapshot) -> Result<Vec<u8>, String> {
    validate(snapshot)?;
    let mut events = snapshot.events.clone();
    events.sort_by(|a, b| {
        a.source_peer_id
            .cmp(&b.source_peer_id)
            .then(a.sequence.cmp(&b.sequence))
    });
    let mut current = snapshot.current.clone();
    current.sort_by(|a, b| a.target_id.cmp(&b.target_id));
    Ok(encode(&CborValue::Map(vec![
        ("version".into(), CborValue::Float(VERSION)),
        (
            "events".into(),
            CborValue::Array(
                events
                    .into_iter()
                    .map(|event| {
                        let mut fields = reference_fields(&event.source_peer_id, event.sequence);
                        fields.push(("target".into(), CborValue::Tstr(event.target_id)));
                        let mut orders = event.order_ids;
                        orders.sort();
                        fields.push((
                            "orders".into(),
                            CborValue::Array(orders.into_iter().map(CborValue::Tstr).collect()),
                        ));
                        if let Some(epoch) = event.prior_epoch {
                            fields.push(("epoch".into(), CborValue::Float(epoch as f64)));
                        }
                        CborValue::Map(fields)
                    })
                    .collect(),
            ),
        ),
        (
            "current".into(),
            CborValue::Array(
                current
                    .into_iter()
                    .map(|row| {
                        let mut fields = reference_fields(&row.source_peer_id, row.sequence);
                        fields.push(("target".into(), CborValue::Tstr(row.target_id)));
                        CborValue::Map(fields)
                    })
                    .collect(),
            ),
        ),
    ])))
}

fn fields(value: &CborValue, size: usize) -> Result<BTreeMap<String, CborValue>, String> {
    let CborValue::Map(entries) = value else {
        return Err("refusal snapshot: invalid fields".into());
    };
    if entries.len() != size {
        return Err("refusal snapshot: invalid fields".into());
    }
    let result: BTreeMap<String, CborValue> = entries.iter().cloned().collect();
    if result.len() != size {
        return Err("refusal snapshot: duplicate field".into());
    }
    Ok(result)
}

fn string(value: Option<&CborValue>) -> Result<String, String> {
    match value {
        Some(CborValue::Tstr(s)) => Ok(s.clone()),
        _ => Err("refusal snapshot: expected text".into()),
    }
}

fn number(value: Option<&CborValue>) -> Result<u64, String> {
    match value {
        Some(CborValue::Float(n)) if *n >= 0.0 && *n <= MAX_COUNTER as f64 && n.fract() == 0.0 => {
            Ok(*n as u64)
        }
        _ => Err("refusal snapshot: expected number".into()),
    }
}

fn items(value: Option<&CborValue>) -> Result<&[CborValue], String> {
    match value {
        Some(CborValue::Array(rows)) => Ok(rows),
        _ => Err("refusal snapshot: expected array".into()),
    }
}

pub fn decode_refusal_snapshot(bytes: &[u8]) -> Result<RefusalSnapshot, String> {
    let top = fields(&decode(bytes)?, 3)?;
    if number(top.get("version"))? != 1 {
        return Err("refusal snapshot: unsupported version".into());
    }
    let events = items(top.get("events"))?
        .iter()
        .map(|value| {
            let CborValue::Map(entries) = value else {
                return Err("refusal snapshot: invalid event fields".into());
            };
            let row = fields(value, entries.len())?;
            if row.len() != 4 && row.len() != 5 {
                return Err("refusal snapshot: invalid event fields".into());
            }
            Ok(QualifiedRefusalEvent {
                source_peer_id: string(row.get("source"))?,
                sequence: number(row.get("sequence"))?,
                target_id: string(row.get("target"))?,
                order_ids: items(row.get("orders"))?
                    .iter()
                    .map(|v| string(Some(v)))
                    .collect::<Result<_, _>>()?,
                prior_epoch: row.get("epoch").map(|v| number(Some(v))).transpose()?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let current = items(top.get("current"))?
        .iter()
        .map(|value| {
            let row = fields(value, 3)?;
            Ok(CurrentRefusal {
                source_peer_id: string(row.get("source"))?,
                sequence: number(row.get("sequence"))?,
                target_id: string(row.get("target"))?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let snapshot = RefusalSnapshot { events, current };
    if encode_refusal_snapshot(&snapshot)? != bytes {
        return Err("refusal snapshot: noncanonical image".into());
    }
    Ok(snapshot)
}

pub fn refusal_snapshot_digest(snapshot: &RefusalSnapshot) -> Result<String, String> {
    Ok(content_address(&encode_refusal_snapshot(snapshot)?))
}

/// Validate an immutable primary or independent recovery copy against the committed digest.
pub fn recover_refusal_snapshot(
    expected_digest: &str,
    primary: Option<&[u8]>,
    recovery: Option<&[u8]>,
) -> Result<RecoveredRefusalSnapshot, String> {
    for (candidate, used_recovery) in [(primary, false), (recovery, true)] {
        if let Some(bytes) = candidate {
            if content_address(bytes) == expected_digest {
                if let Ok(snapshot) = decode_refusal_snapshot(bytes) {
                    return Ok(RecoveredRefusalSnapshot {
                        snapshot,
                        bytes: bytes.to_vec(),
                        used_recovery,
                    });
                }
            }
        }
    }
    Err("refusal snapshot: no verified copy".into())
}
