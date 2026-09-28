//! Internal permanent-posture image: the v1 holding/arrival base and erasure ledger commit together.
//! Handoff, imported qualified references, lower-posture re-entry, and storage proof are later work.

use std::collections::{BTreeMap, BTreeSet};

use crate::arrival::{plan_arrivals, ArrivalCursor};
use crate::cbor::{decode, encode, CborValue};
#[cfg(not(target_arch = "wasm32"))]
use crate::peer_state::PeerStateWriteOutcome;
use crate::peer_state::{decode_peer_state, encode_peer_state, PeerState};
use crate::{Delta, DeltaSet};

const VERSION: f64 = 2.0;
const MAX_COUNTER: u64 = (1_u64 << 53) - 1;

fn valid_delta_id(id: &str) -> bool {
    id.len() == 68
        && id.starts_with("1e20")
        && id.as_bytes()[4..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusalEvent {
    pub sequence: u64,
    pub target_id: String,
    pub order_ids: Vec<String>,
    pub prior_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErasureExclusion {
    pub order_id: String,
    pub target_id: String,
    pub event_sequence: u64,
    pub prior_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurgeObligation {
    /// Stable local obligation identity, separate from refusal sequence.
    pub sequence: u64,
    pub target_id: String,
    /// Storage worker fence; remains stable across later orders for this target.
    pub generation: u64,
    pub event_sequence: u64,
    pub prior_epoch: Option<u64>,
    pub status: String,
    pub fault: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DurablePeerState {
    pub base: PeerState,
    pub refusal_counter: u64,
    pub obligation_counter: u64,
    pub quota_used: u64,
    pub events: Vec<RefusalEvent>,
    pub exclusions: Vec<ErasureExclusion>,
    pub obligations: Vec<PurgeObligation>,
}

/// Final verified admission decisions. The caller supplies the surface ownership fact.
#[derive(Debug, Clone)]
pub struct PermanentCommitInput {
    pub additions: Vec<Delta>,
    pub erasures: Vec<PermanentErasure>,
    pub quota_charge: u64,
    pub at: f64,
    pub sender: String,
}

#[derive(Debug, Clone)]
pub struct PermanentErasure {
    pub target_id: String,
    pub order_ids: Vec<String>,
    pub surface_holds_bytes: bool,
}

fn validate(state: &DurablePeerState) -> Result<(), String> {
    encode_peer_state(&state.base)?;
    if state.refusal_counter > MAX_COUNTER
        || state.obligation_counter > MAX_COUNTER
        || state.quota_used > MAX_COUNTER
    {
        return Err("durable peer state: invalid counter".into());
    }
    if state.events.len() as u64 != state.refusal_counter {
        return Err("durable peer state: refusal history does not match counter".into());
    }
    if state.obligations.len() as u64 != state.obligation_counter {
        return Err("durable peer state: obligation history does not match counter".into());
    }
    let arrived: BTreeMap<&str, u64> = state
        .base
        .arrivals
        .iter()
        .map(|row| (row.id.as_str(), row.sequence))
        .collect();
    let mut latest_by_target: BTreeMap<&str, &RefusalEvent> = BTreeMap::new();
    let mut event_by_order: BTreeMap<&str, &RefusalEvent> = BTreeMap::new();
    for (i, event) in state.events.iter().enumerate() {
        if event.sequence != i as u64 + 1
            || !valid_delta_id(&event.target_id)
            || event.order_ids.is_empty()
        {
            return Err("durable peer state: invalid refusal event".into());
        }
        if event.prior_epoch != arrived.get(event.target_id.as_str()).copied() {
            return Err("durable peer state: refusal targets wrong admission epoch".into());
        }
        let mut last_order = "";
        for order_id in &event.order_ids {
            let order = state.base.admitted.get(order_id);
            if !valid_delta_id(order_id)
                || order_id.as_str() <= last_order
                || order_id == &event.target_id
                || !order.is_some_and(|delta| delta.sig.is_some())
                || event_by_order.contains_key(order_id.as_str())
            {
                return Err("durable peer state: invalid effective order".into());
            }
            event_by_order.insert(order_id.as_str(), event);
            last_order = order_id;
        }
        latest_by_target.insert(event.target_id.as_str(), event);
    }
    let event_targets: BTreeSet<String> = latest_by_target.keys().map(|id| (*id).into()).collect();
    if event_targets != state.base.refused_ids {
        return Err("durable peer state: refusals do not match events".into());
    }
    let mut excluded_orders = BTreeSet::new();
    for exclusion in &state.exclusions {
        let event = event_by_order.get(exclusion.order_id.as_str());
        if !excluded_orders.insert(&exclusion.order_id)
            || !event.is_some_and(|event| {
                exclusion.target_id == event.target_id
                    && exclusion.event_sequence == event.sequence
                    && exclusion.prior_epoch == event.prior_epoch
            })
        {
            return Err("durable peer state: invalid exclusion".into());
        }
    }
    if excluded_orders.len() != event_by_order.len() {
        return Err("durable peer state: effective order lacks exclusion".into());
    }
    let mut obligation_targets = BTreeSet::new();
    for (i, obligation) in state.obligations.iter().enumerate() {
        let event = latest_by_target.get(obligation.target_id.as_str());
        if obligation.sequence != i as u64 + 1
            || obligation.generation != 1
            || !obligation_targets.insert(obligation.target_id.as_str())
            || !event.is_some_and(|event| {
                obligation.event_sequence == event.sequence
                    && obligation.prior_epoch == event.prior_epoch
            })
            || !matches!(obligation.status.as_str(), "pending" | "failed" | "removed")
            || (obligation.status == "failed"
                && !obligation
                    .fault
                    .as_ref()
                    .is_some_and(|fault| !fault.is_empty()))
            || (obligation.status != "failed" && obligation.fault.is_some())
        {
            return Err("durable peer state: invalid purge obligation".into());
        }
    }
    for event in latest_by_target.values() {
        if event.prior_epoch.is_some() && !obligation_targets.contains(event.target_id.as_str()) {
            return Err("durable peer state: held refusal lacks purge obligation".into());
        }
    }
    Ok(())
}

fn field_map(value: &CborValue, label: &str) -> Result<BTreeMap<String, CborValue>, String> {
    let CborValue::Map(entries) = value else {
        return Err(format!("durable peer state: {label} must be a map"));
    };
    let out: BTreeMap<String, CborValue> = entries.iter().cloned().collect();
    if out.len() != entries.len() {
        return Err(format!("durable peer state: duplicate {label} key"));
    }
    Ok(out)
}
fn number(value: Option<&CborValue>, label: &str) -> Result<u64, String> {
    match value {
        Some(CborValue::Float(n)) if *n >= 0.0 && *n <= MAX_COUNTER as f64 && n.fract() == 0.0 => {
            Ok(*n as u64)
        }
        _ => Err(format!(
            "durable peer state: {label} must be a safe counter"
        )),
    }
}
fn string(value: Option<&CborValue>, label: &str) -> Result<String, String> {
    match value {
        Some(CborValue::Tstr(s)) => Ok(s.clone()),
        _ => Err(format!("durable peer state: {label} must be text")),
    }
}
fn items<'a>(value: Option<&'a CborValue>, label: &str) -> Result<&'a [CborValue], String> {
    match value {
        Some(CborValue::Array(v)) => Ok(v),
        _ => Err(format!("durable peer state: {label} must be an array")),
    }
}
fn epoch_field(epoch: Option<u64>) -> Vec<(String, CborValue)> {
    epoch
        .map(|value| vec![("epoch".into(), CborValue::Float(value as f64))])
        .unwrap_or_default()
}
fn optional_epoch(row: &BTreeMap<String, CborValue>) -> Result<Option<u64>, String> {
    row.get("epoch")
        .map(|value| number(Some(value), "epoch"))
        .transpose()
}

/// Canonical local image; it embeds the complete v1 base as bytes.
pub fn encode_durable_peer_state(state: &DurablePeerState) -> Result<Vec<u8>, String> {
    validate(state)?;
    let events = state
        .events
        .iter()
        .map(|event| {
            let mut fields = vec![
                ("sequence".into(), CborValue::Float(event.sequence as f64)),
                ("target".into(), CborValue::Tstr(event.target_id.clone())),
                (
                    "orders".into(),
                    CborValue::Array(
                        event
                            .order_ids
                            .iter()
                            .cloned()
                            .map(CborValue::Tstr)
                            .collect(),
                    ),
                ),
            ];
            fields.extend(epoch_field(event.prior_epoch));
            CborValue::Map(fields)
        })
        .collect();
    let mut exclusions = state.exclusions.clone();
    exclusions.sort_by(|a, b| a.order_id.cmp(&b.order_id));
    let exclusions = exclusions
        .iter()
        .map(|exclusion| {
            let mut fields = vec![
                ("order".into(), CborValue::Tstr(exclusion.order_id.clone())),
                (
                    "target".into(),
                    CborValue::Tstr(exclusion.target_id.clone()),
                ),
                (
                    "event".into(),
                    CborValue::Float(exclusion.event_sequence as f64),
                ),
            ];
            fields.extend(epoch_field(exclusion.prior_epoch));
            CborValue::Map(fields)
        })
        .collect();
    let obligations = state
        .obligations
        .iter()
        .map(|obligation| {
            let mut fields = vec![
                (
                    "sequence".into(),
                    CborValue::Float(obligation.sequence as f64),
                ),
                (
                    "target".into(),
                    CborValue::Tstr(obligation.target_id.clone()),
                ),
                (
                    "generation".into(),
                    CborValue::Float(obligation.generation as f64),
                ),
                (
                    "event".into(),
                    CborValue::Float(obligation.event_sequence as f64),
                ),
                ("status".into(), CborValue::Tstr(obligation.status.clone())),
            ];
            fields.extend(epoch_field(obligation.prior_epoch));
            if let Some(fault) = &obligation.fault {
                fields.push(("fault".into(), CborValue::Tstr(fault.clone())));
            }
            CborValue::Map(fields)
        })
        .collect();
    Ok(encode(&CborValue::Map(vec![
        ("version".into(), CborValue::Float(VERSION)),
        ("peer".into(), CborValue::Tstr(state.base.peer_id.clone())),
        (
            "base".into(),
            CborValue::Bstr(encode_peer_state(&state.base)?),
        ),
        (
            "refusalCounter".into(),
            CborValue::Float(state.refusal_counter as f64),
        ),
        (
            "obligationCounter".into(),
            CborValue::Float(state.obligation_counter as f64),
        ),
        (
            "quotaUsed".into(),
            CborValue::Float(state.quota_used as f64),
        ),
        ("events".into(), CborValue::Array(events)),
        ("exclusions".into(), CborValue::Array(exclusions)),
        ("obligations".into(), CborValue::Array(obligations)),
    ])))
}

pub fn decode_durable_peer_state(
    bytes: &[u8],
    expected_peer_id: &str,
) -> Result<DurablePeerState, String> {
    let top = field_map(&decode(bytes)?, "image")?;
    if top.len() != 9 || number(top.get("version"), "version")? != VERSION as u64 {
        return Err("durable peer state: unsupported image version or fields".into());
    }
    let peer_id = string(top.get("peer"), "peer")?;
    if peer_id != expected_peer_id {
        return Err("durable peer state: wrong peer id".into());
    }
    let base_bytes = match top.get("base") {
        Some(CborValue::Bstr(bytes)) => bytes,
        _ => return Err("durable peer state: base must be bytes".into()),
    };
    let base = decode_peer_state(base_bytes, expected_peer_id)?;
    let events = items(top.get("events"), "events")?
        .iter()
        .map(|value| {
            let row = field_map(value, "event")?;
            if row.len() != if row.contains_key("epoch") { 4 } else { 3 } {
                return Err("durable peer state: invalid event fields".into());
            }
            Ok(RefusalEvent {
                sequence: number(row.get("sequence"), "event sequence")?,
                target_id: string(row.get("target"), "event target")?,
                order_ids: items(row.get("orders"), "event orders")?
                    .iter()
                    .map(|v| string(Some(v), "order id"))
                    .collect::<Result<_, _>>()?,
                prior_epoch: optional_epoch(&row)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let exclusions = items(top.get("exclusions"), "exclusions")?
        .iter()
        .map(|value| {
            let row = field_map(value, "exclusion")?;
            if row.len() != if row.contains_key("epoch") { 4 } else { 3 } {
                return Err("durable peer state: invalid exclusion fields".into());
            }
            Ok(ErasureExclusion {
                order_id: string(row.get("order"), "exclusion order")?,
                target_id: string(row.get("target"), "exclusion target")?,
                event_sequence: number(row.get("event"), "exclusion event")?,
                prior_epoch: optional_epoch(&row)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let obligations = items(top.get("obligations"), "obligations")?
        .iter()
        .map(|value| {
            let row = field_map(value, "obligation")?;
            if row.len()
                != 5 + usize::from(row.contains_key("epoch"))
                    + usize::from(row.contains_key("fault"))
            {
                return Err("durable peer state: invalid obligation fields".into());
            }
            Ok(PurgeObligation {
                sequence: number(row.get("sequence"), "obligation sequence")?,
                target_id: string(row.get("target"), "obligation target")?,
                generation: number(row.get("generation"), "obligation generation")?,
                event_sequence: number(row.get("event"), "obligation event")?,
                prior_epoch: optional_epoch(&row)?,
                status: string(row.get("status"), "obligation status")?,
                fault: row
                    .get("fault")
                    .map(|v| string(Some(v), "obligation fault"))
                    .transpose()?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let state = DurablePeerState {
        base,
        refusal_counter: number(top.get("refusalCounter"), "refusal counter")?,
        obligation_counter: number(top.get("obligationCounter"), "obligation counter")?,
        quota_used: number(top.get("quotaUsed"), "quota counter")?,
        events,
        exclusions,
        obligations,
    };
    validate(&state)?;
    if encode_durable_peer_state(&state)? != bytes {
        return Err("durable peer state: noncanonical image".into());
    }
    Ok(state)
}

fn validate_transition(before: &DurablePeerState, after: &DurablePeerState) -> Result<(), String> {
    if after.quota_used < before.quota_used {
        return Err("durable peer state: quota counter cannot shrink".into());
    }
    if after.base.arrivals.len() < before.base.arrivals.len() {
        return Err("durable peer state: arrival history cannot shrink".into());
    }
    if after.base.arrivals[..before.base.arrivals.len()] != before.base.arrivals {
        return Err("durable peer state: prior arrival changed".into());
    }
    if !before.base.refused_ids.is_subset(&after.base.refused_ids) {
        return Err("durable peer state: permanent refusal cannot be removed".into());
    }
    for delta in before.base.admitted.iter() {
        match after.base.admitted.get(&delta.id) {
            None if !after.base.refused_ids.contains(&delta.id) => {
                return Err("durable peer state: holding lost without refusal".into());
            }
            Some(current) if current.sig != delta.sig => {
                return Err("durable peer state: admitted signature changed".into());
            }
            _ => {}
        }
    }
    if after.events.len() < before.events.len()
        || after.obligations.len() < before.obligations.len()
    {
        return Err("durable peer state: ledger history cannot shrink".into());
    }
    if after.events[..before.events.len()] != before.events {
        return Err("durable peer state: prior refusal event changed".into());
    }
    let new_arrivals = &after.base.arrivals[before.base.arrivals.len()..];
    let new_ids: BTreeSet<&str> = new_arrivals.iter().map(|row| row.id.as_str()).collect();
    let mut new_orders = BTreeSet::new();
    for event in &after.events[before.events.len()..] {
        for order_id in &event.order_ids {
            if !new_ids.contains(order_id.as_str()) {
                return Err("durable peer state: new effective order lacks new arrival".into());
            }
            new_orders.insert(order_id.as_str());
        }
    }
    if after.quota_used - before.quota_used != (new_arrivals.len() - new_orders.len()) as u64 {
        return Err("durable peer state: quota growth must equal new ordinary arrivals".into());
    }
    let exclusions: BTreeMap<&str, &ErasureExclusion> = after
        .exclusions
        .iter()
        .map(|row| (row.order_id.as_str(), row))
        .collect();
    for row in &before.exclusions {
        if exclusions.get(row.order_id.as_str()).copied() != Some(row) {
            return Err("durable peer state: prior exclusion changed".into());
        }
    }
    for (a, b) in before.obligations.iter().zip(after.obligations.iter()) {
        if a.sequence != b.sequence
            || a.target_id != b.target_id
            || a.generation != b.generation
            || a.prior_epoch != b.prior_epoch
            || (a.status == "removed" && b.status != "removed")
        {
            return Err("durable peer state: obligation identity or terminal state changed".into());
        }
    }
    Ok(())
}

/// Form one atomic permanent-posture image from already verified admission decisions.
pub fn plan_permanent_commit(
    before: &DurablePeerState,
    input: &PermanentCommitInput,
) -> Result<DurablePeerState, String> {
    validate(before)?;
    if input.quota_charge > input.additions.len() as u64
        || before
            .quota_used
            .checked_add(input.quota_charge)
            .is_none_or(|sum| sum > MAX_COUNTER)
    {
        return Err("durable peer state: invalid quota charge".into());
    }
    let mut additions = BTreeMap::new();
    for delta in &input.additions {
        if additions.insert(delta.id.clone(), delta.clone()).is_some()
            || before.base.admitted.contains(&delta.id)
            || before.base.refused_ids.contains(&delta.id)
        {
            return Err("durable peer state: addition is duplicate or refused".into());
        }
    }
    let mut groups = input.erasures.clone();
    groups.sort_by(|a, b| a.target_id.cmp(&b.target_id));
    let mut used_orders = BTreeSet::new();
    for (i, group) in groups.iter().enumerate() {
        if !valid_delta_id(&group.target_id)
            || group.order_ids.is_empty()
            || (i > 0 && groups[i - 1].target_id == group.target_id)
            || additions.contains_key(&group.target_id)
        {
            return Err("durable peer state: invalid erasure group".into());
        }
        for order_id in &group.order_ids {
            if order_id == &group.target_id
                || !additions
                    .get(order_id)
                    .is_some_and(|delta| delta.sig.is_some())
                || !used_orders.insert(order_id)
            {
                return Err(
                    "durable peer state: effective order must be a distinct signed addition".into(),
                );
            }
        }
    }
    if input.quota_charge != (additions.len() - used_orders.len()) as u64 {
        return Err("durable peer state: quota charge must equal new ordinary ids".into());
    }
    let active: BTreeSet<String> = before.base.admitted.iter().map(|d| d.id.clone()).collect();
    let accepted: Vec<String> = additions.keys().cloned().collect();
    let arrival = plan_arrivals(
        before.base.cursor,
        &active,
        &accepted,
        input.at,
        &input.sender,
    )?;
    let targets: BTreeSet<&str> = groups.iter().map(|g| g.target_id.as_str()).collect();
    let admitted = DeltaSet::from_deltas(
        before
            .base
            .admitted
            .iter()
            .filter(|delta| !targets.contains(delta.id.as_str()))
            .cloned()
            .chain(additions.values().cloned()),
    )?;
    let mut after = before.clone();
    after.base.admitted = admitted;
    after.base.cursor = ArrivalCursor {
        last_sequence: arrival.last_sequence,
        last_transfer: arrival.last_transfer,
    };
    after.base.arrivals.extend(arrival.arrivals);
    let arrived: BTreeMap<&str, u64> = before
        .base
        .arrivals
        .iter()
        .map(|row| (row.id.as_str(), row.sequence))
        .collect();
    for group in groups {
        let sequence = u64::try_from(after.events.len())
            .ok()
            .and_then(|n| n.checked_add(1))
            .filter(|n| *n <= MAX_COUNTER)
            .ok_or("durable peer state: refusal counter exhausted")?;
        let prior_epoch = arrived.get(group.target_id.as_str()).copied();
        let mut order_ids = group.order_ids;
        order_ids.sort();
        if order_ids.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err("durable peer state: duplicate order in group".into());
        }
        after.events.push(RefusalEvent {
            sequence,
            target_id: group.target_id.clone(),
            order_ids: order_ids.clone(),
            prior_epoch,
        });
        after.base.refused_ids.insert(group.target_id.clone());
        for order_id in order_ids {
            after.exclusions.push(ErasureExclusion {
                order_id,
                target_id: group.target_id.clone(),
                event_sequence: sequence,
                prior_epoch,
            });
        }
        if let Some(obligation) = after
            .obligations
            .iter_mut()
            .find(|row| row.target_id == group.target_id)
        {
            obligation.event_sequence = sequence;
        } else if prior_epoch.is_some() || group.surface_holds_bytes {
            let obligation_sequence = u64::try_from(after.obligations.len())
                .ok()
                .and_then(|n| n.checked_add(1))
                .filter(|n| *n <= MAX_COUNTER)
                .ok_or("durable peer state: obligation counter exhausted")?;
            after.obligations.push(PurgeObligation {
                sequence: obligation_sequence,
                target_id: group.target_id,
                generation: 1,
                event_sequence: sequence,
                prior_epoch,
                status: "pending".into(),
                fault: None,
            });
        }
    }
    after.refusal_counter = after.events.len() as u64;
    after.obligation_counter = after.obligations.len() as u64;
    after.quota_used += input.quota_charge;
    validate(&after)?;
    validate_transition(before, &after)?;
    Ok(after)
}

/// Single-writer replacement for the complete local permanent-posture image.
#[cfg(not(target_arch = "wasm32"))]
pub fn write_durable_peer_state(
    path: &std::path::Path,
    state: &DurablePeerState,
    expected_prior: Option<&[u8]>,
) -> Result<PeerStateWriteOutcome, String> {
    use std::fs;
    use std::io::Write;

    let bytes = encode_durable_peer_state(state)?;
    let prior_bytes = match fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let before = prior_bytes
        .as_ref()
        .map(|bytes| decode_durable_peer_state(bytes, &state.base.peer_id))
        .transpose()?;
    if prior_bytes.as_deref() != expected_prior {
        return Err("durable peer state: expected prior image changed".into());
    }
    if let Some(before) = &before {
        validate_transition(before, state)?;
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let dir = fs::File::open(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(&bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    let committed = temp.persist(path).map_err(|e| e.error.to_string())?;
    drop(committed);
    Ok(match dir.sync_all() {
        Ok(()) => PeerStateWriteOutcome::Durable,
        Err(e) => PeerStateWriteOutcome::CommittedUnconfirmed {
            fault: e.to_string(),
        },
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub fn read_durable_peer_state(
    path: &std::path::Path,
    expected_peer_id: &str,
) -> Result<Option<DurablePeerState>, String> {
    match std::fs::read(path) {
        Ok(bytes) => decode_durable_peer_state(&bytes, expected_peer_id).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
