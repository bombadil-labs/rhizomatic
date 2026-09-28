//! An old-peer signature over preparation is not a durable commit or permission to serve.

use std::collections::BTreeMap;

use ed25519_dalek::{Signer, SigningKey};

use crate::cbor::{decode, encode, CborValue};
use crate::closed_import::{
    closed_import_carried_digest, closed_import_policy_digest, ClosedImportState,
};
use crate::peer_identity::is_canonical_peer_id;
use crate::refusal_snapshot::refusal_snapshot_digest;
use crate::sign::{author_for_seed, verify_sig_strict};

const DOMAIN: &str = "rhizomatic.peer.handoff.prepare.v1";
const VERSION: f64 = 1.0;
const MAX_COUNTER: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedHandoffDescriptor {
    pub attempt_id: String,
    pub surface_id: String,
    pub old_peer_id: String,
    pub new_peer_id: String,
    pub old_state_version: u64,
    pub deadline: f64,
    pub refusal_digest: String,
    pub carried_digest: String,
    pub policy_digest: String,
}

fn digest(value: &str) -> bool {
    value.strip_prefix("1e20").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    })
}

fn validate(descriptor: &PreparedHandoffDescriptor) -> Result<(), String> {
    if descriptor.attempt_id.is_empty()
        || descriptor.surface_id.is_empty()
        || !is_canonical_peer_id(&descriptor.old_peer_id)
        || !is_canonical_peer_id(&descriptor.new_peer_id)
        || descriptor.old_peer_id == descriptor.new_peer_id
        || descriptor.old_state_version > MAX_COUNTER
        || !descriptor.deadline.is_finite()
        || !digest(&descriptor.refusal_digest)
        || !digest(&descriptor.carried_digest)
        || !digest(&descriptor.policy_digest)
    {
        return Err("prepared handoff: invalid descriptor".into());
    }
    Ok(())
}

fn canonical_carried_sources(state: &ClosedImportState) -> Result<(), String> {
    let snapshot_sources = state
        .closed
        .inherited
        .events
        .iter()
        .map(|event| event.source_peer_id.as_str())
        .chain(
            state
                .closed
                .inherited
                .current
                .iter()
                .map(|row| row.source_peer_id.as_str()),
        );
    let obligation_sources = state.obligations.obligations.iter().flat_map(|row| {
        std::iter::once(row.source_peer_id.as_str())
            .chain(std::iter::once(row.event.source_peer_id.as_str()))
            .chain(
                row.prior_epoch
                    .iter()
                    .map(|prior| prior.source_peer_id.as_str()),
            )
    });
    if snapshot_sources
        .chain(obligation_sources)
        .any(|source| !is_canonical_peer_id(source))
    {
        return Err("prepared handoff: noncanonical carried peer id".into());
    }
    Ok(())
}

pub fn prepared_descriptor_from_stage(
    state: &ClosedImportState,
    surface_id: &str,
) -> Result<PreparedHandoffDescriptor, String> {
    canonical_carried_sources(state)?;
    let descriptor = PreparedHandoffDescriptor {
        attempt_id: state.attempt_id.clone(),
        surface_id: surface_id.into(),
        old_peer_id: state.old_peer_id.clone(),
        new_peer_id: state.closed.local.base.peer_id.clone(),
        old_state_version: state.old_state_version,
        deadline: state.deadline,
        refusal_digest: refusal_snapshot_digest(&state.closed.inherited)?,
        carried_digest: closed_import_carried_digest(state)?,
        policy_digest: closed_import_policy_digest(state)?,
    };
    validate(&descriptor)?;
    Ok(descriptor)
}

/// Canonical domain-separated bytes signed by the old peer.
pub fn encode_prepared_handoff_claim(
    descriptor: &PreparedHandoffDescriptor,
) -> Result<Vec<u8>, String> {
    validate(descriptor)?;
    Ok(encode(&CborValue::Map(vec![
        ("version".into(), CborValue::Float(VERSION)),
        ("domain".into(), CborValue::Tstr(DOMAIN.into())),
        (
            "attempt".into(),
            CborValue::Tstr(descriptor.attempt_id.clone()),
        ),
        (
            "surface".into(),
            CborValue::Tstr(descriptor.surface_id.clone()),
        ),
        (
            "oldPeer".into(),
            CborValue::Tstr(descriptor.old_peer_id.clone()),
        ),
        (
            "newPeer".into(),
            CborValue::Tstr(descriptor.new_peer_id.clone()),
        ),
        (
            "oldVersion".into(),
            CborValue::Float(descriptor.old_state_version as f64),
        ),
        ("deadline".into(), CborValue::Float(descriptor.deadline)),
        (
            "refusalDigest".into(),
            CborValue::Tstr(descriptor.refusal_digest.clone()),
        ),
        (
            "carriedDigest".into(),
            CborValue::Tstr(descriptor.carried_digest.clone()),
        ),
        (
            "policyDigest".into(),
            CborValue::Tstr(descriptor.policy_digest.clone()),
        ),
    ])))
}

