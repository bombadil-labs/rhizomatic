//! Canonical append records for signed-loose ordinary admissions. Storage CAS is a separate seam.

use std::collections::{BTreeMap, BTreeSet};

use crate::arrival::{plan_arrivals, ArrivalCursor};
use crate::cbor::{decode, encode, CborValue};
use crate::durable_state::{
    decode_durable_peer_state, empty_durable_peer_state, encode_durable_peer_state,
    DurablePeerState,
};
use crate::hash::content_address;
use crate::pack::{pack_set, unpack_set};
use crate::peer_identity::is_canonical_peer_id;
use crate::set::DeltaSet;
use crate::sign::{verify_delta, Verification};
use crate::types::Delta;

const VERSION: f64 = 1.0;
const MAX_COUNTER: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Clone, PartialEq)]
pub struct OrdinaryJournalCheckpoint {
    pub peer_id: String,
    pub head: String,
    pub state: DurablePeerState,
}

fn ordinary_checkpoint_state(state: &DurablePeerState) -> Result<(), String> {
    if !state.events.is_empty()
        || !state.exclusions.is_empty()
        || !state.obligations.is_empty()
        || !state.base.refused_ids.is_empty()
        || state.quota_used as usize != state.base.admitted.len()
        || state.base.cursor.last_sequence as usize != state.base.admitted.len()
    {
        return Err("ordinary journal: checkpoint is not ordinary-only".into());
    }
    Ok(())
}

/// Canonical verified prefix and its exact frame-chain boundary.
pub fn encode_ordinary_journal_checkpoint(
    checkpoint: &OrdinaryJournalCheckpoint,
) -> Result<Vec<u8>, String> {
    if !is_canonical_peer_id(&checkpoint.peer_id)
        || checkpoint.state.base.peer_id != checkpoint.peer_id
    {
        return Err("ordinary journal: checkpoint peer mismatch".into());
    }
    if !checkpoint.head.is_empty() && !valid_frame_id(&checkpoint.head) {
        return Err("ordinary journal: invalid checkpoint head".into());
    }
    ordinary_checkpoint_state(&checkpoint.state)?;
    if checkpoint.head.is_empty() != checkpoint.state.base.admitted.is_empty() {
        return Err("ordinary journal: checkpoint head/state mismatch".into());
    }
    let image = encode_durable_peer_state(&checkpoint.state)?;
    if reconstructed_checkpoint_head(&checkpoint.state)? != checkpoint.head {
        return Err("ordinary journal: checkpoint head mismatch".into());
    }
    Ok(encode(&CborValue::Map(vec![
        ("version".into(), CborValue::Float(VERSION)),
        ("peer".into(), CborValue::Tstr(checkpoint.peer_id.clone())),
        ("head".into(), CborValue::Tstr(checkpoint.head.clone())),
        ("image".into(), CborValue::Bstr(image)),
    ])))
}

