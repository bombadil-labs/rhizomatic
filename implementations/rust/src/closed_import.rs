//! Internal v4 closed handoff stage. Durable bytes alone never prove import or grant serving.

use std::collections::BTreeMap;

use crate::cbor::{decode, encode, CborValue};
use crate::hash::content_address;
use crate::imported_holdings::{
    decode_imported_holdings, encode_imported_holdings, ImportedHoldings,
};
use crate::imported_obligations::{
    decode_imported_obligations, encode_imported_obligations, ImportedObligationCarry,
};
use crate::inherited_state::{decode_closed_peer_state, encode_closed_peer_state, ClosedPeerState};
#[cfg(not(target_arch = "wasm32"))]
use crate::peer_state::PeerStateWriteOutcome;
#[cfg(not(target_arch = "wasm32"))]
use crate::refusal_snapshot::{encode_refusal_snapshot, verify_refusal_snapshot_copy};

const VERSION: f64 = 4.0;
const MAX_COUNTER: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Clone, PartialEq)]
pub struct ClosedImportState {
    pub attempt_id: String,
    pub old_peer_id: String,
    pub old_state_version: u64,
    pub deadline: f64,
    pub closed: ClosedPeerState,
    pub obligations: ImportedObligationCarry,
    pub holdings: ImportedHoldings,
    pub policy_format: String,
    pub policy_bytes: Vec<u8>,
}

fn empty_local(closed: &ClosedPeerState) -> bool {
    let local = &closed.local;
    local.base.admitted.is_empty()
        && local.base.arrivals.is_empty()
        && local.base.cursor.last_sequence == 0
        && local.base.cursor.last_transfer == 0
        && local.base.refused_ids.is_empty()
        && local.refusal_counter == 0
        && local.obligation_counter == 0
        && local.quota_used == 0
        && local.events.is_empty()
        && local.exclusions.is_empty()
        && local.obligations.is_empty()
}

struct Components {
    closed: Vec<u8>,
    obligations: Vec<u8>,
    holdings: Vec<u8>,
}

fn components(state: &ClosedImportState) -> Result<Components, String> {
    if state.attempt_id.is_empty()
        || state.old_peer_id.is_empty()
        || state.old_peer_id == state.closed.local.base.peer_id
        || state.old_state_version > MAX_COUNTER
        || !state.deadline.is_finite()
        || state.policy_format.is_empty()
        || state.policy_bytes.is_empty()
    {
        return Err("closed import: invalid attempt or policy descriptor".into());
    }
    if !empty_local(&state.closed) {
        return Err("closed import: local candidate is not empty".into());
    }
    if state
        .obligations
        .obligations
        .iter()
        .any(|row| row.source_peer_id == state.closed.local.base.peer_id)
    {
        return Err("closed import: carried obligation uses new peer id".into());
    }
    Ok(Components {
        closed: encode_closed_peer_state(&state.closed)?,
        obligations: encode_imported_obligations(&state.closed.inherited, &state.obligations)?,
        holdings: encode_imported_holdings(&state.closed.inherited, &state.holdings)?,
    })
}

fn carried_bytes(parts: &Components) -> Vec<u8> {
    encode(&CborValue::Map(vec![
        ("closed".into(), CborValue::Bstr(parts.closed.clone())),
        (
            "obligations".into(),
            CborValue::Bstr(parts.obligations.clone()),
        ),
        ("holdings".into(), CborValue::Bstr(parts.holdings.clone())),
    ]))
}

fn policy_bytes(state: &ClosedImportState) -> Vec<u8> {
    encode(&CborValue::Map(vec![
        (
            "format".into(),
            CborValue::Tstr(state.policy_format.clone()),
        ),
        ("bytes".into(), CborValue::Bstr(state.policy_bytes.clone())),
    ]))
}

/// Digest validated canonical carried components, excluding attempt and destination policy.
pub fn closed_import_carried_digest(state: &ClosedImportState) -> Result<String, String> {
    Ok(content_address(&carried_bytes(&components(state)?)))
}

/// Digest the destination policy format and opaque bytes as one object.
pub fn closed_import_policy_digest(state: &ClosedImportState) -> Result<String, String> {
    components(state)?;
    Ok(content_address(&policy_bytes(state)))
}

pub fn encode_closed_import_state(state: &ClosedImportState) -> Result<Vec<u8>, String> {
    let parts = components(state)?;
    Ok(encode(&CborValue::Map(vec![
        ("version".into(), CborValue::Float(VERSION)),
        (
            "peer".into(),
            CborValue::Tstr(state.closed.local.base.peer_id.clone()),
        ),
        ("oldPeer".into(), CborValue::Tstr(state.old_peer_id.clone())),
        ("attempt".into(), CborValue::Tstr(state.attempt_id.clone())),
        (
            "oldVersion".into(),
            CborValue::Float(state.old_state_version as f64),
        ),
        ("deadline".into(), CborValue::Float(state.deadline)),
        ("closed".into(), CborValue::Bstr(parts.closed.clone())),
        (
            "obligations".into(),
            CborValue::Bstr(parts.obligations.clone()),
        ),
        ("holdings".into(), CborValue::Bstr(parts.holdings.clone())),
        (
            "carriedDigest".into(),
            CborValue::Tstr(content_address(&carried_bytes(&parts))),
        ),
        (
            "policyFormat".into(),
            CborValue::Tstr(state.policy_format.clone()),
        ),
        ("policy".into(), CborValue::Bstr(state.policy_bytes.clone())),
        (
            "policyDigest".into(),
            CborValue::Tstr(content_address(&policy_bytes(state))),
        ),
    ])))
}

