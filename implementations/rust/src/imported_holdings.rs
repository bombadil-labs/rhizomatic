//! Internal closed holding inventory. It grants no arrival or serving authority.

use std::collections::{BTreeMap, BTreeSet};

use crate::cbor::{decode, encode, CborValue};
use crate::hash::content_address;
use crate::pack::{pack_set, unpack_set};
use crate::reactor::manifest_member_ids;
use crate::refusal_snapshot::{encode_refusal_snapshot, refusal_snapshot_digest, RefusalSnapshot};
use crate::set::DeltaSet;
use crate::sign::{verify_delta, Verification};
use crate::types::Delta;

const VERSION: f64 = 1.0;

#[derive(Debug, Clone, PartialEq)]
pub struct ImportedHoldings {
    pub holdings: Vec<Delta>,
    pub covers: Vec<Delta>,
}

fn checked_set(rows: &[Delta], label: &str) -> Result<DeltaSet, String> {
    let mut set = DeltaSet::new();
    for row in rows {
        if !set.add(row.clone())? {
            return Err(format!("imported holdings: duplicate {label} id"));
        }
    }
    Ok(set)
}

fn validated(
    snapshot: &RefusalSnapshot,
    imported: &ImportedHoldings,
) -> Result<(DeltaSet, DeltaSet), String> {
    encode_refusal_snapshot(snapshot)?;
    let refused: BTreeSet<&str> = snapshot
        .current
        .iter()
        .map(|row| row.target_id.as_str())
        .collect();
    let holdings = checked_set(&imported.holdings, "holding")?;
    let covers = checked_set(&imported.covers, "cover")?;
    let unsigned: Vec<_> = holdings.iter().filter(|row| row.sig.is_none()).collect();
    for row in covers.iter() {
        if refused.contains(row.id.as_str()) {
            return Err("imported holdings: current refusal is cover evidence".into());
        }
        if holdings.contains(&row.id) {
            return Err("imported holdings: cover duplicates admitted holding".into());
        }
        if verify_delta(row) != Verification::Verified || manifest_member_ids(row).is_empty() {
            return Err("imported holdings: invalid signed cover".into());
        }
        if !unsigned.iter().any(|member| {
            member.claims.author == row.claims.author
                && manifest_member_ids(row).contains(&member.id)
        }) {
            return Err("imported holdings: cover has no unsigned member".into());
        }
    }
    for row in holdings.iter() {
        if refused.contains(row.id.as_str()) {
            return Err("imported holdings: current refusal is admitted".into());
        }
        if row.sig.is_some() && verify_delta(row) != Verification::Verified {
            return Err("imported holdings: invalid holding signature".into());
        }
    }
    for row in unsigned {
        if !covers.iter().chain(holdings.iter()).any(|cover| {
            cover.sig.is_some()
                && cover.claims.author == row.claims.author
                && manifest_member_ids(cover).contains(&row.id)
        }) {
            return Err("imported holdings: unsigned holding has no verified cover".into());
        }
    }
    Ok((holdings, covers))
}

/// Canonical, closed inventory; the old peer's handoff record must bind its digest.
pub fn encode_imported_holdings(
    snapshot: &RefusalSnapshot,
    imported: &ImportedHoldings,
) -> Result<Vec<u8>, String> {
    let (holdings, covers) = validated(snapshot, imported)?;
    Ok(encode(&CborValue::Map(vec![
        ("version".into(), CborValue::Float(VERSION)),
        (
            "snapshotDigest".into(),
            CborValue::Tstr(refusal_snapshot_digest(snapshot)?),
        ),
        ("holdings".into(), CborValue::Bstr(pack_set(&holdings))),
        ("covers".into(), CborValue::Bstr(pack_set(&covers))),
    ])))
}

fn fields(value: &CborValue) -> Result<BTreeMap<String, CborValue>, String> {
    let CborValue::Map(entries) = value else {
        return Err("imported holdings: invalid fields".into());
    };
    if entries.len() != 4 {
        return Err("imported holdings: invalid fields".into());
    }
    let result: BTreeMap<String, CborValue> = entries.iter().cloned().collect();
    if result.len() != 4 {
        return Err("imported holdings: duplicate field".into());
    }
    Ok(result)
}

fn bytes(value: Option<&CborValue>) -> Result<&[u8], String> {
    match value {
        Some(CborValue::Bstr(data)) => Ok(data),
        _ => Err("imported holdings: expected bytes".into()),
    }
}

pub fn decode_imported_holdings(
    image: &[u8],
    snapshot: &RefusalSnapshot,
) -> Result<ImportedHoldings, String> {
    let top = fields(&decode(image)?)?;
    if top.get("version") != Some(&CborValue::Float(VERSION)) {
        return Err("imported holdings: unsupported version".into());
    }
    if top.get("snapshotDigest") != Some(&CborValue::Tstr(refusal_snapshot_digest(snapshot)?)) {
        return Err("imported holdings: wrong refusal snapshot".into());
    }
    let imported = ImportedHoldings {
        holdings: unpack_set(bytes(top.get("holdings"))?)?
            .iter()
            .cloned()
            .collect(),
        covers: unpack_set(bytes(top.get("covers"))?)?
            .iter()
            .cloned()
            .collect(),
    };
    if encode_imported_holdings(snapshot, &imported)? != image {
        return Err("imported holdings: noncanonical image".into());
    }
    Ok(imported)
}

pub fn imported_holdings_digest(
    snapshot: &RefusalSnapshot,
    imported: &ImportedHoldings,
) -> Result<String, String> {
    Ok(content_address(&encode_imported_holdings(
        snapshot, imported,
    )?))
}
