//! Internal active-obligation carry. The old peer owns these until a durable handoff commit.

use std::collections::{BTreeMap, BTreeSet};

use crate::cbor::{decode, encode, CborValue};
use crate::hash::content_address;
use crate::refusal_snapshot::{
    encode_refusal_snapshot, refusal_snapshot_digest, QualifiedEventRef, RefusalSnapshot,
};

const VERSION: f64 = 1.0;
const MAX_COUNTER: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedObligation {
    pub source_peer_id: String,
    pub sequence: u64,
    pub target_id: String,
    pub surface_id: String,
    pub generation: u64,
    pub event: QualifiedEventRef,
    pub prior_epoch: Option<QualifiedEventRef>,
    pub status: String,
    pub fault: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedObligationCarry {
    pub obligations: Vec<ImportedObligation>,
}

fn positive(n: u64) -> bool {
    n > 0 && n <= MAX_COUNTER
}

fn valid_id(id: &str) -> bool {
    id.len() == 68
        && id.starts_with("1e20")
        && id.as_bytes()[4..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

fn validate(snapshot: &RefusalSnapshot, carry: &ImportedObligationCarry) -> Result<(), String> {
    encode_refusal_snapshot(snapshot)?;
    let current: BTreeMap<&str, (&str, u64)> = snapshot
        .current
        .iter()
        .map(|row| {
            (
                row.target_id.as_str(),
                (row.source_peer_id.as_str(), row.sequence),
            )
        })
        .collect();
    let mut identities = BTreeSet::new();
    for row in &carry.obligations {
        if row.source_peer_id.is_empty()
            || !positive(row.sequence)
            || !identities.insert((&row.source_peer_id, row.sequence))
            || !valid_id(&row.target_id)
            || row.surface_id.is_empty()
            || !positive(row.generation)
            || row.event.source_peer_id.is_empty()
            || !positive(row.event.sequence)
            || current.get(row.target_id.as_str()).copied()
                != Some((row.event.source_peer_id.as_str(), row.event.sequence))
            || row
                .prior_epoch
                .as_ref()
                .is_some_and(|epoch| epoch.source_peer_id.is_empty() || !positive(epoch.sequence))
            || !matches!(row.status.as_str(), "pending" | "failed")
            || (row.status == "failed"
                && !row.fault.as_ref().is_some_and(|fault| !fault.is_empty()))
            || (row.status == "pending" && row.fault.is_some())
        {
            return Err("imported obligations: invalid active obligation".into());
        }
    }
    Ok(())
}

fn reference(row: &QualifiedEventRef) -> CborValue {
    CborValue::Map(vec![
        ("source".into(), CborValue::Tstr(row.source_peer_id.clone())),
        ("sequence".into(), CborValue::Float(row.sequence as f64)),
    ])
}

/// Canonical active debt image bound to one refusal snapshot digest.
pub fn encode_imported_obligations(
    snapshot: &RefusalSnapshot,
    carry: &ImportedObligationCarry,
) -> Result<Vec<u8>, String> {
    validate(snapshot, carry)?;
    let mut obligations = carry.obligations.clone();
    obligations.sort_by(|a, b| {
        a.source_peer_id
            .cmp(&b.source_peer_id)
            .then(a.sequence.cmp(&b.sequence))
    });
    let obligations = obligations
        .into_iter()
        .map(|row| {
            let mut fields = vec![
                ("source".into(), CborValue::Tstr(row.source_peer_id)),
                ("sequence".into(), CborValue::Float(row.sequence as f64)),
                ("target".into(), CborValue::Tstr(row.target_id)),
                ("surface".into(), CborValue::Tstr(row.surface_id)),
                ("generation".into(), CborValue::Float(row.generation as f64)),
                ("event".into(), reference(&row.event)),
                ("status".into(), CborValue::Tstr(row.status)),
            ];
            if let Some(epoch) = row.prior_epoch {
                fields.push(("priorEpoch".into(), reference(&epoch)));
            }
            if let Some(fault) = row.fault {
                fields.push(("fault".into(), CborValue::Tstr(fault)));
            }
            CborValue::Map(fields)
        })
        .collect();
    Ok(encode(&CborValue::Map(vec![
        ("version".into(), CborValue::Float(VERSION)),
        (
            "snapshotDigest".into(),
            CborValue::Tstr(refusal_snapshot_digest(snapshot)?),
        ),
        ("obligations".into(), CborValue::Array(obligations)),
    ])))
}

fn fields(value: &CborValue, size: usize) -> Result<BTreeMap<String, CborValue>, String> {
    let CborValue::Map(entries) = value else {
        return Err("imported obligations: invalid fields".into());
    };
    if entries.len() != size {
        return Err("imported obligations: invalid fields".into());
    }
    let result: BTreeMap<String, CborValue> = entries.iter().cloned().collect();
    if result.len() != size {
        return Err("imported obligations: duplicate field".into());
    }
    Ok(result)
}

fn string(value: Option<&CborValue>) -> Result<String, String> {
    match value {
        Some(CborValue::Tstr(s)) => Ok(s.clone()),
        _ => Err("imported obligations: expected text".into()),
    }
}

fn number(value: Option<&CborValue>) -> Result<u64, String> {
    match value {
        Some(CborValue::Float(n)) if *n >= 0.0 && *n <= MAX_COUNTER as f64 && n.fract() == 0.0 => {
            Ok(*n as u64)
        }
        _ => Err("imported obligations: expected number".into()),
    }
}

fn items(value: Option<&CborValue>) -> Result<&[CborValue], String> {
    match value {
        Some(CborValue::Array(rows)) => Ok(rows),
        _ => Err("imported obligations: expected array".into()),
    }
}

fn parse_ref(value: Option<&CborValue>) -> Result<QualifiedEventRef, String> {
    let row = fields(value.ok_or("imported obligations: missing reference")?, 2)?;
    Ok(QualifiedEventRef {
        source_peer_id: string(row.get("source"))?,
        sequence: number(row.get("sequence"))?,
    })
}

pub fn decode_imported_obligations(
    image: &[u8],
    snapshot: &RefusalSnapshot,
) -> Result<ImportedObligationCarry, String> {
    let top = fields(&decode(image)?, 3)?;
    if number(top.get("version"))? != VERSION as u64 {
        return Err("imported obligations: unsupported version".into());
    }
    if string(top.get("snapshotDigest"))? != refusal_snapshot_digest(snapshot)? {
        return Err("imported obligations: wrong refusal snapshot".into());
    }
    let obligations = items(top.get("obligations"))?
        .iter()
        .map(|value| {
            let CborValue::Map(entries) = value else {
                return Err("imported obligations: invalid obligation fields".into());
            };
            let row = fields(value, entries.len())?;
            if row.len()
                != 7 + usize::from(row.contains_key("priorEpoch"))
                    + usize::from(row.contains_key("fault"))
            {
                return Err("imported obligations: invalid obligation fields".into());
            }
            Ok(ImportedObligation {
                source_peer_id: string(row.get("source"))?,
                sequence: number(row.get("sequence"))?,
                target_id: string(row.get("target"))?,
                surface_id: string(row.get("surface"))?,
                generation: number(row.get("generation"))?,
                event: parse_ref(row.get("event"))?,
                prior_epoch: row
                    .get("priorEpoch")
                    .map(|value| parse_ref(Some(value)))
                    .transpose()?,
                status: string(row.get("status"))?,
                fault: row
                    .get("fault")
                    .map(|value| string(Some(value)))
                    .transpose()?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let carry = ImportedObligationCarry { obligations };
    if encode_imported_obligations(snapshot, &carry)? != image {
        return Err("imported obligations: noncanonical image".into());
    }
    Ok(carry)
}

pub fn imported_obligations_digest(
    snapshot: &RefusalSnapshot,
    carry: &ImportedObligationCarry,
) -> Result<String, String> {
    Ok(content_address(&encode_imported_obligations(
        snapshot, carry,
    )?))
}
