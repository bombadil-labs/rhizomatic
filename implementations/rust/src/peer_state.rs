//! Peer-local logical state image for a single-writer durable admission store (SPEC-6 §§2–3).

use std::collections::{BTreeMap, BTreeSet};

use crate::arrival::{ArrivalCursor, ArrivalRecord};
use crate::cbor::{decode, encode, CborValue};
use crate::pack::{pack_set, unpack_set};
use crate::set::DeltaSet;
use crate::sign::{verify_delta, Verification};

const VERSION: f64 = 1.0;
const MAX_SEQUENCE: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Clone, PartialEq)]
pub struct PeerState {
    pub peer_id: String,
    pub admitted: DeltaSet,
    pub cursor: ArrivalCursor,
    pub arrivals: Vec<ArrivalRecord>,
    pub refused_ids: BTreeSet<String>,
}

fn validate(state: &PeerState) -> Result<(), String> {
    if state.peer_id.is_empty() {
        return Err("peer state: peer id must not be empty".into());
    }
    if state.cursor.last_sequence > MAX_SEQUENCE || state.cursor.last_transfer > MAX_SEQUENCE {
        return Err("peer state: invalid arrival cursor".into());
    }
    if state.arrivals.len() as u64 != state.cursor.last_sequence {
        return Err("peer state: arrival history does not match cursor".into());
    }
    let mut last_transfer = 0;
    let mut last_id = "";
    let mut last_at = 0.0;
    let mut last_sender = "";
    let mut arrived = BTreeSet::new();
    for (i, row) in state.arrivals.iter().enumerate() {
        if row.id.is_empty()
            || row.sender.is_empty()
            || !row.at.is_finite()
            || row.sequence != i as u64 + 1
        {
            return Err("peer state: invalid arrival record".into());
        }
        if row.transfer == 0
            || row.transfer > MAX_SEQUENCE
            || row.transfer < last_transfer
            || row.transfer > last_transfer + 1
        {
            return Err("peer state: invalid transfer ordinal".into());
        }
        if row.transfer == last_transfer
            && (row.id.as_str() <= last_id || row.at != last_at || row.sender != last_sender)
        {
            return Err("peer state: inconsistent transfer arrivals".into());
        }
        last_transfer = row.transfer;
        last_id = &row.id;
        last_at = row.at;
        last_sender = &row.sender;
        arrived.insert(row.id.as_str());
    }
    if last_transfer != state.cursor.last_transfer {
        return Err("peer state: transfer history does not match cursor".into());
    }
    for id in &state.refused_ids {
        if id.is_empty() || state.admitted.contains(id) {
            return Err("peer state: invalid refusal set".into());
        }
    }
    for delta in state.admitted.iter() {
        if !arrived.contains(delta.id.as_str()) {
            return Err("peer state: admitted id has no arrival".into());
        }
        if delta.sig.is_some() && verify_delta(delta) != Verification::Verified {
            return Err("peer state: invalid admitted signature".into());
        }
    }
    Ok(())
}

fn field_map(value: &CborValue, label: &str) -> Result<BTreeMap<String, CborValue>, String> {
    let CborValue::Map(entries) = value else {
        return Err(format!("peer state: {label} must be a map"));
    };
    let out: BTreeMap<String, CborValue> = entries.iter().cloned().collect();
    if out.len() != entries.len() {
        return Err(format!("peer state: duplicate {label} key"));
    }
    Ok(out)
}

fn number(value: Option<&CborValue>, label: &str) -> Result<f64, String> {
    match value {
        Some(CborValue::Float(n)) => Ok(*n),
        _ => Err(format!("peer state: {label} must be a number")),
    }
}
fn counter(value: Option<&CborValue>, label: &str) -> Result<u64, String> {
    let n = number(value, label)?;
    if n < 0.0 || n > MAX_SEQUENCE as f64 || n.fract() != 0.0 {
        return Err(format!("peer state: {label} must be a safe counter"));
    }
    Ok(n as u64)
}
fn string(value: Option<&CborValue>, label: &str) -> Result<String, String> {
    match value {
        Some(CborValue::Tstr(s)) => Ok(s.clone()),
        _ => Err(format!("peer state: {label} must be text")),
    }
}
fn items<'a>(value: Option<&'a CborValue>, label: &str) -> Result<&'a [CborValue], String> {
    match value {
        Some(CborValue::Array(v)) => Ok(v),
        _ => Err(format!("peer state: {label} must be an array")),
    }
}

