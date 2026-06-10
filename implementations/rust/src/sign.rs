//! Ed25519 signing & verification (SPEC-1 §5, ERRATA D8-D9). Mirrors ../ts/src/sign.ts.
//! Deterministic (RFC 8032): signature bytes are reproducible across implementations.

use crate::delta::compute_id;
use crate::types::{Claims, Delta};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

pub const AUTHOR_PREFIX: &str = "ed25519:";

fn signing_key_from_seed(seed_hex: &str) -> Result<SigningKey, String> {
    let bytes = hex::decode(seed_hex).map_err(|e| format!("bad seed hex: {e}"))?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "seed must be exactly 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&seed))
}

pub fn public_key_from_seed(seed_hex: &str) -> Result<String, String> {
    Ok(hex::encode(
        signing_key_from_seed(seed_hex)?.verifying_key().to_bytes(),
    ))
}

/// The author string a signed delta MUST carry for this seed (ERRATA D8).
pub fn author_for_seed(seed_hex: &str) -> Result<String, String> {
    Ok(format!(
        "{AUTHOR_PREFIX}{}",
        public_key_from_seed(seed_hex)?
    ))
}

/// Sign claims, producing a complete delta. Refuses to sign claims whose author does not match
/// the signing key — a signature contradicting its own author field is born broken (ERRATA D8).
pub fn sign_claims(claims: &Claims, seed_hex: &str) -> Result<Delta, String> {
    let expected = author_for_seed(seed_hex)?;
    if claims.author != expected {
        return Err(format!(
            "author must be {expected} for this signing key, got {}",
            claims.author
        ));
    }
    let id = compute_id(claims)?;
    let id_bytes = hex::decode(&id).expect("compute_id emits valid hex");
    let sig = signing_key_from_seed(seed_hex)?.sign(&id_bytes);
    Ok(Delta {
        id,
        claims: claims.clone(),
        sig: Some(hex::encode(sig.to_bytes())),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verification {
    Verified,
    Unsigned,
    Invalid,
}

/// Full verification per ERRATA D9: content addressing must hold, then the signature must verify
/// over the raw id bytes against the key named in `author`.
pub fn verify_delta(delta: &Delta) -> Verification {
    match compute_id(&delta.claims) {
        Ok(id) if id == delta.id => {}
        _ => return Verification::Invalid,
    }
    let Some(sig_hex) = &delta.sig else {
        return Verification::Unsigned;
    };
    let Some(pub_hex) = delta.claims.author.strip_prefix(AUTHOR_PREFIX) else {
        return Verification::Invalid;
    };
    let (Ok(pub_bytes), Ok(sig_bytes), Ok(id_bytes)) = (
        hex::decode(pub_hex),
        hex::decode(sig_hex),
        hex::decode(&delta.id),
    ) else {
        return Verification::Invalid;
    };
    let Ok(pub_arr): Result<[u8; 32], _> = pub_bytes.try_into() else {
        return Verification::Invalid;
    };
    let Ok(key) = VerifyingKey::from_bytes(&pub_arr) else {
        return Verification::Invalid;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return Verification::Invalid;
    };
    if key.verify_strict(&id_bytes, &sig).is_ok() {
        Verification::Verified
    } else {
        Verification::Invalid
    }
}
