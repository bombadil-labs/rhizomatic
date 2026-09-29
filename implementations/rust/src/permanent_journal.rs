//! Canonical journal frames for effective erasure and purge reports.

use std::collections::{BTreeMap, BTreeSet};

use crate::cbor::{decode, encode, CborValue};
use crate::durable_state::{
    empty_durable_peer_state, encode_durable_peer_state, plan_permanent_commit_from_verified,
    DurablePeerState, PermanentCommitInput, PermanentErasure,
};
use crate::hash::content_address;
use crate::ordinary_journal::{decode_ordinary_journal_checkpoint, decode_ordinary_peer_frame};
use crate::pack::{pack_set, unpack_set};
use crate::peer_identity::is_canonical_peer_id;
use crate::set::DeltaSet;
use crate::sign::{verify_delta, Verification};
use crate::types::Target;

const VERSION: f64 = 2.0;
const MAX_COUNTER: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Clone)]
pub enum PermanentPeerFrame {
    Admission {
        peer_id: String,
        prior: String,
        input: PermanentCommitInput,
    },
    Purge {
        peer_id: String,
        prior: String,
        target_id: String,
        generation: u64,
        status: String,
        fault: Option<String>,
    },
}

impl PermanentPeerFrame {
    fn peer_id(&self) -> &str {
        match self {
            Self::Admission { peer_id, .. } | Self::Purge { peer_id, .. } => peer_id,
        }
    }
    fn prior(&self) -> &str {
        match self {
            Self::Admission { prior, .. } | Self::Purge { prior, .. } => prior,
        }
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 68
        && id.starts_with("1e20")
        && id.as_bytes()[4..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

fn valid_sender(sender: &str, peer_id: &str) -> bool {
    sender == "local"
        || sender == "unattributed"
        || (is_canonical_peer_id(sender) && sender != peer_id)
}

fn validate(frame: &PermanentPeerFrame) -> Result<(), String> {
    if !is_canonical_peer_id(frame.peer_id())
        || (!frame.prior().is_empty() && !valid_id(frame.prior()))
    {
        return Err("permanent journal: invalid peer or prior".into());
    }
    match frame {
        PermanentPeerFrame::Purge {
            target_id,
            generation,
            status,
            fault,
            ..
        } => {
            if !valid_id(target_id)
                || *generation == 0
                || *generation > MAX_COUNTER
                || (status != "failed" && status != "removed")
                || (status == "failed" && fault.as_ref().is_none_or(String::is_empty))
                || (status == "removed" && fault.is_some())
            {
                return Err("permanent journal: invalid purge report".into());
            }
        }
        PermanentPeerFrame::Admission { peer_id, input, .. } => {
            if !input.at.is_finite()
                || !valid_sender(&input.sender, peer_id)
                || input.quota_charge > MAX_COUNTER
                || input.additions.is_empty()
                || input.erasures.is_empty()
            {
                return Err("permanent journal: invalid admission".into());
            }
            let mut ids = BTreeSet::new();
            for delta in &input.additions {
                if !ids.insert(delta.id.as_str())
                    || delta.sig.is_none()
                    || verify_delta(delta) != Verification::Verified
                {
                    return Err("permanent journal: invalid signed addition".into());
                }
            }
            let mut targets = BTreeSet::new();
            for group in &input.erasures {
                if !valid_id(&group.target_id)
                    || !targets.insert(group.target_id.as_str())
                    || group.order_ids.is_empty()
                    || group.order_ids.iter().any(|id| !ids.contains(id.as_str()))
                {
                    return Err("permanent journal: invalid erasure group".into());
                }
                for order_id in &group.order_ids {
                    let order = input
                        .additions
                        .iter()
                        .find(|delta| &delta.id == order_id)
                        .expect("group order id belongs to additions");
                    let signed_targets: Vec<&str> = order
                        .claims
                        .pointers
                        .iter()
                        .filter_map(|pointer| match &pointer.target {
                            Target::Delta(reference) if pointer.role == "erases" => {
                                Some(reference.delta.as_str())
                            }
                            _ => None,
                        })
                        .collect();
                    if signed_targets.as_slice() != [group.target_id.as_str()] {
                        return Err(
                            "permanent journal: effective order target is not signed".into()
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

fn text(value: Option<&CborValue>) -> Result<String, String> {
    match value {
        Some(CborValue::Tstr(value)) => Ok(value.clone()),
        _ => Err("permanent journal: expected text".into()),
    }
}
fn number(value: Option<&CborValue>) -> Result<f64, String> {
    match value {
        Some(CborValue::Float(value)) => Ok(*value),
        _ => Err("permanent journal: expected number".into()),
    }
}
fn bytes(value: Option<&CborValue>) -> Result<&[u8], String> {
    match value {
        Some(CborValue::Bstr(value)) => Ok(value),
        _ => Err("permanent journal: expected bytes".into()),
    }
}
fn fields(value: &CborValue, count: usize) -> Result<BTreeMap<String, CborValue>, String> {
    let CborValue::Map(entries) = value else {
        return Err("permanent journal: invalid fields".into());
    };
    if entries.len() != count {
        return Err("permanent journal: invalid fields".into());
    }
    let row: BTreeMap<String, CborValue> = entries.iter().cloned().collect();
    if row.len() != count {
        return Err("permanent journal: duplicate field".into());
    }
    Ok(row)
}

pub fn encode_permanent_peer_frame(frame: &PermanentPeerFrame) -> Result<Vec<u8>, String> {
    validate(frame)?;
    let mut row = vec![
        ("version".into(), CborValue::Float(VERSION)),
        (
            "kind".into(),
            CborValue::Tstr(match frame {
                PermanentPeerFrame::Admission { .. } => "admission".into(),
                PermanentPeerFrame::Purge { .. } => "purge".into(),
            }),
        ),
        ("peer".into(), CborValue::Tstr(frame.peer_id().into())),
        ("prior".into(), CborValue::Tstr(frame.prior().into())),
    ];
    match frame {
        PermanentPeerFrame::Purge {
            target_id,
            generation,
            status,
            fault,
            ..
        } => {
            row.extend([
                ("target".into(), CborValue::Tstr(target_id.clone())),
                ("generation".into(), CborValue::Float(*generation as f64)),
                ("status".into(), CborValue::Tstr(status.clone())),
            ]);
            if let Some(fault) = fault {
                row.push(("fault".into(), CborValue::Tstr(fault.clone())));
            }
        }
        PermanentPeerFrame::Admission { input, .. } => {
            let set = DeltaSet::from_deltas(input.additions.iter().cloned())?;
            let mut erasures = input.erasures.clone();
            erasures.sort_by(|a, b| a.target_id.cmp(&b.target_id));
            row.extend([
                ("at".into(), CborValue::Float(input.at)),
                ("sender".into(), CborValue::Tstr(input.sender.clone())),
                ("pack".into(), CborValue::Bstr(pack_set(&set))),
                ("quota".into(), CborValue::Float(input.quota_charge as f64)),
                (
                    "erasures".into(),
                    CborValue::Array(
                        erasures
                            .iter()
                            .map(|group| {
                                let mut orders = group.order_ids.clone();
                                orders.sort();
                                CborValue::Map(vec![
                                    ("target".into(), CborValue::Tstr(group.target_id.clone())),
                                    (
                                        "orders".into(),
                                        CborValue::Array(
                                            orders.into_iter().map(CborValue::Tstr).collect(),
                                        ),
                                    ),
                                    (
                                        "bytes".into(),
                                        CborValue::Float(if group.surface_holds_bytes {
                                            1.0
                                        } else {
                                            0.0
                                        }),
                                    ),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]);
        }
    }
    Ok(encode(&CborValue::Map(row)))
}

pub fn decode_permanent_peer_frame(image: &[u8]) -> Result<PermanentPeerFrame, String> {
    let raw = decode(image)?;
    let CborValue::Map(entries) = &raw else {
        return Err("permanent journal: invalid fields".into());
    };
    let initial: BTreeMap<String, CborValue> = entries.iter().cloned().collect();
    if initial.len() != entries.len() || number(initial.get("version"))? != VERSION {
        return Err("permanent journal: unsupported version".into());
    }
    let kind = text(initial.get("kind"))?;
    let frame = if kind == "purge" {
        let row = fields(&raw, if initial.contains_key("fault") { 8 } else { 7 })?;
        let generation = number(row.get("generation"))?;
        if !generation.is_finite()
            || generation < 1.0
            || generation > MAX_COUNTER as f64
            || generation.fract() != 0.0
        {
            return Err("permanent journal: invalid purge report".into());
        }
        PermanentPeerFrame::Purge {
            peer_id: text(row.get("peer"))?,
            prior: text(row.get("prior"))?,
            target_id: text(row.get("target"))?,
            generation: generation as u64,
            status: text(row.get("status"))?,
            fault: row
                .get("fault")
                .map(|value| text(Some(value)))
                .transpose()?,
        }
    } else if kind == "admission" {
        let row = fields(&raw, 9)?;
        let quota = number(row.get("quota"))?;
        if !quota.is_finite() || quota < 0.0 || quota > MAX_COUNTER as f64 || quota.fract() != 0.0 {
            return Err("permanent journal: invalid quota".into());
        }
        let Some(CborValue::Array(groups)) = row.get("erasures") else {
            return Err("permanent journal: expected erasures".into());
        };
        let erasures = groups
            .iter()
            .map(|value| {
                let group = fields(value, 3)?;
                let Some(CborValue::Array(orders)) = group.get("orders") else {
                    return Err("permanent journal: expected orders".into());
                };
                let byte_flag = number(group.get("bytes"))?;
                if byte_flag != 0.0 && byte_flag != 1.0 {
                    return Err("permanent journal: invalid byte flag".into());
                }
                Ok(PermanentErasure {
                    target_id: text(group.get("target"))?,
                    order_ids: orders
                        .iter()
                        .map(|value| text(Some(value)))
                        .collect::<Result<_, _>>()?,
                    surface_holds_bytes: byte_flag == 1.0,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        PermanentPeerFrame::Admission {
            peer_id: text(row.get("peer"))?,
            prior: text(row.get("prior"))?,
            input: PermanentCommitInput {
                additions: unpack_set(bytes(row.get("pack"))?)?
                    .iter()
                    .cloned()
                    .collect(),
                erasures,
                quota_charge: quota as u64,
                at: number(row.get("at"))?,
                sender: text(row.get("sender"))?,
            },
        }
    } else {
        return Err("permanent journal: invalid kind".into());
    };
    if encode_permanent_peer_frame(&frame)? != image {
        return Err("permanent journal: noncanonical frame".into());
    }
    Ok(frame)
}

/// The host proves physical absence before appending `removed` through its storage seam.
pub fn apply_permanent_peer_frame(
    before: &DurablePeerState,
    frame: &PermanentPeerFrame,
) -> Result<DurablePeerState, String> {
    validate(frame)?;
    if frame.peer_id() != before.base.peer_id {
        return Err("permanent journal: wrong peer".into());
    }
    match frame {
        PermanentPeerFrame::Admission { input, .. } => {
            plan_permanent_commit_from_verified(before, input)
        }
        PermanentPeerFrame::Purge {
            target_id,
            generation,
            status,
            fault,
            ..
        } => {
            let mut after = before.clone();
            let obligation = after
                .obligations
                .iter_mut()
                .find(|row| row.target_id == *target_id && row.generation == *generation)
                .ok_or("permanent journal: no live purge obligation")?;
            if obligation.status == "removed" {
                return Err("permanent journal: no live purge obligation".into());
            }
            obligation.status = status.clone();
            obligation.fault = fault.clone();
            encode_durable_peer_state(&after)?;
            Ok(after)
        }
    }
}

/// Verify a mixed ordinary/permanent chain, optionally after an ordinary-only checkpoint.
pub fn replay_permanent_peer_frames(
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
        .is_some_and(|row| row.peer_id != peer_id)
    {
        return Err("permanent journal: checkpoint peer mismatch".into());
    }
    let (mut state, mut head) = match checkpoint {
        Some(row) => (row.state, row.head),
        None => (empty_durable_peer_state(peer_id)?, String::new()),
    };
    for image in frames {
        let raw = decode(image)?;
        let CborValue::Map(entries) = raw else {
            return Err("permanent journal: invalid frame".into());
        };
        let version = number(
            entries
                .iter()
                .find(|(key, _)| key == "version")
                .map(|(_, value)| value),
        )?;
        if version == 1.0 {
            let ordinary = decode_ordinary_peer_frame(image)?;
            if ordinary.peer_id != peer_id || ordinary.prior != head {
                return Err("permanent journal: broken frame chain".into());
            }
            state = plan_permanent_commit_from_verified(
                &state,
                &PermanentCommitInput {
                    quota_charge: ordinary.additions.len() as u64,
                    additions: ordinary.additions,
                    erasures: Vec::new(),
                    at: ordinary.at,
                    sender: ordinary.sender,
                },
            )?;
        } else if version == VERSION {
            let permanent = decode_permanent_peer_frame(image)?;
            if permanent.peer_id() != peer_id || permanent.prior() != head {
                return Err("permanent journal: broken frame chain".into());
            }
            state = apply_permanent_peer_frame(&state, &permanent)?;
        } else {
            return Err("permanent journal: unsupported frame version".into());
        }
        head = content_address(image);
    }
    if head != expected_head {
        return Err("permanent journal: head mismatch".into());
    }
    encode_durable_peer_state(&state)?;
    Ok(state)
}