fn fields(value: &CborValue) -> Result<BTreeMap<String, CborValue>, String> {
    let CborValue::Map(entries) = value else {
        return Err("closed import: invalid fields".into());
    };
    if entries.len() != 13 {
        return Err("closed import: invalid fields".into());
    }
    let result: BTreeMap<String, CborValue> = entries.iter().cloned().collect();
    if result.len() != 13 {
        return Err("closed import: duplicate fields".into());
    }
    Ok(result)
}

fn string(value: Option<&CborValue>) -> Result<String, String> {
    match value {
        Some(CborValue::Tstr(data)) => Ok(data.clone()),
        _ => Err("closed import: expected text".into()),
    }
}

fn number(value: Option<&CborValue>) -> Result<f64, String> {
    match value {
        Some(CborValue::Float(n)) => Ok(*n),
        _ => Err("closed import: expected number".into()),
    }
}

fn bytes(value: Option<&CborValue>) -> Result<&[u8], String> {
    match value {
        Some(CborValue::Bstr(data)) => Ok(data),
        _ => Err("closed import: expected bytes".into()),
    }
}

pub fn decode_closed_import_state(
    image: &[u8],
    expected_peer_id: &str,
) -> Result<ClosedImportState, String> {
    let top = fields(&decode(image)?)?;
    if number(top.get("version"))? != VERSION {
        return Err("closed import: unsupported version".into());
    }
    let peer_id = string(top.get("peer"))?;
    if peer_id != expected_peer_id {
        return Err("closed import: wrong peer id".into());
    }
    let closed = decode_closed_peer_state(bytes(top.get("closed"))?, &peer_id)?;
    let old_version = number(top.get("oldVersion"))?;
    if !old_version.is_finite()
        || old_version < 0.0
        || old_version > MAX_COUNTER as f64
        || old_version.fract() != 0.0
    {
        return Err("closed import: invalid old state version".into());
    }
    let state = ClosedImportState {
        attempt_id: string(top.get("attempt"))?,
        old_peer_id: string(top.get("oldPeer"))?,
        old_state_version: old_version as u64,
        deadline: number(top.get("deadline"))?,
        obligations: decode_imported_obligations(
            bytes(top.get("obligations"))?,
            &closed.inherited,
        )?,
        holdings: decode_imported_holdings(bytes(top.get("holdings"))?, &closed.inherited)?,
        closed,
        policy_format: string(top.get("policyFormat"))?,
        policy_bytes: bytes(top.get("policy"))?.to_vec(),
    };
    if string(top.get("carriedDigest"))? != closed_import_carried_digest(&state)? {
        return Err("closed import: wrong carried digest".into());
    }
    if string(top.get("policyDigest"))? != closed_import_policy_digest(&state)? {
        return Err("closed import: wrong policy digest".into());
    }
    if encode_closed_import_state(&state)? != image {
        return Err("closed import: noncanonical image".into());
    }
    Ok(state)
}

/// Create the primary once after a separate snapshot recovery copy is verified and synced.
#[cfg(not(target_arch = "wasm32"))]
pub fn stage_closed_import_state(
    path: &std::path::Path,
    recovery_path: &std::path::Path,
    state: &ClosedImportState,
) -> Result<PeerStateWriteOutcome, String> {
    use std::fs;
    use std::io::{Read, Write};

    if path == recovery_path {
        return Err("closed import: recovery path must be separate".into());
    }
    let image = encode_closed_import_state(state)?;
    if path.exists() {
        return Err("closed import: stage already exists".into());
    }
    let inherited_bytes = encode_refusal_snapshot(&state.closed.inherited)?;
    let mut recovery_file = fs::File::open(recovery_path).map_err(|e| e.to_string())?;
    let mut recovery_bytes = Vec::new();
    recovery_file
        .read_to_end(&mut recovery_bytes)
        .map_err(|e| e.to_string())?;
    verify_refusal_snapshot_copy(&content_address(&inherited_bytes), &recovery_bytes)?;
    recovery_file.sync_all().map_err(|e| e.to_string())?;
    let backup_parent = recovery_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    fs::File::open(backup_parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let dir = fs::File::open(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(&image).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    fs::hard_link(temp.path(), path).map_err(|e| e.to_string())?;
    if let Err(e) = fs::remove_file(temp.path()) {
        return Ok(PeerStateWriteOutcome::CommittedUnconfirmed {
            fault: e.to_string(),
        });
    }
    Ok(match dir.sync_all() {
        Ok(()) => PeerStateWriteOutcome::Durable,
        Err(e) => PeerStateWriteOutcome::CommittedUnconfirmed {
            fault: e.to_string(),
        },
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub fn read_closed_import_state(
    path: &std::path::Path,
    expected_peer_id: &str,
) -> Result<Option<ClosedImportState>, String> {
    match std::fs::read(path) {
        Ok(image) => decode_closed_import_state(&image, expected_peer_id).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