fn fields(value: &CborValue, size: usize) -> Result<BTreeMap<String, CborValue>, String> {
    let CborValue::Map(entries) = value else {
        return Err("prepared handoff: invalid fields".into());
    };
    if entries.len() != size {
        return Err("prepared handoff: invalid fields".into());
    }
    let result: BTreeMap<String, CborValue> = entries.iter().cloned().collect();
    if result.len() != size {
        return Err("prepared handoff: duplicate fields".into());
    }
    Ok(result)
}

fn string(value: Option<&CborValue>) -> Result<String, String> {
    match value {
        Some(CborValue::Tstr(data)) => Ok(data.clone()),
        _ => Err("prepared handoff: expected text".into()),
    }
}

fn number(value: Option<&CborValue>) -> Result<f64, String> {
    match value {
        Some(CborValue::Float(n)) => Ok(*n),
        _ => Err("prepared handoff: expected number".into()),
    }
}

fn bytes(value: Option<&CborValue>) -> Result<&[u8], String> {
    match value {
        Some(CborValue::Bstr(data)) => Ok(data),
        _ => Err("prepared handoff: expected bytes".into()),
    }
}

fn decode_claim(image: &[u8]) -> Result<PreparedHandoffDescriptor, String> {
    let row = fields(&decode(image)?, 11)?;
    if number(row.get("version"))? != VERSION || string(row.get("domain"))? != DOMAIN {
        return Err("prepared handoff: wrong domain or version".into());
    }
    let old_version = number(row.get("oldVersion"))?;
    if !old_version.is_finite()
        || old_version < 0.0
        || old_version > MAX_COUNTER as f64
        || old_version.fract() != 0.0
    {
        return Err("prepared handoff: invalid descriptor".into());
    }
    let descriptor = PreparedHandoffDescriptor {
        attempt_id: string(row.get("attempt"))?,
        surface_id: string(row.get("surface"))?,
        old_peer_id: string(row.get("oldPeer"))?,
        new_peer_id: string(row.get("newPeer"))?,
        old_state_version: old_version as u64,
        deadline: number(row.get("deadline"))?,
        refusal_digest: string(row.get("refusalDigest"))?,
        carried_digest: string(row.get("carriedDigest"))?,
        policy_digest: string(row.get("policyDigest"))?,
    };
    if encode_prepared_handoff_claim(&descriptor)? != image {
        return Err("prepared handoff: noncanonical claim".into());
    }
    Ok(descriptor)
}

/// Test and host signing helper; the prepared signature is never a commit proof.
pub fn sign_prepared_handoff(
    descriptor: &PreparedHandoffDescriptor,
    seed_hex: &str,
) -> Result<Vec<u8>, String> {
    let claim = encode_prepared_handoff_claim(descriptor)?;
    if author_for_seed(seed_hex)? != descriptor.old_peer_id {
        return Err("prepared handoff: wrong old peer signing key".into());
    }
    let seed: [u8; 32] = hex::decode(seed_hex)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "prepared handoff: invalid signing seed")?;
    let signature = SigningKey::from_bytes(&seed).sign(&claim).to_bytes();
    Ok(encode(&CborValue::Map(vec![
        ("claim".into(), CborValue::Bstr(claim)),
        ("signature".into(), CborValue::Bstr(signature.to_vec())),
    ])))
}

/// Authenticate and parse a signed preparation without granting commit authority.
pub fn decode_prepared_handoff(image: &[u8]) -> Result<PreparedHandoffDescriptor, String> {
    let row = fields(&decode(image)?, 2)?;
    let claim = bytes(row.get("claim"))?;
    let signature = bytes(row.get("signature"))?;
    let descriptor = decode_claim(claim)?;
    let pubkey =
        hex::decode(&descriptor.old_peer_id["ed25519:".len()..]).map_err(|e| e.to_string())?;
    if !verify_sig_strict(signature, claim, &pubkey) {
        return Err("prepared handoff: invalid old peer signature".into());
    }
    let canonical = encode(&CborValue::Map(vec![
        ("claim".into(), CborValue::Bstr(claim.to_vec())),
        ("signature".into(), CborValue::Bstr(signature.to_vec())),
    ]));
    if canonical != image {
        return Err("prepared handoff: noncanonical image".into());
    }
    Ok(descriptor)
}

/// Require the signed descriptor to match every staged field and the declared old surface.
pub fn verify_prepared_matches_stage(
    image: &[u8],
    state: &ClosedImportState,
    surface_id: &str,
) -> Result<PreparedHandoffDescriptor, String> {
    let actual = decode_prepared_handoff(image)?;
    let expected = prepared_descriptor_from_stage(state, surface_id)?;
    if actual != expected {
        return Err("prepared handoff: descriptor does not match closed stage".into());
    }
    Ok(actual)
}