pub fn decode_ordinary_journal_checkpoint(
    bytes: &[u8],
) -> Result<OrdinaryJournalCheckpoint, String> {
    let CborValue::Map(entries) = decode(bytes)? else {
        return Err("ordinary journal: invalid checkpoint fields".into());
    };
    if entries.len() != 4 {
        return Err("ordinary journal: invalid checkpoint fields".into());
    }
    let row: BTreeMap<String, CborValue> = entries.into_iter().collect();
    if row.len() != 4 || row.get("version") != Some(&CborValue::Float(VERSION)) {
        return Err("ordinary journal: invalid checkpoint fields".into());
    }
    let (Some(CborValue::Tstr(peer_id)), Some(CborValue::Tstr(head)), Some(CborValue::Bstr(image))) =
        (row.get("peer"), row.get("head"), row.get("image"))
    else {
        return Err("ordinary journal: invalid checkpoint fields".into());
    };
    let checkpoint = OrdinaryJournalCheckpoint {
        peer_id: peer_id.clone(),
        head: head.clone(),
        state: decode_durable_peer_state(image, peer_id)?,
    };
    if encode_ordinary_journal_checkpoint(&checkpoint)? != bytes {
        return Err("ordinary journal: noncanonical checkpoint".into());
    }
    Ok(checkpoint)
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrdinaryPeerFrame {
    pub peer_id: String,
    /// Empty for the first frame; otherwise the content id of the preceding frame.
    pub prior: String,
    pub at: f64,
    pub sender: String,
    /// Nonempty, distinct, verified signed loose deltas.
    pub additions: Vec<Delta>,
}

fn valid_frame_id(id: &str) -> bool {
    id.len() == 68
        && id.starts_with("1e20")
        && id.as_bytes()[4..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

fn validate(frame: &OrdinaryPeerFrame, signatures_verified: bool) -> Result<(), String> {
    if !is_canonical_peer_id(&frame.peer_id) {
        return Err("ordinary journal: invalid peer id".into());
    }
    if !frame.prior.is_empty() && !valid_frame_id(&frame.prior) {
        return Err("ordinary journal: invalid prior head".into());
    }
    if frame.sender != "local"
        && frame.sender != "unattributed"
        && (!is_canonical_peer_id(&frame.sender) || frame.sender == frame.peer_id)
    {
        return Err("ordinary journal: invalid sender".into());
    }
    if !frame.at.is_finite() {
        return Err("ordinary journal: invalid arrival time".into());
    }
    if frame.additions.is_empty() {
        return Err("ordinary journal: empty transfer".into());
    }
    let mut ids = BTreeSet::new();
    for delta in &frame.additions {
        if !ids.insert(&delta.id)
            || (!signatures_verified && verify_delta(delta) != Verification::Verified)
            || delta.sig.is_none()
        {
            return Err("ordinary journal: invalid signed addition".into());
        }
    }
    Ok(())
}

/// Canonical one-transfer append bytes; a frame never records a no-op.
pub fn encode_ordinary_peer_frame(frame: &OrdinaryPeerFrame) -> Result<Vec<u8>, String> {
    encode_ordinary_peer_frame_known_verified(frame, false)
}

fn encode_ordinary_peer_frame_known_verified(
    frame: &OrdinaryPeerFrame,
    signatures_verified: bool,
) -> Result<Vec<u8>, String> {
    validate(frame, signatures_verified)?;
    let set = DeltaSet::from_deltas(frame.additions.iter().cloned())?;
    Ok(encode(&CborValue::Map(vec![
        ("version".into(), CborValue::Float(VERSION)),
        ("peer".into(), CborValue::Tstr(frame.peer_id.clone())),
        ("prior".into(), CborValue::Tstr(frame.prior.clone())),
        ("at".into(), CborValue::Float(frame.at)),
        ("sender".into(), CborValue::Tstr(frame.sender.clone())),
        ("pack".into(), CborValue::Bstr(pack_set(&set))),
    ])))
}

fn text(value: Option<&CborValue>) -> Result<String, String> {
    match value {
        Some(CborValue::Tstr(value)) => Ok(value.clone()),
        _ => Err("ordinary journal: expected text".into()),
    }
}

pub fn decode_ordinary_peer_frame(bytes: &[u8]) -> Result<OrdinaryPeerFrame, String> {
    let CborValue::Map(entries) = decode(bytes)? else {
        return Err("ordinary journal: invalid frame fields".into());
    };
    if entries.len() != 6 {
        return Err("ordinary journal: invalid frame fields".into());
    }
    let row: BTreeMap<String, CborValue> = entries.into_iter().collect();
    if row.len() != 6 {
        return Err("ordinary journal: duplicate frame field".into());
    }
    if row.get("version") != Some(&CborValue::Float(VERSION)) {
        return Err("ordinary journal: unsupported frame version".into());
    }
    let Some(CborValue::Float(at)) = row.get("at") else {
        return Err("ordinary journal: expected arrival time".into());
    };
    let Some(CborValue::Bstr(pack)) = row.get("pack") else {
        return Err("ordinary journal: expected pack bytes".into());
    };
    let frame = OrdinaryPeerFrame {
        peer_id: text(row.get("peer"))?,
        prior: text(row.get("prior"))?,
        at: *at,
        sender: text(row.get("sender"))?,
        additions: unpack_set(pack)?.iter().cloned().collect(),
    };
    if encode_ordinary_peer_frame(&frame)? != bytes {
        return Err("ordinary journal: noncanonical frame".into());
    }
    Ok(frame)
}

pub fn ordinary_peer_frame_id(bytes: &[u8]) -> Result<String, String> {
    decode_ordinary_peer_frame(bytes)?;
    Ok(content_address(bytes))
}

fn reconstructed_checkpoint_head(state: &DurablePeerState) -> Result<String, String> {
    let mut head = String::new();
    let mut cursor = ArrivalCursor {
        last_sequence: 0,
        last_transfer: 0,
    };
    let rows = &state.base.arrivals;
    let mut i = 0;
    while i < rows.len() {
        let first = &rows[i];
        if first.transfer != cursor.last_transfer + 1 {
            return Err("ordinary journal: invalid checkpoint arrivals".into());
        }
        let start = i;
        while i < rows.len() && rows[i].transfer == first.transfer {
            i += 1;
        }
        let group = &rows[start..i];
        let ids: Vec<String> = group.iter().map(|row| row.id.clone()).collect();
        let expected = plan_arrivals(cursor, &BTreeSet::new(), &ids, first.at, &first.sender)?;
        if expected.arrivals.as_slice() != group {
            return Err("ordinary journal: invalid checkpoint arrivals".into());
        }
        let additions = ids
            .iter()
            .map(|id| {
                state
                    .base
                    .admitted
                    .get(id)
                    .cloned()
                    .ok_or_else(|| "ordinary journal: invalid checkpoint arrivals".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        head = content_address(&encode_ordinary_peer_frame_known_verified(
            &OrdinaryPeerFrame {
                peer_id: state.base.peer_id.clone(),
                prior: head,
                at: first.at,
                sender: first.sender.clone(),
                additions,
            },
            true,
        )?);
        cursor = ArrivalCursor {
            last_sequence: expected.last_sequence,
            last_transfer: expected.last_transfer,
        };
    }
    if cursor != state.base.cursor {
        return Err("ordinary journal: invalid checkpoint arrivals".into());
    }
    Ok(head)
}

/// Reconstruct and validate one ordinary-only peer from its complete committed frame chain.
pub fn replay_ordinary_peer_frames(
    peer_id: &str,
    frames: &[Vec<u8>],
    expected_head: &str,
) -> Result<DurablePeerState, String> {
    replay_ordinary_peer_frames_from_checkpoint(peer_id, frames, expected_head, None)
}

pub fn replay_ordinary_peer_frames_from_checkpoint(
    peer_id: &str,
    frames: &[Vec<u8>],
    expected_head: &str,
    checkpoint_bytes: Option<&[u8]>,
) -> Result<DurablePeerState, String> {
    let checkpoint = checkpoint_bytes
        .map(decode_ordinary_journal_checkpoint)
        .transpose()?;
    if checkpoint
        .as_ref()
        .is_some_and(|checkpoint| checkpoint.peer_id != peer_id)
    {
        return Err("ordinary journal: checkpoint peer mismatch".into());
    }
    let (mut state, mut head) = match checkpoint {
        Some(checkpoint) => (checkpoint.state, checkpoint.head),
        None => (empty_durable_peer_state(peer_id)?, String::new()),
    };
    for bytes in frames {
        let frame = decode_ordinary_peer_frame(bytes)?;
        if frame.peer_id != peer_id || frame.prior != head {
            return Err("ordinary journal: broken frame chain".into());
        }
        let ids: Vec<String> = frame
            .additions
            .iter()
            .map(|delta| delta.id.clone())
            .collect();
        for delta in frame.additions {
            if state.base.admitted.contains(&delta.id) {
                return Err("ordinary journal: repeated admitted id".into());
            }
            state.base.admitted.add(delta)?;
        }
        let arrival = plan_arrivals(
            ArrivalCursor {
                last_sequence: state.base.cursor.last_sequence,
                last_transfer: state.base.cursor.last_transfer,
            },
            &BTreeSet::new(),
            &ids,
            frame.at,
            &frame.sender,
        )?;
        state.base.cursor = ArrivalCursor {
            last_sequence: arrival.last_sequence,
            last_transfer: arrival.last_transfer,
        };
        state.base.arrivals.extend(arrival.arrivals);
        state.quota_used = state
            .quota_used
            .checked_add(ids.len() as u64)
            .filter(|value| *value <= MAX_COUNTER)
            .ok_or("ordinary journal: quota counter exhausted")?;
        head = content_address(bytes);
    }
    if head != expected_head {
        return Err("ordinary journal: head mismatch".into());
    }
    encode_durable_peer_state(&state)?;
    Ok(state)
}
