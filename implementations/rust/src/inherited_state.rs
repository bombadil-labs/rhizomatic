//! Internal closed staging image. It persists inherited refusals but cannot admit or serve.

use std::collections::BTreeMap;

use crate::cbor::{decode, encode, CborValue};
use crate::durable_state::{
    decode_durable_peer_state, encode_durable_peer_state, DurablePeerState,
};
use crate::hash::content_address;
use crate::peer_identity::same_peer_id;
#[cfg(not(target_arch = "wasm32"))]
use crate::peer_state::PeerStateWriteOutcome;
use crate::refusal_snapshot::{
    decode_refusal_snapshot, encode_refusal_snapshot, local_refusal_snapshot,
    verify_refusal_snapshot_copy, RefusalSnapshot,
};

const VERSION: f64 = 3.0;

#[derive(Debug, Clone, PartialEq)]
pub struct ClosedPeerState {
    pub local: DurablePeerState,
    pub inherited: RefusalSnapshot,
}

fn complete_unchecked(state: &ClosedPeerState) -> Result<RefusalSnapshot, String> {
    let local = local_refusal_snapshot(&state.local)?;
    let mut current: BTreeMap<String, _> = state
        .inherited
        .current
        .iter()
        .cloned()
        .map(|row| (row.target_id.clone(), row))
        .collect();
    for row in local.current {
        current.insert(row.target_id.clone(), row);
    }
    Ok(RefusalSnapshot {
        events: state
            .inherited
            .events
            .iter()
            .cloned()
            .chain(local.events)
            .collect(),
        current: current.into_values().collect(),
    })
}

fn validate(state: &ClosedPeerState) -> Result<(Vec<u8>, Vec<u8>), String> {
    let local_bytes = encode_durable_peer_state(&state.local)?;
    let inherited_bytes = encode_refusal_snapshot(&state.inherited)?;
    let peer_id = &state.local.base.peer_id;
    if state
        .inherited
        .events
        .iter()
        .any(|event| same_peer_id(&event.source_peer_id, peer_id))
    {
        return Err("closed peer state: inherited event uses local peer id".into());
    }
    if state
        .inherited
        .current
        .iter()
        .any(|row| state.local.base.admitted.contains(&row.target_id))
    {
        return Err("closed peer state: inherited refusal is locally admitted".into());
    }
    encode_refusal_snapshot(&complete_unchecked(state)?)?;
    Ok((local_bytes, inherited_bytes))
}

/// Full qualified history for a later handoff; new local events supersede inherited current refs.
pub fn complete_refusal_snapshot(state: &ClosedPeerState) -> Result<RefusalSnapshot, String> {
    validate(state)?;
    complete_unchecked(state)
}

/// Canonical closed image. Its inherited bytes are retained across reopen.
pub fn encode_closed_peer_state(state: &ClosedPeerState) -> Result<Vec<u8>, String> {
    let (local_bytes, inherited_bytes) = validate(state)?;
    let digest = content_address(&inherited_bytes);
    Ok(encode(&CborValue::Map(vec![
        ("version".into(), CborValue::Float(VERSION)),
        (
            "peer".into(),
            CborValue::Tstr(state.local.base.peer_id.clone()),
        ),
        ("local".into(), CborValue::Bstr(local_bytes)),
        ("inherited".into(), CborValue::Bstr(inherited_bytes)),
        ("inheritedDigest".into(), CborValue::Tstr(digest)),
    ])))
}

fn fields(value: &CborValue) -> Result<BTreeMap<String, CborValue>, String> {
    let CborValue::Map(entries) = value else {
        return Err("closed peer state: invalid fields".into());
    };
    if entries.len() != 5 {
        return Err("closed peer state: invalid fields".into());
    }
    let result: BTreeMap<String, CborValue> = entries.iter().cloned().collect();
    if result.len() != 5 {
        return Err("closed peer state: duplicate fields".into());
    }
    Ok(result)
}

fn bytes(value: Option<&CborValue>) -> Result<&[u8], String> {
    match value {
        Some(CborValue::Bstr(data)) => Ok(data),
        _ => Err("closed peer state: expected bytes".into()),
    }
}

fn string(value: Option<&CborValue>) -> Result<&str, String> {
    match value {
        Some(CborValue::Tstr(data)) => Ok(data),
        _ => Err("closed peer state: expected text".into()),
    }
}

pub fn decode_closed_peer_state(
    image: &[u8],
    expected_peer_id: &str,
) -> Result<ClosedPeerState, String> {
    let top = fields(&decode(image)?)?;
    if top.get("version") != Some(&CborValue::Float(VERSION)) {
        return Err("closed peer state: unsupported version".into());
    }
    let peer_id = string(top.get("peer"))?;
    if peer_id != expected_peer_id {
        return Err("closed peer state: wrong peer id".into());
    }
    let inherited_bytes = bytes(top.get("inherited"))?;
    verify_refusal_snapshot_copy(string(top.get("inheritedDigest"))?, inherited_bytes)?;
    let state = ClosedPeerState {
        local: decode_durable_peer_state(bytes(top.get("local"))?, peer_id)?,
        inherited: decode_refusal_snapshot(inherited_bytes)?,
    };
    if encode_closed_peer_state(&state)? != image {
        return Err("closed peer state: noncanonical image".into());
    }
    Ok(state)
}

/// Stage once under a single writer after an independent recovery file already exists.
#[cfg(not(target_arch = "wasm32"))]
pub fn stage_closed_peer_state(
    path: &std::path::Path,
    recovery_path: &std::path::Path,
    state: &ClosedPeerState,
) -> Result<PeerStateWriteOutcome, String> {
    use std::fs;
    use std::io::{Read, Write};

    if path == recovery_path {
        return Err("closed peer state: recovery path must be separate".into());
    }
    let image = encode_closed_peer_state(state)?;
    if path.exists() {
        return Err("closed peer state: stage already exists".into());
    }
    let inherited_bytes = encode_refusal_snapshot(&state.inherited)?;
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
    let committed = temp
        .persist_noclobber(path)
        .map_err(|e| e.error.to_string())?;
    drop(committed);
    Ok(match dir.sync_all() {
        Ok(()) => PeerStateWriteOutcome::Durable,
        Err(e) => PeerStateWriteOutcome::CommittedUnconfirmed {
            fault: e.to_string(),
        },
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub fn read_closed_peer_state(
    path: &std::path::Path,
    expected_peer_id: &str,
) -> Result<Option<ClosedPeerState>, String> {
    match std::fs::read(path) {
        Ok(bytes) => decode_closed_peer_state(&bytes, expected_peer_id).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