/// Canonical private state image; both witnesses emit identical bytes.
pub fn encode_peer_state(state: &PeerState) -> Result<Vec<u8>, String> {
    validate(state)?;
    Ok(encode(&CborValue::Map(vec![
        ("version".into(), CborValue::Float(VERSION)),
        ("peer".into(), CborValue::Tstr(state.peer_id.clone())),
        ("pack".into(), CborValue::Bstr(pack_set(&state.admitted))),
        (
            "sequence".into(),
            CborValue::Float(state.cursor.last_sequence as f64),
        ),
        (
            "transfer".into(),
            CborValue::Float(state.cursor.last_transfer as f64),
        ),
        (
            "arrivals".into(),
            CborValue::Array(
                state
                    .arrivals
                    .iter()
                    .map(|row| {
                        CborValue::Map(vec![
                            ("id".into(), CborValue::Tstr(row.id.clone())),
                            ("at".into(), CborValue::Float(row.at)),
                            ("sequence".into(), CborValue::Float(row.sequence as f64)),
                            ("transfer".into(), CborValue::Float(row.transfer as f64)),
                            ("sender".into(), CborValue::Tstr(row.sender.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "refused".into(),
            CborValue::Array(
                state
                    .refused_ids
                    .iter()
                    .map(|id| CborValue::Tstr(id.clone()))
                    .collect(),
            ),
        ),
    ])))
}

pub fn decode_peer_state(bytes: &[u8], expected_peer_id: &str) -> Result<PeerState, String> {
    let top = field_map(&decode(bytes)?, "image")?;
    if top.len() != 7 || number(top.get("version"), "version")? != VERSION {
        return Err("peer state: unsupported image version or fields".into());
    }
    let peer_id = string(top.get("peer"), "peer")?;
    if peer_id != expected_peer_id {
        return Err("peer state: wrong peer id".into());
    }
    let pack = match top.get("pack") {
        Some(CborValue::Bstr(bytes)) => bytes,
        _ => return Err("peer state: pack must be bytes".into()),
    };
    let arrivals = items(top.get("arrivals"), "arrivals")?
        .iter()
        .map(|value| {
            let row = field_map(value, "arrival")?;
            if row.len() != 5 {
                return Err("peer state: invalid arrival fields".into());
            }
            Ok(ArrivalRecord {
                id: string(row.get("id"), "arrival id")?,
                at: number(row.get("at"), "arrival at")?,
                sequence: counter(row.get("sequence"), "arrival sequence")?,
                transfer: counter(row.get("transfer"), "arrival transfer")?,
                sender: string(row.get("sender"), "arrival sender")?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let refused: Vec<String> = items(top.get("refused"), "refused")?
        .iter()
        .map(|v| string(Some(v), "refused id"))
        .collect::<Result<_, _>>()?;
    let refused_ids: BTreeSet<String> = refused.iter().cloned().collect();
    if refused_ids.len() != refused.len() {
        return Err("peer state: duplicate refusal".into());
    }
    let state = PeerState {
        peer_id,
        admitted: unpack_set(pack)?,
        cursor: ArrivalCursor {
            last_sequence: counter(top.get("sequence"), "sequence")?,
            last_transfer: counter(top.get("transfer"), "transfer")?,
        },
        arrivals,
        refused_ids,
    };
    validate(&state)?;
    if encode_peer_state(&state)? != bytes {
        return Err("peer state: noncanonical image".into());
    }
    Ok(state)
}

/// Single-writer file backend. The caller serializes writes for this peer and directory.
#[cfg(not(target_arch = "wasm32"))]
pub fn write_peer_state(path: &std::path::Path, state: &PeerState) -> Result<(), String> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    let bytes = encode_peer_state(state)?;
    let parent = path
        .parent()
        .ok_or("peer state: missing parent directory")?;
    let nonce = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("{}.{}.tmp", std::process::id(), nonce));
    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temp, path).map_err(|e| e.to_string())?;
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}

#[cfg(not(target_arch = "wasm32"))]
pub fn read_peer_state(
    path: &std::path::Path,
    expected_peer_id: &str,
) -> Result<Option<PeerState>, String> {
    match std::fs::read(path) {
        Ok(bytes) => decode_peer_state(&bytes, expected_peer_id).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
